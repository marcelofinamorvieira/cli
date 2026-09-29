import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CmaClient,
  CmaClientCommand,
  DatoConfigCommand,
  type LogLevelFlagEnum,
  type LogLevelModeEnum,
  type ProfileConfig,
  logLevelMap,
  oclif,
} from '@datocms/cli-utils';
import { camelCase } from 'lodash';
import { assertSupportedDatocmsCli } from '../../compat/datocms-version';
import {
  ContentDiffError,
  type ContentDiffMigrationSummary,
  DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
  generateContentDiffMigration,
} from '../../content-diff';
import { compareStrings } from '../../content-diff/shared/ordering';
import type { ContentDiffTuningOverride } from '../../content-diff/shared/tuning';
import { findNearestFile } from '../../utils/find-nearest-file';
import { migrationsRunLockClearCommand } from '../../utils/migrations-run-lock';
import {
  DEFAULT_MIGRATIONS_MODEL_API_KEY,
  RESERVED_MIGRATIONS_MODEL_MESSAGE,
  isReservedMigrationsModelApiKey,
  resolveMigrationsSettings,
} from '../../utils/migrations-settings';
import {
  type ResolveLinkedSiteToken,
  resolveProfileApiToken,
} from '../../utils/profile-auth';
import { RedactedCmaClientCommand } from '../../utils/redacted-cma-client-command';

type MigrationFormat = 'js' | 'ts';
type UploadScope = 'all' | 'referenced';
type EnvironmentSummary = { id: string; meta: { primary: boolean } };
type ProfileEndpoint = {
  profileConfig: ProfileConfig;
  rootClient: CmaClient.Client;
  buildEnvironmentClient: (environmentId: string) => CmaClient.Client;
};
type DualProfileSelection = {
  sourceProfile: string;
  destinationProfile: string;
  sourceApiToken?: string;
  destinationApiToken?: string;
};
type ParsedToken = { type: string; flag?: string };
type PublicInvalidContentSummary = {
  partial: boolean;
  detectedRecordCount: number;
  migratedRecordCount: number;
  skippedRecordCount: number;
  propagatedSkipCount: number;
  relaxedFieldCount: number;
  relaxedValidatorCount: number;
  requiresTemporaryValidatorRelaxation: boolean;
};
type PublicLegacyIdSummary = {
  detectedLegacyIdCount: number;
  legacyIdMappingCount: number;
  newLegacyIdMappingCount: number;
  skippedLegacyIdCount: number;
  mappingRecordCount: number;
  requiresLegacyIdRemapping: boolean;
};

export type ContentDiffCommandResult = {
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  format: MigrationFormat;
  migrationFilePath: string;
  planFilePath: string;
  runtimeFilePath: string;
  assetsDirectoryPath?: string;
  /** Generation-time tuning values that differ from their defaults. */
  tuningOverrides?: ContentDiffTuningOverride[];
  summary: {
    counts: Record<string, number>;
    destructiveActionCount: number;
    warningCount: number;
    invalidContent: PublicInvalidContentSummary;
    legacyIds: PublicLegacyIdSummary;
  };
};

export default class ContentDiffCommand extends RedactedCmaClientCommand {
  static generateMigration = generateContentDiffMigration;

  static buildProfileClient = (config: CmaClient.ClientConfigOptions) =>
    CmaClient.buildClient(config);

  static resolveLinkedSiteToken = async (
    command: ContentDiffCommand,
    siteId: string,
    organizationId?: string,
  ): Promise<string | undefined> => {
    const resolver = Reflect.get(command, 'resolveTokenFromSiteId') as (
      siteId: string,
      organizationId?: string,
    ) => Promise<string | undefined>;

    return Reflect.apply(resolver, command, [siteId, organizationId]);
  };

  static description =
    'Generate a content migration by comparing two DatoCMS environments';

  static examples = [
    {
      description:
        'Generate a migration from staging to the primary environment',
      command:
        '<%= config.bin %> <%= command.id %> "sync staging content" --autogenerate=staging',
    },
    {
      description: 'Generate a migration from one environment to another',
      command:
        '<%= config.bin %> <%= command.id %> "sync content" --autogenerate=source:destination',
    },
    {
      description: 'Include every upload and destructive cleanup',
      command:
        '<%= config.bin %> <%= command.id %> "mirror content" --autogenerate=source:destination --uploads=all --include-deletions',
    },
    {
      description:
        'Migrate eligible invalid or historical-null content using temporary schema changes',
      command:
        '<%= config.bin %> <%= command.id %> "sync invalid content" --autogenerate=source:destination --migrate-invalid-content',
    },
    {
      description:
        'Generate a migration across projects that share aligned public IDs',
      command:
        '<%= config.bin %> <%= command.id %> "sync shared content" --source-profile=source_project --destination-profile=destination_project --autogenerate=main:main',
    },
  ];

  static args = {
    NAME: oclif.Args.string({
      description: 'The name to give to the generated migration',
      required: true,
    }),
  };

