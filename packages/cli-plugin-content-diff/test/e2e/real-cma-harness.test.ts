import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CmaClient } from '@datocms/cli-utils';
import {
  destinationExecutionEnvironment,
  runCli as runCrossProjectCli,
} from '../cross-project-e2e/cross-project-harness';
import {
  type CliInvocation,
  PACKAGED_HOST_MANIFEST_FILENAME,
  type PrimaryEnvironmentSnapshot,
  SOURCE_CLI,
  appliedEnvironmentOwnershipIsProven,
  buildClient,
  captureEnvironmentFingerprint,
  capturePrimaryEnvironmentSnapshot,
  describePrimaryEnvironmentChanges,
  executableInputsSha256,
  finishPrimaryEnvironmentGuard,
  forkEnvironment,
  goldenPathScenario,
  guardCmaClientAgainstMutationsForTest,
  invokeGeneratedMigrationForReplay,
  mochaHooks,
  requireActivePrimaryEnvironmentGuard,
  resolveCliInvocation,
  runCli,
  runRealCmaScenario,
  shutdownScenarioWork,
  startLivePrimaryEnvironmentGuard,
  startPrimaryEnvironmentGuard,
  verifyPrimaryEnvironmentAfterScenario,
  withAdditionalFailures,
} from './real-cma-harness';
import {
  type ScenarioCancellation,
  createScenarioCancellation,
} from './scenario-cancellation';

describe('real-CMA harness cancellation wiring', () => {
  it('uses the work transport for CMA reads and prevents a queued read after cancellation', async () => {
    let calls = 0;
    const cancellation = createScenarioCancellation({
      fetchFn: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ data: rawFingerprintItem('record', 'regular') }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    const client = buildClient(
      'local-test-token',
      'source',
      cancellation.fetchFn,
    );
    assert.equal(client.config.requestTimeout, 120_000);
    // The SDK retains its header timer when fetch rejects; keep that test-only timer short.
    client.config.requestTimeout = 10;
    const reason = new Error('fixture work failed');
    try {
      assert.equal((await client.items.rawFind('record')).data.id, 'record');
      await cancellation.shutdown(reason);
      await assert.rejects(
        client.items.rawFind('record'),
        /fixture work failed/,
      );
      assert.equal(calls, 1);
    } finally {
      await cancellation.shutdown();
    }
  });

  it('registers a CLI child with the deadline and rejects only after its close event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-diff-cli-cancel-'));
    const script = join(directory, 'wait.cjs');
    const cancellation = createScenarioCancellation({ timeoutMs: 150 });
    let registered = false;
    let closed = false;
    const observed: ScenarioCancellation = {
      ...cancellation,
      trackChild(child) {
        registered = true;
        child.once('close', () => {
          closed = true;
        });
        return cancellation.trackChild(child);
      },
    };
    try {
      // Finite fallback makes missing cancellation fail without leaking a process.
      await writeFile(script, 'setTimeout(() => process.exit(0), 2000);\n');
      await assert.rejects(
        runCli({
          binPath: script,
          args: [],
          cwd: directory,
          apiToken: 'local-test-token',
          cancellation: observed,
        }),
        /Scenario exceeded 150ms/,
      );
      assert.equal(registered, true);
      assert.equal(closed, true);
    } finally {
      await cancellation.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not spawn a later command after cancellation and preserves CLI error redaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-diff-cli-error-'));
    const script = join(directory, 'fail.cjs');
    const cancellation = createScenarioCancellation();
    let registered = 0;
    const observed: ScenarioCancellation = {
      ...cancellation,
      trackChild(child) {
        registered += 1;
        return cancellation.trackChild(child);
      },
    };
    try {
      await writeFile(
        script,
        'console.error(process.env.DATOCMS_API_TOKEN); process.exitCode = 7;\n',
      );
      await assert.rejects(
        runCli({
          binPath: script,
          args: [],
          cwd: directory,
          apiToken: 'local-test-token',
          cancellation: observed,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /exited with 7/);
          assert.match(error.message, /\[REDACTED\]/);
          assert.ok(!error.message.includes('local-test-token'));
          return true;
        },
      );
      const original = new Error('first operation failed');
      await cancellation.shutdown(original);
      await assert.rejects(
        runCli({
          binPath: script,
          args: [],
          cwd: directory,
          apiToken: 'local-test-token',
          cancellation: observed,
        }),
        (error: unknown) => error === original,
      );
      assert.equal(registered, 1);
    } finally {
      await cancellation.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not start a fork when the preceding absence check finishes after cancellation', async () => {
    const cancellation = createScenarioCancellation();
    const reason = new Error('deadline before fork');
    let forkCalls = 0;
    const client = {
      environments: {
        async find() {
          cancellation.abort(reason);
          return null;
        },
        async fork() {
          forkCalls += 1;
        },
      },
    } as unknown as CmaClient.Client;
    const pendingOwnershipRecoveries: Array<() => Promise<void>> = [];
    try {
      await assert.rejects(
        forkEnvironment(client, 'source', 'destination', [], {
          cancellation,
          recoveryClient: client,
          pendingOwnershipRecoveries,
        }),
        (error: unknown) => error === reason,
      );
      assert.equal(forkCalls, 0);
      assert.deepEqual(pendingOwnershipRecoveries, []);
    } finally {
      await cancellation.shutdown();
    }
  });

  it('recovers an ambiguous fork with the independent client only after outstanding work drains', async () => {
    let releaseRequest!: () => void;
    let abortedRequest!: () => void;
    const aborted = new Promise<void>((resolve) => {
      abortedRequest = resolve;
    });
    const cancellation = createScenarioCancellation({
      fetchFn: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => {
              abortedRequest();
              releaseRequest = () => reject(init!.signal!.reason);
            },
            { once: true },
          );
        }),
    });
    const firstFailure = new Error('fork response was lost');
    const pendingRequest = assert.rejects(
      cancellation.fetchFn('https://example.invalid/'),
      (error: unknown) => error === firstFailure,
    );
    const createdEnvironmentIds: string[] = [];
    const pendingOwnershipRecoveries: Array<() => Promise<void>> = [];
    let recoveryReads = 0;
    const workClient = {
      environments: {
        async find() {
          return null;
        },
        async fork() {
          throw firstFailure;
        },
      },
    } as unknown as CmaClient.Client;
    const recoveryClient = {
      environments: {
        async find() {
          assert.equal(cancellation.signal.aborted, true);
          recoveryReads += 1;
          return { meta: { forked_from: 'source' } };
        },
      },
    } as unknown as CmaClient.Client;
    try {
      await assert.rejects(
        forkEnvironment(
          workClient,
          'source',
          'destination',
          createdEnvironmentIds,
          { cancellation, recoveryClient, pendingOwnershipRecoveries },
        ),
        (error: unknown) => error === firstFailure,
      );
      assert.equal(pendingOwnershipRecoveries.length, 1);
      assert.deepEqual(createdEnvironmentIds, []);
      assert.equal(recoveryReads, 0);
      const finished = shutdownScenarioWork({
        cancellation,
        pendingOwnershipRecoveries,
        primaryFailure: firstFailure,
      });
      await aborted;
      assert.equal(
        recoveryReads,
        0,
        'recovery must not overlap a request still tearing down',
      );
      releaseRequest();
      assert.deepEqual(await finished, []);
      await pendingRequest;
      assert.equal(recoveryReads, 1);
      assert.deepEqual(createdEnvironmentIds, ['destination']);
    } finally {
      cancellation.abort(firstFailure);
      await aborted;
      releaseRequest();
      await cancellation.drain();
      await pendingRequest;
    }
  });

  it('aborts successful work too and collects recovery failures without replacing the first work error', async () => {
    const cancellation = createScenarioCancellation();
    const original = new Error('first work error');
    const calls: string[] = [];
    const errors = await shutdownScenarioWork({
      cancellation,
      primaryFailure: original,
      pendingOwnershipRecoveries: [
        async () => {
          calls.push('failed');
          throw new Error('recovery unavailable');
        },
        async () => {
          calls.push('recovered');
        },
      ],
    });
    assert.equal(cancellation.signal.reason, original);
    assert.deepEqual(calls, ['failed', 'recovered']);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /recovery unavailable/);
    const successful = createScenarioCancellation();
    assert.deepEqual(
      await shutdownScenarioWork({
        cancellation: successful,
        pendingOwnershipRecoveries: [],
      }),
      [],
    );
    assert.equal(successful.signal.aborted, true);
  });
});

