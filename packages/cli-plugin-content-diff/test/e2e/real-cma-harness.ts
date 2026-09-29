import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import {
  type ScenarioCancellation,
  createScenarioCancellation,
} from './scenario-cancellation';

const E2E_OPT_IN_ENV = 'DATOCMS_CONTENT_DIFF_E2E';
const E2E_KEEP_ENV = 'DATOCMS_CONTENT_DIFF_E2E_KEEP';
const E2E_DISPOSABLE_PROJECT_ENV =
  'DATOCMS_CONTENT_DIFF_E2E_DISPOSABLE_PROJECT';
const API_TOKEN_ENV = 'DATOCMS_API_TOKEN';
const E2E_CLI_ENV = 'DATOCMS_CONTENT_DIFF_E2E_CLI';
const E2E_PACKAGED_HOST_ENV = 'DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST';
const DISPOSABLE_PROJECT_NAME = /\b(?:e2e|test|testing|disposable)\b/i;
/** Written by scripts/prepare-packaged-host.mjs into every packaged host. */
export const PACKAGED_HOST_MANIFEST_FILENAME =
  'content-diff-packaged-host.json';
const PACKAGED_HOST_KIND = 'datocms-content-diff-packaged-host';
/** Primary fingerprints read every record and upload; allow a large primary. */
const PRIMARY_GUARD_TIMEOUT_MS = 600_000;

const GENERATED_REPLAY_MUTATION_METHODS = new Set([
  'activate',
  'bulkMoveToStage',
  'create',
  'createFromLocalFile',
  'destroy',
  'fork',
  'promote',
  'publish',
  'unpublish',
  'update',
  'updateFromLocalFile',
]);

type GoldenFixtureDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    body: { type: 'text'; localized: false };
    related: { type: 'link'; localized: false };
  };
};

type MigrationRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    name: { type: 'string'; localized: false };
  };
};

export type RealCmaScenarioSeed = Readonly<{
  itemTypeApiKeys: readonly string[];
}>;

export type SeedSourceContext = Readonly<{
  client: CmaClient.Client;
  runId: string;
}>;

export type IntroduceDriftContext<Seed extends RealCmaScenarioSeed> = Readonly<{
  seed: Seed;
  sourceClient: CmaClient.Client;
  destinationClient: CmaClient.Client;
}>;

export type VerifyScenarioContext<
  Seed extends RealCmaScenarioSeed,
  Expected,
> = Readonly<{
  seed: Seed;
  expected: Expected;
  sourceClient: CmaClient.Client;
  destinationClient: CmaClient.Client;
  appliedClient: CmaClient.Client;
  migrationFilename: string;
  migrationFilePath: string;
  planFilePath: string;
  migrationModelApiKey: string;
}>;

export type VerifyGeneratedPlanContext<
  Seed extends RealCmaScenarioSeed,
  Expected,
> = Readonly<{
  seed: Seed;
  expected: Expected;
  sourceClient: CmaClient.Client;
  destinationClient: CmaClient.Client;
  migrationFilename: string;
  migrationFilePath: string;
  planFilePath: string;
}>;

/**
 * A scenario owns only fixture seeding, drift, and its independent oracle.
 * Environment lifecycle and the real CLI invocations stay in the harness.
 */
export type RealCmaScenario<
  Seed extends RealCmaScenarioSeed,
  Expected,
> = Readonly<{
  name: string;
  migrationFormat?: 'js' | 'ts';
  contentDiffArgs?: readonly string[];
  expectedGenerationFailure?: Readonly<{ messagePattern: RegExp }>;
  seedSource(context: SeedSourceContext): Promise<Seed>;
  introduceDrift(context: IntroduceDriftContext<Seed>): Promise<Expected>;
  verifyGeneratedPlan?(
    context: VerifyGeneratedPlanContext<Seed, Expected>,
  ): Promise<void>;
  verify?(context: VerifyScenarioContext<Seed, Expected>): Promise<void>;
}>;

type HarnessConfiguration = Readonly<{
  apiToken: string;
  keepEnvironments: boolean;
  cli: CliInvocation;
}>;

/**
 * How the live suites start the CLI. `source` runs this checkout's TypeScript
 * through bin/dev. `packaged` runs the `datocms` binary of a host prepared by
 * scripts/prepare-packaged-host.mjs, which installed this plugin from its
 * tarball; `environment` points that binary at the host's isolated oclif
 * data/config/cache directories.
 */
export type CliInvocation = Readonly<{
  mode: 'source' | 'packaged';
  binPath: string;
  environment: Readonly<Record<string, string>>;
  description: string;
}>;

type EnvironmentIds = Readonly<{
  source: string;
  destination: string;
  applied: string;
}>;

type CliResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

class ExpectedGenerationFailureObserved extends Error {}

type GoldenSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    modelApiKey: string;
    baselineRecordId: string;
  }>;

type RawGoldenRecord = Readonly<{
  id: string;
  itemTypeId: string;
  title: string | null;
  body: string | null;
  related: string | null;
}>;

type RawGoldenState = Readonly<{
  current: Readonly<Record<string, RawGoldenRecord>>;
  published: Readonly<Record<string, RawGoldenRecord>>;
  currentIds: readonly string[];
  publishedIds: readonly string[];
}>;

type GoldenExpected = Readonly<{
  sourceOnlyRecordId: string;
  destinationOnlyRecordId: string;
  source: RawGoldenState;
  destination: RawGoldenState;
}>;

const pluginPackageRoot = resolve(__dirname, '../..');
const pluginDevBin = join(pluginPackageRoot, 'bin', 'dev');
const pluginMigrationRunnerPath = join(
  pluginPackageRoot,
  'src',
  'commands',
  'migrations',
  'run.ts',
);
const requireFromPluginPackage = createRequire(
  join(pluginPackageRoot, 'package.json'),
);
const { require: requireWithRunnerTsx } = requireFromPluginPackage(
  'tsx/cjs/api',
) as Readonly<{
  require(modulePath: string, parentFilename: string): unknown;
}>;

export const SOURCE_CLI: CliInvocation = {
  mode: 'source',
  binPath: pluginDevBin,
  environment: {},
  description: 'checkout sources through bin/dev',
};

export const goldenPathScenario: RealCmaScenario<GoldenSeed, GoldenExpected> = {
  name: 'published update, source-only create, and retained destination extra',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating fixture schema in source sandbox');

    const modelApiKey = `cde2e_${runId.replace(/-/g, '')}`;
    const model = await client.itemTypes.create({
      name: `Content diff E2E ${runId}`,
      api_key: modelApiKey,
      singleton: false,
      all_locales_required: false,
      sortable: false,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: false,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });

    await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(model.id, {
      label: 'Body',
      api_key: 'body',
      field_type: 'text',
      localized: false,
      validators: {},
    });
    await client.fields.create(model.id, {
      label: 'Related',
      api_key: 'related',
      field_type: 'link',
      localized: false,
      validators: {
        item_item_type: { item_types: [model.id] },
      },
    });

    const baseline = await client.items.create<GoldenFixtureDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      title: 'alpha baseline',
      body: 'alpha published baseline',
      related: null,
    });
    await client.items.publish<GoldenFixtureDefinition>(baseline.id);

    return {
      itemTypeApiKeys: [modelApiKey],
      modelId: model.id,
      modelApiKey,
      baselineRecordId: baseline.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log('[content-diff e2e] Introducing source and destination drift');

    await sourceClient.items.update<GoldenFixtureDefinition>(
      seed.baselineRecordId,
      {
        title: 'alpha source current',
        body: 'source draft over the published baseline',
        related: null,
      },
    );

    const sourceOnly = await sourceClient.items.create<GoldenFixtureDefinition>(
      {
        item_type: { id: seed.modelId, type: 'item_type' },
        title: 'charlie source only',
        body: 'published source-only record',
        related: seed.baselineRecordId,
      },
    );
    await sourceClient.items.publish<GoldenFixtureDefinition>(sourceOnly.id);

    await destinationClient.items.update<GoldenFixtureDefinition>(
      seed.baselineRecordId,
      {
        title: 'alpha destination drift',
        body: 'destination publication must be reconciled',
        related: null,
      },
    );
    await destinationClient.items.publish<GoldenFixtureDefinition>(
      seed.baselineRecordId,
    );

    const destinationOnly =
      await destinationClient.items.create<GoldenFixtureDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        title: 'delta destination only',
        body: 'must survive because deletions are disabled',
        related: seed.baselineRecordId,
      });

    return {
      sourceOnlyRecordId: sourceOnly.id,
      destinationOnlyRecordId: destinationOnly.id,
      source: await captureGoldenRawState(sourceClient, seed.modelId),
      destination: await captureGoldenRawState(destinationClient, seed.modelId),
    };
  },

  async verify({
    seed,
    expected,
    appliedClient,
    migrationFilename,
    migrationModelApiKey,
  }) {
    console.log('[content-diff e2e] Verifying applied state through raw CMA');

    const applied = await captureGoldenRawState(appliedClient, seed.modelId);
    const managedIds = [
      seed.baselineRecordId,
      expected.sourceOnlyRecordId,
    ].sort();

    for (const id of managedIds) {
      assert.deepEqual(
        applied.current[id],
        expected.source.current[id],
        `current source state was not reproduced for ${id}`,
      );
      assert.deepEqual(
        applied.published[id],
        expected.source.published[id],
        `published source state was not reproduced for ${id}`,
      );
    }

    assert.deepEqual(
      applied.current[expected.destinationOnlyRecordId],
      expected.destination.current[expected.destinationOnlyRecordId],
      'destination-only current record was not preserved',
    );
    assert.equal(
      applied.published[expected.destinationOnlyRecordId],
      undefined,
      'destination-only draft unexpectedly became published',
    );
    assert.deepEqual(
      applied.currentIds,
      [...managedIds, expected.destinationOnlyRecordId].sort(),
      'applied current record IDs differ from the managed source plus retained destination records',
    );
    assert.deepEqual(
      applied.publishedIds,
      expected.source.publishedIds,
      'applied published record IDs differ from the source publication set',
    );

    const migrationModels = await appliedClient.itemTypes.list();
    const migrationModel = migrationModels.find(
      ({ api_key }) => api_key === migrationModelApiKey,
    );
    assert.ok(
      migrationModel,
      'migrations:run did not create its tracking model',
    );

    const migrationRecords =
      await appliedClient.items.rawList<MigrationRecordDefinition>({
        filter: { type: migrationModel.id },
        page: { limit: 500 },
      });
    assert.deepEqual(
      migrationRecords.data.map(({ attributes }) => attributes.name).sort(),
      [migrationFilename],
      'migrations:run did not track exactly the generated migration',
    );
  },
};

