// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  ContentDiffPlan,
  DeleteReleaseStep,
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  JsonValue,
  RecordPlan,
  SchemaSnapshot,
  UniqueReleaseStep,
} from '../types';
import { projectPlanCreateSeedFields } from './create-seeds';
import { sharedFailure } from './failure-factory';
import { isObject, semanticHash, stableStringify } from './json';
import { nestedBlockFields, nestedBlockIdentity } from './nested-blocks';
import { compareNullable, compareStrings } from './ordering';
import { schemaWithInspectionItemTypes } from './schema-state';
import {
  type RecordTopologyState,
  UNKNOWN_UNTIL_POSITIONED,
  absoluteRecordPositionsReproducible,
  affectedSiblingGroups,
  moveStatePosition,
  nextKnownPosition,
  orderedPlans,
  parentFirst,
  positionGoalReached,
  recordSiblingGroupKey,
  shiftForInsert,
} from './topology';

export type SanitizedHtmlWriteStage =
  | 'create'
  | 'current-restore'
  | 'delete-release'
  | 'position-finalize'
  | 'published-stage'
  | 'tree-reparent'
  | 'unique-release';

export interface SanitizedHtmlWriteRisk {
  recordId: string;
  itemTypeId: string;
  fieldId: string;
  stage: SanitizedHtmlWriteStage;
  path: string;
  locale: string | null;
}

export interface SanitizedHtmlWriteExecution {
  createOrder: readonly string[];
  uniqueReleases: readonly UniqueReleaseStep[];
  deleteReleases: readonly DeleteReleaseStep[];
  deleteOrder: readonly string[];
  publicationSeedOrder: readonly string[];
  publishOrder: readonly string[];
  updateOrder: readonly string[];
  /** absoluteRecordPositionsReproducible of the plan. */
  absoluteRecordPositionsReproducible: boolean;
}

/**
 * The CMA uses Ruby Sanitize + Nokogiri HTML5 serialization before CREATE and
 * attribute-bearing UPDATEs. Reproducing those bytes in the generated Node runtime
 * would not be a stable cross-language contract. This deliberately small
 * subset is the only input for which byte identity can be proved without
 * parsing HTML: ordinary text with no markup/entity opener, HTML-significant
 * delimiter, carriage return, C0/C1 control, raw NBSP, surrogate, or Unicode
 * noncharacter.
 */
