import type { CmaClient } from '@datocms/cli-utils';
import type {
  CONTENT_DIFF_PLAN_VERSION,
  LEGACY_ID_MAPPING_FIELD_API_KEY,
  LEGACY_ID_MAPPING_FIELD_LABEL,
  LEGACY_ID_MAPPING_FORMAT_VERSION,
  LEGACY_ID_MAPPING_MODEL_NAME,
  LEGACY_ID_MAPPING_NAME_FIELD_API_KEY,
  LEGACY_ID_MAPPING_NAME_FIELD_LABEL,
} from './shared/contract';

export type Client = CmaClient.Client;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const CONTENT_SNAPSHOT_FORMAT_VERSION = 3 as const;
export const CONTENT_DIFF_GENERATOR_VERSION = '1.1.0' as const;
export const INVALID_CONTENT_FORMAT_VERSION = 1 as const;
// Plan and mapping-ledger contract values the runtime shares, under their
// planner names.
export {
  CONTENT_DIFF_PLAN_VERSION as CONTENT_PLAN_FORMAT_VERSION,
  LEGACY_ID_MAPPING_FIELD_API_KEY as CONTENT_DIFF_MAPPING_FIELD_API_KEY,
  LEGACY_ID_MAPPING_FORMAT_VERSION,
  LEGACY_ID_MAPPING_MAX_DOCUMENT_BYTES as CONTENT_DIFF_MAPPING_RECORD_MAX_BYTES,
  LEGACY_ID_MAPPING_NAME_FIELD_API_KEY as CONTENT_DIFF_MAPPING_NAME_FIELD_API_KEY,
  LEGACY_ID_MAPPING_MODEL_API_KEY as DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
} from './shared/contract';

export type ContentDiffErrorCode =
  | 'BLOCK_OWNERSHIP_CONFLICT'
  | 'CONCURRENT_SNAPSHOT_CHANGE'
  | 'DUPLICATE_ENTITY_ID'
  | 'ENVIRONMENT_SEMANTICS_MISMATCH'
  | 'INCOMPATIBLE_SCHEMA'
  | 'INVALID_MIGRATIONS_MODEL'
  | 'INVALID_SCOPE'
  | 'LEGACY_ID_NOT_PORTABLE'
  | 'MIGRATION_RUN_IN_PROGRESS'
  | 'MISSING_EXTERNAL_REFERENCE'
  | 'REQUIRED_REFERENCE_CYCLE'
  | 'SCHEMA_MISMATCH'
  | 'SCHEDULE_CONTRACT_CHANGED'
  | 'SINGLETON_ID_MISMATCH'
  | 'UNHEALTHY_UPLOAD'
  | 'UNPROVEN_FULL_ACCESS'
  | 'UNPROVEN_SCHEMA_EDIT_ACCESS'
  | 'UNSUPPORTED_CONTENT_STATE'
  | 'UNIQUE_VALUE_CYCLE'
  | 'UPLOAD_DOWNLOAD_TIMEOUT';

export class ContentDiffError extends Error {
  readonly code: ContentDiffErrorCode;
  readonly details?: JsonObject;

  constructor(
    code: ContentDiffErrorCode,
    message: string,
    details?: JsonObject,
  ) {
    super(message);
    this.name = 'ContentDiffError';
    this.code = code;
    this.details = details;
  }
}

export type FieldType =
  | 'boolean'
  | 'color'
  | 'date'
  | 'date_time'
  | 'file'
  | 'float'
  | 'gallery'
  | 'integer'
  | 'json'
  | 'lat_lon'
  | 'link'
  | 'links'
  | 'rich_text'
  | 'seo'
  | 'single_block'
  | 'slug'
  | 'string'
  | 'structured_text'
  | 'text'
  | 'video';

export interface FieldSchemaSnapshot {
  id: string;
  apiKey: string;
  fieldType: FieldType;
  localized: boolean;
  position: number;
  /** Always populated by live snapshots; optional for legacy in-memory fixtures. */
  defaultValue?: JsonValue;
  validators: JsonObject;
}

export interface ItemTypeSchemaSnapshot {
  id: string;
  apiKey: string;
  name: string;
  modularBlock: boolean;
  singleton: boolean;
  sortable: boolean;
  tree: boolean;
  draftModeActive: boolean;
  draftSavingActive: boolean;
  allLocalesRequired: boolean;
  workflowId: string | null;
  fields: FieldSchemaSnapshot[];
}

