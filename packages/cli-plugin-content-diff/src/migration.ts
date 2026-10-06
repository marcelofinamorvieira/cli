import { dirname, resolve } from 'node:path';
import type { ContentMigrationClient } from './content-migration-client';
export type * from './content-migration-client';
import { applyPlan } from './engine/apply';
import { assertNotAborted } from './engine/cancellation';
import { captureSnapshot } from './engine/capture';
import { ContentError } from './engine/errors';
import {
  baselineBinaryLookup,
  baselineValidity,
  compareBaseline,
  loadBaseline,
} from './engine/migration-artifact';
import { createIntentRecorder } from './engine/migration-intent';
import {
  executeRecordedMigrationPart,
  loadMigrationModule,
} from './engine/migration-loader';
import { repairMigrationDefinition } from './engine/migration-repair';
import { projectMigrationSchema } from './engine/migration-schema';
import { resolveIntentValidity } from './engine/migration-validity';
import { createPlan } from './engine/planner';
import { fetchSchema } from './engine/schema';
import { SnapshotStore } from './engine/store';
import type {
  ApplyOptions,
  ApplyOutcome,
  Client,
  RepairOptions,
  RepairResult,
  UploadPlan,
} from './engine/types';

/** The generated TypeScript contains intent; this companion only proves its baseline. */
export interface ContentMigrationOptions {
  baseline: string;
  allowTemporarySchemaChanges?: boolean;
  /** Concurrency for repair reads; content:apply execution uses its CLI flag. */
  concurrency?: number;
}

export interface ContentMigrationDefinition {
  readonly format: 'datocms-content-migration';
  readonly version: 1;
  options: ContentMigrationOptions;
  run: (client: ContentMigrationClient, signal?: AbortSignal) => Promise<void>;
}

/** A declaration consumed by content:apply, not a native migration function. */
export type ContentMigration = ContentMigrationDefinition;

interface RecordingSession {
  signal: AbortSignal;
  controller: AbortController;
  pending: Set<Promise<void>>;
  failure?: unknown;
  closed: boolean;
}

const activeRecorders = new WeakMap<ContentMigrationClient, RecordingSession>();

/**
 * Generated parts run in disposable workers, so compiled code and source maps
 * cannot accumulate across a project. Only one awaited CMA intent is in flight.
 * Scripts are trusted local code; the worker is not a security sandbox.
 */
export function runMigrationPart(
  client: ContentMigrationClient,
  path: string,
): Promise<void> {
  const active = activeRecorders.get(client);
  if (!active || active.closed) {
    const error = new ContentError(
      'INACTIVE_CONTENT_MIGRATION',
      'Migration parts must run inside defineContentMigration.',
    );
    if (active) active.failure ??= error;
    const rejected = Promise.reject(error);
    // Keep rejection observable to an awaiting caller without creating an
    // unhandled rejection when the author omitted await.
    void rejected.catch(() => undefined);
    return rejected;
  }
  const work = executeRecordedMigrationPart(
    path,
    async ({ resource, method, args }) => {
      assertNotAborted(active.signal);
      const target = Reflect.get(client, resource);
      const operation = Reflect.get(target, method);
      if (typeof operation !== 'function')
        throw new ContentError(
          'INVALID_MIGRATION_INTENT',
          `Unsupported CMA operation: ${resource}.${method}`,
        );
      return Reflect.apply(operation, target, args);
    },
    { signal: active.signal },
  );
  active.pending.add(work);
  // Attach handlers to the returned promise itself. An async wrapper would
  // introduce another rejected promise that a missing await could orphan.
  void work.then(
    () => active.pending.delete(work),
    (error) => {
      active.failure ??= error;
      active.pending.delete(work);
      active.controller.abort(error);
    },
  );
  return work;
}

/**
 * Declare content intent for content:apply. The branded descriptor makes the
 * execution contract explicit: calls are recorded locally, replanned and guarded.
 * It is trusted executable code, not a native migration function or a sandbox.
 */
export function defineContentMigration(
  options: ContentMigrationOptions,
  run: (client: ContentMigrationClient) => Promise<void>,
): ContentMigration {
  const definition: ContentMigrationDefinition = {
    format: 'datocms-content-migration',
    version: 1,
    options,
    async run(client, signal) {
      const controller = new AbortController();
      const session: RecordingSession = {
        controller,
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
        pending: new Set(),
        closed: false,
      };
      activeRecorders.set(client, session);
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        try {
          assertNotAborted(session.signal);
          await run(client);
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
        }
        session.closed = true;
        if (callbackFailed) controller.abort(callbackError);
        else if (session.pending.size) {
          session.failure ??= new ContentError(
            'UNAWAITED_MIGRATION_PART',
            'The migration callback finished with an active part. Await every runMigrationPart call.',
          );
          controller.abort(session.failure);
        }
        // A callback failure or missing await must never let a worker outlive
        // recording, its SQLite transaction, or the engine's owned cleanup.
        await Promise.allSettled([...session.pending]);
        if (callbackFailed) throw callbackError;
        if (session.failure !== undefined) throw session.failure;
        assertNotAborted(session.signal);
      } finally {
        session.closed = true;
        controller.abort();
        await Promise.allSettled([...session.pending]);
        activeRecorders.delete(client);
      }
    },
  };
  return definition;
}