export function isProvablyCmaSanitizerByteStableText(
  value: JsonValue | undefined,
): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value !== 'string') return false;
  if (/[<>&\r]/u.test(value)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x00a0 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Models every CREATE and every UPDATE whose serialized data.attributes is
 * non-empty in execution order. UPDATE field payloads use the same top-field
 * diff as the generated runtime. Reparent and position payloads are also
 * attributes in the CMA client, so their exact topology state machine is
 * projected as well. If no such write occurs, there is no sanitizer risk. If
 * one occurs, the safety proof checks the complete post-write fields: CMA can
 * full-rehydrate omitted fields whenever the current version is invalid or the
 * model is asynchronously validating, and that runtime-only state is not
 * available in a portable plan.
 */
export function findSanitizedHtmlWriteRisks(
  records: readonly RecordPlan[],
  phaseSchema: SchemaSnapshot,
  projectedCreateSeedFields: ReadonlyMap<string, JsonObject>,
  execution: SanitizedHtmlWriteExecution,
): SanitizedHtmlWriteRisk[] {
  const schemaById = new Map(
    phaseSchema.itemTypes.map((itemType) => [itemType.id, itemType]),
  );
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const states = new Map<
    string,
    { current: JsonObject; publishedHash: string | null }
  >();
  const topologyStates = new Map<string, RecordTopologyState>();
  const risks: SanitizedHtmlWriteRisk[] = [];
  const publicationSeedIds = new Set(execution.publicationSeedOrder);

  for (const record of records) {
    const itemType = schemaById.get(record.itemTypeId);
    if (!itemType) {
      throwUnresolvedSanitizerSchema(
        record.id,
        record.itemTypeId,
        `record:${record.id}`,
      );
    }
    if (record.action === 'create' && record.desired) {
      const fields = projectedCreateSeedFields.get(record.id);
      if (!fields) {
        throw sharedFailure(
          'invalidPlan',
          `Cannot prove sanitized_html byte stability because projected CREATE fields are missing for record ${record.id}.`,
          { recordId: record.id },
        );
      }
      inspectSanitizationFields(
        fields,
        itemType,
        schemaById,
        record.id,
        'create',
        `record:${record.id}`,
        risks,
      );
      states.set(record.id, {
        current: fields,
        publishedHash:
          !itemType.draftModeActive || publicationSeedIds.has(record.id)
            ? semanticHash(fields)
            : null,
      });
    } else if (record.baseline) {
      states.set(record.id, {
        current: record.baseline.current.fields,
        publishedHash: record.baseline.published?.hash ?? null,
      });
      topologyStates.set(record.id, {
        itemTypeId: record.itemTypeId,
        parentId: record.baseline.topology.parentId,
        position: record.baseline.topology.position,
      });
    }
  }

  for (const record of orderedPlans(
    execution.createOrder,
    records.filter(({ action }) => action === 'create'),
  )) {
    const itemType = schemaById.get(record.itemTypeId);
    if (
      !record.desired ||
      !itemType ||
      (!itemType.tree && !itemType.sortable)
    ) {
      continue;
    }
    const position = record.desired.topology.position;
    if (typeof position !== 'number') continue;
    shiftForInsert(
      topologyStates,
      record.itemTypeId,
      record.desired.topology.parentId,
      position,
      record.id,
    );
    topologyStates.set(record.id, {
      itemTypeId: record.itemTypeId,
      parentId: record.desired.topology.parentId,
      position,
    });
  }

  for (const release of execution.uniqueReleases) {
    const record = recordsById.get(release.recordId);
    const itemType = record && schemaById.get(record.itemTypeId);
    const state = states.get(release.recordId);
    if (!record || !itemType || !state) {
      throwUnresolvedSanitizerSchema(
        release.recordId,
        record?.itemTypeId ?? '<unknown>',
        `record:${release.recordId}`,
      );
    }
    const patch = projectedSanitizerVersionPatch(release.fields, state.current);
    const nextCurrent = applySanitizerTopFieldValues(
      state.current,
      release.fields,
    );
    if (Object.keys(patch).length > 0) {
      inspectSanitizationFields(
        nextCurrent,
        itemType,
        schemaById,
        record.id,
        'unique-release',
        `record:${record.id}`,
        risks,
      );
    }
    state.current = nextCurrent;
    if (!itemType.draftModeActive && Object.keys(patch).length > 0) {
      state.publishedHash = semanticHash(state.current);
    }
  }

  for (const record of parentFirst(
    records.filter(
      ({ action, desired }) => desired !== null && action !== 'noop',
    ),
  )) {
    const itemType = schemaById.get(record.itemTypeId);
    const state = states.get(record.id);
    const topology = topologyStates.get(record.id);
    if (
      !record.desired ||
      !itemType?.tree ||
      !state ||
      !topology ||
      topology.parentId === record.desired.topology.parentId
    ) {
      continue;
    }
    inspectSanitizationFields(
      state.current,
      itemType,
      schemaById,
      record.id,
      'tree-reparent',
      `record:${record.id}`,
      risks,
    );
    topology.parentId = record.desired.topology.parentId;
    topology.position = execution.absoluteRecordPositionsReproducible
      ? nextKnownPosition(
          topologyStates,
          record.itemTypeId,
          topology.parentId,
          record.id,
        )
      : UNKNOWN_UNTIL_POSITIONED;
  }

  for (const recordId of execution.publishOrder) {
    const record = recordsById.get(recordId);
    if (
      !record?.desired ||
      record.action === 'noop' ||
      record.action === 'delete'
    )
      continue;
    const itemType = schemaById.get(record.itemTypeId);
    const state = states.get(record.id);
    if (!itemType || !state) {
      throwUnresolvedSanitizerSchema(
        record.id,
        record.itemTypeId,
        `record:${record.id}`,
      );
    }
    if (record.desired.published) {
      if (state.publishedHash !== record.desired.published.hash) {
        const patch = projectedSanitizerVersionPatch(
          record.desired.published.fields,
          state.current,
        );
        const nextCurrent = applySanitizerTopFieldValues(
          state.current,
          record.desired.published.fields,
        );
        if (Object.keys(patch).length > 0) {
          inspectSanitizationFields(
            nextCurrent,
            itemType,
            schemaById,
            record.id,
            'published-stage',
            `record:${record.id}`,
            risks,
          );
        }
        state.current = nextCurrent;
        state.publishedHash = record.desired.published.hash;
      }
    } else {
      state.publishedHash = null;
    }
  }

  for (const record of orderedPlans(execution.updateOrder, records)) {
    if (
      !record.desired ||
      record.action === 'noop' ||
      record.action === 'delete'
    )
      continue;
    const itemType = schemaById.get(record.itemTypeId);
    const state = states.get(record.id);
    if (!itemType || !state) {
      throwUnresolvedSanitizerSchema(
        record.id,
        record.itemTypeId,
        `record:${record.id}`,
      );
    }
    const patch = projectedSanitizerVersionPatch(
      record.desired.current.fields,
      state.current,
    );
    const nextCurrent = applySanitizerTopFieldValues(
      state.current,
      record.desired.current.fields,
    );
    if (Object.keys(patch).length > 0) {
      inspectSanitizationFields(
        nextCurrent,
        itemType,
        schemaById,
        record.id,
        'current-restore',
        `record:${record.id}`,
        risks,
      );
    }
    state.current = nextCurrent;
  }

  for (const release of execution.deleteReleases) {
    const record = recordsById.get(release.recordId);
    const itemType = record && schemaById.get(record.itemTypeId);
    const state = states.get(release.recordId);
    if (!record || !itemType || !state) {
      throwUnresolvedSanitizerSchema(
        release.recordId,
        record?.itemTypeId ?? '<unknown>',
        `record:${release.recordId}`,
      );
    }
    const patch = projectedSanitizerVersionPatch(release.fields, state.current);
    const nextCurrent = applySanitizerTopFieldValues(
      state.current,
      release.fields,
    );
    if (Object.keys(patch).length > 0) {
      inspectSanitizationFields(
        nextCurrent,
        itemType,
        schemaById,
        record.id,
        'delete-release',
        `record:${record.id}`,
        risks,
      );
    }
    state.current = nextCurrent;
  }

  for (const record of orderedPlans(execution.deleteOrder, records).filter(
    ({ action }) => action === 'delete',
  )) {
    const deleted = topologyStates.get(record.id);
    if (!deleted) continue;
    for (const child of topologyStates.values()) {
      if (
        child.itemTypeId === record.itemTypeId &&
        child.parentId === record.id
      ) {
        child.parentId = deleted.parentId;
        child.position = UNKNOWN_UNTIL_POSITIONED;
      }
    }
    topologyStates.delete(record.id);
  }

  const affectedGroups = affectedSiblingGroups(records, schemaById);
  const positional = records
    .filter((record) => {
      const itemType = schemaById.get(record.itemTypeId);
      return Boolean(
        record.desired &&
          typeof record.desired.topology.position === 'number' &&
          itemType &&
          (itemType.tree || itemType.sortable) &&
          affectedGroups.has(
            recordSiblingGroupKey(
              record.itemTypeId,
              record.desired.topology.parentId,
            ),
          ),
      );
    })
    .sort(
      (left, right) =>
        compareStrings(left.itemTypeId, right.itemTypeId) ||
        compareNullable(
          left.desired!.topology.parentId,
          right.desired!.topology.parentId,
        ) ||
        left.desired!.topology.position! - right.desired!.topology.position! ||
        compareStrings(left.id, right.id),
    );
  const seenPositionStates = new Set<string>();
  const maximumPositionSteps = 4 * positional.length * positional.length + 1;
  for (let step = 0; step < maximumPositionSteps; step += 1) {
    const signature = sanitizerTopologyStateSignature(topologyStates);
    if (seenPositionStates.has(signature)) break;
    seenPositionStates.add(signature);
    if (
      positionGoalReached(
        positional,
        topologyStates,
        execution.absoluteRecordPositionsReproducible,
      )
    ) {
      break;
    }
    const next = positional.find((record) => {
      const topology = topologyStates.get(record.id);
      return (
        topology && topology.position !== record.desired!.topology.position
      );
    });
    if (!next) break;
    const state = states.get(next.id);
    const itemType = schemaById.get(next.itemTypeId);
    if (!state || !itemType) {
      throwUnresolvedSanitizerSchema(
        next.id,
        next.itemTypeId,
        `record:${next.id}`,
      );
    }
    inspectSanitizationFields(
      state.current,
      itemType,
      schemaById,
      next.id,
      'position-finalize',
      `record:${next.id}`,
      risks,
    );
    moveStatePosition(
      topologyStates,
      next.id,
      next.desired!.topology.position!,
    );
  }

  const stageOrder: SanitizedHtmlWriteStage[] = [
    'create',
    'unique-release',
    'tree-reparent',
    'published-stage',
    'current-restore',
    'delete-release',
    'position-finalize',
  ];
  const uniqueRisks = [
    ...new Map(
      risks.map((risk) => [
        `${risk.recordId}\u0000${risk.stage}\u0000${risk.fieldId}\u0000${risk.path}`,
        risk,
      ]),
    ).values(),
  ];
  return uniqueRisks.sort(
    (left, right) =>
      compareStrings(left.recordId, right.recordId) ||
      stageOrder.indexOf(left.stage) - stageOrder.indexOf(right.stage) ||
      compareStrings(left.fieldId, right.fieldId) ||
      compareStrings(left.path, right.path),
  );
}

/**
 * The sanitizer risks of an executable plan. CREATE seeds are the exact
 * phase-5 bodies projected over plan.schema. Writes are checked against the
 * phase's managed schema plus the destination inspection models.
 */
export function findPlanSanitizedHtmlWriteRisks(
  plan: Pick<
    ContentDiffPlan,
    | 'execution'
    | 'options'
    | 'records'
    | 'schema'
    | 'targetInspection'
    | 'warnings'
  >,
  phaseManagedSchema: SchemaSnapshot,
): SanitizedHtmlWriteRisk[] {
  return findSanitizedHtmlWriteRisks(
    plan.records,
    schemaWithInspectionItemTypes(
      phaseManagedSchema,
      plan.targetInspection.itemTypes,
    ),
    projectPlanCreateSeedFields(plan),
    {
      ...plan.execution,
      absoluteRecordPositionsReproducible:
        absoluteRecordPositionsReproducible(plan),
    },
  );
}

function sanitizerTopologyStateSignature(
  states: ReadonlyMap<string, RecordTopologyState>,
): string {
  return stableStringify(
    [...states]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([id, state]) => ({
        id,
        parentId: state.parentId,
        position: state.position,
      })),
  );
}

