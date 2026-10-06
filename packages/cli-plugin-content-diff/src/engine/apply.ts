import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { stageBinary } from './apply-binary';
import { validateExecution } from './apply-validation';
import { batches, boundedWork } from './apply-work';
import { readBundle } from './bundle';
import { assertNotAborted } from './cancellation';
import {
  assetDigest,
  captureAssets,
  captureSnapshot,
  clearScan,
  contentDifferences,
  fingerprintDifferences,
  readRecordBatch,
  scanFingerprints,
  scannedFingerprints,
} from './capture';
import {
  canonicalCollection,
  canonicalFields,
  canonicalUpload,
  collectionHash,
  hashJson,
  inspectRecord,
  modelIndex,
  object,
  recordGuard,
  recordHash,
  recordPayloadFields,
  stateFingerprint,
  unsupportedRecordPayloadKey,
} from './codec';
import { lockEnvironment, unlockEnvironment } from './environment-lock';
import { ContentError } from './errors';
import { buildPlanPreview } from './migration-preview';
import { collectionTransitionIssues, orderedCollectionWrites } from './planner';
import {
  assertApplyAccess,
  assertSchemaEditAccess,
  fetchSchema,
} from './schema';
import { SnapshotStore } from './store';
import type {
  ApplyOptions,
  ApplyOutcome,
  Client,
  CollectionPlan,
  CollectionState,
  JsonObject,
  Kind,
  PlanEntry,
  PlanMetadata,
  RecordGuard,
  RecordPlan,
  RecordState,
  RepairOptions,
  RepairResult,
  Schedules,
  SchemaState,
  UploadPlan,
  UploadState,
} from './types';

const emptySchedules: Schedules = { publication: null, unpublishing: null };

/** One counter per model/action, never one object per record. */
class ExecutionProgress {
  private readonly groups = new Map<
    string,
    { completed: number; reported: number }
  >();
  private lastReport = Date.now();

  constructor(private readonly log?: ApplyOptions['log']) {}

  completed(group: string): void {
    if (!this.log) return;
    const count = this.groups.get(group) ?? { completed: 0, reported: 0 };
    count.completed++;
    this.groups.set(group, count);
    if (Date.now() - this.lastReport >= 5_000) this.flush();
  }

  flush(): void {
    this.lastReport = Date.now();
    for (const [group, count] of this.groups) {
      if (count.completed === count.reported) continue;
      this.log?.(`${group}: ${count.completed} completed and verified.`);
      count.reported = count.completed;
    }
  }
}

export function validateForkName(
  options: Pick<ApplyOptions, 'forkName' | 'inPlace'>,
): void {
  if (options.forkName === undefined) return;
  if (options.inPlace)
    throw new ContentError(
      'INVALID_FORK_NAME',
      '--fork-name cannot be used with --in-place.',
    );
  if (!options.forkName || /[^a-z0-9-]/.test(options.forkName))
    throw new ContentError(
      'INVALID_FORK_NAME',
      'Fork names must contain only lowercase letters, numbers, and dashes, and cannot be empty.',
    );
}

function conflict(kind: Kind, id: string, reason: string): never {
  throw new ContentError('APPLY_CONFLICT', `${kind} ${id}: ${reason}`);
}

function equal(a: unknown, b: unknown): boolean {
  return hashJson(a) === hashJson(b);
}

function guardsEqual(a: RecordGuard | null, b: RecordGuard | null): boolean {
  const portable = (guard: RecordGuard | null) =>
    guard
      ? {
          hash: guard.hash,
          modelId: guard.modelId,
          currentVersion: guard.currentVersion,
          publishedUpdatedAt: guard.publishedUpdatedAt,
          parentId: guard.parentId,
          position: guard.position,
          schedules: guard.schedules,
        }
      : null;
  // Schema workers can recalculate validity independently and asynchronously.
  // It is a diagnostic, while versions and portable values detect actual edits.
  return equal(portable(a), portable(b));
}

function missing(error: unknown): boolean {
  return error instanceof CmaClient.ApiError && error.response.status === 404;
}

async function findMaybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function futureSchedules(id: string, schedules: Schedules): void {
  for (const schedule of [schedules.publication, schedules.unpublishing]) {
    if (
      schedule &&
      (!Number.isFinite(Date.parse(schedule.at)) ||
        Date.parse(schedule.at) <= Date.now())
    ) {
      throw new ContentError(
        'EXPIRED_SCHEDULE',
        `Record ${id} has a schedule that is no longer in the future.`,
      );
    }
  }
}

function describeSchedules(schedules: Schedules): string {
  return (
    [
      schedules.publication && `publication at ${schedules.publication.at}`,
      schedules.unpublishing && `unpublishing at ${schedules.unpublishing.at}`,
    ]
      .filter(Boolean)
      .join(' and ') || 'none'
  );
}

/**
 * A schedule that fires during apply changes content the run is about to
 * verify, and a written record's schedule is only recreated after the writes.
 * Refuse to start when any destination schedule, or any schedule the bundle
 * recreates, falls due within the window.
 */
function assertScheduleWindow(context: Context, minutes: number): void {
  const deadline = Date.now() + minutes * 60_000;
  for (const row of context.store.database
    .prepare(`SELECT id,at FROM (
      SELECT id,json_extract(state_json,'$.schedules.publication.at') AS at FROM records WHERE side='live'
      UNION ALL SELECT id,json_extract(state_json,'$.schedules.unpublishing.at') FROM records WHERE side='live'
      UNION ALL SELECT id,json_extract(data,'$.desired.schedules.publication.at') FROM plan WHERE kind='record' AND action IN ('create','update')
      UNION ALL SELECT id,json_extract(data,'$.desired.schedules.unpublishing.at') FROM plan WHERE kind='record' AND action IN ('create','update')
    ) WHERE at IS NOT NULL ORDER BY id`)
    .iterate()) {
    const at = Date.parse(String(row.at));
    if (Number.isFinite(at) && at > deadline) continue;
    throw new ContentError(
      'SCHEDULE_DUE_DURING_APPLY',
      `Record ${row.id} has a schedule at ${row.at}, within the ${minutes}-minute schedule window. Apply after it has run, or lower --schedule-window.`,
      { recordId: String(row.id), at: String(row.at), windowMinutes: minutes },
    );
  }
}

interface Context {
  client: Client;
  store: SnapshotStore;
  manifest: PlanMetadata;
  schema: SchemaState;
  schemaProjection?: (schema: SchemaState) => SchemaState;
  bundlePath: string;
  concurrency: number;
  mutations: number;
  writesPlanned: boolean;
  /** The written environment is locked against other edits. */
  locked: boolean;
  verification: 'versions' | 'full';
  /** Repair can restore settings/schedules, but must never save record content. */
  repairOnly?: boolean;
  signal?: AbortSignal;
  log?: ApplyOptions['log'];
  progress?: ExecutionProgress;
}

function scheduleNeedsValidity(context: Context, record: RecordState): boolean {
  const model = modelIndex(context.schema).get(record.modelId)!;
  return (
    (model.saveInvalidDrafts ||
      context.schema.semantics.improved_validation_at_publishing === true) &&
    !(model.saveInvalidDrafts && record.schedules.publication?.selective)
  );
}

function assertRecordWritable(context: Context, record: RecordState): void {
  const key = unsupportedRecordPayloadKey(
    record.current,
    record.modelId,
    context.schema,
  );
  if (key)
    throw new ContentError(
      'UNSUPPORTED_RECORD_PAYLOAD',
      `Record ${record.id} payload metadata ${key} cannot round-trip through the SDK.`,
    );
}

function managedRecord(context: Context, entry: RecordPlan): boolean {
  return (
    context.manifest.options.modelIds.includes(entry.modelId) &&
    entry.action !== 'skip'
  );
}

function* records(
  context: Context,
  actions: string[],
  order: 'createOrder' | 'updateOrder' | 'publishOrder' | 'deleteOrder',
  rank?: number,
): Generator<RecordPlan> {
  // With an unanalyzed temporary database SQLite can prefer scanning the
  // primary key for every rank, making a dependency chain quadratic. The
  // preflight creates this exact expression index before any phase runs.
  const rows = context.store.database.prepare(
    `SELECT data FROM plan INDEXED BY apply_record_${order} WHERE kind='record' AND action IN (${actions
      .map(() => '?')
      .join(',')})
     ${
       rank === undefined
         ? ''
         : `AND COALESCE(json_extract(data,'$.execution.${order}'),0)=?`
     }
     ORDER BY COALESCE(json_extract(data,'$.execution.${order}'),0),model_id,id`,
  );
  for (const row of rows.iterate(
    ...actions,
    ...(rank === undefined ? [] : [rank]),
  )) {
    yield JSON.parse(row.data as string) as RecordPlan;
  }
}

function* scheduledRecords(
  context: Context,
  restore: boolean,
): Generator<RecordPlan> {
  // Only records this run writes have their schedules cancelled and then
  // recreated. Unchanged records keep theirs: the preflight refuses to start
  // when a schedule falls due within the schedule window, and final
  // verification reports one that fires anyway.
  const schedulePath = restore
    ? "'$.desired.schedules'"
    : "'$.guard.schedules'";
  const rows = context.store.database.prepare(`SELECT data FROM plan WHERE kind='record'
    AND action IN (${restore ? "'create','update'" : "'update','delete'"})
    AND (json_extract(data,(${schedulePath}) || '.publication') IS NOT NULL OR json_extract(data,(${schedulePath}) || '.unpublishing') IS NOT NULL)
    ORDER BY model_id,id`);
  for (const row of rows.iterate()) {
    const entry = JSON.parse(row.data as string) as RecordPlan;
    if (managedRecord(context, entry)) yield entry;
  }
}

function* orderedCollections(
  context: Context,
  deleting: boolean,
): Generator<CollectionPlan> {
  if (!deleting) {
    // Preflight ranks the full intended tree, including preserved ancestors.
    // Using only changed parents can attempt a move before a needed detach.
    yield* orderedCollectionWrites(context.store);
    return;
  }
  const actions = deleting ? "'delete'" : "'create','update'";
  const parent = deleting ? 'baseline' : 'desired';
  const rows = context.store.database.prepare(`WITH RECURSIVE ordered(id,depth) AS (
    SELECT id,0 FROM plan WHERE kind='collection' AND action IN (${actions})
    AND (json_extract(data,'$.${parent}.parentId') IS NULL OR json_extract(data,'$.${parent}.parentId') NOT IN (SELECT id FROM plan WHERE kind='collection' AND action IN (${actions})))
    UNION ALL SELECT p.id,o.depth+1 FROM ordered o CROSS JOIN plan p INDEXED BY apply_plan_${parent}_parent ON json_extract(p.data,'$.${parent}.parentId')=+o.id WHERE p.kind='collection' AND p.action IN (${actions}))
    SELECT p.data FROM plan p JOIN ordered o ON p.id=o.id WHERE p.kind='collection' ORDER BY o.depth ${
      deleting ? 'DESC' : 'ASC'
    },p.id`);
  for (const row of rows.iterate())
    yield JSON.parse(row.data as string) as CollectionPlan;
}

async function recordPhase(
  context: Context,
  actions: string[],
  order: 'createOrder' | 'updateOrder' | 'publishOrder' | 'deleteOrder',
  phase: string,
  work: (entry: RecordPlan) => Promise<void>,
): Promise<void> {
  const models = modelIndex(context.schema);
  const progressState = context.log
    ? context.store.database.prepare(
        "SELECT hash,json_extract(state_json,'$.currentVersion') AS version FROM records WHERE side='live' AND id=?",
      )
    : undefined;
  const dependencyModelId = context.store.database.prepare(
    "SELECT model_id FROM records WHERE side='live' AND id=? UNION ALL SELECT model_id FROM plan WHERE kind='record' AND id=? LIMIT 1",
  );
  const ranks = context.store.database.prepare(
    `SELECT DISTINCT COALESCE(json_extract(data,'$.execution.${order}'),0) AS rank
     FROM plan INDEXED BY apply_record_${order} WHERE kind='record' AND action IN (${actions
       .map(() => '?')
       .join(',')}) ORDER BY rank`,
  );
  for (const row of ranks.iterate(...actions)) {
    assertNotAborted(context.signal);
    await boundedWork(
      records(context, actions, order, Number(row.rank)),
      context.concurrency,
      async (entry) => {
        const before = progressState?.get(entry.id);
        await work(entry);
        const after = progressState?.get(entry.id);
        // A publication/current pass can legitimately be a no-op. Report only
        // a completed, guarded change; concurrent workers have independent IDs.
        if (
          before?.hash !== after?.hash ||
          before?.version !== after?.version
        ) {
          const model = models.get(entry.modelId)!;
          context.progress?.completed(
            `${entry.action} records / ${phase} / ${JSON.stringify(
              model.name,
            )} (${model.apiKey})`,
          );
        }
      },
      (entry) => {
        const model = models.get(entry.modelId)!;
        // CMA renumbers siblings when inserting, removing, or moving. Serialize
        // the whole ordered model, including moves between sibling groups.
        const writes = [`record:${entry.id}`];
        if (model.sortable || model.tree) writes.push(`model:${entry.modelId}`);
        const reads: string[] = [];
        const ids = new Set([
          ...entry.safety.currentReferences,
          ...entry.safety.publishedReferences,
          ...(entry.safety.desiredParentId
            ? [entry.safety.desiredParentId]
            : []),
        ]);
        for (const id of ids) {
          if (id === entry.id) continue;
          reads.push(`record:${id}`);
          const row = dependencyModelId.get(id, id);
          const dependencyModel = row
            ? models.get(String(row.model_id))
            : undefined;
          // Renumbering can change a referenced sibling even when that sibling
          // is preserved. Its entire ordered model is a read dependency.
          if (dependencyModel?.sortable || dependencyModel?.tree)
            reads.push(`model:${dependencyModel.id}`);
        }
        return { writes, reads };
      },
      context.signal,
    );
  }
  context.progress?.flush();
}

