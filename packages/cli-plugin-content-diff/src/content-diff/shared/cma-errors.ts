// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import { isObject } from './json';

/** CMA API error codes that report a missing resource. */
const CMA_NOT_FOUND_ERROR_CODES = new Set([
  'NOT_FOUND',
  'RECORD_NOT_FOUND',
  'ITEM_NOT_FOUND',
]);

/**
 * Whether a CMA client error reports a missing resource: an HTTP 404, or an
 * API error entry whose code is a not-found code. JSON:API error objects keep
 * the code under `attributes`; a flat entry carries it directly. An entry's
 * `id` identifies the error instance, never its kind, so it is not read.
 */
export function isCmaNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, any>;
  if (isObject(candidate.response) && candidate.response.status === 404) {
    return true;
  }
  if (!Array.isArray(candidate.errors)) return false;
  return candidate.errors.some((entry: unknown) => {
    if (!isObject(entry)) return false;
    const source = isObject(entry.attributes) ? entry.attributes : entry;
    return CMA_NOT_FOUND_ERROR_CODES.has(source.code);
  });
}