function inspectSanitizationFields(
  fields: JsonObject,
  itemType: ItemTypeSchemaSnapshot,
  schemaById: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  stage: SanitizedHtmlWriteStage,
  path: string,
  risks: SanitizedHtmlWriteRisk[],
): void {
  for (const field of itemType.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.apiKey)) continue;
    const value = fields[field.apiKey];
    const fieldPath = `${path}.${field.apiKey}`;

    if (fieldUsesSanitizer(field)) {
      inspectSanitizedTextValue(
        value,
        field,
        recordId,
        itemType.id,
        stage,
        fieldPath,
        risks,
      );
    }

    if (
      field.fieldType === 'rich_text' ||
      field.fieldType === 'single_block' ||
      field.fieldType === 'structured_text'
    ) {
      const inspect = (embeddedValue: JsonValue | undefined, at: string) => {
        if (field.fieldType === 'structured_text') {
          inspectSanitizationStructuredTextValue(
            embeddedValue,
            schemaById,
            recordId,
            stage,
            at,
            risks,
          );
        } else {
          inspectSanitizationEmbeddedValue(
            embeddedValue,
            schemaById,
            recordId,
            stage,
            at,
            risks,
          );
        }
      };
      if (field.localized && isSanitizerJsonObject(value)) {
        for (const [locale, localizedValue] of Object.entries(value)) {
          inspect(localizedValue, `${fieldPath}.${locale}`);
        }
      } else {
        inspect(value, fieldPath);
      }
    }
  }
}