async function focusedRecord(
  context: Context,
  id: string,
): Promise<RecordState | null> {
  return (
    (await readRecordBatch(context.client, [id], context.schema))[0] ?? null
  );
}

async function guardRecord(
  context: Context,
  id: string,
): Promise<RecordState | null> {
  assertNotAborted(context.signal);
  // DatoCMS cannot persistently freeze a sandbox. Re-read both full versions
  // here: publication, destruction and schedule APIs have no version token.
  // A subsequent update also sends current_version for optimistic locking.
  const expected = context.store.getRecord('live', id);
  const live = await focusedRecord(context, id);
  if (
    !guardsEqual(
      expected ? recordGuard(expected) : null,
      live ? recordGuard(live) : null,
    )
  ) {
    conflict('record', id, 'changed since the preceding verified state');
  }
  return live;
}

async function rememberRecord(
  context: Context,
  id: string,
  expected: RecordState,
): Promise<RecordState> {
  const record = await focusedRecord(context, id);
  if (!record) conflict('record', id, 'missing after a write');
  // A sandbox cannot be frozen between the write and this read. Only accept
  // its predicted effects, otherwise a concurrent edit becomes the next
  // trusted baseline and later phases can silently overwrite that edit.
  if (
    recordHash(record) !== recordHash(expected) ||
    record.position !== expected.position
  )
    conflict('record', id, 'content or lifecycle changed during a write');
  context.store.putRecord('live', record);
  context.store.database
    .prepare(
      'INSERT INTO apply_schedule_state(id,schedules_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET schedules_json=excluded.schedules_json,previous_schedules_json=NULL',
    )
    .run(id, JSON.stringify(record.schedules));
  return record;
}

async function dependencies(
  context: Context,
  entry: RecordPlan,
  published: boolean,
): Promise<void> {
  // A complete preflight cannot prevent a later concurrent dependency edit.
  // Check the narrow dependency set again immediately around its owner's write.
  const ids = published
    ? entry.safety.publishedReferences
    : entry.safety.currentReferences;
  function* dependencyIds() {
    // A record can publish a reference to itself in the same write. Its own
    // guard already protects it; requiring an earlier published copy would
    // reject that native lifecycle. Tree parents remain separate dependencies.
    for (const id of ids) if (id !== entry.id) yield id;
    if (entry.safety.desiredParentId) yield entry.safety.desiredParentId;
  }
  for (const batch of batches(dependencyIds())) {
    assertNotAborted(context.signal);
    const states = await readRecordBatch(context.client, batch, context.schema);
    for (const id of batch) {
      const state = states.find((record) => record.id === id);
      if (!state || (published && !state.published)) {
        conflict(
          'record',
          entry.id,
          `dependency ${id} is ${published ? 'not published' : 'missing'}`,
        );
      }
      const expected = context.store.getRecord('live', id);
      if (expected && !guardsEqual(recordGuard(expected), recordGuard(state))) {
        conflict('record', id, 'dependency changed during execution');
      }
    }
  }
  for (const id of entry.safety.uploadReferences) {
    assertNotAborted(context.signal);
    const expected = context.store.getUpload('live', id);
    const upload = await findMaybe(() => context.client.uploads.find(id));
    if (
      !upload ||
      !expected ||
      canonicalUpload(upload).hash !== expected.hash
    ) {
      conflict('upload', id, 'required asset changed or disappeared');
    }
  }
}

async function noReferrers(
  context: Context,
  entry: RecordPlan,
  publishedOnly: boolean,
): Promise<void> {
  const refs = await context.client.items.references(entry.id, {
    nested: false,
    version: publishedOnly ? 'published' : 'published-or-current',
  });
  // CMA reports self references too, but destruction/unpublishing handles
  // those atomically with their owner. Other record referrers remain fatal.
  // This exception never applies to the separate upload identity namespace.
  if (refs.some((record) => record.id !== entry.id))
    conflict('record', entry.id, 'still has live referrers');
  const model = context.schema.models.find((m) => m.id === entry.modelId)!;
  if (model.tree && !publishedOnly) {
    const parent = await context.client.items.find(entry.id);
    if (parent.meta.has_children !== false)
      conflict(
        'record',
        entry.id,
        'tree-child absence cannot be proven before deletion',
      );
  }
  // Publication has no version token. recursive:false is the server-side
  // guard against unpublishing any child as an incidental side effect.
}

/** Only siblings whose positions the CMA will shift need a focused guard. */
function* orderingRecords(
  context: Context,
  modelId: string,
): Generator<RecordState> {
  const rows = context.store.database.prepare(
    "SELECT r.state_json FROM apply_ordering o CROSS JOIN records r ON r.side='live' AND r.id=o.id WHERE o.model_id=? ORDER BY o.id",
  );
  for (const row of rows.iterate(modelId))
    yield JSON.parse(row.state_json as string) as RecordState;
}

async function orderingBefore(
  context: Context,
  entry: RecordPlan,
  next?: { parentId: string | null; position: number | null } | null,
): Promise<boolean> {
  // Maintenance mode applies only to primary, so ordering writes must prove
  // the live affected range before trusting the predicted sibling renumbering.
  const model = context.schema.models.find((m) => m.id === entry.modelId)!;
  if ((!model.tree && !model.sortable) || next === undefined) return false;
  const previous = context.store.getRecord('live', entry.id);
  if (
    previous &&
    next &&
    previous.parentId === next.parentId &&
    previous.position === next.position
  )
    return false;
  if (next && next.position === null)
    throw new ContentError(
      'UNEXECUTABLE_ORDERING',
      `Ordered record ${entry.id} has no position.`,
    );
  const db = context.store.database;
  db.prepare('DELETE FROM apply_ordering WHERE model_id=?').run(entry.modelId);
  const insert = (
    predicate: string,
    parameters: (string | number | null)[],
  ) => {
    db.prepare(
      `INSERT OR IGNORE INTO apply_ordering SELECT model_id,id,parent_id,position FROM records WHERE side='live' AND model_id=? AND id!=? AND ${predicate}`,
    ).run(entry.modelId, entry.id, ...parameters);
  };
  if (previous && next && previous.parentId === next.parentId) {
    const oldPosition = previous.position!;
    const newPosition = next.position!;
    if (oldPosition < newPosition)
      insert('parent_id IS ? AND position>? AND position<=?', [
        previous.parentId,
        oldPosition,
        newPosition,
      ]);
    else
      insert('parent_id IS ? AND position>=? AND position<?', [
        previous.parentId,
        newPosition,
        oldPosition,
      ]);
  } else {
    if (previous)
      insert('parent_id IS ? AND position>?', [
        previous.parentId,
        previous.position,
      ]);
    if (next)
      insert('parent_id IS ? AND position>=?', [next.parentId, next.position]);
  }
  // Pulling a bounded affected range avoids rereading the entire ordered model
  // for every ordinary field update or append to a large collection.
  for (const batch of batches(orderingRecords(context, entry.modelId))) {
    assertNotAborted(context.signal);
    const states = await readRecordBatch(
      context.client,
      batch.map((record) => record.id),
      context.schema,
    );
    for (const expected of batch) {
      const actual = states.find((record) => record.id === expected.id);
      if (!actual || !guardsEqual(recordGuard(expected), recordGuard(actual)))
        conflict(
          'record',
          expected.id,
          'affected sibling changed before an ordering write',
        );
    }
  }
  if (previous)
    db.prepare(
      'UPDATE apply_ordering SET position=position-1 WHERE model_id=? AND parent_id IS ? AND position>?',
    ).run(entry.modelId, previous.parentId, previous.position);
  if (next) {
    db.prepare(
      'UPDATE apply_ordering SET position=position+1 WHERE model_id=? AND parent_id IS ? AND position>=?',
    ).run(entry.modelId, next.parentId, next.position);
    db.prepare(
      'INSERT INTO apply_ordering(model_id,id,parent_id,position) VALUES(?,?,?,?)',
    ).run(entry.modelId, entry.id, next.parentId, next.position);
  }
  return true;
}

async function orderingAfter(
  context: Context,
  entry: RecordPlan,
): Promise<void> {
  for (const batch of batches(orderingRecords(context, entry.modelId))) {
    const states = await readRecordBatch(
      context.client,
      batch.map((record) => record.id),
      context.schema,
    );
    for (const expected of batch) {
      const actual = states.find((record) => record.id === expected.id);
      if (!actual)
        conflict('record', expected.id, 'ordered sibling disappeared');
      const topology = context.store.database
        .prepare('SELECT parent_id,position FROM apply_ordering WHERE id=?')
        .get(expected.id)!;
      if (
        actual.parentId !== topology.parent_id ||
        actual.position !== topology.position
      )
        conflict(
          'record',
          expected.id,
          'sibling ordering differs from the predicted CMA renumbering',
        );
      // Server-driven sibling renumbering can change a version, but it must
      // preserve every content, lifecycle, stage, publication and schedule value.
      if (recordHash(actual) !== expected.hash)
        conflict(
          'record',
          expected.id,
          'ordered sibling content changed during a write',
        );
      context.store.putRecord('live', actual);
    }
  }
}

async function updateRecord(
  context: Context,
  entry: RecordPlan,
  body: JsonObject,
  guarded?: RecordState,
): Promise<RecordState> {
  if (context.repairOnly)
    throw new ContentError(
      'REPAIR_CONTENT_WRITE_REQUIRED',
      `Record ${entry.id} needs a new content version before its schedule can be restored; repair cannot write record content.`,
    );
  const expected = context.store.getRecord('live', entry.id);
  if (
    expected &&
    'parent_id' in body &&
    body.parent_id !== expected.parentId &&
    !('position' in body)
  ) {
    throw new ContentError(
      'UNEXECUTABLE_ORDERING',
      `Record ${entry.id} reparenting requires an explicit destination position.`,
    );
  }
  const ordering = await orderingBefore(
    context,
    entry,
    expected
      ? {
          parentId:
            'parent_id' in body
              ? (body.parent_id as string | null)
              : expected.parentId,
          position:
            'position' in body
              ? (body.position as number | null)
              : expected.position,
        }
      : undefined,
  );
  // A caller's guard read is still the latest read unless the ordering check
  // read siblings in between.
  const live =
    guarded && !ordering ? guarded : await guardRecord(context, entry.id);
  if (!live) conflict('record', entry.id, 'missing before update');
  if (!live.currentVersion)
    throw new ContentError(
      'UNEXECUTABLE_STATE',
      `Record ${entry.id} has no optimistic locking version.`,
    );
  const meta = (body.meta ?? {}) as JsonObject;
  const model = modelIndex(context.schema).get(entry.modelId)!;
  const current = canonicalFields(
    { ...live.current, ...body },
    entry.modelId,
    context.schema,
  );
  const intended: RecordState = {
    ...live,
    current,
    published: model.draftMode ? live.published : current,
    createdAt: 'created_at' in meta ? String(meta.created_at) : live.createdAt,
    firstPublishedAt:
      'first_published_at' in meta
        ? (meta.first_published_at as string | null)
        : live.firstPublishedAt,
    stage: 'stage' in meta ? (meta.stage as string | null) : live.stage,
    parentId:
      'parent_id' in body ? (body.parent_id as string | null) : live.parentId,
    position:
      'position' in body ? (body.position as number | null) : live.position,
  };
  // Preservation records can also need a validity or ordering write. Check
  // the actual resulting payload here, including repair paths, before an SDK
  // adapter can drop opaque metadata or fail after the remote write commits.
  assertRecordWritable(context, intended);
  assertNotAborted(context.signal);
  await context.client.items.update(entry.id, {
    ...body,
    meta: { ...meta, current_version: live.currentVersion },
  } as Parameters<Client['items']['update']>[1]);
  context.mutations++;
  const result = await rememberRecord(context, entry.id, intended);
  if (ordering) await orderingAfter(context, entry);
  return result;
}

function metadata(record: RecordState): JsonObject {
  return {
    created_at: record.createdAt,
    first_published_at: record.firstPublishedAt,
    stage: record.stage,
  };
}

function intendSchedule(
  context: Context,
  id: string,
  schedules: Schedules,
): void {
  context.store.database
    .prepare(
      'UPDATE apply_schedule_state SET touched=1,previous_schedules_json=schedules_json,schedules_json=? WHERE id=?',
    )
    .run(JSON.stringify(schedules), id);
}

/** Writes fields if they differ and returns the record as last read. */
async function writeFields(
  context: Context,
  entry: RecordPlan,
  fields: JsonObject,
): Promise<RecordState> {
  const live = await guardRecord(context, entry.id);
  if (!live) conflict('record', entry.id, 'missing before writing fields');
  if (equal(live.current, fields)) return live;
  const verified = await updateRecord(
    context,
    entry,
    recordPayloadFields(fields, entry.modelId, context.schema),
    live,
  );
  if (!equal(verified.current, fields))
    conflict('record', entry.id, 'field payload did not converge');
  return verified;
}

