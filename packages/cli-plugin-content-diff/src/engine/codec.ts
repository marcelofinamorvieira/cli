import { createHash } from 'node:crypto';
import { ContentError } from './errors';
import type {
  BlockOwner,
  CollectionState,
  FieldSchema,
  JsonObject,
  JsonValue,
  ModelSchema,
  RecordGuard,
  RecordState,
  Reference,
  Schedules,
  SchemaState,
  UniqueValue,
  UploadState,
} from './types';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Native integer fields retain arbitrary integers; SDK JSON numbers do not. */
export function assertIntegerFieldPrecision(
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

/** Validator metadata must also survive a later exact schema restoration. */
export function assertMetadataIntegerPrecision(
  value: unknown,
  description: string,
): void {
  const pending: Array<{ value: unknown; path: string }> = [
    { value, path: description },
  ];
  while (pending.length) {
    const current = pending.pop()!;
    if (
      typeof current.value === 'number' &&
      Number.isInteger(current.value) &&
      !Number.isSafeInteger(current.value)
    )
      throw new ContentError(
        'UNSUPPORTED_INTEGER_PRECISION',
        `Numeric metadata ${current.path} cannot be represented as an exact safe integer.`,
        { path: current.path },
      );
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index++)
        pending.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
        });
    } else if (object(current.value)) {
      for (const [key, entry] of Object.entries(current.value))
        pending.push({ value: entry, path: `${current.path}.${key}` });
    }
  }
}

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
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        const entry = json(value[key]);
        if (key === '__proto__')
          Object.defineProperty(result, key, {
            value: entry,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        else result[key] = entry;
      }
    }
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

export function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContentError('INVALID_RESPONSE', `Missing ${name}.`);
  }
  return value;
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function timestamp(value: unknown, name: string): string {
  const text = string(value, name);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()))
    throw new ContentError('INVALID_TIMESTAMP', `Invalid ${name}.`);
  return date.toISOString();
}

export function referenceId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return object(value) && typeof value.id === 'string' ? value.id : null;
}

function blockModelId(value: Record<string, unknown>): string {
  if (typeof value.__itemTypeId === 'string') return value.__itemTypeId;
  if (object(value.item_type) && typeof value.item_type.id === 'string')
    return value.item_type.id;
  if (object(value.relationships) && object(value.relationships.item_type)) {
    const data = value.relationships.item_type.data;
    if (object(data) && typeof data.id === 'string') return data.id;
  }
  throw new ContentError(
    'INVALID_BLOCK',
    'Nested block has no model identity.',
  );
}

const modelIndexes = new WeakMap<
  SchemaState,
  { models: ModelSchema[]; index: Map<string, ModelSchema> }
>();

