import { createHash } from 'node:crypto';
import { ContentError } from './errors';
import type {
  CollectionState,
  FieldSchema,
  JsonObject,
  JsonValue,
  ModelSchema,
  RecordState,
  Reference,
  Schedules,
  SchemaState,
  UploadState,
} from './types';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Native integer fields retain arbitrary integers; SDK JSON numbers do not. */
function assertIntegerFieldPrecision(
  field: Pick<FieldSchema, 'type' | 'localized' | 'apiKey'>,
  value: unknown,
  modelId: string,
): void {
  if (field.type !== 'integer') return;
  const check = (entry: unknown, locale?: string): void => {
    if (typeof entry === 'number' && !Number.isSafeInteger(entry))
      throw new ContentError(
        'UNSUPPORTED_INTEGER_PRECISION',
        `Integer field ${modelId}.${field.apiKey}${
          locale ? `.${locale}` : ''
        } cannot be represented as an exact safe integer.`,
        { modelId, field: field.apiKey, ...(locale ? { locale } : {}) },
      );
  };
  if (field.localized && object(value))
    for (const [locale, entry] of Object.entries(value)) check(entry, locale);
  else check(value);
}

/** Sets an own property, including `__proto__`, which plain assignment would treat as the prototype. */
function assign(target: JsonObject, key: string, value: JsonValue): void {
  if (key === '__proto__')
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  else target[key] = value;
}

/** A copy with sorted keys and without undefined properties. */
export function json(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value))
    return value === 0 ? 0 : value;
  if (Array.isArray(value)) return value.map(json);
  if (object(value)) {
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort())
      if (value[key] !== undefined) assign(result, key, json(value[key]));
    return result;
  }
  throw new ContentError('INVALID_JSON', 'Content contains a non-JSON value.');
}

export function jsonObject(value: unknown): JsonObject {
  if (!object(value))
    throw new ContentError('INVALID_RESPONSE', 'Expected a JSON object.');
  return json(value) as JsonObject;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(json(value));
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A CMA timestamp in one UTC form, so equal instants compare equal. */
export function timestamp(value: string): string {
  return new Date(value).toISOString();
}

export function referenceId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return object(value) && typeof value.id === 'string' ? value.id : null;
}

/** The model of a record or block in the CMA's JSON:API shape. */
export function itemTypeId(resource: unknown): string {
  return (
    resource as { relationships: { item_type: { data: { id: string } } } }
  ).relationships.item_type.data.id;
}

const modelIndexes = new WeakMap<SchemaState, Map<string, ModelSchema>>();

/** Schemas are never mutated once read, so one index per schema object. */
function modelIndex(schema: SchemaState): Map<string, ModelSchema> {
  let index = modelIndexes.get(schema);
  if (!index) {
    index = new Map(schema.models.map((entry) => [entry.id, entry]));
    modelIndexes.set(schema, index);
  }
  return index;
}

function model(schema: SchemaState, id: string): ModelSchema {
  const found = modelIndex(schema).get(id);
  if (!found)
    throw new ContentError(
      'INVALID_MODEL',
      `Content refers to unknown model ${id}.`,
    );
  return found;
}

/*
 * Field values come in two shapes, and every walker below accepts exactly one:
 *
 * - Native: the CMA's JSON:API record attributes, as `GET /items?nested=true`
 *   returns them and as write payloads send them. A block is
 *   `{ type: 'item', id, attributes, relationships: { item_type: { data: { id } } } }`.
 *   `canonicalFields` reads this shape; `recordPayloadFields` writes it.
 * - Canonical: what `RecordState` stores. A block is
 *   `{ id, __itemTypeId, attributes }`, its attributes canonical too.
 *   `recordPayloadFields` and `recordReferences` read this shape.
 *
 * Blocks sit in Modular Content arrays, single block values, and the `item` of
 * `block`/`inlineBlock` nodes reachable through a DAST value's `document` and
 * `children`. The SDK's block utilities are asynchronous and resolve block
 * models through a schema repository, so these synchronous walkers use the
 * captured schema instead. Each value is copied exactly once: a block's
 * attributes are copied by the call that converts the block, never by the
 * levels above it.
 */