export async function runRealCmaE2E(): Promise<void> {
  return runRealCmaScenario(goldenPathScenario);
}

export async function runRealCmaScenario<
  Seed extends RealCmaScenarioSeed,
  Expected,
>(scenario: RealCmaScenario<Seed, Expected>): Promise<void> {
  const configuration = loadHarnessConfiguration();
  const primaryGuard = requireActivePrimaryEnvironmentGuard();
  const recoveryClient = buildClient(configuration.apiToken);
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const environmentIds: EnvironmentIds = {
    source: `cde2e-${runId}-source`,
    destination: `cde2e-${runId}-destination`,
    applied: `cde2e-${runId}-applied`,
  };
  const migrationModelApiKey = `cde2e_migrations_${runId.replace(/-/g, '')}`;
  const createdEnvironmentIds: string[] = [];
  const workspace = await mkdtemp(join(tmpdir(), 'datocms-content-diff-e2e-'));
  const workspaces = [workspace];
  const cancellation = createScenarioCancellation();
  const rootClient = buildClient(
    configuration.apiToken,
    undefined,
    cancellation.fetchFn,
  );
  const pendingOwnershipRecoveries: Array<() => Promise<void>> = [];
  let primaryFailure: Error | undefined;

  try {
    cancellation.throwIfAborted();
    const site = await rootClient.site.find();
    cancellation.throwIfAborted();
    const environments = await rootClient.environments.list();
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

    await assertDisposableProjectSafety({
      primaryClient: buildClient(
        configuration.apiToken,
        primary.id,
        cancellation.fetchFn,
      ),
      projectId: site.id,
      projectName: site.name,
    });

    console.log(
      `[content-diff e2e] Scenario ${JSON.stringify(
        scenario.name,
      )} on project ${JSON.stringify(site.name)} (${site.id}) using ${
        configuration.cli.description
      }`,
    );

    await forkEnvironment(
      rootClient,
      primary.id,
      environmentIds.source,
      createdEnvironmentIds,
      { cancellation, recoveryClient, pendingOwnershipRecoveries },
    );
    cancellation.throwIfAborted();
    const sourceClient = buildClient(
      configuration.apiToken,
      environmentIds.source,
      cancellation.fetchFn,
    );
    const seed = await scenario.seedSource({ client: sourceClient, runId });
    cancellation.throwIfAborted();

    await forkEnvironment(
      rootClient,
      environmentIds.source,
      environmentIds.destination,
      createdEnvironmentIds,
      { cancellation, recoveryClient, pendingOwnershipRecoveries },
    );
    cancellation.throwIfAborted();
    const destinationClient = buildClient(
      configuration.apiToken,
      environmentIds.destination,
      cancellation.fetchFn,
    );
    const expected = await scenario.introduceDrift({
      seed,
      sourceClient,
      destinationClient,
    });
    cancellation.throwIfAborted();

    const migrationsDirectory = join(workspace, 'migrations');
    const configPath = join(workspace, 'datocms.config.json');
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

    cancellation.throwIfAborted();
    const generationFingerprintStartedAt = Date.now();
    console.log(
      '[content-diff e2e] Capturing generation baseline fingerprints',
    );
    const [sourceBeforeGeneration, destinationBeforeGeneration] =
      await Promise.all([
        captureEnvironmentFingerprint(sourceClient),
        captureEnvironmentFingerprint(destinationClient),
      ]);
    console.log(
      `[content-diff e2e] Captured generation baseline fingerprints in ${
        Date.now() - generationFingerprintStartedAt
      }ms`,
    );
    cancellation.throwIfAborted();
    console.log('[content-diff e2e] Running the actual content:diff command');
    try {
      await runCli({
        binPath: configuration.cli.binPath,
        extraEnvironment: configuration.cli.environment,
        args: buildContentDiffArgs({
          scenario,
          name: `real CMA ${runId}`,
          sourceEnvironmentId: environmentIds.source,
          destinationEnvironmentId: environmentIds.destination,
          itemTypeApiKeys: seed.itemTypeApiKeys,
          configPath,
        }),
        cwd: workspace,
        apiToken: configuration.apiToken,
        cancellation,
      });
    } catch (error) {
      cancellation.throwIfAborted();
      const expectedFailure = scenario.expectedGenerationFailure;
      if (!expectedFailure) throw error;

      assert.match(safeError(error).message, expectedFailure.messagePattern);
      const [sourceAfterFailure, destinationAfterFailure] = await Promise.all([
        captureEnvironmentFingerprint(sourceClient),
        captureEnvironmentFingerprint(destinationClient),
      ]);
      assert.equal(
        sourceAfterFailure,
        sourceBeforeGeneration,
        'failed content:diff generation mutated the source environment',
      );
      assert.equal(
        destinationAfterFailure,
        destinationBeforeGeneration,
        'failed content:diff generation mutated the destination environment',
      );
      assert.deepEqual(
        await readdir(migrationsDirectory),
        [],
        'failed content:diff generation left migration artifacts behind',
      );
      cancellation.throwIfAborted();
      console.log('[content-diff e2e] Expected generation failure observed');
      throw new ExpectedGenerationFailureObserved();
    }
    cancellation.throwIfAborted();
    if (scenario.expectedGenerationFailure) {
      throw new Error(
        'content:diff succeeded but generation was expected to fail',
      );
    }
    const [sourceAfterGeneration, destinationAfterGeneration] =
      await Promise.all([
        captureEnvironmentFingerprint(sourceClient),
        captureEnvironmentFingerprint(destinationClient),
      ]);
    assert.equal(
      sourceAfterGeneration,
      sourceBeforeGeneration,
      'content:diff generation mutated the source environment',
    );
    assert.equal(
      destinationAfterGeneration,
      destinationBeforeGeneration,
      'content:diff generation mutated the destination environment',
    );

    cancellation.throwIfAborted();
    const migrationFormat = scenario.migrationFormat ?? 'js';
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((filename) =>
        new RegExp(`^\\d+.*\\.${migrationFormat}$`).test(filename),
      )
      .sort();
    assert.equal(
      migrationFiles.length,
      1,
      `content:diff did not generate exactly one ${migrationFormat.toUpperCase()} migration`,
    );
    const migrationFilename = migrationFiles[0];
    const migrationFilePath = join(migrationsDirectory, migrationFilename);
    const planFilePath = join(
      migrationsDirectory,
      '.datocms-content',
      migrationFilename.replace(/\.(?:js|ts)$/, '.plan.json'),
    );
    await Promise.all([access(migrationFilePath), access(planFilePath)]);
    cancellation.throwIfAborted();
    if (scenario.verifyGeneratedPlan) {
      await scenario.verifyGeneratedPlan({
        seed,
        expected,
        sourceClient,
        destinationClient,
        migrationFilename,
        migrationFilePath,
        planFilePath,
      });
    }

    cancellation.throwIfAborted();
    await assertEnvironmentIdIsUnoccupied(rootClient, environmentIds.applied);
    console.log("[content-diff e2e] Running the plugin's migrations:run");
    try {
      await runCli({
        binPath: configuration.cli.binPath,
        extraEnvironment: configuration.cli.environment,
        args: [
          'migrations:run',
          `--source=${environmentIds.destination}`,
          `--destination=${environmentIds.applied}`,
          `--config-file=${configPath}`,
        ],
        cwd: workspace,
        apiToken: configuration.apiToken,
        cancellation,
      });
      createdEnvironmentIds.push(environmentIds.applied);
    } catch (error) {
      pendingOwnershipRecoveries.push(() =>
        trackAppliedEnvironmentAfterFailure({
          rootClient: recoveryClient,
          apiToken: configuration.apiToken,
          sourceEnvironmentId: environmentIds.destination,
          destinationEnvironmentId: environmentIds.applied,
          migrationModelApiKey,
          createdEnvironmentIds,
        }),
      );
      throw error;
    }

    cancellation.throwIfAborted();
    const appliedClient = buildClient(
      configuration.apiToken,
      environmentIds.applied,
      cancellation.fetchFn,
    );
    assert.ok(scenario.verify, 'successful scenario must define verify()');
    await scenario.verify({
      seed,
      expected,
      sourceClient,
      destinationClient,
      appliedClient,
      migrationFilename,
      migrationFilePath,
      planFilePath,
      migrationModelApiKey,
    });

    cancellation.throwIfAborted();
    await assertGeneratedMigrationIsIdempotent({
      appliedClient,
      appliedEnvironmentId: environmentIds.applied,
      migrationFilePath,
      cancellation,
    });
    cancellation.throwIfAborted();
    await assertRegeneratedDiffIsNoop({
      scenario,
      seed,
      sourceEnvironmentId: environmentIds.source,
      appliedEnvironmentId: environmentIds.applied,
      migrationModelApiKey,
      apiToken: configuration.apiToken,
      cli: configuration.cli,
      cancellation,
      workspaces,
    });

    cancellation.throwIfAborted();
    console.log('[content-diff e2e] Scenario passed');
  } catch (error) {
    if (!(error instanceof ExpectedGenerationFailureObserved)) {
      primaryFailure = safeError(error);
    }
  }

  const cleanupErrors = await shutdownScenarioWork({
    cancellation,
    pendingOwnershipRecoveries,
    primaryFailure,
  });
  for (const workspace of workspaces) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(
        safeError(error, `could not remove local E2E workspace ${workspace}`),
      );
    }
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
      ...(await cleanupEnvironments(recoveryClient, createdEnvironmentIds)),
    );
  }

  // Attribute a primary change to this scenario by comparing with the previous
  // check; the suite-end comparison with the baseline still follows. Owned
  // sandboxes are excluded from the inventory.
  let primaryEnvironmentFailure: Error | undefined;
  try {
    await verifyPrimaryEnvironmentAfterScenario(
      scenario.name,
      createdEnvironmentIds,
    );
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
    // Never demoted to a log line: the scenario and cleanup failures ride
    // along in the same error.
    throw withAdditionalFailures(primaryEnvironmentFailure, [
      primaryFailure,
      cleanupFailure,
    ]);
  }

  if (cleanupFailure && primaryFailure) {
    console.error(`[content-diff e2e] ${cleanupFailure.message}`);
  }

  if (primaryFailure) {
    throw primaryFailure;
  }

  if (cleanupFailure) {
    throw cleanupFailure;
  }
}

