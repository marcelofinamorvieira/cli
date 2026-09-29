import { canonicalizeUploadState, requiredString } from './shared/canonicalize';
import type { UploadSnapshot } from './types';

// Record, upload, collection and schedule canonicalization is shared with the
// migration runtime, so generation and execution hash content identically.
export {
  canonicalTimestamp,
  canonicalizeRecord,
  canonicalizeRecordVersion,
  canonicalizeSchedules,
  canonicalizeUploadCollection,
  sortLocalizedObject,
} from './shared/canonicalize';
// The JSON and ID primitives are shared with the migration runtime.
export { isPortableDatoId } from './shared/ids';
export {
  canonicalizeJson,
  semanticHash,
  stableStringify,
} from './shared/json';

/**
 * The shared upload state plus the planner-only transport. Bundling downloads
 * the binary from `transport.sourceUrl`, so the source URL is required here;
 * it is excluded from the semantic hash the runtime compares.
 */
export function canonicalizeUpload(
  input: unknown,
  localeOrder: readonly string[],
): UploadSnapshot {
  const { hash, consistency, ...state } = canonicalizeUploadState(
    input,
    localeOrder,
  );

  return {
    ...state,
    transport: {
      sourceUrl: requiredString(
        (input as Record<string, unknown>).url,
        'upload.url',
      ),
      bundledPath: null,
      sha256: null,
    },
    hash,
    consistency,
  };
}
