import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { readBundle, writeBundle } from '../../src/engine/bundle';
import { hashJson, recordHash } from '../../src/engine/codec';
import { ContentError } from '../../src/engine/errors';
import { SnapshotStore } from '../../src/engine/store';
import type {
  BundleChunk,
  BundleManifest,
  PlanCounts,
  PlanEntry,
  PlanMetadata,
  RecordPlan,
  RecordState,
  UploadState,
} from '../../src/engine/types';

const digest = (bytes: string | Buffer, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');

function record(id: string, modelId = 'model-a'): RecordState {
  const state: RecordState = {
    id,
    modelId,
    current: { title: id },
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
  };
  state.hash = recordHash(state);
  return state;
}

function recordPlan(
  id: string,
  action: 'noop' | 'update' | 'create' = 'noop',
  modelId = 'model-a',
): RecordPlan {
  const baseline = record(id, modelId);
  const desired =
    action === 'update'
      ? {
          ...baseline,
          current: { title: `${id} changed` },
          hash: '',
        }
      : baseline;
  desired.hash = recordHash(desired);
  return {
    kind: 'record',
    id,
    modelId,
    action,
    guard:
      action === 'create'
        ? null
        : {
            hash: baseline.hash,
            modelId,
            currentVersion: baseline.currentVersion,
            publishedUpdatedAt: baseline.publishedUpdatedAt,
            parentId: null,
            position: null,
            schedules: baseline.schedules,
            validity: baseline.validity,
          },
    baseline: action === 'create' ? null : baseline,
    desired,
    safety: {
      currentReferences: [],
      publishedReferences: [],
      uploadReferences: [],
      blockIds: [],
      desiredParentId: null,
      desiredPosition: null,
    },
    diagnostics: [],
  };
}

function upload(id: string, bytes: Buffer): UploadState {
  return withUploadHash({
    id,
    hash: '',
    md5: digest(bytes, 'md5'),
    size: bytes.length,
    url: `https://assets.example/${id}`,
    filename: `${id}.bin`,
    collectionId: null,
    attributes: {},
  });
}

function withUploadHash(state: UploadState): UploadState {
  return {
    ...state,
    hash: hashJson({
      id: state.id,
      md5: state.md5,
      size: state.size,
      filename: state.filename,
      collectionId: state.collectionId,
      attributes: state.attributes,
    }),
  };
}

function metadata(entries: PlanEntry[]): PlanMetadata {
  const counts = Object.fromEntries(
    ['record', 'upload', 'collection'].map((kind) => [
      kind,
      Object.fromEntries(
        ['create', 'update', 'delete', 'noop', 'skip'].map((action) => [
          action,
          0,
        ]),
      ),
    ]),
  ) as PlanCounts;
  for (const entry of entries) counts[entry.kind][entry.action]++;
  return {
    source: { siteId: 'site', environmentId: 'source' },
    destination: { siteId: 'site', environmentId: 'target' },
    schema: {
      siteId: 'site',
      environmentId: 'target',
      locales: ['en'],
      semantics: {},
      models: [],
      workflows: [],
      hash: hashJson({
        locales: ['en'],
        semantics: {},
        models: [],
        workflows: [],
      }),
    },
    options: {
      modelIds: ['model-a'],
      uploads: 'referenced',
      includeDeletions: false,
      allowPartial: false,
      allowTemporarySchemaChanges: false,
    },
    counts,
    temporarySchemaChanges: [],
  };
}

async function reseal(
  directory: string,
  manifest: BundleManifest,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(directory, 'manifest.json'), bytes);
  await writeFile(join(directory, 'manifest.sha256'), `${digest(bytes)}\n`);
}

/** Only these bounded fixtures are collected; production reads the index as a stream. */
async function readTestChunks(
  directory: string,
  manifest: BundleManifest,
): Promise<BundleChunk[]> {
  assert.ok(manifest.chunks.bytes < 128 * 1024);
  const bytes = await readFile(join(directory, manifest.chunks.file));
  assert.equal(bytes.length, manifest.chunks.bytes);
  assert.equal(digest(bytes), manifest.chunks.sha256);
  return bytes.length
    ? bytes
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as BundleChunk)
    : [];
}

async function sealTestChunks(
  directory: string,
  manifest: BundleManifest,
  chunks: BundleChunk[],
): Promise<void> {
  const bytes = Buffer.from(
    chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''),
  );
  await writeFile(join(directory, manifest.chunks.file), bytes);
  manifest.chunks.bytes = bytes.length;
  manifest.chunks.sha256 = digest(bytes);
  manifest.chunks.count = chunks.length;
}

