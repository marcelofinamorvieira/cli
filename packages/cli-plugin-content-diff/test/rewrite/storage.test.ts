import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { ContentError } from '../../src/engine/errors';
import { SnapshotStore, loadSqlite } from '../../src/engine/store';
import { record, recordPlan } from './artifact-fixture';
describe('temporary indexed snapshot store', () => {
  let directory: string;
  const stores: SnapshotStore[] = [];
  const store = () => {
    const result = new SnapshotStore(directory);
    stores.push(result);
    return result;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-bundle-test-'));
  });
  afterEach(async () => {
    for (const value of stores.splice(0)) value.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('isolates sides, uses indexed order, rolls back transactions, and removes only owned files', async () => {
    const value = store();
    value.putRecord('source', record('z', 'a'));
    value.putRecord('source', record('b', 'b'));
    value.putRecord('source', record('a', 'a'));
    value.putRecord('target', { ...record('a', 'a'), hash: 'target' });
    assert.deepEqual(
      [...value.records('source')].map((item) => [item.modelId, item.id]),
      [
        ['a', 'a'],
        ['a', 'z'],
        ['b', 'b'],
      ],
    );
    assert.equal(value.getRecord('target', 'a')?.hash, 'target');
    assert.throws(() =>
      value.transaction(() => {
        value.putRecord('source', record('rollback'));
        throw new Error('failed');
      }),
    );
    assert.equal(value.getRecord('source', 'rollback'), undefined);
    value.putReference('source', {
      ownerId: 'a',
      targetId: 'z',
      kind: 'current',
      path: 'link',
      fieldId: 'link',
      required: true,
    });
    value.putBlockOwner('source', {
      blockId: 'block',
      recordId: 'a',
      modelId: 'block-model',
      path: 'blocks[0]',
      slice: 'current',
    });
    value.putUniqueValue('source', {
      modelId: 'a',
      fieldId: 'title',
      locale: 'en',
      slice: 'current',
      valueKey: '"a"',
      recordId: 'a',
    });
    assert.equal([...value.references('source', 'a')][0].required, true);
    assert.equal([...value.blockOwners('source', 'a')][0].blockId, 'block');
    assert.equal([...value.uniqueValues('source', 'a')][0].valueKey, '"a"');
    const explanation = value.database
      .prepare(
        'EXPLAIN QUERY PLAN SELECT owner_id FROM refs WHERE side = ? AND target_id = ?',
      )
      .all('source', 'z');
    assert.match(String(explanation[0].detail), /refs_target/);
    value.putPlan(recordPlan('a'));
    value.clearSide('source');
    assert.equal([...value.records('source')].length, 0);
    assert.ok(value.getRecord('target', 'a'));
    assert.ok(value.getPlan('record', 'a'));
    const ownedDirectory = value.directory;
    value.close();
    value.dispose();
    value.dispose();
    assert.equal(existsSync(ownedDirectory), false);
    assert.equal((await lstat(directory)).isDirectory(), true);
  });

  it('keeps the original transaction error when SQLite has already rolled back', () => {
    const value = store();
    assert.throws(
      () =>
        value.transaction(() => {
          value.putRecord('source', record('rolled-back'));
          value.database.exec('ROLLBACK');
          throw new Error('original failure');
        }),
      /original failure/,
    );
    const pages = value.database.prepare('PRAGMA page_count').get()!
      .page_count as number;
    // A full disk makes SQLite roll back the transaction before the helper.
    value.database.exec(`PRAGMA max_page_count = ${pages}`);
    assert.throws(
      () =>
        value.transaction(() => {
          for (let index = 0; index < 8; index++)
            value.putRecord('source', {
              ...record(`full-${index}`),
              current: { title: 'x'.repeat(8192) },
            });
        }),
      /database or disk is full/,
    );
    assert.equal([...value.records('source')].length, 0);
    value.database.exec(`PRAGMA max_page_count = ${pages * 1000}`);
    value.transaction(() => value.putRecord('source', record('after')));
    assert.ok(value.getRecord('source', 'after'));
  });

  it('loads node:sqlite on first use and names the supported Node.js versions when it is unavailable', () => {
    assert.equal(typeof loadSqlite().DatabaseSync, 'function');
    assert.throws(
      () =>
        loadSqlite(() => {
          throw Object.assign(
            new Error('No such built-in module: node:sqlite'),
            { code: 'ERR_UNKNOWN_BUILTIN_MODULE' },
          );
        }),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'UNSUPPORTED_NODE_VERSION' &&
        error.message.includes('Node.js 22.13+') &&
        error.message.includes('Node.js 24+') &&
        error.message.includes(process.version),
    );
    const unrelated = new Error('loader failed');
    assert.throws(
      () =>
        loadSqlite(() => {
          throw unrelated;
        }),
      (error: unknown) => error === unrelated,
    );
    // Simulate a runtime without node:sqlite. Command modules must still load,
    // so the store reports the requirement instead of a module-load failure.
    const root = resolve(__dirname, '../..');
    const script = `
      const assert = require('node:assert/strict');
      const { readdirSync } = require('node:fs');
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function (request, ...rest) {
        if (request === 'node:sqlite')
          throw Object.assign(new Error('No such built-in module: node:sqlite'), {
            code: 'ERR_UNKNOWN_BUILTIN_MODULE',
          });
        return Reflect.apply(load, this, [request, ...rest]);
      };
      require(process.env.CONTENT_ROOT + '/src/commands/content/diff.ts');
      require(process.env.CONTENT_ROOT + '/src/commands/content/apply.ts');
      const { SnapshotStore } = require(process.env.CONTENT_ROOT + '/src/engine/store.ts');
      assert.throws(
        () => new SnapshotStore(process.env.CONTENT_STORE_PARENT),
        (error) => error.code === 'UNSUPPORTED_NODE_VERSION',
      );
      assert.deepEqual(readdirSync(process.env.CONTENT_STORE_PARENT), []);
    `;
    const result = spawnSync(
      process.execPath,
      ['--require', 'ts-node/register', '--eval', script],
      {
        cwd: root,
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(root, 'tsconfig.json'),
          CONTENT_ROOT: root,
          CONTENT_STORE_PARENT: directory,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });

  it('retains direct native iterator owners through forced GC without retaining every prepared query', () => {
    const root = resolve(__dirname, '../..');
    const script = `
      const assert = require('node:assert/strict');
      const { SnapshotStore } = require(process.env.CONTENT_STORE_MODULE);
      (async () => {
        const store = new SnapshotStore(process.env.CONTENT_STORE_PARENT);
        try {
          store.database.exec('CREATE TABLE gc_probe(n INTEGER PRIMARY KEY)');
          const insert = store.database.prepare('INSERT INTO gc_probe VALUES(?)');
          for (let n = 1; n <= 64; n++) insert.run(n);
          const sql = 'SELECT n FROM gc_probe WHERE n >= ? ORDER BY n';
          const first = store.database.prepare(sql).iterate(1);
          const second = store.database.prepare(sql).iterate(32);
          assert.equal(Object.getOwnPropertyDescriptor(first, 'owner').writable, false);
          global.gc();
          assert.equal(first.next().value.n, 1);
          assert.equal(second.next().value.n, 32);
          global.gc();
          assert.equal(first.next().value.n, 2);
          assert.equal(second.next().value.n, 33);
          const remaining = [];
          for (const row of first) { global.gc(); remaining.push(row.n); }
          assert.deepEqual(remaining, Array.from({ length: 62 }, (_, n) => n + 3));
          assert.equal(second.return().done, true);
          assert.equal(second.next().done, true);
          const weak = (() => Array.from({ length: 200 }, (_, n) => {
            const statement = store.database.prepare('SELECT ? AS n');
            statement.get(n);
            return new WeakRef(statement);
          }))();
          for (let n = 0; n < 4; n++) {
            await new Promise(resolve => setImmediate(resolve));
            global.gc();
          }
          assert.equal(weak.filter(reference => reference.deref()).length, 0);
          assert.equal(Reflect.get(store, 'statements').size, 0);
        } finally { store.dispose(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(
      process.execPath,
      ['--expose-gc', '--require', 'ts-node/register', '--eval', script],
      {
        cwd: root,
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(root, 'tsconfig.json'),
          CONTENT_STORE_MODULE: join(root, 'src/engine/store.ts'),
          CONTENT_STORE_PARENT: directory,
        },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });

  it('keeps simultaneous typed iterators independently bound to their sides', () => {
    const value = store();
    value.putRecord('source', record('a'));
    value.putRecord('source', record('b'));
    value.putRecord('target', record('c'));
    value.putRecord('target', record('d'));
    const source = value.records('source');
    const target = value.records('target');
    assert.equal(source.next().value!.id, 'a');
    assert.equal(target.next().value!.id, 'c');
    assert.equal(source.next().value!.id, 'b');
    assert.equal(target.next().value!.id, 'd');
    assert.equal(source.next().done, true);
    assert.equal(target.next().done, true);
  });

  it('bounds record-scoped dependency cleanup and reads to the requested record index', () => {
    const value = store();
    value.transaction(() => {
      for (let index = 0; index < 128; index++) {
        const id = `record-${String(index).padStart(3, '0')}`;
        for (const suffix of ['z', 'a']) {
          value.putBlockOwner('source', {
            blockId: `${suffix}-${id}`,
            recordId: id,
            modelId: 'block',
            path: 'blocks',
            slice: 'current',
          });
          value.putUniqueValue('source', {
            recordId: id,
            modelId: 'model-a',
            fieldId: suffix,
            locale: 'en',
            slice: 'current',
            valueKey: id,
          });
        }
      }
    });
    const prepare = value.database.prepare.bind(value.database);
    const checked = new Set<string>();
    value.database.prepare = (sql) => {
      if (
        (sql.startsWith('DELETE FROM block_owners') ||
          sql.startsWith('SELECT * FROM block_owners') ||
          sql.startsWith('SELECT * FROM unique_values')) &&
        sql.includes('record_id = ?')
      ) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
          'source',
          'record-000',
        );
        // SQLite can prefer a side-only primary-key scan over the existing
        // record index. At project scale that makes per-record work quadratic.
        assert.ok(
          plan.some((row) =>
            String(row.detail).includes('(side=? AND record_id=?)'),
          ),
          JSON.stringify({ sql, plan }),
        );
        checked.add(sql);
      }
      return prepare(sql);
    };
    assert.deepEqual(
      [...value.blockOwners('source', 'record-000')].map(
        (owner) => owner.blockId,
      ),
      ['a-record-000', 'z-record-000'],
    );
    assert.deepEqual(
      [...value.uniqueValues('source', 'record-000')].map(
        (item) => item.fieldId,
      ),
      ['a', 'z'],
    );
    value.putRecord('source', record('record-000'));
    assert.equal([...value.blockOwners('source', 'record-000')].length, 0);
    assert.equal([...value.uniqueValues('source', 'record-000')].length, 0);
    assert.equal([...value.blockOwners('source', 'record-001')].length, 2);
    assert.equal([...value.uniqueValues('source', 'record-001')].length, 2);
    assert.equal(checked.size, 3);
  });
});
