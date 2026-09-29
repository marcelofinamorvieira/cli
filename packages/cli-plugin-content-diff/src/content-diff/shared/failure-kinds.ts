// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { ContentDiffErrorCode } from '../types';

/**
 * Failures shared code can raise, with the error code each environment
 * reports for them. The planner and the runtime keep their own vocabularies:
 * `sharedFailure` builds a ContentDiffError with the planner code during
 * generation and a ContentDiffRuntimeError with the runtime code during
 * execution. No kind may map to the planner codes the CLI formats specially
 * (SCHEMA_MISMATCH, ENVIRONMENT_SEMANTICS_MISMATCH).
 */
export const SHARED_FAILURE_CODES = {
  invalidJson: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'INVALID_JSON',
  },
  malformedContent: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'INVALID_CMA_RESPONSE',
  },
  unhealthyUpload: { planner: 'UNHEALTHY_UPLOAD', runtime: 'UNHEALTHY_UPLOAD' },
  unknownModel: { planner: 'INCOMPATIBLE_SCHEMA', runtime: 'SCHEMA_MISMATCH' },
  invalidPlan: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'INVALID_PLAN',
  },
  invalidCreateOrder: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'INVALID_CREATE_ORDER',
  },
  requiredReferenceCycle: {
    planner: 'REQUIRED_REFERENCE_CYCLE',
    runtime: 'REQUIRED_REFERENCE_CYCLE',
  },
  treeCycle: { planner: 'UNSUPPORTED_CONTENT_STATE', runtime: 'TREE_CYCLE' },
  invalidUploadId: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'INVALID_UPLOAD_ID',
  },
  scheduleContract: {
    planner: 'SCHEDULE_CONTRACT_CHANGED',
    runtime: 'SCHEDULE_CONTRACT_CHANGED',
  },
  // Plan and manifest validation, which generation and execution share. A
  // plan-internal schema mismatch must not reach the CLI's schema-mismatch
  // formatting, so it is an unsupported content state during generation.
  unsupportedPlan: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'UNSUPPORTED_PLAN',
  },
  planSchemaMismatch: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'SCHEMA_MISMATCH',
  },
  unsupportedContentState: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'UNSUPPORTED_CONTENT_STATE',
  },
  invalidManifest: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'INVALID_MANIFEST',
  },
  unsupportedManifest: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'UNSUPPORTED_MANIFEST',
  },
  unsupportedRuntime: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'UNSUPPORTED_RUNTIME',
  },
  planIntegrityFailure: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'PLAN_INTEGRITY_FAILURE',
  },
  // The durable legacy-ID ledger, which generation reads and execution reads
  // and appends to.
  legacyMappingRecordConflict: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'LEGACY_MAPPING_RECORD_CONFLICT',
  },
  legacyMappingConflict: {
    planner: 'UNSUPPORTED_CONTENT_STATE',
    runtime: 'LEGACY_MAPPING_CONFLICT',
  },
} as const satisfies Record<
  string,
  { readonly planner: ContentDiffErrorCode; readonly runtime: string }
>;

export type SharedFailureKind = keyof typeof SHARED_FAILURE_CODES;

/** Reads a kind's codes without falling through to Object.prototype. */
export function sharedFailureCodes(
  kind: string,
): (typeof SHARED_FAILURE_CODES)[SharedFailureKind] | null {
  return Object.prototype.hasOwnProperty.call(SHARED_FAILURE_CODES, kind)
    ? SHARED_FAILURE_CODES[kind as SharedFailureKind]
    : null;
}