describe('real-CMA full-environment fingerprints', () => {
  it('keeps the frozen empty-primary fingerprint unchanged', async () => {
    const client = fingerprintClient(
      { current: [], published: [], nested: { current: [], published: [] } },
      [],
    );
    client.itemTypes.rawList = async () => ({ data: [] });
    // Captured with the original nested:true harness before this optimization.
    assert.equal(
      await captureEnvironmentFingerprint(client),
      '9fb41ee7baaf2b9aac30b4c675baaad91beb5f780127a4094b69f2a87b8695f8',
    );
  });

  it('captures all 2002 flat items plus exact nested root versions without expanding every block', async () => {
    const state = fingerprintFixture(2000);
    const queries: RecordQuery[] = [];
    const client = fingerprintClient(state, queries);
    const first = await captureEnvironmentFingerprint(client);
    assert.match(first, /^[a-f0-9]{64}$/);
    for (const version of ['current', 'published']) {
      const flat = queries.filter(
        (query) => query.version === version && query.nested === false,
      );
      assert.deepEqual(
        flat.map(({ page }) => page),
        [0, 500, 1000, 1500, 2000].map((offset) => ({ offset, limit: 500 })),
      );
      assert.ok(
        flat.every(({ filter }) => filter === undefined),
        'all block/orphan models must remain included',
      );
      const nested = queries.filter(
        (query) => query.version === version && query.nested === true,
      );
      assert.equal(nested.length, 1);
      assert.deepEqual(nested[0].filter!.ids.split(',').sort(), [
        'anchor',
        'root',
      ]);
      assert.deepEqual(nested[0].page, { offset: 0, limit: 30 });
    }
    assert.equal(
      await captureEnvironmentFingerprint(fingerprintClient(state, [])),
      first,
    );
  });

  it('detects orphan fields, block metadata, each publication slice, and root-specific nested versions independently', async () => {
    const baseline = fingerprintFixture(3);
    const expected = await captureEnvironmentFingerprint(
      fingerprintClient(baseline, []),
    );
    const changes: Array<(state: FingerprintFixture) => void> = [
      (state) => {
        state.current[2].attributes.label = 'changed orphan';
      },
      (state) => {
        state.published[2].attributes.label = 'changed published orphan';
      },
      (state) => {
        state.current[0].meta.current_version = 'changed block metadata';
      },
      (state) => {
        state.published[0].meta.is_published_version_valid = false;
      },
      (state) => {
        (
          state.nested.current[1].attributes.hero as {
            attributes: { label: string };
          }
        ).attributes.label = 'different root-current child version';
      },
      (state) => {
        (
          state.nested.published[1].attributes.hero as {
            attributes: { label: string };
          }
        ).attributes.label = 'different root-published child version';
      },
      (state) => {
        state.nested.current[1].meta.created_at = 'different root lineage';
      },
      (state) => {
        state.nested.published[1].meta.current_version =
          'different root version metadata';
      },
    ];
    for (const [index, mutate] of changes.entries()) {
      const state = structuredClone(baseline);
      mutate(state);
      assert.notEqual(
        await captureEnvironmentFingerprint(fingerprintClient(state, [])),
        expected,
        `mutation ${index}`,
      );
    }
  });

  it('fails closed on duplicate, missing, oversized, or count-changing inventory pages', async () => {
    for (const fault of [
      'duplicate',
      'empty',
      'overshoot',
      'changed',
      'invalid',
    ] as const) {
      const state = fingerprintFixture(500);
      await assert.rejects(
        captureEnvironmentFingerprint(
          fingerprintClient(state, [], (query, response) => {
            if (query.version !== 'current' || query.nested !== false) return;
            if (fault === 'invalid') response.meta.total_count = Number.NaN;
            if (query.page.offset === 0) return;
            if (fault === 'duplicate') response.data[0] = state.current[0];
            if (fault === 'empty') response.data = [];
            if (fault === 'overshoot')
              response.data.push(rawFingerprintItem('unexpected', 'block'));
            if (fault === 'changed') response.meta.total_count += 1;
          }),
        ),
        /fingerprint|record count|pagination|duplicate/i,
        fault,
      );
    }
  });

  it('requires an exact nested root batch and rejects records with unknown models', async () => {
    for (const fault of [
      'missing-root',
      'unexpected-root',
      'unknown-model',
    ] as const) {
      const state = fingerprintFixture(1);
      if (fault === 'unknown-model')
        state.current[0].relationships.item_type.data.id = 'unknown';
      await assert.rejects(
        captureEnvironmentFingerprint(
          fingerprintClient(state, [], (query, response) => {
            if (!query.nested || query.version !== 'current') return;
            if (fault === 'missing-root') response.data.pop();
            if (fault === 'unexpected-root')
              response.data[0] = rawFingerprintItem('other-root', 'regular');
          }),
        ),
        /fingerprint|root|model/i,
        fault,
      );
    }
  });
});

type FingerprintItem = {
  id: string;
  type: 'item';
  attributes: Record<string, unknown>;
  relationships: { item_type: { data: { id: string; type: 'item_type' } } };
  meta: Record<string, unknown>;
};
type FingerprintFixture = {
  current: FingerprintItem[];
  published: FingerprintItem[];
  nested: { current: FingerprintItem[]; published: FingerprintItem[] };
};
type RecordQuery = {
  nested: boolean;
  version: 'current' | 'published';
  page: { offset: number; limit: number };
  filter?: { ids: string };
};
type RecordPage = { data: FingerprintItem[]; meta: { total_count: number } };

function rawFingerprintItem(id: string, model: string): FingerprintItem {
  return {
    id,
    type: 'item',
    attributes: { label: id },
    relationships: { item_type: { data: { id: model, type: 'item_type' } } },
    meta: {
      current_version: `${id}-version`,
      is_current_version_valid: true,
      is_published_version_valid: true,
    },
  };
}

function fingerprintFixture(blockCount: number): FingerprintFixture {
  const blocks = Array.from({ length: blockCount }, (_, index) =>
    rawFingerprintItem(`block-${String(index).padStart(4, '0')}`, 'block'),
  );
  const roots = [
    rawFingerprintItem('anchor', 'regular'),
    rawFingerprintItem('root', 'regular'),
  ];
  if (blocks.length) roots[1].attributes.hero = blocks[0].id;
  const current = [...blocks, ...roots];
  const published = structuredClone(current);
  if (blocks.length) published[0].attributes.label = 'published block value';
  const nestedCurrent = structuredClone(roots);
  const nestedPublished = structuredClone(roots);
  if (blocks.length) {
    const nestedBlock = (label: string) => ({
      id: blocks[0].id,
      type: 'item',
      attributes: { label },
      relationships: blocks[0].relationships,
    });
    nestedCurrent[1].attributes.hero = nestedBlock('root current child');
    nestedPublished[1].attributes.hero = nestedBlock('root published child');
  }
  return {
    current,
    published,
    nested: {
      current: nestedCurrent,
      published: nestedPublished,
    },
  };
}

