import { assertNotAborted } from './cancellation';

/** Pull work only as capacity becomes available; never queue the whole work list. */
export async function boundedWork<T>(
  entries: Iterable<T>,
  concurrency: number,
  work: (entry: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Work concurrency must be a positive integer.');
  }
  const running = new Set<Promise<void>>();
  let failure: unknown;
  let failed = false;
  try {
    for (const entry of entries) {
      assertNotAborted(signal);
      while (running.size >= concurrency) {
        await Promise.race(running);
        if (failed) throw failure;
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
      running.add(task);
    }
    while (running.size) {
      await Promise.race(running);
      if (failed) throw failure;
    }
  } finally {
    // Every started request settles before this returns, so a failure never
    // leaves reads running behind the caller.
    await Promise.all(running);
  }
  if (failed) throw failure;
  assertNotAborted(signal);
}

/** Groups of at most 30 values, the limit of one nested record read. */
export function* batches<T>(values: Iterable<T>): Generator<T[]> {
  let batch: T[] = [];
  for (const value of values) {
    batch.push(value);
    if (batch.length === 30) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
