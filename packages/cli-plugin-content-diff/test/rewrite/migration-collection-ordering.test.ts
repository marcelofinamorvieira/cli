import assert from 'node:assert/strict';
import { CmaClient } from '@datocms/cli-utils';
import { writeCollection } from '../../src/engine/apply';
import { collectionHash } from '../../src/engine/codec';
import { SnapshotStore } from '../../src/engine/store';
import type { Client, CollectionState } from '../../src/engine/types';

function folder(
  id: string,
  position: number,
  parentId: string | null = null,
  label = id,
): CollectionState {
  const state = { id, label, position, parentId, hash: '' };
  state.hash = collectionHash(state);
  return state;
}

function fixture(store: SnapshotStore, originals: CollectionState[]) {
  const remote = new Map(originals.map((state) => [state.id, { ...state }]));
  for (const state of originals) store.putCollection('live', state);
  store.database.exec(
    'CREATE TABLE apply_collection_ordering(id TEXT PRIMARY KEY,position INTEGER NOT NULL) WITHOUT ROWID',
  );
  const events: string[] = [];
  const hooks: {
    beforeCreate?: () => void;
    afterCreate?: () => void;
    beforeList?: () => void;
    afterUpdate?: () => void;
  } = {};
  const resource = (id: string) => {
    const state = remote.get(id);
    if (!state)
      throw new CmaClient.ApiError({
        request: {
          method: 'GET',
          url: '/upload-collections/id',
          headers: {},
          body: undefined,
        },
        response: {
          status: 404,
          statusText: 'Not found',
          headers: {},
          body: { data: [] },
        },
      });
    return {
      id,
      type: 'upload_collection',
      label: state.label,
      position: state.position,
      parent: state.parentId
        ? { id: state.parentId, type: 'upload_collection' }
        : null,
      children: [],
    };
  };
  const client = {
    uploadCollections: {
      async find(id: string) {
        return resource(id);
      },
      async list(query: { filter: { ids: string } }) {
        hooks.beforeList?.();
        const ids = query.filter.ids.split(',');
        assert.ok(ids.length <= 30);
        return ids.map(resource);
      },
      async create(body: {
        id: string;
        label: string;
        parent: { id: string } | null;
        position?: number;
      }) {
        events.push(`create:${body.id}`);
        hooks.beforeCreate?.();
        assert.equal(
          body.position,
          undefined,
          'the executor should explicitly rely on native append',
        );
        const parentId = body.parent?.id ?? null;
        const siblings = [...remote.values()].filter(
          (state) => state.parentId === parentId,
        );
        // Native ignores supplied position and appends, even when an eventual
        // desired position is negative, sparse or already occupied.
        const position =
          (siblings.length
            ? Math.max(...siblings.map((state) => state.position))
            : 0) + 1;
        remote.set(body.id, folder(body.id, position, parentId, body.label));
        const response = resource(body.id);
        hooks.afterCreate?.();
        return response;
      },
      async update(
        id: string,
        body: {
          label: string;
          position: number;
          parent: { id: string } | null;
        },
      ) {
        events.push(`update:${id}`);
        const old = remote.get(id)!;
        const parentId = body.parent?.id ?? null;
        for (const sibling of remote.values()) {
          if (sibling.id === id) continue;
          if (old.parentId === parentId) {
            if (
              sibling.parentId === parentId &&
              sibling.position >= Math.min(old.position, body.position) &&
              sibling.position <= Math.max(old.position, body.position)
            )
              sibling.position += body.position < old.position ? 1 : -1;
          } else {
            if (
              sibling.parentId === old.parentId &&
              sibling.position >= old.position
            )
              sibling.position--;
            if (
              sibling.parentId === parentId &&
              sibling.position >= body.position
            )
              sibling.position++;
          }
          sibling.hash = collectionHash(sibling);
        }
        remote.set(id, folder(id, body.position, parentId, body.label));
        const response = resource(id);
        hooks.afterUpdate?.();
        return response;
      },
    },
  } as unknown as Client;
  const context = { client, store, mutations: 0 } as Parameters<
    typeof writeCollection
  >[0];
  return { context, remote, events, hooks };
}

