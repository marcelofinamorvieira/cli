import { ContentError } from './errors';

/** Cooperative interruption stops new work without abandoning submitted writes. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (
    signal.reason instanceof Error &&
    Reflect.get(signal.reason, 'code') === 'INTERRUPTED'
  )
    throw signal.reason;
  throw new ContentError('INTERRUPTED', 'Content operation was interrupted.');
}
