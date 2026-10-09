import type { CmaClient } from '@datocms/cli-utils';

export type Client = CmaClient.Client;
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type Side = 'source' | 'target';
export type Action = 'create' | 'update' | 'delete' | 'noop' | 'skip';
export type Kind = 'record' | 'upload' | 'collection';

export interface FieldSchema {
  id: string;
  apiKey: string;
  type: string;
  localized: boolean;
  /**
   * Validators and default value are hashed into the destination binding and
   * never interpreted: the CMA validates every write.
   */
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
  /**
   * Hashed into the destination binding. Generation also reads it to accept
   * source records whose draft the CMA reports invalid; required locales are
   * never interpreted.
   */
  saveInvalidDrafts: boolean;
  allLocalesRequired: boolean;
  workflowId: string | null;
  fields: FieldSchema[];
}
export interface WorkflowSchema {
  id: string;
  apiKey: string;
  stages: { id: string; name: string; initial: boolean }[];
}
export interface SchemaState {
  siteId: string;
  environmentId: string;
  locales: string[];
  semantics: JsonObject;
  models: ModelSchema[];
  workflows: WorkflowSchema[];
  hash: string;
}
interface PublicationSchedule {
  at: string;
  selective: { locales: string[]; nonLocalized: boolean } | null;
}
interface UnpublishingSchedule {
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
  /**
   * Versions the CMA itself reports as invalid (`is_current_version_valid` or
   * `is_published_version_valid` set to false). Absent when neither is. Not
   * part of the hash: it describes the content, it is not content.
   */
  invalid?: { current: boolean; published: boolean };
  hash: string;
}
/**
 * What apply compares for a destination record: its content hash, plus the
 * version metadata and position the hash leaves out.
 */
export interface RecordGuard {
  hash: string;
  currentVersion: string | null;
  publishedUpdatedAt: string | null;
  position: number | null;
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
}
export interface Diagnostic {
  code: string;
  message: string;
}
export interface RecordPlan {
  kind: 'record';
  id: string;
  modelId: string;
  action: Action;
  /** Whether the record exists in the destination baseline. */
  inDestination: boolean;
  baseline?: RecordState | null;
  desired?: RecordState | null;
  diagnostics: Diagnostic[];
  execution?: {
    createOrder?: number;
    publishOrder?: number;
    deleteOrder?: number;
    creationFields?: JsonObject;
    /**
     * Published fields for a first publication that omits links to other
     * records in a publication cycle; the full desired published fields are
     * published again once those records are published.
     */
    provisionalPublished?: JsonObject;
  };
}
export interface UploadPlan {
  kind: 'upload';
  id: string;
  action: Action;
  inDestination: boolean;
  baseline?: UploadState | null;
  desired?: UploadState | null;
  diagnostics: Diagnostic[];
}
export interface CollectionPlan {
  kind: 'collection';
  id: string;
  action: Action;
  inDestination: boolean;
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
}
export type PlanCounts = Record<Kind, Record<Action, number>>;
export interface PlanMetadata {
  source: { siteId: string; environmentId: string };
  destination: { siteId: string; environmentId: string };
  schema: SchemaState;
  options: PlanOptions;
  counts: PlanCounts;
}
export interface ArtifactChunk {
  file: string;
  sha256: string;
  bytes: number;
  entries: number;
}
export interface ArtifactChunkIndex {
  file: 'chunks.jsonl';
  sha256: string;
  bytes: number;
  count: number;
}
export interface CaptureOptions {
  /** Excludes the configured migration tracking model, bound by ID at generation. */
  schemaProjection?: (schema: SchemaState) => SchemaState;
  signal?: AbortSignal;
  concurrency: number;
  progress?: (message: string) => void;
}
/** Options of content:apply, already validated by the command. */
export interface ApplyOptions {
  signal?: AbortSignal;
  inPlace: boolean;
  allowPrimary: boolean;
  keepFailedFork: boolean;
  destinationEnvironmentId?: string;
  /** Requested ID of a newly created fork; never an existing environment. */
  forkName?: string;
  /** Check original artifacts and destination state without executing the script. */
  preflightOnly?: boolean;
  concurrency: number;
  /** Refuse to start when a schedule falls due within this many minutes. */
  scheduleWindowMinutes: number;
  /** Use DatoCMS's fast fork, which blocks destination writes while it copies. */
  fastFork?: boolean;
  /**
   * 'versions' (the default) skips rereading records whose version did not
   * change; 'full' rereads every record in each check.
   */
  verification?: 'versions' | 'full';
  log?: (message: string) => void;
}
interface ApplyResult {
  environmentId: string;
  scriptExecuted: true;
  partial: boolean;
}
export interface PreflightResult {
  environmentId: string;
  preflightOnly: true;
  scriptExecuted: false;
  partial: boolean;
  /** Original generation summary, not a prediction of edited TypeScript effects. */
  generatedCounts: PlanCounts;
}
export type ApplyOutcome = ApplyResult | PreflightResult;
