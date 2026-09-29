import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';
import { isPortableDatoId, semanticHash } from './canonicalize';
import {
  buildBlockOwnershipIndex,
  collectCreateCycleIntermediateCandidates,
  collectPublishedRecordReferences,
  collectRecordReferences,
  collectUploadReferences,
} from './dependencies';
import { contentTraversalSchema } from './inspection-schema';
import {
  LEGACY_ID_MAPPING_FIELD_LABEL,
  LEGACY_ID_MAPPING_MODEL_NAME,
  LEGACY_ID_MAPPING_NAME_FIELD_LABEL,
} from './shared/contract';
import { isCanonicalLegacyDatoId } from './shared/ids';
import {
  canonicalPrettyStringify,
  isObject,
  sha256,
  utf8ByteLength,
} from './shared/json';
import {
  type LegacyIdMappingSchemaMismatch,
  inspectLegacyMappingFields,
  legacyMappingModelMismatches,
  parseStoredLegacyIdMappingRecord,
  validateLegacyIdMappingLedger,
} from './shared/legacy-id-ledger';
import {
  legacyIdMappingChunkName,
  legacyIdMappingKey,
  legacyIdMappingNamespace,
  legacyIdMappingSortKey,
} from './shared/legacy-id-mapping';
import {
  isNestedBlock,
  isStructuredTextNode,
  nestedBlockFields,
  nestedBlockIdentity,
  requireBlockType,
  requireItemType,
} from './shared/nested-blocks';
import { compareStrings } from './shared/ordering';
import type {
  BuildContentDiffPlanOptions,
  ContentSnapshot,
  InvalidContentDiagnostic,
  ItemTypeSchemaSnapshot,
  JsonObject,
  JsonValue,
  LegacyIdEntityType,
  LegacyIdMappingDocument,
  LegacyIdMappingDocumentEntry,
  LegacyIdMappingEntry,
  LegacyIdMappingPlan,
  LegacyIdMappingSchemaPlan,
  RecordSnapshot,
  RecordVersionSnapshot,
  SchemaSnapshot,
  SkippedLegacyIdMappingEntry,
  SkippedRecordAggregate,
  UploadCollectionSnapshot,
  UploadSnapshot,
} from './types';
import {
  CONTENT_DIFF_MAPPING_FIELD_API_KEY,
  CONTENT_DIFF_MAPPING_NAME_FIELD_API_KEY,
  CONTENT_DIFF_MAPPING_RECORD_MAX_BYTES,
  ContentDiffError,
  DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
  LEGACY_ID_MAPPING_FORMAT_VERSION,
} from './types';

const ITEM_NAMESPACE = 'item';

export interface LegacyIdMappingRegistry {
  schema: LegacyIdMappingSchemaPlan;
  entries: LegacyIdMappingDocumentEntry[];
  records: Array<{ id: string; hash: string }>;
}

// The mapping document serializer is shared with the migration runtime.
export { canonicalPrettyStringify as prettyStableStringify } from './shared/json';

/**
 * Produces a deterministic, canonical, unpadded URL-safe Base64 v4 UUID.
 * The collision counter is part of the seed so callers can reserve the first
 * available ID without relying on random process state.
 */
export function deterministicPortableDatoId(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('base64url');
}

export async function readLegacyIdMappingRegistry(
  client: CmaClient.Client,
  schema: SchemaSnapshot,
  modelApiKey: string = DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
  readRecords = true,
): Promise<LegacyIdMappingRegistry> {
  const schemaPlan = await mappingSchemaPlan(client, schema, modelApiKey);

  if (schemaPlan.model.status === 'new' || !readRecords) {
    return { schema: schemaPlan, entries: [], records: [] };
  }

  const rawRecords: unknown[] = [];
  const iterator = client.items.listPagedIterator(
    {
      filter: { type: schemaPlan.model.id },
      order_by: 'id_ASC',
      version: 'current',
    } as never,
    { perPage: 500, concurrency: 5 },
  );

  for await (const rawRecord of iterator) {
    rawRecords.push(rawRecord);
  }

  // The runtime reads the same ledger with the same shared checks, so both
  // sides accept and reject exactly the same stored records.
  const records = rawRecords
    .sort((left, right) =>
      compareStrings(
        String((left as { id?: unknown } | null)?.id),
        String((right as { id?: unknown } | null)?.id),
      ),
    )
    .map((record) =>
      parseStoredLegacyIdMappingRecord(
        record,
        schemaPlan.model.id,
        schema.siteId,
      ),
    );
  const ledger = validateLegacyIdMappingLedger(records, null, false);

  return {
    schema: schemaPlan,
    entries: sortDocumentEntries([...ledger.sourceClaims.values()]),
    records: records.map(({ id, hash }) => ({ id, hash })),
  };
}

export function assertNoManagedRelationshipToMappingModel(
  schema: SchemaSnapshot,
  modelApiKey: string = DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
): void {
  const internal = schema.itemTypes.find(
    ({ apiKey }) => apiKey === modelApiKey,
  );

  if (!internal) return;

  const structuralValidatorKeys = new Set([
    'item_item_type',
    'items_item_type',
    'rich_text_blocks',
    'single_block_blocks',
    'structured_text_blocks',
    'structured_text_inline_blocks',
    'structured_text_links',
  ]);

  for (const itemType of schema.itemTypes) {
    if (itemType.id === internal.id) continue;

    for (const field of itemType.fields) {
      for (const [validatorKey, validatorValue] of Object.entries(
        field.validators,
      )) {
        if (
          structuralValidatorKeys.has(validatorKey) &&
          jsonContainsExactString(validatorValue, internal.id)
        ) {
          throw new ContentDiffError(
            'INVALID_SCOPE',
            `Managed field ${field.id} refers to reserved internal model ${modelApiKey}. Rename that model or remove the relationship before generating a content diff.`,
            { itemTypeId: itemType.id, fieldId: field.id, modelApiKey },
          );
        }
      }
    }
  }
}

