import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import {
  MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH,
  MIGRATIONS_RUN_LOCK_NAME_PREFIX,
  MIGRATIONS_RUN_LOCK_RECORD_ID,
  type MigrationsRunLockMetadata,
  encodeMigrationsRunLockName,
  parseMigrationsRunLockName,
} from '../../src/utils/migrations-run-lock';
import {
  type CliInvocation,
  buildClient,
  forkEnvironment,
  loadHarnessConfiguration,
  requireActivePrimaryEnvironmentGuard,
  shutdownScenarioWork,
  trackAppliedEnvironmentAfterFailure,
  verifyPrimaryEnvironmentAfterScenario,
  withAdditionalFailures,
} from './real-cma-harness';
import {
  type ScenarioCancellation,
  createScenarioCancellation,
} from './scenario-cancellation';

/**
 * Live coverage of the migrations:run destination lock and of signal
 * handling. Unlike the content scenarios, these cases drive migrations:run
 * directly against owned sandboxes: every environment is a fresh fork of the
 * guarded primary (or of such a fork), primary itself is only read, and every
 * environment this module creates or proves the CLI created is destroyed.
 */

const API_TOKEN_ENV = 'DATOCMS_API_TOKEN';
/** A barrier that is never released fails its migration instead of hanging. */
const BARRIER_TIMEOUT_MS = 10 * 60 * 1000;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
/** A forced exit must not wait for the running migration or the CMA. */
const FORCED_EXIT_TIMEOUT_MS = 30_000;

export const INIT_MIGRATION_FILENAME = '1700000000_init.js';

export type CliOutcome = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export type RunningCli = Readonly<{
  child: ChildProcessWithoutNullStreams;
  /** Combined stdout and stderr received so far, with the token redacted. */
  output(): string;
  exited(): boolean;
  /** Resolves on close whatever the exit code; rejects only on cancellation. */
  completion: Promise<CliOutcome>;
}>;

export type RunLockSandbox = Readonly<{
  runId: string;
  apiToken: string;
  cli: CliInvocation;
  cancellation: ScenarioCancellation;
  rootClient: CmaClient.Client;
  baseEnvironmentId: string;
  baseClient: CmaClient.Client;
  trackingModel: CmaClient.ApiTypes.ItemType;
  migrationsDirectory: string;
  configPath: string;
  workspace: string;
  environmentId(suffix: string): string;
  client(environmentId: string): CmaClient.Client;
  /** Forks an owned environment into a new owned environment. */
  fork(
    sourceEnvironmentId: string,
    destinationEnvironmentId: string,
  ): Promise<CmaClient.Client>;
  startCli(args: readonly string[]): RunningCli;
  /** Runs migrations:run in fork mode and adopts the fork it proves it made. */
  runForkingCli(
    sourceEnvironmentId: string,
    destinationEnvironmentId: string,
    args: readonly string[],
  ): Promise<CliOutcome>;
}>;

