import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { after, before, describe, it } from 'mocha';
import {
  canonicalUpload,
  collectionHash,
  recordHash,
} from '../src/engine/codec';
import { DiffFile, type DiffManifest } from '../src/engine/diff-file';
import {
  ContentError,
  DESTINATION_CHANGED_MESSAGE,
} from '../src/engine/errors';
import {
  assertExpectations,
  cmaFailure,
  runOperations,
} from '../src/engine/execution';
import type { Operation } from '../src/engine/operations';
import { schemaHash } from '../src/engine/schema';
import type {
  Client,
  CollectionState,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { ZipWriter } from '../src/engine/zip';
import { cmaFixture } from './cma-fixture';
import { fixtureId as id } from './fixture-id';
import { content, diff, run, writeTestDiff } from './pipeline';

const apiError = (status: number, url: string, errors: unknown[]) =>
  new CmaClient.ApiError({
    request: { method: 'PUT', url, headers: {} },
    response: {
      status,
      statusText: '',
      headers: {},
      body: { data: errors },
    },
  });

const MODEL = id('execution-model');
const DATE = '2025-01-01T00:00:00.000Z';
const SCHEMA: SchemaState = {
  siteId: 'site',
  environmentId: 'source',
  locales: ['en'],
  semantics: {},
  workflows: [],
  hash: '',
  models: [
    {
      id: MODEL,
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
          id: id('execution-title'),
          apiKey: 'title',
          type: 'string',
          localized: false,
          validators: {},
          defaultValue: null,
        },
      ],
    },
  ],
};
SCHEMA.hash = schemaHash(SCHEMA);

function record(name: string, title = name): RecordState {
  const state: RecordState = {
    id: id(name),
    modelId: MODEL,
    current: { title },
    published: null,
    currentVersion: `v-${name}`,
    publishedUpdatedAt: null,
    createdAt: DATE,
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: '',
  };
  state.hash = recordHash(state);
  return state;
}

function upload(name: string, notes: string): UploadState {
  return canonicalUpload({
    id: id(name),
    basename: name,
    filename: `${name}.svg`,
    md5: createHash('md5').update(name).digest('hex'),
    size: name.length,
    url: `https://assets.example.test/${name}.svg`,
    upload_collection: null,
    author: null,
    copyright: null,
    notes,
    tags: [],
  });
}

function folder(name: string, label: string, position: number) {
  const state: CollectionState = {
    id: id(name),
    label,
    parentId: null,
    position,
    hash: '',
  };
  state.hash = collectionHash(state);
  return state;
}

/**
 * The diff updates a record, an upload and a folder, and creates one of
 * each; `other` and `still` are the same on both sides.
 */
const target = content({
  records: [record('kept', 'Old'), record('other')],
  uploads: [upload('photo', 'old'), upload('still', 'same')],
  collections: [folder('archive', 'Archive', 1)],
});
const source = content({
  records: [record('kept', 'New'), record('other'), record('fresh')],
  uploads: [
    upload('photo', 'new'),
    upload('still', 'same'),
    upload('added', 'new'),
  ],
  collections: [folder('archive', 'Renamed', 1), folder('media', 'Media', 2)],
});
const targetSchema = { ...SCHEMA, environmentId: 'target' };

let directory: string;
let diffPath: string;
let operations: Operation[];
let manifest: DiffManifest;
let diffs = 0;
/**
 * Writes hand-written lines, and the files they upload, as a diff with the
 * generated diff's manifest. Lines are written as they are, valid or not.
 */