/** Schemas are immutable during a capture/plan; retain one index per schema. */
export function modelIndex(schema: SchemaState): Map<string, ModelSchema> {
  const cached = modelIndexes.get(schema);
  if (
    cached &&
    cached.models === schema.models &&
    cached.index.size === schema.models.length
  )
    return cached.index;
  const index = new Map(schema.models.map((entry) => [entry.id, entry]));
  modelIndexes.set(schema, { models: schema.models, index });
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

function mapDocumentBlocks(
  value: JsonValue,
  map: (entry: JsonValue) => JsonValue,
): JsonValue {
  const copy = json(value);
  const pending: JsonValue[] = [copy];
  while (pending.length) {
    const node = pending.pop();
    if (!object(node)) continue;
    if (node.type === 'block' || node.type === 'inlineBlock') {
      if (!Object.hasOwn(node, 'item'))
        throw new ContentError(
          'INVALID_BLOCK',
          'DAST block is missing its item.',
        );
      node.item = map(json(node.item));
    }
    if (object(node.document)) {
      const document = json(node.document);
      node.document = document;
      pending.push(document);
    }
    if (Array.isArray(node.children)) {
      for (let index = 0; index < node.children.length; index += 1) {
        const child = json(node.children[index]);
        node.children[index] = child;
        pending.push(child);
      }
    }
  }
  return copy;
}

function mapBlocks(
  value: JsonValue,
  type: string,
  map: (entry: JsonValue) => JsonValue,
): JsonValue {
  if (value === null) return null;
  if (type === 'rich_text') {
    if (!Array.isArray(value))
      throw new ContentError(
        'INVALID_BLOCK',
        'Modular Content must be an array.',
      );
    return value.map(map);
  }
  if (type === 'single_block') return value === null ? null : map(value);
  if (type === 'structured_text') return mapDocumentBlocks(value, map);
  return json(value);
}

function mapFields(
  fields: Record<string, unknown>,
  modelId: string,
  schema: SchemaState,
  transform: (value: JsonValue) => JsonValue,
): JsonObject {
  const result: JsonObject = {};
  for (const field of model(schema, modelId).fields) {
    // A rounded native integer remains outside the safe range. Refuse it
    // before fingerprinting or writing; JSON strings and float fields retain
    // their distinct native semantics, including inside nested blocks.
    assertIntegerFieldPrecision(field, fields[field.apiKey], modelId);
    const value =
      fields[field.apiKey] === undefined ? null : json(fields[field.apiKey]);
    if (field.localized && value !== null) {
      if (!object(value))
        throw new ContentError(
          'INVALID_LOCALE',
          `Field ${field.apiKey} is not locale-keyed.`,
        );
      const locales: JsonObject = {};
      for (const locale of Object.keys(value).sort())
        locales[locale] = mapBlocks(json(value[locale]), field.type, transform);
      result[field.apiKey] = locales;
    } else {
      result[field.apiKey] = mapBlocks(value, field.type, transform);
    }
  }
  return result;
}

export function canonicalFields(
  fields: Record<string, unknown>,
  modelId: string,
  schema: SchemaState,
): JsonObject {
  return mapFields(fields, modelId, schema, (value) => {
    if (!object(value))
      throw new ContentError(
        'INVALID_BLOCK',
        'Nested read returned a block reference without its content.',
      );
    const id = string(value.id, 'block ID');
    const typeId = blockModelId(value);
    if (!model(schema, typeId).block)
      throw new ContentError(
        'INVALID_BLOCK',
        'Nested content references a regular record model.',
      );
    const attributes = object(value.attributes) ? value.attributes : value;
    return {
      id,
      __itemTypeId: typeId,
      attributes: canonicalFields(attributes, typeId, schema),
    };
  });
}

export function recordPayloadFields(
  fields: JsonObject,
  modelId: string,
  schema: SchemaState,
  options: { validation?: boolean } = {},
): JsonObject {
  return payloadFields(fields, modelId, schema, options);
}

function payloadFields(
  fields: JsonObject,
  modelId: string,
  schema: SchemaState,
  options: { validation?: boolean },
  nativeBlocks?: WeakSet<object>,
): JsonObject {
  return mapFields(fields, modelId, schema, (value) => {
    if (!object(value))
      throw new ContentError(
        'INVALID_BLOCK',
        'Executable block is not an object.',
      );
    const typeId = blockModelId(value);
    if (!model(schema, typeId).block)
      throw new ContentError(
        'INVALID_BLOCK',
        'Executable block references a regular record model.',
      );
    const attributes = object(value.attributes) ? value.attributes : value;
    const result: JsonObject = {
      type: 'item',
      attributes: payloadFields(
        jsonObject(attributes),
        typeId,
        schema,
        options,
        nativeBlocks,
      ),
      relationships: { item_type: { data: { type: 'item_type', id: typeId } } },
    };
    if (!options.validation) result.id = string(value.id, 'block ID');
    nativeBlocks?.add(result);
    return result;
  });
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
    payloadFields(fields, modelId, schema, {}, nativeBlocks),
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

export function recordGuard(record: RecordState): RecordGuard {
  return {
    hash: record.hash,
    modelId: record.modelId,
    currentVersion: record.currentVersion,
    publishedUpdatedAt: record.publishedUpdatedAt,
    parentId: record.parentId,
    position: record.position,
    schedules: record.schedules,
    validity: record.validity,
  };
}

export function canonicalRecord(
  current: unknown,
  published: unknown | null,
  schema: SchemaState,
  schedules: Schedules = { publication: null, unpublishing: null },
): RecordState {
  if (!object(current) || !object(current.meta))
    throw new ContentError('INVALID_RESPONSE', 'Record has no metadata.');
  const id = string(current.id, 'record ID');
  const modelId = blockModelId(current);
  const meta = current.meta;
  if (typeof meta.is_current_version_valid !== 'boolean')
    throw new ContentError('INVALID_RESPONSE', 'Record validity is missing.');
  const pub = published === null ? null : jsonObject(published);
  if (
    pub &&
    (pub.id !== id || blockModelId(pub) !== modelId || !object(pub.meta))
  ) {
    throw new ContentError(
      'INVALID_RESPONSE',
      'Published record identity is inconsistent.',
    );
  }
  if (pub && typeof meta.is_published_version_valid !== 'boolean')
    throw new ContentError(
      'INVALID_RESPONSE',
      'Published record validity is missing.',
    );
  const state: RecordState = {
    id,
    modelId,
    current: canonicalFields(
      object(current.attributes) ? current.attributes : current,
      modelId,
      schema,
    ),
    published: pub
      ? canonicalFields(
          object(pub.attributes) ? pub.attributes : pub,
          modelId,
          schema,
        )
      : null,
    currentVersion: nullableString(meta.current_version),
    publishedUpdatedAt:
      pub && object(pub.meta) ? nullableString(pub.meta.updated_at) : null,
    createdAt: timestamp(meta.created_at, 'creation timestamp'),
    firstPublishedAt:
      meta.first_published_at === null || meta.first_published_at === undefined
        ? null
        : timestamp(meta.first_published_at, 'first publication timestamp'),
    parentId: nullableString(
      object(current.attributes)
        ? current.attributes.parent_id
        : current.parent_id,
    ),
    position:
      typeof (object(current.attributes)
        ? current.attributes.position
        : current.position) === 'number'
        ? Number(
            object(current.attributes)
              ? current.attributes.position
              : current.position,
          )
        : null,
    stage: nullableString(meta.stage),
    schedules,
    validity: {
      current: meta.is_current_version_valid,
      published: pub ? meta.is_published_version_valid === true : null,
    },
    hash: '',
  };
  state.hash = recordHash(state);
  return state;
}

export function canonicalUpload(input: unknown): UploadState {
  if (!object(input))
    throw new ContentError('INVALID_RESPONSE', 'Upload is not an object.');
  const id = string(input.id, 'upload ID');
  const collection =
    object(input.relationships) && object(input.relationships.upload_collection)
      ? referenceId(input.relationships.upload_collection.data)
      : referenceId(input.upload_collection);
  const resource = object(input.attributes)
    ? { ...input.attributes, id }
    : input;
  if (!object(resource))
    throw new ContentError(
      'INVALID_RESPONSE',
      'Upload attributes are missing.',
    );
  const basename = string(resource.basename, 'upload basename');
  const format = nullableString(resource.format);
  const filename =
    typeof resource.filename === 'string'
      ? resource.filename
      : `${basename}${format ? `.${format}` : ''}`;
  const attributes: JsonObject = { basename };
  for (const key of [
    'author',
    'copyright',
    'notes',
    'tags',
    'default_field_metadata',
  ]) {
    if (resource[key] !== undefined) attributes[key] = json(resource[key]);
  }
  const metadata = attributes.default_field_metadata;
  if (object(metadata) && !Object.hasOwn(metadata, 'focal_point')) {
    const alt: JsonObject = {};
    const title: JsonObject = {};
    const customData: JsonObject = {};
    let focalPoint: JsonValue = null;
    let posterTime: JsonValue = null;
    let first = true;
    for (const [locale, entry] of Object.entries(metadata)) {
      if (!object(entry))
        throw new ContentError(
          'INVALID_RESPONSE',
          'Upload locale metadata is invalid.',
        );
      alt[locale] = json(entry.alt);
      title[locale] = json(entry.title);
      customData[locale] = json(entry.custom_data);
      if (first) {
        focalPoint = json(entry.focal_point);
        posterTime = json(entry.poster_time);
        first = false;
      } else if (
        stableStringify(entry.focal_point) !== stableStringify(focalPoint) ||
        stableStringify(entry.poster_time) !== stableStringify(posterTime)
      ) {
        throw new ContentError(
          'UNSUPPORTED_UPLOAD_METADATA',
          'Upload focal point or poster time differs between locales and cannot be reproduced through the CMA client.',
        );
      }
    }
    attributes.default_field_metadata = {
      alt,
      title,
      custom_data: customData,
      focal_point: focalPoint,
      poster_time: posterTime,
    };
  }
  const state: UploadState = {
    id,
    md5: string(resource.md5, 'upload checksum').toLowerCase(),
    size: typeof resource.size === 'number' ? resource.size : -1,
    url: string(resource.url, 'upload URL'),
    filename,
    collectionId: collection,
    attributes,
    hash: '',
  };
  if (state.size < 0)
    throw new ContentError('INVALID_RESPONSE', 'Upload size is missing.');
  state.hash = hashJson({
    id,
    md5: state.md5,
    size: state.size,
    filename,
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

export function canonicalCollection(resource: unknown): CollectionState {
  if (!object(resource))
    throw new ContentError(
      'INVALID_RESPONSE',
      'Upload collection is not an object.',
    );
  const attributes = object(resource.attributes)
    ? resource.attributes
    : resource;
  const parent =
    object(resource.relationships) && object(resource.relationships.parent)
      ? resource.relationships.parent.data
      : resource.parent;
  if (
    typeof attributes.position !== 'number' ||
    !Number.isSafeInteger(attributes.position)
  )
    throw new ContentError(
      'INVALID_RESPONSE',
      'Upload collection position is missing or invalid.',
    );
  const state = {
    id: string(resource.id, 'collection ID'),
    label: string(attributes.label, 'collection label'),
    parentId: referenceId(parent),
    position: attributes.position,
    hash: '',
  };
  state.hash = collectionHash(state);
  return state;
}

function fieldRequired(field: FieldSchema): boolean {
  if (Object.hasOwn(field.validators, 'required')) return true;
  for (const key of ['size', 'length']) {
    const validator = field.validators[key];
    if (
      object(validator) &&
      typeof validator.min === 'number' &&
      validator.min > 0
    )
      return true;
  }
  return false;
}

export function inspectRecord(
  record: RecordState,
  schema: SchemaState,
): {
  references: Reference[];
  blockOwners: BlockOwner[];
  uniqueValues: UniqueValue[];
} {
  const references: Reference[] = [];
  const blockOwners: BlockOwner[] = [];
  const uniqueValues: UniqueValue[] = [];
  const models = modelIndex(schema);
  for (const slice of ['current', 'published'] as const) {
    const rootFields = record[slice];
    if (rootFields === null) continue;
    const pending: Array<{
      fields: JsonObject;
      modelId: string;
      path: string;
      required: boolean;
    }> = [
      { fields: rootFields, modelId: record.modelId, path: '', required: true },
    ];
    while (pending.length) {
      const owner = pending.pop();
      if (!owner) break;
      const ownerModel = models.get(owner.modelId);
      if (!ownerModel)
        throw new ContentError('INVALID_MODEL', 'Block model is missing.');
      for (const field of ownerModel.fields) {
        const raw = owner.fields[field.apiKey] ?? null;
        const values: Array<[string, unknown]> =
          field.localized && object(raw) ? Object.entries(raw) : [['', raw]];
        for (const [locale, unknownValue] of values) {
          const value = json(unknownValue);
          const path = `${owner.path}${field.apiKey}${
            locale ? `.${locale}` : ''
          }`;
          const required = owner.required && fieldRequired(field);
          const add = (targetId: string, kind: Reference['kind']) =>
            references.push({
              ownerId: record.id,
              targetId,
              kind,
              path,
              fieldId: field.id,
              required,
            });
          const block = (entry: JsonValue) => {
            if (!object(entry))
              throw new ContentError(
                'INVALID_BLOCK',
                'Block content is missing.',
              );
            const blockId = string(entry.id, 'block ID');
            const blockType = blockModelId(entry);
            const blockPath = `${path}.block:${blockId}`;
            blockOwners.push({
              blockId,
              recordId: record.id,
              modelId: blockType,
              path,
              slice,
            });
            pending.push({
              fields: jsonObject(entry.attributes),
              modelId: blockType,
              path: `${blockPath}.`,
              required,
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
            const nodes: JsonValue[] = [value];
            while (nodes.length) {
              const node = nodes.pop();
              if (!object(node)) continue;
              if (node.type === 'block' || node.type === 'inlineBlock')
                block(json(node.item));
              else if (node.type === 'inlineItem' || node.type === 'itemLink') {
                const target = referenceId(node.item);
                if (target) add(target, slice);
              }
              if (object(node.document)) nodes.push(json(node.document));
              if (Array.isArray(node.children))
                for (const child of node.children) nodes.push(json(child));
            }
          }
          if (
            ownerModel.id === record.modelId &&
            Object.hasOwn(field.validators, 'unique') &&
            value !== null &&
            // Native uniqueness excludes Rails blank strings. Unicode space
            // includes NEL but excludes BOM, unlike JavaScript trim().
            !(typeof value === 'string' && /^\p{White_Space}*$/u.test(value))
          ) {
            const rule = field.validators.unique;
            const normalized =
              typeof value === 'string' &&
              object(rule) &&
              rule.case_sensitive === false
                ? value.toLowerCase()
                : value;
            uniqueValues.push({
              recordId: record.id,
              modelId: record.modelId,
              fieldId: field.id,
              locale,
              slice,
              valueKey: stableStringify(normalized),
            });
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
        required: true,
      });
  }
  return { references, blockOwners, uniqueValues };
}