export function prepareLegacyIdMappings(
  source: ContentSnapshot,
  target: ContentSnapshot,
  registry: LegacyIdMappingRegistry,
): LegacyIdMappingPlan {
  const sourceTraversalSchema = contentTraversalSchema(source);
  validateRegistryEntries(registry.entries);
  const registryBySource = new Map(
    registry.entries.map((entry) => [
      legacyIdMappingKey(entry.entityType, entry.sourceId),
      entry,
    ]),
  );
  const entries: LegacyIdMappingEntry[] = [];
  const occupied = occupiedIds(source, target, registry.entries);
  for (const { id } of registry.records) {
    occupied.get(ITEM_NAMESPACE)!.add(id);
  }
  const managedCandidates = sourceOnlyLegacyEntities(source, target);

  for (const candidate of managedCandidates) {
    const existing = registryBySource.get(
      legacyIdMappingKey(candidate.entityType, candidate.sourceId),
    );
    if (existing && existing.entityType !== candidate.entityType) {
      throw mappingRegistryError(
        `Legacy Item ID ${candidate.sourceId} is claimed as both ${existing.entityType} and ${candidate.entityType}.`,
      );
    }
    const targetId = existing
      ? existing.targetId
      : reserveEntityTargetId(
          target.siteId,
          candidate,
          occupied.get(legacyIdMappingNamespace(candidate.entityType))!,
        );

    entries.push({
      ...candidate,
      targetId,
      status: existing ? 'existing' : 'new',
      managed: true,
      expectedItemTypeId: null,
      requiredAvailability: { current: true, published: false },
    });
  }

  const selectedRecordIds = new Set(Object.keys(source.records));
  const externalReferenceIds = new Set(
    Object.values(source.records)
      .flatMap((record) =>
        collectRecordReferences(record, sourceTraversalSchema),
      )
      .map(({ toRecordId }) => toRecordId)
      .filter(
        (id) =>
          !selectedRecordIds.has(id) &&
          isCanonicalLegacyDatoId(id) &&
          !target.visibleRecordIds.includes(id),
      ),
  );

  for (const sourceId of [...externalReferenceIds].sort()) {
    const existing = registryBySource.get(
      legacyIdMappingKey('record', sourceId),
    );
    if (!existing) continue;
    if (existing.entityType !== 'record') {
      throw mappingRegistryError(
        `Legacy Item ID ${sourceId} is claimed as ${existing.entityType}, not record.`,
      );
    }

    entries.push({
      ...existing,
      status: 'existing',
      managed: false,
      expectedItemTypeId: null,
      requiredAvailability: { current: false, published: false },
    });
  }

  const sortedEntries = sortPlanMappingEntries(entries);
  validatePlanMappingEntries(sortedEntries);

  return {
    formatVersion: LEGACY_ID_MAPPING_FORMAT_VERSION,
    schema: registry.schema,
    existingMappingRecords: [...registry.records].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    entries: sortedEntries,
    skippedEntries: [],
    newMappingBatch: buildNewMappingBatch(
      target.siteId,
      registry.schema,
      sortedEntries.filter(({ status }) => status === 'new'),
      occupied.get(ITEM_NAMESPACE)!,
    ),
  };
}

export function emptyLegacyIdMappingPlan(
  snapshot: ContentSnapshot,
  modelApiKey: string = DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
): LegacyIdMappingPlan {
  const occupied = new Set([
    ...snapshot.schema.itemTypes.map(({ id }) => id),
    ...snapshot.schema.itemTypes.flatMap(({ fields }) =>
      fields.map(({ id }) => id),
    ),
    ...snapshot.inspection.itemTypes.map(({ id }) => id),
    ...snapshot.inspection.itemTypes.flatMap(({ fields }) =>
      fields.map(({ id }) => id),
    ),
  ]);
  return {
    formatVersion: LEGACY_ID_MAPPING_FORMAT_VERSION,
    schema: newMappingSchemaPlan(snapshot.siteId, modelApiKey, occupied),
    existingMappingRecords: [],
    entries: [],
    skippedEntries: [],
    newMappingBatch: null,
  };
}

