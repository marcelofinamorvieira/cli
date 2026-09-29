import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { RUNTIME_VERSION } from '../../src/content-diff/runtime-template';
import {
  type CliInvocation,
  buildClient,
  captureEnvironmentFingerprint,
  forkEnvironment as forkOwnedEnvironment,
  invokeGeneratedMigrationForReplay,
  resolveCliInvocation,
  shutdownScenarioWork,
  trackAppliedEnvironmentAfterFailure,
} from '../e2e/real-cma-harness';
import {
  type ScenarioCancellation,
  createScenarioCancellation,
} from '../e2e/scenario-cancellation';

import {
  type CrossProjectFixture as Fixture,
  assertAppliedState,
  assertUploadedFixturePng,
  captureFixtureState,
  introduceCrossProjectDrift,
  readBundledFixturePng,
  seedAlignedFixture,
} from './recursive-fixture';

export { alignedFixtureIds } from './recursive-fixture';
export { forkEnvironment as forkOwnedEnvironment } from '../e2e/real-cma-harness';

export const CROSS_PROJECT_E2E_ENV = {
  optIn: 'DATOCMS_CONTENT_DIFF_E2E_CROSS_PROJECT',
  keep: 'DATOCMS_CONTENT_DIFF_E2E_KEEP',
  sourceToken: 'DATOCMS_CONTENT_DIFF_E2E_SOURCE_API_TOKEN',
  destinationToken: 'DATOCMS_CONTENT_DIFF_E2E_DESTINATION_API_TOKEN',
  sourceProjectId: 'DATOCMS_CONTENT_DIFF_E2E_SOURCE_PROJECT_ID',
  destinationProjectId: 'DATOCMS_CONTENT_DIFF_E2E_DESTINATION_PROJECT_ID',
} as const;

const SOURCE_PROFILE = 'cross_source';
const DESTINATION_PROFILE = 'cross_destination';
const DISPOSABLE_PROJECT_NAME =
  /\b(?:e2e|test|testing|disposable|throwaway)\b/i;
const pluginRoot = resolve(__dirname, '../..');
const pluginDevBin = join(pluginRoot, 'bin', 'dev');

type HarnessConfig = Readonly<{
  sourceToken: string;
  destinationToken: string;
  expectedSourceProjectId: string;
  expectedDestinationProjectId: string;
  keep: boolean;
}>;

type CliResult = Readonly<{ stdout: string; stderr: string }>;

export function buildCrossProjectConfig(
  migrationModelApiKey: string,
  migrationsDirectory = 'migrations',
): Record<string, unknown> {
  const profile = (apiTokenEnvName: string) => ({
    apiTokenEnvName,
    logLevel: 'NONE',
    migrations: {
      directory: migrationsDirectory,
      modelApiKey: migrationModelApiKey,
    },
  });

  return {
    profiles: {
      [SOURCE_PROFILE]: profile(CROSS_PROJECT_E2E_ENV.sourceToken),
      [DESTINATION_PROFILE]: profile(CROSS_PROJECT_E2E_ENV.destinationToken),
    },
  };
}

