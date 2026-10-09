import assert from 'node:assert/strict';
import { CmaClient } from '@datocms/cli-utils';
import { afterEach, describe, it } from 'mocha';
import { applyMigration } from '../src/engine/apply';
import * as capture from '../src/engine/capture';
import { recordGuard, recordHash } from '../src/engine/codec';
import {
  ContentError,
  type ContentFailureContext,
  DESTINATION_CHANGED_MESSAGE,
} from '../src/engine/errors';
import * as artifact from '../src/engine/migration-artifact';
import * as planner from '../src/engine/planner';
import * as schemaApi from '../src/engine/schema';
import type {
  ApplyOptions,
  Client,
  PlanMetadata,
  RecordState,
  SchemaState,
} from '../src/engine/types';
import { fixtureId } from './fixture-id';

const restore: Array<() => void> = [];
function replace(target: object, key: string, value: unknown) {
  const before = Reflect.get(target, key);
  Reflect.set(target, key, value);
  restore.push(() => Reflect.set(target, key, before));
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const MODEL = fixtureId('apply-model');
const FIELD = fixtureId('apply-field');
const RECORD = fixtureId('apply-record');
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
        saveInvalidDrafts: false,
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
    },
    counts: {
      record: { ...empty, update: 1 },
      upload: { ...empty },
      collection: { ...empty },
    },
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
  const clients = new Map<string, Client>();
  const events: string[] = [];
  const forkQueries: Array<Record<string, unknown>> = [];
  const hooks: { afterCapture?: (environment: string) => void } = {};
  let uncertain = false;
  let wrongProject = false;
  let captures = 0;
  const verifications: Array<[string, string]> = [];
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
        list: async () => [...environments.values()].map(clone),
        find: async (id: string) => {
          const found = environments.get(id);
          if (!found) throw notFound();
          return clone(found);
        },
        fork: async (
          source: string,
          { id }: { id: string },
          query: Record<string, unknown>,
        ) => {
          events.push(`fork:${id}`);
          forkQueries.push(query);
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
        'CREATE TEMP TABLE migration_baseline(kind TEXT,id TEXT,guard_json TEXT)',
      );
      store.database
        .prepare('INSERT INTO migration_baseline VALUES(?,?,?)')
        .run('record', RECORD, JSON.stringify(recordGuard(original)));
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
      return value;
    },
  );
  replace(
    capture,
    'captureSnapshot',
    async (args: Parameters<typeof capture.captureSnapshot>[0]) => {
      captures++;
      verifications.push([args.environmentId, args.verify]);
      args.store.putRecord(args.side, clone(records.get(args.environmentId)!));
      hooks.afterCapture?.(args.environmentId);
    },
  );
  replace(planner, 'createPlan', () =>
    assert.fail('Apply must never plan edited TypeScript'),
  );
  const options: ApplyOptions = {
    inPlace: false,
    allowPrimary: false,
    keepFailedFork: false,
    concurrency: 2,
    fastFork: true,
    forkName: 'review',
  };
  const builds: Array<[string, boolean]> = [];
  const args = (
    work: (client: Client) => Promise<void>,
    overrides: Partial<ApplyOptions> = {},
  ) => ({
    rootClient: client('main'),
    buildEnvironmentClient: (environment: string, fetchFn?: typeof fetch) => {
      builds.push([environment, typeof fetchFn === 'function']);
      return client(environment);
    },
    scriptPath: '/fixture/migration.ts',
    // Preflight never loads the script.
    definition: overrides.preflightOnly
      ? undefined
      : Object.assign(work, {
          options: { baseline: './migration.content' },
        }),
    options: { ...options, ...overrides },
  });
  return {
    schema,
    original,
    baseline,
    records,
    environments,
    events,
    forkQueries,
    hooks,
    client,
    args,
    builds,
    setUncertain: () => {
      uncertain = true;
    },
    setWrongProject: () => {
      wrongProject = true;
    },
    captures: () => captures,
    verifications,
  };
}