export async function runRunLockScenario(
  name: string,
  body: (sandbox: RunLockSandbox) => Promise<void>,
): Promise<void> {
  const configuration = loadHarnessConfiguration();
  const primaryGuard = requireActivePrimaryEnvironmentGuard();
  const { apiToken } = configuration;
  const recoveryClient = buildClient(apiToken);
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const cancellation = createScenarioCancellation();
  const rootClient = buildClient(apiToken, undefined, cancellation.fetchFn);
  const createdEnvironmentIds: string[] = [];
  const pendingOwnershipRecoveries: Array<() => Promise<void>> = [];
  const migrationModelApiKey = `cde2e_migrations_${runId.replace(/-/g, '')}`;
  const workspace = await mkdtemp(
    join(tmpdir(), 'datocms-content-diff-e2e-lock-'),
  );
  const migrationsDirectory = join(workspace, 'migrations');
  const configPath = join(workspace, 'datocms.config.json');
  const environmentId = (suffix: string) => `cde2e-${runId}-${suffix}`;
  const client = (id: string) =>
    buildClient(apiToken, id, cancellation.fetchFn);
  const forkOptions = {
    cancellation,
    recoveryClient,
    pendingOwnershipRecoveries,
  };
  let primaryFailure: Error | undefined;

  try {
    cancellation.throwIfAborted();
    const [site, environments] = await Promise.all([
      rootClient.site.find(),
      rootClient.environments.list(),
    ]);
    const primary = environments.find(({ meta }) => meta.primary);
    assert.ok(primary, 'the project has no visible primary environment');
    assert.equal(
      site.id,
      primaryGuard.projectId,
      'the scenario token targets a different project than the suite primary guard',
    );
    assert.equal(
      primary.id,
      primaryGuard.primaryEnvironmentId,
      'the primary environment changed since the suite primary guard started',
    );
    console.log(
      `[content-diff e2e] Run-lock scenario ${JSON.stringify(
        name,
      )} on project ${JSON.stringify(site.name)} (${site.id}) using ${
        configuration.cli.description
      }`,
    );

    const baseEnvironmentId = environmentId('lbase');
    await forkEnvironment(
      rootClient,
      primary.id,
      baseEnvironmentId,
      createdEnvironmentIds,
      forkOptions,
    );
    await mkdir(migrationsDirectory);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          profiles: {
            default: {
              apiTokenEnvName: API_TOKEN_ENV,
              logLevel: 'NONE',
              migrations: {
                directory: 'migrations',
                modelApiKey: migrationModelApiKey,
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const startCli = (args: readonly string[]) =>
      startCliProcess({
        cli: configuration.cli,
        args,
        cwd: workspace,
        apiToken,
        cancellation,
      });

    // The plugin's own runner creates the exact tracking model, so every
    // lock below lives where real runs put it.
    console.log(
      '[content-diff e2e] Creating the tracking model through migrations:run',
    );
    await writeFile(
      join(migrationsDirectory, INIT_MIGRATION_FILENAME),
      'module.exports = async function () {};\n',
    );
    assertCliSucceeded(
      await startCli(inPlaceRunArgs(baseEnvironmentId, configPath)).completion,
      'initial migrations:run',
    );
    const baseClient = client(baseEnvironmentId);
    const trackingModel = await baseClient.itemTypes.find(migrationModelApiKey);

    await body({
      runId,
      apiToken,
      cli: configuration.cli,
      cancellation,
      rootClient,
      baseEnvironmentId,
      baseClient,
      trackingModel,
      migrationsDirectory,
      configPath,
      workspace,
      environmentId,
      client,
      async fork(sourceEnvironmentId, destinationEnvironmentId) {
        await forkEnvironment(
          rootClient,
          sourceEnvironmentId,
          destinationEnvironmentId,
          createdEnvironmentIds,
          forkOptions,
        );
        return client(destinationEnvironmentId);
      },
      startCli,
      async runForkingCli(sourceEnvironmentId, destinationEnvironmentId, args) {
        assert.equal(
          await findEnvironmentOrNull(rootClient, destinationEnvironmentId),
          null,
          `refusing to use existing environment ID ${destinationEnvironmentId}`,
        );
        const adopt = () =>
          trackAppliedEnvironmentAfterFailure({
            rootClient: recoveryClient,
            apiToken,
            sourceEnvironmentId,
            destinationEnvironmentId,
            migrationModelApiKey,
            createdEnvironmentIds,
          });
        let outcome: CliOutcome;
        try {
          outcome = await startCli(args).completion;
        } catch (error) {
          pendingOwnershipRecoveries.push(adopt);
          throw error;
        }
        await adopt();
        return outcome;
      },
    });

    cancellation.throwIfAborted();
    console.log('[content-diff e2e] Run-lock scenario passed');
  } catch (error) {
    primaryFailure = safeError(error);
  }

  const cleanupErrors = await shutdownScenarioWork({
    cancellation,
    pendingOwnershipRecoveries,
    primaryFailure,
  });
  try {
    await rm(workspace, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(
      safeError(error, `could not remove local E2E workspace ${workspace}`),
    );
  }

  if (configuration.keepEnvironments) {
    if (createdEnvironmentIds.length > 0) {
      console.log(
        `[content-diff e2e] KEEP enabled; retained environments: ${createdEnvironmentIds.join(
          ', ',
        )}`,
      );
    }
  } else {
    cleanupErrors.push(
      ...(await destroyOwnedEnvironments(
        recoveryClient,
        createdEnvironmentIds,
      )),
    );
  }

  let primaryEnvironmentFailure: Error | undefined;
  try {
    await verifyPrimaryEnvironmentAfterScenario(name, createdEnvironmentIds);
  } catch (error) {
    primaryEnvironmentFailure = safeError(error);
  }

  const cleanupFailure =
    cleanupErrors.length > 0
      ? new Error(
          `one or more E2E resources could not be cleaned up: ${cleanupErrors
            .map(({ message }) => message)
            .join('; ')}`,
        )
      : undefined;

  if (primaryEnvironmentFailure) {
    throw withAdditionalFailures(primaryEnvironmentFailure, [
      primaryFailure,
      cleanupFailure,
    ]);
  }
  if (cleanupFailure && primaryFailure) {
    console.error(`[content-diff e2e] ${cleanupFailure.message}`);
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
}

/** 1. Duplicate-ID probe: the create-then-read-back design's CMA evidence. */
export async function probeDuplicateLockId(
  sandbox: RunLockSandbox,
): Promise<void> {
  const { baseClient, trackingModel } = sandbox;
  const name = maximalLockName(
    plantedLockMetadata({
      environmentId: sandbox.baseEnvironmentId,
      runId: '0123456789abcdef',
    }),
  );
  assert.equal(name.length, MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH);

  console.log('[content-diff e2e] Creating a 255-character lock record');
  const created = await baseClient.items.create({
    id: MIGRATIONS_RUN_LOCK_RECORD_ID,
    item_type: { type: 'item_type', id: trackingModel.id },
    name,
  });
  assert.equal(created.id, MIGRATIONS_RUN_LOCK_RECORD_ID);
  assert.equal(created.name, name, 'the lock name was not stored verbatim');

  let duplicateError: unknown;
  try {
    await baseClient.items.create({
      id: MIGRATIONS_RUN_LOCK_RECORD_ID,
      item_type: { type: 'item_type', id: trackingModel.id },
      name: encodeMigrationsRunLockName(
        plantedLockMetadata({
          environmentId: sandbox.baseEnvironmentId,
          runId: 'fedcba9876543210',
        }),
      ),
    });
  } catch (error) {
    duplicateError = error;
  }
  assert.ok(
    duplicateError instanceof CmaClient.ApiError,
    'a second create with the reserved lock ID did not fail with a CMA error',
  );
  const status = duplicateError.response.status;
  assert.ok(
    status >= 400 && status < 500,
    `the duplicate lock create failed with HTTP ${status}`,
  );
  console.log(
    `[content-diff e2e] Duplicate lock ID rejected with HTTP ${status}: ${JSON.stringify(
      duplicateError.errors.map(({ attributes }) => attributes.code),
    )}`,
  );

  const stored = await baseClient.items.find(MIGRATIONS_RUN_LOCK_RECORD_ID);
  assert.equal(stored.name, name, 'the duplicate create overwrote the lock');
  await baseClient.items.destroy(MIGRATIONS_RUN_LOCK_RECORD_ID);
  assert.equal(await readLockNameOrNull(baseClient), null);
}

/** 2. Two concurrent in-place runs: exactly one executes. */
export async function concurrentInPlaceRuns(
  sandbox: RunLockSandbox,
): Promise<void> {
  const { baseClient, baseEnvironmentId, configPath } = sandbox;
  const barrier = barrierPaths(sandbox.workspace, 'concurrency');
  await writeMigration(sandbox, '1700000100_slow.js', {
    barrier,
    logPath: barrier.log,
  });
  await writeMigration(sandbox, '1700000101_fast.js', { logPath: barrier.log });
  const args = inPlaceRunArgs(baseEnvironmentId, configPath);

  console.log('[content-diff e2e] Starting the lock-holding migrations:run');
  const first = sandbox.startCli(args);
  await waitForFile(barrier.started, first, sandbox.cancellation);
  const holder = await readLockNameOrNull(baseClient);
  assert.ok(holder, 'the running migrations:run holds no lock');
  const holderMeta = lockMetadata(holder);
  assert.equal(holderMeta.pid, first.child.pid);
  assert.equal(holderMeta.mode, 'in-place');
  assert.equal(holderMeta.pending, 2);

  console.log('[content-diff e2e] Starting a concurrent migrations:run');
  const second = await sandbox.startCli(args).completion;
  assert.equal(second.exitCode, 1, describeOutcome(second));
  assert.match(
    outcomeText(second),
    new RegExp(
      `Environment "${escapeRegExp(
        baseEnvironmentId,
      )}" is locked by another migrations:run \\(run ${holderMeta.runId}`,
    ),
  );
  assert.match(outcomeText(second), /No migration was executed\./);

  await writeFile(barrier.release, '');
  assertCliSucceeded(await first.completion, 'lock-holding migrations:run');

  assert.deepEqual(
    invocationLines(await readFile(barrier.log, 'utf8')),
    [
      { name: '1700000100_slow.js', pid: first.child.pid },
      { name: '1700000101_fast.js', pid: first.child.pid },
    ],
    'the refused run executed a migration',
  );
  assert.equal(await readLockNameOrNull(baseClient), null);
  await assertHistory(sandbox, baseClient, [
    INIT_MIGRATION_FILENAME,
    '1700000100_slow.js',
    '1700000101_fast.js',
  ]);
}

/**
 * 3. content:diff refuses while either side is locked. The generation-side
 * check lives in src/content-diff/index.ts.
 */
export async function contentDiffRefusesLockedEnvironments(
  sandbox: RunLockSandbox,
): Promise<void> {
  const { baseClient, baseEnvironmentId, trackingModel } = sandbox;
  const modelApiKey = `cde2e_lock_r${sandbox.runId
    .replace(/[^a-z0-9]/g, '')
    .slice(-12)}`;
  const model = await baseClient.itemTypes.create({
    name: `Run lock probe ${sandbox.runId}`,
    api_key: modelApiKey,
    singleton: false,
    all_locales_required: false,
    sortable: false,
    modular_block: false,
    draft_mode_active: false,
    draft_saving_active: false,
    tree: false,
    collection_appearance: 'compact',
    inverse_relationships_enabled: false,
  });
  await baseClient.fields.create(model.id, {
    label: 'Title',
    api_key: 'title',
    field_type: 'string',
    localized: false,
    validators: {},
  });
  const destinationEnvironmentId = sandbox.environmentId('ldst');
  const destinationClient = await sandbox.fork(
    baseEnvironmentId,
    destinationEnvironmentId,
  );
  const diffArgs = (label: string) => [
    'content:diff',
    `run lock ${label}`,
    `--autogenerate=${baseEnvironmentId}:${destinationEnvironmentId}`,
    `--item-types=${modelApiKey}`,
    '--uploads=referenced',
    '--js',
    `--config-file=${sandbox.configPath}`,
  ];
  const artifactsBefore = await listArtifacts(sandbox.migrationsDirectory);

  for (const [side, client, environmentId] of [
    ['Destination', destinationClient, destinationEnvironmentId],
    ['Source', baseClient, baseEnvironmentId],
  ] as const) {
    const metadata = plantedLockMetadata({ environmentId });
    await plantLock(client, trackingModel, metadata);
    console.log(`[content-diff e2e] Running content:diff with a ${side} lock`);
    const refused = await sandbox.startCli(diffArgs(side)).completion;
    assert.notEqual(refused.exitCode, 0, describeOutcome(refused));
    assert.match(
      outcomeText(refused),
      new RegExp(
        `${side} environment "${escapeRegExp(
          environmentId,
        )}" is being migrated by migrations:run \\(run ${metadata.runId}`,
      ),
    );
    assert.match(outcomeText(refused), /No migration artifacts were created\./);
    assert.deepEqual(
      await listArtifacts(sandbox.migrationsDirectory),
      artifactsBefore,
      'a refused content:diff wrote migration artifacts',
    );
    await client.items.destroy(MIGRATIONS_RUN_LOCK_RECORD_ID);
  }

  console.log('[content-diff e2e] Running content:diff without locks');
  assertCliSucceeded(
    await sandbox.startCli(diffArgs('unlocked')).completion,
    'content:diff without locks',
  );
}

/**
 * 4. Fork mode: a locked source is refused before forking, --force-unlock
 * clears it, and a fork taken while a lock is held reports the copied lock.
 */
export async function forkModeLocks(sandbox: RunLockSandbox): Promise<void> {
  const { baseClient, baseEnvironmentId, configPath, trackingModel } = sandbox;
  const logPath = join(sandbox.workspace, 'fork-invocations.log');
  await writeMigration(sandbox, '1700000200_fork.js', { logPath });

  const sourceLock = plantedLockMetadata({ environmentId: baseEnvironmentId });
  await plantLock(baseClient, trackingModel, sourceLock);
  const destinationEnvironmentId = sandbox.environmentId('lfork');
  const forkArgs = [
    'migrations:run',
    `--source=${baseEnvironmentId}`,
    `--destination=${destinationEnvironmentId}`,
    `--config-file=${configPath}`,
  ];

  console.log('[content-diff e2e] Forking a locked source');
  const refused = await sandbox.runForkingCli(
    baseEnvironmentId,
    destinationEnvironmentId,
    forkArgs,
  );
  assert.equal(refused.exitCode, 1, describeOutcome(refused));
  assert.match(
    outcomeText(refused),
    new RegExp(
      `Cannot fork "${escapeRegExp(
        baseEnvironmentId,
      )}": another migrations:run is in progress there \\(run ${
        sourceLock.runId
      }`,
    ),
  );
  assert.match(outcomeText(refused), /No environment was created\./);
  assert.equal(
    await findEnvironmentOrNull(sandbox.rootClient, destinationEnvironmentId),
    null,
  );
  assert.equal(existsSync(logPath), false);

  console.log('[content-diff e2e] Clearing the source lock with its token');
  const unlocked = await sandbox.runForkingCli(
    baseEnvironmentId,
    destinationEnvironmentId,
    [...forkArgs, `--force-unlock=${sourceLock.runId}`],
  );
  assertCliSucceeded(unlocked, 'migrations:run --force-unlock');
  assert.match(
    outcomeText(unlocked),
    new RegExp(`Cleared the run lock of run ${sourceLock.runId}`),
  );
  assert.equal(await readLockNameOrNull(baseClient), null);
  const destinationClient = sandbox.client(destinationEnvironmentId);
  assert.equal(await readLockNameOrNull(destinationClient), null);
  await assertHistory(sandbox, destinationClient, [
    INIT_MIGRATION_FILENAME,
    '1700000200_fork.js',
  ]);

  console.log('[content-diff e2e] Forking an environment while it is locked');
  const copiedLock = plantedLockMetadata({ environmentId: baseEnvironmentId });
  await plantLock(baseClient, trackingModel, copiedLock);
  const copyEnvironmentId = sandbox.environmentId('lcopy');
  const copyClient = await sandbox.fork(baseEnvironmentId, copyEnvironmentId);
  await baseClient.items.destroy(MIGRATIONS_RUN_LOCK_RECORD_ID);

  const copied = await sandbox.startCli(
    inPlaceRunArgs(copyEnvironmentId, configPath),
  ).completion;
  assert.equal(copied.exitCode, 1, describeOutcome(copied));
  assert.match(
    outcomeText(copied),
    new RegExp(
      `Environment "${escapeRegExp(
        copyEnvironmentId,
      )}" is locked by another migrations:run \\(run ${copiedLock.runId}`,
    ),
  );
  assert.match(
    outcomeText(copied),
    new RegExp(`copied from environment "${escapeRegExp(baseEnvironmentId)}"`),
  );
  // The refused run leaves the copied lock for --force-unlock to clear.
  await assertHistory(
    sandbox,
    copyClient,
    [INIT_MIGRATION_FILENAME],
    copiedLock.runId,
  );
}

/**
 * 5. Signals: one SIGINT stops after the running ordinary migration and
 * releases the lock; a second SIGINT exits at once and leaves the lock with
 * its token, which --force-unlock then clears.
 */
export async function signalInterruption(
  sandbox: RunLockSandbox,
): Promise<void> {
  const { baseClient, baseEnvironmentId, configPath } = sandbox;
  const args = inPlaceRunArgs(baseEnvironmentId, configPath);
  const graceful = barrierPaths(sandbox.workspace, 'graceful');
  await writeMigration(sandbox, '1700000300_slow.js', {
    barrier: graceful,
    logPath: graceful.log,
  });
  await writeMigration(sandbox, '1700000301_after.js', {
    logPath: graceful.log,
  });

  console.log('[content-diff e2e] Sending one SIGINT during a slow migration');
  const stopped = sandbox.startCli(args);
  await waitForFile(graceful.started, stopped, sandbox.cancellation);
  stopped.child.kill('SIGINT');
  await waitForOutput(
    stopped,
    /Migration "1700000300_slow\.js" cannot be interrupted safely/,
    sandbox.cancellation,
  );
  await writeFile(graceful.release, '');
  const stoppedOutcome = await stopped.completion;
  assert.equal(stoppedOutcome.exitCode, 130, describeOutcome(stoppedOutcome));
  assert.match(
    outcomeText(stoppedOutcome),
    /Interrupted by SIGINT after "1700000300_slow\.js" completed; 1 remaining migration\(s\) were not run\./,
  );
  assert.equal(await readLockNameOrNull(baseClient), null);
  assert.deepEqual(
    invocationLines(await readFile(graceful.log, 'utf8')).map(
      ({ name }) => name,
    ),
    ['1700000300_slow.js'],
  );
  await assertHistory(sandbox, baseClient, [
    INIT_MIGRATION_FILENAME,
    '1700000300_slow.js',
  ]);

  const forced = barrierPaths(sandbox.workspace, 'forced');
  await writeMigration(sandbox, '1700000302_slow.js', {
    barrier: forced,
    logPath: forced.log,
  });

  console.log('[content-diff e2e] Sending two SIGINTs during a slow migration');
  const killed = sandbox.startCli(args);
  await waitForFile(forced.started, killed, sandbox.cancellation);
  const heldName = await readLockNameOrNull(baseClient);
  assert.ok(heldName, 'the interrupted run holds no lock');
  const token = lockMetadata(heldName).runId;
  killed.child.kill('SIGINT');
  await waitForOutput(killed, /Received SIGINT\./, sandbox.cancellation);
  const secondSignalAt = Date.now();
  killed.child.kill('SIGINT');
  const killedOutcome = await killed.completion;
  assert.ok(
    Date.now() - secondSignalAt < FORCED_EXIT_TIMEOUT_MS,
    'the second SIGINT did not exit immediately',
  );
  assert.equal(killedOutcome.exitCode, 130, describeOutcome(killedOutcome));
  assert.match(
    killedOutcome.stderr,
    /Received SIGINT again\. Exiting immediately without waiting for "1700000302_slow\.js"\./,
  );
  assert.ok(
    killedOutcome.stderr.includes(
      `The run lock on "${baseEnvironmentId}" is still held (unlock token ${token}).`,
    ),
    describeOutcome(killedOutcome),
  );
  assert.ok(killedOutcome.stderr.includes(`--force-unlock=${token}`));
  assert.equal(lockMetadata(await readLockNameOrNull(baseClient)).runId, token);

  console.log('[content-diff e2e] Clearing the leaked lock with its token');
  await writeFile(forced.release, '');
  assertCliSucceeded(
    await sandbox.startCli([...args, `--force-unlock=${token}`]).completion,
    'migrations:run --force-unlock after a forced exit',
  );
  assert.equal(await readLockNameOrNull(baseClient), null);
  await assertHistory(sandbox, baseClient, [
    INIT_MIGRATION_FILENAME,
    '1700000300_slow.js',
    '1700000301_after.js',
    '1700000302_slow.js',
  ]);
}

export function inPlaceRunArgs(
  environmentId: string,
  configPath: string,
): string[] {
  return [
    'migrations:run',
    `--source=${environmentId}`,
    '--in-place',
    `--config-file=${configPath}`,
  ];
}

/** Metadata for a lock planted by the suite, as if another run held it. */
export function plantedLockMetadata(
  overrides: Partial<MigrationsRunLockMetadata> &
    Pick<MigrationsRunLockMetadata, 'environmentId'>,
): MigrationsRunLockMetadata {
  return {
    v: 1,
    runId: randomBytes(8).toString('hex'),
    mode: 'in-place',
    host: 'content-diff-e2e',
    pid: 1,
    startedAt: new Date().toISOString(),
    pending: 1,
    ...overrides,
  };
}

/**
 * A lock name of exactly the maximum length the runner may write, padded
 * through the optional fields within their own length limits.
 */
export function maximalLockName(metadata: MigrationsRunLockMetadata): string {
  const padded: MigrationsRunLockMetadata = {
    ...metadata,
    host: 'h',
    ci: 'c',
    first: 'f',
  };
  let padding =
    MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH -
    encodeMigrationsRunLockName(padded).length;
  assert.ok(padding >= 0, 'the lock metadata leaves no room for padding');
  for (const key of ['host', 'ci', 'first'] as const) {
    const extra = Math.min(63, padding);
    padded[key] = key[0].repeat(1 + extra);
    padding -= extra;
  }
  assert.equal(padding, 0, 'the lock metadata is too short to pad');
  return encodeMigrationsRunLockName(padded);
}

export type BarrierPaths = Readonly<{
  started: string;
  release: string;
  log: string;
}>;

export function barrierPaths(directory: string, label: string): BarrierPaths {
  return {
    started: join(directory, `${label}.started`),
    release: join(directory, `${label}.release`),
    log: join(directory, `${label}.log`),
  };
}

/**
 * An ordinary migration that logs its invocation and, with a barrier, waits
 * until the test releases it. It ignores abortSignal on purpose.
 */
export function migrationSource({
  name,
  logPath,
  barrier,
  timeoutMs = BARRIER_TIMEOUT_MS,
}: Readonly<{
  name: string;
  logPath: string;
  barrier?: BarrierPaths;
  timeoutMs?: number;
}>): string {
  const lines = [
    "const { appendFileSync, existsSync, writeFileSync } = require('node:fs');",
    '',
    'module.exports = async function () {',
    `  appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(
      name,
    )} + ' ' + process.pid + '\\n');`,
  ];
  if (barrier) {
    lines.push(
      `  writeFileSync(${JSON.stringify(
        barrier.started,
      )}, String(process.pid));`,
      `  const deadline = Date.now() + ${timeoutMs};`,
      `  while (!existsSync(${JSON.stringify(barrier.release)})) {`,
      `    if (Date.now() > deadline) throw new Error(${JSON.stringify(
        `migration barrier ${name} was never released`,
      )});`,
      '    await new Promise((resolve) => setTimeout(resolve, 100));',
      '  }',
    );
  }
  lines.push('};', '');
  return lines.join('\n');
}

export function invocationLines(
  log: string,
): Array<{ name: string; pid: number }> {
  return log
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(\S+) (\d+)$/u.exec(line);
      assert.ok(match, `malformed invocation line ${JSON.stringify(line)}`);
      return { name: match[1], pid: Number(match[2]) };
    });
}

async function writeMigration(
  sandbox: RunLockSandbox,
  filename: string,
  options: Readonly<{ logPath: string; barrier?: BarrierPaths }>,
): Promise<void> {
  await writeFile(
    join(sandbox.migrationsDirectory, filename),
    migrationSource({ name: filename, ...options }),
  );
}

async function plantLock(
  client: CmaClient.Client,
  trackingModel: CmaClient.ApiTypes.ItemType,
  metadata: MigrationsRunLockMetadata,
): Promise<void> {
  await client.items.create({
    id: MIGRATIONS_RUN_LOCK_RECORD_ID,
    item_type: { type: 'item_type', id: trackingModel.id },
    name: encodeMigrationsRunLockName(metadata),
  });
}

async function readLockNameOrNull(
  client: CmaClient.Client,
): Promise<string | null> {
  try {
    const item = await client.items.find(MIGRATIONS_RUN_LOCK_RECORD_ID);
    return String(item.name);
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.response.status === 404) {
      return null;
    }
    throw error;
  }
}

function lockMetadata(name: string | null): MigrationsRunLockMetadata {
  const parsed = parseMigrationsRunLockName(name);
  assert.ok('meta' in parsed, `unreadable lock name ${JSON.stringify(name)}`);
  return parsed.meta;
}

/**
 * Exact history names, and no stray lock-shaped record. A refused run leaves
 * the lock it found in place, so `retainedLockRunId` names the only lock the
 * environment may still hold.
 */
async function assertHistory(
  sandbox: RunLockSandbox,
  client: CmaClient.Client,
  expected: readonly string[],
  retainedLockRunId?: string,
): Promise<void> {
  const names: string[] = [];
  let retainedLockSeen = false;
  for await (const item of client.items.listPagedIterator({
    filter: { type: sandbox.trackingModel.id },
  })) {
    if (
      retainedLockRunId !== undefined &&
      item.id === MIGRATIONS_RUN_LOCK_RECORD_ID
    ) {
      assert.equal(
        lockMetadata(String(item.name)).runId,
        retainedLockRunId,
        'the retained lock belongs to another run',
      );
      retainedLockSeen = true;
      continue;
    }
    assert.notEqual(item.id, MIGRATIONS_RUN_LOCK_RECORD_ID, 'a lock remains');
    const name = String(item.name);
    assert.ok(
      !name.startsWith(MIGRATIONS_RUN_LOCK_NAME_PREFIX),
      `a lock-shaped history record remains: ${item.id}`,
    );
    names.push(name);
  }
  assert.deepEqual(names.sort(), [...expected].sort());
  if (retainedLockRunId !== undefined) {
    assert.ok(retainedLockSeen, 'the refused run removed the lock it found');
  }
}

async function listArtifacts(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true });
  return entries.map(String).sort();
}

