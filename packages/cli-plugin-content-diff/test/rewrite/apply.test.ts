import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { applyBundle } from '../../src/engine/apply';
import { stageBinary } from '../../src/engine/apply-binary';
import { validateExecution } from '../../src/engine/apply-validation';
import { batches, boundedWork } from '../../src/engine/apply-work';
import { writeBundle } from '../../src/engine/bundle';
import { recordGuard, recordHash } from '../../src/engine/codec';
import { ContentError } from '../../src/engine/errors';
import { fetchSchema } from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  ApplyOptions,
  Client,
  JsonObject,
  PlanCounts,
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
  let linkField = false;
  let delayedUpdates = false;
  const stats = { activeUpdates: 0, maximumUpdates: 0 };
  let nativeInvalidDrafts = false;
  let improvedValidation = true;
  const fieldStates = new Map<
    string,
    { validators: JsonObject; defaultValue: string | null }
  >();
  let originalField = {
    validators: {} as JsonObject,
    defaultValue: null as string | null,
  };
  let failRestoration = false;
  let recalculateValidity = false;
  let changePreservedContent = false;
  let failPublicationAfterWrite = false;
  let failAllPublicationCreates = false;
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
    return {
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
            draft_mode_active: true,
            draft_saving_active: nativeInvalidDrafts,
            all_locales_required: false,
            workflow: null,
          },
        ],
      },
      fields: {
        list: async () => [
          {
            id: 'cccccccccccccccccccccc',
            api_key: 'title',
            field_type: 'string',
            localized: false,
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
          body: { validators: JsonObject; default_value: string | null },
        ) => {
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
      workflows: { list: async () => [] },
      scheduledPublication: {
        destroy: async (id: string) => {
          events.push(`cancel-publication:${id}`);
          const record = get(id);
          record.schedules.publication = null;
          remember(record);
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
          remember(record);
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
            },
          );
          records().set(id, record);
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
        references: async () => [],
        destroy: async (id: string) => {
          events.push(`destroy:${id}`);
          records().delete(id);
        },
      },
    } as unknown as Client;
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
    failAllPublicationCreates: () => {
      failAllPublicationCreates = true;
    },
    requireField: () => {
      originalField = {
        validators: { required: {} },
        defaultValue: 'automatic',
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

async function bundle(
  directory: string,
  mock: ReturnType<typeof sdk>,
  entries: RecordPlan[],
  modelIds: string[] = [modelId],
  temporarySchemaChanges: TemporarySchemaChange[] = [],
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
    for (const entry of entries) counts.record[entry.action]++;
    return await writeBundle({
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
        /injected update failure/,
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

  it('repairs schedules after a rejected request has already committed remotely', async () => {
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
        /uncertain schedule outcome/,
      );
      assert.deepEqual(
        mock.environments.get('destination')!.get(recordId)!.schedules,
        baseline?.schedules ?? { publication: null, unpublishing: null },
      );
    }
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
    const change: TemporarySchemaChange = {
      modelId,
      fieldId: 'cccccccccccccccccccccc',
      original: { validators: { required: {} }, defaultValue: 'automatic' },
      temporary: { validators: {}, defaultValue: null },
      reasons: ['Explicit managed transition'],
    };
    for (const fail of [false, true]) {
      const runDirectory = join(directory, String(fail));
      mkdirSync(runDirectory);
      const baseline = state({ title: 'old' });
      const mock = sdk([baseline]);
      mock.requireField();
      const bundlePath = await bundle(
        runDirectory,
        mock,
        [plan(baseline, state({ title: 'new' }))],
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
    const changed = originals[0];
    const bundlePath = await bundle(directory, mock, [
      plan(changed, state({ title: 'new' }, { id: changed.id })),
    ]);
    mock.fail(changed.id);
    mock.failAllPublicationCreates();
    await assert.rejects(
      applyBundle({
        rootClient: mock.root,
        buildEnvironmentClient: mock.client,
        bundlePath,
        options: { ...defaults, inPlace: true },
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