export interface WorkflowSchemaSnapshot {
  id: string;
  apiKey: string;
  stages: Array<{
    id: string;
    name: string;
    initial: boolean;
  }>;
}

export interface SchemaSnapshot {
  siteId: string;
  environmentId: string;
  locales: string[];
  environmentSemantics: {
    timezone: string;
    improvedTimezoneManagement: boolean;
    improvedBooleanFields: boolean;
    improvedValidationAtPublishing: boolean;
    millisecondsInDatetime: boolean;
    nonLocalizedFocalPoints: boolean;
    improvedHexManagement: boolean;
  };
  itemTypes: ItemTypeSchemaSnapshot[];
  workflows: WorkflowSchemaSnapshot[];
  digest: string;
}

export type ItemTypeSelection = 'all' | string[];
export type UploadSelection = 'referenced' | 'all';
export type ContentDiffProjectMode = 'same_project' | 'aligned_projects';

export interface ContentSnapshotScope {
  itemTypes: ItemTypeSelection;
  uploads: UploadSelection;
  migrationsModelApiKey?: string;
  /** Internal append-only legacy-ID ledger model, never managed as content. */
  contentDiffModelApiKey?: string;
  /** Extra upload IDs to include when present, even if currently unreferenced. */
  baselineUploadIds?: string[];
  /** Extra collection IDs to include when present, even if currently unused. */
  baselineUploadCollectionIds?: string[];
  /** Internal destination capture mode used to prove collection-label occupancy. */
  allUploadCollections?: boolean;
}

export interface PublicationScheduleSnapshot {
  at: string;
  selective: null | {
    locales: string[];
    nonLocalized: boolean;
  };
}

export interface UnpublishingScheduleSnapshot {
  at: string;
  locales: string[] | null;
}

export interface RecordScheduleSnapshot {
  publication: PublicationScheduleSnapshot | null;
  unpublishing: UnpublishingScheduleSnapshot | null;
}

/** Request-compatible record fields, excluding id, type, item_type and meta. */
export interface RecordVersionSnapshot {
  fields: JsonObject;
  hash: string;
}

/**
 * CMA validation state is intentionally portable provenance, not content.
 * It never contributes to a record semantic hash, but it does contribute to
 * the enclosing snapshot digest and the two-pass consistency marker.
 */
export interface RecordValiditySnapshot {
  current: boolean;
  published: boolean | null;
}

export interface RecordSnapshot {
  id: string;
  itemTypeId: string;
  current: RecordVersionSnapshot;
  published: RecordVersionSnapshot | null;
  topology: {
    parentId: string | null;
    position: number | null;
  };
  lifecycle: {
    createdAt: string;
    firstPublishedAt: string | null;
  };
  validity: RecordValiditySnapshot;
  stage: string | null;
  schedules: RecordScheduleSnapshot;
  hash: string;
  /** Read-consistency markers. They are deliberately excluded from `hash`. */
  consistency: {
    currentVersion: string;
    updatedAt: string;
    publishedAt: string | null;
    currentValid: boolean;
    publishedValid: boolean | null;
  };
}

export interface UploadCollectionSnapshot {
  id: string;
  label: string;
  parentId: string | null;
  position: number;
  hash: string;
}

export interface UploadSnapshot {
  id: string;
  md5: string;
  basename: string;
  filename: string;
  /** Transport is excluded from the semantic upload hash and may be enriched by bundling. */
  transport: {
    sourceUrl: string;
    bundledPath: string | null;
    sha256: string | null;
  };
  size: number;
  mimeType: string | null;
  manual: {
    author: string | null;
    copyright: string | null;
    notes: string | null;
    defaultFieldMetadata: JsonObject;
    tags: string[];
    collectionId: string | null;
  };
  hash: string;
  /** Read-consistency markers. They are deliberately excluded from `hash`. */
  consistency: {
    updatedAt: string | null;
    antivirusStatus: 'pending' | 'clean' | 'infected' | 'failed' | 'skipped';
  };
}

export interface BlockOwnership {
  blockId: string;
  topRecordId: string;
  itemTypeId: string;
  version: 'current' | 'published';
  fieldPath: string;
  locale: string | null;
}

export type StructuralBlockValidatorKey =
  | 'rich_text_blocks'
  | 'single_block_blocks'
  | 'structured_text_blocks'
  | 'structured_text_inline_blocks';

/**
 * A persisted nested block whose model is no longer accepted at its exact
 * embedding point. This is capture provenance only: it never expands the
 * managed schema-compatibility boundary.
 */
