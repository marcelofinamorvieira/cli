// The planner's implementation of the environment-provided failure factory.
// scripts/runtime-shared.mjs never inlines this module: the hand-written
// runtime declares its own top-level `sharedFailure` next to `runtimeError`,
// and shared code calls whichever binding its environment provides.

import { ContentDiffError, type JsonObject } from '../types';
import { type SharedFailureKind, sharedFailureCodes } from './failure-kinds';

/** Builds the planner error for a failure raised by shared code. */
export function sharedFailure(
  kind: SharedFailureKind,
  message: string,
  details?: JsonObject,
): ContentDiffError {
  const codes = sharedFailureCodes(kind);
  if (!codes) {
    throw new TypeError(`Unknown shared failure kind ${String(kind)}.`);
  }
  return new ContentDiffError(codes.planner, message, details);
}
