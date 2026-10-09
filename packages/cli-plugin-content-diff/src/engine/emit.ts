import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { assertNotAborted } from './cancellation';
import {
  hashJson,
  object,
  recordPayloadFields,
  recordTitle,
  recordUpdatePayloadFields,
  referenceId,
} from './codec';
import { compareIds } from './compare-ids';
import type { Expectation, Operation, OperationName } from './operations';
import {
  type Plan,
  creationEmptyValue,
  orderedCollectionWrites,
} from './planner';
import type { SideIndex } from './side';
import { SpillFiles, byBucket } from './spill';
import type {
  CollectionState,
  JsonObject,
  ModelSchema,
  RecordFacts,
  RecordPlan,
  RecordState,
  SchemaState,
  UploadPlan,
  UploadState,
} from './types';

/** Operation files are sorted in memory, one range of slots at a time. */
const RANGE_CHARACTERS = 64 * 1024 * 1024;

/** A line comment-like label stays on one short line. */
function labelText(value: string): string {
  const short = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return short.replace(/[\r\n\u2028\u2029]+/g, ' ');
}
const quoted = (value: string) => `"${labelText(value)}"`;
const folderRef = (id: string | null) =>
  id ? { id, type: 'upload_collection' } : null;

/** A record named by its model, its title and its ID. */
export function recordLabel(
  schema: SchemaState,
  modelId: string,
  id: string,
  title: string | undefined,
): string {
  const model = schema.models.find((model) => model.id === modelId);
  return `${labelText(model?.name ?? 'record')}${
    title ? ` ${quoted(title)}` : ''
  } (${labelText(id)})`;
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
 * apply checks the MD5 of what it uploads.
 */
export function originalFileUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('skip-default-optimizations', 'true');
  parsed.searchParams.set('svg-sanitize', 'false');
  return parsed.toString();
}

/** Where an asset's file sits in a dump or a diff. */
export function assetEntryName(id: string, filename: string): string {
  return `assets/${id}/${filename.replace(/[/\\]/g, '_')}`;
}

/** A record's fields with `keys` set to their empty native value. */
function emptyFields(
  fields: JsonObject,
  model: ModelSchema,
  keys: Iterable<string>,
): JsonObject {
  const result = structuredClone(fields);
  for (const key of keys) {
    const field = model.fields.find((candidate) => candidate.apiKey === key)!;
    const value = result[key];
    if (field.localized && object(value)) {
      const locales: JsonObject = {};
      for (const locale of Object.keys(value))
        locales[locale] = creationEmptyValue(field.type);
      result[key] = locales;
    } else result[key] = creationEmptyValue(field.type);
  }
  return result;
}

/** Published fields without references to `targets` in top-level link fields. */
function omitLinks(
  fields: JsonObject,
  model: ModelSchema,
  targets: ReadonlySet<string>,
): JsonObject {
  const result = structuredClone(fields);
  const omit = (type: string, value: unknown) => {
    if (type === 'link') {
      const target = referenceId(value);
      return target && targets.has(target) ? null : value;
    }
    return Array.isArray(value)
      ? value.filter((entry) => {
          const target = referenceId(entry);
          return !(target && targets.has(target));
        })
      : value;
  };
  for (const field of model.fields) {
    if (field.type !== 'link' && field.type !== 'links') continue;
    const value = result[field.apiKey];
    if (value === undefined) continue;
    result[field.apiKey] = (
      field.localized && object(value)
        ? Object.fromEntries(
            Object.entries(value).map(([locale, entry]) => [
              locale,
              omit(field.type, entry),
            ]),
          )
        : omit(field.type, value)
    ) as JsonObject[string];
  }
  return result;
}

/** A record's sibling group and place in it. */
interface Placement {
  group: string;
  position: number | null;
}
const groupKey = (model: string, parent: string | null) =>
  JSON.stringify([model, parent]);

/**
 * An operation with its place in the run: its slot (one per entity and
 * phase), its sequence within the slot, and what the final pass needs to
 * decide whether a first update can be locked to the destination version.
 */
interface Emitted {
  slot: number;
  seq: number;
  operation: Operation;
  /** A first update that may carry `meta.current_version`. */
  lock?: Placement & { version: string };
  /** A move out of a sibling group, which renumbers the records after it. */
  leave?: Placement;
}

