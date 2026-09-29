// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { ContentDiffPlan, JsonObject } from '../types';
import {
  CONTENT_DIFF_MANIFEST_VERSION,
  CONTENT_DIFF_PLAN_VERSION,
  CONTENT_DIFF_RUNTIME_VERSION,
  LEGACY_ID_MAPPING_MODEL_API_KEY,
  RELAXABLE_VALIDATOR_KEYS,
} from './contract';
import { planCreateDefaultValueSuppressions } from './create-defaults';
import {
  findNonPortableCreateIds,
  findRecordSnapshotIdentityMismatches,
} from './create-id-contract';
import { findPlanSanitizedHtmlWriteRisks } from './create-sanitization';
import { sharedFailure } from './failure-factory';
import {
  findUnsupportedFreshNestedBlockUpdates,
  itemTypeIdsAffectedByValidatorChanges,
  unsafeFreshNestedCreateRecordIds,
} from './fresh-nested-updates';
import { isPortableDatoId } from './ids';
import { isObject, semanticHash, sha256, stableStringify } from './json';
import { validateLegacyIdMappingPlan } from './legacy-id-mapping';
import {
  type NestedBlockIdentity,
  collectNestedBlockIdentities,
  collectNestedBlocks,
} from './nested-blocks';
import { compareStrings } from './ordering';
import {
  computeSchemaDigest,
  inspectionItemTypesDigest,
  isEnvironmentSemantics,
  schemaWithValidatorRelaxations,
} from './schema-state';
import { uniqueReleaseFieldError } from './unique-releases';
import {
  deriveRequiredManageUploadCollections,
  uploadCollectionOrderContractError,
  uploadCollectionPlanContractError,
} from './upload-collection-contract';
import {
  deriveRequiredUploadActions,
  uploadPlanContractError,
} from './upload-contract';

/** The distinct values, in first-seen order. */
export function planValidationUnique<Value>(values: Iterable<Value>): Value[] {
  return Array.from(new Set(values));
}

/** Whether two string sets hold the same members. */
export function planValidationSameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size &&
    Array.from(left).every((value) => right.has(value))
  );
}

/**
 * Compares two hex digests case-insensitively in time independent of where
 * they differ. Anything that is not non-empty hex of equal length differs.
 */