/** A copy of a DAST value whose block items are converted with `block`. */
function documentValue(
  node: unknown,
  block: (value: unknown) => JsonValue,
): JsonValue {
  if (!object(node)) return json(node);
  const isBlock = node.type === 'block' || node.type === 'inlineBlock';
  const result: JsonObject = {};
  for (const key of Object.keys(node).sort()) {
    const entry = node[key];
    if (entry === undefined) continue;
    assign(
      result,
      key,
      isBlock && key === 'item'
        ? block(entry)
        : key === 'document'
          ? documentValue(entry, block)
          : key === 'children' && Array.isArray(entry)
            ? entry.map((child) => documentValue(child, block))
            : json(entry),
    );
  }
  return result;
}

const BLOCK_FIELD_TYPES = new Set([
  'rich_text',
  'single_block',
  'structured_text',
]);

/** A copy of one locale's value of a field, its blocks converted with `block`. */
function fieldValue(
  value: unknown,
  type: string,
  block: (value: unknown) => JsonValue,
): JsonValue {
  if (value === null) return null;
  if (type === 'rich_text') return (value as unknown[]).map(block);
  if (type === 'single_block') return block(value);
  if (type === 'structured_text') return documentValue(value, block);
  return json(value);
}

/** A copy of a record's or block's fields in schema order. */
function mapFields(
  fields: Record<string, unknown>,
  modelId: string,
  schema: SchemaState,
  block: (value: unknown) => JsonValue,
): JsonObject {
  const result: JsonObject = {};
  for (const field of model(schema, modelId).fields) {
    const value = fields[field.apiKey] ?? null;
    // A rounded native integer remains outside the safe range. Refuse it
    // before fingerprinting or writing; JSON strings and float fields retain
    // their distinct native semantics, including inside nested blocks.
    assertIntegerFieldPrecision(field, value, modelId);
    if (field.localized && object(value)) {
      const locales: JsonObject = {};
      for (const locale of Object.keys(value).sort())
        if (value[locale] !== undefined)
          locales[locale] = fieldValue(value[locale], field.type, block);
      result[field.apiKey] = locales;
    } else {
      result[field.apiKey] = fieldValue(value, field.type, block);
    }
  }
  return result;
}

/** Canonical fields from native record or block attributes. */
export function canonicalFields(
  fields: Record<string, unknown>,
  modelId: string,
  schema: SchemaState,
): JsonObject {
  return mapFields(fields, modelId, schema, (value) => {
    // Capture reads models with block fields nested; a bare block ID here
    // means that choice missed a field type that holds blocks.
    if (!object(value) || !object(value.attributes))
      throw new ContentError(
        'INVALID_BLOCK',
        'Nested read returned a block reference without its content.',
      );
    const typeId = itemTypeId(value);
    return {
      id: value.id as string,
      __itemTypeId: typeId,
      attributes: canonicalFields(value.attributes, typeId, schema),
    };
  });
}

/** The parts of a canonical block, or an INVALID_BLOCK error. */
function canonicalBlock(value: unknown): {
  id: string;
  modelId: string;
  attributes: JsonObject;
} {
  if (
    !object(value) ||
    typeof value.__itemTypeId !== 'string' ||
    !object(value.attributes)
  )
    throw new ContentError('INVALID_BLOCK', 'Block content is missing.');
  return {
    id: value.id as string,
    modelId: value.__itemTypeId,
    attributes: value.attributes as JsonObject,
  };
}

/** Native CMA write payload fields from canonical fields. */
export function recordPayloadFields(
  fields: JsonObject,
  modelId: string,
  schema: SchemaState,
  nativeBlocks?: WeakSet<object>,
): JsonObject {
  return mapFields(fields, modelId, schema, (value) =>
    nativeBlock(value, schema, nativeBlocks),
  );
}

/** A canonical block as a complete native block. */
function nativeBlock(
  value: unknown,
  schema: SchemaState,
  nativeBlocks?: WeakSet<object>,
): JsonObject {
  const block = canonicalBlock(value);
  const result: JsonObject = {
    type: 'item',
    id: block.id,
    attributes: recordPayloadFields(
      block.attributes,
      block.modelId,
      schema,
      nativeBlocks,
    ),
    relationships: {
      item_type: { data: { type: 'item_type', id: block.modelId } },
    },
  };
  nativeBlocks?.add(result);
  return result;
}