type RecordPhase =
  | 'create'
  | 'publish'
  | 'republish'
  | 'draft'
  | 'delete'
  | 'schedule';

interface Context {
  plan: Plan;
  source: SideIndex;
  target: SideIndex;
  schema: SchemaState;
  models: Map<string, ModelSchema>;
  /** Whether the source has asset files (a dump with assets). */
  assetFiles: boolean;
}

/** A record's title once the run is over, for the labels of other records. */
function finalTitle(context: Context, id: string): string | undefined {
  const entry = context.plan.records.get(id);
  return entry?.desired &&
    (entry.action === 'create' || entry.action === 'update')
    ? entry.desired.title
    : context.target.records.get(id)?.title;
}

/**
 * The operations of one record, in the order the run performs them. The
 * record's state as the run leaves it so far (`live`) decides each payload,
 * as each call builds on the previous ones.
 */
function recordOperations(
  context: Context,
  entry: RecordPlan,
  slots: Partial<Record<RecordPhase, number>>,
  baseline: RecordState | undefined,
  desired: RecordState | undefined,
): Emitted[] {
  const { schema } = context;
  const model = context.models.get(entry.modelId)!;
  const out: Emitted[] = [];
  let live = entry.action === 'update' ? structuredClone(baseline) : undefined;
  let written = false;
  // Only a record that has not been written yet can be locked, so its group
  // is still its baseline group.
  const placement: Placement | undefined = baseline && {
    group: groupKey(baseline.modelId, baseline.parentId),
    position: baseline.position,
  };
  const subject = (fields?: JsonObject) =>
    recordLabel(
      schema,
      entry.modelId,
      entry.id,
      recordTitle(
        entry.modelId,
        schema,
        fields ?? live?.current ?? baseline?.current,
      ),
    );
  const write = (
    phase: RecordPhase,
    op: OperationName,
    label: string,
    data?: JsonObject,
    extras: Pick<Emitted, 'lock' | 'leave'> = {},
  ) => {
    const expect: Expectation | undefined =
      !out.length && baseline
        ? {
            currentVersion: baseline.currentVersion,
            publishedUpdatedAt: baseline.publishedUpdatedAt,
          }
        : undefined;
    written = true;
    out.push({
      slot: slots[phase]!,
      seq: out.length,
      operation: {
        op,
        id: entry.id,
        label,
        ...(expect && { expect }),
        ...(data && { data }),
      },
      ...extras,
    });
  };
  // The first write to an existing record is an update locked to the version
  // the destination had, so a concurrent edit fails the update instead of
  // being overwritten. Later writes follow the run's own earlier writes.
  const update = (
    phase: RecordPhase,
    body: JsonObject,
    action: string,
    fields: JsonObject,
    detail = '',
    leave?: Placement,
  ) => {
    if (!Object.keys(body).length) return;
    const version = !written && baseline?.currentVersion;
    write(
      phase,
      'record.update',
      `${action} ${subject(fields)}${detail}`,
      body,
      {
        ...(version && placement && { lock: { ...placement, version } }),
        ...(leave && { leave }),
      },
    );
  };
  const parentLabel = (parentId: string | null) =>
    parentId
      ? ` under ${recordLabel(
          schema,
          entry.modelId,
          parentId,
          finalTitle(context, parentId),
        )}`
      : ' to the top level';
  // The update that brings a record's draft fields and metadata to their
  // desired state. A field update gives a published draft-mode record a new
  // current version, which leaves it with unpublished changes, so that
  // version is published again when the source record has none.
  const draftUpdate = (state: RecordState) => {
    const body = recordUpdatePayloadFields(
      state.current,
      desired!.current,
      entry.modelId,
      schema,
    );
    const republish =
      Object.keys(body).length > 0 &&
      model.draftMode &&
      !!desired!.published &&
      hashJson(desired!.current) === hashJson(desired!.published);
    const meta: JsonObject = {};
    for (const [key, value, previous] of [
      ['created_at', desired!.createdAt, state.createdAt],
      ['first_published_at', desired!.firstPublishedAt, state.firstPublishedAt],
      ['stage', desired!.stage, state.stage],
    ] as const)
      if (value !== previous) meta[key] = value;
    if (Object.keys(meta).length) body.meta = meta;
    return { body, republish };
  };
  // A tree record that changes parent. Moves run in publication order, so a
  // record sits under its new parent before it is published there and has
  // left a parent before that parent is unpublished.
  const moves = () => model.tree && live!.parentId !== desired!.parentId;
  const move = (phase: RecordPhase) => {
    const { parentId } = desired!;
    // A record whose publication is settled takes its draft changes along,
    // unless the update phase would publish them again afterwards.
    const draft = draftUpdate(live!);
    if (
      Object.keys(draft.body).length &&
      !draft.republish &&
      !entry.execution?.provisionalTargets
    ) {
      update(
        phase,
        { ...draft.body, parent_id: parentId },
        'Update',
        desired!.current,
        '',
        placement,
      );
      live = {
        ...live!,
        parentId,
        current: desired!.current,
        createdAt: desired!.createdAt,
        firstPublishedAt: desired!.firstPublishedAt,
        stage: desired!.stage,
      };
      return;
    }
    update(
      phase,
      { parent_id: parentId },
      'Move',
      live!.current,
      parentLabel(parentId),
      placement,
    );
    live = { ...live!, parentId };
  };
  // Writes the fields a publication needs, and the record's move. Like a
  // create, this write carries the first publication date, which publishing
  // keeps.
  const writeFields = (
    phase: RecordPhase,
    fields: JsonObject,
    action: string,
  ) => {
    const body = recordUpdatePayloadFields(
      live!.current,
      fields,
      entry.modelId,
      schema,
    );
    let leave: Placement | undefined;
    if (moves()) {
      leave = placement;
      body.parent_id = desired!.parentId;
      live!.parentId = desired!.parentId;
    }
    const { firstPublishedAt } = desired!;
    if (live!.firstPublishedAt !== firstPublishedAt) {
      body.meta = { first_published_at: firstPublishedAt };
      live!.firstPublishedAt = firstPublishedAt;
    }
    update(phase, body, action, fields, '', leave);
    live!.current = fields;
    if (!model.draftMode) live!.published = fields;
  };

  if (entry.action === 'delete') {
    write('delete', 'record.delete', `Delete ${subject()}`);
    return out;
  }
  if (entry.action === 'create') {
    const fields = emptyFields(
      desired!.published ?? desired!.current,
      model,
      entry.execution?.deferredFields ?? [],
    );
    const body: JsonObject = {
      item_type: { id: entry.modelId, type: 'item_type' },
      ...recordPayloadFields(fields, entry.modelId, schema),
      meta: {
        created_at: desired!.createdAt,
        first_published_at: desired!.firstPublishedAt,
      },
    };
    if (model.tree) body.parent_id = desired!.parentId;
    const initial = schema.workflows
      .find((workflow) => workflow.id === model.workflowId)
      ?.stages.find((stage) => stage.initial);
    live = {
      ...desired!,
      current: fields,
      published: model.draftMode ? null : fields,
      stage: initial?.id ?? null,
    };
    write('create', 'record.create', `Create ${subject()}`, body);
  }
  const targets = entry.execution?.provisionalTargets;
  const provisional =
    targets && omitLinks(desired!.published!, model, new Set(targets));
  for (const republish of [false, true]) {
    if (republish && !provisional) continue;
    const phase = republish ? 'republish' : 'publish';
    const fields = (!republish ? provisional : undefined) ?? desired!.published;
    if (hashJson(live!.published) === hashJson(fields)) {
      if (moves()) move(phase);
      continue;
    }
    if (!fields) {
      write(phase, 'record.unpublish', `Unpublish ${subject()}`);
      live!.published = null;
      if (moves()) move(phase);
      continue;
    }
    writeFields(
      phase,
      fields,
      republish
        ? 'Restore the links left out of the first publication of'
        : provisional
          ? model.draftMode
            ? 'Prepare a first publication, without links to records published later, of'
            : 'Publish, without links to records published later,'
          : model.draftMode
            ? 'Prepare publication of'
            : 'Update',
    );
    // Records of models without draft mode are published by the update.
    if (!model.draftMode) continue;
    write(phase, 'record.publish', `Publish ${subject()}`);
    live!.published = fields;
  }
  const draft = draftUpdate(live!);
  update('draft', draft.body, 'Update', desired!.current);
  live = { ...desired! };
  if (draft.republish) write('draft', 'record.publish', `Publish ${subject()}`);
  // Schedules change last, and only where baseline and desired differ, so a
  // new schedule never sees a half-migrated record.
  const { publication, unpublishing } = desired!.schedules;
  for (const [key, resource, body] of [
    [
      'publication',
      'schedule.publication',
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
      'schedule.unpublishing',
      unpublishing && {
        unpublishing_scheduled_at: unpublishing.at,
        content_in_locales: unpublishing.locales,
      },
    ],
  ] as const) {
    const before = baseline?.schedules[key] ?? null;
    if (hashJson(before) === hashJson(desired!.schedules[key])) continue;
    if (before)
      write(
        'schedule',
        `${resource}.delete`,
        `Remove the scheduled ${key} of ${subject()}`,
      );
    if (body)
      write(
        'schedule',
        `${resource}.create`,
        `Schedule the ${key} of ${subject()}`,
        body as JsonObject,
      );
  }
  return out;
}

