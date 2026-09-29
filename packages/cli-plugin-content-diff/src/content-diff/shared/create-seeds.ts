// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  ContentDiffPlan,
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  JsonValue,
  RecordPlan,
  RecordSnapshot,
} from '../types';
import { sharedFailure } from './failure-factory';
import { isObject } from './json';
import type { ItemTypeLookup } from './nested-blocks';
import {
  isNestedBlock,
  isStructuredTextNode,
  itemTypesById,
  nestedBlockFields,
  nestedBlockIdentity,
  requireBlockType,
  requireItemType,
} from './nested-blocks';
import { fieldIsRequired, referenceId } from './references';

/**
 * What stripping does with an unavailable reference held by a required field:
 * `keep` leaves it (deletion and cycle analyses), `reject` throws
 * requiredReferenceCycle (create seeds), `strip` removes it (declared shells).
 * References held by optional fields are always removed.
 */
export type UnavailableReferencePolicy = 'keep' | 'reject' | 'strip';

/** The fields of a record plan's desired state that a create seed reads. */
export type CreateSeedRecord = Pick<
  RecordSnapshot,
  'id' | 'itemTypeId' | 'current' | 'published'
>;

const REMOVE_UNAVAILABLE_REFERENCE = Symbol('REMOVE_UNAVAILABLE_REFERENCE');
const UNWRAP_UNAVAILABLE_REFERENCE_CHILDREN = Symbol(
  'UNWRAP_UNAVAILABLE_REFERENCE_CHILDREN',
);

interface UnwrappedUnavailableReferenceChildren {
  kind: typeof UNWRAP_UNAVAILABLE_REFERENCE_CHILDREN;
  children: JsonValue[];
}

type StrippedReferenceValue =
  | JsonValue
  | typeof REMOVE_UNAVAILABLE_REFERENCE
  | UnwrappedUnavailableReferenceChildren;

/**
 * The exact field body runtime phase 5 sends to create a record. Every record
 * the create order puts at or after this one is unavailable, and so is every
 * member of a declared shell's component. Declared shells strip unavailable
 * required references; any other record must not hold one.
 */
export function projectCreateSeedFields(
  record: CreateSeedRecord,
  lookup: ItemTypeLookup,
  createOrder: readonly string[],
  createRecordIds: ReadonlySet<string>,
  shellRecordIds: ReadonlySet<string>,
  shellComponents: readonly (readonly string[])[],
): JsonObject {
  const recordIndex = createOrder.indexOf(record.id);
  if (recordIndex < 0) {
    throw sharedFailure(
      'invalidCreateOrder',
      `Execution createOrder is missing record ${record.id}.`,
      { recordId: record.id },
    );
  }
  // The record's own ID is also unavailable until its create succeeds.
  // Optional self edges inside a larger cycle need the same projection as
  // references to later creates, without declaring an invalid shell.
  // A create is available once its first position in the order has passed.
  const created = new Set(createOrder.slice(0, recordIndex));
  const unavailable = new Set(
    createOrder
      .slice(recordIndex)
      .filter((id) => createRecordIds.has(id) && !created.has(id)),
  );
  const isShell = shellRecordIds.has(record.id);
  if (isShell) {
    const component = shellComponents.find((ids) => ids.includes(record.id));
    if (!component) {
      throw sharedFailure(
        'invalidPlan',
        `Execution shellComponents is missing shell record ${record.id}.`,
        { recordId: record.id },
      );
    }
    for (const id of component) unavailable.add(id);
  }
  const itemTypes = itemTypesById(lookup);
  const seed = record.published ?? record.current;
  return stripUnavailableReferences(
    seed.fields,
    requireItemType(itemTypes, record.itemTypeId),
    itemTypes,
    unavailable,
    `record ${record.id}`,
    isShell ? 'strip' : 'reject',
  );
}

/** The parts of a plan that the phase-5 create seeds depend on. */
export type CreateSeedPlan = Pick<ContentDiffPlan, 'records' | 'schema'> & {
  execution: Pick<
    ContentDiffPlan['execution'],
    'createOrder' | 'shellComponents' | 'shellRecordIds'
  >;
};

/**
 * The phase-5 create seed of every planned CREATE, by record ID, projected
 * over plan.schema exactly as the runtime creates it.
 */
