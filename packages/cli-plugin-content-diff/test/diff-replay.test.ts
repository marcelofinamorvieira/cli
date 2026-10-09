import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalFields,
  canonicalUpload,
  collectionHash,
  recordHash,
} from '../src/engine/codec';
import { schemaHash } from '../src/engine/schema';
import type {
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { ZipReader } from '../src/engine/zip';
import { cmaFixture } from './cma-fixture';
import { fixtureId as id } from './fixture-id';
import { content, diff, replay, run, writeTestDiff } from './pipeline';

const MODEL = 'aaaaaaaaaaaaaaaaaaaaaa';
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

function upload(
  name: string,
  bytes: string,
  overrides: Partial<UploadState> = {},
): UploadState {
  const state = canonicalUpload({
    id: id(name),
    basename: name,
    filename: `${name}.svg`,
    format: 'svg',
    md5: createHash('md5').update(bytes).digest('hex'),
    size: bytes.length,
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

function folder(
  name: string,
  position: number,
  parentId: string | null = null,
): CollectionState {
  const state = { id: id(name), label: name, parentId, position, hash: '' };
  state.hash = collectionHash(state);
  return state;
}

describe('diff replay', () => {
  it('updates one changed record with a locked patch, and leaves unchanged records out of the diff', async () => {
    const before = record('changed', { title: 'Before' });
    const after = record('changed', { title: 'After' });
    const unchanged = Array.from({ length: 40 }, (_, index) =>
      record(`unchanged-${index}`, {}),
    );
    const { plan, operations } = await replay({
      source: content({ records: [after, ...unchanged] }),
      target: content({ records: [before, ...unchanged] }),
      sourceSchema: schema(),
      options,
    });
    assert.deepEqual(operations, [
      {
        op: 'record.update',
        id: after.id,
        label: `Update Page "After" (${after.id})`,
        expect: { currentVersion: '1', publishedUpdatedAt: null },
        data: { title: 'After', meta: { current_version: '1' } },
      },
    ]);
    // The diff holds its manifest and operations, and nothing of the
    // destination it leaves unchanged.
    const directory = await mkdtemp(join(tmpdir(), 'content-replay-'));
    try {
      const zip = await ZipReader.open(
        await writeTestDiff(directory, plan, operations),
      );
      try {
        assert.deepEqual([...zip.entries.keys()].sort(), [
          'manifest.json',
          'operations/000001.jsonl',
        ]);
        for await (const { value } of zip.lines('operations'))
          assert.doesNotMatch(JSON.stringify(value), /unchanged-|Before/);
      } finally {
        zip.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps labels on one bounded line without changing payload strings or quoted keys', async () => {
    const definition = schema();
    definition.models[0]!.name =
      'Page */\nawait client.items.destroy("injected");\u2028';
    definition.models[0]!.fields.push({
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
    const { operations, fixture } = await replay({
      source: content({
        records: [record('unsafe-label', { title, details })],
      }),
      target: content({
        records: [
          record('unsafe-label', { title: `Before ${title}`, details: null }),
        ],
      }),
      sourceSchema: definition,
      options,
    });
    assert.deepEqual(
      operations.map((operation) => operation.op),
      ['record.update'],
    );
    const [{ label, data }] = operations as [(typeof operations)[number]];
    assert.ok(label.length < 600);
    assert.ok(label.startsWith('Update Page */ await client.items.destroy'));
    assert.ok(label.includes('…'));
    assert.doesNotMatch(label, /[\r\n\u2028\u2029]/);
    assert.deepEqual(data, {
      title,
      details,
      meta: { current_version: '1' },
    });
    const replayed = fixture.records.get(id('unsafe-label'))!;
    assert.equal(replayed.current.title, title);
    assert.deepEqual(replayed.current.details, details);
  });

  it('replays new circular records, publication divergence, schedules and deletion', async () => {
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
    const { fixture } = await replay({
      source: content({
        records: [
          after,
          record('left', { related: [id('right')] }),
          record('right', { related: [id('left')] }),
        ],
      }),
      target: content({ records: [before, record('deleted', {})] }),
      sourceSchema: schema(),
      options,
    });
    assert.equal(fixture.records.has(id('deleted')), false);
    assert.deepEqual(fixture.records.get(after.id)!.schedules, after.schedules);
  });

  it('publishes provisionally before completing circular published links and newer drafts', async () => {
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
    const { plan, fixture } = await replay({
      source: content({ records: [left, right] }),
      target: content(),
      sourceSchema: schema(),
      options,
    });
    assert.ok(
      [...plan.records.values()].some(
        (entry) => entry.execution?.provisionalTargets?.length,
      ),
    );
    assert.ok(
      fixture.events.filter((event) => event.startsWith('publish:')).length >=
        3,
    );
    for (const expected of [left, right]) {
      const actual = fixture.records.get(expected.id)!;
      assert.deepEqual(actual.published, expected.published);
      assert.deepEqual(actual.current, expected.current);
    }
  });

  it('writes values that violate destination validators unchanged and leaves rejection to the CMA', async () => {
    const definition = schema();
    const validators = { required: {}, unique: {}, length: { max: 4 } };
    definition.models[0]!.fields[0]!.validators = validators;
    definition.hash = schemaHash(definition);
    const holder = record('holder', { title: 'held' });
    const violations = [
      record(
        'invalid-published',
        { title: '' },
        {
          published: { title: '', related: [] },
          firstPublishedAt: '2025-02-01T00:00:00.000Z',
        },
      ),
      record('duplicate', { title: 'held' }),
      record('too-long', { title: 'longer than allowed' }),
    ];
    const { plan, operations } = await diff({
      source: content({ records: [holder, ...violations] }),
      target: content({ records: [holder] }),
      sourceSchema: definition,
      options,
    });
    assert.equal(plan.metadata.counts.record.create, 3);
    for (const entry of violations)
      assert.equal(
        (
          operations.find(
            (operation) =>
              operation.op === 'record.create' && operation.id === entry.id,
          )!.data as JsonObject
        ).title,
        entry.current.title,
      );
    const fixture = cmaFixture(content({ records: [holder] }), definition);
    const directory = await mkdtemp(join(tmpdir(), 'content-replay-'));
    try {
      await assert.rejects(
        run(fixture.client, await writeTestDiff(directory, plan, operations)),
        /publish persisted invalid record/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    assert.deepEqual(
      fixture.definition.models[0]!.fields[0]!.validators,
      validators,
    );
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
    const { fixture } = await replay({
      source: content({ records: after }),
      target: content({ records: before }),
      sourceSchema: schema(),
      options,
    });
    const schedule = /schedule-/;
    const first = fixture.events.findIndex((event) => schedule.test(event));
    assert.ok(first > 0);
    assert.deepEqual(
      fixture.events.slice(first).sort(),
      [
        `schedule-publication:${id('created')}`,
        `schedule-publication:${id('moved')}`,
        `schedule-unpublishing:${id('moved')}`,
        `unschedule-publication:${id('moved')}`,
        `unschedule-unpublishing:${id('cleared')}`,
      ].sort(),
    );
    for (const state of after)
      assert.deepEqual(
        fixture.records.get(state.id)!.schedules,
        state.schedules,
      );
  });

  it('restores ordered unchanged siblings after creation, deletion and reordering intent', async () => {
    const { fixture } = await replay({
      source: content({
        records: [
          record('a', {}, { position: 3 }),
          record('c', {}, { position: 1 }),
          record('d', {}, { position: 2 }),
        ],
      }),
      target: content({
        records: [
          record('a', {}, { position: 1 }),
          record('b', {}, { position: 2 }),
          record('c', {}, { position: 3 }),
        ],
      }),
      sourceSchema: schema(true),
      options,
    });
    assert.deepEqual(
      ['a', 'c', 'd'].map((name) => fixture.records.get(id(name))!.position),
      [3, 1, 2],
    );
  });

  it('creates, replaces, updates and deletes assets from source URLs', async () => {
    const old = '<svg>old</svg>';
    const next = '<svg>new</svg>';
    const described = upload('described', old);
    await replay({
      source: content({
        uploads: [
          upload('existing', next),
          upload('new', next),
          upload('described', old, {
            attributes: { ...described.attributes, notes: 'Described' },
          }),
        ],
      }),
      target: content({
        uploads: [upload('existing', old), described, upload('removed', old)],
      }),
      sourceSchema: schema(),
      options,
    });
  });

  it('preserves a changed Structured Text block at the fifth nesting level', async () => {
    const definition = schema();
    const blockId = id('nested-block-model');
    definition.models[0]!.fields.push({
      id: id('body'),
      apiKey: 'body',
      type: 'structured_text',
      localized: false,
      validators: { structured_text_blocks: { item_types: [blockId] } },
      defaultValue: null,
    });
    definition.models.push({
      ...definition.models[0]!,
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
    await replay({
      source: content({
        records: [record('nested-article', fields('New leaf'))],
      }),
      target: content({
        records: [record('nested-article', fields('Old leaf'))],
      }),
      sourceSchema: definition,
      options,
    });
  });

  it('reconciles folder parent moves and unchanged sibling ordering', async () => {
    await replay({
      source: content({
        collections: [
          folder('folder-a', 3),
          folder('folder-b', 1),
          folder('folder-new', 2),
          folder('child', 1, id('folder-b')),
        ],
      }),
      target: content({
        collections: [
          folder('folder-a', 1),
          folder('folder-b', 2),
          folder('child', 1, id('folder-a')),
        ],
      }),
      sourceSchema: schema(),
      options,
    });
  });
});
