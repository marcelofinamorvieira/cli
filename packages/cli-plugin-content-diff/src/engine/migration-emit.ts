import {
  hashJson,
  object,
  recordPayloadFields,
  recordUpdatePayloadFields,
} from './codec';
import { compareIds } from './compare-ids';
import { orderedCollectionWrites } from './planner';
import type { SnapshotStore } from './store';
import type {
  CollectionPlan,
  CollectionState,
  JsonObject,
  PlanMetadata,
  RecordPlan,
  RecordState,
  Schedules,
  UploadPlan,
} from './types';

type Literal = (value: unknown) => string;
interface MigrationScriptWriter {
  /** Add one operation; `runtime` names the runtime helpers it calls. */
  add(code: string, runtime?: string[]): Promise<void>;
}

/** A line comment ends at any line terminator; keep labels on one short line. */
function commentText(value: string): string {
  const short = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return short.replace(/[\r\n\u2028\u2029]+/g, ' ');
}
const quoted = (value: string) => `"${commentText(value)}"`;
const operation = (comment: string, code: string) =>
  `  // ${comment}\n${code}\n`;
const folderRef = (id: string | null) =>
  id ? { id, type: 'upload_collection' } : null;

/**
 * Names a record by the title it has once the call has run (`current`), so
 * a write is labeled with the title it writes.
 */
export function recordSubject(
  entry: Pick<RecordPlan, 'id' | 'modelId'>,
  schema: PlanMetadata['schema'],
  current: JsonObject | undefined,
) {
  const model = schema.models.find((model) => model.id === entry.modelId);
  let title: string | undefined;
  for (const key of ['title', 'name']) {
    const field = model?.fields.find(
      (field) => field.apiKey === key && field.type === 'string',
    );
    if (!field) continue;
    const value = current?.[key];
    if (typeof value === 'string') title = value;
    else if (field.localized && object(value))
      for (const locale of schema.locales) {
        if (typeof value[locale] === 'string' && value[locale]) {
          title = value[locale];
          break;
        }
      }
    if (title) break;
  }
  return `${commentText(model?.name ?? 'record')}${
    title ? ` ${quoted(title)}` : ''
  } (${commentText(entry.id)})`;
}
function patch(before: JsonObject | null, after: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) =>
        !before ||
        !Object.hasOwn(before, key) ||
        hashJson(before[key]) !== hashJson(value),
    ),
  );
}

/**
 * The stored file of a source asset. Default image optimizations and SVG
 * sanitizing would otherwise serve bytes that differ from the upload, and
 * the generated code checks the MD5 of what it uploads.
 */
function originalFileUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('skip-default-optimizations', 'true');
  parsed.searchParams.set('svg-sanitize', 'false');
  return parsed.toString();
}