export function constantTimeEqualHex(left: unknown, right: unknown): boolean {
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (
    !/^[a-f0-9]+$/.test(normalizedLeft) ||
    !/^[a-f0-9]+$/.test(normalizedRight) ||
    normalizedLeft.length !== normalizedRight.length
  ) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    difference |=
      normalizedLeft.charCodeAt(index) ^ normalizedRight.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Checks a content migration manifest and returns its plan: an object with
 * the supported manifest and runtime versions, sha256 integrity metadata,
 * and a plan whose canonical hash matches, compared in constant time. The
 * plan itself is not validated here; see validateContentDiffPlan.
 */
export function assertContentDiffEnvelope(envelope: unknown): unknown {
  if (!isObject(envelope)) {
    throw sharedFailure(
      'invalidManifest',
      'Content migration manifest is not an object.',
    );
  }
  if (envelope.formatVersion !== CONTENT_DIFF_MANIFEST_VERSION) {
    throw sharedFailure(
      'unsupportedManifest',
      `Unsupported content migration manifest version: ${String(
        envelope.formatVersion,
      )}`,
    );
  }
  if (envelope.runtimeVersion !== CONTENT_DIFF_RUNTIME_VERSION) {
    throw sharedFailure(
      'unsupportedRuntime',
      `Content migration requires runtime ${String(
        envelope.runtimeVersion,
      )}, but this file is runtime ${CONTENT_DIFF_RUNTIME_VERSION}.`,
    );
  }
  if (
    !isObject(envelope.integrity) ||
    envelope.integrity.algorithm !== 'sha256' ||
    typeof envelope.integrity.planSha256 !== 'string'
  ) {
    throw sharedFailure(
      'invalidManifest',
      'Content migration manifest has invalid integrity metadata.',
    );
  }
  if (!isObject(envelope.plan)) {
    throw sharedFailure(
      'invalidManifest',
      'Content migration manifest has no plan.',
    );
  }

  const actual = sha256(stableStringify(envelope.plan));
  if (!constantTimeEqualHex(actual, envelope.integrity.planSha256)) {
    throw sharedFailure(
      'planIntegrityFailure',
      'Content migration plan integrity validation failed.',
    );
  }

  return envelope.plan;
}

/**
 * Checks that a plan is exactly executable before anything touches a
 * project: generation rejects what execution would reject. It covers the
 * endpoints and schema bindings, the inspection and invalid-content
 * contracts, every record, upload and collection plan, the execution orders,
 * unique and delete releases, the legacy-ID mapping plan, sanitizer and
 * fresh-ID safety, and the declared permissions.
 */
export function validateContentDiffPlan(
  input: unknown,
): asserts input is ContentDiffPlan {
  // The plan is untrusted input; its top-level shape is checked before use.
  const plan: any = isObject(input) ? input : {};
  if (plan.formatVersion !== CONTENT_DIFF_PLAN_VERSION) {
    throw sharedFailure(
      'unsupportedPlan',
      `Unsupported content diff plan version: ${String(plan.formatVersion)}`,
    );
  }
  if (
    !isObject(plan.source) ||
    !isObject(plan.target) ||
    !isObject(plan.schema)
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan is missing source, target, or schema metadata.',
    );
  }
  const sourceSiteId = String(plan.source.siteId);
  const targetSiteId = String(plan.target.siteId);
  const projectMode = isObject(plan.options) ? plan.options.projectMode : null;
  if (projectMode !== 'same_project' && projectMode !== 'aligned_projects') {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan has an invalid project mode.',
    );
  }
  if (projectMode === 'same_project' && sourceSiteId !== targetSiteId) {
    throw sharedFailure(
      'invalidPlan',
      'A same-project content diff plan must use one DatoCMS project.',
    );
  }
  if (projectMode === 'aligned_projects' && sourceSiteId === targetSiteId) {
    throw sharedFailure(
      'invalidPlan',
      'An aligned-projects content diff plan must use two different DatoCMS projects.',
    );
  }
  if (String(plan.schema.siteId) !== sourceSiteId) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan schema metadata is not bound to its source project.',
    );
  }
  if (
    sourceSiteId === targetSiteId &&
    String(plan.source.environmentId) === String(plan.target.environmentId)
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Source and destination endpoints must be different.',
    );
  }
  if (
    plan.source.schemaDigest !== plan.target.schemaDigest ||
    plan.schema.digest !== plan.target.schemaDigest
  ) {
    throw sharedFailure(
      'planSchemaMismatch',
      'The plan was generated from incompatible schemas.',
    );
  }
  if (!isEnvironmentSemantics(plan.schema.environmentSemantics)) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan is missing exact environment content-semantics metadata.',
    );
  }
  validateTargetInspection(plan);
  if (
    !isObject(plan.options) ||
    typeof plan.options.migrationsModelApiKey !== 'string' ||
    !plan.options.migrationsModelApiKey
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan is missing the migrations tracking-model API key.',
    );
  }
  if (plan.options.migrationsModelApiKey === LEGACY_ID_MAPPING_MODEL_API_KEY) {
    throw sharedFailure(
      'invalidPlan',
      'The migrations tracking model cannot share the reserved content-diff ledger API key.',
    );
  }
  for (const key of ['records', 'uploads', 'uploadCollections', 'warnings']) {
    if (!Array.isArray(plan[key])) {
      throw sharedFailure(
        'invalidPlan',
        `Content diff plan property ${key} must be an array.`,
      );
    }
  }
  if (!isObject(plan.execution)) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan has no execution ordering.',
    );
  }
  for (const key of [
    'collectionOrder',
    'uploadOrder',
    'uniqueReleases',
    'deleteReleases',
    'shellRecordIds',
    'shellComponents',
    'revalidateBeforePublishIds',
    'createOrder',
    'publicationSeedOrder',
    'publishOrder',
    'updateOrder',
    'deleteOrder',
  ]) {
    if (!Array.isArray(plan.execution[key])) {
      throw sharedFailure(
        'invalidPlan',
        `Content diff execution property ${key} must be an array.`,
      );
    }
  }
  assertUniqueIds(plan.records, 'record');
  assertUniqueIds(plan.uploads, 'upload');
  assertUniqueIds(plan.uploadCollections, 'upload collection');
  const recordSnapshotIdentityMismatches =
    findRecordSnapshotIdentityMismatches(plan);
  if (recordSnapshotIdentityMismatches.length > 0) {
    throw sharedFailure(
      'invalidPlan',
      `Content plan record snapshot identities do not match their plan identities: ${recordSnapshotIdentityMismatches.join(
        ', ',
      )}.`,
    );
  }
  const invalidUploadCollectionPlan = plan.uploadCollections
    .map((collection: any) => ({
      collection,
      error: uploadCollectionPlanContractError(collection),
    }))
    .find((entry: any) => entry.error !== null);
  if (invalidUploadCollectionPlan) {
    throw sharedFailure(
      'invalidPlan',
      `Upload collection ${invalidUploadCollectionPlan.collection.id} has an invalid executable contract: ${invalidUploadCollectionPlan.error}.`,
    );
  }
  const uploadCollectionOrderError = uploadCollectionOrderContractError(
    plan.uploadCollections,
    plan.execution.collectionOrder,
  );
  if (uploadCollectionOrderError) {
    throw sharedFailure(
      'invalidPlan',
      `Upload collection label transition is not executable in the planned order: ${uploadCollectionOrderError}.`,
    );
  }
  const requiredManageUploadCollections = deriveRequiredManageUploadCollections(
    plan.uploadCollections,
  );
  if (
    !isObject(plan.requiredPermissions) ||
    plan.requiredPermissions.manageUploadCollections !==
      requiredManageUploadCollections
  ) {
    throw sharedFailure(
      'invalidPlan',
      `Content plan upload-collection permission does not match its exact operations: expected manageUploadCollections=${String(
        requiredManageUploadCollections,
      )}.`,
    );
  }
  const nonPortableCreateIds = findNonPortableCreateIds(plan);
  if (nonPortableCreateIds.length > 0) {
    throw sharedFailure(
      'invalidPlan',
      `Content plan contains non-portable IDs for CMA creates: ${nonPortableCreateIds.join(
        ', ',
      )}.`,
    );
  }

  if (
    !plan.options ||
    typeof plan.options.migrateInvalidContent !== 'boolean' ||
    !isObject(plan.invalidContent) ||
    plan.invalidContent.formatVersion !== 1 ||
    plan.invalidContent.migrateInvalidContent !==
      plan.options.migrateInvalidContent ||
    !Array.isArray(plan.invalidContent.detectedRecordIds) ||
    !Array.isArray(plan.invalidContent.migratedRecordIds) ||
    !Number.isInteger(plan.invalidContent.propagatedSkipCount) ||
    plan.invalidContent.propagatedSkipCount < 0 ||
    !Array.isArray(plan.invalidContent.validatorRelaxations) ||
    !Array.isArray(plan.invalidContent.skippedRecords) ||
    !isObject(plan.invalidContent.schemaStates) ||
    plan.invalidContent.schemaStates.partialRelaxationContract !==
      'per_field_original_or_relaxed'
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan has an invalid invalid-content contract.',
    );
  }
  if (
    plan.invalidContent.schemaStates.originalDigest !==
      plan.target.schemaDigest ||
    plan.invalidContent.schemaStates.originalDigest !== plan.schema.digest
  ) {
    throw sharedFailure(
      'invalidPlan',
      "Invalid-content schema gating does not target the plan's original schema digest.",
    );
  }

  const relaxationsByFieldId = new Map<string, any>();
  const relaxedRecordIds = new Set<string>();
  for (const relaxation of plan.invalidContent.validatorRelaxations) {
    const itemType = plan.schema.itemTypes.find(
      (entry: any) => entry.id === relaxation.itemTypeId,
    );
    const field = itemType?.fields.find(
      (entry: any) => entry.id === relaxation.fieldId,
    );
    const originalHash = isObject(relaxation.originalValidators)
      ? semanticHash(relaxation.originalValidators)
      : null;
    const relaxedHash = isObject(relaxation.relaxedValidators)
      ? semanticHash(relaxation.relaxedValidators)
      : null;
    const removedKeys =
      isObject(relaxation.originalValidators) &&
      isObject(relaxation.relaxedValidators)
        ? Object.keys(relaxation.originalValidators)
            .filter(
              (key) =>
                !Object.prototype.hasOwnProperty.call(
                  relaxation.relaxedValidators,
                  key,
                ),
            )
            .sort()
        : [];
    const retainedValidators = isObject(relaxation.originalValidators)
      ? Object.fromEntries(
          Object.entries(relaxation.originalValidators).filter(
            (entry) => !removedKeys.includes(entry[0]),
          ),
        )
      : null;
    if (
      !itemType ||
      !field ||
      relaxationsByFieldId.has(relaxation.fieldId) ||
      originalHash !== relaxation.originalHash ||
      relaxedHash !== relaxation.relaxedHash ||
      relaxation.originalHash === relaxation.relaxedHash ||
      stableStringify(field.validators) !==
        stableStringify(relaxation.originalValidators) ||
      !Array.isArray(relaxation.allowedValidatorHashes) ||
      relaxation.allowedValidatorHashes.length !== 2 ||
      !relaxation.allowedValidatorHashes.includes(relaxation.originalHash) ||
      !relaxation.allowedValidatorHashes.includes(relaxation.relaxedHash) ||
      !Array.isArray(relaxation.relaxedValidatorKeys) ||
      stableStringify(
        planValidationUnique(relaxation.relaxedValidatorKeys).sort(),
      ) !== stableStringify(removedKeys) ||
      removedKeys.some((key) => !RELAXABLE_VALIDATOR_KEYS.has(key)) ||
      stableStringify(retainedValidators) !==
        stableStringify(relaxation.relaxedValidators) ||
      !Array.isArray(relaxation.affectedRecordIds) ||
      relaxation.affectedRecordIds.some(
        (id: unknown) => typeof id !== 'string' || !id,
      ) ||
      !Array.isArray(relaxation.reasons) ||
      relaxation.reasons.length === 0
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Validator relaxation for field ${String(
          relaxation.fieldId,
        )} is not an exact, reversible removal of supported optional validators.`,
      );
    }
    relaxationsByFieldId.set(relaxation.fieldId, relaxation);
    relaxation.affectedRecordIds.forEach((id: string) => {
      relaxedRecordIds.add(id);
    });
  }
  if (
    plan.invalidContent.validatorRelaxations.length > 0 &&
    plan.options.migrateInvalidContent !== true
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Validator relaxations require migrateInvalidContent=true in the generated plan.',
    );
  }
  const fullyRelaxedSchema = schemaWithValidatorRelaxations(
    plan.schema,
    plan.invalidContent.validatorRelaxations,
  );
  if (
    computeSchemaDigest(fullyRelaxedSchema) !==
    plan.invalidContent.schemaStates.fullyRelaxedDigest
  ) {
    throw sharedFailure(
      'invalidPlan',
      'The declared fully-relaxed schema digest does not match the validator relaxation plan.',
    );
  }

  assertUniqueIds(plan.invalidContent.skippedRecords, 'skipped record');
  const plannedRecordIds = new Set<string>(
    plan.records.map((entry: any) => entry.id),
  );
  const detectedRecordIds: unknown[] = plan.invalidContent.detectedRecordIds;
  const migratedRecordIds: unknown[] = plan.invalidContent.migratedRecordIds;
  const detectedRecordIdSet = new Set(detectedRecordIds);
  const migratedRecordIdSet = new Set(migratedRecordIds);
  if (
    detectedRecordIds.some((id) => typeof id !== 'string' || !id) ||
    migratedRecordIds.some((id) => typeof id !== 'string' || !id) ||
    detectedRecordIdSet.size !== detectedRecordIds.length ||
    migratedRecordIdSet.size !== migratedRecordIds.length ||
    migratedRecordIds.some(
      (id) =>
        !detectedRecordIdSet.has(id) || !plannedRecordIds.has(id as string),
    ) ||
    plan.invalidContent.propagatedSkipCount >
      plan.invalidContent.skippedRecords.length
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Invalid-content record classifications are inconsistent.',
    );
  }
  if (
    plan.invalidContent.validatorRelaxations.some((relaxation: any) =>
      relaxation.affectedRecordIds.some(
        (id: string) => !plannedRecordIds.has(id),
      ),
    )
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Validator relaxation affectedRecordIds must refer to managed record plans.',
    );
  }
  const sanitizationRisks = findPlanSanitizedHtmlWriteRisks(
    plan,
    fullyRelaxedSchema,
  );
  if (sanitizationRisks.length > 0) {
    throw sharedFailure(
      'invalidPlan',
      'One or more projected CREATE/UPDATE text values may be rewritten by active sanitized_html preprocessing. This runtime cannot preserve those source bytes exactly.',
      {
        recordIds: planValidationUnique(
          sanitizationRisks.map((risk) => risk.recordId),
        ).sort(),
        fieldIds: planValidationUnique(
          sanitizationRisks.map((risk) => risk.fieldId),
        ).sort(),
        stages: planValidationUnique(
          sanitizationRisks.map((risk) => risk.stage),
        ),
        paths: sanitizationRisks.map((risk) => risk.path),
      },
    );
  }
  const defaultValueSuppressions = planCreateDefaultValueSuppressions(plan);
  if (
    defaultValueSuppressions.length > 0 &&
    plan.options.migrateInvalidContent !== true
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Temporary field-default suppression requires migrateInvalidContent=true in the generated plan.',
    );
  }
  if (
    !isObject(plan.requiredPermissions) ||
    typeof plan.requiredPermissions.editSchema !== 'boolean' ||
    ((plan.invalidContent.validatorRelaxations.length > 0 ||
      defaultValueSuppressions.length > 0) &&
      plan.requiredPermissions.editSchema !== true)
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Plan does not declare the schema-edit permission required by its temporary schema changes.',
    );
  }
  const invalidUploadPlan = plan.uploads
    .map((uploadPlan: any) => ({
      uploadPlan,
      error: uploadPlanContractError(uploadPlan, plan.schema),
    }))
    .find((entry: any) => entry.error !== null);
  if (invalidUploadPlan) {
    throw sharedFailure(
      'invalidPlan',
      `Upload ${invalidUploadPlan.uploadPlan.id} has an invalid executable contract: ${invalidUploadPlan.error}. Regenerate the plan with the current plugin.`,
    );
  }
  // Every derived set includes read, so a missing declaration never matches.
  const declaredUploadActions = Array.isArray(
    plan.requiredPermissions.uploadActions,
  )
    ? plan.requiredPermissions.uploadActions
    : [];
  const derivedUploadActions = deriveRequiredUploadActions(plan.uploads);
  if (
    stableStringify(declaredUploadActions) !==
    stableStringify(derivedUploadActions)
  ) {
    throw sharedFailure(
      'invalidPlan',
      'The plan upload permission declaration does not match its exact create, update, replace_asset, move, and delete operations. Regenerate the plan with the current plugin.',
      { expected: derivedUploadActions, actual: declaredUploadActions },
    );
  }
  const defaultSuppressionWarnings = plan.warnings.filter(
    (warning: any) => warning && warning.code === 'DEFAULT_VALUE_SUPPRESSION',
  );
  if (
    (defaultValueSuppressions.length === 0 &&
      defaultSuppressionWarnings.length !== 0) ||
    (defaultValueSuppressions.length > 0 &&
      (defaultSuppressionWarnings.length !== 1 ||
        stableStringify(defaultSuppressionWarnings[0].entityIds) !==
          stableStringify(
            defaultValueSuppressions.map((entry) => entry.fieldId),
          )))
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Plan does not disclose its exact temporary field-default suppression set.',
    );
  }
  for (const skipped of plan.invalidContent.skippedRecords) {
    if (
      plannedRecordIds.has(skipped.id) ||
      !['must_remain_absent', 'preserve_target', 'preserve_external'].includes(
        skipped.disposition,
      ) ||
      typeof skipped.itemTypeId !== 'string' ||
      typeof skipped.sourceHash !== 'string' ||
      !plan.schema.itemTypes.some(
        (itemType: any) =>
          itemType.id === skipped.itemTypeId && itemType.modularBlock !== true,
      ) ||
      !isValiditySnapshot(skipped.sourceValidity) ||
      !Array.isArray(skipped.sourceNestedBlockIds) ||
      !Array.isArray(skipped.targetNestedBlockIds) ||
      !Array.isArray(skipped.preservedExternalBlockIds) ||
      skipped.sourceNestedBlockIds.some(
        (id: unknown) => typeof id !== 'string' || !id,
      ) ||
      skipped.targetNestedBlockIds.some(
        (id: unknown) => typeof id !== 'string' || !id,
      ) ||
      skipped.preservedExternalBlockIds.some(
        (id: unknown) => typeof id !== 'string' || !id,
      ) ||
      new Set(skipped.preservedExternalBlockIds).size !==
        skipped.preservedExternalBlockIds.length ||
      skipped.preservedExternalBlockIds.some(
        (id: string) =>
          !skipped.sourceNestedBlockIds.includes(id) ||
          skipped.targetNestedBlockIds.includes(id),
      ) ||
      !Array.isArray(skipped.reasons) ||
      skipped.reasons.length === 0
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Skipped record ${String(
          skipped.id,
        )} has an invalid preservation contract.`,
      );
    }
    if (skipped.disposition === 'must_remain_absent') {
      if (
        skipped.expectedTargetHash !== null ||
        skipped.targetValidity !== null ||
        skipped.expectedTargetPosition !== null ||
        skipped.targetNestedBlockIds.length !== 0
      ) {
        throw sharedFailure(
          'invalidPlan',
          `Absent skipped record ${skipped.id} unexpectedly declares target state.`,
        );
      }
    } else if (
      skipped.disposition === 'preserve_target' &&
      (typeof skipped.expectedTargetHash !== 'string' ||
        !isValiditySnapshot(skipped.targetValidity) ||
        (skipped.expectedTargetPosition !== null &&
          typeof skipped.expectedTargetPosition !== 'number'))
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Preserved skipped record ${skipped.id} has no exact target state.`,
      );
    } else if (
      skipped.disposition === 'preserve_external' &&
      (skipped.expectedTargetHash !== null ||
        skipped.expectedTargetPosition !== null ||
        skipped.targetValidity !== null ||
        skipped.targetNestedBlockIds.length !== 0 ||
        skipped.preservedExternalBlockIds.length !== 0)
    ) {
      throw sharedFailure(
        'invalidPlan',
        `External skipped record ${skipped.id} must use an existence-only target contract.`,
      );
    }
  }
  if (
    plan.invalidContent.skippedRecords.some(
      (skipped: any) =>
        !detectedRecordIdSet.has(skipped.id) ||
        migratedRecordIdSet.has(skipped.id),
    )
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Skipped invalid records must be detected and disjoint from migrated invalid records.',
    );
  }
  const unavailableSkippedIds = new Set<string>(
    plan.invalidContent.skippedRecords
      .filter((entry: any) => entry.disposition !== 'preserve_target')
      .map((entry: any) => entry.id),
  );
  if (
    plan.records.some(
      (record: any) =>
        record.desired &&
        record.dependencies.some((id: string) => unavailableSkippedIds.has(id)),
    )
  ) {
    throw sharedFailure(
      'invalidPlan',
      'A managed record depends on skipped source content that is absent or externally shadowed in the destination.',
    );
  }
  const managedNestedBlockIds = new Set<string>();
  const plannedNestedBlockIds = new Set<string>();
  const releaseSchemaById = new Map<string, any>(
    plan.schema.itemTypes
      .concat(plan.targetInspection.itemTypes)
      .map((itemType: any) => [itemType.id, itemType]),
  );
  for (const record of plan.records) {
    for (const snapshot of [record.baseline, record.desired]) {
      if (!snapshot) continue;
      const blocks = new Map<string, JsonObject>();
      collectNestedBlocks(
        snapshot.current.fields,
        blocks,
        releaseSchemaById.get(record.itemTypeId),
        releaseSchemaById,
      );
      if (snapshot.published) {
        collectNestedBlocks(
          snapshot.published.fields,
          blocks,
          releaseSchemaById.get(record.itemTypeId),
          releaseSchemaById,
        );
      }
      blocks.forEach((_value, id) => {
        plannedNestedBlockIds.add(id);
      });
      if (snapshot === record.desired) {
        blocks.forEach((_value, id) => {
          managedNestedBlockIds.add(id);
        });
      }
    }
  }
  const transientNestedBlockIds = new Set<string>();
  for (const release of plan.execution.deleteReleases) {
    if (
      Array.isArray(release.transientNestedBlockIds) &&
      release.transientNestedBlockIds.length > 0
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Delete-reference release ${String(
          release.recordId,
        )} requires fresh published-derived nested block IDs, which the CMA full-validation update path cannot create safely. Regenerate this migration with content-diff plan format V9 so the deletion component is preserved.`,
      );
    }
    if (
      !Array.isArray(release.transientNestedBlockIds) ||
      release.transientNestedBlockIds.some(
        (id: unknown) => typeof id !== 'string' || !isPortableDatoId(id),
      ) ||
      new Set(release.transientNestedBlockIds).size !==
        release.transientNestedBlockIds.length ||
      stableStringify(release.transientNestedBlockIds) !==
        stableStringify(release.transientNestedBlockIds.slice().sort())
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Delete-reference release ${String(
          release.recordId,
        )} has an invalid transient nested-block ID reservation.`,
      );
    }
    const releaseBlocks: NestedBlockIdentity[] = [];
    const releaseRecord = plan.records.find(
      (record: any) => record.id === release.recordId,
    );
    collectNestedBlockIdentities(
      release.fields,
      releaseBlocks,
      releaseSchemaById.get(releaseRecord?.itemTypeId),
      releaseSchemaById,
    );
    const releaseBlockIds = new Set(releaseBlocks.map((block) => block.id));
    const declaredIds = new Set<string>(release.transientNestedBlockIds);
    if (releaseBlocks.length !== releaseBlockIds.size) {
      throw sharedFailure(
        'invalidPlan',
        `Delete-reference release ${String(
          release.recordId,
        )} reuses a nested block ID.`,
      );
    }
    if (
      (release.publish === true &&
        !planValidationSameStringSet(releaseBlockIds, declaredIds)) ||
      (release.publish !== true && declaredIds.size !== 0)
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Delete-reference release ${String(
          release.recordId,
        )} does not declare its exact published-derived transient nested blocks.`,
      );
    }
    for (const block of releaseBlocks) {
      const blockType = releaseSchemaById.get(block.itemTypeId);
      if (!blockType || blockType.modularBlock !== true) {
        throw sharedFailure(
          'invalidPlan',
          `Delete-reference release ${String(
            release.recordId,
          )} contains a nested item with an unknown or non-block model.`,
        );
      }
    }
    for (const id of release.transientNestedBlockIds) {
      if (
        transientNestedBlockIds.has(id) ||
        plannedNestedBlockIds.has(id) ||
        plannedRecordIds.has(id)
      ) {
        throw sharedFailure(
          'invalidPlan',
          `Transient nested block ${id} collides with another planned Item identity.`,
        );
      }
      transientNestedBlockIds.add(id);
      plannedNestedBlockIds.add(id);
    }
  }
  validateLegacyIdMappingPlan(
    plan,
    managedNestedBlockIds,
    plannedNestedBlockIds,
  );
  if (
    plan.invalidContent.skippedRecords.some((skipped: any) =>
      skipped.sourceNestedBlockIds
        .concat(skipped.targetNestedBlockIds)
        .some(
          (id: string) =>
            managedNestedBlockIds.has(id) || transientNestedBlockIds.has(id),
        ),
    )
  ) {
    throw sharedFailure(
      'invalidPlan',
      'A skipped aggregate reserves a nested block ID used by managed or transient content.',
    );
  }

  const recordIdsWithAction = (action: string): string[] =>
    plan.records
      .filter((entry: any) => entry.action === action)
      .map((entry: any) => entry.id);
  const createIds = recordIdsWithAction('create');
  const deleteIds = recordIdsWithAction('delete');
  assertOrderContains(plan.execution.createOrder, createIds, 'record create');
  const publicationIds: string[] = plan.records
    .filter((entry: any) => entry.desired)
    .map((entry: any) => entry.id);
  assertOrderContains(
    plan.execution.publishOrder,
    publicationIds,
    'record publication',
  );
  assertOrderContains(plan.execution.deleteOrder, deleteIds, 'record delete');
  if (
    plan.execution.shellRecordIds.some((id: string) => !createIds.includes(id))
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Execution shellRecordIds must contain only source-only record IDs.',
    );
  }
  const shellComponentIds: string[] = [];
  for (const component of plan.execution.shellComponents) {
    if (
      !Array.isArray(component) ||
      component.length === 0 ||
      component.some(
        (id) =>
          typeof id !== 'string' || !plan.execution.shellRecordIds.includes(id),
      ) ||
      new Set(component).size !== component.length ||
      stableStringify(component) !== stableStringify(component.slice().sort())
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Execution shellComponents must contain non-empty, sorted, unique shell-record ID arrays.',
      );
    }
    shellComponentIds.push(...component);
  }
  if (
    new Set(plan.execution.shellRecordIds).size !==
      plan.execution.shellRecordIds.length ||
    new Set(shellComponentIds).size !== shellComponentIds.length ||
    stableStringify(plan.execution.shellRecordIds) !==
      stableStringify(plan.execution.shellRecordIds.slice().sort()) ||
    stableStringify(plan.execution.shellComponents) !==
      stableStringify(
        plan.execution.shellComponents
          .slice()
          .sort((left: string[], right: string[]) =>
            compareStrings(left.join(','), right.join(',')),
          ),
      ) ||
    stableStringify(plan.execution.shellRecordIds.slice().sort()) !==
      stableStringify(shellComponentIds.slice().sort())
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Execution shellComponents must partition shellRecordIds exactly once.',
    );
  }
  if (
    plan.execution.publicationSeedOrder.some((id: string) => {
      const record = plan.records.find((entry: any) => entry.id === id);
      return (
        !record ||
        record.action !== 'create' ||
        !record.desired ||
        !record.desired.published
      );
    })
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Execution publicationSeedOrder must contain only source-only records with a desired published state.',
    );
  }
  for (const id of plan.execution.shellRecordIds) {
    const shell = plan.records.find((entry: any) => entry.id === id);
    const itemType =
      shell &&
      plan.schema.itemTypes.find((entry: any) => entry.id === shell.itemTypeId);
    if (
      !itemType ||
      (!(itemType.draftModeActive && itemType.draftSavingActive) &&
        !relaxedRecordIds.has(id))
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Record shell ${id} requires native invalid-draft saving or an exact validator relaxation.`,
      );
    }
  }
  if (
    plan.execution.revalidateBeforePublishIds.some((id: string) => {
      const record = plan.records.find((entry: any) => entry.id === id);
      const deleteReleasePublishes = plan.execution.deleteReleases.some(
        (release: any) => release.recordId === id && release.publish === true,
      );
      return (
        !record ||
        (!record.desired?.published && !deleteReleasePublishes) ||
        !relaxedRecordIds.has(id)
      );
    })
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Execution revalidateBeforePublishIds contains a record outside the validator-relaxation publication set.',
    );
  }

  if (!plan.options || plan.options.includeDeletions !== true) {
    if (
      plan.records.some((entry: any) => entry.action === 'delete') ||
      plan.uploads.some((entry: any) => entry.action === 'delete')
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Plan contains deletions without includeDeletions enabled.',
      );
    }
  } else if (!plan.targetPreconditions) {
    throw sharedFailure(
      'invalidPlan',
      'A destructive plan must include exact target-set preconditions.',
    );
  }

  for (const entry of plan.records) {
    if (!['create', 'update', 'delete', 'noop'].includes(entry.action)) {
      throw sharedFailure(
        'invalidPlan',
        `Record ${entry.id} has an invalid action.`,
      );
    }
    if (entry.action === 'delete' && entry.desired !== null) {
      throw sharedFailure(
        'invalidPlan',
        `Deleted record ${entry.id} unexpectedly has desired state.`,
      );
    }
    if (entry.action !== 'delete' && !entry.desired) {
      throw sharedFailure(
        'invalidPlan',
        `Record ${entry.id} has no desired state.`,
      );
    }
    if (
      entry.action === 'noop' &&
      (!entry.baseline ||
        entry.baseline.hash !== entry.desired.hash ||
        entry.expectedTargetHash !== entry.desired.hash ||
        stableStringify(entry.baseline.validity) !==
          stableStringify(entry.desired.validity))
    ) {
      throw sharedFailure(
        'invalidPlan',
        `No-op record ${entry.id} must contain identical baseline and desired states.`,
      );
    }
    if (
      !Array.isArray(entry.publishedDependencies) ||
      entry.publishedDependencies.some(
        (id: unknown) => typeof id !== 'string' || !id,
      )
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Record ${entry.id} has invalid publishedDependencies.`,
      );
    }
    if (
      (entry.baseline && !isValiditySnapshot(entry.baseline.validity)) ||
      (entry.desired && !isValiditySnapshot(entry.desired.validity))
    ) {
      throw sharedFailure(
        'invalidPlan',
        `Record ${entry.id} has invalid validity expectations.`,
      );
    }
    if (entry.desired) {
      const itemType = plan.schema.itemTypes.find(
        (candidate: any) => candidate.id === entry.itemTypeId,
      );
      if (!itemType) {
        throw sharedFailure(
          'invalidPlan',
          `Record ${entry.id} refers to missing item type ${entry.itemTypeId}.`,
        );
      }
      if (
        !itemType.draftModeActive &&
        (!entry.desired.published ||
          entry.desired.published.hash !== entry.desired.current.hash)
      ) {
        throw sharedFailure(
          'unsupportedContentState',
          `No-draft item type ${entry.itemTypeId} cannot represent different current and published states.`,
        );
      }
    }
  }
  const unsupportedFreshNestedUpdate = findUnsupportedFreshNestedBlockUpdates(
    plan.records,
    releaseSchemaById,
    releaseSchemaById,
    itemTypeIdsAffectedByValidatorChanges(
      releaseSchemaById,
      new Set(
        plan.invalidContent.validatorRelaxations.map(
          (entry: any) => entry.itemTypeId,
        ),
      ),
    ),
    unsafeFreshNestedCreateRecordIds(plan),
  )[0];
  if (unsupportedFreshNestedUpdate) {
    throw sharedFailure(
      'invalidPlan',
      `Record ${unsupportedFreshNestedUpdate.recordId} would introduce fresh nested block ${unsupportedFreshNestedUpdate.blockId} during ${unsupportedFreshNestedUpdate.stage}. This write requires an invalid or revalidating predecessor, an unproven creation seed, or an ID still retained only in PUBLISHED.`,
      { ...unsupportedFreshNestedUpdate },
    );
  }
  for (const entry of plan.uploads) {
    if (!['create', 'update', 'delete', 'noop'].includes(entry.action)) {
      throw sharedFailure(
        'invalidPlan',
        `Upload ${entry.id} has an invalid action.`,
      );
    }
    if (entry.action === 'delete' ? entry.desired !== null : !entry.desired) {
      throw sharedFailure(
        'invalidPlan',
        `Upload ${entry.id} has state inconsistent with its action.`,
      );
    }
    if (
      entry.action === 'noop' &&
      (!entry.baseline ||
        entry.baseline.hash !== entry.desired.hash ||
        entry.expectedTargetHash !== entry.desired.hash)
    ) {
      throw sharedFailure(
        'invalidPlan',
        `No-op upload ${entry.id} must contain identical baseline and desired states.`,
      );
    }
  }
  for (const release of plan.execution.uniqueReleases) {
    const owner = plan.records.find(
      (entry: any) => entry.id === release.recordId,
    );
    if (
      !owner ||
      owner.action !== 'update' ||
      !isObject(release.fields) ||
      typeof release.intermediateCurrentHash !== 'string' ||
      !Array.isArray(owner.allowedIntermediateHashes) ||
      !owner.allowedIntermediateHashes.includes(release.intermediateCurrentHash)
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Unique-value release contains an invalid owner, field payload, or intermediate hash.',
      );
    }
    const invalidField = uniqueReleaseFieldError(
      plan.schema.itemTypes.find((entry: any) => entry.id === owner.itemTypeId),
      release,
    );
    if (invalidField) {
      throw sharedFailure(
        'invalidPlan',
        `Unique-value release ${release.recordId}.${invalidField.fieldApiKey} ${invalidField.reason}.`,
        { recordId: release.recordId, fieldApiKey: invalidField.fieldApiKey },
      );
    }
  }
  const deleteReleaseOwners = new Set<string>();
  for (const release of plan.execution.deleteReleases) {
    const owner = plan.records.find(
      (entry: any) => entry.id === release.recordId,
    );
    if (
      !owner ||
      owner.action !== 'delete' ||
      deleteReleaseOwners.has(release.recordId) ||
      !isObject(release.fields) ||
      typeof release.intermediateCurrentHash !== 'string' ||
      semanticHash(release.fields) !== release.intermediateCurrentHash ||
      typeof release.publish !== 'boolean' ||
      !Array.isArray(release.transientNestedBlockIds) ||
      !Array.isArray(owner.allowedIntermediateHashes) ||
      !owner.allowedIntermediateHashes.includes(release.intermediateCurrentHash)
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Delete-reference release contains an invalid owner, field payload, publication flag, or intermediate hash.',
      );
    }
    deleteReleaseOwners.add(release.recordId);
  }
}