  static flags = {
    ...CmaClientCommand.flags,
    autogenerate: oclif.Flags.string({
      description:
        'Generate a migration from SOURCE to DESTINATION. When DESTINATION is omitted, the primary environment is used (for example, --autogenerate=staging or --autogenerate=staging:production)',
      required: true,
    }),
    'source-profile': oclif.Flags.string({
      description:
        'Read content from this configured profile (must be used with --destination-profile)',
    }),
    'destination-profile': oclif.Flags.string({
      description:
        'Compare and generate for this configured profile (must be used with --source-profile)',
    }),
    'source-api-token': oclif.Flags.string({
      description:
        'Specify a custom API key for --source-profile instead of its configured authentication',
    }),
    'destination-api-token': oclif.Flags.string({
      description:
        'Specify a custom API key for --destination-profile instead of its configured authentication',
    }),
    'migrations-dir': oclif.Flags.string({
      description:
        'Directory where script migrations are stored, resolved like migrations:run (defaults to the destination profile migrations.directory, then ./migrations)',
    }),
    'migrations-model': oclif.Flags.string({
      description:
        'API key of the DatoCMS model used to store migration data in the destination, resolved like migrations:run (defaults to the destination profile migrations.modelApiKey, then schema_migration)',
    }),
    'item-types': oclif.Flags.string({
      description:
        'Item type API keys to include, separated by commas, or "all"',
      default: 'all',
    }),
    uploads: oclif.Flags.custom<UploadScope>({
      description:
        'Include uploads referenced by selected content or every upload',
      options: ['referenced', 'all'],
      default: 'referenced',
    })(),
    'include-deletions': oclif.Flags.boolean({
      description:
        'Include deletion of destination-only records and unused uploads in scope',
      default: false,
    }),
    'bundle-assets': oclif.Flags.boolean({
      description:
        'Download upload binaries beside the generated migration instead of transferring them from source URLs at runtime',
      default: false,
    }),
    'migrate-invalid-content': oclif.Flags.boolean({
      description:
        'Migrate eligible invalid or historical-null content with exact temporary validator relaxation or create-time field-default suppression; unsupported records are skipped and reported',
      default: false,
    }),
    ts: oclif.Flags.boolean({
      description: 'Force a TypeScript migration',
      exclusive: ['js'],
    }),
    js: oclif.Flags.boolean({
      description: 'Force a JavaScript migration',
      exclusive: ['ts'],
    }),
  };

  protected async init(): Promise<void> {
    const { raw } = await this.parse(ContentDiffCommand);

    if (!hasDualProfileFlag(commandLineFlagNames(raw))) {
      await super.init();
      return;
    }

    const initializeDatoConfig = Reflect.get(
      DatoConfigCommand.prototype,
      'init',
    ) as () => Promise<void>;
    await Reflect.apply(initializeDatoConfig, this, []);
  }

