import { strict as assert } from 'node:assert';
import { batches, boundedWork } from '../src/engine/bounded-work';
import { ContentError } from '../src/engine/errors';

describe('bounded work', () => {
  it('pulls work only as capacity becomes available', async () => {
    let pulled = 0;
    let finished = 0;
    let active = 0;
    let maximum = 0;
    function* work() {
      for (let id = 0; id < 17; id++) {
        pulled++;
        yield id;
      }
    }
    await boundedWork(work(), 3, async () => {
      active++;
      maximum = Math.max(maximum, active);
      // Beyond the running entries, at most one waits for a free slot.
      assert(pulled - finished <= 4);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      finished++;
    });
    assert.equal(maximum, 3);
    assert.equal(active, 0);
    assert.equal(pulled, 17);
  });

  it('waits for every started request after a failure before returning', async () => {
    const order: string[] = [];
    const release: { resolve?: () => void } = {};
    let pulled = 0;
    function* entries() {
      for (let id = 0; id < 20; id++) {
        pulled++;
        yield id;
      }
    }
    const execution = boundedWork(entries(), 2, async (id) => {
      if (id === 0) {
        await new Promise<void>((resolve) => {
          release.resolve = resolve;
        });
        order.push('slow finished');
      } else {
        order.push('failed');
        throw new Error('read failed');
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pulled, 3);
    assert.deepEqual(order, ['failed']);
    release.resolve!();
    await assert.rejects(execution, /read failed/);
    order.push('returned');
    assert.deepEqual(order, ['failed', 'slow finished', 'returned']);
  });

  it('stops queued work on interruption and waits for every started request', async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const execution = boundedWork(
      [0, 1, 2, 3],
      2,
      async (id) => {
        order.push(`start:${id}`);
        await new Promise<void>((resolve) => releases.push(resolve));
        order.push(`finish:${id}`);
      },
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['start:0', 'start:1']);
    controller.abort();
    releases[0]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['start:0', 'start:1', 'finish:0']);
    releases[1]();
    await assert.rejects(
      execution,
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.deepEqual(order, ['start:0', 'start:1', 'finish:0', 'finish:1']);
  });

  it('never places more than 30 IDs in a full nested read batch', () => {
    const result = [...batches(Array.from({ length: 67 }, (_, id) => id))];
    assert.deepEqual(
      result.map((batch) => batch.length),
      [30, 30, 7],
    );
    assert.deepEqual(
      result.flat(),
      Array.from({ length: 67 }, (_, id) => id),
    );
  });
});
