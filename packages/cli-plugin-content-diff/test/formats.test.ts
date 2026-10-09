import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'mocha';
import {
  canonicalCollection,
  canonicalRecord,
  canonicalUpload,
} from '../src/engine/codec';
import { DiffFile, writeDiff } from '../src/engine/diff-file';
import { DumpFile, writeDump } from '../src/engine/dump';
import { assetEntryName, originalFileUrl } from '../src/engine/emit';
import type { Operation } from '../src/engine/operations';
import { readRawSchema, schemaFromRaw } from '../src/engine/schema';
import { SideIndex } from '../src/engine/side';
import { SpillFiles, bucketOf } from '../src/engine/spill';
import type { Client, JsonObject, SchemaState } from '../src/engine/types';
import { ZipReader, ZipWriter } from '../src/engine/zip';
import { withBulkSchema } from './bulk-schema-fixture';
import { fixtureId as id } from './fixture-id';

const PLUGIN_VERSION: string = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8'),
).version;
const MODEL = id('formats-model');
const PUBLISHED_AT = '2025-02-01T00:00:00.000Z';
const md5 = (bytes: string) => createHash('md5').update(bytes).digest('hex');

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

async function text(zip: ZipReader, name: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await zip.stream(name)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function entries(path: string): Promise<string[]> {
  const zip = await ZipReader.open(path);
  zip.close();
  return [...zip.entries.keys()].sort();
}

/** Copies a zip, replacing the entries in `changes` or, with null, leaving them out. */
async function rewrite(
  from: string,
  to: string,
  changes: Record<string, string | null>,
): Promise<string> {
  const source = await ZipReader.open(from);
  const copy = new ZipWriter(to);
  try {
    for (const name of source.entries.keys())
      if (!Object.hasOwn(changes, name))
        copy.addStream(name, () => source.stream(name));
    for (const [name, contents] of Object.entries(changes))
      if (contents !== null) copy.addBuffer(name, contents);
    await copy.close();
  } finally {
    source.close();
  }
  return to;
}

/** A record as the CMA returns it. */
function rawRecord(
  name: string,
  attributes: JsonObject = {},
  meta: JsonObject = {},
) {
  return {
    id: id(name),
    type: 'item',
    attributes: { title: name, related: [], image: null, ...attributes },
    relationships: { item_type: { data: { id: MODEL, type: 'item_type' } } },
    meta: {
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      published_at: null,
      first_published_at: null,
      publication_scheduled_at: null,
      unpublishing_scheduled_at: null,
      current_version: `v-${name}`,
      stage: null,
      ...meta,
    },
  };
}

/** An upload as the SDK's `uploads.list` returns it. */
function rawUpload(name: string, bytes: string, folder?: string) {
  return {
    id: id(name),
    type: 'upload',
    filename: `${name}.svg`,
    basename: name,
    format: 'svg',
    md5: md5(bytes),
    size: bytes.length,
    url: `https://assets.example.test/${name}.svg`,
    upload_collection: folder
      ? { id: id(folder), type: 'upload_collection' }
      : null,
    author: null,
    copyright: null,
    notes: null,
    tags: [],
  };
}

const rawFolder = (name: string, position: number) => ({
  id: id(name),
  type: 'upload_collection',
  label: name,
  position,
  parent: null,
  children: [],
});

/**
 * A project with one model, a draft, a published and a scheduled record,
 * two uploads (one in a folder) and the files their URLs serve.
 */
function project() {
  const at = (day: number) => `2099-01-0${day}T00:00:00.000Z`;
  const current = [
    rawRecord('draft'),
    rawRecord(
      'live',
      { title: 'Live draft' },
      { published_at: PUBLISHED_AT, first_published_at: PUBLISHED_AT },
    ),
    rawRecord(
      'scheduled',
      {},
      {
        publication_scheduled_at: at(1),
        unpublishing_scheduled_at: at(2),
      },
    ),
  ];
  const published = [
    rawRecord(
      'live',
      { title: 'Live published' },
      { updated_at: PUBLISHED_AT, published_at: PUBLISHED_AT },
    ),
  ];
  const schedules = {
    publication: {
      id: 'scheduled-publication',
      type: 'scheduled_publication',
      attributes: {
        publication_scheduled_at: at(1),
        selective_publication: null,
      },
    },
    unpublishing: {
      id: 'scheduled-unpublishing',
      type: 'scheduled_unpublishing',
      attributes: {
        unpublishing_scheduled_at: at(2),
        content_in_locales: null,
      },
    },
  };
  const bytes = new Map([
    ['logo', '<svg>logo</svg>'],
    ['photo', '<svg>photo</svg>'],
  ]);
  const uploads = [
    rawUpload('logo', bytes.get('logo')!, 'media'),
    rawUpload('photo', bytes.get('photo')!),
  ];
  const folders = [rawFolder('media', 1)];
  const client = withBulkSchema({
    site: {
      find: async () => ({
        id: 'site',
        type: 'site',
        locales: ['en'],
        timezone: 'UTC',
        meta: {},
      }),
    },
    itemTypes: {
      list: async () => [
        {
          id: MODEL,
          type: 'item_type',
          api_key: 'article',
          name: 'Article',
          modular_block: false,
          singleton: false,
          sortable: false,
          tree: false,
          draft_mode_active: true,
          draft_saving_active: false,
          all_locales_required: false,
          workflow: null,
        },
      ],
    },
    fields: {
      list: async () =>
        [
          ['title', 'string'],
          ['related', 'links'],
          ['image', 'file'],
        ].map(([apiKey, type]) => ({
          id: id(`formats-${apiKey}`),
          type: 'field',
          api_key: apiKey,
          field_type: type,
          localized: false,
          validators: {},
          default_value: null,
        })),
    },
    workflows: { list: async () => [] },
    users: { findMe: async () => ({ type: 'account' }) },
    async request(request: {
      method: string;
      url: string;
      queryParams: {
        filter: { type?: string; ids?: string };
        version: 'current' | 'published';
        page: { offset?: number; limit: number };
      };
    }) {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/items');
      const { filter, version, page } = request.queryParams;
      const rows = (version === 'current' ? current : published).filter(
        (row) =>
          filter.ids
            ? filter.ids.split(',').includes(row.id)
            : row.relationships.item_type.data.id === filter.type,
      );
      const offset = page.offset ?? 0;
      return {
        data: rows.slice(offset, offset + page.limit),
        meta: { total_count: rows.length },
      };
    },
    items: {
      async rawCurrentVsPublishedState(recordId: string) {
        assert.equal(recordId, id('scheduled'));
        return {
          data: {
            relationships: {
              scheduled_publication: {
                data: { id: schedules.publication.id },
              },
              scheduled_unpublishing: {
                data: { id: schedules.unpublishing.id },
              },
            },
          },
          included: [schedules.publication, schedules.unpublishing],
        };
      },
    },
    uploads: {
      rawList: async () => ({
        data: uploads.slice(0, 1),
        meta: { total_count: uploads.length },
      }),
      list: async (query: { page: { offset: number; limit: number } }) =>
        uploads.slice(query.page.offset, query.page.offset + query.page.limit),
    },
    uploadCollections: { list: async () => folders },
  } as unknown as Client);
  return { client, current, published, schedules, uploads, folders, bytes };
}

describe('content formats', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-formats-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('spill files', () => {
    it('reads the lines of each file back across flushes, one gzip member per flush', async () => {
      const spill = new SpillFiles(join(directory, 'spill'));
      await spill.append(0, '{"n":1}');
      await spill.append(1, '{"n":2}');
      await spill.append(0, '{"n":3}');
      // Lines are buffered until a flush writes them.
      assert.deepEqual(await collect(spill.lines(0)), []);
      const first = spill.flush();
      await spill.append(0, '{"n":4}');
      // Flushes write one after another, in the order they were asked for.
      await Promise.all([spill.flush(), first]);
      assert.deepEqual(await collect(spill.lines(0)), [
        '{"n":1}',
        '{"n":3}',
        '{"n":4}',
      ]);
      assert.deepEqual(await collect(spill.lines(1)), ['{"n":2}']);
      const raw = await readFile(join(directory, 'spill', '0.jsonl.gz'));
      const member = gzipSync('{"n":1}\n{"n":3}\n');
      assert.deepEqual(raw.subarray(0, member.length), member);
      assert.equal(
        gunzipSync(raw).toString('utf8'),
        '{"n":1}\n{"n":3}\n{"n":4}\n',
      );
    });

    it('reads a line holding line and paragraph separators whole', async () => {
      const spill = new SpillFiles(join(directory, 'spill'));
      const line = JSON.stringify({ title: 'a\u2028b\u2029c\rd' });
      await spill.append(0, line);
      await spill.flush();
      assert.deepEqual(await collect(spill.lines(0)), [line]);
    });

    it('creates its directory, writes nothing for an empty flush and reads nothing from an unwritten file', async () => {
      const spill = new SpillFiles(join(directory, 'nested', 'spill'));
      await spill.flush();
      assert.deepEqual(await readdir(join(directory, 'nested', 'spill')), []);
      assert.deepEqual(await collect(spill.lines(7)), []);
    });

    it('buckets IDs with 32-bit FNV-1a, always within range', () => {
      assert.equal(bucketOf('', 2 ** 32), 0x811c9dc5);
      // FNV-1a of "a" sets the sign bit, which must not make a bucket negative.
      assert.equal(bucketOf('a', 2 ** 32), 0xe40c292c);
      assert.equal(bucketOf('foobar', 2 ** 32), 0xbf9cf968);
      assert.equal(bucketOf('a', 1000), 0xe40c292c % 1000);
      for (const buckets of [1, 7, 1024])
        for (let index = 0; index < 200; index++) {
          const bucket = bucketOf(id(`bucket-${index}`), buckets);
          assert.ok(
            Number.isInteger(bucket) && bucket >= 0 && bucket < buckets,
          );
          assert.equal(bucketOf(id(`bucket-${index}`), buckets), bucket);
        }
    });
  });

  describe('zip files', () => {
    it('splits JSON lines entries by UTF-8 bytes', async () => {
      const path = join(directory, 'bytes.zip');
      const zip = new ZipWriter(path);
      // Each line is 3 + 2 bytes, but its emoji counts as 2 characters.
      const lines = zip.jsonLines('lines', 10);
      for (const value of ['😀', '😀', '😀']) await lines.write(value);
      lines.end();
      await zip.close();
      const reader = await ZipReader.open(path);
      try {
        assert.deepEqual(reader.names('lines'), [
          'lines/000001.jsonl',
          'lines/000002.jsonl',
          'lines/000003.jsonl',
        ]);
      } finally {
        reader.close();
      }
    });

    it('writes buffers, streams and JSON lines, publishing the zip only once complete', async () => {
      const path = join(directory, 'round-trip.zip');
      const zip = new ZipWriter(path);
      zip.addBuffer('notes/b.txt', 'second');
      zip.addBuffer('notes/a.txt', 'first');
      zip.addBuffer('notes-other/c.txt', 'other');
      const lines = zip.jsonLines('lines');
      await lines.write({ n: 1 });
      await lines.write('two');
      lines.end();
      zip.addStream('streamed.bin', async () =>
        Readable.from([Buffer.from('chunk-1'), Buffer.from('chunk-2')]),
      );
      zip.addBuffer('data.json', '{"__proto__":{"safe":true}}');
      assert.equal(existsSync(path), false);
      assert.ok(
        (await readdir(directory)).some((name) =>
          name.startsWith('round-trip.zip.partial-'),
        ),
      );
      await zip.close();
      assert.equal(lines.count, 2);
      assert.deepEqual(await readdir(directory), ['round-trip.zip']);
      const reader = await ZipReader.open(path);
      try {
        assert.deepEqual(reader.names('notes'), ['notes/a.txt', 'notes/b.txt']);
        assert.deepEqual(reader.names('lines'), ['lines/000001.jsonl']);
        assert.equal(await text(reader, 'notes/a.txt'), 'first');
        assert.equal(await text(reader, 'streamed.bin'), 'chunk-1chunk-2');
        const data = (await reader.json('data.json')) as object;
        assert.ok(Object.hasOwn(data, '__proto__'));
        assert.equal(JSON.stringify(data), '{"__proto__":{"safe":true}}');
        assert.deepEqual(await collect(reader.lines('lines')), [
          { entry: 'lines/000001.jsonl', line: 1, value: { n: 1 } },
          { entry: 'lines/000001.jsonl', line: 2, value: 'two' },
        ]);
      } finally {
        reader.close();
      }
    });

    it('starts a new JSON lines entry before one would exceed its size', async () => {
      const path = join(directory, 'rollover.zip');
      const zip = new ZipWriter(path);
      const limit = 1024;
      const lines = zip.jsonLines('operations', limit);
      // With its quotes and newline, this line fills an entry exactly.
      await lines.write('x'.repeat(limit - 3));
      await lines.write({ n: 1 });
      await lines.write({ n: 2 });
      lines.end();
      await zip.close();
      const reader = await ZipReader.open(path);
      try {
        assert.deepEqual(reader.names('operations'), [
          'operations/000001.jsonl',
          'operations/000002.jsonl',
        ]);
        const read = await collect(reader.lines('operations'));
        assert.deepEqual(
          read.map(({ entry, line, value }) => [
            entry,
            line,
            typeof value === 'string' ? value.length : value,
          ]),
          [
            ['operations/000001.jsonl', 1, limit - 3],
            ['operations/000002.jsonl', 1, { n: 1 }],
            ['operations/000002.jsonl', 2, { n: 2 }],
          ],
        );
      } finally {
        reader.close();
      }
    });

    it('reads JSON lines holding line and paragraph separators whole', async () => {
      const path = join(directory, 'separators.zip');
      const zip = new ZipWriter(path);
      const lines = zip.jsonLines('lines');
      const value = { title: 'a\u2028b\u2029c\rd' };
      await lines.write(value);
      await lines.write({ n: 2 });
      lines.end();
      await zip.close();
      const reader = await ZipReader.open(path);
      try {
        assert.deepEqual(await collect(reader.lines('lines')), [
          { entry: 'lines/000001.jsonl', line: 1, value },
          { entry: 'lines/000001.jsonl', line: 2, value: { n: 2 } },
        ]);
      } finally {
        reader.close();
      }
    });

    it('never replaces a file, even one that appears while the zip is written', async () => {
      const taken = join(directory, 'taken.zip');
      await writeFile(taken, 'existing');
      const first = new ZipWriter(taken);
      first.addBuffer('a.txt', 'a');
      await assert.rejects(first.close(), {
        code: 'OUTPUT_EXISTS',
        message: `${taken} already exists. Choose another name.`,
      });
      const later = join(directory, 'later.zip');
      const second = new ZipWriter(later);
      second.addBuffer('a.txt', 'a');
      await writeFile(later, 'appeared');
      await assert.rejects(second.close(), { code: 'OUTPUT_EXISTS' });
      assert.equal(await readFile(taken, 'utf8'), 'existing');
      assert.equal(await readFile(later, 'utf8'), 'appeared');
      assert.deepEqual(await readdir(directory), ['later.zip', 'taken.zip']);
    });

    it('discards an unfinished zip with its temporary file', async () => {
      const zip = new ZipWriter(join(directory, 'discarded.zip'));
      const lines = zip.jsonLines('lines');
      await lines.write({ n: 1 });
      await zip.discard();
      assert.deepEqual(await readdir(directory), []);
      assert.throws(() => zip.addBuffer('late.txt', 'late'), /discarded/);
    });

    it('refuses missing entries, and entries and lines that are not JSON', async () => {
      const path = join(directory, 'invalid.zip');
      const zip = new ZipWriter(path);
      zip.addBuffer('broken.json', '{');
      zip.addBuffer('lines/000001.jsonl', '{"n":1}\n\n{\n');
      await zip.close();
      const reader = await ZipReader.open(path);
      try {
        await assert.rejects(reader.json('missing.json'), {
          code: 'INVALID_ZIP',
          message: 'The zip has no entry missing.json.',
        });
        await assert.rejects(reader.json('broken.json'), {
          code: 'INVALID_ZIP',
          message: 'broken.json is not valid JSON.',
        });
        const read: unknown[] = [];
        await assert.rejects(
          async () => {
            for await (const { value } of reader.lines('lines'))
              read.push(value);
          },
          {
            code: 'INVALID_ZIP',
            message: 'Line 3 of lines/000001.jsonl is not valid JSON.',
          },
        );
        assert.deepEqual(read, [{ n: 1 }]);
      } finally {
        reader.close();
      }
    });
  });

  describe('side indexes', () => {
    let schema: SchemaState;
    beforeEach(async () => {
      schema = schemaFromRaw(await readRawSchema(project().client), 'source');
    });
    const file = (upload: string, customData: JsonObject = {}) => ({
      upload_id: id(upload),
      alt: null,
      title: null,
      custom_data: customData,
      focal_point: null,
    });

    it('keeps the facts planning needs in memory and full states in bucket files', async () => {
      const index = new SideIndex(join(directory, 'side'), schema, 4, {
        models: new Set([MODEL]),
        payloadSchema: schema,
      });
      const linked = canonicalRecord(
        rawRecord(
          'linked',
          { related: [id('target'), id('target')], image: file('picture') },
          { is_current_version_valid: false },
        ),
        rawRecord(
          'linked',
          { related: [id('target')], image: file('picture') },
          { updated_at: PUBLISHED_AT },
        ),
        schema,
      );
      const untitled = canonicalRecord(
        rawRecord('untitled', {
          title: null,
          image: file('picture', { __itemTypeId: 'kept as data' }),
        }),
        null,
        schema,
      );
      const upload = canonicalUpload(rawUpload('picture', 'bytes', 'media'));
      const folder = canonicalCollection(rawFolder('media', 1));
      await index.record(linked);
      await index.record(untitled);
      await index.upload(upload);
      await index.collection(folder);
      await index.flush();

      const field = (apiKey: string) => id(`formats-${apiKey}`);
      const facts = {
        id: linked.id,
        modelId: MODEL,
        hash: linked.hash,
        published: true,
        parentId: null,
        position: null,
        invalid: { current: true, published: false },
        title: 'linked',
        references: [] as unknown[],
        bytes: JSON.stringify(linked).length,
      };
      // References are read for the records a plan changes; every record of
      // a selected model names the uploads it references.
      assert.deepEqual(index.records.get(linked.id), facts);
      assert.deepEqual([...index.referencedUploads], [id('picture')]);
      assert.equal(index.records.get(untitled.id)!.unsupportedKeys, undefined);
      await index.loadDetails([linked.id, untitled.id]);
      assert.deepEqual(index.records.get(linked.id), {
        ...facts,
        // One fact per target, kind and field, however often it is linked.
        references: [
          {
            targetId: id('target'),
            kind: 'current',
            root: 'related',
            fieldId: field('related'),
          },
          {
            targetId: id('picture'),
            kind: 'upload',
            root: 'image',
            fieldId: field('image'),
          },
          {
            targetId: id('target'),
            kind: 'published',
            root: 'related',
            fieldId: field('related'),
          },
        ],
      });
      const untitledFacts = index.records.get(untitled.id)!;
      assert.equal(untitledFacts.title, undefined);
      assert.equal(untitledFacts.published, false);
      assert.deepEqual(untitledFacts.unsupportedKeys, ['__itemTypeId']);
      assert.deepEqual(index.uploads.get(upload.id), {
        id: upload.id,
        hash: upload.hash,
        md5: md5('bytes'),
        size: 5,
        collectionId: id('media'),
        filename: 'picture.svg',
      });
      assert.deepEqual(index.collections.get(folder.id), folder);

      const states = new Map<string, unknown>();
      const uploads = new Map<string, unknown>();
      for (let bucket = 0; bucket < 4; bucket++) {
        for (const [key, state] of await index.recordBucket(bucket)) {
          assert.equal(bucketOf(key, 4), bucket);
          states.set(key, state);
        }
        for (const [key, state] of await index.uploadBucket(bucket)) {
          assert.equal(bucketOf(key, 4), bucket);
          uploads.set(key, state);
        }
      }
      assert.deepEqual(
        states,
        new Map([
          [linked.id, linked],
          [untitled.id, untitled],
        ]),
      );
      assert.deepEqual(uploads, new Map([[upload.id, upload]]));
    });

    it('checks payloads only of the selected models', async () => {
      const index = new SideIndex(join(directory, 'side'), schema, 4);
      const state = canonicalRecord(
        rawRecord('unchecked', {
          image: file('picture', { __itemTypeId: 'kept as data' }),
        }),
        null,
        schema,
      );
      await index.record(state);
      await index.flush();
      await index.loadDetails([state.id]);
      assert.equal(index.records.get(state.id)!.unsupportedKeys, undefined);
      assert.deepEqual([...index.referencedUploads], []);
    });

    it('reads only the wanted records of a bucket', async () => {
      const index = new SideIndex(join(directory, 'side'), schema, 1);
      const kept = canonicalRecord(rawRecord('kept'), null, schema);
      const skipped = canonicalRecord(rawRecord('skipped'), null, schema);
      await index.record(kept);
      await index.record(skipped);
      await index.flush();
      assert.deepEqual(
        [...(await index.recordBucket(0, new Set([kept.id]))).keys()],
        [kept.id],
      );
      assert.equal((await index.recordBucket(0)).size, 2);
    });

    it('keeps each side in its own files, reads both at once and keeps own __proto__ keys as data', async () => {
      const value = JSON.parse('{"__proto__":{"safe":true}}');
      const source = new SideIndex(join(directory, 'source'), schema, 2);
      const target = new SideIndex(join(directory, 'target'), schema, 2);
      const before = canonicalRecord(rawRecord('shared'), null, schema);
      const after = canonicalRecord(
        rawRecord('shared', { image: file('picture', value) }),
        null,
        schema,
      );
      await source.record(after);
      await target.record(before);
      await Promise.all([source.flush(), target.flush()]);
      const bucket = bucketOf(before.id, 2);
      const [sources, targets] = await Promise.all([
        source.recordBucket(bucket),
        target.recordBucket(bucket),
      ]);
      assert.equal(sources.get(after.id)!.hash, after.hash);
      assert.equal(targets.get(before.id)!.hash, before.hash);
      const data = (sources.get(after.id)!.current.image as JsonObject)
        .custom_data as object;
      assert.ok(Object.hasOwn(data, '__proto__'));
      assert.equal(JSON.stringify(data), JSON.stringify(value));
    });
  });

  describe('diff files', () => {
    const zero = { create: 0, update: 0, delete: 0, noop: 0, skip: 0 };
    const tracking = { apiKey: 'schema_migration', model: null };
    const manifest = {
      includesAssets: false,
      source: {
        kind: 'environment' as const,
        siteId: 'site',
        environmentId: 'source',
      },
      destination: { siteId: 'site', environmentId: 'target' },
      schemaHash: 'schema-hash',
      sourceTracking: tracking,
      destinationTracking: tracking,
      options: {
        modelIds: [MODEL],
        uploads: 'all' as const,
        includeDeletions: true,
        allowPartial: false,
      },
      counts: {
        record: { ...zero, update: 1 },
        upload: zero,
        collection: zero,
      },
    };
    const update: Operation = {
      op: 'record.update',
      id: id('record'),
      label: 'Update Article "After" (record)',
      expect: { currentVersion: 'v-record', publishedUpdatedAt: null },
      data: { title: 'After', meta: { current_version: 'v-record' } },
    };
    const write = (path: string, operations: Operation[], files?: ZipReader) =>
      writeDiff({
        path,
        manifest,
        operations: (async function* () {
          yield* operations;
        })(),
        files,
      });

    it('writes its operations and a manifest, and reads them back in order with their place', async () => {
      const path = join(directory, 'change.diff-records.zip');
      const operations: Operation[] = [
        update,
        { op: 'record.publish', id: id('record'), label: 'Publish' },
        {
          op: 'folder.update',
          id: id('folder'),
          label: 'Update folder',
          expect: { hash: 'folder-hash' },
          data: JSON.parse('{"__proto__":{"safe":true},"label":"Media"}'),
        },
        { op: 'folders.reorder', label: 'Reorder folders', data: [] },
      ];
      assert.equal(await write(path, operations), 4);
      assert.deepEqual(await entries(path), [
        'manifest.json',
        'operations/000001.jsonl',
      ]);
      const diff = await DiffFile.open(path);
      try {
        assert.deepEqual(diff.manifest, {
          format: 'datocms-content-diff',
          version: 1,
          createdAt: diff.manifest.createdAt,
          pluginVersion: PLUGIN_VERSION,
          ...manifest,
          operations: 4,
        });
        assert.equal(
          new Date(diff.manifest.createdAt).toISOString(),
          diff.manifest.createdAt,
        );
        const read = await collect(diff.operations());
        assert.deepEqual(
          read.map(({ where }) => where),
          [1, 2, 3, 4].map((line) => `operations/000001.jsonl line ${line}`),
        );
        assert.equal(
          JSON.stringify(read.map(({ operation }) => operation)),
          JSON.stringify(operations),
        );
        assert.ok(
          Object.hasOwn(read[2]!.operation.data as object, '__proto__'),
        );
      } finally {
        diff.close();
      }
    });

    it('refuses a file that is not a version 1 diff with its destination, schema and counts', async () => {
      const valid = join(directory, 'valid.zip');
      await write(valid, [update]);
      const reader = await ZipReader.open(valid);
      const raw = (await reader.json('manifest.json')) as Record<
        string,
        unknown
      >;
      reader.close();
      const notZip = join(directory, 'not-a-zip.zip');
      await writeFile(notZip, 'not a zip');
      await assert.rejects(DiffFile.open(notZip), {
        code: 'INVALID_DIFF',
        message: new RegExp(`^${notZip} is not a readable zip: `),
      });
      const changed = (name: string, manifest: unknown) =>
        rewrite(valid, join(directory, `${name}.zip`), {
          'manifest.json': manifest === null ? null : JSON.stringify(manifest),
        });
      const missing = await changed('missing', null);
      await assert.rejects(DiffFile.open(missing), {
        code: 'INVALID_DIFF',
        message: `${missing} is not a version 1 content diff.`,
      });
      for (const [name, manifest] of [
        ['format', { ...raw, format: 'datocms-project-dump' }],
        ['version', { ...raw, version: 2 }],
        ['array', [raw]],
      ] as Array<[string, unknown]>)
        await assert.rejects(
          DiffFile.open(await changed(name, manifest)),
          {
            code: 'INVALID_DIFF',
            message: `${join(
              directory,
              `${name}.zip`,
            )} is not a version 1 content diff.`,
          },
          name,
        );
      for (const key of [
        'destination',
        'schemaHash',
        'destinationTracking',
        'counts',
      ]) {
        const { [key]: _removed, ...rest } = raw;
        await assert.rejects(
          DiffFile.open(await changed(key, rest)),
          {
            code: 'INVALID_DIFF',
            message:
              'The diff manifest is missing its destination, schema or counts.',
          },
          key,
        );
      }
      await assert.rejects(
        DiffFile.open(
          await changed('environment', {
            ...raw,
            destination: { siteId: 'site' },
          }),
        ),
        { code: 'INVALID_DIFF' },
      );
    });

    it('refuses, line by line, what is not a known operation with the fields it needs', async () => {
      const asset = assetEntryName(id('upload'), 'logo.svg');
      const valid = join(directory, 'valid.zip');
      await write(valid, [update]);
      const upload = {
        id: id('upload'),
        label: 'Create asset',
        md5: md5('bytes'),
        data: {},
      };
      const record = { id: id('record'), label: 'Record' };
      const recordExpect = { currentVersion: null, publishedUpdatedAt: null };
      const accepted = [
        { op: 'upload.create', ...upload, url: 'https://assets.example.test' },
        { op: 'upload.replace', ...upload, file: asset, expect: { hash: 'h' } },
        {
          op: 'folder.delete',
          id: id('folder'),
          label: 'F',
          expect: { hash: 'h' },
        },
        { op: 'schedule.publication.delete', ...record, expect: recordExpect },
        { op: 'record.unpublish', ...record, expect: recordExpect },
        { op: 'records.reorder', label: 'Reorder', data: { order: [] } },
      ];
      const refused: Array<[unknown, string]> = [
        [[], 'expected an operation object.'],
        [
          { op: 'record.explode', label: 'x' },
          'unknown operation "record.explode".',
        ],
        [{ label: 'x' }, 'unknown operation undefined.'],
        [
          { op: 'record.publish', id: id('record') },
          '"label" must be a string.',
        ],
        [
          { op: 'record.update', label: 'x', data: {} },
          '"id" must be a DatoCMS ID.',
        ],
        [
          { op: 'record.update', id: '', label: 'x', data: {} },
          '"id" must be a DatoCMS ID.',
        ],
        // IDs go into request paths: nothing can reach another endpoint.
        [
          { op: 'record.delete', id: '../environments/main', label: 'x' },
          '"id" must be a DatoCMS ID.',
        ],
        [
          { op: 'upload.delete', id: 'a?b=1', label: 'x' },
          '"id" must be a DatoCMS ID.',
        ],
        [
          { op: 'record.create', ...record, data: [] },
          '"data" must be an object.',
        ],
        [
          { op: 'folders.reorder', label: 'x', data: {} },
          '"data" must be an array.',
        ],
        [
          { op: 'upload.create', ...upload, md5: undefined, url: 'https://x' },
          '"md5" must be a string.',
        ],
        [
          { op: 'upload.replace', ...upload },
          '"file" or "url" must be a string.',
        ],
        [
          { op: 'upload.create', ...upload, file: 'assets/missing/logo.svg' },
          'the diff has no file assets/missing/logo.svg.',
        ],
        [
          { op: 'record.update', ...record, data: {}, expect: { hash: 'h' } },
          '"expect" does not fit the operation.',
        ],
        [
          {
            op: 'record.delete',
            ...record,
            expect: { currentVersion: 1, publishedUpdatedAt: null },
          },
          '"expect" does not fit the operation.',
        ],
        [
          { op: 'upload.update', ...upload, expect: recordExpect },
          '"expect" does not fit the operation.',
        ],
        [
          { op: 'record.create', ...record, data: {}, expect: recordExpect },
          '"expect" does not fit the operation.',
        ],
        [
          {
            op: 'folder.create',
            id: id('folder'),
            label: 'F',
            data: {},
            expect: { hash: 'h' },
          },
          '"expect" does not fit the operation.',
        ],
      ];
      const lines = (values: unknown[]) =>
        values.map((value) => `${JSON.stringify(value)}\n`).join('');
      const path = await rewrite(valid, join(directory, 'accepted.zip'), {
        'operations/000001.jsonl': lines(accepted),
        [asset]: 'bytes',
      });
      const diff = await DiffFile.open(path);
      try {
        assert.equal(
          (await collect(diff.operations())).length,
          accepted.length,
        );
      } finally {
        diff.close();
      }
      for (const [index, [line, problem]] of refused.entries()) {
        const path = await rewrite(valid, join(directory, `${index}.zip`), {
          'operations/000001.jsonl': lines([update, line]),
        });
        const diff = await DiffFile.open(path);
        const read: unknown[] = [];
        try {
          const where = 'operations/000001.jsonl line 2';
          await assert.rejects(
            async () => {
              for await (const { operation } of diff.operations())
                read.push(operation);
            },
            {
              code: 'INVALID_DIFF',
              message: `${where}: ${problem}`,
              details: { where },
            },
            problem,
          );
          assert.deepEqual(read, [update]);
        } finally {
          diff.close();
        }
      }
    });

    it('copies the asset files its operations upload from the source zip, and only those', async () => {
      const source = join(directory, 'source.dump-records-assets.zip');
      const logo = assetEntryName(id('logo'), 'nested/logo\\name.svg');
      assert.equal(logo, `assets/${id('logo')}/nested_logo_name.svg`);
      const dump = new ZipWriter(source);
      dump.addBuffer(logo, '<svg>logo</svg>');
      dump.addBuffer(assetEntryName(id('other'), 'other.svg'), '<svg/>');
      await dump.close();
      const files = await ZipReader.open(source);
      try {
        const create: Operation = {
          op: 'upload.create',
          id: id('logo'),
          label: 'Create asset',
          file: logo,
          md5: md5('<svg>logo</svg>'),
          data: { filename: 'logo.svg', upload_collection: null },
        };
        const path = join(directory, 'change.diff-records-assets.zip');
        await write(path, [create], files);
        assert.deepEqual(await entries(path), [
          logo,
          'manifest.json',
          'operations/000001.jsonl',
        ]);
        const diff = await DiffFile.open(path);
        try {
          assert.equal(await text(diff.zip, logo), '<svg>logo</svg>');
          assert.deepEqual(await collect(diff.operations()), [
            { operation: create, where: 'operations/000001.jsonl line 1' },
          ]);
        } finally {
          diff.close();
        }
        const missing = { ...create, file: 'assets/missing/logo.svg' };
        for (const from of [files, undefined])
          await assert.rejects(
            write(join(directory, 'missing.zip'), [missing], from),
            {
              code: 'INVALID_DUMP',
              message: 'The source dump has no file assets/missing/logo.svg.',
            },
          );
        assert.deepEqual((await readdir(directory)).sort(), [
          'change.diff-records-assets.zip',
          'source.dump-records-assets.zip',
        ]);
      } finally {
        files.close();
      }
    });

    it('leaves nothing behind when its operations fail, and never replaces a file', async () => {
      const failure = new Error('planning failed');
      await assert.rejects(
        writeDiff({
          path: join(directory, 'failed.zip'),
          manifest,
          operations: (async function* () {
            yield update;
            throw failure;
          })(),
        }),
        (error) => error === failure,
      );
      assert.deepEqual(await readdir(directory), []);
      const taken = join(directory, 'taken.zip');
      await writeFile(taken, 'existing');
      await assert.rejects(write(taken, [update]), { code: 'OUTPUT_EXISTS' });
      assert.equal(await readFile(taken, 'utf8'), 'existing');
      assert.deepEqual(await readdir(directory), ['taken.zip']);
    });
  });

  describe('project dumps', () => {
    const originalFetch = globalThis.fetch;
    let requested: string[];
    /** Serves each asset URL from `files`, or a 404. */
    const serve = (files: Map<string, string>) => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        const body = files.get(url);
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(body);
      }) as typeof fetch;
    };
    const assetFiles = (fixture: ReturnType<typeof project>) =>
      new Map(
        fixture.uploads.map((upload) => [
          originalFileUrl(upload.url),
          fixture.bytes.get(upload.basename)!,
        ]),
      );
    beforeEach(() => {
      requested = [];
      serve(new Map());
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });
    const dump = (
      fixture: ReturnType<typeof project>,
      path: string,
      includeAssets: boolean,
    ) =>
      writeDump({
        client: fixture.client,
        environmentId: 'main',
        primary: true,
        path,
        includeAssets,
        options: { concurrency: 2 },
      });

    it('exports the schema, every record with its published version and schedules, uploads, folders and asset files', async () => {
      const fixture = project();
      serve(assetFiles(fixture));
      const path = join(directory, 'project.dump-records-assets.zip');
      const manifest = await dump(fixture, path, true);
      assert.deepEqual(manifest, {
        format: 'datocms-project-dump',
        version: 1,
        createdAt: manifest.createdAt,
        pluginVersion: PLUGIN_VERSION,
        site: { id: 'site', environment: 'main', primary: true },
        locales: ['en'],
        includesAssets: true,
        counts: { records: 3, uploads: 2, uploadCollections: 1 },
      });
      assert.deepEqual(
        requested.sort(),
        fixture.uploads.map((upload) => originalFileUrl(upload.url)).sort(),
      );
      const assets = fixture.uploads.map((upload) =>
        assetEntryName(upload.id, upload.filename),
      );
      assert.deepEqual(
        await entries(path),
        [
          ...assets,
          'manifest.json',
          'records/000001.jsonl',
          'schema.json',
          'upload-collections/000001.jsonl',
          'uploads/000001.jsonl',
        ].sort(),
      );
      const file = await DumpFile.open(path);
      try {
        assert.deepEqual(file.manifest, manifest);
        const raw = await readRawSchema(fixture.client);
        assert.deepEqual(await file.zip.json('schema.json'), raw);
        assert.deepEqual(file.schema, schemaFromRaw(raw, 'main'));
        const read: unknown[] = [];
        await file.read({
          record: async (line) => void read.push(['record', line]),
          upload: async (upload) => void read.push(['upload', upload]),
          collection: async (folder) => void read.push(['collection', folder]),
        });
        const [draft, live, scheduled] = fixture.current;
        assert.deepEqual(read, [
          [
            'record',
            {
              id: draft!.id,
              current: draft,
              published: null,
              scheduledPublication: null,
              scheduledUnpublishing: null,
            },
          ],
          [
            'record',
            {
              id: live!.id,
              current: live,
              published: fixture.published[0],
              scheduledPublication: null,
              scheduledUnpublishing: null,
            },
          ],
          [
            'record',
            {
              id: scheduled!.id,
              current: scheduled,
              published: null,
              scheduledPublication: fixture.schedules.publication,
              scheduledUnpublishing: fixture.schedules.unpublishing,
            },
          ],
          ...fixture.uploads.map((upload) => ['upload', upload]),
          ...fixture.folders.map((folder) => ['collection', folder]),
        ]);
        for (const upload of fixture.uploads)
          assert.equal(
            await text(file.zip, assetEntryName(upload.id, upload.filename)),
            fixture.bytes.get(upload.basename),
          );
      } finally {
        file.close();
      }
    });

    it('downloads no asset files unless asked to', async () => {
      const path = join(directory, 'project.dump-records.zip');
      const manifest = await dump(project(), path, false);
      assert.equal(manifest.includesAssets, false);
      assert.deepEqual(requested, []);
      assert.ok(
        (await entries(path)).every((name) => !name.startsWith('assets/')),
      );
    });

    it('fails without a file when an asset differs from its MD5', async () => {
      const fixture = project();
      const [logo] = fixture.uploads;
      const files = assetFiles(fixture);
      files.set(originalFileUrl(logo!.url), '<svg>edited</svg>');
      serve(files);
      await assert.rejects(dump(fixture, join(directory, 'dump.zip'), true), {
        code: 'CAPTURE_DRIFT',
        message: `Asset ${logo!.id} changed while it was being exported.`,
      });
      assert.deepEqual(await readdir(directory), []);
    });

    it('fails without a file when an asset download fails', async () => {
      const fixture = project();
      const [logo] = fixture.uploads;
      const files = assetFiles(fixture);
      files.delete(originalFileUrl(logo!.url));
      serve(files);
      await assert.rejects(dump(fixture, join(directory, 'dump.zip'), true), {
        code: 'ASSET_DOWNLOAD_FAILED',
        message: `Asset ${logo!.id} could not be downloaded (HTTP 404).`,
      });
      assert.deepEqual(await readdir(directory), []);
    }).timeout(5000);

    it('refuses a file that is not a version 1 project dump, or holds other counts than it lists', async () => {
      const path = join(directory, 'project.dump-records.zip');
      const manifest = await dump(project(), path, false);
      const notZip = join(directory, 'not-a-zip.zip');
      await writeFile(notZip, 'not a zip');
      await assert.rejects(DumpFile.open(notZip), {
        code: 'INVALID_DUMP',
        message: new RegExp(`^${notZip} is not a readable zip: `),
      });
      const changed = (name: string, value: unknown) =>
        rewrite(path, join(directory, `${name}.zip`), {
          'manifest.json': value === null ? null : JSON.stringify(value),
        });
      for (const [name, value] of [
        ['missing', null],
        ['format', { ...manifest, format: 'datocms-content-diff' }],
        ['version', { ...manifest, version: 2 }],
        ['site', { ...manifest, site: { id: 'site' } }],
        ['counts', { ...manifest, counts: undefined }],
      ] as const) {
        const target = join(directory, `${name}.zip`);
        await assert.rejects(
          DumpFile.open(await changed(name, value)),
          {
            code: 'INVALID_DUMP',
            message: `${target} is not a version 1 project dump.`,
          },
          name,
        );
      }
      const sink = {
        record: async () => {},
        upload: async () => {},
        collection: async () => {},
      };
      for (const [name, counts, message] of [
        [
          'more-records',
          { ...manifest.counts, records: 4 },
          'The dump lists 4 records but holds 3; it is incomplete.',
        ],
        [
          'fewer-folders',
          { ...manifest.counts, uploadCollections: 0 },
          'The dump lists 0 upload-collections but holds 1; it is incomplete.',
        ],
      ] as const) {
        const file = await DumpFile.open(
          await changed(name, { ...manifest, counts }),
        );
        try {
          await assert.rejects(file.read(sink), {
            code: 'INVALID_DUMP',
            message,
          });
        } finally {
          file.close();
        }
      }
    });

    it('stops reading a dump when interrupted', async () => {
      const path = join(directory, 'project.dump-records.zip');
      await dump(project(), path, false);
      const file = await DumpFile.open(path);
      const read: unknown[] = [];
      const controller = new AbortController();
      controller.abort();
      try {
        await assert.rejects(
          file.read(
            {
              record: async (line) => void read.push(line),
              upload: async (upload) => void read.push(upload),
              collection: async (folder) => void read.push(folder),
            },
            controller.signal,
          ),
          { code: 'INTERRUPTED' },
        );
        assert.deepEqual(read, []);
      } finally {
        file.close();
      }
    });
  });
});