  async run(): Promise<ContentDiffCommandResult> {
    assertSupportedDatocmsCli(this);

    const {
      args: { NAME: name },
      flags,
      raw,
    } = await this.parse(ContentDiffCommand);
    const commandLineFlags = commandLineFlagNames(raw);
    const globalFlags = flags as unknown as {
      profile?: string;
      'api-token'?: string;
      'config-file'?: string;
      'base-url'?: string;
      'log-level'?: LogLevelFlagEnum;
      'log-mode'?: LogLevelModeEnum;
      'source-api-token'?: string;
      'destination-api-token'?: string;
      json?: boolean;
    };

    const dualProfileSelection = this.resolveDualProfileSelection({
      requested: hasDualProfileFlag(commandLineFlags),
      sourceProfile: flags['source-profile'],
      destinationProfile: flags['destination-profile'],
      sourceApiToken: globalFlags['source-api-token'],
      destinationApiToken: globalFlags['destination-api-token'],
      legacyFlagProvided:
        commandLineFlags.has('profile') || commandLineFlags.has('api-token'),
    });

    if (dualProfileSelection && globalFlags.profile) {
      // --profile itself was rejected above, so the value came from
      // DATOCMS_PROFILE (including one loaded from .env or .env.local).
      this.warn(
        'DATOCMS_PROFILE is ignored because --source-profile and --destination-profile select the profiles to compare.',
      );
    }

    let sourceRootClient: CmaClient.Client;
    let destinationRootClient: CmaClient.Client;
    let sourceEnvironmentClient: CmaClient.Client;
    let destinationEnvironmentClient: CmaClient.Client;
    let sourceMigrationsModelApiKey: string;
    let destinationMigrationsModelApiKey: string;
    let destinationMigrations: ProfileConfig['migrations'];
    let migrationsDirectory: string;
    let sourceEnvironments: EnvironmentSummary[];
    let destinationEnvironments: EnvironmentSummary[];
    let sourceEnvironmentId: string;
    let destinationEnvironmentId: string;

    if (dualProfileSelection) {
      const [sourceEndpoint, destinationEndpoint] = await Promise.all([
        this.buildProfileEndpoint({
          profileId: dualProfileSelection.sourceProfile,
          explicitApiToken: dualProfileSelection.sourceApiToken,
          endpointTokenFlag: '--source-api-token',
          json: Boolean(globalFlags.json),
          baseUrl: globalFlags['base-url'],
          logLevel: globalFlags['log-level'],
          logMode: globalFlags['log-mode'],
        }),
        this.buildProfileEndpoint({
          profileId: dualProfileSelection.destinationProfile,
          explicitApiToken: dualProfileSelection.destinationApiToken,
          endpointTokenFlag: '--destination-api-token',
          json: Boolean(globalFlags.json),
          baseUrl: globalFlags['base-url'],
          logLevel: globalFlags['log-level'],
          logMode: globalFlags['log-mode'],
        }),
      ]);

      destinationMigrations = destinationEndpoint.profileConfig.migrations;
      ({
        directory: migrationsDirectory,
        modelApiKey: destinationMigrationsModelApiKey,
      } = this.resolveDestinationMigrationsSettings(
        destinationMigrations,
        flags,
      ));
      sourceMigrationsModelApiKey =
        sourceEndpoint.profileConfig.migrations?.modelApiKey ||
        DEFAULT_MIGRATIONS_MODEL_API_KEY;
      sourceRootClient = sourceEndpoint.rootClient;
      destinationRootClient = destinationEndpoint.rootClient;
      [sourceEnvironments, destinationEnvironments] = await Promise.all([
        sourceRootClient.environments.list(),
        destinationRootClient.environments.list(),
      ]);
      ({ sourceEnvironmentId, destinationEnvironmentId } =
        this.resolveEnvironmentIds(
          flags.autogenerate,
          sourceEnvironments,
          destinationEnvironments,
          true,
        ));
      sourceEnvironmentClient =
        sourceEndpoint.buildEnvironmentClient(sourceEnvironmentId);
      destinationEnvironmentClient = destinationEndpoint.buildEnvironmentClient(
        destinationEnvironmentId,
      );
    } else {
      this.requireDatoProfileConfig();
      destinationMigrations = this.datoProfileConfig!.migrations;
      // Both endpoints live in the same project, so they share one tracking
      // model.
      ({
        directory: migrationsDirectory,
        modelApiKey: destinationMigrationsModelApiKey,
      } = this.resolveDestinationMigrationsSettings(
        destinationMigrations,
        flags,
      ));
      sourceMigrationsModelApiKey = destinationMigrationsModelApiKey;
      sourceRootClient = this.client;
      destinationRootClient = this.client;
      sourceEnvironments = await this.client.environments.list();
      destinationEnvironments = sourceEnvironments;
      ({ sourceEnvironmentId, destinationEnvironmentId } =
        this.resolveEnvironmentIds(
          flags.autogenerate,
          sourceEnvironments,
          destinationEnvironments,
          false,
        ));
      [sourceEnvironmentClient, destinationEnvironmentClient] =
        await Promise.all([
          this.buildClient({ environment: sourceEnvironmentId }),
          this.buildClient({ environment: destinationEnvironmentId }),
        ]);
    }

    const format = await this.resolveMigrationFormat({
      forceJavaScript: flags.js,
      forceTypeScript: flags.ts,
      migrationsTsconfig: destinationMigrations?.tsconfig,
    });
    const itemTypes = this.parseItemTypes(flags['item-types']);
    const migrationFilePath = join(
      migrationsDirectory,
      `${Math.floor(Date.now() / 1000)}_${camelCase(name)}.${format}`,
    );

    this.startSpinner(
      `Comparing content from "${sourceEnvironmentId}" to "${destinationEnvironmentId}"`,
    );

    try {
      const generated = await ContentDiffCommand.generateMigration({
        source: {
          rootClient: sourceRootClient,
          environmentClient: sourceEnvironmentClient,
          environmentId: sourceEnvironmentId,
          migrationsModelApiKey: sourceMigrationsModelApiKey,
          contentDiffModelApiKey: DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
        },
        destination: {
          rootClient: destinationRootClient,
          environmentClient: destinationEnvironmentClient,
          environmentId: destinationEnvironmentId,
          migrationsModelApiKey: destinationMigrationsModelApiKey,
          contentDiffModelApiKey: DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
        },
        migrationFilePath,
        format,
        options: {
          itemTypes,
          uploads: flags.uploads,
          includeDeletions: flags['include-deletions'],
          bundleAssets: flags['bundle-assets'],
          migrateInvalidContent: flags['migrate-invalid-content'],
        },
      });

      this.stopSpinner();

      const humanSummary = normalizeSummary(generated.summary);
      const result: ContentDiffCommandResult = {
        sourceEnvironmentId: generated.sourceEnvironmentId,
        destinationEnvironmentId: generated.destinationEnvironmentId,
        format: generated.format,
        migrationFilePath: generated.migrationPath,
        planFilePath: generated.planPath,
        runtimeFilePath: generated.runtimePath,
        ...(generated.assetsPath
          ? { assetsDirectoryPath: generated.assetsPath }
          : {}),
        ...(generated.tuningOverrides && generated.tuningOverrides.length > 0
          ? {
              tuningOverrides: generated.tuningOverrides.map((override) => ({
                ...override,
              })),
            }
          : {}),
        summary: {
          counts: humanSummary.counts,
          destructiveActionCount: humanSummary.destructiveActions.length,
          warningCount: humanSummary.warnings.length,
          invalidContent: toPublicInvalidContentSummary(
            humanSummary.invalidContent,
          ),
          legacyIds: toPublicLegacyIdSummary(humanSummary),
        },
      };

      this.printHumanResult(result, humanSummary);

      return result;
    } catch (error) {
      this.stopSpinnerWithFailure();

      if (
        error instanceof ContentDiffError &&
        error.code === 'ENVIRONMENT_SEMANTICS_MISMATCH'
      ) {
        this.error(
          [
            `Incompatible environment activation/settings: cannot generate content migration ${JSON.stringify(
              name,
            )} from "${sourceEnvironmentId}" to "${destinationEnvironmentId}" because content serialization or validation semantics differ.`,
            'No content records were read and no migration artifacts were created.',
            'Align the destination timezone and product-update activations with the source, or create a fresh destination fork from an environment with matching settings, then regenerate the content diff.',
            'Schema autogeneration alone may not repair activation mismatches.',
            '--migrate-invalid-content does not bypass environment compatibility.',
          ].join('\n'),
        );
      }

      if (
        error instanceof ContentDiffError &&
        error.code === 'MIGRATION_RUN_IN_PROGRESS'
      ) {
        const message = this.migrationRunInProgressMessage(error, {
          name,
          sourceEnvironmentId,
          destinationEnvironmentId,
          sourceEnvironments,
          destinationEnvironments,
          dualProfileSelection,
          profile: globalFlags.profile,
          apiTokenFlagProvided: commandLineFlags.has('api-token'),
          configFile: commandLineFlags.has('config-file')
            ? globalFlags['config-file']
            : undefined,
          migrationsDirectoryOverride: flags['migrations-dir'],
        });

        if (message) {
          this.error(message);
        }
      }

      if (
        error instanceof ContentDiffError &&
        error.code === 'SCHEMA_MISMATCH'
      ) {
        if (dualProfileSelection) {
          this.error(
            [
              `Incompatible schema: cannot generate content migration ${JSON.stringify(
                name,
              )} from "${sourceEnvironmentId}" to "${destinationEnvironmentId}" because the projects' managed schemas differ.`,
              'No content records were read and no migration artifacts were created.',
              'Apply the shared, checked-in schema migration history to the destination project, then regenerate the content diff.',
              'Schema autogeneration currently compares environments within one project and cannot repair cross-project drift.',
              '--migrate-invalid-content only handles supported invalid or historical-null content; it does not bypass schema compatibility.',
            ].join('\n'),
          );
        }

        const schemaReadyEnvironmentId = `${destinationEnvironmentId}-schema-ready`;

        this.error(
          [
            `Incompatible schema: cannot generate content migration ${JSON.stringify(
              name,
            )} from "${sourceEnvironmentId}" to "${destinationEnvironmentId}" because their managed schemas differ.`,
            'No content records were read and no migration artifacts were created.',
            'Generate the schema migration first:',
            `  datocms migrations:new ${JSON.stringify(
              `sync ${sourceEnvironmentId} schema`,
            )} --autogenerate=${JSON.stringify(
              `${sourceEnvironmentId}:${destinationEnvironmentId}`,
            )}`,
            'Apply it to a fork of the destination:',
            `  datocms migrations:run --source=${JSON.stringify(
              destinationEnvironmentId,
            )} --destination=${JSON.stringify(schemaReadyEnvironmentId)}`,
            'Then regenerate the content diff against that schema-ready fork:',
            `  datocms content:diff ${JSON.stringify(
              name,
            )} --autogenerate=${JSON.stringify(
              `${sourceEnvironmentId}:${schemaReadyEnvironmentId}`,
            )}`,
            '--migrate-invalid-content only handles supported invalid or historical-null content; it does not bypass schema compatibility.',
          ].join('\n'),
        );
      }

      throw error;
    }
  }