export async function runAlignedCrossProjectE2E(): Promise<void> {
  const config = loadConfiguration();
  // DATOCMS_CONTENT_DIFF_E2E_CLI=packaged runs a prepared packaged host.
  const cli = resolveCliInvocation();
  console.log(`[content-diff cross-project e2e] CLI: ${cli.description}`);
  const sourceRecoveryRoot = buildClient(config.sourceToken);
  const destinationRecoveryRoot = buildClient(config.destinationToken);
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const sourceEnvironmentId = `cpx-${runId}-main`;
  const destinationEnvironmentId = sourceEnvironmentId;
  const appliedEnvironmentId = `cpx-${runId}-applied`;
  const wrongEnvironmentId = `cpx-${runId}-wrong`;
  const migrationModelApiKey = `cpx_migrations_r${createHash('sha256')
    .update(runId)
    .digest('hex')
    .slice(0, 12)}`;
  const workspace = await mkdtemp(join(tmpdir(), 'datocms-cpx-e2e-'));
  const sourceCreated: string[] = [];
  const destinationCreated: string[] = [];
  const cancellation = createScenarioCancellation();
  const sourceRoot = buildClient(
    config.sourceToken,
    undefined,
    cancellation.fetchFn,
  );
  const destinationRoot = buildClient(
    config.destinationToken,
    undefined,
    cancellation.fetchFn,
  );
  const pendingOwnershipRecoveries: Array<() => Promise<void>> = [];
  let primaryFailure: Error | undefined;
  let primaryBaseline:
    | {
        sourceId: string;
        destinationId: string;
        sourceFingerprint: string;
        destinationFingerprint: string;
      }
    | undefined;

  try {
    cancellation.throwIfAborted();
    const [
      sourceSite,
      destinationSite,
      sourceEnvironments,
      destinationEnvironments,
    ] = await Promise.all([
      sourceRoot.site.find(),
      destinationRoot.site.find(),
      sourceRoot.environments.list(),
      destinationRoot.environments.list(),
    ]);
    cancellation.throwIfAborted();
    const sourcePrimary = sourceEnvironments.find(({ meta }) => meta.primary);
    const destinationPrimary = destinationEnvironments.find(
      ({ meta }) => meta.primary,
    );

    assert.ok(
      sourcePrimary,
      'source project has no visible primary environment',
    );
    assert.ok(
      destinationPrimary,
      'destination project has no visible primary environment',
    );
    assert.notEqual(
      sourceSite.id,
      destinationSite.id,
      'cross-project E2E requires two different projects',
    );
    assert.notEqual(
      config.sourceToken,
      config.destinationToken,
      'cross-project E2E requires distinct project tokens',
    );
    assertDisposableProject(
      sourceSite,
      config.expectedSourceProjectId,
      'source',
    );
    assertDisposableProject(
      destinationSite,
      config.expectedDestinationProjectId,
      'destination',
    );
    assertAlignedSiteSemantics(sourceSite, destinationSite);

    const [sourcePrimaryBefore, destinationPrimaryBefore] = await Promise.all([
      captureEnvironmentFingerprint(
        buildClient(config.sourceToken, sourcePrimary.id, cancellation.fetchFn),
      ),
      captureEnvironmentFingerprint(
        buildClient(
          config.destinationToken,
          destinationPrimary.id,
          cancellation.fetchFn,
        ),
      ),
    ]);

    primaryBaseline = {
      sourceId: sourcePrimary.id,
      destinationId: destinationPrimary.id,
      sourceFingerprint: sourcePrimaryBefore,
      destinationFingerprint: destinationPrimaryBefore,
    };
    cancellation.throwIfAborted();
    await forkOwnedEnvironment(
      sourceRoot,
      sourcePrimary.id,
      sourceEnvironmentId,
      sourceCreated,
      {
        cancellation,
        recoveryClient: sourceRecoveryRoot,
        pendingOwnershipRecoveries,
      },
    );
    await forkOwnedEnvironment(
      destinationRoot,
      destinationPrimary.id,
      destinationEnvironmentId,
      destinationCreated,
      {
        cancellation,
        recoveryClient: destinationRecoveryRoot,
        pendingOwnershipRecoveries,
      },
    );
    cancellation.throwIfAborted();

    const sourceClient = buildClient(
      config.sourceToken,
      sourceEnvironmentId,
      cancellation.fetchFn,
    );
    const destinationClient = buildClient(
      config.destinationToken,
      destinationEnvironmentId,
      cancellation.fetchFn,
    );
    const fixture = await seedAlignedFixture(
      sourceClient,
      destinationClient,
      runId,
    );
    cancellation.throwIfAborted();
    const sourceOnlyUploadId = await introduceCrossProjectDrift({
      source: sourceClient,
      destination: destinationClient,
      fixture,
      workspace,
      cancellation,
    });
    await assertUploadedFixturePng(
      sourceClient,
      sourceOnlyUploadId,
      cancellation,
    );
    cancellation.throwIfAborted();

    const sourceExpected = await captureFixtureState(sourceClient, fixture);
    const destinationExpected = await captureFixtureState(
      destinationClient,
      fixture,
    );
    const [sourceBeforeGeneration, destinationBeforeGeneration] =
      await Promise.all([
        captureEnvironmentFingerprint(sourceClient),
        captureEnvironmentFingerprint(destinationClient),
      ]);

    cancellation.throwIfAborted();
    const migrationsDirectory = join(workspace, 'migrations');
    const configPath = join(workspace, 'datocms.config.json');
    await mkdir(migrationsDirectory);
    await writeFile(
      configPath,
      `${JSON.stringify(
        buildCrossProjectConfig(migrationModelApiKey),
        null,
        2,
      )}\n`,
    );

    const generation = await runCli({
      args: [
        'content:diff',
        `cross-project ${runId}`,
        `--source-profile=${SOURCE_PROFILE}`,
        `--destination-profile=${DESTINATION_PROFILE}`,
        `--autogenerate=${sourceEnvironmentId}:${destinationEnvironmentId}`,
        `--item-types=${fixture.modelApiKey}`,
        '--uploads=referenced',
        '--bundle-assets',
        '--js',
        '--json',
        `--config-file=${configPath}`,
      ],
      cwd: workspace,
      environment: generationEnvironment(config),
      secrets: [config.sourceToken, config.destinationToken],
      cli,
      cancellation,
    });
    cancellation.throwIfAborted();
    const output = parseObject(generation.stdout, 'content:diff output');
    assert.equal(output.sourceEnvironmentId, sourceEnvironmentId);
    assert.equal(output.destinationEnvironmentId, destinationEnvironmentId);

    const migrationFiles = (await readdir(migrationsDirectory)).filter((name) =>
      /^\d+.*\.js$/.test(name),
    );
    assert.equal(migrationFiles.length, 1);
    const migrationFilename = migrationFiles[0];
    const migrationFilePath = join(migrationsDirectory, migrationFilename);
    const planFilePath = join(
      migrationsDirectory,
      '.datocms-content',
      migrationFilename.replace(/\.js$/, '.plan.json'),
    );
    const runtimeFilePath = join(
      migrationsDirectory,
      '.datocms-content',
      `runtime-v${RUNTIME_VERSION}.js`,
    );
    await Promise.all([
      access(migrationFilePath),
      access(planFilePath),
      access(runtimeFilePath),
    ]);
    const generatedBytes = (
      await Promise.all([
        readFile(migrationFilePath, 'utf8'),
        readFile(planFilePath, 'utf8'),
        readFile(runtimeFilePath, 'utf8'),
      ])
    ).join('\n');
    for (const forbidden of [
      config.sourceToken,
      config.destinationToken,
      SOURCE_PROFILE,
      DESTINATION_PROFILE,
    ]) {
      assert.equal(
        generatedBytes.includes(forbidden),
        false,
        'generated artifacts leaked credentials or local profile names',
      );
    }
    const envelope = parseObject(
      await readFile(planFilePath, 'utf8'),
      'content plan envelope',
    );
    assert.equal(envelope.formatVersion, 10);
    assert.equal(envelope.runtimeVersion, RUNTIME_VERSION);
    const plan = parseObject(envelope.plan, 'content plan');
    assert.equal(parseObject(plan.source, 'plan source').siteId, sourceSite.id);
    assert.equal(
      parseObject(plan.target, 'plan target').siteId,
      destinationSite.id,
    );
    assert.equal(
      parseObject(plan.options, 'plan options').projectMode,
      'aligned_projects',
    );
    assert.deepEqual(
      parseObject(plan.invalidContent, 'invalid content').skippedRecords,
      [],
    );
    assert.deepEqual(
      parseObject(plan.invalidContent, 'invalid content').validatorRelaxations,
      [],
    );
    assert.ok(Array.isArray(plan.records));
    assert.deepEqual(
      plan.records
        .map((record) => {
          const entry = parseObject(record, 'record plan');
          return [entry.id, entry.action];
        })
        .sort(([left], [right]) =>
          String(left) < String(right)
            ? -1
            : String(left) > String(right)
              ? 1
              : 0,
        ),
      [
        [fixture.ids.baselineRecord, 'update'],
        [fixture.ids.sourceOnlyRecord, 'create'],
      ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    const bundledPngBytes = await readBundledFixturePng(
      plan,
      planFilePath,
      sourceOnlyUploadId,
    );

    cancellation.throwIfAborted();
    const [sourceAfterGeneration, destinationAfterGeneration] =
      await Promise.all([
        captureEnvironmentFingerprint(sourceClient),
        captureEnvironmentFingerprint(destinationClient),
      ]);
    assert.equal(sourceAfterGeneration, sourceBeforeGeneration);
    assert.equal(destinationAfterGeneration, destinationBeforeGeneration);

    const sourceBeforeWrongProfile =
      await captureEnvironmentFingerprint(sourceClient);
    cancellation.throwIfAborted();
    pendingOwnershipRecoveries.push(() =>
      trackAppliedEnvironmentAfterFailure({
        rootClient: sourceRecoveryRoot,
        apiToken: config.sourceToken,
        sourceEnvironmentId,
        destinationEnvironmentId: wrongEnvironmentId,
        migrationModelApiKey,
        createdEnvironmentIds: sourceCreated,
      }),
    );
    await assertCliFailure({
      args: [
        'migrations:run',
        `--profile=${SOURCE_PROFILE}`,
        `--source=${sourceEnvironmentId}`,
        `--destination=${wrongEnvironmentId}`,
        `--config-file=${configPath}`,
      ],
      cwd: workspace,
      environment: sourceExecutionEnvironment(config),
      secrets: [config.sourceToken],
      cli,
      expectedBinding: {
        migrationFilename,
        targetSiteId: destinationSite.id,
        activeSiteId: sourceSite.id,
      },
      cancellation,
    });
    cancellation.throwIfAborted();
    const unexpectedWrongProjectFork = await findEnvironment(
      sourceRoot,
      wrongEnvironmentId,
    );
    assert.equal(
      unexpectedWrongProjectFork,
      null,
      'wrong-profile execution created a fork before target binding failed',
    );
    assert.equal(
      await captureEnvironmentFingerprint(sourceClient),
      sourceBeforeWrongProfile,
      'wrong-profile execution mutated the source project',
    );

    try {
      await runCli({
        args: [
          'migrations:run',
          `--profile=${DESTINATION_PROFILE}`,
          `--source=${destinationEnvironmentId}`,
          `--destination=${appliedEnvironmentId}`,
          `--config-file=${configPath}`,
        ],
        cwd: workspace,
        environment: destinationExecutionEnvironment(config),
        secrets: [config.destinationToken],
        cli,
        cancellation,
      });
      destinationCreated.push(appliedEnvironmentId);
    } catch (error) {
      pendingOwnershipRecoveries.push(() =>
        trackAppliedEnvironmentAfterFailure({
          rootClient: destinationRecoveryRoot,
          apiToken: config.destinationToken,
          sourceEnvironmentId: destinationEnvironmentId,
          destinationEnvironmentId: appliedEnvironmentId,
          migrationModelApiKey,
          createdEnvironmentIds: destinationCreated,
        }),
      );
      throw error;
    }

    cancellation.throwIfAborted();
    const appliedClient = buildClient(
      config.destinationToken,
      appliedEnvironmentId,
      cancellation.fetchFn,
    );
    const applied = await captureFixtureState(appliedClient, fixture);
    assertAppliedState({
      applied,
      source: sourceExpected,
      destination: destinationExpected,
      fixture,
    });
    await assertUploadedFixturePng(
      appliedClient,
      sourceOnlyUploadId,
      cancellation,
      bundledPngBytes,
    );
    cancellation.throwIfAborted();
    await assertMigrationTracking(
      appliedClient,
      migrationModelApiKey,
      migrationFilename,
    );
    cancellation.throwIfAborted();
    await invokeGeneratedMigrationForReplay(
      migrationFilePath,
      appliedClient,
      appliedEnvironmentId,
    );
    cancellation.throwIfAborted();
    assertAppliedState({
      applied: await captureFixtureState(appliedClient, fixture),
      source: sourceExpected,
      destination: destinationExpected,
      fixture,
    });
    await assertUploadedFixturePng(
      appliedClient,
      sourceOnlyUploadId,
      cancellation,
      bundledPngBytes,
    );
    await assertRegenerationIsNoop({
      workspace,
      config,
      fixture,
      sourceEnvironmentId,
      appliedEnvironmentId,
      migrationModelApiKey,
      cli,
      cancellation,
    });
    cancellation.throwIfAborted();
    const [sourceAfterExecution, destinationAfterExecution] = await Promise.all(
      [
        captureEnvironmentFingerprint(sourceClient),
        captureEnvironmentFingerprint(destinationClient),
      ],
    );
    assert.equal(
      sourceAfterExecution,
      sourceBeforeGeneration,
      'execution changed the original source sandbox',
    );
    assert.equal(
      destinationAfterExecution,
      destinationBeforeGeneration,
      'execution changed the original destination sandbox',
    );
    cancellation.throwIfAborted();
  } catch (error) {
    primaryFailure = safeError(error);
  }

  const cleanupErrors = await shutdownScenarioWork({
    cancellation,
    pendingOwnershipRecoveries,
    primaryFailure,
  });
  if (config.keep) {
    console.log(
      `[content-diff cross-project e2e] KEEP source site ${
        config.expectedSourceProjectId
      }: ${sourceCreated.join(', ') || 'none'}`,
    );
    console.log(
      `[content-diff cross-project e2e] KEEP destination site ${
        config.expectedDestinationProjectId
      }: ${destinationCreated.join(', ') || 'none'}`,
    );
  } else {
    cleanupErrors.push(
      ...(await cleanupOwnedEnvironments(
        destinationRecoveryRoot,
        destinationCreated,
      )),
      ...(await cleanupOwnedEnvironments(sourceRecoveryRoot, sourceCreated)),
    );
  }
  await rm(workspace, { recursive: true, force: true }).catch((error) => {
    cleanupErrors.push(safeError(error));
  });

  if (primaryBaseline) {
    try {
      const [sourcePrimaryAfter, destinationPrimaryAfter] = await Promise.all([
        captureEnvironmentFingerprint(
          buildClient(config.sourceToken, primaryBaseline.sourceId),
        ),
        captureEnvironmentFingerprint(
          buildClient(config.destinationToken, primaryBaseline.destinationId),
        ),
      ]);
      assert.equal(sourcePrimaryAfter, primaryBaseline.sourceFingerprint);
      assert.equal(
        destinationPrimaryAfter,
        primaryBaseline.destinationFingerprint,
      );
    } catch (error) {
      cleanupErrors.push(safeError(error));
    }
  }
  if (primaryFailure && cleanupErrors.length) {
    console.error(
      `[content-diff cross-project e2e] ${cleanupErrors
        .map(({ message }) => message)
        .join('; ')}`,
    );
  }

  if (primaryFailure) throw primaryFailure;
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.map(({ message }) => message).join('; '));
  }
}

