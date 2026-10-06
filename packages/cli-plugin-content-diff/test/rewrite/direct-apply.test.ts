import assert from 'node:assert/strict';
import { CmaClient } from '@datocms/cli-utils';
import { afterEach, describe, it } from 'mocha';
import * as capture from '../../src/engine/capture';
import { recordGuard, recordHash } from '../../src/engine/codec';
import { directApply, directRepair } from '../../src/engine/direct-apply';
import * as artifact from '../../src/engine/migration-artifact';
import * as planner from '../../src/engine/planner';
import * as schemaApi from '../../src/engine/schema';
import type {
  Client,
  DirectApplyOptions,
  JsonObject,
  PlanMetadata,
  RecordState,
  SchemaState,
  TemporarySchemaChange,
} from '../../src/engine/types';
import { fixtureId } from './fixture-id';

const restore: Array<() => void> = [];
function replace(target: object, key: string, value: unknown) {
  const before = Reflect.get(target, key);
  Reflect.set(target, key, value);
  restore.push(() => Reflect.set(target, key, before));
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const MODEL = fixtureId('direct-model');
const FIELD = fixtureId('direct-field');
const RECORD = fixtureId('direct-record');
const DATE = '2025-01-01T00:00:00.000Z';
const empty = { create: 0, update: 0, delete: 0, noop: 0, skip: 0 };
function fixture() {
  const schema: SchemaState = {
    siteId: 'project',
    environmentId: 'main',
    locales: ['en'],
    semantics: {},
    workflows: [],
    hash: '',
    models: [
      {
        id: MODEL,
        apiKey: 'article',
        name: 'Article',
        block: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftMode: true,
        saveInvalidDrafts: true,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: FIELD,
            apiKey: 'title',
            type: 'string',
            localized: false,
            validators: { required: {} },
            defaultValue: null,
          },
        ],
      },
    ],
  };
  schema.hash = schemaApi.schemaHash(schema);
  const original: RecordState = {
    id: RECORD,
    modelId: MODEL,
    current: { title: 'Original' },
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: DATE,
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
  };
  original.hash = recordHash(original);
  const baseline = {
    source: { siteId: 'source', environmentId: 'source' },
    destination: { siteId: 'project', environmentId: 'main' },
    schema,
    options: {
      modelIds: [MODEL],
      uploads: 'all',
      includeDeletions: false,
      allowPartial: false,
      allowTemporarySchemaChanges: false,
    },
    counts: {
      record: { ...empty, update: 1 },
      upload: { ...empty },
      collection: { ...empty },
    },
    temporarySchemaChanges: [] as TemporarySchemaChange[],
    destinationTracking: { apiKey: 'schema_migration', model: null },
  } as PlanMetadata & { destinationTracking: { apiKey: string; model: null } };
  const environments = new Map([
    [
      'main',
      {
        id: 'main',
        meta: {
          primary: true,
          status: 'ready',
          read_only_mode: false,
          forked_from: null as string | null,
          created_at: DATE,
        },
      },
    ],
  ]);
  const records = new Map([['main', clone(original)]]);
  const fields = new Map([
    [
      'main',
      {
        validators: clone(schema.models[0].fields[0].validators),
        default_value: null as unknown,
      },
    ],
  ]);
  const clients = new Map<string, Client>();
  const events: string[] = [];
  const hooks: { afterCapture?: (environment: string) => void } = {};
  let uncertain = false;
  let wrongProject = false;
  let captures = 0;
  const notFound = () =>
    new CmaClient.ApiError({
      request: { method: 'GET', url: '/environments', headers: {} },
      response: {
        status: 404,
        statusText: 'Not found',
        headers: {},
        body: { data: [] },
      },
    });
  const client = (environment: string): Client => {
    if (clients.has(environment)) return clients.get(environment)!;
    const value = {
      config: { environment },
      users: { findMe: async () => ({ id: 'account', type: 'account' }) },
      site: { find: async () => ({ id: wrongProject ? 'wrong' : 'project' }) },
      environments: {
        find: async (id: string) => {
          const found = environments.get(id);
          if (!found) throw notFound();
          return clone(found);
        },
        fork: async (source: string, { id }: { id: string }) => {
          events.push(`fork:${id}`);
          const env = {
            id,
            meta: {
              primary: false,
              status: 'ready',
              read_only_mode: false,
              forked_from: source,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          };
          environments.set(id, env);
          records.set(id, clone(records.get(source)!));
          fields.set(id, clone(fields.get(source)!));
          if (uncertain) throw new Error('Uncertain fork request');
          return clone(env);
        },
        destroy: async (id: string) => {
          events.push(`destroy:${id}`);
          environments.delete(id);
        },
      },
      items: {
        find: async (id: string) => {
          assert.equal(id, RECORD);
          events.push(`read:${environment}`);
          return { id, title: records.get(environment)!.current.title };
        },
        update: async (id: string, payload: { title: string }) => {
          assert.equal(id, RECORD);
          events.push(`write:${environment}:${payload.title}`);
          const state = records.get(environment)!;
          state.current.title = payload.title;
          state.currentVersion = '2';
          state.hash = recordHash(state);
          return { id, title: payload.title };
        },
      },
      fields: {
        find: async (id: string) => {
          assert.equal(id, FIELD);
          return clone(fields.get(environment));
        },
        update: async (
          id: string,
          payload: {
            validators: JsonObject;
            default_value: unknown;
          },
        ) => {
          assert.equal(id, FIELD);
          events.push(`field:${environment}`);
          fields.set(environment, clone(payload));
          return { id, ...payload };
        },
      },
      scheduledPublication: {
        create: async (
          id: string,
          payload: {
            publication_scheduled_at: string;
            selective_publication: unknown;
          },
        ) => {
          assert.equal(id, RECORD);
          events.push(`publication:${environment}`);
          records.get(environment)!.schedules.publication = {
            at: payload.publication_scheduled_at,
            selective: null,
          };
        },
      },
      scheduledUnpublishing: {
        create: async () => assert.fail('unexpected unpublishing'),
      },
    } as unknown as Client;
    clients.set(environment, value);
    return value;
  };
  replace(
    artifact,
    'loadBaseline',
    async (
      directory: string,
      store: Parameters<typeof artifact.loadBaseline>[1],
    ) => {
      assert.equal(directory, '/fixture/migration.content');
      store.database.exec(
        'CREATE TEMP TABLE migration_baseline(kind TEXT,id TEXT,guard_json TEXT,original_json TEXT)',
      );
      store.database
        .prepare('INSERT INTO migration_baseline VALUES(?,?,?,?)')
        .run(
          'record',
          RECORD,
          JSON.stringify(recordGuard(original)),
          JSON.stringify(original),
        );
      return baseline;
    },
  );
  replace(
    schemaApi,
    'fetchSchema',
    async (_client: Client, environment: string) => {
      const value = clone(schema);
      value.environmentId = environment;
      value.siteId = wrongProject ? 'wrong' : 'project';
      value.models[0].fields[0].validators =
        fields.get(environment)!.validators;
      value.models[0].fields[0].defaultValue = fields.get(environment)!
        .default_value as null;
      value.hash = schemaApi.schemaHash(value);
      return value;
    },
  );
  replace(
    capture,
    'captureSnapshot',
    async (args: Parameters<typeof capture.captureSnapshot>[0]) => {
      captures++;
      args.store.putRecord(args.side, clone(records.get(args.environmentId)!));
      hooks.afterCapture?.(args.environmentId);
    },
  );
  replace(
    capture,
    'readRecordBatch',
    async (_client: Client, ids: string[]) => {
      assert.deepEqual(ids, [RECORD]);
      return [clone(records.get(_client.config.environment!)!)];
    },
  );
  replace(planner, 'createPlan', () =>
    assert.fail('Apply must never plan edited TypeScript'),
  );
  const options: DirectApplyOptions = {
    inPlace: false,
    allowPrimary: false,
    keepFailedFork: false,
    allowTemporarySchemaChanges: false,
    concurrency: 2,
    forkName: 'review',
  };
  const args = (
    work: (client: Client, signal?: AbortSignal) => Promise<void>,
    overrides: Partial<DirectApplyOptions> = {},
  ) => ({
    rootClient: client('main'),
    buildEnvironmentClient: client,
    scriptPath: '/fixture/migration.ts',
    definition: Object.assign(work, {
      options: { baseline: './migration.content' },
    }),
    options: { ...options, ...overrides },
  });
  return {
    schema,
    original,
    baseline,
    records,
    fields,
    environments,
    events,
    hooks,
    client,
    args,
    setUncertain: () => {
      uncertain = true;
    },
    setWrongProject: () => {
      wrongProject = true;
    },
    captures: () => captures,
  };
}