export function applyLegacyIdMappingsToSnapshot(
  snapshot: ContentSnapshot,
  mappingPlan: LegacyIdMappingPlan,
): ContentSnapshot {
  const maps = mappingMaps(mappingPlan.entries);
  const traversalSchema = contentTraversalSchema(snapshot);
  const records: Record<string, RecordSnapshot> = {};

  for (const record of Object.values(snapshot.records).sort((left, right) =>
    compareStrings(left.id, right.id),
  )) {
    const mapped = remapRecord(record, traversalSchema, maps);
    insertUnique(records, mapped.id, mapped, 'record');
  }

  const uploads: Record<string, UploadSnapshot> = {};
  for (const upload of Object.values(snapshot.uploads).sort((left, right) =>
    compareStrings(left.id, right.id),
  )) {
    const id = mapId(maps.upload, upload.id);
    const manual = {
      ...upload.manual,
      collectionId: upload.manual.collectionId
        ? mapId(maps.upload_collection, upload.manual.collectionId)
        : null,
    };
    const semanticState = {
      id,
      md5: upload.md5,
      basename: upload.basename,
      filename: upload.filename,
      manual,
    };
    insertUnique(
      uploads,
      id,
      { ...upload, ...semanticState, hash: semanticHash(semanticState) },
      'upload',
    );
  }

  const uploadCollections: Record<string, UploadCollectionSnapshot> = {};
  for (const collection of Object.values(snapshot.uploadCollections).sort(
    (left, right) => compareStrings(left.id, right.id),
  )) {
    const semanticState = {
      id: mapId(maps.upload_collection, collection.id),
      label: collection.label,
      parentId: collection.parentId
        ? mapId(maps.upload_collection, collection.parentId)
        : null,
      position: collection.position,
    };
    insertUnique(
      uploadCollections,
      semanticState.id,
      { ...semanticState, hash: semanticHash(semanticState) },
      'upload collection',
    );
  }

  const missingUploadReferences = Object.fromEntries(
    Object.entries(snapshot.missingUploadReferences ?? {})
      .map(([recordId, uploadIds]): [string, string[]] => [
        mapId(maps.record, recordId),
        [...new Set(uploadIds.map((id) => mapId(maps.upload, id)))].sort(),
      ])
      .sort(([left], [right]) => compareStrings(left, right)),
  );

  return {
    ...snapshot,
    records,
    uploads,
    uploadCollections,
    visibleRecordIds: [
      ...new Set(snapshot.visibleRecordIds.map((id) => mapId(maps.record, id))),
    ].sort(),
    blockOwnership: buildBlockOwnershipIndex(records, traversalSchema),
    inspection: {
      ...snapshot.inspection,
      structuralIssues: snapshot.inspection.structuralIssues
        .map((issue) => ({
          ...issue,
          recordId: mapId(maps.record, issue.recordId),
          blockId: mapId(maps.block, issue.blockId),
        }))
        .sort(
          (left, right) =>
            compareStrings(left.recordId, right.recordId) ||
            compareStrings(left.slice, right.slice) ||
            compareStrings(left.fieldPath, right.fieldPath) ||
            compareStrings(left.locale ?? '', right.locale ?? '') ||
            compareStrings(left.validatorKey, right.validatorKey) ||
            compareStrings(left.blockId, right.blockId) ||
            compareStrings(left.blockItemTypeId, right.blockItemTypeId),
        ),
    },
    missingUploadReferences,
    // This digest is capture provenance for the raw source environment. The
    // normalized target-ID view is wholly described by the plan ledger.
    digest: snapshot.digest,
  };
}

export function remapInvalidContentDiagnostics(
  diagnostics: readonly InvalidContentDiagnostic[],
  rawSource: ContentSnapshot,
  mappedSource: ContentSnapshot,
  target: ContentSnapshot,
  mappingPlan: LegacyIdMappingPlan,
): InvalidContentDiagnostic[] {
  const recordMap = mappingMaps(mappingPlan.entries).record;
  const maps = mappingMaps(mappingPlan.entries);
  const rawTraversalSchema = contentTraversalSchema(rawSource);
  const rawIntermediateCandidates = collectCreateCycleIntermediateCandidates(
    rawSource.records,
    rawTraversalSchema,
    new Set(
      Object.keys(rawSource.records).filter(
        (id) => !(mapId(recordMap, id) in target.records),
      ),
    ),
  );
  const result: InvalidContentDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const mappedRecordId = mapId(recordMap, diagnostic.recordId);
    const rawRecord = rawSource.records[diagnostic.recordId];
    const mappedRecord = mappedSource.records[mappedRecordId];
    if (!rawRecord || !mappedRecord) continue;

    if (diagnostic.slice === 'current') {
      if (diagnostic.versionHash !== rawRecord.current.hash) continue;
      result.push({
        ...diagnostic,
        recordId: mappedRecordId,
        versionHash: mappedRecord.current.hash,
      });
      continue;
    }

    if (diagnostic.slice === 'published') {
      if (
        diagnostic.versionHash !== rawRecord.published?.hash ||
        !mappedRecord.published
      ) {
        continue;
      }
      result.push({
        ...diagnostic,
        recordId: mappedRecordId,
        versionHash: mappedRecord.published.hash,
      });
      continue;
    }

    // Intermediate shell diagnostics are validator-code evidence for an
    // exact source shell. The planner deterministically rebuilds shells after
    // ID normalization. Pairing is intentionally by owning mapped record;
    // source field validators are unchanged by identifier rewriting.
    if (!(mappedRecordId in target.records)) {
      const rawCandidate = rawIntermediateCandidates.find(
        ({ recordId, versionHash }) =>
          recordId === diagnostic.recordId &&
          versionHash === diagnostic.versionHash,
      );
      if (!rawCandidate) continue;
      const itemType = requireItemType(
        rawTraversalSchema,
        rawCandidate.itemTypeId,
      );
      const mappedFields = remapFields(
        rawCandidate.fields,
        itemType,
        rawTraversalSchema,
        maps,
      );
      result.push({
        ...diagnostic,
        recordId: mappedRecordId,
        versionHash: semanticHash(mappedFields),
      });
    }
  }

  return result.sort(compareDiagnostics);
}