/** Recovery reads and resource cleanup must follow actual local work teardown. */
export async function shutdownScenarioWork({
  cancellation,
  pendingOwnershipRecoveries,
  primaryFailure,
}: Readonly<{
  cancellation: ScenarioCancellation;
  pendingOwnershipRecoveries: readonly (() => Promise<void>)[];
  primaryFailure?: Error;
}>): Promise<Error[]> {
  await cancellation.shutdown(primaryFailure);
  const errors: Error[] = [];
  for (const recover of pendingOwnershipRecoveries) {
    try {
      await recover();
    } catch (error) {
      errors.push(
        safeError(error, 'could not recover E2E environment ownership'),
      );
    }
  }
  return errors;
}

function buildContentDiffArgs<Seed extends RealCmaScenarioSeed, Expected>({
  scenario,
  name,
  sourceEnvironmentId,
  destinationEnvironmentId,
  itemTypeApiKeys,
  configPath,
  json = false,
}: Readonly<{
  scenario: RealCmaScenario<Seed, Expected>;
  name: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  itemTypeApiKeys: readonly string[];
  configPath: string;
  json?: boolean;
}>): string[] {
  const scenarioArgs = scenario.contentDiffArgs ?? [];
  const migrationFormat = scenario.migrationFormat ?? 'js';
  const hasUploadScope = scenarioArgs.some((argument) =>
    argument.startsWith('--uploads='),
  );

  return [
    'content:diff',
    name,
    `--autogenerate=${sourceEnvironmentId}:${destinationEnvironmentId}`,
    `--item-types=${itemTypeApiKeys.join(',')}`,
    ...(hasUploadScope ? [] : ['--uploads=referenced']),
    `--${migrationFormat}`,
    `--config-file=${configPath}`,
    ...scenarioArgs,
    ...(json ? ['--json'] : []),
  ];
}

async function assertGeneratedMigrationIsIdempotent({
  appliedClient,
  appliedEnvironmentId,
  migrationFilePath,
  cancellation,
}: Readonly<{
  appliedClient: CmaClient.Client;
  appliedEnvironmentId: string;
  migrationFilePath: string;
  cancellation: ScenarioCancellation;
}>): Promise<void> {
  cancellation.throwIfAborted();
  console.log(
    '[content-diff e2e] Invoking the generated wrapper directly to prove replay is mutation-free',
  );
  const before = await captureEnvironmentFingerprint(appliedClient);
  cancellation.throwIfAborted();
  await invokeGeneratedMigrationForReplay(
    migrationFilePath,
    appliedClient,
    appliedEnvironmentId,
  );
  cancellation.throwIfAborted();
  const after = await captureEnvironmentFingerprint(appliedClient);
  cancellation.throwIfAborted();
  assert.equal(
    after,
    before,
    'direct replay of the generated migration changed raw CMA state',
  );
}

type GeneratedMigration = (
  client: CmaClient.Client,
  executionContext?: Readonly<{
    environmentId: string;
    inPlace: boolean;
    allowPrimary: boolean;
    contentDiffProtocolVersion: 1;
  }>,
) => Promise<void> | void;

/**
 * Load replay artifacts through the same transpile-only loader used by
 * migrations:run. In particular, type-only imports are erased instead of
 * being resolved from the harness's temporary artifact directory.
 */
export function loadGeneratedMigrationForReplay(
  migrationFilePath: string,
): GeneratedMigration {
  const requiredModule = requireWithRunnerTsx(
    migrationFilePath,
    pluginMigrationRunnerPath,
  );
  const defaultExport =
    requiredModule !== null &&
    typeof requiredModule === 'object' &&
    'default' in requiredModule
      ? requiredModule.default
      : undefined;
  const loadedModule =
    typeof requiredModule === 'function'
      ? requiredModule
      : typeof defaultExport === 'function'
        ? defaultExport
        : undefined;
  if (typeof loadedModule !== 'function') {
    throw new Error('generated migration does not export a function');
  }

  return loadedModule as GeneratedMigration;
}

export async function invokeGeneratedMigrationForReplay(
  migrationFilePath: string,
  client: CmaClient.Client,
  environmentId: string,
): Promise<void> {
  const migration = loadGeneratedMigrationForReplay(migrationFilePath);
  const guardedClient = guardCmaClientAgainstMutations(client);
  await Reflect.apply(migration, undefined, [
    guardedClient,
    {
      environmentId,
      inPlace: false,
      allowPrimary: false,
      contentDiffProtocolVersion: 1,
    },
  ]);
}

/**
 * Keeps the replay check honest: unchanged final bytes are insufficient if a
 * migration still issued idempotent writes and triggered audit/webhook side
 * effects. Every runtime mutator is rejected while real CMA reads continue.
 */
export function guardCmaClientAgainstMutationsForTest<T extends object>(
  client: T,
): T {
  return guardObjectAgainstMutations(client, '', new WeakMap()) as T;
}