/**
 * Native CMA update payload for the fields of `after` that differ from
 * `before`. Inside a changed field, a block that keeps its ID and model in the
 * same field and locale is sent as its bare ID when unchanged, or as
 * `{ type, id, attributes }` with only its changed attributes; the CMA keeps
 * an existing block's other content. New blocks are sent in full.
 */
export function recordUpdatePayloadFields(
  before: JsonObject | null,
  after: JsonObject,
  modelId: string,
  schema: SchemaState,
): JsonObject {
  const result: JsonObject = {};
  for (const field of model(schema, modelId).fields) {
    const key = field.apiKey;
    if (!Object.hasOwn(after, key)) continue;
    const value = after[key] ?? null;
    const known = before !== null && Object.hasOwn(before, key);
    const previous = known ? before[key] : null;
    if (known && hashJson(previous) === hashJson(value)) continue;
    assertIntegerFieldPrecision(field, value, modelId);
    const convert = (next: unknown, old: unknown) =>
      fieldValue(next, field.type, updatedBlock(old, field.type, schema));
    if (field.localized && object(value)) {
      const locales: JsonObject = {};
      for (const locale of Object.keys(value).sort())
        if (value[locale] !== undefined)
          locales[locale] = convert(
            value[locale],
            object(previous) ? previous[locale] : null,
          );
      result[key] = locales;
    } else {
      result[key] = convert(value, previous);
    }
  }
  return result;
}

/** Converts the blocks of a field's new value against its previous value. */
function updatedBlock(
  previous: unknown,
  type: string,
  schema: SchemaState,
): (value: unknown) => JsonValue {
  const existing = new Map<string, ReturnType<typeof canonicalBlock>>();
  if (
    BLOCK_FIELD_TYPES.has(type) &&
    previous !== null &&
    previous !== undefined
  )
    fieldValue(previous, type, (value) => {
      const block = canonicalBlock(value);
      existing.set(block.id, block);
      return null;
    });
  return (value) => {
    const block = canonicalBlock(value);
    const old = existing.get(block.id);
    if (!old || old.modelId !== block.modelId)
      return nativeBlock(value, schema);
    if (hashJson(old.attributes) === hashJson(block.attributes))
      return block.id;
    return {
      type: 'item',
      id: block.id,
      attributes: recordUpdatePayloadFields(
        old.attributes,
        block.attributes,
        block.modelId,
        schema,
      ),
    };
  };
}

/** Report content the SDK's recursive item request/response adapters mishandle. */
export function unsupportedRecordPayloadKey(
  fields: JsonObject,
  modelId: string,
  schema: SchemaState,
): string | undefined {
  // Adapt blocks first: their canonical __itemTypeId annotations are expected
  // to disappear. An identically named key in native custom_data is content,
  // but the SDK also removes it (and loses own __proto__ properties). JSON
  // fields are strings in the CMA contract and remain opaque here. Track only
  // schema-identified block wrappers: an opaque object with type='item' is
  // mistaken for a record by the SDK response adapter after a successful write.
  const nativeBlocks = new WeakSet<object>();
  const pending: JsonValue[] = [
    recordPayloadFields(fields, modelId, schema, nativeBlocks),
  ];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (object(value)) {
      if (value.type === 'item' && !nativeBlocks.has(value)) return 'type';
      for (const [key, item] of Object.entries(value)) {
        if (key === '__itemTypeId' || key === '__proto__') return key;
        pending.push(item as JsonValue);
      }
    }
  }
  return undefined;
}

export function recordHash(
  record: Omit<RecordState, 'hash'> | RecordState,
): string {
  return hashJson({
    id: record.id,
    modelId: record.modelId,
    current: record.current,
    published: record.published,
    createdAt: record.createdAt,
    firstPublishedAt: record.firstPublishedAt,
    parentId: record.parentId,
    stage: record.stage,
    schedules: record.schedules,
  });
}

type NativeRecord = Record<string, unknown> & {
  id: string;
  attributes: Record<string, unknown>;
  meta: Record<string, unknown>;
};

/** A record's scheduled publication or unpublishing as the CMA returns it. */
export interface ScheduleResource {
  id: string;
  type: string;
  attributes: JsonObject;
}

/**
 * One record as the CMA returns it: its current version, its published
 * version, and its schedules. This is a line of a dump's `records` entries.
 */
