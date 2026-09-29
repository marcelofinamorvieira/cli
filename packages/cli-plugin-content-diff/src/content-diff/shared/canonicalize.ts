// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  JsonValue,
  RecordScheduleSnapshot,
  RecordSnapshot,
  RecordValiditySnapshot,
  RecordVersionSnapshot,
  SchemaSnapshot,
  UploadCollectionSnapshot,
  UploadSnapshot,
} from '../types';
import { sharedFailure } from './failure-factory';
import { canonicalizeJson, isObject, semanticHash } from './json';
import {
  type NestedBlockIdentity,
  itemTypesById,
  nestedBlockFields,
  nestedBlockIdentity,
} from './nested-blocks';
import { compareStrings } from './ordering';

/** The schema parts canonicalization reads: block models and locale order. */
export type CanonicalizationSchema = Pick<
  SchemaSnapshot,
  'itemTypes' | 'locales'
>;

/** An upload's canonical state without the planner-only `transport`. */
export type CanonicalUploadState = Omit<UploadSnapshot, 'transport'>;

interface CanonicalizationContext {
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>;
  locales: readonly string[];
}

/** Record resource keys that are CMA metadata, never content fields. */
export const ITEM_RESERVED_KEYS = new Set([
  '__itemTypeId',
  'created_at',
  'creator',
  'current_version',
  'editor',
  'first_published_at',
  'has_children',
  'id',
  'is_current',
  'is_current_version_valid',
  'is_published',
  'is_published_version_valid',
  'is_valid',
  'item_type',
  'meta',
  'parent_id',
  'position',
  'publication_scheduled_at',
  'published_at',
  'published_from',
  'published_until',
  'relationships',
  'stage',
  'status',
  'type',
  'unpublishing_scheduled_at',
  'updated_at',
]);

export function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw sharedFailure(
      'malformedContent',
      `The CMA response is missing ${path}.`,
      { path },
    );
  }

  return value;
}

export function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw sharedFailure(
      'malformedContent',
      `The CMA response is missing boolean ${path}.`,
      { path },
    );
  }

  return value;
}

export function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw sharedFailure(
      'malformedContent',
      `The CMA response is missing ${path}.`,
      { path },
    );
  }

  return value;
}

export function canonicalTimestamp(value: unknown, path: string): string {
  const text = requiredString(value, path);
  const milliseconds = Date.parse(text);

  if (!Number.isFinite(milliseconds)) {
    throw sharedFailure(
      'malformedContent',
      `The CMA response contains an invalid timestamp at ${path}.`,
      { path },
    );
  }

  return new Date(milliseconds).toISOString();
}

/**
 * Orders a locale-keyed object by the project locale order, then by code
 * unit, dropping undefined members and canonicalizing every value.
 */
export function sortLocalizedObject(
  value: unknown,
  localeOrder: readonly string[],
): JsonObject {
  if (!isObject(value)) {
    throw sharedFailure(
      'malformedContent',
      'A localized field contains a value that is not an object.',
    );
  }

  const rank = new Map(localeOrder.map((locale, index) => [locale, index]));

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => {
        const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;

        return leftRank - rightRank || compareStrings(left, right);
      })
      .map(([locale, child]) => [locale, canonicalizeJson(child)]),
  );
}

/** Field order of the schema snapshot: position, then field ID. */
export function compareFieldSnapshots(
  left: FieldSchemaSnapshot,
  right: FieldSchemaSnapshot,
): number {
  return left.position - right.position || compareStrings(left.id, right.id);
}

