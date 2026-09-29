import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MIGRATIONS_RUN_LOCK_RECORD_ID,
  parseMigrationsRunLockName,
} from '../../src/utils/migrations-run-lock';
import {
  type BarrierPaths,
  type CliOutcome,
  type RunningCli,
  barrierPaths,
  inPlaceRunArgs,
  invocationLines,
  migrationSource,
  startCliProcess,
  waitForFile,
  waitForOutput,
} from '../e2e/run-lock-scenarios';
import {
  type ScenarioCancellation,
  createScenarioCancellation,
} from '../e2e/scenario-cancellation';

/**
 * Offline counterpart of the live signalInterruption scenario: the real CLI
 * runs through bin/dev in a child process with piped stdio, exactly as the
 * live suite starts it, while package:check's mocked CMA preload serves every
 * CMA call from a JSON state file.
 */

const PLUGIN_ROOT = resolve(__dirname, '../..');
const ENVIRONMENT_ID = 'sandbox';
/** Short enough to fail fast when a notice stays buffered. */
const WAIT_TIMEOUT_MS = 20_000;
/** A barrier that is never released fails its migration instead of hanging. */
const BARRIER_TIMEOUT_MS = 60_000;
const FORCED_EXIT_TIMEOUT_MS = 10_000;

type MockCmaState = {
  contents: Record<string, { items: Array<{ id: string; name: string }> }>;
};