async function findEnvironmentOrNull(
  rootClient: CmaClient.Client,
  environmentId: string,
): Promise<CmaClient.ApiTypes.Environment | null> {
  try {
    return await rootClient.environments.find(environmentId);
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return null;
    }
    throw error;
  }
}

/** Destroys owned environments newest first; an absent one is already gone. */
export async function destroyOwnedEnvironments(
  rootClient: Pick<CmaClient.Client, 'environments'>,
  createdEnvironmentIds: readonly string[],
): Promise<Error[]> {
  const errors: Error[] = [];
  for (const environmentId of [...createdEnvironmentIds].reverse()) {
    try {
      console.log(`[content-diff e2e] Destroying ${environmentId}`);
      await rootClient.environments.destroy(environmentId);
    } catch (error) {
      if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
        continue;
      }
      errors.push(safeError(error, `could not destroy ${environmentId}`));
    }
  }
  return errors;
}

/**
 * Spawns the CLI like the harness's runCli, but keeps the child reachable so
 * the suite can signal it, and reports any exit code instead of rejecting.
 */
export function startCliProcess({
  cli,
  args,
  cwd,
  apiToken,
  cancellation,
}: Readonly<{
  cli: Pick<CliInvocation, 'binPath' | 'environment'>;
  args: readonly string[];
  cwd: string;
  apiToken: string;
  cancellation: ScenarioCancellation;
}>): RunningCli {
  cancellation.throwIfAborted();
  const child = spawn(process.execPath, [cli.binPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...cli.environment,
      DATOCMS_API_TOKEN: apiToken,
      DATOCMS_PROFILE: 'default',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  void cancellation.trackChild(child);
  let stdout = '';
  let stderr = '';
  let startupFailure: Error | undefined;
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.once('error', (error) => {
    startupFailure = new Error(
      `could not start ${basename(cli.binPath)}: ${redact(
        error.message,
        apiToken,
      )}`,
    );
  });
  const completion = new Promise<CliOutcome>((resolve, reject) => {
    child.once('close', (exitCode, signal) => {
      closed = true;
      if (startupFailure) {
        reject(startupFailure);
        return;
      }
      if (cancellation.signal.aborted) {
        reject(cancellation.signal.reason);
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: redact(stdout, apiToken),
        stderr: redact(stderr, apiToken),
      });
    });
  });
  // Callers may await other work first; a rejection is observed there.
  completion.catch(() => undefined);

  return {
    child,
    output: () => redact(`${stdout}\n${stderr}`, apiToken),
    exited: () => closed,
    completion,
  };
}

export async function waitForFile(
  path: string,
  running: RunningCli,
  cancellation: ScenarioCancellation,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  await waitFor(
    () => existsSync(path),
    `file ${basename(path)}`,
    running,
    cancellation,
    timeoutMs,
  );
}

export async function waitForOutput(
  running: RunningCli,
  pattern: RegExp,
  cancellation: ScenarioCancellation,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  await waitFor(
    () => pattern.test(running.output()),
    `output ${pattern}`,
    running,
    cancellation,
    timeoutMs,
  );
}

async function waitFor(
  condition: () => boolean,
  label: string,
  running: RunningCli,
  cancellation: ScenarioCancellation,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    cancellation.throwIfAborted();
    if (condition()) return;
    if (running.exited()) {
      throw new Error(
        `the CLI exited before ${label} appeared:\n${running.output().trim()}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; CLI output so far:\n${running
          .output()
          .trim()}`,
      );
    }
    await delay(100);
  }
}

