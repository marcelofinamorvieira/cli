import { dirname, resolve } from 'node:path';
import type { ContentMigrationDefinition } from '../migration';
import { repairBundle } from './apply';
import { assertNotAborted } from './cancellation';
import { captureSnapshot } from './capture';
import { hashJson, recordGuard } from './codec';
import { ContentError } from './errors';
import {
  baselineBinaryLookup,
  baselineValidity,
  loadBaseline,
} from './migration-artifact';
import { createIntentRecorder } from './migration-intent';
import { projectMigrationSchema } from './migration-schema';
import { resolveIntentValidity } from './migration-validity';
import { createPlan } from './planner';
import { aggregateFields } from './planner-validity';
import {
  assertApplyAccess,
  assertSchemaEditAccess,
  fetchSchema,
  schemaHash,
} from './schema';
import { SnapshotStore } from './store';
import type {
  Client,
  CollectionState,
  RecordGuard,
  RecordState,
  RepairOptions,
  RepairResult,
  SchemaState,
  UploadPlan,
  UploadState,
} from './types';

/** Only validators/defaults can be an interrupted migration's schema residue. */
export function assertRepairSchema(
  current: SchemaState,
  original: SchemaState,
): Set<string> {
  if (current.siteId !== original.siteId)
    throw new ContentError(
      'DESTINATION_MISMATCH',
      'Repair project differs from the migration baseline.',
    );
  const fields = new Map(
    original.models.flatMap((model) =>
      model.fields.map((field) => [field.id, field] as const),
    ),
  );
  const changed = new Set<string>();
  const normalized: SchemaState = {
    ...current,
    models: current.models.map((model) => ({
      ...model,
      fields: model.fields.map((field) => {
        const old = fields.get(field.id);
        if (!old) return field;
        if (
          hashJson(field.validators) !== hashJson(old.validators) ||
          hashJson(field.defaultValue) !== hashJson(old.defaultValue)
        )
          changed.add(field.id);
        return {
          ...field,
          validators: old.validators,
          defaultValue: old.defaultValue,
        };
      }),
    })),
  };
  if (schemaHash(normalized) !== original.hash)
    throw new ContentError(
      'REPAIR_SCHEMA_CONFLICT',
      'Repair requires the original models, fields, types and project settings; only validator/default settings may differ.',
    );
  return changed;
}

/**
 * Reconstruct the original namespace locally, not remotely. Changed baseline
 * identities have complete stored original values; untouched ones must still
 * match their immutable guard because no original payload was saved for them.
 */
export function reconstructRepairBaseline(store: SnapshotStore): void {
  store.clearSide('target');
  store.transaction(() => {
    for (const row of store.database
      .prepare(
        'SELECT kind,id,guard_json,original_json FROM migration_baseline ORDER BY kind,id',
      )
      .iterate()) {
      const id = String(row.id);
      const guard = JSON.parse(String(row.guard_json)) as
        | RecordGuard
        | { hash: string };
      const original =
        row.original_json === null
          ? undefined
          : (JSON.parse(String(row.original_json)) as
              | RecordState
              | UploadState
              | CollectionState);
      const kind = String(row.kind);
      const current =
        kind === 'record'
          ? store.getRecord('live', id)
          : kind === 'upload'
            ? store.getUpload('live', id)
            : store.getCollection('live', id);
      if (!original) {
        let matches = current?.hash === guard.hash;
        if (current && kind === 'record') {
          const { validity: _oldValidity, ...expected } = guard as RecordGuard;
          const { validity: _newValidity, ...actual } = recordGuard(
            current as RecordState,
          );
          matches = hashJson(expected) === hashJson(actual);
        }
        if (!matches)
          throw new ContentError(
            'REPAIR_BASELINE_UNRECOVERABLE',
            `Original ${kind} ${id} was not stored because it was unchanged at generation, and its live state no longer matches the original guard. Repair cannot reconstruct it safely.`,
            { kind, id },
          );
      }
      const state = original ?? current!;
      if (kind === 'record') store.putRecord('target', state as RecordState);
      else if (kind === 'upload')
        store.putUpload('target', state as UploadState);
      else store.putCollection('target', state as CollectionState);
    }
  });
}

