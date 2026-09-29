// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { FieldSchemaSnapshot, JsonObject, JsonValue } from '../types';
import { isObject } from './json';

/**
 * Maps the block slots of a field value, one locale at a time for localized
 * fields. A localized value that is not a locale object is mapped as a whole.
 */
export function mapFieldBlocks(
  value: JsonValue,
  field: Pick<FieldSchemaSnapshot, 'fieldType' | 'localized'>,
  mapper: (block: JsonValue) => JsonValue,
): JsonValue {
  if (field.localized && isEmbeddedJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([locale, localizedValue]) => [
        locale,
        mapNonLocalizedFieldBlocks(localizedValue, field.fieldType, mapper),
      ]),
    );
  }
  return mapNonLocalizedFieldBlocks(value, field.fieldType, mapper);
}

/** Maps only block slots owned by the field, leaving JSON metadata untouched. */
export function mapNonLocalizedFieldBlocks(
  value: JsonValue,
  fieldType: string,
  mapper: (block: JsonValue) => JsonValue,
): JsonValue {
  if (fieldType === 'single_block') return mapper(value);
  if (fieldType === 'rich_text') {
    return Array.isArray(value) ? value.map(mapper) : value;
  }
  if (
    fieldType !== 'structured_text' ||
    !isEmbeddedJsonObject(value) ||
    !isEmbeddedJsonObject(value.document)
  ) {
    return value;
  }
  return {
    ...value,
    document: mapStructuredTextBlockNodes(value.document, mapper),
  };
}

/**
 * Maps the `item` of every Structured Text block and inline block node in a
 * DAST tree. Other nodes and their metadata are copied unchanged.
 */
export function mapStructuredTextBlockNodes(
  value: JsonValue,
  mapper: (block: JsonValue) => JsonValue,
): JsonValue {
  if (!isEmbeddedJsonObject(value)) return value;
  const result = { ...value };
  if (value.type === 'block' || value.type === 'inlineBlock') {
    if (Object.prototype.hasOwnProperty.call(value, 'item')) {
      result.item = mapper(value.item);
    }
  }
  if (Array.isArray(value.children)) {
    result.children = value.children.map((child) =>
      mapStructuredTextBlockNodes(child, mapper),
    );
  }
  return result;
}

function isEmbeddedJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return isObject(value);
}
