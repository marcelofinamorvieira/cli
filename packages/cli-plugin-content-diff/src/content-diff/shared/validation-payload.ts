// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  JsonValue,
} from '../types';
import { mapNonLocalizedFieldBlocks } from './embedded-blocks';
import { sharedFailure } from './failure-factory';
import { isObject } from './json';
import {
  type ItemTypeLookup,
  type NestedBlockIdentity,
  itemTypesById,
  nestedBlockFields,
  nestedBlockIdentity,
} from './nested-blocks';

const VALIDATION_PAYLOAD_EMBEDDED_FIELD_TYPES: ReadonlySet<string> = new Set([
  'rich_text',
  'single_block',
  'structured_text',
]);

/**
 * Converts canonical snapshot fields into a body that the high-level CMA item
 * validation methods can serialize safely. Nested block IDs are deliberately
 * omitted: a published block can have the same parent but no longer belong to
 * the current field/locale slot used by `validateExisting()`. Treating every
 * embedded block as a validation-only new payload preserves its model and
 * complete recursive content without triggering that ownership check.
 */
export function buildRecordValidationPayload(
  fields: JsonObject,
  itemTypeId: string,
  lookup: ItemTypeLookup,
): JsonObject {
  const itemTypes = itemTypesById(lookup);
  const itemType = itemTypes.get(itemTypeId);
  if (!itemType) {
    throw sharedFailure(
      'invalidPlan',
      `Validation payload refers to unknown item type ${itemTypeId}.`,
      { itemTypeId },
    );
  }

  return convertValidationRecordFields(fields, itemType, itemTypes);
}

/**
 * Converts the embedded fields of one record or block. Field paths join API
 * keys with dots and enter a block as `.block:<id>`.
 */
export function convertValidationRecordFields(
  fields: JsonObject,
  itemType: ItemTypeSchemaSnapshot,
  lookup: ItemTypeLookup,
  prefix = '',
): JsonObject {
  const itemTypes = itemTypesById(lookup);
  const fieldsByApiKey = new Map(
    itemType.fields.map((field) => [field.apiKey, field]),
  );

  return Object.fromEntries(
    Object.entries(fields).map(([apiKey, value]) => {
      const field = fieldsByApiKey.get(apiKey);
      const fieldPath = prefix ? `${prefix}.${apiKey}` : apiKey;
      return [
        apiKey,
        field
          ? convertValidationFieldValue(value, field, itemTypes, fieldPath)
          : value,
      ];
    }),
  );
}

/**
 * Converts every nested block inside an embedded value into a validation-only
 * new payload, recursively. Other values are copied unchanged.
 */
export function convertValidationEmbeddedValue(
  value: JsonValue,
  lookup: ItemTypeLookup,
  fieldPath: string,
): JsonValue {
  const itemTypes = itemTypesById(lookup);
  if (Array.isArray(value)) {
    return value.map((child) =>
      convertValidationEmbeddedValue(child, itemTypes, fieldPath),
    );
  }

  if (!isValidationPayloadJsonObject(value)) return value;
  const identity = nestedBlockIdentity(value, fieldPath);
  if (identity) {
    return convertValidationNestedBlock(value, identity, itemTypes, fieldPath);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      convertValidationEmbeddedValue(child, itemTypes, fieldPath),
    ]),
  );
}

/**
 * Converts the block slots of a field value, one locale at a time for
 * localized fields. A localized value that is not a locale object is copied
 * unchanged, as canonicalization keeps it as plain JSON.
 */
function convertValidationFieldValue(
  value: JsonValue,
  field: FieldSchemaSnapshot,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  fieldPath: string,
): JsonValue {
  if (!VALIDATION_PAYLOAD_EMBEDDED_FIELD_TYPES.has(field.fieldType)) {
    return value;
  }

  const convert = (input: JsonValue): JsonValue =>
    mapNonLocalizedFieldBlocks(input, field.fieldType, (block) =>
      convertValidationEmbeddedValue(block, itemTypes, fieldPath),
    );
  if (!field.localized) return convert(value);
  if (!isValidationPayloadJsonObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([locale, localizedValue]) => [
      locale,
      convert(localizedValue),
    ]),
  );
}

function convertValidationNestedBlock(
  block: JsonObject,
  identity: NestedBlockIdentity,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  fieldPath: string,
): JsonObject {
  const itemType = itemTypes.get(identity.itemTypeId);
  if (!itemType) {
    throw sharedFailure(
      'invalidPlan',
      `Nested validation payload refers to unknown model ${identity.itemTypeId}.`,
      { itemTypeId: identity.itemTypeId },
    );
  }

  if (!itemType.modularBlock) {
    throw sharedFailure(
      'invalidPlan',
      `Nested validation payload refers to non-block model ${identity.itemTypeId}.`,
      { itemTypeId: identity.itemTypeId },
    );
  }

  return {
    type: 'item',
    attributes: convertValidationRecordFields(
      nestedBlockFields(block, fieldPath) as JsonObject,
      itemType,
      itemTypes,
      `${fieldPath}.block:${identity.id}`,
    ),
    relationships: {
      item_type: {
        data: { id: identity.itemTypeId, type: 'item_type' },
      },
    },
  };
}

function isValidationPayloadJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return isObject(value);
}