function guardCmaClientAgainstMutations(
  client: CmaClient.Client,
): CmaClient.Client {
  return guardCmaClientAgainstMutationsForTest(client);
}

function guardObjectAgainstMutations(
  target: object,
  path: string,
  proxies: WeakMap<object, object>,
): object {
  const existing = proxies.get(target);
  if (existing) return existing;

  const proxy = new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current) as unknown;
      const key = typeof property === 'string' ? property : String(property);
      const childPath = path ? `${path}.${key}` : key;

      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          if (
            GENERATED_REPLAY_MUTATION_METHODS.has(key) ||
            key.startsWith('activate') ||
            key.startsWith('bulk')
          ) {
            throw new Error(
              `generated migration replay attempted CMA mutation ${childPath}`,
            );
          }
          return Reflect.apply(value, current, args);
        };
      }

      if (value !== null && typeof value === 'object') {
        return guardObjectAgainstMutations(value, childPath, proxies);
      }

      return value;
    },
  });
  proxies.set(target, proxy);
  return proxy;
}

async function assertRegeneratedDiffIsNoop<
  Seed extends RealCmaScenarioSeed,
  Expected,
>({
  scenario,
  seed,
  sourceEnvironmentId,
  appliedEnvironmentId,
  migrationModelApiKey,
  apiToken,
  cli,
  cancellation,
  workspaces,
}: Readonly<{
  scenario: RealCmaScenario<Seed, Expected>;
  seed: Seed;
  sourceEnvironmentId: string;
  appliedEnvironmentId: string;
  migrationModelApiKey: string;
  apiToken: string;
  cli: CliInvocation;
  cancellation: ScenarioCancellation;
  workspaces: string[];
}>): Promise<void> {
  cancellation.throwIfAborted();
  console.log(
    '[content-diff e2e] Regenerating source -> applied and requiring a zero-operation JSON plan',
  );
  const workspace = await mkdtemp(
    join(tmpdir(), 'datocms-content-diff-e2e-regenerate-'),
  );

  workspaces.push(workspace);
  cancellation.throwIfAborted();
  const migrationsDirectory = join(workspace, 'migrations');
  const configPath = join(workspace, 'datocms.config.json');
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
  const result = await runCli({
    binPath: cli.binPath,
    extraEnvironment: cli.environment,
    args: buildContentDiffArgs({
      scenario,
      name: 'real CMA regenerated no-op',
      sourceEnvironmentId,
      destinationEnvironmentId: appliedEnvironmentId,
      itemTypeApiKeys: seed.itemTypeApiKeys,
      configPath,
      json: true,
    }),
    cwd: workspace,
    apiToken,
    cancellation,
  });
  cancellation.throwIfAborted();
  const output = parseJsonObject(result.stdout, 'content:diff JSON output');
  const summary = parseJsonObject(output.summary, 'content:diff summary');
  const counts = parseJsonObject(summary.counts, 'content:diff counts');
  for (const [name, count] of Object.entries(counts)) {
    assert.equal(count, 0, `regenerated content diff reports non-zero ${name}`);
  }
  assert.equal(summary.destructiveActionCount, 0);
  const legacyIds = parseJsonObject(
    summary.legacyIds,
    'content:diff legacy-ID summary',
  );
  assert.equal(legacyIds.requiresLegacyIdRemapping, false);
}

export function loadHarnessConfiguration(): HarnessConfiguration {
  if (process.env[E2E_OPT_IN_ENV] !== '1') {
    throw new Error(
      `${E2E_OPT_IN_ENV}=1 is required; refusing to run a mutating real-CMA test`,
    );
  }

  const apiToken = process.env[API_TOKEN_ENV];
  if (!apiToken) {
    throw new Error(
      `${API_TOKEN_ENV} must contain a CMA token for the disposable E2E project`,
    );
  }

  return {
    apiToken,
    keepEnvironments: process.env[E2E_KEEP_ENV] === '1',
    cli: resolveCliInvocation(),
  };
}

/**
 * Selects the CLI that the live suites spawn. Unset (or `source`) keeps the
 * bin/dev source runner. `packaged` requires a host prepared by
 * scripts/prepare-packaged-host.mjs and validates it before any CMA work.
 */
export function resolveCliInvocation(
  environment: NodeJS.ProcessEnv = process.env,
  { packageRoot = pluginPackageRoot }: Readonly<{ packageRoot?: string }> = {},
): CliInvocation {
  const mode = environment[E2E_CLI_ENV];
  const hostDirectory = environment[E2E_PACKAGED_HOST_ENV];

  if (mode === undefined || mode === '' || mode === 'source') {
    if (hostDirectory) {
      throw new Error(
        `${E2E_PACKAGED_HOST_ENV} is set but ${E2E_CLI_ENV} is not "packaged"; set ${E2E_CLI_ENV}=packaged to run the packaged host, or unset ${E2E_PACKAGED_HOST_ENV}`,
      );
    }
    return SOURCE_CLI;
  }
  if (mode !== 'packaged') {
    throw new Error(
      `${E2E_CLI_ENV} must be "source" or "packaged", not ${JSON.stringify(
        mode,
      )}`,
    );
  }
  if (!hostDirectory || !isAbsolute(hostDirectory)) {
    throw new Error(
      `${E2E_CLI_ENV}=packaged requires ${E2E_PACKAGED_HOST_ENV} to be the absolute host directory printed by scripts/prepare-packaged-host.mjs`,
    );
  }

  return loadPackagedHost(hostDirectory, packageRoot);
}

type PackagedHostManifest = Readonly<{
  kind: string;
  formatVersion: number;
  host: Readonly<{ package: string; version: string; bin: string }>;
  plugin: Readonly<{
    name: string;
    version: string;
    root: string;
    tarball: string;
    tarballSha256: string;
    frozenTarball: boolean;
    executableInputsSha256: string | null;
  }>;
  oclif: Readonly<{ dataDir: string; configDir: string; cacheDir: string }>;
  xdg: Readonly<{ dataHome: string; configHome: string; cacheHome: string }>;
  /** Written only after every installation and routing check passed. */
  verifiedChecks: readonly string[];
}>;

function packagedHostPath(
  hostDirectory: string,
  relativePath: unknown,
): string {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(
      `packaged host path ${JSON.stringify(
        relativePath,
      )} must be a relative path inside the host directory`,
    );
  }
  return join(hostDirectory, ...relativePath.split('/'));
}