export function canonicalizeRecord(
  currentInput: unknown,
  publishedInput: unknown | null,
  itemType: ItemTypeSchemaSnapshot,
  schema: CanonicalizationSchema,
  schedules: RecordScheduleSnapshot,
): RecordSnapshot {
  const context = canonicalizationContext(schema);
  const currentItem = assertItemResource(currentInput);
  const publishedItem =
    publishedInput === null ? null : assertItemResource(publishedInput);
  const current = canonicalizeItemVersion(currentItem, itemType, context);
  const published = publishedItem
    ? canonicalizeItemVersion(publishedItem, itemType, context)
    : null;
  const currentMeta = isObject(currentItem.meta) ? currentItem.meta : {};
  const publishedMeta =
    publishedItem && isObject(publishedItem.meta) ? publishedItem.meta : null;
  const validity = canonicalizeRecordValidity(
    currentItem.id,
    currentMeta,
    publishedMeta,
  );
  const canonicalSchedules = canonicalizeSchedules(schedules, schema.locales);

  const snapshotState = {
    id: currentItem.id,
    itemTypeId: itemType.id,
    current,
    published,
    topology: {
      parentId:
        typeof currentItem.parent_id === 'string'
          ? currentItem.parent_id
          : null,
      position:
        typeof currentItem.position === 'number' ? currentItem.position : null,
    },
    lifecycle: {
      createdAt: canonicalTimestamp(currentMeta.created_at, 'meta.created_at'),
      firstPublishedAt:
        typeof currentMeta.first_published_at === 'string'
          ? canonicalTimestamp(
              currentMeta.first_published_at,
              'meta.first_published_at',
            )
          : null,
    },
    validity,
    stage: typeof currentMeta.stage === 'string' ? currentMeta.stage : null,
    schedules: canonicalSchedules,
  };
  const { validity: _validity, ...semanticState } = snapshotState;

  return {
    ...snapshotState,
    hash: semanticHash({
      ...semanticState,
      // Absolute sibling positions are deliberately not conflict state: a
      // retained destination-only sibling can shift every following record.
      topology: { parentId: snapshotState.topology.parentId },
    }),
    consistency: {
      currentVersion: requiredString(
        currentMeta.current_version,
        'meta.current_version',
      ),
      updatedAt: requiredString(currentMeta.updated_at, 'meta.updated_at'),
      publishedAt:
        typeof currentMeta.published_at === 'string'
          ? currentMeta.published_at
          : null,
      currentValid: validity.current,
      publishedValid: validity.published,
    },
  };
}

function canonicalizeRecordValidity(
  recordId: string,
  currentMeta: Record<string, unknown>,
  publishedMeta: Record<string, unknown> | null,
): RecordValiditySnapshot {
  const current = requiredBoolean(
    currentMeta.is_current_version_valid,
    `record ${recordId} meta.is_current_version_valid`,
  );
  const currentSlice = requiredBoolean(
    currentMeta.is_valid,
    `record ${recordId} current meta.is_valid`,
  );

  if (current !== currentSlice) {
    throw sharedFailure(
      'malformedContent',
      `Record ${recordId} reports inconsistent current validity flags.`,
      { recordId },
    );
  }

  if (!publishedMeta) {
    return { current, published: null };
  }

  const published = requiredBoolean(
    currentMeta.is_published_version_valid,
    `record ${recordId} meta.is_published_version_valid`,
  );
  const publishedSlice = requiredBoolean(
    publishedMeta.is_valid,
    `record ${recordId} published meta.is_valid`,
  );

  if (published !== publishedSlice) {
    throw sharedFailure(
      'malformedContent',
      `Record ${recordId} reports inconsistent published validity flags.`,
      { recordId },
    );
  }

  return { current, published };
}

export function canonicalizeRecordVersion(
  input: unknown,
  itemType: ItemTypeSchemaSnapshot,
  schema: CanonicalizationSchema,
): RecordVersionSnapshot {
  return canonicalizeItemVersion(
    assertItemResource(input),
    itemType,
    canonicalizationContext(schema),
  );
}

function canonicalizationContext(
  schema: CanonicalizationSchema,
): CanonicalizationContext {
  return { itemTypes: itemTypesById(schema), locales: schema.locales };
}