function inspectSanitizationStructuredTextValue(
  value: JsonValue | undefined,
  schemaById: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  stage: SanitizedHtmlWriteStage,
  path: string,
  risks: SanitizedHtmlWriteRisk[],
): void {
  if (!isSanitizerJsonObject(value) || !isSanitizerJsonObject(value.document))
    return;
  inspectSanitizationStructuredTextNode(
    value.document,
    schemaById,
    recordId,
    stage,
    `${path}.document`,
    risks,
  );
}

function inspectSanitizationStructuredTextNode(
  value: JsonValue,
  schemaById: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  stage: SanitizedHtmlWriteStage,
  path: string,
  risks: SanitizedHtmlWriteRisk[],
): void {
  if (!isSanitizerJsonObject(value) || typeof value.type !== 'string') return;
  if (
    (value.type === 'block' || value.type === 'inlineBlock') &&
    Object.prototype.hasOwnProperty.call(value, 'item')
  ) {
    inspectSanitizationEmbeddedValue(
      value.item,
      schemaById,
      recordId,
      stage,
      `${path}.item`,
      risks,
    );
  }
  if (Array.isArray(value.children)) {
    value.children.forEach((child, index) =>
      inspectSanitizationStructuredTextNode(
        child,
        schemaById,
        recordId,
        stage,
        `${path}.children[${index}]`,
        risks,
      ),
    );
  }
}