function readJsonFile(path: string, label: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read ${label} at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} at ${path} must be a JSON object`);
  }
  return parsed as Record<string, any>;
}

function loadPackagedHost(
  hostDirectory: string,
  packageRoot: string,
): CliInvocation {
  const manifestPath = join(hostDirectory, PACKAGED_HOST_MANIFEST_FILENAME);
  const manifest = readJsonFile(
    manifestPath,
    'packaged host manifest',
  ) as PackagedHostManifest;
  const checkout = readJsonFile(
    join(packageRoot, 'package.json'),
    'plugin package.json',
  );
  // Packaged hosts install the workspace's datocms release (packages/cli).
  const expectedHostVersion = readJsonFile(
    join(packageRoot, '..', 'cli', 'package.json'),
    'workspace datocms package.json',
  ).version;

  if (manifest.kind !== PACKAGED_HOST_KIND || manifest.formatVersion !== 1) {
    throw new Error(
      `${manifestPath} is not a format-1 packaged host manifest; rerun scripts/prepare-packaged-host.mjs`,
    );
  }
  if (
    !Array.isArray(manifest.verifiedChecks) ||
    manifest.verifiedChecks.length === 0 ||
    manifest.verifiedChecks.some(
      (title) => typeof title !== 'string' || title.length === 0,
    )
  ) {
    throw new Error(
      `${manifestPath} does not record passed installation and routing checks; rerun scripts/prepare-packaged-host.mjs`,
    );
  }
  if (
    manifest.host?.package !== 'datocms' ||
    manifest.host.version !== expectedHostVersion
  ) {
    throw new Error(
      `the packaged host must use datocms@${expectedHostVersion}, not ${JSON.stringify(
        manifest.host?.version,
      )}`,
    );
  }
  const installedHost = readJsonFile(
    join(hostDirectory, 'node_modules', 'datocms', 'package.json'),
    'installed datocms package.json',
  );
  if (installedHost.version !== manifest.host.version) {
    throw new Error(
      `the packaged host installed datocms@${installedHost.version} instead of ${manifest.host.version}`,
    );
  }
  const binPath = packagedHostPath(hostDirectory, manifest.host.bin);
  if (!existsSync(binPath)) {
    throw new Error(`the packaged host binary ${binPath} does not exist`);
  }

  if (manifest.plugin?.name !== checkout.name) {
    throw new Error(
      `the packaged host contains ${JSON.stringify(
        manifest.plugin?.name,
      )} instead of ${checkout.name}`,
    );
  }
  const installedPlugin = readJsonFile(
    join(packagedHostPath(hostDirectory, manifest.plugin.root), 'package.json'),
    'installed plugin package.json',
  );
  if (
    installedPlugin.name !== manifest.plugin.name ||
    installedPlugin.version !== manifest.plugin.version
  ) {
    throw new Error(
      `the packaged host plugin installation (${installedPlugin.name}@${installedPlugin.version}) does not match its manifest`,
    );
  }
  const tarballPath = packagedHostPath(hostDirectory, manifest.plugin.tarball);
  if (
    !existsSync(tarballPath) ||
    createHash('sha256').update(readFileSync(tarballPath)).digest('hex') !==
      manifest.plugin.tarballSha256
  ) {
    throw new Error(
      `the packaged host tarball ${tarballPath} is missing or does not match its recorded SHA-256`,
    );
  }
  if (manifest.plugin.frozenTarball !== true) {
    const current = executableInputsSha256(packageRoot);
    if (manifest.plugin.executableInputsSha256 !== current) {
      throw new Error(
        'the packaged host was built from different executable sources than this checkout; rerun scripts/prepare-packaged-host.mjs',
      );
    }
  } else if (manifest.plugin.executableInputsSha256 !== null) {
    throw new Error(
      'a frozen-tarball packaged host must not claim a checkout source digest',
    );
  }

  const environment = packagedHostEnvironment(hostDirectory, manifest);
  for (const directory of Object.values(environment).filter((value) =>
    isAbsolute(value),
  )) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new Error(`the packaged host directory ${directory} is missing`);
    }
  }

  return {
    mode: 'packaged',
    binPath,
    environment,
    description: `packaged host ${hostDirectory} (datocms@${
      manifest.host.version
    }, ${manifest.plugin.name}@${manifest.plugin.version}, ${
      manifest.plugin.frozenTarball ? 'frozen ' : ''
    }tarball sha256 ${manifest.plugin.tarballSha256})`,
  };
}

/**
 * Must match packagedHostEnvironment() in scripts/packaged-host.mjs: oclif's
 * DATOCMS_* overrides and XDG locations inside the host, so the packaged CLI
 * never reads or writes the user's global datocms plugins or caches.
 */
function packagedHostEnvironment(
  hostDirectory: string,
  manifest: PackagedHostManifest,
): Record<string, string> {
  return {
    DATOCMS_DATA_DIR: packagedHostPath(hostDirectory, manifest.oclif?.dataDir),
    DATOCMS_CONFIG_DIR: packagedHostPath(
      hostDirectory,
      manifest.oclif?.configDir,
    ),
    DATOCMS_CACHE_DIR: packagedHostPath(
      hostDirectory,
      manifest.oclif?.cacheDir,
    ),
    XDG_DATA_HOME: packagedHostPath(hostDirectory, manifest.xdg?.dataHome),
    XDG_CONFIG_HOME: packagedHostPath(hostDirectory, manifest.xdg?.configHome),
    XDG_CACHE_HOME: packagedHostPath(hostDirectory, manifest.xdg?.cacheHome),
    DATOCMS_SKIP_NEW_VERSION_CHECK: 'true',
  };
}

function listFilesForDigest(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      return listFilesForDigest(join(directory, entry.name), path);
    }
    if (!entry.isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    return [path];
  });
}

/**
 * Must match executableInputsSha256() in scripts/packaged-host.mjs: the
 * sources, launchers, and package/compiler metadata a packed build depends on.
 */
export function executableInputsSha256(packageRoot: string): string {
  const paths = [
    ...listFilesForDigest(join(packageRoot, 'src'), 'src').filter((path) =>
      path.endsWith('.ts'),
    ),
    ...listFilesForDigest(join(packageRoot, 'bin'), 'bin'),
    'package.json',
    'tsconfig.json',
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(packageRoot, ...path.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

type EnvironmentInventoryEntry = Readonly<{
  id: string;
  primary: boolean;
  forkedFrom: string | null;
  createdAt: string;
  readOnlyMode: boolean;
}>;

/**
 * Read-only primary fingerprint: the full environment fingerprint of primary
 * (site semantics, schema, current/published records, uploads, collections),
 * primary's workflow definitions, and the project's environment inventory
 * without sandboxes this suite owns. Operational fields (status,
 * last_data_change_at) are deliberately omitted.
 */
export type PrimaryEnvironmentSnapshot = Readonly<{
  projectId: string;
  primaryEnvironmentId: string;
  environments: readonly EnvironmentInventoryEntry[];
  contentFingerprint: string;
  workflowFingerprint: string;
  /** Owned sandboxes still present (excluding ones being destroyed). */
  retainedOwnedEnvironmentIds: readonly string[];
  fingerprint: string;
}>;

export async function capturePrimaryEnvironmentSnapshot({
  rootClient,
  primaryClient,
  ownedEnvironmentIds,
}: Readonly<{
  rootClient: CmaClient.Client;
  primaryClient(environmentId: string): CmaClient.Client;
  ownedEnvironmentIds: ReadonlySet<string>;
}>): Promise<PrimaryEnvironmentSnapshot> {
  const [site, environments] = await Promise.all([
    rootClient.site.find(),
    rootClient.environments.list(),
  ]);
  const primaries = environments.filter(({ meta }) => meta.primary);
  assert.equal(
    primaries.length,
    1,
    'the project must expose exactly one primary environment',
  );
  const primary = primaries[0];
  assert.ok(
    !ownedEnvironmentIds.has(primary.id),
    `owned E2E sandbox ${primary.id} became the primary environment`,
  );

  const inventory = sortResourcesById(
    environments
      .filter(({ id }) => !ownedEnvironmentIds.has(id))
      .map(({ id, meta }) => ({
        id,
        primary: meta.primary,
        forkedFrom: meta.forked_from ?? null,
        createdAt: meta.created_at,
        readOnlyMode: meta.read_only_mode,
      })),
  );
  const retainedOwnedEnvironmentIds = environments
    .filter(
      ({ id, meta }) =>
        ownedEnvironmentIds.has(id) && meta.status !== 'destroying',
    )
    .map(({ id }) => id)
    .sort();
  const primaryEnvironmentClient = primaryClient(primary.id);
  const [contentFingerprint, workflows] = await Promise.all([
    captureEnvironmentFingerprint(primaryEnvironmentClient),
    primaryEnvironmentClient.workflows.rawList(),
  ]);
  const identity = {
    projectId: String(site.id),
    primaryEnvironmentId: primary.id,
    environments: inventory,
    contentFingerprint,
    workflowFingerprint: createHash('sha256')
      .update(stableJson(sortResourcesById(workflows.data)))
      .digest('hex'),
  };

  return {
    ...identity,
    retainedOwnedEnvironmentIds,
    fingerprint: createHash('sha256')
      .update(stableJson(identity))
      .digest('hex'),
  };
}

/** Human-readable differences; empty when both fingerprints match. */
export function describePrimaryEnvironmentChanges(
  before: PrimaryEnvironmentSnapshot,
  after: PrimaryEnvironmentSnapshot,
): string[] {
  if (before.fingerprint === after.fingerprint) return [];

  const changes: string[] = [];
  if (before.projectId !== after.projectId) {
    changes.push(
      `project changed from ${before.projectId} to ${after.projectId}`,
    );
  }
  if (before.primaryEnvironmentId !== after.primaryEnvironmentId) {
    changes.push(
      `primary environment changed from ${before.primaryEnvironmentId} to ${after.primaryEnvironmentId}`,
    );
  }
  if (before.contentFingerprint !== after.contentFingerprint) {
    changes.push(
      `primary schema/record/upload/collection fingerprint changed from ${before.contentFingerprint} to ${after.contentFingerprint}`,
    );
  }
  if (before.workflowFingerprint !== after.workflowFingerprint) {
    changes.push(
      `primary workflow definitions changed from ${before.workflowFingerprint} to ${after.workflowFingerprint}`,
    );
  }
  const beforeById = new Map(
    before.environments.map((entry) => [entry.id, entry]),
  );
  const afterById = new Map(
    after.environments.map((entry) => [entry.id, entry]),
  );
  const added = [...afterById.keys()].filter((id) => !beforeById.has(id));
  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id));
  const altered = [...afterById.keys()].filter(
    (id) =>
      beforeById.has(id) &&
      stableJson(beforeById.get(id)) !== stableJson(afterById.get(id)),
  );
  if (added.length > 0) {
    changes.push(
      `environments not owned by this suite appeared: ${added.join(', ')}`,
    );
  }
  if (removed.length > 0) {
    changes.push(`environments disappeared: ${removed.join(', ')}`);
  }
  if (altered.length > 0) {
    changes.push(`environment metadata changed: ${altered.join(', ')}`);
  }
  if (changes.length === 0) {
    changes.push(
      `primary snapshot fingerprint changed from ${before.fingerprint} to ${after.fingerprint}`,
    );
  }
  return changes;
}

type PrimaryEnvironmentCheckpoint = Readonly<{
  label: string;
  snapshot: PrimaryEnvironmentSnapshot;
}>;

type PrimaryEnvironmentGuard = {
  readonly baseline: PrimaryEnvironmentSnapshot;
  /** Latest capture; scenario checks report only changes made since it. */
  checkpoint: PrimaryEnvironmentCheckpoint;
  readonly keepEnvironments: boolean;
  readonly ownedEnvironmentIds: Set<string>;
  readonly capture: (
    ownedEnvironmentIds: ReadonlySet<string>,
  ) => Promise<PrimaryEnvironmentSnapshot>;
};

let activePrimaryEnvironmentGuard: PrimaryEnvironmentGuard | undefined;

function assertPrimaryEnvironmentGuardInactive(): void {
  assert.ok(
    !activePrimaryEnvironmentGuard,
    'the primary environment guard is already active',
  );
}

/** Captures the suite baseline with the given read-only capture. */
export async function startPrimaryEnvironmentGuard({
  capture,
  keepEnvironments = false,
}: Readonly<{
  capture: PrimaryEnvironmentGuard['capture'];
  keepEnvironments?: boolean;
}>): Promise<PrimaryEnvironmentSnapshot> {
  assertPrimaryEnvironmentGuardInactive();
  const ownedEnvironmentIds = new Set<string>();
  const baseline = await capture(ownedEnvironmentIds);
  assertPrimaryEnvironmentGuardInactive();
  activePrimaryEnvironmentGuard = {
    baseline,
    checkpoint: { label: 'the suite baseline', snapshot: baseline },
    keepEnvironments,
    ownedEnvironmentIds,
    capture,
  };
  console.log(
    `[content-diff e2e] Primary ${baseline.primaryEnvironmentId} of project ${baseline.projectId} fingerprinted before the suite: ${baseline.fingerprint}`,
  );
  return baseline;
}

/**
 * Live suite baseline. The disposable-project boundary is checked first with
 * a handful of small reads, so a non-disposable project is refused before the
 * baseline pages through every primary record and upload. Without explicit
 * clients it reads with independent clients that own no cancellation.
 */
export async function startLivePrimaryEnvironmentGuard(
  clients?: Readonly<{
    rootClient: CmaClient.Client;
    primaryClient(environmentId: string): CmaClient.Client;
    keepEnvironments: boolean;
  }>,
): Promise<PrimaryEnvironmentSnapshot> {
  assertPrimaryEnvironmentGuardInactive();
  let live = clients;
  if (!live) {
    const configuration = loadHarnessConfiguration();
    live = {
      rootClient: buildClient(configuration.apiToken),
      primaryClient: (environmentId) =>
        buildClient(configuration.apiToken, environmentId),
      keepEnvironments: configuration.keepEnvironments,
    };
  }
  const { rootClient, primaryClient, keepEnvironments } = live;

  const [site, environments] = await Promise.all([
    rootClient.site.find(),
    rootClient.environments.list(),
  ]);
  const primary = environments.find(({ meta }) => meta.primary);
  assert.ok(primary, 'the project has no visible primary environment');
  await assertDisposableProjectSafety({
    primaryClient: primaryClient(primary.id),
    projectId: site.id,
    projectName: site.name,
  });

  return startPrimaryEnvironmentGuard({
    keepEnvironments,
    capture: (ownedEnvironmentIds) =>
      capturePrimaryEnvironmentSnapshot({
        rootClient,
        primaryClient,
        ownedEnvironmentIds,
      }),
  });
}

/** Scenarios refuse to run unless the suite-level guard captured primary. */
export function requireActivePrimaryEnvironmentGuard(): Readonly<{
  projectId: string;
  primaryEnvironmentId: string;
}> {
  if (!activePrimaryEnvironmentGuard) {
    throw new Error(
      'the suite primary-environment guard is not active: run the live suite through npm run test:e2e:real-cma (its Mocha --require of test/e2e/real-cma-harness.ts fingerprints primary before and after the suite); focus on one case with -- --grep',
    );
  }
  const { projectId, primaryEnvironmentId } =
    activePrimaryEnvironmentGuard.baseline;
  return { projectId, primaryEnvironmentId };
}

function assertPrimaryEnvironmentCheck({
  label,
  reference,
  current,
  keepEnvironments,
  retainedScope,
}: Readonly<{
  label: string;
  reference: PrimaryEnvironmentCheckpoint;
  current: PrimaryEnvironmentSnapshot;
  keepEnvironments: boolean;
  /** Owned sandboxes this check is responsible for. */
  retainedScope: ReadonlySet<string>;
}>): void {
  const problems = describePrimaryEnvironmentChanges(
    reference.snapshot,
    current,
  );
  const retained = current.retainedOwnedEnvironmentIds.filter((id) =>
    retainedScope.has(id),
  );
  if (!keepEnvironments && retained.length > 0) {
    problems.push(
      `owned E2E sandboxes remain although KEEP is unset: ${retained.join(
        ', ',
      )}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `primary environment check failed ${label} (compared with ${
        reference.label
      }): ${problems.join('; ')}`,
    );
  }
}

