import { assertNotAborted } from './cancellation';
import { captureSnapshot } from './capture';
import { ContentError } from './errors';
import { writeMigration } from './migration-artifact';
import { prepareMigrationSchema } from './migration-schema';
import { assertSchemaCompatible, createPlan } from './planner';
import { fetchSchema } from './schema';
import { assertSourceRecordsValid } from './source-validity';
import { SnapshotStore } from './store';
import type {
  Client,
  Kind,
  PlanCounts,
  PlanOptions,
  SchemaState,
  Side,
} from './types';

interface GenerationEndpoint {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
}

export interface ContentGenerationArguments {
  source: GenerationEndpoint;
  /** Reuse source when both environments use the same configured endpoint. */
  destination: GenerationEndpoint;
  sourceEnvironment: string;
  destinationEnvironment: string;
  sourceMigrationModelApiKey?: string;
  destinationMigrationModelApiKey?: string;
  outputPath: string;
  options: Omit<PlanOptions, 'modelIds'> & {
    itemTypes: string;
    concurrency: number;
    chunkBytes: number;
  };
  signal: AbortSignal;
  progress?: (message: string) => void;
}

export interface ContentGenerationResult {
  scriptPath: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  counts: PlanCounts;
  /** Why each entry --allow-partial left out of the script was skipped. */
  skipped: Array<{ kind: Kind; id: string; code: string; message: string }>;
}

/** Own generation ordering and temporary stores until the artifact is written. */
export async function generateContentMigration({
  source,
  destination,
  sourceEnvironment,
  destinationEnvironment,
  sourceMigrationModelApiKey,
  destinationMigrationModelApiKey,
  outputPath,
  options,
  signal,
  progress = () => {},
}: ContentGenerationArguments): Promise<ContentGenerationResult> {
  const maximum = options.concurrency;
  const [sourceEnvironments, destinationEnvironments] = await Promise.all([
    source.rootClient.environments.list(),
    destination === source
      ? Promise.resolve(undefined)
      : destination.rootClient.environments.list(),
  ]);
  const sourceEnvironmentId = environmentId(
    sourceEnvironment,
    sourceEnvironments,
  );
  const destinationEnvironmentId = environmentId(
    destinationEnvironment,
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
    prepareMigrationSchema(sourceRawSchema, sourceMigrationModelApiKey);
  const { schema: destinationSchema, tracking: destinationTracking } =
    prepareMigrationSchema(
      destinationRawSchema,
      destinationMigrationModelApiKey,
    );
  if (
    sourceSchema.siteId === destinationSchema.siteId &&
    sourceEnvironmentId === destinationEnvironmentId
  )
    throw new ContentError(
      'SAME_ENVIRONMENT',
      'Source and destination must be different environments or projects.',
    );
  const modelIds = selectedModels(sourceSchema, options.itemTypes);
  assertNotAborted(signal);
  // Reject incompatible schemas before reading either content namespace.
  assertSchemaCompatible(sourceSchema, destinationSchema, new Set(modelIds));
  const store = new SnapshotStore();
  try {
    // Full namespaces give the planner every inbound reference and retained
    // state. The model selection limits planned mutations, not the capture.
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
      progress(`Capturing ${label.toLowerCase()} "${environment}".`);
      return captureSnapshot({
        client,
        environmentId: environment,
        schema,
        store: target,
        side,
        // Generation assumes writes are prevented externally during capture.
        verify: 'none',
        options: {
          signal: captureSignal,
          concurrency: maximum,
          progress: (message) => progress(`${label}: ${message}`),
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
    const metadata = await createPlan(store, sourceSchema, destinationSchema, {
      modelIds,
      uploads: options.uploads,
      includeDeletions: options.includeDeletions,
      allowPartial: options.allowPartial,
    });
    // Only records this migration writes matter, so check after planning and
    // before any file is written.
    assertSourceRecordsValid(store, sourceSchema, destinationSchema);
    progress('Writing TypeScript content migration.');
    const scriptPath = await writeMigration({
      signal,
      store,
      metadata,
      outputPath,
      sourceTracking,
      destinationTracking,
      chunkBytes: options.chunkBytes,
    });
    const skipped: ContentGenerationResult['skipped'] = [];
    for (const kind of ['record', 'upload', 'collection'] as const)
      for (const entry of store.planEntries(kind, 'skip'))
        for (const { code, message } of entry.diagnostics)
          skipped.push({ kind, id: entry.id, code, message });
    return {
      scriptPath,
      sourceEnvironmentId,
      destinationEnvironmentId,
      counts: metadata.counts,
      skipped,
    };
  } finally {
    store.dispose();
  }
}

export function selectedModels(
  schema: SchemaState,
  selection: string,
): string[] {
  const regular = schema.models.filter((model) => !model.block);
  if (selection === 'all') return regular.map((model) => model.id).sort();
  const keys = [...new Set(selection.split(',').map((key) => key.trim()))];
  if (keys.some((key) => !key || key === 'all'))
    throw new ContentError(
      'INVALID_MODEL_SELECTION',
      '--item-types must be "all" or comma-separated model API keys.',
    );
  return keys
    .map((key) => {
      const model = regular.find((model) => model.apiKey === key);
      if (!model)
        throw new ContentError(
          'INVALID_MODEL_SELECTION',
          `Source model "${key}" does not exist or is a block.`,
        );
      return model.id;
    })
    .sort();
}

export function environmentId(
  requested: string,
  environments: Array<{ id: string; meta: { primary: boolean } }>,
): string {
  const environment =
    requested === 'primary'
      ? environments.find((value) => value.meta.primary)
      : environments.find((value) => value.id === requested);
  if (!environment)
    throw new ContentError(
      'ENVIRONMENT_NOT_FOUND',
      `Environment "${requested}" is not available.`,
    );
  return environment.id;
}
