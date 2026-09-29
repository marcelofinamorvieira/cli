// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  SchemaSnapshot,
} from '../types';
import { sharedFailure } from './failure-factory';
import { isObject } from './json';

export interface NestedBlockIdentity {
  id: string;
  itemTypeId: string;
}

/** Where a nested block sits inside its top-level record. */
export interface NestedBlockLocation {
  fieldPath: string;
  locale: string | null;
}

export type NestedBlockVisitor = (
  block: JsonObject & { id: string },
  blockType: ItemTypeSchemaSnapshot,
  location: NestedBlockLocation,
) => void;

/** A schema snapshot, or its item types already indexed by ID. */
export type ItemTypeLookup =
  | Pick<SchemaSnapshot, 'itemTypes'>
  | ReadonlyMap<string, ItemTypeSchemaSnapshot>;

/** Keys of a flat nested block that are identity metadata, not fields. */
const NESTED_BLOCK_RESERVED_KEYS = new Set([
  '__itemTypeId',
  'creator',
  'id',
  'item_type',
  'meta',
  'relationships',
  'type',
]);

/**
 * Reads every CMA representation of a nested block identity and rejects
 * ambiguity. Returning null means that the value makes no nested-item claim.
 */
export function nestedBlockIdentity(
  value: unknown,
  path: string,
): NestedBlockIdentity | null {
  if (!isObject(value)) return null;

  const hasItemType = Object.prototype.hasOwnProperty.call(value, 'item_type');
  const hasRelationshipItemType =
    isObject(value.relationships) &&
    Object.prototype.hasOwnProperty.call(value.relationships, 'item_type');
  const hasInternalItemType = Object.prototype.hasOwnProperty.call(
    value,
    '__itemTypeId',
  );
  const claimsNestedItem =
    value.type === 'item' ||
    (Object.prototype.hasOwnProperty.call(value, 'id') &&
      (hasItemType || hasRelationshipItemType || hasInternalItemType));

  if (!claimsNestedItem) return null;

  if (value.type !== 'item') {
    throw sharedFailure(
      'malformedContent',
      `Nested content at ${path} declares a block model identity without type="item".`,
      { path },
    );
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw sharedFailure(
      'malformedContent',
      `Nested content at ${path} has no non-empty block ID.`,
      { path },
    );
  }

  const candidates: Array<{ representation: string; id: string }> = [];

  if (hasItemType) {
    if (
      !isObject(value.item_type) ||
      typeof value.item_type.id !== 'string' ||
      value.item_type.id.length === 0
    ) {
      throw sharedFailure(
        'malformedContent',
        `Nested content at ${path} has a malformed item_type identity.`,
        { path },
      );
    }
    candidates.push({ representation: 'item_type.id', id: value.item_type.id });
  }

  if (hasRelationshipItemType) {
    const relationship = value.relationships.item_type;
    if (
      !isObject(relationship) ||
      !isObject(relationship.data) ||
      typeof relationship.data.id !== 'string' ||
      relationship.data.id.length === 0
    ) {
      throw sharedFailure(
        'malformedContent',
        `Nested content at ${path} has a malformed relationships.item_type.data identity.`,
        { path },
      );
    }
    candidates.push({
      representation: 'relationships.item_type.data.id',
      id: relationship.data.id,
    });
  }

  if (hasInternalItemType) {
    if (
      typeof value.__itemTypeId !== 'string' ||
      value.__itemTypeId.length === 0
    ) {
      throw sharedFailure(
        'malformedContent',
        `Nested content at ${path} has a malformed __itemTypeId identity.`,
        { path },
      );
    }
    candidates.push({
      representation: '__itemTypeId',
      id: value.__itemTypeId,
    });
  }

  if (candidates.length === 0) {
    throw sharedFailure(
      'malformedContent',
      `Nested content at ${path} has no authoritative block model identity.`,
      { path },
    );
  }

  const itemTypeIds = [...new Set(candidates.map(({ id }) => id))];
  if (itemTypeIds.length !== 1) {
    throw sharedFailure(
      'malformedContent',
      `Nested item ${value.id} has conflicting block model identities at ${path}.`,
      {
        blockId: value.id,
        path,
        representations: Object.fromEntries(
          candidates.map(({ representation, id }) => [representation, id]),
        ),
      },
    );
  }

  return { id: value.id, itemTypeId: itemTypeIds[0] };
}

/**
 * Whether the value is a nested block. A malformed nested-item claim throws
 * instead of being treated as plain JSON.
 */
