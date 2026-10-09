import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalUpload,
  collectionHash,
  recordHash,
} from '../src/engine/codec';
import type { Operation } from '../src/engine/operations';
import { schemaHash } from '../src/engine/schema';
import type {
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { cmaFixture } from './cma-fixture';
import { fixtureId as id } from './fixture-id';
import {
  type Content,
  content,
  diff,
  replay,
  run,
  writeTestDiff,
} from './pipeline';

const MODEL = id('emit-model');
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

const md5 = (bytes: string) => createHash('md5').update(bytes).digest('hex');

function upload(
  name: string,
  bytes: string,
  notes: string | null = null,
): UploadState {
  return canonicalUpload({
    id: id(name),
    basename: name,
    filename: `${name}.svg`,
    md5: md5(bytes),
    size: bytes.length,
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

const rehash = (state: RecordState) => ({ ...state, hash: recordHash(state) });

const published = (name: string, fields: JsonObject = {}) =>
  record(name, fields, {
    published: { title: name, related: [], ...fields },
    firstPublishedAt: '2025-02-01T00:00:00.000Z',
    publishedUpdatedAt: '2025-02-01T00:00:00.000Z',
  });

/** How labels name a record: its model, its title and its ID. */
const article = (name: string, title = name) =>
  `Article "${title}" (${id(name)})`;

/** The check a first operation on an existing record carries. */
const expected = (state: RecordState) => ({
  currentVersion: state.currentVersion,
  publishedUpdatedAt: state.publishedUpdatedAt,
});

/** Record IDs of each sibling group, in order. */
function groups(records: Iterable<RecordState>) {
  const result = new Map<string, string[]>();
  for (const state of [...records].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id),
  )) {
    const group = `${state.modelId} ${state.parentId}`;
    result.set(group, [...(result.get(group) ?? []), state.id]);
  }
  return result;
}

/**
 * Replays `after` over `before` against the in-memory CMA. Planning leaves
 * positions to the sibling groups, so their order is compared directly.
 */
async function replayed(
  before: Partial<Content>,
  after: Partial<Content>,
  sourceSchema = schema(),
) {
  const source = content(after);
  const result = await replay({
    source,
    target: content(before),
    sourceSchema,
    options,
  });
  assert.deepEqual(
    groups(result.fixture.records.values()),
    groups(source.records),
  );
  return result;
}

const ops = (operations: Operation[]) =>
  operations.map((operation) => operation.op);

describe('diff operations', () => {
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
    const { operations, fixture } = await replayed(
      { records: [before] },
      { records: [after] },
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: after.id,
        label: `Prepare publication of ${article('article', 'New published')}`,
        expect: expected(before),
        data: {
          title: 'New published',
          meta: { current_version: 'v-article' },
        },
      },
      {
        op: 'record.publish',
        id: after.id,
        label: `Publish ${article('article', 'New published')}`,
      },
      {
        op: 'record.update',
        id: after.id,
        label: `Update ${article('article', 'New draft')}`,
        data: { title: 'New draft' },
      },
    ]);
    assert.deepEqual(fixture.updates, [
      { id: after.id, locked: true },
      { id: after.id, locked: false },
    ]);
  });

  it('does not lock an update that follows another write to the record', async () => {
    const before = published('withdrawn');
    const after = record('withdrawn', { title: 'Withdrawn and edited' });
    const { operations } = await replayed(
      { records: [before] },
      { records: [after] },
    );
    assert.deepEqual(operations, [
      {
        op: 'record.unpublish',
        id: after.id,
        label: `Unpublish ${article('withdrawn')}`,
        expect: expected(before),
      },
      {
        op: 'record.update',
        id: after.id,
        label: `Update ${article('withdrawn', 'Withdrawn and edited')}`,
        data: {
          title: 'Withdrawn and edited',
          meta: { first_published_at: null },
        },
      },
    ]);
  });

  it('updates records of models without draft mode with one call and no publish', async () => {
    const before = published('page');
    const after = published('page', { title: 'Renamed' });
    const { operations, fixture } = await replayed(
      { records: [before] },
      { records: [after] },
      schema({ draftMode: false }),
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: after.id,
        label: `Update ${article('page', 'Renamed')}`,
        expect: expected(before),
        data: { title: 'Renamed', meta: { current_version: 'v-page' } },
      },
    ]);
    assert.deepEqual(fixture.updates, [{ id: after.id, locked: true }]);
  });

  it('sets the first publication date of an existing record before publishing it, as creates do', async () => {
    const before = record('first');
    const after = published('first');
    const { operations } = await replayed(
      { records: [before] },
      { records: [after] },
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: after.id,
        label: `Prepare publication of ${article('first')}`,
        expect: expected(before),
        data: {
          meta: {
            first_published_at: '2025-02-01T00:00:00.000Z',
            current_version: 'v-first',
          },
        },
      },
      {
        op: 'record.publish',
        id: after.id,
        label: `Publish ${article('first')}`,
      },
    ]);
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
    const { operations } = await replayed(
      { records: [before] },
      { records: [after] },
      definition,
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: after.id,
        label: `Update ${article('blocks')}`,
        expect: expected(before),
        data: {
          body: [
            id('first'),
            {
              type: 'item',
              id: id('second'),
              attributes: {
                inner: {
                  type: 'item',
                  id: id('deep'),
                  attributes: { text: 'deeper' },
                },
              },
            },
            {
              type: 'item',
              id: id('added'),
              attributes: { text: 'added', inner: null },
              relationships: {
                item_type: { data: { type: 'item_type', id: SECTION } },
              },
            },
            id('third'),
          ],
          meta: { current_version: 'v-blocks' },
        },
      },
    ]);
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
    const { operations } = await replayed(
      { records: [before] },
      { records: [after] },
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: after.id,
        label: `Update ${article('reverted')}`,
        expect: expected(before),
        data: { title: 'reverted', meta: { current_version: 'v-reverted' } },
      },
      {
        op: 'record.publish',
        id: after.id,
        label: `Publish ${article('reverted')}`,
      },
    ]);
  });

  it('does not lock records whose baseline has no version', async () => {
    const before = record('unversioned', {}, { currentVersion: null });
    const { operations, fixture } = await replayed(
      { records: [before] },
      { records: [record('unversioned', { title: 'Edited' })] },
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: before.id,
        label: `Update ${article('unversioned', 'Edited')}`,
        expect: { currentVersion: null, publishedUpdatedAt: null },
        data: { title: 'Edited' },
      },
    ]);
    assert.deepEqual(fixture.updates, [{ id: before.id, locked: false }]);
  });

  it('creates records without versions or positions, and tree records with their parent', async () => {
    const parent = record('parent', {}, { position: 1 });
    const child = record('child', {}, { parentId: parent.id, position: 1 });
    const { operations } = await replayed(
      {},
      { records: [parent, child] },
      schema({ tree: true }),
    );
    const created = (state: RecordState) => ({
      op: 'record.create',
      id: state.id,
      label: `Create ${article(state.current.title as string)}`,
      data: {
        item_type: { id: MODEL, type: 'item_type' },
        title: state.current.title,
        related: [],
        meta: {
          created_at: '2025-01-01T00:00:00.000Z',
          first_published_at: null,
        },
        parent_id: state.parentId,
      },
    });
    assert.deepEqual(operations, [created(parent), created(child)]);
  });

  it('publishes a new publication cycle provisionally, then restores its links', async () => {
    const left = published('left', { related: [id('right')] });
    const right = published('right', { related: [id('left')] });
    const { operations } = await replayed({}, { records: [left, right] });
    // The record published first is created without its link and keeps it
    // out until the other one, created with its link, is published too.
    const first = operations.find(
      (operation) => operation.op === 'record.publish',
    )!.id!;
    const [name, other] =
      first === left.id ? ['left', 'right'] : ['right', 'left'];
    const created = (subject: string, related: string[]) => ({
      op: 'record.create',
      id: id(subject),
      label: `Create ${article(subject)}`,
      data: {
        item_type: { id: MODEL, type: 'item_type' },
        title: subject,
        related,
        meta: {
          created_at: '2025-01-01T00:00:00.000Z',
          first_published_at: '2025-02-01T00:00:00.000Z',
        },
      },
    });
    const publish = (subject: string) => ({
      op: 'record.publish',
      id: id(subject),
      label: `Publish ${article(subject)}`,
    });
    assert.deepEqual(operations, [
      created(name, []),
      created(other, [id(name)]),
      publish(name),
      publish(other),
      {
        op: 'record.update',
        id: id(name),
        label: `Restore the links left out of the first publication of ${article(
          name,
        )}`,
        data: { related: [id(other)] },
      },
      publish(name),
    ]);
  });

  it('reorders a changed sortable group with one call and no positions in writes', async () => {
    const before = ['a', 'b', 'c'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const after = ['c', 'a', 'b', 'd'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const { operations, fixture } = await replayed(
      { records: before },
      { records: after },
      schema({ sortable: true }),
    );
    assert.deepEqual(ops(operations), ['record.create', 'records.reorder']);
    assert.equal(operations[0].id, id('d'));
    assert.doesNotMatch(JSON.stringify(operations[0]), /position/);
    assert.deepEqual(operations[1], {
      op: 'records.reorder',
      label: 'Reorder Article records at the top level',
      data: {
        model: MODEL,
        parent: null,
        order: after.map((state) => state.id),
      },
    });
    // One listing and one move put the group in order; one more confirms it.
    assert.deepEqual(fixture.lists, [MODEL, MODEL]);
    assert.deepEqual(fixture.updates, [{ id: id('c'), locked: false }]);
  });

  it('creates new records of a sortable group in their desired order', async () => {
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const { operations, fixture } = await replayed(
      { records: [] },
      { records: after },
      schema({ sortable: true }),
    );
    assert.deepEqual(
      operations.map((operation) => [operation.op, operation.id]),
      [
        ...after.map((state) => ['record.create', state.id]),
        ['records.reorder', undefined],
      ],
    );
    assert.deepEqual(fixture.updates, []);
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
    it(`emits no ordering operation for ${name}`, async () => {
      const { operations } = await replayed(
        {
          records: ['a', 'b', 'c'].map((name, index) =>
            record(name, {}, { position: index + 1 }),
          ),
        },
        { records: [...after] },
        schema({ sortable: true }),
      );
      assert(operations.length);
      assert(!ops(operations).includes('records.reorder'));
      assert.doesNotMatch(JSON.stringify(operations), /position/);
    });

  it('plans no update for records that only shift within their group', async () => {
    const names = Array.from({ length: 30 }, (_, index) => `r${index}`);
    const inserted = [...names.slice(0, 15), 'new', ...names.slice(15)];
    const { plan, operations } = await replayed(
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
    assert.deepEqual(plan.metadata.counts.record, {
      create: 1,
      update: 0,
      delete: 0,
      noop: 30,
      skip: 0,
    });
    assert.deepEqual(ops(operations), ['record.create', 'records.reorder']);
    assert.deepEqual(
      (operations[1].data as JsonObject).order,
      inserted.map((name) => id(name)),
    );
  });

  it('reorders a swapped pair with one call and no updates', async () => {
    const { plan, operations } = await replayed(
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
    assert.equal(plan.metadata.counts.record.update, 0);
    assert.deepEqual(ops(operations), ['records.reorder']);
  });

  it('moves a tree record with parent_id and reorders only its new sibling group', async () => {
    const roots = ['one', 'two'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const moved = record('moved', {}, { parentId: id('one'), position: 1 });
    const before = [
      ...roots,
      moved,
      record('stays', {}, { parentId: id('two'), position: 1 }),
    ];
    const after = [
      ...roots,
      record('moved', {}, { parentId: id('two'), position: 1 }),
      record('stays', {}, { parentId: id('two'), position: 2 }),
    ];
    const { operations } = await replayed(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: id('moved'),
        label: `Move ${article('moved')} under ${article('two')}`,
        expect: expected(moved),
        data: { parent_id: id('two'), meta: { current_version: 'v-moved' } },
      },
      {
        op: 'records.reorder',
        label: `Reorder Article records under ${article('two')}`,
        data: {
          model: MODEL,
          parent: id('two'),
          order: [id('moved'), id('stays')],
        },
      },
    ]);
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
    const { operations } = await replayed(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    assert.equal(
      operations[0].label,
      `Move ${article('moved')} under ${article('two')}`,
    );
    const update = (name: string) =>
      operations
        .slice(1)
        .find(
          (operation) =>
            operation.op === 'record.update' && operation.id === id(name),
        )?.data;
    assert.deepEqual(update('first'), {
      title: 'First edited',
      meta: { current_version: 'v-first' },
    });
    assert.deepEqual(update('after'), { title: 'After edited' });
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
    const { operations } = await replayed(
      { records: [...roots, kid('Kid', 'one')] },
      { records: [...roots, kid('Kid renamed', 'two')] },
      schema({ tree: true, draftMode: false }),
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: id('kid'),
        label: `Update ${article('kid', 'Kid renamed')}`,
        expect: expected(kid('Kid', 'one')),
        data: {
          title: 'Kid renamed',
          parent_id: id('two'),
          meta: { current_version: 'v-kid' },
        },
      },
    ]);
  });

  it('moves and edits the draft of a record whose publication stays in one update', async () => {
    const roots = ['one', 'two'].map((name, index) =>
      record(name, {}, { position: index + 1 }),
    );
    const before = record('kid', {}, { parentId: id('one'), position: 1 });
    const { operations } = await replayed(
      { records: [...roots, before] },
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
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: id('kid'),
        label: `Update ${article('kid', 'Kid draft')}`,
        expect: expected(before),
        data: {
          title: 'Kid draft',
          parent_id: id('two'),
          meta: { current_version: 'v-kid' },
        },
      },
    ]);
  });

  it('moves a record under its new parent before publishing it there', async () => {
    // The old parent stays unpublished, so publishing the record while it
    // still sits there would fail.
    const leaf = record('leaf', {}, { parentId: id('old'), position: 1 });
    const before = [
      record('old', {}, { position: 1 }),
      { ...published('new'), position: 2 },
      leaf,
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
    const { operations } = await replayed(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: id('leaf'),
        label: `Prepare publication of ${article('leaf', 'Leaf renamed')}`,
        expect: expected(leaf),
        data: {
          title: 'Leaf renamed',
          parent_id: id('new'),
          meta: {
            first_published_at: '2025-03-01T00:00:00.000Z',
            current_version: 'v-leaf',
          },
        },
      },
      {
        op: 'record.publish',
        id: id('leaf'),
        label: `Publish ${article('leaf', 'Leaf renamed')}`,
      },
    ]);
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
    const { operations } = await replayed(
      { records: before },
      { records: after },
      schema({ tree: true }),
    );
    const labels = operations.map((operation) => operation.label);
    const move = labels.indexOf(
      `Move ${article('leaf')} under ${article('new')}`,
    );
    assert(move >= 0);
    assert(move < labels.indexOf(`Unpublish ${article('old')}`));
  });

  it('creates, replaces and updates assets from source URLs with MD5 checks', async () => {
    const before = content({
      uploads: [upload('replaced', 'old'), upload('described', 'same')],
    });
    const after = content({
      uploads: [
        upload('created', 'new'),
        upload('replaced', 'newer'),
        upload('described', 'same', 'Described'),
      ],
    });
    const { plan, operations } = await replayed(before, after);
    const url = (name: string) =>
      `https://assets.example.test/${name}.svg?skip-default-optimizations=true&svg-sanitize=false`;
    const attributes = { author: null, copyright: null, notes: null, tags: [] };
    assert.deepEqual(
      Object.fromEntries(
        operations.map((operation) => [operation.id, operation]),
      ),
      {
        [id('created')]: {
          op: 'upload.create',
          id: id('created'),
          label: `Create asset "created.svg" (${id('created')})`,
          url: url('created'),
          md5: md5('new'),
          data: {
            filename: 'created.svg',
            ...attributes,
            upload_collection: null,
          },
        },
        [id('replaced')]: {
          op: 'upload.replace',
          id: id('replaced'),
          label: `Replace the file of asset "replaced.svg" (${id('replaced')})`,
          expect: { hash: before.uploads[0].hash },
          url: url('replaced'),
          md5: md5('newer'),
          data: {
            filename: 'replaced.svg',
            basename: 'replaced',
            ...attributes,
            upload_collection: null,
          },
        },
        [id('described')]: {
          op: 'upload.update',
          id: id('described'),
          label: `Update asset "described.svg" (${id('described')})`,
          expect: { hash: before.uploads[1].hash },
          data: { notes: 'Described' },
        },
      },
    );
    // A source file that changed after generation stops the run.
    const remote = cmaFixture(before, schema(), after);
    remote.remoteFiles.set('https://assets.example.test/created.svg', {
      md5: '0'.repeat(32),
      size: 3,
    });
    const directory = await mkdtemp(join(tmpdir(), 'content-emit-'));
    try {
      await assert.rejects(
        run(remote.client, await writeTestDiff(directory, plan, operations)),
        {
          code: 'ASSET_CHANGED',
          message: new RegExp(
            `^operations/\\S+ line \\d+, Create asset "created\\.svg" \\(${id(
              'created',
            )}\\): Asset ${id(
              'created',
            )} .*changed in the source since the diff generation\\. Please re-generate a diff to apply\\.$`,
          ),
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uploads new files from the diff entries when the source has them', async () => {
    const { operations } = await diff({
      source: content({ uploads: [upload('created', 'new')] }),
      target: content(),
      sourceSchema: schema(),
      options,
      assetFiles: true,
    });
    assert.equal(operations.length, 1);
    assert.equal(operations[0].file, `assets/${id('created')}/created.svg`);
    assert.equal(operations[0].url, undefined);
    assert.equal(operations[0].md5, md5('new'));
  });

  it('changes schedules last, destroying and creating only what differs', async () => {
    const at = '2099-01-01T00:00:00.000Z';
    const before = record(
      'scheduled',
      {},
      {
        schedules: {
          publication: { at, selective: null },
          unpublishing: null,
        },
      },
    );
    const { operations } = await replayed(
      { records: [before] },
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
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: before.id,
        label: `Update ${article('scheduled', 'Edited')}`,
        expect: expected(before),
        data: { title: 'Edited', meta: { current_version: 'v-scheduled' } },
      },
      {
        op: 'schedule.publication.delete',
        id: before.id,
        label: `Remove the scheduled publication of ${article(
          'scheduled',
          'Edited',
        )}`,
      },
      {
        op: 'schedule.unpublishing.create',
        id: before.id,
        label: `Schedule the unpublishing of ${article('scheduled', 'Edited')}`,
        data: { unpublishing_scheduled_at: at, content_in_locales: null },
      },
    ]);
  });

  it('deletes records, assets and folders without versions, deepest folders first', async () => {
    const before = content({
      records: [record('kept'), record('deleted')],
      uploads: [upload('removed', 'bytes')],
      collections: [
        folder('kept-folder', 1),
        folder('parent', 2),
        folder('child', 1, 'parent'),
      ],
    });
    const { operations } = await replayed(before, {
      records: [record('kept')],
      collections: [folder('kept-folder', 1)],
    });
    const deleted = (name: string) => ({
      op: 'folder.delete',
      id: id(name),
      label: `Delete folder "${name}" (${id(name)})`,
      expect: {
        hash: before.collections.find((state) => state.id === id(name))!.hash,
      },
    });
    assert.deepEqual(operations, [
      {
        op: 'record.delete',
        id: id('deleted'),
        label: `Delete ${article('deleted')}`,
        expect: expected(before.records[1]),
      },
      {
        op: 'upload.delete',
        id: id('removed'),
        label: `Delete asset "removed.svg" (${id('removed')})`,
        expect: { hash: before.uploads[0].hash },
      },
      deleted('child'),
      deleted('parent'),
      {
        op: 'folders.reorder',
        label: 'Set the position of every folder',
        data: [
          {
            id: id('kept-folder'),
            type: 'upload_collection',
            position: 1,
            parent: null,
          },
        ],
      },
    ]);
  });

  it('sets no folder positions once every folder is deleted', async () => {
    const { operations } = await replayed(
      { collections: [folder('parent', 1), folder('child', 1, 'parent')] },
      {},
    );
    assert.deepEqual(
      operations.map((operation) => [operation.op, operation.id]),
      [
        ['folder.delete', id('child')],
        ['folder.delete', id('parent')],
      ],
    );
  });
});
