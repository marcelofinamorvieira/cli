import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type CmaClient, CmaClientCommand } from '@datocms/cli-utils';
import { runCommand } from '@oclif/test';
import { expect } from 'chai';
import ContentDiffCommand from '../../../src/commands/content/diff';
import {
  ContentDiffError,
  type ContentDiffMigrationSummary,
} from '../../../src/content-diff';
import {
  type FakeCmaRequest,
  type FakeCmaResponse,
  apiErrorResponse,
  environmentsResponse,
  expectAuthenticatedWith,
  expectRedactedCmaOutput,
  requestedEnvironments,
  siteResponse,
  startFakeCmaServer,
} from '../fake-cma-server';

// oclif derives the command prefix from the plugin package when testing it
// directly; the installed plugin runs under the host's `datocms` binary.
const pluginPackage = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'),
) as { name: string; oclif?: { bin?: string } };
const BIN = pluginPackage.oclif?.bin ?? pluginPackage.name;
const LOCK_DESCRIPTION =
  'run feedfacefeedface, started 2026-09-28T10:00:00.000Z, pid 31337';

type GenerateMigration = typeof ContentDiffCommand.generateMigration;
type GenerateMigrationInput = Parameters<GenerateMigration>[0];
type GenerateMigrationResult = Awaited<ReturnType<GenerateMigration>>;