export function isNestedBlock(
  value: unknown,
  path = 'embedded content',
): value is JsonObject & { id: string } {
  return nestedBlockIdentity(value, path) !== null;
}

/**
 * The model ID an item or block declares, or '' when it declares none. It
 * does not validate the identity; callers that need that use
 * nestedBlockIdentity.
 */
export function itemTypeIdFromItem(value: Record<string, any>): string {
  if (isObject(value.item_type) && typeof value.item_type.id === 'string') {
    return value.item_type.id;
  }
  if (
    isObject(value.relationships) &&
    isObject(value.relationships.item_type) &&
    isObject(value.relationships.item_type.data) &&
    typeof value.relationships.item_type.data.id === 'string'
  ) {
    return value.relationships.item_type.data.id;
  }
  return typeof value.__itemTypeId === 'string' ? value.__itemTypeId : '';
}

/**
 * The fields of a nested block: its own `attributes` object when it has one,
 * otherwise every key that is not identity metadata. Malformed `attributes`
 * throw instead of falling back to the flat shape.
 */
export function nestedBlockFields(
  value: unknown,
  path: string,
): Record<string, any> {
  if (!isObject(value)) {
    throw sharedFailure(
      'malformedContent',
      `Nested content at ${path} is not an object.`,
      { path },
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, 'attributes')) {
    if (!isObject(value.attributes)) {
      throw sharedFailure(
        'malformedContent',
        `Nested content at ${path} has malformed block attributes.`,
        { path },
      );
    }
    return value.attributes;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !NESTED_BLOCK_RESERVED_KEYS.has(key),
    ),
  );
}

export function isStructuredTextNode(value: unknown): value is JsonObject {
  return isObject(value) && typeof value.type === 'string' && value.type !== '';
}

/** Indexes a schema's item types by ID; a Map is returned unchanged. */
export function itemTypesById(
  lookup: ItemTypeLookup,
): ReadonlyMap<string, ItemTypeSchemaSnapshot> {
  const candidate: unknown = lookup;
  if (
    isObject(candidate) &&
    typeof candidate.get === 'function' &&
    typeof candidate.has === 'function'
  ) {
    return candidate as ReadonlyMap<string, ItemTypeSchemaSnapshot>;
  }
  if (isObject(candidate) && Array.isArray(candidate.itemTypes)) {
    return new Map(
      (candidate.itemTypes as ItemTypeSchemaSnapshot[]).map((itemType) => [
        itemType.id,
        itemType,
      ]),
    );
  }
  throw sharedFailure(
    'invalidPlan',
    'An item type lookup must be a schema snapshot or a Map of item types.',
  );
}

export function requireItemType(
  lookup: ItemTypeLookup,
  itemTypeId: string,
): ItemTypeSchemaSnapshot {
  const itemType = itemTypesById(lookup).get(itemTypeId);
  if (!itemType) {
    throw sharedFailure(
      'unknownModel',
      `Content refers to item type ${itemTypeId}, which is absent from the scoped schema.`,
    );
  }
  return itemType;
}

/** The block model of a nested block; a missing or regular model throws. */
export function requireBlockType(
  lookup: ItemTypeLookup,
  identity: NestedBlockIdentity,
  fieldPath: string,
): ItemTypeSchemaSnapshot {
  const blockType = itemTypesById(lookup).get(identity.itemTypeId);
  if (!blockType?.modularBlock) {
    throw sharedFailure(
      'unknownModel',
      `Nested block ${identity.id} refers to unknown block model ${identity.itemTypeId}.`,
      { blockId: identity.id, itemTypeId: identity.itemTypeId, fieldPath },
    );
  }
  return blockType;
}

/**
 * Visits every nested block of a record's fields, depth first and parents
 * before children. Field paths join API keys with dots and enter a block as
 * `.block:<id>`. The locale is that of the localized field holding the block
 * directly; a block's own fields start again from null.
 */
export function visitNestedBlocksInFields(
  fields: Record<string, any>,
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  lookup: ItemTypeLookup,
  visit: NestedBlockVisitor,
  prefix = '',
): void {
  if (!itemType) {
    throw sharedFailure(
      'unknownModel',
      'Cannot inspect nested blocks for an unknown item type.',
    );
  }
  const itemTypes = itemTypesById(lookup);
  for (const field of itemType.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.apiKey)) continue;
    const value = fields[field.apiKey];
    const fieldPath = prefix ? `${prefix}.${field.apiKey}` : field.apiKey;
    if (field.localized && isObject(value)) {
      for (const [locale, localizedValue] of Object.entries(value)) {
        visitNestedBlocksInFieldValue(
          localizedValue,
          field,
          itemTypes,
          visit,
          fieldPath,
          locale,
        );
      }
    } else {
      visitNestedBlocksInFieldValue(
        value,
        field,
        itemTypes,
        visit,
        fieldPath,
        null,
      );
    }
  }
}

