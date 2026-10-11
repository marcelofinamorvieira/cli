import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assertNotAborted } from './cancellation';
import { type CaptureSink, captureEnvironment } from './capture';
import {
  canonicalCollection,
  canonicalRecordLine,
  canonicalUpload,
  itemTypeId,
} from './codec';
import { writeDiff } from './diff-file';
import { DumpFile } from './dump';
import { planOperations } from './emit';
import { ContentError } from './errors';
import {
  DEFAULT_TRACKING_MODEL_API_KEY,
  withoutTrackingModel,
} from './migration-schema';
import { type Plan, assertSchemaCompatible, createPlan } from './planner';
import { fetchSchema } from './schema';
import { SideIndex } from './side';
import { assertSourceRecordsValid } from './source-validity';
import type { Client, PlanCounts, PlanOptions, SchemaState } from './types';

/** Records are spread over this many files per side, read one at a time. */
const BUCKETS = 128;

interface GenerationEndpoint {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Promise<Client>;
}

export interface ContentGenerationArguments {
  /** A live environment, or a dump file. */
  source:
    | { endpoint: GenerationEndpoint; environment: string }
    | { dump: string };
  /** Reuse the source endpoint when both sides use the same profile. */
  destination: { endpoint: GenerationEndpoint; environment: string };
  sourceMigrationModelApiKey?: string;
  destinationMigrationModelApiKey?: string;
  /** Where to write the diff, by whether it carries asset files. */
  outputPath: (includesAssets: boolean) => string;
  options: Omit<PlanOptions, 'modelIds'> & {
    itemTypes: string;
    concurrency: number;
  };
  signal: AbortSignal;
  progress?: (message: string) => void;
}

export interface ContentGenerationResult {
  diffPath: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  counts: PlanCounts;
  operations: number;
}

/** A capture sink that puts canonical states of `models` into a side index. */
function indexSink(index: SideIndex, models: ReadonlySet<string>): CaptureSink {
  return {
    async record(line) {
      if (!models.has(itemTypeId(line.current))) return;
      await index.record(canonicalRecordLine(line, index.schema));
    },
    upload: (upload) => index.upload(canonicalUpload(upload)),
    collection: (collection) =>
      index.collection(canonicalCollection(collection)),
  };
}

/** Whether a plan uploads a new or replaced file. */
function uploadsFiles(plan: Plan): boolean {
  return [...plan.uploads.values()].some(
    (entry) =>
      entry.action === 'create' ||
      (entry.action === 'update' &&
        (entry.baseline?.md5 !== entry.desired?.md5 ||
          entry.baseline?.size !== entry.desired?.size)),
  );
}