  /**
   * Explains a held run lock with the exact commands for the project that
   * holds the locked environment. Returns undefined when the error lacks the
   * details needed to build them, so its own message is shown instead.
   */
  private migrationRunInProgressMessage(
    error: ContentDiffError,
    context: {
      name: string;
      sourceEnvironmentId: string;
      destinationEnvironmentId: string;
      sourceEnvironments: EnvironmentSummary[];
      destinationEnvironments: EnvironmentSummary[];
      dualProfileSelection?: DualProfileSelection;
      /** The single-profile mode profile, from --profile or DATOCMS_PROFILE. */
      profile?: string;
      /** Whether single-profile mode authenticated with --api-token. */
      apiTokenFlagProvided: boolean;
      /** Set only when --config-file was typed; it names both profiles. */
      configFile?: string;
      migrationsDirectoryOverride?: string;
    },
  ): string | undefined {
    const details = error.details;
    const side = details?.side;
    const environmentId = details?.environmentId;
    const unlockToken = details?.unlockToken;
    const trackingModelApiKey = details?.trackingModelApiKey;

    if (
      (side !== 'source' && side !== 'destination') ||
      typeof environmentId !== 'string' ||
      typeof unlockToken !== 'string' ||
      typeof trackingModelApiKey !== 'string'
    ) {
      return undefined;
    }

    const dual = context.dualProfileSelection;
    const environments =
      side === 'source'
        ? context.sourceEnvironments
        : context.destinationEnvironments;
    // In dual-profile mode each side belongs to its own profile, and the
    // migrations directory flag only configures the destination.
    const profile = dual
      ? side === 'source'
        ? dual.sourceProfile
        : dual.destinationProfile
      : context.profile;
    const migrationsDirectory =
      dual && side === 'source'
        ? undefined
        : context.migrationsDirectoryOverride;
    const commandOptions = {
      environmentId,
      token: unlockToken,
      inPlace: true,
      primary: environments.some(
        (environment) =>
          environment.id === environmentId && environment.meta.primary,
      ),
      profile,
      configFile: context.configFile,
      migrationsDirectory,
      migrationsModelApiKey:
        trackingModelApiKey === DEFAULT_MIGRATIONS_MODEL_API_KEY
          ? undefined
          : trackingModelApiKey,
    };
    // Tokens are never echoed: the reader adds the one they passed.
    const explicitTokenFlag = dual
      ? side === 'source'
        ? dual.sourceApiToken && '--source-api-token'
        : dual.destinationApiToken && '--destination-api-token'
      : context.apiTokenFlagProvided && '--api-token';
    const lockDescription =
      typeof details?.lockDescription === 'string'
        ? ` (${details.lockDescription})`
        : '';

    return [
      `Migration run in progress: cannot generate content migration ${JSON.stringify(
        context.name,
      )} from "${context.sourceEnvironmentId}" to "${
        context.destinationEnvironmentId
      }".`,
      `${
        side === 'source' ? 'Source' : 'Destination'
      } environment "${environmentId}" is being migrated by migrations:run${lockDescription}.`,
      'A content diff generated now would compare a partially migrated state.',
      'No migration artifacts were created.',
      'Wait for that run to finish, then regenerate the content diff.',
      `If that run is no longer active, first review the migrations still pending in "${environmentId}":`,
      `  ${migrationsRunLockClearCommand(this.config.bin, {
        ...commandOptions,
        dryRun: true,
      })}`,
      `Then clear the stale lock. This also runs every pending migration in "${environmentId}":`,
      `  ${migrationsRunLockClearCommand(this.config.bin, commandOptions)}`,
      ...(explicitTokenFlag === '--api-token'
        ? ['Add the same --api-token to both commands.']
        : explicitTokenFlag
          ? [
              `Add --api-token with the token you passed as ${explicitTokenFlag} to both commands.`,
            ]
          : []),
    ].join('\n');
  }

