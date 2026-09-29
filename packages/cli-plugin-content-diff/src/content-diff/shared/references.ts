// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { FieldSchemaSnapshot, ItemTypeSchemaSnapshot } from '../types';
import { sharedFailure } from './failure-factory';
import { isObject } from './json';
import type { ItemTypeLookup } from './nested-blocks';
import {
  isStructuredTextNode,
  itemTypesById,
  nestedBlockFields,
  nestedBlockIdentity,
  requireBlockType,
} from './nested-blocks';

/** Receives each record reference with its path and whether it is required. */
export type RecordReferenceVisitor = (
  recordId: string,
  path: string,
  required: boolean,
) => void;

/**
 * Whether the field's validators make an empty value invalid: `required`, or a
 * positive minimum (`length` for Structured Text, `size` otherwise).
 * Validators that are not an object count as none.
 */
export function fieldIsRequired(
  field: Pick<FieldSchemaSnapshot, 'fieldType'> & { validators?: unknown },
): boolean {
  const validators: Record<string, any> = isObject(field.validators)
    ? field.validators
    : {};
  if (Object.prototype.hasOwnProperty.call(validators, 'required')) {
    return true;
  }
  const validatorKey =
    field.fieldType === 'structured_text' ? 'length' : 'size';
  const minimum: Record<string, any> = isObject(validators[validatorKey])
    ? validators[validatorKey]
    : {};
  return (
    (typeof minimum.min === 'number' && minimum.min > 0) ||
    (typeof minimum.eq === 'number' && minimum.eq > 0)
  );
}

/** The record ID of a `link`/`links` entry: an ID string or an `{id}` object. */
export function referenceId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return isObject(value) && typeof value.id === 'string' ? value.id : null;
}

/** The upload ID of a `file`/`gallery` entry: an ID string or `{upload_id}`. */
export function uploadIdFromValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return isObject(value) && typeof value.upload_id === 'string'
    ? value.upload_id
    : null;
}

/**
 * Visits every record a record's fields reference, including references held
 * by nested blocks. Paths join API keys and locales with dots, index arrays,
 * and enter a nested block as `.block:<id>`. A reference is required when its
 * field is required and every enclosing field is too; a nested block's own
 * fields start again from `requiredContext`.
 */
export function visitRecordReferencesInFields(
  fields: Record<string, any>,
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  lookup: ItemTypeLookup,
  visit: RecordReferenceVisitor,
  prefix = '',
  requiredContext = true,
): void {
  if (!itemType) {
    throw sharedFailure(
      'unknownModel',
      'Cannot collect record references for an unknown item type.',
    );
  }
  const itemTypes = itemTypesById(lookup);
  for (const field of itemType.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.apiKey)) continue;
    const value = fields[field.apiKey];
    const fieldPath = prefix ? `${prefix}.${field.apiKey}` : field.apiKey;
    const required = requiredContext && fieldIsRequired(field);
    if (field.localized && isObject(value)) {
      for (const [locale, localizedValue] of Object.entries(value)) {
        visitRecordReferencesInFieldValue(
          localizedValue,
          field,
          itemTypes,
          visit,
          `${fieldPath}.${locale}`,
          required,
        );
      }
    } else {
      visitRecordReferencesInFieldValue(
        value,
        field,
        itemTypes,
        visit,
        fieldPath,
        required,
      );
    }
  }
}

function visitRecordReferencesInFieldValue(
  value: unknown,
  field: FieldSchemaSnapshot,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: RecordReferenceVisitor,
  path: string,
  required: boolean,
): void {
  if (field.fieldType === 'link') {
    const recordId = referenceId(value);
    if (recordId) visit(recordId, path, required);
    return;
  }
  if (field.fieldType === 'links') {
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) => {
      const recordId = referenceId(entry);
      if (recordId) visit(recordId, `${path}[${index}]`, required);
    });
    return;
  }
  if (field.fieldType === 'structured_text') {
    visitRecordReferencesInStructuredText(
      value,
      itemTypes,
      visit,
      path,
      required,
    );
    return;
  }
  if (field.fieldType === 'rich_text' || field.fieldType === 'single_block') {
    visitRecordReferencesInEmbedded(value, itemTypes, visit, path, required);
  }
}

function visitRecordReferencesInStructuredText(
  value: unknown,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: RecordReferenceVisitor,
  path: string,
  requiredContext: boolean,
): void {
  if (!isObject(value) || !isObject(value.document)) return;
  visitRecordReferencesInStructuredTextNode(
    value.document,
    itemTypes,
    visit,
    `${path}.document`,
    requiredContext,
  );
}

function visitRecordReferencesInStructuredTextNode(
  value: unknown,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: RecordReferenceVisitor,
  path: string,
  requiredContext: boolean,
): void {
  if (!isStructuredTextNode(value)) return;
  if (
    (value.type === 'inlineItem' || value.type === 'itemLink') &&
    typeof value.item === 'string'
  ) {
    visit(value.item, `${path}.item`, requiredContext);
  }
  if (
    (value.type === 'block' || value.type === 'inlineBlock') &&
    isObject(value.item)
  ) {
    visitRecordReferencesInNestedBlock(
      value.item,
      itemTypes,
      visit,
      `${path}.item`,
    );
  }
  if (Array.isArray(value.children)) {
    value.children.forEach((child, index) =>
      visitRecordReferencesInStructuredTextNode(
        child,
        itemTypes,
        visit,
        `${path}.children[${index}]`,
        requiredContext,
      ),
    );
  }
}

