import assert from 'node:assert/strict';
import { collectionHash, hashJson, recordHash } from '../src/engine/codec';
import { ContentError } from '../src/engine/errors';
import {
  assertSchemaCompatible,
  createPlan,
  creationEmptyValue,
  orderedCollectionWrites,
} from '../src/engine/planner';
import { PlannerGraph } from '../src/engine/planner-graph';
import { SnapshotStore } from '../src/engine/store';
import type {
  CollectionState,
  FieldSchema,
  JsonObject,
  ModelSchema,
  PlanOptions,
  RecordPlan,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { fixtureId } from './fixture-id';

const id = fixtureId;
const MODEL = id('model');
const TITLE = id('title');
const LINK = id('link');
const BLOCK_MODEL = id('block-model');
const BLOCK_FIELD = id('block-field');
const A = id('a');
const B = id('b');
const C = id('c');

function field(overrides: Partial<FieldSchema> = {}): FieldSchema {
  return {
    id: TITLE,
    apiKey: 'title',
    type: 'string',
    localized: false,
    validators: {},
    defaultValue: null,
    ...overrides,
  };
}
function model(overrides: Partial<ModelSchema> = {}): ModelSchema {
  return {
    id: MODEL,
    apiKey: 'page',
    name: 'Page',
    block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: true,
    saveInvalidDrafts: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [field()],
    ...overrides,
  };
}
function schema(models: ModelSchema[] = [model()]): SchemaState {
  const result: SchemaState = {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en'],
    semantics: {},
    models,
    workflows: [],
    hash: '',
  };
  result.hash = hashJson(result);
  return result;
}
function record(
  recordId = A,
  current: JsonObject = { title: 'hello' },
  overrides: Partial<RecordState> = {},
): RecordState {
  const result: RecordState = {
    id: recordId,
    modelId: MODEL,
    current,
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: '',
    ...overrides,
  };
  if (result.published) result.firstPublishedAt ??= '2020-01-01T00:00:00.000Z';
  result.hash = recordHash(result);
  return result;
}
function upload(uploadId = id('upload')): UploadState {
  const result: UploadState = {
    id: uploadId,
    md5: '0123456789abcdef0123456789abcdef',
    size: 10,
    url: 'https://example.invalid/asset',
    filename: 'asset.png',
    collectionId: null,
    attributes: {},
    hash: '',
  };
  result.hash = hashJson(result);
  return result;
}
function collection(
  collectionId: string,
  parentId: string | null = null,
  position = 1,
  label = collectionId,
): CollectionState {
  const state = { id: collectionId, parentId, position, label, hash: '' };
  state.hash = collectionHash(state);
  return state;
}
function options(overrides: Partial<PlanOptions> = {}): PlanOptions {
  return {
    modelIds: [MODEL],
    uploads: 'referenced',
    includeDeletions: false,
    allowPartial: false,
    ...overrides,
  };
}
/** Two records of one creation cycle, in creation order. */
function creationCycle(store: SnapshotStore): [RecordPlan, RecordPlan] {
  const [first, second] = [A, B]
    .map((recordId) => store.getPlan('record', recordId) as RecordPlan)
    .sort(
      (left, right) =>
        left.execution!.createOrder! - right.execution!.createOrder!,
    ) as [RecordPlan, RecordPlan];
  assert.ok(first.execution!.createOrder! < second.execution!.createOrder!);
  return [first, second];
}
async function fixture(
  source: RecordState[],
  target: RecordState[],
  state = schema(),
  opts = options(),
  check?: (
    store: SnapshotStore,
    metadata: Awaited<ReturnType<typeof createPlan>>,
  ) => void,
): Promise<void> {
  const store = new SnapshotStore();
  try {
    for (const entry of source) store.putRecord('source', entry);
    for (const entry of target) store.putRecord('target', entry);
    const metadata = createPlan(
      store,
      state,
      { ...state, environmentId: 'target' },
      opts,
    );
    check?.(store, metadata);
  } finally {
    store.dispose();
  }
}
async function collectionFixture(
  source: CollectionState[],
  target: CollectionState[],
  overrides: Partial<PlanOptions> = {},
  check?: (
    store: SnapshotStore,
    metadata: Awaited<ReturnType<typeof createPlan>>,
  ) => void,
): Promise<void> {
  const store = new SnapshotStore();
  try {
    for (const state of source) store.putCollection('source', state);
    for (const state of target) store.putCollection('target', state);
    const metadata = createPlan(
      store,
      schema(),
      schema(),
      options({ uploads: 'all', ...overrides }),
    );
    check?.(store, metadata);
  } finally {
    store.dispose();
  }
}
const unsafe = (error: unknown) =>
  error instanceof ContentError && error.code === 'UNSAFE_REQUESTED_CHANGE';

describe('indexed planner', () => {
  it('assigns dependency levels to independent roots and chains without a graph-sized ready queue', () => {
    const store = new SnapshotStore();
    try {
      const graph = new PlannerGraph(store.database);
      for (const recordId of [A, B, C, id('independent'), id('deep')])
        graph.node('create', 'record', recordId);
      graph.edge('create', 'record', B, 'record', A, 'reference');
      graph.edge('create', 'record', C, 'record', B, 'reference');
      graph.edge('create', 'record', id('deep'), 'record', C, 'reference');
      graph.edge(
        'create',
        'record',
        id('deep'),
        'record',
        id('independent'),
        'reference',
      );
      const prepare = store.database.prepare.bind(store.database);
      let indexedReadyQueue = false;
      store.database.prepare = (sql) => {
        if (sql.includes('AND done=0 AND degree=0'))
          indexedReadyQueue = prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all('create')
            .some((row) => String(row.detail).includes('planner_nodes_ready'));
        return prepare(sql);
      };
      assert.equal(graph.order('create'), 0);
      assert.equal(indexedReadyQueue, true);
      const levels = new Map(
        [...graph.ranks('create')].map((entry) => [entry.id, entry.rank]),
      );
      assert.equal(levels.get(A), 0);
      assert.equal(levels.get(id('independent')), 0);
      assert.equal(levels.get(B), 1);
      assert.equal(levels.get(C), 2);
      assert.equal(levels.get(id('deep')), 3);
      graph.edge('create', 'record', A, 'record', C, 'cycle');
      assert.equal(graph.order('create'), 4);
      assert.deepEqual(
        [...graph.ranks('create')].map((entry) => entry.id),
        [id('independent')],
      );
      // Forcing releases a member of the cycle, so every vertex still
      // receives a level and the vertex waiting on the cycle follows it.
      assert.equal(graph.order('create', true), 0);
      const forced = new Map(
        [...graph.ranks('create')].map((entry) => [entry.id, entry.rank]),
      );
      assert.equal(forced.size, 5);
      for (const dependency of [C, id('independent')])
        assert.ok(forced.get(dependency)! < forced.get(id('deep'))!);
    } finally {
      store.dispose();
    }
  });

  it('seeds creation fields with native empty values', () => {
    assert.deepEqual(creationEmptyValue('rich_text'), []);
    assert.deepEqual(creationEmptyValue('links'), []);
    assert.equal(creationEmptyValue('link'), null);
    assert.equal(creationEmptyValue('structured_text'), null);
  });

  it('stores complete changed states and only guards for noops', async () => {
    await fixture(
      [record(), record(B, { title: 'new' })],
      [record(), record(B, { title: 'old' })],
      schema(),
      options(),
      (store, metadata) => {
        const noop = store.getPlan('record', A)!;
        const update = store.getPlan('record', B)! as RecordPlan;
        assert.equal(noop.action, 'noop');
        assert.equal('baseline' in noop, false);
        assert.equal('desired' in noop, false);
        assert.equal(update.action, 'update');
        assert.deepEqual(update.baseline?.current, { title: 'old' });
        assert.deepEqual(update.desired?.current, { title: 'new' });
        assert.equal(metadata.counts.record.noop, 1);
        assert.equal(metadata.counts.record.update, 1);
      },
    );
  });

  it('rejects lossy native metadata payloads and skips only their requested dependency closure', async () => {
    const state = schema([
      model({
        fields: [
          field({ apiKey: 'asset', type: 'file' }),
          field({ id: LINK, apiKey: 'link', type: 'link' }),
        ],
      }),
    ]);
    for (const key of ['__proto__', '__itemTypeId']) {
      for (const slice of ['current', 'published']) {
        const store = new SnapshotStore();
        try {
          const asset = upload();
          store.putUpload('source', asset);
          store.putUpload('target', asset);
          const safe: JsonObject = { asset: null, link: null };
          const lossy: JsonObject = {
            asset: {
              upload_id: asset.id,
              custom_data: { [key]: 'business value' },
            },
            link: null,
          };
          store.putRecord(
            'source',
            record(
              A,
              slice === 'current' ? lossy : safe,
              slice === 'published'
                ? {
                    published: lossy,
                  }
                : {},
            ),
          );
          store.putRecord('source', record(B, { asset: null, link: A }));
          store.putRecord('source', record(C, safe));
          assert.throws(
            () => createPlan(store, state, state, options()),
            (error: unknown) =>
              error instanceof ContentError &&
              error.code === 'UNSAFE_REQUESTED_CHANGE' &&
              error.details?.reason === 'UNSUPPORTED_PAYLOAD_KEY',
          );
          assert.deepEqual([...store.planEntries()], []);
          createPlan(store, state, state, options({ allowPartial: true }));
          assert.equal(store.getPlan('record', A)?.action, 'skip');
          assert.equal(store.getPlan('record', B)?.action, 'skip');
          assert.equal(store.getPlan('record', C)?.action, 'create');
          store.putRecord('target', store.getRecord('source', A)!);
          createPlan(store, state, state, options());
          assert.equal(store.getPlan('record', A)?.action, 'noop');
          assert.equal(store.getPlan('record', B)?.action, 'create');
        } finally {
          store.dispose();
        }
      }
    }
  });

  it('retains destination-only and unselected model records', async () => {
    const other = model({ id: id('other-model'), apiKey: 'other' });
    const source = schema();
    const target = schema([model(), other]);
    const store = new SnapshotStore();
    try {
      store.putRecord(
        'target',
        record(B, { title: 'keep' }, { modelId: other.id }),
      );
      const metadata = createPlan(
        store,
        source,
        target,
        options({ includeDeletions: true }),
      );
      const entry = store.getPlan('record', B)!;
      assert.equal(entry.action, 'noop');
      assert.deepEqual(entry.diagnostics, []);
      assert.equal(metadata.counts.record.delete, 0);
    } finally {
      store.dispose();
    }
  });

  it('compares only the structure content transfer relies on', () => {
    const base = (): SchemaState => ({
      ...schema([
        model({
          workflowId: 'workflow',
          fields: [
            field({ validators: { required: {} }, defaultValue: 'x' }),
            field({ id: LINK, apiKey: 'link', type: 'link' }),
          ],
        }),
        model({ id: BLOCK_MODEL, apiKey: 'block', block: true }),
      ]),
      workflows: [
        {
          id: 'workflow',
          apiKey: 'review',
          stages: [
            { id: 'draft', name: 'Draft', initial: true },
            { id: 'done', name: 'Done', initial: false },
          ],
        },
      ],
    });
    const changed = (edit: (state: SchemaState) => void) => {
      const state = structuredClone(base());
      edit(state);
      return state;
    };
    const page = (state: SchemaState) => state.models[0]!;
    const block = (state: SchemaState) => state.models[1]!;
    const title = (state: SchemaState) => page(state).fields[0]!;
    const stages = (state: SchemaState) => state.workflows[0]!.stages;
    const accepted: Array<[string, (state: SchemaState) => void]> = [
      [
        'validators',
        (state) => {
          title(state).validators = {};
        },
      ],
      [
        'default value',
        (state) => {
          title(state).defaultValue = null;
        },
      ],
      [
        'block field validators',
        (state) => {
          block(state).fields[0]!.validators = { required: {} };
        },
      ],
      [
        'model name',
        (state) => {
          page(state).name = 'Renamed';
        },
      ],
      [
        'field order',
        (state) => {
          page(state).fields.reverse();
        },
      ],
      [
        'allLocalesRequired',
        (state) => {
          page(state).allLocalesRequired = true;
        },
      ],
      [
        'saveInvalidDrafts',
        (state) => {
          page(state).saveInvalidDrafts = true;
        },
      ],
      [
        'stage name',
        (state) => {
          stages(state)[0]!.name = 'Renamed';
        },
      ],
      [
        'initial stage',
        (state) => {
          stages(state)[0]!.initial = false;
          stages(state)[1]!.initial = true;
        },
      ],
      [
        'stage order',
        (state) => {
          stages(state).reverse();
        },
      ],
      [
        'workflow API key',
        (state) => {
          state.workflows[0]!.apiKey = 'other';
        },
      ],
    ];
    const refused: Array<[string, (state: SchemaState) => void]> = [
      [
        'field type',
        (state) => {
          title(state).type = 'text';
        },
      ],
      [
        'field localized',
        (state) => {
          title(state).localized = true;
        },
      ],
      [
        'field API key',
        (state) => {
          title(state).apiKey = 'heading';
        },
      ],
      [
        'added field',
        (state) => {
          page(state).fields.push(field({ id: id('extra'), apiKey: 'extra' }));
        },
      ],
      [
        'removed field',
        (state) => {
          page(state).fields.pop();
        },
      ],
      [
        'block field type',
        (state) => {
          block(state).fields[0]!.type = 'text';
        },
      ],
      [
        'model API key',
        (state) => {
          page(state).apiKey = 'post';
        },
      ],
      [
        'block flag',
        (state) => {
          page(state).block = true;
        },
      ],
      [
        'sortable',
        (state) => {
          page(state).sortable = true;
        },
      ],
      [
        'tree',
        (state) => {
          page(state).tree = true;
        },
      ],
      [
        'draftMode',
        (state) => {
          page(state).draftMode = false;
        },
      ],
      [
        'singleton',
        (state) => {
          page(state).singleton = true;
        },
      ],
      [
        'workflowId',
        (state) => {
          page(state).workflowId = null;
        },
      ],
      [
        'missing block model',
        (state) => {
          state.models.pop();
        },
      ],
      [
        'stage ID',
        (state) => {
          stages(state)[1]!.id = 'published';
        },
      ],
      [
        'added stage',
        (state) => {
          stages(state).push({ id: 'extra', name: 'Extra', initial: false });
        },
      ],
      [
        'workflow ID',
        (state) => {
          state.workflows[0]!.id = 'other';
        },
      ],
      [
        'locales',
        (state) => {
          state.locales = ['en', 'it'];
        },
      ],
      [
        'semantics',
        (state) => {
          state.semantics = { timezone: 'Europe/Rome' };
        },
      ],
    ];
    const selected = new Set([MODEL]);
    for (const [name, edit] of accepted)
      assert.doesNotThrow(
        () => assertSchemaCompatible(base(), changed(edit), selected),
        name,
      );
    for (const [name, edit] of refused)
      assert.throws(
        () => assertSchemaCompatible(base(), changed(edit), selected),
        (error: unknown) =>
          error instanceof ContentError && error.code === 'SCHEMA_INCOMPATIBLE',
        name,
      );
  });

  it('creates records, blocks, uploads and folders with any source identity', async () => {
    const blockSchema = schema([
      model({
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'block', type: 'single_block' }),
        ],
      }),
      model({ id: BLOCK_MODEL, apiKey: 'block', block: true }),
    ]);
    // The CMA validates identities; numeric and malformed IDs plan unchanged.
    for (const sourceId of ['123', 'A'.repeat(22), '0000000000000000000123']) {
      await fixture([record(sourceId)], [], schema(), options(), (store) =>
        assert.equal(store.getPlan('record', sourceId)?.action, 'create'),
      );
      await fixture(
        [
          record(A, {
            block: {
              id: sourceId,
              __itemTypeId: BLOCK_MODEL,
              attributes: { title: 'nested' },
            },
          }),
        ],
        [],
        blockSchema,
        options(),
        (store) => assert.equal(store.getPlan('record', A)?.action, 'create'),
      );
      const store = new SnapshotStore();
      try {
        store.putUpload('source', upload(sourceId));
        createPlan(store, schema(), schema(), options({ uploads: 'all' }));
        assert.equal(store.getPlan('upload', sourceId)?.action, 'create');
      } finally {
        store.dispose();
      }
      await collectionFixture([collection(sourceId)], [], {}, (store) =>
        assert.equal(store.getPlan('collection', sourceId)?.action, 'create'),
      );
    }
  });

  it('empties only the creation cycle link to the record created later', async () => {
    const state = schema([
      model({ fields: [field({ id: LINK, apiKey: 'link', type: 'link' })] }),
    ]);
    await fixture(
      [record(A, { link: B }), record(B, { link: A })],
      [],
      state,
      options(),
      (store) => {
        const [first, second] = creationCycle(store);
        assert.deepEqual(first.execution?.creationFields, { link: null });
        assert.deepEqual(second.execution?.creationFields, { link: first.id });
      },
    );
  });

  it('keeps complete required acyclic creation fields and orders their prerequisites', async () => {
    const state = schema([
      model({
        fields: [
          field(),
          field({
            id: LINK,
            apiKey: 'link',
            type: 'link',
            validators: { required: {} },
          }),
        ],
      }),
    ]);
    const target = record(C, { title: 'existing', link: C });
    await fixture(
      [
        record(A, { title: 'owner', link: B }),
        record(B, { title: 'dependency', link: C }),
        target,
      ],
      [target],
      state,
      options(),
      (store) => {
        const owner = store.getPlan('record', A) as RecordPlan;
        const dependency = store.getPlan('record', B) as RecordPlan;
        assert.deepEqual(owner.execution?.creationFields, {
          title: 'owner',
          link: B,
        });
        assert.deepEqual(dependency.execution?.creationFields, {
          title: 'dependency',
          link: C,
        });
        assert.ok(
          dependency.execution!.createOrder! < owner.execution!.createOrder!,
        );
      },
    );
  });

  it('retains required dependants of optional cycles after nullable cycle seeds are ordered', async () => {
    const optional = model({
      fields: [field({ id: LINK, apiKey: 'link', type: 'link' })],
    });
    const required = model({
      id: id('required-model'),
      apiKey: 'required',
      fields: [
        field({
          id: id('required-link'),
          apiKey: 'link',
          type: 'link',
          validators: { required: {} },
        }),
      ],
    });
    await fixture(
      [
        record(A, { link: B }),
        record(B, { link: A }),
        record(C, { link: A }, { modelId: required.id }),
      ],
      [],
      schema([optional, required]),
      options({ modelIds: [MODEL, required.id] }),
      (store) => {
        const dependant = store.getPlan('record', C) as RecordPlan;
        const seed = store.getPlan('record', A) as RecordPlan;
        assert.deepEqual(dependant.execution?.creationFields, { link: A });
        assert.ok(
          seed.execution!.createOrder! < dependant.execution!.createOrder!,
        );
      },
    );
  });

  it('defers auto-published creation references to existing drafts until their publication phase', async () => {
    const automatic = model({
      id: id('automatic'),
      apiKey: 'automatic',
      draftMode: false,
      fields: [field({ id: LINK, apiKey: 'link', type: 'link' })],
    });
    const state = schema([model(), automatic]);
    const source = [
      record(
        A,
        { link: B },
        {
          modelId: automatic.id,
          published: { link: B },
        },
      ),
      record(
        B,
        { title: 'published dependency' },
        {
          published: { title: 'published dependency' },
        },
      ),
    ];
    const target = [record(B, { title: 'existing draft' })];
    const opts = options({ modelIds: [MODEL, automatic.id] });
    await fixture(source, target, state, opts, (store) => {
      const owner = store.getPlan('record', A) as RecordPlan;
      const dependency = store.getPlan('record', B) as RecordPlan;
      assert.deepEqual(owner.execution?.creationFields, { link: null });
      assert.ok(
        dependency.execution!.publishOrder! < owner.execution!.publishOrder!,
      );
    });
    // A required link is seeded the same way; the CMA judges the write.
    automatic.fields[0].validators.required = {};
    await fixture(source, target, state, opts, (store) =>
      assert.deepEqual(
        (store.getPlan('record', A) as RecordPlan).execution?.creationFields,
        { link: null },
      ),
    );
  });

  it('seeds required creation cycles with empty links without consulting validators', async () => {
    const state = schema([
      model({
        fields: [
          field({
            id: LINK,
            apiKey: 'link',
            type: 'link',
            validators: {
              required: {},
              item_item_type: { item_types: [MODEL] },
            },
          }),
        ],
      }),
    ]);
    const source = [record(A, { link: B }), record(B, { link: A })];
    await fixture(source, [], state, options(), (store) => {
      const [first, second] = creationCycle(store);
      assert.deepEqual(first.execution?.creationFields, { link: null });
      assert.deepEqual(second.execution?.creationFields, { link: first.id });
    });
  });

  it('preserves locale maps in deferred creation seeds', async () => {
    const state = {
      ...schema([
        model({
          fields: [
            field({ localized: true }),
            field({ id: LINK, apiKey: 'link', type: 'link', localized: true }),
          ],
        }),
      ]),
      locales: ['en', 'it'],
    };
    const source = [
      record(A, { title: { en: 'a', it: 'a' }, link: { en: B, it: B } }),
      record(B, { title: { en: 'b', it: 'b' }, link: { en: A, it: A } }),
    ];
    await fixture(source, [], state, options(), (store) => {
      const [first] = creationCycle(store);
      const title = first.id === A ? 'a' : 'b';
      assert.deepEqual(first.execution?.creationFields, {
        title: { en: title, it: title },
        link: { en: null, it: null },
      });
    });
  });

  it('creates localized link and nested-block cycles with native empty values and null locale defaults', async () => {
    const state = {
      ...schema([
        model({
          fields: [
            field({
              localized: true,
              validators: { required: {}, unique: {} },
              defaultValue: { en: null, it: null },
            }),
            field({
              id: LINK,
              apiKey: 'link',
              type: 'link',
              localized: true,
              defaultValue: { en: null, it: null },
            }),
            field({
              id: BLOCK_FIELD,
              apiKey: 'blocks',
              type: 'rich_text',
              localized: true,
              defaultValue: { en: [], it: [] },
            }),
          ],
        }),
        model({
          id: BLOCK_MODEL,
          apiKey: 'block',
          block: true,
          fields: [
            field({ id: id('related'), apiKey: 'related', type: 'link' }),
          ],
        }),
      ]),
      locales: ['en', 'it'],
    };
    const source = [
      record(A, {
        title: { en: 'A' },
        link: { en: B },
        blocks: {
          en: [
            {
              id: id('a-block'),
              __itemTypeId: BLOCK_MODEL,
              attributes: { related: B },
            },
          ],
        },
      }),
      record(B, {
        title: { en: 'B' },
        link: { en: A },
        blocks: {
          en: [
            {
              id: id('b-block'),
              __itemTypeId: BLOCK_MODEL,
              attributes: { related: A },
            },
          ],
        },
      }),
    ];
    await fixture(source, [], state, options(), (store) => {
      const [first, second] = creationCycle(store);
      assert.deepEqual(first.execution?.creationFields?.link, { en: null });
      assert.deepEqual(first.execution?.creationFields?.blocks, { en: [] });
      assert.deepEqual(
        second.execution?.creationFields,
        second.desired!.current,
      );
    });
    const constrained = {
      ...state,
      models: state.models.map((entry) =>
        entry.id === MODEL
          ? {
              ...entry,
              fields: entry.fields.map((value) =>
                value.id === BLOCK_FIELD
                  ? { ...value, validators: { size: { min: 1 } } }
                  : value,
              ),
            }
          : entry,
      ),
    };
    // A minimum size does not change the seed; the CMA judges the write.
    await fixture(source, [], constrained, options(), (store) =>
      assert.deepEqual(
        creationCycle(store)[0].execution?.creationFields?.blocks,
        {
          en: [],
        },
      ),
    );
  });

  it('plans scheduled records whatever their scheduled scope holds', async () => {
    const state = {
      ...schema([
        model({
          fields: [field({ localized: true, validators: { required: {} } })],
        }),
      ]),
      locales: ['en', 'it'],
    };
    const scheduled = record(
      A,
      { title: { en: 'English', it: null } },
      {
        schedules: {
          publication: {
            at: '2090-01-01T12:00:00.000Z',
            selective: { locales: ['en'], nonLocalized: false },
          },
          unpublishing: null,
        },
      },
    );
    await fixture([scheduled], [], state);
    await fixture(
      [
        record(A, scheduled.current, {
          schedules: {
            publication: {
              at: '2090-01-01T12:00:00.000Z',
              selective: { locales: ['it'], nonLocalized: false },
            },
            unpublishing: null,
          },
        }),
      ],
      [],
      state,
      options(),
      (_store, metadata) => assert.equal(metadata.counts.record.create, 1),
    );
    const nonnative = {
      ...schema([model({ fields: [field({ validators: { required: {} } })] })]),
      semantics: { improved_validation_at_publishing: true },
    };
    await fixture(
      [
        record(
          A,
          { title: 'valid' },
          {
            schedules: {
              publication: { at: '2090-01-01T12:00:00.000Z', selective: null },
              unpublishing: null,
            },
          },
        ),
      ],
      [],
      nonnative,
      options(),
      (_store, metadata) => assert.equal(metadata.counts.record.create, 1),
    );
  });

  it('plans writes around scheduled unchanged records that the SDK cannot write back', async () => {
    const state = schema([
      model({
        fields: [field({ apiKey: 'asset', type: 'file' })],
      }),
    ]);
    for (const write of ['none', 'record', 'upload', 'collection']) {
      const store = new SnapshotStore();
      try {
        const asset = upload();
        store.putUpload('source', asset);
        store.putUpload('target', asset);
        const scheduled = record(
          A,
          {
            asset: {
              upload_id: asset.id,
              custom_data: { __itemTypeId: 'business value' },
            },
          },
          {
            schedules: {
              publication: { at: '2099-01-01T12:00:00.000Z', selective: null },
              unpublishing: null,
            },
          },
        );
        store.putRecord('source', scheduled);
        store.putRecord('target', scheduled);
        if (write === 'record')
          store.putRecord('source', record(B, { asset: null }));
        if (write === 'upload') {
          const changed = { ...asset, filename: 'renamed.png', hash: '' };
          changed.hash = hashJson(changed);
          store.putUpload('source', changed);
        }
        if (write === 'collection') {
          const collection = {
            id: id('new-collection'),
            label: 'New',
            parentId: null,
            position: 1,
            hash: '',
          };
          collection.hash = hashJson(collection);
          store.putCollection('source', collection);
        }
        const run = () =>
          createPlan(
            store,
            state,
            state,
            options({ allowPartial: true, uploads: 'all' }),
          );
        // The unchanged record is never rewritten, so it does not block writes.
        const metadata = await run();
        assert.equal(metadata.counts.record.noop, 1);
      } finally {
        store.dispose();
      }
    }
  });

  it('plans records whose values violate destination validators', async () => {
    const EMAIL = id('email');
    const state = schema([
      model({
        fields: [
          field({
            validators: { required: {}, unique: {}, length: { max: 1 } },
          }),
          field({
            id: EMAIL,
            apiKey: 'email',
            validators: { format: { predefined_pattern: 'email' } },
          }),
        ],
      }),
    ]);
    const fields = { title: '', email: 'not an email' };
    const source = [
      record(A, fields, { published: fields }),
      record(B, { title: 'too long', email: null }),
      // Unique values swapped between records and one still held by a
      // retained destination record.
      record(C, { title: 'b', email: null }),
      record(id('d'), { title: 'c', email: null }),
      record(id('e'), { title: 'held', email: null }),
    ];
    await fixture(source, [], state, options(), (_store, metadata) =>
      assert.equal(metadata.counts.record.create, 5),
    );
    await fixture(
      source,
      [
        record(A),
        record(B),
        record(C, { title: 'c', email: null }),
        record(id('d'), { title: 'b', email: null }),
        record(id('e')),
        record(id('holder'), { title: 'held', email: null }),
      ],
      state,
      options(),
      (store, metadata) => {
        assert.equal(metadata.counts.record.update, 5);
        assert.equal(metadata.counts.record.noop, 1);
        for (const entry of store.planEntries('record', 'update'))
          assert.deepEqual(entry.diagnostics, []);
      },
    );
  });

  it('never reads field validators or default values while planning', async () => {
    const state = schema([
      model({
        sortable: true,
        fields: [
          field(),
          field({ id: LINK, apiKey: 'link', type: 'link' }),
          field({ id: BLOCK_FIELD, apiKey: 'blocks', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'block',
        block: true,
        fields: [field({ id: id('related'), apiKey: 'related', type: 'link' })],
      }),
    ]);
    for (const entry of state.models)
      for (const value of entry.fields)
        for (const key of ['validators', 'defaultValue'] as const)
          Object.defineProperty(value, key, {
            get() {
              throw new Error(`planning read ${key}`);
            },
          });
    const blocks = (recordId: string, related: string | null) => [
      {
        id: id(`${recordId}-block`),
        __itemTypeId: BLOCK_MODEL,
        attributes: { related },
      },
    ];
    const linked = (recordId: string, link: string, position: number) => {
      const fields = { title: '', link, blocks: blocks(recordId, link) };
      return record(recordId, fields, {
        published: { ...fields, blocks: blocks(recordId, null) },
        position,
      });
    };
    const store = new SnapshotStore();
    try {
      for (const entry of [linked(A, B, 0), linked(B, A, 1)])
        store.putRecord('source', entry);
      store.putRecord('target', record(C, { title: 'old' }, { position: 0 }));
      const metadata = createPlan(
        store,
        state,
        { ...state, environmentId: 'target' },
        options({ includeDeletions: true }),
      );
      assert.equal(metadata.counts.record.create, 2);
      assert.equal(metadata.counts.record.delete, 1);
    } finally {
      store.dispose();
    }
  });

  it('publishes link cycles among new records in two steps', async () => {
    const state = schema([
      model({ fields: [field({ id: LINK, apiKey: 'link', type: 'link' })] }),
    ]);
    const linked = (recordId: string, link: string) =>
      record(
        recordId,
        { link },
        {
          published: { link },
        },
      );
    await fixture(
      [linked(A, B), linked(B, A)],
      [],
      state,
      options(),
      (store, metadata) => {
        assert.equal(metadata.counts.record.create, 2);
        const [first, second] = [A, B]
          .map((recordId) => store.getPlan('record', recordId) as RecordPlan)
          .sort((left, right) =>
            left.execution?.provisionalPublished
              ? -1
              : right.execution?.provisionalPublished
                ? 1
                : 0,
          );
        // One record publishes without its cycle link, the other can then
        // publish, and apply republishes the first one with the link.
        assert.deepEqual([first.diagnostics, second.diagnostics], [[], []]);
        assert.deepEqual(first.execution?.provisionalPublished, {
          link: null,
        });
        assert.equal(first.execution?.publishOrder, 0);
        assert.equal(second.execution?.provisionalPublished, undefined);
        assert.equal(second.execution?.publishOrder, 1);
      },
    );
  });

  it('drops one link per cycle and keeps links outside it', async () => {
    const LINKS = id('links');
    const X = id('x');
    const state = schema([
      model({
        fields: [field({ id: LINKS, apiKey: 'links', type: 'links' })],
      }),
    ]);
    const linked = (recordId: string, links: string[]) =>
      record(
        recordId,
        { links },
        {
          published: { links },
        },
      );
    const existing = linked(X, []);
    await fixture(
      [linked(A, [B, X]), linked(B, [C, X]), linked(C, [A, X]), existing],
      [existing],
      state,
      options(),
      (store) => {
        const entries = [A, B, C].map(
          (recordId) => store.getPlan('record', recordId) as RecordPlan,
        );
        const provisional = entries.filter(
          (entry) => entry.execution?.provisionalPublished,
        );
        assert.equal(provisional.length, 1);
        const [entry] = provisional;
        const links = entry.desired!.published!.links as string[];
        assert.deepEqual(entry.execution!.provisionalPublished, {
          links: links.filter((target) => target === X),
        });
        assert.deepEqual(
          entries.map((candidate) => candidate.diagnostics),
          [[], [], []],
        );
      },
    );
  });

  it('breaks a required publication cycle link without consulting validators', async () => {
    const state = schema([
      model({
        fields: [
          field({
            id: LINK,
            apiKey: 'link',
            type: 'link',
            validators: { required: {} },
          }),
        ],
      }),
    ]);
    const source = [A, B].map((recordId) =>
      record(
        recordId,
        { link: recordId === A ? B : A },
        {
          published: { link: recordId === A ? B : A },
        },
      ),
    );
    await fixture(source, [], state, options(), (store, metadata) => {
      assert.equal(metadata.counts.record.create, 2);
      assert.deepEqual(
        [A, B]
          .map(
            (recordId) =>
              (store.getPlan('record', recordId) as RecordPlan).execution
                ?.provisionalPublished,
          )
          .filter(Boolean),
        [{ link: null }],
      );
    });
  });

  it('still diagnoses publication cycles through links inside blocks', async () => {
    const state = schema([
      model({
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'blocks', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'block',
        block: true,
        fields: [field({ id: LINK, apiKey: 'related', type: 'link' })],
      }),
    ]);
    const linked = (recordId: string, related: string) => {
      const blocks = [
        {
          id: id(`${recordId}-block`),
          __itemTypeId: BLOCK_MODEL,
          attributes: { related },
        },
      ];
      return record(
        recordId,
        { blocks },
        {
          published: { blocks },
        },
      );
    };
    const source = [linked(A, B), linked(B, A)];
    await assert.rejects(
      fixture(source, [], state, options()),
      (error: unknown) =>
        unsafe(error) &&
        (error as ContentError).details?.reason === 'PUBLICATION_CYCLE',
    );
    await fixture(
      source,
      [],
      state,
      options({ allowPartial: true }),
      (_store, metadata) => assert.equal(metadata.counts.record.skip, 2),
    );
  });

  it('breaks a cycle of a link and a Structured Text link at the link in either ID order', async () => {
    const BODY = id('body');
    const state = schema([
      model({
        fields: [
          field({ id: LINK, apiKey: 'link', type: 'link' }),
          field({ id: BODY, apiKey: 'body', type: 'structured_text' }),
        ],
      }),
    ]);
    const dast = (target: string): JsonObject => ({
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'itemLink',
                item: target,
                children: [{ type: 'span', value: 'back' }],
              },
            ],
          },
        ],
      },
    });
    for (const [linking, linked] of [
      [A, B],
      [B, A],
    ]) {
      const fields = (recordId: string): JsonObject =>
        recordId === linking
          ? { link: linked, body: null }
          : { link: null, body: dast(linking) };
      const source = [A, B].map((recordId) =>
        record(recordId, fields(recordId), { published: fields(recordId) }),
      );
      await fixture(source, [], state, options(), (store, metadata) => {
        assert.equal(metadata.counts.record.create, 2);
        assert.equal(metadata.counts.record.skip, 0);
        const owner = store.getPlan('record', linking) as RecordPlan;
        const other = store.getPlan('record', linked) as RecordPlan;
        assert.deepEqual(owner.execution?.provisionalPublished, {
          link: null,
          body: null,
        });
        assert.equal(other.execution?.provisionalPublished, undefined);
        assert.ok(
          owner.execution!.publishOrder! < other.execution!.publishOrder!,
        );
      });
    }
  });

  it('does not wait for publication of creates that models without draft mode publish', async () => {
    const automatic = model({
      id: id('automatic'),
      apiKey: 'automatic',
      draftMode: false,
      fields: [field({ id: LINK, apiKey: 'link', type: 'link' })],
    });
    const drafted = model({
      fields: [field({ id: id('drafted-link'), apiKey: 'link', type: 'link' })],
    });
    const state = schema([drafted, automatic]);
    const opts = options({ modelIds: [MODEL, automatic.id] });
    const linked = (recordId: string, link: string, modelId: string) =>
      record(
        recordId,
        { link },
        {
          modelId,
          published: { link },
        },
      );
    await fixture(
      [linked(A, B, automatic.id), linked(B, A, automatic.id)],
      [],
      state,
      opts,
      (store) => {
        // The record created second links to the first one, which its
        // create has already published.
        const [first, second] = creationCycle(store);
        for (const entry of [first, second]) {
          assert.equal(entry.action, 'create');
          assert.deepEqual(entry.diagnostics, []);
          assert.equal(entry.execution?.publishOrder, 0);
        }
        assert.deepEqual(first.execution?.creationFields, { link: null });
        assert.deepEqual(second.execution?.creationFields, { link: first.id });
      },
    );
    // A new draft is published only in the publication phase, so the record
    // linking back to it still writes that link afterwards.
    await fixture(
      [linked(A, B, MODEL), linked(B, A, automatic.id)],
      [],
      state,
      opts,
      (store) => {
        const draft = store.getPlan('record', A) as RecordPlan;
        const owner = store.getPlan('record', B) as RecordPlan;
        for (const entry of [draft, owner]) {
          assert.equal(entry.action, 'create');
          assert.deepEqual(entry.diagnostics, []);
        }
        assert.deepEqual(owner.execution?.creationFields, { link: null });
        assert.ok(
          draft.execution!.publishOrder! < owner.execution!.publishOrder!,
        );
      },
    );
  });

  it('plans native self-reference publication, unpublication, and deletion', async () => {
    const dast: JsonObject = {
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'inlineItem', item: A },
              {
                type: 'itemLink',
                item: A,
                children: [{ type: 'span', value: 'self' }],
              },
            ],
          },
        ],
      },
    };
    for (const [type, value] of [
      ['link', A],
      ['links', [A]],
      ['structured_text', dast],
    ] as const) {
      const state = schema([
        model({ fields: [field({ apiKey: 'body', type })] }),
      ]);
      const fields = { body: value } as JsonObject;
      const draft = record(A, fields);
      const published = record(A, fields, {
        published: fields,
      });
      for (const target of [[], [draft]]) {
        await fixture([published], target, state, options(), (store) => {
          const plan = store.getPlan('record', A) as RecordPlan;
          assert.equal(plan.execution?.publishOrder, 0);
          if (target.length === 0)
            assert.deepEqual(plan.execution?.creationFields, {
              body: creationEmptyValue(type),
            });
        });
      }
      await fixture([draft], [published], state, options(), (store) => {
        assert.equal(
          (store.getPlan('record', A) as RecordPlan).execution?.publishOrder,
          0,
        );
      });
      await fixture(
        [],
        [published],
        state,
        options({ includeDeletions: true }),
        (store) => {
          assert.equal(
            (store.getPlan('record', A) as RecordPlan).execution?.deleteOrder,
            0,
          );
        },
      );
    }
  });

  it('orders deletion cycles and self-parented trees deterministically for the CMA to judge', async () => {
    const state = schema([
      model({ fields: [field({ apiKey: 'link', type: 'link' })] }),
    ]);
    await fixture(
      [],
      [record(A, { link: B }), record(B, { link: A })],
      state,
      options({ includeDeletions: true }),
      (store, metadata) => {
        assert.equal(metadata.counts.record.delete, 2);
        const orders = [A, B].map(
          (recordId) =>
            (store.getPlan('record', recordId) as RecordPlan).execution
              ?.deleteOrder,
        );
        assert.equal(new Set(orders).size, 2);
      },
    );
    const tree = schema([model({ tree: true })]);
    await fixture(
      [record(A, { title: 'self' }, { parentId: A, position: 0 })],
      [],
      tree,
      options(),
      (store) =>
        assert.equal(
          typeof (store.getPlan('record', A) as RecordPlan).execution
            ?.createOrder,
          'number',
        ),
    );
    await fixture(
      [],
      [record(A, { title: 'self' }, { parentId: A, position: 0 })],
      tree,
      options({ includeDeletions: true }),
      (_store, metadata) => assert.equal(metadata.counts.record.delete, 1),
    );
  });

  it('deletes a record that only waits on a deletion cycle after that cycle', async () => {
    // The waiting record sorts first, so releasing the lowest blocked vertex
    // would delete it while a cycle member still references it.
    const [target, first, second] = [A, B, C].sort();
    const state = schema([
      model({ fields: [field({ apiKey: 'links', type: 'links' })] }),
    ]);
    await fixture(
      [],
      [
        record(first!, { links: [second!, target!] }),
        record(second!, { links: [first!] }),
        record(target!, { links: [] }),
      ],
      state,
      options({ includeDeletions: true }),
      (store) => {
        const order = (recordId: string) =>
          (store.getPlan('record', recordId) as RecordPlan).execution!
            .deleteOrder!;
        assert.notEqual(order(first!), order(second!));
        assert.ok(order(target!) > order(first!));
      },
    );
  });

  it('plans explicit nulls over configured defaults without consulting defaults', async () => {
    const localized = schema([
      model({
        fields: [
          field({
            localized: true,
            defaultValue: { en: 'default', it: 'predefinito' },
          }),
        ],
      }),
    ]);
    localized.locales = ['en', 'it'];
    const nested = schema([
      model({
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'block', type: 'single_block' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'block',
        block: true,
        fields: [field({ id: id('nested-title'), defaultValue: 'default' })],
      }),
    ]);
    for (const [state, fields] of [
      [
        schema([model({ fields: [field({ defaultValue: 'default' })] })]),
        { title: null },
      ],
      [localized, { title: { en: null, it: null } }],
      [
        nested,
        {
          block: {
            id: id('nested'),
            __itemTypeId: BLOCK_MODEL,
            attributes: { title: null },
          },
        },
      ],
    ] as const)
      await fixture(
        [record(A, fields as JsonObject)],
        [],
        state,
        options(),
        (_store, metadata) => assert.equal(metadata.counts.record.create, 1),
      );
  });

  it('plans block relocation, reuse and singleton identity changes', async () => {
    const state = schema([
      model({
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'block', type: 'single_block' }),
          field({ id: id('blocks'), apiKey: 'blocks', type: 'rich_text' }),
        ],
      }),
      model({ id: BLOCK_MODEL, apiKey: 'block', block: true }),
    ]);
    const block = {
      id: id('nested'),
      __itemTypeId: BLOCK_MODEL,
      attributes: { title: 'inside' },
    };
    // A block moving to another record, a block repeated within one record,
    // and a published-only block written back to the draft all plan as writes.
    await fixture(
      [
        record(A, { block: null, blocks: [] }),
        record(B, { block, blocks: [block, block] }),
      ],
      [
        record(A, { block, blocks: [] }, { published: { block, blocks: [] } }),
        record(B, { block: null, blocks: [] }),
      ],
      state,
      options(),
      (_store, metadata) => assert.equal(metadata.counts.record.update, 2),
    );
    await fixture(
      [record(A)],
      [record(B)],
      schema([model({ singleton: true })]),
      options({ includeDeletions: true }),
      (store) => {
        assert.equal(store.getPlan('record', A)?.action, 'create');
        assert.equal(store.getPlan('record', B)?.action, 'delete');
      },
    );
  });

  it('deletes an upload still referenced by a retained record and leaves the reference to the CMA', async () => {
    const other = model({
      id: id('other-model'),
      fields: [field({ apiKey: 'file', type: 'file' })],
    });
    const state = schema([model(), other]);
    const asset = upload();
    const store = new SnapshotStore();
    try {
      store.putRecord(
        'target',
        record(B, { file: { upload_id: asset.id } }, { modelId: other.id }),
      );
      store.putUpload('target', asset);
      const metadata = createPlan(
        store,
        state,
        state,
        options({ uploads: 'all', includeDeletions: true }),
      );
      assert.equal(store.getPlan('upload', asset.id)?.action, 'delete');
      assert.equal(metadata.counts.record.noop, 1);
    } finally {
      store.dispose();
    }
  });

  it('orders tree creates and linked deletes iteratively', async () => {
    const state = schema([
      model({
        tree: true,
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    await fixture(
      [
        record(A, { title: 'parent' }, { position: 0 }),
        record(B, { title: 'child' }, { parentId: A, position: 0 }),
      ],
      [],
      state,
      options(),
      (store) => {
        const parent = store.getPlan('record', A) as RecordPlan;
        const child = store.getPlan('record', B) as RecordPlan;
        assert.ok(
          parent.execution!.createOrder! < child.execution!.createOrder!,
        );
      },
    );
    await fixture(
      [],
      [record(A, { title: 'owner', link: B }), record(B)],
      state,
      options({ includeDeletions: true }),
      (store) => {
        const owner = store.getPlan('record', A) as RecordPlan;
        const dependency = store.getPlan('record', B) as RecordPlan;
        assert.ok(
          owner.execution!.deleteOrder! < dependency.execution!.deleteOrder!,
        );
      },
    );
  });

  it('moves tree records after every moved ancestor on their desired path', async () => {
    const state = schema([model({ tree: true })]);
    const node = (recordId: string, parentId: string | null) =>
      record(recordId, { title: 'node' }, { parentId, position: 0 });
    const order = (store: SnapshotStore, recordId: string) =>
      (store.getPlan('record', recordId) as RecordPlan).execution!
        .publishOrder!;
    const clean = (store: SnapshotStore) => {
      for (const entry of store.planEntries('record'))
        assert.deepEqual(entry.diagnostics, []);
    };
    // X > P > Y becomes P > Y > X with Y unchanged. Moving X first would put
    // it beneath Y while Y's ancestors still include X, whatever the ID order.
    const [first, second] = [A, B].sort();
    for (const [moved, ancestor] of [
      [first, second],
      [second, first],
    ]) {
      const unchanged = node(C, ancestor);
      await fixture(
        [node(ancestor, null), unchanged, node(moved, C)],
        [node(moved, null), node(ancestor, moved), unchanged],
        state,
        options(),
        (store, metadata) => {
          assert.equal(metadata.counts.record.update, 2);
          assert.equal(metadata.counts.record.noop, 1);
          assert.ok(order(store, ancestor) < order(store, moved));
          clean(store);
        },
      );
    }
    // X > P > U > Q > V becomes Q > V > P > U > X with U and V unchanged.
    // Each move waits for the nearest moved ancestor, which waits for its own.
    const [x, p, u, q, v] = ['x', 'p', 'u', 'q', 'v'].map(id);
    await fixture(
      [node(q, null), node(v, q), node(p, v), node(u, p), node(x, u)],
      [node(x, null), node(p, x), node(u, p), node(q, u), node(v, q)],
      state,
      options(),
      (store, metadata) => {
        assert.equal(metadata.counts.record.update, 3);
        assert.ok(order(store, q) < order(store, p));
        assert.ok(order(store, p) < order(store, x));
        clean(store);
      },
    );
    // An ordinary leaf move has no moved ancestor to wait for.
    await fixture(
      [
        record(A, { title: 'a' }, { position: 0 }),
        record(B, { title: 'b' }, { position: 1 }),
        record(C, { title: 'leaf' }, { parentId: B, position: 0 }),
      ],
      [
        record(A, { title: 'a' }, { position: 0 }),
        record(B, { title: 'b' }, { position: 1 }),
        record(C, { title: 'leaf' }, { parentId: A, position: 0 }),
      ],
      state,
      options(),
      (store, metadata) => {
        assert.equal(metadata.counts.record.update, 1);
        assert.equal(order(store, C), 0);
        clean(store);
      },
    );
  });

  it('plans a 6000-record dependency chain from disk without a recursive graph traversal', async () => {
    const state = schema([model({ tree: true })]);
    const store = new SnapshotStore();
    try {
      // Build the fixture in bounded transactions too: no array of all record
      // payloads should hide a project-sized memory requirement in this test.
      for (let start = 0; start < 6000; start += 100)
        store.transaction(() => {
          for (let index = start; index < start + 100; index++)
            store.putRecord(
              'source',
              record(
                id(`node-${index}`),
                { title: `node-${index}` },
                {
                  parentId: index ? id(`node-${index - 1}`) : null,
                  position: 0,
                  published: { title: `node-${index}` },
                },
              ),
            );
        });
      const metadata = createPlan(
        store,
        state,
        { ...state, environmentId: 'target' },
        options(),
      );
      assert.equal(metadata.counts.record.create, 6000);
      let checked = 0;
      for (const entry of store.planEntries('record')) {
        assert.equal(entry.kind, 'record');
        if (entry.kind !== 'record') continue;
        const depth = Number(String(entry.desired!.current.title).slice(5));
        assert.equal(entry.execution?.createOrder, depth);
        assert.equal(entry.execution?.publishOrder, depth);
        checked++;
      }
      assert.equal(checked, 6000);
    } finally {
      store.dispose();
    }
  });

  it('preserves already published dependency cycles when both targets are available', async () => {
    const state = schema([
      model({
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    const source = [
      record(
        A,
        { title: 'new-a', link: B },
        {
          published: { title: 'new-a', link: B },
        },
      ),
      record(
        B,
        { title: 'new-b', link: A },
        {
          published: { title: 'new-b', link: A },
        },
      ),
    ];
    const target = [
      record(
        A,
        { title: 'old-a', link: B },
        {
          published: { title: 'old-a', link: B },
        },
      ),
      record(
        B,
        { title: 'old-b', link: A },
        {
          published: { title: 'old-b', link: A },
        },
      ),
    ];
    await fixture(source, target, state, options(), (_store, metadata) =>
      assert.equal(metadata.counts.record.update, 2),
    );
  });

  it('unpublishes a record still referenced by a retained publication', async () => {
    const other = model({
      id: id('other'),
      apiKey: 'other',
      fields: [field({ id: LINK, apiKey: 'link', type: 'link' })],
    });
    const state = schema([model(), other]);
    const target = [
      record(A, { title: 'old' }, { published: { title: 'old' } }),
      record(B, { link: A }, { modelId: other.id, published: { link: A } }),
    ];
    await fixture(
      [record(A, { title: 'new' })],
      target,
      state,
      options(),
      (store) => {
        const entry = store.getPlan('record', A) as RecordPlan;
        assert.equal(entry.action, 'update');
        assert.deepEqual(entry.diagnostics, []);
      },
    );
  });

  it('releases previous published references before unpublishing their dependencies', async () => {
    const state = schema([
      model({
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    const target = [
      record(
        A,
        { title: 'owner', link: B },
        {
          published: { title: 'owner', link: B },
        },
      ),
      record(
        B,
        { title: 'dependency', link: null },
        {
          published: { title: 'dependency', link: null },
        },
      ),
    ];
    for (const published of [{ title: 'owner', link: null }, null]) {
      await fixture(
        [
          record(A, { title: 'owner', link: null }, { published }),
          record(B, { title: 'dependency', link: null }),
        ],
        target,
        state,
        options(),
        (store) => {
          const owner = store.getPlan('record', A) as RecordPlan;
          const dependency = store.getPlan('record', B) as RecordPlan;
          assert.ok(
            owner.execution!.publishOrder! <
              dependency.execution!.publishOrder!,
          );
        },
      );
    }
  });

  it('unpublishes a record whose published referrer is deleted later', async () => {
    const state = schema([
      model({
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    const source = [record(B, { title: 'dependency', link: null })];
    const target = [
      record(
        A,
        { title: 'owner', link: B },
        { published: { title: 'owner', link: B } },
      ),
      record(
        B,
        { title: 'dependency', link: null },
        { published: { title: 'dependency', link: null } },
      ),
    ];
    await fixture(
      source,
      target,
      state,
      options({ includeDeletions: true }),
      (store) => {
        assert.equal(store.getPlan('record', A)?.action, 'delete');
        assert.equal(store.getPlan('record', B)?.action, 'update');
      },
    );
  });

  it('plans no update when only ordering differs', async () => {
    const state = schema([model({ sortable: true })]);
    await fixture(
      [
        record(A, { title: 'same' }, { position: 0 }),
        record(B, { title: 'same' }, { position: 1 }),
      ],
      [
        record(A, { title: 'same' }, { position: 1 }),
        record(B, { title: 'same' }, { position: 0 }),
      ],
      state,
      options(),
      (store, metadata) => {
        assert.equal(metadata.counts.record.update, 0);
        assert.equal(store.getPlan('record', A)?.action, 'noop');
      },
    );
  });

  it('plans no update when a requested position coincides with a retained one', async () => {
    const state = schema([model({ sortable: true })]);
    await fixture(
      [record(A, { title: 'same' }, { position: 0 })],
      [
        record(A, { title: 'same' }, { position: 1 }),
        record(B, { title: 'keep' }, { position: 0 }),
      ],
      state,
      options(),
      (store) => assert.equal(store.getPlan('record', A)?.action, 'noop'),
    );
  });

  it('skips a refused record without closing over its ordered model', async () => {
    const state = schema([model({ sortable: true })]);
    const lossy = { title: { __itemTypeId: 'business value' } };
    await fixture(
      [
        record(A, lossy, { position: 0 }),
        record(B, { title: 'sibling' }, { position: 1 }),
      ],
      [],
      state,
      options({ allowPartial: true }),
      (store, metadata) => {
        assert.equal(store.getPlan('record', A)?.action, 'skip');
        assert.equal(store.getPlan('record', B)?.action, 'create');
        assert.equal(metadata.counts.record.skip, 1);
      },
    );
  });

  it('spreads a skip only to writes referencing a skipped create and deletes its retained state needs', async () => {
    const state = schema([
      model({
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    const lossy = { title: { __itemTypeId: 'business value' }, link: null };
    const X = id('x');
    const Y = id('y');
    await fixture(
      [
        // A is a refused create: B and C reference it and are skipped too,
        // whether they are creates or updates.
        record(A, lossy),
        record(B, { title: 'new', link: A }),
        record(C, { title: 'changed', link: A }),
        // X is a refused update: Y references X and is still written, and
        // the deletion of D, which X's destination state links to, is kept.
        record(X, { ...lossy, link: null }),
        record(Y, { title: 'changed', link: X }),
      ],
      [
        record(C, { title: 'old', link: null }),
        record(X, { title: 'old', link: id('d') }),
        record(Y, { title: 'old', link: null }),
        record(id('d'), { title: 'linked', link: null }),
        record(id('e'), { title: 'unlinked', link: null }),
      ],
      state,
      options({ allowPartial: true, includeDeletions: true }),
      (store) => {
        const action = (recordId: string) =>
          store.getPlan('record', recordId)?.action;
        assert.equal(action(A), 'skip');
        assert.equal(action(B), 'skip');
        assert.equal(action(C), 'skip');
        assert.equal(action(X), 'skip');
        assert.equal(action(Y), 'update');
        assert.equal(action(id('d')), 'skip');
        assert.equal(action(id('e')), 'delete');
        assert.deepEqual(
          store
            .getPlan('record', id('d'))
            ?.diagnostics.map((item) => item.code),
          ['PRESERVED_SKIP_DEPENDENCY'],
        );
      },
    );
  });

  it('keeps the uploads and folders that a skipped record still needs', async () => {
    const FILE = id('file');
    const state = schema([
      model({
        fields: [field(), field({ id: FILE, apiKey: 'file', type: 'file' })],
      }),
    ]);
    const folder = collection(id('folder'));
    const kept = { ...upload(id('kept')), collectionId: folder.id, hash: '' };
    kept.hash = hashJson(kept);
    const unrelated = upload(id('unrelated'));
    const X = id('x');
    const store = new SnapshotStore();
    try {
      store.putRecord(
        'source',
        record(X, { title: { __itemTypeId: 'business value' }, file: null }),
      );
      store.putRecord(
        'target',
        record(X, { title: 'old', file: { upload_id: kept.id } }),
      );
      store.putUpload('target', kept);
      store.putUpload('target', unrelated);
      store.putCollection('target', folder);
      createPlan(
        store,
        state,
        { ...state, environmentId: 'target' },
        options({ allowPartial: true, includeDeletions: true, uploads: 'all' }),
      );
      assert.equal(store.getPlan('record', X)?.action, 'skip');
      for (const [kind, entryId] of [
        ['upload', kept.id],
        ['collection', folder.id],
      ] as const) {
        const entry = store.getPlan(kind, entryId);
        assert.equal(entry?.action, 'skip');
        assert.deepEqual(
          entry?.diagnostics.map((item) => item.code),
          ['PRESERVED_SKIP_DEPENDENCY'],
        );
      }
      assert.equal(store.getPlan('upload', unrelated.id)?.action, 'delete');
    } finally {
      store.dispose();
    }
  });

  it('unpublishes published records that link to each other in a forced order', async () => {
    const state = schema([
      model({
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    const linked = (recordId: string, link: string, published: boolean) =>
      record(
        recordId,
        { title: recordId, link },
        published ? { published: { title: recordId, link } } : {},
      );
    await fixture(
      [linked(A, B, false), linked(B, A, false)],
      [linked(A, B, true), linked(B, A, true)],
      state,
      options(),
      (store) => {
        const orders = [A, B].map((recordId) => {
          const entry = store.getPlan('record', recordId) as RecordPlan;
          assert.equal(entry.action, 'update');
          assert.deepEqual(entry.diagnostics, []);
          return entry.execution!.publishOrder;
        });
        assert.notEqual(orders[0], orders[1]);
      },
    );
  });

  it('unpublishes a record referenced from an unpublishing cycle after its referrer', async () => {
    const [target, first, second] = [A, B, C].sort();
    const state = schema([
      model({
        fields: [field(), field({ id: LINK, apiKey: 'links', type: 'links' })],
      }),
    ]);
    const linked = (recordId: string, links: string[], published: boolean) =>
      record(
        recordId,
        { title: recordId, links },
        published ? { published: { title: recordId, links } } : {},
      );
    await fixture(
      [
        linked(first!, [second!, target!], false),
        linked(second!, [first!], false),
        linked(target!, [], false),
      ],
      [
        linked(first!, [second!, target!], true),
        linked(second!, [first!], true),
        linked(target!, [], true),
      ],
      state,
      options(),
      (store) => {
        const order = (recordId: string) => {
          const entry = store.getPlan('record', recordId) as RecordPlan;
          assert.deepEqual(entry.diagnostics, []);
          return entry.execution!.publishOrder!;
        };
        assert.notEqual(order(first!), order(second!));
        assert.ok(order(target!) > order(first!));
      },
    );
  });

  it('unpublishes a tree child before its unpublished parent', async () => {
    const state = schema([model({ tree: true })]);
    const node = (
      recordId: string,
      parentId: string | null,
      published: boolean,
    ) =>
      record(
        recordId,
        { title: recordId },
        {
          parentId,
          position: 0,
          ...(published ? { published: { title: recordId } } : {}),
        },
      );
    await fixture(
      [node(A, null, false), node(B, A, false)],
      [node(A, null, true), node(B, A, true)],
      state,
      options(),
      (store) => {
        const parent = store.getPlan('record', A) as RecordPlan;
        const child = store.getPlan('record', B) as RecordPlan;
        assert.deepEqual([...parent.diagnostics, ...child.diagnostics], []);
        assert.ok(
          child.execution!.publishOrder! < parent.execution!.publishOrder!,
        );
      },
    );
  });

  it('publishes a new tree child linked from a block of its already published parent', async () => {
    const state = schema([
      model({
        tree: true,
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'blocks', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'block',
        block: true,
        fields: [field({ id: LINK, apiKey: 'related', type: 'link' })],
      }),
    ]);
    const blocks = [
      {
        id: id('parent-block'),
        __itemTypeId: BLOCK_MODEL,
        attributes: { related: B },
      },
    ];
    const child = record(
      B,
      { blocks: [] },
      { parentId: A, position: 0, published: { blocks: [] } },
    );
    await fixture(
      [
        record(
          A,
          { blocks },
          { parentId: null, position: 0, published: { blocks } },
        ),
        child,
      ],
      [
        record(
          A,
          { blocks: [] },
          { parentId: null, position: 0, published: { blocks: [] } },
        ),
      ],
      state,
      options(),
      (store) => {
        const parent = store.getPlan('record', A) as RecordPlan;
        const created = store.getPlan('record', B) as RecordPlan;
        assert.equal(parent.action, 'update');
        assert.equal(created.action, 'create');
        assert.deepEqual([...parent.diagnostics, ...created.diagnostics], []);
        assert.equal(parent.execution?.provisionalPublished, undefined);
        assert.equal(created.execution?.provisionalPublished, undefined);
        assert.ok(
          created.execution!.publishOrder! < parent.execution!.publishOrder!,
        );
      },
    );
  });

  it('publishes a new tree child before its newly published parent that links to it from a block', async () => {
    const state = schema([
      model({
        tree: true,
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'blocks', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'block',
        block: true,
        fields: [field({ id: LINK, apiKey: 'related', type: 'link' })],
      }),
    ]);
    const blocks = [
      {
        id: id('parent-block'),
        __itemTypeId: BLOCK_MODEL,
        attributes: { related: B },
      },
    ];
    const parent = (published: boolean) =>
      record(
        A,
        { blocks },
        {
          parentId: null,
          position: 0,
          ...(published && { published: { blocks } }),
        },
      );
    const child = (published: boolean) =>
      record(
        B,
        { blocks: [] },
        {
          parentId: A,
          position: 0,
          ...(published && { published: { blocks: [] } }),
        },
      );
    for (const target of [[], [parent(false), child(false)]])
      await fixture(
        [parent(true), child(true)],
        target,
        state,
        options(),
        (store) => {
          const parentPlan = store.getPlan('record', A) as RecordPlan;
          const childPlan = store.getPlan('record', B) as RecordPlan;
          assert.deepEqual(
            [...parentPlan.diagnostics, ...childPlan.diagnostics],
            [],
          );
          assert.ok(
            childPlan.execution!.publishOrder! <
              parentPlan.execution!.publishOrder!,
          );
        },
      );
  });

  it('orders a folder parent swap deterministically for the CMA to judge', async () => {
    await collectionFixture(
      [collection(A, B), collection(B, A)],
      [collection(A, null), collection(B, null, 2)],
      {},
      (store, metadata) => {
        assert.equal(metadata.counts.collection.update, 2);
        assert.equal([...orderedCollectionWrites(store)].length, 2);
      },
    );
  });

  it('plans position-only collection reorders, sparse positions, and parent moves', async () => {
    const parent = id('parent');
    const other = id('other-parent');
    const cases = [
      {
        target: [
          collection(A, null, 1),
          collection(B, null, 2),
          collection(C, null, 3),
        ],
        source: [
          collection(A, null, 3),
          collection(B, null, 1),
          collection(C, null, 2),
        ],
      },
      {
        target: [collection(A, null, -5), collection(B, null, 10)],
        source: [collection(A, null, 10), collection(B, null, 20)],
      },
      {
        target: [
          collection(parent),
          collection(other, null, 2),
          collection(A, parent),
          collection(B, parent, 2),
          collection(C, other),
        ],
        source: [
          collection(parent),
          collection(other, null, 2),
          collection(A, other, 2),
          collection(B, parent),
          collection(C, other),
        ],
      },
    ];
    for (const { source, target } of cases)
      await collectionFixture(source, target, {}, (store, metadata) => {
        assert(metadata.counts.collection.update > 0);
        for (const state of source) {
          const previous = target.find((entry) => entry.id === state.id)!;
          const entry = store.getPlan('collection', state.id)!;
          assert.equal(
            entry.action,
            previous.hash === state.hash ? 'noop' : 'update',
          );
          if (entry.action === 'update')
            assert.deepEqual(
              entry.kind === 'collection' && entry.desired,
              state,
            );
        }
      });
  });

  it('plans duplicate folder positions', async () => {
    const peers = [collection(A), collection(B)];
    await collectionFixture(peers, peers);
    await collectionFixture(peers, [], {}, (_store, metadata) =>
      assert.equal(metadata.counts.collection.create, 2),
    );
    await collectionFixture([...peers, collection(C, null, 3)], peers);
    await collectionFixture([peers[0]], peers, { includeDeletions: true });
    await collectionFixture(
      [...peers, collection(C, null, 3, 'Renamed')],
      [...peers, collection(C, null, 3)],
      {},
      (store) => assert.equal(store.getPlan('collection', C)?.action, 'update'),
    );
  });

  it('plans folder label collisions and label swaps for the CMA to judge', async () => {
    await collectionFixture(
      [collection(A, null, 1, 'Images')],
      [collection(B, null, 2, 'Images')],
      {},
      (store) => assert.equal(store.getPlan('collection', A)?.action, 'create'),
    );
    await collectionFixture(
      [collection(A, null, 1, 'Beta'), collection(B, null, 2, 'Alpha')],
      [collection(A, null, 1, 'Alpha'), collection(B, null, 2, 'Beta')],
      {},
      (_store, metadata) => assert.equal(metadata.counts.collection.update, 2),
    );
  });

  it('allows ordinary collection renames and moves, case-sensitive labels, and untouched grandfathered labels', async () => {
    await collectionFixture(
      [collection(A, null, 1, 'Renamed')],
      [collection(A, null, 1, 'Original')],
    );
    await collectionFixture(
      [collection(A, null, 1, 'Images')],
      [collection(B, null, 2, 'images')],
    );
    const parent = id('label-parent');
    await collectionFixture(
      [collection(parent), collection(A, parent, 2, 'Images')],
      [
        collection(parent),
        collection(A, null, 2, 'Images'),
        collection(B, parent, 1, 'Other'),
      ],
    );
    const grandfathered = [
      collection(A, null, 1, 'Duplicate'),
      collection(B, null, 2, 'Duplicate'),
    ];
    await collectionFixture(grandfathered, grandfathered);
    await collectionFixture(
      [...grandfathered, collection(C, null, 3, 'New')],
      grandfathered,
    );
  });

  it('orders collection updates by their desired parent rather than their old parent', async () => {
    await collectionFixture(
      [collection(A, B), collection(B)],
      [collection(A), collection(B, A)],
      {},
      (store) => {
        const rank = (collectionId: string) =>
          Number(
            store.database
              .prepare(
                "SELECT rank FROM planner_nodes WHERE phase='collection-write' AND id=?",
              )
              .get(collectionId)?.rank,
          );
        assert(rank(B) < rank(A));
      },
    );
  });

  it('detaches an ancestor before moving beneath its unchanged descendant', async () => {
    const [outer, inner, middle] = [A, B, C].sort();
    const target = [
      collection(outer),
      collection(middle, outer),
      collection(inner, middle),
    ];
    const source = [
      collection(middle),
      collection(inner, middle),
      collection(outer, inner),
    ];
    await collectionFixture(source, target, {}, (store) => {
      assert.deepEqual(
        [...orderedCollectionWrites(store)].map((entry) => entry.id),
        [middle, outer],
      );
    });
  });

  it('plans an update that creates a nested block over a configured default', async () => {
    const state = schema([
      model({
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'block', type: 'single_block' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'block',
        block: true,
        fields: [field({ id: id('nested-title'), defaultValue: 'default' })],
      }),
    ]);
    const source = [
      record(A, {
        block: {
          id: id('nested'),
          __itemTypeId: BLOCK_MODEL,
          attributes: { title: null },
        },
      }),
    ];
    await fixture(
      source,
      [record(A, { block: null })],
      state,
      options(),
      (_store, metadata) => assert.equal(metadata.counts.record.update, 1),
    );
  });
});
