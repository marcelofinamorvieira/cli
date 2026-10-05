import type { Client } from './types';

/**
 * Blocks every other edit to an environment for the duration of a run.
 * DatoCMS has no such feature yet, so this always reports that nothing was
 * locked, and callers keep their concurrency checks.
 *
 * Once the feature exists, implement it here and in unlockEnvironment. While
 * an environment is locked nothing else can change it, so its captures need
 * no second consistency read and apply needs no check before restoring
 * schedules; callers already skip both when this returns true. The lock must
 * let this run's own token keep writing, should also hold back scheduled
 * publications, and should expire on its own if the process dies.
 */
export async function lockEnvironment(
  _client: Client,
  _environmentId: string,
): Promise<boolean> {
  return false;
}

/** Releases a lock taken by lockEnvironment. */
export async function unlockEnvironment(
  _client: Client,
  _environmentId: string,
): Promise<void> {}
