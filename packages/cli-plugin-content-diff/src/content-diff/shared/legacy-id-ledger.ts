// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  JsonObject,
  LegacyIdMappingDocument,
  LegacyIdMappingDocumentEntry,
} from '../types';
import {
  LEGACY_ID_MAPPING_FIELD_API_KEY,
  LEGACY_ID_MAPPING_FIELD_LABEL,
  LEGACY_ID_MAPPING_FORMAT_VERSION,
  LEGACY_ID_MAPPING_MAX_DOCUMENT_BYTES,
  LEGACY_ID_MAPPING_MODEL_API_KEY,
  LEGACY_ID_MAPPING_MODEL_NAME,
  LEGACY_ID_MAPPING_NAME_FIELD_API_KEY,
  LEGACY_ID_MAPPING_NAME_FIELD_LABEL,
} from './contract';
import { sharedFailure } from './failure-factory';
import { isPortableDatoId } from './ids';
import {
  canonicalPrettyStringify,
  canonicalizeJson,
  isObject,
  sha256,
  stableStringify,
  utf8ByteLength,
} from './json';
import {
  legacyIdMappingChunkName,
  legacyIdMappingKey,
  legacyIdMappingSortKey,
  validateLegacyIdMappingEntry,
} from './legacy-id-mapping';
import { itemTypeIdFromItem } from './nested-blocks';
import { compareStrings } from './ordering';

/**
 * The attributes the internal ledger model is created with, in CMA request
 * form, and must keep afterwards.
 */
export const LEGACY_ID_MAPPING_MODEL_ATTRIBUTES = Object.freeze({
  name: LEGACY_ID_MAPPING_MODEL_NAME,
  api_key: LEGACY_ID_MAPPING_MODEL_API_KEY,
  modular_block: false,
  singleton: false,
  sortable: false,
  tree: false,
  draft_mode_active: true,
  draft_saving_active: false,
  all_locales_required: false,
  inverse_relationships_enabled: false,
  collection_appearance: 'compact',
  ordering_direction: null,
  ordering_meta: null,
  hint: null,
});

/** Read-only ledger model attributes the CMA reports. */
const LEGACY_ID_MAPPING_MODEL_READ_ONLY_ATTRIBUTES = Object.freeze({
  has_singleton_item: false,
});

/** Ledger model relationships that must stay empty. */
const LEGACY_ID_MAPPING_MODEL_EMPTY_RELATIONSHIPS = Object.freeze([
  'workflow',
  'ordering_field',
  'presentation_image_field',
  'image_preview_field',
  'excerpt_field',
  'singleton_item',
]);

/** Ledger model relationships that must name the ledger's name field. */
const LEGACY_ID_MAPPING_MODEL_TITLE_RELATIONSHIPS = Object.freeze([
  'title_field',
  'presentation_title_field',
]);

/** The exact shape of one internal ledger field. */
export interface LegacyIdMappingFieldContract {
  apiKey: string;
  label: string;
  fieldType: 'string' | 'json';
  position: number;
  validators: JsonObject;
  appearance: JsonObject;
}

export const LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT: LegacyIdMappingFieldContract =
  Object.freeze({
    apiKey: LEGACY_ID_MAPPING_NAME_FIELD_API_KEY,
    label: LEGACY_ID_MAPPING_NAME_FIELD_LABEL,
    fieldType: 'string',
    position: 1,
    validators: { required: {}, unique: {} },
    appearance: {
      addons: [],
      editor: 'single_line',
      parameters: { heading: false, placeholder: null },
    },
  });

export const LEGACY_ID_MAPPING_FIELD_CONTRACT: LegacyIdMappingFieldContract =
  Object.freeze({
    apiKey: LEGACY_ID_MAPPING_FIELD_API_KEY,
    label: LEGACY_ID_MAPPING_FIELD_LABEL,
    fieldType: 'json',
    position: 2,
    validators: { required: {} },
    appearance: { addons: [], editor: 'json', parameters: {} },
  });

/** One way a live ledger model or field differs from its exact contract. */
export interface LegacyIdMappingSchemaMismatch {
  fieldId?: unknown;
  property: string;
  expected?: unknown;
  actual: unknown;
}

