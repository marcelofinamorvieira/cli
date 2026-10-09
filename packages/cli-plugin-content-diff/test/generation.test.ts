import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'mocha';
import {
  canonicalUpload,
  collectionHash,
  recordHash,
  recordPayloadFields,
} from '../src/engine/codec';
import { DiffFile, PLUGIN_VERSION } from '../src/engine/diff-file';
import { writeDump } from '../src/engine/dump';
import { assetEntryName, originalFileUrl } from '../src/engine/emit';
import { ContentError } from '../src/engine/errors';
import {
  type ContentGenerationArguments,
  generateContentDiff,
} from '../src/engine/generation';
import { prepareMigrationSchema } from '../src/engine/migration-schema';
import type { Operation } from '../src/engine/operations';
import { type RawSchema, schemaFromRaw } from '../src/engine/schema';
import type {
  Client,
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { ZipReader } from '../src/engine/zip';
import { outputPath } from '../src/utils/command-helpers';
import { cmaFixture } from './cma-fixture';
import { fixtureId as id } from './fixture-id';
import { type Content, content, diff, run } from './pipeline';

const ARTICLE = id('generation-article');
const PAGE = id('generation-page');
const TRACKING = id('generation-tracking');
const CREATED = '2025-01-01T00:00:00.000Z';
const PUBLISHED = '2025-02-01T00:00:00.000Z';

/** A schema as the CMA's bulk schema read returns it. */
function rawSchema(
  siteId: string,
  shape: {
    /** The article model's name and invalid draft saving. */
    name?: string;
    saveInvalidDrafts?: boolean;
    locales?: string[];
    /** Whether the environment has the migration tracking model. */
    tracking?: boolean;
  } = {},
): RawSchema {
  const included: unknown[] = [];
  const model = (
    modelId: string,
    apiKey: string,
    name: string,
    fields: Record<string, string>,
    attributes: JsonObject = {},
  ) => {
    included.push({
      id: modelId,
      type: 'item_type',
      attributes: {
        api_key: apiKey,
        name,
        modular_block: false,
        singleton: false,
        sortable: false,
        tree: false,
        draft_mode_active: true,
        draft_saving_active: false,
        all_locales_required: false,
        ...attributes,
      },
      relationships: { workflow: { data: null } },
    });
    for (const [key, type] of Object.entries(fields))
      included.push({
        id: id(`generation-${apiKey}-${key}`),
        type: 'field',
        attributes: {
          api_key: key,
          field_type: type,
          localized: false,
          validators: {},
          default_value: null,
        },
        relationships: {
          item_type: { data: { id: modelId, type: 'item_type' } },
        },
      });
  };
  model(
    ARTICLE,
    'article',
    shape.name ?? 'Article',
    { title: 'string', related: 'links', image: 'file' },
    { draft_saving_active: shape.saveInvalidDrafts ?? false },
  );
  model(PAGE, 'page', 'Page', { title: 'string' });
  if (shape.tracking)
    model(
      TRACKING,
      'schema_migration',
      'Schema migration',
      { name: 'string' },
      { draft_mode_active: false },
    );
  return {
    site: {
      data: {
        id: siteId,
        type: 'site',
        attributes: { locales: shape.locales ?? ['en'], timezone: 'UTC' },
        meta: {},
      },
      included,
    },
    workflows: [],
  } as unknown as RawSchema;
}

function record(
  modelId: string,
  name: string,
  current: JsonObject,
  { publish, ...overrides }: Partial<RecordState> & { publish?: boolean } = {},
): RecordState {
  const state: RecordState = {
    id: id(name),
    modelId,
    current,
    published: publish ? structuredClone(current) : null,
    currentVersion: `v-${name}`,
    publishedUpdatedAt: publish ? PUBLISHED : null,
    createdAt: CREATED,
    firstPublishedAt: publish ? PUBLISHED : null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: '',
    ...overrides,
  };
  state.hash = recordHash(state);
  return state;
}

const article = (
  name: string,
  fields: JsonObject = {},
  overrides: Parameters<typeof record>[3] = {},
) =>
  record(
    ARTICLE,
    name,
    { title: name, related: [], image: null, ...fields },
    overrides,
  );

const page = (name: string, title = name) =>
  record(PAGE, name, { title }, { publish: true });

const migration = (name: string) =>
  record(TRACKING, name, { name }, { publish: true });

function upload(
  name: string,
  bytes: string,
  folder?: string,
  attributes: JsonObject = {},
): UploadState {
  return canonicalUpload({
    id: id(name),
    basename: name,
    filename: `${name}.svg`,
    md5: createHash('md5').update(bytes).digest('hex'),
    size: bytes.length,
    url: `https://assets.example.test/${name}.svg`,
    upload_collection: folder ? { id: id(folder) } : null,
    author: null,
    copyright: null,
    notes: null,
    tags: [],
    ...attributes,
  });
}

function folder(name: string, position: number): CollectionState {
  const state = {
    id: id(name),
    label: name,
    parentId: null,
    position,
    hash: '',
  };
  state.hash = collectionHash(state);
  return state;
}

/** One version of a record as `GET /items` returns it. */
function nativeRecord(
  state: RecordState,
  schema: SchemaState,
  version: 'current' | 'published',
) {
  return {
    id: state.id,
    type: 'item',
    attributes: {
      ...recordPayloadFields(state[version]!, state.modelId, schema),
      parent_id: state.parentId,
      position: state.position,
    },
    relationships: {
      item_type: { data: { id: state.modelId, type: 'item_type' } },
    },
    meta: {
      created_at: state.createdAt,
      first_published_at: state.firstPublishedAt,
      current_version: state.currentVersion,
      published_at: state.publishedUpdatedAt,
      updated_at: state.publishedUpdatedAt,
      stage: state.stage,
      publication_scheduled_at: state.schedules.publication?.at ?? null,
      unpublishing_scheduled_at: state.schedules.unpublishing?.at ?? null,
      is_current_version_valid: !state.invalid?.current,
      is_published_version_valid: !state.invalid?.published,
    },
  };
}

/** A record's schedules as `items.rawCurrentVsPublishedState` returns them. */
function nativeSchedules({ id: recordId, schedules }: RecordState) {
  const { publication, unpublishing } = schedules;
  const included = [
    publication && {
      id: `${recordId}-publication`,
      type: 'scheduled_publication',
      attributes: {
        publication_scheduled_at: publication.at,
        selective_publication: null,
      },
    },
    unpublishing && {
      id: `${recordId}-unpublishing`,
      type: 'scheduled_unpublishing',
      attributes: {
        unpublishing_scheduled_at: unpublishing.at,
        content_in_locales: unpublishing.locales,
      },
    },
  ].filter((resource) => !!resource);
  return {
    data: {
      relationships: Object.fromEntries(
        included.map(({ id, type }) => [type, { data: { id, type } }]),
      ),
    },
    included,
  };
}

const nativeUpload = (upload: UploadState) => ({
  id: upload.id,
  type: 'upload',
  ...upload.attributes,
  md5: upload.md5,
  size: upload.size,
  url: upload.url,
  filename: upload.filename,
  upload_collection: upload.collectionId
    ? { id: upload.collectionId, type: 'upload_collection' }
    : null,
});

const nativeFolder = (folder: CollectionState) => ({
  id: folder.id,
  type: 'upload_collection',
  label: folder.label,
  position: folder.position,
  parent: folder.parentId
    ? { id: folder.parentId, type: 'upload_collection' }
    : null,
});

interface Environment {
  primary?: boolean;
  raw: RawSchema;
  content: Content;
  /** Runs before every call this environment answers, to delay or fail it. */
  before?: (call: string) => Promise<void> | void;
}

type Endpoint = ContentGenerationArguments['destination']['endpoint'];

/**
 * A project's environments behind one CMA endpoint, answering the reads of
 * generation. Every call is logged to `calls` as `site/environment call`.
 */
function project(
  environments: Record<string, Environment>,
  calls: string[],
): Endpoint {
  return {
    rootClient: {
      environments: {
        list: async () =>
          Object.entries(environments).map(([environmentId, environment]) => ({
            id: environmentId,
            meta: { primary: !!environment.primary },
          })),
      },
    } as unknown as Client,
    buildEnvironmentClient(environmentId) {
      const environment = environments[environmentId];
      const respond = async <T>(call: string, value: () => T): Promise<T> => {
        calls.push(`${environment.raw.site.data.id}/${environmentId} ${call}`);
        // A network call yields, so reads that run at once interleave.
        await setImmediate();
        await environment.before?.(call);
        return value();
      };
      const schema = () => schemaFromRaw(environment.raw, environmentId);
      const page = (data: unknown[], total = data.length) => ({
        data,
        meta: { total_count: total },
      });
      // Content is read when asked for, so tests can change it meanwhile.
      const side = () => environment.content;
      return {
        site: { rawFind: () => respond('schema', () => environment.raw.site) },
        workflows: {
          list: () => respond('workflows', () => environment.raw.workflows),
        },
        users: { findMe: () => respond('access', () => ({ type: 'account' })) },
        request: ({
          queryParams: { filter, page: range },
        }: {
          queryParams: {
            filter: { type?: string; ids?: string };
            page: { offset?: number; limit: number };
          };
        }) => {
          if (filter.type)
            return respond(`records ${filter.type}`, () => {
              const rows = side().records.filter(
                (state) => state.modelId === filter.type,
              );
              const offset = range.offset ?? 0;
              return page(
                rows
                  .slice(offset, offset + range.limit)
                  .map((state) => nativeRecord(state, schema(), 'current')),
                rows.length,
              );
            });
          const ids = new Set(filter.ids!.split(','));
          return respond('published', () =>
            page(
              side()
                .records.filter((state) => ids.has(state.id) && state.published)
                .map((state) => nativeRecord(state, schema(), 'published')),
            ),
          );
        },
        items: {
          rawCurrentVsPublishedState: (recordId: string) =>
            respond('schedules', () =>
              nativeSchedules(
                side().records.find((state) => state.id === recordId)!,
              ),
            ),
        },
        uploads: {
          rawList: () =>
            respond('upload count', () =>
              page(
                side().uploads.slice(0, 1).map(nativeUpload),
                side().uploads.length,
              ),
            ),
          list: ({
            page: range,
          }: { page: { offset: number; limit: number } }) =>
            respond('uploads', () =>
              side()
                .uploads.slice(range.offset, range.offset + range.limit)
                .map(nativeUpload),
            ),
        },
        uploadCollections: {
          list: () =>
            respond('folders', () => side().collections.map(nativeFolder)),
        },
      } as unknown as Client;
    },
  };
}

/** The environments that capture calls went to, repeats collapsed. */
function readOrder(calls: string[]): string[] {
  return calls
    .filter((call) => !/ (schema|workflows)$/.test(call))
    .map((call) => call.split(' ')[0])
    .filter((environment, index, all) => environment !== all[index - 1]);
}

/** A written diff's manifest and operations. */
async function read(path: string) {
  const file = await DiffFile.open(path);
  try {
    const operations: Operation[] = [];
    for await (const { operation } of file.operations())
      operations.push(operation);
    return { manifest: file.manifest, operations };
  } finally {
    file.close();
  }
}

const steps = (operations: Operation[]) =>
  operations.map((operation) => [operation.op, operation.id]);

const options = {
  itemTypes: 'article',
  uploads: 'referenced' as const,
  includeDeletions: true,
  allowPartial: false,
  concurrency: 2,
};

describe('content diff generation', () => {
  let work: string;
  let temporary: string;
  let previousTmpdir: string | undefined;
  let generated = 0;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'content-generation-test-'));
    // Generation's own temporary directory lands here, to check it is gone.
    temporary = join(work, 'tmp');
    await mkdir(temporary);
    previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
  });

  afterEach(async () => {
    if (previousTmpdir === undefined)
      Reflect.deleteProperty(process.env, 'TMPDIR');
    else process.env.TMPDIR = previousTmpdir;
    await rm(work, { recursive: true, force: true });
  });

  /**
   * Generates a diff named as content:diff names it, and checks that the
   * temporary directory is removed and that a failure writes nothing.
   */
  async function generate(
    args: Pick<ContentGenerationArguments, 'source' | 'destination'> & {
      name?: string;
      options?: Partial<ContentGenerationArguments['options']>;
      progress?: (message: string) => void;
    },
  ) {
    const path = await outputPath({
      directory: work,
      name: args.name ?? `diff ${++generated}`,
      kind: 'diff',
    });
    try {
      return await generateContentDiff({
        source: args.source,
        destination: args.destination,
        outputPath: path,
        options: { ...options, ...args.options },
        signal: new AbortController().signal,
        progress: args.progress,
      });
    } catch (error) {
      for (const assets of [false, true])
        assert.equal(existsSync(path(assets)), false);
      throw error;
    } finally {
      assert.deepEqual(readdirSync(temporary), []);
    }
  }

  it('reads two environments of one project one after another and writes their diff', async () => {
    const logo = upload('logo', 'logo bytes', 'media');
    const calls: string[] = [];
    const endpoint = project(
      {
        main: {
          primary: true,
          raw: rawSchema('site'),
          content: content({
            records: [
              article('kept', { title: 'Old' }, { publish: true }),
              article('gone'),
              page('home'),
            ],
          }),
        },
        sandbox: {
          raw: rawSchema('site'),
          content: content({
            records: [
              article('kept', { title: 'New' }, { publish: true }),
              article(
                'fresh',
                { related: [id('kept')], image: { upload_id: logo.id } },
                {
                  schedules: {
                    publication: {
                      at: '2030-01-01T00:00:00.000Z',
                      selective: null,
                    },
                    unpublishing: null,
                  },
                },
              ),
              page('home', 'Changed'),
            ],
            uploads: [logo],
            collections: [folder('media', 1)],
          }),
        },
      },
      calls,
    );
    const progress: string[] = [];
    let working: string[] = [];
    const result = await generate({
      source: { endpoint, environment: 'sandbox' },
      destination: { endpoint, environment: 'primary' },
      name: 'sync content',
      progress: (message) => {
        progress.push(message);
        if (message === 'Planning.') working = readdirSync(temporary);
      },
    });
    // Both sides were indexed in one temporary directory, removed since.
    assert.equal(working.length, 1);
    assert.equal(result.sourceEnvironmentId, 'sandbox');
    assert.equal(result.destinationEnvironmentId, 'main');
    assert.match(
      basename(result.diffPath),
      /^\d+_syncContent\.diff-records\.zip$/,
    );
    assert.deepEqual(result.skipped, []);
    // One project shares one rate limit: the source is read in full, every
    // model included, before the destination.
    assert.deepEqual(readOrder(calls), ['site/sandbox', 'site/main']);
    for (const environment of ['sandbox', 'main'])
      for (const model of [ARTICLE, PAGE])
        assert.ok(calls.includes(`site/${environment} records ${model}`));
    assert.deepEqual(
      progress.filter((message) => !message.includes(': ')),
      [
        'Capturing source "sandbox".',
        'Capturing destination "main".',
        'Planning.',
        'Writing the diff.',
      ],
    );

    const { manifest, operations } = await read(result.diffPath);
    const { format, version, createdAt, ...rest } = manifest;
    assert.equal(format, 'datocms-content-diff');
    assert.equal(version, 1);
    assert.ok(!Number.isNaN(Date.parse(createdAt)));
    const untracked = { apiKey: 'schema_migration', model: null };
    assert.deepEqual(rest, {
      pluginVersion: PLUGIN_VERSION,
      includesAssets: false,
      source: { kind: 'environment', siteId: 'site', environmentId: 'sandbox' },
      destination: { siteId: 'site', environmentId: 'main' },
      schemaHash: schemaFromRaw(rawSchema('site'), 'main').hash,
      sourceTracking: untracked,
      destinationTracking: untracked,
      options: {
        modelIds: [ARTICLE],
        uploads: 'referenced',
        includeDeletions: true,
        allowPartial: false,
      },
      counts: result.counts,
      operations: operations.length,
    });
    assert.equal(result.operations, operations.length);
    // Only the selected model changes: the page differs, but is kept as the
    // destination has it.
    assert.deepEqual(result.counts.record, {
      create: 1,
      update: 1,
      delete: 1,
      noop: 1,
      skip: 0,
    });
    assert.deepEqual(steps(operations), [
      ['folder.create', id('media')],
      ['upload.create', logo.id],
      ['record.create', id('fresh')],
      ['record.update', id('kept')],
      ['record.publish', id('kept')],
      ['record.delete', id('gone')],
      ['folders.reorder', undefined],
      ['schedule.publication.create', id('fresh')],
    ]);
    const byOp = (op: string) =>
      operations.find((operation) => operation.op === op)!;
    assert.equal(byOp('upload.create').url, originalFileUrl(logo.url));
    assert.equal(byOp('upload.create').md5, logo.md5);
    assert.equal(byOp('upload.create').file, undefined);
    assert.deepEqual(byOp('record.update').expect, {
      currentVersion: 'v-kept',
      publishedUpdatedAt: PUBLISHED,
    });
    assert.deepEqual(byOp('schedule.publication.create').data, {
      publication_scheduled_at: '2030-01-01T00:00:00.000Z',
      selective_publication: null,
    });
  });

  it('reads two projects at once, and stops the other read when one fails', async () => {
    const calls: string[] = [];
    const sources: Record<string, Environment> = {
      main: {
        primary: true,
        raw: rawSchema('source-site'),
        content: content({
          records: [article('fresh', {}, { publish: true })],
        }),
      },
    };
    const destinations: Record<string, Environment> = {
      main: {
        primary: true,
        raw: rawSchema('destination-site'),
        content: content(),
      },
    };
    const sides = {
      source: { endpoint: project(sources, calls), environment: 'primary' },
      destination: {
        endpoint: project(destinations, calls),
        environment: 'main',
      },
    };
    const result = await generate(sides);
    assert.ok(readOrder(calls).length > 2, readOrder(calls).join(', '));
    const { manifest, operations } = await read(result.diffPath);
    assert.deepEqual(manifest.source, {
      kind: 'environment',
      siteId: 'source-site',
      environmentId: 'main',
    });
    assert.deepEqual(manifest.destination, {
      siteId: 'destination-site',
      environmentId: 'main',
    });
    assert.deepEqual(steps(operations), [
      ['record.create', id('fresh')],
      ['record.publish', id('fresh')],
    ]);

    // The source waits at its first read until the destination has failed.
    calls.length = 0;
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    sources.main.before = (call) => (call === 'access' ? failure : undefined);
    destinations.main.before = (call) => {
      if (!call.startsWith('records')) return;
      setTimeout(failed, 10);
      throw new Error('destination failed');
    };
    await assert.rejects(generate(sides), /^Error: destination failed$/);
    assert.ok(calls.includes('source-site/main access'));
    assert.ok(
      !calls.some((call) => call.startsWith('source-site/main records')),
      calls.join(', '),
    );
  });

  it('refuses the same environment and incompatible schemas before reading content', async () => {
    const calls: string[] = [];
    const environments: Record<string, Environment> = {
      main: { primary: true, raw: rawSchema('site'), content: content() },
      sandbox: {
        raw: rawSchema('site', { locales: ['it'] }),
        content: content(),
      },
    };
    const endpoint = project(environments, calls);
    // Two endpoints for one project name the same environment too.
    for (const destination of [endpoint, project(environments, calls)])
      await assert.rejects(
        generate({
          source: { endpoint, environment: 'primary' },
          destination: { endpoint: destination, environment: 'main' },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ContentError, String(error));
          assert.equal(error.code, 'SAME_ENVIRONMENT');
          assert.equal(
            error.message,
            'Source and destination must be different environments or projects.',
          );
          return true;
        },
      );
    await assert.rejects(
      generate({
        source: { endpoint, environment: 'sandbox' },
        destination: { endpoint, environment: 'main' },
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'SCHEMA_INCOMPATIBLE',
    );
    assert.deepEqual(
      calls.filter((call) => !/ (schema|workflows)$/.test(call)),
      [],
    );
  });

  it('restores the environment a dump came from, without its migration tracking records', async () => {
    const logo = upload('logo', 'logo bytes');
    const raw = rawSchema('site', { tracking: true });
    const dumped = content({
      records: [
        article('kept', { image: { upload_id: logo.id } }, { publish: true }),
        article('draft'),
        page('home'),
        migration('1_init'),
      ],
      uploads: [logo],
    });
    const calls: string[] = [];
    const environments: Record<string, Environment> = {
      main: { primary: true, raw, content: dumped },
    };
    const endpoint = project(environments, calls);
    const dumpPath = join(work, 'backup.dump-records.zip');
    await writeDump({
      client: endpoint.buildEnvironmentClient('main'),
      environmentId: 'main',
      primary: true,
      path: dumpPath,
      includeAssets: false,
      options: { concurrency: 2 },
    });
    // The environment changes after the dump, migrations included.
    const changed = content({
      records: [
        article('kept', { title: 'Edited' }, { publish: true }),
        article('added'),
        page('home'),
        migration('1_init'),
        migration('2_more'),
      ],
    });
    environments.main.content = changed;
    calls.length = 0;
    const progress: string[] = [];
    const result = await generate({
      source: { dump: dumpPath },
      destination: { endpoint, environment: 'main' },
      name: 'restore',
      options: { itemTypes: 'all', uploads: 'all' },
      progress: (message) => progress.push(message),
    });
    assert.equal(result.sourceEnvironmentId, 'main');
    assert.equal(result.destinationEnvironmentId, 'main');
    assert.match(basename(result.diffPath), /^\d+_restore\.diff-records\.zip$/);
    assert.ok(progress.includes('Reading dump "backup.dump-records.zip".'));
    // The destination's tracking model is never read.
    assert.ok(!calls.some((call) => call.endsWith(`records ${TRACKING}`)));

    const { manifest, operations } = await read(result.diffPath);
    const tracking = { apiKey: 'schema_migration', model: { id: TRACKING } };
    assert.deepEqual(manifest.source, {
      kind: 'dump',
      siteId: 'site',
      environmentId: 'main',
      dump: 'backup.dump-records.zip',
    });
    assert.deepEqual(manifest.destination, {
      siteId: 'site',
      environmentId: 'main',
    });
    assert.equal(manifest.includesAssets, false);
    assert.deepEqual(manifest.sourceTracking, tracking);
    assert.deepEqual(manifest.destinationTracking, tracking);
    assert.equal(
      manifest.schemaHash,
      prepareMigrationSchema(schemaFromRaw(raw, 'main')).schema.hash,
    );
    assert.deepEqual(manifest.options.modelIds, [ARTICLE, PAGE].sort());
    assert.deepEqual(steps(operations), [
      ['upload.create', logo.id],
      ['record.create', id('draft')],
      ['record.update', id('kept')],
      ['record.publish', id('kept')],
      ['record.delete', id('added')],
    ]);
    // Without asset files in the dump, the file comes from the source URL.
    assert.equal(operations[0].url, originalFileUrl(logo.url));
    assert.equal(operations[0].file, undefined);

    // Running the diff brings the environment back to the dump.
    const schema = schemaFromRaw(raw, 'main');
    const fixture = cmaFixture(changed, schema, dumped);
    await run(fixture.client, result.diffPath);
    const again = await diff({
      source: dumped,
      target: fixture.snapshot(),
      sourceSchema: schema,
      options: {
        modelIds: [ARTICLE, PAGE],
        uploads: 'all',
        includeDeletions: true,
        allowPartial: false,
      },
    });
    assert.deepEqual(steps(again.operations), []);
  });

  it('carries asset files only when the dump has them and the diff uploads a file', async () => {
    const logo = upload('logo', 'logo bytes');
    const environments: Record<string, Environment> = {
      main: {
        primary: true,
        raw: rawSchema('site'),
        content: content({
          records: [
            article(
              'pictured',
              { image: { upload_id: logo.id } },
              { publish: true },
            ),
          ],
          uploads: [logo],
        }),
      },
    };
    const endpoint = project(environments, []);
    const dumpPath = join(work, 'assets.dump-records-assets.zip');
    const fetched: string[] = [];
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response('logo bytes');
    }) as typeof fetch;
    try {
      await writeDump({
        client: endpoint.buildEnvironmentClient('main'),
        environmentId: 'main',
        primary: true,
        path: dumpPath,
        includeAssets: true,
        options: { concurrency: 2 },
      });
    } finally {
      globalThis.fetch = nativeFetch;
    }
    assert.deepEqual(fetched, [originalFileUrl(logo.url)]);
    const sides = {
      source: { dump: dumpPath },
      destination: { endpoint, environment: 'main' },
    };

    const entry = assetEntryName(logo.id, logo.filename);
    // A new or replaced asset is uploaded from the dump's file; an asset
    // whose metadata alone differs needs no file.
    for (const [name, destination, op, assets] of [
      ['created', content(), 'upload.create', true],
      [
        'replaced',
        content({ uploads: [upload('logo', 'old bytes')] }),
        'upload.replace',
        true,
      ],
      [
        'metadata only',
        content({
          uploads: [
            upload('logo', 'logo bytes', undefined, { author: 'Someone' }),
          ],
        }),
        'upload.update',
        false,
      ],
    ] as const) {
      environments.main.content = destination;
      const result = await generate({ ...sides, name });
      assert.ok(
        result.diffPath.endsWith(
          assets ? '.diff-records-assets.zip' : '.diff-records.zip',
        ),
        result.diffPath,
      );
      const { manifest, operations } = await read(result.diffPath);
      assert.equal(manifest.includesAssets, assets, name);
      assert.deepEqual(steps(operations), [
        [op, logo.id],
        ['record.create', id('pictured')],
        ['record.publish', id('pictured')],
      ]);
      const [write] = operations;
      if (!assets) {
        assert.deepEqual(write.data, { author: null });
        continue;
      }
      assert.equal(write.file, entry);
      assert.equal(write.url, undefined);
      assert.equal(write.md5, logo.md5);
      const zip = await ZipReader.open(result.diffPath);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of await zip.stream(entry))
          chunks.push(chunk as Buffer);
        assert.equal(Buffer.concat(chunks).toString(), 'logo bytes');
      } finally {
        zip.close();
      }
    }
  });

  it('refuses invalid source records before writing, unless the destination saves invalid drafts', async () => {
    const environments: Record<string, Environment> = {
      main: { primary: true, raw: rawSchema('site'), content: content() },
      sandbox: {
        raw: rawSchema('site'),
        content: content({
          records: [
            article(
              'broken',
              {},
              { publish: true, invalid: { current: false, published: true } },
            ),
          ],
        }),
      },
    };
    const endpoint = project(environments, []);
    const sides = {
      source: { endpoint, environment: 'sandbox' },
      destination: { endpoint, environment: 'main' },
    };
    await assert.rejects(generate(sides), (error: unknown) => {
      assert.ok(error instanceof ContentError, String(error));
      assert.equal(error.code, 'INVALID_SOURCE_RECORDS');
      assert.equal(
        error.message.split('\n')[1],
        `- Article "broken" (${id('broken')}): published version invalid`,
      );
      assert.deepEqual(error.details, {
        records: [
          { id: id('broken'), modelId: ARTICLE, versions: ['published'] },
        ],
      });
      return true;
    });
    // The destination model's invalid draft saving decides, and the record
    // is named as the source schema names it.
    environments.sandbox.content = content({
      records: [
        article('draft', {}, { invalid: { current: true, published: false } }),
      ],
    });
    environments.main.raw = rawSchema('site', {
      name: 'Destination Article',
      saveInvalidDrafts: true,
    });
    await generate(sides);
    environments.sandbox.raw = rawSchema('site', { saveInvalidDrafts: true });
    environments.main.raw = rawSchema('site', { name: 'Destination Article' });
    await assert.rejects(generate(sides), (error: unknown) => {
      assert.ok(error instanceof ContentError, String(error));
      assert.equal(error.code, 'INVALID_SOURCE_RECORDS');
      assert.equal(
        error.message.split('\n')[1],
        `- Article "draft" (${id('draft')}): current version invalid`,
      );
      return true;
    });
  });

  it('lists what --allow-partial leaves out of the diff, and refuses it otherwise', async () => {
    const logo = upload('logo', 'logo bytes');
    const unsupported = article(
      'unsupported',
      { image: { upload_id: logo.id, custom_data: { __itemTypeId: 'x' } } },
      { publish: true },
    );
    const environments: Record<string, Environment> = {
      main: {
        primary: true,
        raw: rawSchema('site'),
        content: content({ uploads: [logo] }),
      },
      sandbox: {
        raw: rawSchema('site'),
        content: content({
          records: [unsupported, article('fine', {}, { publish: true })],
          uploads: [logo],
        }),
      },
    };
    const endpoint = project(environments, []);
    const sides = {
      source: { endpoint, environment: 'sandbox' },
      destination: { endpoint, environment: 'main' },
    };
    const message = `Record ${unsupported.id} contains native field metadata at __itemTypeId that the CMA client cannot safely preserve through writes and responses.`;
    await assert.rejects(generate(sides), (error: unknown) => {
      assert.ok(error instanceof ContentError, String(error));
      assert.equal(error.code, 'UNSAFE_REQUESTED_CHANGE');
      assert.equal(error.message, message);
      assert.deepEqual(error.details, {
        kind: 'record',
        id: unsupported.id,
        reason: 'UNSUPPORTED_PAYLOAD_KEY',
        dependencyId: null,
      });
      return true;
    });
    const result = await generate({
      ...sides,
      options: { allowPartial: true },
    });
    assert.deepEqual(result.skipped, [
      {
        kind: 'record',
        id: unsupported.id,
        code: 'UNSUPPORTED_PAYLOAD_KEY',
        message,
      },
    ]);
    assert.equal(result.counts.record.skip, 1);
    const { manifest, operations } = await read(result.diffPath);
    assert.equal(manifest.options.allowPartial, true);
    assert.deepEqual(manifest.counts, result.counts);
    assert.deepEqual(steps(operations), [
      ['record.create', id('fine')],
      ['record.publish', id('fine')],
    ]);
  });
});
