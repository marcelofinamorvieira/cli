import { basename } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { assertNotAborted } from './cancellation';
import {
  canonicalFields,
  canonicalUpload,
  collectionHash,
  hashJson,
  inspectRecord,
  recordHash,
  recordPayloadFields,
  unsupportedRecordPayloadKey,
} from './codec';
import { ContentError } from './errors';
import { creationEmptyValue } from './planner-validity';
import type { SnapshotStore } from './store';
import type {
  BinaryFile,
  Client,
  CollectionState,
  JsonObject,
  JsonValue,
  ModelSchema,
  RecordState,
  SchemaState,
  UploadState,
} from './types';

export interface IntentValidityEvidence {
  recordId: string;
  slice: 'current' | 'published';
  fieldHash: string;
  valid: boolean;
}

export interface IntentValidation
  extends Omit<IntentValidityEvidence, 'valid'> {
  modelId: string;
  fields: JsonObject;
}

/** A verified local binary, indexed by exactly the path used in the script. */
export interface IntentBinary {
  localPath: string;
  binary: BinaryFile;
  filename: string;
  /** Original source URL is provenance only; execution uses verified bytes. */
  url?: string;
}

export interface IntentBinaryBinding {
  uploadId: string;
  asset: IntentBinary;
}

export interface IntentRecorder {
  /** Only the explicitly supported mutation methods are available. */
  client: Client;
  needsValidation(): Generator<IntentValidation>;
  resolveValidity(evidence: IntentValidityEvidence): void;
  /** Seal further calls and drain every submitted local operation. */
  drain(): Promise<void>;
  /** Must succeed before createPlan is called. Unknown validity is not truth. */
  assertReady(): void;
  binaryBindings(): Generator<IntentBinaryBinding>;
}

function invalid(message: string): never {
  throw new ContentError('INVALID_MIGRATION_INTENT', message);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value: unknown, label = 'identity'): string {
  const result = object(value) ? value.id : value;
  if (typeof result !== 'string' || !result || result.trim() !== result)
    invalid(`An explicit stable ${label} is required.`);
  return result;
}

function data(value: unknown, label = 'payload'): JsonObject {
  if (!object(value)) invalid(`Invalid ${label}.`);
  // JSON.stringify would silently erase undefined/functions and round NaN.
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const entry = pending.pop();
    if (entry === null || ['string', 'boolean'].includes(typeof entry))
      continue;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) invalid(`Non-finite number in ${label}.`);
    } else if (Array.isArray(entry)) {
      if (visited.has(entry)) continue;
      visited.add(entry);
      pending.push(...entry);
    } else if (object(entry)) {
      if (visited.has(entry)) continue;
      visited.add(entry);
      const prototype = Object.getPrototypeOf(entry);
      // A transpiled script can run in another VM realm, with its own Object.
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
        invalid(`Only plain objects are supported in ${label}.`);
      pending.push(...Object.values(entry));
    } else invalid(`Non-JSON value in ${label}.`);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    invalid(`Circular or unserializable value in ${label}.`);
  }
}

function only(
  value: Record<string, unknown>,
  keys: Iterable<string>,
  label: string,
): void {
  const permitted = new Set(keys);
  for (const key of Object.keys(value))
    if (!permitted.has(key)) invalid(`Unsupported ${label} property: ${key}.`);
}

function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    invalid(`An explicit ${label} timestamp is required.`);
  return new Date(value).toISOString();
}

function nullableIdentity(value: unknown, label: string): string | null {
  return value === null ? null : identity(value, label);
}

function position(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    invalid('An explicit safe integer position is required.');
  return value;
}

/**
 * Record local CMA-shaped intent, then feed its resulting desired state into
 * createPlan. No CMA request is made here. The planner may reorder writes and
 * introduce safe seeds; this is deliberately not a remote API emulator.
 */