async function linesDiff(
  lines: unknown[],
  files: Record<string, string> = {},
): Promise<string> {
  const path = join(directory, `lines-${++diffs}.diff-records.zip`);
  const zip = new ZipWriter(path);
  zip.addBuffer(
    'operations/000001.jsonl',
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
  for (const [name, contents] of Object.entries(files))
    zip.addBuffer(name, contents);
  zip.addBuffer(
    'manifest.json',
    JSON.stringify({ ...manifest, operations: lines.length }),
  );
  await zip.close();
  return path;
}

async function useDiff<T>(
  path: string,
  use: (file: DiffFile) => Promise<T>,
): Promise<T> {
  const file = await DiffFile.open(path);
  try {
    return await use(file);
  } finally {
    file.close();
  }
}

const check = (client: Client, path = diffPath) =>
  useDiff(path, (file) => assertExpectations(client, file, { concurrency: 2 }));
const execute = (
  client: Client,
  path: string,
  options: Parameters<typeof runOperations>[2] = {},
) => useDiff(path, (file) => runOperations(client, file, options));

/** A client that records every call and answers with `answers`. */
function recorder(answers: Record<string, (...args: any[]) => unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const resource = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_, method) =>
          async (...args: unknown[]) => {
            const call = `${name}.${String(method)}`;
            calls.push([call, ...args]);
            return answers[call]?.(...args);
          },
      },
    );
  const client = new Proxy(
    {},
    { get: (_, name) => resource(String(name)) },
  ) as Client;
  return { client, calls };
}

describe('CMA failure reporting', () => {
  it('names the request, error codes and field validations of a 422', () => {
    const error = cmaFailure(
      apiError(422, 'https://site-api.datocms.com/items/abc?nested=true', [
        {
          id: '1',
          type: 'api_error',
          attributes: {
            code: 'INVALID_FIELD',
            details: { field: 'slug', code: 'VALIDATION_UNIQUE' },
          },
        },
        {
          id: '2',
          type: 'api_error',
          attributes: {
            code: 'INVALID_FIELD',
            details: { field: 'author', code: 'VALIDATION_ITEM_ITEM_TYPE' },
          },
        },
      ]),
    ) as ContentError;
    assert.equal(error.code, 'CMA_VALIDATION_FAILED');
    assert.equal(
      error.message,
      'The CMA rejected PUT /items/abc: INVALID_FIELD (slug: VALIDATION_UNIQUE); INVALID_FIELD (author: VALIDATION_ITEM_ITEM_TYPE). A unique value may still be held by another record; reorder or edit the diff so that record releases it first. A referenced record or asset may be missing or unpublished; make sure the diff creates or publishes it first.',
    );
    assert.deepEqual(error.details, {
      method: 'PUT',
      url: 'https://site-api.datocms.com/items/abc?nested=true',
      status: 422,
      errors: [
        {
          code: 'INVALID_FIELD',
          details: { field: 'slug', code: 'VALIDATION_UNIQUE' },
        },
        {
          code: 'INVALID_FIELD',
          details: { field: 'author', code: 'VALIDATION_ITEM_ITEM_TYPE' },
        },
      ],
    });
  });

  it('reports a stale record version as a concurrent edit', () => {
    const error = cmaFailure(
      apiError(422, 'https://site-api.datocms.com/items/abc', [
        {
          id: '1',
          type: 'api_error',
          attributes: { code: 'STALE_ITEM_VERSION', details: {} },
        },
      ]),
    ) as ContentError;
    assert.equal(error.code, 'RECORD_CHANGED_DURING_APPLY');
    assert.equal(
      error.message,
      'Record abc was modified by someone else while the diff was running.',
    );
  });

  it('reports other CMA errors with the same context and leaves other errors alone', () => {
    const error = cmaFailure(
      apiError(404, 'https://site-api.datocms.com/uploads/u1', [
        {
          id: '1',
          type: 'api_error',
          attributes: { code: 'NOT_FOUND', details: {} },
        },
      ]),
    ) as ContentError;
    assert.equal(error.code, 'CMA_REQUEST_FAILED');
    assert.equal(
      error.message,
      'The CMA request PUT /uploads/u1 failed: NOT_FOUND.',
    );
    assert.equal(error.details?.status, 404);
    const timeout = cmaFailure(
      new CmaClient.TimeoutError({
        request: {
          method: 'PUT',
          url: 'https://site-api.datocms.com/items/rec1',
          headers: {},
        },
      }),
    ) as ContentError;
    assert.equal(timeout.code, 'CMA_REQUEST_FAILED');
    assert.equal(
      timeout.message,
      'The CMA request PUT /items/rec1 timed out; it may still have been applied.',
    );
    assert.deepEqual(timeout.details, {
      method: 'PUT',
      url: 'https://site-api.datocms.com/items/rec1',
      status: null,
      errors: [],
    });
    const plain = new Error('plain');
    assert.equal(cmaFailure(plain), plain);
  });
});

