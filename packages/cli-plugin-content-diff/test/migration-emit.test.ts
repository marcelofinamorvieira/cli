import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import {
  canonicalUpload,
  collectionHash,
  recordHash,
  recordReferences,
} from '../src/engine/codec';
import { writeMigration } from '../src/engine/migration-artifact';
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
import { cmaFixture, executeGeneratedScript } from './cma-fixture';
import { fixtureId as id } from './fixture-id';

const MODEL = id('emit-model');
const tracking = { apiKey: 'schema_migration', model: null };
const options = {
  modelIds: [MODEL],
  uploads: 'all' as const,
  includeDeletions: true,
  allowPartial: false,
};

function schema(
  shape: { sortable?: boolean; tree?: boolean; draftMode?: boolean } = {},
): SchemaState {
  const result: SchemaState = {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en'],
    semantics: {},
    workflows: [],
    models: [
      {
        id: MODEL,
        apiKey: 'article',
        name: 'Article',
        block: false,
        singleton: false,
        sortable: shape.sortable ?? false,
        tree: shape.tree ?? false,
        draftMode: shape.draftMode ?? true,
        saveInvalidDrafts: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: id('emit-title'),
            apiKey: 'title',
            type: 'string',
            localized: false,
            validators: {},
            defaultValue: null,
          },
          {
            id: id('emit-related'),
            apiKey: 'related',
            type: 'links',
            localized: false,
            validators: {},
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
  fields: JsonObject = {},
  overrides: Partial<RecordState> = {},
): RecordState {
  const result: RecordState = {
    id: id(name),
    modelId: MODEL,
    current: { title: name, related: [], ...fields },
    published: null,
    currentVersion: `v-${name}`,
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

function upload(
  name: string,
  content: string,
  notes: string | null = null,
): UploadState {
  return canonicalUpload({
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
    notes,
    tags: [],
  });
}

function folder(
  name: string,
  position: number,
  parent: string | null = null,
): CollectionState {
  const state = {
    id: id(name),
    label: name,
    parentId: parent ? id(parent) : null,
    position,
    hash: '',
  };
  state.hash = collectionHash(state);
  return state;
}

interface Side {
  records?: RecordState[];
  uploads?: UploadState[];
  folders?: CollectionState[];
}

function fill(
  store: SnapshotStore,
  side: 'source' | 'target',
  content: Side,
  definition: SchemaState,
) {
  for (const state of content.records ?? []) {
    store.putRecord(side, state);
    for (const ref of recordReferences(state, definition))
      store.putReference(side, ref);
  }
  for (const state of content.uploads ?? []) store.putUpload(side, state);
  for (const state of content.folders ?? []) store.putCollection(side, state);
}

/**
 * Plan and write a migration, returning its single source file, a runner
 * against the in-memory CMA, and a check that its destination ends
 * up equal to the source.
 */
async function generate(
  before: Side,
  after: Side,
  definition = schema(),
  chunkBytes?: number,
) {
  const directory = await mkdtemp(join(tmpdir(), 'content-emit-'));
  const store = new SnapshotStore(directory);
  try {
    fill(store, 'target', before, definition);
    fill(store, 'source', after, definition);
    const metadata = await createPlan(
      store,
      definition,
      { ...definition, environmentId: 'target' },
      options,
    );
    const output = join(directory, '1_emit.ts');
    await writeMigration({
      store,
      metadata,
      outputPath: output,
      sourceTracking: tracking,
      destinationTracking: tracking,
      chunkBytes,
    });
    const script = await readFile(output, 'utf8');
    typecheck(output);
    return {
      script,
      counts: metadata.counts,
      parts: join(directory, '1_emit.content', 'parts'),
      /** The script without whitespace or trailing commas, for shape assertions. */
      code: script.replace(/\s+/g, '').replace(/,([\])}])/g, '$1'),
      remote: () => cmaFixture(store, definition),
      async run(remote = cmaFixture(store, definition)) {
        await executeGeneratedScript(output, remote.client);
        return remote;
      },
      async converges(remote: ReturnType<typeof cmaFixture>) {
        const check = new SnapshotStore(directory);
        try {
          fill(check, 'source', after, definition);
          fill(
            check,
            'target',
            {
              records: [...remote.records.values()].map((state) => ({
                ...state,
                hash: recordHash(state),
              })),
              uploads: [...remote.uploads.values()],
              folders: [...remote.folders.values()],
            },
            definition,
          );
          const plan = await createPlan(
            check,
            definition,
            { ...definition, environmentId: 'target' },
            options,
          );
          for (const kind of ['record', 'upload', 'collection'] as const)
            for (const action of ['create', 'update', 'delete'] as const)
              assert.equal(plan.counts[kind][action], 0, `${kind} ${action}`);
          // The plan leaves positions to the sibling groups, so compare the
          // order of every group directly.
          const groups = (records: Iterable<RecordState>) => {
            const result = new Map<string, string[]>();
            for (const state of [...records].sort(
              (a, b) =>
                (a.position ?? 0) - (b.position ?? 0) ||
                a.id.localeCompare(b.id),
            )) {
              const group = `${state.modelId} ${state.parentId}`;
              result.set(group, [...(result.get(group) ?? []), state.id]);
            }
            return result;
          };
          assert.deepEqual(
            groups(remote.records.values()),
            groups(after.records ?? []),
          );
        } finally {
          check.dispose();
        }
      },
      async dispose() {
        store.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    store.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Generated code compiles against the real runtime and SDK types. */
function typecheck(file: string) {
  const root = resolve(__dirname, '../../..');
  const program = ts.createProgram([file], {
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

function ordered(code: string, ...fragments: string[]) {
  let from = -1;
  for (const fragment of fragments) {
    const index = code.indexOf(fragment, from + 1);
    assert(index > from, `${fragment} missing or out of order`);
    from = index;
  }
}

const rehash = (state: RecordState) => ({ ...state, hash: recordHash(state) });

const published = (name: string, fields: JsonObject = {}) =>
  record(name, fields, {
    published: { title: name, related: [], ...fields },
    firstPublishedAt: '2025-02-01T00:00:00.000Z',
    publishedUpdatedAt: '2025-02-01T00:00:00.000Z',
  });

describe('generated CMA calls', () => {
  it('locks only the first update of an existing record and never reads it first', async () => {
    const before = published('article', { title: 'Old' });
    const after = record(
      'article',
      { title: 'New draft' },
      {
        published: { title: 'New published', related: [] },
        firstPublishedAt: before.firstPublishedAt,
        publishedUpdatedAt: before.publishedUpdatedAt,
      },
    );
    const test = await generate({ records: [before] }, { records: [after] });
    try {
      const target = JSON.stringify(after.id);
      ordered(
        test.code,
        `//PreparepublicationofArticle"Newpublished"(${after.id})`,
        `client.items.update(${target},{title:"Newpublished",meta:{current_version:"v-article"}});`,
        `//PublishArticle"Newpublished"(${after.id})`,
        `client.items.publish(${target},undefined,{recursive:false});`,
        `//UpdateArticle"Newdraft"(${after.id})`,
        `client.items.update(${target},{title:"Newdraft"});`,
      );
      assert.doesNotMatch(test.script, /items\.find|\.\.\.|reorderRecords/);
      assert.equal(test.script.match(/current_version/g)?.length, 1);
      const remote = await test.run();
      assert.deepEqual(remote.updates, [
        { id: after.id, locked: true },
        { id: after.id, locked: false },
      ]);
      await test.converges(remote);
    } finally {
      await test.dispose();
    }
  });

  it('does not lock an update that follows another write to the record', async () => {
    const before = published('withdrawn');
    const after = record('withdrawn', { title: 'Withdrawn and edited' });
    const test = await generate({ records: [before] }, { records: [after] });
    try {
      ordered(
        test.code,
        `client.items.unpublish(${JSON.stringify(after.id)}`,
        `client.items.update(${JSON.stringify(
          after.id,
        )},{title:"Withdrawnandedited",meta:{first_published_at:null}});`,
      );
      assert.doesNotMatch(test.script, /current_version/);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('updates records of models without draft mode with one call and no publish', async () => {
    const before = published('page');
    const after = published('page', { title: 'Renamed' });
    const test = await generate(
      { records: [before] },
      { records: [after] },
      schema({ draftMode: false }),
    );
    try {
      assert(
        test.code.includes(
          `//UpdateArticle"Renamed"(${
            after.id
          })awaitclient.items.update(${JSON.stringify(
            after.id,
          )},{title:"Renamed",meta:{current_version:"v-page"}});`,
        ),
      );
      assert.equal(test.script.match(/client\./g)?.length, 1);
      const remote = await test.run();
      assert.deepEqual(remote.updates, [{ id: after.id, locked: true }]);
      await test.converges(remote);
    } finally {
      await test.dispose();
    }
  });

  it('sets the first publication date of an existing record before publishing it, as creates do', async () => {
    const before = record('first');
    const after = published('first');
    const test = await generate({ records: [before] }, { records: [after] });
    try {
      const target = JSON.stringify(after.id);
      ordered(
        test.code,
        `//PreparepublicationofArticle"first"(${after.id})`,
        `client.items.update(${target},{meta:{first_published_at:"2025-02-01T00:00:00.000Z",current_version:"v-first"}});`,
        `client.items.publish(${target},undefined,{recursive:false});`,
      );
      assert.equal(test.script.match(/items\.update/g)?.length, 1);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('sends unchanged blocks by ID and changed blocks with only their changed attributes', async () => {
    const SECTION = id('emit-section');
    const definition = schema();
    definition.models[0].fields.push({
      id: id('emit-body'),
      apiKey: 'body',
      type: 'rich_text',
      localized: false,
      validators: {},
      defaultValue: null,
    });
    definition.models.push({
      ...definition.models[0],
      id: SECTION,
      apiKey: 'section',
      name: 'Section',
      block: true,
      draftMode: false,
      fields: [
        {
          id: id('emit-section-text'),
          apiKey: 'text',
          type: 'string',
          localized: false,
          validators: {},
          defaultValue: null,
        },
        {
          id: id('emit-section-inner'),
          apiKey: 'inner',
          type: 'single_block',
          localized: false,
          validators: {},
          defaultValue: null,
        },
      ],
    });
    definition.hash = schemaHash(definition);
    const block = (
      name: string,
      text: string,
      inner: JsonObject | null = null,
    ): JsonObject => ({
      id: id(name),
      __itemTypeId: SECTION,
      attributes: { text, inner },
    });
    const before = record('blocks', {
      body: [
        block('first', 'first'),
        block('second', 'second', block('deep', 'deep')),
        block('third', 'third'),
      ],
    });
    const after = record('blocks', {
      body: [
        block('first', 'first'),
        block('second', 'second', block('deep', 'deeper')),
        block('added', 'added'),
        block('third', 'third'),
      ],
    });
    const test = await generate(
      { records: [before] },
      { records: [after] },
      definition,
    );
    try {
      const ref = (name: string) => JSON.stringify(id(name));
      ordered(
        test.code,
        [
          `client.items.update(${JSON.stringify(after.id)},{body:[${ref(
            'first',
          )},`,
          `{id:${ref('second')},type:"item",attributes:{inner:{id:${ref(
            'deep',
          )},type:"item",attributes:{text:"deeper"}}}},`,
          `{id:${ref(
            'added',
          )},type:"item",attributes:{text:"added",inner:null},relationships:{item_type:{data:{id:${JSON.stringify(
            SECTION,
          )},type:"item_type"}}}},`,
          `${ref('third')}],meta:{current_version:"v-blocks"}});`,
        ].join(''),
      );
      assert.equal(test.script.match(/client\./g)?.length, 1);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('publishes a published record again after reverting its unpublished changes', async () => {
    const before = record(
      'reverted',
      { title: 'Draft edit' },
      {
        published: { title: 'reverted', related: [] },
        firstPublishedAt: '2025-02-01T00:00:00.000Z',
        publishedUpdatedAt: '2025-02-01T00:00:00.000Z',
      },
    );
    const after = published('reverted');
    const test = await generate({ records: [before] }, { records: [after] });
    try {
      const target = JSON.stringify(after.id);
      ordered(
        test.code,
        `//UpdateArticle"reverted"(${after.id})`,
        `client.items.update(${target},{title:"reverted",meta:{current_version:"v-reverted"}});`,
        `//PublishArticle"reverted"(${after.id})`,
        `client.items.publish(${target},undefined,{recursive:false});`,
      );
      assert.equal(test.script.match(/client\./g)?.length, 2);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('does not lock records whose baseline has no version', async () => {
    const test = await generate(
      { records: [record('unversioned', {}, { currentVersion: null })] },
      { records: [record('unversioned', { title: 'Edited' })] },
    );
    try {
      assert.match(test.script, /client\.items\.update/);
      assert.doesNotMatch(test.script, /current_version/);
    } finally {
      await test.dispose();
    }
  });

  it('creates records without versions or positions, and tree records with their parent', async () => {
    const parent = record('parent', {}, { position: 1 });
    const child = record('child', {}, { parentId: parent.id, position: 1 });
    const test = await generate(
      {},
      { records: [parent, child] },
      schema({ tree: true }),
    );
    try {
      ordered(
        test.code,
        `//CreateArticle"parent"(${parent.id})`,
        `client.items.create({id:${JSON.stringify(
          parent.id,
        )},item_type:{id:${JSON.stringify(
          MODEL,
        )},type:"item_type"},title:"parent",related:[],meta:{created_at:"2025-01-01T00:00:00.000Z",first_published_at:null},parent_id:null});`,
        `parent_id:${JSON.stringify(parent.id)}`,
      );
      assert.doesNotMatch(
        test.script,
        /current_version|position|reorderRecords|items\.update/,
      );
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('publishes a new publication cycle provisionally, then restores its links', async () => {
    const left = published('left', { related: [id('right')] });
    const right = published('right', { related: [id('left')] });
    const test = await generate({}, { records: [left, right] });
    try {
      // The record published first is created without its link and keeps
      // it out until the other one, created with its link, is published too.
      const [first, second] = ['left', 'right']
        .map((name) => id(name))
        .sort(
          (a, b) =>
            test.code.indexOf(`client.items.publish("${a}"`) -
            test.code.indexOf(`client.items.publish("${b}"`),
        );
      ordered(
        test.code,
        `client.items.create({id:"${first}"`,
        'related:[]',
        `client.items.create({id:"${second}"`,
        `related:["${first}"]`,
        `client.items.publish("${first}"`,
        `client.items.publish("${second}"`,
        '//RestorethelinksleftoutofthefirstpublicationofArticle',
        `client.items.update("${first}",{related:["${second}"]});`,
        `client.items.publish("${first}"`,
      );
      assert.equal(test.script.match(/items\.update\(/g)?.length, 1);
      assert.doesNotMatch(test.script, /current_version/);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('reorders a changed sortable group with one call and no positions in writes', async () => {
    const definition = schema({ sortable: true });
    const before = ['a', 'b', 'c'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const after = ['c', 'a', 'b', 'd'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const test = await generate(
      { records: before },
      { records: after },
      definition,
    );
    try {
      assert.match(
        test.script,
        /import \{\s*type ContentMigrationClient,\s*defineContentMigration,\s*reorderRecords,\s*\}/,
      );
      ordered(
        test.code,
        `client.items.create({id:${JSON.stringify(id('d'))}`,
        '//ReorderArticlerecordsatthetoplevel',
        `awaitreorderRecords(client,{model:${JSON.stringify(
          MODEL,
        )},parent:null,order:${JSON.stringify(
          after.map((state) => state.id),
        )}});`,
      );
      assert.equal(test.script.match(/reorderRecords\(/g)?.length, 1);
      assert.doesNotMatch(test.script, /position|items\.update/);
      const remote = await test.run();
      // One listing and one move put the group in order; one more confirms it.
      assert.deepEqual(remote.lists, [MODEL, MODEL]);
      assert.deepEqual(remote.updates, [{ id: id('c'), locked: false }]);
      await test.converges(remote);
    } finally {
      await test.dispose();
    }
  });

  it('creates new records of a sortable group in their desired order', async () => {
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const test = await generate(
      { records: [] },
      { records: after },
      schema({ sortable: true }),
    );
    try {
      ordered(
        test.code,
        ...after.map(
          (state) => `client.items.create({id:${JSON.stringify(state.id)}`,
        ),
      );
      assert.equal(test.script.match(/reorderRecords\(/g)?.length, 1);
      const remote = await test.run();
      assert.deepEqual(remote.updates, []);
      await test.converges(remote);
    } finally {
      await test.dispose();
    }
  });

  it('imports runtime helpers only into the parts that call them', async () => {
    const after = ['c', 'a', 'b', 'd'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const test = await generate(
      {
        records: ['a', 'b', 'c'].map((name, index) =>
          record(name, {}, { position: index + 1 }),
        ),
      },
      { records: after },
      schema({ sortable: true }),
      300,
    );
    try {
      assert.match(
        test.script,
        /import \{\s*type ContentMigrationClient,\s*defineContentMigration,\s*runMigrationPart,\s*\}/,
      );
      const parts = (await readdir(test.parts)).sort();
      assert(parts.length > 1);
      const sources = await Promise.all(
        parts.map((part) => readFile(join(test.parts, part), 'utf8')),
      );
      const calling = sources.filter((source) =>
        source.includes('await reorderRecords('),
      );
      assert.equal(calling.length, 1);
      for (const source of sources)
        assert.match(
          source,
          source === calling[0]
            ? /^import \{\s*type ContentMigrationClient,\s*reorderRecords,\s*\} from/
            : /^import type \{ ContentMigrationClient \} from/,
        );
      for (const part of parts) typecheck(join(test.parts, part));
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  for (const [name, after] of [
    [
      'an unchanged order',
      ['a', 'b', 'c'].map((name, index) =>
        record(name, { title: `${name} edited` }, { position: index + 1 }),
      ),
    ],
    [
      'a group that only loses records',
      ['a', 'c'].map((name, index) =>
        record(name, {}, { position: index + 1 }),
      ),
    ],
  ] as const)
    it(`emits no ordering code for ${name}`, async () => {
      const test = await generate(
        {
          records: ['a', 'b', 'c'].map((name, index) =>
            record(name, {}, { position: index + 1 }),
          ),
        },
        { records: [...after] },
        schema({ sortable: true }),
      );
      try {
        assert.doesNotMatch(test.script, /reorderRecords|position/);
        await test.converges(await test.run());
      } finally {
        await test.dispose();
      }
    });

  it('plans no update for records that only shift within their group', async () => {
    const names = Array.from({ length: 30 }, (_, index) => `r${index}`);
    const inserted = [...names.slice(0, 15), 'new', ...names.slice(15)];
    const test = await generate(
      {
        records: names.map((name, index) =>
          record(name, {}, { position: index + 1 }),
        ),
      },
      {
        records: inserted.map((name, index) =>
          record(name, {}, { position: index + 1 }),
        ),
      },
      schema({ sortable: true }),
    );
    try {
      assert.deepEqual(test.counts.record, {
        create: 1,
        update: 0,
        delete: 0,
        noop: 30,
        skip: 0,
      });
      assert.equal(test.script.match(/client\./g)?.length, 1);
      assert.equal(test.script.match(/reorderRecords\(/g)?.length, 1);
      assert(
        test.code.includes(
          `order:${JSON.stringify(inserted.map((name) => id(name)))}`,
        ),
      );
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('reorders a swapped pair with one call and no updates', async () => {
    const test = await generate(
      {
        records: ['a', 'b', 'c'].map((name, index) =>
          record(name, {}, { position: index + 1 }),
        ),
      },
      {
        records: ['a', 'c', 'b'].map((name, index) =>
          record(name, {}, { position: index + 1 }),
        ),
      },
      schema({ sortable: true }),
    );
    try {
      assert.equal(test.counts.record.update, 0);
      assert.doesNotMatch(test.script, /client\./);
      assert.equal(test.script.match(/reorderRecords\(/g)?.length, 1);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('moves a tree record with parent_id and reorders only its new sibling group', async () => {
    const roots = ['one', 'two'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const before = [
      ...roots,
      record('moved', {}, { parentId: id('one'), position: 1 }),
      record('stays', {}, { parentId: id('two'), position: 1 }),
    ];
    const after = [
      ...roots,
      record('moved', {}, { parentId: id('two'), position: 1 }),
      record('stays', {}, { parentId: id('two'), position: 2 }),
    ];
    const test = await generate(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    try {
      ordered(
        test.code,
        `//MoveArticle"moved"(${id('moved')})underArticle"two"(${id('two')})`,
        `client.items.update(${JSON.stringify(
          id('moved'),
        )},{parent_id:${JSON.stringify(
          id('two'),
        )},meta:{current_version:"v-moved"}});`,
        `//ReorderArticlerecordsunderArticle"two"(${id('two')})`,
        `parent:${JSON.stringify(id('two'))},order:${JSON.stringify([
          id('moved'),
          id('stays'),
        ])}`,
      );
      assert.equal(test.script.match(/reorderRecords\(/g)?.length, 1);
      assert.doesNotMatch(test.script, /position/);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('does not lock the first update of a sibling renumbered by an earlier move', async () => {
    const roots = ['one', 'two'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const before = [
      ...roots,
      record('first', {}, { parentId: id('one'), position: 1 }),
      record('moved', {}, { parentId: id('one'), position: 2 }),
      record('after', {}, { parentId: id('one'), position: 3 }),
    ];
    const after = [
      ...roots,
      record(
        'first',
        { title: 'First edited' },
        { parentId: id('one'), position: 1 },
      ),
      record('moved', {}, { parentId: id('two'), position: 1 }),
      record(
        'after',
        { title: 'After edited' },
        { parentId: id('one'), position: 2 },
      ),
    ];
    const test = await generate(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    try {
      for (const sibling of [
        `client.items.update(${JSON.stringify(
          id('first'),
        )},{title:"Firstedited",meta:{current_version:"v-first"}});`,
        `client.items.update(${JSON.stringify(
          id('after'),
        )},{title:"Afteredited"});`,
      ])
        ordered(test.code, `//MoveArticle"moved"(${id('moved')})`, sibling);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('moves and renames a record of a model without draft mode in one update', async () => {
    const roots = ['one', 'two'].map((name, index) => ({
      ...published(name),
      position: index + 1,
    }));
    const kid = (title: string, parent: string) =>
      rehash({
        ...published('kid', { title }),
        parentId: id(parent),
        position: 1,
      });
    const test = await generate(
      { records: [...roots, kid('Kid', 'one')] },
      { records: [...roots, kid('Kid renamed', 'two')] },
      schema({ tree: true, draftMode: false }),
    );
    try {
      ordered(
        test.code,
        `//UpdateArticle"Kidrenamed"(${id('kid')})`,
        `client.items.update(${JSON.stringify(
          id('kid'),
        )},{title:"Kidrenamed",parent_id:${JSON.stringify(
          id('two'),
        )},meta:{current_version:"v-kid"}});`,
      );
      assert.equal(test.script.match(/client\.items\.update\(/g)?.length, 1);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('moves and edits the draft of a record whose publication stays in one update', async () => {
    const roots = ['one', 'two'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const test = await generate(
      {
        records: [
          ...roots,
          record('kid', {}, { parentId: id('one'), position: 1 }),
        ],
      },
      {
        records: [
          ...roots,
          record(
            'kid',
            { title: 'Kid draft' },
            { parentId: id('two'), position: 1 },
          ),
        ],
      },
      schema({ tree: true }),
    );
    try {
      ordered(
        test.code,
        `//UpdateArticle"Kiddraft"(${id('kid')})`,
        `client.items.update(${JSON.stringify(
          id('kid'),
        )},{title:"Kiddraft",parent_id:${JSON.stringify(
          id('two'),
        )},meta:{current_version:"v-kid"}});`,
      );
      assert.equal(test.script.match(/client\.items\.update\(/g)?.length, 1);
      assert.doesNotMatch(test.script, /items\.publish/);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('moves a record under its new parent before publishing it there', async () => {
    // The old parent stays unpublished, so publishing the record while it
    // still sits there would fail.
    const before = [
      record('old', {}, { position: 1 }),
      { ...published('new'), position: 2 },
      record('leaf', {}, { parentId: id('old'), position: 1 }),
    ].map(rehash);
    const after = [
      record('old', {}, { position: 1 }),
      { ...published('new'), position: 2 },
      record(
        'leaf',
        { title: 'Leaf renamed' },
        {
          published: { title: 'Leaf renamed', related: [] },
          firstPublishedAt: '2025-03-01T00:00:00.000Z',
          publishedUpdatedAt: '2025-03-01T00:00:00.000Z',
          parentId: id('new'),
          position: 1,
        },
      ),
    ].map(rehash);
    const test = await generate(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    try {
      ordered(
        test.code,
        `//PreparepublicationofArticle"Leafrenamed"(${id('leaf')})`,
        `client.items.update(${JSON.stringify(
          id('leaf'),
        )},{title:"Leafrenamed",parent_id:${JSON.stringify(id('new'))},meta:{`,
        `//PublishArticle"Leafrenamed"(${id('leaf')})`,
      );
      assert.doesNotMatch(test.code, /\/\/Move/);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('moves a published record out of a parent before unpublishing that parent', async () => {
    const before = [
      { ...published('old'), position: 1 },
      { ...published('new'), position: 2 },
      { ...published('leaf'), parentId: id('old'), position: 1 },
    ].map(rehash);
    const after = [
      record('old', {}, { position: 1 }),
      { ...published('new'), position: 2 },
      { ...published('leaf'), parentId: id('new'), position: 1 },
    ].map(rehash);
    const test = await generate(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    try {
      ordered(
        test.code,
        `//MoveArticle"leaf"(${id('leaf')})underArticle"new"(${id('new')})`,
        `//UnpublishArticle"old"(${id('old')})`,
      );
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('creates, replaces and updates assets from source URLs with MD5 checks', async () => {
    const test = await generate(
      {
        uploads: [upload('replaced', 'old'), upload('described', 'same')],
      },
      {
        uploads: [
          upload('created', 'new'),
          upload('replaced', 'newer'),
          upload('described', 'same', 'Described'),
        ],
      },
    );
    const url = (name: string) =>
      JSON.stringify(
        `https://assets.example.test/${name}.svg?skip-default-optimizations=true&svg-sanitize=false`,
      );
    const md5 = (content: string) =>
      JSON.stringify(createHash('md5').update(content).digest('hex'));
    try {
      ordered(
        test.code,
        `//Createasset"created.svg"(${id('created')})`,
        `{constupload=awaitclient.uploads.createFromUrl({id:${JSON.stringify(
          id('created'),
        )},url:${url(
          'created',
        )},filename:"created.svg",author:null,copyright:null,notes:null,tags:[],upload_collection:null});if(upload.md5!==${md5(
          'new',
        )})thrownewError("Asset${id(
          'created',
        )}changedinthesourcesincethediffgeneration.Pleasere-generateadifftoapply.");}`,
      );
      ordered(
        test.code,
        `//Replacethefileofasset"replaced.svg"(${id('replaced')})`,
        `client.uploads.updateFromUrl(${JSON.stringify(
          id('replaced'),
        )},{url:${url(
          'replaced',
        )},filename:"replaced.svg",basename:"replaced",author:null,copyright:null,notes:null,tags:[],upload_collection:null});if(upload.md5!==${md5(
          'newer',
        )})`,
      );
      assert(
        test.code.includes(
          `client.uploads.update(${JSON.stringify(
            id('described'),
          )},{notes:"Described"});`,
        ),
      );
      await test.converges(await test.run());
      // A source file that changed after generation stops the script.
      const remote = test.remote();
      remote.remoteFiles.set('https://assets.example.test/created.svg', {
        md5: '0'.repeat(32),
        size: 3,
      });
      await assert.rejects(
        test.run(remote),
        new RegExp(
          `Asset ${id(
            'created',
          )} changed in the source since the diff generation\\. Please re-generate a diff to apply\\.`,
        ),
      );
    } finally {
      await test.dispose();
    }
  });

  it('changes schedules last, destroying and creating only what differs', async () => {
    const at = '2099-01-01T00:00:00.000Z';
    const test = await generate(
      {
        records: [
          record(
            'scheduled',
            {},
            {
              schedules: {
                publication: { at, selective: null },
                unpublishing: null,
              },
            },
          ),
        ],
      },
      {
        records: [
          record(
            'scheduled',
            { title: 'Edited' },
            {
              schedules: {
                publication: null,
                unpublishing: { at, locales: null },
              },
            },
          ),
        ],
      },
    );
    try {
      const target = JSON.stringify(id('scheduled'));
      ordered(
        test.code,
        `client.items.update(${target}`,
        `//RemovethescheduledpublicationofArticle"Edited"(${id('scheduled')})`,
        `client.scheduledPublication.destroy(${target});`,
        '//ScheduletheunpublishingofArticle',
        `client.scheduledUnpublishing.create(${target},{unpublishing_scheduled_at:"${at}",content_in_locales:null});`,
      );
      assert.doesNotMatch(
        test.script,
        /scheduledPublication\.create|scheduledUnpublishing\.destroy/,
      );
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('deletes records, assets and folders without versions, deepest folders first', async () => {
    const test = await generate(
      {
        records: [record('kept'), record('deleted')],
        uploads: [upload('removed', 'bytes')],
        folders: [
          folder('kept-folder', 1),
          folder('parent', 2),
          folder('child', 1, 'parent'),
        ],
      },
      { records: [record('kept')], folders: [folder('kept-folder', 1)] },
    );
    try {
      ordered(
        test.code,
        `//DeleteArticle"deleted"(${id('deleted')})`,
        `client.items.destroy(${JSON.stringify(id('deleted'))});`,
        `//Deleteasset"removed.svg"(${id('removed')})`,
        `client.uploads.destroy(${JSON.stringify(id('removed'))});`,
        `client.uploadCollections.destroy(${JSON.stringify(id('child'))});`,
        `client.uploadCollections.destroy(${JSON.stringify(id('parent'))});`,
        `client.uploadCollections.reorder([{id:${JSON.stringify(
          id('kept-folder'),
        )},type:"upload_collection",position:1,parent:null}]);`,
      );
      assert.doesNotMatch(test.script, /current_version/);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });

  it('sets no folder positions once every folder is deleted', async () => {
    const test = await generate(
      { folders: [folder('parent', 1), folder('child', 1, 'parent')] },
      {},
    );
    try {
      ordered(
        test.code,
        `client.uploadCollections.destroy(${JSON.stringify(id('child'))});`,
        `client.uploadCollections.destroy(${JSON.stringify(id('parent'))});`,
      );
      assert.doesNotMatch(test.script, /uploadCollections\.reorder/);
      await test.converges(await test.run());
    } finally {
      await test.dispose();
    }
  });
});
