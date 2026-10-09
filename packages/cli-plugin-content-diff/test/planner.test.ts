import assert from 'node:assert/strict';
import { collectionHash, hashJson, recordHash } from '../src/engine/codec';
import { ContentError } from '../src/engine/errors';
import type { Operation } from '../src/engine/operations';
import {
  COLLECTION_WRITE_PHASE,
  assertSchemaCompatible,
  creationEmptyValue,
  orderedCollectionWrites,
} from '../src/engine/planner';
import { Heap, PlannerGraph } from '../src/engine/planner-graph';
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
import { type Content, content, diff } from './pipeline';

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
type Planned = Awaited<ReturnType<typeof diff>>;
/** Plans one side against the other: records alone, or complete content. */
function fixture(
  source: RecordState[] | Partial<Content>,
  target: RecordState[] | Partial<Content>,
  state = schema(),
  opts = options(),
): Promise<Planned> {
  const side = (value: RecordState[] | Partial<Content>) =>
    content(Array.isArray(value) ? { records: value } : value);
  return diff({
    source: side(source),
    target: side(target),
    sourceSchema: state,
    options: opts,
  });
}
function collectionFixture(
  source: CollectionState[],
  target: CollectionState[],
  overrides: Partial<PlanOptions> = {},
): Promise<Planned> {
  return fixture(
    { collections: source },
    { collections: target },
    schema(),
    options({ uploads: 'all', ...overrides }),
  );
}
/** Two records of one creation cycle, in creation order. */
function creationCycle({ plan }: Planned): [RecordPlan, RecordPlan] {
  const [first, second] = [A, B]
    .map((recordId) => plan.records.get(recordId)!)
    .sort(
      (left, right) =>
        left.execution!.createOrder! - right.execution!.createOrder!,
    ) as [RecordPlan, RecordPlan];
  assert.ok(first.execution!.createOrder! < second.execution!.createOrder!);
  return [first, second];
}
/** The fields a record write sends, without its model and metadata. */
function written(operation: Operation): JsonObject {
  const { item_type: _, meta: __, ...fields } = operation.data as JsonObject;
  return fields;
}
/** The fields a new record is created with. */
function creationFields(operations: Operation[], recordId: string) {
  return written(
    operations.find(
      (operation) =>
        operation.op === 'record.create' && operation.id === recordId,
    )!,
  );
}
/** A new record's fields when it is first published. */
function firstPublished(operations: Operation[], recordId: string) {
  const fields: JsonObject = {};
  for (const operation of operations) {
    if (operation.id !== recordId) continue;
    if (operation.op === 'record.publish') return fields;
    if (operation.op === 'record.create' || operation.op === 'record.update')
      Object.assign(fields, written(operation));
  }
  assert.fail(`Record ${recordId} is never published.`);
}
const unsafe = (error: unknown) =>
  error instanceof ContentError && error.code === 'UNSAFE_REQUESTED_CHANGE';