export interface RecordLine {
  id: string;
  current: unknown;
  published: unknown | null;
  scheduledPublication: ScheduleResource | null;
  scheduledUnpublishing: ScheduleResource | null;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === 'string' ? timestamp(value) : null;
}

const sortedLocales = (value: unknown) => [...(value as string[])].sort();

/** A record's schedules from the resources the CMA returns for them. */
export function canonicalSchedules(
  publication: ScheduleResource | null,
  unpublishing: ScheduleResource | null,
): Schedules {
  const selective = publication?.attributes.selective_publication as {
    content_in_locales: string[];
    non_localized_content: boolean;
  } | null;
  const locales = unpublishing?.attributes.content_in_locales;
  return {
    publication: publication
      ? {
          at: timestamp(
            publication.attributes.publication_scheduled_at as string,
          ),
          selective: selective
            ? {
                locales: sortedLocales(selective.content_in_locales),
                nonLocalized: selective.non_localized_content,
              }
            : null,
        }
      : null,
    unpublishing: unpublishing
      ? {
          at: timestamp(
            unpublishing.attributes.unpublishing_scheduled_at as string,
          ),
          locales:
            locales === null || locales === undefined
              ? null
              : sortedLocales(locales),
        }
      : null,
  };
}

/** A record's state from its native current and published resources. */
export function canonicalRecord(
  current: unknown,
  published: unknown | null,
  schema: SchemaState,
  schedules: Schedules = { publication: null, unpublishing: null },
): RecordState {
  const { id, meta, attributes } = current as NativeRecord;
  const pub = published as NativeRecord | null;
  const modelId = itemTypeId(current as NativeRecord);
  const state: RecordState = {
    id,
    modelId,
    current: canonicalFields(attributes, modelId, schema),
    published: pub ? canonicalFields(pub.attributes, modelId, schema) : null,
    currentVersion: nullableString(meta.current_version),
    publishedUpdatedAt: pub ? nullableString(pub.meta.updated_at) : null,
    createdAt: timestamp(meta.created_at as string),
    firstPublishedAt: optionalTimestamp(meta.first_published_at),
    parentId: nullableString(attributes.parent_id),
    position:
      typeof attributes.position === 'number' ? attributes.position : null,
    stage: nullableString(meta.stage),
    schedules,
    hash: '',
  };
  const invalid = {
    current: meta.is_current_version_valid === false,
    published: meta.is_published_version_valid === false,
  };
  if (invalid.current || invalid.published) state.invalid = invalid;
  state.hash = recordHash(state);
  return state;
}

/** A record's state from a dump or capture line. */
export function canonicalRecordLine(
  line: RecordLine,
  schema: SchemaState,
): RecordState {
  return canonicalRecord(
    line.current,
    line.published,
    schema,
    canonicalSchedules(line.scheduledPublication, line.scheduledUnpublishing),
  );
}

/**
 * The value of a record's `title` or `name` string field, in the first
 * locale that has one, shortened for labels.
 */
export function recordTitle(
  modelId: string,
  schema: SchemaState,
  current: JsonObject | undefined,
): string | undefined {
  const fields = modelIndex(schema).get(modelId)?.fields;
  for (const key of ['title', 'name']) {
    const field = fields?.find(
      (field) => field.apiKey === key && field.type === 'string',
    );
    if (!field) continue;
    const value = current?.[key];
    let title: string | undefined;
    if (typeof value === 'string') title = value;
    else if (field.localized && object(value))
      for (const locale of schema.locales)
        if (typeof value[locale] === 'string' && value[locale]) {
          title = value[locale];
          break;
        }
    if (title) return title.length > 121 ? title.slice(0, 121) : title;
  }
  return undefined;
}

/**
 * An upload as the SDK's `uploads.list` returns it: flat attributes,
 * `upload_collection` as `{ id }` or null, and `default_field_metadata`
 * field-keyed in every environment.
 */