export function projectPlanCreateSeedFields(
  plan: CreateSeedPlan,
): Map<string, JsonObject> {
  const itemTypes = itemTypesById(plan.schema);
  const seeds = new Map<string, JsonObject>();
  for (const record of plan.records) {
    if (record.action !== 'create' || !record.desired) continue;
    seeds.set(
      record.id,
      projectPlanRecordCreateSeedFields(
        plan,
        {
          id: record.id,
          itemTypeId: record.itemTypeId,
          desired: record.desired,
        },
        itemTypes,
      ),
    );
  }
  return seeds;
}

/**
 * The phase-5 create seed of one planned CREATE. The lookup must hold the
 * plan.schema models; the runtime passes its prebuilt map of them.
 */
export function projectPlanRecordCreateSeedFields(
  plan: CreateSeedPlan,
  record: Pick<RecordPlan, 'id' | 'itemTypeId'> & {
    desired: Pick<RecordSnapshot, 'current' | 'published'>;
  },
  lookup: ItemTypeLookup,
): JsonObject {
  return projectCreateSeedFields(
    {
      id: record.id,
      itemTypeId: record.itemTypeId,
      current: record.desired.current,
      published: record.desired.published,
    },
    lookup,
    plan.execution.createOrder,
    new Set(
      plan.records
        .filter(({ action }) => action === 'create')
        .map(({ id }) => id),
    ),
    new Set(plan.execution.shellRecordIds),
    plan.execution.shellComponents,
  );
}

/**
 * Removes references to unavailable records from a record's fields: links
 * become null, `links` entries and inline records disappear, and record links
 * keep only their children. Structured Text is renormalized the way the CMA
 * stores it, and nested blocks are rebuilt in their canonical shape. Fields
 * the model does not declare are copied unchanged.
 */
export function stripUnavailableReferences(
  fields: JsonObject,
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  lookup: ItemTypeLookup,
  unavailable: ReadonlySet<string>,
  path: string,
  requiredReferences: UnavailableReferencePolicy,
): JsonObject {
  if (!itemType) {
    throw sharedFailure(
      'unknownModel',
      `No schema exists while preparing ${path}.`,
      { path },
    );
  }
  if (
    requiredReferences !== 'keep' &&
    requiredReferences !== 'reject' &&
    requiredReferences !== 'strip'
  ) {
    throw sharedFailure(
      'invalidPlan',
      `Unknown required-reference policy ${String(requiredReferences)}.`,
    );
  }
  const itemTypes = itemTypesById(lookup);
  const result: JsonObject = { ...fields };
  for (const field of itemType.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.apiKey)) continue;
    result[field.apiKey] = stripFieldReferenceValue(
      fields[field.apiKey],
      field,
      itemTypes,
      unavailable,
      `${path}.${field.apiKey}`,
      requiredReferences,
    );
  }
  return result;
}

function stripFieldReferenceValue(
  value: JsonValue,
  field: FieldSchemaSnapshot,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  unavailable: ReadonlySet<string>,
  path: string,
  requiredReferences: UnavailableReferencePolicy,
): JsonValue {
  if (field.localized && isCreateSeedJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([locale, localizedValue]) => [
        locale,
        stripLocaleReferenceValue(
          localizedValue,
          field,
          itemTypes,
          unavailable,
          `${path}.${locale}`,
          requiredReferences,
        ),
      ]),
    );
  }
  return stripLocaleReferenceValue(
    value,
    field,
    itemTypes,
    unavailable,
    path,
    requiredReferences,
  );
}

function stripLocaleReferenceValue(
  value: JsonValue,
  field: FieldSchemaSnapshot,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  unavailable: ReadonlySet<string>,
  path: string,
  requiredReferences: UnavailableReferencePolicy,
): JsonValue {
  const required = fieldIsRequired(field);
  const rejectRequired = required && requiredReferences === 'reject';
  // References the field itself holds; a nested block's fields decide again.
  const stripReferences = !required || requiredReferences !== 'keep';

  if (field.fieldType === 'link') {
    const id = referenceId(value);
    if (!id || !unavailable.has(id)) return value;
    if (rejectRequired) {
      throw sharedFailure(
        'requiredReferenceCycle',
        `${path} requires record ${id} before it can be created.`,
      );
    }
    return stripReferences ? null : value;
  }
  if (field.fieldType === 'links') {
    if (!Array.isArray(value) || !stripReferences) return value;
    const filtered = value.filter((entry) => {
      const id = referenceId(entry);
      return !id || !unavailable.has(id);
    });
    if (rejectRequired && filtered.length !== value.length) {
      throw sharedFailure(
        'requiredReferenceCycle',
        `${path} contains references that cannot be seeded safely.`,
      );
    }
    return filtered;
  }
  if (field.fieldType === 'structured_text') {
    if (
      rejectRequired &&
      containsUnavailableStructuredTextRecordReference(value, unavailable)
    ) {
      throw sharedFailure(
        'requiredReferenceCycle',
        `${path} contains a required cyclic record reference.`,
      );
    }
    return canonicalProjectedStructuredText(
      value,
      stripStructuredTextReferences(
        value,
        itemTypes,
        unavailable,
        path,
        requiredReferences,
        stripReferences,
      ),
    );
  }
  if (field.fieldType === 'rich_text' || field.fieldType === 'single_block') {
    if (
      rejectRequired &&
      containsUnavailableTopRecordReference(value, unavailable, path)
    ) {
      throw sharedFailure(
        'requiredReferenceCycle',
        `${path} contains a required cyclic record reference.`,
      );
    }
    const stripped = stripNestedBlockReferences(
      value,
      itemTypes,
      unavailable,
      path,
      requiredReferences,
      stripReferences,
    );
    if (isUnwrappedUnavailableReferenceChildren(stripped)) {
      return stripped.children;
    }
    return stripped === REMOVE_UNAVAILABLE_REFERENCE ? null : stripped;
  }
  return value;
}