  private parseItemTypes(rawItemTypes: string): 'all' | string[] {
    if (rawItemTypes === 'all') {
      return 'all';
    }

    const itemTypes = Array.from(
      new Set(
        rawItemTypes
          .split(',')
          .map((itemType) => itemType.trim())
          .filter(Boolean),
      ),
    );

    if (itemTypes.length === 0 || itemTypes.includes('all')) {
      this.error(
        '--item-types must be "all" or a comma-separated list of item type API keys',
      );
    }

    return itemTypes;
  }

  private resolveDestinationMigrationsSettings(
    profileMigrations: ProfileConfig['migrations'],
    flags: { 'migrations-dir'?: string; 'migrations-model'?: string },
  ): { directory: string; modelApiKey: string } {
    const settings = resolveMigrationsSettings({
      directoryOverride: flags['migrations-dir'],
      modelApiKeyOverride: flags['migrations-model'],
      profileMigrations,
      configPath: this.datoConfigPath,
    });

    if (isReservedMigrationsModelApiKey(settings.modelApiKey)) {
      this.error(RESERVED_MIGRATIONS_MODEL_MESSAGE);
    }

    return settings;
  }

  private resolveDualProfileSelection({
    requested,
    sourceProfile,
    destinationProfile,
    sourceApiToken,
    destinationApiToken,
    legacyFlagProvided,
  }: {
    requested: boolean;
    sourceProfile?: string;
    destinationProfile?: string;
    sourceApiToken?: string;
    destinationApiToken?: string;
    legacyFlagProvided: boolean;
  }): DualProfileSelection | undefined {
    if (!requested) {
      return undefined;
    }

    if (!sourceProfile || !destinationProfile) {
      this.error(
        '--source-profile and --destination-profile must be provided together',
      );
    }

    if (legacyFlagProvided) {
      this.error(
        '--profile and --api-token cannot be combined with --source-profile, --destination-profile, --source-api-token, or --destination-api-token',
      );
    }

    return {
      sourceProfile,
      destinationProfile,
      ...(sourceApiToken ? { sourceApiToken } : {}),
      ...(destinationApiToken ? { destinationApiToken } : {}),
    };
  }

