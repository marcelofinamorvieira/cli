import { isObject } from './shared/json';
import { nestedBlockFields, nestedBlockIdentity } from './shared/nested-blocks';
import { compareStrings } from './shared/ordering';
import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  SchemaSnapshot,
  StructuralBlockValidatorKey,
  StructuralContentIssue,
} from './types';
import { ContentDiffError } from './types';

export type { NestedBlockIdentity } from './shared/nested-blocks';
export { nestedBlockFields, nestedBlockIdentity };

type UnknownObject = Record<string, unknown>;

export interface StructuralInspectionResult {
  encounteredItemTypeIds: string[];
  issues: StructuralContentIssue[];
}

export function inspectRecordStructuralContent(
  input: unknown,
  ownerItemType: ItemTypeSchemaSnapshot,
  fullSchema: SchemaSnapshot,
  recordId: string,
  slice: 'current' | 'published',
): StructuralInspectionResult {
  if (!isObject(input)) {
    throw new ContentDiffError(
      'UNSUPPORTED_CONTENT_STATE',
      `Record ${recordId} returned a malformed ${slice} resource.`,
      { recordId, slice },
    );
  }

  const itemTypes = new Map(
    fullSchema.itemTypes.map((itemType) => [itemType.id, itemType]),
  );
  const encounteredItemTypeIds = new Set<string>();
  const issues: StructuralContentIssue[] = [];
  const fields = isObject(input.attributes) ? input.attributes : input;

  inspectFields(
    fields,
    ownerItemType,
    '',
    null,
    itemTypes,
    recordId,
    slice,
    encounteredItemTypeIds,
    issues,
  );

  return {
    encounteredItemTypeIds: [...encounteredItemTypeIds].sort(),
    issues: deduplicateIssues(
      issues.map((issue) => ({ ...issue, itemTypeId: ownerItemType.id })),
    ),
  };
}

function inspectFields(
  fields: UnknownObject,
  itemType: ItemTypeSchemaSnapshot,
  prefix: string,
  inheritedLocale: string | null,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  slice: 'current' | 'published',
  encounteredItemTypeIds: Set<string>,
  issues: StructuralContentIssue[],
): void {
  for (const field of itemType.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.apiKey)) continue;

    const fieldPath = prefix ? `${prefix}.${field.apiKey}` : field.apiKey;
    const rawValue = fields[field.apiKey];
    const values =
      field.localized && isObject(rawValue)
        ? Object.entries(rawValue)
            .sort(([left], [right]) => compareStrings(left, right))
            .map(([locale, value]) => ({ locale, value }))
        : [{ locale: inheritedLocale, value: rawValue }];

    for (const { locale, value } of values) {
      inspectFieldValue(
        value,
        field,
        fieldPath,
        locale,
        itemTypes,
        recordId,
        slice,
        encounteredItemTypeIds,
        issues,
      );
    }
  }
}

function inspectFieldValue(
  value: unknown,
  field: FieldSchemaSnapshot,
  fieldPath: string,
  locale: string | null,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  slice: 'current' | 'published',
  encounteredItemTypeIds: Set<string>,
  issues: StructuralContentIssue[],
): void {
  if (field.fieldType === 'rich_text') {
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) =>
      inspectEmbeddedBlock(
        entry,
        field,
        'rich_text_blocks',
        `${fieldPath}[${index}]`,
        locale,
        itemTypes,
        recordId,
        slice,
        encounteredItemTypeIds,
        issues,
      ),
    );
    return;
  }

  if (field.fieldType === 'single_block') {
    if (value === null || value === undefined) return;
    inspectEmbeddedBlock(
      value,
      field,
      'single_block_blocks',
      fieldPath,
      locale,
      itemTypes,
      recordId,
      slice,
      encounteredItemTypeIds,
      issues,
    );
    return;
  }

  if (field.fieldType === 'structured_text') {
    if (!isObject(value) || !isObject(value.document)) return;
    inspectStructuredText(
      value.document,
      field,
      `${fieldPath}.document`,
      locale,
      itemTypes,
      recordId,
      slice,
      encounteredItemTypeIds,
      issues,
    );
  }
}