function inspectSanitizedTextValue(
  value: JsonValue | undefined,
  field: FieldSchemaSnapshot,
  recordId: string,
  itemTypeId: string,
  stage: SanitizedHtmlWriteStage,
  path: string,
  risks: SanitizedHtmlWriteRisk[],
): void {
  if (field.localized && isSanitizerJsonObject(value)) {
    for (const [locale, localizedValue] of Object.entries(value)) {
      if (!isProvablyLocalizedSanitizerByteStableText(localizedValue)) {
        risks.push({
          recordId,
          itemTypeId,
          fieldId: field.id,
          stage,
          path: `${path}.${locale}`,
          locale,
        });
      }
    }
    return;
  }

  if (!isProvablyCmaSanitizerByteStableText(value)) {
    risks.push({
      recordId,
      itemTypeId,
      fieldId: field.id,
      stage,
      path,
      locale: null,
    });
  }
}

function inspectSanitizationEmbeddedValue(
  value: JsonValue | undefined,
  schemaById: ReadonlyMap<string, ItemTypeSchemaSnapshot>,
  recordId: string,
  stage: SanitizedHtmlWriteStage,
  path: string,
  risks: SanitizedHtmlWriteRisk[],
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      inspectSanitizationEmbeddedValue(
        child,
        schemaById,
        recordId,
        stage,
        `${path}[${index}]`,
        risks,
      ),
    );
    return;
  }
  if (!isSanitizerJsonObject(value)) return;

  const identity = nestedBlockIdentity(value, path);
  if (identity) {
    const blockType = schemaById.get(identity.itemTypeId);
    if (!blockType?.modularBlock) {
      throwUnresolvedSanitizerSchema(recordId, identity.itemTypeId, path);
    }
    inspectSanitizationFields(
      nestedBlockFields(value, path) as JsonObject,
      blockType,
      schemaById,
      recordId,
      stage,
      `${path}.block:${identity.id}`,
      risks,
    );
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    inspectSanitizationEmbeddedValue(
      child,
      schemaById,
      recordId,
      stage,
      `${path}.${key}`,
      risks,
    );
  }
}

function projectedSanitizerVersionPatch(
  desiredFields: JsonObject,
  currentFields: JsonObject,
): JsonObject {
  // The safety projection only needs to know which top-level attributes are
  // written. Nested shorthand compaction cannot change that set and must not
  // interpret JSON fields or Structured Text metadata as embedded content.
  return Object.fromEntries(
    Object.entries(desiredFields).filter(
      ([key, value]) =>
        !Object.prototype.hasOwnProperty.call(currentFields, key) ||
        stableStringify(value) !== stableStringify(currentFields[key]),
    ),
  );
}

function applySanitizerTopFieldValues(
  current: JsonObject,
  fields: JsonObject,
): JsonObject {
  return { ...current, ...fields };
}

function fieldUsesSanitizer(field: FieldSchemaSnapshot): boolean {
  if (field.fieldType !== 'text') return false;
  const validator = isSanitizerJsonObject(field.validators)
    ? field.validators.sanitized_html
    : undefined;
  return (
    isSanitizerJsonObject(validator) &&
    validator.sanitize_before_validation === true
  );
}

function isProvablyLocalizedSanitizerByteStableText(
  value: JsonValue | undefined,
): boolean {
  return (
    typeof value === 'string' && isProvablyCmaSanitizerByteStableText(value)
  );
}

/** Fails the proof for an item type the phase schema cannot resolve. */
function throwUnresolvedSanitizerSchema(
  recordId: string,
  itemTypeId: string,
  path: string,
): never {
  throw sharedFailure(
    'invalidPlan',
    `Cannot prove sanitized_html byte stability because item type ${itemTypeId} at ${path} is absent from the captured traversal schema.`,
    { recordId, itemTypeId, path },
  );
}

function isSanitizerJsonObject(value: unknown): value is JsonObject {
  return isObject(value);
}