const validationError = (code: string) =>
  new CmaClient.ApiError({
    request: {
      method: 'PUT',
      url: `https://site-api.datocms.com/items/${RECORD}`,
      headers: {},
    },
    response: {
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: {},
      body: {
        data: [
          {
            id: 'error',
            type: 'api_error',
            attributes: {
              code: 'INVALID_FIELD',
              details: { field: 'title', code },
              doc_url: '',
            },
          },
        ],
      },
    },
  });

describe('content migration execution', () => {
  afterEach(() => {
    for (const reset of restore.splice(0).reverse()) reset();
  });
  it('runs edited control flow against the actual client and reports completion without predicting effects', async () => {
    const test = fixture();
    const result = await applyMigration(
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
    // A change during the destination capture is carried into the fork, so
    // only the fork's capture is confirmed.
    assert.deepEqual(test.verifications, [
      ['main', 'none'],
      ['review', 'versions'],
    ]);
    // Only the execution client observes requests through a tracked fetchFn.
    assert.deepEqual(test.builds, [
      ['main', false],
      ['review', false],
      ['review', true],
    ]);
  });
  it('checks the baseline without invoking callbacks or creating a fork in preflight-only mode', async () => {
    const test = fixture();
    const result = await applyMigration(
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
    assert.deepEqual(test.verifications, [['main', 'versions']]);
  });
  it('reports every baseline difference with the same instruction and the first difference', async () => {
    const changed = (details: unknown) => (error: unknown) => {
      assert(error instanceof ContentError);
      assert.equal(error.code, 'DESTINATION_CHANGED');
      assert.equal(error.message, DESTINATION_CHANGED_MESSAGE);
      assert.deepEqual(error.details, details);
      return true;
    };
    const test = fixture();
    test.records.get('main')!.currentVersion = '2';
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      changed({ kind: 'record', id: RECORD, reason: 'changed' }),
    );
    test.records.set('main', clone(test.original));
    // The destination changes after its own check, so only the fork differs.
    test.hooks.afterCapture = (environment) => {
      if (environment === 'main')
        test.records.get('main')!.currentVersion = '3';
    };
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      changed({ kind: 'record', id: RECORD, reason: 'changed' }),
    );
    // The fork that failed its own check is removed.
    assert.deepEqual(test.events, ['fork:review', 'destroy:review']);
    test.hooks.afterCapture = undefined;
    replace(schemaApi, 'fetchSchema', async () => ({
      ...clone(test.schema),
      hash: 'different',
    }));
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      changed({ reason: 'schema' }),
    );
    replace(schemaApi, 'fetchSchema', async () => clone(test.schema));
    replace(capture, 'captureSnapshot', async () => {
      throw new ContentError(
        'CAPTURE_DRIFT',
        'Record x changed during capture.',
      );
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      changed({
        reason: 'drift',
        description: 'Record x changed during capture.',
      }),
    );
    // Generation encoded every destination value, so a value the codec
    // refuses now was written afterwards.
    const refusal =
      'Integer field model.count cannot be represented as an exact safe integer.';
    replace(capture, 'captureSnapshot', async () => {
      throw new ContentError('UNSUPPORTED_INTEGER_PRECISION', refusal);
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      changed({ reason: 'drift', description: refusal }),
    );
    replace(capture, 'captureSnapshot', async () => {
      throw new ContentError('INVALID_RESPONSE', 'Expected a JSON object.');
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: ContentError) => error.code === 'INVALID_RESPONSE',
    );
  });
  it('refuses wrong projects and unapproved primary writes before execution', async () => {
    const test = fixture();
    await assert.rejects(
      applyMigration(
        test.args(async () => assert.fail(), {
          inPlace: true,
          forkName: undefined,
        }),
      ),
      /requires --allow-primary/,
    );
    test.setWrongProject();
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: ContentError) => error.code === 'DESTINATION_MISMATCH',
    );
    assert.deepEqual(test.events, []);
  });
  it('deletes a failed fork, including one whose fork request failed after creating it', async () => {
    const test = fixture();
    await assert.rejects(
      applyMigration(
        test.args(async () => {
          throw new Error('Script failed');
        }),
      ),
      (error: Error & { keptForkEnvironmentId?: string }) => {
        assert.equal(
          error.message,
          'Script failed The fork "review" was deleted; "main" was not changed.',
        );
        assert.equal(error.keptForkEnvironmentId, undefined);
        return true;
      },
    );
    assert.deepEqual(test.events, ['fork:review', 'destroy:review']);
    assert.equal(test.environments.has('main'), true);
    test.setUncertain();
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      /Uncertain fork request/,
    );
    assert.equal(test.environments.has('review'), false);
    assert.deepEqual(test.events.slice(2), ['fork:review', 'destroy:review']);
  });
  it('keeps the original failure when the failed fork cannot be removed', async () => {
    const test = fixture();
    const before = process.listenerCount('unhandledRejection');
    let during = 0;
    replace(test.client('main').environments, 'destroy', async () => {
      during = process.listenerCount('unhandledRejection');
      throw new Error('destroy failed');
    });
    await assert.rejects(
      applyMigration(
        test.args(async () => {
          throw validationError('VALIDATION_UNIQUE');
        }),
      ),
      (error: ContentError) => {
        assert.equal(error.code, 'APPLY_FAILED_CLEANUP_INCOMPLETE');
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.equal(error.forkOutcomeStated, true);
        assert.match(
          error.message,
          /^The CMA rejected PUT .* The failed fork "review" could not be removed: Error: destroy failed$/,
        );
        const cause = error.details?.cause as {
          code: string;
          details: Record<string, unknown>;
        };
        assert.equal(error.details?.forkId, 'review');
        assert.equal(cause.code, 'CMA_VALIDATION_FAILED');
        assert.equal(cause.details.status, 422);
        return true;
      },
    );
    // Unawaited calls cannot end the process while the fork is removed.
    assert.equal(during, before + 1);
    assert.equal(process.listenerCount('unhandledRejection'), before);
    test.environments.delete('review');
    test.hooks.afterCapture = (environment) => {
      if (environment === 'main')
        test.records.get('main')!.currentVersion = '3';
    };
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: ContentError) => {
        assert.equal(error.code, 'APPLY_FAILED_CLEANUP_INCOMPLETE');
        assert.deepEqual(error.details?.cause, {
          code: 'DESTINATION_CHANGED',
          details: { kind: 'record', id: RECORD, reason: 'changed' },
        });
        return true;
      },
    );
  });
  it('removes a fork that ends in a failed status, or leaves its outcome to the caller when kept', async () => {
    for (const keepFailedFork of [false, true]) {
      const test = fixture();
      const environments = test.client('main').environments;
      const find = environments.find.bind(environments);
      replace(environments, 'find', async (id: string) => {
        const found = await find(id);
        return id === 'review'
          ? { ...found, meta: { ...found.meta, status: 'failed' } }
          : found;
      });
      await assert.rejects(
        applyMigration(
          test.args(async () => assert.fail(), { keepFailedFork }),
        ),
        (error: ContentError) => {
          assert.equal(error.code, 'FORK_FAILED');
          assert.equal(
            error.keptForkEnvironmentId,
            keepFailedFork ? 'review' : undefined,
          );
          // The message does not say the fork was kept; the command adds it.
          assert.equal(error.forkOutcomeStated, undefined);
          return true;
        },
      );
      assert.deepEqual(
        test.events,
        keepFailedFork ? ['fork:review'] : ['fork:review', 'destroy:review'],
      );
    }
  });
  it('never removes an environment whose fork request DatoCMS rejected', async () => {
    const test = fixture();
    // Someone else takes the ID during the destination capture.
    test.hooks.afterCapture = (environment) => {
      if (environment === 'main')
        test.environments.set('review', {
          id: 'review',
          meta: { ...test.environments.get('main')!.meta, primary: false },
        });
    };
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: ContentError) => error.code === 'FORK_ID_COLLISION',
    );
    assert.deepEqual(test.events, []);
    test.hooks.afterCapture = undefined;
    test.environments.delete('review');
    const rejection = new CmaClient.ApiError({
      request: { method: 'POST', url: '/environments/main/fork', headers: {} },
      response: {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {},
        body: { data: [] },
      },
    });
    replace(test.client('main').environments, 'fork', async () => {
      throw rejection;
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: Error & { keptForkEnvironmentId?: string }) => {
        assert.equal(error === rejection, true);
        assert.equal(error.keptForkEnvironmentId, undefined);
        return true;
      },
    );
    // An environment under the ID after a rejected request may come from
    // someone else right after the second check, or from a retried request
    // of this run whose first attempt timed out: kept and reported.
    replace(test.client('main').environments, 'fork', async () => {
      test.environments.set('review', {
        id: 'review',
        meta: { ...test.environments.get('main')!.meta, primary: false },
      });
      throw rejection;
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: Error & ContentFailureContext) => {
        assert.equal(error === rejection, true);
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.equal(error.forkOutcomeStated, true);
        assert.match(
          error.message,
          /The fork "review" was kept: an environment with that ID exists after the fork request failed/,
        );
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, []);
  });
  it('refuses a fork ID that is already in use without touching it', async () => {
    const test = fixture();
    test.environments.set('review', {
      id: 'review',
      meta: { ...test.environments.get('main')!.meta, primary: false },
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: ContentError) => error.code === 'FORK_ID_COLLISION',
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, []);
  });
  it('reports the fork kept after failure', async () => {
    const test = fixture();
    await assert.rejects(
      applyMigration(
        test.args(
          async () => {
            throw new Error('Script failed');
          },
          { keepFailedFork: true },
        ),
      ),
      (error: Error & ContentFailureContext) => {
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.equal(error.forkOutcomeStated, true);
        assert.match(error.message, /The fork "review" was kept/);
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, ['fork:review']);
  });
  it('reports a script that rejects with a value that is not an error, and the fork it kept', async () => {
    const test = fixture();
    await assert.rejects(
      applyMigration(
        test.args(() => Promise.reject('oops'), { keepFailedFork: true }),
      ),
      (error: ContentError) => {
        assert.equal(error.code, 'MIGRATION_FAILED');
        assert.equal(
          error.message,
          'The migration callback failed: oops The fork "review" was kept; "main" was not changed.',
        );
        assert.equal(error.keptForkEnvironmentId, 'review');
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, ['fork:review']);
  });
  it('wraps CMA rejections raised by the script and removes the fork', async () => {
    const test = fixture();
    await assert.rejects(
      applyMigration(
        test.args(async () => {
          throw validationError('VALIDATION_UNIQUE');
        }),
      ),
      (error: ContentError) => {
        assert.equal(error.code, 'CMA_VALIDATION_FAILED');
        assert.match(
          error.message,
          new RegExp(
            `^The CMA rejected PUT /items/${RECORD}: INVALID_FIELD \\(title: VALIDATION_UNIQUE\\)\\. A unique value may still be held by another record`,
          ),
        );
        assert.match(error.message, /The fork "review" was deleted/);
        assert.equal(error.details?.status, 422);
        return true;
      },
    );
    assert.deepEqual(test.events, ['fork:review', 'destroy:review']);
  });
  it('requests a fast fork unless a regular fork is asked for', async () => {
    const fast = fixture();
    await applyMigration(fast.args(async () => {}));
    assert.deepEqual(fast.forkQueries, [
      { immediate_return: true, fast: true },
    ]);
    const regular = fixture();
    await applyMigration(regular.args(async () => {}, { fastFork: false }));
    assert.deepEqual(regular.forkQueries, [{ immediate_return: true }]);
  });

  it('explains a fast fork refused while users are editing, and removes nothing', async () => {
    const test = fixture();
    const refusal = new CmaClient.ApiError({
      request: { method: 'POST', url: '/environments/main/fork', headers: {} },
      response: {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {},
        body: {
          data: [
            {
              id: 'error',
              type: 'api_error',
              attributes: {
                code: 'ACTIVE_EDITING_SESSIONS',
                details: {},
                doc_url: '',
              },
            },
          ],
        },
      },
    });
    const message =
      'Cannot proceed with a fast fork of "main", as some users are currently editing records.';
    const suggestions = [
      'Run again once nobody is editing records in the destination',
      'Use --no-fast-fork to create a regular fork, which does not block the destination while it copies',
    ];
    replace(test.client('main').environments, 'fork', async () => {
      throw refusal;
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (
        error: ContentError &
          ContentFailureContext & { suggestions?: string[] },
      ) => {
        assert.equal(error.code, 'FAST_FORK_BLOCKED');
        assert.equal(error.message, message);
        assert.deepEqual(error.suggestions, suggestions);
        assert.equal(error.keptForkEnvironmentId, undefined);
        return true;
      },
    );
    assert.deepEqual(test.events, []);
    // A refused request creates no fork, so an environment that answers to
    // the ID afterwards is reported as kept and never removed.
    replace(test.client('main').environments, 'fork', async () => {
      test.environments.set('review', {
        id: 'review',
        meta: { ...test.environments.get('main')!.meta, primary: false },
      });
      throw refusal;
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (
        error: ContentError &
          ContentFailureContext & { suggestions?: string[] },
      ) => {
        assert.equal(error.code, 'FAST_FORK_BLOCKED');
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.equal(error.forkOutcomeStated, true);
        assert.ok(error.message.startsWith(message));
        assert.match(
          error.message,
          /The fork "review" was kept: an environment with that ID exists after the fork request failed/,
        );
        assert.deepEqual(error.suggestions, suggestions);
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, []);
  });

  it('leaves forking a read-only destination to the CMA and refuses it only in place', async () => {
    const test = fixture();
    test.environments.get('main')!.meta.read_only_mode = true;
    const result = await applyMigration(test.args(async () => {}));
    assert.equal(result.environmentId, 'review');
    assert.deepEqual(test.events, ['fork:review']);
    await assert.rejects(
      applyMigration(
        test.args(async () => assert.fail(), {
          inPlace: true,
          allowPrimary: true,
          forkName: undefined,
        }),
      ),
      (error: ContentError) => error.code === 'DESTINATION_UNAVAILABLE',
    );
  });

  it('looks a possibly created fork up in the listing, never by its name', async () => {
    const test = fixture();
    const environments = test.client('main').environments;
    const find = environments.find.bind(environments);
    const forkName = 'x/../../items/record';
    const found: string[] = [];
    replace(environments, 'find', async (id: string) => {
      found.push(id);
      return find(id);
    });
    replace(environments, 'fork', async () => {
      throw new Error('Uncertain fork request');
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail(), { forkName })),
      /Uncertain fork request/,
    );
    assert.deepEqual(found, ['main']);
    assert.deepEqual(test.events, []);
  });

  it('reports a kept fork with the original failure when its lookup fails', async () => {
    const test = fixture();
    const environments = test.client('main').environments;
    const list = environments.list.bind(environments);
    let ran = false;
    replace(environments, 'list', async () => {
      if (ran) throw new Error('lookup failed');
      return list();
    });
    await assert.rejects(
      applyMigration(
        test.args(
          async () => {
            ran = true;
            throw validationError('VALIDATION_UNIQUE');
          },
          { keepFailedFork: true },
        ),
      ),
      (error: ContentError) => {
        assert.equal(error.code, 'CMA_VALIDATION_FAILED');
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.match(
          error.message,
          /The fork "review" was kept; "main" was not changed\.$/,
        );
        return true;
      },
    );
    assert.deepEqual(test.events, ['fork:review']);
  });

  it('requests no fork when interrupted while the fork ID is checked again', async () => {
    const test = fixture();
    const controller = new AbortController();
    const environments = test.client('main').environments;
    const list = environments.list.bind(environments);
    let lists = 0;
    environments.list = async () => {
      // The second check runs right before the fork request.
      if (++lists === 2) controller.abort();
      return list();
    };
    await assert.rejects(
      applyMigration(
        test.args(async () => assert.fail(), { signal: controller.signal }),
      ),
      (error: ContentError) => error.code === 'INTERRUPTED',
    );
    assert.equal(lists, 2);
    assert.deepEqual(test.events, []);
  });

  it('reports a schema change that fails a capture request as a changed destination', async () => {
    const test = fixture();
    const missing = new CmaClient.ApiError({
      request: { method: 'GET', url: '/items', headers: {} },
      response: {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {},
        body: { data: [] },
      },
    });
    let schemaReads = 0;
    replace(schemaApi, 'fetchSchema', async () => {
      schemaReads++;
      // The model disappears while its records are listed.
      return schemaReads === 1
        ? clone(test.schema)
        : { ...clone(test.schema), models: [], hash: 'changed' };
    });
    replace(capture, 'captureSnapshot', async () => {
      throw missing;
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: ContentError) => {
        assert.equal(error.code, 'DESTINATION_CHANGED');
        assert.equal(error.message, DESTINATION_CHANGED_MESSAGE);
        assert.deepEqual(error.details, { reason: 'schema' });
        return true;
      },
    );
    // An unchanged schema keeps the request's own error.
    replace(schemaApi, 'fetchSchema', async () => clone(test.schema));
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: unknown) => error === missing,
    );
  });

  it('reports a schema change that leaves a captured block unreadable as a changed destination', async () => {
    const test = fixture();
    const unknownModel = new ContentError(
      'INVALID_MODEL',
      'Content refers to unknown model new-block.',
    );
    let schemaReads = 0;
    replace(schemaApi, 'fetchSchema', async () => {
      schemaReads++;
      // A block model is added and used while records are listed.
      return schemaReads === 1
        ? clone(test.schema)
        : { ...clone(test.schema), hash: 'changed' };
    });
    replace(capture, 'captureSnapshot', async () => {
      throw unknownModel;
    });
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: ContentError) => {
        assert.equal(error.code, 'DESTINATION_CHANGED');
        assert.deepEqual(error.details, { reason: 'schema' });
        return true;
      },
    );
    replace(schemaApi, 'fetchSchema', async () => clone(test.schema));
    await assert.rejects(
      applyMigration(test.args(async () => assert.fail())),
      (error: unknown) => error === unknownModel,
    );
  });

  it('leaves an in-place failure exactly as the script left it and says so', async () => {
    const test = fixture();
    test.original.schedules.publication = {
      at: '2099-01-01T00:00:00.000Z',
      selective: null,
    };
    test.original.hash = recordHash(test.original);
    test.records.set('main', clone(test.original));
    await assert.rejects(
      applyMigration(
        test.args(
          async () => {
            test.records.get('main')!.schedules.publication = null;
            throw new Error('Cancelled before content writes');
          },
          {
            inPlace: true,
            allowPrimary: true,
            forkName: undefined,
            verification: 'full',
          },
        ),
      ),
      (error: Error) => {
        assert.equal(
          error.message,
          'Cancelled before content writes Writes made before the failure remain in "main".',
        );
        return true;
      },
    );
    assert.equal(test.records.get('main')!.schedules.publication, null);
    assert.deepEqual(test.events, []);
    assert.deepEqual(test.verifications, [['main', 'full']]);
  });
});