function visitRecordReferencesInEmbedded(
  value: unknown,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: RecordReferenceVisitor,
  path: string,
  requiredContext: boolean,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      visitRecordReferencesInEmbedded(
        child,
        itemTypes,
        visit,
        `${path}[${index}]`,
        requiredContext,
      ),
    );
    return;
  }
  if (!isObject(value)) return;
  if (
    (value.type === 'inlineItem' || value.type === 'itemLink') &&
    typeof value.item === 'string'
  ) {
    visit(value.item, `${path}.item`, requiredContext);
  }
  if (visitRecordReferencesInNestedBlock(value, itemTypes, visit, path)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visitRecordReferencesInEmbedded(
      child,
      itemTypes,
      visit,
      `${path}.${key}`,
      requiredContext,
    );
  }
}

/** Walks the fields of the nested block at `path`; false when it is not one. */
function visitRecordReferencesInNestedBlock(
  value: Record<string, any>,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  visit: RecordReferenceVisitor,
  path: string,
): boolean {
  const identity = nestedBlockIdentity(value, path);
  if (!identity) return false;
  const blockType = requireBlockType(itemTypes, identity, path);
  visitRecordReferencesInFields(
    nestedBlockFields(value, path),
    blockType,
    itemTypes,
    visit,
    `${path}.block:${identity.id}`,
    true,
  );
  return true;
}

/**
 * Adds every upload a record's fields reference to `output`: `file` and
 * `gallery` values, SEO images, and the same fields inside nested blocks.
 */
export function collectUploadIdsFromFields(
  fields: Record<string, any>,
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  lookup: ItemTypeLookup,
  output: Set<string>,
  prefix = '',
): void {
  if (!itemType) {
    throw sharedFailure(
      'unknownModel',
      'Cannot collect upload references for an unknown item type.',
    );
  }
  const itemTypes = itemTypesById(lookup);
  for (const field of itemType.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.apiKey)) continue;
    const value = fields[field.apiKey];
    const fieldPath = prefix ? `${prefix}.${field.apiKey}` : field.apiKey;
    const values: Array<[unknown, string]> =
      field.localized && isObject(value)
        ? Object.entries(value).map(([locale, localizedValue]) => [
            localizedValue,
            `${fieldPath}.${locale}`,
          ])
        : [[value, fieldPath]];
    for (const [fieldValue, path] of values) {
      if (field.fieldType === 'file') {
        const uploadId = uploadIdFromValue(fieldValue);
        if (uploadId) output.add(uploadId);
      } else if (field.fieldType === 'gallery' && Array.isArray(fieldValue)) {
        for (const entry of fieldValue) {
          const uploadId = uploadIdFromValue(entry);
          if (uploadId) output.add(uploadId);
        }
      } else if (
        field.fieldType === 'seo' &&
        isObject(fieldValue) &&
        typeof fieldValue.image === 'string'
      ) {
        output.add(fieldValue.image);
      } else if (field.fieldType === 'structured_text') {
        if (isObject(fieldValue) && isObject(fieldValue.document)) {
          collectUploadIdsFromStructuredTextNode(
            fieldValue.document,
            itemTypes,
            output,
            `${path}.document`,
          );
        }
      } else if (
        field.fieldType === 'rich_text' ||
        field.fieldType === 'single_block'
      ) {
        collectUploadIdsFromEmbedded(fieldValue, itemTypes, output, path);
      }
    }
  }
}

function collectUploadIdsFromStructuredTextNode(
  value: unknown,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  output: Set<string>,
  path: string,
): void {
  if (!isStructuredTextNode(value)) return;
  if (
    (value.type === 'block' || value.type === 'inlineBlock') &&
    isObject(value.item)
  ) {
    collectUploadIdsFromNestedBlock(
      value.item,
      itemTypes,
      output,
      `${path}.item`,
    );
  }
  if (Array.isArray(value.children)) {
    value.children.forEach((child, index) =>
      collectUploadIdsFromStructuredTextNode(
        child,
        itemTypes,
        output,
        `${path}.children[${index}]`,
      ),
    );
  }
}

function collectUploadIdsFromEmbedded(
  value: unknown,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  output: Set<string>,
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      collectUploadIdsFromEmbedded(
        child,
        itemTypes,
        output,
        `${path}[${index}]`,
      ),
    );
    return;
  }
  if (!isObject(value)) return;
  if (collectUploadIdsFromNestedBlock(value, itemTypes, output, path)) return;
  for (const [key, child] of Object.entries(value)) {
    collectUploadIdsFromEmbedded(child, itemTypes, output, `${path}.${key}`);
  }
}

/** Collects the uploads of the nested block at `path`; false when it is not one. */
function collectUploadIdsFromNestedBlock(
  value: Record<string, any>,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  output: Set<string>,
  path: string,
): boolean {
  const identity = nestedBlockIdentity(value, path);
  if (!identity) return false;
  const blockType = requireBlockType(itemTypes, identity, path);
  collectUploadIdsFromFields(
    nestedBlockFields(value, path),
    blockType,
    itemTypes,
    output,
    `${path}.block:${identity.id}`,
  );
  return true;
}