function fingerprintClient(
  state: FingerprintFixture,
  queries: RecordQuery[],
  fault?: (query: RecordQuery, response: RecordPage) => void,
): CmaClient.Client {
  return {
    site: {
      async rawFind() {
        return {
          data: {
            id: 'site',
            attributes: { locales: ['en'], timezone: 'UTC' },
            meta: {},
          },
        };
      },
    },
    itemTypes: {
      async rawList() {
        return {
          data: ['block', 'regular'].map((id) => ({
            id,
            type: 'item_type',
            attributes: { modular_block: id === 'block' },
          })),
        };
      },
    },
    fields: {
      async rawList() {
        return { data: [] };
      },
    },
    fieldsets: {
      async rawList() {
        return { data: [] };
      },
    },
    uploads: {
      async rawList() {
        return { data: [], meta: { total_count: 0 } };
      },
    },
    uploadCollections: {
      async rawList() {
        return { data: [] };
      },
    },
    items: {
      async rawList(query: RecordQuery) {
        queries.push(structuredClone(query));
        const rows = query.nested
          ? state[query.version].map(
              (row) =>
                state.nested[query.version].find(({ id }) => id === row.id) ??
                row,
            )
          : state[query.version];
        const selected = query.filter
          ? rows.filter(({ id }) => query.filter!.ids.split(',').includes(id))
          : rows;
        const response = {
          data: structuredClone(
            selected.slice(
              query.page.offset,
              query.page.offset + query.page.limit,
            ),
          ),
          meta: { total_count: selected.length },
        };
        fault?.(query, response);
        return response;
      },
    },
  } as unknown as CmaClient.Client;
}

describe('real-CMA harness cleanup ownership', () => {
  const expectedSource = 'cde2e-source';
  const trackingModel = 'cde2e_migrations_run';

  it('requires both the expected fork source and the per-run tracking model', () => {
    assert.equal(
      appliedEnvironmentOwnershipIsProven({
        candidate: { meta: { forked_from: expectedSource } },
        sourceEnvironmentId: expectedSource,
        itemTypeApiKeys: ['fixture', trackingModel],
        migrationModelApiKey: trackingModel,
      }),
      true,
    );
  });

  it('does not adopt an absent, unrelated, or same-source colliding environment', () => {
    for (const testCase of [
      {
        candidate: null,
        itemTypeApiKeys: [trackingModel],
      },
      {
        candidate: { meta: { forked_from: 'another-source' } },
        itemTypeApiKeys: [trackingModel],
      },
      {
        candidate: { meta: { forked_from: expectedSource } },
        itemTypeApiKeys: ['somebody_elses_model'],
      },
    ] as const) {
      assert.equal(
        appliedEnvironmentOwnershipIsProven({
          ...testCase,
          sourceEnvironmentId: expectedSource,
          migrationModelApiKey: trackingModel,
        }),
        false,
      );
    }
  });
});