/** Compile the planner's intermediate states and phase order into real CMA calls. */
export async function emitMigrationCalls(
  store: SnapshotStore,
  metadata: PlanMetadata,
  writer: MigrationScriptWriter,
  literal: Literal,
): Promise<void> {
  const db = store.database;
  const { schema } = metadata;
  const models = new Map(schema.models.map((model) => [model.id, model]));
  const call = (method: string, ...args: unknown[]) =>
    `  await client.${method}(${args
      .map((arg) => (arg === undefined ? 'undefined' : literal(arg)))
      .join(', ')});\n`;
  // Each record's state as the script leaves it so far, and whether the
  // script has already written it (only the first write can be locked to the
  // baseline version).
  db.exec(`CREATE TEMP TABLE migration_emit_record_state(id TEXT PRIMARY KEY,state_json TEXT NOT NULL,written INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
 INSERT INTO migration_emit_record_state(id,state_json) SELECT r.id,r.state_json FROM records r JOIN plan p ON p.kind='record' AND p.id=r.id AND p.action='update' WHERE r.side='target';`);
  for (const order of ['createOrder', 'publishOrder', 'deleteOrder'])
    db.exec(
      `CREATE INDEX IF NOT EXISTS migration_emit_${order} ON plan(kind,COALESCE(json_extract(data,'$.execution.${order}'),0),model_id,id)`,
    );
  const read = db.prepare(
    'SELECT state_json,written FROM migration_emit_record_state WHERE id=?',
  );
  const put = db.prepare(
    'INSERT INTO migration_emit_record_state(id,state_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json',
  );
  const markWritten = db.prepare(
    'UPDATE migration_emit_record_state SET written=1 WHERE id=?',
  );
  // A record leaving its sibling group closes the gap it leaves, and the CMA
  // may give each sibling it renumbers a new version, so their first update
  // cannot be locked to the baseline version.
  const markRenumbered = db.prepare(
    "UPDATE migration_emit_record_state SET written=1 WHERE json_extract(state_json,'$.modelId')=? AND json_extract(state_json,'$.parentId') IS ? AND json_extract(state_json,'$.position')>?",
  );
  const leaveGroup = (live: RecordState) =>
    markRenumbered.run(live.modelId, live.parentId, live.position);
  const state = (id: string): RecordState =>
    JSON.parse(String(read.get(id)!.state_json));
  const save = (value: RecordState) => put.run(value.id, JSON.stringify(value));
  function* records(
    actions: readonly string[],
    order?: string,
    tieBreak = '',
  ): Generator<RecordPlan> {
    for (const row of db
      .prepare(
        `SELECT data FROM plan WHERE kind='record' AND action IN (${actions
          .map(() => '?')
          .join(',')}) ORDER BY ${
          order ? `COALESCE(json_extract(data,'$.execution.${order}'),0),` : ''
        }model_id,${tieBreak}id`,
      )
      .iterate(...actions))
      yield JSON.parse(String(row.data));
  }
  const subject = (entry: RecordPlan, written?: JsonObject) => {
    const row = read.get(entry.id);
    return recordSubject(
      entry,
      schema,
      written ??
        (row
          ? (JSON.parse(String(row.state_json)) as RecordState).current
          : entry.baseline?.current),
    );
  };
  /**
   * `written` is the record's current state once an update has run;
   * `detail` follows the record in the comment.
   */
  const write = async (
    entry: RecordPlan,
    action: string,
    code: string,
    written?: JsonObject,
    detail = '',
  ) => {
    const label = subject(entry, written);
    markWritten.run(entry.id);
    await writer.add(operation(`${action} ${label}${detail}`, code));
  };
  // The first write to an existing record is an update locked to the version
  // the baseline recorded, so a concurrent edit fails the update instead of
  // being overwritten. Later writes follow the script's own earlier writes.
  const update = async (
    entry: RecordPlan,
    body: JsonObject,
    action: string,
    written: JsonObject,
    detail?: string,
  ) => {
    if (!Object.keys(body).length) return;
    const version =
      !read.get(entry.id)!.written && entry.baseline?.currentVersion;
    await write(
      entry,
      action,
      call(
        'items.update',
        entry.id,
        version
          ? {
              ...body,
              meta: {
                ...(object(body.meta) ? body.meta : {}),
                current_version: version,
              },
            }
          : body,
      ),
      written,
      detail,
    );
  };
  // A tree parent as the script leaves it so far: its state once written,
  // its baseline otherwise.
  const parentLabel = (modelId: string, parentId: string | null) => {
    if (!parentId) return ' to the top level';
    const row = read.get(parentId);
    const parent = row
      ? (JSON.parse(String(row.state_json)) as RecordState)
      : store.getRecord('target', parentId);
    return ` under ${recordSubject(
      { id: parentId, modelId },
      schema,
      parent?.current,
    )}`;
  };
  // The update that brings a record's draft fields and metadata to their
  // desired state. A field update gives a published draft-mode record a new
  // current version, which leaves it with unpublished changes, so that
  // version is published again when the source record has none.
  const draftUpdate = (entry: RecordPlan, live: RecordState) => {
    const desired = entry.desired!;
    const body = recordUpdatePayloadFields(
      live.current,
      desired.current,
      entry.modelId,
      schema,
    );
    const republish =
      Object.keys(body).length > 0 &&
      models.get(entry.modelId)!.draftMode &&
      !!desired.published &&
      hashJson(desired.current) === hashJson(desired.published);
    const meta: JsonObject = {};
    for (const [key, value, previous] of [
      ['created_at', desired.createdAt, live.createdAt],
      ['first_published_at', desired.firstPublishedAt, live.firstPublishedAt],
      ['stage', desired.stage, live.stage],
    ] as const)
      if (value !== previous) meta[key] = value;
    if (Object.keys(meta).length) body.meta = meta;
    return { body, republish };
  };
  // A tree record that changes parent. Moves run in publication order, so a
  // record sits under its new parent before it is published there and has
  // left a parent before that parent is unpublished.
  const moves = (entry: RecordPlan) =>
    models.get(entry.modelId)!.tree &&
    state(entry.id).parentId !== entry.desired!.parentId;
  const move = async (entry: RecordPlan) => {
    const live = state(entry.id);
    const desired = entry.desired!;
    const { parentId } = desired;
    leaveGroup(live);
    // A record whose publication is settled takes its draft changes along,
    // unless the update phase would publish them again afterwards.
    const draft = draftUpdate(entry, live);
    if (
      Object.keys(draft.body).length &&
      !draft.republish &&
      !entry.execution?.provisionalPublished
    ) {
      await update(
        entry,
        { ...draft.body, parent_id: parentId },
        'Update',
        desired.current,
      );
      save({
        ...live,
        parentId,
        current: desired.current,
        createdAt: desired.createdAt,
        firstPublishedAt: desired.firstPublishedAt,
        stage: desired.stage,
      });
      return;
    }
    await update(
      entry,
      { parent_id: parentId },
      'Move',
      live.current,
      parentLabel(entry.modelId, parentId),
    );
    save({ ...live, parentId });
  };
  // Writes the fields a publication needs, and the record's move. Like a
  // create, this write carries the first publication date, which publishing
  // keeps.
  const writeFields = async (
    entry: RecordPlan,
    fields: JsonObject,
    action: string,
  ) => {
    const live = state(entry.id);
    const body = recordUpdatePayloadFields(
      live.current,
      fields,
      entry.modelId,
      schema,
    );
    if (moves(entry)) {
      leaveGroup(live);
      body.parent_id = entry.desired!.parentId;
      live.parentId = entry.desired!.parentId;
    }
    const { firstPublishedAt } = entry.desired!;
    if (live.firstPublishedAt !== firstPublishedAt) {
      body.meta = { first_published_at: firstPublishedAt };
      live.firstPublishedAt = firstPublishedAt;
    }
    await update(entry, body, action, fields);
    live.current = fields;
    if (!models.get(entry.modelId)!.draftMode) live.published = fields;
    save(live);
  };
  try {
    // Folders: parents first in the final tree; positions follow at the end.
    for (const entry of orderedCollectionWrites(store)) {
      const desired = entry.desired!;
      const subject = `folder ${quoted(desired.label)} (${commentText(
        entry.id,
      )})`;
      if (entry.action === 'create') {
        await writer.add(
          operation(
            `Create ${subject}`,
            call('uploadCollections.create', {
              id: entry.id,
              label: desired.label,
              parent: folderRef(desired.parentId),
            }),
          ),
        );
        continue;
      }
      const body: JsonObject = {};
      if (entry.baseline?.label !== desired.label) body.label = desired.label;
      if (entry.baseline?.parentId !== desired.parentId)
        body.parent = folderRef(desired.parentId);
      if (Object.keys(body).length)
        await writer.add(
          operation(
            `Update ${subject}`,
            call('uploadCollections.update', entry.id, body),
          ),
        );
    }
    for (const item of store.planEntries('upload')) {
      const entry = item as UploadPlan;
      if (!entry.desired || !['create', 'update'].includes(entry.action))
        continue;
      await emitAsset(entry, writer, call, literal);
    }
    // The CMA appends new records to their sibling group, so creates that do
    // not depend on each other follow their desired position, and a group
    // made only of new records needs no move once every record exists.
    for (const entry of records(
      ['create'],
      'createOrder',
      "json_extract(data,'$.desired.parentId'),json_extract(data,'$.desired.position'),",
    )) {
      const desired = entry.desired!;
      const model = models.get(entry.modelId)!;
      const fields =
        entry.execution?.creationFields ?? desired.published ?? desired.current;
      const body: JsonObject = {
        id: entry.id,
        item_type: { id: entry.modelId, type: 'item_type' },
        ...recordPayloadFields(fields, entry.modelId, schema),
        meta: {
          created_at: desired.createdAt,
          first_published_at: desired.firstPublishedAt,
        },
      };
      if (model.tree) body.parent_id = desired.parentId;
      const initial = schema.workflows
        .find((workflow) => workflow.id === model.workflowId)
        ?.stages.find((stage) => stage.initial);
      save({
        ...desired,
        current: fields,
        published: model.draftMode ? null : fields,
        stage: initial?.id ?? null,
      });
      await write(entry, 'Create', call('items.create', body));
    }
    for (const republish of [false, true])
      for (const entry of records(['create', 'update'], 'publishOrder')) {
        const provisional = entry.execution?.provisionalPublished;
        if (republish && !provisional) continue;
        const fields =
          (!republish ? provisional : undefined) ?? entry.desired!.published;
        const { draftMode } = models.get(entry.modelId)!;
        const live = state(entry.id);
        if (hashJson(live.published) === hashJson(fields)) {
          if (moves(entry)) await move(entry);
          continue;
        }
        if (!fields) {
          await write(
            entry,
            'Unpublish',
            call('items.unpublish', entry.id, undefined, { recursive: false }),
          );
          live.published = null;
          save(live);
          if (moves(entry)) await move(entry);
          continue;
        }
        await writeFields(
          entry,
          fields,
          republish
            ? 'Restore the links left out of the first publication of'
            : provisional
              ? draftMode
                ? 'Prepare a first publication, without links to records published later, of'
                : 'Publish, without links to records published later,'
              : draftMode
                ? 'Prepare publication of'
                : 'Update',
        );
        // Records of models without draft mode are published by the update.
        if (!draftMode) continue;
        await write(
          entry,
          'Publish',
          call('items.publish', entry.id, undefined, { recursive: false }),
        );
        save({ ...state(entry.id), published: fields });
      }
    for (const entry of records(['create', 'update'])) {
      const desired = entry.desired!;
      const { body, republish } = draftUpdate(entry, state(entry.id));
      await update(entry, body, 'Update', desired.current);
      save({ ...desired });
      if (republish)
        await write(
          entry,
          'Publish',
          call('items.publish', entry.id, undefined, { recursive: false }),
        );
    }
    for (const entry of records(['delete'], 'deleteOrder'))
      await write(entry, 'Delete', call('items.destroy', entry.id));
    for (const item of store.planEntries('upload', 'delete'))
      await writer.add(
        operation(
          `Delete asset ${quoted(
            (item as UploadPlan).baseline?.filename ?? '',
          )} (${commentText(item.id)})`,
          call('uploads.destroy', item.id),
        ),
      );
    // Baseline depth, not identity order, ensures children disappear before parents.
    for (const row of db
      .prepare(`WITH RECURSIVE folders(id,depth) AS (
 SELECT id,0 FROM collections WHERE side='target' AND parent_id IS NULL
 UNION ALL SELECT child.id,parent.depth+1 FROM folders parent JOIN collections child ON child.side='target' AND child.parent_id=parent.id)
 SELECT p.data FROM plan p JOIN folders f ON p.id=f.id WHERE p.kind='collection' AND p.action='delete' ORDER BY f.depth DESC,p.id`)
      .iterate()) {
      const entry = JSON.parse(String(row.data)) as CollectionPlan;
      await writer.add(
        operation(
          `Delete folder ${quoted(entry.baseline?.label ?? '')} (${commentText(
            entry.id,
          )})`,
          call('uploadCollections.destroy', entry.id),
        ),
      );
    }
    const folders = folderOrder(store);
    if (folders?.length)
      await writer.add(
        operation(
          'Set the position of every folder',
          call('uploadCollections.reorder', folders),
        ),
      );
    for (const group of recordOrders(store, metadata))
      await writer.add(
        operation(
          `Reorder ${commentText(models.get(group.model)!.name)} records${
            group.parent
              ? parentLabel(group.model, group.parent)
              : ' at the top level'
          }`,
          `  await reorderRecords(client, ${literal(group)});\n`,
        ),
        ['reorderRecords'],
      );
    // Schedules change last, and only where baseline and desired differ, so a
    // new schedule never sees a half-migrated record. Deleting a record
    // removes its schedules with it.
    for (const entry of records(['create', 'update']))
      await emitSchedules(entry, subject(entry), writer, call);
  } finally {
    db.exec('DROP TABLE migration_emit_record_state');
  }
}

