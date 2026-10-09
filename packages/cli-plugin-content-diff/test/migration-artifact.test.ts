import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { format } from 'prettier';
import * as ts from 'typescript';
import {
  canonicalFields,
  canonicalUpload,
  collectionHash,
  recordHash,
  recordReferences,
} from '../src/engine/codec';
import type { ContentError } from '../src/engine/errors';
import {
  MAX_MIGRATION_CHUNK_BYTES,
  compareBaseline,
  loadBaseline,
  migrationLiteral,
  writeMigration,
} from '../src/engine/migration-artifact';
import { createPlan } from '../src/engine/planner';
import { schemaHash } from '../src/engine/schema';
import { SnapshotStore } from '../src/engine/store';
import type {
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { cmaFixture, executeGeneratedScript as runScript } from './cma-fixture';
import { fixtureId } from './fixture-id';

const MODEL = 'aaaaaaaaaaaaaaaaaaaaaa';
const id = fixtureId;
const tracking = { apiKey: 'schema_migration', model: null };
const options = {
  modelIds: [MODEL],
  uploads: 'all' as const,
  includeDeletions: true,
  allowPartial: false,
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
        saveInvalidDrafts: false,
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
  for (const ref of recordReferences(state, schema))
    store.putReference(side, ref);
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
  const metadata = createPlan(
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
  const root = resolve(__dirname, '../../..');
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
    for (const state of test.store.records('target'))
      put(store, 'target', state, test.definition);
    for (const state of test.store.uploads('target'))
      store.putUpload('target', state);
    for (const state of test.store.collections('target'))
      store.putCollection('target', state);
    const manifest = await loadBaseline(test.baseline, store);
    compareBaseline(store);
    const remote = cmaFixture(store, test.definition, test.store);
    await runScript(test.output, remote.client);
    remote.snapshot(store);
    const plan = createPlan(
      store,
      test.definition,
      { ...test.definition, environmentId: 'target' },
      manifest.options,
    );
    for (const original of test.store.planEntries()) {
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
      '{"__proto__":{"safe":true},"text":"await client.items.destroy(\\"x\\")","quotes":"a\\nb\\"c"}',
    );
    const literal = migrationLiteral(original);
    const formatted = await format(`(${literal})`, { parser: 'typescript' });
    const reconstructed = runInNewContext(formatted);
    assert.equal(Object.hasOwn(reconstructed, '__proto__'), true);
    assert.equal(JSON.stringify(reconstructed), JSON.stringify(original));
  });

  it('leads Structured Text nodes with their type and file values with their upload', () => {
    assert.equal(
      migrationLiteral({
        content: {
          document: {
            children: [{ level: 2, type: 'heading' }],
            type: 'root',
          },
          schema: 'dast',
        },
        cover: { alt: null, title: null, upload_id: 'u1' },
      }),
      '{ "content": { "schema": "dast", "document": { "type": "root", "children": [{ "type": "heading", "level": 2 }] } }, "cover": { "upload_id": "u1", "alt": null, "title": null } }',
    );
  });

  it('emits a locked one-record patch and a companion of destination guards only', async () => {
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
      assert.equal(
        script,
        `import {
  type ContentMigrationClient,
  defineContentMigration,
} from "@datocms/cli-plugin-content-diff/migration";

export default defineContentMigration(
  async (client: ContentMigrationClient): Promise<void> => {
    // Update Page "After" (${after.id})
    await client.items.update("${after.id}", {
      title: "After",
      meta: { current_version: "1" },
    });
  },
);
`,
      );
      const loaded = new SnapshotStore(test.directory);
      try {
        const manifest = await loadBaseline(test.baseline, loaded);
        assert.equal(manifest.chunks.count, 1);
        assert.equal(manifest.format, 'datocms-content-migration-baseline/1');
        assert.deepEqual((await readdir(test.baseline)).sort(), [
          'baseline',
          'chunks.jsonl',
          'manifest.json',
          'manifest.sha256',
        ]);
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
      [record('unsafe-label', { title: `Before ${title}`, details: null })],
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
      // The comment stays on one line, so the injected call never runs.
      const lines = script.split('\n');
      const index = lines.findIndex((line) => line.includes('// Update Page'));
      const label = lines[index];
      assert(label.length < 600);
      assert(label.includes('await client.items.destroy("injected")'));
      assert(!/[\u2028\u2029\r]/.test(label));
      assert(label.includes('…'));
      assert.match(lines[index + 1], /^ {4}await client\.items\.update\(/);
      assert.equal(script.match(/client\.items\.destroy/g)?.length, 1);
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
      assert.match(script, /\n {8}await client\.items\.update/);
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

  it('replays split code with new circular records, publication divergence, schedules and deletion', async () => {
    const firstPublishedAt = '2025-02-01T00:00:00.000Z';
    const before = record(
      'published',
      { title: 'Old' },
      {
        published: { title: 'Old', related: [] },
        firstPublishedAt,
        publishedUpdatedAt: firstPublishedAt,
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
      // The main file only loops over the parts and imports what it uses.
      const main = (await readFile(test.output, 'utf8')).replace(/\s+/g, ' ');
      const parts = (await readdir(join(test.baseline, 'parts'))).sort();
      assert(parts.length > 1);
      assert(
        main.startsWith(
          'import { type ContentMigrationClient, defineContentMigration, runMigrationPart, } from "@datocms/cli-plugin-content-diff/migration"; ',
        ),
        main,
      );
      assert(
        main.includes(
          `for (const part of [ ${parts
            .map((part) => `"${part}",`)
            .join(' ')} ]) await runMigrationPart(client, __filename, part);`,
        ),
        main,
      );
      // Parts without uploads import only the client type.
      for (const part of parts) {
        const source = await readFile(
          join(test.baseline, 'parts', part),
          'utf8',
        );
        assert.deepEqual(source.match(/^import .*$/gm), [
          'import type { ContentMigrationClient } from "@datocms/cli-plugin-content-diff/migration";',
        ]);
      }
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
      },
    );
    const right = record(
      'cycle-right',
      { title: 'Right draft', related: [id('cycle-left')] },
      {
        published: { title: 'Right published', related: [id('cycle-left')] },
        firstPublishedAt,
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
      const remote = cmaFixture(test.store, test.definition);
      await runScript(test.output, remote.client);
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

  it('emits values that violate destination validators unchanged and leaves rejection to the CMA', async () => {
    const definition = schema();
    definition.models[0].fields[0].validators = {
      required: {},
      unique: {},
      length: { max: 4 },
    };
    definition.hash = schemaHash(definition);
    const invalid = record(
      'invalid-published',
      { title: '' },
      {
        published: { title: '', related: [] },
        firstPublishedAt: '2025-02-01T00:00:00.000Z',
      },
    );
    const holder = record('holder', { title: 'held' });
    const violations = [
      invalid,
      record('duplicate', { title: 'held' }),
      record('too-long', { title: 'longer than allowed' }),
    ];
    const test = await fixture([holder], [holder, ...violations], definition);
    try {
      assert.equal(test.metadata.counts.record.create, 3);
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      await typecheckScript(test);
      const script = await readFile(test.output, 'utf8');
      assert.doesNotMatch(script, /client\.fields\./);
      for (const entry of violations)
        assert.ok(script.includes(`id: ${JSON.stringify(entry.id)},`));
      const remote = cmaFixture(test.store, test.definition);
      await assert.rejects(
        runScript(test.output, remote.client),
        /publish persisted invalid record/,
      );
      assert.deepEqual(remote.definition.models[0].fields[0].validators, {
        required: {},
        unique: {},
        length: { max: 4 },
      });
    } finally {
      await test.dispose();
    }
  });

  it('changes schedules last and only for records whose schedules differ', async () => {
    const at = (day: number) => `2099-01-0${day}T00:00:00.000Z`;
    const publication = (day: number) => ({ at: at(day), selective: null });
    const unpublishing = (day: number) => ({ at: at(day), locales: null });
    const before = [
      record(
        'kept',
        { title: 'Old' },
        { schedules: { publication: publication(1), unpublishing: null } },
      ),
      record(
        'moved',
        {},
        { schedules: { publication: publication(1), unpublishing: null } },
      ),
      record(
        'cleared',
        {},
        { schedules: { publication: null, unpublishing: unpublishing(2) } },
      ),
      record(
        'deleted',
        {},
        { schedules: { publication: publication(3), unpublishing: null } },
      ),
    ];
    const after = [
      record(
        'kept',
        { title: 'New' },
        { schedules: { publication: publication(1), unpublishing: null } },
      ),
      record(
        'moved',
        {},
        {
          schedules: {
            publication: publication(4),
            unpublishing: unpublishing(5),
          },
        },
      ),
      record('cleared', {}),
      record(
        'created',
        {},
        { schedules: { publication: publication(6), unpublishing: null } },
      ),
    ];
    const test = await fixture(before, after);
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      await typecheckScript(test);
      const remote = cmaFixture(test.store, test.definition);
      await runScript(test.output, remote.client);
      const schedule = /schedule-/;
      const first = remote.events.findIndex((event) => schedule.test(event));
      assert(first > 0);
      assert(remote.events.slice(first).every((event) => schedule.test(event)));
      assert.deepEqual(remote.events.slice(first).sort(), [
        `schedule-publication:${id('created')}`,
        `schedule-publication:${id('moved')}`,
        `schedule-unpublishing:${id('moved')}`,
        `unschedule-publication:${id('moved')}`,
        `unschedule-unpublishing:${id('cleared')}`,
      ]);
      for (const state of after)
        assert.deepEqual(
          remote.records.get(state.id)!.schedules,
          state.schedules,
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
    it(`creates, replaces, updates and deletes assets from source URLs at chunk size ${chunkBytes}`, async () => {
      const old = Buffer.from('<svg>old</svg>');
      const next = Buffer.from('<svg>new</svg>');
      const test = await fixture([], []);
      test.store.putUpload('target', upload('existing', old));
      test.store.putUpload('source', upload('existing', next));
      test.store.putUpload('source', upload('new', next));
      test.store.putUpload('target', upload('described', old));
      test.store.putUpload(
        'source',
        upload('described', old, {
          attributes: {
            ...upload('described', old).attributes,
            notes: 'Described',
          },
        }),
      );
      test.store.putUpload('target', upload('removed', old));
      test.metadata = createPlan(
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
        });
        assert.deepEqual(await readdir(test.baseline), [
          'baseline',
          'chunks.jsonl',
          'manifest.json',
          'manifest.sha256',
          ...(chunkBytes === 250 ? ['parts'] : []),
        ]);
        await typecheckScript(test);
        const replayed = await replay(test);
        replayed.dispose();
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
          type: 'item',
          id: id(`block-${depth}`),
          attributes: {
            title: depth === 5 ? text : `Depth ${depth}`,
            nested: block,
          },
          relationships: {
            item_type: { data: { type: 'item_type', id: blockId } },
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
    test.metadata = createPlan(
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

  it('accepts the maximum supported chunk target', async () => {
    const test = await fixture(
      [record('boundary', {})],
      [record('boundary', { title: 'Changed' })],
    );
    try {
      await writeMigration({
        ...test,
        outputPath: test.output,
        sourceTracking: tracking,
        destinationTracking: tracking,
        chunkBytes: MAX_MIGRATION_CHUNK_BYTES,
      });
      const replayed = await replay(test);
      replayed.dispose();
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

  it('never replaces a script that appears while the companion is published', async () => {
    const test = await fixture(
      [record('record', {})],
      [record('record', { title: 'new' })],
    );
    try {
      // The check right after the companion name is claimed is the last one
      // before the script is copied; the competing file appears there.
      const signal = new AbortController().signal;
      Object.defineProperty(signal, 'aborted', {
        get() {
          if (existsSync(test.baseline) && !existsSync(test.output))
            writeFileSync(test.output, 'existing');
          return false;
        },
      });
      await assert.rejects(
        writeMigration({
          ...test,
          outputPath: test.output,
          sourceTracking: tracking,
          destinationTracking: tracking,
          signal,
        }),
        (error: ContentError) => {
          assert.equal(error.code, 'MIGRATION_EXISTS');
          assert.equal(
            error.message,
            `Migration output already exists: ${test.output}`,
          );
          return true;
        },
      );
      assert.equal(await readFile(test.output, 'utf8'), 'existing');
      assert.equal(existsSync(test.baseline), false);
      assert.deepEqual(
        (await readdir(test.directory)).filter((name) =>
          name.startsWith('.content-migration-'),
        ),
        [],
      );
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
        const difference =
          (reason: string, recordId = id('record')) =>
          (error: unknown) => {
            assert.equal((error as ContentError).code, 'DESTINATION_CHANGED');
            assert.deepEqual((error as ContentError).details, {
              kind: 'record',
              id: recordId,
              reason,
            });
            return true;
          };
        assert.throws(() => compareBaseline(loaded), difference('removed'));
        put(loaded, 'target', before, test.definition);
        compareBaseline(loaded);
        put(
          loaded,
          'target',
          record('record', { title: 'another edit' }),
          test.definition,
        );
        assert.throws(() => compareBaseline(loaded), difference('changed'));
        put(loaded, 'target', before, test.definition);
        put(loaded, 'target', record('extra', {}), test.definition);
        assert.throws(
          () => compareBaseline(loaded),
          difference('added', id('extra')),
        );
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
