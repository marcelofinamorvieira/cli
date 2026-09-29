// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { JsonObject } from '../types';
import {
  LEGACY_ID_MAPPING_ENTITY_TYPES,
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
import { isCanonicalLegacyDatoId, isPortableDatoId } from './ids';
import {
  canonicalPrettyStringify,
  isObject,
  sha256,
  stableStringify,
  utf8ByteLength,
} from './json';
import { collectNestedBlocks } from './nested-blocks';
import { compareStrings } from './ordering';
import {
  collectUploadIdsFromFields,
  visitRecordReferencesInFields,
} from './references';

/** The live slices (current, published) a mapped target must exist in. */
export interface LegacyIdMappingAvailability {
  current: boolean;
  published: boolean;
}

/**
 * The claim key of a legacy mapping ID. Records and blocks share the Item ID
 * space, so they share one namespace.
 */
export function legacyIdMappingKey(entityType: string, id: string): string {
  return `${legacyIdMappingNamespace(entityType)}\u0000${id}`;
}

export function legacyIdMappingNamespace(entityType: string): string {
  return entityType === 'record' || entityType === 'block'
    ? 'item'
    : entityType;
}

/** The deterministic sort key of mapping entries: entity type, then source ID. */
export function legacyIdMappingSortKey(entityType: string, id: string): string {
  return `${entityType}\u0000${id}`;
}

/** The unique ledger record name of one chunk of a new mapping batch. */
export function legacyIdMappingChunkName(
  batchId: string,
  chunkIndex: number,
  chunkCount: number,
): string {
  return `legacy-id-map:${batchId}:${String(chunkIndex + 1)}/${String(
    chunkCount,
  )}`;
}

/**
 * Checks one legacy-ID mapping entry: a plan entry (`includeStatus`) carries
 * its status, scope and availability, while a ledger document entry holds
 * exactly the entity type, source ID and target ID.
 */
export function validateLegacyIdMappingEntry(
  entry: unknown,
  includeStatus: boolean,
  label: string,
): void {
  const candidate: Record<string, any> = isObject(entry) ? entry : {};
  if (
    !isObject(entry) ||
    !LEGACY_ID_MAPPING_ENTITY_TYPES.has(candidate.entityType) ||
    typeof candidate.sourceId !== 'string' ||
    !isCanonicalLegacyDatoId(candidate.sourceId) ||
    typeof candidate.targetId !== 'string' ||
    !isPortableDatoId(candidate.targetId) ||
    candidate.sourceId === candidate.targetId ||
    (includeStatus &&
      (!['existing', 'new'].includes(candidate.status) ||
        typeof candidate.managed !== 'boolean' ||
        !(
          candidate.expectedItemTypeId === null ||
          (typeof candidate.expectedItemTypeId === 'string' &&
            candidate.expectedItemTypeId)
        ) ||
        !isObject(candidate.requiredAvailability) ||
        typeof candidate.requiredAvailability.current !== 'boolean' ||
        typeof candidate.requiredAvailability.published !== 'boolean' ||
        stableStringify(Object.keys(candidate.requiredAvailability).sort()) !==
          stableStringify(['current', 'published']) ||
        stableStringify(Object.keys(candidate).sort()) !==
          stableStringify([
            'entityType',
            'expectedItemTypeId',
            'managed',
            'requiredAvailability',
            'sourceId',
            'status',
            'targetId',
          ]) ||
        (candidate.status === 'new' && candidate.managed !== true) ||
        (candidate.managed === true && candidate.expectedItemTypeId !== null) ||
        (candidate.managed === false &&
          (candidate.entityType !== 'record' ||
            typeof candidate.expectedItemTypeId !== 'string' ||
            !candidate.expectedItemTypeId)))) ||
    (!includeStatus &&
      (Object.prototype.hasOwnProperty.call(candidate, 'status') ||
        Object.prototype.hasOwnProperty.call(candidate, 'managed') ||
        Object.prototype.hasOwnProperty.call(candidate, 'expectedItemTypeId') ||
        Object.prototype.hasOwnProperty.call(
          candidate,
          'requiredAvailability',
        ) ||
        stableStringify(Object.keys(candidate).sort()) !==
          stableStringify(['entityType', 'sourceId', 'targetId'])))
  ) {
    throw sharedFailure('invalidPlan', `Invalid legacy-ID ${label}.`);
  }
}

/**
 * The availability each final managed entity offers a mapping: records in
 * their current and (when published) published slices, nested blocks in the
 * slices whose fields hold them, uploads and collections in current only.
 * Preserved historical blocks may use models only the target inspection
 * schema describes, exactly as plan validation traverses them.
 */
export function collectManagedLegacyIdMappingAvailability(
  plan: Record<string, any>,
): Map<string, LegacyIdMappingAvailability> {
  const availability = new Map<string, LegacyIdMappingAvailability>();
  const captureSchemaById = new Map<string, any>(
    plan.schema.itemTypes
      .concat(plan.targetInspection.itemTypes)
      .map((itemType: any) => [itemType.id, itemType]),
  );
  for (const record of plan.records) {
    if (!record.desired) continue;
    availability.set(legacyIdMappingKey('record', record.id), {
      current: true,
      published: record.desired.published !== null,
    });
    const currentBlocks = new Map<string, JsonObject>();
    collectNestedBlocks(
      record.desired.current.fields,
      currentBlocks,
      captureSchemaById.get(record.itemTypeId),
      captureSchemaById,
    );
    const publishedBlocks = new Map<string, JsonObject>();
    if (record.desired.published) {
      collectNestedBlocks(
        record.desired.published.fields,
        publishedBlocks,
        captureSchemaById.get(record.itemTypeId),
        captureSchemaById,
      );
    }
    for (const blockId of new Set([
      ...currentBlocks.keys(),
      ...publishedBlocks.keys(),
    ])) {
      availability.set(legacyIdMappingKey('block', blockId), {
        current: currentBlocks.has(blockId),
        published: publishedBlocks.has(blockId),
      });
    }
  }
  for (const upload of plan.uploads) {
    if (upload.desired) {
      availability.set(legacyIdMappingKey('upload', upload.id), {
        current: true,
        published: false,
      });
    }
  }
  for (const collection of plan.uploadCollections) {
    if (collection.desired) {
      availability.set(legacyIdMappingKey('upload_collection', collection.id), {
        current: true,
        published: false,
      });
    }
  }
  return availability;
}

/**
 * The availability final managed content requires from entities outside the
 * plan: records its current and published fields and tree parents reference,
 * uploads its fields reference (current only), and upload collections its
 * uploads are filed in.
 */
export function collectExternalLegacyIdMappingAvailability(
  plan: Record<string, any>,
): Map<string, LegacyIdMappingAvailability> {
  const availability = new Map<string, LegacyIdMappingAvailability>();
  const schemaById = new Map<string, any>(
    plan.schema.itemTypes.map((entry: any) => [entry.id, entry]),
  );
  const captureSchemaById = new Map<string, any>(
    plan.schema.itemTypes
      .concat(plan.targetInspection.itemTypes)
      .map((entry: any) => [entry.id, entry]),
  );
  const mark = (entityType: string, id: string, published: boolean): void => {
    const key = legacyIdMappingKey(entityType, id);
    const current = availability.get(key) || {
      current: false,
      published: false,
    };
    current.current = true;
    if (published) current.published = true;
    availability.set(key, current);
  };
  for (const record of plan.records) {
    if (!record.desired) continue;
    const itemType = schemaById.get(record.itemTypeId);
    if (!itemType) continue;
    const currentReferences = new Set<string>();
    visitRecordReferencesInFields(
      record.desired.current.fields,
      itemType,
      captureSchemaById,
      (recordId) => {
        currentReferences.add(recordId);
      },
    );
    currentReferences.forEach((id) => mark('record', id, false));
    if (record.desired.topology.parentId) {
      mark('record', record.desired.topology.parentId, false);
    }
    if (record.desired.published) {
      const publishedReferences = new Set<string>();
      visitRecordReferencesInFields(
        record.desired.published.fields,
        itemType,
        captureSchemaById,
        (recordId) => {
          publishedReferences.add(recordId);
        },
      );
      publishedReferences.forEach((id) => mark('record', id, true));
    }
    const currentUploads = new Set<string>();
    collectUploadIdsFromFields(
      record.desired.current.fields,
      itemType,
      captureSchemaById,
      currentUploads,
    );
    currentUploads.forEach((id) => mark('upload', id, false));
    if (record.desired.published) {
      const publishedUploads = new Set<string>();
      collectUploadIdsFromFields(
        record.desired.published.fields,
        itemType,
        captureSchemaById,
        publishedUploads,
      );
      publishedUploads.forEach((id) => mark('upload', id, false));
    }
  }
  for (const upload of plan.uploads) {
    if (upload.desired?.manual.collectionId) {
      mark('upload_collection', upload.desired.manual.collectionId, false);
    }
  }
  return availability;
}

/**
 * Checks the plan's legacy-ID mapping contract: the exact internal ledger
 * schema, canonical existing records and skipped diagnostics, every entry's
 * claim against the final managed state or the external dependencies it
 * serves, and the new mapping batch's deterministic chunks.
 */
export function validateLegacyIdMappingPlan(
  plan: Record<string, any>,
  managedNestedBlockIds: ReadonlySet<string>,
  plannedNestedBlockIds: ReadonlySet<string>,
): void {
  const mappingPlan = plan.legacyIdMappings;
  const mappingSchema = mappingPlan?.schema;
  if (
    !isObject(mappingPlan) ||
    mappingPlan.formatVersion !== LEGACY_ID_MAPPING_FORMAT_VERSION ||
    !isObject(mappingSchema) ||
    !isObject(mappingSchema.model) ||
    !isObject(mappingSchema.nameField) ||
    !isObject(mappingSchema.mappingField) ||
    typeof mappingSchema.model.id !== 'string' ||
    !mappingSchema.model.id ||
    !['existing', 'new'].includes(mappingSchema.model.status) ||
    (mappingSchema.model.status === 'new' &&
      !isPortableDatoId(mappingSchema.model.id)) ||
    mappingSchema.model.apiKey !== LEGACY_ID_MAPPING_MODEL_API_KEY ||
    mappingSchema.model.name !== LEGACY_ID_MAPPING_MODEL_NAME ||
    mappingSchema.model.modularBlock !== false ||
    mappingSchema.model.singleton !== false ||
    mappingSchema.model.sortable !== false ||
    mappingSchema.model.tree !== false ||
    mappingSchema.model.draftModeActive !== true ||
    mappingSchema.model.draftSavingActive !== false ||
    mappingSchema.model.allLocalesRequired !== false ||
    mappingSchema.model.inverseRelationshipsEnabled !== false ||
    mappingSchema.model.workflowId !== null ||
    typeof mappingSchema.nameField.id !== 'string' ||
    !mappingSchema.nameField.id ||
    !['existing', 'new'].includes(mappingSchema.nameField.status) ||
    (mappingSchema.nameField.status === 'new' &&
      !isPortableDatoId(mappingSchema.nameField.id)) ||
    mappingSchema.nameField.apiKey !== LEGACY_ID_MAPPING_NAME_FIELD_API_KEY ||
    mappingSchema.nameField.label !== LEGACY_ID_MAPPING_NAME_FIELD_LABEL ||
    mappingSchema.nameField.fieldType !== 'string' ||
    mappingSchema.nameField.localized !== false ||
    mappingSchema.nameField.position !== 1 ||
    stableStringify(mappingSchema.nameField.validators) !==
      stableStringify({ required: {}, unique: {} }) ||
    typeof mappingSchema.mappingField.id !== 'string' ||
    !mappingSchema.mappingField.id ||
    !['existing', 'new'].includes(mappingSchema.mappingField.status) ||
    (mappingSchema.mappingField.status === 'new' &&
      !isPortableDatoId(mappingSchema.mappingField.id)) ||
    mappingSchema.mappingField.apiKey !== LEGACY_ID_MAPPING_FIELD_API_KEY ||
    mappingSchema.mappingField.label !== LEGACY_ID_MAPPING_FIELD_LABEL ||
    mappingSchema.mappingField.fieldType !== 'json' ||
    mappingSchema.mappingField.localized !== false ||
    mappingSchema.mappingField.position !== 2 ||
    stableStringify(mappingSchema.mappingField.validators) !==
      stableStringify({ required: {} }) ||
    mappingSchema.nameField.status !== mappingSchema.model.status ||
    mappingSchema.mappingField.status !== mappingSchema.model.status ||
    !Array.isArray(mappingPlan.existingMappingRecords) ||
    !Array.isArray(mappingPlan.entries) ||
    !Array.isArray(mappingPlan.skippedEntries) ||
    !(
      mappingPlan.newMappingBatch === null ||
      isObject(mappingPlan.newMappingBatch)
    )
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan has an invalid legacy-ID mapping contract.',
    );
  }
  let previousExistingMappingRecordId: string | null = null;
  const existingMappingRecordIds = new Set<string>();
  for (const record of mappingPlan.existingMappingRecords) {
    if (
      !isObject(record) ||
      !isPortableDatoId(record.id) ||
      typeof record.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.hash) ||
      stableStringify(Object.keys(record).sort()) !==
        stableStringify(['hash', 'id']) ||
      (previousExistingMappingRecordId !== null &&
        compareStrings(record.id, previousExistingMappingRecordId) <= 0)
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Existing legacy-ID mapping records must have unique portable IDs, exact hashes, and deterministic ordering.',
      );
    }
    previousExistingMappingRecordId = record.id;
    existingMappingRecordIds.add(record.id);
  }
  let previousSkippedEntrySortKey: string | null = null;
  const skippedSourceClaims = new Set<string>();
  for (const entry of mappingPlan.skippedEntries) {
    const sortKey =
      isObject(entry) &&
      typeof entry.entityType === 'string' &&
      typeof entry.sourceId === 'string' &&
      typeof entry.reason === 'string'
        ? `${entry.entityType}\u0000${entry.sourceId}\u0000${entry.reason}`
        : null;
    const sourceKey =
      isObject(entry) &&
      typeof entry.entityType === 'string' &&
      typeof entry.sourceId === 'string'
        ? legacyIdMappingKey(entry.entityType, entry.sourceId)
        : null;
    if (
      !isObject(entry) ||
      !LEGACY_ID_MAPPING_ENTITY_TYPES.has(entry.entityType) ||
      !isCanonicalLegacyDatoId(entry.sourceId) ||
      typeof entry.reason !== 'string' ||
      !entry.reason ||
      stableStringify(Object.keys(entry).sort()) !==
        stableStringify(['entityType', 'reason', 'sourceId']) ||
      sortKey === null ||
      (previousSkippedEntrySortKey !== null &&
        compareStrings(sortKey, previousSkippedEntrySortKey) <= 0) ||
      sourceKey === null ||
      skippedSourceClaims.has(sourceKey)
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Skipped legacy-ID mapping diagnostics must be canonical, unique, and deterministically sorted.',
      );
    }
    previousSkippedEntrySortKey = sortKey;
    skippedSourceClaims.add(sourceKey);
  }
  const newSchemaEntries = [
    mappingSchema.model,
    mappingSchema.nameField,
    mappingSchema.mappingField,
  ].filter((entry) => entry.status === 'new');
  const managedSchemaIds = new Set<string>();
  for (const itemType of plan.schema.itemTypes) {
    managedSchemaIds.add(itemType.id);
    for (const field of itemType.fields) managedSchemaIds.add(field.id);
  }
  if (
    new Set(newSchemaEntries.map((entry) => entry.id)).size !==
      newSchemaEntries.length ||
    newSchemaEntries.some((entry) => managedSchemaIds.has(entry.id))
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Internal legacy-ID mapping schema IDs collide with managed schema IDs.',
    );
  }

  const idsOf = (entries: any[], desiredOnly: boolean): Set<string> =>
    new Set(
      entries
        .filter((entry) => !desiredOnly || entry.desired)
        .map((entry) => entry.id),
    );
  const expectedTargetIds: Record<string, ReadonlySet<string>> = {
    record: idsOf(plan.records, true),
    block: managedNestedBlockIds,
    upload: idsOf(plan.uploads, true),
    upload_collection: idsOf(plan.uploadCollections, true),
  };
  const allPlannedTargetIds: Record<string, ReadonlySet<string>> = {
    record: idsOf(plan.records, false),
    block: plannedNestedBlockIds,
    upload: idsOf(plan.uploads, false),
    upload_collection: idsOf(plan.uploadCollections, false),
  };
  const expectedManagedAvailability =
    collectManagedLegacyIdMappingAvailability(plan);
  const expectedExternalAvailability =
    collectExternalLegacyIdMappingAvailability(plan);
  const sourceClaims = new Map<string, Record<string, any>>();
  const targetClaims = new Map<string, Record<string, any>>();
  let previousEntrySortKey: string | null = null;
  for (const entry of mappingPlan.entries) {
    validateLegacyIdMappingEntry(entry, true, 'plan entry');
    const sourceKey = legacyIdMappingKey(entry.entityType, entry.sourceId);
    const targetKey = legacyIdMappingKey(entry.entityType, entry.targetId);
    const entrySortKey = legacyIdMappingSortKey(
      entry.entityType,
      entry.sourceId,
    );
    if (
      previousEntrySortKey !== null &&
      compareStrings(entrySortKey, previousEntrySortKey) <= 0
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Legacy-ID mapping plan entries must be uniquely sorted by entity type and source ID.',
      );
    }
    previousEntrySortKey = entrySortKey;
    if (sourceClaims.has(sourceKey) || targetClaims.has(targetKey)) {
      throw sharedFailure(
        'invalidPlan',
        'Legacy-ID mapping plan contains duplicate source or target claims.',
        {
          entityType: entry.entityType,
          sourceId: entry.sourceId,
          targetId: entry.targetId,
        },
      );
    }
    if (skippedSourceClaims.has(sourceKey)) {
      throw sharedFailure(
        'invalidPlan',
        'A legacy source ID cannot be both migrated and reported as skipped.',
      );
    }
    if (entry.managed) {
      if (!expectedTargetIds[entry.entityType].has(entry.targetId)) {
        throw sharedFailure(
          'invalidPlan',
          `Managed legacy-ID mapping target ${entry.targetId} is not present as a final managed ${entry.entityType}.`,
        );
      }
      const expectedAvailability = expectedManagedAvailability.get(targetKey);
      if (
        !expectedAvailability ||
        stableStringify(entry.requiredAvailability) !==
          stableStringify(expectedAvailability)
      ) {
        throw sharedFailure(
          'invalidPlan',
          `Managed legacy-ID mapping target ${entry.targetId} has availability metadata inconsistent with its final managed state.`,
        );
      }
    } else {
      if (entry.status !== 'existing' || entry.entityType !== 'record') {
        throw sharedFailure(
          'invalidPlan',
          'Only existing record aliases can be declared external to the managed content scope.',
        );
      }
      const belongsToAnyPlannedEntity =
        entry.entityType === 'record' || entry.entityType === 'block'
          ? allPlannedTargetIds.record.has(entry.targetId) ||
            allPlannedTargetIds.block.has(entry.targetId)
          : allPlannedTargetIds[entry.entityType].has(entry.targetId);
      if (belongsToAnyPlannedEntity) {
        throw sharedFailure(
          'invalidPlan',
          `External legacy-ID mapping target ${entry.targetId} is also managed, deleted, or otherwise owned by this plan.`,
        );
      }
      const expectedAvailability = expectedExternalAvailability.get(targetKey);
      if (
        !expectedAvailability ||
        stableStringify(entry.requiredAvailability) !==
          stableStringify(expectedAvailability)
      ) {
        throw sharedFailure(
          'invalidPlan',
          `External legacy-ID mapping target ${entry.targetId} is unused or has availability metadata inconsistent with final rewritten dependencies.`,
        );
      }
    }
    sourceClaims.set(sourceKey, entry);
    targetClaims.set(targetKey, entry);
  }

  const mappedItemTargetIds = new Set<string>(
    mappingPlan.entries
      .filter(
        (entry: any) =>
          entry.entityType === 'record' || entry.entityType === 'block',
      )
      .map((entry: any) => entry.targetId),
  );
  for (const targetId of mappedItemTargetIds) {
    if (existingMappingRecordIds.has(targetId)) {
      throw sharedFailure(
        'invalidPlan',
        `Legacy Item mapping target ${targetId} collides with an existing internal mapping record ID.`,
      );
    }
  }

  const newEntries: any[] = mappingPlan.entries.filter(
    (entry: any) => entry.status === 'new',
  );
  const mappingBatch = mappingPlan.newMappingBatch;
  if ((newEntries.length === 0) !== (mappingBatch === null)) {
    throw sharedFailure(
      'invalidPlan',
      "Legacy-ID mapping batch presence does not match the plan's new mappings.",
    );
  }
  if (mappingBatch === null) return;
  const newMappingDocumentEntries = newEntries.map((entry) => ({
    entityType: entry.entityType,
    sourceId: entry.sourceId,
    targetId: entry.targetId,
  }));
  if (
    !isPortableDatoId(mappingBatch.batchId) ||
    typeof mappingBatch.wholeHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(mappingBatch.wholeHash) ||
    !Array.isArray(mappingBatch.chunks) ||
    mappingBatch.chunks.length === 0 ||
    sha256(stableStringify(newMappingDocumentEntries)) !==
      mappingBatch.wholeHash
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan has invalid legacy-ID mapping batch metadata.',
    );
  }

  const coveredNewEntries: unknown[] = [];
  const mappingRecordIds = new Set<string>();
  const mappingRecordNames = new Set<string>();
  const reservedItemIds = idsOf(plan.records, false);
  plannedNestedBlockIds.forEach((id) => reservedItemIds.add(id));
  mappedItemTargetIds.forEach((id) => reservedItemIds.add(id));

  for (let index = 0; index < mappingBatch.chunks.length; index += 1) {
    const mappingRecord = mappingBatch.chunks[index];
    if (
      !isObject(mappingRecord) ||
      !isPortableDatoId(mappingRecord.id) ||
      mappingRecordIds.has(mappingRecord.id) ||
      existingMappingRecordIds.has(mappingRecord.id) ||
      reservedItemIds.has(mappingRecord.id) ||
      typeof mappingRecord.name !== 'string' ||
      !mappingRecord.name ||
      mappingRecord.name !==
        legacyIdMappingChunkName(
          mappingBatch.batchId,
          index,
          mappingBatch.chunks.length,
        ) ||
      mappingRecordNames.has(mappingRecord.name) ||
      mappingRecord.chunkIndex !== index ||
      mappingRecord.chunkCount !== mappingBatch.chunks.length ||
      typeof mappingRecord.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(mappingRecord.hash) ||
      !Number.isInteger(mappingRecord.byteLength) ||
      mappingRecord.byteLength <= 0 ||
      mappingRecord.byteLength > LEGACY_ID_MAPPING_MAX_DOCUMENT_BYTES ||
      typeof mappingRecord.serializedDocument !== 'string' ||
      !isObject(mappingRecord.document) ||
      mappingRecord.document.formatVersion !==
        LEGACY_ID_MAPPING_FORMAT_VERSION ||
      mappingRecord.document.projectId !== plan.target.siteId ||
      mappingRecord.document.batchId !== mappingBatch.batchId ||
      mappingRecord.document.chunkIndex !== mappingRecord.chunkIndex ||
      mappingRecord.document.chunkCount !== mappingRecord.chunkCount ||
      mappingRecord.document.wholeHash !== mappingBatch.wholeHash ||
      !Array.isArray(mappingRecord.document.entries) ||
      mappingRecord.document.entries.length === 0 ||
      stableStringify(Object.keys(mappingRecord.document).sort()) !==
        stableStringify(
          [
            'batchId',
            'chunkCount',
            'chunkIndex',
            'entries',
            'formatVersion',
            'projectId',
            'wholeHash',
          ].sort(),
        )
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Legacy-ID mapping plan contains an invalid mapping record chunk.',
      );
    }
    mappingRecordIds.add(mappingRecord.id);
    mappingRecordNames.add(mappingRecord.name);

    const documentBytes = canonicalPrettyStringify(mappingRecord.document);
    if (
      mappingRecord.serializedDocument !== documentBytes ||
      sha256(documentBytes) !== mappingRecord.hash ||
      utf8ByteLength(documentBytes) !== mappingRecord.byteLength
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Legacy-ID mapping record ${mappingRecord.id} has invalid hash or byte-length metadata.`,
      );
    }

    let previousDocumentEntrySortKey: string | null = null;
    for (const entry of mappingRecord.document.entries) {
      validateLegacyIdMappingEntry(entry, false, 'mapping document entry');
      const entryKey = legacyIdMappingKey(entry.entityType, entry.sourceId);
      const entrySortKey = legacyIdMappingSortKey(
        entry.entityType,
        entry.sourceId,
      );
      if (
        previousDocumentEntrySortKey !== null &&
        compareStrings(entrySortKey, previousDocumentEntrySortKey) <= 0
      ) {
        throw sharedFailure(
          'invalidPlan',
          `Legacy-ID mapping document ${mappingRecord.id} entries must be uniquely sorted.`,
        );
      }
      previousDocumentEntrySortKey = entrySortKey;
      const planned = sourceClaims.get(entryKey);
      if (
        !planned ||
        planned.entityType !== entry.entityType ||
        planned.status !== 'new' ||
        planned.targetId !== entry.targetId
      ) {
        throw sharedFailure(
          'invalidPlan',
          `Legacy-ID mapping document ${mappingRecord.id} contains an entry not declared as new by the plan.`,
        );
      }
      coveredNewEntries.push(entry);
    }
  }
  if (
    stableStringify(coveredNewEntries) !==
    stableStringify(newMappingDocumentEntries)
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Legacy-ID mapping chunks do not cover every new mapping exactly once.',
    );
  }
  const createsMappingSchema = [
    mappingSchema.model,
    mappingSchema.nameField,
    mappingSchema.mappingField,
  ].some((entry) => entry.status === 'new');
  if (createsMappingSchema && plan.requiredPermissions.editSchema !== true) {
    throw sharedFailure(
      'invalidPlan',
      'Creating the internal datocms_content_diff schema requires schema-edit permission.',
    );
  }
}