async function cancelSchedules(context: Context, id: string): Promise<void> {
  const expectedSchedules = context.store.getRecord('live', id)?.schedules;
  if (!expectedSchedules?.publication && !expectedSchedules?.unpublishing)
    return;
  let live = await guardRecord(context, id);
  if (!live) return;
  if (live.schedules.publication) {
    const schedules = { ...live.schedules, publication: null };
    intendSchedule(context, id, schedules);
    assertNotAborted(context.signal);
    await context.client.scheduledPublication.destroy(id);
    context.mutations++;
    live = await rememberRecord(context, id, { ...live, schedules });
    if (live.schedules.publication)
      conflict('record', id, 'publication schedule was not canceled');
  }
  // The record was read just above, by the guard or after the previous write.
  if (live.schedules.unpublishing) {
    const schedules = { ...live.schedules, unpublishing: null };
    intendSchedule(context, id, schedules);
    assertNotAborted(context.signal);
    await context.client.scheduledUnpublishing.destroy(id);
    context.mutations++;
    live = await rememberRecord(context, id, { ...live, schedules });
    if (live.schedules.unpublishing)
      conflict('record', id, 'unpublishing schedule was not canceled');
  }
}

async function restoreSchedules(
  context: Context,
  id: string,
  schedules: Schedules,
): Promise<void> {
  const expected = context.store.getRecord('live', id)?.schedules;
  if (
    !schedules.publication &&
    !schedules.unpublishing &&
    !expected?.publication &&
    !expected?.unpublishing
  )
    return;
  futureSchedules(id, schedules);
  let verified = false;
  if (schedules.publication) {
    let live = await guardRecord(context, id);
    if (!live) conflict('record', id, 'missing before scheduling publication');
    const stampRequired = scheduleNeedsValidity(context, {
      ...live,
      schedules,
    });
    if (stampRequired && !live.validity.current) {
      const entry = context.store.getPlan('record', id) as
        | RecordPlan
        | undefined;
      if (!entry) conflict('record', id, 'schedule owner has no guarded plan');
      // Full scheduled publication checks the persisted stamp too. Refresh a
      // stale diagnostic by saving the same content with optimistic locking.
      live = await updateRecord(
        context,
        entry,
        recordPayloadFields(live.current, live.modelId, context.schema),
      );
      if (!live.validity.current)
        throw new ContentError(
          'INVALID_SCHEDULE',
          `Record ${id} is invalid before scheduling publication.`,
        );
      await guardRecord(context, id);
    }
    const current = context.store.getRecord('live', id)!;
    const intendedSchedules = {
      ...current.schedules,
      publication: schedules.publication,
    };
    intendSchedule(context, id, intendedSchedules);
    assertNotAborted(context.signal);
    await context.client.scheduledPublication.create(id, {
      publication_scheduled_at: schedules.publication.at,
      selective_publication: schedules.publication.selective
        ? {
            content_in_locales: schedules.publication.selective.locales,
            non_localized_content: schedules.publication.selective.nonLocalized,
          }
        : null,
    });
    context.mutations++;
    await rememberRecord(context, id, {
      ...current,
      schedules: intendedSchedules,
    });
    verified = true;
  }
  if (schedules.unpublishing) {
    futureSchedules(id, schedules);
    // rememberRecord has just read it after the publication schedule.
    if (!verified) await guardRecord(context, id);
    const current = context.store.getRecord('live', id)!;
    const intendedSchedules = {
      ...current.schedules,
      unpublishing: schedules.unpublishing,
    };
    intendSchedule(context, id, intendedSchedules);
    assertNotAborted(context.signal);
    await context.client.scheduledUnpublishing.create(id, {
      unpublishing_scheduled_at: schedules.unpublishing.at,
      content_in_locales: schedules.unpublishing.locales,
    });
    context.mutations++;
    await rememberRecord(context, id, {
      ...current,
      schedules: intendedSchedules,
    });
  }
  if (!equal(context.store.getRecord('live', id)?.schedules, schedules)) {
    conflict(
      'record',
      id,
      'restored schedules differ from the exact requested schedules',
    );
  }
}

async function createRecord(
  context: Context,
  entry: RecordPlan,
): Promise<void> {
  const desired = entry.desired!;
  const fields =
    entry.execution?.creationFields ?? desired.published ?? desired.current;
  const seed = { ...desired, current: fields, published: null };
  const inspected = inspectRecord(seed, context.schema);
  const references = inspected.references
    .filter((reference) => reference.kind === 'current')
    .map((reference) => reference.targetId);
  const model = modelIndex(context.schema).get(entry.modelId)!;
  const seedPlan = {
    ...entry,
    safety: {
      ...entry.safety,
      currentReferences: references,
      publishedReferences: references,
    },
  };
  // Creating on a model without draft mode also publishes. Check only the
  // actual seed dependencies, and require their publication before this write
  // so CMA link strategies cannot publish another record incidentally.
  await dependencies(context, seedPlan, !model.draftMode);
  const ordering = await orderingBefore(context, entry, {
    parentId: desired.parentId,
    position: desired.position,
  });
  await guardRecord(context, entry.id);
  assertRecordWritable(context, seed);
  assertNotAborted(context.signal);
  await context.client.items.create({
    id: entry.id,
    item_type: { id: entry.modelId, type: 'item_type' },
    ...recordPayloadFields(fields, entry.modelId, context.schema),
    meta: {
      created_at: desired.createdAt,
      first_published_at: desired.firstPublishedAt,
    },
    ...(model.tree ? { parent_id: desired.parentId } : {}),
    ...(model.tree || model.sortable ? { position: desired.position } : {}),
  } as Parameters<Client['items']['create']>[0]);
  context.mutations++;
  const workflow = context.schema.workflows.find(
    (candidate) => candidate.id === model.workflowId,
  );
  const initialStage = Array.isArray(workflow?.stages)
    ? workflow.stages.find((stage) => object(stage) && stage.initial === true)
    : undefined;
  const created = await rememberRecord(context, entry.id, {
    ...desired,
    current: fields,
    published: model.draftMode ? null : fields,
    stage:
      object(initialStage) && typeof initialStage.id === 'string'
        ? initialStage.id
        : null,
    schedules: emptySchedules,
  });
  if (!equal(created.current, fields))
    conflict('record', entry.id, 'creation seed did not converge');
  if (ordering) await orderingAfter(context, entry);
}

async function publication(
  context: Context,
  entry: RecordPlan,
  republish = false,
): Promise<void> {
  const desired = entry.desired!;
  // A record in a publication cycle is first published without its links to
  // the rest of the cycle (see the planner's breakPublicationCycles), so its
  // dependency check covers only what that provisional version references.
  // The republication pass then publishes the full desired fields, once every
  // record it links to is published.
  const provisional = republish
    ? undefined
    : entry.execution?.provisionalPublished;
  const published = provisional ?? desired.published;
  const publicationPlan: RecordPlan = provisional
    ? {
        ...entry,
        safety: {
          ...entry.safety,
          publishedReferences: inspectRecord(
            { ...desired, current: provisional, published: null },
            context.schema,
          )
            .references.filter((reference) => reference.kind === 'current')
            .map((reference) => reference.targetId),
        },
      }
    : entry;
  let live = await guardRecord(context, entry.id);
  if (!live) conflict('record', entry.id, 'missing before publication');
  const model = context.schema.models.find((m) => m.id === entry.modelId)!;
  const preparation: JsonObject = {};
  if (model.tree && live.parentId !== desired.parentId) {
    preparation.parent_id = desired.parentId;
    preparation.position = desired.position;
  }
  if (
    live.createdAt !== desired.createdAt ||
    live.firstPublishedAt !== desired.firstPublishedAt
  ) {
    preparation.meta = {
      created_at: desired.createdAt,
      first_published_at: desired.firstPublishedAt,
    };
  }
  if (Object.keys(preparation).length)
    live = await updateRecord(context, entry, preparation);
  if (equal(live.published, published)) return;
  if (!published) {
    await noReferrers(context, entry, true);
    await guardRecord(context, entry.id);
    assertRecordWritable(context, live);
    assertNotAborted(context.signal);
    await context.client.items.unpublish(entry.id, undefined, {
      recursive: false,
    });
    context.mutations++;
    live = await rememberRecord(context, entry.id, {
      ...live,
      published: null,
    });
    if (live.published)
      conflict('record', entry.id, 'unpublishing did not converge');
    return;
  }
  await dependencies(context, publicationPlan, true);
  live = await writeFields(context, entry, published);
  if (!live.validity.current) {
    // The private validateExisting endpoint only checks a payload; it does not
    // persist a refreshed validity stamp. Save the same guarded content under
    // the declared temporary validators before attempting publication.
    live = await updateRecord(
      context,
      entry,
      recordPayloadFields(live.current, entry.modelId, context.schema),
    );
  }
  if (!live.validity.current) {
    throw new ContentError(
      'INVALID_PUBLICATION',
      `Record ${entry.id} is invalid before publication.`,
    );
  }
  await dependencies(context, publicationPlan, true);
  await guardRecord(context, entry.id);
  assertRecordWritable(context, live);
  assertNotAborted(context.signal);
  await context.client.items.publish(entry.id, undefined, { recursive: false });
  context.mutations++;
  live = await rememberRecord(context, entry.id, { ...live, published });
  if (!equal(live.published, published))
    conflict('record', entry.id, 'published payload did not converge');
}

async function current(context: Context, entry: RecordPlan): Promise<void> {
  const desired = entry.desired!;
  await dependencies(context, entry, false);
  const live = await writeFields(context, entry, desired.current);
  const model = context.schema.models.find((m) => m.id === entry.modelId)!;
  const body: JsonObject = {};
  if (!equal(metadata(live), metadata(desired))) body.meta = metadata(desired);
  if (model.tree && live.parentId !== desired.parentId) {
    body.parent_id = desired.parentId;
    body.position = desired.position;
  }
  if ((model.tree || model.sortable) && live.position !== desired.position)
    body.position = desired.position;
  if (Object.keys(body).length) await updateRecord(context, entry, body);
}

async function guardCollection(
  context: Context,
  id: string,
): Promise<CollectionState | null> {
  // Collection endpoints have no version token, and a sandbox cannot be
  // frozen. Compare the complete captured state again before each write.
  assertNotAborted(context.signal);
  const resource = await findMaybe(() =>
    context.client.uploadCollections.find(id),
  );
  const live = resource ? canonicalCollection(resource) : null;
  if (
    (live?.hash ?? null) !==
    (context.store.getCollection('live', id)?.hash ?? null)
  )
    conflict('collection', id, 'changed before write');
  return live;
}

function* collectionSiblings(
  context: Context,
): Generator<{ state: CollectionState; position: number }> {
  const rows = context.store.database.prepare(
    "SELECT c.state_json,o.position FROM apply_collection_ordering o CROSS JOIN collections c ON c.side='live' AND c.id=o.id ORDER BY o.id",
  );
  for (const row of rows.iterate())
    yield {
      state: JSON.parse(row.state_json as string),
      position: Number(row.position),
    };
}

async function verifyCollectionSiblings(
  context: Context,
  after: boolean,
): Promise<void> {
  for (const batch of batches(collectionSiblings(context))) {
    assertNotAborted(context.signal);
    const ids = new Set(batch.map((row) => row.state.id));
    // The public collection endpoint supports filter.ids. Its unfiltered list
    // is unpaginated, so guard only the indexed native shift range in batches.
    const actual = new Map<string, CollectionState>();
    for (const raw of await context.client.uploadCollections.list({
      filter: { ids: [...ids].join(',') },
    })) {
      const state = canonicalCollection(raw);
      if (!ids.has(state.id) || actual.has(state.id))
        throw new ContentError(
          'INVALID_RESPONSE',
          'Collection ID filter returned an unexpected or duplicate identity.',
        );
      actual.set(state.id, state);
    }
    for (const row of batch) {
      if (!Number.isSafeInteger(row.position))
        throw new ContentError(
          'UNEXECUTABLE_COLLECTION_ORDERING',
          `Collection ${row.state.id} would exceed the supported integer position range.`,
        );
      const expected = after
        ? collectionHash({ ...row.state, position: row.position })
        : row.state.hash;
      const found = actual.get(row.state.id);
      if (!found || found.hash !== expected)
        conflict(
          'collection',
          row.state.id,
          after
            ? 'affected sibling changed during an ordering write'
            : 'affected sibling changed before an ordering write',
        );
      if (after) context.store.putCollection('live', found);
    }
  }
}

async function collectionOrderingBefore(
  context: Context,
  before: CollectionState,
  desired: CollectionState,
): Promise<void> {
  // DatoCMS has no persistent sandbox freeze, and collection writes have no
  // version token. Predict the native inclusive sibling shifts, guard that
  // bounded range immediately before the write, then verify its exact result.
  const db = context.store.database;
  db.exec('DELETE FROM apply_collection_ordering');
  const insert = (
    parentId: string | null,
    minimum: number,
    maximum: number | null,
    delta: number,
  ) => {
    db.prepare(
      `INSERT INTO apply_collection_ordering SELECT id,position+? FROM collections INDEXED BY collections_siblings WHERE side='live' AND parent_id IS ? AND position>=? ${
        maximum === null ? '' : 'AND position<=?'
      } AND id!=?`,
    ).run(
      delta,
      parentId,
      minimum,
      ...(maximum === null ? [] : [maximum]),
      before.id,
    );
  };
  if (before.parentId === desired.parentId)
    insert(
      before.parentId,
      Math.min(before.position, desired.position),
      Math.max(before.position, desired.position),
      desired.position < before.position ? 1 : -1,
    );
  else {
    insert(before.parentId, before.position, null, -1);
    insert(desired.parentId, desired.position, null, 1);
  }
  await verifyCollectionSiblings(context, false);
}