function stripStructuredTextReferences(
  value: JsonValue,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  unavailable: ReadonlySet<string>,
  path: string,
  requiredReferences: UnavailableReferencePolicy,
  stripReferences: boolean,
): StrippedReferenceValue {
  if (!isCreateSeedJsonObject(value) || !isCreateSeedJsonObject(value.document))
    return value;
  const strippedDocument = stripStructuredTextNodeReferences(
    value.document,
    itemTypes,
    unavailable,
    `${path}.document`,
    requiredReferences,
    stripReferences,
    value.schema === 'dast',
  );
  if (
    strippedDocument === REMOVE_UNAVAILABLE_REFERENCE ||
    isUnwrappedUnavailableReferenceChildren(strippedDocument)
  ) {
    return strippedDocument;
  }
  return { ...value, document: strippedDocument };
}

function stripStructuredTextNodeReferences(
  value: JsonValue,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  unavailable: ReadonlySet<string>,
  path: string,
  requiredReferences: UnavailableReferencePolicy,
  stripReferences: boolean,
  normalizeDast: boolean,
): StrippedReferenceValue {
  if (!isStructuredTextNode(value)) return value;
  if (
    stripReferences &&
    value.type === 'inlineItem' &&
    typeof value.item === 'string' &&
    unavailable.has(value.item)
  ) {
    return REMOVE_UNAVAILABLE_REFERENCE;
  }

  const strippedChildren = Array.isArray(value.children)
    ? value.children.flatMap((child, index) => {
        const stripped = stripStructuredTextNodeReferences(
          child,
          itemTypes,
          unavailable,
          `${path}.children[${index}]`,
          requiredReferences,
          stripReferences,
          normalizeDast,
        );
        if (stripped === REMOVE_UNAVAILABLE_REFERENCE) return [];
        if (isUnwrappedUnavailableReferenceChildren(stripped)) {
          return stripped.children;
        }
        return [stripped];
      })
    : null;
  const normalizedChildren =
    strippedChildren && normalizeDast
      ? normalizeProjectedDastChildren(strippedChildren)
      : strippedChildren;

  if (
    stripReferences &&
    value.type === 'itemLink' &&
    typeof value.item === 'string' &&
    unavailable.has(value.item)
  ) {
    return {
      kind: UNWRAP_UNAVAILABLE_REFERENCE_CHILDREN,
      children: normalizedChildren ?? [],
    };
  }

  const output: JsonObject = { ...value };
  if (normalizedChildren) output.children = normalizedChildren;
  if (
    (value.type === 'block' || value.type === 'inlineBlock') &&
    isCreateSeedJsonObject(value.item) &&
    isNestedBlock(value.item, `${path}.item`)
  ) {
    const strippedItem = stripNestedBlockReferences(
      value.item,
      itemTypes,
      unavailable,
      `${path}.item`,
      requiredReferences,
      stripReferences,
    );
    if (
      strippedItem !== REMOVE_UNAVAILABLE_REFERENCE &&
      !isUnwrappedUnavailableReferenceChildren(strippedItem)
    ) {
      output.item = strippedItem;
    }
  }

  if (!normalizeDast) return output;
  return normalizeProjectedDastNode(output);
}