export function canonicalUpload(input: unknown): UploadState {
  const upload = input as Record<string, unknown> & {
    id: string;
    basename: string;
    size: number;
    md5: string;
    url: string;
    filename: string;
  };
  const { id } = upload;
  const attributes: JsonObject = { basename: upload.basename };
  for (const key of [
    'author',
    'copyright',
    'notes',
    'tags',
    'default_field_metadata',
  ]) {
    if (upload[key] !== undefined) attributes[key] = json(upload[key]);
  }
  const state: UploadState = {
    id,
    md5: upload.md5.toLowerCase(),
    size: upload.size,
    url: upload.url,
    filename: upload.filename,
    collectionId: referenceId(upload.upload_collection),
    attributes,
    hash: '',
  };
  state.hash = hashJson({
    id,
    md5: state.md5,
    size: state.size,
    filename: state.filename,
    collectionId: state.collectionId,
    attributes,
  });
  return state;
}

export function collectionHash(
  state: Pick<CollectionState, 'id' | 'label' | 'parentId' | 'position'>,
): string {
  return hashJson({
    id: state.id,
    label: state.label,
    parentId: state.parentId,
    position: state.position,
  });
}

/** An upload collection as the SDK's `uploadCollections.list` returns it. */
export function canonicalCollection(resource: unknown): CollectionState {
  const collection = resource as {
    id: string;
    label: string;
    parent: unknown;
    position: number;
  };
  const state = {
    id: collection.id,
    label: collection.label,
    parentId: referenceId(collection.parent),
    position: collection.position,
    hash: '',
  };
  state.hash = collectionHash(state);
  return state;
}

/**
 * Every record, upload and parent a record's current and published fields
 * refer to, including references held inside nested blocks.
 */
export function recordReferences(
  record: RecordState,
  schema: SchemaState,
): Reference[] {
  const references: Reference[] = [];
  for (const slice of ['current', 'published'] as const) {
    const rootFields = record[slice];
    if (rootFields === null) continue;
    const pending: Array<{
      fields: JsonObject;
      modelId: string;
      path: string;
    }> = [{ fields: rootFields, modelId: record.modelId, path: '' }];
    while (pending.length) {
      const owner = pending.pop();
      if (!owner) break;
      for (const field of model(schema, owner.modelId).fields) {
        const raw = owner.fields[field.apiKey] ?? null;
        const values: Array<[string, unknown]> =
          field.localized && object(raw) ? Object.entries(raw) : [['', raw]];
        for (const [locale, value] of values) {
          const path = `${owner.path}${field.apiKey}${
            locale ? `.${locale}` : ''
          }`;
          const add = (targetId: string, kind: Reference['kind']) =>
            references.push({
              ownerId: record.id,
              targetId,
              kind,
              path,
              fieldId: field.id,
            });
          const block = (entry: unknown) => {
            const { id, modelId, attributes } = canonicalBlock(entry);
            pending.push({
              fields: attributes,
              modelId,
              path: `${path}.block:${id}.`,
            });
          };
          if (field.type === 'link') {
            const target = referenceId(value);
            if (target) add(target, slice);
          } else if (field.type === 'links' && Array.isArray(value)) {
            for (const entry of value) {
              const target = referenceId(entry);
              if (target) add(target, slice);
            }
          } else if (
            field.type === 'file' &&
            object(value) &&
            typeof value.upload_id === 'string'
          ) {
            add(value.upload_id, 'upload');
          } else if (field.type === 'gallery' && Array.isArray(value)) {
            for (const entry of value)
              if (object(entry) && typeof entry.upload_id === 'string')
                add(entry.upload_id, 'upload');
          } else if (
            field.type === 'seo' &&
            object(value) &&
            typeof value.image === 'string'
          ) {
            add(value.image, 'upload');
          } else if (field.type === 'rich_text' && Array.isArray(value)) {
            for (const entry of value) block(entry);
          } else if (field.type === 'single_block' && value !== null) {
            block(value);
          } else if (field.type === 'structured_text') {
            const nodes: unknown[] = [value];
            while (nodes.length) {
              const node = nodes.pop();
              if (!object(node)) continue;
              if (node.type === 'block' || node.type === 'inlineBlock')
                block(node.item);
              else if (node.type === 'inlineItem' || node.type === 'itemLink') {
                const target = referenceId(node.item);
                if (target) add(target, slice);
              }
              if (object(node.document)) nodes.push(node.document);
              if (Array.isArray(node.children)) nodes.push(...node.children);
            }
          }
        }
      }
    }
    if (record.parentId)
      references.push({
        ownerId: record.id,
        targetId: record.parentId,
        kind: slice,
        path: 'parentId',
        fieldId: '',
      });
  }
  return references;
}