export async function writeCollection(
  context: Context,
  desired: CollectionState,
): Promise<void> {
  const before = await guardCollection(context, desired.id);
  if (before?.hash === desired.hash) return;
  if (desired.parentId && !(await guardCollection(context, desired.parentId)))
    conflict('collection', desired.id, 'parent collection is missing');
  const body = {
    label: desired.label,
    position: desired.position,
    parent: desired.parentId
      ? { id: desired.parentId, type: 'upload_collection' as const }
      : null,
  };
  if (!before) {
    // Native collection creation ignores a supplied position and appends.
    // Prove that allowed intermediate before asking the guarded update path
    // to move it to the intended index, including negative or sparse indexes.
    const last = context.store.database
      .prepare(
        "SELECT state_json FROM collections WHERE side='live' AND parent_id IS ? ORDER BY position DESC,id LIMIT 1",
      )
      .get(desired.parentId);
    const sibling = last
      ? (JSON.parse(String(last.state_json)) as CollectionState)
      : undefined;
    const appended = {
      ...desired,
      position: (sibling?.position ?? 0) + 1,
    };
    if (!Number.isSafeInteger(appended.position))
      throw new ContentError(
        'UNEXECUTABLE_COLLECTION_ORDERING',
        `Collection ${desired.id} cannot be appended within the supported integer position range.`,
      );
    appended.hash = collectionHash(appended);
    // A sandbox cannot be frozen. Check the observed append boundary and the
    // new identity immediately before creating; verify the response and then
    // a fresh read before that intermediate can become a trusted baseline.
    if (sibling) await guardCollection(context, sibling.id);
    await guardCollection(context, desired.id);
    assertNotAborted(context.signal);
    const created = canonicalCollection(
      await context.client.uploadCollections.create({
        id: desired.id,
        label: body.label,
        parent: body.parent,
      }),
    );
    context.mutations++;
    if (created.hash !== appended.hash)
      conflict(
        'collection',
        desired.id,
        'created collection differs from its expected append state',
      );
    const verified = canonicalCollection(
      await context.client.uploadCollections.find(desired.id),
    );
    if (verified.hash !== created.hash)
      conflict('collection', desired.id, 'collection changed after creation');
    context.store.putCollection('live', verified);
    await writeCollection(context, desired);
    return;
  }
  // Updating at the same position can shift duplicate peers, so every actual
  // update uses the native range prediction, including label-only writes.
  await collectionOrderingBefore(context, before, desired);
  await guardCollection(context, desired.id);
  assertNotAborted(context.signal);
  await context.client.uploadCollections.update(desired.id, body);
  context.mutations++;
  const verified = canonicalCollection(
    await context.client.uploadCollections.find(desired.id),
  );
  if (verified.hash !== desired.hash)
    conflict('collection', desired.id, 'collection did not converge');
  context.store.putCollection('live', verified);
  await verifyCollectionSiblings(context, true);
}

async function collection(
  context: Context,
  entry: CollectionPlan,
): Promise<void> {
  await writeCollection(context, entry.desired!);
}

async function reconcileCollectionOrdering(context: Context): Promise<void> {
  // Moving too-low indexes downward in descending desired order first leaves
  // every index at or above its target. Moving upward in ascending target order
  // then preserves already-fixed lower indexes, including sparse/negative gaps.
  // The planner simulates this same sequence for native duplicate-position cases.
  for (const descending of [true, false]) {
    const rows = context.store.database.prepare(
      `SELECT c.id,CASE WHEN p.action IN ('create','update') THEN json_extract(p.data,'$.desired.position') ELSE original.position END AS position FROM collections c LEFT JOIN plan p ON p.kind='collection' AND p.id=c.id LEFT JOIN apply_original_collections original ON original.id=c.id WHERE c.side='live' ORDER BY c.parent_id,position ${
        descending ? 'DESC' : 'ASC'
      },c.id`,
    );
    for (const row of rows.iterate()) {
      assertNotAborted(context.signal);
      const live = context.store.getCollection('live', String(row.id))!;
      const position = Number(row.position);
      if (descending ? live.position >= position : live.position <= position)
        continue;
      const desired = { ...live, position };
      desired.hash = collectionHash(desired);
      await writeCollection(context, desired);
    }
  }
}

async function upload(context: Context, entry: UploadPlan): Promise<void> {
  assertNotAborted(context.signal);
  const found = await findMaybe(() => context.client.uploads.find(entry.id));
  const expected = context.store.getUpload('live', entry.id);
  let live = found ? canonicalUpload(found) : null;
  if ((live?.hash ?? null) !== (expected?.hash ?? null))
    conflict('upload', entry.id, 'changed before write');
  const desired = entry.desired!;
  if (
    desired.collectionId &&
    !(await findMaybe(() =>
      context.client.uploadCollections.find(desired.collectionId!),
    ))
  ) {
    conflict('upload', entry.id, 'asset collection is missing');
  }
  if (!live || live.md5 !== desired.md5 || live.size !== desired.size) {
    if (!entry.binary)
      throw new ContentError(
        'MISSING_BINARY',
        `Upload ${entry.id} requires a bundled binary.`,
      );
    // The SDK performs its normal upload/job/retry handling. A globally unique
    // staging filename avoids the site-wide same-name upload request window.
    const staged = await stageBinary(
      context.bundlePath,
      context.store.directory,
      entry.binary,
      context.signal,
    );
    let path: string;
    try {
      assertNotAborted(context.signal);
      path = await CmaClient.uploadLocalFileAndReturnPath(
        context.client,
        staged,
        { filename: `${randomUUID()}-${desired.filename}` },
      );
    } finally {
      // The bundle retains the verified bytes. Remove each copy once its
      // upload settles, bounding staged disk use by the write concurrency.
      // A failed removal must not mask the upload result; disposal of the
      // working directory removes any remaining copy.
      await rm(staged, { force: true }).catch(() => undefined);
    }
    const beforeBinaryWrite = await findMaybe(() =>
      context.client.uploads.find(entry.id),
    );
    if (
      (beforeBinaryWrite ? canonicalUpload(beforeBinaryWrite).hash : null) !==
      (live?.hash ?? null)
    ) {
      conflict('upload', entry.id, 'changed while its binary was staged');
    }
    assertNotAborted(context.signal);
    let written: UploadState;
    if (live) {
      // keep_url can overwrite a file shared by other environments. Always
      // replace with a new isolated URL, preserving only the upload identity.
      written = canonicalUpload(
        await context.client.uploads.update(
          entry.id,
          { path },
          { replace_strategy: 'create_new_url' },
        ),
      );
    } else {
      written = canonicalUpload(
        await context.client.uploads.create({ id: entry.id, path }),
      );
    }
    context.mutations++;
    if (
      written.id !== entry.id ||
      written.md5 !== desired.md5 ||
      written.size !== desired.size
    )
      conflict('upload', entry.id, 'uploaded binary checksum differs');
    if (live) {
      if (written.collectionId !== live.collectionId)
        conflict(
          'upload',
          entry.id,
          'collection changed during binary replacement',
        );
      for (const key of [
        'tags',
        'default_field_metadata',
        'author',
        'copyright',
        'notes',
      ]) {
        const previous = live.attributes[key];
        // Native binary processing fills blank author/copyright/notes from
        // EXIF. It preserves existing nonblank values and all manual tags,
        // field metadata and collection membership. File-derived name/format
        // changes are intentionally checked later against desired metadata.
        const exifDefault =
          ['author', 'copyright', 'notes'].includes(key) &&
          (previous === null ||
            previous === undefined ||
            (typeof previous === 'string' && !previous.trim()));
        if (
          !exifDefault &&
          !equal(previous ?? null, written.attributes[key] ?? null)
        )
          conflict(
            'upload',
            entry.id,
            `${key} changed during binary replacement`,
          );
      }
    }
    // There is no persistent sandbox freeze: another writer can edit after
    // the SDK's mutation response. Trust only that controlled intermediate,
    // then verify a fresh read before letting the metadata phase overwrite it.
    const verifiedBinary = canonicalUpload(
      await context.client.uploads.find(entry.id),
    );
    if (verifiedBinary.hash !== written.hash)
      conflict('upload', entry.id, 'changed after the binary write response');
    live = verifiedBinary;
    context.store.putUpload('live', live);
  }
  const before = canonicalUpload(await context.client.uploads.find(entry.id));
  if (before.hash !== live.hash)
    conflict('upload', entry.id, 'changed before metadata write');
  assertNotAborted(context.signal);
  await context.client.uploads.update(entry.id, {
    ...desired.attributes,
    upload_collection: desired.collectionId
      ? { id: desired.collectionId, type: 'upload_collection' }
      : null,
  } as Parameters<Client['uploads']['update']>[1]);
  context.mutations++;
  const verified = canonicalUpload(await context.client.uploads.find(entry.id));
  if (verified.hash !== desired.hash)
    conflict('upload', entry.id, 'asset metadata did not converge');
  context.store.putUpload('live', verified);
}

function preserveBaseline(context: Context): void {
  context.store.database.exec(
    'CREATE TABLE apply_ordering(model_id TEXT,id TEXT PRIMARY KEY,parent_id TEXT,position REAL)',
  );
  // Drive sibling reads from the small affected range. Without this index and
  // explicit outer join order, SQLite can scan every live record per move.
  context.store.database.exec(
    'CREATE INDEX apply_ordering_model ON apply_ordering(model_id,id)',
  );
  context.store.database.exec(
    'CREATE TABLE apply_collection_ordering(id TEXT PRIMARY KEY,position INTEGER NOT NULL) WITHOUT ROWID',
  );
  context.store.database.exec(
    "CREATE TABLE apply_schedule_state AS SELECT id,json_extract(state_json,'$.schedules') AS schedules_json FROM records WHERE side='live'",
  );
  context.store.database.exec(
    'CREATE UNIQUE INDEX apply_schedule_state_id ON apply_schedule_state(id)',
  );
  context.store.database.exec(
    'ALTER TABLE apply_schedule_state ADD COLUMN touched INTEGER NOT NULL DEFAULT 0',
  );
  context.store.database.exec(
    'ALTER TABLE apply_schedule_state ADD COLUMN previous_schedules_json TEXT',
  );
  for (const table of ['records', 'uploads', 'collections']) {
    context.store.database.exec(
      `CREATE TABLE apply_original_${table} AS SELECT * FROM ${table} WHERE side='live'`,
    );
    context.store.database.exec(
      `CREATE UNIQUE INDEX apply_original_${table}_id ON apply_original_${table}(id)`,
    );
  }
}

function verifyForkBaseline(context: Context): void {
  for (const [kind, table] of [
    ['record', 'records'],
    ['upload', 'uploads'],
    ['collection', 'collections'],
  ] as const) {
    const changed = context.store.database
      .prepare(
        `SELECT live.id FROM ${table} live LEFT JOIN apply_original_${table} original ON original.id=live.id
       WHERE live.side='live' AND (original.id IS NULL OR original.hash!=live.hash${
         kind === 'record' ? ' OR original.position IS NOT live.position' : ''
       })
       UNION ALL SELECT original.id FROM apply_original_${table} original
       LEFT JOIN ${table} live ON live.side='live' AND live.id=original.id WHERE live.id IS NULL LIMIT 1`,
      )
      .get();
    if (changed)
      conflict(
        kind,
        String(changed.id),
        'destination changed while its fork was being created',
      );
  }
}

async function reconcileOrdering(context: Context): Promise<void> {
  const ordered = context.store.database.prepare(
    `SELECT r.state_json,p.data AS plan_data FROM records r
     LEFT JOIN plan p ON p.kind='record' AND p.id=r.id
     WHERE r.side='live' AND r.position IS NOT NULL
     ORDER BY r.model_id,
       COALESCE(json_extract(p.data,'$.desired.parentId'),r.parent_id),
       COALESCE(json_extract(p.data,'$.desired.position'),
         (SELECT o.position FROM apply_original_records o WHERE o.id=r.id)),r.id`,
  );
  for (const row of ordered.iterate()) {
    assertNotAborted(context.signal);
    const live = JSON.parse(row.state_json as string) as RecordState;
    const plan = row.plan_data
      ? (JSON.parse(row.plan_data as string) as RecordPlan)
      : undefined;
    const originalRow = context.store.database
      .prepare('SELECT state_json FROM apply_original_records WHERE id=?')
      .get(live.id);
    const desired =
      (plan?.action === 'create' || plan?.action === 'update'
        ? plan.desired
        : null) ??
      (originalRow
        ? (JSON.parse(originalRow.state_json as string) as RecordState)
        : undefined);
    if (!desired || desired.position === null) continue;
    if (context.store.getRecord('live', live.id)?.position === desired.position)
      continue;
    const actual = await guardRecord(context, live.id);
    if (actual?.position === desired.position) continue;
    const entry: RecordPlan = plan ?? {
      kind: 'record',
      id: live.id,
      modelId: live.modelId,
      action: 'noop',
      guard: recordGuard(live),
      safety: {
        currentReferences: [],
        publishedReferences: [],
        uploadReferences: [],
        blockIds: [],
        desiredParentId: desired.parentId,
        desiredPosition: desired.position,
      },
      diagnostics: [],
    };
    await updateRecord(context, entry, { position: desired.position });
  }
}