  private async buildProfileEndpoint({
    profileId,
    explicitApiToken,
    endpointTokenFlag,
    json,
    baseUrl,
    logLevel,
    logMode,
  }: {
    profileId: string;
    explicitApiToken?: string;
    endpointTokenFlag: '--source-api-token' | '--destination-api-token';
    json: boolean;
    baseUrl?: string;
    logLevel?: LogLevelFlagEnum;
    logMode?: LogLevelModeEnum;
  }): Promise<ProfileEndpoint> {
    this.requireDatoConfig();

    const profileConfig = this.datoConfig!.profiles[profileId];

    if (!profileConfig) {
      this.error(
        `Requested profile "${profileId}" is not defined in config file "${this.datoConfigRelativePath}"`,
        {
          suggestions: [
            `Configure it with "${this.config.bin} profile:set ${profileId}"`,
          ],
        },
      );
    }

    const resolveLinkedSiteToken: ResolveLinkedSiteToken = (
      siteId,
      organizationId,
    ) =>
      ContentDiffCommand.resolveLinkedSiteToken(this, siteId, organizationId);
    const { apiToken, environmentName } = await resolveProfileApiToken({
      explicitApiToken,
      profileConfig,
      profileId,
      resolveLinkedSiteToken,
    });

    if (!apiToken) {
      this.error(
        `Cannot find an API token for profile "${profileId}" to call DatoCMS!`,
        {
          suggestions: [
            `Provide ${endpointTokenFlag}`,
            `Link profile "${profileId}" to a project with "${this.config.bin} link --profile=${profileId}" (requires "${this.config.bin} login" first)`,
            `Set the ${environmentName} environment variable (we look inside .env.local and .env too)`,
          ],
        },
      );
    }

    const profileLogLevel = logLevel || profileConfig.logLevel;
    const profileLogMode = logMode || profileConfig.logMode;
    // Registering the token with the command-wide redactor also removes it
    // from the other endpoint's logs.
    const clientOptions =
      this.credentialRedactor.protectClientOptions<CmaClient.ClientConfigOptions>(
        {
          apiToken,
          ...(baseUrl || profileConfig.baseUrl
            ? { baseUrl: baseUrl || profileConfig.baseUrl }
            : {}),
          logLevel:
            json || !profileLogLevel
              ? CmaClient.LogLevel.NONE
              : logLevelMap[profileLogLevel],
          logFn: this.buildApiLogFunction(profileLogMode),
        },
      );

    return {
      profileConfig,
      rootClient: ContentDiffCommand.buildProfileClient(clientOptions),
      buildEnvironmentClient: (environmentId) =>
        ContentDiffCommand.buildProfileClient({
          ...clientOptions,
          environment: environmentId,
        }),
    };
  }

