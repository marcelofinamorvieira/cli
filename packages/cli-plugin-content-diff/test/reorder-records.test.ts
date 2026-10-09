import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { ContentError } from '../src/engine/errors';
import { type ContentMigrationClient, reorderRecords } from '../src/migration';

interface Row {
  id: string;
  model: string;
  parent: string | null;
  position: number;
}

/**
 * Records of sortable/tree models with the CMA's insert-and-shift semantics:
 * a record leaving its position closes the gap, and one inserted at a
 * position pushes the siblings at or after it down by one.
 */
function mockClient(rows: Row[], options: { ignoreMoves?: boolean } = {}) {
  const writes: Array<{ id: string; position: number }> = [];
  let listings = 0;
  const client = {
    items: {
      async *listPagedIterator(
        query: { filter: { type: string }; version: string },
        paging: { perPage: number },
      ) {
        assert.equal(query.version, 'current');
        assert.equal(paging.perPage, 500);
        listings++;
        for (const row of [...rows].reverse())
          if (row.model === query.filter.type)
            yield {
              id: row.id,
              type: 'item',
              position: row.position,
              ...(row.parent === null ? {} : { parent_id: row.parent }),
            };
      },
      async update(id: string, body: { position: number }) {
        assert.deepEqual(Object.keys(body), ['position']);
        writes.push({ id, position: body.position });
        if (options.ignoreMoves) return { id };
        const row = rows.find((candidate) => candidate.id === id)!;
        const siblings = rows.filter(
          (other) =>
            other !== row &&
            other.model === row.model &&
            other.parent === row.parent,
        );
        for (const other of siblings)
          if (other.position > row.position) other.position--;
        for (const other of siblings)
          if (other.position >= body.position) other.position++;
        row.position = body.position;
        return { id };
      },
    },
  };
  const order = (parent: string | null = null) =>
    rows
      .filter((row) => row.model === 'model' && row.parent === parent)
      .sort((a, b) => a.position - b.position)
      .map((row) => row.id);
  return {
    client: client as unknown as ContentMigrationClient,
    writes,
    order,
    get listings() {
      return listings;
    },
  };
}

const group = (ids: string[], parent: string | null = null, start = 1) =>
  ids.map((id, index) => ({
    id,
    model: 'model',
    parent,
    position: start + index,
  }));

function permutations(values: string[]): string[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(
      (rest) => [value, ...rest],
    ),
  );
}

describe('reorderRecords', () => {
  it('moves only the records outside the longest run already in order', async () => {
    const mock = mockClient(group(['a', 'b', 'c', 'd']));
    await reorderRecords(mock.client, {
      model: 'model',
      parent: null,
      order: ['b', 'c', 'd', 'a'],
    });
    assert.deepEqual(mock.order(), ['b', 'c', 'd', 'a']);
    assert.deepEqual(mock.writes, [{ id: 'a', position: 4 }]);
    assert.equal(mock.listings, 2);
  });

  it('reaches every order of a group in one pass with the fewest moves', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const order of permutations(ids)) {
      const mock = mockClient(group(ids, null, 0));
      await reorderRecords(mock.client, {
        model: 'model',
        parent: null,
        order,
      });
      assert.deepEqual(mock.order(), order);
      const sorted = order.join() === ids.join();
      assert.equal(mock.listings, sorted ? 1 : 2, order.join());
      // Records already in relative order (the longest such run) stay put.
      const run: number[] = [];
      order.forEach((id, end) => {
        run[end] = 1;
        for (let start = 0; start < end; start++)
          if (order[start] < id) run[end] = Math.max(run[end], run[start] + 1);
      });
      assert.equal(
        mock.writes.length,
        ids.length - Math.max(...run),
        order.join(),
      );
    }
  });

  it('issues no writes for a group already in order', async () => {
    const mock = mockClient(group(['a', 'b', 'c']));
    await reorderRecords(mock.client, {
      model: 'model',
      parent: null,
      order: ['a', 'b', 'c'],
    });
    assert.deepEqual(mock.writes, []);
    assert.equal(mock.listings, 1);
  });

  it('orders one tree sibling group and leaves the others alone', async () => {
    const rows = [
      ...group(['root-a', 'root-b']),
      ...group(['x', 'y', 'z'], 'root-a'),
      ...group(['p', 'q'], 'root-b'),
    ];
    const mock = mockClient(rows);
    await reorderRecords(mock.client, {
      model: 'model',
      parent: 'root-a',
      order: ['z', 'x', 'y'],
    });
    assert.deepEqual(mock.order('root-a'), ['z', 'x', 'y']);
    assert.deepEqual(mock.order(), ['root-a', 'root-b']);
    assert.deepEqual(mock.order('root-b'), ['p', 'q']);
    assert.deepEqual(
      mock.writes.map((write) => write.id),
      ['z'],
    );
  });

  it('reads the result back and repeats when positions have gaps', async () => {
    const rows = group(['a', 'b', 'c', 'd']).map((row, index) => ({
      ...row,
      position: index * 5,
    }));
    const mock = mockClient(rows);
    await reorderRecords(mock.client, {
      model: 'model',
      parent: null,
      order: ['d', 'c', 'b', 'a'],
    });
    assert.deepEqual(mock.order(), ['d', 'c', 'b', 'a']);
    assert(mock.listings >= 2 && mock.listings <= 4);
  });

  it('refuses a group whose members differ from the order list', async () => {
    const mock = mockClient(group(['a', 'b', 'extra'], 'tree-parent'));
    await assert.rejects(
      reorderRecords(mock.client, {
        model: 'model',
        parent: 'tree-parent',
        order: ['b', 'missing'],
      }),
      (error: unknown) => {
        assert(error instanceof ContentError);
        assert.equal(error.code, 'ORDERING_MEMBERS_DIFFER');
        assert.match(
          error.message,
          /children of record tree-parent of model model differ from the order list \(not listed: .*listed but not present: missing\)\. Update the order list/,
        );
        return true;
      },
    );
    const mismatch = mockClient(group(['a', 'b', 'extra']));
    await assert.rejects(
      reorderRecords(mismatch.client, {
        model: 'model',
        parent: null,
        order: ['b', 'a', 'a'],
      }),
      (error: unknown) => {
        assert(error instanceof ContentError);
        assert.equal(error.code, 'ORDERING_MEMBERS_DIFFER');
        assert.deepEqual(error.details?.unexpected, ['extra']);
        assert.deepEqual(error.details?.missing, []);
        assert.deepEqual(error.details?.repeated, ['a']);
        return true;
      },
    );
    assert.deepEqual(mismatch.writes, []);
  });

  it('fails with ORDERING_NOT_APPLIED when the order never converges', async () => {
    const mock = mockClient(group(['a', 'b', 'c']), { ignoreMoves: true });
    await assert.rejects(
      reorderRecords(mock.client, {
        model: 'model',
        parent: null,
        order: ['c', 'b', 'a'],
      }),
      (error: unknown) => {
        assert(error instanceof ContentError);
        assert.equal(error.code, 'ORDERING_NOT_APPLIED');
        assert.deepEqual(error.details?.actual, ['a', 'b', 'c']);
        return true;
      },
    );
    assert.equal(mock.listings, 4);
    assert.equal(mock.writes.length, 6);
  });
});