function validateBundlePreflight(context: Context): void {
  for (const order of [
    'createOrder',
    'updateOrder',
    'publishOrder',
    'deleteOrder',
  ]) {
    context.store.database.exec(
      `CREATE INDEX IF NOT EXISTS apply_record_${order} ON plan(kind,action,COALESCE(json_extract(data,'$.execution.${order}'),0),model_id,id)`,
    );
  }
  context.store.database.exec(
    "CREATE INDEX IF NOT EXISTS apply_plan_desired_parent ON plan(kind,json_extract(data,'$.desired.parentId'),action,id)",
  );
  for (const [kind, table] of [
    ['record', 'records'],
    ['upload', 'uploads'],
    ['collection', 'collections'],
  ] as const) {
    const unexpected = context.store.database
      .prepare(
        `SELECT live.id FROM ${table} live LEFT JOIN plan p ON p.kind=? AND p.id=live.id WHERE live.side='live' AND p.id IS NULL LIMIT 1`,
      )
      .get(kind);
    if (unexpected)
      conflict(
        kind,
        String(unexpected.id),
        'destination namespace gained an identity since bundle generation',
      );
  }
  context.store.database.exec(
    "CREATE INDEX IF NOT EXISTS apply_plan_baseline_parent ON plan(kind,json_extract(data,'$.baseline.parentId'),action,id)",
  );
  const reachableModels = new Set<string>();
  for (const entry of context.store.iteratePlan()) {
    assertNotAborted(context.signal);
    if (entry.kind === 'record')
      validateExecution({
        entry,
        store: context.store,
        schema: context.schema,
        changes: context.manifest.temporarySchemaChanges,
      });
    if (
      entry.kind === 'record' &&
      ['create', 'update', 'delete'].includes(entry.action) &&
      !managedRecord(context, entry)
    ) {
      throw new ContentError(
        'INVALID_BUNDLE',
        `Record ${entry.id} mutates a model outside the declared scope.`,
      );
    }
    const live =
      entry.kind === 'record'
        ? context.store.getRecord('live', entry.id)
        : entry.kind === 'upload'
          ? context.store.getUpload('live', entry.id)
          : context.store.getCollection('live', entry.id);
    if (entry.action === 'create') {
      if (live)
        conflict(entry.kind, entry.id, 'creation identity already exists');
    } else if (entry.action === 'skip' && !entry.guard && live) {
      conflict(
        entry.kind,
        entry.id,
        'skipped creation identity appeared since bundle generation',
      );
    } else if (
      entry.guard &&
      (!live ||
        (entry.kind === 'record'
          ? !guardsEqual(recordGuard(live as RecordState), entry.guard)
          : live.hash !== entry.guard.hash))
    ) {
      conflict(
        entry.kind,
        entry.id,
        'destination does not match the bundled baseline',
      );
    } else if (entry.action !== 'skip' && !entry.guard) {
      throw new ContentError(
        'INVALID_BUNDLE',
        `${entry.kind} ${entry.id} has no destination guard.`,
      );
    }
    if (
      entry.kind === 'record' &&
      entry.desired &&
      (entry.action === 'create' || entry.action === 'update')
    ) {
      if (
        managedRecord(context, entry) &&
        (entry.action === 'create' || entry.action === 'update')
      ) {
        reachableModels.add(entry.modelId);
        for (const owner of inspectRecord(entry.desired, context.schema)
          .blockOwners)
          reachableModels.add(owner.modelId);
      }
      futureSchedules(entry.id, entry.desired.schedules);
      const model = context.schema.models.find((m) => m.id === entry.modelId);
      if (!model || model.block)
        throw new ContentError(
          'INVALID_BUNDLE',
          `Unknown record model ${entry.modelId}.`,
        );
      if ((model.tree || model.sortable) && entry.desired.position === null) {
        throw new ContentError(
          'UNEXECUTABLE_ORDERING',
          `Ordered record ${entry.id} has no position.`,
        );
      }
      if (
        !model.draftMode &&
        !equal(entry.desired.current, entry.desired.published)
      ) {
        throw new ContentError(
          'UNEXECUTABLE_STATE',
          `Record ${entry.id} needs distinct publication state on a model without draft mode.`,
        );
      }
      if (entry.desired.published && !entry.desired.firstPublishedAt) {
        throw new ContentError(
          'UNEXECUTABLE_STATE',
          `Published record ${entry.id} has no first publication timestamp.`,
        );
      }
    }
  }
  for (const change of context.manifest.temporarySchemaChanges) {
    if (!reachableModels.has(change.modelId)) {
      throw new ContentError(
        'INVALID_BUNDLE',
        `Temporary field change ${change.fieldId} is unrelated to managed content transitions.`,
      );
    }
  }
  const collections = context.store.database
    .prepare(`WITH RECURSIVE ordered(id) AS (
    SELECT id FROM plan WHERE kind='collection' AND action IN ('create','update')
    AND (json_extract(data,'$.desired.parentId') IS NULL OR json_extract(data,'$.desired.parentId') NOT IN
      (SELECT id FROM plan WHERE kind='collection' AND action IN ('create','update')))
    UNION SELECT p.id FROM ordered o CROSS JOIN plan p INDEXED BY apply_plan_desired_parent ON json_extract(p.data,'$.desired.parentId')=+o.id
      WHERE p.kind='collection' AND p.action IN ('create','update'))
    SELECT (SELECT count(*) FROM plan WHERE kind='collection' AND action IN ('create','update')) AS total,
      (SELECT count(*) FROM ordered) AS ordered`)
    .get()!;
  if (collections.total !== collections.ordered) {
    throw new ContentError(
      'COLLECTION_CYCLE',
      'Asset collections cannot be created or moved in their planned parent order.',
    );
  }
  // Imported execution plans receive the same native ordering/label proof as
  // generated plans, using this run's fresh baseline and exact write order.
  for (const issue of collectionTransitionIssues({
    store: context.store,
    baselineSide: 'live',
    writes: orderedCollections(context, false),
    deletes: orderedCollections(context, true),
  }))
    throw new ContentError(issue.code, issue.message, { ...issue });
}

async function captureLive(
  context: Context,
  environmentId: string,
  verify = true,
): Promise<void> {
  assertNotAborted(context.signal);
  context.store.clearSide('live');
  await captureSnapshot({
    client: context.client,
    environmentId,
    schema: context.schema,
    store: context.store,
    side: 'live',
    options: {
      schemaProjection: context.schemaProjection,
      modelIds: context.schema.models
        .filter((model) => !model.block)
        .map((model) => model.id),
      uploads: 'all',
      concurrency: context.concurrency,
      signal: context.signal,
      progress: context.log,
    },
    // The consistency check only detects other writers; a locked environment
    // has none. By version, it rereads only records whose version changed.
    verify:
      verify && !context.locked
        ? context.verification === 'versions'
          ? 'versions'
          : true
        : false,
  });
}

function expectedFinal(entry: PlanEntry, schedules: boolean): string | null {
  if (entry.action === 'delete') return null;
  if (entry.action === 'skip' || entry.action === 'noop')
    return entry.guard?.hash ?? null;
  if (!entry.desired)
    throw new ContentError(
      'INVALID_BUNDLE',
      `${entry.kind} ${entry.id} has no desired state.`,
    );
  if (entry.kind === 'record' && !schedules) {
    return recordHash({ ...entry.desired!, schedules: emptySchedules });
  }
  return entry.desired.hash;
}

function verifyFinal(
  context: Context,
  schedules: boolean,
  kinds: Kind[] = ['record', 'upload', 'collection'],
): void {
  for (const entry of context.store.iteratePlan()) {
    assertNotAborted(context.signal);
    if (!kinds.includes(entry.kind)) continue;
    const state =
      entry.kind === 'record'
        ? context.store.getRecord('live', entry.id)
        : entry.kind === 'upload'
          ? context.store.getUpload('live', entry.id)
          : context.store.getCollection('live', entry.id);
    if ((state?.hash ?? null) !== expectedFinal(entry, schedules)) {
      conflict(
        entry.kind,
        entry.id,
        'final state differs from the reviewed bundle',
      );
    }
    if (entry.kind === 'record' && state) {
      const record = state as RecordState;
      const position =
        entry.action === 'create' || entry.action === 'update'
          ? entry.desired!.position
          : entry.guard?.position ?? null;
      if (record.position !== position)
        conflict(
          'record',
          entry.id,
          'final position differs from the reviewed bundle',
        );
      // Validity is a CMA-computed diagnostic. Restoring field settings queues
      // background validation, which can legitimately recompute grandfathered
      // flags on both managed and preserved records without changing content.
    }
  }
  for (const [kind, table] of [
    ['record', 'records'],
    ['upload', 'uploads'],
    ['collection', 'collections'],
  ] as const) {
    if (!kinds.includes(kind)) continue;
    const changed = context.store.database
      .prepare(
        `SELECT live.id FROM ${table} live LEFT JOIN plan p ON p.kind=? AND p.id=live.id
       LEFT JOIN apply_original_${table} original ON original.id=live.id
       WHERE live.side='live' AND p.id IS NULL AND (original.id IS NULL OR original.hash != live.hash${
         kind === 'record' ? ' OR original.position IS NOT live.position' : ''
       })
       UNION ALL
       SELECT original.id FROM apply_original_${table} original LEFT JOIN plan p ON p.kind=? AND p.id=original.id
       LEFT JOIN ${table} live ON live.side='live' AND live.id=original.id WHERE p.id IS NULL AND live.id IS NULL LIMIT 1`,
      )
      .get(kind, kind);
    if (changed)
      conflict(
        kind,
        String(changed.id),
        'preserved destination namespace changed',
      );
  }
}

async function temporarySchema(
  context: Context,
  restore: boolean,
): Promise<void> {
  for (const change of context.manifest.temporarySchemaChanges) {
    assertNotAborted(context.signal);
    const wanted = restore ? change.original : change.temporary;
    const before = await context.client.fields.find(change.fieldId);
    const allowed = restore ? change.temporary : change.original;
    if (
      !equal(before.validators, allowed.validators) ||
      !equal(before.default_value, allowed.defaultValue)
    ) {
      throw new ContentError(
        'SCHEMA_CONFLICT',
        `Field ${change.fieldId} changed before ${
          restore ? 'restoration' : 'temporary relaxation'
        }.`,
      );
    }
    assertNotAborted(context.signal);
    await context.client.fields.update(change.fieldId, {
      validators: wanted.validators,
      default_value: wanted.defaultValue,
    } as Parameters<Client['fields']['update']>[1]);
    context.mutations++;
    const after = await context.client.fields.find(change.fieldId);
    if (
      !equal(after.validators, wanted.validators) ||
      !equal(after.default_value, wanted.defaultValue)
    ) {
      throw new ContentError(
        'SCHEMA_RESTORE_FAILED',
        `Field ${change.fieldId} settings did not converge.`,
      );
    }
  }
}

/**
 * Replacing or renaming an upload makes DatoCMS rewrite its URL inside text
 * fields of other records in place, without a new record version. Such runs
 * need a full final reread.
 */
function rewritesAssetUrls(context: Context): boolean {
  return !!context.store.database
    .prepare(
      "SELECT 1 FROM plan WHERE kind='upload' AND action='update' AND (json_extract(data,'$.binary') IS NOT NULL OR json_extract(data,'$.desired.url') IS NOT json_extract(data,'$.baseline.url') OR json_extract(data,'$.desired.filename') IS NOT json_extract(data,'$.baseline.filename')) LIMIT 1",
    )
    .get();
}

function captureOptions(context: Context) {
  return {
    schemaProjection: context.schemaProjection,
    modelIds: context.schema.models
      .filter((model) => !model.block)
      .map((model) => model.id),
    uploads: 'all' as const,
    concurrency: context.concurrency,
    signal: context.signal,
    progress: context.log,
  };
}

// A fork whose background job died can stay "creating" indefinitely.
const FORK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Waits until DatoCMS has finished creating a fork requested without waiting.
 * DatoCMS deletes a fork that fails, so a missing fork means it failed.
 */
async function waitForFork(
  rootClient: Client,
  id: string,
  log?: ApplyOptions['log'],
  signal?: AbortSignal,
  timeout = FORK_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeout;
  for (let wait = 1000; ; wait = Math.min(wait * 2, 10_000)) {
    assertNotAborted(signal);
    const fork = await findMaybe(() => rootClient.environments.find(id));
    if (!fork)
      throw new ContentError(
        'FORK_FAILED',
        `DatoCMS could not create fork "${id}" and removed it.`,
      );
    if (fork.meta.status === 'ready') return fork;
    if (Date.now() >= deadline)
      throw new ContentError(
        'FORK_TIMEOUT',
        `Fork "${id}" was still being created after ${Math.round(
          timeout / 60_000,
        )} minutes.`,
      );
    if (fork.meta.status !== 'creating')
      throw new ContentError(
        'FORK_VERIFY_FAILED',
        `Fork "${id}" ended in status ${fork.meta.status}.`,
      );
    log?.(
      `Waiting for fork "${id}" (${
        fork.meta.fork_completion_percentage ?? 0
      }%).`,
    );
    try {
      await delay(wait, undefined, signal ? { signal } : undefined);
    } finally {
      assertNotAborted(signal);
    }
  }
}

/** Reads uploads and collections again and compares them with the live side. */
async function verifyAssets(context: Context, reason: string): Promise<void> {
  const assets = new SnapshotStore();
  try {
    await captureAssets({
      client: context.client,
      store: assets,
      side: 'live',
      options: captureOptions(context),
    });
    if (
      (await assetDigest(context.store, 'live', context.signal)) !==
      (await assetDigest(assets, 'live', context.signal))
    )
      conflict('collection', 'assets', reason);
  } finally {
    assets.dispose();
  }
}