/**
 * Create, replace or update one asset. New and replaced files are uploaded
 * from the source asset's URL and must match the MD5 captured at generation.
 */
async function emitAsset(
  entry: UploadPlan,
  writer: MigrationScriptWriter,
  call: (method: string, ...args: unknown[]) => string,
  literal: Literal,
): Promise<void> {
  const desired = entry.desired!;
  const baseline = entry.baseline;
  const subject = `asset ${quoted(desired.filename)} (${commentText(
    entry.id,
  )})`;
  const collection = folderRef(desired.collectionId);
  const replaced =
    baseline &&
    (baseline.md5 !== desired.md5 || baseline.size !== desired.size);
  if (!baseline || replaced) {
    // The CMA derives a new asset's basename from its filename.
    const { basename: _basename, ...created } = desired.attributes;
    const body = baseline
      ? { url: originalFileUrl(desired.url), filename: desired.filename }
      : {
          id: entry.id,
          url: originalFileUrl(desired.url),
          filename: desired.filename,
        };
    const upload = baseline
      ? `client.uploads.updateFromUrl(${literal(entry.id)}, ${literal({
          ...body,
          ...desired.attributes,
          upload_collection: collection,
        })})`
      : `client.uploads.createFromUrl(${literal({
          ...body,
          ...created,
          upload_collection: collection,
        })})`;
    await writer.add(
      operation(
        `${baseline ? 'Replace the file of' : 'Create'} ${subject}`,
        `  {\n    const upload = await ${upload};\n    if (upload.md5 !== ${literal(
          desired.md5,
        )})\n      throw new Error(${literal(
          `Asset ${entry.id} changed in the source since the diff generation. Please re-generate a diff to apply.`,
        )});\n  }\n`,
      ),
    );
    return;
  }
  const body = patch(baseline.attributes, desired.attributes);
  if (baseline.collectionId !== desired.collectionId)
    body.upload_collection = collection;
  if (Object.keys(body).length)
    await writer.add(
      operation(`Update ${subject}`, call('uploads.update', entry.id, body)),
    );
}

