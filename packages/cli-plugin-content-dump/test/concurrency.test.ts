import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CONCURRENCY,
  forEachConcurrently,
  inOrder,
  runInDependencyOrder,
} from '../src/utils/concurrency';

const range = (count: number) => Array.from({ length: count }, (_, i) => i);
const ascending = (values: number[]) => [...values].sort((a, b) => a - b);

/** Counts the tasks running at once, and the most there ever were. */
function gauge() {
  const state = { running: 0, most: 0 };
  return {
    state,
    async run(work: () => Promise<void>) {
      state.running++;
      state.most = Math.max(state.most, state.running);
      try {
        await work();
      } finally {
        state.running--;
      }
    },
  };
}

describe('forEachConcurrently', () => {
  it('never runs more than CONCURRENCY tasks at once', async () => {
    const { state, run } = gauge();
    const done: number[] = [];
    await forEachConcurrently(range(30), (item) =>
      run(async () => {
        await sleep(item % 4);
        done.push(item);
      }),
    );
    assert.equal(state.most, CONCURRENCY);
    assert.deepEqual(ascending(done), range(30));
  });

  it('takes its items from sync and async iterables', async () => {
    async function* slowly() {
      yield 1;
      await sleep(1);
      yield 2;
      yield 3;
    }
    const sources: Array<Iterable<number> | AsyncIterable<number>> = [
      [1, 2, 3],
      new Set([1, 2, 3]),
      new Map([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]).keys(),
      slowly(),
    ];
    for (const source of sources) {
      const seen: number[] = [];
      await forEachConcurrently(source, async (item) => {
        seen.push(item);
      });
      assert.deepEqual(ascending(seen), [1, 2, 3]);
    }
  });

  it('reads an async iterable only as tasks finish', async () => {
    let read = 0;
    let finished = 0;
    let furthestAhead = 0;
    async function* items() {
      for (const item of range(30)) {
        read++;
        furthestAhead = Math.max(furthestAhead, read - finished);
        yield item;
      }
    }
    await forEachConcurrently(items(), async (item) => {
      await sleep(item % 3);
      finished++;
    });
    assert.equal(read, 30);
    assert.equal(furthestAhead, CONCURRENCY);
  });

  it('starts no task after the first failure, waits for the running ones and rethrows that failure', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const first = new Error('first');
    await assert.rejects(
      forEachConcurrently(range(30), async (item) => {
        started.push(item);
        if (item === 2) {
          await sleep(1);
          throw first;
        }
        if (item === 5) {
          await sleep(5);
          throw new Error('second');
        }
        await sleep(15);
        finished.push(item);
      }),
      (error) => error === first,
    );
    assert.deepEqual(ascending(started), range(CONCURRENCY));
    assert.deepEqual(ascending(finished), [0, 1, 3, 4, 6, 7]);
  });

  it('waits for the running tasks when reading the items fails, then rethrows that failure', async () => {
    const finished: number[] = [];
    const broken = new Error('damaged source');
    async function* items() {
      yield* [0, 1, 2];
      throw broken;
    }
    await assert.rejects(
      forEachConcurrently(items(), async (item) => {
        await sleep(5);
        finished.push(item);
      }),
      (error) => error === broken,
    );
    assert.deepEqual(ascending(finished), [0, 1, 2]);
  });
});