function visitNestedBlocksInFieldValue(
  value: unknown,
  field: FieldSchemaSnapshot,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: NestedBlockVisitor,
  fieldPath: string,
  locale: string | null,
): void {
  if (field.fieldType === 'structured_text') {
    if (!isObject(value) || !isObject(value.document)) return;
    visitNestedBlocksInStructuredTextNode(
      value.document,
      itemTypes,
      visit,
      fieldPath,
      locale,
    );
    return;
  }
  if (field.fieldType === 'rich_text' || field.fieldType === 'single_block') {
    visitNestedBlocksInValue(value, itemTypes, visit, fieldPath, locale);
  }
}

function visitNestedBlocksInStructuredTextNode(
  value: unknown,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: NestedBlockVisitor,
  fieldPath: string,
  locale: string | null,
): void {
  if (!isStructuredTextNode(value)) return;
  if (
    (value.type === 'block' || value.type === 'inlineBlock') &&
    isObject(value.item)
  ) {
    const identity = nestedBlockIdentity(value.item, fieldPath);
    if (identity) {
      visitNestedBlock(
        value.item,
        identity,
        itemTypes,
        visit,
        fieldPath,
        locale,
      );
    }
  }
  if (Array.isArray(value.children)) {
    for (const child of value.children) {
      visitNestedBlocksInStructuredTextNode(
        child,
        itemTypes,
        visit,
        fieldPath,
        locale,
      );
    }
  }
}

function visitNestedBlocksInValue(
  value: unknown,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: NestedBlockVisitor,
  fieldPath: string,
  locale: string | null,
): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      visitNestedBlocksInValue(child, itemTypes, visit, fieldPath, locale);
    }
    return;
  }
  if (!isObject(value)) return;
  const identity = nestedBlockIdentity(value, fieldPath);
  if (identity) {
    visitNestedBlock(value, identity, itemTypes, visit, fieldPath, locale);
    return;
  }
  for (const child of Object.values(value)) {
    visitNestedBlocksInValue(child, itemTypes, visit, fieldPath, locale);
  }
}

function visitNestedBlock(
  block: Record<string, any>,
  identity: NestedBlockIdentity,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: NestedBlockVisitor,
  fieldPath: string,
  locale: string | null,
): void {
  const blockType = requireBlockType(itemTypes, identity, fieldPath);
  visit(block as JsonObject & { id: string }, blockType, { fieldPath, locale });
  visitNestedBlocksInFields(
    nestedBlockFields(block, fieldPath),
    blockType,
    itemTypes,
    visit,
    `${fieldPath}.block:${identity.id}`,
  );
}

/** Collects every nested block by ID. */
export function collectNestedBlocks(
  fields: Record<string, any>,
  output: Map<string, JsonObject>,
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  lookup: ItemTypeLookup,
): void {
  visitNestedBlocksInFields(fields, itemType, lookup, (block) => {
    output.set(block.id, block);
  });
}

/** Collects the ID and block model of every nested block, in visit order. */
export function collectNestedBlockIdentities(
  fields: Record<string, any>,
  output: NestedBlockIdentity[],
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  lookup: ItemTypeLookup,
): void {
  visitNestedBlocksInFields(fields, itemType, lookup, (block, blockType) => {
    output.push({ id: block.id, itemTypeId: blockType.id });
  });
}

export function collectNestedBlockIds(
  fields: Record<string, any>,
  output: Set<string>,
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  lookup: ItemTypeLookup,
): void {
  visitNestedBlocksInFields(fields, itemType, lookup, (block) => {
    output.add(block.id);
  });
}

/**
 * Identifies the slot a nested block occupies: its top-level record, block
 * model, field path and locale. A block ID may own only one slot.
 */
export function blockOwnershipLocationKey(
  topRecordId: string,
  itemTypeId: string,
  fieldPath: string,
  locale: string | null | undefined,
): string {
  return [topRecordId, itemTypeId, fieldPath, locale ?? ''].join(':');
}
