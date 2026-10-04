import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { oclif } from '@datocms/cli-utils';
import { writeBundle } from '../../engine/bundle';
import { assertNotAborted } from '../../engine/cancellation';
import { captureSnapshot } from '../../engine/capture';
import { ContentError } from '../../engine/errors';
import { createPlan } from '../../engine/planner';
import {
  assertApplyAccess,
  assertSchemaEditAccess,
  fetchSchema,
} from '../../engine/schema';
import { SnapshotStore } from '../../engine/store';
import type { PlanCounts } from '../../engine/types';
import {
  ContentCommand,
  concurrency,
  environmentId,
  selectedModels,
} from '../../utils/content-command';
import { withInterruptHandling } from '../../utils/interruption';

export type ContentDiffCommandResult = {
  bundlePath: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  counts: PlanCounts;
};

export default class ContentDiffCommand extends ContentCommand {
  static description =
    'Compare DatoCMS environments and export a complete content bundle';
  static examples = [
    '<%= config.bin %> <%= command.id %> --source=staging --destination=primary --output=./content-bundle',
    '<%= config.bin %> <%= command.id %> --source=main --destination=main --source-profile=source --destination-profile=target --output=./content-bundle',
  ];
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
      description: 'New directory for the complete content bundle',
      required: true,
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
    concurrency: oclif.Flags.integer({
      description: 'Maximum concurrent independent requests (1–16)',
      default: 4,
    }),
    'chunk-bytes': oclif.Flags.integer({
      description: 'Target JSONL chunk size; a single entry is never split',
      default: 4 * 1024 * 1024,
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
    const { flags } = await this.parse(ContentDiffCommand);
    const maximum = concurrency(flags.concurrency);
    if (!Number.isSafeInteger(flags['chunk-bytes']) || flags['chunk-bytes'] < 1)
      throw new ContentError(
        'INVALID_CHUNK_SIZE',
        '--chunk-bytes must be a positive safe integer.',
      );
    const outputPath = resolve(flags.output);
    try {
      await lstat(outputPath);
      throw new ContentError(
        'BUNDLE_EXISTS',
        `Bundle output already exists: ${outputPath}`,
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
    const [sourceSchema, destinationSchema] = await Promise.all([
      fetchSchema(sourceClient, sourceEnvironmentId),
      fetchSchema(destinationClient, destinationEnvironmentId),
    ]);
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
      this.progress(`Capturing source "${sourceEnvironmentId}".`);
      await captureSnapshot({
        client: sourceClient,
        environmentId: sourceEnvironmentId,
        schema: sourceSchema,
        store,
        side: 'source',
        options: {
          signal,
          modelIds: sourceSchema.models
            .filter((model) => !model.block)
            .map((model) => model.id),
          uploads: 'all',
          concurrency: maximum,
          progress: (message) => this.progress(message),
        },
      });
      this.progress(`Capturing destination "${destinationEnvironmentId}".`);
      await captureSnapshot({
        client: destinationClient,
        environmentId: destinationEnvironmentId,
        schema: destinationSchema,
        store,
        side: 'target',
        options: {
          signal,
          modelIds: destinationSchema.models
            .filter((model) => !model.block)
            .map((model) => model.id),
          uploads: 'all',
          concurrency: maximum,
          progress: (message) => this.progress(message),
        },
      });
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
      this.progress('Writing content bundle and required asset binaries.');
      const bundlePath = await writeBundle({
        signal,
        store,
        metadata,
        outputPath,
        chunkBytes: flags['chunk-bytes'],
      });
      const result = {
        bundlePath,
        sourceEnvironmentId,
        destinationEnvironmentId,
        counts: metadata.counts,
      };
      if (!this.jsonEnabled()) {
        this.log(`Content bundle: ${bundlePath}`);
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
