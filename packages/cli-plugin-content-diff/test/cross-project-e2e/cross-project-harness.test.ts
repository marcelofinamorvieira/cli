import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import { isPortableDatoId } from '../../src/content-diff/canonicalize';
import { shutdownScenarioWork } from '../e2e/real-cma-harness';
import {
  type ScenarioCancellation,
  createScenarioCancellation,
} from '../e2e/scenario-cancellation';
import {
  CROSS_PROJECT_E2E_ENV,
  alignedFixtureIds,
  assertDisposableProject,
  assertWrongProjectBindingFailure,
  buildCrossProjectConfig,
  destinationExecutionEnvironment,
  forkOwnedEnvironment,
  runAlignedCrossProjectE2E,
  runCli,
} from './cross-project-harness';

describe('aligned cross-project real-CMA harness contracts', () => {
  it('requires the exact migration and both project IDs in the CLI binding refusal', () => {
    const expected = {
      migrationFilename: '20260922123456_cross-project.js',
      targetSiteId: '234793',
      activeSiteId: '234130',
    };
    const message =
      'Error: Content-diff migration "20260922123456_cross-project.js" targets DatoCMS project "234793", but the active profile targets "234130". No migration was executed.';
    assert.doesNotThrow(() =>
      assertWrongProjectBindingFailure(message, expected),
    );
    assert.doesNotThrow(() =>
      assertWrongProjectBindingFailure(
        message.replace(/ /g, '\n    '),
        expected,
      ),
    );
    for (const unexpected of [
      'Authentication failed',
      'Wrong target or destination project',
      message.replace('234793', '234794'),
      message.replace('234130', '234131'),
      message.replace('20260922123456_cross-project.js', 'different.js'),
      message.replace('No migration was executed.', ''),
    ])
      assert.throws(
        () => assertWrongProjectBindingFailure(unexpected, expected),
        assert.AssertionError,
        unexpected,
      );
  });

  it('accepts whole-word throwaway markers only when the project identity matches', () => {
    for (const name of [
      'second blank throwaway project',
      'SECOND-BLANK-THROWAWAY-PROJECT',
      'throwaway',
      'source e2e',
      'source test',
      'source testing',
      'source disposable',
    ]) {
      assert.doesNotThrow(() =>
        assertDisposableProject({ id: 'source', name }, 'source', 'source'),
      );
    }
    for (const name of [
      'Company Production',
      'nonthrowawayable',
      'throwawayproduction',
      'productionthrowaway',
      'contest storefront',
      'pretestingpost',
    ]) {
      assert.throws(
        () =>
          assertDisposableProject({ id: 'source', name }, 'source', 'source'),
        /source project name must contain/,
        name,
      );
    }
    assert.throws(
      () =>
        assertDisposableProject(
          { id: 'wrong-project', name: 'second blank throwaway project' },
          'destination',
          'destination',
        ),
      /destination project marker does not match/,
    );
  });

  it('does not claim a colliding fork for destructive cleanup', async () => {
    const owned: string[] = [];
    let reads = 0;
    const collision = new CmaClient.ApiError({
      request: {
        url: '/environments/source/fork',
        method: 'POST',
        headers: {},
      },
      response: {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {},
        body: {
          data: [
            {
              id: 'collision',
              type: 'api_error',
              attributes: {
                code: 'VALIDATION_UNIQUENESS',
                details: {},
              },
            },
          ],
        },
      },
    });
    const client = {
      environments: {
        async find() {
          reads += 1;
          if (reads === 1) {
            throw new CmaClient.ApiError({
              request: {
                url: '/environments/candidate',
                method: 'GET',
                headers: {},
              },
              response: {
                status: 404,
                statusText: 'Not Found',
                headers: {},
                body: {
                  data: [
                    {
                      id: 'missing',
                      type: 'api_error',
                      attributes: { code: 'NOT_FOUND', details: {} },
                    },
                  ],
                },
              },
            });
          }
          return { id: 'candidate', meta: { forked_from: 'source' } };
        },
        async fork() {
          throw collision;
        },
      },
    };
    const cancellation = createScenarioCancellation();
    const pendingOwnershipRecoveries: Array<() => Promise<void>> = [];
    try {
      await assert.rejects(
        forkOwnedEnvironment(client as never, 'source', 'candidate', owned, {
          cancellation,
          recoveryClient: client as never,
          pendingOwnershipRecoveries,
        }),
        (error) => error === collision,
      );
      assert.deepEqual(owned, []);
      assert.deepEqual(pendingOwnershipRecoveries, []);
      assert.equal(reads, 1);
    } finally {
      await cancellation.shutdown();
    }
  });

  it('defers each project fork recovery until cancellation and keeps ownership lists distinct', async () => {
    const cancellation = createScenarioCancellation();
    const pendingOwnershipRecoveries: Array<() => Promise<void>> = [];
    const owned = { source: [] as string[], destination: [] as string[] };
    const events: string[] = [];
    const original = new Error('lost fork response');
    try {
      for (const project of ['source', 'destination'] as const) {
        const work = {
          environments: {
            async find() {
              return null;
            },
            async fork() {
              throw original;
            },
          },
        };
        const recovery = {
          environments: {
            async find() {
              assert.equal(cancellation.signal.aborted, true);
              events.push(project);
              return { meta: { forked_from: `${project}-primary` } };
            },
          },
        };
        await assert.rejects(
          forkOwnedEnvironment(
            work as never,
            `${project}-primary`,
            `${project}-sandbox`,
            owned[project],
            {
              cancellation,
              recoveryClient: recovery as never,
              pendingOwnershipRecoveries,
            },
          ),
          (error) => error === original,
        );
      }
      assert.deepEqual(events, []);
      assert.deepEqual(owned, { source: [], destination: [] });
      assert.deepEqual(
        await shutdownScenarioWork({
          cancellation,
          pendingOwnershipRecoveries,
          primaryFailure: original,
        }),
        [],
      );
      assert.deepEqual(events, ['source', 'destination']);
      assert.deepEqual(owned, {
        source: ['source-sandbox'],
        destination: ['destination-sandbox'],
      });
      assert.equal(cancellation.signal.reason, original);
    } finally {
      await cancellation.shutdown();
    }
  });

  it('kills a deadline-bound CLI, observes close, and blocks a later command', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'cross-project-cli-cancel-'),
    );
    const binPath = join(directory, 'wait.cjs');
    await writeFile(binPath, 'setTimeout(() => process.exit(0), 2000);\n');
    const cancellation = createScenarioCancellation({ timeoutMs: 150 });
    let registered = 0;
    let closed = false;
    const observed: ScenarioCancellation = {
      ...cancellation,
      trackChild(child) {
        registered += 1;
        child.once('close', () => {
          closed = true;
        });
        return cancellation.trackChild(child);
      },
    };
    const input = {
      binPath,
      args: [],
      cwd: directory,
      environment: {},
      secrets: [],
      cancellation: observed,
    };
    try {
      await assert.rejects(runCli(input), /Scenario exceeded 150ms/);
      assert.equal(closed, true);
      await assert.rejects(
        runCli(input),
        (error) => error === cancellation.signal.reason,
      );
      assert.equal(registered, 1);
    } finally {
      await cancellation.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves destination-only child credentials and redacts a failed command after close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cross-project-cli-auth-'));
    const binPath = join(directory, 'auth.cjs');
    const cancellation = createScenarioCancellation();
    const savedEnvironment = { ...process.env };
    let closed = false;
    try {
      process.env[CROSS_PROJECT_E2E_ENV.sourceToken] = 'ambient-source';
      process.env[CROSS_PROJECT_E2E_ENV.destinationToken] =
        'ambient-destination';
      process.env.DATOCMS_API_TOKEN = 'ambient-default';
      process.env.DATOCMS_PROFILE = 'ambient-profile';
      const environment = destinationExecutionEnvironment({
        sourceToken: 'local-source-token',
        destinationToken: 'local-destination-token',
        expectedSourceProjectId: 'source',
        expectedDestinationProjectId: 'destination',
        keep: false,
      });
      await writeFile(
        binPath,
        `
const forbidden = ['DATOCMS_API_TOKEN', 'DATOCMS_PROFILE', '${CROSS_PROJECT_E2E_ENV.sourceToken}'];
if (forbidden.some(key => process.env[key] !== undefined)) throw new Error('source or ambient credential leaked');
if (process.env.${CROSS_PROJECT_E2E_ENV.destinationToken} !== 'local-destination-token') throw new Error('destination credential absent');
console.error(process.env.${CROSS_PROJECT_E2E_ENV.destinationToken});
process.exitCode = 7;
`,
      );
      await assert.rejects(
        runCli({
          binPath,
          args: [],
          cwd: directory,
          environment,
          secrets: ['local-destination-token'],
          cancellation: {
            ...cancellation,
            trackChild(child) {
              child.once('close', () => {
                closed = true;
              });
              return cancellation.trackChild(child);
            },
          },
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(closed, true);
          assert.match(error.message, /exited with 7/);
          assert.match(error.message, /\[REDACTED\]/);
          assert.ok(!error.message.includes('local-destination-token'));
          return true;
        },
      );
    } finally {
      process.env = savedEnvironment;
      await cancellation.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains project identity rejection before any mutation with the scoped transport', async () => {
    const originalFetch = globalThis.fetch;
    const savedEnvironment = { ...process.env };
    const calls: string[] = [];
    try {
      Object.assign(process.env, {
        [CROSS_PROJECT_E2E_ENV.optIn]: '1',
        [CROSS_PROJECT_E2E_ENV.sourceToken]: 'local-source-token',
        [CROSS_PROJECT_E2E_ENV.destinationToken]: 'local-destination-token',
        [CROSS_PROJECT_E2E_ENV.sourceProjectId]: 'wrong-source-marker',
        [CROSS_PROJECT_E2E_ENV.destinationProjectId]: 'destination',
      });
      delete process.env[CROSS_PROJECT_E2E_ENV.keep];
      globalThis.fetch = async (input, init) => {
        assert.ok(
          init?.signal,
          'every work request must carry the cancellation signal',
        );
        const path = new URL(String(input)).pathname;
        calls.push(`${init!.method} ${path}`);
        assert.equal(
          init!.method,
          'GET',
          'identity checks must reject before mutation',
        );
        const token = new Headers(init!.headers).get('authorization')!;
        const project = token.includes('local-source-token')
          ? 'source'
          : 'destination';
        const data =
          path === '/site'
            ? {
                id: project,
                type: 'site',
                attributes: { name: `${project} testing` },
                meta: {},
              }
            : [
                {
                  id: 'main',
                  type: 'environment',
                  attributes: {},
                  meta: { primary: true },
                },
              ];
        return new Response(JSON.stringify({ data }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      await assert.rejects(
        runAlignedCrossProjectE2E(),
        /source project marker does not match/,
      );
      assert.deepEqual(calls.sort(), [
        'GET /environments',
        'GET /environments',
        'GET /site',
        'GET /site',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env = savedEnvironment;
    }
  });

  it('uses deterministic portable identities for independently seeded projects', () => {
    const first = alignedFixtureIds('same-seed');
    const second = alignedFixtureIds('same-seed');

    expect(first).to.deep.equal(second);
    expect(new Set(Object.values(first)).size).to.equal(
      Object.values(first).length,
    );
    for (const id of Object.values(first)) {
      expect(isPortableDatoId(id), id).to.equal(true);
    }
  });

  it('keeps both profile credentials environment-backed and shares only destination-owned migration settings', () => {
    expect(buildCrossProjectConfig('migration_log')).to.deep.equal({
      profiles: {
        cross_source: {
          apiTokenEnvName: CROSS_PROJECT_E2E_ENV.sourceToken,
          logLevel: 'NONE',
          migrations: {
            directory: 'migrations',
            modelApiKey: 'migration_log',
          },
        },
        cross_destination: {
          apiTokenEnvName: CROSS_PROJECT_E2E_ENV.destinationToken,
          logLevel: 'NONE',
          migrations: {
            directory: 'migrations',
            modelApiKey: 'migration_log',
          },
        },
      },
    });
  });
});