function assertCliSucceeded(outcome: CliOutcome, label: string): void {
  assert.equal(
    outcome.exitCode,
    0,
    `${label} failed. ${describeOutcome(outcome)}`,
  );
}

function outcomeText(outcome: CliOutcome): string {
  // oclif wraps long warnings and errors; compare the unwrapped text.
  return `${outcome.stdout}\n${outcome.stderr}`.replace(/\s*\n\s*›\s*/gu, ' ');
}

function describeOutcome(outcome: CliOutcome): string {
  return `exit ${
    outcome.exitCode ?? `signal ${outcome.signal}`
  }\n${outcome.stdout.trim()}\n${outcome.stderr.trim()}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function safeError(error: unknown, prefix?: string): Error {
  const label = prefix ? `${prefix}: ` : '';
  if (error instanceof CmaClient.ApiError) {
    const details = error.errors.map(({ attributes }) => ({
      code: attributes.code,
      details: attributes.details,
    }));
    return new Error(
      `${label}CMA ${error.response.status}: ${JSON.stringify(details)}`,
    );
  }
  if (error instanceof Error) return new Error(`${label}${error.message}`);
  return new Error(`${label}${String(error)}`);
}

function redact(value: string, apiToken: string): string {
  return value.split(apiToken).join('[REDACTED]');
}
