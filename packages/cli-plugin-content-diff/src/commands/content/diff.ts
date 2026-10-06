import { lstat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { oclif } from '@datocms/cli-utils';
import { camelCase } from 'lodash';
import { assertNotAborted } from '../../engine/cancellation';
import { captureSnapshot } from '../../engine/capture';
import { ContentError } from '../../engine/errors';
import { writeMigration } from '../../engine/migration-artifact';
import {
  DEFAULT_MIGRATION_CHUNK_BYTES,
  MAX_MIGRATION_CHUNK_BYTES,
} from '../../engine/migration-limits';
import {
  prepareMigrationSchema,
  projectMigrationSchema,
} from '../../engine/migration-schema';
import { createPlan } from '../../engine/planner';
import {
  assertApplyAccess,
  assertSchemaEditAccess,
  fetchSchema,
} from '../../engine/schema';
import { SnapshotStore } from '../../engine/store';
import type { PlanCounts, SchemaState, Side } from '../../engine/types';
import {
  ContentCommand,
  concurrency,
  environmentId,
  selectedModels,
} from '../../utils/content-command';
import { withInterruptHandling } from '../../utils/interruption';

export type ContentDiffCommandResult = {
  scriptPath: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  counts: PlanCounts;
};

export default class ContentDiffCommand extends ContentCommand {
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
      description: 'Include safe destination-only content deletions',
      default: false,
    }),
    'allow-partial': oclif.Flags.boolean({
      description:
        'Permit only proven isolated skips and their dependency closure',
      default: false,
    }),
    'allow-temporary-schema-changes': oclif.Flags.boolean({
      description: 'Plan supported temporary validator and default changes',
      default: false,
    }),
    verification: oclif.Flags.custom<'versions' | 'full'>({
      description:
        'Skip rereading records whose version did not change ("versions"), or reread every record in each check ("full")',
      options: ['versions', 'full'],
      default: 'versions',
    })(),
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent independent requests (1–16)',
      default: 8,
    }),
    'chunk-bytes': oclif.Flags.integer({
      description:
        'Target TypeScript part size; a single operation is never split',
      default: DEFAULT_MIGRATION_CHUNK_BYTES,
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
    const maximum = concurrency(flags.concurrency);
    if (
      !Number.isSafeInteger(flags['chunk-bytes']) ||
      flags['chunk-bytes'] < 1 ||
      flags['chunk-bytes'] > MAX_MIGRATION_CHUNK_BYTES
    )
      throw new ContentError(
        'INVALID_CHUNK_SIZE',
        `--chunk-bytes must be an integer from 1 to ${MAX_MIGRATION_CHUNK_BYTES} bytes (16 MiB minus 1 KiB).`,
      );
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
    if (
      flags.output &&
      ['.js', '.mjs', '.cjs', '.mts', '.cts'].includes(extname(flags.output))
    )
      throw new ContentError(
        'INVALID_MIGRATION_PATH',
        'Content migration output must be a .ts file or a directory.',
      );
    const outputPath = flags.output?.endsWith('.ts')
      ? requestedOutput
      : join(
          requestedOutput,
          `${Math.floor(Date.now() / 1000)}_${migrationName}.ts`,
        );
    try {
      await lstat(outputPath);
      throw new ContentError(
        'MIGRATION_EXISTS',
        `Migration output already exists: ${outputPath}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
    const [sourceEnvironments, destinationEnvironments] = await Promise.all([
      source.rootClient.environments.list(),
      destination === source
        ? Promise.resolve(undefined)
        : destination.rootClient.environments.list(),
    ]);
    const sourceEnvironmentId = environmentId(flags.source, sourceEnvironments);
    const destinationEnvironmentId = environmentId(
      flags.destination,
      destinationEnvironments ?? sourceEnvironments,
    );
    const sourceClient = source.buildEnvironmentClient(sourceEnvironmentId);
    const destinationClient = destination.buildEnvironmentClient(
      destinationEnvironmentId,
    );
    const [sourceRawSchema, destinationRawSchema] = await Promise.all([
      fetchSchema(sourceClient, sourceEnvironmentId),
      fetchSchema(destinationClient, destinationEnvironmentId),
    ]);
    const { schema: sourceSchema, tracking: sourceTracking } =
      prepareMigrationSchema(
        sourceRawSchema,
        sourceProfile?.migrations?.modelApiKey,
      );
    const { schema: destinationSchema, tracking: destinationTracking } =
      prepareMigrationSchema(
        destinationRawSchema,
        destinationProfile?.migrations?.modelApiKey,
      );
    if (
      sourceSchema.siteId === destinationSchema.siteId &&
      sourceEnvironmentId === destinationEnvironmentId
    )
      throw new ContentError(
        'SAME_ENVIRONMENT',
        'Source and destination must be different environments or projects.',
      );
    const modelIds = selectedModels(sourceSchema, flags['item-types']);
    assertNotAborted(signal);
    const store = new SnapshotStore();
    try {
      // Full namespaces prove inbound dependencies and preservation. The model
      // selection below limits planned mutations, rather than capture authority.
      const capture = (
        side: Side,
        target: SnapshotStore,
        captureSignal: AbortSignal,
      ) => {
        const [client, environment, schema, label]: [
          typeof sourceClient,
          string,
          SchemaState,
          string,
        ] =
          side === 'source'
            ? [sourceClient, sourceEnvironmentId, sourceSchema, 'Source']
            : [
                destinationClient,
                destinationEnvironmentId,
                destinationSchema,
                'Destination',
              ];
        this.progress(`Capturing ${label.toLowerCase()} "${environment}".`);
        return captureSnapshot({
          client,
          environmentId: environment,
          schema,
          store: target,
          side,
          // DatoCMS cannot freeze sandbox environments, so every capture must
          // recheck consistency before its state is used to generate a migration.
          verify: flags.verification === 'versions' ? 'versions' : true,
          options: {
            schemaProjection: (rawSchema) =>
              projectMigrationSchema(
                rawSchema,
                side === 'source' ? sourceTracking : destinationTracking,
              ),
            signal: captureSignal,
            modelIds: schema.models
              .filter((model) => !model.block)
              .map((model) => model.id),
            uploads: 'all',
            concurrency: maximum,
            progress: (message) => this.progress(`${label}: ${message}`),
          },
        });
      };
      if (destination === source) {
        // One project shares one API rate limit, so reading both environments
        // at once would only trade time for retries.
        await capture('source', store, signal);
        await capture('target', store, signal);
      } else {
        // Two projects have separate rate limits. Read both at once, each into
        // its own store so neither writes tables the other is reading, and
        // stop the other read as soon as one fails.
        const destinationStore = new SnapshotStore();
        const shared = new AbortController();
        const forward = () => shared.abort();
        signal.addEventListener('abort', forward, { once: true });
        try {
          const results = await Promise.allSettled(
            (
              [
                ['source', store],
                ['target', destinationStore],
              ] as const
            ).map(([side, target]) =>
              capture(side, target, shared.signal).catch((error) => {
                shared.abort();
                throw error;
              }),
            ),
          );
          const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (failures.length)
            throw (
              failures.find(
                (failure) =>
                  !(
                    failure instanceof ContentError &&
                    failure.code === 'INTERRUPTED'
                  ),
              ) ?? failures[0]
            );
          store.importSide(destinationStore, 'target');
        } finally {
          signal.removeEventListener('abort', forward);
          destinationStore.dispose();
        }
      }
      const metadata = await createPlan(
        store,
        sourceSchema,
        destinationSchema,
        {
          modelIds,
          uploads: flags.uploads,
          includeDeletions: flags['include-deletions'],
          allowPartial: flags['allow-partial'],
          allowTemporarySchemaChanges: flags['allow-temporary-schema-changes'],
        },
      );
      await assertApplyAccess(
        destinationClient,
        destinationSchema,
        store,
        true,
        modelIds,
      );
      if (metadata.temporarySchemaChanges.length)
        await assertSchemaEditAccess(destinationClient);
      this.progress(
        'Writing TypeScript content migration and required asset binaries.',
      );
      const scriptPath = await writeMigration({
        signal,
        store,
        metadata,
        outputPath,
        sourceTracking,
        destinationTracking,
        chunkBytes: flags['chunk-bytes'],
        concurrency: maximum,
      });
      const result = {
        scriptPath,
        sourceEnvironmentId,
        destinationEnvironmentId,
        counts: metadata.counts,
      };
      if (!this.jsonEnabled()) {
        this.log(`TypeScript content migration: ${scriptPath}`);
        for (const kind of ['record', 'upload', 'collection'] as const)
          this.log(
            `${kind}: ${Object.entries(metadata.counts[kind])
              .map(([action, count]) => `${count} ${action}`)
              .join(', ')}`,
          );
      }
      return result;
    } finally {
      store.dispose();
    }
  }
}
