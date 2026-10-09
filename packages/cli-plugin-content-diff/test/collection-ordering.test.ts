import assert from 'node:assert/strict';
import { collectionHash } from '../src/engine/codec';
import { schemaHash } from '../src/engine/schema';
import type { CollectionState, SchemaState } from '../src/engine/types';
import { fixtureId } from './fixture-id';
import { content, replay } from './pipeline';

function folder(
  name: string,
  position: number,
  parent: string | null = null,
  label = name,
): CollectionState {
  const state = {
    id: fixtureId(name),
    label,
    parentId: parent ? fixtureId(parent) : null,
    position,
    hash: '',
  };
  state.hash = collectionHash(state);
  return state;
}

const schema: SchemaState = {
  siteId: 'site',
  environmentId: 'source',
  locales: ['en'],
  semantics: {},
  models: [],
  workflows: [],
  hash: '',
};
schema.hash = schemaHash(schema);

const byId = (folders: Iterable<CollectionState>) =>
  [...folders].sort((a, b) => a.id.localeCompare(b.id));

/** Replays `after` over `before` and checks every folder ends up as in `after`. */
async function fixture(before: CollectionState[], after: CollectionState[]) {
  const result = await replay({
    source: content({ collections: after }),
    target: content({ collections: before }),
    sourceSchema: schema,
    options: {
      modelIds: [],
      uploads: 'all',
      includeDeletions: true,
      allowPartial: false,
    },
  });
  assert.deepEqual(byId(result.fixture.folders.values()), byId(after));
  return { events: result.fixture.events, operations: result.operations };
}

describe('folder operations', () => {
  it('creates folders without a position and sets every position in one reorder', async () => {
    const result = await fixture(
      [folder('a', 1), folder('b', 2)],
      [folder('new', 1), folder('a', 2), folder('b', 3)],
    );
    const id = fixtureId('new');
    assert.deepEqual(result.events, [`create-folder:${id}`, 'reorder-folders']);
    assert.deepEqual(result.operations, [
      {
        op: 'folder.create',
        id,
        label: `Create folder "new" (${id})`,
        data: { label: 'new', parent: null },
      },
      {
        op: 'folders.reorder',
        label: 'Set the position of every folder',
        data: ['new', 'a', 'b'].map((name, index) => ({
          id: fixtureId(name),
          type: 'upload_collection',
          position: index + 1,
          parent: null,
        })),
      },
    ]);
  });

  it('updates only the label and parent that differ', async () => {
    const before = [folder('a', 1), folder('b', 2), folder('child', 1, 'a')];
    const result = await fixture(before, [
      folder('a', 1, null, 'Renamed'),
      folder('b', 2),
      folder('child', 1, 'b'),
    ]);
    assert.deepEqual(
      result.operations.map((operation) => operation.op),
      ['folder.update', 'folder.update', 'folders.reorder'],
    );
    const update = (name: string) =>
      result.operations.find((operation) => operation.id === fixtureId(name));
    assert.deepEqual(update('a'), {
      op: 'folder.update',
      id: fixtureId('a'),
      label: `Update folder "Renamed" (${fixtureId('a')})`,
      expect: { hash: before[0].hash },
      data: { label: 'Renamed' },
    });
    assert.deepEqual(update('child'), {
      op: 'folder.update',
      id: fixtureId('child'),
      label: `Update folder "child" (${fixtureId('child')})`,
      expect: { hash: before[2].hash },
      data: { parent: { id: fixtureId('b'), type: 'upload_collection' } },
    });
    assert.equal(result.events.at(-1), 'reorder-folders');
  });

  it('emits nothing for unchanged folders', async () => {
    const result = await fixture(
      [folder('a', 1), folder('b', 2)],
      [folder('a', 1), folder('b', 2)],
    );
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.operations, []);
  });

  for (const desired of [-10, 12])
    it(`preserves sparse and negative positions with insertion at ${desired}`, async () => {
      await fixture(
        [folder('a', -8), folder('b', -3), folder('c', 4)],
        desired === -10
          ? [
              folder('new', -10),
              folder('a', -7),
              folder('b', -2),
              folder('c', 5),
            ]
          : [
              folder('new', 12),
              folder('a', -8),
              folder('b', -3),
              folder('c', 4),
            ],
      );
    });

  it('creates a parent before its new child independent of ID order', async () => {
    const result = await fixture(
      [],
      [folder('parent', 3), folder('child', -2, 'parent')],
    );
    assert(
      result.events.indexOf(`create-folder:${fixtureId('parent')}`) <
        result.events.indexOf(`create-folder:${fixtureId('child')}`),
    );
  });

  it('detaches a parent before reversing its parent-child relationship', async () => {
    await fixture(
      [folder('parent', 1), folder('child', 1, 'parent')],
      [folder('child', 1), folder('parent', 1, 'child')],
    );
  });

  it('deletes descendant folders before their ancestors', async () => {
    const result = await fixture(
      [
        folder('parent', 1),
        folder('child', 1, 'parent'),
        folder('grandchild', 1, 'child'),
      ],
      [],
    );
    assert.deepEqual(result.events, [
      `destroy-folder:${fixtureId('grandchild')}`,
      `destroy-folder:${fixtureId('child')}`,
      `destroy-folder:${fixtureId('parent')}`,
    ]);
  });

  it('moves children away before deleting their former parent', async () => {
    await fixture(
      [folder('old', 1), folder('new', 2), folder('child', 1, 'old')],
      [folder('new', 2), folder('child', 1, 'new')],
    );
  });
});
