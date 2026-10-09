import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { after, afterEach, before, describe, it } from 'mocha';
import { applyContentDiff } from '../src/engine/apply';
import { recordHash } from '../src/engine/codec';
import {
  ContentError,
  type ContentFailureContext,
  DESTINATION_CHANGED_MESSAGE,
} from '../src/engine/errors';
import * as schemaApi from '../src/engine/schema';
import type {
  ApplyOptions,
  Client,
  PlanCounts,
  RecordState,
  SchemaState,
} from '../src/engine/types';
import { cmaFixture } from './cma-fixture';
import { fixtureId } from './fixture-id';
import { content, diff, writeTestDiff } from './pipeline';

const restore: Array<() => void> = [];
function replace(target: object, key: string, value: unknown) {
  const before = Reflect.get(target, key);
  Reflect.set(target, key, value);
  restore.push(() => Reflect.set(target, key, before));
}
const clone = <T>(value: T): T => structuredClone(value);
const MODEL = fixtureId('apply-model');
const RECORD = fixtureId('apply-record');
const DATE = '2025-01-01T00:00:00.000Z';
const SCHEMA: SchemaState = {
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
          id: fixtureId('apply-field'),
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
SCHEMA.hash = schemaApi.schemaHash(SCHEMA);

function record(overrides: Partial<RecordState>): RecordState {
  const state: RecordState = {
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
    ...overrides,
  };
  state.hash = recordHash(state);
  return state;
}
/** The destination holds a draft; the diff updates and publishes it. */
const original = record({});
const edited = record({
  current: { title: 'Edited' },
  published: { title: 'Edited' },
  currentVersion: '9',
  publishedUpdatedAt: DATE,
  firstPublishedAt: DATE,
});
const LABEL = `Publish Article "Edited" (${RECORD})`;

const environment = (id: string, primary: boolean) => ({
  id,
  meta: {
    primary,
    status: 'ready',
    read_only_mode: false,
    fork_completion_percentage: 100,
  },
});

/** The diff every test applies, written once. */
let directory: string;
let diffPath: string;
let counts: PlanCounts;

function fixture() {
  /** What the destination schema reads as; tests change it. */
  const schema = clone(SCHEMA);
  const site = { id: 'project' };
  const environments = new Map([['main', environment('main', true)]]);
  const contents = new Map([
    ['main', cmaFixture(content({ records: [original] }), SCHEMA)],
  ]);
  const events: string[] = [];
  const forkQueries: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  let failure: unknown;
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
  // The root client: the project and its environments.
  const root = {
    site: { find: async () => clone(site) },
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
        environments.set(id, environment(id, false));
        contents.set(id, cmaFixture(contents.get(source)!.snapshot(), SCHEMA));
        return clone(environments.get(id)!);
      },
      destroy: async (id: string) => {
        events.push(`destroy:${id}`);
        environments.delete(id);
      },
    },
  };
  replace(
    schemaApi,
    'fetchSchema',
    async (
      _client: Client,
      environmentId: string,
      project: (schema: SchemaState) => SchemaState,
    ) => project({ ...clone(schema), environmentId }),
  );
  const options: ApplyOptions = {
    inPlace: false,
    allowPrimary: false,
    keepFailedFork: false,
    concurrency: 2,
    fastFork: true,
    forkName: 'review',
    log: (message) => logs.push(message),
  };
  const apply = (overrides: Partial<ApplyOptions> = {}) =>
    applyContentDiff({
      rootClient: root as unknown as Client,
      buildEnvironmentClient: (id: string) => {
        const { client } = contents.get(id)!;
        if (failure)
          client.items.publish = async () => {
            throw failure;
          };
        return client;
      },
      diffPath,
      options: { ...options, ...overrides },
    });
  return {
    schema,
    site,
    environments,
    contents,
    events,
    forkQueries,
    logs,
    root,
    apply,
    /** Every publication, in every environment, rejects with `error`. */
    failPublication(error: unknown) {
      failure = error;
    },
    /** The record as an environment holds it. */
    record: (environmentId: string) =>
      contents.get(environmentId)!.records.get(RECORD)!,
    /** The writes the run made in an environment. */
    writes: (environmentId: string) =>
      contents.get(environmentId)?.events ?? [],
    checks: () => logs.filter((message) => message.startsWith('Checking')),
  };
}