function stripNestedBlockReferences(
  value: JsonValue,
  itemTypes: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  unavailable: ReadonlySet<string>,
  path: string,
  requiredReferences: UnavailableReferencePolicy,
  stripReferences: boolean,
): StrippedReferenceValue {
  if (Array.isArray(value)) {
    const children = value.flatMap((child, index) => {
      const stripped = stripNestedBlockReferences(
        child,
        itemTypes,
        unavailable,
        `${path}[${index}]`,
        requiredReferences,
        stripReferences,
      );
      if (stripped === REMOVE_UNAVAILABLE_REFERENCE) return [];
      if (isUnwrappedUnavailableReferenceChildren(stripped)) {
        return stripped.children;
      }
      return [stripped];
    });
    return normalizeProjectedDastChildren(children);
  }
  if (!isCreateSeedJsonObject(value)) return value;
  if (
    stripReferences &&
    value.type === 'inlineItem' &&
    typeof value.item === 'string' &&
    unavailable.has(value.item)
  ) {
    return REMOVE_UNAVAILABLE_REFERENCE;
  }
  if (
    stripReferences &&
    value.type === 'itemLink' &&
    typeof value.item === 'string' &&
    unavailable.has(value.item)
  ) {
    const strippedChildren = stripNestedBlockReferences(
      Array.isArray(value.children) ? value.children : [],
      itemTypes,
      unavailable,
      `${path}.children`,
      requiredReferences,
      stripReferences,
    );
    return {
      kind: UNWRAP_UNAVAILABLE_REFERENCE_CHILDREN,
      children: Array.isArray(strippedChildren) ? strippedChildren : [],
    };
  }
  const identity = nestedBlockIdentity(value, path);
  if (identity) {
    const blockType = requireBlockType(itemTypes, identity, path);
    // The canonical block shape, with keys in canonical JSON order.
    return {
      attributes: stripUnavailableReferences(
        nestedBlockFields(value, path) as JsonObject,
        blockType,
        itemTypes,
        unavailable,
        `${path}.block(${identity.id})`,
        requiredReferences,
      ),
      id: identity.id,
      relationships: {
        item_type: { data: { id: identity.itemTypeId, type: 'item_type' } },
      },
      type: 'item',
    };
  }
  const output: JsonObject = Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const stripped = stripNestedBlockReferences(
        child,
        itemTypes,
        unavailable,
        `${path}.${key}`,
        requiredReferences,
        stripReferences,
      );
      if (stripped === REMOVE_UNAVAILABLE_REFERENCE) return [];
      if (isUnwrappedUnavailableReferenceChildren(stripped)) {
        return [[key, stripped.children]];
      }
      return [[key, stripped]];
    }),
  );
  return normalizeProjectedDastNode(output);
}

/**
 * Applies the CMA's DAST cleanup to a node whose children were stripped: an
 * emptied container disappears, a link left holding one empty span becomes
 * that span, and an empty span loses its marks.
 */
function normalizeProjectedDastNode(
  output: JsonObject,
): StrippedReferenceValue {
  if (Array.isArray(output.children) && output.children.length === 0) {
    return REMOVE_UNAVAILABLE_REFERENCE;
  }
  if (
    (output.type === 'link' || output.type === 'itemLink') &&
    Array.isArray(output.children) &&
    output.children.length === 1 &&
    isEmptyDastSpan(output.children[0])
  ) {
    return { type: 'span', value: '' };
  }
  if (isEmptyDastSpan(output)) {
    const { marks: _marks, ...emptySpan } = output;
    return emptySpan;
  }
  return output;
}

function isCreateSeedJsonObject(value: unknown): value is JsonObject {
  return isObject(value);
}

function isUnwrappedUnavailableReferenceChildren(
  value: StrippedReferenceValue,
): value is UnwrappedUnavailableReferenceChildren {
  return (
    isCreateSeedJsonObject(value) &&
    (value as { kind?: unknown }).kind === UNWRAP_UNAVAILABLE_REFERENCE_CHILDREN
  );
}

function normalizeProjectedDastChildren(children: JsonValue[]): JsonValue[] {
  const result: JsonValue[] = [];
  for (const child of children) {
    if (result.length > 0 && isEmptyDastSpan(result[result.length - 1])) {
      result.pop();
    }
    result.push(child);
    if (
      result.length >= 2 &&
      areMergeableDastSpans(
        result[result.length - 2],
        result[result.length - 1],
      )
    ) {
      const right = result.pop() as JsonObject;
      const left = result[result.length - 1] as JsonObject;
      left.value = String(left.value) + String(right.value);
    }
    if (
      result.length >= 2 &&
      areMergeableDastLists(
        result[result.length - 2],
        result[result.length - 1],
      )
    ) {
      const right = result.pop() as JsonObject;
      const left = result[result.length - 1] as JsonObject;
      left.children = (left.children as JsonValue[]).concat(
        right.children as JsonValue[],
      );
    }
  }
  if (result.length > 1 && isEmptyDastSpan(result[result.length - 1])) {
    result.pop();
  }
  return result;
}