export interface StructuralContentIssue {
  recordId: string;
  itemTypeId: string;
  slice: 'current' | 'published';
  fieldId: string;
  fieldPath: string;
  locale: string | null;
  validatorKey: StructuralBlockValidatorKey;
  blockId: string;
  blockItemTypeId: string;
}

export interface ContentInspectionSnapshot {
  /** Actually encountered modular-block models outside the managed schema. */
  itemTypes: ItemTypeSchemaSnapshot[];
  digest: string;
  structuralIssues: StructuralContentIssue[];
}

export interface ContentSnapshot {
  formatVersion: typeof CONTENT_SNAPSHOT_FORMAT_VERSION;
  siteId: string;
  environmentId: string;
  capturedAt: string;
  schema: SchemaSnapshot;
  scope: {
    itemTypeIds: string[];
    uploads: UploadSelection;
  };
  /** Every regular model in this environment, for authoritative read proof. */
  readItemTypes: Array<{
    id: string;
    workflowId: string | null;
  }>;
  records: Record<string, RecordSnapshot>;
  uploads: Record<string, UploadSnapshot>;
  uploadCollections: Record<string, UploadCollectionSnapshot>;
  /** All visible current record IDs, including models outside the selected scope. */
  visibleRecordIds: string[];
  blockOwnership: Record<string, BlockOwnership[]>;
  /** Narrow read-only schema required to inspect persisted invalid blocks. */
  inspection: ContentInspectionSnapshot;
  /** Missing upload IDs grouped by owning top-level aggregate. */
  missingUploadReferences?: Record<string, string[]>;
  digest: string;
}

export interface ScheduleAdapter {
  read(client: Client, recordId: string): Promise<RecordScheduleSnapshot>;
}

export interface CaptureContentSnapshotInput {
  client: Client;
  environmentId: string;
  schema?: SchemaSnapshot;
  scope: ContentSnapshotScope;
  maxAttempts?: number;
  scheduleAdapter?: ScheduleAdapter;
  /**
   * Exact diffing cannot be proven from permission-filtered collections. The
   * caller must positively establish unrestricted reads before setting this.
   */
  fullAccessVerified?: boolean;
}

export interface ReferenceDependency {
  fromRecordId: string;
  toRecordId: string;
  path: string;
  required: boolean;
}

export interface RecordDependencyGraph {
  dependencies: Record<string, string[]>;
  references: ReferenceDependency[];
  createOrder: string[];
  updateOrder: string[];
  /** Creates whose valid/invalid seed differs from their desired seed version. */
  temporarySeedRecordIds: string[];
  /** Creates whose intra-cycle references are stripped for a native or relaxed shell. */
  shellRecordIds: string[];
  /** Exact strongly connected create components that own those shells. */
  shellComponents: string[][];
  /** Optional-cycle creates whose valid seed must be published before final reconciliation. */
  publicationSeedOrder: string[];
}

/**
 * A partial current-version update that releases one or more unique values
 * before records consuming those values are created or reconciled.
 */
export interface UniqueReleaseStep {
  recordId: string;
  /** Full desired values, keyed by field API key. */
  fields: JsonObject;
  consumerRecordIds: string[];
  /** Hash of baseline current fields after applying `fields`. */
  intermediateCurrentHash: string;
}

/**
 * A deterministic unlink step used to break an optional-reference cycle
 * between records that are all scheduled for deletion.
 */
export interface DeleteReleaseStep {
  recordId: string;
  /** Complete current fields after optional intra-cycle references are removed. */
  fields: JsonObject;
  /** Semantic hash of `fields`, used to recognize a resumed partial run. */
  intermediateCurrentHash: string;
  /** Whether the released current version must replace a published version. */
  publish: boolean;
  /**
   * Reserved for explicit runtime rejection in format V9 and must be empty.
   * Published-derived releases that need fresh nested blocks are preserved as
   * skipped aggregates because the CMA full-validation path cannot create
   * those transient identities safely.
   */
  transientNestedBlockIds: string[];
}

export type RecordPlanAction = 'create' | 'update' | 'delete' | 'noop';

export interface RecordPlan {
  id: string;
  itemTypeId: string;
  action: RecordPlanAction;
  expectedTargetHash: string | null;
  baseline: RecordSnapshot | null;
  desired: RecordSnapshot | null;
  changes: {
    current: boolean;
    published: boolean;
    topology: boolean;
    lifecycle: boolean;
    stage: boolean;
    schedules: boolean;
  };
  dependencies: string[];
  /** Every record referenced by the desired published snapshot, including out-of-scope IDs. */
  publishedDependencies: string[];
  allowedIntermediateHashes: string[];
}

