import type { CmaClient } from '@datocms/cli-utils';

export type Client = CmaClient.Client;
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type Side = 'source' | 'target';
export type Action = 'create' | 'update' | 'delete' | 'noop' | 'skip';
/** Plan entry kinds; `collection` is an upload folder. */
export const KINDS = ['record', 'upload', 'collection'] as const;
export type Kind = (typeof KINDS)[number];

export interface FieldSchema {
  id: string;
  apiKey: string;
  type: string;
  localized: boolean;
  /**
   * Validators and default value are hashed into the destination schema hash
   * and never interpreted: the CMA validates every write.
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
   * Hashed into the destination schema hash. Generation also reads the
   * destination's setting to accept source records whose draft the CMA
   * reports invalid; required locales are never interpreted.
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

/**
 * What planning keeps of a captured record: its identity, hash, publication
 * and place, but not its field values, which stay on disk until the
 * operations are written. A reference keeps the top-level field it sits in
 * (`root`, or `parentId` for a tree parent) instead of its full path.
 */
export interface RecordFacts {
  id: string;
  modelId: string;
  hash: string;
  published: boolean;
  parentId: string | null;
  position: number | null;
  invalid?: { current: boolean; published: boolean };
  /** The value of the record's `title` or `name` field, for labels. */
  title?: string;
  /** Read only for records the plan creates, updates or deletes. */
  references: ReferenceFact[];
  /** Keys in the record's values the SDK would corrupt through a write. */
  unsupportedKeys?: string[];
  /** Size of the record's JSON, to size operation files. */
  bytes: number;
}
export type ReferenceFact = Omit<Reference, 'ownerId' | 'path'> & {
  root: string;
};
export type UploadFacts = Pick<
  UploadState,
  'id' | 'hash' | 'md5' | 'size' | 'collectionId' | 'filename'
>;

export interface Diagnostic {
  code: string;
  message: string;
}
export interface RecordPlan {
  kind: 'record';
  id: string;
  modelId: string;
  action: Action;
  /** Whether the record exists in the destination. */
  inDestination: boolean;
  baseline?: RecordFacts | null;
  desired?: RecordFacts | null;
  diagnostics: Diagnostic[];
  execution?: {
    createOrder?: number;
    publishOrder?: number;
    deleteOrder?: number;
    /**
     * Top-level fields a create leaves empty because they reference records
     * not created (or, for models without draft mode, not published) yet.
     */
    deferredFields?: string[];
    /**
     * Records whose links a first publication leaves out of the top-level
     * link fields, because they are in a publication cycle with this one;
     * the full published fields are published again once they are published.
     */
    provisionalTargets?: string[];
  };
}
export interface UploadPlan {
  kind: 'upload';
  id: string;
  action: Action;
  inDestination: boolean;
  baseline?: UploadFacts | null;
  desired?: UploadFacts | null;
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
export interface CaptureOptions {
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
  /** Check the diff and the destination without running it. */
  preflightOnly?: boolean;
  concurrency: number;
  /**
   * Use DatoCMS's fast fork (the command's default), which blocks destination
   * writes while it copies; false creates a regular fork.
   */
  fastFork: boolean;
  log?: (message: string) => void;
}
interface ApplyResult {
  environmentId: string;
  executed: true;
  operations: number;
  partial: boolean;
}
export interface PreflightResult {
  environmentId: string;
  preflightOnly: true;
  executed: false;
  operations: number;
  partial: boolean;
  /** Generation summary, not a prediction of the effects of edited lines. */
  generatedCounts: PlanCounts;
}
export type ApplyOutcome = ApplyResult | PreflightResult;