function areMergeableDastSpans(left: JsonValue, right: JsonValue): boolean {
  if (!isCreateSeedJsonObject(left) || !isCreateSeedJsonObject(right))
    return false;
  if (left.type !== 'span' || right.type !== 'span') return false;
  if (typeof left.value !== 'string' || typeof right.value !== 'string') {
    return false;
  }
  const leftMarks = Array.isArray(left.marks) ? left.marks.map(String) : [];
  const rightMarks = Array.isArray(right.marks) ? right.marks.map(String) : [];
  return (
    leftMarks.length === rightMarks.length &&
    leftMarks.every((mark) => rightMarks.includes(mark))
  );
}

function areMergeableDastLists(left: JsonValue, right: JsonValue): boolean {
  return (
    isCreateSeedJsonObject(left) &&
    isCreateSeedJsonObject(right) &&
    left.type === 'list' &&
    right.type === 'list' &&
    left.style === right.style &&
    Array.isArray(left.children) &&
    Array.isArray(right.children)
  );
}

function isEmptyDastSpan(value: JsonValue): value is JsonObject {
  return (
    isCreateSeedJsonObject(value) && value.type === 'span' && value.value === ''
  );
}

function canonicalProjectedStructuredText(
  original: JsonValue,
  stripped: StrippedReferenceValue,
): JsonValue {
  if (!isCreateSeedJsonObject(original) || original.schema !== 'dast') {
    if (stripped === REMOVE_UNAVAILABLE_REFERENCE) return null;
    return isUnwrappedUnavailableReferenceChildren(stripped)
      ? stripped.children
      : stripped;
  }
  if (
    stripped === REMOVE_UNAVAILABLE_REFERENCE ||
    isUnwrappedUnavailableReferenceChildren(stripped) ||
    !isCreateSeedJsonObject(stripped) ||
    !isCreateSeedJsonObject(stripped.document)
  ) {
    // validateExisting inspects raw nested-block payloads, while a real write
    // normalizes DAST first. Persist the exact canonical empty shape so both
    // paths diagnose the same required/length validators.
    return emptyDastValue();
  }
  return stripped;
}

function emptyDastValue(): JsonObject {
  return {
    schema: 'dast',
    document: {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'span', value: '' }] },
      ],
    },
  };
}

function containsUnavailableStructuredTextRecordReference(
  value: JsonValue,
  unavailable: ReadonlySet<string>,
): boolean {
  if (!isCreateSeedJsonObject(value) || !isCreateSeedJsonObject(value.document))
    return false;
  return structuredTextNodeContainsUnavailableRecordReference(
    value.document,
    unavailable,
  );
}

function structuredTextNodeContainsUnavailableRecordReference(
  value: JsonValue,
  unavailable: ReadonlySet<string>,
): boolean {
  if (!isStructuredTextNode(value)) return false;
  if (
    (value.type === 'inlineItem' || value.type === 'itemLink') &&
    typeof value.item === 'string' &&
    unavailable.has(value.item)
  ) {
    return true;
  }
  // References inside a real nested block are governed by the nested block's
  // own typed fields, not by the outer Structured Text validator.
  return (
    Array.isArray(value.children) &&
    value.children.some((child) =>
      structuredTextNodeContainsUnavailableRecordReference(child, unavailable),
    )
  );
}

function containsUnavailableTopRecordReference(
  value: JsonValue,
  unavailable: ReadonlySet<string>,
  path: string,
): boolean {
  if (Array.isArray(value)) {
    return value.some((child, index) =>
      containsUnavailableTopRecordReference(
        child,
        unavailable,
        `${path}[${index}]`,
      ),
    );
  }
  if (!isCreateSeedJsonObject(value)) return false;
  if (
    (value.type === 'inlineItem' || value.type === 'itemLink') &&
    typeof value.item === 'string'
  ) {
    return unavailable.has(value.item);
  }
  // A nested block's references are governed by its own typed fields.
  if (isNestedBlock(value, path)) return false;
  return Object.entries(value).some(([key, child]) =>
    containsUnavailableTopRecordReference(child, unavailable, `${path}.${key}`),
  );
}
