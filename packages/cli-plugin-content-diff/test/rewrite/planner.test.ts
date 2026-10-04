import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectionHash, hashJson, recordHash } from '../../src/engine/codec';
import { ContentError } from '../../src/engine/errors';
import { createPlan, orderedCollectionWrites } from '../../src/engine/planner';
import { PlannerGraph } from '../../src/engine/planner-graph';
import {
  creationEmptyValue,
  fieldFailures,
  fieldNeedsDefaultSuppression,
} from '../../src/engine/planner-validity';
import { SnapshotStore } from '../../src/engine/store';
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
} from '../../src/engine/types';

const id = (name: string) =>
  createHash('sha256').update(name).digest('base64url').slice(0, 22);
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
    validity: { current: true, published: null },
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
    allowTemporarySchemaChanges: false,
    ...overrides,
  };
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
    const metadata = await createPlan(
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
    const metadata = await createPlan(
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

describe('indexed rewrite planner', () => {
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
    } finally {
      store.dispose();
    }
  });

  it('uses native empty collections and suppresses only a nonnull default for the matching locale', () => {
    assert.deepEqual(creationEmptyValue('rich_text'), []);
    assert.deepEqual(creationEmptyValue('links'), []);
    assert.equal(creationEmptyValue('link'), null);
    const localized = field({
      type: 'link',
      localized: true,
      defaultValue: { en: null, it: 'preset' },
    });
    assert.equal(fieldNeedsDefaultSuppression(localized, { en: null }), false);
    assert.equal(
      fieldNeedsDefaultSuppression(localized, { en: null, it: 'keep' }),
      false,
    );
    assert.equal(fieldNeedsDefaultSuppression(localized, { it: null }), true);
    assert.equal(
      fieldNeedsDefaultSuppression(
        field({
          type: 'rich_text',
          localized: true,
          defaultValue: { en: [], it: [] },
        }),
        { en: [] },
      ),
      false,
    );
  });

  it('matches native blank length, array size, equality/multiple and Unicode character checks', () => {
    assert.deepEqual(
      fieldFailures(field({ validators: { length: { min: 1 } } }), ''),
      ['length'],
    );
    assert.deepEqual(
      fieldFailures(field({ validators: { length: { min: 1 } } }), null),
      ['length'],
    );
    assert.deepEqual(
      fieldFailures(
        field({ type: 'rich_text', validators: { size: { min: 1 } } }),
        [],
      ),
      ['size'],
    );
    assert.deepEqual(
      fieldFailures(field({ validators: { length: { eq: 1 } } }), '😊'),
      [],
    );
    assert.deepEqual(
      fieldFailures(field({ validators: { length: { eq: 2 } } }), '😊'),
      ['length'],
    );
    assert.deepEqual(
      fieldFailures(
        field({
          type: 'links',
          validators: { size: { min: 1, multiple_of: 2 } },
        }),
        ['one', 'two', 'three'],
      ),
      ['size'],
    );
    assert.deepEqual(
      fieldFailures(
        field({ type: 'links', validators: { size: { multiple_of: 2 } } }),
        ['one'],
      ),
      [],
    );
    assert.deepEqual(
      fieldFailures(
        field({ validators: { required: {}, enum: { values: ['allowed'] } } }),
        '  ',
      ),
      ['required'],
    );
    assert.deepEqual(
      fieldFailures(field({ validators: { required: {} } }), '\u0085'),
      ['required'],
    );
    assert.deepEqual(
      fieldFailures(field({ validators: { required: {} } }), '\uFEFF'),
      [],
    );
    assert.deepEqual(
      fieldFailures(
        field({ type: 'float', validators: { number_range: { min: 1 } } }),
        null,
      ),
      [],
    );
  });

  it('counts DAST span/code characters and detects the native required empty-paragraph constant', () => {
    const document: JsonObject = {
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          { type: 'paragraph', children: [{ type: 'span', value: '😊' }] },
          { type: 'code', code: 'a😊' },
        ],
      },
    };
    assert.deepEqual(
      fieldFailures(
        field({ type: 'structured_text', validators: { length: { eq: 3 } } }),
        document,
      ),
      [],
    );
    assert.deepEqual(
      fieldFailures(
        field({ type: 'structured_text', validators: { length: { eq: 4 } } }),
        document,
      ),
      ['length'],
    );
    const blank: JsonObject = {
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          { type: 'paragraph', children: [{ type: 'span', value: '' }] },
        ],
      },
    };
    assert.deepEqual(
      fieldFailures(
        field({ type: 'structured_text', validators: { required: {} } }),
        blank,
      ),
      ['required'],
    );
    assert.equal(creationEmptyValue('structured_text'), null);
  });
  it('stores complete changed states and only guards/safety for noops', async () => {
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
                    validity: { current: true, published: true },
                  }
                : {},
            ),
          );
          store.putRecord('source', record(B, { asset: null, link: A }));
          store.putRecord('source', record(C, safe));
          await assert.rejects(
            createPlan(store, state, state, options()),
            (error: unknown) =>
              error instanceof ContentError &&
              error.code === 'UNSAFE_REQUESTED_CHANGE' &&
              error.details?.reason === 'UNSUPPORTED_PAYLOAD_KEY',
          );
          assert.deepEqual([...store.planEntries()], []);
          await createPlan(
            store,
            state,
            state,
            options({ allowPartial: true }),
          );
          assert.equal(store.getPlan('record', A)?.action, 'skip');
          assert.equal(store.getPlan('record', B)?.action, 'skip');
          assert.equal(store.getPlan('record', C)?.action, 'create');
          store.putRecord('target', store.getRecord('source', A)!);
          await createPlan(store, state, state, options());
          assert.equal(store.getPlan('record', A)?.action, 'noop');
          assert.equal(store.getPlan('record', B)?.action, 'create');
        } finally {
          store.dispose();
        }
      }
    }
  });

  it('retains destination-only and unselected model records without deletion warnings', async () => {
    const other = model({ id: id('other-model'), apiKey: 'other' });
    const source = schema();
    const target = schema([model(), other]);
    const store = new SnapshotStore();
    try {
      store.putRecord(
        'target',
        record(B, { title: 'keep' }, { modelId: other.id }),
      );
      const metadata = await createPlan(
        store,
        source,
        target,
        options({ includeDeletions: true }),
      );
      const entry = store.getPlan('record', B)!;
      assert.equal(entry.action, 'noop');
      assert.deepEqual(
        entry.diagnostics.map((item) => item.code),
        ['RETAINED_DESTINATION_MODEL'],
      );
      assert.equal(metadata.counts.record.delete, 0);
    } finally {
      store.dispose();
    }
  });

  it('fails global schema incompatibility even when partial changes are allowed', async () => {
    const store = new SnapshotStore();
    try {
      await assert.rejects(
        createPlan(
          store,
          schema(),
          { ...schema(), locales: ['it'] },
          options({ allowPartial: true }),
        ),
        (error: unknown) =>
          error instanceof ContentError && error.code === 'SCHEMA_INCOMPATIBLE',
      );
    } finally {
      store.dispose();
    }
  });

  it('rejects nonportable creates and skips their complete requested dependency closure', async () => {
    const state = schema([
      model({
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    const source = [
      record('123'),
      record(B, { title: 'dependent', link: '123' }),
      record(C),
    ];
    await assert.rejects(fixture(source, [], state), unsafe);
    await fixture(
      source,
      [],
      state,
      options({ allowPartial: true }),
      (store, metadata) => {
        assert.equal(store.getPlan('record', '123')?.action, 'skip');
        assert.equal(store.getPlan('record', B)?.action, 'skip');
        assert.equal(store.getPlan('record', C)?.action, 'create');
        assert.equal(metadata.counts.record.skip, 2);
        assert.equal(metadata.counts.record.create, 1);
      },
    );
  });

  it('allows optional current creation cycles through explicit null seeds', async () => {
    const state = schema([
      model({ fields: [field({ id: LINK, apiKey: 'link', type: 'link' })] }),
    ]);
    await fixture(
      [record(A, { link: B }), record(B, { link: A })],
      [],
      state,
      options(),
      (store, metadata) => {
        for (const entry of store.planEntries('record')) {
          assert.equal(entry.kind, 'record');
          if (entry.kind !== 'record') continue;
          assert.deepEqual(entry.execution?.creationFields, { link: null });
          assert.equal(typeof entry.execution?.createOrder, 'number');
        }
        assert.deepEqual(metadata.temporarySchemaChanges, []);
      },
    );
  });

  it('keeps complete required acyclic creation fields and orders prerequisites without a temporary change', async () => {
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
      (store, metadata) => {
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
        assert.deepEqual(metadata.temporarySchemaChanges, []);
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
      (store, metadata) => {
        const dependant = store.getPlan('record', C) as RecordPlan;
        const seed = store.getPlan('record', A) as RecordPlan;
        assert.deepEqual(dependant.execution?.creationFields, { link: A });
        assert.ok(
          seed.execution!.createOrder! < dependant.execution!.createOrder!,
        );
        assert.deepEqual(metadata.temporarySchemaChanges, []);
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
          validity: { current: true, published: true },
        },
      ),
      record(
        B,
        { title: 'published dependency' },
        {
          published: { title: 'published dependency' },
          validity: { current: true, published: true },
        },
      ),
    ];
    const target = [record(B, { title: 'existing draft' })];
    const opts = options({ modelIds: [MODEL, automatic.id] });
    await fixture(source, target, state, opts, (store, metadata) => {
      const owner = store.getPlan('record', A) as RecordPlan;
      const dependency = store.getPlan('record', B) as RecordPlan;
      assert.deepEqual(owner.execution?.creationFields, { link: null });
      assert.ok(
        dependency.execution!.publishOrder! < owner.execution!.publishOrder!,
      );
      assert.deepEqual(metadata.temporarySchemaChanges, []);
    });
    automatic.fields[0].validators.required = {};
    await assert.rejects(fixture(source, target, state, opts), unsafe);
    await fixture(
      source,
      target,
      state,
      { ...opts, allowTemporarySchemaChanges: true },
      (store, metadata) => {
        assert.deepEqual(
          (store.getPlan('record', A) as RecordPlan).execution?.creationFields,
          { link: null },
        );
        assert.equal(metadata.temporarySchemaChanges[0].fieldId, LINK);
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          {},
        );
      },
    );
  });

  it('requires exact required-validator relaxation for required creation cycles', async () => {
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
    await assert.rejects(fixture(source, [], state), unsafe);
    await fixture(
      source,
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) => {
        assert.equal(metadata.temporarySchemaChanges.length, 1);
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          { item_item_type: { item_types: [MODEL] } },
        );
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].original.validators,
          state.models[0].fields[0].validators,
        );
      },
    );
  });

  it('allows native invalid draft saves without disabling validators', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ validators: { required: {} } })],
      }),
    ]);
    await fixture(
      [
        record(
          A,
          { title: null },
          { validity: { current: false, published: null } },
        ),
      ],
      [],
      state,
      options(),
      (_store, metadata) =>
        assert.deepEqual(metadata.temporarySchemaChanges, []),
    );
  });

  it('uses native invalid-draft saving for grandfathered current values and ignores flag-only differences', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ validators: { required: {} } })],
      }),
    ]);
    await fixture(
      [
        record(
          A,
          { title: '' },
          { validity: { current: true, published: null } },
        ),
      ],
      [],
      state,
      options(),
      (_store, metadata) =>
        assert.deepEqual(metadata.temporarySchemaChanges, []),
    );
    await fixture(
      [
        record(
          A,
          { title: '' },
          { validity: { current: false, published: null } },
        ),
      ],
      [
        record(
          A,
          { title: '' },
          { validity: { current: true, published: null } },
        ),
      ],
      state,
      options(),
      (_store, metadata) => assert.equal(metadata.counts.record.noop, 1),
    );
  });

  it('preserves locale maps in deferred creation seeds and rejects structural locale mismatches', async () => {
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
    await fixture(source, [], state, options(), (store) =>
      assert.deepEqual(
        (store.getPlan('record', A) as RecordPlan).execution?.creationFields,
        { title: { en: 'a', it: 'a' }, link: { en: null, it: null } },
      ),
    );
    await assert.rejects(
      fixture(
        [record(A, { title: { en: 'a' }, link: { it: null } })],
        [],
        state,
      ),
      unsafe,
    );
    const all = {
      ...schema([
        model({
          allLocalesRequired: true,
          fields: [field({ localized: true })],
        }),
      ]),
      locales: ['en', 'it'],
    };
    await assert.rejects(
      fixture([record(A, { title: { en: 'a' } })], [], all),
      unsafe,
    );
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
    await fixture(source, [], state, options(), (store, metadata) => {
      assert.deepEqual(metadata.temporarySchemaChanges, []);
      for (const plan of store.planEntries('record'))
        if (plan.kind === 'record') {
          assert.deepEqual(plan.execution?.creationFields?.link, { en: null });
          assert.deepEqual(plan.execution?.creationFields?.blocks, { en: [] });
          assert.equal(plan.execution?.createOrder, 0);
        }
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
    await assert.rejects(fixture(source, [], constrained), unsafe);
    await fixture(
      source,
      [],
      constrained,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          {},
        ),
    );
  });

  it('validates exactly the scheduled locale scope and accepts stale derived flags', async () => {
    const state = {
      ...schema([
        model({
          saveInvalidDrafts: true,
          fields: [field({ localized: true, validators: { required: {} } })],
        }),
      ]),
      locales: ['en', 'it'],
    };
    const scheduled = record(
      A,
      { title: { en: 'English', it: null } },
      {
        validity: { current: false, published: null },
        schedules: {
          publication: {
            at: '2090-01-01T12:00:00.000Z',
            selective: { locales: ['en'], nonLocalized: false },
          },
          unpublishing: null,
        },
      },
    );
    await fixture([scheduled], [], state, options(), (_store, metadata) =>
      assert.deepEqual(metadata.temporarySchemaChanges, []),
    );
    await assert.rejects(
      fixture(
        [
          record(A, scheduled.current, {
            validity: scheduled.validity,
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
      ),
      unsafe,
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
            validity: { current: false, published: null },
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

  it('preserves invalid unchanged schedules without writes and diagnoses their recreation in mixed plans', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ validators: { required: {} } })],
      }),
    ]);
    const scheduled = record(
      A,
      { title: '' },
      {
        validity: { current: false, published: null },
        schedules: {
          publication: { at: '2090-01-01T12:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    await fixture(
      [scheduled],
      [scheduled],
      state,
      options({ allowPartial: true, allowTemporarySchemaChanges: true }),
      (_store, metadata) => assert.equal(metadata.counts.record.noop, 1),
    );
    await assert.rejects(
      fixture(
        [scheduled, record(B, { title: 'new content' })],
        [scheduled],
        state,
        options({ allowPartial: true, allowTemporarySchemaChanges: true }),
      ),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'UNEXECUTABLE_EXISTING_SCHEDULE' &&
        error.message.includes('title (required)'),
    );
    const legacy = schema([
      model({ fields: [field({ validators: { required: {} } })] }),
    ]);
    await fixture(
      [scheduled],
      [scheduled],
      legacy,
      options(),
      (_store, metadata) => assert.equal(metadata.counts.record.noop, 1),
    );
  });

  it('diagnoses duplicate unique schedules before writes and preserves existing schedules without writes', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ validators: { unique: {} } })],
      }),
    ]);
    const schedules: RecordState['schedules'] = {
      publication: { at: '2099-01-01T12:00:00.000Z', selective: null },
      unpublishing: null,
    };
    const duplicate = record(B, { title: 'duplicate' });
    for (const published of [null, { title: 'previous publication' }]) {
      const scheduled = record(
        A,
        { title: 'duplicate' },
        {
          published,
          schedules,
          validity: { current: false, published: published ? true : null },
        },
      );
      await assert.rejects(
        fixture(
          [scheduled, duplicate],
          [],
          state,
          options({ allowTemporarySchemaChanges: true }),
        ),
        (error: unknown) =>
          error instanceof ContentError &&
          error.details?.reason === 'INVALID_SCHEDULED_PUBLICATION',
      );
      await fixture(
        [scheduled, duplicate],
        [],
        state,
        options({ allowPartial: true }),
        (store) => {
          assert.equal(store.getPlan('record', A)?.action, 'skip');
          assert.equal(store.getPlan('record', B)?.action, 'create');
        },
      );
      await assert.rejects(
        fixture(
          [scheduled, duplicate, record(C, { title: 'new content' })],
          [scheduled, duplicate],
          state,
          options({ allowPartial: true }),
        ),
        (error: unknown) =>
          error instanceof ContentError &&
          error.code === 'UNEXECUTABLE_EXISTING_SCHEDULE' &&
          /unique/.test(error.message),
      );
      await fixture(
        [scheduled, duplicate],
        [scheduled, duplicate],
        state,
        options({ allowPartial: true }),
        (_store, metadata) => assert.equal(metadata.counts.record.noop, 2),
      );
    }
  });

  it('checks scheduled uniqueness only in the requested locale scope', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ localized: true, validators: { unique: {} } })],
      }),
    ]);
    state.locales = ['en', 'it'];
    const scheduled = (locale: string) =>
      record(
        A,
        { title: { en: 'duplicate', it: 'a' } },
        {
          validity: { current: false, published: null },
          schedules: {
            publication: {
              at: '2099-01-01T12:00:00.000Z',
              selective: { locales: [locale], nonLocalized: false },
            },
            unpublishing: null,
          },
        },
      );
    const duplicate = record(
      B,
      { title: { en: 'duplicate', it: 'b' } },
      { validity: { current: false, published: null } },
    );
    await fixture([scheduled('it'), duplicate], [], state);
    await assert.rejects(
      fixture([scheduled('en'), duplicate], [], state),
      (error: unknown) =>
        error instanceof ContentError &&
        error.details?.reason === 'INVALID_SCHEDULED_PUBLICATION',
    );
  });

  it('diagnoses unsafe scheduled noop refreshes when any final plan kind writes', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
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
            validity: { current: false, published: null },
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
        if (write === 'none') await run();
        else
          await assert.rejects(
            run(),
            (error: unknown) =>
              error instanceof ContentError &&
              error.code === 'UNEXECUTABLE_EXISTING_SCHEDULE' &&
              error.details?.reason === 'UNSUPPORTED_PAYLOAD_KEY',
          );
      } finally {
        store.dispose();
      }
    }
  });

  it('uses destination validity and native schedule semantics for noop refresh safety', async () => {
    const cases = [
      {
        sourceValid: false,
        targetValid: true,
        saveInvalidDrafts: true,
        improved: false,
        selective: false,
        unpublishing: false,
        rejects: false,
      },
      {
        sourceValid: true,
        targetValid: false,
        saveInvalidDrafts: true,
        improved: false,
        selective: false,
        unpublishing: false,
        rejects: true,
      },
      {
        sourceValid: false,
        targetValid: false,
        saveInvalidDrafts: true,
        improved: false,
        selective: true,
        unpublishing: false,
        rejects: false,
      },
      {
        sourceValid: false,
        targetValid: false,
        saveInvalidDrafts: false,
        improved: false,
        selective: false,
        unpublishing: false,
        rejects: false,
      },
      {
        sourceValid: false,
        targetValid: false,
        saveInvalidDrafts: false,
        improved: true,
        selective: false,
        unpublishing: false,
        rejects: true,
      },
      {
        sourceValid: false,
        targetValid: false,
        saveInvalidDrafts: true,
        improved: false,
        selective: false,
        unpublishing: true,
        rejects: false,
      },
    ];
    for (const entry of cases) {
      const state = schema([
        model({
          saveInvalidDrafts: entry.saveInvalidDrafts,
          fields: [field({ apiKey: 'asset', type: 'file' })],
        }),
      ]);
      state.semantics.improved_validation_at_publishing = entry.improved;
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
            validity: { current: entry.sourceValid, published: null },
            schedules: entry.unpublishing
              ? {
                  publication: null,
                  unpublishing: {
                    at: '2099-01-01T12:00:00.000Z',
                    locales: null,
                  },
                }
              : {
                  publication: {
                    at: '2099-01-01T12:00:00.000Z',
                    selective: entry.selective
                      ? { locales: [], nonLocalized: true }
                      : null,
                  },
                  unpublishing: null,
                },
          },
        );
        store.putRecord('source', scheduled);
        store.putRecord('target', {
          ...scheduled,
          validity: { current: entry.targetValid, published: null },
        });
        store.putRecord('source', record(B, { asset: null }));
        const run = createPlan(store, state, state, options());
        if (entry.rejects)
          await assert.rejects(
            run,
            (error: unknown) =>
              error instanceof ContentError &&
              error.code === 'UNEXECUTABLE_EXISTING_SCHEDULE',
          );
        else await run;
      } finally {
        store.dispose();
      }
    }
  });

  it('rechecks scheduled uniqueness after a partial skip restores a destination owner', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ validators: { unique: {} } })],
      }),
    ]);
    const schedules: RecordState['schedules'] = {
      publication: { at: '2099-01-01T12:00:00.000Z', selective: null },
      unpublishing: null,
    };
    const source = [
      record(A, { title: 'held' }, { schedules }),
      record(B, { title: 'released' }),
      record(C, { title: 'independent' }),
    ];
    const target = [
      record(A, { title: 'previous' }, { schedules }),
      record(B, { title: 'held' }, { currentVersion: null }),
    ];
    await fixture(
      source,
      target,
      state,
      options({ allowPartial: true }),
      (store) => {
        assert.equal(store.getPlan('record', A)?.action, 'skip');
        assert.equal(store.getPlan('record', B)?.action, 'skip');
        assert.equal(store.getPlan('record', C)?.action, 'create');
      },
    );
    await assert.rejects(
      fixture(
        source,
        [source[0], target[1]],
        state,
        options({ allowPartial: true }),
      ),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'UNEXECUTABLE_EXISTING_SCHEDULE',
    );
    await fixture(
      source.slice(0, 2),
      [source[0], target[1]],
      state,
      options({ allowPartial: true }),
      (_store, metadata) => {
        assert.equal(metadata.counts.record.noop, 1);
        assert.equal(metadata.counts.record.skip, 1);
        assert.deepEqual(metadata.temporarySchemaChanges, []);
      },
    );
  });

  it('proves grandfathered field failures even when both stored validity flags remain true', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [
          field({
            validators: { required: {}, unique: {}, length: { max: 100 } },
          }),
        ],
      }),
    ]);
    const source = [
      record(
        A,
        { title: '' },
        {
          published: { title: '' },
          validity: { current: true, published: true },
        },
      ),
    ];
    await assert.rejects(fixture(source, [], state), unsafe);
    await fixture(
      source,
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) => {
        assert.equal(metadata.temporarySchemaChanges.length, 1);
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          { unique: {}, length: { max: 100 } },
        );
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].original.validators,
          { required: {}, unique: {}, length: { max: 100 } },
        );
      },
    );
    await assert.rejects(fixture(source, [record(A)], state), unsafe);
    await fixture(
      source,
      [record(A)],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          { unique: {}, length: { max: 100 } },
        ),
    );
  });

  it('diagnoses publication reference cycles before execution', async () => {
    const state = schema([
      model({ fields: [field({ id: LINK, apiKey: 'link', type: 'link' })] }),
    ]);
    const source = [
      record(
        A,
        { link: B },
        {
          published: { link: B },
          validity: { current: true, published: true },
        },
      ),
      record(
        B,
        { link: A },
        {
          published: { link: A },
          validity: { current: true, published: true },
        },
      ),
    ];
    await assert.rejects(
      fixture(
        source,
        [],
        state,
        options({ allowTemporarySchemaChanges: true }),
      ),
      unsafe,
    );
    await fixture(
      source,
      [],
      state,
      options({ allowPartial: true }),
      (_store, metadata) => assert.equal(metadata.counts.record.skip, 2),
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
        validity: { current: true, published: true },
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

  it('still rejects multi-record deletion cycles and self-parented trees', async () => {
    const state = schema([
      model({ fields: [field({ apiKey: 'link', type: 'link' })] }),
    ]);
    await assert.rejects(
      fixture(
        [],
        [record(A, { link: B }), record(B, { link: A })],
        state,
        options({ includeDeletions: true }),
      ),
      unsafe,
    );
    const tree = schema([model({ tree: true })]);
    await assert.rejects(
      fixture(
        [record(A, { title: 'self' }, { parentId: A, position: 0 })],
        [],
        tree,
      ),
      unsafe,
    );
    await assert.rejects(
      fixture(
        [],
        [record(A, { title: 'self' }, { parentId: A, position: 0 })],
        tree,
        options({ includeDeletions: true }),
      ),
      unsafe,
    );
  });

  it('copies invalid published values with a proven narrow relaxation and ignores stale derived validity flags', async () => {
    const state = schema([
      model({
        fields: [field({ validators: { required: {}, length: { max: 10 } } })],
      }),
    ]);
    const source = [
      record(
        A,
        { title: 'valid' },
        {
          published: { title: null },
          validity: { current: true, published: false },
        },
      ),
    ];
    await assert.rejects(fixture(source, [], state), unsafe);
    await fixture(
      source,
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          { length: { max: 10 } },
        ),
    );
    await fixture(
      [
        record(
          A,
          { title: 'valid' },
          {
            published: { title: 'valid' },
            validity: { current: true, published: false },
          },
        ),
      ],
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.deepEqual(metadata.temporarySchemaChanges, []),
    );
  });

  it('plans null/default suppression explicitly and removes unused changes after skips', async () => {
    const state = schema([
      model({ fields: [field({ defaultValue: 'default' })] }),
    ]);
    await assert.rejects(
      fixture([record(A, { title: null })], [], state),
      unsafe,
    );
    await fixture(
      [record(A, { title: null })],
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) => {
        assert.equal(
          metadata.temporarySchemaChanges[0].temporary.defaultValue,
          null,
        );
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          {},
        );
      },
    );
    await fixture(
      [record('legacy', { title: null })],
      [],
      state,
      options({ allowTemporarySchemaChanges: true, allowPartial: true }),
      (_store, metadata) =>
        assert.deepEqual(metadata.temporarySchemaChanges, []),
    );
  });

  it('suppresses localized defaults with every environment locale retained', async () => {
    const state = schema([
      model({
        fields: [
          field({
            localized: true,
            defaultValue: { en: 'default', it: 'predefinito', fr: null },
          }),
        ],
      }),
    ]);
    state.locales = ['en', 'it', 'fr'];
    await fixture(
      [record(A, { title: { en: null, it: null } })],
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) => {
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.defaultValue,
          { en: null, it: null, fr: null },
        );
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].original.defaultValue,
          { en: 'default', it: 'predefinito', fr: null },
        );
      },
    );
  });

  it('detects defaults inside nested blocks without inspecting opaque JSON', async () => {
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
    await assert.rejects(fixture(source, [], state), unsafe);
    await fixture(
      source,
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.equal(metadata.temporarySchemaChanges[0].modelId, BLOCK_MODEL),
    );
  });

  it('rejects block ownership relocation and singleton identity mismatch', async () => {
    const state = schema([
      model({
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'block', type: 'single_block' }),
        ],
      }),
      model({ id: BLOCK_MODEL, apiKey: 'block', block: true }),
    ]);
    const block = {
      id: id('nested'),
      __itemTypeId: BLOCK_MODEL,
      attributes: { title: 'inside' },
    };
    await assert.rejects(
      fixture(
        [record(A, { block: null }), record(B, { block })],
        [record(A, { block }), record(B, { block: null })],
        state,
      ),
      unsafe,
    );
    await assert.rejects(
      fixture(
        [record(A)],
        [record(B)],
        schema([model({ singleton: true })]),
        options({ includeDeletions: true }),
      ),
      unsafe,
    );
  });

  it('diagnoses actual published writes that would reintroduce published-only block IDs', async () => {
    const blockId = id('published-only-block');
    const block = {
      id: blockId,
      __itemTypeId: BLOCK_MODEL,
      attributes: { title: 'Block' },
    };
    for (const type of ['rich_text', 'single_block', 'structured_text']) {
      const value =
        type === 'rich_text'
          ? [block]
          : type === 'single_block'
            ? block
            : {
                schema: 'dast',
                document: {
                  type: 'root',
                  children: [{ type: 'block', item: block }],
                },
              };
      const empty = creationEmptyValue(type);
      const state = schema([
        model({
          fields: [
            field(),
            field({ id: BLOCK_FIELD, apiKey: 'body', type }),
            field({ id: LINK, apiKey: 'link', type: 'link' }),
          ],
        }),
        model({
          id: BLOCK_MODEL,
          apiKey: 'content_block',
          block: true,
          fields: [field({ id: id('block-title') })],
        }),
      ]);
      const baseline = record(
        A,
        { title: 'Draft', body: empty, link: null },
        {
          published: { title: 'Old publication', body: value, link: null },
          validity: { current: true, published: true },
        },
      );
      const desired = record(A, baseline.current, {
        published: { title: 'New publication', body: value, link: null },
        validity: baseline.validity,
      });
      await assert.rejects(
        fixture([desired], [baseline], state),
        (error: unknown) =>
          error instanceof ContentError &&
          error.details?.reason === 'UNSUPPORTED_BLOCK_REINTRODUCTION',
      );
      await fixture(
        [
          desired,
          record(B, { title: 'Dependent', body: empty, link: A }),
          record(C, { title: 'Independent', body: empty, link: null }),
        ],
        [baseline],
        state,
        options({ allowPartial: true }),
        (store) => {
          assert.equal(store.getPlan('record', A)?.action, 'skip');
          assert.equal(store.getPlan('record', B)?.action, 'skip');
          assert.equal(store.getPlan('record', C)?.action, 'create');
        },
      );
    }
  });

  it('preserves matching publications and allows blocks owned by destination current', async () => {
    const block = {
      id: id('published-block'),
      __itemTypeId: BLOCK_MODEL,
      attributes: { title: 'Block' },
    };
    const state = schema([
      model({
        fields: [
          field(),
          field({ id: BLOCK_FIELD, apiKey: 'body', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'content_block',
        block: true,
        fields: [field({ id: id('block-title') })],
      }),
    ]);
    const published = { title: 'Publication', body: [block] };
    const baseline = record(
      A,
      { title: 'Draft', body: [] },
      { published, validity: { current: true, published: true } },
    );
    await fixture(
      [
        record(
          A,
          { title: 'Changed draft', body: [] },
          { published, validity: baseline.validity },
        ),
      ],
      [baseline],
      state,
    );
    const updatedPublication = { title: 'New publication', body: [block] };
    await fixture(
      [
        record(A, baseline.current, {
          published: updatedPublication,
          validity: baseline.validity,
        }),
      ],
      [record(A, published, { published, validity: baseline.validity })],
      state,
    );
    await fixture(
      [
        record(A, baseline.current, {
          published: updatedPublication,
          validity: baseline.validity,
        }),
      ],
      [
        record(A, baseline.current, {
          published: { title: 'Old publication', body: [] },
          validity: baseline.validity,
        }),
      ],
      state,
    );
  });

  it('models orphan removal before allowing a same-ID block recreation', async () => {
    const block = {
      id: id('recreated-block'),
      __itemTypeId: BLOCK_MODEL,
      attributes: { title: 'Block' },
    };
    const state = schema([
      model({
        fields: [
          field(),
          field({ id: BLOCK_FIELD, apiKey: 'body', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'content_block',
        block: true,
        fields: [field({ id: id('block-title') })],
      }),
    ]);
    const withBlock = { title: 'Body', body: [block] };
    const withoutBlock = { title: 'Body', body: [] };
    const baseline = record(A, withoutBlock, {
      published: withBlock,
      validity: { current: true, published: true },
    });
    await assert.rejects(
      fixture(
        [
          record(A, withBlock, {
            published: withBlock,
            validity: baseline.validity,
          }),
        ],
        [baseline],
        state,
      ),
      (error: unknown) =>
        error instanceof ContentError &&
        error.details?.reason === 'UNSUPPORTED_BLOCK_REINTRODUCTION',
    );
    await fixture(
      [record(A, withBlock, { firstPublishedAt: baseline.firstPublishedAt })],
      [baseline],
      state,
    );
    for (const priorPublication of [null, withBlock]) {
      const prior = record(A, withBlock, {
        published: priorPublication,
        validity: { current: true, published: priorPublication ? true : null },
      });
      await fixture(
        [
          record(A, withBlock, {
            published: withoutBlock,
            validity: { current: true, published: true },
          }),
        ],
        [prior],
        state,
      );
    }
  });

  it('checks published-only nested ownership at a stable parent block and permits reordering', async () => {
    const parentId = id('parent-block');
    const childId = id('nested-published-only');
    const childModel = id('child-model');
    const nested = {
      id: childId,
      __itemTypeId: childModel,
      attributes: { title: 'Child' },
    };
    const parent = (children: JsonObject[]) => ({
      id: parentId,
      __itemTypeId: BLOCK_MODEL,
      attributes: { nested: { en: children } },
    });
    const state = schema([
      model({
        fields: [
          field(),
          field({ id: BLOCK_FIELD, apiKey: 'body', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'parent_block',
        block: true,
        fields: [
          field({
            id: id('nested-field'),
            apiKey: 'nested',
            type: 'rich_text',
            localized: true,
          }),
        ],
      }),
      model({
        id: childModel,
        apiKey: 'child_block',
        block: true,
        fields: [field({ id: id('child-title') })],
      }),
    ]);
    const baseline = record(
      A,
      { title: 'Draft', body: [parent([])] },
      {
        published: { title: 'Old', body: [parent([nested])] },
        validity: { current: true, published: true },
      },
    );
    const desired = record(A, baseline.current, {
      published: { title: 'New', body: [parent([nested])] },
      validity: baseline.validity,
    });
    await assert.rejects(
      fixture([desired], [baseline], state),
      (error: unknown) =>
        error instanceof ContentError &&
        error.details?.reason === 'UNSUPPORTED_BLOCK_REINTRODUCTION' &&
        error.details?.dependencyId === childId,
    );
    const second = { ...nested, id: id('second-child') };
    const original = { title: 'Original', body: [parent([nested, second])] };
    await fixture(
      [record(A, { title: 'New', body: [parent([second, nested])] })],
      [record(A, original)],
      state,
    );
  });

  it('requires an already-declared suppression when publication staging recreates an existing defaulted block', async () => {
    const blockId = id('defaulted-recreated-block');
    const block = {
      id: blockId,
      __itemTypeId: BLOCK_MODEL,
      attributes: { amount: null },
    };
    const blockAmount = id('defaulted-block-amount');
    const state = schema([
      model({
        fields: [
          field(),
          field({ id: BLOCK_FIELD, apiKey: 'body', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'content_block',
        block: true,
        fields: [
          field({
            id: blockAmount,
            apiKey: 'amount',
            type: 'integer',
            defaultValue: 7,
          }),
        ],
      }),
    ]);
    const fields = { title: 'Draft', body: [block] };
    const baseline = record(A, fields);
    const desired = record(A, fields, {
      published: { title: 'Publication', body: [] },
      validity: { current: true, published: true },
    });
    await assert.rejects(
      fixture(
        [desired],
        [baseline],
        state,
        options({ allowTemporarySchemaChanges: true }),
      ),
      (error: unknown) =>
        error instanceof ContentError &&
        error.details?.reason === 'UNSUPPORTED_BLOCK_RECREATION_DEFAULT',
    );
    const newBlock = { ...block, id: id('new-defaulted-block') };
    const requiringSuppression = record(B, { title: 'New', body: [newBlock] });
    await fixture(
      [desired, requiringSuppression],
      [baseline],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) => {
        assert.equal(metadata.temporarySchemaChanges.length, 1);
        assert.equal(metadata.temporarySchemaChanges[0].fieldId, blockAmount);
        assert.equal(
          metadata.temporarySchemaChanges[0].temporary.defaultValue,
          null,
        );
      },
    );
    await fixture(
      [
        desired,
        record('legacy', requiringSuppression.current),
        record(C, { title: 'Independent', body: [] }),
      ],
      [baseline],
      state,
      options({ allowPartial: true, allowTemporarySchemaChanges: true }),
      (store, metadata) => {
        assert.equal(store.getPlan('record', A)?.action, 'skip');
        assert.equal(store.getPlan('record', 'legacy')?.action, 'skip');
        assert.equal(store.getPlan('record', C)?.action, 'create');
        assert.deepEqual(metadata.temporarySchemaChanges, []);
      },
    );
  });

  it('rejects a legacy block only when the planned phases must recreate its identity', async () => {
    const block = {
      id: '42',
      __itemTypeId: BLOCK_MODEL,
      attributes: { title: 'Existing legacy block' },
    };
    const state = schema([
      model({
        fields: [
          field(),
          field({ id: BLOCK_FIELD, apiKey: 'body', type: 'rich_text' }),
        ],
      }),
      model({
        id: BLOCK_MODEL,
        apiKey: 'content_block',
        block: true,
        fields: [field({ id: id('legacy-block-title') })],
      }),
    ]);
    const fields = { title: 'Draft', body: [block] };
    const baseline = record(A, fields);
    await fixture(
      [record(A, { ...fields, title: 'Edited draft' })],
      [baseline],
      state,
    );
    await assert.rejects(
      fixture(
        [
          record(A, fields, {
            published: { title: 'Publication', body: [] },
            validity: { current: true, published: true },
          }),
        ],
        [baseline],
        state,
      ),
      (error: unknown) =>
        error instanceof ContentError &&
        error.details?.reason === 'UNSUPPORTED_LEGACY_BLOCK_ID',
    );
  });

  it('detects repeated block IDs even when their storage ownership keys would be identical', async () => {
    const state = schema([
      model({
        fields: [
          field({ id: BLOCK_FIELD, apiKey: 'blocks', type: 'rich_text' }),
        ],
      }),
      model({ id: BLOCK_MODEL, apiKey: 'block', block: true }),
    ]);
    const block = {
      id: id('nested'),
      __itemTypeId: BLOCK_MODEL,
      attributes: { title: 'inside' },
    };
    const bad = record(A, { blocks: [block, block] });
    await assert.rejects(fixture([bad], [], state), unsafe);
    await fixture(
      [bad, record(B, { blocks: [] })],
      [],
      state,
      options({ allowPartial: true }),
      (_store, metadata) => {
        assert.equal(metadata.counts.record.skip, 1);
        assert.equal(metadata.counts.record.create, 1);
      },
    );
    await assert.rejects(
      fixture([], [bad], state),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'BLOCK_OWNERSHIP_CONFLICT',
    );
  });

  it('prevents deletion of an upload needed by an unselected preservation record', async () => {
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
      await assert.rejects(
        createPlan(
          store,
          state,
          state,
          options({ uploads: 'all', includeDeletions: true }),
        ),
        unsafe,
      );
      const metadata = await createPlan(
        store,
        state,
        state,
        options({ uploads: 'all', includeDeletions: true, allowPartial: true }),
      );
      assert.equal(store.getPlan('upload', asset.id)?.action, 'skip');
      assert.equal(metadata.counts.record.noop, 1);
    } finally {
      store.dispose();
    }
  });

  it('orders unique-value releases and requires explicit relaxation for swaps', async () => {
    const state = schema([
      model({
        fields: [field({ validators: { unique: {}, length: { max: 100 } } })],
      }),
    ]);
    await fixture(
      [record(A, { title: 'new' }), record(B, { title: 'a' })],
      [record(A, { title: 'a' }), record(B, { title: 'b' })],
      state,
      options(),
      (store) => {
        const a = store.getPlan('record', A) as RecordPlan;
        const b = store.getPlan('record', B) as RecordPlan;
        assert.ok(a.execution!.updateOrder! < b.execution!.updateOrder!);
      },
    );
    const source = [record(A, { title: 'b' }), record(B, { title: 'a' })];
    const target = [record(A, { title: 'a' }), record(B, { title: 'b' })];
    await assert.rejects(fixture(source, target, state), unsafe);
    await fixture(
      source,
      target,
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          { length: { max: 100 } },
        ),
    );
  });

  it('detects unique conflicts with retained destination-only records', async () => {
    const state = schema([
      model({ fields: [field({ validators: { unique: {} } })] }),
    ]);
    await assert.rejects(
      fixture(
        [record(A, { title: 'held' })],
        [record(B, { title: 'held' })],
        state,
      ),
      unsafe,
    );
  });

  it('narrowly reproduces proven grandfathered source uniqueness without permitting unrelated destination collisions', async () => {
    const state = schema([
      model({
        fields: [field({ validators: { unique: {}, length: { max: 100 } } })],
      }),
    ]);
    const source = [
      record(A, { title: 'grandfathered' }),
      record(B, { title: 'grandfathered' }),
    ];
    await assert.rejects(fixture(source, [], state), unsafe);
    await fixture(
      source,
      [],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.deepEqual(
          metadata.temporarySchemaChanges[0].temporary.validators,
          { length: { max: 100 } },
        ),
    );
    await assert.rejects(
      fixture(
        source,
        [record(C, { title: 'grandfathered' })],
        state,
        options({ allowTemporarySchemaChanges: true }),
      ),
      unsafe,
    );
  });

  it('aggregates repeated native invalid unique owners rather than joining every owner pair', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ validators: { unique: {} } })],
      }),
    ]);
    const source = Array.from({ length: 180 }, (_, index) =>
      record(
        id(`new-duplicate-${index}`),
        { title: 'duplicate' },
        { validity: { current: false, published: null } },
      ),
    );
    const target = Array.from({ length: 120 }, (_, index) =>
      record(
        id(`old-duplicate-${index}`),
        { title: 'duplicate' },
        { validity: { current: false, published: null } },
      ),
    );
    await fixture(source, target, state, options(), (store, metadata) => {
      assert.equal(metadata.counts.record.create, 180);
      assert.equal(metadata.counts.record.noop, 120);
      assert.deepEqual(metadata.temporarySchemaChanges, []);
      assert.equal(
        store.database
          .prepare(
            "SELECT owner_count FROM planner_unique_owners WHERE side='target'",
          )
          .get()?.owner_count,
        120,
      );
      assert.equal(
        store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM planner_unique_owners WHERE side='target'",
          )
          .get()?.count,
        1,
      );
    });
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
                },
              ),
            );
        });
      const metadata = await createPlan(
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
        assert.equal(entry.execution?.updateOrder, depth);
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
          validity: { current: true, published: true },
        },
      ),
      record(
        B,
        { title: 'new-b', link: A },
        {
          published: { title: 'new-b', link: A },
          validity: { current: true, published: true },
        },
      ),
    ];
    const target = [
      record(
        A,
        { title: 'old-a', link: B },
        {
          published: { title: 'old-a', link: B },
          validity: { current: true, published: true },
        },
      ),
      record(
        B,
        { title: 'old-b', link: A },
        {
          published: { title: 'old-b', link: A },
          validity: { current: true, published: true },
        },
      ),
    ];
    await fixture(source, target, state, options(), (_store, metadata) =>
      assert.equal(metadata.counts.record.update, 2),
    );
  });

  it('prevents unpublishing a record needed by a retained publication', async () => {
    const other = model({
      id: id('other'),
      apiKey: 'other',
      fields: [field({ id: LINK, apiKey: 'link', type: 'link' })],
    });
    const state = schema([model(), other]);
    const target = [
      record(
        A,
        { title: 'old' },
        {
          published: { title: 'old' },
          validity: { current: true, published: true },
        },
      ),
      record(
        B,
        { link: A },
        {
          modelId: other.id,
          published: { link: A },
          validity: { current: true, published: true },
        },
      ),
    ];
    await assert.rejects(
      fixture([record(A, { title: 'new' })], target, state),
      unsafe,
    );
    await fixture(
      [record(A, { title: 'new' })],
      target,
      state,
      options({ allowPartial: true }),
      (store) => assert.equal(store.getPlan('record', A)?.action, 'skip'),
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
          validity: { current: true, published: true },
        },
      ),
      record(
        B,
        { title: 'dependency', link: null },
        {
          published: { title: 'dependency', link: null },
          validity: { current: true, published: true },
        },
      ),
    ];
    for (const published of [{ title: 'owner', link: null }, null]) {
      await fixture(
        [
          record(
            A,
            { title: 'owner', link: null },
            {
              published,
              validity: { current: true, published: published ? true : null },
            },
          ),
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

  it('diagnoses unpublishing when a published referrer will only be deleted later', async () => {
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
        {
          published: { title: 'owner', link: B },
          validity: { current: true, published: true },
        },
      ),
      record(
        B,
        { title: 'dependency', link: null },
        {
          published: { title: 'dependency', link: null },
          validity: { current: true, published: true },
        },
      ),
    ];
    await assert.rejects(
      fixture(source, target, state, options({ includeDeletions: true })),
      unsafe,
    );
    await fixture(
      source,
      target,
      state,
      options({ includeDeletions: true, allowPartial: true }),
      (store) => {
        assert.equal(store.getPlan('record', A)?.action, 'delete');
        assert.equal(store.getPlan('record', B)?.action, 'skip');
      },
    );
  });

  it('allows a native invalid current unique value without temporary schema changes', async () => {
    const state = schema([
      model({
        saveInvalidDrafts: true,
        fields: [field({ validators: { unique: {} } })],
      }),
    ]);
    await fixture(
      [
        record(
          A,
          { title: 'held' },
          { validity: { current: false, published: null } },
        ),
      ],
      [record(B, { title: 'held' })],
      state,
      options(),
      (_store, metadata) =>
        assert.deepEqual(metadata.temporarySchemaChanges, []),
    );
  });

  it('carries a complete state when only ordering differs', async () => {
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
        assert.equal(metadata.counts.record.update, 2);
        assert.equal(
          (store.getPlan('record', A) as RecordPlan).desired?.position,
          0,
        );
      },
    );
  });

  it('rejects conflicting requested and retained sibling positions even with partial enabled', async () => {
    const state = schema([model({ sortable: true })]);
    await assert.rejects(
      fixture(
        [record(A, { title: 'same' }, { position: 0 })],
        [
          record(A, { title: 'same' }, { position: 1 }),
          record(B, { title: 'keep' }, { position: 0 }),
        ],
        state,
        options({ allowPartial: true }),
      ),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'ORDERING_CONFLICT',
    );
  });

  it('closes a partial skip over its ordered model and retains unrelated models', async () => {
    const other = model({ id: id('other'), apiKey: 'other' });
    const state = schema([model({ sortable: true }), other]);
    await fixture(
      [
        record('legacy', { title: 'bad' }, { position: 0 }),
        record(B, { title: 'sibling' }, { position: 1 }),
        record(C, { title: 'independent' }, { modelId: other.id }),
      ],
      [],
      state,
      options({ allowPartial: true, modelIds: [MODEL, other.id] }),
      (store, metadata) => {
        assert.equal(store.getPlan('record', B)?.action, 'skip');
        assert.equal(store.getPlan('record', C)?.action, 'create');
        assert.equal(metadata.counts.record.skip, 2);
      },
    );
  });

  it('detects collection movement cycles and proves isolated collection skips', async () => {
    const store = new SnapshotStore();
    try {
      store.putCollection('target', collection(A, null));
      store.putCollection('target', collection(B, null, 2));
      store.putCollection('source', collection(A, B));
      store.putCollection('source', collection(B, A));
      await assert.rejects(
        createPlan(store, schema(), schema(), options({ uploads: 'all' })),
        unsafe,
      );
      const metadata = await createPlan(
        store,
        schema(),
        schema(),
        options({ uploads: 'all', allowPartial: true }),
      );
      assert.equal(metadata.counts.collection.skip, 2);
    } finally {
      store.dispose();
    }
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
          const final = store.database
            .prepare(
              'SELECT parent_id,position FROM planner_collection_live WHERE id=?',
            )
            .get(state.id);
          assert.equal(final?.parent_id, state.parentId);
          assert.equal(final?.position, state.position);
          const previous = target.find((entry) => entry.id === state.id)!;
          assert.equal(
            store.getPlan('collection', state.id)?.action,
            previous.hash === state.hash ? 'noop' : 'update',
          );
        }
      });
  });

  it('preserves legal collection duplicates for noops, explicit creates, deletes, and unaffected updates', async () => {
    const peers = [collection(A), collection(B)];
    await collectionFixture(peers, peers);
    await collectionFixture(peers, []);
    await collectionFixture([...peers, collection(C, null, 3)], peers);
    await collectionFixture([peers[0]], peers, { includeDeletions: true });
    await collectionFixture(
      [...peers, collection(C, null, 3, 'Renamed')],
      [...peers, collection(C, null, 3)],
      {},
      (store) => {
        assert.equal(store.getPlan('collection', C)?.action, 'update');
        assert.equal(
          store.database
            .prepare('SELECT position FROM planner_collection_live WHERE id=?')
            .get(A)?.position,
          1,
        );
        assert.equal(
          store.database
            .prepare('SELECT position FROM planner_collection_live WHERE id=?')
            .get(B)?.position,
          1,
        );
      },
    );
  });

  it('diagnoses only collection collisions that cannot survive native shifts', async () => {
    for (const { source, target } of [
      {
        source: [collection(A, null, 2), collection(B, null, 2)],
        target: [collection(A), collection(B, null, 2)],
      },
      {
        source: [collection(A, null, 1, 'Renamed'), collection(B)],
        target: [collection(A), collection(B)],
      },
    ]) {
      await assert.rejects(
        collectionFixture(source, target),
        (error: unknown) =>
          error instanceof ContentError &&
          error.details?.reason === 'COLLECTION_ORDERING_CONFLICT',
      );
      await collectionFixture(
        source,
        target,
        { allowPartial: true },
        (store) => {
          assert.equal(store.getPlan('collection', A)?.action, 'skip');
          assert.equal(store.getPlan('collection', B)?.action, 'noop');
        },
      );
    }
  });

  it('rejects retained collection label collisions and transient label swaps before writes', async () => {
    const source = [collection(A, null, 1, 'Images')];
    const target = [collection(B, null, 2, 'Images')];
    const labelConflict = (error: unknown) =>
      error instanceof ContentError &&
      error.details?.reason === 'COLLECTION_LABEL_CONFLICT';
    await assert.rejects(collectionFixture(source, target), labelConflict);
    await collectionFixture(source, target, { allowPartial: true }, (store) => {
      assert.equal(store.getPlan('collection', A)?.action, 'skip');
      assert.equal(store.getPlan('collection', B)?.action, 'noop');
    });
    const swap = [
      collection(A, null, 1, 'Beta'),
      collection(B, null, 2, 'Alpha'),
    ];
    const original = [
      collection(A, null, 1, 'Alpha'),
      collection(B, null, 2, 'Beta'),
    ];
    await assert.rejects(collectionFixture(swap, original), labelConflict);
    await collectionFixture(
      swap,
      original,
      { allowPartial: true },
      (_store, metadata) => assert.equal(metadata.counts.collection.skip, 2),
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

  it('reconciles every bounded three-collection permutation with sparse targets', async () => {
    const identities = [A, B, C];
    const target = identities.map((collectionId, index) =>
      collection(collectionId, null, index + 1),
    );
    for (const first of [1, 5, 10])
      for (const second of [1, 5, 10])
        for (const third of [1, 5, 10]) {
          if (new Set([first, second, third]).size !== 3) continue;
          const source = identities.map((collectionId, index) =>
            collection(collectionId, null, [first, second, third][index]),
          );
          await collectionFixture(source, target, {}, (store) => {
            for (const state of source)
              assert.equal(
                store.database
                  .prepare(
                    'SELECT position FROM planner_collection_live WHERE id=?',
                  )
                  .get(state.id)?.position,
                state.position,
              );
          });
        }
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
                "SELECT rank FROM planner_nodes WHERE phase='collection-create' AND id=?",
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
      for (const state of source) {
        const actual = store.database
          .prepare(
            'SELECT parent_id,position FROM planner_collection_live WHERE id=?',
          )
          .get(state.id);
        assert.equal(actual?.parent_id, state.parentId);
        assert.equal(actual?.position, state.position);
      }
    });
  });

  it('closes collection skips across old and new sibling groups while retaining unrelated groups', async () => {
    const parents = [id('parent-p'), id('parent-q'), id('parent-r')];
    const unaffected = id('unaffected-collection');
    const store = new SnapshotStore();
    try {
      for (const side of ['source', 'target'] as const)
        for (const [index, parent] of parents.entries())
          store.putCollection(side, collection(parent, null, index + 1));
      for (const state of [
        collection(B, parents[0]),
        collection(C, parents[1]),
        collection(unaffected, parents[2]),
      ])
        store.putCollection('target', state);
      for (const state of [
        collection('legacy', parents[0]),
        collection(B, parents[1]),
        collection(C, parents[1], 2),
        collection(unaffected, parents[2], 1, 'Renamed'),
      ])
        store.putCollection('source', state);
      const asset = upload();
      asset.collectionId = B;
      asset.hash = hashJson(asset);
      store.putUpload('source', asset);
      const state = schema([
        model({
          fields: [
            field(),
            field({ id: BLOCK_FIELD, apiKey: 'asset', type: 'file' }),
          ],
        }),
      ]);
      store.putRecord(
        'source',
        record(A, { title: 'Dependent', asset: { upload_id: asset.id } }),
      );
      const independent = id('independent-record');
      store.putRecord(
        'source',
        record(independent, { title: 'Independent', asset: null }),
      );
      await createPlan(
        store,
        state,
        state,
        options({ uploads: 'all', allowPartial: true }),
      );
      for (const collectionId of ['legacy', B, C])
        assert.equal(store.getPlan('collection', collectionId)?.action, 'skip');
      assert.equal(store.getPlan('collection', unaffected)?.action, 'update');
      assert.equal(store.getPlan('upload', asset.id)?.action, 'skip');
      assert.equal(store.getPlan('record', A)?.action, 'skip');
      assert.equal(store.getPlan('record', independent)?.action, 'create');
    } finally {
      store.dispose();
    }
  });

  it('suppresses defaults when an update creates a new nested block', async () => {
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
    await assert.rejects(
      fixture(source, [record(A, { block: null })], state),
      unsafe,
    );
    await fixture(
      source,
      [record(A, { block: null })],
      state,
      options({ allowTemporarySchemaChanges: true }),
      (_store, metadata) =>
        assert.equal(
          metadata.temporarySchemaChanges[0].temporary.defaultValue,
          null,
        ),
    );
  });
});