/**
 * Every folder that exists once the script has run, at its desired position:
 * the source position for managed folders, the baseline one for the rest.
 * Null when no folder changes; empty when every folder is deleted.
 */
function folderOrder(store: SnapshotStore): JsonObject[] | null {
  if (
    !store.database
      .prepare(
        "SELECT 1 FROM plan WHERE kind='collection' AND action IN ('create','update','delete') LIMIT 1",
      )
      .get()
  )
    return null;
  const final = new Map<string, CollectionState>();
  for (const folder of store.collections('target'))
    final.set(folder.id, folder);
  for (const item of store.planEntries('collection')) {
    const entry = item as CollectionPlan;
    if (entry.action === 'delete') final.delete(entry.id);
    else if (
      (entry.action === 'create' || entry.action === 'update') &&
      entry.desired
    )
      final.set(entry.id, entry.desired);
  }
  return [...final.values()]
    .sort(
      (a, b) =>
        compareIds(a.parentId ?? '', b.parentId ?? '') ||
        a.position - b.position ||
        compareIds(a.id, b.id),
    )
    .map((folder) => ({
      id: folder.id,
      type: 'upload_collection',
      position: folder.position,
      parent: folderRef(folder.parentId),
    }));
}

interface Member {
  id: string;
  position: number;
  managed: boolean;
}

