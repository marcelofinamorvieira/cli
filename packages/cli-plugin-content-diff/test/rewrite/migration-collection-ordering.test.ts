import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectionHash } from '../../src/engine/codec';
import { writeMigration } from '../../src/engine/migration-artifact';
import { createPlan } from '../../src/engine/planner';
import { schemaHash } from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type { CollectionState, SchemaState } from '../../src/engine/types';
import {
  directClientFixture,
  executeGeneratedScript,
} from './direct-client-fixture';
import { fixtureId } from './fixture-id';

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
async function fixture(before: CollectionState[], after: CollectionState[]) {
  const directory = await mkdtemp(join(tmpdir(), 'content-direct-folders-'));
  const store = new SnapshotStore(directory);
  const schema: SchemaState = {
    siteId: 'site',
    environmentId: 'target',
    locales: ['en'],
    semantics: {},
    models: [],
    workflows: [],
    hash: '',
  };
  schema.hash = schemaHash(schema);
  for (const state of before) store.putCollection('target', state);
  for (const state of after) store.putCollection('source', state);
  try {
    const metadata = await createPlan(
      store,
      { ...schema, environmentId: 'source' },
      schema,
      {
        modelIds: [],
        uploads: 'all',
        includeDeletions: true,
        allowPartial: false,
        allowTemporarySchemaChanges: false,
      },
    );
    const output = join(directory, '123_folders.ts');
    await writeMigration({
      store,
      metadata,
      outputPath: output,
      sourceTracking: { apiKey: 'schema_migration', model: null },
      destinationTracking: { apiKey: 'schema_migration', model: null },
      chunkBytes: 300,
    });
    const remote = directClientFixture(store, schema);
    await executeGeneratedScript(output, remote.client, remote.uploadFile);
    assert.deepEqual(
      [...remote.folders.values()].sort((a, b) => a.id.localeCompare(b.id)),
      after.slice().sort((a, b) => a.id.localeCompare(b.id)),
    );
    return { events: remote.events, script: await readFile(output, 'utf8') };
  } finally {
    store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
describe('direct generated collection ordering', () => {
  it('creates at native append and moves before existing folders', async () => {
    const result = await fixture(
      [folder('a', 1), folder('b', 2)],
      [folder('new', 1), folder('a', 2), folder('b', 3)],
    );
    const id = fixtureId('new');
    assert(
      result.events.indexOf(`create-folder:${id}`) <
        result.events.indexOf(`update-folder:${id}`),
    );
  });
  it('keeps the native append result without a needless new-folder update', async () => {
    const result = await fixture(
      [folder('a', 4)],
      [folder('a', 4), folder('new', 5)],
    );
    assert(!result.events.includes(`update-folder:${fixtureId('new')}`));
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
    assert(
      result.events.indexOf(`destroy-folder:${fixtureId('grandchild')}`) <
        result.events.indexOf(`destroy-folder:${fixtureId('child')}`),
    );
    assert(
      result.events.indexOf(`destroy-folder:${fixtureId('child')}`) <
        result.events.indexOf(`destroy-folder:${fixtureId('parent')}`),
    );
  });
  it('moves children away before deleting their former parent', async () => {
    await fixture(
      [folder('old', 1), folder('new', 2), folder('child', 1, 'old')],
      [folder('new', 2), folder('child', 1, 'new')],
    );
  });
});
