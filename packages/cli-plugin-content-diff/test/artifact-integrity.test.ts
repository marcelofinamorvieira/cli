import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { recordHash } from '../src/engine/codec';
import { ContentError } from '../src/engine/errors';
import type { BaselineManifest } from '../src/engine/migration-artifact';
import { SnapshotStore } from '../src/engine/store';
import type { ArtifactChunk } from '../src/engine/types';
import {
  digest,
  metadata,
  readFixture,
  recordPlan,
  writeFixture,
} from './artifact-fixture';
async function manifest(directory: string): Promise<BaselineManifest> {
  return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
}
async function chunks(
  directory: string,
  manifest: BaselineManifest,
): Promise<ArtifactChunk[]> {
  const bytes = await readFile(join(directory, manifest.chunks.file));
  assert.equal(bytes.length, manifest.chunks.bytes);
  assert.equal(digest(bytes), manifest.chunks.sha256);
  return bytes.length
    ? bytes
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}
async function reseal(
  directory: string,
  manifest: BaselineManifest,
  descriptors?: ArtifactChunk[],
) {
  if (descriptors) {
    const raw = descriptors
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join('');
    await writeFile(join(directory, manifest.chunks.file), raw);
    Object.assign(manifest.chunks, {
      bytes: Buffer.byteLength(raw),
      sha256: digest(raw),
      count: descriptors.length,
    });
  }
  const raw = `${JSON.stringify(manifest)}\n`;
  await writeFile(join(directory, 'manifest.json'), raw);
  await writeFile(join(directory, 'manifest.sha256'), `${digest(raw)}\n`);
}
function assertEmpty(store: SnapshotStore) {
  if (
    store.database
      .prepare('SELECT name FROM sqlite_temp_master WHERE name=?')
      .get('migration_baseline')
  )
    assert.equal(
      store.database
        .prepare('SELECT COUNT(*) AS count FROM migration_baseline')
        .get()!.count,
      0,
    );
}
describe('TypeScript baseline integrity', () => {
  let directory: string;
  const stores: SnapshotStore[] = [];
  const store = () => {
    const value = new SnapshotStore(directory);
    stores.push(value);
    return value;
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-baseline-integrity-'));
  });
  afterEach(async () => {
    for (const value of stores.splice(0)) value.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  it('streams deterministic UTF-8 chunks of compact guards without record content', async () => {
    const source = store();
    const entries = [
      recordPlan('z'),
      recordPlan('a', 'update'),
      recordPlan('é'),
      recordPlan('big', 'update'),
    ];
    entries[3].baseline!.current.large = 'x'.repeat(2300);
    entries[3].baseline!.hash = recordHash(entries[3].baseline!);
    for (const entry of entries) source.putPlan(entry);
    const output = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'first'),
      chunkBytes: 1100,
    });
    const first = await manifest(output);
    const rows: Array<Record<string, unknown>> = [];
    for (const chunk of await chunks(output, first)) {
      const raw = await readFile(join(output, chunk.file));
      const lines = raw.toString('utf8').trimEnd().split('\n');
      assert.equal(digest(raw), chunk.sha256);
      assert.ok(raw.length <= 1100 || lines.length === 1);
      assert.doesNotMatch(raw.toString('utf8'), /xxxx|changed/);
      rows.push(...lines.map((line) => JSON.parse(line)));
    }
    assert.deepEqual(
      rows.map((row) => row.id),
      ['a', 'big', 'z', 'é'],
    );
    for (const row of rows)
      assert.deepEqual(Object.keys(row).sort(), ['guard', 'id', 'kind']);
    const imported = store();
    assert.deepEqual(
      await readFixture({ directory: output, store: imported }),
      first,
    );
    assert.equal(
      imported.database
        .prepare('SELECT COUNT(*) AS count FROM migration_baseline')
        .get()!.count,
      4,
    );
    const second = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'second'),
      chunkBytes: 1100,
    });
    assert.deepEqual((await manifest(second)).chunks, first.chunks);
  });
  it('keeps the manifest compact while streaming many descriptors', async () => {
    const source = store();
    const entries = Array.from({ length: 128 }, (_, index) =>
      recordPlan(`record-${index}`),
    );
    for (const entry of entries) source.putPlan(entry);
    const output = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'many'),
      chunkBytes: 1,
    });
    const value = await manifest(output);
    assert.equal(Array.isArray(value.chunks), false);
    assert.ok(value.chunks.count >= entries.length);
    assert.ok(
      value.chunks.bytes > Buffer.byteLength(JSON.stringify(value)) * 10,
    );
    await readFixture({ directory: output, store: store() });
  });
  it('rejects index corruption, duplicates, ordering and counts', async () => {
    const source = store();
    const entries = [recordPlan('a'), recordPlan('b')];
    for (const entry of entries) source.putPlan(entry);
    for (const attack of ['checksum', 'duplicate', 'order', 'count']) {
      const output = await writeFixture({
        store: source,
        metadata: metadata(entries),
        outputPath: join(directory, attack),
        chunkBytes: 1,
      });
      const value = await manifest(output);
      const descriptors = await chunks(output, value);
      if (attack === 'checksum') value.chunks.sha256 = '0'.repeat(64);
      if (attack === 'duplicate') descriptors[1] = descriptors[0];
      if (attack === 'order') descriptors.reverse();
      if (attack === 'count') value.chunks.count++;
      await reseal(
        output,
        value,
        ['duplicate', 'order'].includes(attack) ? descriptors : undefined,
      );
      const imported = store();
      await assert.rejects(
        readFixture({ directory: output, store: imported }),
        (error: unknown) =>
          error instanceof ContentError &&
          error.code === 'INVALID_MIGRATION_BASELINE',
        attack,
      );
    }
  });
  it('supports an empty checksummed index and rejects an index changed before import', async () => {
    const source = store();
    const output = await writeFixture({
      store: source,
      metadata: metadata([]),
      outputPath: join(directory, 'empty'),
    });
    const empty = await readFixture({ directory: output, store: store() });
    assert.equal(empty.chunks.count, 0);
    assert.equal(empty.chunks.bytes, 0);
    assert.equal(empty.chunks.sha256, digest(''));
    const entries = [recordPlan('a'), recordPlan('b')];
    for (const entry of entries) source.putPlan(entry);
    const populated = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'changed'),
      chunkBytes: 1,
    });
    const value = await manifest(populated);
    const imported = store();
    const prepare = imported.database.prepare.bind(imported.database);
    imported.database.prepare = (sql) => {
      // The manifest has been checked; the index is read next.
      if (sql === 'INSERT INTO migration_baseline VALUES(?,?,?)')
        writeFileSync(join(populated, value.chunks.file), 'corrupt');
      return prepare(sql);
    };
    await assert.rejects(
      readFixture({ directory: populated, store: imported }),
      /size differs/,
    );
    assertEmpty(imported);
  });
  it('rejects chunk corruption, traversal and manifest changes', async () => {
    const source = store();
    const entry = recordPlan('one', 'update');
    source.putPlan(entry);
    for (const attack of ['chunk', 'traversal', 'manifest']) {
      const output = await writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: join(directory, attack),
      });
      const value = await manifest(output);
      const descriptors = await chunks(output, value);
      if (attack === 'chunk')
        await writeFile(join(output, descriptors[0].file), 'corrupt');
      if (attack === 'traversal') {
        descriptors[0].file = '../outside';
        await reseal(output, value, descriptors);
      }
      if (attack === 'manifest')
        await writeFile(join(output, 'manifest.sha256'), `${'0'.repeat(64)}\n`);
      const imported = store();
      await assert.rejects(readFixture({ directory: output, store: imported }));
      assertEmpty(imported);
    }
  });
  it('rejects rows without a kind, ID or guard object after resealing', async () => {
    for (const attack of ['kind', 'id', 'guard']) {
      const entry = recordPlan('record', 'update');
      const source = store();
      source.putPlan(entry);
      const output = await writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: join(directory, attack),
      });
      const value = await manifest(output);
      const descriptors = await chunks(output, value);
      const raw = (await readFile(join(output, descriptors[0].file), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const [row] = raw;
      if (attack === 'kind') row.kind = 'item';
      if (attack === 'id') row.id = '';
      if (attack === 'guard') row.guard = 'forged';
      const bytes = raw.map((row) => `${JSON.stringify(row)}\n`).join('');
      await writeFile(join(output, descriptors[0].file), bytes);
      Object.assign(descriptors[0], {
        bytes: Buffer.byteLength(bytes),
        sha256: digest(bytes),
      });
      await reseal(output, value, descriptors);
      const imported = store();
      await assert.rejects(
        readFixture({ directory: output, store: imported }),
        (error: unknown) =>
          error instanceof ContentError &&
          error.code === 'INVALID_MIGRATION_BASELINE',
        attack,
      );
      assertEmpty(imported);
    }
  });
  it('rejects a later chunk that changes, and an interruption, while loading', async () => {
    const source = store();
    const entries = Array.from({ length: 128 }, (_, index) =>
      recordPlan(`record-${index}`),
    );
    for (const entry of entries) source.putPlan(entry);
    const output = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'many'),
      chunkBytes: 1,
    });
    const descriptors = await chunks(output, await manifest(output));
    const original = await readFile(join(output, descriptors[1].file));
    for (const attack of ['chunk', 'abort', 'buffered-abort']) {
      const imported = store();
      const controller = new AbortController();
      const prepare = imported.database.prepare.bind(imported.database);
      let inserted = 0;
      imported.database.prepare = (sql) => {
        const statement = prepare(sql);
        if (sql === 'INSERT INTO migration_baseline VALUES(?,?,?)') {
          const run = statement.run.bind(statement);
          statement.run = (...parameters) => {
            const result = Reflect.apply(
              run,
              statement,
              parameters,
            ) as ReturnType<typeof statement.run>;
            if (++inserted === 1) {
              if (attack === 'chunk')
                writeFileSync(join(output, descriptors[1].file), 'corrupt');
              else if (attack === 'abort') controller.abort();
              else setImmediate(() => controller.abort());
            }
            return result;
          };
        }
        return statement;
      };
      await assert.rejects(
        readFixture({
          directory: output,
          store: imported,
          signal: controller.signal,
        }),
        attack === 'chunk'
          ? /size differs/
          : (error: unknown) =>
              error instanceof ContentError && error.code === 'INTERRUPTED',
      );
      assert.ok(inserted > 0 && inserted < entries.length);
      assert.equal(existsSync(join(output, 'manifest.json')), true);
      await writeFile(join(output, descriptors[1].file), original);
    }
  });
  it('preserves a disk-full error when SQLite has already rolled back an import', async () => {
    const source = store();
    const entries = Array.from({ length: 8 }, (_, index) =>
      recordPlan(`record-${index}`, 'update'),
    );
    for (const entry of entries) source.putPlan(entry);
    const output = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'disk-full'),
    });
    const imported = store();
    const prepare = imported.database.prepare.bind(imported.database);
    let writes = 0;
    imported.database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === 'INSERT INTO migration_baseline VALUES(?,?,?)') {
        const run = statement.run.bind(statement);
        statement.run = (...parameters) => {
          if (++writes === 2) {
            imported.database.exec('ROLLBACK');
            throw new Error('database or disk is full');
          }
          return Reflect.apply(run, statement, parameters) as ReturnType<
            typeof statement.run
          >;
        };
      }
      return statement;
    };
    await assert.rejects(
      readFixture({ directory: output, store: imported }),
      /database or disk is full/,
    );
    assertEmpty(imported);
  });
});
