import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashJson, recordHash } from '../../src/engine/codec';
import { ContentError } from '../../src/engine/errors';
import { createPlan } from '../../src/engine/planner';
import { PlannerGraph } from '../../src/engine/planner-graph';
import {
  creationEmptyValue,
  fieldFailures,
  fieldNeedsDefaultSuppression,
} from '../../src/engine/planner-validity';
import { SnapshotStore } from '../../src/engine/store';
import type {
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
      assert.equal(graph.order('create'), 0);
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

  it('diagnoses managed unchanged schedules that the CMA cannot recreate under restored validators', async () => {
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
    await assert.rejects(
      fixture(
        [scheduled],
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

  it('handles a bounded long dependency chain without a recursive graph traversal', async () => {
    const state = schema([model({ tree: true })]);
    const records: RecordState[] = [];
    for (let index = 0; index < 1200; index++)
      records.push(
        record(
          id(`node-${index}`),
          { title: `node-${index}` },
          { parentId: index ? id(`node-${index - 1}`) : null, position: 0 },
        ),
      );
    await fixture(records, [], state, options(), (_store, metadata) =>
      assert.equal(metadata.counts.record.create, 1200),
    );
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
    const collection = (collectionId: string, parentId: string | null) => ({
      id: collectionId,
      label: collectionId,
      parentId,
      hash: hashJson({ collectionId, parentId }),
    });
    try {
      store.putCollection('target', collection(A, null));
      store.putCollection('target', collection(B, null));
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