async function assertMigrationTracking(
  client: CmaClient.Client,
  apiKey: string,
  filename: string,
): Promise<void> {
  const model = (await client.itemTypes.list()).find(
    ({ api_key }) => api_key === apiKey,
  );
  assert.ok(model, 'destination migration tracking model is missing');
  const records = await client.items.rawList({
    filter: { type: model.id },
    page: { limit: 500 },
  });
  assert.deepEqual(
    records.data.map(({ attributes }) => attributes.name),
    [filename],
  );
}

async function assertRegenerationIsNoop(input: {
  workspace: string;
  config: HarnessConfig;
  fixture: Fixture;
  sourceEnvironmentId: string;
  appliedEnvironmentId: string;
  migrationModelApiKey: string;
  cli: CliInvocation;
  cancellation: ScenarioCancellation;
}): Promise<void> {
  input.cancellation.throwIfAborted();
  const directory = join(input.workspace, 'regenerated');
  const configPath = join(input.workspace, 'regenerated.config.json');
  await mkdir(directory);
  await writeFile(
    configPath,
    `${JSON.stringify(
      buildCrossProjectConfig(input.migrationModelApiKey, 'regenerated'),
      null,
      2,
    )}\n`,
  );
  const result = await runCli({
    args: [
      'content:diff',
      'cross-project regenerated no-op',
      `--source-profile=${SOURCE_PROFILE}`,
      `--destination-profile=${DESTINATION_PROFILE}`,
      `--autogenerate=${input.sourceEnvironmentId}:${input.appliedEnvironmentId}`,
      `--item-types=${input.fixture.modelApiKey}`,
      '--uploads=referenced',
      '--bundle-assets',
      '--js',
      '--json',
      `--config-file=${configPath}`,
    ],
    cwd: input.workspace,
    environment: generationEnvironment(input.config),
    secrets: [input.config.sourceToken, input.config.destinationToken],
    cli: input.cli,
    cancellation: input.cancellation,
  });
  input.cancellation.throwIfAborted();
  const summary = parseObject(
    parseObject(result.stdout, 'regenerated output').summary,
    'regenerated summary',
  );
  for (const [name, count] of Object.entries(
    parseObject(summary.counts, 'regenerated counts'),
  )) {
    assert.equal(count, 0, `regenerated plan reports non-zero ${name}`);
  }
  assert.equal(summary.destructiveActionCount, 0);
}