/**
 * Per-scenario check after cleanup. The scenario's sandboxes join the owned
 * set, and only changes since the previous checkpoint and this scenario's own
 * surviving sandboxes are reported, so one faulty scenario is not repeated as
 * a failure of every later scenario. The suite-end check still compares with
 * the baseline and reports every surviving owned sandbox.
 */
export async function verifyPrimaryEnvironmentAfterScenario(
  scenarioName: string,
  scenarioEnvironmentIds: readonly string[],
): Promise<PrimaryEnvironmentSnapshot | undefined> {
  const guard = activePrimaryEnvironmentGuard;
  if (!guard) return undefined;

  for (const environmentId of scenarioEnvironmentIds) {
    guard.ownedEnvironmentIds.add(environmentId);
  }
  const label = `after scenario ${JSON.stringify(scenarioName)}`;
  let current: PrimaryEnvironmentSnapshot;
  try {
    current = await guard.capture(guard.ownedEnvironmentIds);
  } catch (error) {
    throw safeError(error, `could not check the primary environment ${label}`);
  }
  const reference = guard.checkpoint;
  guard.checkpoint = { label: `the check ${label}`, snapshot: current };
  assertPrimaryEnvironmentCheck({
    label,
    reference,
    current,
    keepEnvironments: guard.keepEnvironments,
    retainedScope: new Set(scenarioEnvironmentIds),
  });
  return current;
}

export async function finishPrimaryEnvironmentGuard(): Promise<void> {
  const guard = activePrimaryEnvironmentGuard;
  if (!guard) return;
  try {
    const final = await guard.capture(guard.ownedEnvironmentIds);
    assertPrimaryEnvironmentCheck({
      label: 'after the suite',
      reference: { label: 'the suite baseline', snapshot: guard.baseline },
      current: final,
      keepEnvironments: guard.keepEnvironments,
      retainedScope: guard.ownedEnvironmentIds,
    });
    console.log(
      `[content-diff e2e] Primary ${final.primaryEnvironmentId} unchanged after the suite: ${final.fingerprint}`,
    );
  } finally {
    activePrimaryEnvironmentGuard = undefined;
  }
}

/**
 * Mocha root hooks. `npm run test:e2e:real-cma` loads this module with
 * `--require`, so primary is fingerprinted once before the first live case and
 * compared once after the last; a change fails the suite.
 */
export const mochaHooks = {
  async beforeAll(this: Mocha.Context): Promise<void> {
    this.timeout(PRIMARY_GUARD_TIMEOUT_MS);
    await startLivePrimaryEnvironmentGuard();
  },
  async afterAll(this: Mocha.Context): Promise<void> {
    this.timeout(PRIMARY_GUARD_TIMEOUT_MS);
    await finishPrimaryEnvironmentGuard();
  },
};

