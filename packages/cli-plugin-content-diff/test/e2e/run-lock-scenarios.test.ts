import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import {
  MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH,
  parseMigrationsRunLockName,
} from '../../src/utils/migrations-run-lock';
import {
  barrierPaths,
  destroyOwnedEnvironments,
  invocationLines,
  maximalLockName,
  migrationSource,
  plantedLockMetadata,
  startCliProcess,
  waitForFile,
  waitForOutput,
} from './run-lock-scenarios';
import { createScenarioCancellation } from './scenario-cancellation';

function environmentError(status: number, code: string): CmaClient.ApiError {
  return new CmaClient.ApiError({
    request: { url: '/environments/x', method: 'DELETE', headers: {} },
    response: {
      status,
      statusText: code,
      headers: {},
      body: {
        data: [
          { id: code, type: 'api_error', attributes: { code, details: {} } },
        ],
      },
    },
  });
}

describe('run-lock real-CMA scenario helpers', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-diff-run-lock-e2e-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('plants readable locks and builds a lock name of exactly the maximum length', () => {
    for (const environmentId of ['e', 'cde2e-mfx1abcd-0a1b2c-lbase']) {
      const metadata = plantedLockMetadata({ environmentId });
      assert.match(metadata.runId, /^[0-9a-f]{16}$/u);
      const name = maximalLockName(metadata);
      const parsed = parseMigrationsRunLockName(name);

      assert.equal(name.length, MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH);
      assert.ok('meta' in parsed);
      assert.equal(parsed.meta.runId, metadata.runId);
      assert.equal(parsed.meta.environmentId, environmentId);
    }
    assert.notEqual(
      plantedLockMetadata({ environmentId: 'e' }).runId,
      plantedLockMetadata({ environmentId: 'e' }).runId,
    );
  });

  it('writes barrier migrations that log, signal their start, and wait for release', async () => {
    const barrier = barrierPaths(directory, 'probe');
    const path = join(directory, '1700000000_slow.js');
    await writeFile(
      path,
      migrationSource({
        name: '1700000000_slow.js',
        logPath: barrier.log,
        barrier,
      }),
    );
    const migration = require(path) as () => Promise<void>;

    let settled = false;
    const running = migration().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(settled, false);
    assert.equal(await readFile(barrier.started, 'utf8'), String(process.pid));
    await writeFile(barrier.release, '');
    await running;
    assert.deepEqual(invocationLines(await readFile(barrier.log, 'utf8')), [
      { name: '1700000000_slow.js', pid: process.pid },
    ]);
  });

  it('fails a barrier migration that is never released instead of hanging', async () => {
    const barrier = barrierPaths(directory, 'stuck');
    const path = join(directory, '1700000000_stuck.js');
    await writeFile(
      path,
      migrationSource({
        name: '1700000000_stuck.js',
        logPath: barrier.log,
        barrier,
        timeoutMs: 150,
      }),
    );
    const migration = require(path) as () => Promise<void>;

    await assert.rejects(
      migration(),
      /migration barrier 1700000000_stuck\.js was never released/,
    );
  });

  it('writes recording migrations without a barrier', async () => {
    const log = join(directory, 'plain.log');
    const path = join(directory, '1700000000_plain.js');
    await writeFile(
      path,
      migrationSource({ name: '1700000000_plain.js', logPath: log }),
    );
    await (require(path) as () => Promise<void>)();
    await (require(path) as () => Promise<void>)();

    assert.deepEqual(
      invocationLines(await readFile(log, 'utf8')).map(({ name }) => name),
      ['1700000000_plain.js', '1700000000_plain.js'],
    );
    assert.throws(() => invocationLines('not a line\n'), /malformed/);
  });

  it('keeps a spawned CLI signalable and reports its exit code with the token redacted', async () => {
    const bin = join(directory, 'fake-cli.cjs');
    await writeFile(
      bin,
      `process.on('SIGINT', () => {
  console.error('stopping for ' + process.env.DATOCMS_API_TOKEN);
  process.exit(130);
});
console.log('ready ' + process.argv.slice(2).join(' '));
setTimeout(() => process.exit(0), 20000);
`,
    );
    const cancellation = createScenarioCancellation();
    try {
      const running = startCliProcess({
        cli: { binPath: bin, environment: {} },
        args: ['migrations:run', '--in-place'],
        cwd: directory,
        apiToken: 'local-test-token',
        cancellation,
      });
      await waitForOutput(
        running,
        /ready migrations:run --in-place/,
        cancellation,
      );
      running.child.kill('SIGINT');
      const outcome = await running.completion;

      assert.equal(outcome.exitCode, 130);
      assert.match(outcome.stderr, /stopping for \[REDACTED\]/);
      assert.ok(!running.output().includes('local-test-token'));
      assert.equal(running.exited(), true);
    } finally {
      await cancellation.shutdown();
    }
  });

  it('stops waiting when the CLI exits before the awaited file or output appears', async () => {
    const bin = join(directory, 'exits.cjs');
    await writeFile(bin, "console.log('bye'); process.exitCode = 1;\n");
    const cancellation = createScenarioCancellation();
    try {
      const running = startCliProcess({
        cli: { binPath: bin, environment: {} },
        args: [],
        cwd: directory,
        apiToken: 'local-test-token',
        cancellation,
      });
      await assert.rejects(
        waitForFile(join(directory, 'never'), running, cancellation),
        /the CLI exited before file never appeared:\nbye/,
      );
      await assert.rejects(
        waitForOutput(running, /never/, cancellation),
        /the CLI exited before output/,
      );
      assert.equal((await running.completion).exitCode, 1);
    } finally {
      await cancellation.shutdown();
    }
  });

  it('rejects a CLI completion that was cancelled', async () => {
    const bin = join(directory, 'waits.cjs');
    await writeFile(bin, 'setTimeout(() => process.exit(0), 20000);\n');
    const cancellation = createScenarioCancellation({ childKillGraceMs: 0 });
    const running = startCliProcess({
      cli: { binPath: bin, environment: {} },
      args: [],
      cwd: directory,
      apiToken: 'local-test-token',
      cancellation,
    });
    const reason = new Error('scenario cancelled');
    cancellation.abort(reason);

    await assert.rejects(running.completion, (error) => error === reason);
    await cancellation.drain();
  });

  it('destroys owned environments newest first and ignores ones already gone', async () => {
    const destroyed: string[] = [];
    const rootClient = {
      environments: {
        destroy: async (id: string) => {
          destroyed.push(id);
          if (id === 'gone') throw environmentError(404, 'NOT_FOUND');
          if (id === 'broken') throw environmentError(500, 'INTERNAL_ERROR');
          return {};
        },
      },
    } as unknown as Pick<CmaClient.Client, 'environments'>;

    const errors = await destroyOwnedEnvironments(rootClient, [
      'base',
      'gone',
      'broken',
      'copy',
    ]);

    assert.deepEqual(destroyed, ['copy', 'broken', 'gone', 'base']);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /could not destroy broken: CMA 500/);
  });
});
