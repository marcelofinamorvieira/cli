import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { buildBlockRecord } from '@datocms/cma-client';
import { deserializeJsonEntity } from '@datocms/rest-client-utils';
import {
  captureSnapshot,
  readRecordBatch,
  readSchedules,
} from '../../src/engine/capture';
import {
  canonicalCollection,
  canonicalFields,
  canonicalRecord,
  canonicalUpload,
  hashJson,
  inspectRecord,
  recordGuard,
  recordPayloadFields,
} from '../../src/engine/codec';
import { ContentError } from '../../src/engine/errors';
import {
  assertFullReadAccess,
  assertSchemaEditAccess,
  fetchSchema,
} from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  Client,
  FieldSchema,
  JsonObject,
  ModelSchema,
  SchemaState,
} from '../../src/engine/types';

const identity = (name: string) =>
  createHash('sha256').update(name).digest('base64url').slice(0, 22);
const MODEL = identity('model');
const BLOCK = identity('block');
const NESTED = identity('nested');
const RECORD = identity('record');
const LINKED = identity('linked');
const ASSET = identity('asset');
const DATE = '2020-01-01T00:00:00.000Z';
const FUTURE = '2090-01-01T12:30:00.000Z';

function field(
  apiKey: string,
  type = 'string',
  validators: JsonObject = {},
): FieldSchema {
  return {
    id: identity(apiKey),
    apiKey,
    type,
    localized: false,
    validators,
    defaultValue: null,
  };
}
function model(
  id = MODEL,
  fields = [field('title')],
  block = false,
): ModelSchema {
  return {
    id,
    apiKey: id,
    name: id,
    block,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: true,
    saveInvalidDrafts: true,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}
function state(models = [model()]): SchemaState {
  return {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en', 'it'],
    semantics: {},
    models,
    workflows: [],
    hash: '',
  };
}
function rawRecord(
  id = RECORD,
  fields: JsonObject = { title: 'record' },
  published = false,
  modelId = MODEL,
): Record<string, unknown> {
  return {
    id,
    type: 'item',
    attributes: fields,
    relationships: { item_type: { data: { id: modelId, type: 'item_type' } } },
    meta: {
      current_version: 'v1',
      created_at: DATE,
      updated_at: DATE,
      first_published_at: published ? DATE : null,
      published_at: published ? DATE : null,
      is_current_version_valid: true,
      is_published_version_valid: published ? true : null,
      publication_scheduled_at: null,
      unpublishing_scheduled_at: null,
      stage: null,
    },
  };
}
function response(
  rows: unknown[],
  total = rows.length,
): Record<string, unknown> {
  return { data: rows, meta: { total_count: total } };
}
function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof ContentError && error.code === code;
}

type ListArgs = {
  filter: { type?: string; ids?: string };
  nested: boolean;
  version: 'current' | 'published';
  page: { offset?: number; limit: number };
};
function mockClient(
  models = [model()],
  records: Record<string, unknown>[] = [],
  published: Record<string, unknown>[] = [],
) {
  const calls: ListArgs[] = [];
  const schemaFlags = {
    improved_timezone_management: true,
    improved_boolean_fields: true,
    improved_validation_at_publishing: true,
    milliseconds_in_datetime: true,
    non_localized_focal_points: true,
    improved_hex_management: true,
  };
  const mock = {
    site: {
      find: async () => ({
        id: 'site',
        timezone: 'UTC',
        locales: ['en', 'it'],
        meta: schemaFlags,
      }),
    },
    itemTypes: {
      list: async () =>
        models.map((entry) => ({
          id: entry.id,
          api_key: entry.apiKey,
          name: entry.name,
          modular_block: entry.block,
          singleton: entry.singleton,
          sortable: entry.sortable,
          tree: entry.tree,
          draft_mode_active: entry.draftMode,
          draft_saving_active: entry.saveInvalidDrafts,
          all_locales_required: entry.allLocalesRequired,
          workflow: null,
        })),
    },
    fields: {
      list: async (modelId: string) =>
        models
          .find((entry) => entry.id === modelId)!
          .fields.map((entry) => ({
            id: entry.id,
            api_key: entry.apiKey,
            field_type: entry.type,
            localized: entry.localized,
            validators: entry.validators,
            default_value: entry.defaultValue,
          })),
    },
    workflows: { list: async () => [] },
    users: {
      findMe: async () => ({ type: 'access_token', hardcoded_type: 'admin' }),
    },
    roles: { find: async () => ({}) },
    items: {
      rawList: async (args: ListArgs) => {
        calls.push(structuredClone(args));
        const data = args.version === 'current' ? records : published;
        const wanted = args.filter.ids
          ? new Set(args.filter.ids.split(','))
          : null;
        const filtered = data.filter((record) =>
          wanted
            ? wanted.has(String(record.id))
            : (record.relationships as { item_type: { data: { id: string } } })
                .item_type.data.id === args.filter.type,
        );
        const offset = args.page.offset ?? 0;
        return response(
          filtered.slice(offset, offset + args.page.limit),
          filtered.length,
        );
      },
      rawCurrentVsPublishedState: async (_id: string) => {
        throw new Error('No schedules expected.');
      },
    },
    uploads: { rawList: async () => response([]) },
    uploadCollections: { list: async () => [] },
  };
  return { mock, client: mock as unknown as Client, calls };
}