describe('real-CMA harness replay mutation guard', () => {
  it('allows reads and rejects mutators before calling the underlying client', async () => {
    const calls: string[] = [];
    const client = {
      items: {
        async find(id: string) {
          calls.push(`find:${id}`);
          return { id };
        },
        async update(id: string) {
          calls.push(`update:${id}`);
          return { id };
        },
      },
      uploads: {
        async updateFromLocalFile(id: string) {
          calls.push(`upload:${id}`);
          return { id };
        },
      },
    };
    const guarded = guardCmaClientAgainstMutationsForTest(client);

    assert.deepEqual(await guarded.items.find('record-1'), { id: 'record-1' });
    assert.throws(
      () => guarded.items.update('record-1'),
      /attempted CMA mutation items\.update/,
    );
    assert.throws(
      () => guarded.uploads.updateFromLocalFile('upload-1'),
      /attempted CMA mutation uploads\.updateFromLocalFile/,
    );
    assert.deepEqual(calls, ['find:record-1']);
  });

  it("loads TypeScript with the plugin runner's tsx semantics and passes the guarded protocol context", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-diff-ts-replay-'));
    const migrationPath = join(directory, '1700000000_replay.ts');
    const calls: string[] = [];
    const client = {
      items: {
        async find(id: string) {
          calls.push(`find:${id}`);
          return { id };
        },
        async update(id: string) {
          calls.push(`update:${id}`);
          return { id };
        },
      },
    };

    try {
      await writeFile(
        migrationPath,
        `import type { Client } from 'datocms/lib/cma-client-node';

export default async function migration(
  client: Client,
  executionContext: unknown,
): Promise<void> {
  (globalThis as any).__contentDiffReplayContext = executionContext;
  await client.items.find('record-1');
  await client.items.update('record-1', {});
}
`,
      );

      await assert.rejects(
        invokeGeneratedMigrationForReplay(
          migrationPath,
          client as never,
          'applied-environment',
        ),
        /attempted CMA mutation items\.update/,
      );
      assert.deepEqual(
        (globalThis as Record<string, unknown>).__contentDiffReplayContext,
        {
          environmentId: 'applied-environment',
          inPlace: false,
          allowPrimary: false,
          contentDiffProtocolVersion: 1,
        },
      );
      assert.deepEqual(calls, ['find:record-1']);
    } finally {
      (globalThis as Record<string, unknown>).__contentDiffReplayContext =
        undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

type EnvironmentRow = {
  id: string;
  meta: {
    primary: boolean;
    status: 'creating' | 'ready' | 'destroying';
    forked_from: string | null;
    created_at: string;
    last_data_change_at: string;
    read_only_mode: boolean;
  };
};

function environmentRow(
  id: string,
  overrides: Partial<EnvironmentRow['meta']> = {},
): EnvironmentRow {
  return {
    id,
    meta: {
      primary: id === 'main',
      status: 'ready',
      forked_from: id === 'main' ? null : 'main',
      created_at: `2026-01-01T00:00:00Z#${id}`,
      last_data_change_at: '2026-01-01T00:00:00Z',
      read_only_mode: false,
      ...overrides,
    },
  };
}

type WorkflowRow = { id: string; type: 'workflow'; attributes: object };

function workflowClient(
  content: FingerprintFixture,
  workflows: WorkflowRow[],
): CmaClient.Client {
  return Object.assign(fingerprintClient(content, []), {
    workflows: {
      async rawList() {
        return { data: structuredClone(workflows) };
      },
    },
  });
}

function primaryReaders(
  environments: EnvironmentRow[],
  content: FingerprintFixture = fingerprintFixture(1),
  projectId = 'project-1',
  workflows: WorkflowRow[] = [],
) {
  const primaryReads: string[] = [];
  return {
    primaryReads,
    rootClient: {
      site: {
        async find() {
          return { id: projectId, name: 'content-diff e2e' };
        },
      },
      environments: {
        async list() {
          return structuredClone(environments);
        },
      },
    } as unknown as CmaClient.Client,
    primaryClient(environmentId: string) {
      primaryReads.push(environmentId);
      return workflowClient(content, workflows);
    },
  };
}

/**
 * Primary client for the live guard: answers the disposable-project probe
 * (model list and one-row record/upload pages) and logs every read, so a test
 * can prove the probe ran before any full fingerprint read.
 */
function probedPrimaryClient(
  counts: Readonly<{ models: number; records: number; uploads: number }>,
  reads: string[],
): CmaClient.Client {
  const base = workflowClient(
    { current: [], published: [], nested: { current: [], published: [] } },
    [],
  );
  const logged = <T>(name: string, read: () => Promise<T>) => {
    reads.push(name);
    return read();
  };
  return {
    ...base,
    site: { rawFind: () => logged('site.rawFind', base.site.rawFind) },
    itemTypes: {
      list: () =>
        logged('itemTypes.list', async () =>
          Array.from({ length: counts.models }, (_, index) => ({
            id: `model-${index}`,
          })),
        ),
      rawList: () =>
        logged('itemTypes.rawList', async () => ({
          data: Array.from({ length: counts.models }, (_, index) => ({
            id: `model-${index}`,
            type: 'item_type',
            attributes: { modular_block: false },
          })),
        })),
    },
    items: {
      rawList: (query: Partial<RecordQuery>) =>
        query.version === undefined
          ? logged(`items.rawList limit ${query.page?.limit}`, async () => ({
              data: [],
              meta: { total_count: counts.records },
            }))
          : logged(`items.rawList ${query.version}`, () =>
              base.items.rawList(query as never),
            ),
    },
    uploads: {
      rawList: (query: { page?: { limit?: number } }) =>
        logged(`uploads.rawList limit ${query.page?.limit}`, async () => ({
          data: [],
          meta: { total_count: counts.uploads },
        })),
    },
  } as unknown as CmaClient.Client;
}

describe('real-CMA suite primary-environment guard', () => {
  afterEach(async () => {
    // Never leak an active guard into another test.
    await finishPrimaryEnvironmentGuard().catch(() => undefined);
  });

  it('fingerprints primary content, workflows, and the environment inventory without owned sandboxes', async () => {
    const readers = primaryReaders([
      environmentRow('main'),
      environmentRow('unrelated-sandbox'),
      environmentRow('cde2e-owned'),
    ]);
    const snapshot = await capturePrimaryEnvironmentSnapshot({
      ...readers,
      ownedEnvironmentIds: new Set(['cde2e-owned']),
    });

    assert.deepEqual(readers.primaryReads, ['main']);
    assert.equal(snapshot.projectId, 'project-1');
    assert.equal(snapshot.primaryEnvironmentId, 'main');
    assert.deepEqual(
      snapshot.environments.map(({ id }) => id),
      ['main', 'unrelated-sandbox'],
    );
    assert.deepEqual(snapshot.retainedOwnedEnvironmentIds, ['cde2e-owned']);
    assert.equal(
      snapshot.contentFingerprint,
      await captureEnvironmentFingerprint(
        fingerprintClient(fingerprintFixture(1), []),
      ),
    );
    assert.match(snapshot.workflowFingerprint, /^[a-f0-9]{64}$/);
    assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);

    const withoutOwned = await capturePrimaryEnvironmentSnapshot({
      ...primaryReaders([
        environmentRow('main'),
        environmentRow('unrelated-sandbox'),
      ]),
      ownedEnvironmentIds: new Set(['cde2e-owned']),
    });
    assert.equal(withoutOwned.fingerprint, snapshot.fingerprint);
    assert.deepEqual(withoutOwned.retainedOwnedEnvironmentIds, []);
  });

  it('ignores operational environment fields, owned sandboxes being destroyed, and workflow order', async () => {
    const workflow = (id: string): WorkflowRow => ({
      id,
      type: 'workflow',
      attributes: { name: id, api_key: id },
    });
    const baseline = await capturePrimaryEnvironmentSnapshot({
      ...primaryReaders([environmentRow('main')], undefined, undefined, [
        workflow('a'),
        workflow('b'),
      ]),
      ownedEnvironmentIds: new Set(),
    });
    const later = await capturePrimaryEnvironmentSnapshot({
      ...primaryReaders(
        [
          environmentRow('main', {
            last_data_change_at: '2026-02-02T00:00:00Z',
          }),
          environmentRow('cde2e-owned', { status: 'destroying' }),
        ],
        undefined,
        undefined,
        [workflow('b'), workflow('a')],
      ),
      ownedEnvironmentIds: new Set(['cde2e-owned']),
    });

    assert.equal(later.fingerprint, baseline.fingerprint);
    assert.deepEqual(later.retainedOwnedEnvironmentIds, []);
    assert.deepEqual(describePrimaryEnvironmentChanges(baseline, later), []);
  });

  it('detects primary content, workflow, inventory, identity, and promotion changes independently', async () => {
    const baselineEnvironments = [
      environmentRow('main'),
      environmentRow('existing-sandbox'),
    ];
    const baseline = await capturePrimaryEnvironmentSnapshot({
      ...primaryReaders(baselineEnvironments),
      ownedEnvironmentIds: new Set(),
    });
    const changedContent = fingerprintFixture(1);
    changedContent.published[0].attributes.label = 'primary was published to';

    const cases: Array<{
      name: string;
      readers: ReturnType<typeof primaryReaders>;
      message: RegExp;
    }> = [
      {
        name: 'content',
        readers: primaryReaders(baselineEnvironments, changedContent),
        message: /schema\/record\/upload\/collection fingerprint changed/,
      },
      {
        name: 'workflow',
        readers: primaryReaders(
          baselineEnvironments,
          fingerprintFixture(1),
          'project-1',
          [
            {
              id: 'workflow-1',
              type: 'workflow',
              attributes: { name: 'Created in primary' },
            },
          ],
        ),
        message: /primary workflow definitions changed/,
      },
      {
        name: 'unowned environment',
        readers: primaryReaders([
          ...baselineEnvironments,
          environmentRow('cde2e-unproven-applied'),
        ]),
        message: /appeared: cde2e-unproven-applied/,
      },
      {
        name: 'removed environment',
        readers: primaryReaders([environmentRow('main')]),
        message: /disappeared: existing-sandbox/,
      },
      {
        name: 'environment metadata',
        readers: primaryReaders([
          environmentRow('main', { read_only_mode: true }),
          environmentRow('existing-sandbox'),
        ]),
        message: /metadata changed: main/,
      },
      {
        name: 'promotion',
        readers: primaryReaders([
          environmentRow('main', { primary: false }),
          environmentRow('existing-sandbox', { primary: true }),
        ]),
        message: /primary environment changed from main to existing-sandbox/,
      },
      {
        name: 'project',
        readers: primaryReaders(
          baselineEnvironments,
          fingerprintFixture(1),
          'project-2',
        ),
        message: /project changed from project-1 to project-2/,
      },
    ];

    for (const testCase of cases) {
      const after = await capturePrimaryEnvironmentSnapshot({
        ...testCase.readers,
        ownedEnvironmentIds: new Set(),
      });
      const changes = describePrimaryEnvironmentChanges(baseline, after);
      assert.notEqual(after.fingerprint, baseline.fingerprint, testCase.name);
      assert.match(changes.join('; '), testCase.message, testCase.name);
    }
  });

  it('rejects an ambiguous primary or a promoted owned sandbox', async () => {
    await assert.rejects(
      capturePrimaryEnvironmentSnapshot({
        ...primaryReaders([
          environmentRow('main'),
          environmentRow('other', { primary: true }),
        ]),
        ownedEnvironmentIds: new Set(),
      }),
      /exactly one primary environment/,
    );
    await assert.rejects(
      capturePrimaryEnvironmentSnapshot({
        ...primaryReaders([
          environmentRow('main', { primary: false }),
          environmentRow('cde2e-owned', { primary: true }),
        ]),
        ownedEnvironmentIds: new Set(['cde2e-owned']),
      }),
      /owned E2E sandbox cde2e-owned became the primary environment/,
    );
  });

  function snapshot(
    fingerprint: string,
    retainedOwnedEnvironmentIds: string[] = [],
  ): PrimaryEnvironmentSnapshot {
    return {
      projectId: 'project-1',
      primaryEnvironmentId: 'main',
      environments: [],
      contentFingerprint: fingerprint,
      workflowFingerprint: 'workflows',
      retainedOwnedEnvironmentIds,
      fingerprint,
    };
  }

  it('attributes a change only to the scenario that made it and reports only that scenario sandboxes', async () => {
    const captures: string[][] = [];
    const results = [
      snapshot('baseline'),
      // Scenario a changes primary and leaves one sandbox behind.
      snapshot('changed', ['cde2e-a-source']),
      // Scenario b is clean; a's leftover is still there.
      snapshot('changed', ['cde2e-a-source']),
      // Scenario c leaves its own sandbox behind.
      snapshot('changed', ['cde2e-a-source', 'cde2e-c-applied']),
      // Suite end.
      snapshot('changed', ['cde2e-a-source', 'cde2e-c-applied']),
    ];
    await startPrimaryEnvironmentGuard({
      capture: async (owned) => {
        captures.push([...owned].sort());
        const next = results.shift();
        assert.ok(next, 'unexpected extra primary capture');
        return next;
      },
    });

    assert.deepEqual(requireActivePrimaryEnvironmentGuard(), {
      projectId: 'project-1',
      primaryEnvironmentId: 'main',
    });
    await assert.rejects(
      verifyPrimaryEnvironmentAfterScenario('a', [
        'cde2e-a-source',
        'cde2e-a-destination',
      ]),
      (error: Error) => {
        assert.equal(
          error.message,
          'primary environment check failed after scenario "a" (compared with the suite baseline): primary schema/record/upload/collection fingerprint changed from baseline to changed; owned E2E sandboxes remain although KEEP is unset: cde2e-a-source',
        );
        return true;
      },
    );
    await verifyPrimaryEnvironmentAfterScenario('b', ['cde2e-b-source']);
    await assert.rejects(
      verifyPrimaryEnvironmentAfterScenario('c', ['cde2e-c-applied']),
      (error: Error) => {
        assert.equal(
          error.message,
          'primary environment check failed after scenario "c" (compared with the check after scenario "b"): owned E2E sandboxes remain although KEEP is unset: cde2e-c-applied',
        );
        return true;
      },
    );
    await assert.rejects(finishPrimaryEnvironmentGuard(), (error: Error) => {
      assert.equal(
        error.message,
        'primary environment check failed after the suite (compared with the suite baseline): primary schema/record/upload/collection fingerprint changed from baseline to changed; owned E2E sandboxes remain although KEEP is unset: cde2e-a-source, cde2e-c-applied',
      );
      return true;
    });
    assert.deepEqual(captures, [
      [],
      ['cde2e-a-destination', 'cde2e-a-source'],
      ['cde2e-a-destination', 'cde2e-a-source', 'cde2e-b-source'],
      [
        'cde2e-a-destination',
        'cde2e-a-source',
        'cde2e-b-source',
        'cde2e-c-applied',
      ],
      [
        'cde2e-a-destination',
        'cde2e-a-source',
        'cde2e-b-source',
        'cde2e-c-applied',
      ],
    ]);
  });

  it('names a failed scenario capture and keeps comparing with the last completed check', async () => {
    const results: Array<PrimaryEnvironmentSnapshot | Error> = [
      snapshot('baseline'),
      new Error('primary read timed out'),
      snapshot('changed'),
    ];
    await startPrimaryEnvironmentGuard({
      capture: async () => {
        const next = results.shift();
        if (next instanceof Error) throw next;
        assert.ok(next, 'unexpected extra primary capture');
        return next;
      },
    });
    await assert.rejects(
      verifyPrimaryEnvironmentAfterScenario('a', []),
      /^Error: could not check the primary environment after scenario "a": primary read timed out$/,
    );
    await assert.rejects(
      verifyPrimaryEnvironmentAfterScenario('b', []),
      /after scenario "b" \(compared with the suite baseline\): primary schema\/record\/upload\/collection fingerprint changed from baseline to changed$/,
    );
  });

  it('fails the suite end on a changed primary and always deactivates the guard', async () => {
    let captured = 0;
    await startPrimaryEnvironmentGuard({
      capture: async () => snapshot(captured++ === 0 ? 'before' : 'after'),
    });
    await assert.rejects(
      finishPrimaryEnvironmentGuard(),
      /check failed after the suite \(compared with the suite baseline\): primary schema\/record\/upload\/collection fingerprint changed from before to after/,
    );
    assert.throws(requireActivePrimaryEnvironmentGuard, /not active/);
  });

  it('fails when owned sandboxes survive cleanup unless KEEP retains them', async () => {
    for (const keepEnvironments of [false, true]) {
      let calls = 0;
      await startPrimaryEnvironmentGuard({
        keepEnvironments,
        capture: async () =>
          snapshot('same', calls++ === 0 ? [] : ['cde2e-leftover']),
      });
      const scenarioCheck = verifyPrimaryEnvironmentAfterScenario('keeps', [
        'cde2e-leftover',
      ]);
      if (keepEnvironments) {
        await scenarioCheck;
        await finishPrimaryEnvironmentGuard();
      } else {
        await assert.rejects(
          scenarioCheck,
          /after scenario "keeps" .*owned E2E sandboxes remain although KEEP is unset: cde2e-leftover$/,
        );
        await assert.rejects(
          finishPrimaryEnvironmentGuard(),
          /after the suite .*owned E2E sandboxes remain although KEEP is unset: cde2e-leftover$/,
        );
      }
    }
  });

  it('refuses a non-disposable live project with small probe reads before fingerprinting primary', async () => {
    const saved = process.env.DATOCMS_CONTENT_DIFF_E2E_DISPOSABLE_PROJECT;
    Reflect.deleteProperty(
      process.env,
      'DATOCMS_CONTENT_DIFF_E2E_DISPOSABLE_PROJECT',
    );
    try {
      for (const projectName of ['Production site', 'content-diff e2e']) {
        const reads: string[] = [];
        const readers = primaryReaders([environmentRow('main')]);
        (
          readers.rootClient.site as unknown as { find(): Promise<unknown> }
        ).find = async () => ({ id: 'project-1', name: projectName });
        await assert.rejects(
          startLivePrimaryEnvironmentGuard({
            rootClient: readers.rootClient,
            primaryClient: () =>
              probedPrimaryClient(
                { models: 3, records: 5000, uploads: 2 },
                reads,
              ),
            keepEnvironments: false,
          }),
          /refusing to run against non-empty project .*primary contains 3 model\(s\), 5000 record\(s\), and 2 upload\(s\)/,
        );
        assert.deepEqual(reads.sort(), [
          'itemTypes.list',
          'items.rawList limit 1',
          'uploads.rawList limit 1',
        ]);
        assert.throws(requireActivePrimaryEnvironmentGuard, /not active/);
      }
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(
          process.env,
          'DATOCMS_CONTENT_DIFF_E2E_DISPOSABLE_PROJECT',
        );
      } else {
        process.env.DATOCMS_CONTENT_DIFF_E2E_DISPOSABLE_PROJECT = saved;
      }
    }
  });

  it('fingerprints a blank live project only after its disposable-project probe', async () => {
    const reads: string[] = [];
    const readers = primaryReaders([environmentRow('main')]);
    const baseline = await startLivePrimaryEnvironmentGuard({
      rootClient: readers.rootClient,
      primaryClient: () =>
        probedPrimaryClient({ models: 0, records: 0, uploads: 0 }, reads),
      keepEnvironments: false,
    });
    assert.equal(baseline.primaryEnvironmentId, 'main');
    assert.deepEqual(reads.slice(0, 3).sort(), [
      'itemTypes.list',
      'items.rawList limit 1',
      'uploads.rawList limit 1',
    ]);
    assert.ok(reads.slice(3).includes('items.rawList current'));
    assert.deepEqual(requireActivePrimaryEnvironmentGuard(), {
      projectId: 'project-1',
      primaryEnvironmentId: 'main',
    });
    await assert.rejects(
      startLivePrimaryEnvironmentGuard({
        rootClient: readers.rootClient,
        primaryClient: () => assert.fail('must not read primary'),
        keepEnvironments: false,
      }),
      /already active/,
    );
  });

  it('refuses a second baseline and an unguarded scenario before any CMA work', async () => {
    await startPrimaryEnvironmentGuard({ capture: async () => snapshot('a') });
    await assert.rejects(
      startPrimaryEnvironmentGuard({ capture: async () => snapshot('b') }),
      /already active/,
    );
    await finishPrimaryEnvironmentGuard();
    assert.equal(
      await verifyPrimaryEnvironmentAfterScenario('without a guard', []),
      undefined,
    );

    const saved = { ...process.env };
    try {
      process.env.DATOCMS_CONTENT_DIFF_E2E = '1';
      process.env.DATOCMS_API_TOKEN = 'local-test-token';
      Reflect.deleteProperty(process.env, 'DATOCMS_CONTENT_DIFF_E2E_CLI');
      Reflect.deleteProperty(
        process.env,
        'DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST',
      );
      let seeded = false;
      await assert.rejects(
        runRealCmaScenario({
          ...goldenPathScenario,
          async seedSource() {
            seeded = true;
            throw new Error('must not seed');
          },
        }),
        /suite primary-environment guard is not active: run the live suite through npm run test:e2e:real-cma/,
      );
      assert.equal(seeded, false);
    } finally {
      process.env = saved;
    }
  });

  it('throws a primary change together with the scenario failure instead of only logging it', async () => {
    let captured = 0;
    await startPrimaryEnvironmentGuard({
      capture: async (owned) => {
        assert.deepEqual([...owned], []);
        return snapshot(captured++ === 0 ? 'baseline' : 'changed');
      },
    });
    const saved = { ...process.env };
    const savedFetch = globalThis.fetch;
    try {
      process.env.DATOCMS_CONTENT_DIFF_E2E = '1';
      process.env.DATOCMS_API_TOKEN = 'local-test-token';
      Reflect.deleteProperty(process.env, 'DATOCMS_CONTENT_DIFF_E2E_CLI');
      Reflect.deleteProperty(
        process.env,
        'DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST',
      );
      // Offline: the scenario's first CMA read is refused.
      let offlineRequests = 0;
      globalThis.fetch = async () => {
        offlineRequests += 1;
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'offline',
                type: 'api_error',
                attributes: {
                  code: 'OFFLINE_FIXTURE_REFUSAL',
                  details: {},
                },
              },
            ],
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      };
      await assert.rejects(
        runRealCmaScenario(goldenPathScenario),
        (error: Error) => {
          const [primaryLine, ...rest] = error.message.split('\n');
          assert.equal(
            primaryLine,
            `primary environment check failed after scenario ${JSON.stringify(
              goldenPathScenario.name,
            )} (compared with the suite baseline): primary schema/record/upload/collection fingerprint changed from baseline to changed`,
          );
          assert.match(
            rest.join('\n'),
            /^also: CMA 401: .*OFFLINE_FIXTURE_REFUSAL/,
          );
          assert.doesNotMatch(error.message, /local-test-token/);
          return true;
        },
      );
      assert.ok(offlineRequests > 0);
    } finally {
      globalThis.fetch = savedFetch;
      process.env = saved;
    }
  });

  it('combines failures with the leading one first', () => {
    const leading = new Error('primary changed');
    assert.equal(withAdditionalFailures(leading, [undefined]), leading);
    assert.equal(
      withAdditionalFailures(leading, [
        new Error('scenario failed'),
        undefined,
        new Error('cleanup failed'),
      ]).message,
      'primary changed\nalso: scenario failed\nalso: cleanup failed',
    );
  });

  it('is registered as Mocha root hooks by the live-suite command only', async () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    );
    assert.match(
      pkg.scripts['test:e2e:real-cma'],
      /--require ts-node\/register --require test\/e2e\/real-cma-harness\.ts /,
    );
    assert.doesNotMatch(pkg.scripts.test, /real-cma-harness/);
    assert.equal(typeof mochaHooks.afterAll, 'function');

    const saved = { ...process.env };
    try {
      Reflect.deleteProperty(process.env, 'DATOCMS_CONTENT_DIFF_E2E');
      await assert.rejects(
        mochaHooks.beforeAll.call({ timeout() {} } as unknown as Mocha.Context),
        /DATOCMS_CONTENT_DIFF_E2E=1 is required/,
      );
      assert.throws(requireActivePrimaryEnvironmentGuard, /not active/);
    } finally {
      process.env = saved;
    }
  });
});