/**
 * Create, replace or update one asset. New and replaced files are uploaded
 * from the source dump's file or the source asset's URL and must match the
 * MD5 the source reported.
 */
function uploadOperation(
  context: Context,
  entry: UploadPlan,
  baseline: UploadState | undefined,
  desired: UploadState | undefined,
): Operation | undefined {
  const expect: Expectation | undefined = baseline && { hash: baseline.hash };
  if (entry.action === 'delete')
    return {
      op: 'upload.delete',
      id: entry.id,
      label: `Delete asset ${quoted(baseline?.filename ?? '')} (${labelText(
        entry.id,
      )})`,
      ...(expect && { expect }),
    };
  const subject = `asset ${quoted(desired!.filename)} (${labelText(entry.id)})`;
  const collection = folderRef(desired!.collectionId);
  const replaced =
    baseline &&
    (baseline.md5 !== desired!.md5 || baseline.size !== desired!.size);
  if (!baseline || replaced) {
    // The CMA derives a new asset's basename from its filename.
    const { basename: _basename, ...created } = desired!.attributes;
    return {
      op: baseline ? 'upload.replace' : 'upload.create',
      id: entry.id,
      label: `${baseline ? 'Replace the file of' : 'Create'} ${subject}`,
      ...(expect && { expect }),
      ...(context.assetFiles
        ? { file: assetEntryName(entry.id, desired!.filename) }
        : { url: originalFileUrl(desired!.url) }),
      md5: desired!.md5,
      data: {
        filename: desired!.filename,
        ...(baseline ? desired!.attributes : created),
        upload_collection: collection,
      },
    };
  }
  const body = patch(baseline.attributes, desired!.attributes);
  if (baseline.collectionId !== desired!.collectionId)
    body.upload_collection = collection;
  if (!Object.keys(body).length) return undefined;
  return {
    op: 'upload.update',
    id: entry.id,
    label: `Update ${subject}`,
    ...(expect && { expect }),
    data: body,
  };
}