describe('content diff execution', () => {
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-execution-test-'));
    const generated = await diff({
      source,
      target,
      sourceSchema: SCHEMA,
      targetSchema,
      options: {
        modelIds: [MODEL],
        uploads: 'all',
        includeDeletions: false,
        allowPartial: false,
      },
    });
    operations = generated.operations;
    diffPath = await writeTestDiff(directory, generated.plan, operations);
    manifest = await useDiff(diffPath, async (file) => file.manifest);
  });
  after(() => rm(directory, { recursive: true, force: true }));

  describe('destination expectations', () => {
    it('passes when everything the diff touches is as expected, and compares nothing else', async () => {
      // Only the first operation on an existing entity carries what it expects.
      assert.deepEqual(
        operations.flatMap((operation) =>
          operation.expect ? [[operation.op, operation.id]] : [],
        ),
        [
          ['folder.update', id('archive')],
          ['upload.update', id('photo')],
          ['record.update', id('kept')],
        ],
      );
      const fixture = cmaFixture(target, targetSchema, source);
      fixture.records.get(id('other'))!.currentVersion = 'edited';
      fixture.uploads.get(id('still'))!.attributes.notes = 'edited';
      assert.equal(await check(fixture.client), operations.length);
    });

    const cases: Array<
      [
        string,
        (fixture: ReturnType<typeof cmaFixture>) => void,
        { kind: string; id: string; reason: string },
      ]
    > = [
      [
        'a record edited',
        ({ records }) => {
          records.get(id('kept'))!.currentVersion = 'edited';
        },
        { kind: 'record', id: id('kept'), reason: 'changed' },
      ],
      [
        'a record published',
        ({ records }) => {
          Object.assign(records.get(id('kept'))!, {
            published: { title: 'Old' },
            publishedUpdatedAt: DATE,
          });
        },
        { kind: 'record', id: id('kept'), reason: 'changed' },
      ],
      [
        'a record deleted',
        ({ records }) => records.delete(id('kept')),
        { kind: 'record', id: id('kept'), reason: 'removed' },
      ],
      [
        'a record created under an ID the diff creates',
        ({ records }) =>
          records.set(id('fresh'), { ...record('other'), id: id('fresh') }),
        { kind: 'record', id: id('fresh'), reason: 'added' },
      ],
      [
        'an upload edited',
        ({ uploads }) => {
          uploads.get(id('photo'))!.attributes.notes = 'edited';
        },
        { kind: 'upload', id: id('photo'), reason: 'changed' },
      ],
      [
        'an upload deleted',
        ({ uploads }) => uploads.delete(id('photo')),
        { kind: 'upload', id: id('photo'), reason: 'removed' },
      ],
      [
        'an upload created under an ID the diff creates',
        ({ uploads }) =>
          uploads.set(id('added'), {
            ...upload('still', 'x'),
            id: id('added'),
          }),
        { kind: 'upload', id: id('added'), reason: 'added' },
      ],
      [
        'a folder renamed',
        ({ folders }) => {
          folders.get(id('archive'))!.label = 'Edited';
        },
        { kind: 'collection', id: id('archive'), reason: 'changed' },
      ],
      [
        'a folder deleted',
        ({ folders }) => folders.delete(id('archive')),
        { kind: 'collection', id: id('archive'), reason: 'removed' },
      ],
      [
        'a folder created under an ID the diff creates',
        ({ folders }) =>
          folders.set(id('media'), folder('media', 'Someone else', 2)),
        { kind: 'collection', id: id('media'), reason: 'added' },
      ],
    ];
    for (const [change, apply, details] of cases)
      it(`reports ${change} with the same instruction`, async () => {
        const fixture = cmaFixture(target, targetSchema, source);
        apply(fixture);
        await assert.rejects(check(fixture.client), (error: ContentError) => {
          assert.equal(error.code, 'DESTINATION_CHANGED');
          assert.equal(error.message, DESTINATION_CHANGED_MESSAGE);
          assert.deepEqual(error.details, details);
          return true;
        });
        assert.deepEqual(fixture.events, []);
      });

    it('reads records and uploads by ID in batches of 100, and folders only when the diff touches them', async () => {
      const lines = [
        ...Array.from({ length: 150 }, (_, index) => ({
          op: 'record.create',
          id: `r${index}`,
          label: `Create r${index}`,
          data: {},
        })),
        {
          op: 'upload.update',
          id: 'u',
          label: 'Update u',
          expect: { hash: 'h' },
          data: {},
        },
      ];
      const { client, calls } = recorder({
        'items.rawList': () => ({ data: [] }),
        'uploads.list': () => [],
      });
      await assert.rejects(
        check(client, await linesDiff(lines)),
        (error: ContentError) => error.code === 'DESTINATION_CHANGED',
      );
      const queries = calls
        .filter(([method]) => method === 'items.rawList')
        .map(([, query]) => {
          const { filter, version, page } = query as {
            filter: { ids: string };
            version: string;
            page: { limit: number };
          };
          return [filter.ids.split(',').length, version, page.limit];
        });
      assert.deepEqual(
        queries.sort(),
        [
          [100, 'current', 100],
          [100, 'published', 100],
          [50, 'current', 50],
          [50, 'published', 50],
        ].sort(),
      );
      assert.deepEqual(
        calls.filter(([method]) => method !== 'items.rawList'),
        [['uploads.list', { filter: { ids: 'u' }, page: { limit: 1 } }]],
      );
    });

    it('refuses an invalid line before reading or writing anything', async () => {
      const valid = {
        op: 'record.update',
        id: 'r',
        label: 'Update r',
        expect: { currentVersion: '1', publishedUpdatedAt: null },
        data: { title: 'x' },
      };
      for (const [line, problem] of [
        [
          { op: 'record.explode', label: 'x' },
          'unknown operation "record.explode".',
        ],
        [
          { op: 'record.update', id: 'r', label: 'x' },
          '"data" must be an object.',
        ],
        [{ op: 'record.publish', label: 'x' }, '"id" must be a DatoCMS ID.'],
        [
          { ...valid, op: 'record.create' },
          '"expect" does not fit the operation.',
        ],
        [
          { op: 'upload.create', id: 'u', label: 'x', data: {}, md5: 'm' },
          '"file" or "url" must be a string.',
        ],
        [
          {
            op: 'upload.create',
            id: 'u',
            label: 'x',
            data: {},
            md5: 'm',
            file: 'assets/u/missing.svg',
          },
          'the diff has no file assets/u/missing.svg.',
        ],
      ] as const) {
        const { client, calls } = recorder();
        await assert.rejects(
          check(client, await linesDiff([valid, line])),
          (error: ContentError) => {
            assert.equal(error.code, 'INVALID_DIFF');
            assert.equal(
              error.message,
              `operations/000001.jsonl line 2: ${problem}`,
            );
            assert.deepEqual(error.details, {
              where: 'operations/000001.jsonl line 2',
            });
            return true;
          },
        );
        assert.deepEqual(calls, []);
      }
    });
  });

  describe('running operations', () => {
    it('runs every operation in order through its SDK call', async () => {
      const md5 = { md5: 'ABCDEF' };
      const lines = [
        { op: 'folder.create', id: 'f', label: '1', data: { label: 'F' } },
        { op: 'folder.update', id: 'f', label: '2', data: { label: 'G' } },
        { op: 'folders.reorder', label: '3', data: [{ id: 'f' }] },
        {
          op: 'upload.create',
          id: 'u',
          label: '4',
          url: 'https://example.test/u.svg',
          md5: 'abcdef',
          data: { filename: 'u.svg' },
        },
        {
          op: 'upload.replace',
          id: 'u',
          label: '5',
          url: 'https://example.test/v.svg',
          md5: 'abcdef',
          data: { filename: 'v.svg' },
        },
        { op: 'upload.update', id: 'u', label: '6', data: { notes: 'n' } },
        { op: 'record.create', id: 'r', label: '7', data: { title: 't' } },
        { op: 'record.update', id: 'r', label: '8', data: { title: 'u' } },
        { op: 'record.publish', id: 'r', label: '9' },
        {
          op: 'schedule.publication.create',
          id: 'r',
          label: '10',
          data: { publication_scheduled_at: DATE },
        },
        { op: 'schedule.publication.delete', id: 'r', label: '11' },
        {
          op: 'schedule.unpublishing.create',
          id: 'r',
          label: '12',
          data: { unpublishing_scheduled_at: DATE },
        },
        { op: 'schedule.unpublishing.delete', id: 'r', label: '13' },
        { op: 'record.unpublish', id: 'r', label: '14' },
        { op: 'record.delete', id: 'r', label: '15' },
        { op: 'upload.delete', id: 'u', label: '16' },
        { op: 'folder.delete', id: 'f', label: '17' },
      ];
      const { client, calls } = recorder({
        'uploads.createFromUrl': () => md5,
        'uploads.updateFromUrl': () => md5,
      });
      assert.equal(await execute(client, await linesDiff(lines)), lines.length);
      // A record is published or unpublished alone, never with its links.
      const alone = [undefined, { recursive: false }];
      assert.deepEqual(calls, [
        ['uploadCollections.create', { id: 'f', label: 'F' }],
        ['uploadCollections.update', 'f', { label: 'G' }],
        ['uploadCollections.reorder', [{ id: 'f' }]],
        [
          'uploads.createFromUrl',
          { id: 'u', url: 'https://example.test/u.svg', filename: 'u.svg' },
        ],
        [
          'uploads.updateFromUrl',
          'u',
          { url: 'https://example.test/v.svg', filename: 'v.svg' },
        ],
        ['uploads.update', 'u', { notes: 'n' }],
        ['items.create', { id: 'r', title: 't' }],
        ['items.update', 'r', { title: 'u' }],
        ['items.publish', 'r', ...alone],
        [
          'scheduledPublication.create',
          'r',
          { publication_scheduled_at: DATE },
        ],
        ['scheduledPublication.destroy', 'r'],
        [
          'scheduledUnpublishing.create',
          'r',
          { unpublishing_scheduled_at: DATE },
        ],
        ['scheduledUnpublishing.destroy', 'r'],
        ['items.unpublish', 'r', ...alone],
        ['items.destroy', 'r'],
        ['uploads.destroy', 'u'],
        ['uploadCollections.destroy', 'f'],
      ]);
    });

    it('uploads new files from the diff and removes each extracted file', async () => {
      const files = {
        'assets/u/u.svg': '<svg>new</svg>',
        'assets/v/v.svg': '<svg>replaced</svg>',
      };
      const md5 = (contents: string) =>
        createHash('md5').update(contents).digest('hex');
      const lines = Object.entries(files).map(([file, contents]) => ({
        op: file.includes('/u/') ? 'upload.create' : 'upload.replace',
        id: file.split('/')[1],
        label: `Upload ${file}`,
        file,
        md5: md5(contents),
        data: { filename: file.split('/')[2] },
      }));
      const read: Array<[string, string]> = [];
      const extract = async ({ localPath }: { localPath: string }) => {
        const contents = await readFile(localPath, 'utf8');
        read.push([localPath, contents]);
        return { md5: md5(contents) };
      };
      const { client, calls } = recorder({
        'uploads.createFromLocalFile': extract,
        'uploads.updateFromLocalFile': (_id: string, body) => extract(body),
      });
      await execute(client, await linesDiff(lines, files));
      assert.deepEqual(
        read.map(([, contents]) => contents),
        Object.values(files),
      );
      assert.deepEqual(calls, [
        [
          'uploads.createFromLocalFile',
          { id: 'u', localPath: read[0]![0], filename: 'u.svg' },
        ],
        [
          'uploads.updateFromLocalFile',
          'v',
          { localPath: read[1]![0], filename: 'v.svg' },
        ],
      ]);
      for (const [path] of read) await assert.rejects(access(path));
    });

    it('refuses an uploaded file that differs from the one the diff expects', async () => {
      const message = (asset: string) =>
        `Asset ${asset} was uploaded with a different file than the diff expects: it changed in the source since the diff generation. Please re-generate a diff to apply.`;
      // A source asset edited after the diff was generated, fetched by URL.
      const fixture = cmaFixture(target, targetSchema, source);
      fixture.remoteFiles.get(upload('added', 'new').url)!.md5 = 'edited';
      const index = operations.findIndex(
        (operation) => operation.op === 'upload.create',
      );
      const { label } = operations[index]!;
      const where = `operations/000001.jsonl line ${index + 1}`;
      await assert.rejects(
        run(fixture.client, diffPath),
        (error: ContentError) => {
          assert.equal(error.code, 'ASSET_CHANGED');
          assert.equal(
            error.message,
            `${where}, ${label}: ${message(id('added'))}`,
          );
          assert.deepEqual(error.details, { operation: { where, label } });
          return true;
        },
      );
      // A file from the diff is removed once it has been uploaded, also then.
      let extracted = '';
      const { client } = recorder({
        'uploads.createFromLocalFile': ({
          localPath,
        }: { localPath: string }) => {
          extracted = localPath;
          return { md5: 'edited' };
        },
      });
      const line = {
        op: 'upload.create',
        id: 'u',
        label: 'Create u',
        file: 'assets/u/u.svg',
        md5: 'expected',
        data: {},
      };
      await assert.rejects(
        execute(client, await linesDiff([line], { 'assets/u/u.svg': 'x' })),
        (error: ContentError) => {
          assert.equal(error.code, 'ASSET_CHANGED');
          assert.equal(
            error.message,
            `operations/000001.jsonl line 1, Create u: ${message('u')}`,
          );
          return true;
        },
      );
      await assert.rejects(access(extracted));
    });

    it('names the line and label of a failed operation and runs nothing after it', async () => {
      const lines = [
        { op: 'record.publish', id: 'a', label: 'Publish a' },
        { op: 'record.update', id: 'b', label: 'Update b', data: {} },
        { op: 'record.delete', id: 'c', label: 'Delete c' },
      ];
      const path = await linesDiff(lines);
      const rejection = apiError(422, 'https://site-api.datocms.com/items/b', [
        {
          id: '1',
          type: 'api_error',
          attributes: {
            code: 'INVALID_FIELD',
            details: { field: 'title', code: 'VALIDATION_UNIQUE' },
          },
        },
      ]);
      const failing = (error: unknown) =>
        recorder({
          'items.update': () => {
            throw error;
          },
        });
      const where = 'operations/000001.jsonl line 2';
      const rejected = failing(rejection);
      await assert.rejects(
        execute(rejected.client, path),
        (error: ContentError) => {
          assert.equal(error.code, 'CMA_VALIDATION_FAILED');
          assert.equal(
            error.message,
            `${where}, Update b: The CMA rejected PUT /items/b: INVALID_FIELD (title: VALIDATION_UNIQUE). A unique value may still be held by another record; reorder or edit the diff so that record releases it first.`,
          );
          assert.deepEqual(error.details, {
            method: 'PUT',
            url: 'https://site-api.datocms.com/items/b',
            status: 422,
            errors: [
              {
                code: 'INVALID_FIELD',
                details: { field: 'title', code: 'VALIDATION_UNIQUE' },
              },
            ],
            operation: { where, label: 'Update b' },
          });
          return true;
        },
      );
      assert.deepEqual(
        rejected.calls.map(([method]) => method),
        ['items.publish', 'items.update'],
      );
      const timedOut = failing(
        new CmaClient.TimeoutError({
          request: {
            method: 'PUT',
            url: 'https://site-api.datocms.com/items/b',
            headers: {},
          },
        }),
      );
      await assert.rejects(
        execute(timedOut.client, path),
        (error: ContentError) => {
          assert.equal(error.code, 'CMA_REQUEST_FAILED');
          assert.equal(
            error.message,
            `${where}, Update b: The CMA request PUT /items/b timed out; it may still have been applied.`,
          );
          return true;
        },
      );
      // Anything that is not a CMA failure is reported as it is.
      const plain = new Error('plain');
      await assert.rejects(
        execute(failing(plain).client, path),
        (error: unknown) => error === plain,
      );
    });

    it("keeps the ID it creates and the file it uploads whatever a line's data says", async () => {
      const md5 = { md5: 'abcdef' };
      const { client, calls } = recorder({
        'uploads.createFromUrl': () => md5,
      });
      await execute(
        client,
        await linesDiff([
          {
            op: 'record.create',
            id: 'r',
            label: '1',
            data: { id: 'other', title: 't' },
          },
          {
            op: 'folder.create',
            id: 'f',
            label: '2',
            data: { id: 'other', label: 'F' },
          },
          {
            op: 'upload.create',
            id: 'u',
            label: '3',
            url: 'https://example.test/u.svg',
            md5: 'abcdef',
            data: {
              id: 'other',
              localPath: '/etc/hosts',
              url: 'https://elsewhere.test/u.svg',
              filename: 'u.svg',
            },
          },
        ]),
      );
      assert.deepEqual(calls, [
        ['items.create', { id: 'r', title: 't' }],
        ['uploadCollections.create', { id: 'f', label: 'F' }],
        [
          'uploads.createFromUrl',
          { id: 'u', url: 'https://example.test/u.svg', filename: 'u.svg' },
        ],
      ]);
    });

    it('fails a run interrupted during its last operation', async () => {
      const controller = new AbortController();
      const { client } = recorder({
        'items.publish': () => controller.abort(),
      });
      await assert.rejects(
        execute(
          client,
          await linesDiff([{ op: 'record.publish', id: 'r', label: 'last' }]),
          { signal: controller.signal },
        ),
        { code: 'INTERRUPTED' },
      );
    });

    it('finishes the operation in flight on interrupt and runs no other', async () => {
      const controller = new AbortController();
      const interruption = Object.assign(
        new ContentError(
          'INTERRUPTED',
          'Content operation interrupted by SIGINT.',
        ),
        { exitCode: 130 },
      );
      const settled: string[] = [];
      const { client, calls } = recorder({
        'items.publish': async (id: string) => {
          controller.abort(interruption);
          await new Promise((resolve) => setImmediate(resolve));
          settled.push(id);
        },
      });
      const lines = ['a', 'b'].map((record) => ({
        op: 'record.publish',
        id: record,
        label: `Publish ${record}`,
      }));
      await assert.rejects(
        execute(client, await linesDiff(lines), { signal: controller.signal }),
        (error: unknown) => error === interruption,
      );
      assert.deepEqual(calls, [
        ['items.publish', 'a', undefined, { recursive: false }],
      ]);
      assert.deepEqual(settled, ['a']);
    });
  });
});
