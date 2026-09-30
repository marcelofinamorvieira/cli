import { randomUUID } from 'node:crypto';
import { CmaClient } from '@datocms/cli-utils';
import { stageBinary } from './apply-binary';
import { validateExecution } from './apply-validation';
import { batches, boundedWork } from './apply-work';
import { readBundle } from './bundle';
import { captureSnapshot, readRecordBatch } from './capture';
import {
  canonicalCollection,
  canonicalUpload,
  hashJson,
  inspectRecord,
  modelIndex,
  recordGuard,
  recordHash,
  recordPayloadFields,
} from './codec';
import { ContentError } from './errors';
import {
  assertApplyAccess,
  assertSchemaEditAccess,
  fetchSchema,
} from './schema';
import { SnapshotStore } from './store';
import type {
  ApplyOptions,
  ApplyResult,
  BundleManifest,
  Client,
  CollectionPlan,
  JsonObject,
  Kind,
  PlanEntry,
  RecordGuard,
  RecordPlan,
  RecordState,
  Schedules,
  SchemaState,
  UploadPlan,
} from './types';

const emptySchedules: Schedules = { publication: null, unpublishing: null };

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

interface Context {
  client: Client;
  store: SnapshotStore;
  manifest: BundleManifest;
  schema: SchemaState;
  bundlePath: string;
  concurrency: number;
  mutations: number;
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
  const rows = context.store.database.prepare(
    `SELECT data FROM plan WHERE kind='record' AND action IN (${actions
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
  const schedulePath = restore
    ? "CASE WHEN action='noop' THEN '$.guard.schedules' ELSE '$.desired.schedules' END"
    : "'$.guard.schedules'";
  const rows = context.store.database.prepare(`SELECT data FROM plan WHERE kind='record'
    AND action IN (${
      restore ? "'create','update','noop'" : "'update','delete','noop'"
    })
    AND (json_extract(data,(${schedulePath}) || '.publication') IS NOT NULL OR json_extract(data,(${schedulePath}) || '.unpublishing') IS NOT NULL)
    ORDER BY model_id,id`);
  for (const row of rows.iterate()) {
    const entry = JSON.parse(row.data as string) as RecordPlan;
    if (managedRecord(context, entry)) yield entry;
  }
}

async function recordPhase(
  context: Context,
  actions: string[],
  order: 'createOrder' | 'updateOrder' | 'publishOrder' | 'deleteOrder',
  work: (entry: RecordPlan) => Promise<void>,
): Promise<void> {
  const models = modelIndex(context.schema);
  const dependencyModelId = context.store.database.prepare(
    "SELECT model_id FROM records WHERE side='live' AND id=? UNION ALL SELECT model_id FROM plan WHERE kind='record' AND id=? LIMIT 1",
  );
  const ranks = context.store.database.prepare(
    `SELECT DISTINCT COALESCE(json_extract(data,'$.execution.${order}'),0) AS rank
     FROM plan WHERE kind='record' AND action IN (${actions
       .map(() => '?')
       .join(',')}) ORDER BY rank`,
  );
  for (const row of ranks.iterate(...actions)) {
    await boundedWork(
      records(context, actions, order, Number(row.rank)),
      context.concurrency,
      work,
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
    );
  }
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
): Promise<RecordState> {
  const record = await focusedRecord(context, id);
  if (!record) conflict('record', id, 'missing after a write');
  context.store.putRecord('live', record);
  context.store.database
    .prepare(
      'INSERT INTO apply_schedule_state(id,schedules_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET schedules_json=excluded.schedules_json',
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
    yield* ids;
    if (entry.safety.desiredParentId) yield entry.safety.desiredParentId;
  }
  for (const batch of batches(dependencyIds())) {
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
  if (refs.length) conflict('record', entry.id, 'still has live referrers');
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
    "SELECT r.state_json FROM apply_ordering o JOIN records r ON r.side='live' AND r.id=o.id WHERE o.model_id=? ORDER BY o.id",
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
): Promise<RecordState> {
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
  const live = await guardRecord(context, entry.id);
  if (!live) conflict('record', entry.id, 'missing before update');
  if (!live.currentVersion)
    throw new ContentError(
      'UNEXECUTABLE_STATE',
      `Record ${entry.id} has no optimistic locking version.`,
    );
  const meta = (body.meta ?? {}) as JsonObject;
  await context.client.items.update(entry.id, {
    ...body,
    meta: { ...meta, current_version: live.currentVersion },
  } as Parameters<Client['items']['update']>[1]);
  context.mutations++;
  const result = await rememberRecord(context, entry.id);
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
      'UPDATE apply_schedule_state SET touched=1,schedules_json=? WHERE id=?',
    )
    .run(JSON.stringify(schedules), id);
}

async function writeFields(
  context: Context,
  entry: RecordPlan,
  fields: JsonObject,
): Promise<void> {
  const live = await guardRecord(context, entry.id);
  if (!live) conflict('record', entry.id, 'missing before writing fields');
  if (equal(live.current, fields)) return;
  await updateRecord(
    context,
    entry,
    recordPayloadFields(fields, entry.modelId, context.schema),
  );
  const verified = context.store.getRecord('live', entry.id)!;
  if (!equal(verified.current, fields))
    conflict('record', entry.id, 'field payload did not converge');
}

async function cancelSchedules(context: Context, id: string): Promise<void> {
  const expectedSchedules = context.store.getRecord('live', id)?.schedules;
  if (!expectedSchedules?.publication && !expectedSchedules?.unpublishing)
    return;
  let live = await guardRecord(context, id);
  if (!live) return;
  if (live.schedules.publication) {
    intendSchedule(context, id, { ...live.schedules, publication: null });
    await context.client.scheduledPublication.destroy(id);
    context.mutations++;
    live = await rememberRecord(context, id);
    if (live.schedules.publication)
      conflict('record', id, 'publication schedule was not canceled');
  }
  if (live.schedules.unpublishing) {
    await guardRecord(context, id);
    intendSchedule(context, id, { ...live.schedules, unpublishing: null });
    await context.client.scheduledUnpublishing.destroy(id);
    context.mutations++;
    live = await rememberRecord(context, id);
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
  if (schedules.publication) {
    let live = await guardRecord(context, id);
    if (!live) conflict('record', id, 'missing before scheduling publication');
    const liveModelId = live.modelId;
    const model = context.schema.models.find(
      (candidate) => candidate.id === liveModelId,
    )!;
    const stampRequired =
      (model.saveInvalidDrafts ||
        context.schema.semantics.improved_validation_at_publishing === true) &&
      !(model.saveInvalidDrafts && schedules.publication.selective);
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
    intendSchedule(context, id, {
      ...current.schedules,
      publication: schedules.publication,
    });
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
    await rememberRecord(context, id);
  }
  if (schedules.unpublishing) {
    futureSchedules(id, schedules);
    await guardRecord(context, id);
    const current = context.store.getRecord('live', id)!;
    intendSchedule(context, id, {
      ...current.schedules,
      unpublishing: schedules.unpublishing,
    });
    await context.client.scheduledUnpublishing.create(id, {
      unpublishing_scheduled_at: schedules.unpublishing.at,
      content_in_locales: schedules.unpublishing.locales,
    });
    context.mutations++;
    await rememberRecord(context, id);
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
  const seedPlan = {
    ...entry,
    safety: {
      ...entry.safety,
      currentReferences: inspected.references
        .filter((r) => r.kind === 'current')
        .map((r) => r.targetId),
    },
  };
  await dependencies(context, seedPlan, false);
  const ordering = await orderingBefore(context, entry, {
    parentId: desired.parentId,
    position: desired.position,
  });
  await guardRecord(context, entry.id);
  const model = context.schema.models.find((m) => m.id === entry.modelId)!;
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
  const created = await rememberRecord(context, entry.id);
  if (!equal(created.current, fields))
    conflict('record', entry.id, 'creation seed did not converge');
  if (ordering) await orderingAfter(context, entry);
}

async function publication(context: Context, entry: RecordPlan): Promise<void> {
  const desired = entry.desired!;
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
  if (equal(live.published, desired.published)) return;
  if (!desired.published) {
    await noReferrers(context, entry, true);
    await guardRecord(context, entry.id);
    await context.client.items.unpublish(entry.id, undefined, {
      recursive: false,
    });
    context.mutations++;
    live = await rememberRecord(context, entry.id);
    if (live.published)
      conflict('record', entry.id, 'unpublishing did not converge');
    return;
  }
  await dependencies(context, entry, true);
  await writeFields(context, entry, desired.published);
  live = await guardRecord(context, entry.id);
  if (!live) conflict('record', entry.id, 'missing before publication');
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
  await dependencies(context, entry, true);
  await guardRecord(context, entry.id);
  await context.client.items.publish(entry.id, undefined, { recursive: false });
  context.mutations++;
  live = await rememberRecord(context, entry.id);
  if (!equal(live.published, desired.published))
    conflict('record', entry.id, 'published payload did not converge');
}

async function current(context: Context, entry: RecordPlan): Promise<void> {
  const desired = entry.desired!;
  await dependencies(context, entry, false);
  await writeFields(context, entry, desired.current);
  const live = await guardRecord(context, entry.id);
  if (!live)
    conflict('record', entry.id, 'missing before lifecycle reconciliation');
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

async function collection(
  context: Context,
  entry: CollectionPlan,
): Promise<void> {
  const found = await findMaybe(() =>
    context.client.uploadCollections.find(entry.id),
  );
  const expected = context.store.getCollection('live', entry.id);
  const live = found ? canonicalCollection(found) : null;
  if ((live?.hash ?? null) !== (expected?.hash ?? null))
    conflict('collection', entry.id, 'changed before write');
  const desired = entry.desired!;
  if (
    desired.parentId &&
    !(await findMaybe(() =>
      context.client.uploadCollections.find(desired.parentId!),
    ))
  ) {
    conflict('collection', entry.id, 'parent collection is missing');
  }
  const body = {
    label: desired.label,
    parent: desired.parentId
      ? { id: desired.parentId, type: 'upload_collection' as const }
      : null,
  };
  if (entry.action === 'create')
    await context.client.uploadCollections.create({ id: entry.id, ...body });
  else await context.client.uploadCollections.update(entry.id, body);
  context.mutations++;
  const verified = canonicalCollection(
    await context.client.uploadCollections.find(entry.id),
  );
  if (verified.hash !== desired.hash)
    conflict('collection', entry.id, 'collection did not converge');
  context.store.putCollection('live', verified);
}

async function upload(context: Context, entry: UploadPlan): Promise<void> {
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
    );
    const path = await CmaClient.uploadLocalFileAndReturnPath(
      context.client,
      staged,
      { filename: `${randomUUID()}-${desired.filename}` },
    );
    const beforeBinaryWrite = await findMaybe(() =>
      context.client.uploads.find(entry.id),
    );
    if (
      (beforeBinaryWrite ? canonicalUpload(beforeBinaryWrite).hash : null) !==
      (live?.hash ?? null)
    ) {
      conflict('upload', entry.id, 'changed while its binary was staged');
    }
    if (live) {
      // keep_url can overwrite a file shared by other environments. Always
      // replace with a new isolated URL, preserving only the upload identity.
      await context.client.uploads.update(
        entry.id,
        { path },
        { replace_strategy: 'create_new_url' },
      );
    } else {
      await context.client.uploads.create({ id: entry.id, path });
    }
    context.mutations++;
    live = canonicalUpload(await context.client.uploads.find(entry.id));
    context.store.putUpload('live', live);
    if (live.md5 !== desired.md5 || live.size !== desired.size)
      conflict('upload', entry.id, 'uploaded binary checksum differs');
  }
  const before = canonicalUpload(await context.client.uploads.find(entry.id));
  if (before.hash !== live.hash)
    conflict('upload', entry.id, 'changed before metadata write');
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
  context.store.database.exec(
    "CREATE TABLE apply_schedule_state AS SELECT id,json_extract(state_json,'$.schedules') AS schedules_json FROM records WHERE side='live'",
  );
  context.store.database.exec(
    'CREATE UNIQUE INDEX apply_schedule_state_id ON apply_schedule_state(id)',
  );
  context.store.database.exec(
    'ALTER TABLE apply_schedule_state ADD COLUMN touched INTEGER NOT NULL DEFAULT 0',
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
    if (
      entry.kind === 'record' &&
      entry.action === 'noop' &&
      managedRecord(context, entry) &&
      entry.guard
    )
      futureSchedules(entry.id, entry.guard.schedules);
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
    UNION SELECT p.id FROM plan p JOIN ordered o ON json_extract(p.data,'$.desired.parentId')=o.id
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
}

async function captureLive(
  context: Context,
  environmentId: string,
): Promise<void> {
  context.store.clearSide('live');
  await captureSnapshot({
    client: context.client,
    environmentId,
    schema: context.schema,
    store: context.store,
    side: 'live',
    options: {
      modelIds: context.schema.models
        .filter((model) => !model.block)
        .map((model) => model.id),
      uploads: 'all',
      concurrency: context.concurrency,
    },
    verify: true,
  });
}

function expectedFinal(
  context: Context,
  entry: PlanEntry,
  schedules: boolean,
): string | null {
  if (entry.action === 'delete') return null;
  if (
    entry.kind === 'record' &&
    entry.action === 'noop' &&
    managedRecord(context, entry) &&
    !schedules
  ) {
    const original = context.store.database
      .prepare('SELECT state_json FROM apply_original_records WHERE id=?')
      .get(entry.id);
    if (!original)
      conflict('record', entry.id, 'unchanged baseline record is missing');
    return recordHash({
      ...(JSON.parse(original.state_json as string) as RecordState),
      schedules: emptySchedules,
    });
  }
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

function verifyFinal(context: Context, schedules: boolean): void {
  for (const entry of context.store.iteratePlan()) {
    const state =
      entry.kind === 'record'
        ? context.store.getRecord('live', entry.id)
        : entry.kind === 'upload'
          ? context.store.getUpload('live', entry.id)
          : context.store.getCollection('live', entry.id);
    if ((state?.hash ?? null) !== expectedFinal(context, entry, schedules)) {
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

export async function applyBundle(args: {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  bundlePath: string;
  options: ApplyOptions;
}): Promise<ApplyResult> {
  const store = new SnapshotStore();
  let ownedFork: string | undefined;
  let forkRequested = false;
  let context: Context | undefined;
  let changedSchema = false;
  let startedWrites = false;
  let complete = false;
  const repairs: string[] = [];
  let repairFailureCount = 0;
  const recordRepairFailure = (message: string): void => {
    repairFailureCount++;
    if (repairs.length < 20) repairs.push(message);
  };
  try {
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
    const manifest = await readBundle({ directory: args.bundlePath, store });
    const destinationId =
      args.options.destinationEnvironmentId ??
      manifest.destination.environmentId;
    const targetClient = args.buildEnvironmentClient(destinationId);
    const [schema, rootSite] = await Promise.all([
      fetchSchema(targetClient, destinationId),
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
    context = {
      client: targetClient,
      store,
      manifest,
      schema,
      bundlePath: args.bundlePath,
      concurrency: Math.max(
        1,
        Math.min(16, Math.floor(args.options.concurrency ?? 4)),
      ),
      mutations: 0,
    };
    // DatoCMS exposes no persistent sandbox freeze. Maintenance mode applies
    // only to primary and is not an immutable snapshot or a transaction. These
    // complete baseline and focused checks reduce races; apply is not atomic.
    await captureLive(context, destinationId);
    validateBundlePreflight(context);
    preserveBaseline(context);
    let environmentId = destinationId;
    if (!args.options.inPlace) {
      ownedFork = `content-apply-${randomUUID()}`;
      if (
        await findMaybe(() => args.rootClient.environments.find(ownedFork!))
      ) {
        throw new ContentError(
          'FORK_ID_COLLISION',
          'Generated fork ID is already in use.',
        );
      }
      forkRequested = true;
      const fork = await args.rootClient.environments.fork(destinationId, {
        id: ownedFork,
      });
      if (fork.id !== ownedFork || fork.meta.read_only_mode) {
        throw new ContentError(
          'FORK_VERIFY_FAILED',
          'The owned fork is not a regular writable fork.',
        );
      }
      environmentId = ownedFork;
      context.client = args.buildEnvironmentClient(environmentId);
      context.schema = await fetchSchema(context.client, environmentId);
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
      await captureLive(context, environmentId);
      validateBundlePreflight(context);
      verifyForkBaseline(context);
    }
    args.options.log?.(`Applying to ${environmentId}`);
    startedWrites = true;
    for (const entry of scheduledRecords(context, false))
      await cancelSchedules(context, entry.id);
    if (manifest.temporarySchemaChanges.length) {
      changedSchema = true;
      await temporarySchema(context, false);
    }
    // Collection parents first, from indexed recursive order rather than an
    // array of all collection payloads.
    const collections = store.database.prepare(
      `WITH RECURSIVE ordered(id,depth) AS (
       SELECT id,0 FROM plan WHERE kind='collection' AND action IN ('create','update')
       AND (json_extract(data,'$.desired.parentId') IS NULL OR json_extract(data,'$.desired.parentId') NOT IN (SELECT id FROM plan WHERE kind='collection' AND action IN ('create','update')))
       UNION ALL SELECT p.id,o.depth+1 FROM plan p JOIN ordered o ON json_extract(p.data,'$.desired.parentId')=o.id WHERE p.kind='collection' AND p.action IN ('create','update'))
       SELECT p.data FROM plan p JOIN ordered o ON p.id=o.id WHERE p.kind='collection' ORDER BY o.depth,p.id`,
    );
    for (const row of collections.iterate())
      await collection(context, JSON.parse(row.data as string));
    await boundedWork(
      store.iteratePlan('upload'),
      context.concurrency,
      async (entry) => {
        if (entry.action === 'create' || entry.action === 'update')
          await upload(context!, entry as UploadPlan);
      },
    );
    await recordPhase(context, ['create'], 'createOrder', (entry) =>
      createRecord(context!, entry),
    );
    await recordPhase(context, ['create', 'update'], 'publishOrder', (entry) =>
      publication(context!, entry),
    );
    await recordPhase(context, ['create', 'update'], 'updateOrder', (entry) =>
      current(context!, entry),
    );
    await recordPhase(context, ['delete'], 'deleteOrder', async (entry) => {
      const ordering = await orderingBefore(context!, entry, null);
      await noReferrers(context!, entry, false);
      await guardRecord(context!, entry.id);
      await context!.client.items.destroy(entry.id);
      context!.mutations++;
      if (await focusedRecord(context!, entry.id))
        conflict('record', entry.id, 'record remained after deletion');
      store.database
        .prepare("DELETE FROM records WHERE side='live' AND id=?")
        .run(entry.id);
      if (ordering) await orderingAfter(context!, entry);
    });
    await reconcileOrdering(context);
    for (const entry of store.iteratePlan('upload', 'delete')) {
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
      await context.client.uploads.destroy(entry.id);
      context.mutations++;
    }
    // Collection deletion is child-first; uploads have already been moved or
    // removed. The CMA rejects any remaining dependency rather than cascading.
    const collectionDeletes = store.database.prepare(`WITH RECURSIVE ordered(id,depth) AS (
      SELECT id,0 FROM plan WHERE kind='collection' AND action='delete'
      AND (json_extract(data,'$.baseline.parentId') IS NULL OR json_extract(data,'$.baseline.parentId') NOT IN (SELECT id FROM plan WHERE kind='collection' AND action='delete'))
      UNION ALL SELECT p.id,o.depth+1 FROM plan p JOIN ordered o ON json_extract(p.data,'$.baseline.parentId')=o.id WHERE p.kind='collection' AND p.action='delete')
      SELECT p.data FROM plan p JOIN ordered o ON p.id=o.id WHERE p.kind='collection' ORDER BY o.depth DESC,p.id`);
    for (const row of collectionDeletes.iterate()) {
      const entry = JSON.parse(row.data as string) as CollectionPlan;
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
      await context.client.uploadCollections.destroy(entry.id);
      context.mutations++;
    }
    // Deletions can shift positions. Reconcile after them and before the final
    // full capture, preserving every managed and untouched sibling.
    await recordPhase(context, ['create', 'update'], 'updateOrder', (entry) =>
      current(context!, entry),
    );
    if (changedSchema) {
      await temporarySchema(context, true);
      changedSchema = false;
    }
    const finalSchema = await fetchSchema(context.client, environmentId);
    if (finalSchema.hash !== manifest.schema.hash)
      throw new ContentError(
        'SCHEMA_CONFLICT',
        'Final schema differs from the original schema.',
      );
    // Recheck the complete reviewed and preserved namespace after writes.
    // This detects observable concurrent edits; it does not make apply atomic.
    await captureLive(context, environmentId);
    verifyFinal(context, false);
    for (const entry of scheduledRecords(context, true))
      await restoreSchedules(
        context,
        entry.id,
        entry.action === 'noop'
          ? entry.guard!.schedules
          : entry.desired!.schedules,
      );
    // Schedules are writes too. Verify exact dates and all content again after
    // restoring them, using a second independently checked complete capture.
    await captureLive(context, environmentId);
    verifyFinal(context, true);
    complete = true;
    return {
      environmentId,
      mutations: context.mutations,
      partial: [...Object.values(manifest.counts)].some(
        (counts) => counts.skip > 0,
      ),
    };
  } catch (error) {
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
            if (
              original.schedules.publication ||
              original.schedules.unpublishing
            )
              throw new Error('record no longer exists');
            continue;
          }
          if (equal(live.schedules, original.schedules)) continue;
          const expectedRow = store.database
            .prepare(
              'SELECT schedules_json FROM apply_schedule_state WHERE id=?',
            )
            .get(original.id);
          if (
            !expectedRow ||
            !equal(
              live.schedules,
              JSON.parse(expectedRow.schedules_json as string),
            )
          ) {
            throw new Error('schedules changed concurrently');
          }
          store.putRecord('live', live);
          await cancelSchedules(context, original.id);
          await restoreSchedules(context, original.id, original.schedules);
        } catch (repair) {
          recordRepairFailure(`Schedules ${original.id}: ${String(repair)}`);
        }
      }
    }
    if (ownedFork && forkRequested && !args.options.keepFailedFork) {
      try {
        const fork = await findMaybe(() =>
          args.rootClient.environments.find(ownedFork!),
        );
        if (
          fork &&
          fork.meta.forked_from ===
            (args.options.destinationEnvironmentId ??
              context?.manifest.destination.environmentId)
        ) {
          await args.rootClient.environments.destroy(ownedFork);
          if (
            await findMaybe(() => args.rootClient.environments.find(ownedFork!))
          )
            throw new Error('failed fork still exists after deletion');
        } else if (fork) {
          throw new Error(
            'fork ownership could not be proven; environment retained',
          );
        }
      } catch (repair) {
        recordRepairFailure(`Failed fork ${ownedFork}: ${String(repair)}`);
      }
    }
    if (repairFailureCount)
      throw new ContentError(
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
      );
    throw error;
  } finally {
    // The bundle is an export and survives both success and failure. Only the
    // SQLite workspace owned by this execution is disposed here.
    store.dispose();
    if (!complete && ownedFork && forkRequested && args.options.keepFailedFork)
      args.options.log?.(`Kept failed fork ${ownedFork}`);
  }
}