export function finalizeLegacyIdMappingPlan(
  tentative: LegacyIdMappingPlan,
  source: ContentSnapshot,
  target: ContentSnapshot,
  externalTargets: NonNullable<
    BuildContentDiffPlanOptions['externalLegacyRecordTargets']
  > = {},
  additionalOccupiedItemIds: readonly string[] = [],
  detectedSource: ContentSnapshot = source,
  skippedRecords: readonly SkippedRecordAggregate[] = [],
): LegacyIdMappingPlan {
  const sourceTraversalSchema = contentTraversalSchema(source);
  const retained: LegacyIdMappingEntry[] = [];

  for (const entry of tentative.entries) {
    if (!entry.managed) continue;

    const availability = managedAvailability(entry, source);
    if (availability) {
      retained.push({ ...entry, requiredAvailability: availability });
    }
  }

  const currentExternal = new Set<string>();
  const publishedExternal = new Set<string>();
  const managedRecordIds = new Set(Object.keys(source.records));
  for (const record of Object.values(source.records)) {
    const currentOnly = collectRecordReferences(
      { ...record, published: null },
      sourceTraversalSchema,
    );
    for (const { toRecordId } of currentOnly) {
      if (!managedRecordIds.has(toRecordId)) currentExternal.add(toRecordId);
    }
    for (const { toRecordId } of collectPublishedRecordReferences(
      record,
      sourceTraversalSchema,
    )) {
      if (!managedRecordIds.has(toRecordId)) publishedExternal.add(toRecordId);
    }
  }

  for (const entry of tentative.entries) {
    if (entry.status !== 'existing') continue;
    if (managedAvailability(entry, source)) continue;
    if (entry.entityType === 'block') {
      throw mappingRegistryError(
        `Existing block alias ${entry.sourceId} cannot be used as an out-of-scope dependency.`,
      );
    }
    if (entry.entityType !== 'record') continue;

    const current = currentExternal.has(entry.targetId);
    const published = publishedExternal.has(entry.targetId);
    if (!current && !published) continue;
    if (!target.visibleRecordIds.includes(entry.targetId)) continue;
    const externalTarget = externalTargets[entry.targetId];
    if (!externalTarget?.current || (published && !externalTarget.published)) {
      throw new ContentDiffError(
        'MISSING_EXTERNAL_REFERENCE',
        `Mapped out-of-scope record ${entry.targetId} is not available in the destination slices required by retained content.`,
        {
          sourceId: entry.sourceId,
          targetId: entry.targetId,
          requiresPublished: published,
        },
      );
    }

    retained.push({
      ...entry,
      managed: false,
      expectedItemTypeId: externalTarget.itemTypeId,
      requiredAvailability: { current: current || published, published },
    });
  }

  const entries = sortPlanMappingEntries(retained);
  validatePlanMappingEntries(entries, true);
  const retainedKeys = new Set(
    entries.map(({ entityType, sourceId }) =>
      legacyIdMappingSortKey(entityType, sourceId),
    ),
  );
  const skippedEntries = [
    ...tentative.skippedEntries,
    ...tentative.entries
      .filter(
        ({ entityType, sourceId }) =>
          !retainedKeys.has(legacyIdMappingSortKey(entityType, sourceId)),
      )
      .map(
        ({ entityType, sourceId, targetId }): SkippedLegacyIdMappingEntry => ({
          entityType,
          sourceId,
          reason: skippedLegacyIdReason(
            entityType,
            targetId,
            detectedSource,
            skippedRecords,
          ),
        }),
      ),
  ]
    .sort(compareSkippedMappingEntries)
    .filter(
      (entry, index, values) =>
        index === 0 ||
        entry.entityType !== values[index - 1].entityType ||
        entry.sourceId !== values[index - 1].sourceId,
    );
  const occupiedItems = new Set([
    ...Object.keys(source.records),
    ...Object.keys(source.blockOwnership),
    ...Object.keys(target.records),
    ...Object.keys(target.blockOwnership),
    ...source.visibleRecordIds,
    ...target.visibleRecordIds,
    ...additionalOccupiedItemIds,
    ...tentative.existingMappingRecords.map(({ id }) => id),
  ]);

  return {
    ...tentative,
    entries,
    skippedEntries,
    newMappingBatch: buildNewMappingBatch(
      target.siteId,
      tentative.schema,
      entries.filter(({ status }) => status === 'new'),
      occupiedItems,
    ),
  };
}

function skippedLegacyIdReason(
  entityType: LegacyIdEntityType,
  targetId: string,
  detectedSource: ContentSnapshot,
  skippedRecords: readonly SkippedRecordAggregate[],
): string {
  const detectedTraversalSchema = contentTraversalSchema(detectedSource);
  const owningRecordIds = new Set<string>();

  if (entityType === 'record' && detectedSource.records[targetId]) {
    owningRecordIds.add(targetId);
  }
  if (entityType === 'block') {
    for (const ownership of detectedSource.blockOwnership[targetId] ?? []) {
      owningRecordIds.add(ownership.topRecordId);
    }
  }
  if (entityType === 'record') {
    for (const record of Object.values(detectedSource.records)) {
      if (
        collectRecordReferences(record, detectedTraversalSchema).some(
          ({ toRecordId }) => toRecordId === targetId,
        )
      ) {
        owningRecordIds.add(record.id);
      }
    }
  }
  if (entityType === 'upload') {
    for (const record of Object.values(detectedSource.records)) {
      if (
        collectUploadReferences(record, detectedTraversalSchema).includes(
          targetId,
        )
      ) {
        owningRecordIds.add(record.id);
      }
    }
  }
  if (entityType === 'upload_collection') {
    const uploadIds = new Set(
      Object.values(detectedSource.uploads)
        .filter(({ manual }) => manual.collectionId === targetId)
        .map(({ id }) => id),
    );
    for (const record of Object.values(detectedSource.records)) {
      if (
        collectUploadReferences(record, detectedTraversalSchema).some((id) =>
          uploadIds.has(id),
        )
      ) {
        owningRecordIds.add(record.id);
      }
    }
  }

  const related = skippedRecords.filter(({ id }) => owningRecordIds.has(id));
  const reasons = [
    ...new Set(
      related.flatMap(({ reasons: recordReasons }) =>
        recordReasons.map(
          ({ code, slice }) => `${code}${slice ? ` (${slice})` : ''}`,
        ),
      ),
    ),
  ].sort();
  if (reasons.length > 0) {
    return `${
      entityType === 'record' && owningRecordIds.has(targetId)
        ? 'top-level aggregate'
        : 'owning or referring aggregate'
    } skipped: ${reasons.join(', ')}`;
  }
  return 'removed from the final managed scope after skip propagation';
}

function compareSkippedMappingEntries(
  left: SkippedLegacyIdMappingEntry,
  right: SkippedLegacyIdMappingEntry,
): number {
  return (
    compareStrings(left.entityType, right.entityType) ||
    compareStrings(left.sourceId, right.sourceId) ||
    compareStrings(left.reason, right.reason)
  );
}