/** The ledger field IDs a plan declares, when a plan exists. */
export interface LegacyIdMappingPlannedFields {
  nameField: { id: string; status: 'existing' | 'new' };
  mappingField: { id: string; status: 'existing' | 'new' };
}

/** A stored ledger record whose document passed every check. */
export interface StoredLegacyIdMappingRecord {
  id: string;
  name: string;
  serializedDocument: string;
  hash: string;
  byteLength: number;
  document: LegacyIdMappingDocument;
  itemTypeId: string;
}

/** The claims a validated ledger holds, keyed by legacyIdMappingKey. */
export interface LegacyIdMappingLedger {
  recordsById: Map<string, StoredLegacyIdMappingRecord>;
  recordsByName: Map<string, StoredLegacyIdMappingRecord>;
  sourceClaims: Map<string, LegacyIdMappingDocumentEntry>;
  sourceClaimBatchIds: Map<string, string>;
  targetClaims: Map<string, LegacyIdMappingDocumentEntry>;
}

/** The deterministic chunk a plan reserves for a new mapping batch. */
export interface LegacyIdMappingPlannedChunk {
  id: string;
  name: string;
  hash: string;
  byteLength: number;
  serializedDocument: string;
}

/** The field attributes a ledger field is created with, in CMA request form. */
export function legacyMappingFieldAttributes(
  contract: LegacyIdMappingFieldContract,
): JsonObject {
  return {
    label: contract.label,
    api_key: contract.apiKey,
    field_type: contract.fieldType,
    localized: false,
    position: contract.position,
    validators: canonicalizeJson(contract.validators),
    appearance: canonicalizeJson(contract.appearance),
    default_value: null,
    hint: null,
    deep_filtering_enabled: false,
    content_link_enabled: true,
  };
}

/**
 * The ways a raw CMA item type differs from the exact ledger model contract.
 * A missing relationship reads as empty; a relationship that is neither
 * empty nor an object with an ID is a mismatch.
 */
export function legacyMappingModelMismatches(
  model: Record<string, any>,
): LegacyIdMappingSchemaMismatch[] {
  const mismatches: LegacyIdMappingSchemaMismatch[] = [];
  const expectedAttributes: Record<string, unknown> = {
    ...LEGACY_ID_MAPPING_MODEL_ATTRIBUTES,
    ...LEGACY_ID_MAPPING_MODEL_READ_ONLY_ATTRIBUTES,
  };
  for (const [property, expected] of Object.entries(expectedAttributes)) {
    if (model[property] !== expected) {
      mismatches.push({ property, expected, actual: model[property] });
    }
  }
  for (const property of LEGACY_ID_MAPPING_MODEL_EMPTY_RELATIONSHIPS) {
    const relationshipId = legacyIdLedgerRelationshipId(model[property]);
    if (relationshipId !== null) {
      mismatches.push({
        property,
        expected: null,
        actual: relationshipId ?? model[property],
      });
    }
  }
  return mismatches;
}

/** The ways one raw CMA field differs from its exact ledger field contract. */
export function legacyMappingFieldMismatches(
  field: Record<string, any>,
  contract: LegacyIdMappingFieldContract,
): LegacyIdMappingSchemaMismatch[] {
  const mismatches: LegacyIdMappingSchemaMismatch[] = [];
  const expectedAttributes: Record<string, unknown> = {
    label: contract.label,
    api_key: contract.apiKey,
    field_type: contract.fieldType,
    localized: false,
    position: contract.position,
    default_value: null,
    hint: null,
    deep_filtering_enabled: false,
    content_link_enabled: true,
  };
  for (const [property, expected] of Object.entries(expectedAttributes)) {
    if (field[property] !== expected) {
      mismatches.push({
        fieldId: field.id,
        property,
        expected,
        actual: field[property],
      });
    }
  }
  if (!legacyIdLedgerJsonEquals(field.validators, contract.validators)) {
    mismatches.push({
      fieldId: field.id,
      property: 'validators',
      expected: contract.validators,
      actual: field.validators,
    });
  }
  if (!legacyIdLedgerJsonEquals(field.appearance, contract.appearance)) {
    mismatches.push({
      fieldId: field.id,
      property: 'appearance',
      expected: contract.appearance,
      actual: field.appearance,
    });
  }
  const fieldsetId = legacyIdLedgerRelationshipId(field.fieldset);
  if (fieldsetId !== null) {
    mismatches.push({
      fieldId: field.id,
      property: 'fieldset',
      expected: null,
      actual: fieldsetId ?? field.fieldset,
    });
  }
  return mismatches;
}