function loadConfiguration(): HarnessConfig {
  assert.equal(
    process.env[CROSS_PROJECT_E2E_ENV.optIn],
    '1',
    `${CROSS_PROJECT_E2E_ENV.optIn}=1 is required`,
  );
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    sourceToken: required(CROSS_PROJECT_E2E_ENV.sourceToken),
    destinationToken: required(CROSS_PROJECT_E2E_ENV.destinationToken),
    expectedSourceProjectId: required(CROSS_PROJECT_E2E_ENV.sourceProjectId),
    expectedDestinationProjectId: required(
      CROSS_PROJECT_E2E_ENV.destinationProjectId,
    ),
    keep: process.env[CROSS_PROJECT_E2E_ENV.keep] === '1',
  };
}

export function assertDisposableProject(
  site: { id: string; name: string },
  expectedId: string,
  role: string,
): void {
  assert.equal(site.id, expectedId, `${role} project marker does not match`);
  assert.match(
    site.name,
    DISPOSABLE_PROJECT_NAME,
    `${role} project name must contain e2e, test, testing, disposable, or throwaway`,
  );
}

function assertAlignedSiteSemantics(
  source: CmaClient.ApiTypes.Site,
  destination: CmaClient.ApiTypes.Site,
): void {
  const select = (site: CmaClient.ApiTypes.Site) => ({
    locales: site.locales,
    timezone: site.timezone,
    improvedTimezoneManagement: site.meta.improved_timezone_management,
    improvedBooleanFields: site.meta.improved_boolean_fields,
    improvedValidationAtPublishing: site.meta.improved_validation_at_publishing,
    millisecondsInDatetime: site.meta.milliseconds_in_datetime,
    nonLocalizedFocalPoints: site.meta.non_localized_focal_points,
    improvedHexManagement: site.meta.improved_hex_management,
  });
  assert.deepEqual(
    select(source),
    select(destination),
    'cross-project E2E projects have incompatible content semantics',
  );
}

