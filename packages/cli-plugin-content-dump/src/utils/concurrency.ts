/**
 * How many CMA requests the plugin keeps in flight. The SDK waits out rate
 * limits and retries transient errors on its own.
 */
export const CONCURRENCY = 8;

/**
 * Runs `task` for every item, at most CONCURRENCY at a time. After the first
 * failure no task starts; the running ones are awaited, then the failure is
 * thrown.
 */
export async function forEachConcurrently<T>(
  items: AsyncIterable<T> | Iterable<T>,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const running = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  try {
    for await (const item of items) {
      if (failure) break;
      const run: Promise<void> = Promise.resolve()
        .then(() => task(item))
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => running.delete(run));
      running.add(run);
      if (running.size >= CONCURRENCY) await Promise.race(running);
    }
  } finally {
    // Also when reading the items fails: no task outlives this call.
    await Promise.all(running);
  }
  if (failure) throw failure.error;
}

/**
 * Runs `task` for every one of `tasks`, at most CONCURRENCY at a time, each
 * only once every task in its `dependencies` has finished. The dependencies
 * must form no cycle. Fails like `forEachConcurrently`.
 */
export async function runInDependencyOrder(
  tasks: readonly number[],
  dependencies: readonly (readonly number[])[],
  task: (index: number) => Promise<void>,
): Promise<void> {
  const remaining = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const index of tasks) {
    remaining.set(index, dependencies[index]!.length);
    for (const dependency of dependencies[index]!) {
      const list = dependents.get(dependency);
      if (list) list.push(index);
      else dependents.set(dependency, [index]);
    }
  }
  const ready = tasks.filter((index) => remaining.get(index) === 0);
  const running = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  let started = 0;
  const release = (index: number) => {
    for (const dependent of dependents.get(index) ?? []) {
      const left = remaining.get(dependent)! - 1;
      remaining.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  };
  while (!failure && (started < ready.length || running.size)) {
    while (started < ready.length && running.size < CONCURRENCY) {
      const index = ready[started++]!;
      const run: Promise<void> = Promise.resolve()
        .then(() => task(index))
        .then(
          () => release(index),
          (error: unknown) => {
            failure ??= { error };
          },
        )
        .finally(() => running.delete(run));
      running.add(run);
    }
    if (running.size) await Promise.race(running);
  }
  await Promise.all(running);
  if (failure) throw failure.error;
  if (started < tasks.length)
    throw new Error('The dependencies between tasks form a cycle.');
}

/**
 * Yields `read(0)`, `read(1)`, … `read(count - 1)` in order, keeping up to
 * CONCURRENCY reads in flight ahead of the consumer.
 */
export async function* inOrder<T>(
  count: number,
  read: (index: number) => Promise<T>,
): AsyncGenerator<T> {
  const pending: Promise<T>[] = [];
  let next = 0;
  const fill = () => {
    while (next < count && pending.length < CONCURRENCY) {
      const result = read(next++);
      // A read the consumer never reaches must not reject unhandled.
      result.catch(() => {});
      pending.push(result);
    }
  };
  fill();
  while (pending.length) {
    const value = await pending.shift()!;
    fill();
    yield value;
  }
}