function canonicalizeItemVersion(
  item: Record<string, any> & { id: string },
  itemType: ItemTypeSchemaSnapshot,
  context: CanonicalizationContext,
): RecordVersionSnapshot {
  const fields = canonicalizeRecordFields(
    recordFieldContainer(item, itemType),
    itemType,
    context,
    '',
  );

  return { fields, hash: semanticHash(fields) };
}

/**
 * The object holding a record's fields: its own `attributes` object for the
 * JSON:API shape, unless the model has a field named `attributes`, in which
 * case the resource is flat and `attributes` is that field.
 */
function recordFieldContainer(
  item: Record<string, any>,
  itemType: ItemTypeSchemaSnapshot,
): Record<string, any> {
  return isObject(item.attributes) &&
    !itemType.fields.some(({ apiKey }) => apiKey === 'attributes')
    ? item.attributes
    : item;
}

function canonicalizeRecordFields(
  attributes: Record<string, any>,
  itemType: ItemTypeSchemaSnapshot,
  context: CanonicalizationContext,
  prefix: string,
): JsonObject {
  const fields: Array<[string, JsonValue]> = [];
  const fieldKeys = new Set<string>();

  for (const field of [...itemType.fields].sort(compareFieldSnapshots)) {
    if (!Object.prototype.hasOwnProperty.call(attributes, field.apiKey)) {
      continue;
    }

    fieldKeys.add(field.apiKey);
    fields.push([
      field.apiKey,
      canonicalizeFieldValue(
        attributes[field.apiKey],
        field,
        context,
        prefix ? `${prefix}.${field.apiKey}` : field.apiKey,
      ),
    ]);
  }

  // Preserve unknown attributes instead of silently erasing content when the
  // client receives a newer response shape than this generator knows about.
  for (const key of Object.keys(attributes).sort(compareStrings)) {
    if (
      ITEM_RESERVED_KEYS.has(key) ||
      fieldKeys.has(key) ||
      attributes[key] === undefined
    ) {
      continue;
    }

    fields.push([key, canonicalizeJson(attributes[key])]);
  }

  return Object.fromEntries(fields);
}

function canonicalizeFieldValue(
  input: unknown,
  field: FieldSchemaSnapshot,
  context: CanonicalizationContext,
  fieldPath: string,
): JsonValue {
  if (field.localized) {
    if (!isObject(input)) {
      return canonicalizeJson(input);
    }

    const ordered = sortLocalizedObject(input, context.locales);

    return Object.fromEntries(
      Object.entries(ordered).map(([locale, value]) => [
        locale,
        canonicalizeNonLocalizedFieldValue(value, field, context, fieldPath),
      ]),
    );
  }

  return canonicalizeNonLocalizedFieldValue(input, field, context, fieldPath);
}

function canonicalizeNonLocalizedFieldValue(
  input: unknown,
  field: FieldSchemaSnapshot,
  context: CanonicalizationContext,
  fieldPath: string,
): JsonValue {
  if (field.fieldType === 'structured_text') {
    if (!isObject(input) || !isObject(input.document)) {
      return canonicalizeJson(input);
    }
    return canonicalizeJson({
      ...input,
      document: canonicalizeStructuredTextNode(
        input.document,
        context,
        fieldPath,
      ),
    });
  }

  if (field.fieldType === 'rich_text' || field.fieldType === 'single_block') {
    return canonicalizeEmbeddedContent(input, context, fieldPath);
  }

  return canonicalizeJson(input);
}

function canonicalizeStructuredTextNode(
  input: unknown,
  context: CanonicalizationContext,
  fieldPath: string,
): JsonValue {
  if (!isObject(input)) return canonicalizeJson(input);

  const output = { ...input };
  if (
    (input.type === 'block' || input.type === 'inlineBlock') &&
    input.item !== undefined
  ) {
    output.item = canonicalizeEmbeddedContent(input.item, context, fieldPath);
  }
  if (Array.isArray(input.children)) {
    output.children = input.children.map((child) =>
      canonicalizeStructuredTextNode(child, context, fieldPath),
    );
  }
  return canonicalizeJson(output);
}