const validationError = (code: string) =>
  new CmaClient.ApiError({
    request: {
      method: 'PUT',
      url: `https://site-api.datocms.com/items/${RECORD}/publish`,
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

const changed = (details: unknown) => (error: unknown) => {
  assert(error instanceof ContentError);
  assert.equal(error.code, 'DESTINATION_CHANGED');
  assert.equal(error.message, DESTINATION_CHANGED_MESSAGE);
  assert.deepEqual(error.details, details);
  return true;
};

describe('content diff apply', () => {
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-apply-test-'));
    const { plan, operations } = await diff({
      source: content({ records: [edited] }),
      target: content({ records: [original] }),
      sourceSchema: { ...SCHEMA, siteId: 'source', environmentId: 'source' },
      targetSchema: SCHEMA,
      options: {
        modelIds: [MODEL],
        uploads: 'all',
        includeDeletions: false,
        allowPartial: false,
      },
    });
    assert.deepEqual(
      operations.map((operation) => operation.op),
      ['record.update', 'record.publish'],
    );
    assert.equal(operations[1]!.label, LABEL);
    counts = plan.metadata.counts;
    diffPath = await writeTestDiff(directory, plan, operations);
  });
  after(() => rm(directory, { recursive: true, force: true }));
  afterEach(() => {
    for (const reset of restore.splice(0).reverse()) reset();
  });

  it('checks the destination and its fork, then runs the diff in the fork', async () => {
    const test = fixture();
    const result = await test.apply();
    assert.deepEqual(result, {
      environmentId: 'review',
      executed: true,
      operations: 2,
      partial: false,
    });
    assert.deepEqual(test.events, ['fork:review']);
    assert.deepEqual(test.writes('review'), [
      `update:${RECORD}`,
      `publish:${RECORD}`,
    ]);
    // The first update is locked to the version the diff expects.
    assert.deepEqual(test.contents.get('review')!.updates, [
      { id: RECORD, locked: true },
    ]);
    assert.deepEqual(test.record('review').published, { title: 'Edited' });
    assert.deepEqual(test.writes('main'), []);
    assert.equal(test.record('main').current.title, 'Original');
    // A change during the destination check is carried into the fork, whose
    // own check sees it.
    assert.deepEqual(test.logs, [
      'Checking what the diff touches in "main".',
      'Creating destination fork "review".',
      'Checking what the diff touches in "review".',
      'Running 2 operations in "review".',
    ]);
  });

  it('checks the destination without running anything or creating a fork in preflight-only mode', async () => {
    const test = fixture();
    const result = await test.apply({ preflightOnly: true });
    assert.deepEqual(result, {
      environmentId: 'main',
      preflightOnly: true,
      executed: false,
      operations: 2,
      partial: false,
      generatedCounts: counts,
    });
    assert.deepEqual(test.events, []);
    assert.deepEqual(test.writes('main'), []);
    assert.deepEqual(test.checks(), [
      'Checking what the diff touches in "main".',
    ]);
  });

  it('refuses a fork name already in use in preflight-only mode too', async () => {
    const test = fixture();
    test.environments.set('review', environment('review', false));
    await assert.rejects(
      test.apply({ preflightOnly: true }),
      (error: ContentError) => error.code === 'FORK_ID_COLLISION',
    );
    assert.deepEqual(test.events, []);
  });

  it('reports every destination difference with the same instruction and the first difference', async () => {
    const test = fixture();
    test.record('main').currentVersion = '2';
    await assert.rejects(
      test.apply(),
      changed({ kind: 'record', id: RECORD, reason: 'changed' }),
    );
    assert.deepEqual(test.events, []);
    test.record('main').currentVersion = '1';
    // The destination changes after its own check, so only the fork differs.
    const fork = test.root.environments.fork;
    replace(
      test.root.environments,
      'fork',
      async (...args: Parameters<typeof fork>) => {
        test.record('main').currentVersion = '3';
        return fork(...args);
      },
    );
    await assert.rejects(
      test.apply(),
      changed({ kind: 'record', id: RECORD, reason: 'changed' }),
    );
    // The fork that failed its own check is removed.
    assert.deepEqual(test.events, ['fork:review', 'destroy:review']);
    assert.deepEqual(test.writes('review'), []);
    test.events.length = 0;
    test.schema.locales = ['en', 'it'];
    await assert.rejects(test.apply(), changed({ reason: 'schema' }));
    test.schema.locales = ['en'];
    // The migration tracking model the diff was generated against is gone.
    replace(schemaApi, 'fetchSchema', async () => {
      throw new ContentError(
        'INVALID_MIGRATION_TRACKING_MODEL',
        'The exact migration tracking model is missing, renamed, or replaced.',
      );
    });
    await assert.rejects(test.apply(), changed({ reason: 'schema' }));
    assert.deepEqual(test.events, []);
  });

  it('reports a failed check request as itself', async () => {
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
    test.contents.get('main')!.client.items.rawList = async () => {
      throw missing;
    };
    await assert.rejects(test.apply(), (error: unknown) => error === missing);
    assert.deepEqual(test.events, []);
  });

  it('refuses wrong projects and unapproved primary writes before execution', async () => {
    const test = fixture();
    await assert.rejects(
      test.apply({ inPlace: true, forkName: undefined }),
      (error: ContentError) => {
        assert.equal(error.code, 'PRIMARY_REQUIRES_APPROVAL');
        assert.equal(
          error.message,
          'Applying in place to primary requires --allow-primary.',
        );
        return true;
      },
    );
    const mismatch = (error: ContentError) => {
      assert.equal(error.code, 'DESTINATION_MISMATCH');
      assert.equal(
        error.message,
        'Destination project does not match the diff.',
      );
      return true;
    };
    test.site.id = 'wrong';
    await assert.rejects(test.apply(), mismatch);
    // The environment client may still answer for another project.
    test.site.id = 'project';
    test.schema.siteId = 'wrong';
    await assert.rejects(test.apply(), mismatch);
    assert.deepEqual(test.events, []);
    assert.deepEqual(test.writes('main'), []);
  });

  it('deletes a failed fork, including one whose fork request failed after creating it', async () => {
    const test = fixture();
    test.failPublication(new Error('Publication failed'));
    await assert.rejects(
      test.apply(),
      (error: Error & ContentFailureContext) => {
        assert.equal(error.message, 'Publication failed');
        assert.equal(
          error.outcome,
          'The fork "review" was deleted; "main" was not changed.',
        );
        assert.equal(error.keptForkEnvironmentId, undefined);
        return true;
      },
    );
    assert.deepEqual(test.events, ['fork:review', 'destroy:review']);
    assert.equal(test.environments.has('main'), true);
    assert.equal(test.record('main').current.title, 'Original');
    const fork = test.root.environments.fork;
    replace(
      test.root.environments,
      'fork',
      async (...args: Parameters<typeof fork>) => {
        await fork(...args);
        throw new Error('Uncertain fork request');
      },
    );
    await assert.rejects(test.apply(), /Uncertain fork request/);
    assert.equal(test.environments.has('review'), false);
    assert.deepEqual(test.events.slice(2), ['fork:review', 'destroy:review']);
  });

  it('keeps the original failure when the failed fork cannot be removed', async () => {
    const test = fixture();
    replace(test.root.environments, 'destroy', async () => {
      throw new Error('destroy failed');
    });
    test.failPublication(validationError('VALIDATION_UNIQUE'));
    await assert.rejects(test.apply(), (error: ContentError) => {
      assert.equal(error.code, 'APPLY_FAILED_CLEANUP_INCOMPLETE');
      assert.equal(error.keptForkEnvironmentId, 'review');
      // The message itself says the fork could not be removed.
      assert.equal(error.outcome, undefined);
      assert.match(
        error.message,
        /^operations\/000001\.jsonl line 2, Publish Article .* The CMA rejected PUT .* The failed fork "review" could not be removed: Error: destroy failed$/,
      );
      const cause = error.details?.cause as {
        code: string;
        details: Record<string, unknown>;
      };
      assert.equal(error.details?.forkId, 'review');
      assert.equal(cause.code, 'CMA_VALIDATION_FAILED');
      assert.equal(cause.details.status, 422);
      return true;
    });
    test.environments.delete('review');
    const fork = test.root.environments.fork;
    replace(
      test.root.environments,
      'fork',
      async (...args: Parameters<typeof fork>) => {
        test.record('main').currentVersion = '3';
        return fork(...args);
      },
    );
    await assert.rejects(test.apply(), (error: ContentError) => {
      assert.equal(error.code, 'APPLY_FAILED_CLEANUP_INCOMPLETE');
      assert.deepEqual(error.details?.cause, {
        code: 'DESTINATION_CHANGED',
        details: { kind: 'record', id: RECORD, reason: 'changed' },
      });
      return true;
    });
  });

  it('removes a fork that ends in a failed status, or says it was kept', async () => {
    for (const keepFailedFork of [false, true]) {
      const test = fixture();
      const find = test.root.environments.find;
      replace(test.root.environments, 'find', async (id: string) => {
        const found = await find(id);
        return id === 'review'
          ? { ...found, meta: { ...found.meta, status: 'failed' } }
          : found;
      });
      await assert.rejects(
        test.apply({ keepFailedFork }),
        (error: ContentError) => {
          assert.equal(error.code, 'FORK_FAILED');
          assert.equal(error.message, 'Fork "review" ended in status failed.');
          assert.equal(
            error.keptForkEnvironmentId,
            keepFailedFork ? 'review' : undefined,
          );
          assert.equal(
            error.outcome,
            keepFailedFork ? 'The fork "review" was kept.' : undefined,
          );
          return true;
        },
      );
      assert.deepEqual(
        test.events,
        keepFailedFork ? ['fork:review'] : ['fork:review', 'destroy:review'],
      );
      assert.deepEqual(test.writes('review'), []);
    }
  });

  it('never removes an environment whose fork request DatoCMS rejected', async () => {
    const test = fixture();
    const list = test.root.environments.list;
    let lists = 0;
    // Someone else takes the ID while the destination is checked.
    replace(test.root.environments, 'list', async () => {
      if (++lists === 2)
        test.environments.set('review', environment('review', false));
      return list();
    });
    await assert.rejects(
      test.apply(),
      (error: ContentError) => error.code === 'FORK_ID_COLLISION',
    );
    assert.deepEqual(test.events, []);
    replace(test.root.environments, 'list', list);
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
    replace(test.root.environments, 'fork', async () => {
      throw rejection;
    });
    await assert.rejects(
      test.apply(),
      (error: Error & { keptForkEnvironmentId?: string }) => {
        assert.equal(error === rejection, true);
        assert.equal(error.keptForkEnvironmentId, undefined);
        return true;
      },
    );
    // An environment under the ID after a rejected request may come from
    // someone else right after the second check, or from a retried request
    // of this run whose first attempt timed out: kept and reported.
    replace(test.root.environments, 'fork', async () => {
      test.environments.set('review', environment('review', false));
      throw rejection;
    });
    await assert.rejects(
      test.apply(),
      (error: Error & ContentFailureContext) => {
        assert.equal(error === rejection, true);
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.match(
          error.outcome ?? '',
          /^The fork "review" was kept: an environment with that ID exists after the fork request failed/,
        );
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, []);
  });

  it('refuses a fork ID that is already in use without touching it', async () => {
    const test = fixture();
    test.environments.set('review', environment('review', false));
    await assert.rejects(test.apply(), (error: ContentError) => {
      assert.equal(error.code, 'FORK_ID_COLLISION');
      assert.equal(
        error.message,
        'Environment "review" already exists. Choose another --fork-name.',
      );
      return true;
    });
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, []);
    // Refused before the destination is checked.
    assert.deepEqual(test.checks(), []);
  });

  it('reports the fork kept after failure', async () => {
    const test = fixture();
    test.failPublication(new Error('Publication failed'));
    await assert.rejects(
      test.apply({ keepFailedFork: true }),
      (error: Error & ContentFailureContext) => {
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.equal(
          error.outcome,
          'The fork "review" was kept; "main" was not changed.',
        );
        return true;
      },
    );
    assert.equal(test.environments.has('review'), true);
    assert.deepEqual(test.events, ['fork:review']);
    // The fork keeps the writes made before the failure.
    assert.deepEqual(test.writes('review'), [`update:${RECORD}`]);
  });

  it('reports a frozen failure as it is', async () => {
    for (const inPlace of [false, true]) {
      const test = fixture();
      const frozen = Object.freeze(new Error('Frozen failure'));
      test.failPublication(frozen);
      await assert.rejects(
        test.apply(
          inPlace
            ? { inPlace: true, allowPrimary: true, forkName: undefined }
            : {},
        ),
        (error: unknown) => error === frozen,
      );
    }
  });

  it('wraps CMA rejections of an operation with its line and removes the fork', async () => {
    const test = fixture();
    test.failPublication(validationError('VALIDATION_UNIQUE'));
    await assert.rejects(test.apply(), (error: ContentError) => {
      assert.equal(error.code, 'CMA_VALIDATION_FAILED');
      assert.match(
        error.message,
        new RegExp(
          `^operations/000001\\.jsonl line 2, Publish Article "Edited" \\(${RECORD}\\): The CMA rejected PUT /items/${RECORD}/publish: INVALID_FIELD \\(title: VALIDATION_UNIQUE\\)\\. A unique value may still be held by another record`,
        ),
      );
      assert.match(error.outcome ?? '', /The fork "review" was deleted/);
      assert.equal(error.details?.status, 422);
      assert.deepEqual(error.details?.operation, {
        where: 'operations/000001.jsonl line 2',
        label: LABEL,
      });
      return true;
    });
    assert.deepEqual(test.events, ['fork:review', 'destroy:review']);
  });

  it('requests a fast fork unless a regular fork is asked for', async () => {
    const fast = fixture();
    await fast.apply();
    assert.deepEqual(fast.forkQueries, [
      { immediate_return: true, fast: true },
    ]);
    const regular = fixture();
    await regular.apply({ fastFork: false });
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
    replace(test.root.environments, 'fork', async () => {
      throw refusal;
    });
    await assert.rejects(
      test.apply(),
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
    replace(test.root.environments, 'fork', async () => {
      test.environments.set('review', environment('review', false));
      throw refusal;
    });
    await assert.rejects(
      test.apply(),
      (
        error: ContentError &
          ContentFailureContext & { suggestions?: string[] },
      ) => {
        assert.equal(error.code, 'FAST_FORK_BLOCKED');
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.equal(error.message, message);
        assert.match(
          error.outcome ?? '',
          /^The fork "review" was kept: an environment with that ID exists after the fork request failed/,
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
    const result = await test.apply();
    assert.equal(result.environmentId, 'review');
    assert.deepEqual(test.events, ['fork:review']);
    await assert.rejects(
      test.apply({ inPlace: true, allowPrimary: true, forkName: undefined }),
      (error: ContentError) => error.code === 'DESTINATION_UNAVAILABLE',
    );
    assert.deepEqual(test.writes('main'), []);
  });

  it('looks a possibly created fork up in the listing, never by its name', async () => {
    const test = fixture();
    const find = test.root.environments.find;
    const forkName = 'x/../../items/record';
    const found: string[] = [];
    replace(test.root.environments, 'find', async (id: string) => {
      found.push(id);
      return find(id);
    });
    replace(test.root.environments, 'fork', async () => {
      throw new Error('Uncertain fork request');
    });
    await assert.rejects(test.apply({ forkName }), /Uncertain fork request/);
    assert.deepEqual(found, ['main']);
    assert.deepEqual(test.events, []);
  });

  it('reports a kept fork with the original failure when its lookup fails', async () => {
    const test = fixture();
    const list = test.root.environments.list;
    let lists = 0;
    // Both fork ID checks succeed; the lookup after the failure does not.
    replace(test.root.environments, 'list', async () => {
      if (++lists > 2) throw new Error('lookup failed');
      return list();
    });
    test.failPublication(validationError('VALIDATION_UNIQUE'));
    await assert.rejects(
      test.apply({ keepFailedFork: true }),
      (error: ContentError) => {
        assert.equal(error.code, 'CMA_VALIDATION_FAILED');
        assert.equal(error.keptForkEnvironmentId, 'review');
        assert.equal(
          error.outcome,
          'The fork "review" was kept; "main" was not changed.',
        );
        return true;
      },
    );
    assert.deepEqual(test.events, ['fork:review']);
  });

  it('requests no fork when interrupted while the fork ID is checked again', async () => {
    const test = fixture();
    const controller = new AbortController();
    const list = test.root.environments.list;
    let lists = 0;
    replace(test.root.environments, 'list', async () => {
      // The second check runs right before the fork request.
      if (++lists === 2) controller.abort();
      return list();
    });
    await assert.rejects(
      test.apply({ signal: controller.signal }),
      (error: ContentError) => error.code === 'INTERRUPTED',
    );
    assert.equal(lists, 2);
    assert.deepEqual(test.events, []);
  });

  it('checks an in-place destination once and leaves a failure exactly as the run left it', async () => {
    const test = fixture();
    test.failPublication(new Error('Publication failed'));
    await assert.rejects(
      test.apply({ inPlace: true, allowPrimary: true, forkName: undefined }),
      (error: Error & ContentFailureContext) => {
        assert.equal(error.message, 'Publication failed');
        assert.equal(
          error.outcome,
          'Writes made before the failure remain in "main".',
        );
        return true;
      },
    );
    assert.deepEqual(test.writes('main'), [`update:${RECORD}`]);
    assert.equal(test.record('main').current.title, 'Edited');
    assert.equal(test.record('main').published, null);
    assert.deepEqual(test.events, []);
    assert.deepEqual(test.checks(), [
      'Checking what the diff touches in "main".',
    ]);
  });
});
