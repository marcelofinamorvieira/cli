import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CmaClient } from '@datocms/cli-utils';
import { buildBlockRecord } from '@datocms/cma-client';
import { buildClient } from '@datocms/cma-client-node';
import {
  deserializeJsonEntity,
  serializeRawRequestBodyWithItems,
} from '@datocms/rest-client-utils';
import {
  captureSnapshot,
  readRecordBatch,
  readSchedules,
} from '../src/engine/capture';
import {
  canonicalCollection,
  canonicalFields,
  canonicalRecord,
  canonicalUpload,
  hashJson,
  recordPayloadFields,
  recordReferences,
  unsupportedRecordPayloadKey,
} from '../src/engine/codec';
import { ContentError } from '../src/engine/errors';
import { assertFullReadAccess, fetchSchema } from '../src/engine/schema';
import { SnapshotStore } from '../src/engine/store';
import type {
  Client,
  FieldSchema,
  JsonObject,
  ModelSchema,
  SchemaState,
} from '../src/engine/types';
import { withBulkSchema } from './bulk-schema-fixture';

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
    saveInvalidDrafts: false,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}
/** A model with a block field, so capture reads it in nested 30-record pages. */
function pagedModel(): ModelSchema {
  return model(MODEL, [field('title'), field('blocks', 'rich_text')]);
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
/** A block as the CMA's nested reads return it and write payloads send it. */
function nativeBlock(
  id: string,
  modelId: string,
  attributes: JsonObject,
): JsonObject {
  return {
    type: 'item',
    id,
    attributes,
    relationships: { item_type: { data: { type: 'item_type', id: modelId } } },
  };
}
/** A block as `RecordState` stores it. */
function canonicalBlock(
  id: string,
  modelId: string,
  attributes: JsonObject,
): JsonObject {
  return { id, __itemTypeId: modelId, attributes };
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
    request: async (request: {
      method: string;
      url: string;
      queryParams?: Record<string, unknown>;
    }): Promise<unknown> => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/items');
      return mock.items.rawList(request.queryParams as ListArgs);
    },
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
    uploads: {
      rawList: async () => response([]),
      list: async () => [] as unknown[],
    },
    uploadCollections: { list: async () => [] },
  };
  withBulkSchema(mock as unknown as Client);
  return { mock, client: mock as unknown as Client, calls };
}