async function mappingSchemaPlan(
  client: CmaClient.Client,
  schema: SchemaSnapshot,
  modelApiKey: string,
): Promise<LegacyIdMappingSchemaPlan> {
  const model = schema.itemTypes.find(({ apiKey }) => apiKey === modelApiKey);
  const reserved = new Set([
    ...schema.itemTypes.map(({ id }) => id),
    ...schema.itemTypes.flatMap(({ fields }) => fields.map(({ id }) => id)),
  ]);

  if (!model) {
    const nameCollision = schema.itemTypes.find(
      ({ name }) => name === LEGACY_ID_MAPPING_MODEL_NAME,
    );
    if (nameCollision) {
      throw mappingRegistryError(
        `Model name Content diff is already used by ${nameCollision.apiKey}; the reserved ${modelApiKey} ledger cannot be created safely.`,
      );
    }
    return newMappingSchemaPlan(schema.siteId, modelApiKey, reserved);
  }

  const [rawModel, rawFields] = await Promise.all([
    client.itemTypes.find(model.id),
    client.fields.list(model.id),
  ]);
  const modelMismatches = legacyMappingModelMismatches(rawModel);
  if (modelMismatches.length > 0) {
    throw mappingSchemaError(
      `Existing model ${modelApiKey} does not match the reserved content-diff ledger contract.`,
      model.id,
      modelMismatches,
    );
  }
  // Generation never resumes an interrupted ledger append: the fields must be
  // complete, exact, and the only fields of the model.
  const { nameField, mappingField, mismatches } = inspectLegacyMappingFields(
    rawModel,
    rawFields,
    null,
    false,
  );
  if (!nameField || !mappingField || mismatches.length > 0) {
    throw mappingSchemaError(
      `Existing model ${modelApiKey} does not match the reserved content-diff ledger schema.`,
      model.id,
      mismatches,
    );
  }

  return {
    model: {
      id: model.id,
      apiKey: modelApiKey,
      name: LEGACY_ID_MAPPING_MODEL_NAME,
      modularBlock: false,
      singleton: false,
      sortable: false,
      tree: false,
      draftModeActive: true,
      draftSavingActive: false,
      allLocalesRequired: false,
      inverseRelationshipsEnabled: false,
      workflowId: null,
      status: 'existing',
    },
    nameField: {
      id: nameField.id,
      apiKey: CONTENT_DIFF_MAPPING_NAME_FIELD_API_KEY,
      label: LEGACY_ID_MAPPING_NAME_FIELD_LABEL,
      fieldType: 'string',
      localized: false,
      position: 1,
      validators: { required: {}, unique: {} },
      status: 'existing',
    },
    mappingField: {
      id: mappingField.id,
      apiKey: CONTENT_DIFF_MAPPING_FIELD_API_KEY,
      label: LEGACY_ID_MAPPING_FIELD_LABEL,
      fieldType: 'json',
      localized: false,
      position: 2,
      validators: { required: {} },
      status: 'existing',
    },
  };
}

function newMappingSchemaPlan(
  siteId: string,
  modelApiKey: string,
  occupied: Set<string>,
): LegacyIdMappingSchemaPlan {
  const modelId = reserveDeterministicId(
    `content-diff-ledger-schema:${siteId}:${modelApiKey}:model`,
    occupied,
  );
  const nameFieldId = reserveDeterministicId(
    `content-diff-ledger-schema:${siteId}:${modelApiKey}:name`,
    occupied,
  );
  const mappingFieldId = reserveDeterministicId(
    `content-diff-ledger-schema:${siteId}:${modelApiKey}:mapping`,
    occupied,
  );

  return {
    model: {
      id: modelId,
      apiKey: modelApiKey,
      name: LEGACY_ID_MAPPING_MODEL_NAME,
      modularBlock: false,
      singleton: false,
      sortable: false,
      tree: false,
      draftModeActive: true,
      draftSavingActive: false,
      allLocalesRequired: false,
      inverseRelationshipsEnabled: false,
      workflowId: null,
      status: 'new',
    },
    nameField: {
      id: nameFieldId,
      apiKey: CONTENT_DIFF_MAPPING_NAME_FIELD_API_KEY,
      label: LEGACY_ID_MAPPING_NAME_FIELD_LABEL,
      fieldType: 'string',
      localized: false,
      position: 1,
      validators: { required: {}, unique: {} },
      status: 'new',
    },
    mappingField: {
      id: mappingFieldId,
      apiKey: CONTENT_DIFF_MAPPING_FIELD_API_KEY,
      label: LEGACY_ID_MAPPING_FIELD_LABEL,
      fieldType: 'json',
      localized: false,
      position: 2,
      validators: { required: {} },
      status: 'new',
    },
  };
}

function buildNewMappingBatch(
  siteId: string,
  schema: LegacyIdMappingSchemaPlan,
  planEntries: LegacyIdMappingEntry[],
  occupiedItemIds: Set<string>,
): LegacyIdMappingPlan['newMappingBatch'] {
  const entries = sortDocumentEntries(
    planEntries.map(({ entityType, sourceId, targetId }) => ({
      entityType,
      sourceId,
      targetId,
    })),
  );
  if (entries.length === 0) return null;

  const wholeHash = semanticHash(entries);
  const batchId = deterministicPortableDatoId(
    `content-diff-ledger-batch:${siteId}:${schema.model.apiKey}:${wholeHash}`,
  );
  const provisionalChunkCount = entries.length;
  const entryChunks: LegacyIdMappingDocumentEntry[][] = [];
  let current: LegacyIdMappingDocumentEntry[] = [];

  for (const entry of entries) {
    const candidate = [...current, entry];
    const document = mappingDocument(
      siteId,
      batchId,
      entryChunks.length,
      provisionalChunkCount,
      wholeHash,
      candidate,
    );
    if (
      utf8ByteLength(canonicalPrettyStringify(document)) <=
      CONTENT_DIFF_MAPPING_RECORD_MAX_BYTES
    ) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw mappingRegistryError(
        `Legacy mapping ${entry.entityType}/${entry.sourceId} cannot fit in one 128 KiB ledger record.`,
      );
    }
    entryChunks.push(current);
    current = [entry];
  }
  if (current.length > 0) entryChunks.push(current);

  const chunkCount = entryChunks.length;
  const chunks = entryChunks.map((chunkEntries, chunkIndex) => {
    const document = mappingDocument(
      siteId,
      batchId,
      chunkIndex,
      chunkCount,
      wholeHash,
      chunkEntries,
    );
    const serializedDocument = canonicalPrettyStringify(document);
    const byteLength = utf8ByteLength(serializedDocument);
    if (byteLength > CONTENT_DIFF_MAPPING_RECORD_MAX_BYTES) {
      throw mappingRegistryError(
        `Legacy mapping chunk ${chunkIndex} exceeds 128 KiB.`,
      );
    }
    const id = reserveDeterministicId(
      `content-diff-ledger-record:${siteId}:${batchId}:${chunkIndex}`,
      occupiedItemIds,
    );
    return {
      id,
      name: legacyIdMappingChunkName(batchId, chunkIndex, chunkCount),
      chunkIndex,
      chunkCount,
      hash: sha256(serializedDocument),
      byteLength,
      serializedDocument,
      document,
    };
  });

  return { batchId, wholeHash, chunks };
}