/** Folder creates and updates, parents before children in the final tree. */
function folderWrites(context: Context): Operation[] {
  const operations: Operation[] = [];
  for (const entry of orderedCollectionWrites(context.plan)) {
    const desired = entry.desired!;
    const subject = `folder ${quoted(desired.label)} (${labelText(entry.id)})`;
    if (entry.action === 'create') {
      operations.push({
        op: 'folder.create',
        id: entry.id,
        label: `Create ${subject}`,
        data: { label: desired.label, parent: folderRef(desired.parentId) },
      });
      continue;
    }
    const body: JsonObject = {};
    if (entry.baseline?.label !== desired.label) body.label = desired.label;
    if (entry.baseline?.parentId !== desired.parentId)
      body.parent = folderRef(desired.parentId);
    if (Object.keys(body).length)
      operations.push({
        op: 'folder.update',
        id: entry.id,
        label: `Update ${subject}`,
        expect: { hash: entry.baseline!.hash },
        data: body,
      });
  }
  return operations;
}

/** Folder deletes, children before parents by their destination depth. */
function folderDeletes(context: Context): Operation[] {
  const folders = [...context.target.collections.values()];
  const depth = new Map<string, number>();
  let level = folders.filter((folder) => !folder.parentId);
  for (let current = 0; level.length; current++) {
    for (const folder of level) depth.set(folder.id, current);
    const parents = new Set(level.map((folder) => folder.id));
    level = folders.filter(
      (folder) =>
        folder.parentId &&
        parents.has(folder.parentId) &&
        !depth.has(folder.id),
    );
  }
  return [...context.plan.collections.values()]
    .filter((entry) => entry.action === 'delete' && depth.has(entry.id))
    .sort(
      (a, b) => depth.get(b.id)! - depth.get(a.id)! || compareIds(a.id, b.id),
    )
    .map((entry) => ({
      op: 'folder.delete',
      id: entry.id,
      label: `Delete folder ${quoted(entry.baseline?.label ?? '')} (${labelText(
        entry.id,
      )})`,
      expect: { hash: entry.baseline!.hash },
    }));
}

