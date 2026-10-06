import { strict as assert } from 'node:assert';
import { batches, boundedWork } from '../../src/engine/apply-work';
import { ContentError } from '../../src/engine/errors';

describe('bounded work and request draining', () => {
  it('limits pulled work and serializes writes in the same ordered group', async () => {
    let pulled = 0;
    let active = 0;
    let maximum = 0;
    const groups = new Set<string>();
    function* work() {
      for (let id = 0; id < 17; id++) {
        pulled++;
        yield { id, group: String(id % 3) };
      }
    }
    await boundedWork(
      work(),
      3,
      async ({ group }) => {
        assert(!groups.has(group));
        groups.add(group);
        active++;
        maximum = Math.max(maximum, active);
        assert(pulled <= 17);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        groups.delete(group);
      },
      (entry) => entry.group,
    );
    assert.equal(maximum, 3);
    assert.equal(active, 0);
    assert.equal(pulled, 17);
  });

  it('drains all submitted writes after a failure before cleanup can run', async () => {
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
        order.push('slow committed');
      } else {
        order.push('failed');
        throw new Error('uncertain remote outcome');
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pulled, 3);
    assert.deepEqual(order, ['failed']);
    release.resolve!();
    await assert.rejects(execution, /uncertain remote outcome/);
    order.push('cleanup');
    assert.deepEqual(order, ['failed', 'slow committed', 'cleanup']);
  });

  it('stops queued work on interruption and waits for every submitted write', async () => {
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
      undefined,
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

  it('allows concurrent readers and serializes conflicting read/write locks', async () => {
    let readers = 0;
    let maximumReaders = 0;
    let writing = false;
    const order: string[] = [];
    const entries = [
      { id: 'a', writes: ['a'], reads: ['shared'] },
      { id: 'b', writes: ['b'], reads: ['shared'] },
      { id: 'writer', writes: ['shared'], reads: [] },
      { id: 'c', writes: ['c'], reads: ['shared'] },
    ];
    await boundedWork(
      entries,
      3,
      async (entry) => {
        if (entry.id === 'writer') {
          assert.equal(readers, 0);
          writing = true;
        } else {
          assert.equal(writing, false);
          readers++;
          maximumReaders = Math.max(maximumReaders, readers);
        }
        order.push(`start:${entry.id}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        order.push(`finish:${entry.id}`);
        if (entry.id === 'writer') writing = false;
        else readers--;
      },
      (entry) => entry,
    );
    assert.equal(maximumReaders, 2);
    assert(order.indexOf('start:writer') > order.indexOf('finish:a'));
    assert(order.indexOf('start:writer') > order.indexOf('finish:b'));
    assert(order.indexOf('start:c') > order.indexOf('finish:writer'));
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