function mappingDocument(
  projectId: string,
  batchId: string,
  chunkIndex: number,
  chunkCount: number,
  wholeHash: string,
  entries: LegacyIdMappingDocumentEntry[],
): LegacyIdMappingDocument {
  return {
    formatVersion: LEGACY_ID_MAPPING_FORMAT_VERSION,
    projectId,
    batchId,
    chunkIndex,
    chunkCount,
    wholeHash,
    entries,
  };
}

function sourceOnlyLegacyEntities(
  source: ContentSnapshot,
  target: ContentSnapshot,
): LegacyIdMappingDocumentEntry[] {
  const sourceOnly = [
    ...Object.keys(source.records)
      .filter((id) => !(id in target.records))
      .map((sourceId) => ({ entityType: 'record' as const, sourceId })),
    ...Object.keys(source.blockOwnership)
      .filter((id) => !(id in target.blockOwnership))
      .map((sourceId) => ({ entityType: 'block' as const, sourceId })),
    ...Object.keys(source.uploads)
      .filter((id) => !(id in target.uploads))
      .map((sourceId) => ({ entityType: 'upload' as const, sourceId })),
    ...Object.keys(source.uploadCollections)
      .filter((id) => !(id in target.uploadCollections))
      .map((sourceId) => ({
        entityType: 'upload_collection' as const,
        sourceId,
      })),
  ].filter(({ sourceId }) => !isPortableDatoId(sourceId));

  const malformed = sourceOnly.filter(
    ({ sourceId }) => !isCanonicalLegacyDatoId(sourceId),
  );
  if (malformed.length > 0) {
    const first = malformed.sort(compareMappingEntries)[0];
    throw mappingRegistryError(
      `Source-only ${first.entityType} ID ${first.sourceId} is neither a canonical portable DatoCMS ID nor a decimal legacy ID.`,
    );
  }

  return sortDocumentEntries([
    ...sourceOnly
      .filter(({ entityType }) => entityType === 'record')
      .map(({ sourceId }) => ({
        entityType: 'record' as const,
        sourceId,
        targetId: '',
      })),
    ...sourceOnly
      .filter(({ entityType }) => entityType === 'block')
      .map(({ sourceId }) => ({
        entityType: 'block' as const,
        sourceId,
        targetId: '',
      })),
    ...sourceOnly
      .filter(({ entityType }) => entityType === 'upload')
      .map(({ sourceId }) => ({
        entityType: 'upload' as const,
        sourceId,
        targetId: '',
      })),
    ...sourceOnly
      .filter(({ entityType }) => entityType === 'upload_collection')
      .map(({ sourceId }) => ({
        entityType: 'upload_collection' as const,
        sourceId,
        targetId: '',
      })),
  ]);
}

function occupiedIds(
  source: ContentSnapshot,
  target: ContentSnapshot,
  registryEntries: LegacyIdMappingDocumentEntry[],
): Map<string, Set<string>> {
  return new Map([
    [
      ITEM_NAMESPACE,
      new Set([
        ...Object.keys(source.records),
        ...Object.keys(source.blockOwnership),
        ...Object.keys(target.records),
        ...Object.keys(target.blockOwnership),
        ...source.visibleRecordIds,
        ...target.visibleRecordIds,
        ...registryEntries
          .filter(
            ({ entityType }) =>
              legacyIdMappingNamespace(entityType) === ITEM_NAMESPACE,
          )
          .map(({ targetId }) => targetId),
      ]),
    ],
    [
      'upload',
      new Set([
        ...Object.keys(source.uploads),
        ...Object.keys(target.uploads),
        ...registryEntries
          .filter(({ entityType }) => entityType === 'upload')
          .map(({ targetId }) => targetId),
      ]),
    ],
    [
      'upload_collection',
      new Set([
        ...Object.keys(source.uploadCollections),
        ...Object.keys(target.uploadCollections),
        ...registryEntries
          .filter(({ entityType }) => entityType === 'upload_collection')
          .map(({ targetId }) => targetId),
      ]),
    ],
  ]);
}

function reserveEntityTargetId(
  siteId: string,
  entry: Pick<LegacyIdMappingDocumentEntry, 'entityType' | 'sourceId'>,
  occupied: Set<string>,
): string {
  return reserveDeterministicId(
    `content-diff-legacy-id:${siteId}:${legacyIdMappingNamespace(
      entry.entityType,
    )}:${entry.sourceId}`,
    occupied,
  );
}

function reserveDeterministicId(seed: string, occupied: Set<string>): string {
  for (let counter = 0; counter < 10_000; counter += 1) {
    const id = deterministicPortableDatoId(`${seed}:${counter}`);
    if (!occupied.has(id)) {
      occupied.add(id);
      return id;
    }
  }
  throw mappingRegistryError('Could not reserve a collision-free portable ID.');
}