export type UploadPlanAction = 'create' | 'update' | 'delete' | 'noop';

export interface UploadPlan {
  id: string;
  action: UploadPlanAction;
  expectedTargetHash: string | null;
  baseline: UploadSnapshot | null;
  desired: UploadSnapshot | null;
  changes: {
    binary: boolean;
    metadata: boolean;
    collection: boolean;
  };
}

export type UploadCollectionPlanAction = 'create' | 'update' | 'noop';

export interface UploadCollectionPlan {
  id: string;
  action: UploadCollectionPlanAction;
  expectedTargetHash: string | null;
  baseline: UploadCollectionSnapshot | null;
  desired: UploadCollectionSnapshot;
}

export type InvalidContentSlice =
  | 'current'
  | 'published'
  | 'intermediate'
  | 'schedule';

export type InvalidContentReasonCode =
  | 'DEPENDENCY_ON_SKIPPED_RECORD'
  | 'ENTITY_ID_COLLISION'
  | 'INVALID_CREATE_SEED'
  | 'INVALID_CURRENT'
  | 'INVALID_INTERMEDIATE'
  | 'INVALID_PUBLISHED'
  | 'ORDERING_ANCHOR'
  | 'MISSING_REFERENCE'
  | 'REQUIRED_REFERENCE_CYCLE'
  | 'STRUCTURAL_VALIDATION'
  | 'UNRELAXABLE_VALIDATOR'
  | 'UNSAFE_SCHEDULED_PUBLICATION'
  | 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE'
  | 'UNSUPPORTED_PUBLISHED_BLOCK_RELEASE'
  | 'UNIQUE_VALUE_CYCLE'
  | 'VALIDATION_CONTRACT_CHANGED';

export interface InvalidContentReason {
  code: InvalidContentReasonCode;
  slice: InvalidContentSlice | null;
  message: string;
  fieldId?: string;
  validatorKey?: string;
  dependencyId?: string;
  /** Root-to-leaf selected-record dependency chain, including both ends. */
  dependencyChain: string[];
}

export interface InvalidContentValidationIssue {
  code: string;
  fieldId: string | null;
  details: JsonObject;
}

/**
 * Result of a read-only diagnostic validation for one exact prospective
 * version. `versionHash` prevents a result from being applied to another
 * payload after planner refactors or snapshot changes.
 */
export interface InvalidContentDiagnostic {
  recordId: string;
  slice: Exclude<InvalidContentSlice, 'schedule'>;
  versionHash: string;
  valid: boolean;
  issues: InvalidContentValidationIssue[];
}

export interface CreateCycleShellCandidate {
  recordId: string;
  itemTypeId: string;
  componentRecordIds: string[];
  fields: JsonObject;
  versionHash: string;
  topologyCycle: boolean;
}

export type SkippedRecordDisposition =
  | 'must_remain_absent'
  | 'preserve_target'
  | 'preserve_external';

/** A whole top-level aggregate that the generated migration must not write. */
export interface SkippedRecordAggregate {
  id: string;
  itemTypeId: string;
  disposition: SkippedRecordDisposition;
  sourceHash: string;
  expectedTargetHash: string | null;
  expectedTargetPosition: number | null;
  sourceValidity: RecordValiditySnapshot;
  targetValidity: RecordValiditySnapshot | null;
  sourceNestedBlockIds: string[];
  /** Source block IDs that already belong to unmanaged destination content. */
  preservedExternalBlockIds: string[];
  targetNestedBlockIds: string[];
  reasons: InvalidContentReason[];
}

/** Exact, reversible validator replacement applied around content writes. */
export interface ValidatorRelaxationPlan {
  fieldId: string;
  itemTypeId: string;
  originalValidators: JsonObject;
  relaxedValidators: JsonObject;
  originalHash: string;
  relaxedHash: string;
  /** Exactly these two field-validator hashes are safe on a resumed run. */
  allowedValidatorHashes: [string, string];
  relaxedValidatorKeys: string[];
  affectedRecordIds: string[];
  reasons: InvalidContentReason[];
}

export type LegacyIdEntityType =
  | 'record'
  | 'block'
  | 'upload'
  | 'upload_collection';

export interface LegacyIdMappingDocumentEntry {
  entityType: LegacyIdEntityType;
  sourceId: string;
  targetId: string;
}