describe('expanded capture and native payload codec', () => {
  it('canonicalizes native and simple records including both independently expanded slices', () => {
    const schema = state([
      model(MODEL, [field('title'), field('blocks', 'rich_text')]),
      model(BLOCK, [field('body')], true),
    ]);
    const nativeBlock = buildBlockRecord({
      id: NESTED,
      item_type: { id: BLOCK, type: 'item_type' },
      body: 'current block',
    });
    const current = rawRecord(
      RECORD,
      { title: 'current', blocks: [nativeBlock as unknown as JsonObject] },
      true,
    );
    const published = rawRecord(
      RECORD,
      {
        title: 'published',
        blocks: [
          {
            ...nativeBlock,
            attributes: { body: 'published block' },
          } as unknown as JsonObject,
        ],
      },
      true,
    );
    const native = canonicalRecord(current, published, schema);
    const simple = canonicalRecord(
      deserializeJsonEntity(current),
      deserializeJsonEntity(published),
      schema,
    );
    assert.deepEqual(native, simple);
    assert.deepEqual(native.current.blocks, [
      {
        id: NESTED,
        __itemTypeId: BLOCK,
        attributes: { body: 'current block' },
      },
    ]);
    assert.deepEqual(native.published?.blocks, [
      {
        id: NESTED,
        __itemTypeId: BLOCK,
        attributes: { body: 'published block' },
      },
    ]);
    const payload = recordPayloadFields(native.current, MODEL, schema);
    const wireBlock = structuredClone(nativeBlock);
    Reflect.deleteProperty(wireBlock, '__itemTypeId');
    assert.deepEqual(payload.blocks, [wireBlock]);
    assert.deepEqual(canonicalFields(payload, MODEL, schema), native.current);
    const validation = recordPayloadFields(native.current, MODEL, schema, {
      validation: true,
    });
    assert.equal('id' in (validation.blocks as JsonObject[])[0], false);
    assert.deepEqual((validation.blocks as JsonObject[])[0].relationships, {
      item_type: { data: { id: BLOCK, type: 'item_type' } },
    });
  });

  it('walks DAST block/inlineBlock/item links but preserves opaque JSON with the same keys', () => {
    const schema = state([
      model(MODEL, [
        field('content', 'structured_text'),
        field('opaque', 'json'),
      ]),
      model(BLOCK, [field('file', 'file'), field('related', 'link')], true),
    ]);
    const block = buildBlockRecord({
      id: NESTED,
      item_type: { id: BLOCK, type: 'item_type' },
      file: { upload_id: ASSET },
      related: LINKED,
    });
    const inline = buildBlockRecord({
      id: identity('inline'),
      item_type: { id: BLOCK, type: 'item_type' },
      file: { upload_id: ASSET },
      related: LINKED,
    });
    const opaque = {
      id: 'opaque',
      __itemTypeId: 'opaque-model',
      attributes: { related: 'opaque-target' },
      type: 'block',
      item: 'leave-me',
    };
    const fields: JsonObject = {
      content: {
        schema: 'dast',
        document: {
          type: 'root',
          children: [
            { type: 'block', item: block as unknown as JsonObject },
            {
              type: 'paragraph',
              children: [
                { type: 'inlineBlock', item: inline as unknown as JsonObject },
                { type: 'inlineItem', item: LINKED },
                {
                  type: 'itemLink',
                  item: LINKED,
                  children: [{ type: 'span', value: 'link' }],
                },
              ],
            },
          ],
        },
      },
      opaque,
    };
    const record = canonicalRecord(rawRecord(RECORD, fields), null, schema);
    assert.deepEqual(record.current.opaque, opaque);
    const inspected = inspectRecord(record, schema);
    assert.equal(inspected.blockOwners.length, 2);
    assert.deepEqual(
      [
        ...new Set(
          inspected.references
            .filter((ref) => ref.kind === 'current')
            .map((ref) => ref.targetId),
        ),
      ],
      [LINKED],
    );
    assert.deepEqual(
      [
        ...new Set(
          inspected.references
            .filter((ref) => ref.kind === 'upload')
            .map((ref) => ref.targetId),
        ),
      ],
      [ASSET],
    );
    const payload = recordPayloadFields(record.current, MODEL, schema);
    assert.deepEqual(payload.opaque, opaque);
    assert.deepEqual(canonicalFields(payload, MODEL, schema), record.current);
  });

  it('rejects unexpanded or unidentified blocks', () => {
    const schema = state([
      model(MODEL, [field('blocks', 'rich_text')]),
      model(BLOCK, [], true),
    ]);
    assert.throws(
      () => canonicalFields({ blocks: [NESTED] }, MODEL, schema),
      errorCode('INVALID_BLOCK'),
    );
    assert.throws(
      () =>
        canonicalFields(
          { blocks: [{ id: NESTED, attributes: {} }] },
          MODEL,
          schema,
        ),
      errorCode('INVALID_BLOCK'),
    );
    assert.throws(
      () =>
        canonicalFields(
          {
            blocks: [
              { id: NESTED, __itemTypeId: MODEL, attributes: { blocks: null } },
            ],
          },
          MODEL,
          schema,
        ),
      errorCode('INVALID_BLOCK'),
    );
  });

  it('canonicalizes native asset and collection resources without dropping localized metadata', () => {
    const localeMetadata = {
      en: {
        alt: 'English',
        title: null,
        custom_data: { x: 'one' },
        focal_point: { x: 0.3, y: 0.4 },
        poster_time: null,
      },
      it: {
        alt: 'Italiano',
        title: 'Titolo',
        custom_data: { x: 'due' },
        focal_point: { x: 0.3, y: 0.4 },
        poster_time: null,
      },
    };
    const raw = {
      id: ASSET,
      type: 'upload',
      attributes: {
        basename: 'image',
        format: 'png',
        md5: 'ABCDEF0123456789ABCDEF0123456789',
        size: 100,
        url: 'https://example.invalid/image.png',
        default_field_metadata: localeMetadata,
      },
      relationships: {
        upload_collection: {
          data: { type: 'upload_collection', id: identity('collection') },
        },
      },
    };
    assert.deepEqual(
      canonicalUpload(raw),
      canonicalUpload(deserializeJsonEntity(raw)),
    );
    assert.deepEqual(canonicalUpload(raw).attributes.default_field_metadata, {
      alt: { en: 'English', it: 'Italiano' },
      title: { en: null, it: 'Titolo' },
      custom_data: { en: { x: 'one' }, it: { x: 'due' } },
      focal_point: { x: 0.3, y: 0.4 },
      poster_time: null,
    });
    const collection = {
      id: identity('collection'),
      type: 'upload_collection',
      attributes: { label: 'Images' },
      relationships: { parent: { data: null } },
    };
    assert.deepEqual(
      canonicalCollection(collection),
      canonicalCollection(deserializeJsonEntity(collection)),
    );
  });

  it('captures 30-record nested pages with backpressure and the complete unselected namespace', async () => {
    const other = model(identity('other'));
    const records = Array.from({ length: 125 }, (_, index) =>
      rawRecord(identity(`r${index}`), { title: `record ${index}` }),
    );
    records.push(
      rawRecord(identity('outside'), { title: 'outside' }, false, other.id),
    );
    const fixture = mockClient([model(), other], records);
    const original = fixture.mock.items.rawList;
    let active = 0;
    let maximum = 0;
    fixture.mock.items.rawList = async (args) => {
      active++;
      maximum = Math.max(maximum, active);
      assert.equal(args.nested, true);
      assert.equal(args.page.limit, 30);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await original(args);
      } finally {
        active--;
      }
    };
    const store = new SnapshotStore();
    try {
      const schema = await fetchSchema(fixture.client, 'source');
      await captureSnapshot({
        client: fixture.client,
        environmentId: 'source',
        schema,
        store,
        side: 'source',
        options: { modelIds: [MODEL], uploads: 'referenced', concurrency: 2 },
        verify: false,
      });
      assert.equal([...store.records('source')].length, 126);
      assert.equal(
        store.getRecord('source', identity('outside'))?.current.title,
        'outside',
      );
      assert.equal(maximum, 2);
      assert.deepEqual(
        fixture.calls
          .filter(
            (call) => call.filter.type === MODEL && call.version === 'current',
          )
          .map((call) => call.page.offset)
          .sort((a, b) => (a ?? 0) - (b ?? 0)),
        [0, 30, 60, 90, 120],
      );
      assert.equal(
        store.database
          .prepare('SELECT COUNT(*) AS count FROM capture_raw')
          .get()?.count,
        0,
      );
    } finally {
      const directory = store.directory;
      store.dispose();
      assert.equal(existsSync(directory), false);
    }
  });

  it('rejects changed page totals, duplicated identities, and missing publication slices', async () => {
    for (const scenario of ['total', 'duplicate', 'publication'] as const) {
      const records = Array.from({ length: 31 }, (_, index) =>
        rawRecord(
          identity(`r${index}`),
          { title: 'record' },
          scenario === 'publication',
        ),
      );
      const fixture = mockClient([model()], records);
      const original = fixture.mock.items.rawList;
      fixture.mock.items.rawList = async (args) => {
        const body = await original(args);
        if ((args.page.offset ?? 0) > 0 && args.version === 'current') {
          if (scenario === 'total') return response(body.data as unknown[], 32);
          if (scenario === 'duplicate') return response([records[0]], 31);
        }
        return body;
      };
      const store = new SnapshotStore();
      try {
        const schema = await fetchSchema(fixture.client, 'source');
        await assert.rejects(
          captureSnapshot({
            client: fixture.client,
            environmentId: 'source',
            schema,
            store,
            side: 'source',
            options: { modelIds: [MODEL], uploads: 'all' },
            verify: false,
          }),
          errorCode('CAPTURE_DRIFT'),
        );
        assert.equal(
          store.database
            .prepare('SELECT COUNT(*) AS count FROM capture_raw')
            .get()?.count,
          0,
        );
      } finally {
        store.dispose();
      }
    }
  });

  it('verifies complete expanded content twice and rejects changed versions or schema', async () => {
    for (const scenario of [
      'stable',
      'version',
      'schema',
      'validity',
    ] as const) {
      const fixture = mockClient([model()], [rawRecord()]);
      const original = fixture.mock.items.rawList;
      let currentPass = 0;
      fixture.mock.items.rawList = async (args) => {
        const body = await original(args);
        if (args.version === 'current') {
          currentPass++;
          if (currentPass > 1 && scenario === 'version') {
            const rows = structuredClone(body.data) as Record<
              string,
              unknown
            >[];
            (rows[0].meta as Record<string, unknown>).current_version = 'v2';
            return response(rows);
          }
          if (currentPass > 1 && scenario === 'validity') {
            const rows = structuredClone(body.data) as Record<
              string,
              unknown
            >[];
            (rows[0].meta as Record<string, unknown>).is_current_version_valid =
              false;
            return response(rows);
          }
        }
        return body;
      };
      const originalSite = fixture.mock.site.find;
      let sites = 0;
      fixture.mock.site.find = async () => {
        const site = await originalSite();
        if (++sites > 1 && scenario === 'schema')
          return { ...site, locales: ['en'] };
        return site;
      };
      const store = new SnapshotStore();
      try {
        const schema = await fetchSchema(fixture.client, 'source');
        const capture = captureSnapshot({
          client: fixture.client,
          environmentId: 'source',
          schema,
          store,
          side: 'source',
          options: { modelIds: [MODEL], uploads: 'all' },
        });
        if (scenario === 'stable' || scenario === 'validity') {
          await capture;
          assert.equal(currentPass, 2);
        } else await assert.rejects(capture, errorCode('CAPTURE_DRIFT'));
        assert.equal(
          store.database
            .prepare('SELECT COUNT(*) AS count FROM capture_raw')
            .get()?.count,
          0,
        );
      } finally {
        store.dispose();
      }
    }
  });

  it('bounds focused reads, rejects unexpected IDs, and keeps guard validity metadata', async () => {
    const fixture = mockClient([model()], [rawRecord()]);
    const schema = await fetchSchema(fixture.client, 'source');
    await assert.rejects(
      readRecordBatch(
        fixture.client,
        Array.from({ length: 31 }, (_, index) => identity(String(index))),
        schema,
      ),
      errorCode('INVALID_BATCH'),
    );
    assert.equal(fixture.calls.length, 0);
    const records = await readRecordBatch(fixture.client, [RECORD], schema);
    assert.deepEqual(recordGuard(records[0]).validity, records[0].validity);
    assert.equal(fixture.calls.length, 2);
    fixture.mock.items.rawList = async () => response([rawRecord(LINKED)]);
    await assert.rejects(
      readRecordBatch(fixture.client, [RECORD], schema),
      errorCode('INVALID_RESPONSE'),
    );
  });

  it('captures exact private selective schedules and rejects incomplete or drifting state', async () => {
    const fixture = mockClient();
    const current = rawRecord();
    (current.meta as Record<string, unknown>).publication_scheduled_at = FUTURE;
    (current.meta as Record<string, unknown>).unpublishing_scheduled_at =
      '2090-02-01T12:30:00.000Z';
    const body = {
      data: {
        relationships: {
          scheduled_publication: {
            data: { type: 'scheduled_publication', id: 'pub' },
          },
          scheduled_unpublishing: {
            data: { type: 'scheduled_unpublishing', id: 'unpub' },
          },
        },
      },
      included: [
        {
          id: 'pub',
          type: 'scheduled_publication',
          attributes: {
            publication_scheduled_at: FUTURE,
            selective_publication: {
              content_in_locales: ['it', 'en'],
              non_localized_content: false,
            },
          },
        },
        {
          id: 'unpub',
          type: 'scheduled_unpublishing',
          attributes: {
            unpublishing_scheduled_at: '2090-02-01T12:30:00.000Z',
            content_in_locales: ['it'],
          },
        },
      ],
    };
    Reflect.set(
      fixture.mock.items,
      'rawCurrentVsPublishedState',
      async () => body,
    );
    assert.deepEqual(await readSchedules(fixture.client, current), {
      publication: {
        at: FUTURE,
        selective: { locales: ['en', 'it'], nonLocalized: false },
      },
      unpublishing: { at: '2090-02-01T12:30:00.000Z', locales: ['it'] },
    });
    Reflect.set(fixture.mock.items, 'rawCurrentVsPublishedState', async () => ({
      ...body,
      included: [],
    }));
    await assert.rejects(
      readSchedules(fixture.client, current),
      errorCode('SCHEDULE_CONTRACT'),
    );
    Reflect.set(fixture.mock.items, 'rawCurrentVsPublishedState', async () => ({
      ...body,
      included: [
        {
          ...body.included[0],
          attributes: {
            ...body.included[0].attributes,
            publication_scheduled_at: '2091-01-01T12:30:00.000Z',
          },
        },
        body.included[1],
      ],
    }));
    await assert.rejects(
      readSchedules(fixture.client, current),
      errorCode('CAPTURE_DRIFT'),
    );
  });

  it('proves full namespace permissions before any content read and checks schema-edit authority', async () => {
    const fixture = mockClient([model()], [rawRecord()]);
    const schema = await fetchSchema(fixture.client, 'source');
    Reflect.set(fixture.mock.users, 'findMe', async () => ({
      type: 'access_token',
      role: {
        id: 'role',
        meta: {
          final_permissions: {
            can_manage_upload_collections: true,
            can_edit_schema: false,
            positive_item_type_permissions: [],
            negative_item_type_permissions: [],
            positive_upload_permissions: [],
            negative_upload_permissions: [],
          },
        },
      },
    }));
    const store = new SnapshotStore();
    try {
      await assert.rejects(
        captureSnapshot({
          client: fixture.client,
          environmentId: 'source',
          schema,
          store,
          side: 'source',
          options: { modelIds: [MODEL], uploads: 'all' },
        }),
        errorCode('UNPROVEN_FULL_ACCESS'),
      );
      assert.equal(fixture.calls.length, 0);
      await assert.rejects(
        assertSchemaEditAccess(fixture.client),
        errorCode('UNPROVEN_SCHEMA_EDIT_ACCESS'),
      );
      Reflect.set(fixture.mock.users, 'findMe', async () => ({
        type: 'access_token',
        hardcoded_type: 'admin',
      }));
      await assertFullReadAccess(fixture.client, schema);
    } finally {
      store.dispose();
    }
  });

  it('hashes canonical content independently from object insertion order', () => {
    assert.equal(
      hashJson({ b: 1, a: { z: true, x: null } }),
      hashJson({ a: { x: null, z: true }, b: 1 }),
    );
    assert.throws(
      () => hashJson({ bad: Number.NaN }),
      errorCode('INVALID_JSON'),
    );
  });

  it('preserves JSON keys named __proto__ without changing the object prototype', () => {
    const schema = state([model(MODEL, [field('opaque', 'json')])]);
    const opaque = JSON.parse(
      '{"__proto__":{"marker":"own-value"},"normal":true}',
    ) as JsonObject;
    const result = canonicalRecord(rawRecord(RECORD, { opaque }), null, schema);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.current.opaque, '__proto__'),
      true,
    );
    assert.equal(
      (result.current.opaque as JsonObject).__proto__ &&
        ((result.current.opaque as JsonObject).__proto__ as JsonObject).marker,
      'own-value',
    );
    assert.equal(
      Object.getPrototypeOf(result.current.opaque),
      Object.prototype,
    );
    assert.equal(
      hashJson(opaque),
      hashJson(
        JSON.parse('{"normal":true,"__proto__":{"marker":"own-value"}}'),
      ),
    );
    assert.notEqual(hashJson(opaque), hashJson({ normal: true }));
  });

  it('rejects missing published validity instead of guessing an invalid version', () => {
    const current = rawRecord(RECORD, { title: 'current' }, true);
    Reflect.deleteProperty(
      current.meta as object,
      'is_published_version_valid',
    );
    assert.throws(
      () =>
        canonicalRecord(
          current,
          rawRecord(RECORD, { title: 'published' }, true),
          state(),
        ),
      errorCode('INVALID_RESPONSE'),
    );
  });

  it('rejects asset metadata whose localized focal point or poster time cannot be reproduced', () => {
    for (const attribute of ['focal_point', 'poster_time'] as const) {
      const en = {
        alt: null,
        title: null,
        custom_data: {},
        focal_point: { x: 0.2, y: 0.4 },
        poster_time: 0,
      };
      const it = {
        ...en,
        [attribute]: attribute === 'focal_point' ? { x: 0.8, y: 0.7 } : 4,
      };
      assert.throws(
        () =>
          canonicalUpload({
            id: ASSET,
            basename: 'image',
            format: 'png',
            md5: '0123456789abcdef0123456789abcdef',
            size: 100,
            url: 'https://example.invalid/image',
            default_field_metadata: { en, it },
          }),
        errorCode('UNSUPPORTED_UPLOAD_METADATA'),
      );
    }
  });
});
