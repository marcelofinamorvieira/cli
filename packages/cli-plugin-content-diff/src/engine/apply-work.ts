export interface WorkLocks {
  writes: readonly string[];
  reads: readonly string[];
}

interface ActiveLocks {
  writes: Set<string>;
  reads: Set<string>;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) if (b.has(key)) return true;
  return false;
}

function conflicts(a: ActiveLocks, b: ActiveLocks): boolean {
  return (
    intersects(a.writes, b.writes) ||
    intersects(a.writes, b.reads) ||
    intersects(a.reads, b.writes)
  );
}

/** Pull work only as capacity becomes available; never queue the whole bundle. */
export async function boundedWork<T>(
  entries: Iterable<T>,
  concurrency: number,
  work: (entry: T) => Promise<void>,
  group: (entry: T) => string | WorkLocks | null = () => null,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Work concurrency must be a positive integer.');
  }
  const running = new Map<Promise<void>, ActiveLocks>();
  let failure: unknown;
  let failed = false;
  async function drainOne() {
    await Promise.race(running.keys());
    if (failed) throw failure;
  }
  try {
    for (const entry of entries) {
      assertNotAborted(signal);
      const keys = group(entry);
      const lock: ActiveLocks = {
        writes: new Set(typeof keys === 'string' ? [keys] : keys?.writes ?? []),
        reads: new Set(typeof keys === 'string' ? [] : keys?.reads ?? []),
      };
      while (
        running.size >= concurrency ||
        [...running.values()].some((active) => conflicts(lock, active))
      ) {
        await drainOne();
      }
      if (failed) throw failure;
      assertNotAborted(signal);
      const task = Promise.resolve()
        .then(() => {
          assertNotAborted(signal);
          return work(entry);
        })
        .catch((error: unknown) => {
          if (!failed) failure = error;
          failed = true;
        })
        .finally(() => running.delete(task));
      running.set(task, lock);
    }
    while (running.size) await drainOne();
  } finally {
    // A rejected write may have committed remotely. Wait for every submitted
    // request before restoration or fork deletion; never retry the execution.
    await Promise.all(running.keys());
  }
  if (failed) throw failure;
  assertNotAborted(signal);
}

export function* batches<T>(values: Iterable<T>, size = 30): Generator<T[]> {
  if (!Number.isSafeInteger(size) || size < 1 || size > 30) {
    throw new Error('Nested-read batch size must be between 1 and 30.');
  }
  let batch: T[] = [];
  for (const value of values) {
    batch.push(value);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
import { assertNotAborted } from './cancellation';
