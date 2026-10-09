import { stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { oclif } from '@datocms/cli-utils';
import { camelCase } from 'lodash';
import { ContentError } from '../../engine/errors';
import {
  type ContentGenerationResult,
  generateContentMigration,
} from '../../engine/generation';
import {
  DEFAULT_MIGRATION_CHUNK_BYTES,
  MAX_MIGRATION_CHUNK_BYTES,
  assertOutputAbsent,
} from '../../engine/migration-artifact';
import { KINDS } from '../../engine/types';
import { withInterruptHandling } from '../../utils/interruption';
import { PairedProfileCommand } from '../../utils/paired-profile-command';

type ContentDiffCommandResult = ContentGenerationResult;

export default class ContentDiffCommand extends PairedProfileCommand {
  static description =
    'Compare DatoCMS environments and generate an editable TypeScript content migration';
  static examples = [
    '<%= config.bin %> <%= command.id %> syncContent --source=staging --destination=primary',
    '<%= config.bin %> <%= command.id %> --source=main --destination=main --source-profile=source --destination-profile=target --output=./migrations/content/sync.ts',
  ];
  static args = {
    NAME: oclif.Args.string({
      description: 'Migration name used for a timestamped TypeScript filename',
      default: 'contentMigration',
    }),
  };
  static flags = {
    source: oclif.Flags.string({
      description: 'Source environment ID, or "primary"',
      required: true,
    }),
    destination: oclif.Flags.string({
      description: 'Destination environment ID, or "primary"',
      default: 'primary',
    }),
    output: oclif.Flags.string({
      description:
        'TypeScript file or directory (defaults to the content subdirectory of the destination profile migration directory)',
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
        'Skip content the generated script cannot reproduce, and the writes that need it, instead of failing',
      default: false,
    }),
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent independent requests (1–16)',
      default: 8,
      min: 1,
      max: 16,
    }),
    'chunk-bytes': oclif.Flags.integer({
      description:
        'Target size of each TypeScript part and baseline chunk file; a single operation is never split',
      default: DEFAULT_MIGRATION_CHUNK_BYTES,
      min: 1,
      max: MAX_MIGRATION_CHUNK_BYTES,
    }),
  };

  async run(): Promise<ContentDiffCommandResult> {
    return withInterruptHandling(
      (signal) => this.runOperation(signal),
      () =>
        this.progress(
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
    const migrationName = camelCase(args?.NAME ?? 'contentMigration');
    if (!migrationName)
      throw new ContentError(
        'INVALID_MIGRATION_NAME',
        'The migration name must contain letters or numbers.',
      );
    const migrationsDirectory = destinationProfile?.migrations?.directory
      ? resolve(
          dirname(this.datoConfigPath ?? resolve('datocms.config.json')),
          destinationProfile.migrations.directory,
        )
      : resolve('./migrations');
    // The native schema runner scans its directory for timestamped scripts.
    // Keep plugin-only content scripts below it so they are not auto-discovered.
    const defaultDirectory = join(migrationsDirectory, 'content');
    const requestedOutput = flags.output
      ? resolve(flags.output)
      : defaultDirectory;
    // A path with another extension is refused rather than created as a
    // directory, unless it already is one.
    const outputIsFile = extname(requestedOutput) === '.ts';
    if (
      !outputIsFile &&
      extname(requestedOutput) &&
      !(await stat(requestedOutput).then(
        (entry) => entry.isDirectory(),
        () => false,
      ))
    )
      throw new ContentError(
        'INVALID_MIGRATION_PATH',
        'Content migration output must be a .ts file or a directory.',
      );
    const outputPath = outputIsFile
      ? requestedOutput
      : join(
          requestedOutput,
          `${Math.floor(Date.now() / 1000)}_${migrationName}.ts`,
        );
    // Checked again when the files are written; this fails before reading.
    await assertOutputAbsent(outputPath);
    const source = await this.endpoint(
      flags['source-profile'],
      flags['source-api-token'],
    );
    const destination = flags['destination-profile']
      ? await this.endpoint(
          flags['destination-profile'],
          flags['destination-api-token'],
        )
      : source;
    const result = await generateContentMigration({
      source,
      destination,
      sourceEnvironment: flags.source,
      destinationEnvironment: flags.destination,
      sourceMigrationModelApiKey: sourceProfile?.migrations?.modelApiKey,
      destinationMigrationModelApiKey:
        destinationProfile?.migrations?.modelApiKey,
      outputPath,
      options: {
        itemTypes: flags['item-types'],
        uploads: flags.uploads,
        includeDeletions: flags['include-deletions'],
        allowPartial: flags['allow-partial'],
        concurrency: flags.concurrency,
        chunkBytes: flags['chunk-bytes'],
      },
      signal,
      progress: (message) => this.progress(message),
    });
    if (!this.jsonEnabled()) {
      this.log(`TypeScript content migration: ${result.scriptPath}`);
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
    }
    return result;
  }
}