type PackagedHostFixture = {
  packageRoot: string;
  hostDirectory: string;
  manifest: Record<string, any>;
  writeManifest(): Promise<void>;
};

async function writeFileWithParents(path: string, contents: string | Buffer) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

async function packagedHostFixture(
  directory: string,
): Promise<PackagedHostFixture> {
  const packageRoot = join(directory, 'checkout');
  const hostDirectory = join(directory, 'host');
  const checkout = {
    name: '@example/content-diff-plugin',
    version: '1.2.3',
    devDependencies: { datocms: '^4.2.0' },
  };
  await writeFileWithParents(
    join(packageRoot, 'package.json'),
    JSON.stringify(checkout),
  );
  // The workspace host next to the checkout, as packages/cli is.
  await writeFileWithParents(
    join(directory, 'cli', 'package.json'),
    JSON.stringify({ name: 'datocms', version: '4.2.0' }),
  );
  await writeFileWithParents(join(packageRoot, 'tsconfig.json'), '{}\n');
  await writeFileWithParents(join(packageRoot, 'README.md'), 'docs\n');
  await writeFileWithParents(join(packageRoot, 'bin', 'run'), 'launcher\n');
  await writeFileWithParents(
    join(packageRoot, 'src', 'index.ts'),
    'export {};\n',
  );
  await writeFileWithParents(
    join(packageRoot, 'src', 'nested', 'command.ts'),
    'export const command = 1;\n',
  );

  await writeFileWithParents(
    join(hostDirectory, 'node_modules', 'datocms', 'package.json'),
    JSON.stringify({ name: 'datocms', version: '4.2.0' }),
  );
  await writeFileWithParents(
    join(hostDirectory, 'node_modules', 'datocms', 'bin', 'run'),
    '#!/usr/bin/env node\n',
  );
  const pluginRoot = 'oclif/data/node_modules/@example/content-diff-plugin';
  await writeFileWithParents(
    join(hostDirectory, ...pluginRoot.split('/'), 'package.json'),
    JSON.stringify({ name: checkout.name, version: checkout.version }),
  );
  for (const path of [
    'oclif/config',
    'oclif/cache',
    'xdg/data',
    'xdg/config',
    'xdg/cache',
  ]) {
    await mkdir(join(hostDirectory, ...path.split('/')), { recursive: true });
  }
  const tarball = Buffer.from('packed plugin bytes');
  await writeFileWithParents(
    join(hostDirectory, 'tarball', 'plugin.tgz'),
    tarball,
  );

  const manifest: Record<string, any> = {
    kind: 'datocms-content-diff-packaged-host',
    formatVersion: 1,
    host: {
      package: 'datocms',
      version: '4.2.0',
      bin: 'node_modules/datocms/bin/run',
    },
    plugin: {
      name: checkout.name,
      version: checkout.version,
      root: pluginRoot,
      tarball: 'tarball/plugin.tgz',
      tarballSha256: createHash('sha256').update(tarball).digest('hex'),
      fileCount: 1,
      frozenTarball: false,
      executableInputsSha256: executableInputsSha256(packageRoot),
    },
    oclif: {
      dataDir: 'oclif/data',
      configDir: 'oclif/config',
      cacheDir: 'oclif/cache',
    },
    xdg: {
      dataHome: 'xdg/data',
      configHome: 'xdg/config',
      cacheHome: 'xdg/cache',
    },
    verifiedChecks: ['the tarball contains exactly the expected release files'],
  };
  const fixture: PackagedHostFixture = {
    packageRoot,
    hostDirectory,
    manifest,
    async writeManifest() {
      await writeFile(
        join(hostDirectory, PACKAGED_HOST_MANIFEST_FILENAME),
        JSON.stringify(fixture.manifest),
      );
    },
  };
  await fixture.writeManifest();
  return fixture;
}