export interface LegacyIdMappingEntry extends LegacyIdMappingDocumentEntry {
  status: 'existing' | 'new';
  /** Whether the mapped entity itself is reconciled by this plan. */
  managed: boolean;
  /** Expected live model for an external record alias; null for managed entities. */
  expectedItemTypeId: string | null;
  /** Target slices the runtime must prove before writes. */
  requiredAvailability: {
    current: boolean;
    published: boolean;
  };
}

/** Generation diagnostic only; never written into the durable alias ledger. */
export interface SkippedLegacyIdMappingEntry {
  entityType: LegacyIdEntityType;
  sourceId: string;
  reason: string;
}

export interface LegacyIdMappingDocument {
  formatVersion: typeof LEGACY_ID_MAPPING_FORMAT_VERSION;
  projectId: string;
  batchId: string;
  chunkIndex: number;
  chunkCount: number;
  wholeHash: string;
  entries: LegacyIdMappingDocumentEntry[];
}

export interface LegacyIdMappingSchemaResource {
  id: string;
  status: 'existing' | 'new';
}

export interface LegacyIdMappingSchemaPlan {
  model: LegacyIdMappingSchemaResource & {
    apiKey: string;
    name: typeof LEGACY_ID_MAPPING_MODEL_NAME;
    modularBlock: false;
    singleton: false;
    sortable: false;
    tree: false;
    draftModeActive: true;
    draftSavingActive: false;
    allLocalesRequired: false;
    inverseRelationshipsEnabled: false;
    workflowId: null;
  };
  nameField: LegacyIdMappingSchemaResource & {
    apiKey: typeof LEGACY_ID_MAPPING_NAME_FIELD_API_KEY;
    label: typeof LEGACY_ID_MAPPING_NAME_FIELD_LABEL;
    fieldType: 'string';
    localized: false;
    position: 1;
    validators: { required: JsonObject; unique: JsonObject };
  };
  mappingField: LegacyIdMappingSchemaResource & {
    apiKey: typeof LEGACY_ID_MAPPING_FIELD_API_KEY;
    label: typeof LEGACY_ID_MAPPING_FIELD_LABEL;
    fieldType: 'json';
    localized: false;
    position: 2;
    validators: { required: JsonObject };
  };
}

export interface LegacyIdMappingChunkPlan {
  id: string;
  name: string;
  chunkIndex: number;
  chunkCount: number;
  hash: string;
  byteLength: number;
  serializedDocument: string;
  document: LegacyIdMappingDocument;
}

export interface LegacyIdMappingPlan {
  formatVersion: typeof LEGACY_ID_MAPPING_FORMAT_VERSION;
  schema: LegacyIdMappingSchemaPlan;
  /** Existing append-only records are immutable preconditions and reserve Item IDs. */
  existingMappingRecords: Array<{
    id: string;
    /** SHA-256 of the exact canonical pretty JSON field string. */
    hash: string;
  }>;
  entries: LegacyIdMappingEntry[];
  skippedEntries: SkippedLegacyIdMappingEntry[];
  newMappingBatch: null | {
    batchId: string;
    wholeHash: string;
    chunks: LegacyIdMappingChunkPlan[];
  };
}

export interface PlanWarning {
  code:
    | 'ABSOLUTE_POSITION_NOT_REPRODUCIBLE'
    | 'DEFAULT_VALUE_SUPPRESSION'
    | 'INVALID_CONTENT_NOOP'
    | 'INVALID_CONTENT_SKIPPED'
    | 'LEGACY_ID_REMAP'
    | 'LEGACY_ID_SKIPPED'
    | 'RETAINED_TARGET_RECORD'
    | 'RETAINED_TARGET_UPLOAD';
  message: string;
  entityIds: string[];
}

export interface PlanSummary {
  records: { create: number; update: number; delete: number };
  uploads: { create: number; update: number; delete: number };
  uploadCollections: { create: number; update: number };
  invalidContent: {
    status: 'complete' | 'partial';
    detectedRecords: number;
    migratedRecords: number;
    skippedRecords: number;
    propagatedSkipCount: number;
    validatorRelaxations: number;
    relaxedFieldCount: number;
    relaxedValidatorCount: number;
    requiresTemporaryValidatorRelaxation: boolean;
  };
  legacyIdMappings: {
    detected: number;
    existing: number;
    created: number;
    skipped: number;
    records: number;
  };
  warnings: number;
}