  private buildApiLogFunction(
    logMode?: LogLevelModeEnum,
  ): (message: string) => void {
    return (message) => {
      if (logMode === 'directory') {
        const match = message.match(/^\[([^\]]+)\]/);

        if (!match) {
          return;
        }

        const logDirectory = './api-calls';
        if (!existsSync(logDirectory)) {
          mkdirSync(logDirectory, { recursive: true });
        }

        appendFileSync(join(logDirectory, `${match[1]}.log`), `${message}\n`, {
          encoding: 'utf8',
        });
      } else if (logMode === 'file') {
        appendFileSync('./api-calls.log', `${message}\n`, {
          encoding: 'utf8',
        });
      } else {
        this.log(message);
      }
    };
  }

  private resolveEnvironmentIds(
    rawAutogenerate: string,
    sourceEnvironments: EnvironmentSummary[],
    destinationEnvironments: EnvironmentSummary[],
    allowMatchingEnvironmentIds: boolean,
  ): {
    sourceEnvironmentId: string;
    destinationEnvironmentId: string;
  } {
    const parts = rawAutogenerate.split(':');

    if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) {
      this.error(
        '--autogenerate must use the format SOURCE or SOURCE:DESTINATION',
      );
    }

    const sourceEnvironmentId = parts[0];
    const primaryEnvironment = destinationEnvironments.find(
      (environment) => environment.meta.primary,
    );
    const destinationEnvironmentId = parts[1] || primaryEnvironment?.id;

    if (!destinationEnvironmentId) {
      this.error('Cannot determine the primary environment');
    }

    if (
      !sourceEnvironments.some(
        (environment) => environment.id === sourceEnvironmentId,
      )
    ) {
      this.error(`Environment "${sourceEnvironmentId}" does not exist`);
    }

    if (
      !destinationEnvironments.some(
        (environment) => environment.id === destinationEnvironmentId,
      )
    ) {
      this.error(`Environment "${destinationEnvironmentId}" does not exist`);
    }

    if (
      !allowMatchingEnvironmentIds &&
      sourceEnvironmentId === destinationEnvironmentId
    ) {
      this.error('Source and destination environments must be different');
    }

    return { sourceEnvironmentId, destinationEnvironmentId };
  }

  private async resolveMigrationFormat({
    forceJavaScript,
    forceTypeScript,
    migrationsTsconfig,
  }: {
    forceJavaScript: boolean;
    forceTypeScript: boolean;
    migrationsTsconfig?: string;
  }): Promise<MigrationFormat> {
    if (forceJavaScript) {
      return 'js';
    }

    if (forceTypeScript || migrationsTsconfig) {
      return 'ts';
    }

    try {
      await findNearestFile('tsconfig.json');
      return 'ts';
    } catch {
      return 'js';
    }
  }

  private printHumanResult(
    result: ContentDiffCommandResult,
    summary: ContentDiffMigrationSummary,
  ): void {
    if (this.jsonEnabled()) {
      return;
    }

    this.log(
      `Content diff: ${result.sourceEnvironmentId} -> ${result.destinationEnvironmentId}`,
    );
    this.log(`Migration: ${relative(process.cwd(), result.migrationFilePath)}`);
    this.log(`Plan: ${relative(process.cwd(), result.planFilePath)}`);
    this.log(`Runtime: ${relative(process.cwd(), result.runtimeFilePath)}`);

    if (result.assetsDirectoryPath) {
      this.log(
        `Assets: ${relative(process.cwd(), result.assetsDirectoryPath)}`,
      );
    }

    for (const override of result.tuningOverrides ?? []) {
      this.log(
        `Tuning: ${override.variable}=${override.valueMs} (default ${override.defaultMs})`,
      );
    }

    if (summary.invalidContent.requiresTemporaryValidatorRelaxation) {
      this.warn(
        `TEMPORARY VALIDATOR RELAXATION: this migration will relax ${
          summary.invalidContent.relaxedValidatorCount
        } validator${
          summary.invalidContent.relaxedValidatorCount === 1 ? '' : 's'
        } across ${summary.invalidContent.relaxedFieldCount} field${
          summary.invalidContent.relaxedFieldCount === 1 ? '' : 's'
        } while migrating ${
          summary.invalidContent.migratedRecords
        } invalid record${
          summary.invalidContent.migratedRecords === 1 ? '' : 's'
        }.`,
      );
      this.warn(
        'RESIDUAL RISK: if execution stops after schema relaxation, validators can remain relaxed until this same migration is rerun successfully. There is no cross-resource rollback. Running on primary additionally requires migrations:run --in-place --allow-primary.',
      );
    }

    if (summary.legacyIdMappings.length > 0) {
      const newCount = summary.legacyIdMappings.filter(
        ({ status }) => status === 'new',
      ).length;
      this.warn(
        `LEGACY ID REMAPPING: ${
          summary.legacyIdMappings.length
        } legacy identifier${
          summary.legacyIdMappings.length === 1 ? '' : 's'
        } detected. Legacy IDs cannot be preserved. This migration will assign new IDs and persist aliases in the datocms_content_diff model. External consumers using the old IDs must be updated. ${newCount} new mapping${
          newCount === 1 ? '' : 's'
        } will be saved in the append-only ledger before content writes.`,
      );
    }

    if (summary.skippedLegacyIdMappings.length > 0) {
      this.warn(
        `LEGACY IDS SKIPPED: ${
          summary.skippedLegacyIdMappings.length
        } legacy identifier${
          summary.skippedLegacyIdMappings.length === 1 ? '' : 's'
        } belonged only to skipped content. These entities will not be migrated, and no new alias reservations will be written for them.`,
      );
    }

    if (summary.invalidContent.skippedRecords > 0) {
      this.warn(
        `PARTIAL CONTENT DIFF: ${
          summary.invalidContent.skippedRecords
        } top-level record aggregate${
          summary.invalidContent.skippedRecords === 1 ? ' was' : 's were'
        } skipped. Review the diagnostics below before running the migration.`,
      );
    }

    this.log('Changes:');
    const counts = Object.entries(summary.counts).filter(
      ([, count]) => count > 0,
    );

    if (counts.length === 0) {
      this.log('  none');
    } else {
      for (const [change, count] of counts) {
        this.log(`  ${change}: ${count}`);
      }
    }

    if (summary.records.length > 0) {
      this.log('Records:');
      for (const record of summary.records) {
        this.log(
          `  ${record.action} ${record.itemTypeId}/${record.id}${
            record.title ? ` (${record.title})` : ''
          }`,
        );
      }
    }

    if (summary.uploads.length > 0) {
      this.log('Uploads:');
      for (const upload of summary.uploads) {
        this.log(
          `  ${upload.action} ${upload.id}${
            upload.filename ? ` (${upload.filename})` : ''
          }`,
        );
      }
    }

    if (summary.skippedRecords.length > 0) {
      this.log('Skipped records:');
      for (const record of summary.skippedRecords) {
        for (const reason of record.reasons) {
          this.log(
            `  model=${record.itemTypeId} id=${record.id} slice=${
              reason.slice ?? 'aggregate'
            } reason=${reason.code}`,
          );
          this.log(
            `    dependency chain: ${
              reason.dependencyChain.length > 0
                ? reason.dependencyChain.join(' -> ')
                : 'none'
            }`,
          );
        }
      }
    }

    if (summary.validatorRelaxations.length > 0) {
      this.log('Validator relaxations:');
      for (const relaxation of summary.validatorRelaxations) {
        this.log(
          `  model=${relaxation.itemTypeId} field=${
            relaxation.fieldId
          } validators=${
            relaxation.relaxedValidatorKeys.join(',') || 'none'
          } records=${relaxation.affectedRecordIds.join(',') || 'none'}`,
        );
      }
    }

    if (summary.legacyIdMappings.length > 0) {
      this.log('Legacy ID mappings:');
      for (const mapping of summary.legacyIdMappings) {
        this.log(
          `  ${mapping.entityType} ${mapping.sourceId} -> ${mapping.targetId} (${mapping.status})`,
        );
      }
    }

    if (summary.skippedLegacyIdMappings.length > 0) {
      this.log('Skipped legacy IDs (not migrated):');
      for (const diagnostic of summary.skippedLegacyIdMappings) {
        this.log(
          `  ${diagnostic.entityType} ${diagnostic.sourceId}: ${diagnostic.reason}`,
        );
      }
    }

    if (summary.destructiveActions.length > 0) {
      this.log('Destructive actions:');
      for (const action of summary.destructiveActions) {
        this.log(`  ${action}`);
      }
    }

    if (summary.warnings.length > 0) {
      this.log('Warnings:');
      for (const warning of summary.warnings) {
        this.log(`  ${warning}`);
      }
    }
  }
}