async function assertDisposableProjectSafety({
  primaryClient,
  projectId,
  projectName,
}: Readonly<{
  primaryClient: CmaClient.Client;
  projectId: string;
  projectName: string;
}>): Promise<void> {
  const [itemTypes, items, uploads] = await Promise.all([
    primaryClient.itemTypes.list(),
    primaryClient.items.rawList({ page: { limit: 1 } }),
    primaryClient.uploads.rawList({ page: { limit: 1 } }),
  ]);
  const counts = {
    models: itemTypes.length,
    records: items.meta.total_count,
    uploads: uploads.meta.total_count,
  };
  const isEmpty = Object.values(counts).every((count) => count === 0);

  if (isEmpty) {
    return;
  }

  const markerMatches = process.env[E2E_DISPOSABLE_PROJECT_ENV] === projectId;
  const nameMatches = DISPOSABLE_PROJECT_NAME.test(projectName);

  if (!markerMatches || !nameMatches) {
    throw new Error(
      [
        `refusing to run against non-empty project ${JSON.stringify(
          projectName,
        )} (${projectId})`,
        `primary contains ${counts.models} model(s), ${counts.records} record(s), and ${counts.uploads} upload(s)`,
        `the project name must contain e2e, test, or disposable as a separate word and ${E2E_DISPOSABLE_PROJECT_ENV} must exactly equal ${projectId}`,
      ].join('; '),
    );
  }
}

export function buildClient(
  apiToken: string,
  environment?: string,
  fetchFn?: typeof fetch,
): CmaClient.Client {
  return CmaClient.buildClient({
    apiToken,
    ...(environment ? { environment } : {}),
    ...(fetchFn ? { fetchFn } : {}),
    autoRetry: true,
    requestTimeout: 120_000,
    logLevel: CmaClient.LogLevel.NONE,
  });
}

export async function forkEnvironment(
  rootClient: CmaClient.Client,
  sourceEnvironmentId: string,
  destinationEnvironmentId: string,
  createdEnvironmentIds: string[],
  {
    cancellation,
    recoveryClient,
    pendingOwnershipRecoveries,
  }: Readonly<{
    cancellation: ScenarioCancellation;
    recoveryClient: CmaClient.Client;
    pendingOwnershipRecoveries: Array<() => Promise<void>>;
  }>,
): Promise<void> {
  cancellation.throwIfAborted();
  await assertEnvironmentIdIsUnoccupied(rootClient, destinationEnvironmentId);
  cancellation.throwIfAborted();
  console.log(
    `[content-diff e2e] Forking ${sourceEnvironmentId} -> ${destinationEnvironmentId}`,
  );
  try {
    await rootClient.environments.fork(sourceEnvironmentId, {
      id: destinationEnvironmentId,
    });
    createdEnvironmentIds.push(destinationEnvironmentId);
  } catch (error) {
    if (
      !(
        error instanceof CmaClient.ApiError &&
        error.findError('VALIDATION_UNIQUENESS')
      )
    ) {
      pendingOwnershipRecoveries.push(() =>
        trackForkAfterAmbiguousFailure({
          rootClient: recoveryClient,
          sourceEnvironmentId,
          destinationEnvironmentId,
          createdEnvironmentIds,
        }),
      );
    }
    throw error;
  }
}

async function assertEnvironmentIdIsUnoccupied(
  rootClient: CmaClient.Client,
  environmentId: string,
): Promise<void> {
  const existing = await findEnvironmentOrNull(rootClient, environmentId);
  assert.equal(
    existing,
    null,
    `refusing to use existing environment ID ${environmentId}`,
  );
}

async function trackForkAfterAmbiguousFailure({
  rootClient,
  sourceEnvironmentId,
  destinationEnvironmentId,
  createdEnvironmentIds,
}: Readonly<{
  rootClient: CmaClient.Client;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  createdEnvironmentIds: string[];
}>): Promise<void> {
  const candidate = await findEnvironmentOrNull(
    rootClient,
    destinationEnvironmentId,
  );
  if (candidate?.meta.forked_from === sourceEnvironmentId) {
    createdEnvironmentIds.push(destinationEnvironmentId);
  }
}

export async function trackAppliedEnvironmentAfterFailure({
  rootClient,
  apiToken,
  sourceEnvironmentId,
  destinationEnvironmentId,
  migrationModelApiKey,
  createdEnvironmentIds,
}: Readonly<{
  rootClient: CmaClient.Client;
  apiToken: string;
  sourceEnvironmentId: string;
  destinationEnvironmentId: string;
  migrationModelApiKey: string;
  createdEnvironmentIds: string[];
}>): Promise<void> {
  const candidate = await findEnvironmentOrNull(
    rootClient,
    destinationEnvironmentId,
  );
  if (candidate?.meta.forked_from !== sourceEnvironmentId) return;

  try {
    const candidateClient = buildClient(apiToken, destinationEnvironmentId);
    const itemTypes = await candidateClient.itemTypes.list();
    if (
      appliedEnvironmentOwnershipIsProven({
        candidate,
        sourceEnvironmentId,
        itemTypeApiKeys: itemTypes.map(({ api_key }) => api_key),
        migrationModelApiKey,
      })
    ) {
      createdEnvironmentIds.push(destinationEnvironmentId);
    }
  } catch {
    // If ownership cannot be proved through the per-run tracking model, leave
    // the cde2e-prefixed sandbox for manual cleanup instead of risking deletion
    // of an environment created by another process after the absence check.
  }
}

