import type { CmaClient } from '@datocms/cli-utils';

export type Client = CmaClient.Client;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type Side = 'source' | 'target' | 'live';
export type Action = 'create' | 'update' | 'delete' | 'noop' | 'skip';
export type Kind = 'record' | 'upload' | 'collection';

export interface FieldSchema {
  id: string;
  apiKey: string;
  type: string;
  localized: boolean;
  validators: JsonObject;
  defaultValue: JsonValue;
}
export interface ModelSchema {
  id: string;
  apiKey: string;
  name: string;
  block: boolean;
  singleton: boolean;
  sortable: boolean;
  tree: boolean;
  draftMode: boolean;
  saveInvalidDrafts: boolean;
  allLocalesRequired: boolean;
  workflowId: string | null;
  fields: FieldSchema[];
}
export interface SchemaState {
  siteId: string;
  environmentId: string;
  locales: string[];
  semantics: JsonObject;
  models: ModelSchema[];
  workflows: JsonObject[];
  hash: string;
}
export interface PublicationSchedule {
  at: string;
  selective: { locales: string[]; nonLocalized: boolean } | null;
}
export interface UnpublishingSchedule {
  at: string;
  locales: string[] | null;
}
export interface Schedules {
  publication: PublicationSchedule | null;
  unpublishing: UnpublishingSchedule | null;
}
export interface RecordState {
  id: string;
  modelId: string;
  current: JsonObject;
  published: JsonObject | null;
  currentVersion: string | null;
  publishedUpdatedAt: string | null;
  createdAt: string;
  firstPublishedAt: string | null;
  parentId: string | null;
  position: number | null;
  stage: string | null;
  schedules: Schedules;
  validity: { current: boolean; published: boolean | null };
  hash: string;
}
export interface RecordGuard {
  hash: string;
  modelId: string;
  currentVersion: string | null;
  publishedUpdatedAt: string | null;
  parentId: string | null;
  position: number | null;
  schedules: Schedules;
  validity: { current: boolean; published: boolean | null };
}
export interface UploadState {
  id: string;
  hash: string;
  md5: string;
  size: number;
  url: string;
  filename: string;
  collectionId: string | null;
  attributes: JsonObject;
}
export interface CollectionState {
  id: string;
  hash: string;
  label: string;
  parentId: string | null;
  position: number;
}
export interface Reference {
  ownerId: string;
  targetId: string;
  kind: 'current' | 'published' | 'upload';
  path: string;
  fieldId: string;
  required: boolean;
}
export interface BlockOwner {
  blockId: string;
  recordId: string;
  modelId: string;
  path: string;
  slice: 'current' | 'published';
}
export interface UniqueValue {
  recordId: string;
  modelId: string;
  fieldId: string;
  locale: string;
  slice: 'current' | 'published';
  valueKey: string;
}
export interface Diagnostic {
  code: string;
  message: string;
  dependencyId?: string;
}
export interface BinaryFile {
  file: string;
  sha256: string;
  md5: string;
  bytes: number;
}
export interface RecordPlan {
  kind: 'record';
  id: string;
  modelId: string;
  action: Action;
  guard: RecordGuard | null;
  baseline?: RecordState | null;
  desired?: RecordState | null;
  safety: {
    currentReferences: string[];
    publishedReferences: string[];
    uploadReferences: string[];
    blockIds: string[];
    desiredParentId: string | null;
    desiredPosition: number | null;
  };
  diagnostics: Diagnostic[];
  execution?: {
    createOrder?: number;
    updateOrder?: number;
    publishOrder?: number;
    deleteOrder?: number;
    creationFields?: JsonObject;
    /**
     * Published fields for a first publication that omits links to other
     * records in a publication cycle; the full desired published fields are
     * published again once those records are published.
     */
    provisionalPublished?: JsonObject;
    preclearFieldIds?: string[];
  };
}
export interface UploadPlan {
  kind: 'upload';
  id: string;
  action: Action;
  guard: { hash: string } | null;
  baseline?: UploadState | null;
  desired?: UploadState | null;
  binary?: BinaryFile;
  diagnostics: Diagnostic[];
}
export interface CollectionPlan {
  kind: 'collection';
  id: string;
  action: Action;
  guard: { hash: string } | null;
  baseline?: CollectionState | null;
  desired?: CollectionState | null;
  diagnostics: Diagnostic[];
}
export type PlanEntry = RecordPlan | UploadPlan | CollectionPlan;
export interface PlanOptions {
  modelIds: string[];
  uploads: 'referenced' | 'all';
  includeDeletions: boolean;
  allowPartial: boolean;
  allowTemporarySchemaChanges: boolean;
}
export interface TemporarySchemaChange {
  fieldId: string;
  modelId: string;
  original: { validators: JsonObject; defaultValue: JsonValue };
  temporary: { validators: JsonObject; defaultValue: JsonValue };
  reasons: string[];
}
export type PlanCounts = Record<Kind, Record<Action, number>>;
export interface PlanMetadata {
  source: { siteId: string; environmentId: string };
  destination: { siteId: string; environmentId: string };
  schema: SchemaState;
  options: PlanOptions;
  counts: PlanCounts;
  temporarySchemaChanges: TemporarySchemaChange[];
}
export interface BundleChunk {
  file: string;
  sha256: string;
  bytes: number;
  entries: number;
}
export interface BundleChunkIndex {
  file: 'chunks.jsonl';
  sha256: string;
  bytes: number;
  count: number;
}
export interface BundleManifest extends PlanMetadata {
  format: 'datocms-content-bundle/1';
  createdAt: string;
  chunks: BundleChunkIndex;
}
export interface CaptureOptions {
  /** Exclude only explicitly verified migration-tracking metadata. */
  schemaProjection?: (schema: SchemaState) => SchemaState;
  signal?: AbortSignal;
  modelIds: string[];
  uploads: 'referenced' | 'all';
  concurrency?: number;
  progress?: (message: string) => void;
}
export interface ApplyOptions {
  /** Internal native migration integration; never serialized into artifacts. */
  schemaProjection?: (schema: SchemaState) => SchemaState;
  signal?: AbortSignal;
  inPlace: boolean;
  allowPrimary: boolean;
  keepFailedFork: boolean;
  allowTemporarySchemaChanges: boolean;
  destinationEnvironmentId?: string;
  concurrency?: number;
  /** Refuse to start when a schedule falls due within this many minutes. */
  scheduleWindowMinutes?: number;
  /** Use DatoCMS's fast fork, which blocks destination writes while it copies. */
  fastFork?: boolean;
  /**
   * 'versions' (the default) skips rereading records whose version did not
   * change; 'full' rereads every record in each check.
   */
  verification?: 'versions' | 'full';
  log?: (message: string) => void;
}
export interface RepairOptions {
  schemaProjection?: (schema: SchemaState) => SchemaState;
  signal?: AbortSignal;
  allowPrimary: boolean;
  destinationEnvironmentId?: string;
  log?: (message: string) => void;
}
export interface RepairResult {
  environmentId: string;
  restoredSchedules: number;
  restoredFields: number;
}
export interface ApplyResult {
  environmentId: string;
  mutations: number;
  partial: boolean;
}