/** Own generation ordering and temporary files until the diff is written. */
export async function generateContentDiff({
  source,
  destination,
  sourceMigrationModelApiKey,
  destinationMigrationModelApiKey,
  outputPath,
  options,
  signal,
  progress = () => {},
}: ContentGenerationArguments): Promise<ContentGenerationResult> {
  const live = 'endpoint' in source ? source : undefined;
  const dumpPath = 'dump' in source ? source.dump : undefined;
  const dump = dumpPath ? await DumpFile.open(dumpPath) : undefined;
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-'));
  try {
    const sameEndpoint = live?.endpoint === destination.endpoint;
    const [sourceEnvironments, destinationEnvironments] = await Promise.all([
      live?.endpoint.rootClient.environments.list(),
      sameEndpoint
        ? undefined
        : destination.endpoint.rootClient.environments.list(),
    ]);
    const destinationEnvironmentId = environmentId(
      destination.environment,
      destinationEnvironments ?? sourceEnvironments!,
    );
    const sourceEnvironmentId = live
      ? environmentId(live.environment, sourceEnvironments!)
      : dump!.manifest.site.environment;
    const sourceClient = live
      ? await live.endpoint.buildEnvironmentClient(sourceEnvironmentId)
      : undefined;
    const destinationClient = await destination.endpoint.buildEnvironmentClient(
      destinationEnvironmentId,
    );
    const [sourceRawSchema, destinationRawSchema] = await Promise.all([
      sourceClient
        ? fetchSchema(sourceClient, sourceEnvironmentId)
        : dump!.schema,
      fetchSchema(destinationClient, destinationEnvironmentId),
    ]);
    const trackingModelApiKey =
      destinationMigrationModelApiKey || DEFAULT_TRACKING_MODEL_API_KEY;
    const sourceSchema = withoutTrackingModel(
      sourceRawSchema,
      sourceMigrationModelApiKey || DEFAULT_TRACKING_MODEL_API_KEY,
    );
    const destinationSchema = withoutTrackingModel(
      destinationRawSchema,
      trackingModelApiKey,
    );
    // A dump may be a backup of the destination itself.
    if (
      live &&
      sourceSchema.siteId === destinationSchema.siteId &&
      sourceEnvironmentId === destinationEnvironmentId
    )
      throw new ContentError(
        'SAME_ENVIRONMENT',
        'Source and destination must be different environments or projects.',
      );
    const modelIds = selectedModels(sourceSchema, options.itemTypes);
    assertNotAborted(signal);
    // Reject incompatible schemas before reading either side's content.
    assertSchemaCompatible(sourceSchema, destinationSchema, new Set(modelIds));
    const models = new Set(modelIds);
    const sourceIndex = new SideIndex(
      join(directory, 'source'),
      sourceSchema,
      BUCKETS,
      { models },
    );
    const targetIndex = new SideIndex(
      join(directory, 'target'),
      destinationSchema,
      BUCKETS,
      { models },
    );
    // Only the selected models are read on both sides; links from other
    // records to records the diff changes are left to the CMA.
    const capture = (
      label: string,
      client: Client,
      schema: SchemaState,
      index: SideIndex,
      captureSignal: AbortSignal,
    ) => {
      progress(`Capturing ${label.toLowerCase()} "${schema.environmentId}".`);
      return captureEnvironment({
        client,
        schema,
        sink: indexSink(index, models),
        options: {
          signal: captureSignal,
          concurrency: options.concurrency,
          models,
          progress: (message) => progress(`${label}: ${message}`),
        },
      });
    };
    const readers: Array<(signal: AbortSignal) => Promise<void>> = [
      (captureSignal) => {
        if (!dump)
          return capture(
            'Source',
            sourceClient!,
            sourceSchema,
            sourceIndex,
            captureSignal,
          );
        progress(`Reading dump "${basename(dumpPath!)}".`);
        return dump.read(indexSink(sourceIndex, models), captureSignal);
      },
      (captureSignal) =>
        capture(
          'Destination',
          destinationClient,
          destinationSchema,
          targetIndex,
          captureSignal,
        ),
    ];
    if (live && sourceSchema.siteId === destinationSchema.siteId) {
      // One project shares one API rate limit, so reading both environments
      // at once would only trade time for retries.
      for (const read of readers) await read(signal);
    } else {
      // Separate projects, or a dump, are read at once; one failure stops
      // the other read.
      const shared = new AbortController();
      const forward = () => shared.abort();
      signal.addEventListener('abort', forward, { once: true });
      try {
        const results = await Promise.allSettled(
          readers.map((read) =>
            read(shared.signal).catch((error: unknown) => {
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
      } finally {
        signal.removeEventListener('abort', forward);
      }
    }
    assertNotAborted(signal);
    await Promise.all([sourceIndex.flush(), targetIndex.flush()]);
    progress('Planning.');
    const plan = await createPlan(sourceIndex, targetIndex, {
      modelIds,
      uploads: options.uploads,
      includeDeletions: options.includeDeletions,
    });
    // Only records the diff writes matter, so check after planning and
    // before any file is written.
    assertSourceRecordsValid(plan, sourceSchema, destinationSchema);
    const assetFiles = !!dump?.manifest.includesAssets && uploadsFiles(plan);
    const diffPath = outputPath(assetFiles);
    progress('Writing the diff.');
    const operations = await writeDiff({
      path: diffPath,
      manifest: {
        includesAssets: assetFiles,
        source: {
          kind: dump ? 'dump' : 'environment',
          siteId: sourceSchema.siteId,
          environmentId: sourceEnvironmentId,
          ...(dumpPath && { dump: basename(dumpPath) }),
        },
        destination: plan.metadata.destination,
        schemaHash: destinationSchema.hash,
        trackingModelApiKey,
        options: plan.metadata.options,
        counts: plan.metadata.counts,
      },
      operations: planOperations({
        plan,
        source: sourceIndex,
        target: targetIndex,
        directory,
        assetFiles,
        signal,
      }),
      files: assetFiles ? dump!.zip : undefined,
    });
    return {
      diffPath,
      sourceEnvironmentId,
      destinationEnvironmentId,
      counts: plan.metadata.counts,
      operations,
    };
  } finally {
    dump?.close();
    await rm(directory, { recursive: true, force: true });
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