describe('planner', () => {
  it('pops a heap in order, whatever the push order', () => {
    const values = Array.from({ length: 200 }, (_, n) => (n * 73) % 200);
    const heap = new Heap<number>((a, b) => a - b);
    for (const value of values) heap.push(value);
    assert.equal(heap.peek(), 0);
    const popped: number[] = [];
    for (let value = heap.pop(); value !== undefined; value = heap.pop())
      popped.push(value);
    assert.deepEqual(
      popped,
      [...values].sort((a, b) => a - b),
    );
  });

  it('assigns dependency levels to independent roots and chains', () => {
    const graph = new PlannerGraph();
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
      graph.ranks('create').map((entry) => [entry.id, entry.rank]),
    );
    assert.equal(levels.get(A), 0);
    assert.equal(levels.get(id('independent')), 0);
    assert.equal(levels.get(B), 1);
    assert.equal(levels.get(C), 2);
    assert.equal(levels.get(id('deep')), 3);
    graph.edge('create', 'record', A, 'record', C, 'cycle');
    assert.equal(graph.order('create'), 4);
    assert.deepEqual(
      graph.ranks('create').map((entry) => entry.id),
      [id('independent')],
    );
    // Forcing releases a member of the cycle, so every vertex still
    // receives a level and the vertex waiting on the cycle follows it.
    assert.equal(graph.order('create', true), 0);
    const forced = new Map(
      graph.ranks('create').map((entry) => [entry.id, entry.rank]),
    );
    assert.equal(forced.size, 5);
    for (const dependency of [C, id('independent')])
      assert.ok(forced.get(dependency)! < forced.get(id('deep'))!);
  });

  it('reports the edges a cycle leaves unranked until they are removed', () => {
    const [first, second, waiting] = [A, B, C].sort();
    const graph = new PlannerGraph();
    for (const recordId of [first, second, waiting])
      graph.node('publish', 'record', recordId);
    graph.edge('publish', 'record', first, 'record', second, 'publication');
    graph.edge('publish', 'record', first, 'record', second, 'parent');
    graph.edge('publish', 'record', second, 'record', first, 'publication');
    graph.edge('publish', 'record', waiting, 'record', first, 'publication');
    assert.equal(graph.order('publish'), 3);
    assert.equal(graph.done('publish', 'record', first), false);
    assert.equal(graph.done('publish', 'record', id('absent')), undefined);
    assert.deepEqual(
      [...graph.unresolvedEdges('publish')],
      [
        { ownerId: first, dependencyId: second, reason: 'publication' },
        { ownerId: first, dependencyId: second, reason: 'parent' },
        { ownerId: second, dependencyId: first, reason: 'publication' },
        { ownerId: waiting, dependencyId: first, reason: 'publication' },
      ],
    );
    graph.removeEdges(
      'publish',
      first,
      second,
      (reason) => reason === 'parent',
    );
    assert.equal(graph.order('publish'), 3);
    graph.removeEdges(
      'publish',
      first,
      second,
      (reason) => reason === 'publication',
    );
    assert.equal(graph.order('publish'), 0);
    assert.deepEqual([...graph.unresolvedEdges('publish')], []);
    assert.deepEqual(
      graph.ranks('publish').map((entry) => [entry.id, entry.rank]),
      [
        [first, 0],
        [second, 1],
        [waiting, 1],
      ],
    );
  });

  it('seeds creation fields with native empty values', () => {
    assert.deepEqual(creationEmptyValue('rich_text'), []);
    assert.deepEqual(creationEmptyValue('links'), []);
    assert.equal(creationEmptyValue('link'), null);
    assert.equal(creationEmptyValue('structured_text'), null);
  });

  it('keeps both states of changed records and neither for noops', async () => {
    const { plan, operations } = await fixture(
      [record(), record(B, { title: 'new' })],
      [record(), record(B, { title: 'old' })],
    );
    const noop = plan.records.get(A)!;
    const update = plan.records.get(B)!;
    assert.equal(noop.action, 'noop');
    assert.equal('baseline' in noop, false);
    assert.equal('desired' in noop, false);
    assert.equal(update.action, 'update');
    assert.equal(update.baseline?.title, 'old');
    assert.equal(update.desired?.title, 'new');
    assert.equal(plan.metadata.counts.record.noop, 1);
    assert.equal(plan.metadata.counts.record.update, 1);
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: B,
        label: `Update Page "new" (${B})`,
        expect: { currentVersion: '1', publishedUpdatedAt: null },
        data: { title: 'new', meta: { current_version: '1' } },
      },
    ]);
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
        const asset = upload();
        const safe: JsonObject = { asset: null, link: null };
        const lossy: JsonObject = {
          asset: {
            upload_id: asset.id,
            custom_data: { [key]: 'business value' },
          },
          link: null,
        };
        const refused = record(
          A,
          slice === 'current' ? lossy : safe,
          slice === 'published' ? { published: lossy } : {},
        );
        const source = content({
          records: [
            refused,
            record(B, { asset: null, link: A }),
            record(C, safe),
          ],
          uploads: [asset],
        });
        const target = content({ uploads: [asset] });
        await assert.rejects(
          fixture(source, target, state),
          (error: unknown) =>
            unsafe(error) &&
            (error as ContentError).details?.reason ===
              'UNSUPPORTED_PAYLOAD_KEY',
        );
        const partial = await fixture(
          source,
          target,
          state,
          options({ allowPartial: true }),
        );
        assert.equal(partial.plan.records.get(A)?.action, 'skip');
        assert.equal(partial.plan.records.get(B)?.action, 'skip');
        assert.equal(partial.plan.records.get(C)?.action, 'create');
        const { plan } = await fixture(
          source,
          { ...target, records: [refused] },
          state,
        );
        assert.equal(plan.records.get(A)?.action, 'noop');
        assert.equal(plan.records.get(B)?.action, 'create');
      }
    }
  });

  it('retains destination-only and unselected model records', async () => {
    const other = model({ id: id('other-model'), apiKey: 'other' });
    const { plan } = await diff({
      source: content(),
      target: content({
        records: [record(B, { title: 'keep' }, { modelId: other.id })],
      }),
      sourceSchema: schema(),
      targetSchema: schema([model(), other]),
      options: options({ includeDeletions: true }),
    });
    const entry = plan.records.get(B)!;
    assert.equal(entry.action, 'noop');
    assert.deepEqual(entry.diagnostics, []);
    assert.equal(plan.metadata.counts.record.delete, 0);
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
      const created = await fixture([record(sourceId)], []);
      assert.equal(created.plan.records.get(sourceId)?.action, 'create');
      const nested = await fixture(
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
      );
      assert.equal(nested.plan.records.get(A)?.action, 'create');
      const asset = await fixture(
        { uploads: [upload(sourceId)] },
        [],
        schema(),
        options({ uploads: 'all' }),
      );
      assert.equal(asset.plan.uploads.get(sourceId)?.action, 'create');
      const folder = await collectionFixture([collection(sourceId)], []);
      assert.equal(folder.plan.collections.get(sourceId)?.action, 'create');
    }
  });

  it('empties only the creation cycle link to the record created later', async () => {
    const state = schema([
      model({ fields: [field({ id: LINK, apiKey: 'link', type: 'link' })] }),
    ]);
    const planned = await fixture(
      [record(A, { link: B }), record(B, { link: A })],
      [],
      state,
    );
    const [first, second] = creationCycle(planned);
    assert.deepEqual(first.execution?.deferredFields, ['link']);
    assert.deepEqual(second.execution?.deferredFields, []);
    assert.deepEqual(creationFields(planned.operations, first.id), {
      link: null,
    });
    assert.deepEqual(creationFields(planned.operations, second.id), {
      link: first.id,
    });
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
    const { plan, operations } = await fixture(
      [
        record(A, { title: 'owner', link: B }),
        record(B, { title: 'dependency', link: C }),
        target,
      ],
      [target],
      state,
    );
    const owner = plan.records.get(A)!;
    const dependency = plan.records.get(B)!;
    assert.deepEqual(owner.execution?.deferredFields, []);
    assert.deepEqual(dependency.execution?.deferredFields, []);
    assert.deepEqual(creationFields(operations, A), {
      title: 'owner',
      link: B,
    });
    assert.deepEqual(creationFields(operations, B), {
      title: 'dependency',
      link: C,
    });
    assert.ok(
      dependency.execution!.createOrder! < owner.execution!.createOrder!,
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
    const { plan, operations } = await fixture(
      [
        record(A, { link: B }),
        record(B, { link: A }),
        record(C, { link: A }, { modelId: required.id }),
      ],
      [],
      schema([optional, required]),
      options({ modelIds: [MODEL, required.id] }),
    );
    const dependant = plan.records.get(C)!;
    const seed = plan.records.get(A)!;
    assert.deepEqual(dependant.execution?.deferredFields, []);
    assert.deepEqual(creationFields(operations, C), { link: A });
    assert.ok(seed.execution!.createOrder! < dependant.execution!.createOrder!);
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
    const { plan, operations } = await fixture(source, target, state, opts);
    const owner = plan.records.get(A)!;
    const dependency = plan.records.get(B)!;
    assert.deepEqual(owner.execution?.deferredFields, ['link']);
    assert.deepEqual(creationFields(operations, A), { link: null });
    assert.ok(
      dependency.execution!.publishOrder! < owner.execution!.publishOrder!,
    );
    // A required link is seeded the same way; the CMA judges the write.
    automatic.fields[0].validators.required = {};
    const required = await fixture(source, target, state, opts);
    assert.deepEqual(required.plan.records.get(A)!.execution?.deferredFields, [
      'link',
    ]);
    assert.deepEqual(creationFields(required.operations, A), { link: null });
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
    const planned = await fixture(source, [], state);
    const [first, second] = creationCycle(planned);
    assert.deepEqual(creationFields(planned.operations, first.id), {
      link: null,
    });
    assert.deepEqual(creationFields(planned.operations, second.id), {
      link: first.id,
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
    const planned = await fixture(source, [], state);
    const [first] = creationCycle(planned);
    const title = first.id === A ? 'a' : 'b';
    assert.deepEqual(first.execution?.deferredFields, ['link']);
    assert.deepEqual(creationFields(planned.operations, first.id), {
      title: { en: title, it: title },
      link: { en: null, it: null },
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
    const planned = await fixture(source, [], state);
    const [first, second] = creationCycle(planned);
    const seed = creationFields(planned.operations, first.id);
    assert.deepEqual(seed.link, { en: null });
    assert.deepEqual(seed.blocks, { en: [] });
    assert.deepEqual(second.execution?.deferredFields, []);
    assert.deepEqual(creationFields(planned.operations, second.id).link, {
      en: first.id,
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
    const sized = await fixture(source, [], constrained);
    assert.deepEqual(
      creationFields(sized.operations, creationCycle(sized)[0].id).blocks,
      { en: [] },
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
    const planned = await fixture([scheduled], [], state);
    assert.equal(planned.plan.metadata.counts.record.create, 1);
    const elsewhere = await fixture(
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
    );
    assert.equal(elsewhere.plan.metadata.counts.record.create, 1);
    const nonnative = {
      ...schema([model({ fields: [field({ validators: { required: {} } })] })]),
      semantics: { improved_validation_at_publishing: true },
    };
    const improved = await fixture(
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
    );
    assert.equal(improved.plan.metadata.counts.record.create, 1);
  });

  it('plans writes around scheduled unchanged records that the SDK cannot write back', async () => {
    const state = schema([
      model({
        fields: [field({ apiKey: 'asset', type: 'file' })],
      }),
    ]);
    for (const write of ['none', 'record', 'upload', 'collection']) {
      const asset = upload();
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
      const source = content({ records: [scheduled], uploads: [asset] });
      if (write === 'record') source.records.push(record(B, { asset: null }));
      if (write === 'upload') {
        const changed = { ...asset, filename: 'renamed.png', hash: '' };
        changed.hash = hashJson(changed);
        source.uploads = [changed];
      }
      if (write === 'collection') {
        const created = {
          id: id('new-collection'),
          label: 'New',
          parentId: null,
          position: 1,
          hash: '',
        };
        created.hash = hashJson(created);
        source.collections.push(created);
      }
      // The unchanged record is never rewritten, so it does not block writes.
      const { plan } = await fixture(
        source,
        { records: [scheduled], uploads: [asset] },
        state,
        options({ allowPartial: true, uploads: 'all' }),
      );
      assert.equal(plan.metadata.counts.record.noop, 1);
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
    const created = await fixture(source, [], state);
    assert.equal(created.plan.metadata.counts.record.create, 5);
    const { plan } = await fixture(
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
    );
    assert.equal(plan.metadata.counts.record.update, 5);
    assert.equal(plan.metadata.counts.record.noop, 1);
    for (const entry of plan.records.values())
      if (entry.action === 'update') assert.deepEqual(entry.diagnostics, []);
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
    const { plan } = await fixture(
      [linked(A, B, 0), linked(B, A, 1)],
      [record(C, { title: 'old' }, { position: 0 })],
      state,
      options({ includeDeletions: true }),
    );
    assert.equal(plan.metadata.counts.record.create, 2);
    assert.equal(plan.metadata.counts.record.delete, 1);
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
    const { plan, operations } = await fixture(
      [linked(A, B), linked(B, A)],
      [],
      state,
    );
    assert.equal(plan.metadata.counts.record.create, 2);
    const [first, second] = [A, B]
      .map((recordId) => plan.records.get(recordId)!)
      .sort((left, right) =>
        left.execution?.provisionalTargets
          ? -1
          : right.execution?.provisionalTargets
            ? 1
            : 0,
      );
    // One record publishes without its cycle link, the other can then
    // publish, and apply republishes the first one with the link.
    assert.deepEqual([first.diagnostics, second.diagnostics], [[], []]);
    assert.deepEqual(first.execution?.provisionalTargets, [second.id]);
    assert.deepEqual(firstPublished(operations, first.id), { link: null });
    assert.equal(first.execution?.publishOrder, 0);
    assert.equal(second.execution?.provisionalTargets, undefined);
    assert.equal(second.execution?.publishOrder, 1);
    assert.deepEqual(
      operations
        .filter((operation) => operation.op === 'record.publish')
        .map((operation) => operation.id),
      [first.id, second.id, first.id],
    );
    const restore = operations.find((operation) =>
      operation.label.startsWith('Restore the links left out'),
    );
    assert.equal(restore?.id, first.id);
    assert.deepEqual(restore?.data, { link: second.id });
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
    const next = new Map([
      [A, B],
      [B, C],
      [C, A],
    ]);
    const { plan, operations } = await fixture(
      [...[...next].map(([owner, link]) => linked(owner, [link, X])), existing],
      [existing],
      state,
    );
    const entries = [A, B, C].map((recordId) => plan.records.get(recordId)!);
    const provisional = entries.filter(
      (entry) => entry.execution?.provisionalTargets,
    );
    assert.equal(provisional.length, 1);
    const [entry] = provisional;
    assert.deepEqual(entry.execution!.provisionalTargets, [next.get(entry.id)]);
    assert.deepEqual(firstPublished(operations, entry.id), { links: [X] });
    assert.deepEqual(
      entries.map((candidate) => candidate.diagnostics),
      [[], [], []],
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
    const { plan, operations } = await fixture(source, [], state);
    assert.equal(plan.metadata.counts.record.create, 2);
    assert.deepEqual(
      [A, B]
        .filter(
          (recordId) =>
            plan.records.get(recordId)!.execution?.provisionalTargets,
        )
        .map((recordId) => firstPublished(operations, recordId)),
      [{ link: null }],
    );
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
      fixture(source, [], state),
      (error: unknown) =>
        unsafe(error) &&
        (error as ContentError).details?.reason === 'PUBLICATION_CYCLE',
    );
    const { plan, operations } = await fixture(
      source,
      [],
      state,
      options({ allowPartial: true }),
    );
    assert.equal(plan.metadata.counts.record.skip, 2);
    assert.deepEqual(operations, []);
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
      const { plan, operations } = await fixture(source, [], state);
      assert.equal(plan.metadata.counts.record.create, 2);
      assert.equal(plan.metadata.counts.record.skip, 0);
      const owner = plan.records.get(linking)!;
      const other = plan.records.get(linked)!;
      assert.deepEqual(owner.execution?.provisionalTargets, [linked]);
      assert.deepEqual(firstPublished(operations, linking), {
        link: null,
        body: null,
      });
      assert.equal(other.execution?.provisionalTargets, undefined);
      assert.ok(
        owner.execution!.publishOrder! < other.execution!.publishOrder!,
      );
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
    // The record created second links to the first one, which its create
    // has already published.
    const automated = await fixture(
      [linked(A, B, automatic.id), linked(B, A, automatic.id)],
      [],
      state,
      opts,
    );
    const [first, second] = creationCycle(automated);
    for (const entry of [first, second]) {
      assert.equal(entry.action, 'create');
      assert.deepEqual(entry.diagnostics, []);
      assert.equal(entry.execution?.publishOrder, 0);
    }
    assert.deepEqual(creationFields(automated.operations, first.id), {
      link: null,
    });
    assert.deepEqual(creationFields(automated.operations, second.id), {
      link: first.id,
    });
    // A new draft is published only in the publication phase, so the record
    // linking back to it still writes that link afterwards.
    const { plan, operations } = await fixture(
      [linked(A, B, MODEL), linked(B, A, automatic.id)],
      [],
      state,
      opts,
    );
    const draft = plan.records.get(A)!;
    const owner = plan.records.get(B)!;
    for (const entry of [draft, owner]) {
      assert.equal(entry.action, 'create');
      assert.deepEqual(entry.diagnostics, []);
    }
    assert.deepEqual(owner.execution?.deferredFields, ['link']);
    assert.deepEqual(creationFields(operations, B), { link: null });
    assert.ok(draft.execution!.publishOrder! < owner.execution!.publishOrder!);
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
        const { plan, operations } = await fixture([published], target, state);
        const entry = plan.records.get(A)!;
        assert.equal(entry.execution?.publishOrder, 0);
        if (target.length === 0) {
          assert.deepEqual(entry.execution?.deferredFields, ['body']);
          assert.deepEqual(creationFields(operations, A), {
            body: creationEmptyValue(type),
          });
        }
      }
      const unpublished = await fixture([draft], [published], state);
      assert.equal(unpublished.plan.records.get(A)!.execution?.publishOrder, 0);
      const deleted = await fixture(
        [],
        [published],
        state,
        options({ includeDeletions: true }),
      );
      assert.equal(deleted.plan.records.get(A)!.execution?.deleteOrder, 0);
    }
  });

  it('orders deletion cycles and self-parented trees deterministically for the CMA to judge', async () => {
    const state = schema([
      model({ fields: [field({ apiKey: 'link', type: 'link' })] }),
    ]);
    const cycle = await fixture(
      [],
      [record(A, { link: B }), record(B, { link: A })],
      state,
      options({ includeDeletions: true }),
    );
    assert.equal(cycle.plan.metadata.counts.record.delete, 2);
    const orders = [A, B].map(
      (recordId) => cycle.plan.records.get(recordId)!.execution?.deleteOrder,
    );
    assert.equal(new Set(orders).size, 2);
    const tree = schema([model({ tree: true })]);
    const created = await fixture(
      [record(A, { title: 'self' }, { parentId: A, position: 0 })],
      [],
      tree,
    );
    assert.equal(
      typeof created.plan.records.get(A)!.execution?.createOrder,
      'number',
    );
    const deleted = await fixture(
      [],
      [record(A, { title: 'self' }, { parentId: A, position: 0 })],
      tree,
      options({ includeDeletions: true }),
    );
    assert.equal(deleted.plan.metadata.counts.record.delete, 1);
  });

  it('deletes a record that only waits on a deletion cycle after that cycle', async () => {
    // The waiting record sorts first, so releasing the lowest blocked vertex
    // would delete it while a cycle member still references it.
    const [target, first, second] = [A, B, C].sort();
    const state = schema([
      model({ fields: [field({ apiKey: 'links', type: 'links' })] }),
    ]);
    const { plan } = await fixture(
      [],
      [
        record(first!, { links: [second!, target!] }),
        record(second!, { links: [first!] }),
        record(target!, { links: [] }),
      ],
      state,
      options({ includeDeletions: true }),
    );
    const order = (recordId: string) =>
      plan.records.get(recordId)!.execution!.deleteOrder!;
    assert.notEqual(order(first!), order(second!));
    assert.ok(order(target!) > order(first!));
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
    ] as const) {
      const { plan } = await fixture(
        [record(A, fields as JsonObject)],
        [],
        state,
      );
      assert.equal(plan.metadata.counts.record.create, 1);
    }
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
    const moved = await fixture(
      [
        record(A, { block: null, blocks: [] }),
        record(B, { block, blocks: [block, block] }),
      ],
      [
        record(A, { block, blocks: [] }, { published: { block, blocks: [] } }),
        record(B, { block: null, blocks: [] }),
      ],
      state,
    );
    assert.equal(moved.plan.metadata.counts.record.update, 2);
    const { plan } = await fixture(
      [record(A)],
      [record(B)],
      schema([model({ singleton: true })]),
      options({ includeDeletions: true }),
    );
    assert.equal(plan.records.get(A)?.action, 'create');
    assert.equal(plan.records.get(B)?.action, 'delete');
  });

  it('deletes an upload still referenced by a retained record and leaves the reference to the CMA', async () => {
    const other = model({
      id: id('other-model'),
      fields: [field({ apiKey: 'file', type: 'file' })],
    });
    const asset = upload();
    const { plan } = await fixture(
      [],
      {
        records: [
          record(B, { file: { upload_id: asset.id } }, { modelId: other.id }),
        ],
        uploads: [asset],
      },
      schema([model(), other]),
      options({ uploads: 'all', includeDeletions: true }),
    );
    assert.equal(plan.uploads.get(asset.id)?.action, 'delete');
    assert.equal(plan.metadata.counts.record.noop, 1);
  });

  it('orders tree creates and linked deletes iteratively', async () => {
    const state = schema([
      model({
        tree: true,
        fields: [field(), field({ id: LINK, apiKey: 'link', type: 'link' })],
      }),
    ]);
    const created = await fixture(
      [
        record(A, { title: 'parent' }, { position: 0 }),
        record(B, { title: 'child' }, { parentId: A, position: 0 }),
      ],
      [],
      state,
    );
    const parent = created.plan.records.get(A)!;
    const child = created.plan.records.get(B)!;
    assert.ok(parent.execution!.createOrder! < child.execution!.createOrder!);
    const deleted = await fixture(
      [],
      [record(A, { title: 'owner', link: B }), record(B)],
      state,
      options({ includeDeletions: true }),
    );
    const owner = deleted.plan.records.get(A)!;
    const dependency = deleted.plan.records.get(B)!;
    assert.ok(
      owner.execution!.deleteOrder! < dependency.execution!.deleteOrder!,
    );
  });

  it('moves tree records after every moved ancestor on their desired path', async () => {
    const state = schema([model({ tree: true })]);
    const node = (recordId: string, parentId: string | null) =>
      record(recordId, { title: 'node' }, { parentId, position: 0 });
    const order = ({ plan }: Planned, recordId: string) =>
      plan.records.get(recordId)!.execution!.publishOrder!;
    const clean = ({ plan }: Planned) => {
      for (const entry of plan.records.values())
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
      const planned = await fixture(
        [node(ancestor, null), unchanged, node(moved, C)],
        [node(moved, null), node(ancestor, moved), unchanged],
        state,
      );
      assert.equal(planned.plan.metadata.counts.record.update, 2);
      assert.equal(planned.plan.metadata.counts.record.noop, 1);
      assert.ok(order(planned, ancestor) < order(planned, moved));
      clean(planned);
    }
    // X > P > U > Q > V becomes Q > V > P > U > X with U and V unchanged.
    // Each move waits for the nearest moved ancestor, which waits for its own.
    const [x, p, u, q, v] = ['x', 'p', 'u', 'q', 'v'].map(id);
    const chain = await fixture(
      [node(q, null), node(v, q), node(p, v), node(u, p), node(x, u)],
      [node(x, null), node(p, x), node(u, p), node(q, u), node(v, q)],
      state,
    );
    assert.equal(chain.plan.metadata.counts.record.update, 3);
    assert.ok(order(chain, q) < order(chain, p));
    assert.ok(order(chain, p) < order(chain, x));
    clean(chain);
    // An ordinary leaf move has no moved ancestor to wait for.
    const leaf = await fixture(
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
    );
    assert.equal(leaf.plan.metadata.counts.record.update, 1);
    assert.equal(order(leaf, C), 0);
    clean(leaf);
  });

  it('plans a 6000-record dependency chain without a recursive graph traversal', async () => {
    const state = schema([model({ tree: true })]);
    const records = Array.from({ length: 6000 }, (_, index) =>
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
    const { plan, operations } = await fixture(records, [], state);
    assert.equal(plan.metadata.counts.record.create, 6000);
    let checked = 0;
    for (const entry of plan.records.values()) {
      const depth = Number(entry.desired!.title!.slice(5));
      assert.equal(entry.execution?.createOrder, depth);
      assert.equal(entry.execution?.publishOrder, depth);
      checked++;
    }
    assert.equal(checked, 6000);
    // Each record is created, and then published, after its parent.
    for (const op of ['record.create', 'record.publish'])
      assert.deepEqual(
        operations
          .filter((operation) => operation.op === op)
          .map((operation) => operation.id),
        records.map((entry) => entry.id),
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
    const { plan } = await fixture(source, target, state);
    assert.equal(plan.metadata.counts.record.update, 2);
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
    const { plan } = await fixture(
      [record(A, { title: 'new' })],
      target,
      state,
    );
    const entry = plan.records.get(A)!;
    assert.equal(entry.action, 'update');
    assert.deepEqual(entry.diagnostics, []);
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
      const { plan } = await fixture(
        [
          record(A, { title: 'owner', link: null }, { published }),
          record(B, { title: 'dependency', link: null }),
        ],
        target,
        state,
      );
      const owner = plan.records.get(A)!;
      const dependency = plan.records.get(B)!;
      assert.ok(
        owner.execution!.publishOrder! < dependency.execution!.publishOrder!,
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
    const { plan } = await fixture(
      source,
      target,
      state,
      options({ includeDeletions: true }),
    );
    assert.equal(plan.records.get(A)?.action, 'delete');
    assert.equal(plan.records.get(B)?.action, 'update');
  });

  it('plans no update when only ordering differs', async () => {
    const state = schema([model({ sortable: true })]);
    const { plan, operations } = await fixture(
      [
        record(A, { title: 'same' }, { position: 0 }),
        record(B, { title: 'same' }, { position: 1 }),
      ],
      [
        record(A, { title: 'same' }, { position: 1 }),
        record(B, { title: 'same' }, { position: 0 }),
      ],
      state,
    );
    assert.equal(plan.metadata.counts.record.update, 0);
    assert.equal(plan.records.get(A)?.action, 'noop');
    // The group is ordered by one reorder instead.
    assert.deepEqual(
      operations.map((operation) => [operation.op, operation.data]),
      [['records.reorder', { model: MODEL, parent: null, order: [A, B] }]],
    );
  });

  it('plans no update when a requested position coincides with a retained one', async () => {
    const state = schema([model({ sortable: true })]);
    const { plan } = await fixture(
      [record(A, { title: 'same' }, { position: 0 })],
      [
        record(A, { title: 'same' }, { position: 1 }),
        record(B, { title: 'keep' }, { position: 0 }),
      ],
      state,
    );
    assert.equal(plan.records.get(A)?.action, 'noop');
  });

  it('skips a refused record without closing over its ordered model', async () => {
    const state = schema([model({ sortable: true })]);
    const lossy = { title: { __itemTypeId: 'business value' } };
    const { plan } = await fixture(
      [
        record(A, lossy, { position: 0 }),
        record(B, { title: 'sibling' }, { position: 1 }),
      ],
      [],
      state,
      options({ allowPartial: true }),
    );
    assert.equal(plan.records.get(A)?.action, 'skip');
    assert.equal(plan.records.get(B)?.action, 'create');
    assert.equal(plan.metadata.counts.record.skip, 1);
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
    const { plan } = await fixture(
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
    );
    const action = (recordId: string) => plan.records.get(recordId)?.action;
    assert.equal(action(A), 'skip');
    assert.equal(action(B), 'skip');
    assert.equal(action(C), 'skip');
    assert.equal(action(X), 'skip');
    assert.equal(action(Y), 'update');
    assert.equal(action(id('d')), 'skip');
    assert.equal(action(id('e')), 'delete');
    assert.deepEqual(
      plan.records.get(id('d'))?.diagnostics.map((item) => item.code),
      ['PRESERVED_SKIP_DEPENDENCY'],
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
    const { plan } = await fixture(
      [record(X, { title: { __itemTypeId: 'business value' }, file: null })],
      {
        records: [record(X, { title: 'old', file: { upload_id: kept.id } })],
        uploads: [kept, unrelated],
        collections: [folder],
      },
      state,
      options({ allowPartial: true, includeDeletions: true, uploads: 'all' }),
    );
    assert.equal(plan.records.get(X)?.action, 'skip');
    for (const entry of [
      plan.uploads.get(kept.id),
      plan.collections.get(folder.id),
    ]) {
      assert.equal(entry?.action, 'skip');
      assert.deepEqual(
        entry?.diagnostics.map((item) => item.code),
        ['PRESERVED_SKIP_DEPENDENCY'],
      );
    }
    assert.equal(plan.uploads.get(unrelated.id)?.action, 'delete');
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
    const { plan } = await fixture(
      [linked(A, B, false), linked(B, A, false)],
      [linked(A, B, true), linked(B, A, true)],
      state,
    );
    const orders = [A, B].map((recordId) => {
      const entry = plan.records.get(recordId)!;
      assert.equal(entry.action, 'update');
      assert.deepEqual(entry.diagnostics, []);
      return entry.execution!.publishOrder;
    });
    assert.notEqual(orders[0], orders[1]);
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
    const { plan } = await fixture(
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
    );
    const order = (recordId: string) => {
      const entry = plan.records.get(recordId)!;
      assert.deepEqual(entry.diagnostics, []);
      return entry.execution!.publishOrder!;
    };
    assert.notEqual(order(first!), order(second!));
    assert.ok(order(target!) > order(first!));
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
    const { plan } = await fixture(
      [node(A, null, false), node(B, A, false)],
      [node(A, null, true), node(B, A, true)],
      state,
    );
    const parent = plan.records.get(A)!;
    const child = plan.records.get(B)!;
    assert.deepEqual([...parent.diagnostics, ...child.diagnostics], []);
    assert.ok(child.execution!.publishOrder! < parent.execution!.publishOrder!);
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
    const { plan } = await fixture(
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
    );
    const parent = plan.records.get(A)!;
    const created = plan.records.get(B)!;
    assert.equal(parent.action, 'update');
    assert.equal(created.action, 'create');
    assert.deepEqual([...parent.diagnostics, ...created.diagnostics], []);
    assert.equal(parent.execution?.provisionalTargets, undefined);
    assert.equal(created.execution?.provisionalTargets, undefined);
    assert.ok(
      created.execution!.publishOrder! < parent.execution!.publishOrder!,
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
    for (const target of [[], [parent(false), child(false)]]) {
      const { plan } = await fixture(
        [parent(true), child(true)],
        target,
        state,
      );
      const parentPlan = plan.records.get(A)!;
      const childPlan = plan.records.get(B)!;
      assert.deepEqual(
        [...parentPlan.diagnostics, ...childPlan.diagnostics],
        [],
      );
      assert.ok(
        childPlan.execution!.publishOrder! <
          parentPlan.execution!.publishOrder!,
      );
    }
  });

  it('orders a folder parent swap deterministically for the CMA to judge', async () => {
    const { plan } = await collectionFixture(
      [collection(A, B), collection(B, A)],
      [collection(A, null), collection(B, null, 2)],
    );
    assert.equal(plan.metadata.counts.collection.update, 2);
    assert.equal(orderedCollectionWrites(plan).length, 2);
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
    for (const { source, target } of cases) {
      const { plan } = await collectionFixture(source, target);
      assert(plan.metadata.counts.collection.update > 0);
      for (const state of source) {
        const previous = target.find((entry) => entry.id === state.id)!;
        const entry = plan.collections.get(state.id)!;
        assert.equal(
          entry.action,
          previous.hash === state.hash ? 'noop' : 'update',
        );
        if (entry.action === 'update') assert.deepEqual(entry.desired, state);
      }
    }
  });

  it('plans duplicate folder positions', async () => {
    const peers = [collection(A), collection(B)];
    await collectionFixture(peers, peers);
    const created = await collectionFixture(peers, []);
    assert.equal(created.plan.metadata.counts.collection.create, 2);
    await collectionFixture([...peers, collection(C, null, 3)], peers);
    await collectionFixture([peers[0]], peers, { includeDeletions: true });
    const renamed = await collectionFixture(
      [...peers, collection(C, null, 3, 'Renamed')],
      [...peers, collection(C, null, 3)],
    );
    assert.equal(renamed.plan.collections.get(C)?.action, 'update');
  });

  it('plans folder label collisions and label swaps for the CMA to judge', async () => {
    const collision = await collectionFixture(
      [collection(A, null, 1, 'Images')],
      [collection(B, null, 2, 'Images')],
    );
    assert.equal(collision.plan.collections.get(A)?.action, 'create');
    const swap = await collectionFixture(
      [collection(A, null, 1, 'Beta'), collection(B, null, 2, 'Alpha')],
      [collection(A, null, 1, 'Alpha'), collection(B, null, 2, 'Beta')],
    );
    assert.equal(swap.plan.metadata.counts.collection.update, 2);
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
    const { plan } = await collectionFixture(
      [collection(A, B), collection(B)],
      [collection(A), collection(B, A)],
    );
    const rank = new Map(
      plan.graph
        .ranks(COLLECTION_WRITE_PHASE)
        .map((entry) => [entry.id, entry.rank]),
    );
    assert(rank.get(B)! < rank.get(A)!);
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
    const { plan } = await collectionFixture(source, target);
    assert.deepEqual(
      orderedCollectionWrites(plan).map((entry) => entry.id),
      [middle, outer],
    );
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
    const { plan } = await fixture(source, [record(A, { block: null })], state);
    assert.equal(plan.metadata.counts.record.update, 1);
  });
});