describe('migrations:run signal handling in a child process', function () {
  this.timeout(120_000);

  let directory: string;
  let workspace: string;
  let migrationsDirectory: string;
  let configPath: string;
  let statePath: string;
  let cliEnvironment: Record<string, string>;
  let cancellation: ScenarioCancellation;

  before(function () {
    if (process.platform === 'win32') this.skip();
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'datocms-migrations-signals-'));
    workspace = join(directory, 'workspace');
    migrationsDirectory = join(workspace, 'migrations');
    configPath = join(workspace, 'datocms.config.json');
    statePath = join(directory, 'cma-state.json');
    await mkdir(migrationsDirectory, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: { default: { migrations: { directory: 'migrations' } } },
      }),
    );

    const { MOCK_CMA_PRELOAD } = (await import(
      pathToFileURL(join(PLUGIN_ROOT, 'scripts', 'package-check.mjs')).href
    )) as { MOCK_CMA_PRELOAD: string };
    const mockPath = join(directory, 'mock-cma.cjs');
    await writeFile(mockPath, MOCK_CMA_PRELOAD);
    // Installs the mock when the CLI first loads @datocms/cli-utils, so that
    // bin/dev still loads @oclif/core itself, in the same order as the live
    // suite, which preloads nothing.
    const preloadPath = join(directory, 'preload.cjs');
    await writeFile(
      preloadPath,
      [
        "'use strict';",
        "const Module = require('node:module');",
        'const load = Module._load;',
        'Module._load = function (request, ...rest) {',
        '  const loaded = load.call(this, request, ...rest);',
        "  if (request === '@datocms/cli-utils') {",
        '    Module._load = load;',
        `    require(${JSON.stringify(mockPath)});`,
        '  }',
        '  return loaded;',
        '};',
        '',
      ].join('\n'),
    );
    await writeFile(
      statePath,
      JSON.stringify({
        siteId: 'signals-site',
        mutations: [],
        environments: [
          {
            id: 'main',
            type: 'environment',
            meta: { primary: true, status: 'ready', forked_from: null },
          },
          {
            id: ENVIRONMENT_ID,
            type: 'environment',
            meta: { primary: false, status: 'ready', forked_from: 'main' },
          },
        ],
        contents: {
          main: { itemTypes: [], fields: [], items: [] },
          [ENVIRONMENT_ID]: { itemTypes: [], fields: [], items: [] },
        },
      }),
    );

    cliEnvironment = {
      // bin/dev takes no preload argument, so the mock rides on NODE_OPTIONS.
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require ${JSON.stringify(preloadPath)}`,
      ]
        .filter(Boolean)
        .join(' '),
      PACKAGE_CHECK_PLUGIN_ROOT: PLUGIN_ROOT,
      PACKAGE_CHECK_CMA_STATE: statePath,
      PACKAGE_CHECK_MARKERS: join(directory, 'markers.jsonl'),
      XDG_CACHE_HOME: join(directory, 'xdg-cache'),
      XDG_CONFIG_HOME: join(directory, 'xdg-config'),
      XDG_DATA_HOME: join(directory, 'xdg-data'),
    };
    cancellation = createScenarioCancellation({ childKillGraceMs: 1000 });
  });

  afterEach(async () => {
    // Kills any CLI still running after a failure.
    await cancellation.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  function startCli(extraArgs: readonly string[] = []): RunningCli {
    return startCliProcess({
      cli: {
        binPath: join(PLUGIN_ROOT, 'bin', 'dev'),
        environment: cliEnvironment,
      },
      args: [...inPlaceRunArgs(ENVIRONMENT_ID, configPath), ...extraArgs],
      cwd: workspace,
      apiToken: 'signals-test-token',
      cancellation,
    });
  }

  async function writeMigration(
    filename: string,
    options: Readonly<{ logPath: string; barrier?: BarrierPaths }>,
  ): Promise<void> {
    await writeFile(
      join(migrationsDirectory, filename),
      migrationSource({
        name: filename,
        timeoutMs: BARRIER_TIMEOUT_MS,
        ...options,
      }),
    );
  }

  async function trackingRecords(): Promise<{
    lockName: string | null;
    history: string[];
  }> {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as MockCmaState;
    const items = state.contents[ENVIRONMENT_ID].items;
    const lock = items.find(({ id }) => id === MIGRATIONS_RUN_LOCK_RECORD_ID);
    return {
      lockName: lock ? lock.name : null,
      history: items
        .filter(({ id }) => id !== MIGRATIONS_RUN_LOCK_RECORD_ID)
        .map(({ name }) => name)
        .sort(),
    };
  }

  function lockToken(name: string | null): string {
    const parsed = parseMigrationsRunLockName(name);
    assert.ok('meta' in parsed, `unreadable lock name ${JSON.stringify(name)}`);
    return parsed.meta.runId;
  }

  it('prints the first-signal notice while the migration still runs, then stops after it and releases the lock', async () => {
    const graceful = barrierPaths(directory, 'graceful');
    await writeMigration('1700000300_slow.js', {
      barrier: graceful,
      logPath: graceful.log,
    });
    await writeMigration('1700000301_after.js', { logPath: graceful.log });

    const running = startCli();
    await waitForFile(graceful.started, running, cancellation, WAIT_TIMEOUT_MS);
    running.child.kill('SIGINT');
    // The migration is still blocked on its barrier, which is released only
    // once the notice has reached the stderr pipe.
    await waitForOutput(
      running,
      /Received SIGINT\. Migration "1700000300_slow\.js" cannot be interrupted safely; migrations:run will stop after it finishes and run no further migrations\. Press Ctrl-C again to exit immediately\./,
      cancellation,
      WAIT_TIMEOUT_MS,
    );
    assert.equal(running.exited(), false);
    assert.equal(existsSync(graceful.release), false);

    await writeFile(graceful.release, '');
    const outcome = await running.completion;

    assert.equal(outcome.exitCode, 130, describeOutcome(outcome));
    assert.match(
      outcome.stderr,
      /Received SIGINT\. Migration "1700000300_slow\.js" cannot be interrupted safely/,
    );
    assert.match(
      outcomeText(outcome),
      /Interrupted by SIGINT after "1700000300_slow\.js" completed; 1 remaining migration\(s\) were not run\./,
    );
    assert.deepEqual(
      invocationLines(await readFile(graceful.log, 'utf8')).map(
        ({ name }) => name,
      ),
      ['1700000300_slow.js'],
    );
    assert.deepEqual(await trackingRecords(), {
      lockName: null,
      history: ['1700000300_slow.js'],
    });
  });

  it("streams a migration's own output while it runs instead of after it finishes", async () => {
    const slow = barrierPaths(directory, 'progress');
    await writeFile(
      join(migrationsDirectory, '1700000303_progress.js'),
      [
        "const { existsSync, writeFileSync } = require('node:fs');",
        '',
        'module.exports = async function () {',
        "  console.log('progress: step 1 of 2');",
        `  writeFileSync(${JSON.stringify(
          slow.started,
        )}, String(process.pid));`,
        `  const deadline = Date.now() + ${BARRIER_TIMEOUT_MS};`,
        `  while (!existsSync(${JSON.stringify(slow.release)})) {`,
        "    if (Date.now() > deadline) throw new Error('never released');",
        '    await new Promise((resolve) => setTimeout(resolve, 100));',
        '  }',
        "  console.log('progress: step 2 of 2');",
        '};',
        '',
      ].join('\n'),
    );

    const running = startCli();
    await waitForFile(slow.started, running, cancellation, WAIT_TIMEOUT_MS);
    // The migration is still blocked on its barrier: its first line must
    // already have reached the stdout pipe.
    await waitForOutput(
      running,
      /progress: step 1 of 2/,
      cancellation,
      WAIT_TIMEOUT_MS,
    );
    assert.equal(running.exited(), false);
    assert.doesNotMatch(running.output(), /progress: step 2 of 2/);

    await writeFile(slow.release, '');
    const outcome = await running.completion;

    assert.equal(outcome.exitCode, 0, describeOutcome(outcome));
    const stepOne = outcome.stdout.indexOf('progress: step 1 of 2');
    const stepTwo = outcome.stdout.indexOf('progress: step 2 of 2');
    assert.ok(stepOne >= 0 && stepTwo > stepOne, describeOutcome(outcome));
    assert.match(
      outcomeText(outcome),
      /Running migration "1700000303_progress\.js"\.\.\. done/,
    );
    assert.deepEqual(await trackingRecords(), {
      lockName: null,
      history: ['1700000303_progress.js'],
    });
  });

  it('exits at once on a second signal and leaves the run lock with its unlock token', async () => {
    const forced = barrierPaths(directory, 'forced');
    await writeMigration('1700000302_slow.js', {
      barrier: forced,
      logPath: forced.log,
    });

    const running = startCli();
    await waitForFile(forced.started, running, cancellation, WAIT_TIMEOUT_MS);
    const { lockName } = await trackingRecords();
    assert.ok(lockName, 'the interrupted run holds no lock');
    const token = lockToken(lockName);

    running.child.kill('SIGINT');
    await waitForOutput(
      running,
      /Received SIGINT\. Migration "1700000302_slow\.js" cannot be interrupted safely/,
      cancellation,
      WAIT_TIMEOUT_MS,
    );
    const secondSignalAt = Date.now();
    running.child.kill('SIGINT');
    const outcome = await running.completion;

    assert.ok(
      Date.now() - secondSignalAt < FORCED_EXIT_TIMEOUT_MS,
      'the second SIGINT did not exit immediately',
    );
    assert.equal(outcome.exitCode, 130, describeOutcome(outcome));
    assert.match(
      outcome.stderr,
      /Received SIGINT again\. Exiting immediately without waiting for "1700000302_slow\.js"\./,
    );
    assert.ok(
      outcome.stderr.includes(
        `The run lock on "${ENVIRONMENT_ID}" is still held (unlock token ${token}).`,
      ),
      describeOutcome(outcome),
    );
    assert.ok(outcome.stderr.includes(`--force-unlock=${token}`));
    const leaked = await trackingRecords();
    assert.equal(lockToken(leaked.lockName), token);
    assert.deepEqual(leaked.history, []);

    // The printed token clears the leaked lock and the run completes.
    await writeFile(forced.release, '');
    const resumed = await startCli([`--force-unlock=${token}`]).completion;
    assert.equal(resumed.exitCode, 0, describeOutcome(resumed));
    assert.deepEqual(await trackingRecords(), {
      lockName: null,
      history: ['1700000302_slow.js'],
    });
  });
});

function outcomeText(outcome: CliOutcome): string {
  // oclif wraps long errors; compare the unwrapped text.
  return `${outcome.stdout}\n${outcome.stderr}`.replace(/\s*\n\s*›\s*/gu, ' ');
}

function describeOutcome(outcome: CliOutcome): string {
  return `exit ${
    outcome.exitCode ?? `signal ${outcome.signal}`
  }\n${outcome.stdout.trim()}\n${outcome.stderr.trim()}`;
}