/**
 * Finds the ledger's name and mapping fields among a ledger model's raw
 * fields and reports every way the set differs from the exact ledger schema.
 * `plannedFields` pins the IDs of fields a plan found existing. Only an
 * interrupted append the runtime is resuming may `permitPartial`: a name
 * field without the mapping field, or no fields yet.
 */
export function inspectLegacyMappingFields(
  model: Record<string, any>,
  fields: readonly unknown[],
  plannedFields: LegacyIdMappingPlannedFields | null,
  permitPartial: boolean,
): {
  nameField: Record<string, any> | null;
  mappingField: Record<string, any> | null;
  mismatches: LegacyIdMappingSchemaMismatch[];
} {
  const withApiKey = (apiKey: string) =>
    fields.filter(
      (field): field is Record<string, any> =>
        isObject(field) && field.api_key === apiKey,
    );
  const nameFields = withApiKey(LEGACY_ID_MAPPING_NAME_FIELD_API_KEY);
  const mappingFields = withApiKey(LEGACY_ID_MAPPING_FIELD_API_KEY);
  const nameField = nameFields[0] ?? null;
  const mappingField = mappingFields[0] ?? null;
  const extraFields = fields.filter(
    (field) =>
      !isObject(field) ||
      (field.api_key !== LEGACY_ID_MAPPING_NAME_FIELD_API_KEY &&
        field.api_key !== LEGACY_ID_MAPPING_FIELD_API_KEY),
  );
  const mismatches: LegacyIdMappingSchemaMismatch[] = [];
  if (extraFields.length > 0) {
    mismatches.push({
      property: 'extraFields',
      actual: extraFields.map((field) => (isObject(field) ? field.id : field)),
    });
  }
  if (nameFields.length > 1 || mappingFields.length > 1) {
    mismatches.push({
      property: 'duplicateFields',
      actual: [...nameFields.slice(1), ...mappingFields.slice(1)].map(
        (field) => field.id,
      ),
    });
  }
  for (const [field, contract, planned] of [
    [
      nameField,
      LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT,
      plannedFields?.nameField,
    ],
    [
      mappingField,
      LEGACY_ID_MAPPING_FIELD_CONTRACT,
      plannedFields?.mappingField,
    ],
  ] as const) {
    if (!field) continue;
    mismatches.push(...legacyMappingFieldMismatches(field, contract));
    if (planned?.status === 'existing' && field.id !== planned.id) {
      mismatches.push({
        fieldId: field.id,
        property: 'id',
        expected: planned.id,
        actual: field.id,
      });
    }
  }
  const expectedTitleFieldId = nameField ? nameField.id : null;
  for (const property of LEGACY_ID_MAPPING_MODEL_TITLE_RELATIONSHIPS) {
    const relationshipId = legacyIdLedgerRelationshipId(model[property]);
    if (relationshipId !== expectedTitleFieldId) {
      mismatches.push({
        property,
        expected: expectedTitleFieldId,
        actual: relationshipId === undefined ? model[property] : relationshipId,
      });
    }
  }
  if (!nameField && mappingField) {
    mismatches.push({
      property: 'partialFields',
      expected: 'name field before mapping field',
      actual: 'mapping field without name field',
    });
  }
  if (!nameField && plannedFields?.nameField.status === 'existing') {
    mismatches.push({
      property: 'nameField',
      expected: plannedFields.nameField.id,
      actual: 'missing',
    });
  }
  if (!mappingField && plannedFields?.mappingField.status === 'existing') {
    mismatches.push({
      property: 'mappingField',
      expected: plannedFields.mappingField.id,
      actual: 'missing',
    });
  }
  if ((!nameField || !mappingField) && !permitPartial) {
    mismatches.push({
      property: 'fieldCount',
      expected: 2,
      actual: fields.length,
    });
  }
  return { nameField, mappingField, mismatches };
}