export async function loadContentMigration(
  path: string,
  signal?: AbortSignal,
): Promise<ContentMigrationDefinition> {
  const module = await loadMigrationModule<unknown>(path, { signal });
  const declaration =
    module && typeof module === 'object' && 'default' in module
      ? module.default
      : module;
  if (
    !declaration ||
    typeof declaration !== 'object' ||
    !('format' in declaration) ||
    declaration.format !== 'datocms-content-migration' ||
    !('version' in declaration) ||
    declaration.version !== 1 ||
    !('run' in declaration) ||
    typeof declaration.run !== 'function' ||
    !('options' in declaration) ||
    !declaration.options ||
    typeof declaration.options !== 'object' ||
    !('baseline' in declaration.options) ||
    typeof declaration.options.baseline !== 'string' ||
    !declaration.options.baseline
  )
    throw new ContentError(
      'INVALID_CONTENT_MIGRATION',
      'content:apply expects a default descriptor exported by defineContentMigration.',
    );
  return declaration as ContentMigrationDefinition;
}

export interface ContentMigrationApplyArguments {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  scriptPath: string;
  options: ApplyOptions;
}

export async function applyContentMigration(
  args: ContentMigrationApplyArguments,
): Promise<ApplyOutcome> {
  const definition = await loadContentMigration(
    args.scriptPath,
    args.options.signal,
  );
  return executeDefinition({ ...args, definition });
}

async function executeDefinition(
  args: ContentMigrationApplyArguments & {
    definition: ContentMigrationDefinition;
  },
): Promise<ApplyOutcome> {
  const { options, definition } = args;
  const store = new SnapshotStore();
  try {
    assertNotAborted(options.signal);
    const directory = resolve(
      dirname(resolve(args.scriptPath)),
      definition.options.baseline,
    );
    options.log?.('Validating migration baseline and asset checksums.');
    const baseline = await loadBaseline(directory, store, options.signal);
    const environmentId =
      options.destinationEnvironmentId ?? baseline.destination.environmentId;
    const client = args.buildEnvironmentClient(environmentId);
    const projection = (schema: Parameters<typeof projectMigrationSchema>[0]) =>
      projectMigrationSchema(schema, baseline.destinationTracking);
    const schema = await fetchSchema(client, environmentId, projection);
    if (
      schema.siteId !== baseline.destination.siteId ||
      schema.hash !== baseline.schema.hash
    )
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project or schema differs from the migration baseline.',
      );
    const environment = await args.rootClient.environments.find(environmentId);
    if (environment.meta.primary && options.inPlace && !options.allowPrimary)
      throw new ContentError(
        'PRIMARY_REQUIRES_APPROVAL',
        'Applying in place to primary requires --allow-primary.',
      );
    options.log?.(`Checking migration baseline in "${environmentId}".`);
    // DatoCMS maintenance mode only protects primary. Without a persistent
    // sandbox freeze, capture and baseline checks must reject observed drift
    // before the edited TypeScript can produce any remote content writes.
    await captureSnapshot({
      client,
      environmentId,
      schema,
      store,
      side: 'target',
      options: {
        modelIds: schema.models
          .filter((model) => !model.block)
          .map((model) => model.id),
        uploads: 'all',
        concurrency: options.concurrency ?? 8,
        signal: options.signal,
        progress: options.log,
        schemaProjection: projection,
      },
      verify: options.verification === 'full' ? true : 'versions',
    });
    compareBaseline(store, 'target');
    const recorder = createIntentRecorder({
      store,
      schema,
      signal: options.signal,
      allowedModelIds: baseline.options.modelIds,
      validityEvidence: baselineValidity(store),
      binaryLookup: (path) => baselineBinaryLookup(store, directory, path),
    });
    options.log?.(
      'Reading TypeScript CMA operations and rebuilding their safety plan.',
    );
    store.database.exec('BEGIN');
    try {
      await definition.run(recorder.client, options.signal);
      await recorder.drain();
      assertNotAborted(options.signal);
      store.database.exec('COMMIT');
    } catch (error) {
      await recorder.drain().catch(() => undefined);
      try {
        store.database.exec('ROLLBACK');
      } catch {
        /* Preserve the script error. */
      }
      throw error;
    }
    await resolveIntentValidity({
      recorder,
      store,
      schema,
      client,
      concurrency: options.concurrency,
      signal: options.signal,
    });
    recorder.assertReady();
    const metadata = await createPlan(
      store,
      {
        ...schema,
        siteId: baseline.source.siteId,
        environmentId: baseline.source.environmentId,
      },
      schema,
      {
        ...baseline.options,
        // The simulated namespace begins as a complete target copy. Missing
        // identities therefore represent explicit script deletions only.
        includeDeletions: true,
        uploads: 'all',
        allowTemporarySchemaChanges: options.allowTemporarySchemaChanges,
      },
    );
    for (const binding of recorder.binaryBindings()) {
      const entry = store.getPlan('upload', binding.uploadId) as
        | UploadPlan
        | undefined;
      if (entry && (entry.action === 'create' || entry.action === 'update')) {
        entry.binary = binding.asset.binary;
        store.putPlan(entry);
      }
    }
    assertNotAborted(options.signal);
    const result = await applyPlan({
      rootClient: args.rootClient,
      buildEnvironmentClient: args.buildEnvironmentClient,
      artifactDirectory: directory,
      options: { ...options, schemaProjection: projection },
      plan: {
        metadata,
        entries: () => store.planEntries(),
        snapshot: { store, environmentId, schemaHash: schema.hash },
        release: () => store.dispose(),
      },
    });
    result.partial ||= Object.values(baseline.counts).some(
      (counts) => counts.skip > 0,
    );
    return result;
  } finally {
    store.dispose();
  }
}

export async function repairContentMigration(args: {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  scriptPath: string;
  options: RepairOptions;
}): Promise<RepairResult> {
  const definition = await loadContentMigration(
    args.scriptPath,
    args.options.signal,
  );
  return repairMigrationDefinition({ ...args, definition });
}