function remapRecord(
  record: RecordSnapshot,
  schema: SchemaSnapshot,
  maps: MappingMaps,
): RecordSnapshot {
  const id = mapId(maps.record, record.id);
  const itemType = requireItemType(schema, record.itemTypeId);
  const current = remapVersion(record.current, itemType, schema, maps);
  const published = record.published
    ? remapVersion(record.published, itemType, schema, maps)
    : null;
  const topology = {
    parentId: record.topology.parentId
      ? mapId(maps.record, record.topology.parentId)
      : null,
    position: record.topology.position,
  };
  const semanticState = {
    id,
    itemTypeId: record.itemTypeId,
    current,
    published,
    topology: { parentId: topology.parentId },
    lifecycle: record.lifecycle,
    stage: record.stage,
    schedules: record.schedules,
  };
  return {
    ...record,
    id,
    current,
    published,
    topology,
    hash: semanticHash(semanticState),
  };
}

function remapVersion(
  version: RecordVersionSnapshot,
  itemType: ItemTypeSchemaSnapshot,
  schema: SchemaSnapshot,
  maps: MappingMaps,
): RecordVersionSnapshot {
  const fields = remapFields(version.fields, itemType, schema, maps);
  return { fields, hash: semanticHash(fields) };
}

function remapFields(
  fields: JsonObject,
  itemType: ItemTypeSchemaSnapshot,
  schema: SchemaSnapshot,
  maps: MappingMaps,
  prefix = '',
): JsonObject {
  const result: JsonObject = { ...fields };
  for (const field of itemType.fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.apiKey)) continue;
    const value = fields[field.apiKey];
    const fieldPath = prefix ? `${prefix}.${field.apiKey}` : field.apiKey;
    if (field.localized && isObject(value)) {
      result[field.apiKey] = Object.fromEntries(
        Object.entries(value).map(([locale, localized]) => [
          locale,
          remapFieldValue(localized, field, schema, maps, fieldPath),
        ]),
      );
    } else {
      result[field.apiKey] = remapFieldValue(
        value,
        field,
        schema,
        maps,
        fieldPath,
      );
    }
  }
  return result;
}

function remapFieldValue(
  value: JsonValue,
  field: ItemTypeSchemaSnapshot['fields'][number],
  schema: SchemaSnapshot,
  maps: MappingMaps,
  fieldPath: string,
): JsonValue {
  if (field.fieldType === 'link') {
    return typeof value === 'string' ? mapId(maps.record, value) : value;
  }
  if (field.fieldType === 'links' && Array.isArray(value)) {
    return value.map((id) =>
      typeof id === 'string' ? mapId(maps.record, id) : id,
    );
  }
  if (field.fieldType === 'file') return remapUploadValue(value, maps.upload);
  if (field.fieldType === 'gallery' && Array.isArray(value)) {
    return value.map((entry) => remapUploadValue(entry, maps.upload));
  }
  if (
    field.fieldType === 'seo' &&
    isJsonObject(value) &&
    typeof value.image === 'string'
  ) {
    return { ...value, image: mapId(maps.upload, value.image) };
  }
  if (field.fieldType === 'structured_text') {
    return remapStructuredTextValue(value, schema, maps, fieldPath);
  }
  if (field.fieldType === 'rich_text' || field.fieldType === 'single_block') {
    return remapEmbeddedValue(value, schema, maps, fieldPath);
  }
  return value;
}

function remapStructuredTextValue(
  value: JsonValue,
  schema: SchemaSnapshot,
  maps: MappingMaps,
  fieldPath: string,
): JsonValue {
  if (!isJsonObject(value) || !isObject(value.document)) return value;
  return {
    ...value,
    document: remapStructuredTextNode(value.document, schema, maps, fieldPath),
  };
}

function remapStructuredTextNode(
  value: JsonValue,
  schema: SchemaSnapshot,
  maps: MappingMaps,
  fieldPath: string,
): JsonValue {
  if (!isStructuredTextNode(value)) return value;

  const result: JsonObject = { ...value };
  if (
    (value.type === 'inlineItem' || value.type === 'itemLink') &&
    typeof value.item === 'string'
  ) {
    result.item = mapId(maps.record, value.item);
  } else if (
    (value.type === 'block' || value.type === 'inlineBlock') &&
    isObject(value.item) &&
    isNestedBlock(value.item, fieldPath)
  ) {
    result.item = remapEmbeddedValue(value.item, schema, maps, fieldPath);
  }

  if (Array.isArray(value.children)) {
    result.children = value.children.map((child) =>
      remapStructuredTextNode(child, schema, maps, fieldPath),
    );
  }

  return result;
}

function remapUploadValue(
  value: JsonValue,
  map: Map<string, string>,
): JsonValue {
  if (typeof value === 'string') return mapId(map, value);
  if (isJsonObject(value) && typeof value.upload_id === 'string') {
    return { ...value, upload_id: mapId(map, value.upload_id) };
  }
  return value;
}

function remapEmbeddedValue(
  value: JsonValue,
  schema: SchemaSnapshot,
  maps: MappingMaps,
  fieldPath: string,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((child) =>
      remapEmbeddedValue(child, schema, maps, fieldPath),
    );
  }
  if (!isObject(value)) return value;
  const identity = nestedBlockIdentity(value, fieldPath);
  if (identity) {
    const blockType = requireBlockType(schema, identity, fieldPath);
    const fields = remapFields(
      nestedBlockFields(value, fieldPath) as JsonObject,
      blockType,
      schema,
      maps,
      `${fieldPath}.block:${identity.id}`,
    );
    return {
      ...value,
      id: mapId(maps.block, identity.id),
      ...(isObject(value.attributes) ? { attributes: fields } : fields),
    };
  }
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'item' &&
      typeof child === 'string' &&
      (value.type === 'inlineItem' || value.type === 'itemLink')
    ) {
      result[key] = mapId(maps.record, child);
    } else {
      result[key] = remapEmbeddedValue(child, schema, maps, fieldPath);
    }
  }
  return result;
}