/**
 * Parses one stored ledger record: its ID, model, field values and
 * lifecycle, then its canonical mapping document, deterministic name and
 * uniquely sorted entries. Any defect is a ledger record conflict.
 */
export function parseStoredLegacyIdMappingRecord(
  record: unknown,
  modelId: string,
  projectId: string,
): StoredLegacyIdMappingRecord {
  const candidate: Record<string, any> = isObject(record) ? record : {};
  const recordId = String(isObject(record) ? record.id : record);
  const name = candidate[LEGACY_ID_MAPPING_NAME_FIELD_API_KEY];
  const serializedDocument = candidate[LEGACY_ID_MAPPING_FIELD_API_KEY];
  if (
    !isObject(record) ||
    !isPortableDatoId(candidate.id) ||
    itemTypeIdFromItem(candidate) !== modelId ||
    typeof name !== 'string' ||
    !name ||
    typeof serializedDocument !== 'string'
  ) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      `Internal mapping record ${recordId} has an invalid ID, model relationship, or field value shape.`,
      { recordId },
    );
  }
  const meta: Record<string, any> = isObject(candidate.meta)
    ? candidate.meta
    : {};
  if (
    meta.status !== 'draft' ||
    meta.is_valid !== true ||
    meta.is_current_version_valid !== true ||
    meta.is_published_version_valid !== null ||
    meta.stage !== null ||
    meta.publication_scheduled_at !== null ||
    meta.unpublishing_scheduled_at !== null ||
    meta.published_at !== null ||
    meta.first_published_at !== null
  ) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      `Internal mapping record ${recordId} must remain a valid, unscheduled, workflow-free draft with no published version.`,
      { recordId },
    );
  }
  const byteLength = utf8ByteLength(serializedDocument);
  if (byteLength > LEGACY_ID_MAPPING_MAX_DOCUMENT_BYTES) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      `Internal mapping record ${recordId} exceeds the 128 KiB serialized mapping limit.`,
      { recordId },
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(serializedDocument);
  } catch (error) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      `Internal mapping record ${recordId} contains malformed JSON.`,
      { recordId, cause: legacyIdLedgerErrorMessage(error) },
    );
  }
  if (!isLegacyIdMappingDocument(document, projectId)) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      `Internal mapping record ${recordId} has invalid ledger metadata.`,
      { recordId },
    );
  }
  if (canonicalPrettyStringify(document) !== serializedDocument) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      `Internal mapping record ${recordId} is not encoded with canonical pretty JSON.`,
      { recordId },
    );
  }
  if (
    name !==
    legacyIdMappingChunkName(
      document.batchId,
      document.chunkIndex,
      document.chunkCount,
    )
  ) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      `Internal mapping record ${recordId} has a name inconsistent with its deterministic batch position.`,
      { recordId },
    );
  }
  let previousSortKey: string | null = null;
  for (const entry of document.entries) {
    try {
      validateLegacyIdMappingEntry(entry, false, 'stored mapping entry');
    } catch (error) {
      throw sharedFailure(
        'legacyMappingRecordConflict',
        `Internal mapping record ${recordId} contains an invalid mapping entry.`,
        { recordId, cause: legacyIdLedgerErrorMessage(error) },
      );
    }
    const sortKey = legacyIdMappingSortKey(entry.entityType, entry.sourceId);
    if (
      previousSortKey !== null &&
      compareStrings(sortKey, previousSortKey) <= 0
    ) {
      throw sharedFailure(
        'legacyMappingRecordConflict',
        `Internal mapping record ${recordId} entries are not uniquely sorted.`,
        { recordId },
      );
    }
    previousSortKey = sortKey;
  }
  return {
    id: candidate.id,
    name,
    serializedDocument,
    hash: sha256(serializedDocument),
    byteLength,
    document,
    itemTypeId: modelId,
  };
}

/**
 * Validates parsed ledger records as a whole: unique IDs and names,
 * consistent batches, uniquely sorted entries across each batch's chunks,
 * unique source and target claims, and whole-batch integrity. A batch must be
 * complete unless `permitPartial` is set and it is a chunk prefix of
 * `plannedBatch`, which only a resuming runtime passes. Chunks of the planned
 * batch must match its deterministic reservation exactly.
 */
