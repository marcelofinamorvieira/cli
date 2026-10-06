import { requiresBinary } from './asset-download';
import { hashJson, object, recordPayloadFields } from './codec';
import { orderedCollectionWrites } from './planner';
import type { SnapshotStore } from './store';
import type {
  CollectionPlan,
  JsonObject,
  PlanMetadata,
  RecordPlan,
  RecordState,
  TemporarySchemaChange,
  UploadPlan,
} from './types';

type Literal = (value: unknown, depth?: number) => string;
export interface MigrationScriptWriter {
  add(statement: string, partStatement?: string): Promise<void>;
  asset(statement: (path: string) => string, file: string): Promise<void>;
}
const label = (value: string) =>
  JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value)
    .replace(/\*\//g, '*\\/')
    .replace(/[\u2028\u2029]/g, (c) =>
      c === '\u2028' ? '\\u2028' : '\\u2029',
    );
function recordLabel(entry: RecordPlan, schema: PlanMetadata['schema']) {
  const model = schema.models.find((model) => model.id === entry.modelId)!;
  const state = entry.desired ?? entry.baseline;
  let title: string | undefined;
  for (const key of ['title', 'name']) {
    const field = model.fields.find(
      (field) => field.apiKey === key && field.type === 'string',
    );
    if (!field) continue;
    const value = state?.current[key];
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
  return `${label(model.name)} (${label(model.apiKey)}) record ${label(
    entry.id,
  )}${title ? `, ${label(title)}` : ''}`;
}
const comment = (action: string, subject: string, statement: string) =>
  `  // ${action}: ${subject}.\n${statement}`;
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
function payload(
  fields: JsonObject,
  modelId: string,
  schema: PlanMetadata['schema'],
): JsonObject {
  const full = recordPayloadFields(fields, modelId, schema);
  return Object.fromEntries(Object.keys(fields).map((key) => [key, full[key]]));
}

/** Explicit, guarded CMA restoration shared by the normal path and its finally. */
export function restoreFieldSource(
  change: TemporarySchemaChange,
  literal: Literal,
): string {
  const original = {
    validators: change.original.validators,
    default_value: change.original.defaultValue,
  };
  const temporary = {
    validators: change.temporary.validators,
    default_value: change.temporary.defaultValue,
  };
  return `  {\n    const field = await client.fields.find(${literal(
    change.fieldId,
  )});\n    const settings = { validators: field.validators, default_value: field.default_value };\n    if (!isDeepStrictEqual(settings, ${literal(
    original,
    2,
  )})) {\n      if (!isDeepStrictEqual(settings, ${literal(
    temporary,
    2,
  )})) throw new Error(${literal(
    `Field ${change.fieldId} changed concurrently; original settings were not restored.`,
  )});\n      await client.fields.update(${literal(change.fieldId)}, ${literal(
    original,
    2,
  )});\n    }\n  }\n\n`;
}

/** Compile the planner's proven intermediate states and phase order into real CMA calls. */
export async function emitMigrationCalls(
  store: SnapshotStore,
  metadata: PlanMetadata,
  writer: MigrationScriptWriter,
  literal: Literal,
): Promise<void> {
  const db = store.database;
  const models = new Map(
    metadata.schema.models.map((model) => [model.id, model]),
  );
  const call = (method: string, ...args: unknown[]) =>
    `  checkMigration(client);\n  await client.${method}(${args
      .map((arg) => literal(arg, 1))
      .join(', ')});\n\n`;
  db.exec(`CREATE TEMP TABLE migration_emit_record_state(id TEXT PRIMARY KEY,state_json TEXT NOT NULL) WITHOUT ROWID;
 INSERT INTO migration_emit_record_state SELECT r.id,r.state_json FROM records r JOIN plan p ON p.kind='record' AND p.id=r.id AND p.action IN ('update','delete') WHERE r.side='target';`);
  for (const order of [
    'createOrder',
    'publishOrder',
    'updateOrder',
    'deleteOrder',
  ])
    db.exec(
      `CREATE INDEX IF NOT EXISTS migration_emit_${order} ON plan(kind,COALESCE(json_extract(data,'$.execution.${order}'),0),model_id,id)`,
    );
  const read = db.prepare(
    'SELECT state_json FROM migration_emit_record_state WHERE id=?',
  );
  const put = db.prepare(
    'INSERT OR REPLACE INTO migration_emit_record_state VALUES(?,?)',
  );
  const state = (id: string): RecordState | undefined => {
    const row = read.get(id);
    return row ? JSON.parse(String(row.state_json)) : undefined;
  };
  const save = (value: RecordState) => put.run(value.id, JSON.stringify(value));
  function* records(
    actions: readonly string[],
    order: string,
  ): Generator<RecordPlan> {
    for (const row of db
      .prepare(
        `SELECT data FROM plan WHERE kind='record' AND action IN (${actions
          .map(() => '?')
          .join(
            ',',
          )}) ORDER BY COALESCE(json_extract(data,'$.execution.${order}'),0),model_id,id`,
      )
      .iterate(...actions))
      yield JSON.parse(String(row.data));
  }
  const update = async (
    entry: RecordPlan,
    body: JsonObject,
    action: string,
  ) => {
    if (!Object.keys(body).length) return;
    await writer.add(
      comment(
        action,
        recordLabel(entry, metadata.schema),
        `  {\n    checkMigration(client);\n    const current = await client.items.find(${literal(
          entry.id,
        )}, { nested: true });\n    checkMigration(client);\n    await client.items.update(${literal(
          entry.id,
        )}, {\n      ...${literal(body, 3)},\n      meta: { ...${literal(
          body.meta ?? {},
          3,
        )}, current_version: current.meta.current_version },\n    });\n  }\n\n`,
      ),
    );
  };
  const writeFields = async (
    entry: RecordPlan,
    fields: JsonObject,
    action: string,
  ) => {
    const live = state(entry.id)!;
    const changed = patch(live.current, fields);
    await update(
      entry,
      payload(changed, entry.modelId, metadata.schema),
      action,
    );
    live.current = fields;
    if (!models.get(entry.modelId)!.draftMode) live.published = fields;
    save(live);
  };
  const refreshValidity = async (entry: RecordPlan, fields: JsonObject) =>
    writer.add(
      comment(
        'Refresh publication validity when needed',
        recordLabel(entry, metadata.schema),
        `  {\n    checkMigration(client);\n    const current = await client.items.find(${literal(
          entry.id,
        )}, { nested: true });\n    if (!current.meta.is_current_version_valid) {\n      checkMigration(client);\n      await client.items.update(${literal(
          entry.id,
        )}, { ...${literal(
          recordPayloadFields(fields, entry.modelId, metadata.schema),
          3,
        )}, meta: { current_version: current.meta.current_version } });\n    }\n  }\n\n`,
      ),
    );
  try {
    // Schedules are removed before any changed record can become publishable midway.
    for (const entry of records(['update', 'delete'], 'updateOrder'))
      for (const [key, resource] of [
        ['publication', 'scheduledPublication'],
        ['unpublishing', 'scheduledUnpublishing'],
      ] as const)
        if (entry.baseline?.schedules[key])
          await writer.add(
            comment(
              `Remove ${key} schedule`,
              recordLabel(entry, metadata.schema),
              call(`${resource}.destroy`, entry.id),
            ),
          );
    for (const change of metadata.temporarySchemaChanges) {
      const original = {
        validators: change.original.validators,
        default_value: change.original.defaultValue,
      };
      const temporary = {
        validators: change.temporary.validators,
        default_value: change.temporary.defaultValue,
      };
      await writer.add(
        comment(
          'Apply temporary field settings',
          label(change.fieldId),
          `  {\n    checkMigration(client);\n    const field = await client.fields.find(${literal(
            change.fieldId,
          )});\n    if (!isDeepStrictEqual({ validators: field.validators, default_value: field.default_value }, ${literal(
            original,
            2,
          )})) throw new Error(${literal(
            `Field ${change.fieldId} changed before temporary relaxation.`,
          )});\n    checkMigration(client);\n    await client.fields.update(${literal(
            change.fieldId,
          )}, ${literal(temporary, 2)});\n  }\n\n`,
        ),
      );
    }
    for (const entry of orderedCollectionWrites(store)) {
      const desired = entry.desired!;
      const body = {
        label: desired.label,
        parent: desired.parentId
          ? { id: desired.parentId, type: 'upload_collection' }
          : null,
        position: desired.position,
      };
      if (entry.action === 'create')
        await writer.add(
          comment(
            'Create asset folder',
            `${label(desired.label)} (${label(entry.id)})`,
            call('uploadCollections.create', {
              id: entry.id,
              label: desired.label,
              parent: body.parent,
            }),
          ),
        );
      await writer.add(
        comment(
          'Set asset folder metadata and position',
          label(entry.id),
          `  {\n    checkMigration(client);\n    const folder = await client.uploadCollections.find(${literal(
            entry.id,
          )});\n    if (folder.label !== ${literal(
            desired.label,
          )} || folder.position !== ${literal(
            desired.position,
          )} || (folder.parent?.id ?? null) !== ${literal(
            desired.parentId,
          )}) {\n      checkMigration(client);\n      await client.uploadCollections.update(${literal(
            entry.id,
          )}, ${literal(body, 2)});\n    }\n  }\n\n`,
        ),
      );
    }
    for (const item of store.iteratePlan('upload')) {
      const entry = item as UploadPlan;
      if (!entry.desired || !['create', 'update'].includes(entry.action))
        continue;
      const desired = entry.desired;
      const subject = `${label(desired.filename)} (${label(entry.id)})`;
      if (requiresBinary(entry)) {
        const row = db
          .prepare(
            'SELECT data FROM migration_baseline_binaries WHERE upload_id=?',
          )
          .get(entry.id);
        if (!row) throw new Error(`Missing verified binary for ${entry.id}`);
        const asset = JSON.parse(String(row.data));
        await writer.asset(
          (local) =>
            comment(
              entry.action === 'create'
                ? 'Create asset'
                : 'Replace asset binary',
              subject,
              `  {\n    checkMigration(client);\n    const path = await uploadMigrationFile(client, ${local}, ${literal(
                desired.filename,
              )});\n    checkMigration(client);\n    await client.uploads.${
                entry.action === 'create'
                  ? `create({ id: ${literal(entry.id)}, path })`
                  : `update(${literal(
                      entry.id,
                    )}, { path }, { replace_strategy: 'create_new_url' })`
              };\n  }\n\n`,
            ),
          asset.binary.file,
        );
      }
      await writer.add(
        comment(
          'Update asset metadata',
          subject,
          call('uploads.update', entry.id, {
            ...desired.attributes,
            upload_collection: desired.collectionId
              ? { id: desired.collectionId, type: 'upload_collection' }
              : null,
          }),
        ),
      );
    }
    for (const entry of records(['create'], 'createOrder')) {
      const desired = entry.desired!;
      const model = models.get(entry.modelId)!;
      const fields =
        entry.execution?.creationFields ?? desired.published ?? desired.current;
      await writer.add(
        comment(
          'Create record',
          recordLabel(entry, metadata.schema),
          call('items.create', {
            id: entry.id,
            item_type: { id: entry.modelId, type: 'item_type' },
            ...recordPayloadFields(fields, entry.modelId, metadata.schema),
            meta: {
              created_at: desired.createdAt,
              first_published_at: desired.firstPublishedAt,
            },
            ...(model.tree ? { parent_id: desired.parentId } : {}),
            ...(model.tree || model.sortable
              ? { position: desired.position }
              : {}),
          }),
        ),
      );
      const workflow = metadata.schema.workflows.find(
        (workflow) => workflow.id === model.workflowId,
      );
      const initial = Array.isArray(workflow?.stages)
        ? workflow.stages.find(
            (stage) => object(stage) && stage.initial === true,
          )
        : undefined;
      save({
        ...desired,
        current: fields,
        published: model.draftMode ? null : fields,
        stage:
          object(initial) && typeof initial.id === 'string' ? initial.id : null,
      });
    }
    for (const republish of [false, true])
      for (const entry of records(['create', 'update'], 'publishOrder')) {
        if (republish && !entry.execution?.provisionalPublished) continue;
        const desired = entry.desired!;
        let live = state(entry.id)!;
        const fields =
          (!republish ? entry.execution?.provisionalPublished : undefined) ??
          desired.published;
        const model = models.get(entry.modelId)!;
        const prep: JsonObject = {};
        if (model.tree && live.parentId !== desired.parentId) {
          prep.parent_id = desired.parentId;
          prep.position = desired.position;
          live.parentId = desired.parentId;
          live.position = desired.position;
        }
        if (
          live.createdAt !== desired.createdAt ||
          live.firstPublishedAt !== desired.firstPublishedAt
        ) {
          prep.meta = {
            created_at: desired.createdAt,
            first_published_at: desired.firstPublishedAt,
          };
          live.createdAt = desired.createdAt;
          live.firstPublishedAt = desired.firstPublishedAt;
        }
        await update(entry, prep, 'Prepare publication metadata');
        save(live);
        if (hashJson(live.published) === hashJson(fields)) continue;
        if (!fields) {
          await writer.add(
            comment(
              'Unpublish record',
              recordLabel(entry, metadata.schema),
              `  checkMigration(client);\n  await client.items.unpublish(${literal(
                entry.id,
              )}, undefined, { recursive: false });\n\n`,
            ),
          );
          live.published = null;
          save(live);
          continue;
        }
        await writeFields(
          entry,
          fields,
          republish
            ? 'Restore publication cycle links'
            : 'Update published fields',
        );
        await refreshValidity(entry, fields);
        await writer.add(
          comment(
            'Publish record',
            recordLabel(entry, metadata.schema),
            `  checkMigration(client);\n  await client.items.publish(${literal(
              entry.id,
            )}, undefined, { recursive: false });\n\n`,
          ),
        );
        live = state(entry.id)!;
        live.published = fields;
        save(live);
      }
    for (const entry of records(['create', 'update'], 'updateOrder')) {
      const desired = entry.desired!;
      const live = state(entry.id)!;
      const body = payload(
        patch(live.current, desired.current),
        entry.modelId,
        metadata.schema,
      );
      const meta: JsonObject = {};
      for (const [key, value, previous] of [
        ['created_at', desired.createdAt, live.createdAt],
        ['first_published_at', desired.firstPublishedAt, live.firstPublishedAt],
        ['stage', desired.stage, live.stage],
      ] as const)
        if (value !== previous) meta[key] = value;
      if (Object.keys(meta).length) body.meta = meta;
      await update(
        entry,
        body,
        desired.published
          ? 'Restore newer draft fields'
          : 'Update record fields and metadata',
      );
      save({ ...desired });
    }
    for (const entry of records(['delete'], 'deleteOrder'))
      await writer.add(
        comment(
          'Delete record',
          recordLabel(entry, metadata.schema),
          call('items.destroy', entry.id),
        ),
      );
    for (const item of store.iteratePlan('upload', 'delete'))
      await writer.add(
        comment(
          'Delete asset',
          label(item.id),
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
        comment(
          'Delete asset folder',
          label(entry.id),
          call('uploadCollections.destroy', entry.id),
        ),
      );
    }
    await emitOrdering(store, metadata, writer, literal);
    for (const change of metadata.temporarySchemaChanges)
      await writer.add(
        comment(
          'Restore original field settings',
          label(change.fieldId),
          restoreFieldSource(change, literal),
        ),
      );
    for (const entry of records(['create', 'update'], 'updateOrder')) {
      const desired = entry.desired!;
      const publication = desired.schedules.publication;
      if (publication) {
        const model = models.get(entry.modelId)!;
        if (
          (model.saveInvalidDrafts ||
            metadata.schema.semantics.improved_validation_at_publishing ===
              true) &&
          !(model.saveInvalidDrafts && publication.selective)
        )
          await refreshValidity(entry, desired.current);
        await writer.add(
          comment(
            'Set publication schedule',
            recordLabel(entry, metadata.schema),
            call('scheduledPublication.create', entry.id, {
              publication_scheduled_at: publication.at,
              selective_publication: publication.selective
                ? {
                    content_in_locales: publication.selective.locales,
                    non_localized_content: publication.selective.nonLocalized,
                  }
                : null,
            }),
          ),
        );
      }
      if (desired.schedules.unpublishing)
        await writer.add(
          comment(
            'Set unpublishing schedule',
            recordLabel(entry, metadata.schema),
            call('scheduledUnpublishing.create', entry.id, {
              unpublishing_scheduled_at: desired.schedules.unpublishing.at,
              content_in_locales: desired.schedules.unpublishing.locales,
            }),
          ),
        );
    }
  } finally {
    db.exec('DROP TABLE migration_emit_record_state');
  }
}

async function emitOrdering(
  store: SnapshotStore,
  metadata: PlanMetadata,
  writer: MigrationScriptWriter,
  literal: Literal,
) {
  const db = store.database;
  db.exec(
    'CREATE TEMP TABLE migration_emit_positions(kind TEXT,id TEXT,model_id TEXT,parent_id TEXT,position REAL,PRIMARY KEY(kind,id)) WITHOUT ROWID; CREATE INDEX migration_emit_position_order ON migration_emit_positions(kind,model_id,parent_id,position,id)',
  );
  const insert = db.prepare(
    'INSERT OR REPLACE INTO migration_emit_positions VALUES(?,?,?,?,?)',
  );
  const remove = db.prepare(
    'DELETE FROM migration_emit_positions WHERE kind=? AND id=?',
  );
  try {
    for (const model of metadata.schema.models) {
      if (
        (!model.sortable && !model.tree) ||
        !db
          .prepare(
            "SELECT 1 FROM plan WHERE kind='record' AND model_id=? AND action IN ('create','update','delete') LIMIT 1",
          )
          .get(model.id)
      )
        continue;
      for (const state of store.iterateRecords('target', model.id))
        insert.run(
          'record',
          state.id,
          model.id,
          state.parentId,
          state.position,
        );
      for (const row of db
        .prepare(
          "SELECT data FROM plan WHERE kind='record' AND model_id=? AND action IN ('create','update','delete') ORDER BY id",
        )
        .iterate(model.id)) {
        const plan = JSON.parse(String(row.data)) as RecordPlan;
        if (plan.action === 'delete') remove.run('record', plan.id);
        else
          insert.run(
            'record',
            plan.id,
            model.id,
            plan.desired!.parentId,
            plan.desired!.position,
          );
      }
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM plan WHERE kind='collection' AND action IN ('create','update','delete') LIMIT 1",
        )
        .get()
    ) {
      for (const state of store.iterateCollections('target'))
        insert.run('collection', state.id, '', state.parentId, state.position);
      for (const item of store.iteratePlan('collection')) {
        const plan = item as CollectionPlan;
        if (plan.action === 'delete') remove.run('collection', plan.id);
        else if (['create', 'update'].includes(plan.action))
          insert.run(
            'collection',
            plan.id,
            '',
            plan.desired!.parentId,
            plan.desired!.position,
          );
      }
    }
    // Native collection positions permit gaps/duplicates: move down first, then up.
    for (const descending of [true, false])
      for (const row of db
        .prepare(
          `SELECT * FROM migration_emit_positions WHERE kind='collection' ORDER BY parent_id,position ${
            descending ? 'DESC' : 'ASC'
          },id`,
        )
        .iterate())
        await writer.add(
          comment(
            'Restore asset folder order',
            label(String(row.id)),
            `  {\n    checkMigration(client);\n    const current = await client.uploadCollections.find(${literal(
              row.id,
            )});\n    if (current.position ${descending ? '<' : '>'} ${literal(
              row.position,
            )}) {\n      checkMigration(client);\n      await client.uploadCollections.update(${literal(
              row.id,
            )}, { position: ${literal(row.position)} });\n    }\n  }\n\n`,
          ),
        );
    // The second pass settles sibling shifts caused by earlier reparenting.
    for (let pass = 0; pass < 2; pass++)
      for (const row of db
        .prepare(
          "SELECT * FROM migration_emit_positions WHERE kind='record' ORDER BY model_id,parent_id,position,id",
        )
        .iterate()) {
        const model = metadata.schema.models.find(
          (model) => model.id === row.model_id,
        )!;
        await writer.add(
          comment(
            `Restore record order (pass ${pass + 1}/2)`,
            label(String(row.id)),
            `  {\n    checkMigration(client);\n    const current = await client.items.find(${literal(
              row.id,
            )}, { nested: true });\n    if (current.position !== ${literal(
              row.position,
            )}${
              model.tree
                ? ` || current.parent_id !== ${literal(row.parent_id)}`
                : ''
            }) {\n      checkMigration(client);\n      await client.items.update(${literal(
              row.id,
            )}, { ${
              model.tree ? `parent_id: ${literal(row.parent_id)}, ` : ''
            }position: ${literal(
              row.position,
            )}, meta: { current_version: current.meta.current_version } });\n    }\n  }\n\n`,
          ),
        );
      }
  } finally {
    db.exec('DROP TABLE migration_emit_positions');
  }
}