describe('temporary indexed snapshot store and streamed bundles', () => {
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

  it('streams deterministic UTF-8 chunks, keeps noops compact, and never splits oversized entries', async () => {
    const source = store();
    const entries: PlanEntry[] = [
      recordPlan('z'),
      recordPlan('a', 'update'),
      recordPlan('é'),
      recordPlan('big', 'create'),
    ];
    (entries[3] as RecordPlan).desired!.current.large = 'x'.repeat(2300);
    (entries[3] as RecordPlan).desired!.hash = recordHash(
      (entries[3] as RecordPlan).desired!,
    );
    for (const entry of entries) source.putPlan(entry);
    const output = await writeBundle({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'bundle'),
      chunkBytes: 1100,
    });
    const manifest = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    ) as BundleManifest;
    const serialized: PlanEntry[] = [];
    for (const chunk of await readTestChunks(output, manifest)) {
      const bytes = await readFile(join(output, chunk.file));
      const lines = bytes.toString('utf8').trimEnd().split('\n');
      assert.equal(bytes.length, chunk.bytes);
      assert.equal(digest(bytes), chunk.sha256);
      assert.ok(chunk.bytes <= 1100 || lines.length === 1);
      serialized.push(...lines.map((line) => JSON.parse(line) as PlanEntry));
    }
    assert.deepEqual(
      serialized.map((entry) => entry.id),
      ['a', 'big', 'z', 'é'],
    );
    const unchanged = serialized.find((entry) => entry.id === 'z')!;
    assert.equal(unchanged.baseline, undefined);
    assert.equal(unchanged.desired, undefined);
    assert.ok(unchanged.guard);
    assert.ok(serialized[0].baseline);
    assert.ok(serialized[0].desired);
    const imported = store();
    assert.deepEqual(
      await readBundle({ directory: output, store: imported }),
      manifest,
    );
    assert.deepEqual([...imported.planEntries()], serialized);
    const second = await writeBundle({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'second'),
      chunkBytes: 1100,
    });
    const secondManifest = JSON.parse(
      await readFile(join(second, 'manifest.json'), 'utf8'),
    ) as BundleManifest;
    assert.deepEqual(secondManifest.chunks, manifest.chunks);
  });

  it('keeps the manifest compact while streaming many descriptors and one oversized entry', async () => {
    const source = store();
    const entries: RecordPlan[] = Array.from({ length: 128 }, (_, number) =>
      recordPlan(`record-${String(number).padStart(3, '0')}`),
    );
    source.putPlan(entries[0]);
    const small = await writeBundle({
      store: source,
      metadata: metadata([entries[0]]),
      outputPath: join(directory, 'small'),
      chunkBytes: 64,
    });
    const smallManifestBytes = (await lstat(join(small, 'manifest.json'))).size;
    const oversized = recordPlan('oversized', 'create');
    oversized.desired!.current.large = 'x'.repeat(130_000);
    oversized.desired!.hash = recordHash(oversized.desired!);
    entries.push(oversized);
    for (const entry of entries) source.putPlan(entry);
    const output = await writeBundle({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'many'),
      chunkBytes: 64,
    });
    const manifestBytes = await readFile(join(output, 'manifest.json'));
    const manifest = JSON.parse(
      manifestBytes.toString('utf8'),
    ) as BundleManifest;
    assert.equal(Array.isArray(manifest.chunks), false);
    assert.deepEqual(Object.keys(manifest.chunks).sort(), [
      'bytes',
      'count',
      'file',
      'sha256',
    ]);
    assert.equal(manifest.chunks.count, 129);
    assert.ok(manifestBytes.length < smallManifestBytes + 64);
    assert.ok(manifest.chunks.bytes > manifestBytes.length * 10);
    const chunks = await readTestChunks(output, manifest);
    assert.equal(chunks.length, 129);
    assert.ok(chunks.every((chunk) => chunk.entries === 1));
    const largeChunk = chunks.find((chunk) => chunk.bytes > 130_000)!;
    const largeBytes = await readFile(join(output, largeChunk.file));
    assert.equal(largeBytes.toString('utf8').trimEnd().split('\n').length, 1);
    const imported = store();
    await readBundle({ directory: output, store: imported });
    assert.equal(
      imported.database.prepare('SELECT COUNT(*) AS count FROM plan').get()!
        .count,
      129,
    );
    assert.equal(
      (imported.getPlan('record', 'oversized') as RecordPlan).desired!.current
        .large,
      oversized.desired!.current.large,
    );
  });

  it('validates the streamed index checksum, sequence, paths, counts, symlinks, and bounded descriptor lines before importing', async () => {
    const source = store();
    const entries = [recordPlan('a'), recordPlan('b')];
    for (const entry of entries) source.putPlan(entry);
    for (const attack of [
      'checksum',
      'duplicate',
      'order',
      'count',
      'symlink',
      'oversized-line',
    ]) {
      const output = await writeBundle({
        store: source,
        metadata: metadata(entries),
        outputPath: join(directory, attack),
        chunkBytes: 1,
      });
      const manifest = JSON.parse(
        await readFile(join(output, 'manifest.json'), 'utf8'),
      ) as BundleManifest;
      const chunks = await readTestChunks(output, manifest);
      if (attack === 'checksum') manifest.chunks.sha256 = '0'.repeat(64);
      if (attack === 'duplicate')
        await sealTestChunks(output, manifest, [chunks[0], chunks[0]]);
      if (attack === 'order')
        await sealTestChunks(output, manifest, chunks.reverse());
      if (attack === 'count') manifest.chunks.count++;
      if (attack === 'symlink') {
        const outside = join(directory, 'outside-index.jsonl');
        await writeFile(
          outside,
          await readFile(join(output, manifest.chunks.file)),
        );
        await rm(join(output, manifest.chunks.file));
        await symlink(outside, join(output, manifest.chunks.file));
      }
      if (attack === 'oversized-line')
        await sealTestChunks(output, manifest, [
          { ...chunks[0], padding: 'x'.repeat(2048) } as BundleChunk,
          chunks[1],
        ]);
      await reseal(output, manifest);
      const imported = store();
      await assert.rejects(
        readBundle({ directory: output, store: imported }),
        (error: unknown) =>
          error instanceof ContentError && error.code === 'INVALID_BUNDLE',
        attack,
      );
      assert.equal([...imported.planEntries()].length, 0);
    }
  });

  it('supports an empty checksummed chunk index and rejects index changes before import commit', async () => {
    const source = store();
    const empty = await writeBundle({
      store: source,
      metadata: metadata([]),
      outputPath: join(directory, 'empty'),
    });
    const emptyManifest = await readBundle({
      directory: empty,
      store: store(),
    });
    assert.equal(emptyManifest.chunks.bytes, 0);
    assert.equal(emptyManifest.chunks.count, 0);
    assert.equal(emptyManifest.chunks.sha256, digest(''));
    const entries = [recordPlan('a'), recordPlan('b')];
    for (const entry of entries) source.putPlan(entry);
    const output = await writeBundle({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'changed-index'),
      chunkBytes: 1,
    });
    const manifest = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    ) as BundleManifest;
    const chunks = await readTestChunks(output, manifest);
    const changed = chunks
      .map(
        (chunk) =>
          `${JSON.stringify(
            Object.fromEntries(Object.entries(chunk).reverse()),
          )}\n`,
      )
      .join('');
    assert.equal(Buffer.byteLength(changed), manifest.chunks.bytes);
    assert.notEqual(digest(changed), manifest.chunks.sha256);
    const imported = store();
    const execute = imported.database.exec.bind(imported.database);
    imported.database.exec = (sql) => {
      execute(sql);
      if (sql === 'BEGIN')
        require('node:fs').writeFileSync(
          join(output, manifest.chunks.file),
          changed,
        );
    };
    let attempted = 0;
    const putPlan = imported.putPlan.bind(imported);
    imported.putPlan = (entry) => {
      attempted++;
      putPlan(entry);
    };
    await assert.rejects(
      readBundle({ directory: output, store: imported }),
      /Chunk index checksum/,
    );
    assert.equal(attempted, 2);
    assert.equal([...imported.planEntries()].length, 0);
  });

  it('streams and checks asset downloads, deduplicates binaries, and omits an asset list from the manifest', async () => {
    const source = store();
    const bytes = Buffer.from('binary content '.repeat(200));
    const desired = upload('one', bytes);
    const second = upload('two', bytes);
    const old = withUploadHash({
      ...second,
      md5: digest('old', 'md5'),
      size: 3,
    });
    const entries: PlanEntry[] = [
      {
        kind: 'upload',
        id: 'one',
        action: 'create',
        guard: null,
        baseline: null,
        desired,
        diagnostics: [],
      },
      {
        kind: 'upload',
        id: 'two',
        action: 'update',
        guard: { hash: old.hash },
        baseline: old,
        desired: second,
        diagnostics: [],
      },
    ];
    for (const entry of entries) source.putPlan(entry);
    let pulls = 0;
    const fetchFn = (async () => {
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 257, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
        }),
      );
    }) as typeof fetch;
    const output = await writeBundle({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'bundle'),
      fetchFn,
    });
    assert.ok(pulls > 10);
    assert.deepEqual(await readdir(join(output, 'binaries')), [
      `${digest(bytes)}.bin`,
    ]);
    const manifest = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    ) as BundleManifest;
    assert.equal('binaries' in manifest, false);
    const imported = store();
    await readBundle({ directory: output, store: imported });
    for (const entry of imported.planEntries('upload')) {
      assert.equal(entry.kind, 'upload');
      if (entry.kind === 'upload')
        assert.deepEqual(entry.binary, {
          file: `binaries/${digest(bytes)}.bin`,
          sha256: digest(bytes),
          md5: digest(bytes, 'md5'),
          bytes: bytes.length,
        });
    }
  });

  it('downloads original asset bytes with dashboard controls while preserving captured URLs and other query parameters', async () => {
    for (const format of ['svg', 'jpg']) {
      const source = store();
      const bytes =
        format === 'svg'
          ? Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0"/></svg>\n',
            )
          : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 0xff, 0xd9]);
      const filename = `original + copy.${format}`;
      const capturedUrl = `https://assets.example/original.${format}?download_key=opaque%2Bvalue&keep=one&keep=two&dl=preview&skip-default-optimizations=false&svg-sanitize=true`;
      const desired = withUploadHash({
        ...upload(format, bytes),
        filename,
        url: capturedUrl,
      });
      const entry: PlanEntry = {
        kind: 'upload',
        id: format,
        action: 'create',
        baseline: null,
        desired,
        guard: null,
        diagnostics: [],
      };
      source.putPlan(entry);
      const requested: URL[] = [];
      const output = await writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: join(directory, `original-${format}`),
        fetchFn: (async (input) => {
          const url = new URL(String(input));
          requested.push(url);
          const original =
            url.searchParams.get('svg-sanitize') === 'false' &&
            url.searchParams.get('skip-default-optimizations') === 'true';
          // Imgix's default SVG sanitization adds a declaration/formatting;
          // project-level image optimizations can also change raster bytes.
          return new Response(
            original
              ? bytes
              : Buffer.concat([Buffer.from('<?xml version="1.0"?>\n'), bytes]),
          );
        }) as typeof fetch,
      });
      assert.equal(requested.length, 1);
      assert.equal(requested[0].pathname, `/original.${format}`);
      assert.equal(requested[0].searchParams.get('dl'), filename);
      assert.equal(requested[0].searchParams.get('svg-sanitize'), 'false');
      assert.equal(
        requested[0].searchParams.get('skip-default-optimizations'),
        'true',
      );
      assert.equal(
        requested[0].searchParams.get('download_key'),
        'opaque+value',
      );
      assert.deepEqual(requested[0].searchParams.getAll('keep'), [
        'one',
        'two',
      ]);
      const imported = store();
      await readBundle({ directory: output, store: imported });
      const saved = imported.getPlan('upload', format)!;
      assert(saved.kind === 'upload' && saved.binary);
      assert.equal(saved.desired!.url, capturedUrl);
      assert.equal(saved.binary.md5, digest(bytes, 'md5'));
      assert.equal(saved.binary.bytes, bytes.length);
      assert.deepEqual(await readFile(join(output, saved.binary.file)), bytes);
    }
  });

  it('retains exact size and checksum enforcement on original-download requests', async () => {
    const bytes = Buffer.from('unchanged original binary');
    for (const corruption of ['size', 'checksum']) {
      const source = store();
      const desired = upload(corruption, bytes);
      const entry: PlanEntry = {
        kind: 'upload',
        id: corruption,
        action: 'create',
        baseline: null,
        desired,
        guard: null,
        diagnostics: [],
      };
      source.putPlan(entry);
      const output = join(directory, `corrupt-original-${corruption}`);
      const corrupted =
        corruption === 'size'
          ? Buffer.concat([bytes, Buffer.from('extra')])
          : Buffer.from(bytes);
      if (corruption === 'checksum') corrupted[0] ^= 1;
      await assert.rejects(
        writeBundle({
          store: source,
          metadata: metadata([entry]),
          outputPath: output,
          fetchFn: (async (input) => {
            const url = new URL(String(input));
            assert.equal(
              url.searchParams.get('skip-default-optimizations'),
              'true',
            );
            assert.equal(url.searchParams.get('svg-sanitize'), 'false');
            return new Response(corrupted);
          }) as typeof fetch,
        }),
        /exceeds its captured size|differs from the captured binary/,
      );
      assert.equal(existsSync(output), false);
      assert.equal(
        (await readdir(directory)).some((name) =>
          name.startsWith(`.corrupt-original-${corruption}-`),
        ),
        false,
      );
    }
  });

  it('does not download an upload metadata-only update', async () => {
    const source = store();
    const baseline = upload('one', Buffer.from('asset'));
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'update',
      guard: { hash: baseline.hash },
      baseline,
      desired: withUploadHash({ ...baseline, filename: 'renamed.bin' }),
      diagnostics: [],
    };
    source.putPlan(entry);
    const output = await writeBundle({
      store: source,
      metadata: metadata([entry]),
      outputPath: join(directory, 'bundle'),
      fetchFn: (async () => {
        assert.fail('Unexpected asset download');
      }) as typeof fetch,
    });
    const imported = store();
    await readBundle({ directory: output, store: imported });
    assert.equal(
      (imported.getPlan('upload', 'one') as { binary?: unknown }).binary,
      undefined,
    );
  });

  it('rejects overwrite and removes staging files after a mismatched or failed download', async () => {
    const source = store();
    const desired = upload('one', Buffer.from('expected'));
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired,
      diagnostics: [],
    };
    source.putPlan(entry);
    const output = join(directory, 'bundle');
    await mkdir(output);
    await assert.rejects(
      writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'BUNDLE_EXISTS',
    );
    assert.deepEqual(await readdir(output), []);
    await rm(output, { recursive: true });
    await assert.rejects(
      writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        fetchFn: (async () =>
          new Response(Buffer.from('wrong'))) as typeof fetch,
      }),
      /differs from the captured binary/,
    );
    assert.equal(existsSync(output), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-bundle-'),
      ),
      false,
    );
    await assert.rejects(
      writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        fetchFn: (async () => {
          throw new Error('connection lost');
        }) as typeof fetch,
      }),
      /connection lost/,
    );
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-bundle-'),
      ),
      false,
    );
  });

  it('cancels an unsuccessful asset response before removing its incomplete bundle', async () => {
    const source = store();
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired: upload('one', Buffer.from('asset')),
      diagnostics: [],
    };
    source.putPlan(entry);
    let cancelled = false;
    const output = join(directory, 'bundle');
    await assert.rejects(
      writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        fetchFn: (async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 404 },
          )) as typeof fetch,
      }),
      /could not be downloaded \(404\)/,
    );
    assert.equal(cancelled, true);
    assert.equal(existsSync(output), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-bundle-'),
      ),
      false,
    );
  });

  it('aborts pending asset fetches with the supplied signal and removes their incomplete bundle', async () => {
    const source = store();
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired: upload('one', Buffer.from('asset')),
      diagnostics: [],
    };
    source.putPlan(entry);
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const output = join(directory, 'bundle');
    const writing = writeBundle({
      store: source,
      metadata: metadata([entry]),
      outputPath: output,
      signal: controller.signal,
      fetchFn: (async (_url, init) => {
        assert.equal(init?.signal, controller.signal);
        ready();
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new Error('native fetch aborted')),
            { once: true },
          );
        });
      }) as typeof fetch,
    });
    const rejected = assert.rejects(
      writing,
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    await started;
    controller.abort();
    await rejected;
    assert.equal(existsSync(output), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-bundle-'),
      ),
      false,
    );
  });

  it('releases an interrupted asset body and rejects pre-aborted output before creating directories', async () => {
    const source = store();
    const bytes = Buffer.from('asset');
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired: upload('one', bytes),
      diagnostics: [],
    };
    source.putPlan(entry);
    const controller = new AbortController();
    let cancelled = false;
    let pulls = 0;
    const output = join(directory, 'bundle');
    await assert.rejects(
      writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        signal: controller.signal,
        fetchFn: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(stream) {
                if (++pulls > 1) controller.abort();
                stream.enqueue(bytes.subarray(0, 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
          )) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.equal(cancelled, true);
    assert.equal(existsSync(output), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-bundle-'),
      ),
      false,
    );
    const parent = join(directory, 'never-created');
    await assert.rejects(
      writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: join(parent, 'bundle'),
        signal: controller.signal,
        fetchFn: (async () =>
          assert.fail('Pre-aborted bundle must not download')) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.equal(existsSync(parent), false);
  });

  it('rejects chunk corruption, traversal, symlinks, and missing binary integrity before importing entries', async () => {
    const source = store();
    const bytes = Buffer.from('asset');
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired: upload('one', bytes),
      diagnostics: [],
    };
    source.putPlan(entry);
    for (const attack of [
      'chunk',
      'traversal',
      'symlink',
      'binary',
      'manifest',
    ]) {
      const output = await writeBundle({
        store: source,
        metadata: metadata([entry]),
        outputPath: join(directory, attack),
        fetchFn: (async () => new Response(bytes)) as typeof fetch,
      });
      const manifest = JSON.parse(
        await readFile(join(output, 'manifest.json'), 'utf8'),
      ) as BundleManifest;
      const chunks = await readTestChunks(output, manifest);
      if (attack === 'chunk')
        await writeFile(join(output, chunks[0].file), 'corrupt');
      if (attack === 'traversal') {
        chunks[0].file = '../outside.jsonl';
        await sealTestChunks(output, manifest, chunks);
        await reseal(output, manifest);
      }
      if (attack === 'symlink') {
        const target = join(output, chunks[0].file);
        const original = await readFile(target);
        const outside = join(directory, 'outside.jsonl');
        await writeFile(outside, original);
        await rm(target);
        await symlink(outside, target);
      }
      if (attack === 'binary')
        await writeFile(join(output, `binaries/${digest(bytes)}.bin`), 'wrong');
      if (attack === 'manifest')
        await writeFile(join(output, 'manifest.sha256'), `${'0'.repeat(64)}\n`);
      const imported = store();
      await assert.rejects(
        readBundle({ directory: output, store: imported }),
        (error: unknown) =>
          error instanceof ContentError && error.code === 'INVALID_BUNDLE',
      );
      assert.equal([...imported.planEntries()].length, 0);
    }
  });

  it('rejects structurally invalid entries even when checksums are recreated', async () => {
    const source = store();
    const entry = recordPlan('one', 'update');
    source.putPlan(entry);
    const output = await writeBundle({
      store: source,
      metadata: metadata([entry]),
      outputPath: join(directory, 'bundle'),
    });
    const manifest = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    ) as BundleManifest;
    const chunks = await readTestChunks(output, manifest);
    const malformed = { ...entry, baseline: undefined };
    const bytes = Buffer.from(`${JSON.stringify(malformed)}\n`);
    await writeFile(join(output, chunks[0].file), bytes);
    chunks[0].bytes = bytes.length;
    chunks[0].sha256 = digest(bytes);
    await sealTestChunks(output, manifest, chunks);
    await reseal(output, manifest);
    const imported = store();
    await assert.rejects(
      readBundle({ directory: output, store: imported }),
      /Invalid baseline/,
    );
    assert.equal([...imported.planEntries()].length, 0);
  });

  it('rejects forged content fingerprints, complete guards, and schema states after byte checksums are recreated', async () => {
    const asset = upload('asset', Buffer.from('asset'));
    const collection = {
      id: 'collection',
      label: 'Original',
      parentId: null,
      position: 1,
      hash: hashJson({
        id: 'collection',
        label: 'Original',
        parentId: null,
        position: 1,
      }),
    };
    const cases: Array<{
      name: string;
      entry: PlanEntry;
      mutate: (entry: PlanEntry, manifest: BundleManifest) => void;
    }> = [
      {
        name: 'record',
        entry: recordPlan('record', 'update'),
        mutate: (entry) => {
          (entry as RecordPlan).desired!.current.title = 'forged';
        },
      },
      {
        name: 'guard',
        entry: recordPlan('record', 'update'),
        mutate: (entry) => {
          (entry as RecordPlan).baseline!.currentVersion = 'forged';
        },
      },
      {
        name: 'upload',
        entry: {
          kind: 'upload',
          id: asset.id,
          action: 'update',
          guard: { hash: asset.hash },
          baseline: asset,
          desired: withUploadHash({ ...asset, filename: 'renamed.bin' }),
          diagnostics: [],
        },
        mutate: (entry) => {
          if (entry.kind === 'upload')
            entry.desired!.attributes.notes = 'forged';
        },
      },
      {
        name: 'collection',
        entry: {
          kind: 'collection',
          id: collection.id,
          action: 'create',
          guard: null,
          baseline: null,
          desired: collection,
          diagnostics: [],
        },
        mutate: (entry) => {
          if (entry.kind === 'collection') entry.desired!.label = 'forged';
        },
      },
      {
        name: 'schema',
        entry: recordPlan('record', 'update'),
        mutate: (_entry, manifest) => {
          manifest.schema.workflows.push({ id: 'forged' });
        },
      },
      ...['position-hash', 'position-fraction', 'position-missing'].map(
        (name) => ({
          name,
          entry: {
            kind: 'collection' as const,
            id: collection.id,
            action: 'create' as const,
            guard: null,
            baseline: null,
            desired: collection,
            diagnostics: [],
          },
          mutate: (entry: PlanEntry) => {
            if (entry.kind !== 'collection') return;
            if (name === 'position-hash') entry.desired!.position = 2;
            else if (name === 'position-missing')
              Reflect.deleteProperty(entry.desired!, 'position');
            else {
              entry.desired!.position = 1.5;
              entry.desired!.hash = hashJson({
                id: collection.id,
                label: collection.label,
                parentId: null,
                position: 1.5,
              });
            }
          },
        }),
      ),
    ];
    for (const item of cases) {
      const source = store();
      source.putPlan(item.entry);
      const output = await writeBundle({
        store: source,
        metadata: metadata([item.entry]),
        outputPath: join(directory, item.name),
      });
      const manifest = JSON.parse(
        await readFile(join(output, 'manifest.json'), 'utf8'),
      ) as BundleManifest;
      const chunks = await readTestChunks(output, manifest);
      const entry = JSON.parse(
        (await readFile(join(output, chunks[0].file), 'utf8')).trim(),
      ) as PlanEntry;
      item.mutate(entry, manifest);
      const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
      await writeFile(join(output, chunks[0].file), bytes);
      chunks[0].bytes = bytes.length;
      chunks[0].sha256 = digest(bytes);
      await sealTestChunks(output, manifest, chunks);
      await reseal(output, manifest);
      const imported = store();
      await assert.rejects(
        readBundle({ directory: output, store: imported }),
        (error: unknown) =>
          error instanceof ContentError && error.code === 'INVALID_BUNDLE',
        item.name,
      );
      assert.equal([...imported.planEntries()].length, 0);
    }
  });

  it('rejects unsafe integer validator metadata before importing temporary schema restoration settings', async () => {
    for (const target of ['original', 'temporary']) {
      const source = store();
      const entry = recordPlan('record', 'update');
      source.putPlan(entry);
      const meta = metadata([entry]);
      meta.schema.models = [
        {
          id: 'model-a',
          apiKey: 'article',
          name: 'Article',
          block: false,
          singleton: false,
          sortable: false,
          tree: false,
          draftMode: true,
          saveInvalidDrafts: true,
          allLocalesRequired: false,
          workflowId: null,
          fields: [
            {
              id: 'counter-field',
              apiKey: 'title',
              type: 'integer',
              localized: false,
              validators: { number_range: { min: 0 } },
              defaultValue: null,
            },
          ],
        },
      ];
      meta.schema.hash = hashJson({
        locales: meta.schema.locales,
        semantics: meta.schema.semantics,
        models: meta.schema.models,
        workflows: meta.schema.workflows,
      });
      meta.options.allowTemporarySchemaChanges = true;
      meta.temporarySchemaChanges = [
        {
          fieldId: 'counter-field',
          modelId: 'model-a',
          original: {
            validators: { number_range: { min: 0 } },
            defaultValue: null,
          },
          temporary: { validators: {}, defaultValue: null },
          reasons: ['Permit the reviewed transition.'],
        },
      ];
      const output = await writeBundle({
        store: source,
        metadata: meta,
        outputPath: join(directory, `unsafe-validators-${target}`),
      });
      const manifest = JSON.parse(
        await readFile(join(output, 'manifest.json'), 'utf8'),
      ) as BundleManifest;
      const unsafe = JSON.parse('9007199254740993') as number;
      if (target === 'original') {
        manifest.schema.models[0].fields[0].validators = {
          number_range: { min: unsafe },
        };
        manifest.temporarySchemaChanges[0].original.validators = {
          number_range: { min: unsafe },
        };
        manifest.schema.hash = hashJson({
          locales: manifest.schema.locales,
          semantics: manifest.schema.semantics,
          models: manifest.schema.models,
          workflows: manifest.schema.workflows,
        });
      } else
        manifest.temporarySchemaChanges[0].temporary.validators = {
          number_range: { min: unsafe },
        };
      await reseal(output, manifest);
      const imported = store();
      await assert.rejects(
        readBundle({ directory: output, store: imported }),
        (error) =>
          error instanceof ContentError &&
          error.code === 'UNSUPPORTED_INTEGER_PRECISION',
      );
      assert.equal([...imported.planEntries()].length, 0);
    }
  });

  it('accepts exact validator removal/default suppression and rejects forged temporary field changes', async () => {
    for (const localized of [false, true]) {
      const source = store();
      const entry = recordPlan('record');
      source.putPlan(entry);
      const planMetadata = metadata([entry]);
      planMetadata.schema.models = [
        {
          id: 'model-a',
          apiKey: 'article',
          name: 'Article',
          block: false,
          singleton: false,
          sortable: false,
          tree: false,
          draftMode: true,
          saveInvalidDrafts: false,
          allLocalesRequired: false,
          workflowId: null,
          fields: [
            {
              id: 'field-a',
              apiKey: 'title',
              type: 'string',
              localized,
              validators: { required: {}, length: { max: 25 } },
              defaultValue: localized ? { en: 'automatic' } : 'automatic',
            },
          ],
        },
      ];
      const field = planMetadata.schema.models[0].fields[0];
      planMetadata.schema.hash = hashJson({
        locales: planMetadata.schema.locales,
        semantics: planMetadata.schema.semantics,
        models: planMetadata.schema.models,
        workflows: planMetadata.schema.workflows,
      });
      planMetadata.options.allowTemporarySchemaChanges = true;
      planMetadata.temporarySchemaChanges = [
        {
          fieldId: field.id,
          modelId: 'model-a',
          original: {
            validators: field.validators,
            defaultValue: field.defaultValue,
          },
          temporary: {
            validators: { length: { max: 25 } },
            defaultValue: localized ? { en: null } : null,
          },
          reasons: ['Required creation reference is temporarily deferred.'],
        },
      ];
      for (const attack of [
        'valid',
        'unchanged',
        ...(localized ? ['scalar-null', 'missing-locale', 'extra-locale'] : []),
        'addition',
        'modified',
        'default',
        'field',
        'original',
        'duplicate',
        'reasons',
      ]) {
        const output = await writeBundle({
          store: source,
          metadata: planMetadata,
          outputPath: join(directory, `${localized}-${attack}`),
        });
        const manifest = JSON.parse(
          await readFile(join(output, 'manifest.json'), 'utf8'),
        ) as BundleManifest;
        const change = manifest.temporarySchemaChanges[0];
        if (attack === 'unchanged')
          change.temporary.defaultValue = change.original.defaultValue;
        if (attack === 'scalar-null') change.temporary.defaultValue = null;
        if (attack === 'missing-locale') change.temporary.defaultValue = {};
        if (attack === 'extra-locale')
          change.temporary.defaultValue = { en: null, it: null };
        if (attack === 'addition')
          change.temporary.validators.enum = { values: ['other'] };
        if (attack === 'modified')
          change.temporary.validators.length = { max: 1 };
        if (attack === 'default') change.temporary.defaultValue = 'different';
        if (attack === 'field') change.fieldId = 'outside-field';
        if (attack === 'original') change.original.defaultValue = 'different';
        if (attack === 'duplicate')
          manifest.temporarySchemaChanges.push(change);
        if (attack === 'reasons') change.reasons = [];
        await reseal(output, manifest);
        const imported = store();
        if (attack === 'valid' || attack === 'unchanged')
          await readBundle({ directory: output, store: imported });
        else {
          await assert.rejects(
            readBundle({ directory: output, store: imported }),
            (error: unknown) =>
              error instanceof ContentError && error.code === 'INVALID_BUNDLE',
            attack,
          );
          assert.equal([...imported.planEntries()].length, 0);
        }
      }
    }
  });

  it('rolls back streamed import if integrity changes between validation and import', async () => {
    const source = store();
    const entries = [recordPlan('a'), recordPlan('b')];
    for (const entry of entries) source.putPlan(entry);
    const output = await writeBundle({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'bundle'),
      chunkBytes: 1,
    });
    const manifest = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    ) as BundleManifest;
    const chunks = await readTestChunks(output, manifest);
    const imported = store();
    const putPlan = imported.putPlan.bind(imported);
    let called = false;
    imported.putPlan = (entry) => {
      putPlan(entry);
      if (!called) {
        called = true;
        // Mutation runs synchronously before the next file is opened.
        require('node:fs').writeFileSync(
          join(output, chunks[1].file),
          'corrupt',
        );
      }
    };
    await assert.rejects(
      readBundle({ directory: output, store: imported }),
      /Chunk size differs/,
    );
    assert.equal([...imported.planEntries()].length, 0);
  });

  it('interrupts buffered bundle validation and rolls back an interrupted import while retaining the completed export', async () => {
    const source = store();
    const entries = Array.from({ length: 128 }, (_, index) =>
      recordPlan(`record-${String(index).padStart(3, '0')}`),
    );
    source.transaction(() => {
      for (const entry of entries) source.putPlan(entry);
    });
    const output = await writeBundle({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'bundle'),
    });
    for (const phase of ['validation', 'import']) {
      const imported = store();
      const controller = new AbortController();
      let scanned = 0;
      let inserted = 0;
      const prepare = imported.database.prepare.bind(imported.database);
      imported.database.prepare = (sql) => {
        const statement = prepare(sql);
        if (sql === 'INSERT INTO bundle_keys VALUES (?, ?)') {
          const run = statement.run.bind(statement);
          statement.run = (...parameters) => {
            const result = Reflect.apply(
              run,
              statement,
              parameters,
            ) as ReturnType<typeof statement.run>;
            if (++scanned === 1 && phase === 'validation')
              setImmediate(() => controller.abort());
            return result;
          };
        }
        return statement;
      };
      const putPlan = imported.putPlan.bind(imported);
      imported.putPlan = (entry) => {
        putPlan(entry);
        if (++inserted === 1 && phase === 'import') controller.abort();
      };
      await assert.rejects(
        readBundle({
          directory: output,
          store: imported,
          signal: controller.signal,
        }),
        (error: unknown) =>
          error instanceof ContentError && error.code === 'INTERRUPTED',
        phase,
      );
      if (phase === 'validation') {
        assert.ok(scanned > 0 && scanned < entries.length);
        assert.equal(inserted, 0);
      } else {
        assert.equal(scanned, entries.length);
        assert.equal(inserted, 1);
      }
      assert.equal([...imported.planEntries()].length, 0);
      assert.equal(
        imported.database
          .prepare(
            "SELECT name FROM sqlite_temp_master WHERE name='bundle_keys'",
          )
          .get(),
        undefined,
      );
      assert.equal(existsSync(join(output, 'manifest.json')), true);
    }
  });
});