export interface ContentDiffPlan {
  formatVersion: typeof CONTENT_DIFF_PLAN_VERSION;
  generatorVersion: typeof CONTENT_DIFF_GENERATOR_VERSION;
  source: {
    siteId: string;
    environmentId: string;
    schemaDigest: string;
    snapshotDigest: string;
    capturedAt: string;
  };
  target: {
    siteId: string;
    environmentId: string;
    schemaDigest: string;
    snapshotDigest: string;
    capturedAt: string;
  };
  options: {
    /** Whether both snapshots belong to one project or to asserted aligned projects. */
    projectMode: ContentDiffProjectMode;
    includeDeletions: boolean;
    uploads: UploadSelection;
    migrateInvalidContent: boolean;
    /** Exact model API key used by `migrations:run` for its tracking records. */
    migrationsModelApiKey: string;
  };
  schema: SchemaSnapshot;
  /**
   * Destination-only block schemas needed to recapture invalid baselines.
   * They are deliberately outside `schema.digest` and are never writable.
   */
  targetInspection: {
    itemTypes: ItemTypeSchemaSnapshot[];
    digest: string;
  };
  records: RecordPlan[];
  uploads: UploadPlan[];
  uploadCollections: UploadCollectionPlan[];
  legacyIdMappings: LegacyIdMappingPlan;
  invalidContent: {
    formatVersion: typeof INVALID_CONTENT_FORMAT_VERSION;
    migrateInvalidContent: boolean;
    schemaStates: {
      originalDigest: string;
      fullyRelaxedDigest: string;
      /**
       * A partial run is valid only when every listed field independently
       * matches one of its two `allowedValidatorHashes`.
       */
      partialRelaxationContract: 'per_field_original_or_relaxed';
    };
    detectedRecordIds: string[];
    migratedRecordIds: string[];
    propagatedSkipCount: number;
    validatorRelaxations: ValidatorRelaxationPlan[];
    skippedRecords: SkippedRecordAggregate[];
  };
  execution: {
    collectionOrder: string[];
    uploadOrder: string[];
    uniqueReleases: UniqueReleaseStep[];
    deleteReleases: DeleteReleaseStep[];
    shellRecordIds: string[];
    /**
     * Exact create-cycle membership. A shell strips its own component while
     * preserving already-created records from independent components.
     */
    shellComponents: string[][];
    /**
     * Records that need a same-content write after validator relaxation (or
     * validator restoration) so CMA validity is synchronous before publish.
     */
    revalidateBeforePublishIds: string[];
    createOrder: string[];
    /** Valid optional-cycle seeds that must be published before final publication operations. */
    publicationSeedOrder: string[];
    /** Forward order for publish/reconcile/unpublish operations. */
    publishOrder: string[];
    updateOrder: string[];
    deleteOrder: string[];
  };
  targetPreconditions: null | {
    itemTypeIds: string[];
    selectedRecordIds: string[];
    desiredRecordIds: string[];
    selectedUploadIds: string[];
    desiredUploadIds: string[];
  };
  requiredPermissions: {
    /** Full-project read scope used by filtered referrer preflight checks. */
    readItemTypes: Array<{
      id: string;
      workflowId: string | null;
    }>;
    itemTypes: Array<{
      id: string;
      actions: Array<
        'read' | 'create' | 'update' | 'publish' | 'delete' | 'move_to_stage'
      >;
    }>;
    uploadActions: Array<
      'read' | 'create' | 'update' | 'replace_asset' | 'move' | 'delete'
    >;
    manageUploadCollections: boolean;
    manageSchedules: boolean;
    editSchema: boolean;
  };
  warnings: PlanWarning[];
  summary: PlanSummary;
}

export interface BuildContentDiffPlanOptions {
  includeDeletions: boolean;
  uploads: UploadSelection;
  /** Defaults to the core CLI's `schema_migration` API key. */
  migrationsModelApiKey?: string;
  /** Defaults to false for direct library callers. */
  migrateInvalidContent?: boolean;
  invalidContentDiagnostics?: InvalidContentDiagnostic[];
  entityIdCollisions?: Array<{
    id: string;
    kind: 'record' | 'block';
    topRecordId: string;
  }>;
  /** Source identifiers are rewritten from this append-only ledger contract. */
  legacyIdMappings?: LegacyIdMappingPlan;
  /** Authoritative destination facts for existing aliases that may remain external. */
  externalLegacyRecordTargets?: Record<
    string,
    { itemTypeId: string; current: boolean; published: boolean }
  >;
  /** Existing durable Item-namespace aliases that must remain reserved. */
  legacyIdMappingOccupiedItemIds?: string[];
}