const commandPrototype = CmaClientCommand.prototype as unknown as {
  buildClient: (options?: { environment?: string }) => Promise<unknown>;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('content:diff', () => {
  let temporaryDirectory: string;
  let configPath: string;
  let capturedInput: GenerateMigrationInput | undefined;
  let generatedSummary: ContentDiffMigrationSummary;
  let originalBuildClient: typeof commandPrototype.buildClient;
  let originalGenerateMigration: GenerateMigration;
  let originalBuildProfileClient: typeof ContentDiffCommand.buildProfileClient;
  let originalResolveLinkedSiteToken: typeof ContentDiffCommand.resolveLinkedSiteToken;
  let environmentListCalls: number;

  beforeEach(async () => {
    capturedInput = undefined;
    environmentListCalls = 0;
    generatedSummary = buildGeneratedSummary();
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'datocms-content-diff-'));
    configPath = join(temporaryDirectory, 'datocms.config.json');

    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          default: {
            migrations: {
              directory: 'custom-migrations',
              modelApiKey: 'migration_log',
              tsconfig: 'tsconfig.migrations.json',
            },
          },
        },
      }),
    );

    originalBuildClient = commandPrototype.buildClient;
    commandPrototype.buildClient = async () => ({
      environments: {
        list: async () => {
          environmentListCalls += 1;
          return [
            { id: 'primary', meta: { primary: true } },
            { id: 'source', meta: { primary: false } },
            { id: 'destination', meta: { primary: false } },
          ];
        },
      },
    });

    originalGenerateMigration = ContentDiffCommand.generateMigration;
    originalBuildProfileClient = ContentDiffCommand.buildProfileClient;
    originalResolveLinkedSiteToken = ContentDiffCommand.resolveLinkedSiteToken;
    ContentDiffCommand.generateMigration = async (input) => {
      capturedInput = input;
      return buildGeneratedResult(input, generatedSummary);
    };
  });

  afterEach(async () => {
    commandPrototype.buildClient = originalBuildClient;
    ContentDiffCommand.generateMigration = originalGenerateMigration;
    ContentDiffCommand.buildProfileClient = originalBuildProfileClient;
    ContentDiffCommand.resolveLinkedSiteToken = originalResolveLinkedSiteToken;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('uses the primary destination and configured TypeScript convention', async () => {
    const { stdout, error } = await runCommand(
      `content:diff "sync source content" --autogenerate=source --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(capturedInput?.source.environmentId).to.equal('source');
    expect(capturedInput?.destination.environmentId).to.equal('primary');
    expect(capturedInput?.format).to.equal('ts');
    expect(capturedInput?.options).to.deep.equal({
      itemTypes: 'all',
      uploads: 'referenced',
      includeDeletions: false,
      bundleAssets: false,
      migrateInvalidContent: false,
    });
    expect(capturedInput?.source.migrationsModelApiKey).to.equal(
      'migration_log',
    );
    expect(capturedInput?.destination.migrationsModelApiKey).to.equal(
      'migration_log',
    );
    expect(dirname(capturedInput!.migrationFilePath)).to.equal(
      join(temporaryDirectory, 'custom-migrations'),
    );
    expect(basename(capturedInput!.migrationFilePath)).to.match(
      /^\d+_syncSourceContent\.ts$/,
    );
    expect(stdout).to.contain('Content diff: source -> primary');
    expect(stdout).to.contain('Changes:');
    expect(stdout).to.contain('  none');
  });

  it('supports an explicit destination, filters, deletion, bundling, and JSON', async () => {
    generatedSummary = buildInvalidContentSummary();
    generatedSummary.counts['legacyIdMappings.records'] = 1;
    generatedSummary.counts['legacyIdMappings.detected'] = 3;
    generatedSummary.counts['legacyIdMappings.skipped'] = 1;
    generatedSummary.legacyIdMappings = [
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: 'YhEa5SbeSl6KwIFizzkzig',
        status: 'new',
      },
      {
        entityType: 'upload',
        sourceId: '178178742',
        targetId: 'LQQiCYCfSU6DTmCQ63-JRw',
        status: 'existing',
      },
    ];
    generatedSummary.skippedLegacyIdMappings = [
      {
        entityType: 'block',
        sourceId: '178178743',
        reason:
          'owning or referring aggregate skipped: INVALID_CURRENT (current)',
      },
    ];

    const { stdout, error } = await runCommand(
      `content:diff "sync selected content" --autogenerate=source:destination --item-types=article,author,article --uploads=all --include-deletions --bundle-assets --migrate-invalid-content --js --json --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(capturedInput?.destination.environmentId).to.equal('destination');
    expect(capturedInput?.format).to.equal('js');
    expect(capturedInput?.options).to.deep.equal({
      itemTypes: ['article', 'author'],
      uploads: 'all',
      includeDeletions: true,
      bundleAssets: true,
      migrateInvalidContent: true,
    });

    const output = JSON.parse(stdout) as {
      sourceEnvironmentId: string;
      destinationEnvironmentId: string;
      format: string;
      summary: {
        counts: Record<string, number>;
        destructiveActionCount: number;
        warningCount: number;
        invalidContent: Record<string, unknown>;
        legacyIds: Record<string, unknown>;
      };
    };

    expect(output).to.include({
      sourceEnvironmentId: 'source',
      destinationEnvironmentId: 'destination',
      format: 'js',
    });
    expect(output.summary).to.deep.equal({
      counts: {
        'records.create': 0,
        'records.delete': 0,
        'records.update': 0,
        'uploadCollections.create': 0,
        'uploadCollections.update': 0,
        'uploads.create': 0,
        'uploads.delete': 0,
        'uploads.update': 0,
        'legacyIdMappings.records': 1,
        'legacyIdMappings.detected': 3,
        'legacyIdMappings.skipped': 1,
      },
      destructiveActionCount: 0,
      warningCount: 1,
      invalidContent: {
        partial: true,
        detectedRecordCount: 3,
        migratedRecordCount: 1,
        skippedRecordCount: 2,
        propagatedSkipCount: 1,
        relaxedFieldCount: 1,
        relaxedValidatorCount: 2,
        requiresTemporaryValidatorRelaxation: true,
      },
      legacyIds: {
        detectedLegacyIdCount: 3,
        legacyIdMappingCount: 2,
        newLegacyIdMappingCount: 1,
        skippedLegacyIdCount: 1,
        mappingRecordCount: 1,
        requiresLegacyIdRemapping: true,
      },
    });
    expect(output.summary).not.to.have.property('records');
    expect(output.summary).not.to.have.property('uploads');
    expect(output.summary).not.to.have.property('warnings');
    expect(output.summary).not.to.have.property('skippedRecords');
    expect(output.summary).not.to.have.property('validatorRelaxations');
    expect(stdout).not.to.contain('178178741');
    expect(stdout).not.to.contain('178178743');
    expect(stdout).not.to.contain('YhEa5SbeSl6KwIFizzkzig');
    expect(stdout).not.to.contain('record-skipped');
    expect(stdout).not.to.contain('DEPENDENCY_ON_SKIPPED_RECORD');
    expect(stdout).not.to.contain('Content diff:');
  });

  it('prints a prominent legacy-ID warning and reviewable mappings', async () => {
    generatedSummary = buildGeneratedSummary();
    generatedSummary.counts['legacyIdMappings.records'] = 1;
    generatedSummary.legacyIdMappings = [
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: 'YhEa5SbeSl6KwIFizzkzig',
        status: 'new',
      },
    ];
    generatedSummary.skippedLegacyIdMappings = [
      {
        entityType: 'block',
        sourceId: '178178742',
        reason:
          'owning or referring aggregate skipped: INVALID_CURRENT (current)',
      },
    ];

    const { stdout, stderr, error } = await runCommand(
      `content:diff "sync legacy content" --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    const warningOutput = stderr
      .replace(/›\s+(?:Warning:\s*)?/g, '')
      .replace(/\s+/g, ' ');
    expect(warningOutput).to.contain('LEGACY ID REMAPPING');
    expect(warningOutput).to.contain('LEGACY IDS SKIPPED');
    for (const phrase of [
      'Legacy IDs cannot',
      'be preserved',
      'persist aliases',
      'datocms_content_diff model',
      'External consumers',
      'using the old IDs must be updated',
    ]) {
      expect(warningOutput).to.contain(phrase);
    }
    expect(stdout).to.contain('Legacy ID mappings:');
    expect(stdout).to.contain(
      'record 178178741 -> YhEa5SbeSl6KwIFizzkzig (new)',
    );
    expect(stdout).to.contain('Skipped legacy IDs (not migrated):');
    expect(stdout).to.contain(
      'block 178178742: owning or referring aggregate skipped: INVALID_CURRENT (current)',
    );
  });

  it('prints deterministic skipped-record diagnostics and prominent relaxation risk without field values', async () => {
    generatedSummary = buildInvalidContentSummary();

    const { stdout, stderr, error } = await runCommand(
      `content:diff "sync invalid content" --autogenerate=source:destination --migrate-invalid-content --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(capturedInput?.options.migrateInvalidContent).to.equal(true);
    expect(stderr).to.contain('TEMPORARY VALIDATOR RELAXATION');
    expect(stderr).to.contain('RESIDUAL RISK');
    expect(stderr).to.contain('PARTIAL CONTENT DIFF');
    expect(stderr).to.contain('migrations:run --in-place --allow-primary');
    expect(stdout).to.contain('Skipped records:');
    expect(stdout).to.contain(
      'model=model-a id=record-skipped slice=current reason=INVALID_CURRENT',
    );
    expect(stdout).to.contain('dependency chain: none');
    expect(stdout).to.contain(
      'model=model-a id=record-skipped slice=published reason=DEPENDENCY_ON_SKIPPED_RECORD',
    );
    expect(stdout).to.contain(
      'dependency chain: record-root -> record-skipped',
    );
    expect(stdout.indexOf('reason=INVALID_CURRENT')).to.be.lessThan(
      stdout.indexOf('reason=DEPENDENCY_ON_SKIPPED_RECORD'),
    );
    expect(stdout).to.contain(
      'model=model-a field=field-title validators=length,required records=record-a,record-z',
    );
    expect(`${stdout}${stderr}`).not.to.contain('private field value');
  });

  it('excludes the default schema migration tracking model', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          default: {
            migrations: { directory: 'migrations' },
          },
        },
      }),
    );

    const { error } = await runCommand(
      `content:diff sync --autogenerate=source --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(capturedInput?.destination.migrationsModelApiKey).to.equal(
      'schema_migration',
    );
  });

  it('rejects malformed and identical environment selections', async () => {
    const malformed = await runCommand(
      `content:diff sync --autogenerate=source: --config-file=${configPath}`,
    );
    const identical = await runCommand(
      `content:diff sync --autogenerate=source:source --config-file=${configPath}`,
    );

    expect(malformed.error?.message).to.contain('SOURCE or SOURCE:DESTINATION');
    expect(identical.error?.message).to.contain(
      'Source and destination environments must be different',
    );
    expect(capturedInput).to.equal(undefined);
  });

  it('rejects unknown environments before generating files', async () => {
    const missingSource = await runCommand(
      `content:diff sync --autogenerate=missing:destination --config-file=${configPath}`,
    );
    const missingDestination = await runCommand(
      `content:diff sync --autogenerate=source:missing --config-file=${configPath}`,
    );

    expect(missingSource.error?.message).to.contain(
      'Environment "missing" does not exist',
    );
    expect(missingDestination.error?.message).to.contain(
      'Environment "missing" does not exist',
    );
    expect(capturedInput).to.equal(undefined);
  });

  it('uses independent profile clients and destination-owned migration settings', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: {
            siteId: 'source-site',
            migrations: {
              directory: 'source-migrations',
              modelApiKey: 'source_migration_log',
            },
          },
          destination_project: {
            siteId: 'destination-site',
            migrations: {
              directory: 'destination-migrations',
              modelApiKey: 'destination_migration_log',
              tsconfig: 'destination.tsconfig.json',
            },
          },
        },
      }),
    );

    const builtClients: Array<{
      options: CmaClient.ClientConfigOptions;
      client: CmaClient.Client;
    }> = [];
    installDualProfileClientFactory({
      builtClients,
      sourceCredential: 'source-explicit-credential',
      destinationCredential: 'destination-explicit-credential',
    });
    ContentDiffCommand.resolveLinkedSiteToken = async () => {
      throw new Error('Explicit endpoint credentials must take precedence');
    };

    const { stdout, stderr, error } = await runCommand(
      `content:diff "sync aligned projects" --source-profile=source_project --destination-profile=destination_project --source-api-token=source-explicit-credential --destination-api-token=destination-explicit-credential --autogenerate=main --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(capturedInput?.source.environmentId).to.equal('main');
    expect(capturedInput?.destination.environmentId).to.equal('main');
    expect(capturedInput?.source.migrationsModelApiKey).to.equal(
      'source_migration_log',
    );
    expect(capturedInput?.destination.migrationsModelApiKey).to.equal(
      'destination_migration_log',
    );
    expect(dirname(capturedInput!.migrationFilePath)).to.equal(
      join(temporaryDirectory, 'destination-migrations'),
    );
    expect(capturedInput?.format).to.equal('ts');

    const sourceRoot = builtClients.find(
      ({ options }) =>
        options.apiToken === 'source-explicit-credential' &&
        !options.environment,
    );
    const sourceEnvironment = builtClients.find(
      ({ options }) =>
        options.apiToken === 'source-explicit-credential' &&
        options.environment === 'main',
    );
    const destinationRoot = builtClients.find(
      ({ options }) =>
        options.apiToken === 'destination-explicit-credential' &&
        !options.environment,
    );
    const destinationEnvironment = builtClients.find(
      ({ options }) =>
        options.apiToken === 'destination-explicit-credential' &&
        options.environment === 'main',
    );
    expect(capturedInput?.source.rootClient).to.equal(sourceRoot?.client);
    expect(capturedInput?.source.environmentClient).to.equal(
      sourceEnvironment?.client,
    );
    expect(capturedInput?.destination.rootClient).to.equal(
      destinationRoot?.client,
    );
    expect(capturedInput?.destination.environmentClient).to.equal(
      destinationEnvironment?.client,
    );
    expect(`${stdout}${stderr}`).not.to.contain('source-explicit-credential');
    expect(`${stdout}${stderr}`).not.to.contain(
      'destination-explicit-credential',
    );
    expect(`${stdout}${stderr}`).not.to.contain('source_project');
    expect(`${stdout}${stderr}`).not.to.contain('destination_project');
  });

  it('redacts both endpoint credentials from verbose CMA logs', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: { migrations: { directory: 'source-migrations' } },
          destination_project: {
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    const sourceCredential = 'source-secret-body-and-headers';
    const destinationCredential = 'destination-secret-body-and-headers';

    ContentDiffCommand.buildProfileClient = (options) => {
      const isSource = options.apiToken === sourceCredential;
      const isDestination = options.apiToken === destinationCredential;
      if (!isSource && !isDestination) {
        throw new Error('Unexpected profile credential');
      }
      options.logFn?.(
        `[1] request headers authorization: Bearer ${options.apiToken}`,
      );
      return {
        environments: {
          list: async () => [{ id: 'main', meta: { primary: true } }],
        },
      } as unknown as CmaClient.Client;
    };

    const { stdout, stderr, error } = await runCommand(
      `content:diff sync --source-profile=source_project --destination-profile=destination_project --source-api-token=${sourceCredential} --destination-api-token=${destinationCredential} --autogenerate=main:main --log-level=BODY_AND_HEADERS --log-mode=stdout --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(`${stdout}${stderr}`).to.contain('[REDACTED]');
    expect(`${stdout}${stderr}`).not.to.contain(sourceCredential);
    expect(`${stdout}${stderr}`).not.to.contain(destinationCredential);
  });

  it('resolves linked projects independently before profile environment variables', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: {
            siteId: 'source-site',
            organizationId: 'source-organization',
            apiTokenEnvName: 'TEST_SOURCE_PROFILE_CREDENTIAL',
            migrations: { directory: 'source-migrations' },
          },
          destination_project: {
            siteId: 'destination-site',
            organizationId: 'destination-organization',
            apiTokenEnvName: 'TEST_DESTINATION_PROFILE_CREDENTIAL',
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    const previousSourceCredential = process.env.TEST_SOURCE_PROFILE_CREDENTIAL;
    const previousDestinationCredential =
      process.env.TEST_DESTINATION_PROFILE_CREDENTIAL;
    process.env.TEST_SOURCE_PROFILE_CREDENTIAL = 'ignored-source-environment';
    process.env.TEST_DESTINATION_PROFILE_CREDENTIAL =
      'ignored-destination-environment';
    const linkedSiteRequests: Array<{
      siteId: string;
      organizationId?: string;
    }> = [];
    ContentDiffCommand.resolveLinkedSiteToken = async (
      _command,
      siteId,
      organizationId,
    ) => {
      linkedSiteRequests.push({ siteId, organizationId });
      return siteId === 'source-site'
        ? 'source-oauth-credential'
        : 'destination-oauth-credential';
    };
    const builtClients: Array<{
      options: CmaClient.ClientConfigOptions;
      client: CmaClient.Client;
    }> = [];
    installDualProfileClientFactory({
      builtClients,
      sourceCredential: 'source-oauth-credential',
      destinationCredential: 'destination-oauth-credential',
    });

    try {
      const { error } = await runCommand(
        `content:diff sync --source-profile=source_project --destination-profile=destination_project --autogenerate=source:destination --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(linkedSiteRequests).to.have.deep.members([
        {
          siteId: 'source-site',
          organizationId: 'source-organization',
        },
        {
          siteId: 'destination-site',
          organizationId: 'destination-organization',
        },
      ]);
      expect(
        builtClients.some(
          ({ options }) => options.apiToken === 'ignored-source-environment',
        ),
      ).to.equal(false);
      expect(
        builtClients.some(
          ({ options }) =>
            options.apiToken === 'ignored-destination-environment',
        ),
      ).to.equal(false);
    } finally {
      restoreEnvironmentVariable(
        'TEST_SOURCE_PROFILE_CREDENTIAL',
        previousSourceCredential,
      );
      restoreEnvironmentVariable(
        'TEST_DESTINATION_PROFILE_CREDENTIAL',
        previousDestinationCredential,
      );
    }
  });

  it('resolves each unlinked profile from its configured environment variable', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: {
            apiTokenEnvName: 'TEST_SOURCE_PROFILE_CREDENTIAL',
            migrations: { directory: 'source-migrations' },
          },
          destination_project: {
            apiTokenEnvName: 'TEST_DESTINATION_PROFILE_CREDENTIAL',
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    const previousSourceCredential = process.env.TEST_SOURCE_PROFILE_CREDENTIAL;
    const previousDestinationCredential =
      process.env.TEST_DESTINATION_PROFILE_CREDENTIAL;
    process.env.TEST_SOURCE_PROFILE_CREDENTIAL = 'source-env-credential';
    process.env.TEST_DESTINATION_PROFILE_CREDENTIAL =
      'destination-env-credential';
    const builtClients: Array<{
      options: CmaClient.ClientConfigOptions;
      client: CmaClient.Client;
    }> = [];
    installDualProfileClientFactory({
      builtClients,
      sourceCredential: 'source-env-credential',
      destinationCredential: 'destination-env-credential',
    });

    try {
      const { error } = await runCommand(
        `content:diff sync --source-profile=source_project --destination-profile=destination_project --autogenerate=source:destination --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(
        builtClients.some(
          ({ options }) => options.apiToken === 'source-env-credential',
        ),
      ).to.equal(true);
      expect(
        builtClients.some(
          ({ options }) => options.apiToken === 'destination-env-credential',
        ),
      ).to.equal(true);
    } finally {
      restoreEnvironmentVariable(
        'TEST_SOURCE_PROFILE_CREDENTIAL',
        previousSourceCredential,
      );
      restoreEnvironmentVariable(
        'TEST_DESTINATION_PROFILE_CREDENTIAL',
        previousDestinationCredential,
      );
    }
  });

  it('rejects partial or ambiguous dual-profile authentication flags', async () => {
    const missingDestination = await runCommand(
      `content:diff sync --source-profile=source_project --autogenerate=source:destination --config-file=${configPath}`,
    );
    const endpointTokenWithoutProfiles = await runCommand(
      `content:diff sync --source-api-token=source-credential --autogenerate=source:destination --config-file=${configPath}`,
    );
    const legacyProfile = await runCommand(
      `content:diff sync --source-profile=default --destination-profile=default --profile=default --autogenerate=source:destination --config-file=${configPath}`,
    );
    const legacyToken = await runCommand(
      `content:diff sync --source-profile=default --destination-profile=default --api-token=legacy-credential --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(missingDestination.error?.message).to.contain(
      '--source-profile and --destination-profile must be provided together',
    );
    expect(endpointTokenWithoutProfiles.error?.message).to.contain(
      '--source-profile and --destination-profile must be provided together',
    );
    expect(legacyProfile.error?.message).to.contain(
      '--profile and --api-token cannot be combined',
    );
    expect(legacyToken.error?.message).to.contain(
      '--profile and --api-token cannot be combined',
    );
    expect(capturedInput).to.equal(undefined);
  });

  it('validates source and destination environments against their respective projects', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: { migrations: { directory: 'source-migrations' } },
          destination_project: {
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    const builtClients: Array<{
      options: CmaClient.ClientConfigOptions;
      client: CmaClient.Client;
    }> = [];
    installDualProfileClientFactory({
      builtClients,
      sourceCredential: 'source-credential',
      destinationCredential: 'destination-credential',
    });
    const commonFlags = `--source-profile=source_project --destination-profile=destination_project --source-api-token=source-credential --destination-api-token=destination-credential --config-file=${configPath}`;

    const missingSource = await runCommand(
      `content:diff sync --autogenerate=destination:destination ${commonFlags}`,
    );
    const missingDestination = await runCommand(
      `content:diff sync --autogenerate=source:source ${commonFlags}`,
    );

    expect(missingSource.error?.message).to.contain(
      'Environment "destination" does not exist',
    );
    expect(missingDestination.error?.message).to.contain(
      'Environment "source" does not exist',
    );
    expect(capturedInput).to.equal(undefined);
  });

  it('does not recommend single-project schema autogeneration for aligned projects', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: { migrations: { directory: 'source-migrations' } },
          destination_project: {
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    const builtClients: Array<{
      options: CmaClient.ClientConfigOptions;
      client: CmaClient.Client;
    }> = [];
    installDualProfileClientFactory({
      builtClients,
      sourceCredential: 'source-credential',
      destinationCredential: 'destination-credential',
    });
    ContentDiffCommand.generateMigration = async () => {
      throw new ContentDiffError('SCHEMA_MISMATCH', 'Internal diagnostic.');
    };

    const { error } = await runCommand(
      `content:diff "sync shared content" --source-profile=source_project --destination-profile=destination_project --source-api-token=source-credential --destination-api-token=destination-credential --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'Apply the shared, checked-in schema migration history',
    );
    expect(error?.message).to.contain(
      'Schema autogeneration currently compares environments within one project',
    );
    expect(error?.message).not.to.contain('datocms migrations:new');
  });

  it('translates schema mismatches into an actionable generation error', async () => {
    ContentDiffCommand.generateMigration = async () => {
      throw new ContentDiffError(
        'SCHEMA_MISMATCH',
        'Internal schema diagnostic that should not replace command guidance.',
      );
    };

    const { error, stdout, stderr } = await runCommand(
      `content:diff "sync schema-sensitive content" --autogenerate=source:destination --migrate-invalid-content --api-token=not-a-real-secret --config-file=${configPath}`,
    );

    expect(error?.message).to.equal(
      [
        'Incompatible schema: cannot generate content migration "sync schema-sensitive content" from "source" to "destination" because their managed schemas differ.',
        'No content records were read and no migration artifacts were created.',
        'Generate the schema migration first:',
        '  datocms migrations:new "sync source schema" --autogenerate="source:destination"',
        'Apply it to a fork of the destination:',
        '  datocms migrations:run --source="destination" --destination="destination-schema-ready"',
        'Then regenerate the content diff against that schema-ready fork:',
        '  datocms content:diff "sync schema-sensitive content" --autogenerate="source:destination-schema-ready"',
        '--migrate-invalid-content only handles supported invalid or historical-null content; it does not bypass schema compatibility.',
      ].join('\n'),
    );
    expect(`${stdout}${stderr}${error?.message}`).not.to.contain(
      'not-a-real-secret',
    );
  });

  it('does not present schema autogeneration as sufficient for activation drift', async () => {
    ContentDiffCommand.generateMigration = async () => {
      throw new ContentDiffError(
        'ENVIRONMENT_SEMANTICS_MISMATCH',
        'Internal environment-semantics diagnostic.',
      );
    };

    const { error } = await runCommand(
      `content:diff "sync content" --autogenerate=source:destination --migrate-invalid-content --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'Incompatible environment activation/settings',
    );
    expect(error?.message).to.contain(
      'Schema autogeneration alone may not repair activation mismatches.',
    );
    expect(error?.message).to.contain(
      '--migrate-invalid-content does not bypass environment compatibility.',
    );
    expect(error?.message).not.to.contain('migrations:new');
  });

  it('explains a held run lock with commands for the locked primary environment', async () => {
    ContentDiffCommand.generateMigration = async () => {
      throw runLockError({
        side: 'destination',
        environmentId: 'primary',
        trackingModelApiKey: 'migration_log',
      });
    };

    const { error, stdout, stderr } = await runCommand(
      `content:diff "sync locked content" --autogenerate=source --profile=default --migrations-dir="locked migrations" --api-token=not-a-real-secret --config-file=${configPath}`,
    );
    const target = `--source=primary --in-place --allow-primary --profile=default --config-file=${configPath} --migrations-dir='locked migrations' --migrations-model=migration_log`;

    expect(error?.message).to.equal(
      [
        'Migration run in progress: cannot generate content migration "sync locked content" from "source" to "primary".',
        `Destination environment "primary" is being migrated by migrations:run (${LOCK_DESCRIPTION}).`,
        'A content diff generated now would compare a partially migrated state.',
        'No migration artifacts were created.',
        'Wait for that run to finish, then regenerate the content diff.',
        'If that run is no longer active, first review the migrations still pending in "primary":',
        `  ${BIN} migrations:run ${target} --dry-run`,
        'Then clear the stale lock. This also runs every pending migration in "primary":',
        `  ${BIN} migrations:run ${target} --force-unlock=feedfacefeedface`,
        'Add the same --api-token to both commands.',
      ].join('\n'),
    );
    expect(`${stdout}${stderr}${error?.message}`).not.to.contain(
      'not-a-real-secret',
    );
  });

  it('omits run lock flags that the locked sandbox does not need', async () => {
    await writeFile(configPath, JSON.stringify({ profiles: { default: {} } }));
    ContentDiffCommand.generateMigration = async () => {
      throw runLockError({
        side: 'source',
        environmentId: 'source',
        trackingModelApiKey: 'schema_migration',
      });
    };

    const { error } = await runCommand(
      `content:diff sync --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      `Source environment "source" is being migrated by migrations:run (${LOCK_DESCRIPTION}).`,
    );
    expect(error?.message).to.contain(
      `\n  ${BIN} migrations:run --source=source --in-place --config-file=${configPath} --dry-run\n`,
    );
    expect(error?.message).to.match(
      new RegExp(
        `\\n  ${BIN} migrations:run --source=source --in-place --config-file=${escapeRegExp(
          configPath,
        )} --force-unlock=feedfacefeedface$`,
      ),
    );
  });

  it('points run lock commands at the profile that holds the locked environment', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: {
            migrations: {
              directory: 'source-migrations',
              modelApiKey: 'source_migration_log',
            },
          },
          destination_project: {
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    installDualProfileClientFactory({
      builtClients: [],
      sourceCredential: 'source-credential',
      destinationCredential: 'destination-credential',
    });
    const flags = `--source-profile=source_project --destination-profile=destination_project --source-api-token=source-credential --destination-api-token=destination-credential --autogenerate=main:destination --migrations-dir=./release --migrations-model=deploy_history --config-file=${configPath}`;

    ContentDiffCommand.generateMigration = async () => {
      throw runLockError({
        side: 'source',
        environmentId: 'main',
        trackingModelApiKey: 'source_migration_log',
      });
    };
    const source = await runCommand(`content:diff sync ${flags}`);

    expect(source.error?.message).to.contain(
      `  ${BIN} migrations:run --source=main --in-place --allow-primary --profile=source_project --config-file=${configPath} --migrations-model=source_migration_log --force-unlock=feedfacefeedface\n`,
    );
    expect(source.error?.message).to.match(
      /Add --api-token with the token you passed as --source-api-token to both commands\.$/,
    );

    ContentDiffCommand.generateMigration = async () => {
      throw runLockError({
        side: 'destination',
        environmentId: 'destination',
        trackingModelApiKey: 'deploy_history',
      });
    };
    const destination = await runCommand(`content:diff sync ${flags}`);

    expect(destination.error?.message).to.contain(
      `  ${BIN} migrations:run --source=destination --in-place --profile=destination_project --config-file=${configPath} --migrations-dir=./release --migrations-model=deploy_history --dry-run\n`,
    );
    expect(destination.error?.message).to.match(
      /Add --api-token with the token you passed as --destination-api-token to both commands\.$/,
    );
    for (const { stdout, stderr, error } of [source, destination]) {
      expect(`${stdout}${stderr}${error?.message}`).not.to.match(
        /(source|destination)-credential/,
      );
    }
  });

  it('keeps the run lock error message when its details are incomplete', async () => {
    ContentDiffCommand.generateMigration = async () => {
      throw new ContentDiffError(
        'MIGRATION_RUN_IN_PROGRESS',
        'Internal run lock diagnostic.',
        { side: 'destination' },
      );
    };

    const { error } = await runCommand(
      `content:diff sync --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error?.message).to.equal('Internal run lock diagnostic.');
  });

  it('prints generation-time tuning overrides and includes them in JSON', async () => {
    const tuningOverrides = [
      {
        key: 'assetHeadersTimeoutMs' as const,
        variable: 'DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS',
        valueMs: 30_000,
        defaultMs: 120_000,
      },
      {
        key: 'assetIdleTimeoutMs' as const,
        variable: 'DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS',
        valueMs: 900_000,
        defaultMs: 300_000,
      },
    ];
    ContentDiffCommand.generateMigration = async (input) => ({
      ...buildGeneratedResult(input, generatedSummary),
      tuningOverrides,
    });

    const human = await runCommand(
      `content:diff sync --autogenerate=source:destination --bundle-assets --config-file=${configPath}`,
    );

    expect(human.error).to.equal(undefined);
    const lines = human.stdout.split('\n');
    const assetsLine = lines.findIndex((line) => line.startsWith('Assets: '));
    expect(assetsLine).to.be.greaterThan(-1);
    expect(lines.slice(assetsLine + 1, assetsLine + 3)).to.deep.equal([
      'Tuning: DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS=30000 (default 120000)',
      'Tuning: DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS=900000 (default 300000)',
    ]);

    const json = await runCommand(
      `content:diff sync --autogenerate=source:destination --bundle-assets --json --config-file=${configPath}`,
    );

    expect(json.error).to.equal(undefined);
    expect(JSON.parse(json.stdout).tuningOverrides).to.deep.equal(
      tuningOverrides,
    );
  });

  it('prints no tuning lines and omits tuning from JSON at the defaults', async () => {
    ContentDiffCommand.generateMigration = async (input) => ({
      ...buildGeneratedResult(input, generatedSummary),
      tuningOverrides: [],
    });

    const human = await runCommand(
      `content:diff sync --autogenerate=source:destination --bundle-assets --config-file=${configPath}`,
    );
    const json = await runCommand(
      `content:diff sync --autogenerate=source:destination --bundle-assets --json --config-file=${configPath}`,
    );

    expect(human.error).to.equal(undefined);
    expect(human.stdout).not.to.contain('Tuning:');
    expect(json.error).to.equal(undefined);
    expect(JSON.parse(json.stdout)).not.to.have.property('tuningOverrides');
  });

  it('leaves generation errors without dedicated guidance unchanged', async () => {
    ContentDiffCommand.generateMigration = async () => {
      throw new ContentDiffError(
        'UNPROVEN_FULL_ACCESS',
        'The API token cannot prove read access to every record.',
      );
    };

    const { error } = await runCommand(
      `content:diff sync --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error).to.be.instanceOf(ContentDiffError);
    expect((error as ContentDiffError).code).to.equal('UNPROVEN_FULL_ACCESS');
    expect(error?.message).to.equal(
      'The API token cannot prove read access to every record.',
    );
    expect(error?.message).not.to.contain('migrations:new');
  });

  it('redacts the single-profile token from every CMA client log', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'single-profile-verbose-credential';
    const server = await startFakeCmaServer(singleProjectRoute);
    ContentDiffCommand.generateMigration = async (input) => {
      capturedInput = input;
      await input.source.rootClient.site.find();
      await input.source.environmentClient.site.find();
      await input.destination.environmentClient.site.find();
      return buildGeneratedResult(input, generatedSummary);
    };

    try {
      const { stdout, stderr, error } = await runCommand(
        `content:diff sync --autogenerate=source:destination --api-token=${credential} --base-url=${server.baseUrl} --log-level=BODY_AND_HEADERS --log-mode=stdout --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expectAuthenticatedWith(server.requests, [credential]);
      expect([...requestedEnvironments(server.requests)]).to.have.members([
        undefined,
        'source',
        'destination',
      ]);
      expectRedactedCmaOutput(`${stdout}${stderr}`, [credential]);
    } finally {
      await server.close();
    }
  });

  it('redacts the single-profile token from file-mode CMA logs', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'single-profile-file-credential';
    const previousCredential = process.env.DATOCMS_API_TOKEN;
    const previousDirectory = process.cwd();
    process.env.DATOCMS_API_TOKEN = credential;
    const server = await startFakeCmaServer(singleProjectRoute);
    ContentDiffCommand.generateMigration = async (input) => {
      capturedInput = input;
      await input.destination.environmentClient.site.find();
      return buildGeneratedResult(input, generatedSummary);
    };

    try {
      process.chdir(temporaryDirectory);
      const { stdout, stderr, error } = await runCommand(
        `content:diff sync --autogenerate=source:destination --base-url=${server.baseUrl} --log-level=BODY_AND_HEADERS --log-mode=file --config-file=${configPath}`,
      );
      const fileLog = await readFile(
        join(temporaryDirectory, 'api-calls.log'),
        'utf8',
      );

      expect(error).to.equal(undefined);
      expectAuthenticatedWith(server.requests, [credential]);
      expectRedactedCmaOutput(fileLog, [credential]);
      expect(`${stdout}${stderr}`).not.to.contain(credential);
    } finally {
      process.chdir(previousDirectory);
      restoreEnvironmentVariable('DATOCMS_API_TOKEN', previousCredential);
      await server.close();
    }
  });

  it('redacts the single-profile token from uncaught CMA errors', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'single-profile-error-credential';
    const server = await startFakeCmaServer(() =>
      apiErrorResponse(422, 'INVALID_FIELD'),
    );

    try {
      const { stdout, stderr, error } = await runCommand(
        `content:diff sync --autogenerate=source:destination --api-token=${credential} --base-url=${server.baseUrl} --config-file=${configPath}`,
      );

      expect(error?.message).to.contain('422');
      expectAuthenticatedWith(server.requests, [credential]);
      expect(stdout).to.contain("name: 'ApiError'");
      expect(`${stdout}${stderr}${error?.stack}`).not.to.contain(credential);
      expect(JSON.stringify(Reflect.get(error!, 'request'))).not.to.contain(
        credential,
      );
      expect(capturedInput).to.equal(undefined);
    } finally {
      await server.close();
    }
  });

  it('redacts both endpoint credentials from real dual-profile CMA client logs', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: { migrations: { directory: 'source-migrations' } },
          destination_project: {
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    const sourceCredential = 'source-real-client-credential';
    const destinationCredential = 'destination-real-client-credential';
    const server = await startFakeCmaServer((request) =>
      request.method === 'GET' && request.path === '/environments'
        ? environmentsResponse([{ id: 'main', primary: true }])
        : singleProjectRoute(request),
    );
    ContentDiffCommand.generateMigration = async (input) => {
      capturedInput = input;
      await input.source.rootClient.site.find();
      await input.source.environmentClient.site.find();
      await input.destination.rootClient.site.find();
      await input.destination.environmentClient.site.find();
      return buildGeneratedResult(input, generatedSummary);
    };

    try {
      const { stdout, stderr, error } = await runCommand(
        `content:diff sync --source-profile=source_project --destination-profile=destination_project --source-api-token=${sourceCredential} --destination-api-token=${destinationCredential} --autogenerate=main:main --base-url=${server.baseUrl} --log-level=BODY_AND_HEADERS --log-mode=stdout --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expectAuthenticatedWith(server.requests, [
        sourceCredential,
        destinationCredential,
      ]);
      expectRedactedCmaOutput(`${stdout}${stderr}`, [
        sourceCredential,
        destinationCredential,
      ]);
    } finally {
      await server.close();
    }
  });

  it('applies --migrations-dir and --migrations-model with migrations:run precedence', async () => {
    const { error } = await runCommand(
      `content:diff sync --autogenerate=source:destination --migrations-dir=flag-migrations --migrations-model=flag_migration_log --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(dirname(capturedInput!.migrationFilePath)).to.equal(
      resolve('flag-migrations'),
    );
    expect(capturedInput?.source.migrationsModelApiKey).to.equal(
      'flag_migration_log',
    );
    expect(capturedInput?.destination.migrationsModelApiKey).to.equal(
      'flag_migration_log',
    );
  });

  it('defaults to ./migrations and schema_migration without profile migrations settings', async () => {
    await writeFile(configPath, JSON.stringify({ profiles: { default: {} } }));

    const { error } = await runCommand(
      `content:diff sync --autogenerate=source:destination --js --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(dirname(capturedInput!.migrationFilePath)).to.equal(
      resolve('migrations'),
    );
    expect(capturedInput?.destination.migrationsModelApiKey).to.equal(
      'schema_migration',
    );
  });

  it('applies migrations overrides to the destination profile only in dual-profile mode', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: {
            migrations: {
              directory: 'source-migrations',
              modelApiKey: 'source_migration_log',
            },
          },
          destination_project: {
            migrations: {
              directory: 'destination-migrations',
              modelApiKey: 'destination_migration_log',
            },
          },
        },
      }),
    );
    installDualProfileClientFactory({
      builtClients: [],
      sourceCredential: 'source-credential',
      destinationCredential: 'destination-credential',
    });
    const overrideDirectory = join(temporaryDirectory, 'override-migrations');

    const { error } = await runCommand(
      `content:diff sync --source-profile=source_project --destination-profile=destination_project --source-api-token=source-credential --destination-api-token=destination-credential --autogenerate=main --migrations-dir=${overrideDirectory} --migrations-model=override_migration_log --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(dirname(capturedInput!.migrationFilePath)).to.equal(
      overrideDirectory,
    );
    expect(capturedInput?.destination.migrationsModelApiKey).to.equal(
      'override_migration_log',
    );
    expect(capturedInput?.source.migrationsModelApiKey).to.equal(
      'source_migration_log',
    );
  });

  it('rejects the reserved ledger model as the tracking model before any CMA call', async () => {
    const override = await runCommand(
      `content:diff sync --autogenerate=source:destination --migrations-model=datocms_content_diff --config-file=${configPath}`,
    );
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          default: { migrations: { modelApiKey: 'datocms_content_diff' } },
        },
      }),
    );
    const profile = await runCommand(
      `content:diff sync --autogenerate=source:destination --config-file=${configPath}`,
    );

    for (const { error } of [override, profile]) {
      expect(error?.message).to.contain(
        'The model API key "datocms_content_diff" is reserved for the content-diff legacy-ID mapping ledger and cannot be used to track migrations.',
      );
    }
    expect(environmentListCalls).to.equal(0);
    expect(capturedInput).to.equal(undefined);
  });

  it('rejects a reserved destination tracking model in dual-profile mode before listing environments', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: {},
          destination_project: {},
        },
      }),
    );
    const builtClients: Array<{
      options: CmaClient.ClientConfigOptions;
      client: CmaClient.Client;
    }> = [];
    installDualProfileClientFactory({
      builtClients,
      sourceCredential: 'source-credential',
      destinationCredential: 'destination-credential',
      onEnvironmentList: () => {
        environmentListCalls += 1;
      },
    });

    const { error } = await runCommand(
      `content:diff sync --source-profile=source_project --destination-profile=destination_project --source-api-token=source-credential --destination-api-token=destination-credential --autogenerate=main --migrations-model=datocms_content_diff --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'reserved for the content-diff legacy-ID mapping ledger',
    );
    expect(builtClients.map(({ options }) => options.apiToken)).to.have.members(
      ['source-credential', 'destination-credential'],
    );
    expect(environmentListCalls).to.equal(0);
    expect(capturedInput).to.equal(undefined);
  });

  it('ignores an environment-provided DATOCMS_PROFILE in dual-profile mode', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: { migrations: { directory: 'source-migrations' } },
          destination_project: {
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    installDualProfileClientFactory({
      builtClients: [],
      sourceCredential: 'source-credential',
      destinationCredential: 'destination-credential',
    });
    const previousProfile = process.env.DATOCMS_PROFILE;
    process.env.DATOCMS_PROFILE = 'source_project';

    try {
      const { stderr, error } = await runCommand(
        `content:diff sync --source-profile=source_project --destination-profile=destination_project --source-api-token=source-credential --destination-api-token=destination-credential --autogenerate=source:destination --config-file=${configPath}`,
      );
      const explicitProfile = await runCommand(
        `content:diff sync --source-profile=source_project --destination-profile=destination_project --profile=source_project --autogenerate=source:destination --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(capturedInput?.destination.environmentId).to.equal('destination');
      expect(
        stderr.replace(/›\s+(?:Warning:\s*)?/g, '').replace(/\s+/g, ' '),
      ).to.contain(
        'DATOCMS_PROFILE is ignored because --source-profile and --destination-profile select the profiles to compare.',
      );
      expect(explicitProfile.error?.message).to.contain(
        '--profile and --api-token cannot be combined',
      );
    } finally {
      restoreEnvironmentVariable('DATOCMS_PROFILE', previousProfile);
    }
  });

  it('detects dual-profile flags given as separate values', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          source_project: { migrations: { directory: 'source-migrations' } },
          destination_project: {
            migrations: { directory: 'destination-migrations' },
          },
        },
      }),
    );
    installDualProfileClientFactory({
      builtClients: [],
      sourceCredential: 'source-credential',
      destinationCredential: 'destination-credential',
    });

    const { error } = await runCommand(
      `content:diff sync --source-profile source_project --destination-profile destination_project --source-api-token source-credential --destination-api-token destination-credential --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(dirname(capturedInput!.migrationFilePath)).to.equal(
      join(temporaryDirectory, 'destination-migrations'),
    );
  });

  it('treats dual-profile flag names after a -- terminator as the migration name', async () => {
    const { error } = await runCommand(
      `content:diff --autogenerate=source:destination --config-file=${configPath} -- --source-profile`,
    );

    expect(error).to.equal(undefined);
    expect(capturedInput?.source.environmentId).to.equal('source');
    expect(capturedInput?.destination.environmentId).to.equal('destination');
    expect(basename(capturedInput!.migrationFilePath)).to.match(
      /^\d+_sourceProfile\.ts$/,
    );
  });

  it('orders the printed summary by code unit regardless of locale collation', async () => {
    generatedSummary.records = [
      { id: 'record-lower', itemTypeId: 'article', action: 'create' },
      { id: 'record-upper', itemTypeId: 'Zebra', action: 'create' },
    ];
    generatedSummary.warnings = ['a lowercase warning', 'B uppercase warning'];

    const { stdout, error } = await runCommand(
      `content:diff sync --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(stdout.indexOf('create Zebra/record-upper')).to.be.lessThan(
      stdout.indexOf('create article/record-lower'),
    );
    expect(stdout.indexOf('B uppercase warning')).to.be.lessThan(
      stdout.indexOf('a lowercase warning'),
    );
  });

  it('prints record titles and upload filenames after their IDs when known', async () => {
    generatedSummary.records = [
      {
        id: 'record-titled',
        itemTypeId: 'post',
        action: 'update',
        title: 'Spring launch',
      },
      { id: 'record-untitled', itemTypeId: 'post', action: 'create' },
    ];
    generatedSummary.uploads = [
      { id: 'upload-named', action: 'create', filename: 'hero.png' },
      { id: 'upload-unnamed', action: 'delete' },
    ];

    const { stdout, error } = await runCommand(
      `content:diff sync --autogenerate=source:destination --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(stdout).to.contain('  update post/record-titled (Spring launch)\n');
    expect(stdout).to.contain('  create post/record-untitled\n');
    expect(stdout).to.contain('  create upload-named (hero.png)\n');
    expect(stdout).to.contain('  delete upload-unnamed\n');
  });

  it('is discoverable with the complete generation-only flag surface', async () => {
    const { stdout, error } = await runCommand('content:diff --help');

    expect(error).to.equal(undefined);
    expect(stdout).to.contain(
      'Generate a content migration by comparing two DatoCMS environments',
    );
    for (const flag of [
      '--autogenerate',
      '--source-profile',
      '--destination-profile',
      '--source-api-token',
      '--destination-api-token',
      '--migrations-dir',
      '--migrations-model',
      '--item-types',
      '--uploads',
      '--include-deletions',
      '--bundle-assets',
      '--migrate-invalid-content',
      '--ts',
      '--js',
    ]) {
      expect(stdout).to.contain(flag);
    }
    expect(capturedInput).to.equal(undefined);
  });
});

function runLockError(details: {
  side: 'source' | 'destination';
  environmentId: string;
  trackingModelApiKey: string;
}): ContentDiffError {
  return new ContentDiffError(
    'MIGRATION_RUN_IN_PROGRESS',
    'Internal run lock diagnostic.',
    {
      ...details,
      lockRecordId: 'pV2V96fXSDyPgWYeu6p3jw',
      unlockToken: 'feedfacefeedface',
      lockDescription: LOCK_DESCRIPTION,
    },
  );
}

function buildGeneratedResult(
  input: GenerateMigrationInput,
  summary: ContentDiffMigrationSummary,
): GenerateMigrationResult {
  const baseName = basename(input.migrationFilePath, `.${input.format}`);
  const contentDirectory = join(
    dirname(input.migrationFilePath),
    '.datocms-content',
  );

  return {
    sourceEnvironmentId: input.source.environmentId,
    destinationEnvironmentId: input.destination.environmentId,
    format: input.format,
    migrationPath: input.migrationFilePath,
    planPath: join(contentDirectory, `${baseName}.plan.json`),
    runtimePath: join(contentDirectory, `runtime-v1.${input.format}`),
    ...(input.options.bundleAssets
      ? { assetsPath: join(contentDirectory, `${baseName}.assets`) }
      : {}),
    summary,
  };
}

function buildGeneratedSummary(): ContentDiffMigrationSummary {
  return {
    counts: {
      'records.create': 0,
      'records.update': 0,
      'records.delete': 0,
      'uploads.create': 0,
      'uploads.update': 0,
      'uploads.delete': 0,
      'uploadCollections.create': 0,
      'uploadCollections.update': 0,
      'legacyIdMappings.records': 0,
      'legacyIdMappings.detected': 0,
      'legacyIdMappings.skipped': 0,
    },
    records: [],
    uploads: [],
    destructiveActions: [],
    warnings: [],
    invalidContent: {
      status: 'complete',
      detectedRecords: 0,
      migratedRecords: 0,
      skippedRecords: 0,
      propagatedSkipCount: 0,
      validatorRelaxations: 0,
      relaxedFieldCount: 0,
      relaxedValidatorCount: 0,
      requiresTemporaryValidatorRelaxation: false,
    },
    skippedRecords: [],
    validatorRelaxations: [],
    legacyIdMappings: [],
    skippedLegacyIdMappings: [],
  };
}

function buildInvalidContentSummary(): ContentDiffMigrationSummary {
  return {
    ...buildGeneratedSummary(),
    warnings: ['Invalid content requires review before execution.'],
    invalidContent: {
      status: 'partial',
      detectedRecords: 3,
      migratedRecords: 1,
      skippedRecords: 2,
      propagatedSkipCount: 1,
      validatorRelaxations: 1,
      relaxedFieldCount: 1,
      relaxedValidatorCount: 2,
      requiresTemporaryValidatorRelaxation: true,
    },
    skippedRecords: [
      {
        id: 'record-skipped',
        itemTypeId: 'model-a',
        disposition: 'preserve_target',
        reasons: [
          {
            code: 'DEPENDENCY_ON_SKIPPED_RECORD',
            slice: 'published',
            dependencyId: 'record-root',
            dependencyChain: ['record-root', 'record-skipped'],
          },
          {
            code: 'INVALID_CURRENT',
            slice: 'current',
            dependencyChain: [],
          },
        ],
      },
    ],
    validatorRelaxations: [
      {
        fieldId: 'field-title',
        itemTypeId: 'model-a',
        relaxedValidatorKeys: ['required', 'length'],
        affectedRecordIds: ['record-z', 'record-a'],
      },
    ],
  };
}

function installDualProfileClientFactory({
  builtClients,
  sourceCredential,
  destinationCredential,
  onEnvironmentList,
}: {
  builtClients: Array<{
    options: CmaClient.ClientConfigOptions;
    client: CmaClient.Client;
  }>;
  sourceCredential: string;
  destinationCredential: string;
  onEnvironmentList?: () => void;
}): void {
  ContentDiffCommand.buildProfileClient = (options) => {
    const isSource = options.apiToken === sourceCredential;
    const isDestination = options.apiToken === destinationCredential;

    if (!isSource && !isDestination) {
      throw new Error('Unexpected profile credential');
    }

    const client = {
      environments: {
        list: async () => {
          onEnvironmentList?.();
          return isSource
            ? [
                { id: 'main', meta: { primary: true } },
                { id: 'source', meta: { primary: false } },
              ]
            : [
                { id: 'main', meta: { primary: true } },
                { id: 'destination', meta: { primary: false } },
              ];
        },
      },
    } as unknown as CmaClient.Client;
    builtClients.push({ options, client });
    return client;
  };
}

function singleProjectRoute(
  request: FakeCmaRequest,
): FakeCmaResponse | undefined {
  if (request.method === 'GET' && request.path === '/environments') {
    return environmentsResponse([
      { id: 'primary', primary: true },
      { id: 'source', primary: false },
      { id: 'destination', primary: false },
    ]);
  }

  if (request.method === 'GET' && request.path === '/site') {
    return siteResponse('fake-site');
  }

  return undefined;
}

function restoreEnvironmentVariable(
  name: string,
  previousValue: string | undefined,
): void {
  if (previousValue === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = previousValue;
  }
}
