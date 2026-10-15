import assert from 'node:assert/strict';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {
  DUMP_FORMAT,
  DUMP_VERSION,
  type DumpManifest,
  openDump,
} from '../src/dump/format';
import { ZipReader, ZipWriter } from '../src/dump/zip';

let directory: string;

/** Gives every test of the suite its own empty `directory`. */
function useTemporaryDirectory() {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-dump-zip-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function valuesOf(zip: ZipReader, prefix: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const { value } of zip.lines(prefix)) values.push(value);
  return values;
}

async function withReader<T>(
  path: string,
  read: (zip: ZipReader) => Promise<T>,
): Promise<T> {
  const zip = await ZipReader.open(path);
  try {
    return await read(zip);
  } finally {
    zip.close();
  }
}

/** Writes a zip by hand, holding what ZipWriter would never write. */
async function writeZip(path: string, entries: Record<string, string>) {
  const zip = new yazl.ZipFile();
  for (const [name, contents] of Object.entries(entries))
    zip.addBuffer(Buffer.from(contents), name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

async function compressionMethods(
  path: string,
): Promise<Record<string, number>> {
  const zip = await yauzl.openPromise(path, {
    lazyEntries: true,
    autoClose: false,
  });
  const methods: Record<string, number> = {};
  for await (const entry of zip.eachEntry())
    methods[entry.fileName] = entry.compressionMethod;
  zip.close();
  return methods;
}

/** The writer opens its partial file asynchronously. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; !condition(); attempt++) {
    if (attempt === 200) assert.fail('The condition never held.');
    await sleep(5);
  }
}

async function assertUserError(
  promise: Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

describe('ZipWriter and ZipReader', () => {
  useTemporaryDirectory();

  it('round-trip JSON, JSON Lines and stored file entries', async () => {
    const path = join(directory, 'not', 'yet', 'there', 'dump.zip');
    const file = Buffer.from([0, 1, 2, 254, 255]);
    const zip = new ZipWriter(path);
    zip.addJson('schema.json', { site: { id: 'site' } });
    zip.addJson('manifest.json', { pretty: true }, { pretty: true });
    const records = [{ id: 'a' }, { id: 'b', title: 'Café ✓' }];
    assert.equal(await zip.addLines('records', records), 2);
    async function* uploads() {
      yield { id: 'u1' };
      await sleep(1);
      yield null;
      yield 'three';
    }
    assert.equal(await zip.addLines('uploads', uploads()), 3);
    await zip.addFile('assets/u1/pixel.png', Readable.from([file]));
    await zip.close();

    await withReader(path, async (reader) => {
      assert.deepEqual(await reader.json('schema.json'), {
        site: { id: 'site' },
      });
      assert.equal(
        (await bytesOf(await reader.stream('manifest.json'))).toString(),
        '{\n  "pretty": true\n}\n',
      );
      const lines = [];
      for await (const line of reader.lines('records')) lines.push(line);
      assert.deepEqual(lines, [
        { text: '{"id":"a"}', value: { id: 'a' } },
        { text: '{"id":"b","title":"Café ✓"}', value: records[1] },
      ]);
      assert.deepEqual(await valuesOf(reader, 'uploads'), [
        { id: 'u1' },
        null,
        'three',
      ]);
      assert.deepEqual(
        await bytesOf(await reader.stream('assets/u1/pixel.png')),
        file,
      );
      assert.equal(reader.has('records/000001.jsonl'), true);
      assert.equal(reader.has('missing.json'), false);
    });
    assert.equal(
      (await compressionMethods(path))['assets/u1/pixel.png'],
      0,
      'The asset file is not stored uncompressed.',
    );
  });

  it('write no entry for an empty lines source, which reads back as no lines', async () => {
    const path = join(directory, 'dump.zip');
    const zip = new ZipWriter(path);
    assert.equal(await zip.addLines('records', []), 0);
    await zip.close();

    await withReader(path, async (reader) => {
      assert.equal(reader.has('records/000001.jsonl'), false);
      assert.deepEqual(await valuesOf(reader, 'records'), []);
    });
  });

  it('keep JSON strings holding U+2028 and U+2029 inside their line', async () => {
    const path = join(directory, 'dump.zip');
    const values = ['line separator', { text: 'paragraph end' }, 1];
    const zip = new ZipWriter(path);
    await zip.addLines('records', values);
    await zip.close();

    await withReader(path, async (reader) => {
      const raw = (
        await bytesOf(await reader.stream('records/000001.jsonl'))
      ).toString();
      // JSON.stringify leaves them unescaped, and node:readline would split there.
      assert.ok(raw.includes(' ') && raw.includes(' '));
      assert.deepEqual(await valuesOf(reader, 'records'), values);
    });
  });

  it('decode multi-byte characters that straddle the chunks of an entry', async () => {
    const path = join(directory, 'dump.zip');
    const values = ['€'.repeat(100_000), { name: '日本語'.repeat(30_000) }];
    const zip = new ZipWriter(path);
    await zip.addLines('records', values);
    await zip.close();

    await withReader(path, async (reader) =>
      assert.deepEqual(await valuesOf(reader, 'records'), values),
    );
  });

  it('write nothing at the final path until close(), which moves <path>.partial into place', async () => {
    const path = join(directory, 'dump.zip');
    const zip = new ZipWriter(path);
    zip.addJson('schema.json', {});
    await zip.addLines('records', [{ id: 'a' }]);
    await waitFor(() => existsSync(`${path}.partial`));
    assert.equal(existsSync(path), false);

    await zip.close();
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(`${path}.partial`), false);
  });

  it('leave neither file after discard()', async () => {
    const path = join(directory, 'dump.zip');
    const zip = new ZipWriter(path);
    zip.addJson('schema.json', {});
    await zip.addLines('records', [{ id: 'a' }]);
    await waitFor(() => existsSync(`${path}.partial`));

    await zip.discard();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.partial`), false);
  });

  it('reject with the error of a failing lines source, and leave neither file once discarded', async () => {
    const path = join(directory, 'dump.zip');
    const zip = new ZipWriter(path);
    async function* failing() {
      yield { id: 'a' };
      throw new Error('The CMA went away.');
    }
    await assert.rejects(
      zip.addLines('records', failing()),
      /The CMA went away\./,
    );

    await zip.discard();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.partial`), false);
  });

  it('read a last line without a line feed, and skip empty lines', async () => {
    const path = join(directory, 'dump.zip');
    await writeZip(path, {
      'records/000002.jsonl': '{"id":"c"}',
      'records/000001.jsonl': '{"id":"a"}\n\n{"id":"b"}\n',
      'records-elsewhere/000001.jsonl': '{"id":"not a record"}\n',
    });

    await withReader(path, async (reader) =>
      assert.deepEqual(await valuesOf(reader, 'records'), [
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ]),
    );
  });

  it('report a line that is not JSON as INVALID_DUMP, naming its entry and line', async () => {
    const path = join(directory, 'dump.zip');
    await writeZip(path, {
      'records/000001.jsonl': '{"id":"a"}\n\n{"id": truncated\n{"id":"b"}\n',
    });

    await withReader(path, async (reader) => {
      const values: unknown[] = [];
      await assertUserError(
        (async () => {
          for await (const { value } of reader.lines('records'))
            values.push(value);
        })(),
        'INVALID_DUMP',
        /^Line 3 of records\/000001\.jsonl is not valid JSON/,
      );
      assert.deepEqual(values, [{ id: 'a' }]);
    });
  });
});

describe('openDump', () => {
  useTemporaryDirectory();

  const manifest = (changes: Partial<Record<string, unknown>> = {}) => ({
    format: DUMP_FORMAT,
    version: DUMP_VERSION,
    createdAt: '2026-10-15T09:45:00.000Z',
    pluginVersion: '0.0.0',
    site: { id: 'site', environment: 'main', primary: true },
    locales: ['en'],
    includesAssets: false,
    counts: { records: 1, uploads: 0, uploadCollections: 0 },
    ...changes,
  });
  const schema = {
    site: { data: { id: 'site', attributes: { locales: ['en'] } } },
    workflows: [],
  };

  it('opens a dump, with its manifest, schema and lines', async () => {
    const path = join(directory, 'dump.zip');
    const zip = new ZipWriter(path);
    zip.addJson('schema.json', schema);
    await zip.addLines('records', [{ id: 'a' }]);
    zip.addJson('manifest.json', manifest(), { pretty: true });
    await zip.close();

    const dump = await openDump(path);
    try {
      assert.equal(dump.path, path);
      assert.deepEqual(dump.manifest, manifest() as DumpManifest);
      assert.deepEqual(dump.schema, schema);
      assert.deepEqual(await valuesOf(dump.zip, 'records'), [{ id: 'a' }]);
    } finally {
      dump.zip.close();
    }
  });

  it('refuses a file that is not a zip as INVALID_DUMP', async () => {
    const path = join(directory, 'notes.txt');
    await writeFile(path, 'Just some notes.\n');
    await assertUserError(
      openDump(path),
      'INVALID_DUMP',
      /notes\.txt is not a dump written by content:export: it is not a readable zip/,
    );
  });

  it('refuses a zip without manifest.json or without schema.json as INVALID_DUMP', async () => {
    const withoutManifest = join(directory, 'without-manifest.zip');
    await writeZip(withoutManifest, { 'schema.json': JSON.stringify(schema) });
    await assertUserError(
      openDump(withoutManifest),
      'INVALID_DUMP',
      /it has no manifest\.json or schema\.json/,
    );

    const withoutSchema = join(directory, 'without-schema.zip');
    await writeZip(withoutSchema, {
      'manifest.json': JSON.stringify(manifest()),
    });
    await assertUserError(
      openDump(withoutSchema),
      'INVALID_DUMP',
      /it has no manifest\.json or schema\.json/,
    );
  });

  it('refuses a manifest of another format or version as INVALID_DUMP', async () => {
    for (const [name, changes] of [
      ['other-format', { format: 'some-other-backup' }],
      ['other-version', { version: DUMP_VERSION + 1 }],
    ] as const) {
      const path = join(directory, `${name}.zip`);
      await writeZip(path, {
        'manifest.json': JSON.stringify(manifest(changes)),
        'schema.json': JSON.stringify(schema),
      });
      await assertUserError(
        openDump(path),
        'INVALID_DUMP',
        /its manifest is not one of a version 1 datocms-project-dump/,
      );
    }
  });

  it('refuses a manifest that is not JSON as INVALID_DUMP', async () => {
    const path = join(directory, 'damaged.zip');
    await writeZip(path, {
      'manifest.json': '{"format":',
      'schema.json': JSON.stringify(schema),
    });
    await assertUserError(
      openDump(path),
      'INVALID_DUMP',
      /its manifest or schema is not valid JSON/,
    );
  });
});