export function validateLegacyIdMappingLedger(
  records: readonly StoredLegacyIdMappingRecord[],
  plannedBatch: {
    batchId: string;
    wholeHash: string;
    chunks: readonly LegacyIdMappingPlannedChunk[];
  } | null,
  permitPartial: boolean,
): LegacyIdMappingLedger {
  const recordsById = new Map<string, StoredLegacyIdMappingRecord>();
  const recordsByName = new Map<string, StoredLegacyIdMappingRecord>();
  const sourceClaims = new Map<string, LegacyIdMappingDocumentEntry>();
  const sourceClaimBatchIds = new Map<string, string>();
  const targetClaims = new Map<string, LegacyIdMappingDocumentEntry>();
  const batches = new Map<
    string,
    {
      batchId: string;
      chunkCount: number;
      wholeHash: string;
      chunks: Map<number, StoredLegacyIdMappingRecord>;
    }
  >();

  for (const record of records) {
    if (recordsById.has(record.id) || recordsByName.has(record.name)) {
      throw sharedFailure(
        'legacyMappingRecordConflict',
        'Internal mapping records contain duplicate IDs or names.',
        { recordId: record.id, name: record.name },
      );
    }
    recordsById.set(record.id, record);
    recordsByName.set(record.name, record);
    const batchId = record.document.batchId;
    const batch = batches.get(batchId) ?? {
      batchId,
      chunkCount: record.document.chunkCount,
      wholeHash: record.document.wholeHash,
      chunks: new Map<number, StoredLegacyIdMappingRecord>(),
    };
    if (
      batch.chunkCount !== record.document.chunkCount ||
      batch.wholeHash !== record.document.wholeHash ||
      batch.chunks.has(record.document.chunkIndex)
    ) {
      throw sharedFailure(
        'legacyMappingRecordConflict',
        `Internal mapping batch ${batchId} contains inconsistent or duplicate chunk metadata.`,
        { batchId },
      );
    }
    batch.chunks.set(record.document.chunkIndex, record);
    batches.set(batchId, batch);
  }

  for (const batch of batches.values()) {
    const plannedCurrentBatch =
      plannedBatch && plannedBatch.batchId === batch.batchId
        ? plannedBatch
        : null;
    const presentIndexes = [...batch.chunks.keys()].sort(
      (left, right) => left - right,
    );
    const isPrefix = presentIndexes.every((value, index) => value === index);
    const complete = presentIndexes.length === batch.chunkCount && isPrefix;
    if (
      !complete &&
      !(
        permitPartial &&
        plannedCurrentBatch &&
        batch.chunkCount === plannedCurrentBatch.chunks.length &&
        batch.wholeHash === plannedCurrentBatch.wholeHash &&
        isPrefix
      )
    ) {
      throw sharedFailure(
        'legacyMappingRecordConflict',
        `Internal mapping batch ${batch.batchId} is incomplete and is not a recoverable prefix of this migration.`,
        { batchId: batch.batchId },
      );
    }

    const combinedEntries: LegacyIdMappingDocumentEntry[] = [];
    for (const index of presentIndexes) {
      const record = batch.chunks.get(index) as StoredLegacyIdMappingRecord;
      if (plannedCurrentBatch) {
        assertExactLegacyMappingChunkRecord(
          record,
          plannedCurrentBatch.chunks[index],
        );
      }
      combinedEntries.push(...record.document.entries);
    }
    let previousSortKey: string | null = null;
    for (const entry of combinedEntries) {
      const sourceKey = legacyIdMappingKey(entry.entityType, entry.sourceId);
      const targetKey = legacyIdMappingKey(entry.entityType, entry.targetId);
      const sortKey = legacyIdMappingSortKey(entry.entityType, entry.sourceId);
      if (
        previousSortKey !== null &&
        compareStrings(sortKey, previousSortKey) <= 0
      ) {
        throw sharedFailure(
          'legacyMappingRecordConflict',
          `Internal mapping batch ${batch.batchId} entries are not uniquely sorted across chunks.`,
          { batchId: batch.batchId },
        );
      }
      previousSortKey = sortKey;
      const priorSource = sourceClaims.get(sourceKey);
      const priorTarget = targetClaims.get(targetKey);
      if (priorSource || priorTarget) {
        throw sharedFailure(
          'legacyMappingConflict',
          'Persistent legacy-ID mappings contain duplicate source or target claims.',
          {
            entityType: entry.entityType,
            sourceId: entry.sourceId,
            targetId: entry.targetId,
            priorSource: priorSource ? { ...priorSource } : null,
            priorTarget: priorTarget ? { ...priorTarget } : null,
          },
        );
      }
      sourceClaims.set(sourceKey, entry);
      sourceClaimBatchIds.set(sourceKey, batch.batchId);
      targetClaims.set(targetKey, entry);
    }
    if (
      complete &&
      sha256(stableStringify(combinedEntries)) !== batch.wholeHash
    ) {
      throw sharedFailure(
        'legacyMappingRecordConflict',
        `Internal mapping batch ${batch.batchId} failed whole-batch integrity verification.`,
        { batchId: batch.batchId },
      );
    }
  }

  return {
    recordsById,
    recordsByName,
    sourceClaims,
    sourceClaimBatchIds,
    targetClaims,
  };
}