/** Recheck a prepared destination capture without rereading every nested field. */
async function verifyPreparedBaseline(
  context: Context,
  environmentId: string,
): Promise<void> {
  const scan = 'prepared-baseline';
  const assertSchema = async () => {
    const schema = await fetchSchema(
      context.client,
      environmentId,
      context.schemaProjection,
    );
    if (
      schema.siteId !== context.schema.siteId ||
      schema.hash !== context.schema.hash
    )
      throw new ContentError(
        'SCHEMA_CONFLICT',
        'Destination schema changed after recording the migration.',
      );
  };
  try {
    // DatoCMS cannot persistently freeze a sandbox. A reused capture must be
    // revalidated after recording/planning and acquiring any available lock;
    // version matches are evidence of unchanged content, not an atomic snapshot.
    await assertSchema();
    await scanFingerprints({
      client: context.client,
      schema: context.schema,
      store: context.store,
      scan,
      options: captureOptions(context),
    });
    let matched = 0;
    for (const { id, fingerprint } of scannedFingerprints(
      context.store,
      scan,
    )) {
      assertNotAborted(context.signal);
      const expected = context.store.getRecord('live', id);
      if (!expected)
        conflict('record', id, 'destination gained a record after recording');
      if (stateFingerprint(expected) !== fingerprint)
        conflict(
          'record',
          id,
          'destination version or metadata changed after recording',
        );
      matched++;
    }
    const count = Number(
      context.store.database
        .prepare("SELECT COUNT(*) AS total FROM records WHERE side='live'")
        .get()!.total,
    );
    if (matched !== count) {
      const missing = context.store.database
        .prepare(`SELECT id FROM records r WHERE side='live' AND NOT EXISTS
        (SELECT 1 FROM scan_rows s WHERE s.scan=? AND s.slice='current' AND s.id=r.id) LIMIT 1`)
        .get(scan);
      conflict(
        'record',
        String(missing?.id ?? 'namespace'),
        'destination lost a record after recording',
      );
    }
    // Plain version listings expose schedule times but omit locale/field scope.
    // Read every originally scheduled record again, even if its time is equal.
    const scheduled = context.store.database.prepare(`SELECT id FROM records WHERE side='live' AND
      (json_extract(state_json,'$.schedules.publication') IS NOT NULL OR
       json_extract(state_json,'$.schedules.unpublishing') IS NOT NULL) ORDER BY id`);
    const ids = (function* () {
      for (const row of scheduled.iterate()) yield String(row.id);
    })();
    await boundedWork(
      batches(ids),
      context.concurrency,
      async (batch) => {
        const records = await readRecordBatch(
          context.client,
          batch,
          context.schema,
        );
        for (const id of batch) {
          assertNotAborted(context.signal);
          const current = records.find((record) => record.id === id);
          const expected = context.store.getRecord('live', id)!;
          if (
            !current ||
            !guardsEqual(recordGuard(current), recordGuard(expected))
          )
            conflict('record', id, 'scheduled content changed after recording');
        }
      },
      undefined,
      context.signal,
    );
    await verifyAssets(context, 'destination assets changed after recording');
    await assertSchema();
    assertNotAborted(context.signal);
  } finally {
    clearScan(context.store, scan);
  }
}

/**
 * The fork baseline without rereading every record. A fork keeps each record's
 * version, so records whose listed version matches the destination capture
 * hold the same content; any other record is read in full and compared, and
 * replaces the destination's state as the fork's live baseline.
 */
async function verifyForkByVersions(context: Context): Promise<void> {
  const scan = 'fork-baseline';
  try {
    await scanFingerprints({
      client: context.client,
      schema: context.schema,
      store: context.store,
      scan,
      options: captureOptions(context),
    });
    const { changed, missing, extra } = fingerprintDifferences(
      context.store,
      'live',
      scan,
    );
    const differing =
      missing ??
      extra ??
      (await contentDifferences(
        context.client,
        context.schema,
        changed,
        (id) => context.store.getRecord('live', id),
        captureOptions(context),
        (state) => context.store.putRecord('live', state),
      ));
    if (differing)
      conflict(
        'record',
        differing,
        'fork differs from the destination baseline',
      );
    await verifyAssets(context, 'fork assets differ from the destination');
  } finally {
    clearScan(context.store, scan);
  }
}

/**
 * Final verification without rereading untouched records. Records the run
 * wrote are read in full and compared with the bundle. Every other record must
 * still have its baseline version, or else its full content must still equal
 * the baseline; no record may appear or disappear unexpectedly. Uploads and
 * collections are reread in full.
 */
async function verifyFinalByVersions(
  context: Context,
  schedules: boolean,
): Promise<void> {
  const scan = 'final';
  const store = context.store;
  try {
    await scanFingerprints({
      client: context.client,
      schema: context.schema,
      store,
      scan,
      options: captureOptions(context),
    });
    const written = store.database
      .prepare(
        "SELECT id FROM plan WHERE kind='record' AND action IN ('create','update') ORDER BY id",
      )
      .all()
      .map((row) => String(row.id));
    for (const batch of batches(written)) {
      assertNotAborted(context.signal);
      const states = await readRecordBatch(
        context.client,
        batch,
        context.schema,
      );
      for (const id of batch) {
        const state = states.find((candidate) => candidate.id === id);
        if (!state) conflict('record', id, 'missing after writes');
        store.putRecord('live', state);
      }
    }
    const original = store.database.prepare(
      'SELECT state_json FROM apply_original_records WHERE id=?',
    );
    const originalState = (id: string) => {
      const row = original.get(id);
      return row
        ? (JSON.parse(String(row.state_json)) as RecordState)
        : undefined;
    };
    const changed: string[] = [];
    let listed = 0;
    for (const { id, fingerprint } of scannedFingerprints(store, scan)) {
      assertNotAborted(context.signal);
      listed++;
      const entry = store.getPlan('record', id) as RecordPlan | undefined;
      if (entry && (entry.action === 'create' || entry.action === 'update')) {
        if (stateFingerprint(store.getRecord('live', id)!) !== fingerprint)
          conflict('record', id, 'changed during final verification');
        continue;
      }
      if (entry?.action === 'delete')
        conflict('record', id, 'record remained after deletion');
      const baseline = originalState(id);
      if (!baseline || (entry?.action === 'skip' && !entry.guard))
        conflict(
          'record',
          id,
          'destination namespace gained an identity since bundle generation',
        );
      if (stateFingerprint(baseline) !== fingerprint) changed.push(id);
    }
    const expected = Number(
      store.database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM apply_original_records) - (SELECT COUNT(*) FROM plan WHERE kind='record' AND action='delete') + (SELECT COUNT(*) FROM plan WHERE kind='record' AND action='create') AS count",
        )
        .get()?.count ?? 0,
    );
    if (listed !== expected) {
      const absent = store.database
        .prepare(
          `SELECT o.id FROM apply_original_records o LEFT JOIN plan p ON p.kind='record' AND p.id=o.id
           WHERE (p.action IS NULL OR p.action<>'delete') AND NOT EXISTS(SELECT 1 FROM scan_rows s WHERE s.scan=? AND s.slice='current' AND s.id=o.id) LIMIT 1`,
        )
        .get(scan);
      conflict(
        'record',
        String(absent?.id ?? 'unknown'),
        'record disappeared from the destination',
      );
    }
    // A new version need not mean new content, as when renumbered siblings are
    // restored to their positions; compare such records in full.
    const differing = await contentDifferences(
      context.client,
      context.schema,
      changed,
      originalState,
      captureOptions(context),
      (state) => store.putRecord('live', state),
    );
    if (differing)
      conflict(
        'record',
        differing,
        store.getPlan('record', differing)
          ? 'final state differs from the reviewed bundle'
          : 'preserved destination namespace changed',
      );
    for (const entry of store.iteratePlan('record')) {
      if (entry.action !== 'create' && entry.action !== 'update') continue;
      const state = store.getRecord('live', entry.id)!;
      if (state.hash !== expectedFinal(entry, schedules))
        conflict(
          'record',
          entry.id,
          'final state differs from the reviewed bundle',
        );
      if (state.position !== (entry as RecordPlan).desired!.position)
        conflict(
          'record',
          entry.id,
          'final position differs from the reviewed bundle',
        );
    }
    for (const table of ['uploads', 'collections'])
      store.database.prepare(`DELETE FROM ${table} WHERE side='live'`).run();
    await captureAssets({
      client: context.client,
      store,
      side: 'live',
      options: captureOptions(context),
    });
    verifyFinal(context, schedules, ['upload', 'collection']);
  } finally {
    clearScan(store, scan);
  }
}