describe('expanded capture and native payload codec', () => {
  it('records only the versions the CMA itself reports invalid', () => {
    const schema = state();
    const valid = canonicalRecord(rawRecord(), null, schema);
    assert.equal(valid.invalid, undefined);
    const raw = rawRecord(RECORD, { title: 'record' }, true);
    const meta = raw.meta as JsonObject;
    meta.is_current_version_valid = false;
    meta.is_published_version_valid = false;
    const published = rawRecord(RECORD, { title: 'record' }, true);
    const invalid = canonicalRecord(raw, published, schema);
    assert.deepEqual(invalid.invalid, { current: true, published: true });
    // The verdict describes the content; it does not change its hash.
    assert.equal(
      invalid.hash,
      canonicalRecord(
        rawRecord(RECORD, { title: 'record' }, true),
        published,
        schema,
      ).hash,
    );
    // A null verdict is not an invalid one.
    meta.is_current_version_valid = null;
    meta.is_published_version_valid = null;
    assert.equal(canonicalRecord(raw, published, schema).invalid, undefined);
  });

  it('canonicalizes native records including both independently expanded slices', () => {
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
    const references = recordReferences(record, schema);
    assert.deepEqual(
      [
        ...new Set(
          references
            .filter((ref) => ref.kind === 'current')
            .map((ref) => ref.targetId),
        ),
      ],
      [LINKED],
    );
    assert.deepEqual(
      [
        ...new Set(
          references
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
  });

  it('detects custom metadata keys lost by native SDK serialization without rejecting block annotations or JSON strings', () => {
    const localizedFile = { ...field('image', 'file'), localized: true };
    const schema = state([
      model(MODEL, [
        field('images', 'gallery'),
        field('blocks', 'rich_text'),
        field('opaque', 'json'),
      ]),
      model(BLOCK, [localizedFile], true),
    ]);
    for (const key of ['__itemTypeId', '__proto__']) {
      const customData = JSON.parse(
        `{"${key}":"business-value","credit":"Artist"}`,
      ) as JsonObject;
      const file = {
        upload_id: ASSET,
        alt: null,
        title: null,
        custom_data: customData,
        focal_point: null,
        poster_time: null,
      };
      const sourceFields: JsonObject = {
        images: [file],
        blocks: [nativeBlock(NESTED, BLOCK, { image: { en: file } })],
        opaque: JSON.stringify(customData),
      };
      const canonical = canonicalFields(sourceFields, MODEL, schema);
      const native = recordPayloadFields(canonical, MODEL, schema);
      const serialized = serializeRawRequestBodyWithItems({
        data: { id: RECORD, type: 'item', attributes: native },
      });
      assert.equal(
        Object.hasOwn(
          (native.images as JsonObject[])[0].custom_data as JsonObject,
          key,
        ),
        true,
      );
      assert.equal(
        Object.hasOwn(serialized.data.attributes.images[0].custom_data, key),
        false,
      );
      assert.equal(serialized.data.attributes.opaque, sourceFields.opaque);
      assert.equal(unsupportedRecordPayloadKey(canonical, MODEL, schema), key);
      // Check both the direct gallery and localized nested file independently.
      assert.equal(
        unsupportedRecordPayloadKey(
          { ...canonical, blocks: [] },
          MODEL,
          schema,
        ),
        key,
      );
      assert.equal(
        unsupportedRecordPayloadKey(
          { ...canonical, images: [] },
          MODEL,
          schema,
        ),
        key,
      );
      const safe = canonicalFields(
        {
          images: [{ ...file, custom_data: { credit: 'Artist' } }],
          blocks: [
            nativeBlock(NESTED, BLOCK, {
              image: { en: { ...file, custom_data: {} } },
            }),
          ],
          opaque: sourceFields.opaque,
        },
        MODEL,
        schema,
      );
      assert.equal(unsupportedRecordPayloadKey(safe, MODEL, schema), undefined);
    }
  });

  it('canonicalizes SDK asset and collection entities without dropping localized metadata', () => {
    const metadata = {
      alt: { en: 'English', it: 'Italiano' },
      title: { en: null, it: 'Titolo' },
      custom_data: { en: { x: 'one' }, it: { x: 'due' } },
      focal_point: { x: 0.3, y: 0.4 },
      poster_time: null,
    };
    const upload = canonicalUpload({
      id: ASSET,
      type: 'upload',
      basename: 'image',
      filename: 'image.png',
      format: 'png',
      md5: 'ABCDEF0123456789ABCDEF0123456789',
      size: 100,
      url: 'https://example.invalid/image.png',
      default_field_metadata: metadata,
      upload_collection: {
        type: 'upload_collection',
        id: identity('collection'),
      },
    });
    assert.equal(upload.md5, 'abcdef0123456789abcdef0123456789');
    assert.equal(upload.collectionId, identity('collection'));
    assert.deepEqual(upload.attributes.default_field_metadata, metadata);
    const collection = {
      id: identity('collection'),
      type: 'upload_collection',
      attributes: { label: 'Images', position: 1 },
      relationships: { parent: { data: null } },
    };
    assert.deepEqual(canonicalCollection(deserializeJsonEntity(collection)), {
      id: identity('collection'),
      label: 'Images',
      parentId: null,
      position: 1,
      hash: canonicalCollection(deserializeJsonEntity(collection)).hash,
    });
  });

  it('reads asset metadata field-keyed through the SDK in environments that serve it locale-keyed', async () => {
    const raw = {
      id: ASSET,
      type: 'upload',
      attributes: {
        basename: 'image',
        filename: 'image.png',
        format: 'png',
        md5: '0123456789abcdef0123456789abcdef',
        size: 100,
        url: 'https://example.invalid/image.png',
        default_field_metadata: {
          en: {
            alt: 'English',
            title: null,
            custom_data: {},
            focal_point: { x: 0.3, y: 0.4 },
            poster_time: null,
          },
          it: {
            alt: 'Italiano',
            title: 'Titolo',
            custom_data: {},
            focal_point: { x: 0.3, y: 0.4 },
            poster_time: null,
          },
        },
      },
      relationships: { upload_collection: { data: null } },
    };
    const client = buildClient({
      apiToken: 'offline-fixture-token',
      fetchFn: async () =>
        new Response(JSON.stringify(response([raw])), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const [upload] = await client.uploads.list();
    assert.deepEqual(
      canonicalUpload(upload).attributes.default_field_metadata,
      {
        alt: { en: 'English', it: 'Italiano' },
        title: { en: null, it: 'Titolo' },
        custom_data: { en: {}, it: {} },
        focal_point: { x: 0.3, y: 0.4 },
        poster_time: null,
      },
    );
  });

  it('pages uploads through the SDK by ID and rejects totals, lengths or identities that change meanwhile', async () => {
    const uploads = Array.from({ length: 501 }, (_, index) => ({
      id: identity(`upload-${index}`),
      type: 'upload',
      basename: `image-${index}`,
      filename: `image-${index}.png`,
      md5: '0123456789abcdef0123456789abcdef',
      size: 100,
      url: `https://example.invalid/image-${index}.png`,
      default_field_metadata: {},
      upload_collection: null,
    }));
    for (const scenario of [
      'complete',
      'page-total',
      'short',
      'duplicate',
      'final-total',
      'removed-from-first-page',
    ] as const) {
      const fixture = mockClient();
      const live = [...uploads];
      const listed: unknown[] = [];
      let counts = 0;
      fixture.mock.uploads.rawList = async () => {
        counts += 1;
        const changed =
          (scenario === 'page-total' && counts === 2) ||
          (scenario === 'final-total' && counts === 3);
        return response([], changed ? 502 : live.length);
      };
      fixture.mock.uploads.list = async (args?: {
        page: { offset: number; limit: number };
      }) => {
        listed.push(structuredClone(args));
        const { offset, limit } = args!.page;
        if (offset > 0 && scenario === 'short') return [];
        if (offset > 0 && scenario === 'duplicate') return [uploads[0]];
        const page = live.slice(offset, offset + limit);
        // An upload of the first page is deleted right after it is listed,
        // so every later read sees the remaining uploads shifted left.
        if (offset === 0 && scenario === 'removed-from-first-page')
          live.splice(10, 1);
        return page;
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
          options: { concurrency: 1 },
          verify: 'none',
        });
        if (scenario !== 'complete') {
          await assert.rejects(capture, errorCode('CAPTURE_DRIFT'), scenario);
          continue;
        }
        await capture;
        assert.deepEqual(listed, [
          { order_by: 'id_ASC', page: { offset: 0, limit: 500 } },
          { order_by: 'id_ASC', page: { offset: 500, limit: 500 } },
        ]);
        assert.equal(counts, 3);
        assert.deepEqual(
          [...store.uploads('source')].map((upload) => upload.id).sort(),
          uploads.map((upload) => upload.id).sort(),
        );
      } finally {
        store.dispose();
      }
    }
  });

  it('retains native collection positions in fingerprints, including sparse negative indexes', () => {
    const input = {
      id: identity('positioned-collection'),
      label: 'Collection',
      parent: null,
    };
    assert.notDeepEqual(
      canonicalCollection({ ...input, position: -3 }),
      canonicalCollection({ ...input, position: 8 }),
    );
    assert.throws(() => canonicalCollection(input), /position/);
    assert.equal(
      canonicalCollection({ ...input, position: 1.5 }).position,
      1.5,
    );
  });

  it('rejects collection-position-only drift during the independent capture check', async () => {
    const fixture = mockClient();
    let reads = 0;
    fixture.client.uploadCollections.list = async () => [
      {
        id: identity('moving-collection'),
        type: 'upload_collection',
        label: 'Collection',
        position: ++reads,
        parent: null,
        children: [],
      },
    ];
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
          options: { concurrency: 1 },
          verify: 'full',
        }),
        /changed during capture/,
      );
    } finally {
      store.dispose();
    }
  });

  it('rejects metadata mistaken for an item by SDK response adaptation while allowing real blocks and JSON strings', async () => {
    const schema = state([
      model(MODEL, [
        field('image', 'file'),
        field('images', 'gallery'),
        field('blocks', 'rich_text'),
        field('content', 'structured_text'),
        field('opaque', 'json'),
      ]),
      model(BLOCK, [{ ...field('image', 'file'), localized: true }], true),
    ]);
    const image = (type: string): JsonObject => ({
      upload_id: ASSET,
      alt: null,
      title: null,
      custom_data: { type, credit: 'Artist' },
      focal_point: null,
      poster_time: null,
    });
    const block = (type: string): JsonObject =>
      nativeBlock(NESTED, BLOCK, { image: { en: image(type) } });
    const safe: JsonObject = {
      image: image('photo'),
      images: [image('photo')],
      blocks: [block('photo')],
      content: {
        schema: 'dast',
        document: {
          type: 'root',
          children: [{ type: 'block', item: block('photo') }],
        },
      },
      opaque: JSON.stringify({ type: 'item', __itemTypeId: 'business-data' }),
    };
    assert.equal(
      unsupportedRecordPayloadKey(
        canonicalFields(safe, MODEL, schema),
        MODEL,
        schema,
      ),
      undefined,
    );
    for (const placement of ['file', 'gallery', 'nested', 'dast']) {
      const fields = structuredClone(safe);
      if (placement === 'file') fields.image = image('item');
      if (placement === 'gallery') fields.images = [image('item')];
      if (placement === 'nested') fields.blocks = [block('item')];
      if (placement === 'dast')
        fields.content = {
          schema: 'dast',
          document: {
            type: 'root',
            children: [{ type: 'block', item: block('item') }],
          },
        };
      const canonical = canonicalFields(fields, MODEL, schema);
      let writes = 0;
      const client = buildClient({
        apiToken: 'offline-fixture-token',
        fetchFn: async (_url, init) => {
          writes++;
          const body = JSON.parse(String(init?.body)) as {
            data: { attributes: JsonObject };
          };
          // The native write succeeds, but the SDK adapter then mistakes the
          // custom_data object for a record and throws after the transport.
          return new Response(
            JSON.stringify({ data: rawRecord(RECORD, body.data.attributes) }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      });
      await assert.rejects(
        client.items.rawUpdate(RECORD, {
          data: {
            id: RECORD,
            type: 'item',
            attributes: recordPayloadFields(canonical, MODEL, schema),
          },
        }),
        /item_type/,
      );
      assert.equal(writes, 1);
      assert.equal(
        unsupportedRecordPayloadKey(canonical, MODEL, schema),
        'type',
        placement,
      );
    }
  });

  it('captures 30-record nested pages with backpressure and the complete unselected namespace', async () => {
    const other = model(identity('other'));
    other.fields[0].id = identity('other-title');
    const records = Array.from({ length: 125 }, (_, index) =>
      rawRecord(identity(`r${index}`), {
        title: `record ${index}`,
        blocks: [],
      }),
    );
    records.push(
      rawRecord(identity('outside'), { title: 'outside' }, false, other.id),
    );
    const fixture = mockClient([pagedModel(), other], records);
    const original = fixture.mock.items.rawList;
    let active = 0;
    let maximum = 0;
    fixture.mock.items.rawList = async (args) => {
      active++;
      maximum = Math.max(maximum, active);
      // Only models with block fields need expanded 30-record pages.
      if (args.filter.type === MODEL) {
        assert.equal(args.nested, true);
        assert.equal(args.page.limit, 30);
      } else {
        assert.equal(args.nested, false);
        assert.equal(args.page.limit, 500);
      }
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
        options: { concurrency: 2 },
        verify: 'none',
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

  it('rejects unsafe native INTEGER wire values before capture can merge distinct integers', async () => {
    const schema = state([
      model(MODEL, [
        field('counter', 'integer'),
        field('opaque', 'json'),
        field('fraction', 'float'),
      ]),
    ]);
    const opaque = '{"counter":9007199254740993}';
    for (const literal of [
      '9007199254740992',
      '9007199254740993',
      '-9007199254740993',
    ]) {
      for (const slice of ['current', 'published']) {
        const client = buildClient({
          apiToken: 'offline-fixture-token',
          fetchFn: async (input) => {
            const version = new URL(String(input)).searchParams.get('version');
            const row = rawRecord(
              RECORD,
              {
                counter: version === slice ? '__WIRE_INTEGER__' : 1,
                opaque,
                fraction: 1e30,
              },
              true,
            );
            const wire = JSON.stringify(response([row])).replace(
              '"__WIRE_INTEGER__"',
              literal,
            );
            return new Response(wire, {
              headers: { 'content-type': 'application/json' },
            });
          },
        });
        await assert.rejects(
          readRecordBatch(client, [RECORD], schema),
          errorCode('UNSUPPORTED_INTEGER_PRECISION'),
        );
      }
    }
    for (const value of [
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      0,
      null,
    ]) {
      const client = buildClient({
        apiToken: 'offline-fixture-token',
        fetchFn: async () =>
          new Response(
            JSON.stringify(
              response([
                rawRecord(
                  RECORD,
                  { counter: value, opaque, fraction: 1e30 },
                  true,
                ),
              ]),
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
      });
      const [captured] = await readRecordBatch(client, [RECORD], schema);
      assert.equal(captured.current.counter, value);
      assert.equal(captured.published!.counter, value);
      assert.equal(captured.current.opaque, opaque);
      assert.equal(captured.current.fraction, 1e30);
    }
  });

  it('checks INTEGER precision in localized and nested capture/write fields without parsing opaque JSON', () => {
    const schema = state([
      model(MODEL, [
        { ...field('count', 'integer'), localized: true },
        field('blocks', 'rich_text'),
      ]),
      model(
        BLOCK,
        [
          field('count', 'integer'),
          field('opaque', 'json'),
          field('fraction', 'float'),
        ],
        true,
      ),
    ]);
    const opaque = '{"count":9007199254740993}';
    // canonicalFields reads native blocks; recordPayloadFields canonical ones.
    for (const [convert, wrap] of [
      [canonicalFields, nativeBlock],
      [recordPayloadFields, canonicalBlock],
    ] as const) {
      const block = (count: number): JsonObject =>
        wrap(NESTED, BLOCK, { count, opaque, fraction: 1e30 });
      const invalidFields: JsonObject[] = [
        { count: { en: 1, it: Number.MAX_SAFE_INTEGER + 1 }, blocks: [] },
        { count: { en: 1 }, blocks: [block(Number.MIN_SAFE_INTEGER - 1)] },
      ];
      for (const fields of invalidFields)
        assert.throws(
          () => convert(fields, MODEL, schema),
          errorCode('UNSUPPORTED_INTEGER_PRECISION'),
        );
      assert.doesNotThrow(() =>
        convert(
          {
            count: { en: Number.MAX_SAFE_INTEGER, it: null },
            blocks: [block(Number.MIN_SAFE_INTEGER)],
          },
          MODEL,
          schema,
        ),
      );
    }
  });

  it('captures exact native custom_data through the authenticated SDK request path before serializer diagnostics', async () => {
    const models = [
      model(MODEL, [
        field('image', 'file'),
        field('images', 'gallery'),
        field('blocks', 'rich_text'),
      ]),
      model(
        BLOCK,
        [{ ...field('localized_image', 'file'), localized: true }],
        true,
      ),
    ];
    const customData = JSON.parse(
      '{"ordinary":"kept","__proto__":"native-proto-value","__itemTypeId":"native-item-type-value"}',
    ) as JsonObject;
    const file = {
      upload_id: ASSET,
      alt: null,
      title: null,
      custom_data: customData,
      focal_point: null,
      poster_time: null,
    };
    const row = rawRecord(RECORD, {
      image: file,
      images: [file],
      blocks: [
        {
          id: NESTED,
          type: 'item',
          attributes: { localized_image: { en: file } },
          relationships: {
            item_type: { data: { id: BLOCK, type: 'item_type' } },
          },
        },
      ],
    });
    let fetches = 0;
    const native = buildClient({
      apiToken: 'offline-fixture-token',
      environment: 'native-capture',
      fetchFn: async (input, init) => {
        fetches++;
        const url = new URL(String(input));
        assert.equal(url.pathname, '/items');
        assert.equal(url.searchParams.get('nested'), 'true');
        const headers = new Headers(init?.headers);
        assert.equal(
          headers.get('authorization'),
          'Bearer offline-fixture-token',
        );
        assert.equal(headers.get('x-environment'), 'native-capture');
        return new Response(
          JSON.stringify(
            response(
              url.searchParams.get('version') === 'published' ? [] : [row],
            ),
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    // Even the SDK rawList adapter loses this own key before returning data.
    const lossy = await native.items.rawList({
      nested: true,
      version: 'current',
    });
    assert.equal(
      Object.hasOwn(
        (lossy.data[0].attributes.image as JsonObject)
          .custom_data as JsonObject,
        '__proto__',
      ),
      false,
    );
    const fixture = mockClient(models);
    Reflect.set(fixture.mock, 'request', native.request.bind(native));
    fixture.mock.items.rawList = async () =>
      assert.fail('Native capture must avoid the lossy item adapter');
    const store = new SnapshotStore();
    try {
      const schema = await fetchSchema(fixture.client, 'source');
      await captureSnapshot({
        client: fixture.client,
        environmentId: 'source',
        schema,
        store,
        side: 'source',
        options: { concurrency: 4 },
        verify: 'none',
      });
      const captured = store.getRecord('source', RECORD)!;
      assert.deepEqual(
        (captured.current.image as JsonObject).custom_data,
        customData,
      );
      assert.deepEqual(
        (captured.current.images as JsonObject[])[0].custom_data,
        customData,
      );
      const block = (captured.current.blocks as JsonObject[])[0];
      assert.deepEqual(
        (
          ((block.attributes as JsonObject).localized_image as JsonObject)
            .en as JsonObject
        ).custom_data,
        customData,
      );
      assert.equal(
        Object.getPrototypeOf(
          (captured.current.image as JsonObject).custom_data,
        ),
        Object.prototype,
      );
      assert.notEqual(
        unsupportedRecordPayloadKey(captured.current, MODEL, schema),
        undefined,
      );
      assert.deepEqual(
        await readRecordBatch(fixture.client, [RECORD], schema),
        [captured],
      );
      assert.equal(fetches, 5);
    } finally {
      store.dispose();
    }
  });

  it('rejects changed page totals, duplicated identities, and missing publication slices', async () => {
    for (const scenario of ['total', 'duplicate', 'publication'] as const) {
      const records = Array.from({ length: 31 }, (_, index) =>
        rawRecord(
          identity(`r${index}`),
          { title: 'record', blocks: [] },
          scenario === 'publication',
        ),
      );
      const fixture = mockClient([pagedModel()], records);
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
            options: { concurrency: 4 },
            verify: 'none',
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

  it('keeps SQLite failures while storing capture pages instead of reporting drift', async () => {
    for (const scenario of ['full', 'error'] as const) {
      const records = Array.from({ length: 31 }, (_, index) =>
        rawRecord(identity(`stored-${index}`), { title: 'x'.repeat(2048) }),
      );
      const fixture = mockClient([model()], records);
      const store = new SnapshotStore();
      try {
        const schema = await fetchSchema(fixture.client, 'source');
        // Capture reuses an existing raw page table with this layout.
        store.database.exec(
          'CREATE TEMP TABLE capture_raw(side TEXT NOT NULL,slice TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(side,slice,id)) WITHOUT ROWID',
        );
        if (scenario === 'full') {
          const pages = store.database.prepare('PRAGMA temp.page_count').get()!
            .page_count as number;
          store.database.exec(`PRAGMA temp.max_page_count = ${pages}`);
        } else {
          store.database.exec(`
            CREATE TEMP TRIGGER capture_unavailable BEFORE INSERT ON capture_raw
            BEGIN SELECT json('unavailable'); END;
          `);
        }
        await assert.rejects(
          captureSnapshot({
            client: fixture.client,
            environmentId: 'source',
            schema,
            store,
            side: 'source',
            options: { concurrency: 4 },
            verify: 'none',
          }),
          (error: unknown) =>
            !(error instanceof ContentError) &&
            (scenario === 'full'
              ? /database or disk is full/
              : /malformed JSON/
            ).test((error as Error).message),
          scenario,
        );
        assert.equal([...store.records('source')].length, 0);
      } finally {
        store.dispose();
      }
    }
  });

  it('stores captured records without building the indexes the planner rebuilds', async () => {
    const models = [
      model(MODEL, [field('blocks', 'rich_text')]),
      model(BLOCK, [field('related', 'link')], true),
    ];
    const records = Array.from({ length: 31 }, (_, index) =>
      rawRecord(identity(`batch-${index}`), {
        blocks: [
          nativeBlock(identity(`block-${index}`), BLOCK, { related: LINKED }),
        ],
      }),
    );
    const fixture = mockClient(models, records);
    const store = new SnapshotStore();
    try {
      const schema = await fetchSchema(fixture.client, 'source');
      await captureSnapshot({
        client: fixture.client,
        environmentId: 'source',
        schema,
        store,
        side: 'source',
        options: { concurrency: 4 },
        verify: 'none',
      });
      assert.equal([...store.records('source')].length, 31);
      assert.equal(
        store.database.prepare('SELECT COUNT(*) AS count FROM refs').get()
          ?.count,
        0,
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
  });

  it('drains active capture pages on cancellation without starting queued requests', async () => {
    const fixture = mockClient(
      [pagedModel()],
      Array.from({ length: 125 }, (_, index) =>
        rawRecord(identity(`abort-${index}`), { title: 'record', blocks: [] }),
      ),
    );
    const controller = new AbortController();
    const original = fixture.mock.items.rawList;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const active = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let started = 0;
    let completed = 0;
    let finished = false;
    fixture.mock.items.rawList = async (args) => {
      if ((args.page.offset ?? 0) > 0) {
        if (++started === 2) ready();
        await pending;
        completed++;
      }
      return original(args);
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
        verify: 'full',
        options: {
          concurrency: 2,
          signal: controller.signal,
        },
      });
      const rejected = assert
        .rejects(capture, errorCode('INTERRUPTED'))
        .then(() => {
          finished = true;
        });
      await active;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(finished, false);
      assert.equal(completed, 0);
      release();
      await rejected;
      assert.equal(started, 2);
      assert.equal(completed, 2);
      assert.deepEqual(
        fixture.calls
          .map((call) => call.page.offset)
          .sort((a, b) => (a ?? 0) - (b ?? 0)),
        [0, 30, 60],
      );
      assert.equal(
        store.database
          .prepare('SELECT COUNT(*) AS count FROM capture_raw')
          .get()?.count,
        0,
      );
    } finally {
      release();
      store.dispose();
    }
  });

  it('processes cancellation between SQLite record batches even when schedule reads resolve immediately', async () => {
    const fixture = mockClient(
      [model()],
      Array.from({ length: 65 }, (_, index) =>
        rawRecord(identity(`yield-${index}`)),
      ),
    );
    const store = new SnapshotStore();
    const controller = new AbortController();
    const original = store.putRecord.bind(store);
    let written = 0;
    store.putRecord = (side, state) => {
      original(side, state);
      if (++written === 1) setImmediate(() => controller.abort());
    };
    try {
      const schema = await fetchSchema(fixture.client, 'source');
      await assert.rejects(
        captureSnapshot({
          client: fixture.client,
          environmentId: 'source',
          schema,
          store,
          side: 'source',
          options: {
            signal: controller.signal,
            concurrency: 4,
          },
          verify: 'none',
        }),
        errorCode('INTERRUPTED'),
      );
      assert.equal(written, 30);
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

  it('verifies complete expanded content twice and rejects changed versions or schema', async () => {
    for (const scenario of ['stable', 'version', 'schema'] as const) {
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
          verify: 'full',
          options: { concurrency: 4 },
        });
        if (scenario === 'stable') {
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

  it('rejects unexpected IDs in focused reads', async () => {
    const fixture = mockClient([model()], [rawRecord()]);
    const schema = await fetchSchema(fixture.client, 'source');
    const records = await readRecordBatch(fixture.client, [RECORD], schema);
    assert.equal(records[0].id, RECORD);
    assert.equal(fixture.calls.length, 2);
    fixture.mock.items.rawList = async () => response([rawRecord(LINKED)]);
    await assert.rejects(
      readRecordBatch(fixture.client, [RECORD], schema),
      errorCode('INVALID_RESPONSE'),
    );
  });

  it('checks consistency by version, rereading only records with a new version', async () => {
    for (const edit of ['none', 'version', 'content'] as const) {
      const records = Array.from({ length: 3 }, (_, index) =>
        rawRecord(identity(`v${index}`), { title: `record ${index}` }),
      );
      const fixture = mockClient([model()], records);
      const original = fixture.mock.items.rawList;
      let calls = 0;
      let focused = 0;
      fixture.mock.items.rawList = async (args) => {
        if (args.filter.ids) focused++;
        // The record is saved after the first pass read it, before the
        // version listing that follows: a new version, and maybe new content.
        else if (
          args.filter.type === MODEL &&
          ++calls === 3 &&
          edit !== 'none'
        ) {
          const meta = records[0].meta as Record<string, unknown>;
          meta.current_version = 'v2';
          if (edit === 'content')
            (records[0].attributes as JsonObject).title = 'edited';
        }
        return original(args);
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
          options: { concurrency: 4 },
          verify: 'versions',
        });
        if (edit === 'content')
          await assert.rejects(capture, errorCode('CAPTURE_DRIFT'));
        else await capture;
        // Only the record with a new version is read again in full.
        assert.equal(focused, edit === 'none' ? 0 : 2);
      } finally {
        store.dispose();
      }
    }
  });

  it('reads schedule details for a whole capture concurrently, not per 30-record batch', async () => {
    // One scheduled record in each of three 30-record batches.
    const records = Array.from({ length: 90 }, (_, index) => {
      const record = rawRecord(identity(`s${index}`), { title: `${index}` });
      if (index % 30 === 0)
        (record.meta as Record<string, unknown>).publication_scheduled_at =
          FUTURE;
      return record;
    });
    const fixture = mockClient([model()], records);
    let active = 0;
    let maximum = 0;
    Reflect.set(fixture.mock.items, 'rawCurrentVsPublishedState', async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active--;
      return {
        data: {
          relationships: {
            scheduled_publication: {
              data: { type: 'scheduled_publication', id: 'pub' },
            },
            scheduled_unpublishing: { data: null },
          },
        },
        included: [
          {
            id: 'pub',
            type: 'scheduled_publication',
            attributes: {
              publication_scheduled_at: FUTURE,
              selective_publication: null,
            },
          },
        ],
      };
    });
    const store = new SnapshotStore();
    try {
      const schema = await fetchSchema(fixture.client, 'source');
      await captureSnapshot({
        client: fixture.client,
        environmentId: 'source',
        schema,
        store,
        side: 'source',
        options: { concurrency: 4 },
        verify: 'none',
      });
      assert.equal(maximum, 3);
      for (const index of [0, 30, 60])
        assert.deepEqual(
          store.getRecord('source', identity(`s${index}`))?.schedules,
          {
            publication: { at: FUTURE, selective: null },
            unpublishing: null,
          },
        );
      assert.equal(
        store.database
          .prepare('SELECT COUNT(*) AS count FROM capture_schedules')
          .get()?.count,
        0,
      );
    } finally {
      store.dispose();
    }
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
      errorCode('INVALID_RESPONSE'),
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
    // A record deleted after the listing is drift, not a CMA failure.
    Reflect.set(fixture.mock.items, 'rawCurrentVsPublishedState', async () => {
      throw new CmaClient.ApiError({
        request: { method: 'GET', url: '/items/x', headers: {} },
        response: {
          status: 404,
          statusText: 'Not Found',
          headers: {},
          body: { data: [] },
        },
      });
    });
    await assert.rejects(
      readSchedules(fixture.client, current),
      errorCode('CAPTURE_DRIFT'),
    );
  });

  it('proves full namespace permissions before any content read', async () => {
    const fixture = mockClient([model()], [rawRecord()]);
    const schema = await fetchSchema(fixture.client, 'source');
    Reflect.set(fixture.mock.users, 'findMe', async () => ({
      type: 'access_token',
      role: {
        id: 'role',
        meta: {
          final_permissions: {
            can_manage_upload_collections: true,
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
          verify: 'full',
          options: { concurrency: 4 },
        }),
        errorCode('UNPROVEN_FULL_ACCESS'),
      );
      assert.equal(fixture.calls.length, 0);
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
});