export function createIntentRecorder(args: {
  store: SnapshotStore;
  schema: SchemaState;
  binaries?: Iterable<IntentBinary>;
  binaryLookup?: (localPath: string) => IntentBinary | undefined;
  validityEvidence?: Iterable<IntentValidityEvidence>;
  allowedModelIds?: Iterable<string>;
  signal?: AbortSignal;
}): IntentRecorder {
  const { store, schema } = args;
  const db = store.database;
  const models = new Map(schema.models.map((model) => [model.id, model]));
  const allowed = new Set(
    args.allowedModelIds ??
      schema.models.filter((m) => !m.block).map((m) => m.id),
  );
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS migration_intent_evidence (
      id TEXT, slice TEXT, hash TEXT, valid INTEGER NOT NULL,
      PRIMARY KEY(id,slice,hash)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS migration_intent_unknown (
      id TEXT, slice TEXT, hash TEXT, PRIMARY KEY(id,slice)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS migration_intent_binaries (
      path TEXT PRIMARY KEY, data TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS migration_intent_upload_binary (
      id TEXT PRIMARY KEY, path TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS migration_intent_shift (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL
    ) WITHOUT ROWID;
    DELETE FROM migration_intent_evidence;
    DELETE FROM migration_intent_unknown;
    DELETE FROM migration_intent_binaries;
    DELETE FROM migration_intent_upload_binary;
  `);
  const evidenceInsert = db.prepare(
    'INSERT OR REPLACE INTO migration_intent_evidence VALUES(?,?,?,?)',
  );
  const binaryInsert = db.prepare(
    'INSERT INTO migration_intent_binaries VALUES(?,?)',
  );
  db.exec('SAVEPOINT migration_intent_initialize');
  try {
    for (const evidence of args.validityEvidence ?? []) {
      if (
        !['current', 'published'].includes(evidence.slice) ||
        typeof evidence.valid !== 'boolean'
      )
        invalid('Invalid source validity evidence.');
      evidenceInsert.run(
        identity(evidence.recordId),
        evidence.slice,
        evidence.fieldHash,
        Number(evidence.valid),
      );
    }
    for (const asset of args.binaries ?? []) {
      identity(asset.localPath, 'binary path');
      if (
        !Number.isSafeInteger(asset.binary.bytes) ||
        asset.binary.bytes < 0 ||
        !/^[a-f0-9]{32}$/.test(asset.binary.md5) ||
        !/^[a-f0-9]{64}$/.test(asset.binary.sha256)
      )
        invalid('Invalid verified binary descriptor.');
      binaryInsert.run(asset.localPath, JSON.stringify(asset));
    }
    // Copy the complete target namespace on disk. Unmentioned identities must
    // remain present, otherwise a partial script could become a mass deletion.
    for (const table of [
      'records',
      'uploads',
      'collections',
      'refs',
      'block_owners',
      'unique_values',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE side='source'`).run();
      const columns = (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name);
      db.exec(
        `INSERT INTO ${table} SELECT 'source',${columns
          .slice(1)
          .join(',')} FROM ${table} WHERE side='target'`,
      );
    }
    db.exec('RELEASE migration_intent_initialize');
  } catch (error) {
    db.exec(
      'ROLLBACK TO migration_intent_initialize; RELEASE migration_intent_initialize',
    );
    throw error;
  }

  const modelFor = (modelId: string): ModelSchema => {
    const model = models.get(modelId);
    if (!model || model.block || !allowed.has(modelId))
      invalid(`Model ${modelId} is outside the migration scope.`);
    return model;
  };
  const getRecord = (value: unknown): RecordState => {
    const id = identity(value, 'record ID');
    const state = store.getRecord('source', id);
    if (!state) invalid(`Record ${id} does not exist in the intended state.`);
    modelFor(state.modelId);
    return state;
  };
  const knownValidity = (
    state: RecordState,
    slice: 'current' | 'published',
    old?: RecordState,
  ): boolean | null => {
    const fields = state[slice];
    const outstanding = db
      .prepare(
        'SELECT hash FROM migration_intent_unknown WHERE id=? AND slice=?',
      )
      .get(state.id, slice);
    db.prepare(
      'DELETE FROM migration_intent_unknown WHERE id=? AND slice=?',
    ).run(state.id, slice);
    if (fields === null) return null;
    const hash = hashJson(fields);
    if (old?.[slice] && hashJson(old[slice]) === hash) {
      if (!outstanding) return old.validity[slice];
    }
    const evidence = db
      .prepare(
        'SELECT valid FROM migration_intent_evidence WHERE id=? AND slice=? AND hash=?',
      )
      .get(state.id, slice, hash);
    if (evidence) return Boolean(evidence.valid);
    const baseline = store.getRecord('target', state.id);
    for (const baselineSlice of ['current', 'published'] as const) {
      if (
        baseline?.[baselineSlice] &&
        hashJson(baseline[baselineSlice]) === hash
      )
        return baseline.validity[baselineSlice];
    }
    db.prepare('INSERT INTO migration_intent_unknown VALUES(?,?,?)').run(
      state.id,
      slice,
      hash,
    );
    // The existing RecordState type is API-only and cannot represent unknown.
    // Keep a conservative placeholder, tracked above; assertReady refuses it.
    return false;
  };
  const putRecord = (state: RecordState, old?: RecordState): void => {
    const unsupported =
      unsupportedRecordPayloadKey(state.current, state.modelId, schema) ??
      (state.published
        ? unsupportedRecordPayloadKey(state.published, state.modelId, schema)
        : undefined);
    if (unsupported)
      invalid(
        `Record ${state.id} contains unsupported SDK metadata ${unsupported}.`,
      );
    state.validity = {
      current: knownValidity(state, 'current', old) === true,
      published: knownValidity(state, 'published', old),
    };
    state.hash = recordHash(state);
    const inspected = inspectRecord(state, schema);
    store.putRecord('source', state);
    for (const ref of inspected.references) store.putReference('source', ref);
    for (const owner of inspected.blockOwners)
      store.putBlockOwner('source', owner);
    for (const value of inspected.uniqueValues)
      store.putUniqueValue('source', value);
  };
  const response = (state: RecordState): JsonObject => ({
    id: state.id,
    type: 'item',
    item_type: { id: state.modelId, type: 'item_type' },
    ...recordPayloadFields(state.current, state.modelId, schema),
  });
  const metadata = (raw: unknown): JsonObject => {
    if (raw === undefined) return {};
    const meta = data(raw, 'record metadata');
    only(
      meta,
      ['created_at', 'first_published_at', 'stage'],
      'record metadata',
    );
    if ('created_at' in meta)
      meta.created_at = date(meta.created_at, 'created_at');
    if ('first_published_at' in meta && meta.first_published_at !== null)
      meta.first_published_at = date(
        meta.first_published_at,
        'first_published_at',
      );
    if ('stage' in meta && meta.stage !== null)
      identity(meta.stage, 'workflow stage');
    return meta;
  };
  const fieldsFrom = (
    body: JsonObject,
    model: ModelSchema,
    previous?: RecordState,
  ): JsonObject => {
    only(
      body,
      [
        ...model.fields.map((field) => field.apiKey),
        'id',
        'type',
        'item_type',
        'meta',
        'parent_id',
        'position',
      ],
      'record',
    );
    const fields: JsonObject = previous ? { ...previous.current } : {};
    const presentLocales = model.fields
      .filter((field) => field.localized && object(body[field.apiKey]))
      .flatMap((field) => Object.keys(body[field.apiKey] as JsonObject));
    const locales = model.allLocalesRequired
      ? schema.locales
      : [...new Set(presentLocales)];
    if (
      !previous &&
      model.fields.some((field) => field.localized) &&
      !locales.length
    )
      invalid('Creating a localized record requires an explicit locale set.');
    for (const field of model.fields) {
      if (Object.hasOwn(body, field.apiKey))
        fields[field.apiKey] = body[field.apiKey];
      else if (!previous) {
        const defaultFor = (locale?: string): JsonValue => {
          const configured =
            field.localized && object(field.defaultValue)
              ? field.defaultValue[locale!]
              : field.defaultValue;
          return configured ?? creationEmptyValue(field.type);
        };
        fields[field.apiKey] = field.localized
          ? Object.fromEntries(
              locales.map((locale) => [locale, defaultFor(locale)]),
            )
          : defaultFor();
      }
    }
    // Locale objects and nested aggregates replace the supplied field, while
    // omitted FIELD keys preserve it. Explicit null remains intent: the
    // planner decides whether native defaults need temporary suppression.
    return canonicalFields(fields, model.id, schema);
  };
  const noExtra = (args: unknown[], count: number): void => {
    if (args.slice(count).some((value) => value !== undefined))
      invalid('Unsupported CMA method options.');
  };
  const nextRecordPosition = (
    modelId: string,
    parentId: string | null,
  ): number =>
    Number(
      db
        .prepare(
          "SELECT COALESCE(MAX(position),0)+1 AS value FROM records WHERE side='source' AND model_id=? AND parent_id IS ?",
        )
        .get(modelId, parentId)!.value,
    );
  const shiftRecords = (
    id: string,
    modelId: string,
    previous: RecordState | undefined,
    next: { parentId: string | null; position: number | null } | null,
  ): void => {
    const model = modelFor(modelId);
    if (
      (!model.sortable && !model.tree) ||
      (previous &&
        next &&
        previous.parentId === next.parentId &&
        previous.position === next.position)
    )
      return;
    // Apply removal then insertion, exactly as the CMA renumbers ordered
    // siblings. Hashes exclude position; all other stored state is preserved.
    if (previous)
      db.prepare(`UPDATE records SET position=position-1,state_json=json_set(state_json,'$.position',position-1)
      WHERE side='source' AND model_id=? AND parent_id IS ? AND position>? AND id<>?`).run(
        modelId,
        previous.parentId,
        previous.position,
        id,
      );
    if (next)
      db.prepare(`UPDATE records SET position=position+1,state_json=json_set(state_json,'$.position',position+1)
      WHERE side='source' AND model_id=? AND parent_id IS ? AND position>=? AND id<>?`).run(
        modelId,
        next.parentId,
        next.position,
        id,
      );
  };
  const lifecycle = (args: unknown[]): RecordState => {
    noExtra(args, 3);
    if (args[1] !== undefined)
      invalid('Selective publication is not supported by migration intent.');
    if (args[2] !== undefined) {
      const options = data(args[2], 'publication options');
      only(options, ['recursive'], 'publication options');
      if (options.recursive !== false)
        invalid('Recursive publication is not supported by migration intent.');
    }
    return getRecord(args[0]);
  };
  const removeRecord = (id: string): void => {
    db.prepare("DELETE FROM records WHERE side='source' AND id=?").run(id);
    for (const [table, column] of [
      ['refs', 'owner_id'],
      ['block_owners', 'record_id'],
      ['unique_values', 'record_id'],
    ])
      db.prepare(
        `DELETE FROM ${table} WHERE side='source' AND ${column}=?`,
      ).run(id);
    db.prepare('DELETE FROM migration_intent_unknown WHERE id=?').run(id);
  };
  const methods: Record<
    string,
    Record<string, (...values: unknown[]) => unknown>
  > = {
    items: {
      create(...values) {
        noExtra(values, 1);
        const body = data(values[0]);
        const id = identity(body.id, 'record ID');
        if (store.getRecord('source', id))
          invalid(`Record ${id} already exists.`);
        const model = modelFor(identity(body.item_type, 'model ID'));
        const meta = metadata(body.meta);
        const fields = fieldsFrom(body, model);
        const workflow = schema.workflows.find(
          (candidate) => candidate.id === model.workflowId,
        );
        const initial = Array.isArray(workflow?.stages)
          ? workflow.stages.find(
              (candidate) => object(candidate) && candidate.initial === true,
            )
          : undefined;
        const state: RecordState = {
          id,
          modelId: model.id,
          current: fields,
          published: model.draftMode ? null : fields,
          currentVersion: null,
          publishedUpdatedAt: null,
          createdAt: date(meta.created_at, 'created_at'),
          firstPublishedAt:
            meta.first_published_at == null
              ? null
              : date(meta.first_published_at, 'first_published_at'),
          stage:
            meta.stage === undefined
              ? object(initial) && typeof initial.id === 'string'
                ? initial.id
                : null
              : nullableIdentity(meta.stage, 'workflow stage'),
          parentId: model.tree
            ? nullableIdentity(body.parent_id ?? null, 'tree parent')
            : null,
          position:
            model.tree || model.sortable
              ? position(
                  body.position ??
                    nextRecordPosition(
                      model.id,
                      model.tree
                        ? nullableIdentity(
                            body.parent_id ?? null,
                            'tree parent',
                          )
                        : null,
                    ),
                )
              : null,
          schedules: { publication: null, unpublishing: null },
          validity: {
            current: false,
            published: model.draftMode ? null : false,
          },
          hash: '',
        };
        if (!model.draftMode && !state.firstPublishedAt)
          invalid('Non-draft record creation requires first_published_at.');
        shiftRecords(id, model.id, undefined, state);
        putRecord(state);
        return response(state);
      },
      update(...values) {
        noExtra(values, 2);
        const before = getRecord(values[0]);
        const body = data(values[1]);
        if ('id' in body && identity(body.id) !== before.id)
          invalid('An update cannot change the record ID.');
        if ('item_type' in body && identity(body.item_type) !== before.modelId)
          invalid('An update cannot change the record model.');
        const model = modelFor(before.modelId);
        if ('parent_id' in body && !model.tree)
          invalid('parent_id requires a tree model.');
        if ('position' in body && !model.tree && !model.sortable)
          invalid('position requires an ordered model.');
        const meta = metadata(body.meta);
        const current = fieldsFrom(body, model, before);
        const next: RecordState = {
          ...before,
          current,
          published: model.draftMode ? before.published : current,
          createdAt:
            'created_at' in meta ? String(meta.created_at) : before.createdAt,
          firstPublishedAt:
            'first_published_at' in meta
              ? (meta.first_published_at as string | null)
              : before.firstPublishedAt,
          stage:
            'stage' in meta
              ? nullableIdentity(meta.stage, 'workflow stage')
              : before.stage,
          parentId:
            'parent_id' in body
              ? nullableIdentity(body.parent_id, 'tree parent')
              : before.parentId,
          position:
            'position' in body
              ? position(body.position)
              : 'parent_id' in body &&
                  nullableIdentity(body.parent_id, 'tree parent') !==
                    before.parentId
                ? nextRecordPosition(
                    model.id,
                    nullableIdentity(body.parent_id, 'tree parent'),
                  )
                : before.position,
        };
        shiftRecords(before.id, before.modelId, before, next);
        putRecord(next, before);
        return response(next);
      },
      publish(...values) {
        const before = lifecycle(values);
        if (!before.firstPublishedAt)
          invalid(
            'Publishing requires an explicit first_published_at in record metadata.',
          );
        const next = { ...before, published: before.current };
        putRecord(next, before);
        return response(next);
      },
      unpublish(...values) {
        const before = lifecycle(values);
        if (!modelFor(before.modelId).draftMode)
          invalid('A model without draft mode cannot be unpublished.');
        const next = { ...before, published: null };
        putRecord(next, before);
        return response(next);
      },
      destroy(...values) {
        noExtra(values, 1);
        const before = getRecord(values[0]);
        shiftRecords(before.id, before.modelId, before, null);
        removeRecord(before.id);
        return response(before);
      },
    },
  };

  for (const [resource, key, atKey] of [
    ['scheduledPublication', 'publication', 'publication_scheduled_at'],
    ['scheduledUnpublishing', 'unpublishing', 'unpublishing_scheduled_at'],
  ] as const) {
    methods[resource] = {
      create(...values) {
        noExtra(values, 2);
        const before = getRecord(values[0]);
        const body = data(values[1]);
        only(
          body,
          key === 'publication'
            ? [atKey, 'selective_publication']
            : [atKey, 'content_in_locales'],
          'schedule',
        );
        const at = date(body[atKey], atKey);
        const localeList = (value: unknown): string[] | null => {
          if (value == null) return null;
          if (
            !Array.isArray(value) ||
            !value.every(
              (locale) =>
                typeof locale === 'string' && schema.locales.includes(locale),
            )
          )
            invalid('Invalid schedule locale set.');
          return [...value] as string[];
        };
        let selective = null;
        if (key === 'publication' && body.selective_publication != null) {
          const selection = data(
            body.selective_publication,
            'selective publication',
          );
          only(
            selection,
            ['content_in_locales', 'non_localized_content'],
            'selective publication',
          );
          if (typeof selection.non_localized_content !== 'boolean')
            invalid('Selective publication needs non_localized_content.');
          selective = {
            locales: localeList(selection.content_in_locales) ?? [],
            nonLocalized: selection.non_localized_content,
          };
        }
        const schedules = {
          ...before.schedules,
          [key]:
            key === 'publication'
              ? { at, selective }
              : { at, locales: localeList(body.content_in_locales) },
        };
        putRecord({ ...before, schedules }, before);
        return { id: before.id, ...body };
      },
      destroy(...values) {
        noExtra(values, 1);
        const before = getRecord(values[0]);
        if (!before.schedules[key])
          invalid(`Record ${before.id} has no ${key} schedule.`);
        putRecord(
          { ...before, schedules: { ...before.schedules, [key]: null } },
          before,
        );
        return { id: before.id };
      },
    };
  }

  const collection = (value: unknown): CollectionState => {
    const id = identity(value, 'collection ID');
    const state = store.getCollection('source', id);
    if (!state) invalid(`Collection ${id} does not exist.`);
    return state;
  };
  const saveCollection = (
    body: JsonObject,
    old?: CollectionState,
  ): CollectionState => {
    only(body, ['id', 'type', 'label', 'position', 'parent'], 'collection');
    const id = old?.id ?? identity(body.id, 'collection ID');
    if ('id' in body && identity(body.id) !== id)
      invalid('An update cannot change the collection ID.');
    const label = body.label ?? old?.label;
    if (typeof label !== 'string' || !label)
      invalid('A collection label is required.');
    const parentId =
      'parent' in body
        ? nullableIdentity(body.parent, 'collection parent')
        : old?.parentId ?? null;
    const appendPosition = Number(
      db
        .prepare(
          "SELECT COALESCE(MAX(position),0)+1 AS value FROM collections WHERE side='source' AND parent_id IS ?",
        )
        .get(parentId)!.value,
    );
    const next: CollectionState = {
      id,
      label,
      parentId,
      position: position(old ? body.position ?? old.position : appendPosition),
      hash: '',
    };
    // Collections use inclusive ranges, even for label-only updates at a
    // duplicate position. Creation itself does not renumber siblings.
    if (old) {
      db.exec('DELETE FROM migration_intent_shift');
      if (old.parentId === next.parentId) {
        db.prepare(`INSERT INTO migration_intent_shift SELECT id,position+? FROM collections
          WHERE side='source' AND parent_id IS ? AND position BETWEEN ? AND ? AND id<>?`).run(
          next.position < old.position ? 1 : -1,
          old.parentId,
          Math.min(old.position, next.position),
          Math.max(old.position, next.position),
          id,
        );
      } else {
        db.prepare(`INSERT INTO migration_intent_shift SELECT id,position-1 FROM collections
          WHERE side='source' AND parent_id IS ? AND position>=? AND id<>?`).run(
          old.parentId,
          old.position,
          id,
        );
        db.prepare(`INSERT INTO migration_intent_shift SELECT id,position+1 FROM collections
          WHERE side='source' AND parent_id IS ? AND position>=? AND id<>?`).run(
          next.parentId,
          next.position,
          id,
        );
      }
      for (const row of db
        .prepare('SELECT id,position FROM migration_intent_shift ORDER BY id')
        .iterate()) {
        const sibling = store.getCollection('source', String(row.id))!;
        sibling.position = Number(row.position);
        sibling.hash = collectionHash(sibling);
        store.putCollection('source', sibling);
      }
    }
    next.hash = collectionHash(next);
    store.putCollection('source', next);
    return next;
  };
  methods.uploadCollections = {
    create(...values) {
      noExtra(values, 1);
      const body = data(values[0]);
      if (store.getCollection('source', identity(body.id)))
        invalid('Collection already exists.');
      return saveCollection(body);
    },
    update(...values) {
      noExtra(values, 2);
      return saveCollection(data(values[1]), collection(values[0]));
    },
    destroy(...values) {
      noExtra(values, 1);
      const before = collection(values[0]);
      db.prepare("DELETE FROM collections WHERE side='source' AND id=?").run(
        before.id,
      );
      return before;
    },
  };

  const getUpload = (value: unknown): UploadState => {
    const id = identity(value, 'upload ID');
    const state = store.getUpload('source', id);
    if (!state) invalid(`Upload ${id} does not exist.`);
    return state;
  };
  const uploadAttributes = [
    'basename',
    'author',
    'copyright',
    'notes',
    'tags',
    'default_field_metadata',
    'upload_collection',
  ];
  const saveUpload = (
    body: JsonObject,
    old?: UploadState,
    asset?: IntentBinary,
  ): UploadState => {
    const id = old?.id ?? identity(body.id, 'upload ID');
    if ('id' in body && identity(body.id) !== id)
      invalid('An update cannot change the upload ID.');
    const filename = String(
      body.filename ?? asset?.filename ?? old?.filename ?? '',
    );
    if (!filename || basename(filename) !== filename)
      invalid('A plain upload filename is required.');
    const dot = filename.lastIndexOf('.');
    const fileBase = dot < 0 ? filename : filename.slice(0, dot);
    const fileFormat = dot < 0 ? null : filename.slice(dot + 1);
    const attributes: JsonObject = old
      ? { ...old.attributes }
      : {
          basename: fileBase,
          author: null,
          copyright: null,
          notes: null,
          tags: [],
          default_field_metadata: {
            alt: Object.fromEntries(
              schema.locales.map((locale) => [locale, null]),
            ),
            title: Object.fromEntries(
              schema.locales.map((locale) => [locale, null]),
            ),
            custom_data: Object.fromEntries(
              schema.locales.map((locale) => [locale, {}]),
            ),
            focal_point: null,
            poster_time: null,
          },
        };
    for (const key of uploadAttributes) {
      if (!(key in body) || key === 'upload_collection') continue;
      if (key === 'default_field_metadata') {
        const patch = data(body[key], 'upload default metadata');
        only(
          patch,
          ['alt', 'title', 'custom_data', 'focal_point', 'poster_time'],
          'upload default metadata',
        );
        const merged = { ...(attributes[key] as JsonObject), ...patch };
        for (const localized of ['alt', 'title', 'custom_data'])
          if (localized in patch) {
            const value = patch[localized];
            if (!object(value))
              invalid(`Upload ${localized} must be locale-keyed.`);
            if (
              Object.keys(value).some(
                (locale) => !schema.locales.includes(locale),
              )
            )
              invalid('Unsupported upload metadata locale.');
            merged[localized] = {
              ...((attributes[key] as JsonObject)[localized] as JsonObject),
              ...value,
            } as JsonObject;
          }
        attributes[key] = merged;
      } else attributes[key] = body[key];
    }
    if (asset && !('basename' in body)) attributes.basename = fileBase;
    const result = canonicalUpload({
      id,
      ...attributes,
      filename: `${attributes.basename}${fileFormat ? `.${fileFormat}` : ''}`,
      format: fileFormat,
      md5: asset?.binary.md5 ?? old?.md5,
      size: asset?.binary.bytes ?? old?.size,
      url: asset?.url ?? old?.url ?? `https://migration.invalid/${id}`,
      upload_collection:
        'upload_collection' in body
          ? body.upload_collection
          : old?.collectionId
            ? { id: old.collectionId, type: 'upload_collection' }
            : null,
    });
    store.putUpload('source', result);
    return result;
  };
  const getBinary = (localPath: unknown): IntentBinary => {
    const path = identity(localPath, 'verified local binary path');
    let row = db
      .prepare('SELECT data FROM migration_intent_binaries WHERE path=?')
      .get(path);
    if (!row && args.binaryLookup) {
      const asset = args.binaryLookup(path);
      if (asset) {
        if (asset.localPath !== path)
          invalid('Binary lookup returned another path.');
        binaryInsert.run(path, JSON.stringify(asset));
        row = { data: JSON.stringify(asset) };
      }
    }
    if (!row)
      invalid(`Binary path is not in the verified migration assets: ${path}.`);
    return JSON.parse(String(row.data)) as IntentBinary;
  };
  methods.uploads = {
    createFromLocalFile(...values) {
      noExtra(values, 1);
      const body = data(values[0]);
      only(
        body,
        ['id', 'type', 'localPath', 'filename', ...uploadAttributes],
        'local upload',
      );
      const id = identity(body.id, 'upload ID');
      if (store.getUpload('source', id))
        invalid(`Upload ${id} already exists.`);
      const asset = getBinary(body.localPath);
      const result = saveUpload(body, undefined, asset);
      db.prepare(
        'INSERT OR REPLACE INTO migration_intent_upload_binary VALUES(?,?)',
      ).run(id, asset.localPath);
      return { id: result.id, ...result.attributes };
    },
    update(...values) {
      noExtra(values, 3);
      const before = getUpload(values[0]);
      const body = data(values[1]);
      only(body, ['id', 'type', 'path', ...uploadAttributes], 'upload update');
      let asset: IntentBinary | undefined;
      if ('path' in body) {
        asset = getBinary(body.path);
        const options = data(values[2], 'binary replacement options');
        only(options, ['replace_strategy'], 'binary replacement options');
        if (options.replace_strategy !== 'create_new_url')
          invalid('Binary replacement requires create_new_url.');
      } else if (values[2] !== undefined)
        invalid('Upload options require a binary replacement.');
      const result = saveUpload(body, before, asset);
      if (asset)
        db.prepare(
          'INSERT OR REPLACE INTO migration_intent_upload_binary VALUES(?,?)',
        ).run(before.id, asset.localPath);
      return { id: result.id, ...result.attributes };
    },
    destroy(...values) {
      noExtra(values, 1);
      const before = getUpload(values[0]);
      db.prepare("DELETE FROM uploads WHERE side='source' AND id=?").run(
        before.id,
      );
      db.prepare('DELETE FROM migration_intent_upload_binary WHERE id=?').run(
        before.id,
      );
      return { id: before.id };
    },
  };

  let failure: unknown;
  const reject = (message: string): never => {
    failure = new ContentError('INVALID_MIGRATION_INTENT', message);
    throw failure;
  };
  const facade = (
    entries: Record<string, unknown>,
    prefix = 'client',
  ): unknown =>
    new Proxy(Object.freeze(entries), {
      get(target, property) {
        if (property === 'then') return undefined;
        if (typeof property !== 'string' || !Object.hasOwn(target, property))
          return reject(
            `Unsupported CMA method or property: ${prefix}.${String(
              property,
            )}.`,
          );
        return target[property];
      },
      set() {
        return reject('The recording client cannot be modified.');
      },
    });
  const resources: Record<string, unknown> = {};
  let recordedCalls = 0;
  let sealed = false;
  const pending = new Set<Promise<void>>();
  for (const [resource, calls] of Object.entries(methods)) {
    const wrapped: Record<string, unknown> = {};
    for (const [name, call] of Object.entries(calls))
      wrapped[name] = (...values: unknown[]) => {
        const operation = (async () => {
          if (sealed)
            throw new ContentError(
              'INACTIVE_CONTENT_MIGRATION',
              'CMA intent cannot be recorded after the migration callback has finished.',
            );
          if (failure) throw failure;
          assertNotAborted(args.signal);
          db.exec('SAVEPOINT migration_intent_operation');
          let result: unknown;
          try {
            result = call(...values);
            db.exec('RELEASE migration_intent_operation');
          } catch (error) {
            db.exec(
              'ROLLBACK TO migration_intent_operation; RELEASE migration_intent_operation',
            );
            failure = error;
            throw error;
          }
          // Awaiting only already-resolved CMA-shaped calls would starve SIGINT
          // and timers during large local scripts. Give cancellation a turn.
          if (++recordedCalls % 64 === 0) await setImmediate();
          assertNotAborted(args.signal);
          return result;
        })();
        const observed = operation.then(
          () => {
            pending.delete(observed);
          },
          (error: unknown) => {
            failure ??= error;
            pending.delete(observed);
          },
        );
        pending.add(observed);
        return operation;
      };
    resources[resource] = facade(wrapped, `client.${resource}`);
  }
  return {
    client: facade(resources) as Client,
    *needsValidation() {
      for (const row of db
        .prepare(
          'SELECT id,slice,hash FROM migration_intent_unknown ORDER BY id,slice',
        )
        .iterate()) {
        const state = store.getRecord('source', String(row.id))!;
        const slice = String(row.slice) as 'current' | 'published';
        yield {
          recordId: state.id,
          modelId: state.modelId,
          slice,
          fieldHash: String(row.hash),
          fields: state[slice]!,
        };
      }
    },
    resolveValidity(evidence) {
      const before = getRecord(evidence.recordId);
      const fields = before[evidence.slice];
      if (
        !fields ||
        hashJson(fields) !== evidence.fieldHash ||
        typeof evidence.valid !== 'boolean'
      )
        invalid(
          'Validity evidence does not match the current recorded payload.',
        );
      evidenceInsert.run(
        before.id,
        evidence.slice,
        evidence.fieldHash,
        Number(evidence.valid),
      );
      const next = {
        ...before,
        validity: { ...before.validity, [evidence.slice]: evidence.valid },
      };
      putRecord(next);
    },
    async drain() {
      sealed = true;
      while (pending.size) await Promise.all(pending);
      if (failure) throw failure;
      assertNotAborted(args.signal);
    },
    assertReady() {
      assertNotAborted(args.signal);
      if (failure) throw failure;
      if (pending.size)
        throw new ContentError(
          'UNAWAITED_MIGRATION_INTENT',
          'Pending CMA intent must settle before planning or execution can begin.',
        );
      const unknown = db
        .prepare(
          'SELECT id,slice FROM migration_intent_unknown ORDER BY id,slice LIMIT 1',
        )
        .get();
      if (unknown)
        throw new ContentError(
          'MIGRATION_VALIDITY_REQUIRED',
          `Edited ${unknown.slice} content for record ${unknown.id} requires native validation before planning.`,
        );
    },
    *binaryBindings() {
      for (const row of db
        .prepare(
          'SELECT b.id,a.data FROM migration_intent_upload_binary b JOIN migration_intent_binaries a ON a.path=b.path ORDER BY b.id',
        )
        .iterate())
        yield {
          uploadId: String(row.id),
          asset: JSON.parse(String(row.data)) as IntentBinary,
        };
    },
  };
}