describe('native append-first collection creation', () => {
  let store: SnapshotStore;
  beforeEach(() => {
    store = new SnapshotStore();
  });
  afterEach(() => {
    store.dispose();
  });

  it('creates at native append then safely moves before existing folders', async () => {
    const mock = fixture(store, [folder('a', 1), folder('b', 2)]);
    await writeCollection(mock.context, folder('new', 1));
    assert.deepEqual(mock.events, ['create:new', 'update:new']);
    assert.deepEqual(
      ['new', 'a', 'b'].map((id) => mock.remote.get(id)!.position),
      [1, 2, 3],
    );
    assert.equal(mock.context.mutations, 2);
    for (const [id, remote] of mock.remote)
      assert.equal(store.getCollection('live', id)!.hash, remote.hash);
  });

  it('accepts the exact append state without an unnecessary update', async () => {
    const mock = fixture(store, [folder('a', 4)]);
    await writeCollection(mock.context, folder('new', 5));
    assert.deepEqual(mock.events, ['create:new']);
    assert.equal(store.getCollection('live', 'new')!.position, 5);
  });

  for (const desiredPosition of [-10, 12]) {
    it(`preserves a desired sparse or negative position ${desiredPosition}`, async () => {
      const mock = fixture(store, [
        folder('a', -8),
        folder('b', -3),
        folder('c', 4),
      ]);
      const desired = folder('new', desiredPosition);
      await writeCollection(mock.context, desired);
      assert.equal(store.getCollection('live', 'new')!.hash, desired.hash);
      assert.deepEqual(
        ['a', 'b', 'c'].map((id) => mock.remote.get(id)!.position),
        desiredPosition === -10 ? [-7, -2, 5] : [-8, -3, 4],
      );
    });
  }

  it('guards an empty nested sibling group independently of root positions', async () => {
    const mock = fixture(store, [folder('parent', 8), folder('root', 100)]);
    await writeCollection(mock.context, folder('child', -2, 'parent'));
    assert.equal(mock.remote.get('child')!.position, -2);
    assert.equal(mock.remote.get('root')!.position, 100);
    assert.deepEqual(mock.events, ['create:child', 'update:child']);
  });

  it('refuses an unexpected append result caused by a concurrent new sibling', async () => {
    const mock = fixture(store, [folder('a', 1)]);
    mock.hooks.beforeCreate = () => {
      mock.remote.set('concurrent', folder('concurrent', 2));
    };
    await assert.rejects(
      writeCollection(mock.context, folder('new', -1)),
      /expected append state/,
    );
    assert.deepEqual(mock.events, ['create:new']);
    assert.equal(store.getCollection('live', 'new'), undefined);
  });

  it('refuses drift after the create response before trusting the new baseline', async () => {
    const mock = fixture(store, [folder('a', 1)]);
    mock.hooks.afterCreate = () => {
      mock.remote.get('new')!.label = 'Concurrent edit';
    };
    await assert.rejects(
      writeCollection(mock.context, folder('new', -1)),
      /changed after creation/,
    );
    assert.deepEqual(mock.events, ['create:new']);
    assert.equal(store.getCollection('live', 'new'), undefined);
  });

  it('refuses a new-folder edit between sibling verification and its position update', async () => {
    const mock = fixture(store, [folder('a', 1)]);
    mock.hooks.beforeList = () => {
      mock.remote.get('new')!.label = 'Concurrent edit';
    };
    await assert.rejects(
      writeCollection(mock.context, folder('new', -1)),
      /changed before write/,
    );
    assert.deepEqual(mock.events, ['create:new']);
  });

  it('refuses sibling drift before the position update', async () => {
    const mock = fixture(store, [folder('a', 1)]);
    mock.hooks.beforeList = () => {
      mock.remote.get('a')!.label = 'Concurrent edit';
    };
    await assert.rejects(
      writeCollection(mock.context, folder('new', -1)),
      /affected sibling changed before/,
    );
    assert.deepEqual(mock.events, ['create:new']);
  });

  it('refuses sibling drift after the position update', async () => {
    const mock = fixture(store, [folder('a', 1)]);
    mock.hooks.afterUpdate = () => {
      mock.remote.get('a')!.label = 'Concurrent edit';
    };
    await assert.rejects(
      writeCollection(mock.context, folder('new', -1)),
      /affected sibling changed during/,
    );
    assert.deepEqual(mock.events, ['create:new', 'update:new']);
  });

  it('retains inclusive native shifts for label-only updates at duplicate positions', async () => {
    const mock = fixture(store, [
      folder('a', 1),
      folder('b', 1),
      folder('c', 7),
    ]);
    await writeCollection(mock.context, folder('a', 1, null, 'Renamed'));
    assert.deepEqual(
      ['a', 'b', 'c'].map((id) => mock.remote.get(id)!.position),
      [1, 0, 7],
    );
    assert.equal(store.getCollection('live', 'b')!.position, 0);
  });

  it('refuses overflowing the append position before any create', async () => {
    const mock = fixture(store, [folder('a', Number.MAX_SAFE_INTEGER)]);
    await assert.rejects(
      writeCollection(mock.context, folder('new', 1)),
      /cannot be appended/,
    );
    assert.deepEqual(mock.events, []);
  });
});