function toPublicInvalidContentSummary(
  summary: ContentDiffMigrationSummary['invalidContent'],
): PublicInvalidContentSummary {
  return {
    partial: summary.status === 'partial',
    detectedRecordCount: summary.detectedRecords,
    migratedRecordCount: summary.migratedRecords,
    skippedRecordCount: summary.skippedRecords,
    propagatedSkipCount: summary.propagatedSkipCount,
    relaxedFieldCount: summary.relaxedFieldCount,
    relaxedValidatorCount: summary.relaxedValidatorCount,
    requiresTemporaryValidatorRelaxation:
      summary.requiresTemporaryValidatorRelaxation,
  };
}

function toPublicLegacyIdSummary(
  summary: ContentDiffMigrationSummary,
): PublicLegacyIdSummary {
  const newLegacyIdMappingCount = summary.legacyIdMappings.filter(
    ({ status }) => status === 'new',
  ).length;
  return {
    detectedLegacyIdCount:
      summary.legacyIdMappings.length + summary.skippedLegacyIdMappings.length,
    legacyIdMappingCount: summary.legacyIdMappings.length,
    newLegacyIdMappingCount,
    skippedLegacyIdCount: summary.skippedLegacyIdMappings.length,
    mappingRecordCount: summary.legacyIdMappings.length
      ? summary.counts['legacyIdMappings.records'] ?? 0
      : 0,
    requiresLegacyIdRemapping: summary.legacyIdMappings.length > 0,
  };
}

function normalizeSummary(
  summary: ContentDiffMigrationSummary,
): ContentDiffMigrationSummary {
  return {
    counts: Object.fromEntries(
      Object.entries(summary.counts).sort(([left], [right]) =>
        compareStrings(left, right),
      ),
    ),
    records: [...summary.records].sort(
      (left, right) =>
        compareStrings(left.itemTypeId, right.itemTypeId) ||
        compareStrings(left.id, right.id) ||
        compareStrings(left.action, right.action),
    ),
    uploads: [...summary.uploads].sort(
      (left, right) =>
        compareStrings(left.id, right.id) ||
        compareStrings(left.action, right.action),
    ),
    invalidContent: { ...summary.invalidContent },
    skippedRecords: summary.skippedRecords
      .map((record) => ({
        ...record,
        reasons: [...record.reasons].sort(
          (left, right) =>
            compareStrings(left.slice ?? '', right.slice ?? '') ||
            compareStrings(left.code, right.code) ||
            compareStrings(left.dependencyId ?? '', right.dependencyId ?? '') ||
            compareStrings(
              left.dependencyChain.join('\0'),
              right.dependencyChain.join('\0'),
            ),
        ),
      }))
      .sort(
        (left, right) =>
          compareStrings(left.itemTypeId, right.itemTypeId) ||
          compareStrings(left.id, right.id) ||
          compareStrings(left.disposition, right.disposition),
      ),
    validatorRelaxations: summary.validatorRelaxations
      .map((relaxation) => ({
        ...relaxation,
        relaxedValidatorKeys: [...relaxation.relaxedValidatorKeys].sort(
          compareStrings,
        ),
        affectedRecordIds: [...relaxation.affectedRecordIds].sort(
          compareStrings,
        ),
      }))
      .sort(
        (left, right) =>
          compareStrings(left.itemTypeId, right.itemTypeId) ||
          compareStrings(left.fieldId, right.fieldId),
      ),
    legacyIdMappings: [...summary.legacyIdMappings].sort(
      (left, right) =>
        compareStrings(left.entityType, right.entityType) ||
        compareStrings(left.sourceId, right.sourceId),
    ),
    skippedLegacyIdMappings: [...summary.skippedLegacyIdMappings].sort(
      (left, right) =>
        compareStrings(left.entityType, right.entityType) ||
        compareStrings(left.sourceId, right.sourceId) ||
        compareStrings(left.reason, right.reason),
    ),
    destructiveActions: [...summary.destructiveActions].sort(compareStrings),
    warnings: [...summary.warnings].sort(compareStrings),
  };
}

const DUAL_PROFILE_FLAGS = [
  'source-profile',
  'destination-profile',
  'source-api-token',
  'destination-api-token',
] as const;

/**
 * Names of the flags typed on the command line. Parser tokens stop at a `--`
 * terminator, cover both `--flag value` and `--flag=value`, and never include
 * values oclif filled in from flag defaults or environment variables such as
 * DATOCMS_PROFILE.
 */
function commandLineFlagNames(raw: readonly ParsedToken[]): Set<string> {
  return new Set(
    raw.flatMap((token) =>
      token.type === 'flag' && token.flag ? [token.flag] : [],
    ),
  );
}

function hasDualProfileFlag(flagNames: ReadonlySet<string>): boolean {
  return DUAL_PROFILE_FLAGS.some((flag) => flagNames.has(flag));
}
