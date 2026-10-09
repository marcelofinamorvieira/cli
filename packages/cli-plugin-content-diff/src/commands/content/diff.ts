import { dirname, join, resolve } from 'node:path';
import { oclif } from '@datocms/cli-utils';
import {
  type ContentGenerationResult,
  generateContentDiff,
} from '../../engine/generation';
import { KINDS } from '../../engine/types';
import { outputPath } from '../../utils/command-helpers';
import { withInterruptHandling } from '../../utils/interruption';
import { PairedProfileCommand } from '../../utils/paired-profile-command';

type ContentDiffCommandResult = ContentGenerationResult;

export default class ContentDiffCommand extends PairedProfileCommand {
  static description =
    'Compare a DatoCMS environment or project dump with an environment and write a content diff';
  static examples = [
    '<%= config.bin %> <%= command.id %> syncContent --source=staging --destination=primary',
    '<%= config.bin %> <%= command.id %> restore --source-dump=./1791556200_backup.dump-records.zip --destination=main',
    '<%= config.bin %> <%= command.id %> --source=main --destination=main --source-profile=source --destination-profile=target --output=./sync.zip',
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
      // --source-api-token needs --source-profile, so it is refused too,
      // without an error that repeats the token.
      exclusive: ['source-profile'],
    }),
    destination: oclif.Flags.string({
      description: 'Destination environment ID, or "primary"',
      default: 'primary',
    }),
    output: oclif.Flags.string({
      description:
        'Diff .zip file, or directory for a timestamped name (defaults to the content subdirectory of the destination profile migration directory)',
    }),
    'source-profile': oclif.Flags.string({
      description: 'Configured source project profile',
      dependsOn: ['destination-profile'],
    }),
    'destination-profile': oclif.Flags.string({
      description: 'Configured destination project profile',
      dependsOn: ['source-profile'],
    }),
    'source-api-token': oclif.Flags.string({
      description: 'Override authentication for the source profile',
      dependsOn: ['source-profile'],
    }),
    'destination-api-token': oclif.Flags.string({
      description: 'Override authentication for the destination profile',
      dependsOn: ['destination-profile'],
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
    'allow-partial': oclif.Flags.boolean({
      description:
        'Skip content the diff cannot reproduce, and the writes that need it, instead of failing',
      default: false,
    }),
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent independent requests (1–16)',
      default: 8,
      min: 1,
      max: 16,
    }),
  };

  async run(): Promise<ContentDiffCommandResult> {
    return withInterruptHandling(
      (signal) => this.runOperation(signal),
      () =>
        this.logToStderr(
          'Interrupted. Waiting for active requests and cleaning up temporary state.',
        ),
    );
  }

  private async runOperation(
    signal: AbortSignal,
  ): Promise<ContentDiffCommandResult> {
    const { flags, args } = await this.parse(ContentDiffCommand);
    const sourceProfile = flags['source-profile']
      ? this.datoConfig?.profiles[flags['source-profile']]
      : this.datoProfileConfig;
    const destinationProfile = flags['destination-profile']
      ? this.datoConfig?.profiles[flags['destination-profile']]
      : this.datoProfileConfig;
    const migrationsDirectory = destinationProfile?.migrations?.directory
      ? resolve(
          dirname(this.datoConfigPath ?? resolve('datocms.config.json')),
          destinationProfile.migrations.directory,
        )
      : resolve('./migrations');
    // The native schema runner scans its directory for timestamped scripts.
    // Keep content diffs below it, where it does not look.
    const path = await outputPath({
      output: flags.output,
      directory: join(migrationsDirectory, 'content'),
      name: args.NAME,
      kind: 'diff',
    });
    const destination = {
      endpoint: flags['destination-profile']
        ? await this.endpoint(
            flags['destination-profile'],
            flags['destination-api-token'],
          )
        : await this.endpoint(),
      environment: flags.destination,
    };
    const source = flags['source-dump']
      ? { dump: resolve(flags['source-dump']) }
      : {
          endpoint: flags['source-profile']
            ? await this.endpoint(
                flags['source-profile'],
                flags['source-api-token'],
              )
            : destination.endpoint,
          environment: flags.source!,
        };
    const result = await generateContentDiff({
      source,
      destination,
      sourceMigrationModelApiKey: (flags['source-dump']
        ? destinationProfile
        : sourceProfile
      )?.migrations?.modelApiKey,
      destinationMigrationModelApiKey:
        destinationProfile?.migrations?.modelApiKey,
      outputPath: path,
      options: {
        itemTypes: flags['item-types'],
        uploads: flags.uploads,
        includeDeletions: flags['include-deletions'],
        allowPartial: flags['allow-partial'],
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
    for (const skip of result.skipped)
      this.logToStderr(
        `Skipped ${skip.kind} ${skip.id} (${skip.code}): ${skip.message}`,
      );
    return result;
  }
}