/**
 * Every folder that exists once the run is over, at its desired position:
 * the source position for managed folders, the destination one for the rest.
 * Nothing when no folder changes.
 */
function folderOrder(context: Context): Operation[] {
  const entries = [...context.plan.collections.values()];
  if (
    !entries.some((entry) =>
      ['create', 'update', 'delete'].includes(entry.action),
    )
  )
    return [];
  const final = new Map<string, CollectionState>(context.target.collections);
  for (const entry of entries)
    if (entry.action === 'delete') final.delete(entry.id);
    else if (
      (entry.action === 'create' || entry.action === 'update') &&
      entry.desired
    )
      final.set(entry.id, entry.desired);
  const folders = [...final.values()]
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
  return folders.length
    ? [
        {
          op: 'folders.reorder',
          label: 'Set the position of every folder',
          data: folders,
        },
      ]
    : [];
}

/** SQL-like ascending order with nulls first. */
function nullsFirst(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

/**
 * Sibling groups of sortable and tree models whose final membership or order
 * differs from the destination, with their complete final order. Members are
 * sorted by desired position (the source position for records the plan
 * manages, the destination position for retained records), managed records
 * first on ties, then by ID. A group that only loses records keeps its order
 * and needs no operation.
 */
function recordOrders(context: Context): Operation[] {
  const { plan, source, target } = context;
  const selected = new Set(plan.metadata.options.modelIds);
  const ordered = new Set(
    context.schema.models
      .filter(
        (model) => selected.has(model.id) && (model.sortable || model.tree),
      )
      .map((model) => model.id),
  );
  const groups = new Set<string>();
  const managed = new Map<
    string,
    Array<{ id: string; position: number; managed: boolean }>
  >();
  const leaving = new Set<string>();
  const entries = [...plan.records.values()].sort(
    (a, b) => compareIds(a.modelId, b.modelId) || compareIds(a.id, b.id),
  );
  for (const action of ['create', 'update', 'delete'] as const)
    for (const entry of entries) {
      if (entry.action !== action) continue;
      if (entry.baseline && ordered.has(entry.baseline.modelId)) {
        groups.add(groupKey(entry.baseline.modelId, entry.baseline.parentId));
        leaving.add(entry.id);
      }
      if (action === 'delete' || !ordered.has(entry.modelId)) continue;
      const group = groupKey(entry.modelId, entry.desired!.parentId);
      groups.add(group);
      const member = {
        id: entry.id,
        position: entry.desired!.position ?? 0,
        managed: true,
      };
      const members = managed.get(group);
      if (members) members.push(member);
      else managed.set(group, [member]);
    }
  // The destination members of each group. Records that stay in their group
  // but sit at another position in the source have no plan entry of their
  // own, so their groups are found here too.
  const members = new Map<string, RecordFacts[]>();
  for (const record of target.records.values()) {
    if (!ordered.has(record.modelId)) continue;
    const group = groupKey(record.modelId, record.parentId);
    const rows = members.get(group);
    if (rows) rows.push(record);
    else members.set(group, [record]);
    const other = source.records.get(record.id);
    if (
      other &&
      other.modelId === record.modelId &&
      other.parentId === record.parentId &&
      other.position !== record.position
    )
      groups.add(group);
  }
  const operations: Operation[] = [];
  for (const group of [...groups].sort()) {
    const [model, parent] = JSON.parse(group) as [string, string | null];
    const rows = (members.get(group) ?? []).sort(
      (a, b) => nullsFirst(a.position, b.position) || compareIds(a.id, b.id),
    );
    const baseline = rows.map((row) => row.id);
    const wanted = [
      ...rows
        .filter((row) => !leaving.has(row.id))
        .map((row) => {
          const other = source.records.get(row.id);
          const kept =
            other &&
            other.modelId === row.modelId &&
            other.parentId === row.parentId &&
            plan.records.get(row.id)?.action !== 'skip';
          return {
            id: row.id,
            position:
              (kept ? other.position ?? row.position : row.position) ?? 0,
            managed: !!kept,
          };
        }),
      ...(managed.get(group) ?? []),
    ].sort(
      (a, b) =>
        a.position - b.position ||
        Number(b.managed) - Number(a.managed) ||
        compareIds(a.id, b.id),
    );
    const order = wanted.map((member) => member.id);
    const kept = new Set(order);
    const remaining = baseline.filter((id) => kept.has(id));
    if (
      order.length < 2 ||
      (remaining.length === order.length &&
        remaining.every((id, index) => id === order[index]))
    )
      continue;
    const name = context.models.get(model)!.name;
    operations.push({
      op: 'records.reorder',
      label: `Reorder ${labelText(name)} records${
        parent
          ? ` under ${recordLabel(
              context.schema,
              model,
              parent,
              finalTitle(context, parent),
            )}`
          : ' at the top level'
      }`,
      data: { model, parent, order },
    });
  }
  return operations;
}

/**
 * Every operation of a plan, in the order the run performs them. Each
 * record, upload or folder gets a slot per phase, numbered in run order
 * from the plan alone; the operations of records and uploads are then built
 * one bucket at a time, from the full source and destination states, into
 * files that each cover a range of slots and are sorted in memory.
 */
export async function* planOperations(args: {
  plan: Plan;
  source: SideIndex;
  target: SideIndex;
  directory: string;
  assetFiles: boolean;
  signal?: AbortSignal;
}): AsyncGenerator<Operation> {
  const { plan, source, target, signal } = args;
  const schema = plan.metadata.schema;
  const context: Context = {
    plan,
    source,
    target,
    schema,
    models: new Map(schema.models.map((model) => [model.id, model])),
    assetFiles: args.assetFiles,
  };
  const estimates: number[] = [];
  const assign = (characters: number) => estimates.push(characters) - 1;
  const ready: Emitted[] = [];
  const memory = (operations: Operation[]) => {
    for (const operation of operations)
      ready.push({
        slot: assign(JSON.stringify(operation).length),
        seq: 0,
        operation,
      });
  };
  const records = [...plan.records.values()];
  const uploads = [...plan.uploads.values()];
  const byModel = (a: RecordPlan, b: RecordPlan) =>
    compareIds(a.modelId, b.modelId) || compareIds(a.id, b.id);
  const order =
    (key: 'createOrder' | 'publishOrder' | 'deleteOrder') =>
    (a: RecordPlan, b: RecordPlan) =>
      (a.execution?.[key] ?? 0) - (b.execution?.[key] ?? 0) || byModel(a, b);
  const writes = records.filter(
    (entry) => entry.action === 'create' || entry.action === 'update',
  );
  const recordSlots = new Map<string, Partial<Record<RecordPhase, number>>>();
  const slot = (entry: RecordPlan, phase: RecordPhase, characters: number) => {
    const slots = recordSlots.get(entry.id) ?? {};
    slots[phase] = assign(characters);
    recordSlots.set(entry.id, slots);
  };
  const uploadSlots = new Map<string, number>();
  const byId = (a: { id: string }, b: { id: string }) => compareIds(a.id, b.id);

  memory(folderWrites(context));
  for (const entry of uploads
    .filter((entry) => entry.action === 'create' || entry.action === 'update')
    .sort(byId))
    uploadSlots.set(entry.id, assign(4096));
  // The CMA appends new records to their sibling group, so creates that do
  // not depend on each other follow their desired position, and a group
  // made only of new records needs no move once every record exists.
  for (const entry of records
    .filter((entry) => entry.action === 'create')
    .sort(
      (a, b) =>
        (a.execution?.createOrder ?? 0) - (b.execution?.createOrder ?? 0) ||
        compareIds(a.modelId, b.modelId) ||
        compareIds(a.desired?.parentId ?? '', b.desired?.parentId ?? '') ||
        nullsFirst(a.desired?.position ?? null, b.desired?.position ?? null) ||
        compareIds(a.id, b.id),
    ))
    slot(entry, 'create', entry.desired!.bytes);
  const published = [...writes].sort(order('publishOrder'));
  for (const entry of published) slot(entry, 'publish', entry.desired!.bytes);
  for (const entry of published)
    if (entry.execution?.provisionalTargets)
      slot(entry, 'republish', entry.desired!.bytes);
  for (const entry of [...writes].sort(byModel))
    slot(entry, 'draft', entry.desired!.bytes);
  for (const entry of records
    .filter((entry) => entry.action === 'delete')
    .sort(order('deleteOrder')))
    slot(entry, 'delete', 512);
  for (const entry of uploads
    .filter((entry) => entry.action === 'delete')
    .sort(byId))
    uploadSlots.set(entry.id, assign(512));
  memory(folderDeletes(context));
  memory(folderOrder(context));
  memory(recordOrders(context));
  for (const entry of [...writes].sort(byModel)) slot(entry, 'schedule', 1024);

  // Ranges of slots of about RANGE_CHARACTERS each.
  const starts = [0];
  let characters = 0;
  estimates.forEach((estimate, index) => {
    if (characters && characters + estimate > RANGE_CHARACTERS) {
      starts.push(index);
      characters = 0;
    }
    characters += estimate;
  });
  const rangeOf = (slot: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= slot) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const ranges = new SpillFiles(join(args.directory, 'operations'));
  const spill = (emitted: Emitted) =>
    ranges.append(rangeOf(emitted.slot), JSON.stringify(emitted));
  for (const emitted of ready) await spill(emitted);

  // Records and uploads, one bucket at a time.
  for (const [bucket, wanted] of byBucket(recordSlots.keys(), source.buckets)) {
    assertNotAborted(signal);
    const [sources, targets] = await Promise.all([
      source.recordBucket(bucket, wanted),
      target.recordBucket(bucket, wanted),
    ]);
    for (const id of wanted)
      for (const emitted of recordOperations(
        context,
        plan.records.get(id)!,
        recordSlots.get(id)!,
        targets.get(id),
        sources.get(id),
      ))
        await spill(emitted);
    await setImmediate();
  }
  for (const [bucket, wanted] of byBucket(uploadSlots.keys(), source.buckets)) {
    assertNotAborted(signal);
    const [sources, targets] = await Promise.all([
      source.uploadBucket(bucket, wanted),
      target.uploadBucket(bucket, wanted),
    ]);
    for (const id of wanted) {
      const operation = uploadOperation(
        context,
        plan.uploads.get(id)!,
        targets.get(id),
        sources.get(id),
      );
      if (operation)
        await spill({ slot: uploadSlots.get(id)!, seq: 0, operation });
    }
  }
  await ranges.flush();

  // A record leaving its sibling group closes the gap it leaves, and the CMA
  // may give each sibling it renumbers a new version, so a later first update
  // of such a sibling cannot be locked to the destination version.
  const left = new Map<string, number>();
  for (let range = 0; range < starts.length; range++) {
    assertNotAborted(signal);
    const emitted: Emitted[] = [];
    for await (const line of ranges.lines(range))
      emitted.push(JSON.parse(line) as Emitted);
    emitted.sort((a, b) => a.slot - b.slot || a.seq - b.seq);
    for (const { operation, lock, leave } of emitted) {
      if (lock) {
        const first = left.get(lock.group);
        const renumbered =
          first !== undefined &&
          lock.position !== null &&
          first < lock.position;
        if (!renumbered) {
          const data = operation.data as JsonObject;
          data.meta = {
            ...(object(data.meta) ? data.meta : {}),
            current_version: lock.version,
          };
        }
      }
      if (leave && leave.position !== null)
        left.set(
          leave.group,
          Math.min(left.get(leave.group) ?? leave.position, leave.position),
        );
      yield operation;
    }
  }
}