type PackagedHostScripts = {
  executableInputsSha256(packageRoot: string): string;
  packagedHostEnvironment(
    hostDirectory: string,
    manifest: Record<string, any>,
  ): Record<string, string>;
  writePackagedHostManifest(
    packagedHost: { hostDirectory: string; manifest: Record<string, any> },
    verifiedChecks: readonly string[],
  ): string;
  PACKAGED_HOST_MANIFEST_FILENAME: string;
  PACKAGED_HOST_KIND: string;
  PACKAGED_HOST_LAYOUT: {
    oclif: Record<string, string>;
    xdg: Record<string, string>;
  };
};

async function importPackagedHostScripts(): Promise<PackagedHostScripts> {
  return (await import(
    pathToFileURL(resolve(__dirname, '../../scripts/packaged-host.mjs')).href
  )) as PackagedHostScripts;
}

describe('real-CMA harness CLI selection', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-diff-cli-mode-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('uses bin/dev sources unless the packaged mode is explicitly selected', () => {
    for (const environment of [
      {},
      { DATOCMS_CONTENT_DIFF_E2E_CLI: '' },
      { DATOCMS_CONTENT_DIFF_E2E_CLI: 'source' },
    ]) {
      assert.equal(resolveCliInvocation(environment), SOURCE_CLI);
    }
    assert.match(SOURCE_CLI.binPath, /[/\\]bin[/\\]dev$/);
    assert.deepEqual(SOURCE_CLI.environment, {});
  });

  it('rejects unknown modes, a stray host, and missing or relative hosts', () => {
    for (const [environment, message] of [
      [
        { DATOCMS_CONTENT_DIFF_E2E_CLI: 'lib' },
        /must be "source" or "packaged"/,
      ],
      [
        { DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: '/tmp/host' },
        /is set but DATOCMS_CONTENT_DIFF_E2E_CLI is not "packaged"/,
      ],
      [
        { DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged' },
        /requires DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST/,
      ],
      [
        {
          DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged',
          DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: 'relative/host',
        },
        /absolute host directory/,
      ],
    ] as const) {
      assert.throws(() => resolveCliInvocation(environment), message);
    }
  });

  it("runs the packaged host's datocms binary with oclif state isolated inside the host", async () => {
    const fixture = await packagedHostFixture(directory);
    const invocation = resolveCliInvocation(
      {
        DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged',
        DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: fixture.hostDirectory,
      },
      { packageRoot: fixture.packageRoot },
    );
    const host = fixture.hostDirectory;

    assert.equal(invocation.mode, 'packaged');
    assert.equal(
      invocation.binPath,
      join(host, 'node_modules', 'datocms', 'bin', 'run'),
    );
    assert.deepEqual(invocation.environment, {
      DATOCMS_DATA_DIR: join(host, 'oclif', 'data'),
      DATOCMS_CONFIG_DIR: join(host, 'oclif', 'config'),
      DATOCMS_CACHE_DIR: join(host, 'oclif', 'cache'),
      XDG_DATA_HOME: join(host, 'xdg', 'data'),
      XDG_CONFIG_HOME: join(host, 'xdg', 'config'),
      XDG_CACHE_HOME: join(host, 'xdg', 'cache'),
      DATOCMS_SKIP_NEW_VERSION_CHECK: 'true',
    });
    assert.match(
      invocation.description,
      /datocms@4\.2\.0, @example\/content-diff-plugin@1\.2\.3, tarball sha256 [a-f0-9]{64}/,
    );

    // The documentation-only README does not make the host stale.
    await writeFile(join(fixture.packageRoot, 'README.md'), 'changed docs\n');
    resolveCliInvocation(
      {
        DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged',
        DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: host,
      },
      { packageRoot: fixture.packageRoot },
    );
  });

  it('refuses stale, tampered, escaping, or mismatched packaged hosts', async () => {
    const mutations: Array<{
      name: string;
      mutate(fixture: PackagedHostFixture): Promise<void>;
      message: RegExp;
    }> = [
      {
        name: 'changed source',
        async mutate(fixture) {
          await writeFile(
            join(fixture.packageRoot, 'src', 'nested', 'command.ts'),
            'export const command = 2;\n',
          );
        },
        message: /built from different executable sources/,
      },
      {
        name: 'tampered tarball',
        async mutate(fixture) {
          await writeFile(
            join(fixture.hostDirectory, 'tarball', 'plugin.tgz'),
            'other bytes',
          );
        },
        message: /does not match its recorded SHA-256/,
      },
      {
        name: 'escaping path',
        async mutate(fixture) {
          fixture.manifest.oclif.dataDir = '../outside';
          await fixture.writeManifest();
        },
        message: /must be a relative path inside the host directory/,
      },
      {
        name: 'wrong host version',
        async mutate(fixture) {
          await writeFile(
            join(
              fixture.hostDirectory,
              'node_modules',
              'datocms',
              'package.json',
            ),
            JSON.stringify({ name: 'datocms', version: '4.2.1' }),
          );
        },
        message: /installed datocms@4\.2\.1 instead of 4\.2\.0/,
      },
      {
        name: 'other plugin',
        async mutate(fixture) {
          fixture.manifest.plugin.name = '@example/other';
          await fixture.writeManifest();
        },
        message: /contains "@example\/other"/,
      },
      {
        name: 'frozen with digest',
        async mutate(fixture) {
          fixture.manifest.plugin.frozenTarball = true;
          await fixture.writeManifest();
        },
        message: /frozen-tarball packaged host must not claim/,
      },
      ...[undefined, [], [''], 'all checks passed'].map((verifiedChecks) => ({
        name: `unverified host (${JSON.stringify(verifiedChecks)})`,
        async mutate(fixture: PackagedHostFixture) {
          fixture.manifest.verifiedChecks = verifiedChecks;
          await fixture.writeManifest();
        },
        message: /does not record passed installation and routing checks/,
      })),
      {
        name: 'missing manifest',
        async mutate(fixture) {
          await rm(
            join(fixture.hostDirectory, PACKAGED_HOST_MANIFEST_FILENAME),
          );
        },
        message: /cannot read packaged host manifest/,
      },
    ];

    for (const [index, testCase] of mutations.entries()) {
      const fixture = await packagedHostFixture(join(directory, `${index}`));
      await testCase.mutate(fixture);
      assert.throws(
        () =>
          resolveCliInvocation(
            {
              DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged',
              DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: fixture.hostDirectory,
            },
            { packageRoot: fixture.packageRoot },
          ),
        testCase.message,
        testCase.name,
      );
    }
  });

  it('accepts a frozen tarball host without claiming a checkout digest', async () => {
    const fixture = await packagedHostFixture(directory);
    fixture.manifest.plugin.frozenTarball = true;
    fixture.manifest.plugin.executableInputsSha256 = null;
    await fixture.writeManifest();
    await writeFile(
      join(fixture.packageRoot, 'src', 'index.ts'),
      'export const later = true;\n',
    );
    const invocation = resolveCliInvocation(
      {
        DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged',
        DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: fixture.hostDirectory,
      },
      { packageRoot: fixture.packageRoot },
    );
    assert.match(invocation.description, /frozen tarball sha256/);
  });

  it('agrees with scripts/packaged-host.mjs on layout, isolation, and source digest', async () => {
    const scripts = await importPackagedHostScripts();
    const fixture = await packagedHostFixture(directory);

    assert.equal(
      scripts.PACKAGED_HOST_MANIFEST_FILENAME,
      PACKAGED_HOST_MANIFEST_FILENAME,
    );
    assert.equal(scripts.PACKAGED_HOST_KIND, fixture.manifest.kind);
    assert.deepEqual(
      scripts.PACKAGED_HOST_LAYOUT.oclif,
      fixture.manifest.oclif,
    );
    assert.deepEqual(scripts.PACKAGED_HOST_LAYOUT.xdg, fixture.manifest.xdg);
    assert.equal(
      scripts.executableInputsSha256(fixture.packageRoot),
      executableInputsSha256(fixture.packageRoot),
    );
    assert.deepEqual(
      scripts.packagedHostEnvironment(fixture.hostDirectory, fixture.manifest),
      resolveCliInvocation(
        {
          DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged',
          DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: fixture.hostDirectory,
        },
        { packageRoot: fixture.packageRoot },
      ).environment,
    );

    // The script writes the manifest only with passed checks, which the
    // harness requires.
    const { verifiedChecks: _, ...unverified } = fixture.manifest;
    const manifestPath = join(
      fixture.hostDirectory,
      PACKAGED_HOST_MANIFEST_FILENAME,
    );
    await rm(manifestPath);
    assert.throws(
      () =>
        scripts.writePackagedHostManifest(
          { hostDirectory: fixture.hostDirectory, manifest: unverified },
          [],
        ),
      /requires the titles of the checks that passed/,
    );
    assert.equal(
      await readFile(manifestPath, 'utf8').catch(() => 'absent'),
      'absent',
    );
    assert.equal(
      scripts.writePackagedHostManifest(
        { hostDirectory: fixture.hostDirectory, manifest: unverified },
        ['routing check'],
      ),
      manifestPath,
    );
    assert.deepEqual(
      (await readdir(fixture.hostDirectory)).filter((name) =>
        name.startsWith(PACKAGED_HOST_MANIFEST_FILENAME),
      ),
      [PACKAGED_HOST_MANIFEST_FILENAME],
    );
    assert.equal(
      resolveCliInvocation(
        {
          DATOCMS_CONTENT_DIFF_E2E_CLI: 'packaged',
          DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST: fixture.hostDirectory,
        },
        { packageRoot: fixture.packageRoot },
      ).mode,
      'packaged',
    );
  });

  it('runs cross-project CLI calls through the packaged host with only the per-command credential', async () => {
    const script = join(directory, 'print-env.cjs');
    await writeFile(
      script,
      "process.stdout.write(JSON.stringify({ bin: 'packaged host', data: process.env.DATOCMS_DATA_DIR, xdg: process.env.XDG_CONFIG_HOME, source: process.env.DATOCMS_CONTENT_DIFF_E2E_SOURCE_API_TOKEN, destination: process.env.DATOCMS_CONTENT_DIFF_E2E_DESTINATION_API_TOKEN }));\n",
    );
    const explicit = join(directory, 'explicit.cjs');
    await writeFile(explicit, "process.stdout.write('explicit bin');\n");
    const cli: CliInvocation = {
      mode: 'packaged',
      binPath: script,
      environment: {
        DATOCMS_DATA_DIR: '/host/oclif/data',
        XDG_CONFIG_HOME: '/host/xdg/config',
      },
      description: 'fixture packaged host',
    };
    const savedDataDirectory = process.env.DATOCMS_DATA_DIR;
    const cancellation = createScenarioCancellation();
    try {
      // A global oclif override in the parent must not reach the host.
      process.env.DATOCMS_DATA_DIR = '/home/user/.local/share/datocms';
      const environment = destinationExecutionEnvironment({
        sourceToken: 'source-secret',
        destinationToken: 'destination-secret',
        expectedSourceProjectId: 'source-project',
        expectedDestinationProjectId: 'destination-project',
        keep: false,
      });
      const packaged = await runCrossProjectCli({
        args: [],
        cwd: directory,
        environment,
        secrets: ['destination-secret'],
        cancellation,
        cli,
      });
      assert.deepEqual(JSON.parse(packaged.stdout), {
        bin: 'packaged host',
        data: '/host/oclif/data',
        xdg: '/host/xdg/config',
        destination: 'destination-secret',
      });

      const explicitBin = await runCrossProjectCli({
        args: [],
        cwd: directory,
        environment,
        secrets: ['destination-secret'],
        cancellation,
        cli,
        binPath: explicit,
      });
      assert.equal(explicitBin.stdout, 'explicit bin');
    } finally {
      if (savedDataDirectory === undefined) {
        Reflect.deleteProperty(process.env, 'DATOCMS_DATA_DIR');
      } else {
        process.env.DATOCMS_DATA_DIR = savedDataDirectory;
      }
      await cancellation.shutdown();
    }
  });

  it('passes the packaged isolation variables to CLI children while keeping the scenario token', async () => {
    const script = join(directory, 'print-env.cjs');
    await writeFile(
      script,
      'process.stdout.write(JSON.stringify({ data: process.env.DATOCMS_DATA_DIR, token: process.env.DATOCMS_API_TOKEN, profile: process.env.DATOCMS_PROFILE }));\n',
    );
    const cancellation = createScenarioCancellation();
    try {
      const result = await runCli({
        binPath: script,
        args: [],
        cwd: directory,
        apiToken: 'local-test-token',
        cancellation,
        extraEnvironment: {
          DATOCMS_DATA_DIR: '/isolated/data',
          DATOCMS_API_TOKEN: 'must-not-override',
        },
      });
      assert.deepEqual(JSON.parse(result.stdout), {
        data: '/isolated/data',
        token: 'local-test-token',
        profile: 'default',
      });
    } finally {
      await cancellation.shutdown();
    }
  });
});