describe('runInDependencyOrder', () => {
  it('starts a task only once all its dependencies finished', async () => {
    const dependencies = [[], [0], [0], [1, 2], [], [3, 4]];
    const events: string[] = [];
    await runInDependencyOrder(range(6), dependencies, async (index) => {
      events.push(`start ${index}`);
      await sleep(6 - index);
      events.push(`end ${index}`);
    });
    assert.equal(events.length, 12);
    // Tasks without dependencies run together.
    assert.deepEqual(events.slice(0, 2), ['start 0', 'start 4']);
    for (const [index, needed] of dependencies.entries())
      for (const dependency of needed)
        assert.ok(
          events.indexOf(`end ${dependency}`) <
            events.indexOf(`start ${index}`),
          `Task ${index} started before task ${dependency} finished.`,
        );
  });

  it('never runs more than CONCURRENCY tasks at once', async () => {
    const { state, run } = gauge();
    // Every task but the first waits for it, and is then free to run.
    const dependencies = range(30).map((index) => (index ? [0] : []));
    let done = 0;
    await runInDependencyOrder(range(30), dependencies, () =>
      run(async () => {
        await sleep(1);
        done++;
      }),
    );
    assert.equal(done, 30);
    assert.equal(state.most, CONCURRENCY);
  });

  it('runs only the tasks it is given', async () => {
    const ran: number[] = [];
    await runInDependencyOrder([1, 3], [[], [], [0], [1]], async (index) => {
      ran.push(index);
    });
    assert.deepEqual(ran, [1, 3]);
  });

  it('starts no task after the first failure, waits for the running ones and rethrows that failure', async () => {
    // Task 1 waits for task 0; the others are free, but only CONCURRENCY start.
    const dependencies = range(12).map((index) => (index === 1 ? [0] : []));
    const started: number[] = [];
    const finished: number[] = [];
    const first = new Error('first');
    await assert.rejects(
      runInDependencyOrder(range(12), dependencies, async (index) => {
        started.push(index);
        if (index === 0) {
          await sleep(1);
          throw first;
        }
        if (index === 4) {
          await sleep(5);
          throw new Error('second');
        }
        await sleep(15);
        finished.push(index);
      }),
      (error) => error === first,
    );
    assert.deepEqual(ascending(started), [0, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(ascending(finished), [2, 3, 5, 6, 7, 8]);
  });

  it('throws when the dependencies form a cycle', async () => {
    const ran: number[] = [];
    await assert.rejects(
      runInDependencyOrder([0, 1, 2], [[], [2], [1]], async (index) => {
        ran.push(index);
      }),
      /The dependencies between tasks form a cycle\./,
    );
    assert.deepEqual(ran, [0]);

    await assert.rejects(
      runInDependencyOrder([0], [[0]], async () => {}),
      /form a cycle/,
    );
  });
});

describe('inOrder', () => {
  it('yields the results in index order, reading at most CONCURRENCY ahead of the consumer', async () => {
    let started = 0;
    let furthestAhead = 0;
    const values: number[] = [];
    const reads = inOrder(20, async (index) => {
      started++;
      // Later reads settle first.
      await sleep(20 - index);
      return index * 10;
    });
    for await (const value of reads) {
      values.push(value);
      furthestAhead = Math.max(furthestAhead, started - values.length);
      const before = started;
      await sleep(1);
      assert.equal(
        started,
        before,
        'A read started while the consumer was busy.',
      );
    }
    assert.deepEqual(
      values,
      range(20).map((index) => index * 10),
    );
    assert.equal(furthestAhead, CONCURRENCY);
  });

  it('rethrows a failed read once the consumer reaches it', async () => {
    const values: number[] = [];
    await assert.rejects(
      (async () => {
        for await (const value of inOrder(6, async (index) => {
          if (index === 3) throw new Error('Read 3 failed.');
          return index;
        }))
          values.push(value);
      })(),
      /Read 3 failed\./,
    );
    assert.deepEqual(values, [0, 1, 2]);
  });

  it('does not leave a failed read the consumer never reaches as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const reads = inOrder(10, async (index) => {
        if (index === 3) throw new Error('Never reached.');
        if (index === 5) {
          await sleep(5);
          throw new Error('Never reached either.');
        }
        await sleep(1);
        return index;
      });
      for await (const value of reads) if (value === 1) break;
      await sleep(20);
    } finally {
      process.removeListener('unhandledRejection', listener);
    }
    assert.deepEqual(unhandled, []);
  });
});
