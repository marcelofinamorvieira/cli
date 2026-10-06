import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compileFunction, runInNewContext } from 'node:vm';
import { format } from 'prettier';
import * as ts from 'typescript';
import {
  canonicalFields,
  canonicalUpload,
  collectionHash,
  hashJson,
  inspectRecord,
  recordHash,
} from '../../src/engine/codec';
import {
  baselineBinaries,
  compareBaseline,
  loadBaseline,
  migrationLiteral,
  writeMigration,
} from '../../src/engine/migration-artifact';
import {
  MAX_MIGRATION_CHUNK_BYTES,
  MAX_MIGRATION_FILE_BYTES,
} from '../../src/engine/migration-limits';
import { createPlan } from '../../src/engine/planner';
import { schemaHash } from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../../src/engine/types';
import type { ContentMigrationClient } from '../../src/migration';
import {
  directClientFixture,
  executeGeneratedScript as runScript,
} from './direct-client-fixture';
import { fixtureId } from './fixture-id';

const MODEL = 'aaaaaaaaaaaaaaaaaaaaaa';
const id = fixtureId;
const tracking = { apiKey: 'schema_migration', model: null };
const options = {
  modelIds: [MODEL],
  uploads: 'all' as const,
  includeDeletions: true,
  allowPartial: false,
  allowTemporarySchemaChanges: true,
};
function schema(ordered = false): SchemaState {
  const result: SchemaState = {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en'],
    semantics: {},
    workflows: [],
    models: [
      {
        id: MODEL,
        apiKey: 'page',
        name: 'Page',
        block: false,
        singleton: false,
        sortable: ordered,
        tree: false,
        draftMode: true,
        saveInvalidDrafts: true,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: id('title'),
            apiKey: 'title',
            type: 'string',
            localized: false,
            validators: {},
            defaultValue: null,
          },
          {
            id: id('related'),
            apiKey: 'related',
            type: 'links',
            localized: false,
            validators: { items_item_type: { item_types: [MODEL] } },
            defaultValue: null,
          },
        ],
      },
    ],
    hash: '',
  };
  result.hash = schemaHash(result);
  return result;
}
function record(
  name: string,
  fields: JsonObject,
  overrides: Partial<RecordState> = {},
): RecordState {
  const result: RecordState = {
    id: id(name),
    modelId: MODEL,
    current: { title: name, related: [], ...fields },
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
    ...overrides,
  };
  result.hash = recordHash(result);
  return result;
}
function put(
  store: SnapshotStore,
  side: 'target' | 'source',
  state: RecordState,
  schema: SchemaState,
) {
  store.putRecord(side, state);
  const inspected = inspectRecord(state, schema);
  for (const ref of inspected.references) store.putReference(side, ref);
  for (const owner of inspected.blockOwners) store.putBlockOwner(side, owner);
  for (const unique of inspected.uniqueValues)
    store.putUniqueValue(side, unique);
}
async function fixture(
  before: RecordState[],
  after: RecordState[],
  definition = schema(),
) {
  const directory = await mkdtemp(join(tmpdir(), 'content-ts-artifact-'));
  const store = new SnapshotStore(directory);
  for (const state of before) put(store, 'target', state, definition);
  for (const state of after) put(store, 'source', state, definition);
  const metadata = await createPlan(
    store,
    definition,
    { ...definition, environmentId: 'target' },
    options,
  );
  return {
    directory,
    store,
    metadata,
    definition,
    output: join(directory, '123_change.ts'),
    baseline: join(directory, '123_change.content'),
    async dispose() {
      store.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function typecheckScript(test: Awaited<ReturnType<typeof fixture>>) {
  const files = [test.output];
  try {
    for (const part of await readdir(join(test.baseline, 'parts')))
      files.push(join(test.baseline, 'parts', part));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const root = resolve(__dirname, '../../../..');
  const program = ts.createProgram(files, {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    typeRoots: [join(root, 'node_modules/@types')],
    paths: {
      '@datocms/cli-plugin-content-diff/migration': [
        join(root, 'packages/cli-plugin-content-diff/src/migration.ts'),
      ],
    },
  });
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
    [],
  );
}
async function replay(test: Awaited<ReturnType<typeof fixture>>) {
  const store = new SnapshotStore(test.directory);
  try {
    for (const state of test.store.iterateRecords('target'))
      put(store, 'target', state, test.definition);
    for (const state of test.store.iterateUploads('target'))
      store.putUpload('target', state);
    for (const state of test.store.iterateCollections('target'))
      store.putCollection('target', state);
    const manifest = await loadBaseline(test.baseline, store);
    compareBaseline(store);
    const remote = directClientFixture(store, test.definition);
    await runScript(test.output, remote.client, remote.uploadFile);
    remote.snapshot(store);
    const plan = await createPlan(
      store,
      test.definition,
      { ...test.definition, environmentId: 'target' },
      manifest.options,
    );
    for (const original of test.store.iteratePlan()) {
      const actual = store.getPlan(original.kind, original.id)!;
      assert.equal(
        actual.action,
        original.action,
        `${original.kind}/${original.id} action`,
      );
      if (original.desired)
        assert.equal(
          actual.desired?.hash,
          original.desired.hash,
          `${original.kind}/${original.id} state`,
        );
    }
    assert.deepEqual(plan.counts, test.metadata.counts);
    return store;
  } catch (error) {
    store.dispose();
    throw error;
  }
}

function upload(
  name: string,
  content: Buffer,
  overrides: Partial<UploadState> = {},
): UploadState {
  const state = canonicalUpload({
    id: id(name),
    basename: name,
    filename: `${name}.svg`,
    format: 'svg',
    md5: createHash('md5').update(content).digest('hex'),
    size: content.length,
    url: `https://assets.example.test/${name}.svg`,
    upload_collection: null,
    author: null,
    copyright: null,
    notes: null,
    tags: [],
    default_field_metadata: {
      alt: { en: null },
      title: { en: null },
      custom_data: { en: {} },
      focal_point: null,
      poster_time: null,
    },
  });
  return { ...state, ...overrides };
}

describe('TypeScript migration artifacts', () => {
  it('preserves __proto__ as data through formatting without rewriting string contents', async () => {
    const original = JSON.parse(
      '{"__proto__":{"safe":true},"text":"__MIGRATION_ASSET__(\\"binaries/abc.bin\\")","quotes":"a\\nb\\"c"}',
    );
    const literal = migrationLiteral(original);
    const formatted = await format(`(${literal})`, { parser: 'typescript' });
    const reconstructed = runInNewContext(formatted);
    assert.equal(Object.hasOwn(reconstructed, '__proto__'), true);
    assert.equal(JSON.stringify(reconstructed), JSON.stringify(original));
  });

  it('emits a readable one-record patch with only immutable original data in the companion', async () => {
    const before = record('changed', { title: 'Before' });
    const after = record('changed', { title: 'After' });
    const unchanged = Array.from({ length: 40 }, (_, i) =>
      record(`unchanged-${i}`, {}),
    );
    const test = await fixture([before, ...unchanged], [after, ...unchanged]);
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      const script = await readFile(test.output, 'utf8');
      assert.match(script, /client\.items\.update/);
      assert.match(script, /title: "After"/);
      assert.match(
        script,
        /Update record fields and metadata: "Page" \("page"\) record/,
      );
      assert.match(script, /, "After"\./);
      assert.match(script, /ContentMigrationClient/);
      assert.doesNotMatch(script, /datocms\/lib\/cma-client-node/);
      assert.doesNotMatch(script, /unchanged-|"Before"|runMigrationPart/);
      assert(script.length < 2000);
      const loaded = new SnapshotStore(test.directory);
      try {
        const manifest = await loadBaseline(test.baseline, loaded);
        assert.equal(manifest.targetCounts.record, 41);
        assert.equal(
          loaded.database
            .prepare(
              'SELECT count(*) AS n FROM migration_baseline WHERE original_json IS NOT NULL',
            )
            .get()!.n,
          1,
        );
        const parts = await readdir(join(test.baseline, 'baseline'));
        for (const part of parts) {
          const content = await readFile(
            join(test.baseline, 'baseline', part),
            'utf8',
          );
          assert.doesNotMatch(content, /"desired"|"After"/);
        }
      } finally {
        loaded.dispose();
      }
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  it('escapes bounded comments without changing payload strings or quoted property keys', async () => {
    const definition = schema();
    definition.models[0].name =
      'Page */\nawait client.items.destroy("injected");\u2028';
    definition.models[0].fields.push({
      id: id('details'),
      apiKey: 'details',
      type: 'json',
      localized: false,
      validators: {},
      defaultValue: null,
    });
    definition.hash = schemaHash(definition);
    const title = `Title */\r\n// @ts-ignore\u2029${'very long '.repeat(100)}`;
    const details = JSON.parse(
      '{"quoted-key":{"value":"safe"},"text":"quotes \\" and newlines\\n"}',
    );
    const test = await fixture(
      [record('unsafe-label', { title: 'Before', details: null })],
      [record('unsafe-label', { title, details })],
      definition,
    );
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      const script = await readFile(test.output, 'utf8');
      const label = script
        .split('\n')
        .find((line) => line.includes('// Update record fields'))!;
      assert(label.length < 600);
      assert(!label.includes('*/'));
      assert(!label.includes('\u2028'));
      assert(!label.includes('\u2029'));
      assert(label.includes('…'));
      assert.match(script, /"quoted-key":/);
      const replayed = await replay(test);
      try {
        assert.equal(
          replayed.getRecord('source', id('unsafe-label'))!.current.title,
          title,
        );
        assert.deepEqual(
          replayed.getRecord('source', id('unsafe-label'))!.current.details,
          details,
        );
      } finally {
        replayed.dispose();
      }
    } finally {
      await test.dispose();
    }
  });

  it('formats inline code using the project configuration', async () => {
    const test = await fixture(
      [record('style', {})],
      [record('style', { title: 'Styled' })],
    );
    try {
      await writeFile(
        join(test.directory, '.prettierrc.json'),
        JSON.stringify({
          singleQuote: true,
          semi: false,
          tabWidth: 4,
          quoteProps: 'preserve',
        }),
      );
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      const script = await readFile(test.output, 'utf8');
      assert.match(
        script,
        /from '@datocms\/cli-plugin-content-diff\/migration'\n/,
      );
      assert.match(script, /'title': 'Styled'/);
      assert.match(script, /\n {12}await client\.items\.update/);
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  it('resolves split-part configuration against final paths and replays the formatted code', async () => {
    const test = await fixture(
      [],
      Array.from({ length: 5 }, (_, index) => record(`style-${index}`, {})),
    );
    try {
      await writeFile(
        join(test.directory, '.prettierrc.json'),
        JSON.stringify({
          singleQuote: true,
          semi: false,
          overrides: [
            {
              files: ['**/*.content/parts/*.ts'],
              options: { singleQuote: false, semi: true, tabWidth: 4 },
            },
          ],
        }),
      );
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 400,
      });
      const script = await readFile(test.output, 'utf8');
      assert.match(
        script,
        /from '@datocms\/cli-plugin-content-diff\/migration'\n/,
      );
      for (const part of await readdir(join(test.baseline, 'parts'))) {
        const content = await readFile(
          join(test.baseline, 'parts', part),
          'utf8',
        );
        assert.match(
          content,
          /from "@datocms\/cli-plugin-content-diff\/migration";/,
        );
        assert.match(content, /\n {4}await client\.items\.create/);
      }
      await typecheckScript(test);
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  for (const invalidConfig of [
    '{ invalid JSON',
    JSON.stringify({ tabWidth: 'invalid' }),
  ])
    it(`falls back to default formatting for invalid project configuration: ${invalidConfig}`, async () => {
      const test = await fixture(
        [record('fallback', {})],
        [record('fallback', { title: 'Fallback' })],
      );
      try {
        await writeFile(
          join(test.directory, '.prettierrc.json'),
          invalidConfig,
        );
        await writeMigration({
          ...test,
          outputPath: test.output,
          sourceTracking: tracking,
          destinationTracking: tracking,
        });
        const script = await readFile(test.output, 'utf8');
        assert.match(
          script,
          /from "@datocms\/cli-plugin-content-diff\/migration";/,
        );
        assert.match(script, /title: "Fallback"/);
        const replayed = await replay(test);
        replayed.dispose();
      } finally {
        await test.dispose();
      }
    });

  it('splits parts again when project formatting expands a group beyond its target', async () => {
    const test = await fixture(
      Array.from({ length: 12 }, (_, index) => record(`growth-${index}`, {})),
      Array.from({ length: 12 }, (_, index) =>
        record(`growth-${index}`, { title: 'Changed' }),
      ),
    );
    try {
      await writeFile(
        join(test.directory, '.prettierrc.json'),
        JSON.stringify({ tabWidth: 100 }),
      );
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 5000,
      });
      const parts = await readdir(join(test.baseline, 'parts'));
      assert(parts.length > 1);
      for (const part of parts) {
        const content = await readFile(
          join(test.baseline, 'parts', part),
          'utf8',
        );
        assert(
          Buffer.byteLength(content) <= 6024 ||
            (content.match(/client\.items\.update/g) ?? []).length === 1,
          'only one indivisible guarded operation may exceed the part target',
        );
      }
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  it('rejects a single operation that grows past 16 MiB during formatting and removes partial output', async () => {
    const definition = schema();
    definition.models[0].fields.push({
      id: id('details'),
      apiKey: 'details',
      type: 'json',
      localized: false,
      validators: {},
      defaultValue: null,
    });
    definition.hash = schemaHash(definition);
    const test = await fixture(
      [record('growth', { details: null })],
      [
        record('growth', {
          details: Array.from({ length: 2500 }, () => 'value'),
        }),
      ],
      definition,
    );
    try {
      await writeFile(
        join(test.directory, '.prettierrc.json'),
        JSON.stringify({ tabWidth: 2048, printWidth: 40 }),
      );
      await assert.rejects(
        writeMigration({
          ...test,
          outputPath: test.output,
          sourceTracking: tracking,
          destinationTracking: tracking,
        }),
        { code: 'MIGRATION_FILE_TOO_LARGE' },
      );
      assert(
        !(await readdir(test.directory)).some(
          (name) =>
            name.startsWith('.content-migration-') ||
            name.startsWith('123_change'),
        ),
      );
    } finally {
      await test.dispose();
    }
  });

  it('replays split code with new circular records, publication divergence, schedules and deletion', async () => {
    const firstPublishedAt = '2025-02-01T00:00:00.000Z';
    const before = record(
      'published',
      { title: 'Old' },
      {
        published: { title: 'Old', related: [] },
        firstPublishedAt,
        publishedUpdatedAt: firstPublishedAt,
        validity: { current: true, published: true },
        schedules: {
          publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const after = record(
      'published',
      { title: 'New draft' },
      {
        published: { title: 'New published', related: [] },
        firstPublishedAt,
        publishedUpdatedAt: firstPublishedAt,
        validity: { current: true, published: true },
        schedules: {
          publication: {
            at: '2099-01-02T00:00:00.000Z',
            selective: { locales: ['en'], nonLocalized: true },
          },
          unpublishing: { at: '2099-02-01T00:00:00.000Z', locales: ['en'] },
        },
      },
    );
    const left = record('left', { related: [id('right')] });
    const right = record('right', { related: [id('left')] });
    const test = await fixture(
      [before, record('deleted', {})],
      [after, left, right],
    );
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 250,
      });
      assert.match(await readFile(test.output, 'utf8'), /runMigrationPart/);
      await typecheckScript(test);
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  it('executes provisional publication before completing circular published links and newer drafts', async () => {
    const firstPublishedAt = '2025-02-01T00:00:00.000Z';
    const left = record(
      'cycle-left',
      { title: 'Left draft', related: [id('cycle-right')] },
      {
        published: { title: 'Left published', related: [id('cycle-right')] },
        firstPublishedAt,
        validity: { current: true, published: true },
      },
    );
    const right = record(
      'cycle-right',
      { title: 'Right draft', related: [id('cycle-left')] },
      {
        published: { title: 'Right published', related: [id('cycle-left')] },
        firstPublishedAt,
        validity: { current: true, published: true },
      },
    );
    const test = await fixture([], [left, right]);
    try {
      assert(
        [...test.store.planEntries('record')].some(
          (entry) =>
            entry.kind === 'record' && entry.execution?.provisionalPublished,
        ),
      );
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 350,
      });
      const remote = directClientFixture(test.store, test.definition);
      await runScript(test.output, remote.client, remote.uploadFile);
      assert(
        remote.events.filter((event) => event.startsWith('publish:')).length >=
          3,
      );
      for (const expected of [left, right]) {
        assert.deepEqual(
          remote.records.get(expected.id)!.published,
          expected.published,
        );
        assert.deepEqual(
          remote.records.get(expected.id)!.current,
          expected.current,
        );
      }
    } finally {
      await test.dispose();
    }
  });

  it('restores temporary required validators in the script after successful invalid publication and failed writes', async () => {
    const definition = schema();
    definition.models[0].fields[0].validators = { required: {} };
    definition.hash = schemaHash(definition);
    const invalid = record(
      'invalid-published',
      { title: '' },
      {
        published: { title: '', related: [] },
        firstPublishedAt: '2025-02-01T00:00:00.000Z',
        validity: { current: false, published: false },
      },
    );
    const test = await fixture([], [invalid], definition);
    try {
      assert(test.metadata.temporarySchemaChanges.length > 0);
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 300,
      });
      await typecheckScript(test);
      for (const failure of [false, true]) {
        const remote = directClientFixture(test.store, test.definition);
        if (failure)
          Reflect.set(remote.client.items, 'create', async () => {
            throw new Error('injected create failure');
          });
        const run = runScript(test.output, remote.client, remote.uploadFile);
        if (failure) await assert.rejects(run, /injected create failure/);
        else await run;
        assert.deepEqual(remote.definition.models[0].fields[0].validators, {
          required: {},
        });
        assert(
          remote.events.filter((event) => event.startsWith('field:')).length >=
            2,
        );
      }
    } finally {
      await test.dispose();
    }
  });

  it('suppresses configured creation defaults to preserve explicit null and restores the field afterward', async () => {
    const definition = schema();
    definition.models[0].fields[0].defaultValue = 'Native default';
    definition.hash = schemaHash(definition);
    const wanted = record('null-default', { title: null });
    const test = await fixture([], [wanted], definition);
    try {
      assert(
        test.metadata.temporarySchemaChanges.some(
          (change) => change.temporary.defaultValue === null,
        ),
      );
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 300,
      });
      const remote = directClientFixture(test.store, test.definition);
      await runScript(test.output, remote.client, remote.uploadFile);
      assert.equal(remote.records.get(wanted.id)!.current.title, null);
      assert.equal(
        remote.definition.models[0].fields[0].defaultValue,
        'Native default',
      );
    } finally {
      await test.dispose();
    }
  });

  it('restores ordered unchanged siblings after creation, deletion and reordering intent', async () => {
    const definition = schema(true);
    const before = [
      record('a', {}, { position: 1 }),
      record('b', {}, { position: 2 }),
      record('c', {}, { position: 3 }),
    ];
    const after = [
      record('a', {}, { position: 3 }),
      record('c', {}, { position: 1 }),
      record('d', {}, { position: 2 }),
    ];
    const test = await fixture(before, after, definition);
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 300,
      });
      const replayed = await replay(test);
      try {
        for (const state of after)
          assert.equal(
            replayed.getRecord('source', state.id)!.position,
            state.position,
          );
      } finally {
        replayed.dispose();
      }
    } finally {
      await test.dispose();
    }
  });

  for (const chunkBytes of [4 * 1024 * 1024, 250])
    it(`replays verified binary creation/replacement with correct paths at chunk size ${chunkBytes}`, async () => {
      const old = Buffer.from('<svg>old</svg>');
      const next = Buffer.from('<svg>new</svg>');
      const test = await fixture([], []);
      const target = upload('existing', old);
      const desired = upload('existing', next);
      const created = upload('new', next);
      test.store.putUpload('target', target);
      test.store.putUpload('source', desired);
      test.store.putUpload('source', created);
      test.metadata = await createPlan(
        test.store,
        test.definition,
        { ...test.definition, environmentId: 'target' },
        options,
      );
      try {
        await writeMigration({
          ...test,
          outputPath: test.output,
          sourceTracking: tracking,
          destinationTracking: tracking,
          chunkBytes,
          fetchFn: async () => new Response(next),
        });
        await typecheckScript(test);
        const replayed = await replay(test);
        try {
          const binaries = [...baselineBinaries(replayed, test.baseline)];
          assert.equal(binaries.length, 2);
          assert.notEqual(binaries[0].localPath, binaries[1].localPath);
          for (const binary of binaries)
            assert.deepEqual(await readFile(binary.localPath), next);
        } finally {
          replayed.dispose();
        }
      } finally {
        await test.dispose();
      }
    });

  it('preserves a changed Structured Text block at the fifth nesting level', async () => {
    const definition = schema();
    const blockId = id('nested-block-model');
    definition.models[0].fields.push({
      id: id('body'),
      apiKey: 'body',
      type: 'structured_text',
      localized: false,
      validators: { structured_text_blocks: { item_types: [blockId] } },
      defaultValue: null,
    });
    definition.models.push({
      ...definition.models[0],
      id: blockId,
      apiKey: 'nested_block',
      name: 'Nested block',
      block: true,
      draftMode: false,
      fields: [
        {
          id: id('block-title'),
          apiKey: 'title',
          type: 'string',
          localized: false,
          validators: {},
          defaultValue: null,
        },
        {
          id: id('nested'),
          apiKey: 'nested',
          type: 'single_block',
          localized: false,
          validators: { single_block_blocks: { item_types: [blockId] } },
          defaultValue: null,
        },
      ],
    });
    definition.hash = schemaHash(definition);
    const fields = (text: string) => {
      let block: JsonObject | null = null;
      for (let depth = 5; depth >= 1; depth--)
        block = {
          id: id(`block-${depth}`),
          __itemTypeId: blockId,
          attributes: {
            title: depth === 5 ? text : `Depth ${depth}`,
            nested: block,
          },
        };
      return canonicalFields(
        {
          title: 'Nested article',
          related: [],
          body: {
            schema: 'dast',
            document: {
              type: 'root',
              children: [{ type: 'block', item: block }],
            },
          },
        },
        MODEL,
        definition,
      );
    };
    const test = await fixture(
      [record('nested-article', fields('Old leaf'))],
      [record('nested-article', fields('New leaf'))],
      definition,
    );
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 500,
      });
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  it('preserves intentionally invalid draft evidence without pretending it is valid', async () => {
    const definition = schema();
    definition.models[0].fields[0].validators = { required: {} };
    definition.hash = schemaHash(definition);
    const test = await fixture(
      [record('invalid', { title: 'Before' })],
      [
        record(
          'invalid',
          { title: '' },
          { validity: { current: false, published: null } },
        ),
      ],
      definition,
    );
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      const replayed = await replay(test);
      try {
        assert.equal(
          replayed.getRecord('source', id('invalid'))!.validity.current,
          false,
        );
      } finally {
        replayed.dispose();
      }
    } finally {
      await test.dispose();
    }
  });

  it('reconciles folder parent moves and unchanged sibling ordering', async () => {
    const collection = (
      name: string,
      position: number,
      parentId: string | null = null,
    ): CollectionState => {
      const state = { id: id(name), label: name, parentId, position, hash: '' };
      state.hash = collectionHash(state);
      return state;
    };
    const test = await fixture([], []);
    const before = [
      collection('folder-a', 1),
      collection('folder-b', 2),
      collection('child', 1, id('folder-a')),
    ];
    const after = [
      collection('folder-a', 3),
      collection('folder-b', 1),
      collection('folder-new', 2),
      collection('child', 1, id('folder-b')),
    ];
    for (const state of before) test.store.putCollection('target', state);
    for (const state of after) test.store.putCollection('source', state);
    test.metadata = await createPlan(
      test.store,
      test.definition,
      { ...test.definition, environmentId: 'target' },
      options,
    );
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 250,
      });
      await typecheckScript(test);
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  it('rejects oversized chunk targets before writing and accepts the maximum supported target', async () => {
    const test = await fixture(
      [record('boundary', {})],
      [record('boundary', { title: 'Changed' })],
    );
    try {
      const before = await readdir(test.directory);
      for (const chunkBytes of [
        MAX_MIGRATION_CHUNK_BYTES + 1,
        32 * 1024 * 1024,
      ])
        await assert.rejects(
          writeMigration({
            ...test,
            outputPath: test.output,
            sourceTracking: tracking,
            destinationTracking: tracking,
            chunkBytes,
          }),
          /chunk size must be between/,
        );
      assert.deepEqual(await readdir(test.directory), before);
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: MAX_MIGRATION_CHUNK_BYTES,
      });
      assert.ok(
        (await readFile(test.output)).length <= MAX_MIGRATION_FILE_BYTES,
      );
      const replayed = await replay(test);
      replayed.dispose();
    } finally {
      await test.dispose();
    }
  });

  it('removes incomplete output when one operation exceeds the loader ceiling', async () => {
    const test = await fixture(
      [record('oversized', {})],
      [record('oversized', { title: 'x'.repeat(MAX_MIGRATION_FILE_BYTES) })],
    );
    try {
      await assert.rejects(
        writeMigration({
          ...test,
          outputPath: test.output,
          sourceTracking: tracking,
          destinationTracking: tracking,
        }),
        /generated operation exceeds/,
      );
      assert.ok(
        !(await readdir(test.directory)).some(
          (name) =>
            name.startsWith('.content-migration-') ||
            name.startsWith('123_change'),
        ),
      );
    } finally {
      await test.dispose();
    }
  });

  it('counts escaped filename headers in the final source-file ceiling', async function () {
    if (process.platform === 'win32') this.skip();
    const emptyCall = `  await client.items.update(${migrationLiteral(
      id('boundary'),
      1,
    )}, ${migrationLiteral({ title: '' }, 1)});\n\n`;
    const title = 'x'.repeat(
      MAX_MIGRATION_CHUNK_BYTES - Buffer.byteLength(emptyCall) - 300,
    );
    const test = await fixture(
      [record('boundary', {})],
      [record('boundary', { title })],
    );
    // POSIX permits these filename bytes. JSON escaping expands the script's
    // companion path beyond the normal 1 KiB header allowance.
    const basename = `1_${'\u0001'.repeat(245)}`;
    const outputPath = join(test.directory, `${basename}.ts`);
    try {
      await assert.rejects(
        writeMigration({
          ...test,
          outputPath,
          sourceTracking: tracking,
          destinationTracking: tracking,
          chunkBytes: MAX_MIGRATION_CHUNK_BYTES,
        }),
        { code: 'MIGRATION_FILE_TOO_LARGE' },
      );
      assert.ok(
        !(await readdir(test.directory)).some(
          (name) =>
            name.startsWith('.content-migration-') || name.startsWith(basename),
        ),
      );
    } finally {
      await test.dispose();
    }
  });

  it('rejects baseline corruption and rolls back partial baseline imports', async () => {
    const before = record('record', {});
    const after = record('record', { title: 'new' });
    const test = await fixture([before], [after]);
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: 200,
      });
      const files = await readdir(join(test.baseline, 'baseline'));
      await writeFile(
        join(test.baseline, 'baseline', files.at(-1)!),
        '{"corrupt":true}\n',
      );
      const loaded = new SnapshotStore(test.directory);
      try {
        await assert.rejects(loadBaseline(test.baseline, loaded));
        assert.equal(
          loaded.database
            .prepare('SELECT count(*) AS n FROM migration_baseline')
            .get()!.n,
          0,
        );
      } finally {
        loaded.dispose();
      }
    } finally {
      await test.dispose();
    }
  });

  it('refuses namespace drift, overwritten outputs and incomplete generation', async () => {
    const before = record('record', {});
    const test = await fixture([before], [record('record', { title: 'new' })]);
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      await assert.rejects(
        writeMigration({
          ...test,
          outputPath: test.output,
          sourceTracking: tracking,
          destinationTracking: tracking,
        }),
        /already exists/,
      );
      const loaded = new SnapshotStore(test.directory);
      try {
        await loadBaseline(test.baseline, loaded);
        assert.throws(() => compareBaseline(loaded), /lost record/);
        put(loaded, 'target', before, test.definition);
        compareBaseline(loaded);
        put(
          loaded,
          'target',
          record('record', { title: 'another edit' }),
          test.definition,
        );
        assert.throws(() => compareBaseline(loaded), /differs/);
        put(loaded, 'target', before, test.definition);
        put(loaded, 'target', record('extra', {}), test.definition);
        assert.throws(() => compareBaseline(loaded), /gained record/);
      } finally {
        loaded.dispose();
      }
      const controller = new AbortController();
      controller.abort();
      const cancelled = join(test.directory, '124_cancelled.ts');
      await assert.rejects(
        writeMigration({
          ...test,
          outputPath: cancelled,
          sourceTracking: tracking,
          destinationTracking: tracking,
          signal: controller.signal,
        }),
      );
      assert(
        !(await readdir(test.directory)).some(
          (name) =>
            name.startsWith('.content-migration-') ||
            name.startsWith('124_cancelled'),
        ),
      );
    } finally {
      await test.dispose();
    }
  });
});