function inspectStructuredText(
  value: unknown,
  field: FieldSchemaSnapshot,
  path: string,
  locale: string | null,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  slice: 'current' | 'published',
  encounteredItemTypeIds: Set<string>,
  issues: StructuralContentIssue[],
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      inspectStructuredText(
        child,
        field,
        `${path}[${index}]`,
        locale,
        itemTypes,
        recordId,
        slice,
        encounteredItemTypeIds,
        issues,
      ),
    );
    return;
  }
  if (!isObject(value)) return;

  if (value.type === 'block' || value.type === 'inlineBlock') {
    const validatorKey: StructuralBlockValidatorKey =
      value.type === 'block'
        ? 'structured_text_blocks'
        : 'structured_text_inline_blocks';
    if (!Object.prototype.hasOwnProperty.call(value, 'item')) {
      throw unsupportedIdentity(path, 'has a block node without an item');
    }
    inspectEmbeddedBlock(
      value.item,
      field,
      validatorKey,
      `${path}.item`,
      locale,
      itemTypes,
      recordId,
      slice,
      encounteredItemTypeIds,
      issues,
    );
  } else {
    const unexpectedIdentity = nestedBlockIdentity(value, path);
    if (unexpectedIdentity) {
      throw new ContentDiffError(
        'UNSUPPORTED_CONTENT_STATE',
        `Nested item ${unexpectedIdentity.id} appears outside a Structured Text block node at ${path}.`,
        { blockId: unexpectedIdentity.id, path },
      );
    }
  }

  if (Array.isArray(value.children)) {
    inspectStructuredText(
      value.children,
      field,
      `${path}.children`,
      locale,
      itemTypes,
      recordId,
      slice,
      encounteredItemTypeIds,
      issues,
    );
  }
}

function inspectEmbeddedBlock(
  value: unknown,
  field: FieldSchemaSnapshot,
  validatorKey: StructuralBlockValidatorKey,
  path: string,
  locale: string | null,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  slice: 'current' | 'published',
  encounteredItemTypeIds: Set<string>,
  issues: StructuralContentIssue[],
): void {
  const identity = nestedBlockIdentity(value, path);
  if (!identity) {
    throw unsupportedIdentity(
      path,
      'has no authoritative nested block identity',
    );
  }

  const blockType = itemTypes.get(identity.itemTypeId);
  if (!blockType) {
    throw new ContentDiffError(
      'UNSUPPORTED_CONTENT_STATE',
      `Nested item ${identity.id} refers to unknown block model ${identity.itemTypeId}.`,
      {
        blockId: identity.id,
        blockItemTypeId: identity.itemTypeId,
        path,
      },
    );
  }
  if (!blockType.modularBlock) {
    throw new ContentDiffError(
      'UNSUPPORTED_CONTENT_STATE',
      `Nested item ${identity.id} refers to regular model ${identity.itemTypeId}.`,
      {
        blockId: identity.id,
        blockItemTypeId: identity.itemTypeId,
        path,
      },
    );
  }

  encounteredItemTypeIds.add(blockType.id);
  const allowed = structuralValidatorItemTypeIds(field, validatorKey);
  if (!allowed.has(blockType.id)) {
    issues.push({
      recordId,
      itemTypeId: '',
      slice,
      fieldId: field.id,
      fieldPath: path,
      locale,
      validatorKey,
      blockId: identity.id,
      blockItemTypeId: blockType.id,
    });
  }

  inspectFields(
    nestedBlockFields(value, path),
    blockType,
    `${path}.block:${identity.id}`,
    locale,
    itemTypes,
    recordId,
    slice,
    encounteredItemTypeIds,
    issues,
  );
}

function structuralValidatorItemTypeIds(
  field: FieldSchemaSnapshot,
  validatorKey: StructuralBlockValidatorKey,
): Set<string> {
  const configuration: unknown = field.validators[validatorKey];
  if (configuration === undefined) return new Set();
  if (!isObject(configuration) || !Array.isArray(configuration.item_types)) {
    throw new ContentDiffError(
      'INCOMPATIBLE_SCHEMA',
      `Field ${field.id} has a malformed ${validatorKey} validator.`,
      { fieldId: field.id, validatorKey },
    );
  }
  if (
    configuration.item_types.some(
      (itemTypeId) => typeof itemTypeId !== 'string' || itemTypeId.length === 0,
    )
  ) {
    throw new ContentDiffError(
      'INCOMPATIBLE_SCHEMA',
      `Field ${field.id} has non-string item type IDs in ${validatorKey}.`,
      { fieldId: field.id, validatorKey },
    );
  }
  return new Set(configuration.item_types as string[]);
}

function deduplicateIssues(
  issues: readonly StructuralContentIssue[],
): StructuralContentIssue[] {
  return [
    ...new Map(
      issues.map((issue) => [
        [
          issue.recordId,
          issue.slice,
          issue.fieldId,
          issue.fieldPath,
          issue.locale ?? '',
          issue.validatorKey,
          issue.blockId,
          issue.blockItemTypeId,
        ].join('\0'),
        issue,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareStrings(left.recordId, right.recordId) ||
      compareStrings(left.slice, right.slice) ||
      compareStrings(left.fieldPath, right.fieldPath) ||
      compareStrings(left.locale ?? '', right.locale ?? '') ||
      compareStrings(left.blockId, right.blockId),
  );
}

function unsupportedIdentity(path: string, message: string): ContentDiffError {
  return new ContentDiffError(
    'UNSUPPORTED_CONTENT_STATE',
    `Nested content at ${path} ${message}.`,
    { path },
  );
}