async function findEnvironment(
  client: CmaClient.Client,
  id: string,
): Promise<CmaClient.ApiTypes.Environment | null> {
  try {
    return await client.environments.find(id);
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return null;
    }
    throw error;
  }
}

async function cleanupOwnedEnvironments(
  client: CmaClient.Client,
  ids: readonly string[],
): Promise<Error[]> {
  const errors: Error[] = [];
  for (const id of [...ids].reverse()) {
    try {
      await client.environments.destroy(id);
    } catch (error) {
      if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
        continue;
      }
      errors.push(safeError(error));
    }
  }
  return errors;
}

function generationEnvironment(config: HarnessConfig): NodeJS.ProcessEnv {
  return childEnvironment({
    [CROSS_PROJECT_E2E_ENV.sourceToken]: config.sourceToken,
    [CROSS_PROJECT_E2E_ENV.destinationToken]: config.destinationToken,
  });
}

function sourceExecutionEnvironment(config: HarnessConfig): NodeJS.ProcessEnv {
  return childEnvironment({
    [CROSS_PROJECT_E2E_ENV.sourceToken]: config.sourceToken,
  });
}

export function destinationExecutionEnvironment(
  config: HarnessConfig,
): NodeJS.ProcessEnv {
  return childEnvironment({
    [CROSS_PROJECT_E2E_ENV.destinationToken]: config.destinationToken,
  });
}