/**
 * Checks the destination inspection schema: distinct, sorted, out-of-scope
 * modular block models with well-formed fields that collide with no managed
 * field, matching the declared digest.
 */
export function validateTargetInspection(plan: Record<string, any>): void {
  const inspection = plan.targetInspection;
  if (
    !isObject(inspection) ||
    !Array.isArray(inspection.itemTypes) ||
    typeof inspection.digest !== 'string'
  ) {
    throw sharedFailure(
      'invalidPlan',
      'Content diff plan is missing the destination inspection-schema contract.',
    );
  }
  const managedItemTypeIds = new Set<string>(
    plan.schema.itemTypes.map((itemType: any) => itemType.id),
  );
  const managedFieldIds = new Set<string>(
    plan.schema.itemTypes.flatMap((itemType: any) =>
      itemType.fields.map((field: any) => field.id),
    ),
  );
  const inspectionItemTypeIds = new Set<string>();
  const inspectionFieldIds = new Set<string>();
  let previousItemTypeId: string | null = null;
  for (const itemType of inspection.itemTypes) {
    if (
      !isObject(itemType) ||
      typeof itemType.id !== 'string' ||
      !itemType.id ||
      typeof itemType.apiKey !== 'string' ||
      !itemType.apiKey ||
      itemType.modularBlock !== true ||
      !Array.isArray(itemType.fields) ||
      managedItemTypeIds.has(itemType.id) ||
      inspectionItemTypeIds.has(itemType.id) ||
      (previousItemTypeId !== null &&
        compareStrings(itemType.id, previousItemTypeId) <= 0)
    ) {
      throw sharedFailure(
        'invalidPlan',
        'Destination inspection item types must be distinct, sorted, out-of-scope modular block models.',
      );
    }
    inspectionItemTypeIds.add(itemType.id);
    previousItemTypeId = itemType.id;
    for (const field of itemType.fields) {
      if (
        !isObject(field) ||
        typeof field.id !== 'string' ||
        !field.id ||
        typeof field.apiKey !== 'string' ||
        !field.apiKey ||
        typeof field.fieldType !== 'string' ||
        typeof field.localized !== 'boolean' ||
        typeof field.position !== 'number' ||
        !isObject(field.validators) ||
        managedFieldIds.has(field.id) ||
        inspectionFieldIds.has(field.id)
      ) {
        throw sharedFailure(
          'invalidPlan',
          'Destination inspection schema contains an invalid or colliding field.',
        );
      }
      inspectionFieldIds.add(field.id);
    }
  }
  if (inspectionItemTypesDigest(inspection.itemTypes) !== inspection.digest) {
    throw sharedFailure(
      'invalidPlan',
      'Destination inspection-schema digest does not match its item types.',
    );
  }
}

function assertUniqueIds(entries: any[], label: string): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      throw sharedFailure(
        'invalidPlan',
        `Plan contains an invalid ${label} ID.`,
      );
    }
    if (ids.has(entry.id)) {
      throw sharedFailure(
        'invalidPlan',
        `Plan contains duplicate ${label} ID ${entry.id}.`,
      );
    }
    ids.add(entry.id);
  }
}

function assertOrderContains(
  order: unknown[],
  requiredIds: string[],
  label: string,
): void {
  const ordered = new Set(order);
  const missing = requiredIds.filter((id) => !ordered.has(id));
  if (missing.length) {
    throw sharedFailure(
      'invalidPlan',
      `Execution order for ${label} is missing: ${missing.join(', ')}.`,
    );
  }
}

function isValiditySnapshot(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.current === 'boolean' &&
    (value.published === null || typeof value.published === 'boolean')
  );
}