/** Rebuild repair intent from the same editable TS; no run progress is saved. */
export async function repairMigrationDefinition(args: {
  definition: ContentMigrationDefinition;
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  scriptPath: string;
  options: RepairOptions;
}): Promise<RepairResult> {
  const { definition, options } = args;
  const store = new SnapshotStore();
  let transferred = false;
  try {
    assertNotAborted(options.signal);
    const directory = resolve(
      dirname(resolve(args.scriptPath)),
      definition.options.baseline,
    );
    options.log?.('Validating the immutable migration baseline for repair.');
    const baseline = await loadBaseline(directory, store, options.signal);
    const environmentId =
      options.destinationEnvironmentId ?? baseline.destination.environmentId;
    const client = args.buildEnvironmentClient(environmentId);
    // Direct repair cannot claim ownership of a tracking model introduced by
    // an unknown native migration run. The recorded exact binding is required.
    const projection = (schema: SchemaState) =>
      projectMigrationSchema(schema, baseline.destinationTracking);
    const [liveSchema, rootSite, environment] = await Promise.all([
      fetchSchema(client, environmentId, projection),
      args.rootClient.site.find(),
      args.rootClient.environments.find(environmentId),
    ]);
    if (
      rootSite.id !== baseline.destination.siteId ||
      liveSchema.siteId !== baseline.destination.siteId
    )
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Repair project differs from the migration baseline.',
      );
    if (environment.meta.read_only_mode || environment.meta.status !== 'ready')
      throw new ContentError(
        'DESTINATION_UNAVAILABLE',
        'Repair environment is not writable and ready.',
      );
    if (environment.meta.primary && !options.allowPrimary)
      throw new ContentError(
        'PRIMARY_REQUIRES_APPROVAL',
        'Repairing primary requires --allow-primary.',
      );
    const originalSchema = { ...baseline.schema, environmentId };
    const changedSettings = assertRepairSchema(liveSchema, originalSchema);
    options.log?.(
      `Reading current content in "${environmentId}" to reconstruct the original repair baseline.`,
    );
    await captureSnapshot({
      client,
      environmentId,
      schema: originalSchema,
      store,
      side: 'live',
      options: {
        modelIds: originalSchema.models
          .filter((model) => !model.block)
          .map((model) => model.id),
        uploads: 'all',
        concurrency: definition.options.concurrency ?? 4,
        signal: options.signal,
        progress: options.log,
        schemaProjection: projection,
      },
      // An interrupted apply intentionally differs from the original baseline.
      // Preserved identities are checked below; the repair executor freshly
      // guards each schedule before restoring it.
      verify: false,
    });
    const afterCapture = await fetchSchema(client, environmentId, projection);
    if (afterCapture.hash !== liveSchema.hash)
      throw new ContentError(
        'REPAIR_SCHEMA_CONFLICT',
        'Schema settings changed while the repair baseline was being read.',
      );
    reconstructRepairBaseline(store);
    const recorder = createIntentRecorder({
      store,
      schema: originalSchema,
      signal: options.signal,
      allowedModelIds: baseline.options.modelIds,
      validityEvidence: baselineValidity(store),
      binaryLookup: (path) => baselineBinaryLookup(store, directory, path),
    });
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
        /* Keep the script error. */
      }
      throw error;
    }
    const models = new Map(
      originalSchema.models.map((model) => [model.id, model]),
    );
    for (const unknown of recorder.needsValidation()) {
      const model = models.get(unknown.modelId)!;
      for (const value of aggregateFields(
        unknown.fields,
        model,
        originalSchema,
      ))
        if (changedSettings.has(value.field.id))
          throw new ContentError(
            'UNSUPPORTED_EDIT_VALIDATION',
            `Edited ${unknown.slice} content for record ${unknown.recordId} cannot be validated while field ${value.field.apiKey} still has temporary or changed settings. Repair with the original script first.`,
            { recordId: unknown.recordId, fieldId: value.field.id },
          );
    }
    await resolveIntentValidity({
      recorder,
      store,
      schema: originalSchema,
      client,
      concurrency: definition.options.concurrency,
      signal: options.signal,
    });
    recorder.assertReady();
    const metadata = await createPlan(
      store,
      {
        ...originalSchema,
        siteId: baseline.source.siteId,
        environmentId: baseline.source.environmentId,
      },
      originalSchema,
      {
        ...baseline.options,
        includeDeletions: true,
        uploads: 'all',
        allowTemporarySchemaChanges: true,
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
    await assertApplyAccess(
      client,
      originalSchema,
      store,
      true,
      baseline.options.modelIds,
    );
    if (metadata.temporarySchemaChanges.length)
      await assertSchemaEditAccess(client);
    assertNotAborted(options.signal);
    transferred = true;
    return await repairBundle({
      rootClient: args.rootClient,
      buildEnvironmentClient: args.buildEnvironmentClient,
      bundlePath: directory,
      options: {
        ...options,
        destinationEnvironmentId: environmentId,
        schemaProjection: projection,
      },
      prepared: {
        metadata,
        entries: () => store.planEntries(),
        release: () => store.dispose(),
      },
    });
  } finally {
    if (!transferred) store.dispose();
  }
}