export async function applyBundle(args: {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  bundlePath: string;
  options: ApplyOptions;
  /** A freshly replanned TypeScript migration; no persisted execution progress. */
  prepared?: {
    metadata: PlanMetadata;
    entries: () => Iterable<PlanEntry>;
    snapshot?: {
      store: SnapshotStore;
      environmentId: string;
      schemaHash: string;
    };
    release?: () => void;
  };
}): Promise<ApplyOutcome> {
  const store = new SnapshotStore();
  let ownedFork: string | undefined;
  let forkRequested = false;
  let forkConfirmed = false;
  let forkCreatedAt: string | undefined;
  let context: Context | undefined;
  let changedSchema = false;
  let destinationLocked = false;
  let forkLocked = false;
  let startedWrites = false;
  let complete = false;
  let reusedSnapshot = false;
  const repairs: string[] = [];
  let repairFailureCount = 0;
  const recordRepairFailure = (message: string): void => {
    repairFailureCount++;
    if (repairs.length < 20) repairs.push(message);
  };
  try {
    assertNotAborted(args.options.signal);
    validateForkName(args.options);
    if (
      args.options.concurrency !== undefined &&
      (!Number.isSafeInteger(args.options.concurrency) ||
        args.options.concurrency < 1)
    ) {
      throw new ContentError(
        'INVALID_CONCURRENCY',
        'Apply concurrency must be a positive integer.',
      );
    }
    args.options.log?.(
      args.prepared
        ? 'Validating the rebuilt migration plan.'
        : 'Validating content bundle and asset checksums.',
    );
    const manifest: PlanMetadata = args.prepared
      ? args.prepared.metadata
      : await readBundle({
          directory: args.bundlePath,
          store,
          signal: args.options.signal,
        });
    const destinationId =
      args.options.destinationEnvironmentId ??
      manifest.destination.environmentId;
    if (args.prepared) {
      try {
        store.transaction(() => {
          for (const entry of args.prepared!.entries()) {
            assertNotAborted(args.options.signal);
            store.putPlan(entry);
          }
        });
        const snapshot = args.prepared.snapshot;
        if (
          snapshot &&
          (args.options.verification ?? 'versions') === 'versions'
        ) {
          if (
            snapshot.environmentId !== destinationId ||
            snapshot.schemaHash !== manifest.schema.hash
          )
            throw new ContentError(
              'DESTINATION_MISMATCH',
              'Prepared snapshot belongs to another environment or schema.',
            );
          // importSide closes the source database. Finish reading plan entries
          // first, copy the original target side, and only then release it.
          store.importSide(snapshot.store, 'target');
          store.transaction(() => {
            for (const table of [
              'records',
              'uploads',
              'collections',
              'refs',
              'block_owners',
              'unique_values',
            ])
              store.database.exec(
                `UPDATE ${table} SET side='live' WHERE side='target'`,
              );
          });
          reusedSnapshot = true;
        }
      } finally {
        args.prepared.release?.();
      }
    }
    assertNotAborted(args.options.signal);
    const targetClient = args.buildEnvironmentClient(destinationId);
    const [schema, rootSite] = await Promise.all([
      fetchSchema(targetClient, destinationId, args.options.schemaProjection),
      args.rootClient.site.find(),
    ]);
    // Bind the project before even a fork request. Profiles can be configured
    // for another site while retaining an identically named environment.
    if (
      schema.siteId !== manifest.destination.siteId ||
      rootSite.id !== manifest.destination.siteId ||
      schema.hash !== manifest.schema.hash
    ) {
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project or schema does not match the bundle.',
      );
    }
    if (
      manifest.temporarySchemaChanges.length &&
      !args.options.allowTemporarySchemaChanges
    ) {
      throw new ContentError(
        'TEMPORARY_SCHEMA_CHANGES_REQUIRED',
        'This bundle requires --allow-temporary-schema-changes.',
      );
    }
    if (manifest.temporarySchemaChanges.length)
      await assertSchemaEditAccess(targetClient);
    await assertApplyAccess(
      targetClient,
      schema,
      store,
      args.options.inPlace,
      manifest.options.modelIds,
    );
    const destination = await args.rootClient.environments.find(destinationId);
    if (
      destination.meta.read_only_mode ||
      destination.meta.status !== 'ready'
    ) {
      throw new ContentError(
        'DESTINATION_UNAVAILABLE',
        'Destination environment is not writable and ready.',
      );
    }
    if (
      args.options.inPlace &&
      destination.meta.primary &&
      !args.options.allowPrimary
    ) {
      throw new ContentError(
        'PRIMARY_REQUIRES_APPROVAL',
        'Applying in place to primary requires --allow-primary.',
      );
    }
    if (!args.options.inPlace) {
      const requestedName =
        args.options.forkName ?? `content-apply-${randomUUID()}`;
      if (
        await findMaybe(() => args.rootClient.environments.find(requestedName))
      )
        throw new ContentError(
          'FORK_ID_COLLISION',
          `Environment "${requestedName}" already exists. Choose another --fork-name.`,
        );
      if (!args.options.dryRun) ownedFork = requestedName;
    }
    if (!args.options.dryRun)
      destinationLocked = await lockEnvironment(targetClient, destinationId);
    context = {
      client: targetClient,
      store,
      manifest,
      schema,
      schemaProjection: args.options.schemaProjection,
      locked: destinationLocked,
      verification: args.options.verification ?? 'versions',
      bundlePath: args.bundlePath,
      concurrency: Math.max(
        1,
        Math.min(16, Math.floor(args.options.concurrency ?? 4)),
      ),
      mutations: 0,
      writesPlanned:
        manifest.temporarySchemaChanges.length > 0 ||
        !!store.database
          .prepare(
            "SELECT 1 FROM plan WHERE action IN ('create','update','delete') LIMIT 1",
          )
          .get(),
      signal: args.options.signal,
      log: args.options.log,
      progress: new ExecutionProgress(args.options.log),
    };
    // DatoCMS exposes no persistent sandbox freeze. Maintenance mode applies
    // only to primary and is not an immutable snapshot or a transaction. These
    // complete baseline and focused checks reduce races; apply is not atomic.
    let environmentId = destinationId;
    if (ownedFork) {
      forkRequested = true;
      assertNotAborted(context.signal);
      // DatoCMS copies the environment in the background. Request the fork
      // first so the copy overlaps the destination check below; the fork is
      // compared with the bundle and that check once both have finished.
      context.log?.(
        `Creating destination fork "${ownedFork}"${
          args.options.fastFork ? ' with a fast fork' : ''
        }.`,
      );
      const requested = await args.rootClient.environments.fork(
        destinationId,
        { id: ownedFork },
        {
          immediate_return: true,
          ...(args.options.fastFork ? { fast: true } : {}),
        },
      );
      if (
        requested.id !== ownedFork ||
        typeof requested.meta.created_at !== 'string' ||
        !Number.isFinite(Date.parse(requested.meta.created_at))
      )
        throw new ContentError(
          'FORK_VERIFY_FAILED',
          'DatoCMS did not confirm the requested fork identity and creation time.',
        );
      // A name can be claimed between the existence check and creation. A
      // rejected request proves no ownership, even if that same name now exists
      // and was forked from our destination. Never clean up that other run.
      forkConfirmed = true;
      forkCreatedAt = requested.meta.created_at;
    }
    context.log?.(`Verifying destination baseline in "${destinationId}".`);
    if (reusedSnapshot) await verifyPreparedBaseline(context, destinationId);
    else await captureLive(context, destinationId);
    validateBundlePreflight(context);
    if (context.writesPlanned)
      assertScheduleWindow(context, args.options.scheduleWindowMinutes ?? 120);
    if (args.options.dryRun) {
      assertNotAborted(context.signal);
      complete = true;
      return buildPlanPreview(store, manifest, destinationId);
    }
    preserveBaseline(context);
    if (ownedFork) {
      const fork = await waitForFork(
        args.rootClient,
        ownedFork,
        context.log,
        context.signal,
      );
      if (
        fork.id !== ownedFork ||
        fork.meta.read_only_mode ||
        fork.meta.primary ||
        fork.meta.forked_from !== destinationId ||
        fork.meta.created_at !== forkCreatedAt
      ) {
        throw new ContentError(
          'FORK_VERIFY_FAILED',
          'The owned fork is not a regular writable fork.',
        );
      }
      environmentId = ownedFork;
      context.client = args.buildEnvironmentClient(environmentId);
      forkLocked = await lockEnvironment(context.client, ownedFork);
      context.locked = forkLocked;
      context.schema = await fetchSchema(
        context.client,
        environmentId,
        context.schemaProjection,
      );
      await assertApplyAccess(
        context.client,
        context.schema,
        store,
        true,
        manifest.options.modelIds,
      );
      if (manifest.temporarySchemaChanges.length)
        await assertSchemaEditAccess(context.client);
      if (
        context.schema.siteId !== schema.siteId ||
        context.schema.hash !== schema.hash
      ) {
        throw new ContentError(
          'FORK_VERIFY_FAILED',
          'Fork project/schema differs from the bound destination.',
        );
      }
      context.log?.(`Verifying fork baseline in "${environmentId}".`);
      if (context.verification === 'versions' && !context.locked) {
        await verifyForkByVersions(context);
      } else {
        // One read suffices: it is compared with the bundle and the
        // destination, and anything written to the fork later fails the final
        // verification, which keeps its consistency check.
        await captureLive(context, environmentId, false);
        validateBundlePreflight(context);
        verifyForkBaseline(context);
      }
    }
    args.options.log?.(`Applying to ${environmentId}`);
    startedWrites = context.writesPlanned;
    if (context.writesPlanned)
      for (const entry of scheduledRecords(context, false))
        await cancelSchedules(context, entry.id);
    if (manifest.temporarySchemaChanges.length) {
      changedSchema = true;
      await temporarySchema(context, false);
    }
    // Collection parents first, from indexed recursive order rather than an
    // array of all collection payloads. CROSS JOIN fixes the recursive row as
    // the outer loop; unary + removes TEXT affinity without changing its ID,
    // allowing the JSON-parent expression index to seek each child's parent.
    for (const entry of orderedCollections(context, false)) {
      await collection(context, entry);
      context.progress?.completed(`${entry.action} asset folders`);
    }
    context.progress?.flush();
    await boundedWork(
      store.iteratePlan('upload'),
      context.concurrency,
      async (entry) => {
        if (entry.action === 'create' || entry.action === 'update') {
          await upload(context!, entry as UploadPlan);
          context!.progress?.completed(`${entry.action} assets`);
        }
      },
      undefined,
      context.signal,
    );
    context.progress?.flush();
    await recordPhase(context, ['create'], 'createOrder', 'creation', (entry) =>
      createRecord(context!, entry),
    );
    await recordPhase(
      context,
      ['create', 'update'],
      'publishOrder',
      'publication',
      (entry) => publication(context!, entry),
    );
    // Every record is now published as planned, except cycle members that were
    // published without their cycle links. Restore and republish those before
    // the current phase, which would otherwise be overwritten by this write.
    await recordPhase(
      context,
      ['create', 'update'],
      'publishOrder',
      'publication links',
      (entry) =>
        entry.execution?.provisionalPublished
          ? publication(context!, entry, true)
          : Promise.resolve(),
    );
    await recordPhase(
      context,
      ['create', 'update'],
      'updateOrder',
      'current state',
      (entry) => current(context!, entry),
    );
    await recordPhase(
      context,
      ['delete'],
      'deleteOrder',
      'deletion',
      async (entry) => {
        const ordering = await orderingBefore(context!, entry, null);
        await noReferrers(context!, entry, false);
        const live = await guardRecord(context!, entry.id);
        if (live) assertRecordWritable(context!, live);
        assertNotAborted(context!.signal);
        await context!.client.items.destroy(entry.id);
        context!.mutations++;
        if (await focusedRecord(context!, entry.id))
          conflict('record', entry.id, 'record remained after deletion');
        store.database
          .prepare("DELETE FROM records WHERE side='live' AND id=?")
          .run(entry.id);
        if (ordering) await orderingAfter(context!, entry);
      },
    );
    await reconcileOrdering(context);
    for (const entry of store.iteratePlan('upload', 'delete')) {
      assertNotAborted(context.signal);
      const expected = store.getUpload('live', entry.id);
      const live = canonicalUpload(await context.client.uploads.find(entry.id));
      if (live.hash !== expected?.hash)
        conflict('upload', entry.id, 'changed before deletion');
      if (
        (
          await context.client.uploads.references(entry.id, {
            version: 'published-or-current',
          })
        ).length
      )
        conflict('upload', entry.id, 'still has live referrers');
      assertNotAborted(context.signal);
      await context.client.uploads.destroy(entry.id);
      context.mutations++;
      if (await findMaybe(() => context!.client.uploads.find(entry.id)))
        conflict('upload', entry.id, 'asset remained after deletion');
      context.progress?.completed('delete assets');
    }
    // Collection deletion is child-first; uploads have already been moved or
    // removed. The CMA rejects any remaining dependency rather than cascading.
    for (const entry of orderedCollections(context, true)) {
      assertNotAborted(context.signal);
      const expected = store.getCollection('live', entry.id);
      const resource = await context.client.uploadCollections.find(entry.id);
      const live = canonicalCollection(resource);
      if (live.hash !== expected?.hash)
        conflict('collection', entry.id, 'changed before deletion');
      if (resource.children.length)
        conflict('collection', entry.id, 'still has child collections');
      const membership = await context.client.uploads.rawList({
        filter: { collection_id: { eq: entry.id } },
        page: { limit: 1 },
      });
      if (
        !Number.isSafeInteger(membership.meta.total_count) ||
        membership.meta.total_count < 0
      ) {
        throw new ContentError(
          'INVALID_RESPONSE',
          'Collection membership response has no authoritative total count.',
        );
      }
      if (membership.meta.total_count !== 0)
        conflict('collection', entry.id, 'still contains uploads');
      assertNotAborted(context.signal);
      await context.client.uploadCollections.destroy(entry.id);
      context.mutations++;
      if (
        await findMaybe(() => context!.client.uploadCollections.find(entry.id))
      )
        conflict('collection', entry.id, 'collection remained after deletion');
      store.database
        .prepare("DELETE FROM collections WHERE side='live' AND id=?")
        .run(entry.id);
      context.progress?.completed('delete asset folders');
    }
    context.progress?.flush();
    await reconcileCollectionOrdering(context);
    // Deletions and ordered writes can shift positions. Reconcile after them
    // and before the final full capture, preserving every managed and
    // untouched sibling. Without either, positions cannot have moved.
    const ordered = context.schema.models
      .filter((model) => model.sortable || model.tree)
      .map((model) => model.id);
    if (
      store.database
        .prepare(
          `SELECT 1 FROM plan WHERE kind='record' AND (action='delete' OR (action IN ('create','update') AND model_id IN (${ordered
            .map(() => '?')
            .join(',')}))) LIMIT 1`,
        )
        .get(...ordered)
    )
      await recordPhase(
        context,
        ['create', 'update'],
        'updateOrder',
        'ordering reconciliation',
        (entry) => current(context!, entry),
      );
    if (changedSchema) {
      await temporarySchema(context, true);
      changedSchema = false;
    }
    const finalSchema = await fetchSchema(
      context.client,
      environmentId,
      context.schemaProjection,
    );
    if (finalSchema.hash !== manifest.schema.hash)
      throw new ContentError(
        'SCHEMA_CONFLICT',
        'Final schema differs from the original schema.',
      );
    // Recheck the complete reviewed and preserved namespace after writes.
    // This detects observable concurrent edits; it does not make apply atomic.
    // In place, check the written content before arming schedules on it. A
    // fork that fails verification is deleted, so one final check suffices.
    if (context.verification === 'versions' && rewritesAssetUrls(context))
      context.verification = 'full';
    if (args.options.inPlace && !context.locked) {
      context.log?.('Verifying final content before restoring schedules.');
      if (context.verification === 'versions')
        await verifyFinalByVersions(context, !context.writesPlanned);
      else {
        await captureLive(context, environmentId);
        verifyFinal(context, !context.writesPlanned);
      }
    }
    // Schedules are recreated once every write is done and the original field
    // settings are back, so DatoCMS validates them under the final schema.
    if (context.writesPlanned)
      for (const entry of scheduledRecords(context, true))
        await restoreSchedules(context, entry.id, entry.desired!.schedules);
    // Schedules are writes too. Verify exact dates and all content again after
    // restoring them, using a second independently checked complete capture.
    context.log?.('Verifying final content and schedules.');
    if (context.verification === 'versions' && !context.locked)
      await verifyFinalByVersions(context, true);
    else {
      await captureLive(context, environmentId);
      verifyFinal(context, true);
    }
    assertNotAborted(context.signal);
    complete = true;
    return {
      environmentId,
      mutations: context.mutations,
      partial: [...Object.values(manifest.counts)].some(
        (counts) => counts.skip > 0,
      ),
    };
  } catch (error) {
    // Cancellation stops new work, then all already-submitted writes drain.
    // Repairs must run with the ordinary client and without that abort signal:
    // abandoning restoration would leave schedules or field settings changed.
    if (context) context.signal = undefined;
    if (context && changedSchema) {
      for (const change of context.manifest.temporarySchemaChanges) {
        try {
          const live = await context.client.fields.find(change.fieldId);
          if (
            equal(live.validators, change.original.validators) &&
            equal(live.default_value, change.original.defaultValue)
          )
            continue;
          if (
            !equal(live.validators, change.temporary.validators) ||
            !equal(live.default_value, change.temporary.defaultValue)
          )
            throw new Error('settings were changed concurrently');
          await context.client.fields.update(change.fieldId, {
            validators: change.original.validators,
            default_value: change.original.defaultValue,
          } as Parameters<Client['fields']['update']>[1]);
          const restored = await context.client.fields.find(change.fieldId);
          if (
            !equal(restored.validators, change.original.validators) ||
            !equal(restored.default_value, change.original.defaultValue)
          )
            throw new Error('original settings did not converge');
        } catch (repair) {
          recordRepairFailure(`Field ${change.fieldId}: ${String(repair)}`);
        }
      }
    }
    if (context && args.options.inPlace && startedWrites) {
      for (const row of store.database
        .prepare(
          'SELECT scheduled.id,original.state_json FROM apply_schedule_state scheduled LEFT JOIN apply_original_records original ON original.id=scheduled.id WHERE scheduled.touched=1',
        )
        .iterate()) {
        const original = row.state_json
          ? (JSON.parse(row.state_json as string) as RecordState)
          : { id: String(row.id), schedules: emptySchedules };
        const plan = store.getPlan('record', original.id);
        if (
          !plan ||
          plan.kind !== 'record' ||
          !managedRecord(context, plan) ||
          !['create', 'update', 'delete', 'noop'].includes(plan.action)
        )
          continue;
        try {
          const live = await focusedRecord(context, original.id);
          if (!live) {
            if (plan.action !== 'delete' && scheduled(original.schedules))
              throw new Error('record no longer exists');
            continue;
          }
          if (equal(live.schedules, original.schedules)) continue;
          // Restore an original schedule only on the original content. A record
          // this run created or already changed is left as it is and reported:
          // re-arming the old schedule could publish content nobody scheduled.
          if (!row.state_json)
            throw new Error(
              `was created by this run, so its schedules (${describeSchedules(
                live.schedules,
              )}) were left as they are`,
            );
          if (
            recordHash({ ...live, schedules: original.schedules }) !==
            recordHash(original as RecordState)
          )
            throw new Error(
              `content was changed by this run or another editor, so its schedules were left as they are (original: ${describeSchedules(
                original.schedules,
              )})`,
            );
          const expectedRow = store.database
            .prepare(
              'SELECT schedules_json,previous_schedules_json FROM apply_schedule_state WHERE id=?',
            )
            .get(original.id);
          if (
            !expectedRow ||
            (!equal(
              live.schedules,
              JSON.parse(expectedRow.schedules_json as string),
            ) &&
              (!expectedRow.previous_schedules_json ||
                !equal(
                  live.schedules,
                  JSON.parse(expectedRow.previous_schedules_json as string),
                )))
          ) {
            throw new Error('schedules changed concurrently');
          }
          // With no persistent sandbox freeze, a rejected request has two
          // legitimate observed outcomes: its exact prewrite or intended state.
          // Accept either only while that request is unverified; a third state
          // still belongs to a competing writer and must not be overwritten.
          store.putRecord('live', live);
          await cancelSchedules(context, original.id);
          await restoreSchedules(context, original.id, original.schedules);
        } catch (repair) {
          recordRepairFailure(`Schedules ${original.id}: ${String(repair)}`);
        }
      }
    }
    if (ownedFork && forkConfirmed && !args.options.keepFailedFork) {
      try {
        // A fork requested without waiting may still be copying; it can only
        // be deleted once DatoCMS has finished creating it.
        const settled = await waitForFork(
          args.rootClient,
          ownedFork,
          args.options.log,
          undefined,
          30 * 60 * 1000,
        ).catch((error: unknown) =>
          error instanceof ContentError && error.code === 'FORK_TIMEOUT'
            ? error
            : undefined,
        );
        if (settled instanceof ContentError)
          throw new Error(
            'the fork was still being created; delete it once DatoCMS finishes',
          );
        const fork = await findMaybe(() =>
          args.rootClient.environments.find(ownedFork!),
        );
        if (
          fork &&
          !fork.meta.primary &&
          fork.meta.created_at === forkCreatedAt &&
          fork.meta.forked_from ===
            (args.options.destinationEnvironmentId ??
              context?.manifest.destination.environmentId)
        ) {
          args.options.log?.(`Removing failed fork "${ownedFork}".`);
          await args.rootClient.environments.destroy(ownedFork);
          if (
            await findMaybe(() => args.rootClient.environments.find(ownedFork!))
          )
            throw new Error('failed fork still exists after deletion');
          args.options.log?.(`Removed failed fork "${ownedFork}".`);
        } else if (fork) {
          throw new Error(
            'fork ownership could not be proven; environment retained',
          );
        }
      } catch (repair) {
        recordRepairFailure(`Failed fork ${ownedFork}: ${String(repair)}`);
      }
    }
    if (ownedFork && forkRequested && !forkConfirmed) {
      args.options.log?.(
        `Fork request for "${ownedFork}" did not return confirmed ownership; no environment cleanup was attempted.`,
      );
      if (error instanceof Error)
        Object.assign(error, { unconfirmedForkEnvironmentId: ownedFork });
    }
    const failure = repairFailureCount
      ? new ContentError(
          'APPLY_FAILED_REPAIR_INCOMPLETE',
          `${
            error instanceof Error ? error.message : String(error)
          } Cleanup problems: ${repairFailureCount} repair ${
            repairFailureCount === 1 ? 'failure' : 'failures'
          }; showing ${repairs.length} ${
            repairs.length === 1 ? 'sample' : 'samples'
          }: ${repairs.join('; ')}`,
          {
            repairFailureCount,
            retainedRepairSamples: repairs.length,
            repairSamples: repairs,
          },
        )
      : error;
    // Progress output can be off (for example under --json), so a retained
    // fork is also named on the reported failure.
    if (
      ownedFork &&
      forkConfirmed &&
      args.options.keepFailedFork &&
      failure instanceof Error
    )
      Object.assign(failure, { keptForkEnvironmentId: ownedFork });
    throw failure;
  } finally {
    // Locks are released even when cleanup failed; a failed release must not
    // hide the run's own outcome.
    if (forkLocked && ownedFork)
      await unlockEnvironment(
        args.buildEnvironmentClient(ownedFork),
        ownedFork,
      ).catch(() => undefined);
    if (destinationLocked && context)
      await unlockEnvironment(
        args.buildEnvironmentClient(
          args.options.destinationEnvironmentId ??
            context.manifest.destination.environmentId,
        ),
        args.options.destinationEnvironmentId ??
          context.manifest.destination.environmentId,
      ).catch(() => undefined);
    // The bundle is an export and survives both success and failure. Only the
    // SQLite workspace owned by this execution is disposed here.
    store.dispose();
    context?.progress?.flush();
    if (!complete && ownedFork && forkConfirmed && args.options.keepFailedFork)
      args.options.log?.(`Kept failed fork ${ownedFork}`);
  }
}