function managedAvailability(
  entry: LegacyIdMappingEntry,
  source: ContentSnapshot,
): LegacyIdMappingEntry['requiredAvailability'] | null {
  if (entry.entityType === 'record') {
    const record = source.records[entry.targetId];
    return record
      ? { current: true, published: record.published !== null }
      : null;
  }
  if (entry.entityType === 'block') {
    const ownership = source.blockOwnership[entry.targetId];
    return ownership
      ? {
          current: ownership.some(({ version }) => version === 'current'),
          published: ownership.some(({ version }) => version === 'published'),
        }
      : null;
  }
  if (entry.entityType === 'upload') {
    return source.uploads[entry.targetId]
      ? { current: true, published: false }
      : null;
  }
  return source.uploadCollections[entry.targetId]
    ? { current: true, published: false }
    : null;
}

interface MappingMaps {
  record: Map<string, string>;
  block: Map<string, string>;
  upload: Map<string, string>;
  upload_collection: Map<string, string>;
}

function mappingMaps(entries: readonly LegacyIdMappingEntry[]): MappingMaps {
  const maps: MappingMaps = {
    record: new Map(),
    block: new Map(),
    upload: new Map(),
    upload_collection: new Map(),
  };
  for (const entry of entries)
    maps[entry.entityType].set(entry.sourceId, entry.targetId);
  return maps;
}

function validateRegistryEntries(
  entries: readonly LegacyIdMappingDocumentEntry[],
): void {
  const sourceClaims = new Map<string, LegacyIdMappingDocumentEntry>();
  const targetClaims = new Map<string, LegacyIdMappingDocumentEntry>();
  for (const entry of entries) {
    if (
      !isCanonicalLegacyDatoId(entry.sourceId) ||
      !isPortableDatoId(entry.targetId)
    ) {
      throw mappingRegistryError(
        `Invalid legacy mapping ${entry.entityType}/${entry.sourceId}.`,
      );
    }
    const sourceKey = legacyIdMappingKey(entry.entityType, entry.sourceId);
    const targetKey = legacyIdMappingKey(entry.entityType, entry.targetId);
    if (sourceClaims.has(sourceKey) || targetClaims.has(targetKey)) {
      throw mappingRegistryError(
        `Conflicting legacy mapping claim for ${entry.entityType}/${entry.sourceId}.`,
      );
    }
    sourceClaims.set(sourceKey, entry);
    targetClaims.set(targetKey, entry);
  }
}

function validatePlanMappingEntries(
  entries: readonly LegacyIdMappingEntry[],
  requireExternalType = false,
): void {
  validateRegistryEntries(entries);
  for (const entry of entries) {
    if (!entry.managed && entry.status !== 'existing') {
      throw mappingRegistryError(
        'Out-of-scope aliases must already exist in the durable ledger.',
      );
    }
    if (!entry.managed && entry.entityType !== 'record') {
      throw mappingRegistryError(
        'Only out-of-scope record aliases are supported in this plan format.',
      );
    }
    if (!entry.managed && requireExternalType && !entry.expectedItemTypeId) {
      throw mappingRegistryError(
        `Out-of-scope record alias ${entry.sourceId} has no authoritative destination item type.`,
      );
    }
  }
}

function sortPlanMappingEntries(
  entries: readonly LegacyIdMappingEntry[],
): LegacyIdMappingEntry[] {
  return [...entries].sort(compareMappingEntries);
}

function sortDocumentEntries(
  entries: readonly LegacyIdMappingDocumentEntry[],
): LegacyIdMappingDocumentEntry[] {
  return [...entries].sort(compareMappingEntries);
}

function compareMappingEntries(
  left: Pick<LegacyIdMappingDocumentEntry, 'entityType' | 'sourceId'>,
  right: Pick<LegacyIdMappingDocumentEntry, 'entityType' | 'sourceId'>,
): number {
  return (
    compareStrings(left.entityType, right.entityType) ||
    compareStrings(left.sourceId, right.sourceId)
  );
}

function mapId(map: Map<string, string>, id: string): string {
  return map.get(id) ?? id;
}

function insertUnique<T>(
  record: Record<string, T>,
  id: string,
  value: T,
  label: string,
): void {
  if (id in record) {
    throw new ContentDiffError(
      'DUPLICATE_ENTITY_ID',
      `Legacy ID normalization produced duplicate ${label} ID ${id}.`,
      { id },
    );
  }
  record[id] = value;
}

function jsonContainsExactString(value: JsonValue, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value))
    return value.some((child) => jsonContainsExactString(child, target));
  return (
    isObject(value) &&
    Object.values(value).some((child) => jsonContainsExactString(child, target))
  );
}

function mappingRegistryError(message: string): ContentDiffError {
  return new ContentDiffError('UNSUPPORTED_CONTENT_STATE', message);
}

function mappingSchemaError(
  message: string,
  modelId: string,
  mismatches: readonly LegacyIdMappingSchemaMismatch[],
): ContentDiffError {
  return new ContentDiffError('UNSUPPORTED_CONTENT_STATE', message, {
    modelId,
    mismatches: mismatches.map(({ fieldId, property }) =>
      typeof fieldId === 'string' ? `${fieldId}.${property}` : property,
    ),
  });
}

function compareDiagnostics(
  left: InvalidContentDiagnostic,
  right: InvalidContentDiagnostic,
): number {
  return (
    compareStrings(left.recordId, right.recordId) ||
    compareStrings(left.slice, right.slice) ||
    compareStrings(left.versionHash, right.versionHash)
  );
}

/**
 * The shared isObject, narrowing a JSON value to JsonObject. The shared guard
 * narrows to Record<string, any>, which a JsonValue array satisfies too, so
 * property reads on the narrowed value would not typecheck.
 */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isObject(value);
}