/** Rejects a stored chunk that differs from its deterministic reservation. */
export function assertExactLegacyMappingChunkRecord(
  record: StoredLegacyIdMappingRecord,
  plannedChunk: LegacyIdMappingPlannedChunk | undefined,
): void {
  if (!legacyMappingChunkMatches(record, plannedChunk)) {
    throw sharedFailure(
      'legacyMappingRecordConflict',
      "Existing mapping chunk does not exactly match this migration's deterministic reservation.",
      {
        recordId: record.id,
        batchId: record.document.batchId,
        chunkIndex: record.document.chunkIndex,
      },
    );
  }
}

/** Whether a stored chunk is byte-identical to its planned reservation. */
export function legacyMappingChunkMatches(
  record: StoredLegacyIdMappingRecord | null | undefined,
  plannedChunk: LegacyIdMappingPlannedChunk | null | undefined,
): boolean {
  return Boolean(
    record &&
      plannedChunk &&
      record.id === plannedChunk.id &&
      record.name === plannedChunk.name &&
      record.hash === plannedChunk.hash &&
      record.byteLength === plannedChunk.byteLength &&
      record.serializedDocument === plannedChunk.serializedDocument,
  );
}

function isLegacyIdMappingDocument(
  document: unknown,
  projectId: string,
): document is LegacyIdMappingDocument {
  return (
    isObject(document) &&
    document.formatVersion === LEGACY_ID_MAPPING_FORMAT_VERSION &&
    document.projectId === projectId &&
    isPortableDatoId(document.batchId) &&
    Number.isInteger(document.chunkIndex) &&
    document.chunkIndex >= 0 &&
    Number.isInteger(document.chunkCount) &&
    document.chunkCount > 0 &&
    document.chunkIndex < document.chunkCount &&
    typeof document.wholeHash === 'string' &&
    /^[0-9a-f]{64}$/.test(document.wholeHash) &&
    Array.isArray(document.entries) &&
    document.entries.length > 0 &&
    stableStringify(Object.keys(document).sort(compareStrings)) ===
      stableStringify([
        'batchId',
        'chunkCount',
        'chunkIndex',
        'entries',
        'formatVersion',
        'projectId',
        'wholeHash',
      ])
  );
}

/**
 * The ID of a ledger relationship: null when it is empty or absent, its ID
 * when it is an object with a non-empty string ID, and undefined when it is
 * malformed, so that it matches no expectation.
 */
function legacyIdLedgerRelationshipId(
  value: unknown,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  return isObject(value) && typeof value.id === 'string' && value.id
    ? value.id
    : undefined;
}

function legacyIdLedgerJsonEquals(actual: unknown, expected: unknown): boolean {
  try {
    return stableStringify(actual) === stableStringify(expected);
  } catch {
    return false;
  }
}

function legacyIdLedgerErrorMessage(error: unknown): string {
  return isObject(error) && typeof error.message === 'string' && error.message
    ? error.message
    : String(error);
}