const scheduled = (schedules: Schedules | undefined): boolean =>
  !!(schedules?.publication || schedules?.unpublishing);

/**
 * Puts back what an interrupted or killed in-place apply left behind: the
 * original field settings, and schedules that were cancelled but never
 * recreated. Nothing is resumed, and only the bundle and the live environment
 * are read. A record whose content is still the original gets its original
 * schedules back, one whose content matches the bundle gets the bundle's
 * schedules, and anything else is left as it is and reported.
 */
export async function repairBundle(args: {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  bundlePath: string;
  options: RepairOptions;
  prepared?: {
    metadata: PlanMetadata;
    entries: () => Iterable<PlanEntry>;
    release?: () => void;
  };
}): Promise<RepairResult> {
  const store = new SnapshotStore();
  const problems: string[] = [];
  let problemCount = 0;
  const problem = (message: string): void => {
    problemCount++;
    if (problems.length < 20) problems.push(message);
  };
  try {
    const { signal, log } = args.options;
    log?.(
      args.prepared
        ? 'Validating the reconstructed migration repair plan.'
        : 'Validating content bundle and asset checksums.',
    );
    const manifest: PlanMetadata = args.prepared
      ? args.prepared.metadata
      : await readBundle({ directory: args.bundlePath, store, signal });
    if (args.prepared) {
      try {
        store.transaction(() => {
          for (const entry of args.prepared!.entries()) {
            assertNotAborted(signal);
            store.putPlan(entry);
          }
        });
      } finally {
        args.prepared.release?.();
      }
    }
    const environmentId =
      args.options.destinationEnvironmentId ??
      manifest.destination.environmentId;
    const client = args.buildEnvironmentClient(environmentId);
    const [rootSite, environment] = await Promise.all([
      args.rootClient.site.find(),
      args.rootClient.environments.find(environmentId),
    ]);
    if (rootSite.id !== manifest.destination.siteId)
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project does not match the bundle.',
      );
    if (environment.meta.read_only_mode || environment.meta.status !== 'ready')
      throw new ContentError(
        'DESTINATION_UNAVAILABLE',
        'Destination environment is not writable and ready.',
      );
    if (environment.meta.primary && !args.options.allowPrimary)
      throw new ContentError(
        'PRIMARY_REQUIRES_APPROVAL',
        'Repairing primary requires --allow-primary.',
      );
    let restoredFields = 0;
    let restoredSchedules = 0;
    // Field settings first, so schedules are recreated under the original
    // rules, as a completed apply would.
    for (const change of manifest.temporarySchemaChanges) {
      assertNotAborted(signal);
      const live = await client.fields.find(change.fieldId);
      const matches = (settings: typeof change.original) =>
        equal(live.validators, settings.validators) &&
        equal(live.default_value, settings.defaultValue);
      if (matches(change.original)) continue;
      if (!matches(change.temporary)) {
        problem(
          `Field ${change.fieldId}: settings were changed by someone else; left as they are`,
        );
        continue;
      }
      log?.(`Restoring field ${change.fieldId} settings.`);
      await client.fields.update(change.fieldId, {
        validators: change.original.validators,
        default_value: change.original.defaultValue,
      } as Parameters<Client['fields']['update']>[1]);
      restoredFields++;
    }
    const schema = await fetchSchema(
      client,
      environmentId,
      args.options.schemaProjection,
    );
    if (schema.siteId !== manifest.destination.siteId)
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project does not match the bundle.',
      );
    if (schema.hash !== manifest.schema.hash) {
      problem('Schema differs from the bundle; schedules were not checked');
    } else {
      const context: Context = {
        client,
        store,
        manifest,
        schema,
        bundlePath: args.bundlePath,
        concurrency: 1,
        mutations: 0,
        writesPlanned: true,
        locked: false,
        verification: 'full',
        repairOnly: true,
        signal,
        log,
      };
      store.database.exec(
        'CREATE TABLE apply_schedule_state(id TEXT PRIMARY KEY,schedules_json TEXT,touched INTEGER NOT NULL DEFAULT 0,previous_schedules_json TEXT)',
      );
      // Only records an apply cancels or recreates schedules for.
      function* candidates(): Generator<string> {
        for (const entry of store.planEntries('record')) {
          if (entry.kind !== 'record' || !managedRecord(context, entry))
            continue;
          if (
            (['update', 'delete'].includes(entry.action) &&
              scheduled(entry.guard?.schedules)) ||
            (['create', 'update'].includes(entry.action) &&
              scheduled(entry.desired?.schedules))
          )
            yield entry.id;
        }
      }
      for (const batch of batches(candidates())) {
        assertNotAborted(signal);
        const states = await readRecordBatch(client, batch, schema);
        for (const id of batch) {
          const entry = store.getPlan('record', id) as RecordPlan;
          const live = states.find((state) => state.id === id);
          try {
            if (!live) {
              if (
                entry.action !== 'delete' &&
                scheduled(entry.guard?.schedules)
              )
                problem(`Record ${id} no longer exists`);
              continue;
            }
            const original =
              entry.guard &&
              recordHash({ ...live, schedules: entry.guard.schedules }) ===
                entry.guard.hash;
            const reviewed =
              entry.desired &&
              recordHash({ ...live, schedules: entry.desired.schedules }) ===
                entry.desired.hash;
            const wanted = original
              ? entry.guard!.schedules
              : reviewed
                ? entry.desired!.schedules
                : null;
            if (!wanted) {
              if (
                equal(
                  live.schedules,
                  entry.guard?.schedules ?? emptySchedules,
                ) ||
                (entry.desired &&
                  equal(live.schedules, entry.desired.schedules))
              )
                continue;
              problem(
                `Record ${id}: content matches neither the original nor the bundle, so its schedules were left as they are (original: ${describeSchedules(
                  entry.guard?.schedules ?? emptySchedules,
                )})`,
              );
              continue;
            }
            if (equal(live.schedules, wanted)) continue;
            if (scheduled(live.schedules)) {
              problem(
                `Record ${id} has schedules (${describeSchedules(
                  live.schedules,
                )}) that differ from the expected ones (${describeSchedules(
                  wanted,
                )}); left as they are`,
              );
              continue;
            }
            if (
              [wanted.publication, wanted.unpublishing].some(
                (schedule) => schedule && Date.parse(schedule.at) <= Date.now(),
              )
            ) {
              problem(
                `Record ${id}: its schedule (${describeSchedules(
                  wanted,
                )}) has already passed; publish or unpublish it manually`,
              );
              continue;
            }
            log?.(`Restoring schedules of record ${id}.`);
            store.putRecord('live', live);
            store.database
              .prepare(
                'INSERT OR REPLACE INTO apply_schedule_state(id,schedules_json) VALUES(?,?)',
              )
              .run(id, JSON.stringify(live.schedules));
            await restoreSchedules(context, id, wanted);
            restoredSchedules++;
          } catch (error) {
            if (error instanceof ContentError && error.code === 'INTERRUPTED')
              throw error;
            problem(`Schedules ${id}: ${String(error)}`);
          }
        }
      }
    }
    if (problemCount)
      throw new ContentError(
        'REPAIR_INCOMPLETE',
        `Restored ${restoredSchedules} schedules and ${restoredFields} field settings. ${problemCount} ${
          problemCount === 1 ? 'item needs' : 'items need'
        } attention; showing ${problems.length}: ${problems.join('; ')}`,
        { problemCount, problems, restoredSchedules, restoredFields },
      );
    return { environmentId, restoredSchedules, restoredFields };
  } finally {
    store.dispose();
  }
}
