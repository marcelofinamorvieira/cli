import { dirname, join, resolve } from 'node:path';
import {
  CmaClientCommand,
  type ProfileConfig,
  oclif,
} from '@datocms/cli-utils';
import type { ContentFailureContext } from '../../engine/errors';
import {
  type ContentGenerationResult,
  generateContentDiff,
} from '../../engine/generation';
import { KINDS } from '../../engine/types';
import { jsonFailure, outputPath } from '../../utils/command-helpers';
import { withInterruptHandling } from '../../utils/interruption';
import {
  resolveLinkedSiteToken,
  resolveProfileApiToken,
} from '../../utils/profile-auth';

type ContentDiffCommandResult = ContentGenerationResult;
type ClientOptions = Awaited<
  ReturnType<CmaClientCommand['buildBaseClientInitializationOptions']>
>;

export default class ContentDiffCommand extends CmaClientCommand {
  static description =
    'Compare a DatoCMS environment or project dump with an environment and write a content diff';
  static examples = [
    '<%= config.bin %> <%= command.id %> syncContent --source=staging --destination=primary',
    '<%= config.bin %> <%= command.id %> restore --source-dump=./1791556200_backup.dump-records.zip --destination=main',
    '<%= config.bin %> <%= command.id %> --source=main --destination=main --profile=target --source-profile=source --out=./sync.zip',
  ];
  static args = {
    NAME: oclif.Args.string({
      description: 'Name used for the timestamped diff file name',
      default: 'contentMigration',
    }),
  };
  static flags = {
    source: oclif.Flags.string({
      description: 'Source environment ID, or "primary"',
      exactlyOne: ['source', 'source-dump'],
    }),
    'source-dump': oclif.Flags.string({
      description: 'Project dump to use as the source, from content:export',
      exclusive: ['source-profile'],
    }),
    destination: oclif.Flags.string({
      description: 'Destination environment ID, or "primary"',
      default: 'primary',
    }),
    out: oclif.Flags.string({
      description:
        'Diff .zip file, or directory for a timestamped name (defaults to the content subdirectory of the migrations directory)',
    }),
    'source-profile': oclif.Flags.string({
      description:
        'Configured profile of the source project, when it differs from the destination project',
    }),
    'source-api-token': oclif.Flags.string({
      description:
        'API token of the source project, instead of its profile token',
      dependsOn: ['source-profile'],
    }),
    'item-types': oclif.Flags.string({
      description: 'Model API keys separated by commas, or "all"',
      default: 'all',
    }),
    uploads: oclif.Flags.custom<'referenced' | 'all'>({
      description: 'Upload scope',
      options: ['referenced', 'all'],
      default: 'referenced',
    })(),
    'include-deletions': oclif.Flags.boolean({
      description: 'Delete destination-only content within the scope',
      default: false,
    }),
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent independent requests (1–16)',
      default: 8,
      min: 1,
      max: 16,
    }),
  };

  private clientOptions?: Promise<ClientOptions>;

  // Environment clients reuse the options `init` resolved for `this.client`;
  // resolving them again would repeat a linked project's Dashboard request.
  protected buildBaseClientInitializationOptions(): Promise<ClientOptions> {
    this.clientOptions ??= super.buildBaseClientInitializationOptions();
    return this.clientOptions;
  }

  async run(): Promise<ContentDiffCommandResult> {
    return withInterruptHandling(
      (signal) => this.runOperation(signal),
      () =>
        this.logToStderr(
          'Interrupted. Waiting for active requests and cleaning up temporary state.',
        ),
    );
  }

  /**
   * Clients for the source project named by `--source-profile`, with its
   * token resolved in the native order: `--source-api-token`, the linked
   * project's OAuth token, then the profile's environment variable.
   */
  private async sourceProject(profileId: string, explicitApiToken?: string) {
    this.requireDatoConfig();
    const profile: ProfileConfig | undefined =
      this.datoConfig!.profiles[profileId];
    if (!profile)
      this.error(
        `Requested profile "${profileId}" is not defined in config file "${this.datoConfigRelativePath}"`,
        {
          suggestions: [
            `Configure it with "${this.config.bin} profile:set ${profileId}"`,
          ],
        },
      );
    const { apiToken, environmentName } = await resolveProfileApiToken({
      explicitApiToken,
      profileConfig: profile,
      profileId,
      resolveLinkedSiteToken: (siteId, organizationId) =>
        resolveLinkedSiteToken({ siteId, organizationId }),
    });
    if (!apiToken)
      this.error(
        `Cannot find an API token for the source profile "${profileId}"!`,
        {
          suggestions: [
            `The source API token is determined by looking at:
* The --source-api-token flag
* The ${environmentName} environment variable (we look inside .env.local and .env too)
* A linked project via "datocms link" (requires "datocms login" first)`,
          ],
        },
      );
    const client = (environment?: string) =>
      this.buildClient({ apiToken, baseUrl: profile.baseUrl, environment });
    return {
      profile,
      endpoint: {
        rootClient: await client(),
        buildEnvironmentClient: (environment: string) => client(environment),
      },
    };
  }

  private async runOperation(
    signal: AbortSignal,
  ): Promise<ContentDiffCommandResult> {
    const { flags, args } = await this.parse(ContentDiffCommand);
    const migrationsDirectory = this.datoProfileConfig?.migrations?.directory
      ? resolve(
          dirname(this.datoConfigPath),
          this.datoProfileConfig.migrations.directory,
        )
      : resolve('./migrations');
    // The native schema runner scans its directory for timestamped scripts.
    // Keep content diffs below it, where it does not look.
    const path = await outputPath({
      output: flags.out,
      directory: join(migrationsDirectory, 'content'),
      name: args.NAME,
      kind: 'diff',
    });
    const destination = {
      endpoint: {
        rootClient: this.client,
        buildEnvironmentClient: (environment: string) =>
          this.buildClient({ environment }),
      },
      environment: flags.destination,
    };
    const sourceProject = flags['source-profile']
      ? await this.sourceProject(
          flags['source-profile'],
          flags['source-api-token'],
        )
      : undefined;
    const source = flags['source-dump']
      ? { dump: resolve(flags['source-dump']) }
      : {
          endpoint: sourceProject?.endpoint ?? destination.endpoint,
          environment: flags.source!,
        };
    const result = await generateContentDiff({
      source,
      destination,
      sourceMigrationModelApiKey: (
        sourceProject?.profile ?? this.datoProfileConfig
      )?.migrations?.modelApiKey,
      destinationMigrationModelApiKey:
        this.datoProfileConfig?.migrations?.modelApiKey,
      outputPath: path,
      options: {
        itemTypes: flags['item-types'],
        uploads: flags.uploads,
        includeDeletions: flags['include-deletions'],
        concurrency: flags.concurrency,
      },
      signal,
      progress: (message) => this.logToStderr(message),
    });
    this.log(
      `Content diff: ${result.diffPath} (${result.operations} operations)`,
    );
    for (const kind of KINDS)
      this.log(
        `${kind}: ${Object.entries(result.counts[kind])
          .map(([action, count]) => `${count} ${action}`)
          .join(', ')}`,
      );
    return result;
  }

  protected async catch(
    error: Error & ContentFailureContext & { exitCode?: number },
  ): Promise<void> {
    if (this.jsonEnabled()) return this.logJson(jsonFailure(error));
    return super.catch(error);
  }
}