function childEnvironment(values: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    'DATOCMS_API_TOKEN',
    'DATOCMS_PROFILE',
    CROSS_PROJECT_E2E_ENV.sourceToken,
    CROSS_PROJECT_E2E_ENV.destinationToken,
  ]) {
    delete environment[key];
  }
  return { ...environment, ...values };
}

export async function runCli(input: {
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  secrets: readonly string[];
  cancellation: ScenarioCancellation;
  binPath?: string;
  /** Packaged-host binary and isolation variables; bin/dev when omitted. */
  cli?: CliInvocation;
}): Promise<CliResult> {
  input.cancellation.throwIfAborted();
  const binPath = input.binPath ?? input.cli?.binPath ?? pluginDevBin;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath, ...input.args], {
      cwd: input.cwd,
      env: { ...input.environment, ...input.cli?.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    void input.cancellation.trackChild(child);
    let stdout = '';
    let stderr = '';
    let startupFailure: Error | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      startupFailure = new Error(redact(error.message, input.secrets));
    });
    child.once('close', (code, signal) => {
      if (startupFailure) return rejectPromise(startupFailure);
      if (input.cancellation.signal.aborted)
        return rejectPromise(input.cancellation.signal.reason);
      if (code === 0) return resolvePromise({ stdout, stderr });
      rejectPromise(
        new Error(
          redact(
            [
              `${basename(binPath)} exited with ${code ?? signal}`,
              stdout.trim(),
              stderr.trim(),
            ]
              .filter(Boolean)
              .join('\n'),
            input.secrets,
          ),
        ),
      );
    });
  });
}