function canonicalizeEmbeddedContent(
  input: unknown,
  context: CanonicalizationContext,
  fieldPath: string,
): JsonValue {
  if (Array.isArray(input)) {
    return input.map((value) =>
      canonicalizeEmbeddedContent(value, context, fieldPath),
    );
  }

  if (!isObject(input)) {
    return canonicalizeJson(input);
  }

  const identity = nestedBlockIdentity(input, fieldPath);
  if (identity) {
    return canonicalizeNestedItem(input, identity, context, fieldPath);
  }

  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, value]) => [
        key,
        canonicalizeEmbeddedContent(value, context, fieldPath),
      ]),
  );
}

function canonicalizeNestedItem(
  input: Record<string, any>,
  identity: NestedBlockIdentity,
  context: CanonicalizationContext,
  fieldPath: string,
): JsonObject {
  const itemType = context.itemTypes.get(identity.itemTypeId);

  if (!itemType?.modularBlock) {
    throw sharedFailure(
      'malformedContent',
      `Nested item ${identity.id} refers to unknown block model ${identity.itemTypeId}.`,
      { blockId: identity.id, itemTypeId: identity.itemTypeId, fieldPath },
    );
  }

  return {
    id: identity.id,
    type: 'item',
    relationships: {
      item_type: {
        data: { id: identity.itemTypeId, type: 'item_type' },
      },
    },
    attributes: canonicalizeRecordFields(
      nestedBlockFields(input, fieldPath),
      itemType,
      context,
      `${fieldPath}.block:${identity.id}`,
    ),
  };
}

/**
 * Canonical upload state shared by generation and execution. The planner
 * adds its `transport` on top; the runtime compares only this state.
 */
export function canonicalizeUploadState(
  input: unknown,
  localeOrder: readonly string[],
): CanonicalUploadState {
  if (!isObject(input)) {
    throw sharedFailure(
      'malformedContent',
      'The CMA returned an invalid upload resource.',
    );
  }

  const meta = isObject(input.meta) ? input.meta : {};
  const antivirus = isObject(meta.antivirus) ? meta.antivirus : {};
  const antivirusStatus = antivirus.status;

  if (
    antivirusStatus !== 'pending' &&
    antivirusStatus !== 'clean' &&
    antivirusStatus !== 'infected' &&
    antivirusStatus !== 'failed' &&
    antivirusStatus !== 'skipped'
  ) {
    throw sharedFailure(
      'malformedContent',
      `Upload ${String(input.id)} has an unknown antivirus status.`,
    );
  }

  if (
    antivirusStatus === 'pending' ||
    antivirusStatus === 'infected' ||
    antivirusStatus === 'failed'
  ) {
    throw sharedFailure(
      'unhealthyUpload',
      `Upload ${String(
        input.id,
      )} cannot be migrated while antivirus status is ${antivirusStatus}.`,
      { uploadId: String(input.id), antivirusStatus },
    );
  }

  const uploadCollection = isObject(input.upload_collection)
    ? input.upload_collection
    : null;
  const metadata = canonicalizeDefaultFieldMetadata(
    input.default_field_metadata,
    localeOrder,
  );
  const manual = {
    author: typeof input.author === 'string' ? input.author : null,
    copyright: typeof input.copyright === 'string' ? input.copyright : null,
    notes: typeof input.notes === 'string' ? input.notes : null,
    defaultFieldMetadata: metadata,
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.map(String))].sort()
      : [],
    collectionId:
      uploadCollection && typeof uploadCollection.id === 'string'
        ? uploadCollection.id
        : null,
  };
  const semanticState = {
    id: requiredString(input.id, 'upload.id'),
    md5: requiredString(input.md5, 'upload.md5'),
    basename: requiredString(input.basename, 'upload.basename'),
    filename: requiredString(input.filename, 'upload.filename'),
    manual,
  };

  return {
    ...semanticState,
    size: requiredNumber(input.size, 'upload.size'),
    mimeType: typeof input.mime_type === 'string' ? input.mime_type : null,
    hash: semanticHash(semanticState),
    consistency: {
      updatedAt: typeof input.updated_at === 'string' ? input.updated_at : null,
      antivirusStatus,
    },
  };
}