/**
 * Sibling groups of sortable and tree models whose final membership or order
 * differs from the baseline, with their complete final order. Members are
 * sorted by desired position (the source position for records the plan
 * manages, the baseline position for retained destination records), managed
 * records first on ties, then by ID. Only groups that gain, lose or reorder
 * records are read; a group that only loses records keeps its order and needs
 * no code.
 */
function* recordOrders(
  store: SnapshotStore,
  metadata: PlanMetadata,
): Generator<{ model: string; parent: string | null; order: string[] }> {
  const selected = new Set(metadata.options.modelIds);
  const ordered = new Set(
    metadata.schema.models
      .filter(
        (model) => selected.has(model.id) && (model.sortable || model.tree),
      )
      .map((model) => model.id),
  );
  const key = (model: string, parent: string | null) =>
    JSON.stringify([model, parent]);
  const groups = new Set<string>();
  const managed = new Map<string, Member[]>();
  const leaving = new Set<string>();
  for (const action of ['create', 'update', 'delete'] as const)
    for (const item of store.planEntries('record', action)) {
      const entry = item as RecordPlan;
      if (entry.baseline && ordered.has(entry.baseline.modelId)) {
        groups.add(key(entry.baseline.modelId, entry.baseline.parentId));
        leaving.add(entry.id);
      }
      if (action === 'delete' || !ordered.has(entry.modelId)) continue;
      const desired = entry.desired!;
      const group = key(entry.modelId, desired.parentId);
      groups.add(group);
      let members = managed.get(group);
      if (!members) {
        members = [];
        managed.set(group, members);
      }
      members.push({
        id: entry.id,
        position: desired.position ?? 0,
        managed: true,
      });
    }
  // Records that stay in their group but sit at another position in the
  // source have no plan entry of their own.
  for (const row of store.database
    .prepare(
      `SELECT DISTINCT s.model_id,s.parent_id FROM records s JOIN records t ON t.side='target' AND t.id=s.id AND t.model_id=s.model_id AND t.parent_id IS s.parent_id
 WHERE s.side='source' AND s.position IS NOT t.position`,
    )
    .iterate()) {
    const model = String(row.model_id);
    if (ordered.has(model))
      groups.add(
        key(model, row.parent_id === null ? null : String(row.parent_id)),
      );
  }
  // A retained member the source also holds in this group takes its source
  // position, unless the plan skipped it.
  const siblings = store.database.prepare(
    `SELECT t.id,COALESCE(s.position,t.position) AS position,s.id IS NOT NULL AS managed FROM records t
 LEFT JOIN plan p ON p.kind='record' AND p.id=t.id
 LEFT JOIN records s ON s.side='source' AND s.id=t.id AND s.model_id=t.model_id AND s.parent_id IS t.parent_id AND p.action IS NOT 'skip'
 WHERE t.side='target' AND t.model_id=? AND t.parent_id IS ? ORDER BY t.position,t.id`,
  );
  for (const group of [...groups].sort()) {
    const [model, parent] = JSON.parse(group) as [string, string | null];
    const rows = siblings.all(model, parent);
    const baseline = rows.map((row) => String(row.id));
    const members: Member[] = [
      ...rows
        .filter((row) => !leaving.has(String(row.id)))
        .map((row) => ({
          id: String(row.id),
          position: Number(row.position ?? 0),
          managed: Boolean(row.managed),
        })),
      ...(managed.get(group) ?? []),
    ].sort(
      (a, b) =>
        a.position - b.position ||
        Number(b.managed) - Number(a.managed) ||
        compareIds(a.id, b.id),
    );
    const order = members.map((member) => member.id);
    const kept = new Set(order);
    const remaining = baseline.filter((id) => kept.has(id));
    if (
      order.length < 2 ||
      (remaining.length === order.length &&
        remaining.every((id, index) => id === order[index]))
    )
      continue;
    yield { model, parent, order };
  }
}