export function appliedEnvironmentOwnershipIsProven({
  candidate,
  sourceEnvironmentId,
  itemTypeApiKeys,
  migrationModelApiKey,
}: Readonly<{
  candidate: null | Readonly<{
    meta: Readonly<{ forked_from: string | null }>;
  }>;
  sourceEnvironmentId: string;
  itemTypeApiKeys: readonly string[];
  migrationModelApiKey: string;
}>): boolean {
  return (
    candidate?.meta.forked_from === sourceEnvironmentId &&
    itemTypeApiKeys.includes(migrationModelApiKey)
  );
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

async function cleanupEnvironments(
  rootClient: CmaClient.Client,
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

export async function runCli({
  binPath,
  args,
  cwd,
  apiToken,
  cancellation,
  extraEnvironment = {},
}: Readonly<{
  binPath: string;
  args: readonly string[];
  cwd: string;
  apiToken: string;
  cancellation: ScenarioCancellation;
  extraEnvironment?: Readonly<Record<string, string>>;
}>): Promise<CliResult> {
  cancellation.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extraEnvironment,
        DATOCMS_API_TOKEN: apiToken,
        DATOCMS_PROFILE: 'default',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    void cancellation.trackChild(child);
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
      // A spawn error is followed by close. Await it before any workspace cleanup.
      startupFailure = new Error(
        `could not start ${basename(binPath)}: ${redact(
          error.message,
          apiToken,
        )}`,
      );
    });
    child.once('close', (exitCode, signal) => {
      if (startupFailure) {
        rejectPromise(startupFailure);
        return;
      }
      if (cancellation.signal.aborted) {
        rejectPromise(cancellation.signal.reason);
        return;
      }
      if (exitCode === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(
        new Error(
          [
            `${basename(binPath)} exited with ${
              exitCode ?? `signal ${signal}`
            }`,
            redact(stdout, apiToken).trim(),
            redact(stderr, apiToken).trim(),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });
  });
}

export async function captureEnvironmentFingerprint(
  client: CmaClient.Client,
): Promise<string> {
  const [
    site,
    itemTypeResponse,
    currentItems,
    publishedItems,
    uploads,
    collections,
  ] = await Promise.all([
    client.site.rawFind().then(({ data }) => data),
    client.itemTypes.rawList(),
    captureAllRawItems(client, 'current'),
    captureAllRawItems(client, 'published'),
    captureAllRawUploads(client),
    client.uploadCollections.rawList().then(({ data }) => data),
  ]);
  const itemTypes = sortResourcesById(itemTypeResponse.data);
  const [currentWithRootPayloads, publishedWithRootPayloads, schema] =
    await Promise.all([
      captureNestedRootPayloads(client, 'current', currentItems, itemTypes),
      captureNestedRootPayloads(client, 'published', publishedItems, itemTypes),
      Promise.all(
        itemTypes.map(async (itemType) => {
          const [fields, fieldsets] = await Promise.all([
            client.fields.rawList(itemType.id).then(({ data }) => data),
            client.fieldsets.rawList(itemType.id).then(({ data }) => data),
          ]);
          return {
            itemType,
            fields: sortResourcesById(fields),
            fieldsets: sortResourcesById(fieldsets),
          };
        }),
      ),
    ]);
  const serialized = stableJson({
    // Site metadata contains asynchronously refreshed operational timestamps
    // (for example last_data_change_at). They can advance after the first
    // migration has already returned, which would make a read-only replay look
    // mutating. Keep only environment content semantics in this fingerprint.
    site: {
      id: site.id,
      locales: site.attributes.locales,
      timezone: site.attributes.timezone,
      environmentSemantics: {
        improvedTimezoneManagement: site.meta.improved_timezone_management,
        improvedBooleanFields: site.meta.improved_boolean_fields,
        improvedValidationAtPublishing:
          site.meta.improved_validation_at_publishing,
        millisecondsInDatetime: site.meta.milliseconds_in_datetime,
        nonLocalizedFocalPoints: site.meta.non_localized_focal_points,
        improvedHexManagement: site.meta.improved_hex_management,
      },
    },
    schema,
    content: {
      current: sortResourcesById(currentWithRootPayloads),
      published: sortResourcesById(publishedWithRootPayloads),
    },
    uploads: sortResourcesById(uploads),
    uploadCollections: sortResourcesById(collections),
  });
  return createHash('sha256').update(serialized).digest('hex');
}

async function captureAllRawItems(
  client: CmaClient.Client,
  version: 'current' | 'published',
): Promise<CmaClient.RawApiTypes.Item[]> {
  const resources: CmaClient.RawApiTypes.Item[] = [];
  const seenIds = new Set<string>();
  let expectedTotal: number | null = null;

  while (expectedTotal === null || resources.length < expectedTotal) {
    const response = await client.items.rawList({
      // Unfiltered listing includes block records. Expanding every block also
      // expands its descendants repeatedly and limits pages to thirty rows.
      // Preserve every flat row and its metadata, then expand regular roots.
      nested: false,
      order_by: 'id_ASC',
      version,
      page: { offset: resources.length, limit: 500 },
    });
    assert.ok(
      Number.isSafeInteger(response.meta.total_count) &&
        response.meta.total_count >= 0,
      `${version} fingerprint record count must be a nonnegative integer`,
    );
    assert.ok(
      Array.isArray(response.data) && response.data.length <= 500,
      `${version} fingerprint pagination returned an oversized or invalid page`,
    );
    if (expectedTotal === null) expectedTotal = response.meta.total_count;
    assert.equal(
      response.meta.total_count,
      expectedTotal,
      `${version} record count changed during fingerprint capture`,
    );
    if (response.data.length === 0) {
      assert.equal(
        resources.length,
        expectedTotal,
        `${version} record pagination ended early`,
      );
      break;
    }
    for (const resource of response.data) {
      assert.ok(
        typeof resource.id === 'string' &&
          resource.id.length > 0 &&
          resource.type === 'item',
        `${version} fingerprint pagination returned an invalid record`,
      );
      assert.ok(
        !seenIds.has(resource.id),
        `${version} fingerprint pagination returned duplicate record ${resource.id}`,
      );
      seenIds.add(resource.id);
      resources.push(resource);
    }
    assert.ok(
      resources.length <= expectedTotal,
      `${version} fingerprint pagination exceeded its record count`,
    );
  }

  return resources;
}

async function captureNestedRootPayloads(
  client: CmaClient.Client,
  version: 'current' | 'published',
  records: readonly CmaClient.RawApiTypes.Item[],
  itemTypes: readonly CmaClient.RawApiTypes.ItemType[],
): Promise<CmaClient.RawApiTypes.Item[]> {
  const models = new Map(itemTypes.map((itemType) => [itemType.id, itemType]));
  const rootIds = records
    .filter((record) => {
      const model = models.get(record.relationships.item_type.data.id);
      assert.ok(
        model && typeof model.attributes.modular_block === 'boolean',
        `${version} fingerprint record ${record.id} has an unknown model`,
      );
      return !model.attributes.modular_block;
    })
    .map(({ id }) => id);
  const nestedRoots = new Map<string, CmaClient.RawApiTypes.Item>();
  // Flat version inventories retain orphan blocks and their complete metadata.
  // Root payloads also retain each aggregate's explicit nested-version links:
  // a root's historical child payload must not be inferred from global block
  // CURRENT/PUBLISHED pointers, particularly after selective publication.
  for (let offset = 0; offset < rootIds.length; offset += 30) {
    const requested = rootIds.slice(offset, offset + 30);
    const requestedIds = new Set(requested);
    const response = await client.items.rawList({
      filter: { ids: requested.join(',') },
      nested: true,
      version,
      order_by: 'id_ASC',
      page: { offset: 0, limit: 30 },
    });
    assert.equal(
      response.meta.total_count,
      requested.length,
      `${version} fingerprint root count changed during capture`,
    );
    assert.equal(
      response.data.length,
      requested.length,
      `${version} fingerprint root payload batch is incomplete`,
    );
    for (const resource of response.data) {
      assert.ok(
        requestedIds.has(resource.id) && !nestedRoots.has(resource.id),
        `${version} fingerprint root payload batch returned a duplicate or unexpected ID`,
      );
      nestedRoots.set(resource.id, resource);
    }
  }
  return records.map((record) => nestedRoots.get(record.id) ?? record);
}

async function captureAllRawUploads(
  client: CmaClient.Client,
): Promise<CmaClient.RawApiTypes.Upload[]> {
  const resources: CmaClient.RawApiTypes.Upload[] = [];
  let expectedTotal: number | null = null;

  while (expectedTotal === null || resources.length < expectedTotal) {
    const response = await client.uploads.rawList({
      order_by: 'id_ASC',
      page: { offset: resources.length, limit: 500 },
    });
    if (expectedTotal === null) expectedTotal = response.meta.total_count;
    assert.equal(
      response.meta.total_count,
      expectedTotal,
      'upload count changed during fingerprint capture',
    );
    if (response.data.length === 0) {
      assert.equal(
        resources.length,
        expectedTotal,
        'upload pagination ended early',
      );
      break;
    }
    resources.push(...response.data);
  }

  return resources;
}

function sortResourcesById<T extends { id: string }>(
  resources: readonly T[],
): T[] {
  return [...resources].sort((left, right) => left.id.localeCompare(right.id));
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalizeForFingerprint(value));
}

function canonicalizeForFingerprint(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForFingerprint(entry) ?? null);
  }
  if (typeof value !== 'object') return String(value);

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, entry]) => {
        const canonical = canonicalizeForFingerprint(entry);
        return canonical === undefined ? [] : [[key, canonical]];
      }),
  );
}

function parseJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

async function captureGoldenRawState(
  client: CmaClient.Client,
  modelId: string,
): Promise<RawGoldenState> {
  const [current, published] = await Promise.all([
    client.items.rawList<GoldenFixtureDefinition>({
      filter: { type: modelId },
      version: 'current',
      page: { limit: 500 },
    }),
    client.items.rawList<GoldenFixtureDefinition>({
      filter: { type: modelId },
      version: 'published',
      page: { limit: 500 },
    }),
  ]);

  return {
    current: rawRecordsById(current.data),
    published: rawRecordsById(published.data),
    currentIds: current.data.map(({ id }) => id).sort(),
    publishedIds: published.data.map(({ id }) => id).sort(),
  };
}

function rawRecordsById(
  records: readonly CmaClient.RawApiTypes.Item<GoldenFixtureDefinition>[],
): Readonly<Record<string, RawGoldenRecord>> {
  return Object.fromEntries(
    records
      .map(
        (record) =>
          [
            record.id,
            {
              id: record.id,
              itemTypeId: record.relationships.item_type.data.id,
              title: record.attributes.title,
              body: record.attributes.body,
              related: record.attributes.related,
            },
          ] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Keeps the leading failure first and appends every other failure message. */
export function withAdditionalFailures(
  failure: Error,
  others: readonly (Error | undefined)[],
): Error {
  const additional = others.filter(
    (other): other is Error => other !== undefined,
  );
  if (additional.length === 0) return failure;
  return new Error(
    [
      failure.message,
      ...additional.map(({ message }) => `also: ${message}`),
    ].join('\n'),
  );
}

function safeError(error: unknown, prefix?: string): Error {
  if (error instanceof CmaClient.ApiError) {
    const details = error.errors.map(({ attributes }) => ({
      code: attributes.code,
      details: attributes.details,
    }));
    return new Error(
      `${prefix ? `${prefix}: ` : ''}CMA ${
        error.response.status
      }: ${JSON.stringify(details)}`,
    );
  }

  if (error instanceof Error) {
    return new Error(`${prefix ? `${prefix}: ` : ''}${error.message}`);
  }

  return new Error(`${prefix ? `${prefix}: ` : ''}${String(error)}`);
}

function redact(value: string, apiToken: string): string {
  return value.split(apiToken).join('[REDACTED]');
}
