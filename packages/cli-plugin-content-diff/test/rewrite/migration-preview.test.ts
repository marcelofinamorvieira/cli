import assert from 'node:assert/strict';
import { it } from 'mocha';
import { buildPlanPreview } from '../../src/engine/migration-preview';
import { SnapshotStore } from '../../src/engine/store';
import type { PlanCounts, PlanMetadata } from '../../src/engine/types';

it('summarizes changes by model and resource without materializing record payloads', () => {
  const store = new SnapshotStore();
  try {
    const insert = store.database.prepare('INSERT INTO plan VALUES(?,?,?,?,?)');
    // Invalid payload JSON proves this preview reads only indexed group metadata.
    store.transaction(() => {
      for (let i = 0; i < 10000; i++)
        insert.run('record', String(i), 'articles', 'update', 'unused');
      insert.run('record', 'new', 'pages', 'create', 'unused');
      insert.run('record', 'retained', 'untouched', 'noop', 'unused');
      insert.run('upload', 'asset', '', 'delete', 'unused');
      insert.run('collection', 'folder', '', 'skip', 'unused');
    });
    const empty = { create: 0, update: 0, delete: 0, noop: 0, skip: 0 };
    const counts: PlanCounts = {
      record: { ...empty, create: 1, update: 10000, noop: 1 },
      upload: { ...empty, delete: 1 },
      collection: { ...empty, skip: 1 },
    };
    const metadata = {
      counts,
      temporarySchemaChanges: [{ fieldId: 'field' }],
      schema: {
        models: [
          { id: 'articles', apiKey: 'article', name: 'Articles' },
          { id: 'pages', apiKey: 'page', name: 'Pages' },
          { id: 'untouched', apiKey: 'untouched', name: 'Untouched' },
        ],
      },
    } as unknown as PlanMetadata;
    const result = buildPlanPreview(store, metadata, 'main');
    assert.equal(result.dryRun, true);
    assert.equal(result.mutations, 0);
    assert.equal(result.environmentId, 'main');
    assert.equal(result.partial, true);
    assert.equal(result.temporarySchemaChanges, 1);
    assert.deepEqual(result.counts, counts);
    assert.equal(result.groups.length, 4);
    assert.equal(
      result.groups.find((g) => g.model?.apiKey === 'article')?.counts.update,
      10000,
    );
    assert.equal(
      result.groups.some((g) => g.model?.apiKey === 'untouched'),
      false,
    );
    assert.equal(
      store.database.prepare('SELECT COUNT(*) AS total FROM plan').get()?.total,
      10004,
    );
  } finally {
    store.dispose();
  }
});