describe('direct content migration execution', () => {
  afterEach(() => {
    for (const reset of restore.splice(0).reverse()) reset();
  });
  it('runs edited control flow against the actual client and reports completion without predicting effects', async () => {
    const test = fixture();
    const result = await directApply(
      test.args(async (client) => {
        assert.equal(client, test.client('review'));
        const record = await client.items.find(RECORD);
        await client.items.update(RECORD, {
          title: `${record.title} edited directly`,
        });
      }),
    );
    assert.deepEqual(result, {
      environmentId: 'review',
      scriptExecuted: true,
      partial: false,
    });
    assert.deepEqual(test.events, [
      'fork:review',
      'read:review',
      'write:review:Original edited directly',
    ]);
    assert.equal(test.records.get('main')!.current.title, 'Original');
    assert.equal(test.captures(), 2);
  });
  it('checks the baseline without invoking callbacks or creating a fork in preflight-only mode', async () => {
    const test = fixture();
    const result = await directApply(
      test.args(async () => assert.fail('preflight executed the script'), {
        preflightOnly: true,
      }),
    );
    assert.deepEqual(result, {
      environmentId: 'main',
      preflightOnly: true,
      scriptExecuted: false,
      partial: false,
      generatedCounts: test.baseline.counts,
    });
    assert.deepEqual(test.events, []);
  });
  it('refuses destination drift, wrong projects and unapproved primary writes before execution', async () => {
    const test = fixture();
    test.records.get('main')!.currentVersion = '2';
    await assert.rejects(
      directApply(test.args(async () => assert.fail())),
      /differs from the migration baseline/,
    );
    test.records.set('main', clone(test.original));
    await assert.rejects(
      directApply(
        test.args(async () => assert.fail(), {
          inPlace: true,
          forkName: undefined,
        }),
      ),
      /requires --allow-primary/,
    );
    test.setWrongProject();
    await assert.rejects(
      directApply(test.args(async () => assert.fail())),
      /project does not match/,
    );
    assert.deepEqual(test.events, []);
  });
  it('preserves existing and unconfirmed forks while deleting only a confirmed failed fork', async () => {
    const test = fixture();
    await assert.rejects(
      directApply(
        test.args(async () => {
          throw new Error('Script failed');
        }),
      ),
      /Script failed/,
    );
    assert.deepEqual(test.events, ['fork:review', 'destroy:review']);
    assert.equal(test.environments.has('main'), true);
    test.setUncertain();
    await assert.rejects(
      directApply(test.args(async () => assert.fail())),
      (error: Error & { unconfirmedForkEnvironmentId?: string }) => {
        assert.equal(error.unconfirmedForkEnvironmentId, 'review');
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    await assert.rejects(
      directApply(test.args(async () => assert.fail())),
      /already exists/,
    );
    assert.equal(
      test.events.filter((event) => event.startsWith('destroy')).length,
      1,
    );
  });
  it('refuses a sandbox promoted during baseline capture before invoking the script', async () => {
    const test = fixture();
    test.environments.get('main')!.meta.primary = false;
    test.hooks.afterCapture = () => {
      test.environments.get('main')!.meta.primary = true;
    };
    await assert.rejects(
      directApply(
        test.args(async () => assert.fail('promoted sandbox executed'), {
          inPlace: true,
          forkName: undefined,
        }),
      ),
      /is now primary/,
    );
    assert.deepEqual(test.events, []);
  });

  it('refuses an owned fork promoted during its baseline capture', async () => {
    const test = fixture();
    test.hooks.afterCapture = (environment) => {
      if (environment === 'review')
        test.environments.get('review')!.meta.primary = true;
    };
    await assert.rejects(
      directApply(test.args(async () => assert.fail('promoted fork executed'))),
      /is now primary/,
    );
    assert.deepEqual(test.events, ['fork:review']);
    assert.equal(test.environments.has('review'), true);
  });

  it('refuses a replaced environment after baseline capture', async () => {
    const test = fixture();
    test.hooks.afterCapture = () => {
      test.environments.get('main')!.meta.created_at =
        '2026-02-01T00:00:00.000Z';
    };
    await assert.rejects(
      directApply(test.args(async () => assert.fail('replacement executed'))),
      /replaced or its ownership metadata changed/,
    );
    assert.deepEqual(test.events, []);
  });

  it('never restores fields into a failed fork promoted or replaced by another operation', async () => {
    const test = fixture();
    test.baseline.temporarySchemaChanges = [
      {
        fieldId: FIELD,
        modelId: MODEL,
        original: { validators: { required: {} }, defaultValue: null },
        temporary: { validators: {}, defaultValue: null },
        reasons: ['fixture'],
      },
    ];
    await assert.rejects(
      directApply(
        test.args(
          async (client) => {
            await client.fields.update(FIELD, {
              validators: {},
              default_value: null,
            });
            test.environments.get('review')!.meta.primary = true;
            throw new Error('Script failed after promotion');
          },
          { allowTemporarySchemaChanges: true },
        ),
      ),
      /Restoration was not authorized/,
    );
    assert.deepEqual(test.fields.get('review')!.validators, {});
    assert.deepEqual(test.events, ['fork:review', 'field:review']);
  });

  it('reports the confirmed fork kept after failure', async () => {
    const test = fixture();
    await assert.rejects(
      directApply(
        test.args(
          async () => {
            throw new Error('Script failed');
          },
          { keepFailedFork: true },
        ),
      ),
      (error: Error & { keptForkEnvironmentId?: string }) => {
        assert.equal(error.keptForkEnvironmentId, 'review');
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, ['fork:review']);
  });
  it('authorizes declared temporary settings and restores exact temporary values after a failed script', async () => {
    const test = fixture();
    test.baseline.temporarySchemaChanges = [
      {
        fieldId: FIELD,
        modelId: MODEL,
        original: { validators: { required: {} }, defaultValue: null },
        temporary: { validators: {}, defaultValue: null },
        reasons: ['fixture'],
      },
    ];
    const work = async (client: Client) => {
      await client.fields.update(FIELD, {
        validators: {},
        default_value: null,
      });
      throw new Error('Interrupted fixture');
    };
    await assert.rejects(
      directApply(test.args(work)),
      /requires --allow-temporary-schema-changes/,
    );
    assert.deepEqual(test.events, []);
    await assert.rejects(
      directApply(
        test.args(work, {
          allowTemporarySchemaChanges: true,
          inPlace: true,
          allowPrimary: true,
          forkName: undefined,
        }),
      ),
      /Interrupted fixture/,
    );
    assert.deepEqual(test.fields.get('main')!.validators, { required: {} });
    assert.deepEqual(test.events, ['field:main', 'field:main']);
  });
  it('never overwrites unrelated field edits during emergency restoration', async () => {
    const test = fixture();
    test.baseline.temporarySchemaChanges = [
      {
        fieldId: FIELD,
        modelId: MODEL,
        original: { validators: { required: {} }, defaultValue: null },
        temporary: { validators: {}, defaultValue: null },
        reasons: ['fixture'],
      },
    ];
    await assert.rejects(
      directApply(
        test.args(
          async (client) => {
            await client.fields.update(FIELD, {
              validators: { length: { min: 3 } },
              default_value: null,
            });
            throw new Error('failed');
          },
          {
            allowTemporarySchemaChanges: true,
            inPlace: true,
            allowPrimary: true,
            forkName: undefined,
          },
        ),
      ),
      /settings differ from the original/,
    );
    assert.deepEqual(test.fields.get('main')!.validators, {
      length: { min: 3 },
    });
  });
  it('disables schedule-window checks explicitly at zero and otherwise refuses near schedules', async () => {
    const test = fixture();
    test.original.schedules.publication = {
      at: '2020-01-01T00:00:00.000Z',
      selective: null,
    };
    test.original.hash = recordHash(test.original);
    test.records.set('main', clone(test.original));
    await assert.rejects(
      directApply(
        test.args(async () => assert.fail(), { preflightOnly: true }),
      ),
      /schedule.*within the 120-minute schedule window/,
    );
    const result = await directApply(
      test.args(async () => assert.fail(), {
        preflightOnly: true,
        scheduleWindowMinutes: 0,
      }),
    );
    assert.equal(result.scriptExecuted, false);
    assert.deepEqual(test.events, []);
  });

  it('restores a cancelled original schedule after in-place failure without guessing edited schedules', async () => {
    const test = fixture();
    test.original.schedules.publication = {
      at: '2099-01-01T00:00:00.000Z',
      selective: null,
    };
    test.original.hash = recordHash(test.original);
    test.records.set('main', clone(test.original));
    await assert.rejects(
      directApply(
        test.args(
          async () => {
            test.records.get('main')!.schedules.publication = null;
            throw new Error('Cancelled before content writes');
          },
          { inPlace: true, allowPrimary: true, forkName: undefined },
        ),
      ),
      /Cancelled before content writes/,
    );
    assert.deepEqual(
      test.records.get('main')!.schedules,
      test.original.schedules,
    );
    assert.deepEqual(test.events, ['publication:main']);
  });

  it('retains a fork whose ownership metadata changed before failed-run cleanup', async () => {
    const test = fixture();
    await assert.rejects(
      directApply(
        test.args(async () => {
          test.environments.get('review')!.meta.created_at =
            '2026-02-01T00:00:00.000Z';
          throw new Error('Script failed');
        }),
      ),
      /ownership could not be proven/,
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, ['fork:review']);
  });

  it('repairs original field settings and schedules without calling the migration or a planner', async () => {
    const test = fixture();
    test.baseline.temporarySchemaChanges = [
      {
        fieldId: FIELD,
        modelId: MODEL,
        original: { validators: { required: {} }, defaultValue: null },
        temporary: { validators: {}, defaultValue: null },
        reasons: ['fixture'],
      },
    ];
    test.fields.get('main')!.validators = {};
    test.original.schedules.publication = {
      at: '2099-01-01T00:00:00.000Z',
      selective: null,
    };
    test.original.hash = recordHash(test.original);
    const args = test.args(async () => assert.fail('repair ran script'));
    const result = await directRepair({
      ...args,
      options: { allowPrimary: true },
    });
    assert.deepEqual(result, {
      environmentId: 'main',
      restoredFields: 1,
      restoredSchedules: 1,
    });
    assert.deepEqual(test.events, ['field:main', 'publication:main']);
  });
  it('repairs from the generated sibling companion without any executable definition', async () => {
    const test = fixture();
    const args = test.args(async () =>
      assert.fail('repair evaluated a definition'),
    );
    const { definition: _definition, ...withoutDefinition } = args;
    assert.deepEqual(
      await directRepair({
        ...withoutDefinition,
        options: { allowPrimary: true },
      }),
      { environmentId: 'main', restoredFields: 0, restoredSchedules: 0 },
    );
    assert.deepEqual(test.events, []);
  });

  it('leaves schedules alone when the content differs from the original baseline', async () => {
    const test = fixture();
    test.original.schedules.publication = {
      at: '2099-01-01T00:00:00.000Z',
      selective: null,
    };
    test.original.hash = recordHash(test.original);
    test.records.get('main')!.current.title = 'Unknown edited state';
    await assert.rejects(
      directRepair({
        ...test.args(async () => assert.fail()),
        options: { allowPrimary: true },
      }),
      /content differs from the original baseline/,
    );
    assert.deepEqual(test.events, []);
  });
});