async function assertCliFailure(
  input: Parameters<typeof runCli>[0] & {
    expectedBinding: Parameters<typeof assertWrongProjectBindingFailure>[1];
  },
): Promise<void> {
  try {
    await runCli(input);
    assert.fail('CLI command unexpectedly succeeded');
  } catch (error) {
    input.cancellation.throwIfAborted();
    assertWrongProjectBindingFailure(
      safeError(error).message,
      input.expectedBinding,
    );
  }
}

export function assertWrongProjectBindingFailure(
  message: string,
  expected: Readonly<{
    migrationFilename: string;
    targetSiteId: string;
    activeSiteId: string;
  }>,
): void {
  const refusal =
    `Content-diff migration "${expected.migrationFilename}" targets DatoCMS project "${expected.targetSiteId}", ` +
    `but the active profile targets "${expected.activeSiteId}". No migration was executed.`;
  assert.ok(
    message.replace(/\s+/g, ' ').includes(refusal),
    'CLI failure did not identify the expected migration and project binding refusal before execution',
  );
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function safeError(error: unknown): Error {
  if (error instanceof CmaClient.ApiError) {
    return new Error(
      `CMA ${error.response.status}: ${JSON.stringify(
        error.errors.map(({ attributes }) => ({
          code: attributes.code,
          details: attributes.details,
        })),
      )}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => result.split(secret).join('[REDACTED]'),
    value,
  );
}