/**
 * Field-keyed metadata must hold locale objects under alt, title and
 * custom_data; anything else is malformed rather than silently kept.
 */
function canonicalizeDefaultFieldMetadata(
  input: unknown,
  localeOrder: readonly string[],
): JsonObject {
  if (!isObject(input)) {
    return {};
  }

  const fieldKeyed = [
    'alt',
    'title',
    'custom_data',
    'focal_point',
    'poster_time',
  ].some((key) => Object.prototype.hasOwnProperty.call(input, key));

  // The CMA client converts the legacy locale-keyed shape to the field-keyed
  // one, so this only sees it from a raw call. It is kept as it is, for the
  // upload contract to reject rather than to be reshaped here.
  if (!fieldKeyed) {
    return sortLocalizedObject(input, localeOrder);
  }

  const result: JsonObject = {};

  for (const key of ['alt', 'title', 'custom_data'] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = sortLocalizedObject(input[key], localeOrder);
    }
  }

  for (const key of ['focal_point', 'poster_time'] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = canonicalizeJson(input[key]);
    }
  }

  return result;
}

export function canonicalizeUploadCollection(
  input: unknown,
): UploadCollectionSnapshot {
  if (!isObject(input)) {
    throw sharedFailure(
      'malformedContent',
      'The CMA returned an invalid upload collection resource.',
    );
  }

  const parent = isObject(input.parent) ? input.parent : null;
  const semanticState = {
    id: requiredString(input.id, 'uploadCollection.id'),
    label: requiredString(input.label, 'uploadCollection.label'),
    parentId: parent
      ? requiredString(parent.id, 'uploadCollection.parent.id')
      : null,
    position: requiredNumber(input.position, 'uploadCollection.position'),
  };

  return { ...semanticState, hash: semanticHash(semanticState) };
}

export function canonicalizeSchedules(
  schedules: RecordScheduleSnapshot,
  localeOrder: readonly string[],
): RecordScheduleSnapshot {
  const localeRank = new Map(
    localeOrder.map((locale, index) => [locale, index]),
  );
  const sortLocales = (locales: readonly string[]) =>
    [...new Set(locales)].sort((left, right) => {
      const leftRank = localeRank.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = localeRank.get(right) ?? Number.MAX_SAFE_INTEGER;

      return leftRank - rightRank || compareStrings(left, right);
    });

  return {
    publication: schedules.publication
      ? {
          at: canonicalTimestamp(
            schedules.publication.at,
            'schedule.publication.at',
          ),
          selective: schedules.publication.selective
            ? {
                locales: sortLocales(schedules.publication.selective.locales),
                nonLocalized: schedules.publication.selective.nonLocalized,
              }
            : null,
        }
      : null,
    unpublishing: schedules.unpublishing
      ? {
          at: canonicalTimestamp(
            schedules.unpublishing.at,
            'schedule.unpublishing.at',
          ),
          locales: schedules.unpublishing.locales
            ? sortLocales(schedules.unpublishing.locales)
            : null,
        }
      : null,
  };
}

function assertItemResource(value: unknown): Record<string, any> & {
  id: string;
} {
  if (!isObject(value) || typeof value.id !== 'string') {
    throw sharedFailure(
      'malformedContent',
      'The CMA returned an invalid record resource.',
    );
  }

  return value as Record<string, any> & { id: string };
}
