import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { serializeRawItem } from '@datocms/rest-client-utils';
import { applyBundle, repairBundle } from '../../src/engine/apply';
import { stageBinary } from '../../src/engine/apply-binary';
import { validateExecution } from '../../src/engine/apply-validation';
import { batches, boundedWork } from '../../src/engine/apply-work';
import { writeBundle } from '../../src/engine/bundle';
import {
  canonicalCollection,
  canonicalFields,
  canonicalUpload,
  inspectRecord,
  recordGuard,
  recordHash,
} from '../../src/engine/codec';
import { ContentError } from '../../src/engine/errors';
import { fetchSchema } from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  ApplyOptions,
  Client,
  CollectionPlan,
  CollectionState,
  JsonObject,
  JsonValue,
  PlanCounts,
  PlanEntry,
  RecordPlan,
  RecordState,
  TemporarySchemaChange,
} from '../../src/engine/types';

describe('apply bounded work and owned binary staging', () => {
  it('limits pulled work and serializes writes in the same ordered group', async () => {
    let pulled = 0;
    let active = 0;
    let maximum = 0;
    const groups = new Set<string>();
    function* work() {
      for (let id = 0; id < 17; id++) {
        pulled++;
        yield { id, group: String(id % 3) };
      }
    }
    await boundedWork(
      work(),
      3,
      async ({ group }) => {
        assert(!groups.has(group));
        groups.add(group);
        active++;
        maximum = Math.max(maximum, active);
        assert(pulled <= 17);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        groups.delete(group);
      },
      (entry) => entry.group,
    );
    assert.equal(maximum, 3);
    assert.equal(active, 0);
    assert.equal(pulled, 17);
  });

  it('drains all submitted writes after a failure before cleanup can run', async () => {
    const order: string[] = [];
    const release: { resolve?: () => void } = {};
    let pulled = 0;
    function* entries() {
      for (let id = 0; id < 20; id++) {
        pulled++;
        yield id;
      }
    }
    const execution = boundedWork(entries(), 2, async (id) => {
      if (id === 0) {
        await new Promise<void>((resolve) => {
          release.resolve = resolve;
        });
        order.push('slow committed');
      } else {
        order.push('failed');
        throw new Error('uncertain remote outcome');
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pulled, 3);
    assert.deepEqual(order, ['failed']);
    release.resolve!();
    await assert.rejects(execution, /uncertain remote outcome/);
    order.push('cleanup');
    assert.deepEqual(order, ['failed', 'slow committed', 'cleanup']);
  });

  it('stops queued work on interruption and waits for every submitted write', async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const execution = boundedWork(
      [0, 1, 2, 3],
      2,
      async (id) => {
        order.push(`start:${id}`);
        await new Promise<void>((resolve) => releases.push(resolve));
        order.push(`finish:${id}`);
      },
      undefined,
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['start:0', 'start:1']);
    controller.abort();
    releases[0]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['start:0', 'start:1', 'finish:0']);
    releases[1]();
    await assert.rejects(
      execution,
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.deepEqual(order, ['start:0', 'start:1', 'finish:0', 'finish:1']);
  });

  it('allows concurrent readers and serializes conflicting read/write locks', async () => {
    let readers = 0;
    let maximumReaders = 0;
    let writing = false;
    const order: string[] = [];
    const entries = [
      { id: 'a', writes: ['a'], reads: ['shared'] },
      { id: 'b', writes: ['b'], reads: ['shared'] },
      { id: 'writer', writes: ['shared'], reads: [] },
      { id: 'c', writes: ['c'], reads: ['shared'] },
    ];
    await boundedWork(
      entries,
      3,
      async (entry) => {
        if (entry.id === 'writer') {
          assert.equal(readers, 0);
          writing = true;
        } else {
          assert.equal(writing, false);
          readers++;
          maximumReaders = Math.max(maximumReaders, readers);
        }
        order.push(`start:${entry.id}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        order.push(`finish:${entry.id}`);
        if (entry.id === 'writer') writing = false;
        else readers--;
      },
      (entry) => entry,
    );
    assert.equal(maximumReaders, 2);
    assert(order.indexOf('start:writer') > order.indexOf('finish:a'));
    assert(order.indexOf('start:writer') > order.indexOf('finish:b'));
    assert(order.indexOf('start:c') > order.indexOf('finish:writer'));
  });

  it('never places more than 30 IDs in a full nested read batch', () => {
    const result = [...batches(Array.from({ length: 67 }, (_, id) => id))];
    assert.deepEqual(
      result.map((batch) => batch.length),
      [30, 30, 7],
    );
    assert.deepEqual(
      result.flat(),
      Array.from({ length: 67 }, (_, id) => id),
    );
  });

  it('uploads a private verified copy and rejects changed bundle bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'apply-binary-test-'));
    try {
      const bundle = join(directory, 'bundle');
      const staging = join(directory, 'staging');
      mkdirSync(join(bundle, 'binaries'), { recursive: true });
      mkdirSync(staging);
      const bytes = Buffer.from('verified file');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const binary = {
        file: `binaries/${sha256}.bin`,
        sha256,
        md5: createHash('md5').update(bytes).digest('hex'),
        bytes: bytes.length,
      };
      writeFileSync(join(bundle, binary.file), bytes);
      const staged = await stageBinary(bundle, staging, binary);
      assert(existsSync(staged));
      writeFileSync(
        join(bundle, binary.file),
        'changed after bundle validation',
      );
      await assert.rejects(
        stageBinary(bundle, staging, binary),
        /changed before staging/,
      );
      assert(existsSync(staged));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes a partially staged binary after interruption', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'apply-binary-abort-'));
    try {
      const staging = join(directory, 'staging');
      mkdirSync(staging);
      const bytes = Buffer.alloc(4 * 1024 * 1024, 'a');
      const binary = {
        file: 'binary.bin',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        md5: createHash('md5').update(bytes).digest('hex'),
      };
      writeFileSync(join(directory, binary.file), bytes);
      const controller = new AbortController();
      const staged = stageBinary(directory, staging, binary, controller.signal);
      controller.abort();
      await assert.rejects(
        staged,
        (error: unknown) =>
          error instanceof ContentError && error.code === 'INTERRUPTED',
      );
      assert.deepEqual(readdirSync(staging), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const modelId = 'aaaaaaaaaaaaaaaaaaaaaa';
const recordId = 'bbbbbbbbbbbbbbbbbbbbbb';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function state(
  fields: JsonObject,
  overrides: Partial<RecordState> = {},
): RecordState {
  const record: RecordState = {
    id: recordId,
    modelId,
    current: fields,
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
  record.hash = recordHash(record);
  return record;
}

function plan(
  baseline: RecordState | null,
  desired: RecordState | null,
): RecordPlan {
  return {
    kind: 'record',
    id: desired?.id ?? baseline!.id,
    modelId,
    action: baseline ? (desired ? 'update' : 'delete') : 'create',
    baseline,
    desired,
    guard: baseline ? recordGuard(baseline) : null,
    safety: {
      currentReferences: [],
      publishedReferences: [],
      uploadReferences: [],
      blockIds: [],
      desiredParentId: desired?.parentId ?? null,
      desiredPosition: desired?.position ?? null,
    },
    execution: {
      createOrder: 0,
      updateOrder: 0,
      publishOrder: 0,
      deleteOrder: 0,
    },
    diagnostics: [],
  };
}

function sdk(initial: RecordState[] = []) {
  const events: string[] = [];
  const focusedReads: string[][] = [];
  const environments = new Map<string, Map<string, RecordState>>([
    [
      'destination',
      new Map(initial.map((record) => [record.id, clone(record)])),
    ],
  ]);
  let failure: string | undefined;
  let primary = false;
  let rootSiteId = 'site';
  let ordered = false;
  let tree = false;
  let withWorkflow = false;
  let draftMode = true;
  let linkField = false;
  let delayedUpdates = false;
  const stats = { activeUpdates: 0, maximumUpdates: 0 };
  let nativeInvalidDrafts = false;
  let improvedValidation = true;
  let localizedTitle = false;
  const fieldStates = new Map<
    string,
    { validators: JsonObject; defaultValue: JsonValue }
  >();
  let originalField = {
    validators: {} as JsonObject,
    defaultValue: null as JsonValue,
  };
  let failRestoration = false;
  let recalculateValidity = false;
  let changePreservedContent = false;
  let failPublicationAfterWrite = false;
  let failPublicationBeforeWrite = false;
  let failAllPublicationCreates = false;
  let afterNextUpdate: ((record: RecordState) => void) | undefined;
  let afterNextCreate: ((record: RecordState) => void) | undefined;
  let afterNextFork: (() => void) | undefined;
  let afterNextScheduleCancellation:
    | ((record: RecordState) => void)
    | undefined;
  const fieldState = (environmentId: string) => {
    if (!fieldStates.has(environmentId))
      fieldStates.set(environmentId, clone(originalField));
    return fieldStates.get(environmentId)!;
  };
  const site = () => ({
    id: 'site',
    locales: ['en'],
    timezone: 'UTC',
    meta: {
      improved_timezone_management: true,
      improved_boolean_fields: true,
      improved_validation_at_publishing: improvedValidation,
      milliseconds_in_datetime: true,
      non_localized_focal_points: true,
      improved_hex_management: true,
    },
  });
  const raw = (record: RecordState, published = false) => ({
    id: record.id,
    type: 'item',
    attributes: {
      ...(published ? record.published : record.current),
      parent_id: record.parentId,
      position: record.position,
    },
    relationships: { item_type: { data: { id: modelId, type: 'item_type' } } },
    meta: {
      created_at: record.createdAt,
      first_published_at: record.firstPublishedAt,
      updated_at: published
        ? record.publishedUpdatedAt
        : '2020-01-01T00:00:00.000Z',
      published_at: record.published ? record.publishedUpdatedAt : null,
      current_version: record.currentVersion,
      is_current_version_valid: record.validity.current,
      is_published_version_valid: record.validity.published,
      stage: record.stage,
      publication_scheduled_at: record.schedules.publication?.at ?? null,
      unpublishing_scheduled_at: record.schedules.unpublishing?.at ?? null,
    },
  });
  const notFound = () =>
    new CmaClient.ApiError({
      request: {
        method: 'GET',
        url: '/resource',
        headers: {},
        body: undefined,
      },
      response: {
        status: 404,
        statusText: 'Not found',
        headers: {},
        body: { data: [] },
      },
    });
  function client(environmentId: string): Client {
    const records = () => environments.get(environmentId)!;
    const get = (id: string) => {
      const record = records().get(id);
      if (!record) throw notFound();
      return record;
    };
    const remember = (record: RecordState) => {
      record.hash = recordHash(record);
      record.currentVersion = String(Number(record.currentVersion) + 1);
    };
    const result = {
      site: { find: async () => site() },
      users: { findMe: async () => ({ id: 'account', type: 'account' }) },
      itemTypes: {
        list: async () => [
          {
            id: modelId,
            api_key: 'page',
            name: 'Page',
            modular_block: false,
            singleton: false,
            sortable: ordered,
            tree,
            draft_mode_active: draftMode,
            draft_saving_active: nativeInvalidDrafts,
            all_locales_required: false,
            workflow: withWorkflow
              ? { id: 'workflow', type: 'workflow' }
              : null,
          },
        ],
      },
      fields: {
        list: async () => [
          {
            id: 'cccccccccccccccccccccc',
            api_key: 'title',
            field_type: 'string',
            localized: localizedTitle,
            validators: fieldState(environmentId).validators,
            default_value: fieldState(environmentId).defaultValue,
          },
          ...(linkField
            ? [
                {
                  id: 'iiiiiiiiiiiiiiiiiiiiii',
                  api_key: 'link',
                  field_type: 'link',
                  localized: false,
                  validators: {},
                  default_value: null,
                },
              ]
            : []),
        ],
        find: async () => ({
          validators: fieldState(environmentId).validators,
          default_value: fieldState(environmentId).defaultValue,
        }),
        update: async (
          _id: string,
          body: { validators: JsonObject; default_value: JsonValue },
        ) => {
          if (localizedTitle) {
            assert(
              body.default_value &&
                typeof body.default_value === 'object' &&
                !Array.isArray(body.default_value),
              'native localized default must be a locale map',
            );
            assert.deepEqual(
              Object.keys(body.default_value),
              ['en'],
              'native localized default must include every locale',
            );
          }
          events.push('field-settings');
          if (failRestoration && 'required' in body.validators)
            throw new Error('injected schema restoration failure');
          fieldStates.set(environmentId, {
            validators: clone(body.validators),
            defaultValue: body.default_value,
          });
          if (recalculateValidity && 'required' in body.validators) {
            // CMA background validation changes diagnostics without creating
            // a content version or modifying the saved current/published data.
            for (const record of records().values()) {
              record.validity.current = record.current.title !== '';
              record.validity.published = record.published
                ? record.published.title !== ''
                : null;
              if (changePreservedContent && record.id !== recordId) {
                record.current.title = 'concurrent content edit';
                record.hash = recordHash(record);
              }
            }
          }
        },
      },
      workflows: {
        list: async () =>
          withWorkflow
            ? [
                {
                  id: 'workflow',
                  api_key: 'editorial',
                  stages: [
                    { id: 'draft', name: 'Draft', initial: true },
                    { id: 'review', name: 'Review', initial: false },
                  ],
                },
              ]
            : [],
      },
      scheduledPublication: {
        destroy: async (id: string) => {
          events.push(`cancel-publication:${id}`);
          const record = get(id);
          record.schedules.publication = null;
          remember(record);
          afterNextScheduleCancellation?.(record);
          afterNextScheduleCancellation = undefined;
        },
        create: async (
          id: string,
          body: {
            publication_scheduled_at: string;
            selective_publication: {
              content_in_locales: string[];
              non_localized_content: boolean;
            } | null;
          },
        ) => {
          events.push(`schedule-publication:${id}`);
          if (failPublicationBeforeWrite) {
            failPublicationBeforeWrite = false;
            throw new Error('injected schedule failure before write');
          }
          if (failAllPublicationCreates)
            throw new Error('injected repeated publication repair failure');
          const record = get(id);
          if (
            (nativeInvalidDrafts || improvedValidation) &&
            !(nativeInvalidDrafts && body.selective_publication)
          ) {
            assert.equal(
              record.validity.current,
              true,
              'full cached validity is required by this scheduling mode',
            );
          }
          record.schedules.publication = {
            at: body.publication_scheduled_at,
            selective: body.selective_publication
              ? {
                  locales: body.selective_publication.content_in_locales,
                  nonLocalized:
                    body.selective_publication.non_localized_content,
                }
              : null,
          };
          remember(record);
          if (failPublicationAfterWrite) {
            failPublicationAfterWrite = false;
            throw new Error('injected uncertain schedule outcome');
          }
        },
      },
      scheduledUnpublishing: {
        destroy: async (id: string) => {
          events.push(`cancel-unpublishing:${id}`);
          const record = get(id);
          record.schedules.unpublishing = null;
          remember(record);
        },
        create: async (
          id: string,
          body: {
            unpublishing_scheduled_at: string;
            content_in_locales: string[] | null;
          },
        ) => {
          events.push(`schedule-unpublishing:${id}`);
          const record = get(id);
          record.schedules.unpublishing = {
            at: body.unpublishing_scheduled_at,
            locales: body.content_in_locales,
          };
          remember(record);
        },
      },
      uploads: {
        rawList: async () => ({ data: [], meta: { total_count: 0 } }),
        listPagedIterator: async function* () {},
      },
      uploadCollections: { list: async () => [] },
      items: {
        rawCurrentVsPublishedState: async (id: string) => {
          const schedules = get(id).schedules;
          return {
            data: {
              relationships: {
                scheduled_publication: {
                  data: schedules.publication
                    ? { id: 'publication', type: 'scheduled_publication' }
                    : null,
                },
                scheduled_unpublishing: {
                  data: schedules.unpublishing
                    ? { id: 'unpublishing', type: 'scheduled_unpublishing' }
                    : null,
                },
              },
            },
            included: [
              ...(schedules.publication
                ? [
                    {
                      id: 'publication',
                      type: 'scheduled_publication',
                      attributes: {
                        publication_scheduled_at: schedules.publication.at,
                        selective_publication: schedules.publication.selective
                          ? {
                              content_in_locales:
                                schedules.publication.selective.locales,
                              non_localized_content:
                                schedules.publication.selective.nonLocalized,
                            }
                          : null,
                      },
                    },
                  ]
                : []),
              ...(schedules.unpublishing
                ? [
                    {
                      id: 'unpublishing',
                      type: 'scheduled_unpublishing',
                      attributes: {
                        unpublishing_scheduled_at: schedules.unpublishing.at,
                        content_in_locales: schedules.unpublishing.locales,
                      },
                    },
                  ]
                : []),
            ],
          };
        },
        rawList: async (query: {
          filter?: { ids?: string; type?: string };
          version?: string;
          page?: { offset?: number; limit?: number };
        }) => {
          if (query.filter?.ids)
            assert(query.filter.ids.split(',').length <= 30);
          if (query.filter?.ids) focusedReads.push(query.filter.ids.split(','));
          let result = [...records().values()].filter(
            (record) =>
              !query.filter?.ids ||
              query.filter.ids.split(',').includes(record.id),
          );
          if (query.version === 'published')
            result = result.filter((record) => record.published);
          result.sort((a, b) => a.id.localeCompare(b.id));
          const offset = query.page?.offset ?? 0;
          return {
            data: result
              .slice(offset, offset + (query.page?.limit ?? 30))
              .map((record) => raw(record, query.version === 'published')),
            meta: { total_count: result.length },
          };
        },
        update: async (id: string, body: JsonObject) => {
          events.push(`update:${id}`);
          if (delayedUpdates) {
            stats.activeUpdates++;
            stats.maximumUpdates = Math.max(
              stats.maximumUpdates,
              stats.activeUpdates,
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
            stats.activeUpdates--;
          }
          if (failure === id) throw new Error('injected update failure');
          const record = get(id);
          const meta = (body.meta ?? {}) as JsonObject;
          assert.equal(meta.current_version, record.currentVersion);
          if ('title' in body) record.current.title = body.title;
          if ('link' in body) record.current.link = body.link;
          if ('created_at' in meta) record.createdAt = String(meta.created_at);
          if ('first_published_at' in meta)
            record.firstPublishedAt = meta.first_published_at as string | null;
          if ('stage' in meta) record.stage = meta.stage as string | null;
          record.validity.current =
            !('required' in fieldState(environmentId).validators) ||
            record.current.title !== '';
          const nextParent =
            'parent_id' in body
              ? (body.parent_id as string | null)
              : record.parentId;
          if (nextParent !== record.parentId) {
            const previousParent = record.parentId;
            const previousPosition = record.position!;
            for (const sibling of records().values()) {
              if (
                sibling.id !== record.id &&
                sibling.parentId === previousParent &&
                sibling.position! > previousPosition
              ) {
                sibling.position!--;
                remember(sibling);
              }
            }
            let appended = -1;
            for (const sibling of records().values()) {
              if (sibling.id !== record.id && sibling.parentId === nextParent)
                appended = Math.max(appended, sibling.position!);
            }
            const nextPosition =
              'position' in body ? (body.position as number) : appended + 1;
            for (const sibling of records().values()) {
              if (
                sibling.id !== record.id &&
                sibling.parentId === nextParent &&
                sibling.position! >= nextPosition
              ) {
                sibling.position!++;
                remember(sibling);
              }
            }
            record.parentId = nextParent;
            record.position = nextPosition;
          } else if ('position' in body && body.position !== record.position) {
            const old = record.position!;
            const next = body.position as number;
            for (const sibling of records().values()) {
              if (sibling.id === record.id) continue;
              if (sibling.parentId !== record.parentId) continue;
              if (
                old < next &&
                sibling.position! > old &&
                sibling.position! <= next
              ) {
                sibling.position!--;
                remember(sibling);
              }
              if (
                old > next &&
                sibling.position! >= next &&
                sibling.position! < old
              ) {
                sibling.position!++;
                remember(sibling);
              }
            }
            record.position = next;
          }
          if (!draftMode) {
            record.published = clone(record.current);
            record.validity.published = record.validity.current;
            record.firstPublishedAt ??= '2020-01-01T00:00:00.000Z';
            record.publishedUpdatedAt = '2020-01-02T00:00:00.000Z';
          }
          remember(record);
          afterNextUpdate?.(record);
          afterNextUpdate = undefined;
          return raw(record);
        },
        create: async (body: JsonObject) => {
          const id = String(body.id);
          events.push(`create:${id}`);
          assert(!records().has(id));
          const meta = body.meta as JsonObject;
          const record = state(
            { title: body.title },
            {
              id,
              createdAt: String(meta.created_at),
              firstPublishedAt: meta.first_published_at as string | null,
              position: ordered ? (body.position as number) : null,
              stage: withWorkflow ? 'draft' : null,
            },
          );
          if (!draftMode) {
            record.published = clone(record.current);
            record.validity.published = true;
            record.firstPublishedAt ??= '2020-01-01T00:00:00.000Z';
            record.publishedUpdatedAt = '2020-01-02T00:00:00.000Z';
          }
          records().set(id, record);
          afterNextCreate?.(record);
          afterNextCreate = undefined;
          return raw(record);
        },
        publish: async (
          id: string,
          _body: unknown,
          query: { recursive: boolean },
        ) => {
          events.push(`publish:${id}`);
          assert.equal(query.recursive, false);
          const record = get(id);
          record.published = clone(record.current);
          record.validity.published = true;
          record.firstPublishedAt ??= '2020-01-01T00:00:00.000Z';
          record.publishedUpdatedAt = '2020-01-02T00:00:00.000Z';
          remember(record);
          return raw(record);
        },
        unpublish: async (id: string) => {
          const record = get(id);
          record.published = null;
          record.validity.published = null;
          remember(record);
        },
        references: async (id: string, query: { version: string }) =>
          [...records().values()]
            .filter(
              (record) =>
                (query.version !== 'published' && record.current.link === id) ||
                (query.version !== 'current' && record.published?.link === id),
            )
            .map((record) => raw(record)),
        destroy: async (id: string) => {
          events.push(`destroy:${id}`);
          records().delete(id);
        },
      },
    } as unknown as Client;
    result.request = (async (request) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/items');
      return result.items.rawList(
        request.queryParams as Parameters<Client['items']['rawList']>[0],
      );
    }) as Client['request'];
    return result;
  }
  const root = {
    site: { find: async () => ({ ...site(), id: rootSiteId }) },
    environments: {
      find: async (id: string) => {
        if (!environments.has(id)) throw notFound();
        return {
          id,
          meta: {
            status: 'ready',
            read_only_mode: false,
            primary: id === 'destination' && primary,
            forked_from: id === 'destination' ? null : 'destination',
          },
        };
      },
      fork: async (id: string, body: { id: string }) => {
        events.push(`fork:${body.id}`);
        environments.set(
          body.id,
          new Map(
            [...environments.get(id)!].map(([key, record]) => [
              key,
              clone(record),
            ]),
          ),
        );
        afterNextFork?.();
        afterNextFork = undefined;
        return { id: body.id, meta: { read_only_mode: false } };
      },
      destroy: async (id: string) => {
        events.push(`delete-fork:${id}`);
        assert.equal(
          stats.activeUpdates,
          0,
          'accepted writes must drain before cleanup',
        );
        assert.notEqual(id, 'destination');
        environments.delete(id);
      },
    },
  } as unknown as Client;
  return {
    client,
    root,
    events,
    environments,
    focusedReads,
    setOrdered: () => {
      ordered = true;
    },
    setTree: () => {
      tree = true;
    },
    withWorkflow: () => {
      withWorkflow = true;
    },
    withoutDraftMode: () => {
      draftMode = false;
    },
    withLinks: () => {
      linkField = true;
    },
    withDelayedUpdates: () => {
      delayedUpdates = true;
    },
    stats,
    scheduleValidation: (native: boolean, improved: boolean) => {
      nativeInvalidDrafts = native;
      improvedValidation = improved;
    },
    failNextPublicationAfterWrite: () => {
      failPublicationAfterWrite = true;
    },
    failNextPublicationBeforeWrite: () => {
      failPublicationBeforeWrite = true;
    },
    afterNextUpdate: (hook: (record: RecordState) => void) => {
      afterNextUpdate = hook;
    },
    afterNextCreate: (hook: (record: RecordState) => void) => {
      afterNextCreate = hook;
    },
    afterNextFork: (hook: () => void) => {
      afterNextFork = hook;
    },
    afterNextScheduleCancellation: (hook: (record: RecordState) => void) => {
      afterNextScheduleCancellation = hook;
    },
    failAllPublicationCreates: () => {
      failAllPublicationCreates = true;
    },
    requireField: (localized = false) => {
      localizedTitle = localized;
      originalField = {
        validators: { required: {} },
        defaultValue: localized ? { en: 'automatic' } : 'automatic',
      };
    },
    fieldStates,
    failRestoration: () => {
      failRestoration = true;
    },
    revalidateOnRestoration: (alsoChangeContent = false) => {
      recalculateValidity = true;
      changePreservedContent = alsoChangeContent;
    },
    fail: (id: string) => {
      failure = id;
    },
    setPrimary: () => {
      primary = true;
    },
    wrongRootProject: () => {
      rootSiteId = 'another-site';
    },
  };
}

const defaults: ApplyOptions = {
  inPlace: false,
  allowPrimary: false,
  keepFailedFork: false,
  allowTemporarySchemaChanges: false,
  concurrency: 2,
};

function collectionState(
  id: string,
  position: number,
  parentId: string | null = null,
  label = id,
): CollectionState {
  return canonicalCollection({
    id,
    label,
    position,
    parent: parentId ? { id: parentId, type: 'upload_collection' } : null,
  });
}

function collectionPlan(
  baseline: CollectionState | null,
  desired: CollectionState | null,
): CollectionPlan {
  return {
    kind: 'collection',
    id: (desired ?? baseline)!.id,
    action: baseline
      ? desired
        ? baseline.hash === desired.hash
          ? 'noop'
          : 'update'
        : 'delete'
      : 'create',
    baseline,
    desired,
    guard: baseline ? { hash: baseline.hash } : null,
    diagnostics: [],
  };
}

function withCollections(
  mock: ReturnType<typeof sdk>,
  initial: CollectionState[],
) {
  const states = new Map<string, Map<string, CollectionState>>([
    ['destination', new Map(initial.map((state) => [state.id, clone(state)]))],
  ]);
  const filteredReads: string[][] = [];
  let afterUpdate: (() => void) | undefined;
  const originalClient = mock.client;
  mock.client = (environmentId) => {
    const client = originalClient(environmentId);
    if (!states.has(environmentId))
      states.set(
        environmentId,
        new Map(
          [...states.get('destination')!].map(([id, state]) => [
            id,
            clone(state),
          ]),
        ),
      );
    const records = states.get(environmentId)!;
    const resource = (id: string) => {
      const state = records.get(id);
      if (!state)
        throw new CmaClient.ApiError({
          request: {
            method: 'GET',
            url: `/upload-collections/${id}`,
            headers: {},
            body: undefined,
          },
          response: {
            status: 404,
            statusText: 'Not found',
            headers: {},
            body: { data: [] },
          },
        });
      return {
        id,
        type: 'upload_collection',
        label: state.label,
        position: state.position,
        parent: state.parentId
          ? { id: state.parentId, type: 'upload_collection' }
          : null,
        children: [...records.values()]
          .filter((child) => child.parentId === id)
          .map((child) => ({ id: child.id, type: 'upload_collection' })),
      };
    };
    client.uploadCollections = {
      list: async (query?: { filter?: { ids?: string } }) => {
        const ids = query?.filter?.ids?.split(',');
        if (ids) {
          assert(ids.length <= 30);
          filteredReads.push(ids);
        }
        return [...records.keys()]
          .filter((id) => !ids || ids.includes(id))
          .map(resource);
      },
      find: async (id: string) => resource(id),
      create: async (body: {
        id: string;
        label: string;
        parent?: { id: string } | null;
        position?: number;
      }) => {
        mock.events.push(`collection-create:${body.id}`);
        assert(!records.has(body.id));
        const parentId = body.parent?.id ?? null;
        assert(
          ![...records.values()].some(
            (state) =>
              state.parentId === parentId && state.label === body.label,
          ),
          'native collection label uniqueness',
        );
        const siblings = [...records.values()].filter(
          (state) => state.parentId === parentId,
        );
        const position =
          body.position ??
          (siblings.length
            ? Math.max(...siblings.map((state) => state.position))
            : 0) + 1;
        // Native create accepts an explicit index without shifting peers.
        records.set(
          body.id,
          collectionState(body.id, position, parentId, body.label),
        );
        return resource(body.id);
      },
      update: async (
        id: string,
        body: {
          label?: string;
          parent?: { id: string } | null;
          position?: number;
        },
      ) => {
        mock.events.push(`collection-update:${id}`);
        const current = records.get(id)!;
        const parentId =
          'parent' in body ? body.parent?.id ?? null : current.parentId;
        const position = body.position ?? current.position;
        for (
          let ancestor = parentId;
          ancestor;
          ancestor = records.get(ancestor)?.parentId ?? null
        )
          assert.notEqual(ancestor, id, 'native collection parent cycle');
        assert(
          ![...records.values()].some(
            (state) =>
              state.id !== id &&
              state.parentId === parentId &&
              state.label === (body.label ?? current.label),
          ),
          'native collection label uniqueness',
        );
        for (const sibling of records.values()) {
          if (sibling.id === id) continue;
          if (parentId === current.parentId) {
            if (
              sibling.parentId === parentId &&
              sibling.position >= Math.min(current.position, position) &&
              sibling.position <= Math.max(current.position, position)
            )
              sibling.position += position < current.position ? 1 : -1;
          } else {
            if (
              sibling.parentId === current.parentId &&
              sibling.position >= current.position
            )
              sibling.position--;
            if (sibling.parentId === parentId && sibling.position >= position)
              sibling.position++;
          }
        }
        records.set(
          id,
          collectionState(id, position, parentId, body.label ?? current.label),
        );
        afterUpdate?.();
        afterUpdate = undefined;
        return resource(id);
      },
      destroy: async (id: string) => {
        mock.events.push(`collection-delete:${id}`);
        assert.equal(resource(id).children.length, 0);
        records.delete(id); // Native deletion leaves sibling position gaps.
      },
    } as unknown as Client['uploadCollections'];
    return client;
  };
  return {
    states,
    filteredReads,
    afterUpdate: (hook: () => void) => {
      afterUpdate = hook;
    },
  };
}

function uploadFixture() {
  return {
    id: 'eeeeeeeeeeeeeeeeeeeeee',
    type: 'upload',
    attributes: {
      basename: 'original',
      filename: 'original.txt',
      format: 'txt',
      md5: createHash('md5').update('old').digest('hex'),
      size: 3,
      url: 'https://assets.example/original.txt',
      notes: 'baseline',
      author: null as string | null,
      copyright: null as string | null,
      tags: [],
      default_field_metadata: {
        alt: {},
        title: {},
        custom_data: {},
        focal_point: null,
        poster_time: null,
      },
    },
    relationships: { upload_collection: { data: null } },
  };
}

function withFileTitle(mock: ReturnType<typeof sdk>, upload = uploadFixture()) {
  const originalClient = mock.client;
  mock.client = (environmentId: string) => {
    const client = originalClient(environmentId);
    const fields = client.fields.list.bind(client.fields);
    client.fields.list = (async (
      ...args: Parameters<Client['fields']['list']>
    ) =>
      (await fields(...args)).map((field) => ({
        ...field,
        field_type: 'file',
      }))) as Client['fields']['list'];
    client.uploads.rawList = (async () => ({
      data: [clone(upload)],
      meta: { total_count: 1 },
    })) as unknown as Client['uploads']['rawList'];
    client.uploads.find = (async () =>
      clone(upload)) as unknown as Client['uploads']['find'];
    const update = client.items.update.bind(client.items);
    client.items.update = ((id, body) =>
      update(id, serializeRawItem(body))) as Client['items']['update'];
    return client;
  };
  const state = canonicalUpload(upload);
  return {
    kind: 'upload' as const,
    id: upload.id,
    action: 'noop' as const,
    guard: { hash: state.hash },
    diagnostics: [],
  };
}

const blockModelId = 'f'.repeat(22);
function blockValue(
  id: string,
  text: string | number | null = 'Block',
): JsonObject {
  return { id, __itemTypeId: blockModelId, attributes: { text } };
}

function withBlockField(
  mock: ReturnType<typeof sdk>,
  defaultValue: string | number | null = null,
  fieldType: 'string' | 'integer' = 'string',
) {
  const originalClient = mock.client;
  const defaults = new Map<string, string | number | null>();
  mock.client = (environmentId) => {
    const client = originalClient(environmentId);
    if (!defaults.has(environmentId)) defaults.set(environmentId, defaultValue);
    const listTypes = client.itemTypes.list.bind(client.itemTypes);
    const listFields = client.fields.list.bind(client.fields);
    client.itemTypes.list = (async () => {
      const models = await listTypes();
      return [
        ...models,
        {
          ...models[0],
          id: blockModelId,
          api_key: 'text_block',
          name: 'Text block',
          modular_block: true,
          draft_mode_active: false,
          sortable: false,
          tree: false,
          workflow: null,
        },
      ];
    }) as Client['itemTypes']['list'];
    client.fields.list = (async (id: string) =>
      id === blockModelId
        ? [
            {
              id: 'g'.repeat(22),
              api_key: 'text',
              field_type: fieldType,
              localized: false,
              validators: {},
              default_value: defaults.get(environmentId),
            },
          ]
        : [
            ...(await listFields(id)),
            {
              id: 'h'.repeat(22),
              api_key: 'body',
              field_type: 'rich_text',
              localized: false,
              validators: {},
              default_value: null,
            },
          ]) as unknown as Client['fields']['list'];
    const findField = client.fields.find.bind(client.fields);
    const updateField = client.fields.update.bind(client.fields);
    client.fields.find = (async (id: string) =>
      id === 'g'.repeat(22)
        ? { validators: {}, default_value: defaults.get(environmentId) }
        : findField(id)) as Client['fields']['find'];
    client.fields.update = (async (
      id: string,
      body: { default_value: string | number | null },
    ) => {
      if (id !== 'g'.repeat(22))
        return updateField(
          id,
          body as Parameters<Client['fields']['update']>[1],
        );
      mock.events.push('block-field-settings');
      defaults.set(environmentId, body.default_value);
      return { validators: {}, default_value: body.default_value };
    }) as unknown as Client['fields']['update'];
    const update = client.items.update.bind(client.items);
    client.items.update = (async (id: string, body: JsonObject) => {
      const record = mock.environments.get(environmentId)!.get(id)!;
      const schema = await fetchSchema(client, environmentId);
      const next = canonicalFields(
        { ...record.current, ...body },
        modelId,
        schema,
      );
      const before = inspectRecord(record, schema).blockOwners;
      const after = inspectRecord(
        { ...record, current: next, published: null },
        schema,
      ).blockOwners;
      for (const owner of after) {
        if (before.some((prior) => prior.blockId === owner.blockId))
          assert(
            before.some(
              (prior) =>
                prior.slice === 'current' &&
                prior.blockId === owner.blockId &&
                prior.path === owner.path &&
                prior.modelId === owner.modelId,
            ),
            'native block must belong to the old current field/locale',
          );
      }
      // Native creation fills explicit null from the field default, while an
      // existing current block may retain null. Model orphan recreation too.
      for (const block of (Array.isArray(next.body)
        ? next.body
        : []) as JsonObject[]) {
        const attributes = block.attributes as JsonObject;
        if (
          !before.some((owner) => owner.blockId === block.id) &&
          attributes.text === null &&
          defaults.get(environmentId) !== null
        )
          attributes.text = defaults.get(environmentId)!;
      }
      const result = await update(id, body);
      record.current = next;
      record.hash = recordHash(record);
      return result;
    }) as Client['items']['update'];
    return client;
  };
  return { defaults };
}

async function bundle(
  directory: string,
  mock: ReturnType<typeof sdk>,
  entries: PlanEntry[],
  modelIds: string[] = [modelId],
  temporarySchemaChanges: TemporarySchemaChange[] = [],
  fetchFn?: Parameters<typeof writeBundle>[0]['fetchFn'],
): Promise<string> {
  const store = new SnapshotStore(directory);
  try {
    for (const entry of entries) store.putPlan(entry);
    for (const record of mock.environments.get('destination')!.values()) {
      if (!entries.some((entry) => entry.id === record.id)) {
        const preserved = { ...plan(record, record), action: 'noop' as const };
        store.putPlan(preserved);
        entries.push(preserved);
      }
    }
    const schema = await fetchSchema(mock.client('destination'), 'destination');
    const counts: PlanCounts = Object.fromEntries(
      ['record', 'upload', 'collection'].map((kind) => [
        kind,
        { create: 0, update: 0, delete: 0, noop: 0, skip: 0 },
      ]),
    ) as PlanCounts;
    for (const entry of entries) counts[entry.kind][entry.action]++;
    return await writeBundle({
      fetchFn,
      store,
      outputPath: join(directory, 'bundle'),
      metadata: {
        source: { siteId: 'source-site', environmentId: 'source' },
        destination: { siteId: 'site', environmentId: 'destination' },
        schema,
        options: {
          modelIds,
          uploads: 'all',
          includeDeletions: true,
          allowPartial: entries.some((entry) => entry.action === 'skip'),
          allowTemporarySchemaChanges: temporarySchemaChanges.length > 0,
        },
        counts,
        temporarySchemaChanges,
      },
    });
  } finally {
    store.dispose();
  }
}

describe('apply executor with the SDK resource contract', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'apply-executor-test-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('copies sparse collection positions and rejects position-only baseline drift', async () => {
    for (const drift of [false, true]) {
      const runDirectory = join(directory, String(drift));
      mkdirSync(runDirectory);
      const a = collectionState('aaaaaaaaaaaaaaaaaaaaaa', 1);
      const b = collectionState('bbbbbbbbbbbbbbbbbbbbbb', 5);
      const desired = [collectionState(a.id, 5), collectionState(b.id, 10)];
      const mock = sdk();
      const collections = withCollections(mock, [a, b]);
      const bundlePath = await bundle(runDirectory, mock, [
        collectionPlan(a, desired[0]),
        collectionPlan(b, desired[1]),
      ]);
      if (drift) collections.states.get('destination')!.get(a.id)!.position = 2;
      const execution = applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      if (drift) {
        await assert.rejects(execution, /bundled baseline/);
        assert.deepEqual(mock.events, []);
      } else {
        const result = await execution;
        assert.deepEqual(
          desired.map(
            (state) =>
              collections.states.get(result.environmentId)!.get(state.id)!
                .position,
          ),
          [5, 10],
        );
      }
    }
  });

  it('reconciles collection create, move and delete side effects while preserving sibling gaps', async () => {
    const ids = 'pqabxydn'.split('').map((letter) => letter.repeat(22));
    const [p, q, a, b, x, y, d, n] = ids;
    const originals = [
      collectionState(p, 1),
      collectionState(q, 2),
      collectionState(d, 3),
      collectionState(a, 1, p),
      collectionState(b, 5, p),
      collectionState(x, 1, q),
      collectionState(y, 6, q),
    ];
    const desired = [
      collectionState(p, 1),
      collectionState(q, 2),
      collectionState(a, 4, q),
      collectionState(b, 5, p),
      collectionState(x, 1, q),
      collectionState(y, 6, q),
      collectionState(n, 2, p),
    ];
    const mock = sdk();
    const collections = withCollections(mock, originals);
    const entries = desired.map((state) =>
      collectionPlan(
        originals.find((old) => old.id === state.id) ?? null,
        state,
      ),
    );
    entries.push(
      collectionPlan(originals.find((state) => state.id === d)!, null),
    );
    const bundlePath = await bundle(directory, mock, entries);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const written = collections.states.get(result.environmentId)!;
    assert(!written.has(d));
    for (const state of desired)
      assert.deepEqual(
        {
          parent: written.get(state.id)!.parentId,
          position: written.get(state.id)!.position,
        },
        { parent: state.parentId, position: state.position },
      );
    assert(collections.filteredReads.length > 0);
    assert(collections.filteredReads.every((ids) => ids.length <= 30));
  });

  it('reconciles creation before an existing root and deletion of a shifted owned root', async () => {
    const original = collectionState(
      'oLPhICAoQxOVRZGPV3WGdg',
      1,
      null,
      'Existing',
    );
    const deleted = collectionState(
      'WrQrcRDJRX6SakYFxUIulA',
      2,
      null,
      'Owned deletion',
    );
    const parent = collectionState(
      '4DfUiJA_TW-Vj3--VvnXGg',
      1,
      null,
      'Created parent',
    );
    const child = collectionState(
      'olgBAw2WQxi2II0a1y8HFA',
      1,
      parent.id,
      'Created child',
    );
    const shifted = collectionState(original.id, 2, null, original.label);
    const mock = sdk();
    const collections = withCollections(mock, [original, deleted]);
    const bundlePath = await bundle(directory, mock, [
      collectionPlan(original, shifted),
      collectionPlan(deleted, null),
      collectionPlan(null, parent),
      collectionPlan(null, child),
    ]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const actual = collections.states.get(result.environmentId)!;
    assert(!actual.has(deleted.id));
    assert.equal(actual.get(parent.id)!.position, 1);
    assert.equal(actual.get(original.id)!.position, 2);
    assert.equal(actual.get(child.id)!.position, 1);
    assert.equal(actual.get(child.id)!.parentId, parent.id);
  });

  it('orders collection moves through unchanged descendants using the full intended tree', async () => {
    const a = collectionState('a'.repeat(22), 1);
    const c = collectionState('c'.repeat(22), 1, a.id);
    const b = collectionState('b'.repeat(22), 1, c.id);
    const wantedC = collectionState(c.id, 1);
    const wantedA = collectionState(a.id, 1, b.id);
    const mock = sdk();
    const collections = withCollections(mock, [a, b, c]);
    const bundlePath = await bundle(directory, mock, [
      collectionPlan(a, wantedA),
      collectionPlan(b, b),
      collectionPlan(c, wantedC),
    ]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const actual = collections.states.get(result.environmentId)!;
    assert.equal(actual.get(c.id)!.parentId, null);
    assert.equal(actual.get(b.id)!.parentId, c.id);
    assert.equal(actual.get(a.id)!.parentId, b.id);
    assert(
      mock.events.indexOf(`collection-update:${c.id}`) <
        mock.events.indexOf(`collection-update:${a.id}`),
    );
  });

  it('rejects an observed collection sibling edit after a move before later writes overwrite it', async () => {
    const originals = ['a', 'b', 'c'].map((letter, index) =>
      collectionState(letter.repeat(22), index + 1),
    );
    const desired = originals.map((state, index) =>
      collectionState(state.id, index === 0 ? 3 : index),
    );
    const mock = sdk();
    const collections = withCollections(mock, originals);
    const bundlePath = await bundle(
      directory,
      mock,
      originals.map((state, index) => collectionPlan(state, desired[index])),
    );
    collections.afterUpdate(() => {
      collections.states.get('destination')!.get(originals[1].id)!.position = 8;
    });
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      /affected sibling changed during/,
    );
    assert.equal(
      collections.states.get('destination')!.get(originals[1].id)!.position,
      8,
    );
    assert.deepEqual(mock.events, [`collection-update:${originals[0].id}`]);
  });

  it('preserves untouched duplicate collection indexes while creating and deleting explicit positions', async () => {
    const originals = [
      collectionState('a'.repeat(22), 1),
      collectionState('b'.repeat(22), 1),
      collectionState('c'.repeat(22), 9),
    ];
    const created = collectionState('d'.repeat(22), 1);
    const relabeled = collectionState(originals[2].id, 9, null, 'Renamed');
    const mock = sdk();
    const collections = withCollections(mock, originals);
    const bundlePath = await bundle(directory, mock, [
      collectionPlan(originals[0], null),
      collectionPlan(originals[1], originals[1]),
      collectionPlan(originals[2], relabeled),
      collectionPlan(null, created),
    ]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const actual = collections.states.get(result.environmentId)!;
    assert(!actual.has(originals[0].id));
    assert.equal(actual.get(originals[1].id)!.position, 1);
    assert.equal(actual.get(created.id)!.position, 1);
    assert.equal(actual.get(relabeled.id)!.position, 9);
    assert.equal(actual.get(relabeled.id)!.label, 'Renamed');
    assert.deepEqual(collections.filteredReads, []);
  });

  it('rejects imported final and transient collection label conflicts before a fork or write', async () => {
    for (const outcome of [
      'create-conflict',
      'transient-conflict',
      'safe-handoff',
    ]) {
      const runDirectory = join(directory, outcome);
      mkdirSync(runDirectory);
      const a = collectionState(
        'a'.repeat(22),
        1,
        null,
        outcome === 'safe-handoff' ? 'Beta' : 'Alpha',
      );
      const b = collectionState(
        'b'.repeat(22),
        2,
        null,
        outcome === 'safe-handoff' ? 'Alpha' : 'Beta',
      );
      const mock = sdk();
      const collections = withCollections(mock, [a, b]);
      const entries =
        outcome === 'create-conflict'
          ? [
              collectionPlan(a, a),
              collectionPlan(b, b),
              collectionPlan(
                null,
                collectionState('c'.repeat(22), 3, null, 'Alpha'),
              ),
            ]
          : [
              collectionPlan(
                a,
                collectionState(
                  a.id,
                  1,
                  null,
                  outcome === 'safe-handoff' ? 'Gamma' : 'Beta',
                ),
              ),
              collectionPlan(
                b,
                collectionState(
                  b.id,
                  2,
                  null,
                  outcome === 'safe-handoff' ? 'Beta' : 'Gamma',
                ),
              ),
            ];
      const bundlePath = await bundle(runDirectory, mock, entries);
      const execution = applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      if (outcome === 'safe-handoff') {
        const result = await execution;
        assert.equal(
          collections.states.get(result.environmentId)!.get(a.id)!.label,
          'Gamma',
        );
        assert.equal(
          collections.states.get(result.environmentId)!.get(b.id)!.label,
          'Beta',
        );
      } else {
        await assert.rejects(
          execution,
          (error) =>
            error instanceof ContentError &&
            error.code === 'COLLECTION_LABEL_CONFLICT',
        );
        assert.deepEqual(mock.events, []);
      }
    }
  });

  it('rejects imported collection positions that cannot converge before any writes', async () => {
    const a = collectionState('a'.repeat(22), 1);
    const b = collectionState('b'.repeat(22), 2);
    const mock = sdk();
    withCollections(mock, [a, b]);
    const bundlePath = await bundle(directory, mock, [
      collectionPlan(a, collectionState(a.id, 2)),
      collectionPlan(b, b),
    ]);
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      (error) =>
        error instanceof ContentError &&
        error.code === 'COLLECTION_ORDERING_CONFLICT',
    );
    assert.deepEqual(mock.events, []);
  });

  it('rejects imported missing, deleted and cyclic collection parents before any writes', async () => {
    for (const reason of ['missing', 'deleted', 'cycle']) {
      const runDirectory = join(directory, reason);
      mkdirSync(runDirectory);
      const a = collectionState('a'.repeat(22), 1);
      const b = collectionState('b'.repeat(22), 2);
      const child = collectionState(b.id, 1, a.id);
      const original =
        reason === 'missing' ? [] : reason === 'cycle' ? [a, child] : [a, b];
      const mock = sdk();
      withCollections(mock, original);
      const entries: CollectionPlan[] =
        reason === 'missing'
          ? [collectionPlan(null, collectionState(a.id, 1, b.id))]
          : reason === 'cycle'
            ? [
                collectionPlan(a, collectionState(a.id, 1, b.id)),
                collectionPlan(child, child),
              ]
            : [
                collectionPlan(a, collectionState(a.id, 1, b.id)),
                collectionPlan(b, null),
              ];
      const bundlePath = await bundle(runDirectory, mock, entries);
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: defaults,
        }),
        (error) =>
          error instanceof ContentError && error.code.startsWith('COLLECTION_'),
      );
      assert.deepEqual(mock.events, []);
    }
  });

  it('guards only the affected collection range and does no sibling reads for a label-only change', async () => {
    for (const move of [false, true]) {
      const runDirectory = join(directory, String(move));
      mkdirSync(runDirectory);
      const originals = Array.from({ length: 80 }, (_, index) =>
        collectionState(
          createHash('sha256')
            .update(`collection ${index}`)
            .digest('base64url')
            .slice(0, 22),
          index + 1,
        ),
      );
      const intended = originals.map((state, index) =>
        collectionState(
          state.id,
          move && index === 39
            ? 41
            : move && index === 40
              ? 40
              : state.position,
          null,
          index === 39 ? 'Renamed' : state.label,
        ),
      );
      const mock = sdk();
      const collections = withCollections(mock, originals);
      const bundlePath = await bundle(
        runDirectory,
        mock,
        originals.map((state, index) => collectionPlan(state, intended[index])),
      );
      await applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      if (move) assert(collections.filteredReads.length > 0);
      else assert.deepEqual(collections.filteredReads, []);
      assert(
        collections.filteredReads
          .flat()
          .every((id) => id === originals[39].id || id === originals[40].id),
      );
    }
  });

  it('uses a fresh regular fork and accurately copies published then current state', async () => {
    const baseline = state({ title: 'old' });
    const desired = state(
      { title: 'draft' },
      {
        published: { title: 'public' },
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        validity: { current: true, published: true },
      },
    );
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.notEqual(result.environmentId, 'destination');
    assert.equal(
      mock.environments.get('destination')!.get(recordId)!.current.title,
      'old',
    );
    const written = mock.environments.get(result.environmentId)!.get(recordId)!;
    assert.deepEqual(written.current, desired.current);
    assert.deepEqual(written.published, desired.published);
    assert.equal(written.firstPublishedAt, desired.firstPublishedAt);
    assert(!mock.events.some((event) => event.startsWith('delete-fork')));
  });

  it('rejects content changed after a metadata write before publication can overwrite it', async () => {
    const baseline = state({ title: 'old' });
    const desired = state(
      { title: 'reviewed' },
      {
        published: { title: 'reviewed' },
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        validity: { current: true, published: true },
      },
    );
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    mock.afterNextUpdate((record) => {
      record.current.title = 'concurrent editor';
      record.currentVersion = String(Number(record.currentVersion) + 1);
    });
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      /changed during|did not converge/,
    );
    assert.equal(
      mock.environments.get('destination')!.get(recordId)!.current.title,
      'concurrent editor',
    );
    assert(!mock.events.some((event) => event.startsWith('publish:')));
  });

  it('rejects content changed during schedule cancellation before later content writes', async () => {
    const baseline = state(
      { title: 'old' },
      {
        schedules: {
          publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const desired = state({ title: 'reviewed' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    mock.afterNextScheduleCancellation((record) => {
      record.current.title = 'concurrent editor';
      record.currentVersion = String(Number(record.currentVersion) + 1);
    });
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      // The editor's content is not the original, so the original schedule is
      // not re-armed over it; the record is reported instead.
      /changed during.*schedules were left as they are/,
    );
    const actual = mock.environments.get('destination')!.get(recordId)!;
    assert.equal(actual.current.title, 'concurrent editor');
    assert.deepEqual(actual.schedules, {
      publication: null,
      unpublishing: null,
    });
    assert(!mock.events.some((event) => event.startsWith('update:')));
  });

  it('rejects a concurrent publication observed after creation before replacing it', async () => {
    const desired = state(
      { title: 'reviewed' },
      {
        published: { title: 'reviewed' },
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        validity: { current: true, published: true },
      },
    );
    const mock = sdk();
    const bundlePath = await bundle(directory, mock, [plan(null, desired)]);
    mock.afterNextCreate((record) => {
      record.published = { title: 'concurrent publication' };
      record.validity.published = true;
      record.publishedUpdatedAt = '2020-01-02T00:00:00.000Z';
    });
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      /changed during/,
    );
    assert.deepEqual(
      mock.environments.get('destination')!.get(recordId)!.published,
      { title: 'concurrent publication' },
    );
    assert(!mock.events.some((event) => event.startsWith('publish:')));
  });

  it('creates a workflow record in its initial stage before restoring the reviewed stage', async () => {
    const desired = state({ title: 'new' }, { stage: 'review' });
    const mock = sdk();
    mock.withWorkflow();
    const bundlePath = await bundle(directory, mock, [plan(null, desired)]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.equal(
      mock.environments.get(result.environmentId)!.get(recordId)!.stage,
      'review',
    );
  });

  it('accepts automatic publication during creates and updates on models without draft mode', async () => {
    for (const create of [true, false]) {
      const runDirectory = join(directory, String(create));
      mkdirSync(runDirectory);
      const baseline = state(
        { title: 'old' },
        {
          published: { title: 'old' },
          publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
          firstPublishedAt: '2019-01-01T00:00:00.000Z',
          validity: { current: true, published: true },
        },
      );
      const desired = state(
        { title: 'new' },
        {
          ...baseline,
          current: { title: 'new' },
          published: { title: 'new' },
        },
      );
      const mock = sdk(create ? [] : [baseline]);
      mock.withoutDraftMode();
      const bundlePath = await bundle(runDirectory, mock, [
        plan(create ? null : baseline, desired),
      ]);
      const result = await applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      const actual = mock.environments
        .get(result.environmentId)!
        .get(recordId)!;
      assert.deepEqual(actual.current, desired.current);
      assert.deepEqual(actual.published, desired.published);
    }
  });

  it('creates mutually linked records without draft mode before publication writes set their links', async () => {
    const otherId = 'dddddddddddddddddddddd';
    const desired = [
      { id: recordId, fields: { title: 'a', link: otherId } },
      { id: otherId, fields: { title: 'b', link: recordId } },
    ].map(({ id, fields }) =>
      state(fields, {
        id,
        published: fields,
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        validity: { current: true, published: true },
      }),
    );
    // Creation also publishes on this model, so both seeds defer the mutual
    // link and no publish edge orders the records; publication sets the links.
    const entries = desired.map((record) => {
      const entry = plan(null, record);
      entry.execution = {
        ...entry.execution,
        creationFields: { ...record.current, link: null },
      };
      entry.safety.currentReferences = [record.current.link as string];
      entry.safety.publishedReferences = [record.current.link as string];
      return entry;
    });
    const mock = sdk();
    mock.withoutDraftMode();
    mock.withLinks();
    const bundlePath = await bundle(directory, mock, entries);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    for (const record of desired) {
      const actual = mock.environments
        .get(result.environmentId)!
        .get(record.id)!;
      assert.deepEqual(actual.current, record.current);
      assert.deepEqual(actual.published, record.published);
    }
    const writes = mock.events.filter((event) =>
      /^(create|update):/.test(event),
    );
    assert.deepEqual(writes.slice(0, 2).sort(), [
      `create:${recordId}`,
      `create:${otherId}`,
    ]);
    assert.deepEqual(writes.slice(2).sort(), [
      `update:${recordId}`,
      `update:${otherId}`,
    ]);
  });

  it('publishes a cycle of new linked records in two steps', async () => {
    const otherId = 'dddddddddddddddddddddd';
    const desired = [
      { id: recordId, fields: { title: 'a', link: otherId } },
      { id: otherId, fields: { title: 'b', link: recordId } },
    ].map(({ id, fields }) =>
      state(fields, {
        id,
        published: fields,
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        validity: { current: true, published: true },
      }),
    );
    const entries = (provisional: boolean) =>
      desired.map((record, index) => {
        const entry = plan(null, record);
        entry.execution = {
          ...entry.execution,
          creationFields: { ...record.current, link: null },
          publishOrder: index,
          ...(provisional && index === 0
            ? { provisionalPublished: { ...record.current, link: null } }
            : {}),
        };
        entry.safety.currentReferences = [record.current.link as string];
        entry.safety.publishedReferences = [record.current.link as string];
        return entry;
      });
    for (const provisional of [false, true]) {
      const runDirectory = join(directory, String(provisional));
      mkdirSync(runDirectory);
      const mock = sdk();
      mock.withLinks();
      // DatoCMS refuses to publish a record linking to an unpublished one.
      const environmentClient = (environmentId: string) => {
        const client = mock.client(environmentId);
        const publish = client.items.publish.bind(client.items);
        client.items.publish = (async (id: string, ...rest: unknown[]) => {
          const records = mock.environments.get(environmentId)!;
          const link = records.get(id)?.current.link as string | null;
          if (link && link !== id && !records.get(link)?.published)
            throw new Error(`${id} links to unpublished record ${link}`);
          return Reflect.apply(publish, client.items, [id, ...rest]);
        }) as typeof client.items.publish;
        return client;
      };
      const bundlePath = await bundle(runDirectory, mock, entries(provisional));
      const run = applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: environmentClient,
        bundlePath,
        options: defaults,
      });
      if (!provisional) {
        // Without the provisional step, the dependency guard refuses first.
        await assert.rejects(run, /dependency \w+ is not published/);
        continue;
      }
      const result = await run;
      for (const record of desired) {
        const actual = mock.environments
          .get(result.environmentId)!
          .get(record.id)!;
        assert.deepEqual(actual.current, record.current);
        assert.deepEqual(actual.published, record.published);
      }
      // The first record publishes without its link, the second publishes,
      // and the first is republished with the link restored.
      assert.deepEqual(
        mock.events.filter((event) => event.startsWith('publish:')),
        [`publish:${recordId}`, `publish:${otherId}`, `publish:${recordId}`],
      );
    }
  });

  it('rejects a provisional publication that changes more than cycle links', async () => {
    const otherId = 'dddddddddddddddddddddd';
    const desired = [
      { id: recordId, fields: { title: 'a', link: otherId } },
      { id: otherId, fields: { title: 'b', link: recordId } },
    ].map(({ id, fields }) =>
      state(fields, {
        id,
        published: fields,
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        validity: { current: true, published: true },
      }),
    );
    const entries = desired.map((record, index) => {
      const entry = plan(null, record);
      entry.execution = {
        ...entry.execution,
        creationFields: { ...record.current, link: null },
        publishOrder: index,
        ...(index === 0
          ? { provisionalPublished: { title: 'not reviewed', link: null } }
          : {}),
      };
      entry.safety.currentReferences = [record.current.link as string];
      entry.safety.publishedReferences = [record.current.link as string];
      return entry;
    });
    const mock = sdk();
    mock.withLinks();
    const bundlePath = await bundle(directory, mock, entries);
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'INVALID_BUNDLE' &&
        /changes more than cycle links/.test(error.message),
    );
    assert.deepEqual(
      mock.events.filter((event) => /^(create|update|publish):/.test(event)),
      [],
    );
  });

  it('publishes, unpublishes, and deletes records with self references without bypassing external referrers', async () => {
    for (const action of [
      'publish',
      'unpublish',
      'delete',
      'external-delete',
    ]) {
      const runDirectory = join(directory, action);
      mkdirSync(runDirectory);
      const baseline = state(
        { title: 'self', link: recordId },
        {
          published:
            action === 'publish' ? null : { title: 'self', link: recordId },
          firstPublishedAt: '2019-01-01T00:00:00.000Z',
          publishedUpdatedAt:
            action === 'publish' ? null : '2020-01-02T00:00:00.000Z',
          validity: {
            current: true,
            published: action === 'publish' ? null : true,
          },
        },
      );
      const desired = action.includes('delete')
        ? null
        : state(baseline.current, {
            ...baseline,
            published: action === 'publish' ? baseline.current : null,
            publishedUpdatedAt:
              action === 'publish' ? '2020-01-02T00:00:00.000Z' : null,
            validity: {
              current: true,
              published: action === 'publish' ? true : null,
            },
          });
      const external = state(
        { title: 'external', link: recordId },
        { id: 'dddddddddddddddddddddd' },
      );
      const mock = sdk(
        action === 'external-delete' ? [baseline, external] : [baseline],
      );
      mock.withLinks();
      const entry = plan(baseline, desired);
      entry.safety.currentReferences = desired ? [recordId] : [];
      entry.safety.publishedReferences = desired?.published ? [recordId] : [];
      const entries = [entry];
      if (action === 'external-delete') {
        const preserved = {
          ...plan(external, external),
          action: 'noop' as const,
        };
        preserved.safety.currentReferences = [recordId];
        entries.push(preserved);
      }
      const bundlePath = await bundle(runDirectory, mock, entries);
      const apply = applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      if (action === 'external-delete') {
        await assert.rejects(apply, /still has live referrers/);
      } else {
        const result = await apply;
        const written = mock.environments
          .get(result.environmentId)!
          .get(recordId);
        if (desired) assert.deepEqual(written?.published, desired.published);
        else assert.equal(written, undefined);
      }
    }
  });

  it('runs independent record writes concurrently within a dependency level', async () => {
    const originals = Array.from({ length: 4 }, (_, index) =>
      state(
        { title: `old ${index}` },
        {
          id: createHash('sha256')
            .update(`parallel ${index}`)
            .digest('base64url')
            .slice(0, 22),
        },
      ),
    );
    const entries = originals.map((original, index) =>
      plan(original, state({ title: `new ${index}` }, { id: original.id })),
    );
    const mock = sdk(originals);
    mock.withDelayedUpdates();
    const bundlePath = await bundle(directory, mock, entries);
    await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.equal(mock.stats.maximumUpdates, 2);
  });

  it('seeks execution ranks and collection children through their expression indexes', async () => {
    const baseline = state({ title: 'old' }, { position: 0 });
    const mock = sdk([baseline]);
    mock.setOrdered();
    const updated = plan(baseline, state({ title: 'new' }, { position: 0 }));
    const created = plan(
      null,
      state(
        { title: 'created' },
        { id: 'dddddddddddddddddddddd', position: 1 },
      ),
    );
    updated.execution!.updateOrder = 4;
    created.execution!.updateOrder = 7;
    const collectionA = collectionState('e'.repeat(22), 1);
    const collectionB = collectionState('f'.repeat(22), 2);
    withCollections(mock, [collectionA, collectionB]);
    const bundlePath = await bundle(directory, mock, [
      updated,
      created,
      collectionPlan(collectionA, collectionState(collectionA.id, 2)),
      collectionPlan(collectionB, collectionState(collectionB.id, 1)),
    ]);
    const inspected = new Set<SnapshotStore['database']>();
    const observed: string[][] = [];
    const collections: string[][] = [];
    const siblingLookups: string[][] = [];
    const putPlan = SnapshotStore.prototype.putPlan;
    SnapshotStore.prototype.putPlan = function (entry) {
      const database = this.database;
      if (!inspected.has(database)) {
        inspected.add(database);
        const prepare = database.prepare.bind(database);
        database.prepare = (sql) => {
          if (
            sql.startsWith('SELECT data FROM plan') &&
            sql.includes('$.execution.') &&
            sql.includes('=?')
          ) {
            const parameterCount = (sql.match(/\?/g) ?? []).length;
            const parameters =
              parameterCount === 3 ? ['create', 'update', 0] : ['create', 0];
            const details = prepare(`EXPLAIN QUERY PLAN ${sql}`)
              .all(...parameters)
              .map((row) => String(row.detail));
            observed.push(details);
            assert(
              details.some((detail) =>
                /USING INDEX apply_record_.*<expr>=\?/.test(detail),
              ),
              details.join('; '),
            );
          }
          if (sql.startsWith('WITH RECURSIVE ordered(')) {
            const details = prepare(`EXPLAIN QUERY PLAN ${sql}`)
              .all()
              .map((row) => String(row.detail));
            collections.push(details);
            assert(
              details.some((detail) =>
                /SEARCH p USING (?:COVERING )?INDEX apply_plan_.*_parent \(kind=\? AND <expr>=\?/.test(
                  detail,
                ),
              ),
              details.join('; '),
            );
          }
          if (
            sql.startsWith(
              'SELECT c.state_json,o.position FROM apply_collection_ordering',
            ) ||
            sql.startsWith('SELECT r.state_json FROM apply_ordering')
          ) {
            const record = sql.startsWith('SELECT r.');
            const details = prepare(`EXPLAIN QUERY PLAN ${sql}`)
              .all(...(record ? [modelId] : []))
              .map((row) => String(row.detail));
            siblingLookups.push(details);
            assert(
              details.some((detail) =>
                /SEARCH [rc] USING PRIMARY KEY \(side=\? AND id=\?\)/.test(
                  detail,
                ),
              ),
              details.join('; '),
            );
          }
          return prepare(sql);
        };
      }
      return putPlan.call(this, entry);
    };
    try {
      await applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      assert(
        observed.length >= 5,
        'creation, publication, and current phases must seek their requested ranks',
      );
      assert(
        collections.length >= 4,
        'both preflights and collection create/delete ordering must seek children',
      );
      assert(
        siblingLookups.length >= 3,
        'record and collection sibling reads must seek only the affected identities',
      );
    } finally {
      SnapshotStore.prototype.putPlan = putPlan;
    }
  });

  it('allows concurrent owners to read the same unchanged referenced record', async () => {
    const taxonomy = state(
      { title: 'taxonomy', link: null },
      { id: 'dddddddddddddddddddddd' },
    );
    const a = state({ title: 'old a', link: taxonomy.id });
    const b = state(
      { title: 'old b', link: taxonomy.id },
      { id: 'cccccccccccccccccccccc' },
    );
    const entries = [a, b].map((original) => {
      const entry = plan(
        original,
        state({ ...original.current, title: 'new' }, { id: original.id }),
      );
      entry.safety.currentReferences = [taxonomy.id];
      return entry;
    });
    const mock = sdk([a, b, taxonomy]);
    mock.withLinks();
    mock.withDelayedUpdates();
    const bundlePath = await bundle(directory, mock, entries);
    await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.equal(mock.stats.maximumUpdates, 2);
  });

  it('serializes a referenced writer with an owner that reads it in the same level', async () => {
    const dependency = state(
      { title: 'old dependency', link: null },
      { id: 'dddddddddddddddddddddd' },
    );
    const owner = state({ title: 'old owner', link: dependency.id });
    const ownerPlan = plan(
      owner,
      state({ title: 'new owner', link: dependency.id }),
    );
    ownerPlan.safety.currentReferences = [dependency.id];
    const dependencyPlan = plan(
      dependency,
      state({ title: 'new dependency', link: null }, { id: dependency.id }),
    );
    const mock = sdk([owner, dependency]);
    mock.withLinks();
    mock.withDelayedUpdates();
    const bundlePath = await bundle(directory, mock, [
      ownerPlan,
      dependencyPlan,
    ]);
    await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.equal(mock.stats.maximumUpdates, 1);
  });

  it('serializes record writes within an ordered model', async () => {
    const a = state({ title: 'old a' }, { position: 0 });
    const b = state(
      { title: 'old b' },
      { id: 'cccccccccccccccccccccc', position: 1 },
    );
    const mock = sdk([a, b]);
    mock.setOrdered();
    mock.withDelayedUpdates();
    const entries = [a, b].map((original) =>
      plan(
        original,
        state(
          { title: 'new' },
          { id: original.id, position: original.position },
        ),
      ),
    );
    const bundlePath = await bundle(directory, mock, entries);
    await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.equal(mock.stats.maximumUpdates, 1);
  });

  it('drains concurrent record requests before deleting a failed fork', async () => {
    const a = state({ title: 'old a' });
    const b = state({ title: 'old b' }, { id: 'cccccccccccccccccccccc' });
    const mock = sdk([a, b]);
    mock.withDelayedUpdates();
    mock.fail(a.id);
    const entries = [a, b].map((original) =>
      plan(original, state({ title: 'new' }, { id: original.id })),
    );
    const bundlePath = await bundle(directory, mock, entries);
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      /injected update failure/,
    );
    assert.equal(mock.stats.maximumUpdates, 2);
    assert.equal(mock.stats.activeUpdates, 0);
    assert.equal(mock.environments.size, 1);
  });

  it('refuses an already interrupted run before requesting any mutations', async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = sdk();
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath: join(directory, 'missing-bundle'),
        options: { ...defaults, signal: controller.signal },
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.deepEqual(mock.events, []);
  });

  it('removes a fork whose submitted creation finishes after interruption', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
    ]);
    const controller = new AbortController();
    mock.afterNextFork(() => controller.abort());
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, signal: controller.signal },
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.equal(mock.environments.size, 1);
    assert(mock.events.some((event) => event.startsWith('delete-fork:')));
    assert(!mock.events.some((event) => event.startsWith('update:')));
  });

  it('drains concurrent submitted writes before deleting an interrupted fork', async () => {
    const originals = Array.from({ length: 4 }, (_, index) =>
      state({ title: `old ${index}` }, { id: String(index).repeat(22) }),
    );
    const mock = sdk(originals);
    mock.withDelayedUpdates();
    const bundlePath = await bundle(
      directory,
      mock,
      originals.map((original) =>
        plan(original, state({ title: 'new' }, { id: original.id })),
      ),
    );
    const controller = new AbortController();
    mock.afterNextUpdate(() => controller.abort());
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, signal: controller.signal },
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.equal(mock.stats.activeUpdates, 0);
    assert.equal(
      mock.events.filter((event) => event.startsWith('update:')).length,
      2,
    );
    assert(mock.events.at(-1)?.startsWith('delete-fork:'));
    assert.equal(mock.environments.size, 1);
  });

  it('restores original schedules after an in-place interruption only on original content', async () => {
    for (const point of ['before content', 'after content']) {
      const runDirectory = join(directory, point.replace(' ', '-'));
      mkdirSync(runDirectory);
      const baseline = state(
        { title: 'old' },
        {
          schedules: {
            publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
            unpublishing: null,
          },
        },
      );
      const mock = sdk([baseline]);
      mock.requireField();
      const changes: TemporarySchemaChange[] = [
        {
          fieldId: 'cccccccccccccccccccccc',
          modelId,
          original: { validators: { required: {} }, defaultValue: 'automatic' },
          temporary: { validators: {}, defaultValue: null },
          reasons: ['temporary test validation'],
        },
      ];
      const bundlePath = await bundle(
        runDirectory,
        mock,
        [plan(baseline, state({ title: 'new' }))],
        [modelId],
        changes,
      );
      const controller = new AbortController();
      if (point === 'before content')
        mock.afterNextScheduleCancellation(() => controller.abort());
      else mock.afterNextUpdate(() => controller.abort());
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: {
            ...defaults,
            inPlace: true,
            allowTemporarySchemaChanges: true,
            signal: controller.signal,
          },
        }),
        (error: unknown) =>
          error instanceof ContentError &&
          (point === 'before content'
            ? error.code === 'INTERRUPTED'
            : error.code === 'APPLY_FAILED_REPAIR_INCOMPLETE' &&
              /content was changed by this run/.test(error.message)),
      );
      assert.deepEqual(mock.fieldStates.get('destination'), {
        validators: { required: {} },
        defaultValue: 'automatic',
      });
      const record = mock.environments.get('destination')!.get(recordId)!;
      if (point === 'before content') {
        assert.equal(record.current.title, 'old');
        assert.deepEqual(record.schedules, baseline.schedules);
        assert(mock.events.includes(`schedule-publication:${recordId}`));
      } else {
        // The run already wrote new content: re-arming the original schedule
        // would publish content nobody scheduled.
        assert.equal(record.current.title, 'new');
        assert.deepEqual(record.schedules, {
          publication: null,
          unpublishing: null,
        });
        assert(!mock.events.includes(`schedule-publication:${recordId}`));
        assert.equal(
          mock.events.filter((event) => event === 'field-settings').length,
          2,
        );
      }
    }
  });

  it('refuses to start when a schedule falls due within the schedule window', async () => {
    const otherId = 'dddddddddddddddddddddd';
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const unchanged = state(
      { title: 'scheduled' },
      {
        id: otherId,
        schedules: {
          publication: { at: soon, selective: null },
          unpublishing: null,
        },
      },
    );
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline, unchanged]);
    const preserved = {
      ...plan(unchanged, unchanged),
      action: 'noop' as const,
    };
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
      preserved,
    ]);
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'SCHEDULE_DUE_DURING_APPLY' &&
        error.details?.recordId === otherId,
    );
    assert.equal(mock.events.length, 0);
    // With the window disabled the run proceeds, and the unchanged record's
    // schedule is neither cancelled nor recreated.
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: { ...defaults, scheduleWindowMinutes: 0 },
    });
    assert.deepEqual(
      mock.events.filter((event) => event.endsWith(`:${otherId}`)),
      [],
    );
    assert.deepEqual(
      mock.environments.get(result.environmentId)!.get(otherId)!.schedules,
      unchanged.schedules,
    );
  });

  it('verifies content before restoring schedules only when writing in place', async () => {
    for (const inPlace of [false, true]) {
      const runDirectory = join(directory, String(inPlace));
      mkdirSync(runDirectory);
      const baseline = state({ title: 'old' });
      const mock = sdk([baseline]);
      const bundlePath = await bundle(runDirectory, mock, [
        plan(baseline, state({ title: 'new' })),
      ]);
      const logs: string[] = [];
      await applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace, log: (message) => logs.push(message) },
      });
      // A failed fork is deleted, so it needs only the final verification.
      assert.equal(
        logs.includes('Verifying final content before restoring schedules.'),
        inPlace,
      );
      assert(logs.includes('Verifying final content and schedules.'));
    }
  });

  it('repairs schedules and field settings left behind by a killed in-place run', async () => {
    const otherId = 'dddddddddddddddddddddd';
    const thirdId = 'ffffffffffffffffffffff';
    const ids = [recordId, otherId, thirdId];
    const original = (id: string) =>
      state(
        { title: 'old' },
        {
          id,
          schedules: {
            publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
            unpublishing: null,
          },
        },
      );
    const reviewed = (id: string) =>
      state(
        { title: 'new' },
        {
          id,
          schedules: {
            publication: { at: '2099-02-01T00:00:00.000Z', selective: null },
            unpublishing: null,
          },
        },
      );
    const mock = sdk(ids.map(original));
    mock.requireField();
    const changes: TemporarySchemaChange[] = [
      {
        fieldId: 'cccccccccccccccccccccc',
        modelId,
        original: { validators: { required: {} }, defaultValue: 'automatic' },
        temporary: { validators: {}, defaultValue: null },
        reasons: ['temporary test validation'],
      },
    ];
    const bundlePath = await bundle(
      directory,
      mock,
      ids.map((id) => plan(original(id), reviewed(id))),
      [modelId],
      changes,
    );
    // A killed run: rules still relaxed, every schedule cancelled, one record
    // already written, and one edited by someone else meanwhile.
    mock.fieldStates.set('destination', { validators: {}, defaultValue: null });
    const records = mock.environments.get('destination')!;
    records.get(otherId)!.current = { title: 'new' };
    records.get(thirdId)!.current = { title: 'someone else' };
    for (const record of records.values()) {
      record.schedules = { publication: null, unpublishing: null };
      record.currentVersion = String(Number(record.currentVersion) + 1);
      record.hash = recordHash(record);
    }
    const repair = () =>
      repairBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { allowPrimary: false },
      });
    await assert.rejects(repair(), (error: unknown) => {
      assert(error instanceof ContentError);
      assert.equal(error.code, 'REPAIR_INCOMPLETE');
      assert.equal(error.details?.restoredFields, 1);
      assert.equal(error.details?.restoredSchedules, 2);
      assert.equal(error.details?.problemCount, 1);
      assert.match(
        error.message,
        new RegExp(`${thirdId}: content matches neither`),
      );
      return true;
    });
    assert.deepEqual(mock.fieldStates.get('destination'), {
      validators: { required: {} },
      defaultValue: 'automatic',
    });
    // Original content gets its original schedule back, written content gets
    // the bundle's, and the edited record is left for a person to decide.
    assert.deepEqual(
      records.get(recordId)!.schedules,
      original(recordId).schedules,
    );
    assert.deepEqual(
      records.get(otherId)!.schedules,
      reviewed(otherId).schedules,
    );
    assert.deepEqual(records.get(thirdId)!.schedules, {
      publication: null,
      unpublishing: null,
    });
    // Running it again changes nothing and reports the same record.
    const events = mock.events.length;
    await assert.rejects(
      repair(),
      (error: unknown) =>
        error instanceof ContentError &&
        error.details?.restoredSchedules === 0 &&
        error.details?.restoredFields === 0 &&
        error.details?.problemCount === 1,
    );
    assert.equal(mock.events.length, events);
    mock.setPrimary();
    await assert.rejects(
      repair(),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'PRIMARY_REQUIRES_APPROVAL',
    );
  });

  it('rejects another root project before a fork or content mutation', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
    ]);
    mock.wrongRootProject();
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      /project or schema/,
    );
    assert.deepEqual(mock.events, []);
  });

  it('rejects stale full-content baselines before creating a fork', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
    ]);
    mock.environments
      .get('destination')!
      .set(recordId, state({ title: 'concurrent edit' }));
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      /bundled baseline/,
    );
    assert.deepEqual(mock.events, []);
  });

  it('requires explicit primary authorization for in-place mutation', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
    ]);
    mock.setPrimary();
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      /allow-primary/,
    );
    assert.deepEqual(mock.events, []);
  });

  it('rejects a destination that is read-only or not ready before any mutation', async () => {
    for (const [index, override] of [
      { read_only_mode: true },
      { status: 'creating' },
    ].entries()) {
      const runDirectory = join(directory, String(index));
      mkdirSync(runDirectory);
      const baseline = state({ title: 'old' });
      const mock = sdk([baseline]);
      const bundlePath = await bundle(runDirectory, mock, [
        plan(baseline, state({ title: 'new' })),
      ]);
      const find = mock.root.environments.find;
      mock.root.environments.find = (async (id: string) => {
        const environment = await find(id);
        return id === 'destination'
          ? { ...environment, meta: { ...environment.meta, ...override } }
          : environment;
      }) as typeof find;
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: defaults,
        }),
        (error: unknown) =>
          error instanceof ContentError &&
          error.code === 'DESTINATION_UNAVAILABLE',
      );
      assert.deepEqual(mock.events, []);
    }
  });

  it('requires explicit consent for bundled temporary schema changes before any mutation', async () => {
    const change: TemporarySchemaChange = {
      modelId,
      fieldId: 'cccccccccccccccccccccc',
      original: { validators: { required: {} }, defaultValue: 'automatic' },
      temporary: { validators: {}, defaultValue: null },
      reasons: ['Explicit managed transition'],
    };
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    mock.requireField();
    const bundlePath = await bundle(
      directory,
      mock,
      [plan(baseline, state({ title: 'new' }))],
      [modelId],
      [change],
    );
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'TEMPORARY_SCHEMA_CHANGES_REQUIRED',
    );
    assert.deepEqual(mock.events, []);
    assert.deepEqual(mock.fieldStates.get('destination'), change.original);
  });

  it('rejects a destination schema changed since generation before a fork or content mutation', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
    ]);
    mock.fieldStates.set('destination', {
      validators: { required: {} },
      defaultValue: null,
    });
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'DESTINATION_MISMATCH',
    );
    assert.deepEqual(mock.events, []);
  });

  it('rejects and removes a fork whose schema or content differs from the verified destination', async () => {
    for (const drift of ['schema', 'content']) {
      const runDirectory = join(directory, drift);
      mkdirSync(runDirectory);
      const baseline = state({ title: 'old' });
      const mock = sdk([baseline]);
      const bundlePath = await bundle(runDirectory, mock, [
        plan(baseline, state({ title: 'new' })),
      ]);
      // A destination edit committed after its verified capture but before
      // the fork copied it appears only in the fork.
      mock.afterNextFork(() => {
        const forkId = [...mock.environments.keys()].find(
          (id) => id !== 'destination',
        )!;
        if (drift === 'schema')
          mock.fieldStates.set(forkId, {
            validators: { required: {} },
            defaultValue: null,
          });
        else
          mock.environments.get(forkId)!.get(recordId)!.current.title =
            'edited while forking';
      });
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: defaults,
        }),
        (error: unknown) =>
          error instanceof ContentError &&
          error.code ===
            (drift === 'schema' ? 'FORK_VERIFY_FAILED' : 'APPLY_CONFLICT'),
      );
      assert(!mock.events.some((event) => event.startsWith('update:')));
      assert(mock.events.some((event) => event.startsWith('delete-fork:')));
      assert.equal(mock.environments.size, 1);
    }
  });

  it('rejects a schema changed during writes before accepting the final content', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
    ]);
    const concurrent = { validators: { required: {} }, defaultValue: null };
    mock.afterNextUpdate(() => mock.fieldStates.set('destination', concurrent));
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'SCHEMA_CONFLICT',
    );
    assert(mock.events.includes(`update:${recordId}`));
    assert.deepEqual(mock.fieldStates.get('destination'), concurrent);
  });

  it('deletes only its own failed fork, and honors keep-failed-fork', async () => {
    for (const keepFailedFork of [false, true]) {
      const runDirectory = join(directory, String(keepFailedFork));
      mkdirSync(runDirectory);
      const baseline = state({ title: 'old' });
      const mock = sdk([baseline]);
      const bundlePath = await bundle(runDirectory, mock, [
        plan(baseline, state({ title: 'new' })),
      ]);
      mock.fail(recordId);
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: { ...defaults, keepFailedFork },
        }),
        (error: Error & { keptForkEnvironmentId?: string }) => {
          assert.match(error.message, /injected update failure/);
          assert.equal(
            error.keptForkEnvironmentId !== undefined &&
              error.keptForkEnvironmentId !== 'destination' &&
              mock.environments.has(error.keptForkEnvironmentId),
            keepFailedFork,
          );
          return true;
        },
      );
      assert(mock.environments.has('destination'));
      assert.equal(mock.environments.size, keepFailedFork ? 2 : 1);
      assert.equal(
        mock.events.some((event) => event.startsWith('delete-fork:')),
        !keepFailedFork,
      );
      assert(existsSync(bundlePath));
    }
  });

  it('rejects an expired requested schedule before any environment mutation', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const desired = state(
      { title: 'new' },
      {
        schedules: {
          publication: { at: '2000-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      /no longer in the future/,
    );
    assert.deepEqual(mock.events, []);
  });

  it('cancels managed schedules before writes and restores exact requested dates and scopes', async () => {
    const baseline = state(
      { title: 'old' },
      {
        schedules: {
          publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const desired = state(
      { title: 'new' },
      {
        schedules: {
          publication: {
            at: '2099-02-01T10:30:00.000Z',
            selective: { locales: ['en'], nonLocalized: false },
          },
          unpublishing: { at: '2099-03-01T14:00:00.000Z', locales: ['en'] },
        },
      },
    );
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const written = mock.environments.get(result.environmentId)!.get(recordId)!;
    assert.deepEqual(written.schedules, desired.schedules);
    assert(
      mock.events.indexOf(`cancel-publication:${recordId}`) <
        mock.events.indexOf(`update:${recordId}`),
    );
    assert(
      mock.events.indexOf(`schedule-publication:${recordId}`) >
        mock.events.indexOf(`update:${recordId}`),
    );
  });

  it('restores original destination schedules after an in-place failure', async () => {
    const baseline = state(
      { title: 'old' },
      {
        schedules: {
          publication: {
            at: '2099-01-01T00:00:00.000Z',
            selective: { locales: ['en'], nonLocalized: true },
          },
          unpublishing: null,
        },
      },
    );
    const desired = state({ title: 'new' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    mock.fail(recordId);
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      /injected update failure/,
    );
    assert.deepEqual(
      mock.environments.get('destination')!.get(recordId)!.schedules,
      baseline.schedules,
    );
    assert(!mock.events.some((event) => event.startsWith('fork:')));
  });

  it('keeps a committed bundle schedule after a rejected request on changed content', async () => {
    for (const created of [false, true]) {
      const runDirectory = join(directory, String(created));
      mkdirSync(runDirectory);
      const baseline = created
        ? null
        : state(
            { title: 'old' },
            {
              schedules: {
                publication: {
                  at: '2099-01-01T00:00:00.000Z',
                  selective: null,
                },
                unpublishing: null,
              },
            },
          );
      const desired = state(
        { title: 'new' },
        {
          schedules: {
            publication: { at: '2099-02-01T00:00:00.000Z', selective: null },
            unpublishing: null,
          },
        },
      );
      const mock = sdk(baseline ? [baseline] : []);
      const bundlePath = await bundle(runDirectory, mock, [
        plan(baseline, desired),
      ]);
      mock.failNextPublicationAfterWrite();
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: { ...defaults, inPlace: true },
        }),
        /uncertain schedule outcome.*left as they are/,
      );
      // The content is already the bundle's, so the committed schedule from
      // the bundle stays and the record is reported.
      assert.deepEqual(
        mock.environments.get('destination')!.get(recordId)!.schedules,
        desired.schedules,
      );
    }
  });

  it('leaves a cancelled schedule on changed content when the replacement request fails', async () => {
    const baseline = state(
      { title: 'old' },
      {
        schedules: {
          publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const desired = state(
      { title: 'new' },
      {
        schedules: {
          publication: { at: '2099-02-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    mock.failNextPublicationBeforeWrite();
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === 'APPLY_FAILED_REPAIR_INCOMPLETE' &&
        error.message.startsWith('injected schedule failure before write') &&
        /left as they are \(original: publication at 2099-01-01/.test(
          error.message,
        ),
    );
    assert.deepEqual(
      mock.environments.get('destination')!.get(recordId)!.schedules,
      { publication: null, unpublishing: null },
    );
  });

  it('preserves a concurrent schedule change instead of treating it as an uncertain write outcome', async () => {
    const baseline = state(
      { title: 'old' },
      {
        schedules: {
          publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const desired = state({ title: 'new' });
    const concurrent = { at: '2099-03-01T00:00:00.000Z', selective: null };
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    mock.afterNextScheduleCancellation((record) => {
      record.schedules.publication = concurrent;
    });
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      }),
      /schedules changed concurrently/,
    );
    assert.deepEqual(
      mock.environments.get('destination')!.get(recordId)!.schedules
        .publication,
      concurrent,
    );
    assert(!mock.events.some((event) => event.startsWith('schedule-')));
  });

  it('leaves schedules on unselected preservation records untouched', async () => {
    const baseline = state(
      { title: 'preserved' },
      {
        schedules: {
          publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const entry = { ...plan(baseline, baseline), action: 'noop' as const };
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [entry], []);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.equal(result.mutations, 0);
    assert(
      !mock.events.some(
        (event) => event.startsWith('cancel-') || event.startsWith('schedule-'),
      ),
    );
  });

  it('preserves a proven partial skip without validating its unexecuted desired state', async () => {
    const baseline = state({ title: 'old' }, { position: 0 });
    const mock = sdk([baseline]);
    mock.setOrdered();
    const unsafeDesired = state(
      { title: 'unexecutable' },
      {
        position: 7,
        validity: { current: false, published: null },
        schedules: {
          publication: { at: '2000-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const entry = {
      ...plan(baseline, unsafeDesired),
      action: 'skip' as const,
      diagnostics: [
        {
          code: 'EXPIRED_SCHEDULE',
          message: 'Desired publication date already passed.',
        },
      ],
    };
    const bundlePath = await bundle(directory, mock, [entry]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert.equal(result.partial, true);
    assert.equal(result.mutations, 0);
    assert.deepEqual(
      mock.environments.get(result.environmentId)!.get(recordId),
      baseline,
    );
  });

  it('does not reread an entire ordered model for an ordinary field edit', async () => {
    const baseline = Array.from({ length: 71 }, (_, position) =>
      state(
        { title: `record ${position}` },
        {
          id: createHash('sha256')
            .update(String(position))
            .digest('base64url')
            .slice(0, 22),
          position,
        },
      ),
    );
    const changed = baseline[35];
    const desired = state(
      { title: 'edited' },
      { id: changed.id, position: changed.position },
    );
    const mock = sdk(baseline);
    mock.setOrdered();
    const bundlePath = await bundle(directory, mock, [plan(changed, desired)]);
    await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert(mock.focusedReads.length > 0);
    assert(
      mock.focusedReads.every(
        (ids) => ids.length === 1 && ids[0] === changed.id,
      ),
    );
  });

  it('keeps point-read work constant when unchanged unscheduled records grow', async () => {
    let budget: number | undefined;
    for (const count of [1, 97]) {
      const runDirectory = join(directory, String(count));
      mkdirSync(runDirectory);
      const baseline = Array.from({ length: count }, (_, index) =>
        state(
          { title: `record ${index}` },
          {
            id: createHash('sha256')
              .update(String(index))
              .digest('base64url')
              .slice(0, 22),
          },
        ),
      );
      const changed = baseline[0];
      const mock = sdk(baseline);
      const bundlePath = await bundle(runDirectory, mock, [
        plan(changed, state({ title: 'edited' }, { id: changed.id })),
      ]);
      await applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      assert(
        mock.focusedReads.every(
          (ids) => ids.length === 1 && ids[0] === changed.id,
        ),
      );
      if (budget === undefined) budget = mock.focusedReads.length;
      else assert.equal(mock.focusedReads.length, budget);
    }
  });

  it('never touches scheduled unchanged records, in all-noop or mixed bundles', async () => {
    for (const mixed of [false, true]) {
      const runDirectory = join(directory, String(mixed));
      mkdirSync(runDirectory);
      const unsafe = state(
        {
          title: {
            upload_id: 'eeeeeeeeeeeeeeeeeeeeee',
            custom_data: { __itemTypeId: 'preserve' },
          },
        },
        {
          validity: { current: false, published: null },
          schedules: {
            publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
            unpublishing: null,
          },
        },
      );
      const other = state({ title: null }, { id: 'dddddddddddddddddddddd' });
      const mock = sdk(mixed ? [unsafe, other] : [unsafe]);
      const asset = withFileTitle(mock);
      const entry = { ...plan(unsafe, unsafe), action: 'noop' as const };
      entry.safety.uploadReferences = [asset.id];
      const entries: PlanEntry[] = [entry, asset];
      if (mixed) {
        const updated = plan(
          other,
          state(
            { title: { upload_id: asset.id, custom_data: { credit: 'safe' } } },
            { id: other.id },
          ),
        );
        updated.safety.uploadReferences = [asset.id];
        entries.push(updated);
      }
      const bundlePath = await bundle(runDirectory, mock, entries);
      const execution = applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
      });
      const result = await execution;
      if (!mixed) assert.equal(result.mutations, 0);
      assert.deepEqual(
        mock.events.filter((event) => event.endsWith(`:${recordId}`)),
        [],
      );
      assert.deepEqual(
        mock.environments.get('destination')!.get(recordId)!.current,
        unsafe.current,
      );
      assert.deepEqual(
        mock.environments.get('destination')!.get(recordId)!.schedules,
        unsafe.schedules,
      );
    }
  });

  it('leaves a scheduled unchanged record alone when its validity changes during apply', async () => {
    const unsafe = state(
      {
        title: {
          upload_id: 'eeeeeeeeeeeeeeeeeeeeee',
          custom_data: { __itemTypeId: 'preserve' },
        },
      },
      {
        schedules: {
          publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
          unpublishing: null,
        },
      },
    );
    const other = state({ title: null }, { id: 'dddddddddddddddddddddd' });
    const mock = sdk([unsafe, other]);
    const asset = withFileTitle(mock);
    const unchanged = { ...plan(unsafe, unsafe), action: 'noop' as const };
    unchanged.safety.uploadReferences = [asset.id];
    const changed = plan(
      other,
      state(
        { title: { upload_id: asset.id, custom_data: { credit: 'safe' } } },
        { id: other.id },
      ),
    );
    changed.safety.uploadReferences = [asset.id];
    const bundlePath = await bundle(directory, mock, [
      unchanged,
      changed,
      asset,
    ]);
    mock.afterNextUpdate(() => {
      mock.environments
        .get('destination')!
        .get(recordId)!.validity.current = false;
    });
    await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: { ...defaults, inPlace: true },
    });
    assert.deepEqual(
      mock.events.filter((event) => event.endsWith(`:${recordId}`)),
      [],
    );
    assert.deepEqual(
      mock.environments.get('destination')!.get(recordId)!.schedules,
      unsafe.schedules,
    );
    assert.deepEqual(
      mock.environments.get('destination')!.get(recordId)!.current,
      unsafe.current,
    );
  });

  it('guards the binary replacement response before accepting metadata from a later read', async () => {
    const sdkUpload = require(
      join(
        dirname(require.resolve('@datocms/cma-client-node')),
        'utils/uploadLocalFileAndReturnPath.js',
      ),
    );
    const uploadLocalFile = sdkUpload.uploadLocalFileAndReturnPath;
    sdkUpload.uploadLocalFileAndReturnPath = async () =>
      '/staged/replacement.txt';
    try {
      for (const outcome of [
        'native',
        'after-response',
        'in-response',
        'exif',
      ]) {
        const runDirectory = join(directory, outcome);
        mkdirSync(runDirectory);
        const resource = uploadFixture();
        const baseline = canonicalUpload(resource);
        const bytes = Buffer.from('replacement bytes');
        const native = clone(resource);
        const wanted = clone(resource);
        wanted.attributes.md5 = createHash('md5').update(bytes).digest('hex');
        wanted.attributes.size = bytes.length;
        wanted.attributes.basename = 'reviewed';
        wanted.attributes.filename = 'reviewed.txt';
        wanted.attributes.notes = 'reviewed notes';
        const desired = canonicalUpload(wanted);
        const mock = sdk();
        const originalClient = mock.client;
        let metadataWrites = 0;
        mock.client = (environmentId) => {
          const client = originalClient(environmentId);
          client.uploads.rawList = (async () => ({
            data: [clone(native)],
            meta: { total_count: 1 },
          })) as unknown as Client['uploads']['rawList'];
          client.uploads.find = (async () =>
            clone(native)) as unknown as Client['uploads']['find'];
          client.uploads.update = (async (
            _id: string,
            body: JsonObject,
            query?: { replace_strategy?: string },
          ) => {
            if ('path' in body) {
              assert.equal(query?.replace_strategy, 'create_new_url');
              native.attributes.md5 = desired.md5;
              native.attributes.size = desired.size;
              native.attributes.basename = 'generated-upload';
              native.attributes.filename = 'generated-upload.txt';
              native.attributes.url = 'https://assets.example/isolated.txt';
              if (outcome === 'in-response')
                native.attributes.notes = 'concurrent editor';
              if (outcome === 'exif') native.attributes.author = 'EXIF author';
              const response = clone(native);
              if (outcome === 'after-response')
                native.attributes.notes = 'concurrent editor';
              return response;
            }
            metadataWrites++;
            Object.assign(native.attributes, body);
            native.attributes.filename = `${native.attributes.basename}.txt`;
            return clone(native);
          }) as unknown as Client['uploads']['update'];
          return client;
        };
        const bundlePath = await bundle(
          runDirectory,
          mock,
          [
            {
              kind: 'upload',
              id: resource.id,
              action: 'update',
              baseline,
              desired,
              guard: { hash: baseline.hash },
              diagnostics: [],
            },
          ],
          [modelId],
          [],
          async () => new Response(bytes),
        );
        const execution = applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: { ...defaults, inPlace: true },
        });
        if (outcome === 'after-response' || outcome === 'in-response') {
          await assert.rejects(execution, /binary.*changed|changed.*binary/);
          assert.equal(native.attributes.notes, 'concurrent editor');
          assert.equal(metadataWrites, 0);
        } else {
          await execution;
          assert.equal(metadataWrites, 1);
          assert.equal(canonicalUpload(native).hash, desired.hash);
        }
      }
    } finally {
      sdkUpload.uploadLocalFileAndReturnPath = uploadLocalFile;
    }
  });

  it('removes each staged binary copy as soon as its upload succeeds or fails', async () => {
    const sdkUpload = require(
      join(
        dirname(require.resolve('@datocms/cma-client-node')),
        'utils/uploadLocalFileAndReturnPath.js',
      ),
    );
    const uploadLocalFile = sdkUpload.uploadLocalFileAndReturnPath;
    const dispose = SnapshotStore.prototype.dispose;
    const staged: string[] = [];
    const retained: string[] = [];
    // The workspace removal would hide copies kept for the whole run.
    SnapshotStore.prototype.dispose = function (this: SnapshotStore) {
      retained.push(...staged.filter((path) => existsSync(path)));
      dispose.call(this);
    };
    try {
      for (const fail of [false, true]) {
        const runDirectory = join(directory, String(fail));
        mkdirSync(runDirectory);
        const resource = uploadFixture();
        const baseline = canonicalUpload(resource);
        const bytes = Buffer.from('replacement bytes');
        const native = clone(resource);
        const wanted = clone(resource);
        wanted.attributes.md5 = createHash('md5').update(bytes).digest('hex');
        wanted.attributes.size = bytes.length;
        const desired = canonicalUpload(wanted);
        sdkUpload.uploadLocalFileAndReturnPath = async (
          _client: Client,
          path: string,
        ) => {
          assert(existsSync(path));
          staged.push(path);
          if (fail) throw new Error('injected upload failure');
          return '/staged/replacement.txt';
        };
        const mock = sdk();
        const originalClient = mock.client;
        mock.client = (environmentId) => {
          const client = originalClient(environmentId);
          client.uploads.rawList = (async () => ({
            data: [clone(native)],
            meta: { total_count: 1 },
          })) as unknown as Client['uploads']['rawList'];
          client.uploads.find = (async () =>
            clone(native)) as unknown as Client['uploads']['find'];
          client.uploads.update = (async (_id: string, body: JsonObject) => {
            if ('path' in body) {
              assert(!existsSync(staged[staged.length - 1]));
              native.attributes.md5 = desired.md5;
              native.attributes.size = desired.size;
            } else {
              Object.assign(native.attributes, body);
            }
            return clone(native);
          }) as unknown as Client['uploads']['update'];
          return client;
        };
        const bundlePath = await bundle(
          runDirectory,
          mock,
          [
            {
              kind: 'upload',
              id: resource.id,
              action: 'update',
              baseline,
              desired,
              guard: { hash: baseline.hash },
              diagnostics: [],
            },
          ],
          [modelId],
          [],
          async () => new Response(bytes),
        );
        const execution = applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: { ...defaults, inPlace: true },
        });
        if (fail) await assert.rejects(execution, /injected upload failure/);
        else await execution;
      }
      assert.equal(staged.length, 2);
      assert.deepEqual(retained, []);
    } finally {
      sdkUpload.uploadLocalFileAndReturnPath = uploadLocalFile;
      SnapshotStore.prototype.dispose = dispose;
    }
  });

  it('refreshes a stale validity stamp only for schedules that require the global stamp', async () => {
    for (const [index, native, improved, selective, refresh] of [
      [0, false, true, false, true],
      [1, false, true, true, true],
      [2, true, true, true, false],
      [3, false, false, false, false],
    ] as const) {
      const runDirectory = join(directory, String(index));
      mkdirSync(runDirectory);
      const baseline = state(
        { title: 'valid unchanged content' },
        { validity: { current: false, published: null } },
      );
      const mock = sdk([baseline]);
      mock.scheduleValidation(native, improved);
      const desired = state(baseline.current, {
        validity: baseline.validity,
        schedules: {
          publication: {
            at: '2099-01-01T00:00:00.000Z',
            selective: selective
              ? { locales: ['en'], nonLocalized: true }
              : null,
          },
          unpublishing: null,
        },
      });
      const bundlePath = await bundle(runDirectory, mock, [
        plan(baseline, desired),
      ]);
      const result = await applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      assert.equal(
        mock.events.filter((event) => event.startsWith('update:')).length,
        refresh ? 1 : 0,
      );
      assert.deepEqual(
        mock.environments.get(result.environmentId)!.get(recordId)!.schedules,
        desired.schedules,
      );
    }
  });

  it('guards only the sibling range shifted by a positional move', async () => {
    const baseline = Array.from({ length: 71 }, (_, position) =>
      state(
        { title: `record ${position}` },
        {
          id: createHash('sha256')
            .update(String(position))
            .digest('base64url')
            .slice(0, 22),
          position,
        },
      ),
    );
    const mock = sdk(baseline);
    mock.setOrdered();
    const entries = [
      plan(
        baseline[0],
        state(baseline[0].current, { id: baseline[0].id, position: 1 }),
      ),
      plan(
        baseline[1],
        state(baseline[1].current, { id: baseline[1].id, position: 0 }),
      ),
    ];
    const bundlePath = await bundle(directory, mock, entries);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const written = mock.environments.get(result.environmentId)!;
    assert.equal(written.get(baseline[0].id)!.position, 1);
    assert.equal(written.get(baseline[1].id)!.position, 0);
    assert(
      mock.focusedReads
        .flat()
        .every((id) => id === baseline[0].id || id === baseline[1].id),
    );
    assert(mock.focusedReads.every((ids) => ids.length <= 2));
  });

  it('copies the appended position from a native parent-only tree reparent payload', async () => {
    const p = state(
      { title: 'P' },
      { id: 'aaaaaaaaaaaaaaaaaaaaaa', position: 0 },
    );
    const q = state(
      { title: 'Q' },
      { id: 'dddddddddddddddddddddd', position: 1 },
    );
    const a = state({ title: 'A' }, { parentId: p.id, position: 1 });
    const b = state(
      { title: 'B' },
      { id: 'cccccccccccccccccccccc', parentId: q.id, position: 1 },
    );
    const mock = sdk([p, q, a, b]);
    mock.setTree();
    mock.environments.set(
      'source',
      new Map([p, q, a, b].map((record) => [record.id, clone(record)])),
    );
    await mock.client('source').items.update(a.id, {
      parent_id: q.id,
      meta: { current_version: a.currentVersion! },
    });
    const desired = clone(mock.environments.get('source')!.get(a.id)!);
    assert.equal(desired.position, 2);
    const bundlePath = await bundle(directory, mock, [plan(a, desired)]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const written = mock.environments.get(result.environmentId)!;
    assert.equal(written.get(a.id)!.parentId, q.id);
    assert.equal(written.get(a.id)!.position, 2);
    assert.equal(written.get(b.id)!.position, 1);
    assert.equal(written.get(p.id)!.position, 0);
    assert.equal(written.get(q.id)!.position, 1);
  });

  it('rejects a newly added destination identity before any fork', async () => {
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [
      plan(baseline, state({ title: 'new' })),
    ]);
    mock.environments
      .get('destination')!
      .set(
        'dddddddddddddddddddddd',
        state(
          { title: 'added after generation' },
          { id: 'dddddddddddddddddddddd' },
        ),
      );
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      /gained an identity/,
    );
    assert.deepEqual(mock.events, []);
  });

  it('rejects imported writes that need an existing published-only block ID before any mutation', async () => {
    for (const into of ['published', 'current']) {
      const runDirectory = join(directory, into);
      mkdirSync(runDirectory);
      const block = blockValue('i'.repeat(22));
      const baseline = state(
        { title: 'Draft', body: [] },
        {
          published: { title: 'Public', body: [block] },
          publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
          firstPublishedAt: '2019-01-01T00:00:00.000Z',
          validity: { current: true, published: true },
        },
      );
      const desired = state(
        into === 'current'
          ? { title: 'Restored', body: [block] }
          : baseline.current,
        {
          ...baseline,
          current:
            into === 'current'
              ? { title: 'Restored', body: [block] }
              : baseline.current,
          published:
            into === 'published'
              ? { title: 'Changed public title', body: [block] }
              : baseline.published,
        },
      );
      const mock = sdk([baseline]);
      withBlockField(mock);
      const entry = plan(baseline, desired);
      entry.safety.blockIds = [String(block.id)];
      const bundlePath = await bundle(runDirectory, mock, [entry]);
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: defaults,
        }),
        (error) =>
          error instanceof ContentError &&
          /block.*current|published.only/i.test(error.message),
      );
      assert.deepEqual(mock.events, []);
    }
  });

  it('preserves matching published blocks and writes changed published blocks while current still owns them', async () => {
    for (const mode of ['matching', 'changed', 'already-published-only']) {
      const publishedChanged = mode === 'changed';
      const runDirectory = join(directory, mode);
      mkdirSync(runDirectory);
      const publishedBlock = blockValue('i'.repeat(22));
      const draftBlock = blockValue('j'.repeat(22));
      const baseline = state(
        {
          title: 'Draft',
          body:
            mode === 'already-published-only'
              ? [draftBlock]
              : [publishedBlock, draftBlock],
        },
        {
          published: { title: 'Public', body: [publishedBlock] },
          publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
          firstPublishedAt: '2019-01-01T00:00:00.000Z',
          validity: { current: true, published: true },
        },
      );
      const desired = state(
        { title: 'Changed draft', body: [draftBlock] },
        {
          ...baseline,
          current: { title: 'Changed draft', body: [draftBlock] },
          published: publishedChanged
            ? { title: 'Changed public', body: [publishedBlock] }
            : baseline.published,
        },
      );
      const mock = sdk([baseline]);
      withBlockField(mock);
      const entry = plan(baseline, desired);
      entry.safety.blockIds = [
        String(publishedBlock.id),
        String(draftBlock.id),
      ].sort();
      const bundlePath = await bundle(runDirectory, mock, [entry]);
      const result = await applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      });
      const actual = mock.environments
        .get(result.environmentId)!
        .get(recordId)!;
      assert.deepEqual(actual.current, desired.current);
      assert.deepEqual(actual.published, desired.published);
      assert.equal(
        mock.events.filter((event) => event.startsWith('publish:')).length,
        publishedChanged ? 1 : 0,
      );
    }
  });

  it('allows block recreation after unpublishing removes a published-only orphan', async () => {
    const block = blockValue('i'.repeat(22));
    const baseline = state(
      { title: 'Draft', body: [] },
      {
        published: { title: 'Public', body: [block] },
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        validity: { current: true, published: true },
      },
    );
    const desired = state(
      { title: 'Restored', body: [block] },
      {
        ...baseline,
        current: { title: 'Restored', body: [block] },
        published: null,
        publishedUpdatedAt: null,
        validity: { current: true, published: null },
      },
    );
    const mock = sdk([baseline]);
    withBlockField(mock);
    const entry = plan(baseline, desired);
    entry.safety.blockIds = [String(block.id)];
    const bundlePath = await bundle(directory, mock, [entry]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    const actual = mock.environments.get(result.environmentId)!.get(recordId)!;
    assert.deepEqual(actual.current, desired.current);
    assert.equal(actual.published, null);
  });

  it('imports declared default suppression for a recreated block and restores the field afterward', async () => {
    const published = blockValue('i'.repeat(22), 1);
    const draft = blockValue('j'.repeat(22), null);
    const baseline = state(
      { title: 'Draft', body: [published, draft] },
      {
        published: { title: 'Public', body: [published] },
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        firstPublishedAt: '2019-01-01T00:00:00.000Z',
        validity: { current: true, published: true },
      },
    );
    const desired = state(
      { title: 'Restored draft', body: [draft] },
      {
        ...baseline,
        current: { title: 'Restored draft', body: [draft] },
        published: { title: 'Changed public', body: [published] },
      },
    );
    const mock = sdk([baseline]);
    const fields = withBlockField(mock, 7, 'integer');
    const entry = plan(baseline, desired);
    entry.safety.blockIds = [String(published.id), String(draft.id)].sort();
    const changes: TemporarySchemaChange[] = [
      {
        fieldId: 'g'.repeat(22),
        modelId: blockModelId,
        original: { validators: {}, defaultValue: 7 },
        temporary: { validators: {}, defaultValue: null },
        reasons: [
          'Preserve null when the current block is recreated after publication staging.',
        ],
      },
    ];
    const bundlePath = await bundle(
      directory,
      mock,
      [entry],
      [modelId],
      changes,
    );
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: { ...defaults, allowTemporarySchemaChanges: true },
    });
    const actual = mock.environments.get(result.environmentId)!.get(recordId)!;
    assert.deepEqual(actual.current, desired.current);
    assert.deepEqual(actual.published, desired.published);
    assert.equal(fields.defaults.get(result.environmentId), 7);
    assert.equal(
      mock.events.filter((event) => event === 'block-field-settings').length,
      2,
    );
  });

  it('rejects imported unsafe INTEGER payloads before a fork or content write', async () => {
    for (const slice of ['current', 'published']) {
      const runDirectory = join(directory, slice);
      mkdirSync(runDirectory);
      const block = blockValue('i'.repeat(22), 1);
      const unsafe = blockValue(String(block.id), Number.MAX_SAFE_INTEGER + 1);
      const baseline = state({ title: 'Before', body: [block] });
      const desired = state(
        { title: 'After', body: slice === 'current' ? [unsafe] : [block] },
        {
          published:
            slice === 'published' ? { title: 'Public', body: [unsafe] } : null,
          firstPublishedAt:
            slice === 'published' ? '2019-01-01T00:00:00.000Z' : null,
          publishedUpdatedAt:
            slice === 'published' ? '2020-01-02T00:00:00.000Z' : null,
          validity: {
            current: true,
            published: slice === 'published' ? true : null,
          },
        },
      );
      const mock = sdk([baseline]);
      withBlockField(mock, null, 'integer');
      const entry = plan(baseline, desired);
      entry.safety.blockIds = [String(block.id)];
      const bundlePath = await bundle(runDirectory, mock, [entry]);
      await assert.rejects(
        applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: defaults,
        }),
        (error) =>
          error instanceof ContentError &&
          error.code === 'UNSUPPORTED_INTEGER_PRECISION',
      );
      assert.deepEqual(mock.events, []);
    }
  });

  it('rejects an imported creation seed that replaces unrelated content', async () => {
    const mock = sdk();
    const entry = plan(null, state({ title: 'approved' }));
    entry.execution = {
      ...entry.execution,
      creationFields: { title: 'unapproved intermediate' },
    };
    const bundlePath = await bundle(directory, mock, [entry]);
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: defaults,
      }),
      /undeferred field/,
    );
    assert.deepEqual(mock.events, []);
  });

  it('rejects SDK-lossy imported record payloads while permitting preservation-only records', async () => {
    const schema = await fetchSchema(
      sdk().client('destination'),
      'destination',
    );
    schema.models[0].fields.push({
      id: 'eeeeeeeeeeeeeeeeeeeeee',
      apiKey: 'image',
      type: 'file',
      localized: false,
      validators: {},
      defaultValue: null,
    });
    const before = state({ title: 'old', image: null });
    const after = state({
      title: 'new',
      image: {
        upload_id: 'dddddddddddddddddddddd',
        custom_data: { __itemTypeId: 'business-value' },
      },
    });
    const store = new SnapshotStore(directory);
    try {
      for (const entry of [plan(null, after), plan(before, after)]) {
        assert.throws(
          () => validateExecution({ entry, store, schema, changes: [] }),
          /payload metadata __itemTypeId cannot round-trip/,
        );
      }
      assert.doesNotThrow(() =>
        validateExecution({
          entry: { ...plan(after, after), action: 'noop' },
          store,
          schema,
          changes: [],
        }),
      );
    } finally {
      store.dispose();
    }
  });

  it('accepts localized deferred reference maps and rejects changed locale keys', async () => {
    const schema = await fetchSchema(
      sdk().client('destination'),
      'destination',
    );
    schema.locales = ['en', 'it'];
    schema.models[0].fields.push({
      id: 'eeeeeeeeeeeeeeeeeeeeee',
      apiKey: 'link',
      type: 'link',
      localized: true,
      validators: {},
      defaultValue: null,
    });
    const source = state({
      title: 'unchanged',
      link: { en: 'dddddddddddddddddddddd', it: 'dddddddddddddddddddddd' },
    });
    const entry = plan(null, source);
    entry.execution = {
      ...entry.execution,
      creationFields: { title: 'unchanged', link: { en: null, it: null } },
    };
    const store = new SnapshotStore(directory);
    try {
      store.putPlan(
        plan(
          null,
          state(
            { title: 'dependency', link: { en: null, it: null } },
            { id: 'dddddddddddddddddddddd' },
          ),
        ),
      );
      assert.doesNotThrow(() =>
        validateExecution({ entry, store, schema, changes: [] }),
      );
      entry.execution.creationFields!.link = { en: null };
      assert.throws(
        () => validateExecution({ entry, store, schema, changes: [] }),
        /undeferred field/,
      );
      entry.execution.creationFields!.link = { en: null, it: null, fr: null };
      assert.throws(
        () => validateExecution({ entry, store, schema, changes: [] }),
        /undeferred field/,
      );
      entry.execution.creationFields!.link = null;
      assert.throws(
        () => validateExecution({ entry, store, schema, changes: [] }),
        /undeferred field/,
      );
    } finally {
      store.dispose();
    }
  });

  it('allows an automatic-publication seed to defer an existing record awaiting publication', async () => {
    const mock = sdk();
    mock.withLinks();
    const schema = await fetchSchema(mock.client('destination'), 'destination');
    schema.models[0].draftMode = false;
    const dependencyId = 'dddddddddddddddddddddd';
    const entry = plan(
      null,
      state(
        { title: 'new', link: dependencyId },
        {
          published: { title: 'new', link: dependencyId },
        },
      ),
    );
    entry.execution = {
      ...entry.execution,
      creationFields: { title: 'new', link: null },
    };
    const before = state(
      { title: 'dependency', link: null },
      { id: dependencyId },
    );
    const after = state(before.current, {
      id: dependencyId,
      published: before.current,
    });
    const store = new SnapshotStore(directory);
    try {
      store.putPlan(plan(before, after));
      assert.doesNotThrow(() =>
        validateExecution({ entry, store, schema, changes: [] }),
      );
      schema.models[0].draftMode = true;
      assert.throws(
        () => validateExecution({ entry, store, schema, changes: [] }),
        /undeferred field/,
      );
      schema.models[0].draftMode = false;
      store.putPlan(plan(after, after));
      assert.throws(
        () => validateExecution({ entry, store, schema, changes: [] }),
        /undeferred field/,
      );
    } finally {
      store.dispose();
    }
  });

  it('accepts exact empty modular-content seeds while preserving partial locale keys', async () => {
    const schema = await fetchSchema(
      sdk().client('destination'),
      'destination',
    );
    schema.locales = ['en', 'it'];
    schema.models[0].fields.push({
      id: 'eeeeeeeeeeeeeeeeeeeeee',
      apiKey: 'body',
      type: 'rich_text',
      localized: true,
      validators: {},
      defaultValue: null,
    });
    schema.models.push({
      ...clone(schema.models[0]),
      id: 'ffffffffffffffffffffff',
      apiKey: 'block',
      block: true,
      fields: [
        {
          id: 'gggggggggggggggggggggg',
          apiKey: 'link',
          type: 'link',
          localized: false,
          validators: {},
          defaultValue: null,
        },
      ],
    });
    const source = state({
      title: 'unchanged',
      body: {
        en: [
          {
            id: 'hhhhhhhhhhhhhhhhhhhhhh',
            __itemTypeId: 'ffffffffffffffffffffff',
            attributes: { link: 'dddddddddddddddddddddd' },
          },
        ],
      },
    });
    const entry = plan(null, source);
    entry.execution = {
      ...entry.execution,
      creationFields: { title: 'unchanged', body: { en: [] } },
    };
    const store = new SnapshotStore(directory);
    try {
      store.putPlan(
        plan(
          null,
          state(
            { title: 'dependency', body: { en: [] } },
            { id: 'dddddddddddddddddddddd' },
          ),
        ),
      );
      assert.doesNotThrow(() =>
        validateExecution({ entry, store, schema, changes: [] }),
      );
      entry.execution.creationFields!.body = { en: [], it: [] };
      assert.throws(
        () => validateExecution({ entry, store, schema, changes: [] }),
        /undeferred field/,
      );
      entry.execution.creationFields!.body = { en: null };
      assert.throws(
        () => validateExecution({ entry, store, schema, changes: [] }),
        /undeferred field/,
      );
    } finally {
      store.dispose();
    }
  });

  it('restores declared validator and default settings on success and in-place failure', async () => {
    for (const localized of [false, true]) {
      const change: TemporarySchemaChange = {
        modelId,
        fieldId: 'cccccccccccccccccccccc',
        original: {
          validators: { required: {} },
          defaultValue: localized ? { en: 'automatic' } : 'automatic',
        },
        temporary: {
          validators: {},
          defaultValue: localized ? { en: null } : null,
        },
        reasons: ['Explicit managed transition'],
      };
      for (const fail of [false, true]) {
        const runDirectory = join(directory, `${localized}-${fail}`);
        mkdirSync(runDirectory);
        const baseline = state({ title: localized ? { en: 'old' } : 'old' });
        const mock = sdk([baseline]);
        mock.requireField(localized);
        const bundlePath = await bundle(
          runDirectory,
          mock,
          [plan(baseline, state({ title: localized ? { en: 'new' } : 'new' }))],
          [modelId],
          [change],
        );
        if (fail) mock.fail(recordId);
        const execution = applyBundle({
          rootClient: mock.root,
          buildEnvironmentClient: mock.client,
          bundlePath,
          options: {
            ...defaults,
            inPlace: true,
            allowTemporarySchemaChanges: true,
          },
        });
        if (fail) await assert.rejects(execution, /injected update failure/);
        else await execution;
        assert.deepEqual(mock.fieldStates.get('destination'), change.original);
      }
    }
  });

  it('reports unsuccessful schema repair after an in-place failure', async () => {
    const change: TemporarySchemaChange = {
      modelId,
      fieldId: 'cccccccccccccccccccccc',
      original: { validators: { required: {} }, defaultValue: 'automatic' },
      temporary: { validators: {}, defaultValue: null },
      reasons: ['Explicit managed transition'],
    };
    const baseline = state({ title: 'old' });
    const mock = sdk([baseline]);
    mock.requireField();
    const bundlePath = await bundle(
      directory,
      mock,
      [plan(baseline, state({ title: 'new' }))],
      [modelId],
      [change],
    );
    mock.fail(recordId);
    mock.failRestoration();
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: {
          ...defaults,
          inPlace: true,
          allowTemporarySchemaChanges: true,
        },
      }),
      /Cleanup problems:.*restoration failure/,
    );
    assert.deepEqual(mock.fieldStates.get('destination'), change.temporary);
  });

  it('retains bounded repair samples while attempting every failed schedule restoration', async () => {
    const originals = Array.from({ length: 27 }, (_, index) =>
      state(
        { title: `record ${index}` },
        {
          id: createHash('sha256')
            .update(`repair ${index}`)
            .digest('base64url')
            .slice(0, 22),
          schedules: {
            publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
            unpublishing: null,
          },
        },
      ),
    );
    const mock = sdk(originals);
    // Only written records have their schedules cancelled. The first write
    // fails, so every record still has its original content to restore onto.
    const bundlePath = await bundle(
      directory,
      mock,
      originals.map((original) =>
        plan(original, state({ title: 'new' }, { id: original.id })),
      ),
    );
    mock.fail(originals.map((original) => original.id).sort()[0]);
    mock.failAllPublicationCreates();
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true, concurrency: 1 },
      }),
      (error: unknown) => {
        assert(error instanceof ContentError);
        assert.equal(error.code, 'APPLY_FAILED_REPAIR_INCOMPLETE');
        assert.equal(error.details?.repairFailureCount, 27);
        assert.equal(error.details?.retainedRepairSamples, 20);
        assert.equal((error.details?.repairSamples as string[]).length, 20);
        assert.match(error.message, /27 repair failures; showing 20 samples/);
        return true;
      },
    );
    assert.equal(
      mock.events.filter((event) => event.startsWith('schedule-publication:'))
        .length,
      27,
    );
  });

  it('accepts recomputed validity diagnostics while verifying managed and preserved content', async () => {
    const change: TemporarySchemaChange = {
      modelId,
      fieldId: 'cccccccccccccccccccccc',
      original: { validators: { required: {} }, defaultValue: 'automatic' },
      temporary: { validators: {}, defaultValue: null },
      reasons: ['Preserve grandfathered content'],
    };
    const baseline = state(
      { title: 'old' },
      {
        published: { title: 'old' },
        firstPublishedAt: '2020-01-01T00:00:00.000Z',
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        validity: { current: true, published: true },
      },
    );
    const desired = state(
      { title: '' },
      {
        published: { title: '' },
        firstPublishedAt: baseline.firstPublishedAt,
        publishedUpdatedAt: baseline.publishedUpdatedAt,
        validity: { current: true, published: true },
      },
    );
    const preserved = state({ title: '' }, { id: 'dddddddddddddddddddddd' });
    const mock = sdk([baseline, preserved]);
    mock.requireField();
    mock.revalidateOnRestoration();
    const bundlePath = await bundle(
      directory,
      mock,
      [plan(baseline, desired)],
      [modelId],
      [change],
    );
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: { ...defaults, allowTemporarySchemaChanges: true },
    });
    const written = mock.environments.get(result.environmentId)!;
    assert.deepEqual(written.get(recordId)!.current, desired.current);
    assert.deepEqual(written.get(recordId)!.published, desired.published);
    assert.deepEqual(written.get(recordId)!.validity, {
      current: false,
      published: false,
    });
    assert.equal(written.get(preserved.id)!.validity.current, false);
    assert.deepEqual(written.get(preserved.id)!.current, preserved.current);
    assert.deepEqual(
      mock.fieldStates.get(result.environmentId),
      change.original,
    );
  });

  it('persists a refreshed validity stamp with an optimistic write before publishing identical content', async () => {
    const baseline = state(
      { title: 'already desired' },
      {
        firstPublishedAt: '2020-01-01T00:00:00.000Z',
        validity: { current: false, published: null },
      },
    );
    const desired = state(
      { title: 'already desired' },
      {
        published: { title: 'already desired' },
        firstPublishedAt: '2020-01-01T00:00:00.000Z',
        publishedUpdatedAt: '2020-01-02T00:00:00.000Z',
        validity: { current: true, published: true },
      },
    );
    const mock = sdk([baseline]);
    const bundlePath = await bundle(directory, mock, [plan(baseline, desired)]);
    const result = await applyBundle({
      rootClient: mock.root,
      buildEnvironmentClient: mock.client,
      bundlePath,
      options: defaults,
    });
    assert(
      mock.events.indexOf(`update:${recordId}`) <
        mock.events.indexOf(`publish:${recordId}`),
    );
    assert.deepEqual(
      mock.environments.get(result.environmentId)!.get(recordId)!.published,
      desired.published,
    );
  });

  it('still rejects content drift when schema validation recomputes diagnostic flags', async () => {
    const change: TemporarySchemaChange = {
      modelId,
      fieldId: 'cccccccccccccccccccccc',
      original: { validators: { required: {} }, defaultValue: 'automatic' },
      temporary: { validators: {}, defaultValue: null },
      reasons: ['Managed transition'],
    };
    const baseline = state({ title: 'old' });
    const preserved = state({ title: '' }, { id: 'dddddddddddddddddddddd' });
    const mock = sdk([baseline, preserved]);
    mock.requireField();
    mock.revalidateOnRestoration(true);
    const bundlePath = await bundle(
      directory,
      mock,
      [plan(baseline, state({ title: 'new' }))],
      [modelId],
      [change],
    );
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, allowTemporarySchemaChanges: true },
      }),
      /final state differs/,
    );
    assert.equal(mock.environments.size, 1);
  });
});