async function emitSchedules(
  entry: RecordPlan,
  subject: string,
  writer: MigrationScriptWriter,
  call: (method: string, ...args: unknown[]) => string,
): Promise<void> {
  const baseline: Schedules | null = entry.baseline?.schedules ?? null;
  const desired = entry.desired!.schedules;
  const { publication, unpublishing } = desired;
  for (const [key, resource, body] of [
    [
      'publication',
      'scheduledPublication',
      publication && {
        publication_scheduled_at: publication.at,
        selective_publication: publication.selective
          ? {
              content_in_locales: publication.selective.locales,
              non_localized_content: publication.selective.nonLocalized,
            }
          : null,
      },
    ],
    [
      'unpublishing',
      'scheduledUnpublishing',
      unpublishing && {
        unpublishing_scheduled_at: unpublishing.at,
        content_in_locales: unpublishing.locales,
      },
    ],
  ] as const) {
    const before = baseline?.[key] ?? null;
    if (hashJson(before) === hashJson(desired[key])) continue;
    if (before)
      await writer.add(
        operation(
          `Remove the scheduled ${key} of ${subject}`,
          call(`${resource}.destroy`, entry.id),
        ),
      );
    if (body)
      await writer.add(
        operation(
          `Schedule the ${key} of ${subject}`,
          call(`${resource}.create`, entry.id, body),
        ),
      );
  }
}
