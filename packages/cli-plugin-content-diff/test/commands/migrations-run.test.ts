import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient, CmaClientCommand, oclif } from '@datocms/cli-utils';
import { runCommand } from '@oclif/test';
import { expect } from 'chai';
import MigrationRunCommand from '../../src/commands/migrations/run';
import { stableStringify } from '../../src/content-diff/canonicalize';
import {
  RUNTIME_VERSION,
  renderEntrypoint,
} from '../../src/content-diff/runtime-template';
import {
  MIGRATIONS_RUN_LOCK_NAME_PREFIX,
  MIGRATIONS_RUN_LOCK_RECORD_ID,
  type MigrationsRunLockMetadata,
  encodeMigrationsRunLockName,
  parseMigrationsRunLockName,
} from '../../src/utils/migrations-run-lock';
import {
  type FakeCmaRequest,
  type FakeCmaResponse,
  apiErrorResponse,
  environmentResource,
  environmentsResponse,
  expectAuthenticatedWith,
  expectRedactedCmaOutput,
  siteResponse,
  startFakeCmaServer,
} from './fake-cma-server';

type BuildClient = (options?: { environment?: string }) => Promise<
  Record<string, unknown>
>;

const commandPrototype = CmaClientCommand.prototype as unknown as {
  buildClient: BuildClient;
};

type RunCommandSeams = {
  forceExit(code: number): void;
  writeStderrSync(message: string): void;
  sleep(ms: number): Promise<void>;
};

// oclif derives the command prefix from the plugin package when testing it
// directly; the installed plugin runs under the host's `datocms` binary.
const pluginPackage = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
) as { name: string; oclif?: { bin?: string } };
const BIN = pluginPackage.oclif?.bin ?? pluginPackage.name;

const runCommandPrototype =
  MigrationRunCommand.prototype as unknown as RunCommandSeams;

type FakeLockItem = {
  id: string;
  item_type: { type: 'item_type'; id: string };
  name: string;
  meta: { created_at: string };
};

function foreignLockMetadata(
  overrides: Partial<MigrationsRunLockMetadata> = {},
): MigrationsRunLockMetadata {
  return {
    v: 1,
    runId: 'feedfacefeedface',
    environmentId: 'sandbox',
    mode: 'in-place',
    host: 'other-host',
    pid: 31337,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    pending: 3,
    first: '1700000000_other.js',
    ...overrides,
  };
}

function lockItem(
  metadata: MigrationsRunLockMetadata = foreignLockMetadata(),
  modelId = 'migration-model',
): FakeLockItem {
  return {
    id: MIGRATIONS_RUN_LOCK_RECORD_ID,
    item_type: { type: 'item_type', id: modelId },
    name: encodeMigrationsRunLockName(metadata),
    meta: { created_at: metadata.startedAt },
  };
}

function lockMetadataOf(name: unknown): MigrationsRunLockMetadata {
  const parsed = parseMigrationsRunLockName(name);
  if (!('meta' in parsed)) throw new Error(`not a lock name: ${String(name)}`);
  return parsed.meta;
}

function exactMigrationModel(): CmaClient.ApiTypes.ItemType {
  return {
    id: 'migration-model',
    type: 'item_type',
    name: 'Schema migration',
    api_key: 'schema_migration',
    modular_block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draft_mode_active: false,
    draft_saving_active: false,
    all_locales_required: false,
    workflow: null,
  } as CmaClient.ApiTypes.ItemType;
}

function exactMigrationNameField(): CmaClient.ApiTypes.Field {
  return {
    id: 'migration-name-field',
    type: 'field',
    label: 'Migration file name',
    api_key: 'name',
    field_type: 'string',
    localized: false,
    default_value: null,
    validators: { required: {} },
  } as CmaClient.ApiTypes.Field;
}

function apiError(status: number, statusText: string): CmaClient.ApiError {
  return new CmaClient.ApiError({
    request: {
      url: '/item-types/schema_migration',
      method: 'GET',
      headers: {},
    },
    response: { status, statusText, headers: {} },
  });
}

function apiErrorWithCode(
  status: number,
  code: string,
  id = 'error-instance',
): CmaClient.ApiError {
  return new CmaClient.ApiError({
    request: {
      url: '/item-types/schema_migration',
      method: 'GET',
      headers: {},
    },
    response: {
      status,
      statusText: String(status),
      headers: {},
      body: {
        data: [{ id, type: 'api_error', attributes: { code, details: {} } }],
      },
    },
  });
}

async function writeBoundContentMigration(
  migrationsDirectory: string,
  options: {
    projectMode?: 'same_project' | 'aligned_projects';
    sourceSiteId?: string;
    targetSiteId?: string;
    runtimeVersion?: string;
    body?: string;
  } = {},
): Promise<{ migrationPath: string; manifestPath: string }> {
  const migrationBasename = '1700000100_bound';
  const manifestBasename = `${migrationBasename}.plan.json`;
  const migrationPath = join(migrationsDirectory, `${migrationBasename}.js`);
  const contentDirectory = join(migrationsDirectory, '.datocms-content');
  const manifestPath = join(contentDirectory, manifestBasename);
  const sourceSiteId = options.sourceSiteId ?? 'source-site';
  const targetSiteId = options.targetSiteId ?? 'target-site';
  const runtimeVersion = options.runtimeVersion ?? RUNTIME_VERSION;
  const plan = {
    formatVersion: 10,
    source: {
      siteId: sourceSiteId,
      environmentId: 'main',
    },
    target: {
      siteId: targetSiteId,
      environmentId: 'main',
    },
    schema: { siteId: sourceSiteId },
    options: {
      projectMode: options.projectMode ?? 'aligned_projects',
    },
  };
  const manifest = {
    formatVersion: 10,
    runtimeVersion,
    integrity: {
      algorithm: 'sha256',
      planSha256: createHash('sha256')
        .update(stableStringify(plan))
        .digest('hex'),
    },
    plan,
  };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = createHash('sha256')
    .update(manifestContents)
    .digest('hex');
  const binding = {
    bindingVersion: 1,
    targetSiteId,
    manifestBasename,
    manifestSha256,
  };

  await mkdir(contentDirectory);
  await writeFile(manifestPath, manifestContents);
  await writeFile(
    migrationPath,
    `// datocms-content-diff-binding ${JSON.stringify(binding)}
// .datocms-content/runtime-v${runtimeVersion}
module.exports = async function (client, context) {
  globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
${options.body ?? ''}
};
`,
  );

  return { migrationPath, manifestPath };
}

describe('migrations:run execution context', () => {
  let temporaryDirectory: string;
  let migrationsDirectory: string;
  let configPath: string;
  let originalBuildClient: BuildClient;
  let targetClient: Record<string, unknown>;
  let builtEnvironmentIds: Array<string | undefined>;
  let forkCalls: Array<{ sourceId: string; destinationId: string }>;
  let migrationRecordWrites: number;
  let actualSiteId: string;
  let heldLock: FakeLockItem | null;
  let runEvents: string[];
  let lockCreateBodies: Array<Record<string, unknown>>;
  let lockDestroyCalls: number;
  let environmentClients: Record<string, Record<string, unknown>>;
  let forcedExits: number[];
  let synchronousStderr: string[];
  let originalForceExit: RunCommandSeams['forceExit'];
  let originalWriteStderrSync: RunCommandSeams['writeStderrSync'];
  let originalSleep: RunCommandSeams['sleep'];
  let sleeps: number[];
  let signalListenerBaseline: { SIGINT: number; SIGTERM: number };

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'datocms-migrations-run-'),
    );
    migrationsDirectory = join(temporaryDirectory, 'migrations');
    configPath = join(temporaryDirectory, 'datocms.config.json');
    builtEnvironmentIds = [];
    forkCalls = [];
    migrationRecordWrites = 0;
    actualSiteId = 'target-site';
    heldLock = null;
    runEvents = [];
    lockCreateBodies = [];
    lockDestroyCalls = 0;
    environmentClients = {};
    forcedExits = [];
    synchronousStderr = [];
    sleeps = [];
    signalListenerBaseline = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    (globalThis as Record<string, unknown>).__runEvents = runEvents;

    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          default: {
            migrations: { directory: 'migrations' },
          },
        },
      }),
    );
    await mkdir(migrationsDirectory);

    const environments = [
      { id: 'primary', meta: { primary: true } },
      { id: 'source', meta: { primary: false } },
      { id: 'sandbox', meta: { primary: false } },
    ];
    const rootClient = {
      site: {
        find: async () => ({ id: actualSiteId }),
      },
      environments: {
        list: async () => environments,
        find: async (id: string) =>
          environments.find((environment) => environment.id === id),
        fork: async (sourceId: string, body: { id: string }) => {
          forkCalls.push({ sourceId, destinationId: body.id });
        },
      },
    };
    targetClient = {
      marker: 'target-client',
      itemTypes: {
        find: async () => exactMigrationModel(),
      },
      fields: {
        list: async () => [exactMigrationNameField()],
      },
      items: {
        async *listPagedIterator() {},
        find: async (id: string) => {
          if (id === MIGRATIONS_RUN_LOCK_RECORD_ID && heldLock) return heldLock;
          throw apiError(404, 'Not Found');
        },
        create: async (body: Record<string, unknown>) => {
          if (body.id === MIGRATIONS_RUN_LOCK_RECORD_ID) {
            lockCreateBodies.push(body);
            runEvents.push('lock-create');
            if (heldLock) throw apiError(422, 'Unprocessable Entity');
            heldLock = {
              id: MIGRATIONS_RUN_LOCK_RECORD_ID,
              item_type: body.item_type as FakeLockItem['item_type'],
              name: String(body.name),
              meta: { created_at: new Date().toISOString() },
            };
            return heldLock;
          }
          migrationRecordWrites += 1;
          runEvents.push(`history ${String(body.name)}`);
          return { id: 'migration-record' };
        },
        destroy: async (id: string) => {
          lockDestroyCalls += 1;
          runEvents.push('lock-destroy');
          if (id !== MIGRATIONS_RUN_LOCK_RECORD_ID || !heldLock) {
            throw apiError(404, 'Not Found');
          }
          heldLock = null;
          return {};
        },
      },
    };

    originalBuildClient = commandPrototype.buildClient;
    commandPrototype.buildClient = async (options) => {
      builtEnvironmentIds.push(options?.environment);
      if (!options?.environment) return rootClient;
      return environmentClients[options.environment] ?? targetClient;
    };
    originalForceExit = runCommandPrototype.forceExit;
    originalWriteStderrSync = runCommandPrototype.writeStderrSync;
    originalSleep = runCommandPrototype.sleep;
    runCommandPrototype.sleep = async (ms) => {
      sleeps.push(ms);
    };
    runCommandPrototype.forceExit = (code) => {
      forcedExits.push(code);
    };
    runCommandPrototype.writeStderrSync = (message) => {
      synchronousStderr.push(message);
    };
  });

  afterEach(async () => {
    commandPrototype.buildClient = originalBuildClient;
    runCommandPrototype.forceExit = originalForceExit;
    runCommandPrototype.writeStderrSync = originalWriteStderrSync;
    runCommandPrototype.sleep = originalSleep;
    expect(process.listenerCount('SIGINT')).to.equal(
      signalListenerBaseline.SIGINT,
    );
    expect(process.listenerCount('SIGTERM')).to.equal(
      signalListenerBaseline.SIGTERM,
    );
    (globalThis as Record<string, unknown>).__runEvents = undefined;
    (globalThis as Record<string, unknown>).__migrationContext = undefined;
    (globalThis as Record<string, unknown>).__oneArgumentMigrationClient =
      undefined;
    (globalThis as Record<string, unknown>).__migrationInvocations = undefined;
    (globalThis as Record<string, unknown>).__replaceLock = undefined;
    (globalThis as Record<string, unknown>).__abortSignalSeen = undefined;
    (globalThis as Record<string, unknown>).__listenerCounts = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('passes the actual fork target and flags while one-argument migrations remain compatible', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_old.js'),
      `module.exports = async function (client) {
        globalThis.__oneArgumentMigrationClient = client.marker;
      };`,
    );
    await writeFile(
      join(migrationsDirectory, '1700000001_context.js'),
      `module.exports = async function (client, context) {
        globalThis.__migrationContext = { client: client.marker, context };
      };`,
    );

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(forkCalls).to.deep.equal([
      { sourceId: 'source', destinationId: 'generated-fork' },
    ]);
    expect(builtEnvironmentIds).to.deep.equal([
      undefined,
      'source',
      'generated-fork',
    ]);
    expect(
      (globalThis as Record<string, unknown>).__oneArgumentMigrationClient,
    ).to.equal('target-client');
    const captured = (globalThis as Record<string, unknown>)
      .__migrationContext as {
      client: string;
      context: Record<string, unknown>;
    };
    const { abortSignal, ...context } = captured.context;
    expect(abortSignal).to.be.instanceOf(AbortSignal);
    expect((abortSignal as AbortSignal).aborted).to.equal(false);
    expect({ client: captured.client, context }).to.deep.equal({
      client: 'target-client',
      context: {
        environmentId: 'generated-fork',
        inPlace: false,
        allowPrimary: false,
        contentDiffProtocolVersion: 1,
      },
    });
  });

  it('passes both explicit primary opt-ins to migrations', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_context.js'),
      `module.exports = async function (_client, context) {
        globalThis.__migrationContext = context;
      };`,
    );

    const { error, stderr } = await runCommand(
      `migrations:run --source=primary --in-place --allow-primary --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    const { abortSignal, ...context } = (globalThis as Record<string, unknown>)
      .__migrationContext as Record<string, unknown>;
    expect(abortSignal).to.be.instanceOf(AbortSignal);
    expect(context).to.deep.equal({
      environmentId: 'primary',
      inPlace: true,
      allowPrimary: true,
      contentDiffProtocolVersion: 1,
    });
    expect(stderr).to.contain('no automatic rollback');
  });

  for (const configuration of ['flag', 'profile'] as const) {
    it(`uses the ${configuration} migration tsconfig for TypeScript path aliases`, async () => {
      const tsconfigPath = join(temporaryDirectory, 'custom.tsconfig.json');
      await mkdir(join(temporaryDirectory, 'helpers'));
      await writeFile(
        join(temporaryDirectory, 'helpers', 'value.ts'),
        'export const value: number = 42;',
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { 'migration-helpers/*': ['helpers/*'] },
          },
        }),
      );
      await writeFile(
        join(migrationsDirectory, '1700000000_typed.ts'),
        `import { value } from 'migration-helpers/value';
export default async function (): Promise<void> {
  (globalThis as Record<string, unknown>).__migrationInvocations = value;
}`,
      );
      if (configuration === 'profile') {
        await writeFile(
          configPath,
          JSON.stringify({
            profiles: {
              default: {
                migrations: {
                  directory: 'migrations',
                  tsconfig: 'custom.tsconfig.json',
                },
              },
            },
          }),
        );
      }
      const previousTsconfig = process.env.TSX_TSCONFIG_PATH;

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}${
          configuration === 'flag'
            ? ` --migrations-tsconfig=${tsconfigPath}`
            : ''
        }`,
      );

      expect(error).to.equal(undefined);
      expect(
        (globalThis as Record<string, unknown>).__migrationInvocations,
      ).to.equal(42);
      expect(migrationRecordWrites).to.equal(1);
      expect(process.env.TSX_TSCONFIG_PATH).to.equal(previousTsconfig);
    });
  }

  it('skips completed legacy migrations using their recorded relative paths', async () => {
    await mkdir(join(migrationsDirectory, 'legacyClient'));
    await writeFile(
      join(migrationsDirectory, 'legacyClient', '1700000000_completed.js'),
      'module.exports = async function () {};',
    );
    Object.assign(targetClient.items as object, {
      async *listPagedIterator() {
        yield { name: 'legacyClient/1700000000_completed.js' };
      },
    });

    const { error, stdout } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(stdout).to.contain('No new migration scripts to run');
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('does not confuse current and legacy migrations that share a basename', async () => {
    const filename = '1700000000_sameName.js';
    await mkdir(join(migrationsDirectory, 'legacyClient'));
    await writeFile(join(migrationsDirectory, filename), '');
    await writeFile(join(migrationsDirectory, 'legacyClient', filename), '');
    targetClient.items = {
      async *listPagedIterator() {
        yield { name: filename };
      },
    };
    const command = Object.create(MigrationRunCommand.prototype);
    const pending = await Reflect.apply(
      Reflect.get(command, 'migrationScriptsToRun'),
      command,
      [exactMigrationModel(), targetClient, migrationsDirectory],
    );

    expect(pending).to.deep.equal([
      {
        filename,
        path: join(migrationsDirectory, 'legacyClient', filename),
        legacy: true,
      },
    ]);
  });

  for (const locale of ['en_US.UTF-8', 'sv_SE.UTF-8']) {
    it(`orders pending migration files consistently under ${locale}`, async () => {
      for (const filename of ['1700000000_ä.js', '1700000000_z.js']) {
        await writeFile(join(migrationsDirectory, filename), '');
      }
      const sourcePath = require.resolve('../../src/commands/migrations/run');
      const script = `
const Command = require(${JSON.stringify(sourcePath)}).default;
const command = Object.create(Command.prototype);
command.migrationScriptsToRun(null, {}, process.argv[1])
  .then((scripts) => process.stdout.write(JSON.stringify(scripts.map((script) => script.filename))))
  .catch((error) => { console.error(error); process.exitCode = 1; });
`;
      const result = spawnSync(
        process.execPath,
        [
          '--require',
          require.resolve('ts-node/register'),
          '-e',
          script,
          migrationsDirectory,
        ],
        {
          cwd: temporaryDirectory,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            ...process.env,
            LANG: locale,
            LC_ALL: locale,
            TS_NODE_PROJECT: resolve('tsconfig.json'),
          },
        },
      );

      expect(result.error).to.equal(undefined);
      expect(result.status, result.stderr).to.equal(0);
      expect(JSON.parse(result.stdout)).to.deep.equal([
        '1700000000_z.js',
        '1700000000_ä.js',
      ]);
    });
  }

  it('recognizes legacy migration history recorded with Windows path separators', async () => {
    await mkdir(join(migrationsDirectory, 'legacyClient'));
    await writeFile(
      join(migrationsDirectory, 'legacyClient', '1700000000_completed.js'),
      'module.exports = async function () {};',
    );
    Object.assign(targetClient.items as object, {
      async *listPagedIterator() {
        yield { name: 'legacyClient\\1700000000_completed.js' };
      },
    });

    const { error, stdout } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(stdout).to.contain('No new migration scripts to run');
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('reports an unreadable legacy migration directory before creating a fork', async () => {
    await writeFile(
      join(migrationsDirectory, 'legacyClient'),
      'not a directory',
    );
    await writeFile(
      join(migrationsDirectory, '1700000000_current.js'),
      'module.exports = async function () {};',
    );

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('ENOTDIR');
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  for (const exportedValue of ['null', '42', "'invalid'"]) {
    it(`reports an invalid ${exportedValue} export without writing migration history`, async () => {
      await writeFile(
        join(migrationsDirectory, '1700000000_invalid.js'),
        `module.exports = ${exportedValue};`,
      );

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error?.message).to.contain(
        'The script does not export a valid migration function',
      );
      expect(migrationRecordWrites).to.equal(0);
    });
  }

  it('validates and runs a destination-bound content migration', async () => {
    await writeBoundContentMigration(migrationsDirectory);

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(forkCalls).to.deep.equal([
      { sourceId: 'source', destinationId: 'generated-fork' },
    ]);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(1);
    expect(migrationRecordWrites).to.equal(1);
  });

  it('keeps previously generated runtime-v16 bound migrations runnable', async () => {
    await writeBoundContentMigration(migrationsDirectory, {
      runtimeVersion: '16',
    });

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(1);
  });

  it('validates runtime-v16 manifests with their original mixed-case and Unicode key ordering', async () => {
    const { migrationPath, manifestPath } = await writeBoundContentMigration(
      migrationsDirectory,
      { runtimeVersion: '16' },
    );
    // These bytes use the original runtime-v16 localeCompare ordering.
    const legacyPlanJson =
      '{"formatVersion":10,"metadata":{"a":1,"Å":2,"z":3,"Z":4},"options":{"projectMode":"aligned_projects"},"schema":{"siteId":"source-site"},"source":{"environmentId":"main","siteId":"source-site"},"target":{"environmentId":"main","siteId":"target-site"}}';
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.plan = JSON.parse(legacyPlanJson);
    manifest.integrity.planSha256 = createHash('sha256')
      .update(legacyPlanJson)
      .digest('hex');
    const manifestContents = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestContents);
    const manifestSha256 = createHash('sha256')
      .update(manifestContents)
      .digest('hex');
    await writeFile(
      migrationPath,
      (await readFile(migrationPath, 'utf8')).replace(
        /"manifestSha256":"[a-f0-9]+"/u,
        `"manifestSha256":"${manifestSha256}"`,
      ),
    );

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(1);
  });

  for (const format of ['js', 'ts'] as const) {
    it(`loads generated ${format} entrypoints and their adjacent runtime through the scoped loader`, async () => {
      const { migrationPath, manifestPath } =
        await writeBoundContentMigration(migrationsDirectory);
      const actualMigrationPath = migrationPath.replace(/\.js$/u, `.${format}`);
      const manifestSha256 = createHash('sha256')
        .update(await readFile(manifestPath))
        .digest('hex');
      await rm(migrationPath);
      await writeFile(
        actualMigrationPath,
        renderEntrypoint(
          format,
          '1700000100_bound.plan.json',
          manifestSha256,
          'target-site',
        ),
      );
      await writeFile(
        join(
          migrationsDirectory,
          '.datocms-content',
          `runtime-v${RUNTIME_VERSION}.${format}`,
        ),
        `${
          format === 'js'
            ? 'exports.runContentDiffMigration = async function'
            : 'export async function runContentDiffMigration'
        } (client, envelope, options) {
          globalThis.__migrationContext = { client: client.marker, options };
        }`,
      );

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      const captured = (globalThis as Record<string, unknown>)
        .__migrationContext as {
        client: string;
        options: { executionContext: Record<string, unknown> };
      };
      const { abortSignal, ...executionContext } =
        captured.options.executionContext;
      expect(abortSignal).to.be.instanceOf(AbortSignal);
      expect({
        client: captured.client,
        options: { ...captured.options, executionContext },
      }).to.deep.equal({
        client: 'target-client',
        options: {
          manifestPath: await realpath(manifestPath),
          executionContext: {
            environmentId: 'sandbox',
            inPlace: true,
            allowPrimary: false,
            contentDiffProtocolVersion: 1,
          },
        },
      });
      expect(migrationRecordWrites).to.equal(1);
    });
  }

  it('rejects mismatched manifest and wrapper runtime versions before any mutation', async () => {
    const { migrationPath } =
      await writeBoundContentMigration(migrationsDirectory);
    await writeFile(
      migrationPath,
      (await readFile(migrationPath, 'utf8')).replace(
        `runtime-v${RUNTIME_VERSION}`,
        'runtime-v16',
      ),
    );

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('unsupported format or runtime version');
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('rejects a destination binding for another profile before any mutation', async () => {
    await writeBoundContentMigration(migrationsDirectory);
    actualSiteId = 'wrong-site';
    let migrationModelCreates = 0;
    targetClient.itemTypes = {
      find: async () => {
        throw apiError(404, 'Not Found');
      },
      create: async () => {
        migrationModelCreates += 1;
        return exactMigrationModel();
      },
    };

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('active profile targets "wrong-site"');
    expect(forkCalls).to.deep.equal([]);
    expect(migrationModelCreates).to.equal(0);
    expect(migrationRecordWrites).to.equal(0);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
  });

  it('rejects a tampered manifest before creating a fork or tracking record', async () => {
    const { manifestPath } =
      await writeBoundContentMigration(migrationsDirectory);
    await writeFile(manifestPath, '{"tampered":true}\n');

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('manifest integrity validation failed');
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('rejects a manifest path binding that does not match the migration filename', async () => {
    const { migrationPath } =
      await writeBoundContentMigration(migrationsDirectory);
    const source = await readFile(migrationPath, 'utf8');
    await writeFile(
      migrationPath,
      source.replace(
        '1700000100_bound.plan.json',
        '1700000100_other.plan.json',
      ),
    );

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('instead of');
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('rejects a current runtime wrapper whose static binding was removed', async () => {
    const { migrationPath } =
      await writeBoundContentMigration(migrationsDirectory);
    const source = await readFile(migrationPath, 'utf8');
    await writeFile(
      migrationPath,
      source
        .split(/\r?\n/u)
        .filter((line) => !line.startsWith('// datocms-content-diff-binding '))
        .join('\n'),
    );

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'missing its required static destination binding',
    );
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('rejects a static target-site binding that was changed independently of its manifest', async () => {
    const { migrationPath } =
      await writeBoundContentMigration(migrationsDirectory);
    const source = await readFile(migrationPath, 'utf8');
    await writeFile(
      migrationPath,
      source.replace(
        '"targetSiteId":"target-site"',
        '"targetSiteId":"other-site"',
      ),
    );

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'static destination binding does not match the manifest target site',
    );
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('rejects inconsistent project-mode metadata before any mutation', async () => {
    await writeBoundContentMigration(migrationsDirectory, {
      projectMode: 'same_project',
      sourceSiteId: 'source-site',
      targetSiteId: 'target-site',
    });

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'inconsistent project-mode or endpoint metadata',
    );
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('validates destination bindings during dry runs without mutating or invoking scripts', async () => {
    await writeBoundContentMigration(migrationsDirectory);

    const { error } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --dry-run --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(forkCalls).to.deep.equal([]);
    expect(migrationRecordWrites).to.equal(0);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
  });

  it('keeps unbound runtime-v15 content migrations runnable', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000100_legacyContentDiff.js'),
      `// .datocms-content/runtime-v15\nmodule.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(1);
    expect(migrationRecordWrites).to.equal(1);
  });

  it('retains the primary guard and does not invoke a migration without --allow-primary', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_context.js'),
      `module.exports = async function () {
        globalThis.__migrationContext = 'invoked';
      };`,
    );

    const { error } = await runCommand(
      `migrations:run --source=primary --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'Running migrations on primary environment is not allowed',
    );
    expect((globalThis as Record<string, unknown>).__migrationContext).to.equal(
      undefined,
    );
    expect(builtEnvironmentIds).to.deep.equal([undefined]);
  });

  it('rejects --allow-primary unless --in-place is also explicit', async () => {
    const { error } = await runCommand(
      `migrations:run --source=primary --allow-primary --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('--allow-primary');
    expect(error?.message).to.contain('--in-place');
    expect(builtEnvironmentIds).to.deep.equal([]);
  });

  it('rejects the reserved content-diff ledger as the configured migrations model before any CMA call', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: {
          default: {
            migrations: {
              directory: 'migrations',
              modelApiKey: 'datocms_content_diff',
            },
          },
        },
      }),
    );

    const { error } = await runCommand(
      `migrations:run --source=source --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'reserved for the content-diff legacy-ID mapping ledger',
    );
    expect(builtEnvironmentIds).to.deep.equal([undefined]);
    expect(forkCalls).to.deep.equal([]);
  });

  it('rejects a reserved --migrations-model override before any CMA call', async () => {
    const { error } = await runCommand(
      `migrations:run --source=source --migrations-model=datocms_content_diff --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'reserved for the content-diff legacy-ID mapping ledger',
    );
    expect(builtEnvironmentIds).to.deep.equal([undefined]);
    expect(forkCalls).to.deep.equal([]);
  });

  it('fails closed before invoking scripts when the tracker lookup API fails', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    targetClient.itemTypes = {
      find: async () => {
        throw apiError(403, 'Forbidden');
      },
    };

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('403 Forbidden');
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('fails closed before invoking scripts when tracker model creation fails', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    targetClient.itemTypes = {
      find: async () => {
        throw apiError(404, 'Not Found');
      },
      create: async () => {
        throw apiError(403, 'Forbidden');
      },
    };

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('403 Forbidden');
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('fails closed before invoking scripts when tracker fields cannot be read', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    targetClient.fields = {
      list: async () => {
        throw apiError(403, 'Forbidden');
      },
    };

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('403 Forbidden');
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('keeps compatible custom tracking models with optional audit fields working', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    targetClient.itemTypes = {
      find: async () => ({
        ...exactMigrationModel(),
        name: 'User-owned model',
      }),
    };
    targetClient.fields = {
      list: async () => [
        {
          ...exactMigrationNameField(),
          label: 'Applied migration',
          validators: {},
        },
        {
          id: 'optional-audit-note',
          type: 'field',
          label: 'Audit note',
          api_key: 'audit_note',
          field_type: 'string',
          localized: false,
          default_value: null,
          validators: {},
        },
      ],
    };

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(1);
    expect(migrationRecordWrites).to.equal(1);
  });

  it('rejects an unusable custom tracker before invoking scripts', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    targetClient.fields = {
      list: async () => [
        exactMigrationNameField(),
        {
          id: 'required-audit-note',
          type: 'field',
          label: 'Audit note',
          api_key: 'audit_note',
          field_type: 'string',
          localized: false,
          default_value: null,
          validators: { required: {} },
        },
      ],
    };

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'cannot safely track migration file names',
    );
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('does not repair a fieldless tracker when migration history already exists', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    let fieldCreateCalls = 0;
    targetClient.fields = {
      list: async () => [],
      create: async () => {
        fieldCreateCalls += 1;
        return exactMigrationNameField();
      },
    };
    Object.assign(targetClient.items as object, {
      async *listPagedIterator() {
        yield { id: 'orphaned-migration-record' };
      },
    });

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'cannot safely reconstruct the lost migration history',
    );
    expect(fieldCreateCalls).to.equal(0);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('fails closed when an existing tracker record has no migration name', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    Object.assign(targetClient.items as object, {
      async *listPagedIterator() {
        yield { id: 'invalid-migration-record', name: null };
      },
    });

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'cannot safely determine which scripts already ran',
    );
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('fails closed on field creation and resumes an exact partial tracker on rerun', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    const model = exactMigrationModel();
    const nameField = exactMigrationNameField();
    let modelExists = false;
    let fieldExists = false;
    let modelCreateCalls = 0;
    let fieldCreateCalls = 0;
    targetClient.itemTypes = {
      find: async () => {
        if (!modelExists) throw apiError(404, 'Not Found');
        return model;
      },
      create: async () => {
        modelCreateCalls += 1;
        modelExists = true;
        return model;
      },
    };
    targetClient.fields = {
      list: async () => (fieldExists ? [nameField] : []),
      create: async () => {
        fieldCreateCalls += 1;
        if (fieldCreateCalls === 1) throw apiError(403, 'Forbidden');
        fieldExists = true;
        return nameField;
      },
    };

    const firstRun = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(firstRun.error?.message).to.contain('403 Forbidden');
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
    expect(modelCreateCalls).to.equal(1);
    expect(fieldCreateCalls).to.equal(1);

    const secondRun = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(secondRun.error).to.equal(undefined);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(1);
    expect(migrationRecordWrites).to.equal(1);
    expect(modelCreateCalls).to.equal(1);
    expect(fieldCreateCalls).to.equal(2);
  });

  it('keeps dry-run read-only when the tracker model is absent', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    let modelCreateCalls = 0;
    targetClient.itemTypes = {
      find: async () => {
        throw apiError(404, 'Not Found');
      },
      create: async () => {
        modelCreateCalls += 1;
        return exactMigrationModel();
      },
    };

    const { error, stdout } = await runCommand(
      `migrations:run --source=source --destination=generated-fork --dry-run --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(stdout).to.contain(
      'Migrations will be simulated (dry run) in "generated-fork" sandbox environment',
    );
    expect(stdout).to.contain(
      'Successfully simulated 1 migration scripts (dry run, no changes were made)',
    );
    expect(forkCalls).to.deep.equal([]);
    expect(modelCreateCalls).to.equal(0);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
    expect(migrationRecordWrites).to.equal(0);
  });

  it('treats a tracker lookup reporting a CMA not-found code as a missing tracker', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    let modelExists = false;
    let modelCreateCalls = 0;
    targetClient.itemTypes = {
      find: async () => {
        if (!modelExists) throw apiErrorWithCode(422, 'NOT_FOUND');
        return exactMigrationModel();
      },
      create: async () => {
        modelCreateCalls += 1;
        modelExists = true;
        return exactMigrationModel();
      },
    };
    targetClient.fields = {
      list: async () => [exactMigrationNameField()],
      create: async () => exactMigrationNameField(),
    };

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error).to.equal(undefined);
    expect(modelCreateCalls).to.equal(1);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(1);
    expect(migrationRecordWrites).to.equal(1);
  });

  it('still fails closed on a tracker lookup error that only carries a not-found error ID', async () => {
    await writeFile(
      join(migrationsDirectory, '1700000000_count.js'),
      `module.exports = async function () {
        globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
      };`,
    );
    let modelCreateCalls = 0;
    targetClient.itemTypes = {
      find: async () => {
        throw apiErrorWithCode(422, 'INVALID_FIELD', 'NOT_FOUND');
      },
      create: async () => {
        modelCreateCalls += 1;
        return exactMigrationModel();
      },
    };

    const { error } = await runCommand(
      `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('INVALID_FIELD');
    expect(modelCreateCalls).to.equal(0);
    expect(
      (globalThis as Record<string, unknown>).__migrationInvocations,
    ).to.equal(undefined);
  });

  for (const [label, validators] of [
    ['an extra validator', { required: {}, unique: {} }],
    ['a configured required validator', { required: { x: 1 } }],
    [
      'a non-JSON validator value',
      { required: {}, length: { min: Number.NaN } },
    ],
  ] as const) {
    it(`rejects a created tracker with ${label} through the shared tracking-model contract`, async () => {
      await writeFile(
        join(migrationsDirectory, '1700000000_count.js'),
        `module.exports = async function () {
          globalThis.__migrationInvocations = (globalThis.__migrationInvocations || 0) + 1;
        };`,
      );
      targetClient.itemTypes = {
        find: async () => {
          throw apiError(404, 'Not Found');
        },
        create: async () => exactMigrationModel(),
      };
      targetClient.fields = {
        list: async () => [{ ...exactMigrationNameField(), validators }],
        create: async () => exactMigrationNameField(),
      };

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error?.message).to.contain(
        'Configured migrations model "schema_migration" (migration-model) cannot safely track migration file names.',
      );
      expect(
        (globalThis as Record<string, unknown>).__migrationInvocations,
      ).to.equal(undefined);
      expect(migrationRecordWrites).to.equal(0);
      expect(lockCreateBodies).to.deep.equal([]);
    });
  }

  it('redacts the API token from root, source, tracker, and migration client logs', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'migrations-run-verbose-credential';
    await writeFile(
      join(migrationsDirectory, '1700000000_readSite.js'),
      `module.exports = async function (client) {
        await client.site.find();
      };`,
    );
    const server = await startFakeCmaServer(migrationRunRoute());

    try {
      const { stdout, stderr, error } = await runCommand(
        `migrations:run --source=sandbox --destination=generated-fork --api-token=${credential} --base-url=${server.baseUrl} --log-level=BODY_AND_HEADERS --log-mode=stdout --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expectAuthenticatedWith(server.requests, [credential]);
      const calls = server.requests.map(
        ({ method, path, headers }) =>
          `${method} ${path} ${headers['x-environment'] ?? '(root)'}`,
      );
      expect(calls).to.include.members([
        'POST /environments/sandbox/fork (root)',
        'GET /item-types/schema_migration sandbox',
        'POST /item-types generated-fork',
        'GET /site generated-fork',
        'POST /items generated-fork',
      ]);
      expectRedactedCmaOutput(`${stdout}${stderr}`, [credential]);
    } finally {
      await server.close();
    }
  });

  it('redacts the API token from uncaught tracker errors', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'migrations-run-error-credential';
    await writeFile(
      join(migrationsDirectory, '1700000000_noop.js'),
      'module.exports = async function () {};',
    );
    const route = migrationRunRoute();
    const server = await startFakeCmaServer((request) =>
      request.method === 'POST' &&
      request.path === '/items' &&
      !isLockCreateRequest(request)
        ? apiErrorResponse(422, 'INVALID_FIELD')
        : route(request),
    );

    try {
      const { stdout, stderr, error } = await runCommand(
        `migrations:run --source=sandbox --in-place --api-token=${credential} --base-url=${server.baseUrl} --config-file=${configPath}`,
      );

      expect(error?.message).to.contain('422');
      expectAuthenticatedWith(server.requests, [credential]);
      expect(
        server.requests.some(
          ({ method, path }) =>
            method === 'DELETE' &&
            path === `/items/${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
        ),
      ).to.equal(true);
      expect(stdout).to.contain("name: 'ApiError'");
      expect(`${stdout}${stderr}${error?.stack}`).not.to.contain(credential);
    } finally {
      await server.close();
    }
  });

  it('redacts the API token from the stack printed for a failed migration', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'migrations-run-failure-credential';
    await writeFile(
      join(migrationsDirectory, '1700000000_leakToken.js'),
      `module.exports = async function (client) {
        await client.site.find();
        throw new Error('Rejected token ' + client.config.apiToken);
      };`,
    );
    const server = await startFakeCmaServer(migrationRunRoute());

    try {
      const { stdout, stderr, error } = await runCommand(
        `migrations:run --source=sandbox --in-place --api-token=${credential} --base-url=${server.baseUrl} --config-file=${configPath}`,
      );

      expect(error?.message).to.contain(
        'Migration "1700000000_leakToken.js" failed',
      );
      expectAuthenticatedWith(server.requests, [credential]);
      expect(
        server.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.path === '/items' &&
            !isLockCreateRequest(request),
        ),
      ).to.equal(false);
      expect(
        server.requests.some(
          ({ method, path }) =>
            method === 'DELETE' &&
            path === `/items/${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
        ),
      ).to.equal(true);
      expect(stdout).to.match(
        /----\nError: Rejected token \[REDACTED\]\n\s+at [^\n]+[\s\S]*\n----/u,
      );
      expect(`${stdout}${stderr}${error?.stack}`).not.to.contain(credential);
    } finally {
      await server.close();
    }
  });
  async function writeMigration(filename: string, body = ''): Promise<void> {
    await writeFile(
      join(migrationsDirectory, filename),
      `module.exports = async function (client, context) {
  globalThis.__runEvents.push(${JSON.stringify(`script ${filename}`)});
${body}
};`,
    );
  }

  function lockItemsResource(): Record<string, (...args: never[]) => unknown> {
    return targetClient.items as Record<string, (...args: never[]) => unknown>;
  }

  function createdLockRunId(): string {
    expect(lockCreateBodies).to.have.length.greaterThan(0);
    return lockMetadataOf(lockCreateBodies[0].name).runId;
  }

  describe('run lock', () => {
    it('locks an in-place target with the fixed ID before the first script and releases it after the last history write', async () => {
      await writeMigration('1700000000_a.js');
      await writeMigration('1700000001_b.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'script 1700000001_b.js',
        'history 1700000001_b.js',
        'lock-destroy',
      ]);
      expect(lockCreateBodies).to.have.length(1);
      const [body] = lockCreateBodies;
      expect(body.id).to.equal(MIGRATIONS_RUN_LOCK_RECORD_ID);
      expect(body.item_type).to.deep.equal({
        type: 'item_type',
        id: 'migration-model',
      });
      expect(String(body.name).startsWith(MIGRATIONS_RUN_LOCK_NAME_PREFIX)).to
        .be.true;
      const metadata = lockMetadataOf(body.name);
      expect(metadata).to.include({
        v: 1,
        environmentId: 'sandbox',
        mode: 'in-place',
        pid: process.pid,
        pending: 2,
        first: '1700000000_a.js',
      });
      expect(metadata.runId).to.match(/^[0-9a-f]{16}$/u);
      expect(metadata).not.to.have.property('sourceEnvironmentId');
      expect(metadata).not.to.have.property('user');
      expect(heldLock).to.equal(null);
    });

    it('checks the fork source read-only and locks only the new destination', async () => {
      const sourceCalls: string[] = [];
      environmentClients.source = {
        ...targetClient,
        items: {
          async *listPagedIterator() {},
          find: async (id: string) => {
            sourceCalls.push(`find ${id}`);
            throw apiError(404, 'Not Found');
          },
          create: async () => {
            sourceCalls.push('create');
            return {};
          },
          destroy: async () => {
            sourceCalls.push('destroy');
            return {};
          },
        },
      };
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(sourceCalls).to.deep.equal([
        `find ${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
      ]);
      expect(forkCalls).to.deep.equal([
        { sourceId: 'source', destinationId: 'generated-fork' },
      ]);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
      expect(lockMetadataOf(lockCreateBodies[0].name)).to.include({
        environmentId: 'generated-fork',
        mode: 'fork',
        sourceEnvironmentId: 'source',
      });
    });

    it('refuses a lock held by another run without running, recording, or clearing anything', async () => {
      heldLock = lockItem();
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCKED');
      expect(exitCodeOf(error)).to.equal(1);
      expect(error?.message).to.contain(
        'Environment "sandbox" is locked by another migrations:run (run feedfacefeedface, started ',
      );
      expect(error?.message).to.contain(
        '(5 min ago), on host "other-host", pid 31337, 3 pending migration(s) starting with "1700000000_other.js"',
      );
      expect(error?.message).to.contain('No migration was executed.');
      expect(suggestionsOf(error)).to.deep.equal([
        'Wait for that run to finish, then retry.',
        `If that run is no longer active, clear the stale lock with "${BIN} migrations:run --source=sandbox --in-place --config-file=${configPath} --force-unlock=feedfacefeedface".`,
      ]);
      expect(runEvents).to.deep.equal([]);
      expect(migrationRecordWrites).to.equal(0);
      expect(lockDestroyCalls).to.equal(0);
    });

    it('includes --allow-primary in the clearing command for a locked primary', async () => {
      heldLock = lockItem(foreignLockMetadata({ environmentId: 'primary' }));
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=primary --in-place --allow-primary --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCKED');
      expect(suggestionsOf(error)).to.include(
        `If that run is no longer active, clear the stale lock with "${BIN} migrations:run --source=primary --in-place --allow-primary --config-file=${configPath} --force-unlock=feedfacefeedface".`,
      );
      expect(runEvents).to.deep.equal([]);
    });

    it('names a custom tracking model in the clearing command, since the lock lives there', async () => {
      heldLock = lockItem();
      (targetClient.itemTypes as Record<string, unknown>).find = async () => ({
        ...exactMigrationModel(),
        api_key: 'deploy_history',
      });
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --migrations-model=deploy_history --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCKED');
      expect(suggestionsOf(error)).to.include(
        `If that run is no longer active, clear the stale lock with "${BIN} migrations:run --source=sandbox --in-place --config-file=${configPath} --migrations-model=deploy_history --force-unlock=feedfacefeedface".`,
      );
      expect(runEvents).to.deep.equal([]);
    });

    it('holds the lock when a rejected create was actually stored with its own run ID', async () => {
      const items = lockItemsResource();
      const create = items.create as (
        body: Record<string, unknown>,
      ) => Promise<unknown>;
      items.create = (async (body: Record<string, unknown>) => {
        const created = await create(body);
        if (body.id === MIGRATIONS_RUN_LOCK_RECORD_ID) {
          throw apiError(422, 'Unprocessable Entity');
        }
        return created;
      }) as never;
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
      expect(createdLockRunId()).to.match(/^[0-9a-f]{16}$/u);
    });

    it('surfaces the original create error when no lock exists afterwards', async () => {
      const items = lockItemsResource();
      const create = items.create as (
        body: Record<string, unknown>,
      ) => Promise<unknown>;
      items.create = (async (body: Record<string, unknown>) => {
        if (body.id === MIGRATIONS_RUN_LOCK_RECORD_ID) {
          throw new Error('name failed its format validator');
        }
        return create(body);
      }) as never;
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCK_CREATE_FAILED');
      expect(error?.message).to.equal(
        'Could not create the migrations:run lock record in model "schema_migration": name failed its format validator. No migration was executed. Retry: another run may have released its lock at the same moment. If this keeps failing, the "name" field must accept arbitrary strings of up to 255 characters.',
      );
      expect(runEvents).to.deep.equal([]);
      expect(migrationRecordWrites).to.equal(0);
    });

    for (const forceUnlock of ['', ' --force-unlock=feedfacefeedface']) {
      it(`refuses the reserved ID under another model${
        forceUnlock ? ' even with --force-unlock' : ''
      }`, async () => {
        heldLock = lockItem(foreignLockMetadata(), 'other-model');
        await writeMigration('1700000000_a.js');

        const { error } = await runCommand(
          `migrations:run --source=sandbox --in-place${forceUnlock} --config-file=${configPath}`,
        );

        expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCK_CONFLICT');
        expect(error?.message).to.contain(
          `Record ID ${MIGRATIONS_RUN_LOCK_RECORD_ID}, reserved for the migrations:run lock, belongs to another model.`,
        );
        expect(lockDestroyCalls).to.equal(0);
        expect(runEvents).to.deep.equal([]);
      });
    }

    it('ignores the lock record in migration history', async () => {
      Object.assign(targetClient.items as object, {
        async *listPagedIterator() {
          yield {
            id: MIGRATIONS_RUN_LOCK_RECORD_ID,
            name: encodeMigrationsRunLockName(foreignLockMetadata()),
          };
          yield { id: 'history-a', name: '1700000000_a.js' };
        },
      });
      await writeMigration('1700000000_a.js');
      await writeMigration('1700000001_b.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000001_b.js',
        'history 1700000001_b.js',
        'lock-destroy',
      ]);
    });

    it('fails closed on a lock-prefixed history name under another ID', async () => {
      Object.assign(targetClient.items as object, {
        async *listPagedIterator() {
          yield {
            id: 'imposter',
            name: encodeMigrationsRunLockName(foreignLockMetadata()),
          };
        },
      });
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCK_CONFLICT');
      expect(error?.message).to.contain(
        'Migration tracking record "imposter" looks like a migrations:run lock but does not use the reserved lock ID.',
      );
      expect(runEvents).to.deep.equal([]);
    });

    it('re-reads history under the lock and skips scripts another run completed', async () => {
      let listCalls = 0;
      Object.assign(targetClient.items as object, {
        async *listPagedIterator() {
          listCalls += 1;
          if (listCalls > 1) yield { id: 'history-a', name: '1700000000_a.js' };
        },
      });
      await writeMigration('1700000000_a.js');
      await writeMigration('1700000001_b.js');

      const { error, stdout } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(listCalls).to.equal(2);
      expect(stdout).to.contain(
        'Skipping 1 migration script(s) completed by another run before this run acquired the lock.',
      );
      expect(stdout).to.contain('Successfully run 1 migration scripts');
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000001_b.js',
        'history 1700000001_b.js',
        'lock-destroy',
      ]);
    });

    it('releases the lock and runs nothing when another run completed everything', async () => {
      let listCalls = 0;
      Object.assign(targetClient.items as object, {
        async *listPagedIterator() {
          listCalls += 1;
          if (listCalls > 1) yield { id: 'history-a', name: '1700000000_a.js' };
        },
      });
      await writeMigration('1700000000_a.js');

      const { error, stdout } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(stdout).to.contain('No new migration scripts to run');
      expect(runEvents).to.deep.equal(['lock-create', 'lock-destroy']);
    });

    it('still releases the lock after a migration failure', async () => {
      await writeMigration('1700000000_a.js', "throw new Error('boom');");

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error?.message).to.contain('Migration "1700000000_a.js" failed');
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'lock-destroy',
      ]);
      expect(heldLock).to.equal(null);
    });

    it('keeps the migration failure when releasing the lock also fails', async () => {
      lockItemsResource().destroy = (async () => {
        throw apiError(500, 'Internal Server Error');
      }) as never;
      await writeMigration('1700000000_a.js', "throw new Error('boom');");

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );
      const runId = createdLockRunId();

      expect(error?.message).to.contain('Migration "1700000000_a.js" failed');
      expect(flat(stderr)).to.contain(
        `Could not release the run lock on "sandbox" (unlock token ${runId}):`,
      );
      expect(compact(stderr)).to.contain(
        compact(
          `clear it with "${BIN} migrations:run --source=sandbox --in-place --config-file=${configPath} --force-unlock=${runId}"`,
        ),
      );
    });

    it('exits successfully with a warning when only the release fails', async () => {
      lockItemsResource().destroy = (async () => {
        throw apiError(500, 'Internal Server Error');
      }) as never;
      await writeMigration('1700000000_a.js');

      const { error, stderr, stdout } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(stdout).to.contain('Successfully run 1 migration scripts');
      expect(flat(stderr)).to.contain(
        `Could not release the run lock on "sandbox" (unlock token ${createdLockRunId()}):`,
      );
      expect(migrationRecordWrites).to.equal(1);
    });

    it('leaves a lock that another run took over in place', async () => {
      (globalThis as Record<string, unknown>).__replaceLock = () => {
        heldLock = lockItem(foreignLockMetadata({ runId: 'bbbbbbbbbbbbbbbb' }));
      };
      await writeMigration('1700000000_a.js', 'globalThis.__replaceLock();');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(lockDestroyCalls).to.equal(0);
      expect(flat(stderr)).to.contain(
        'The run lock on "sandbox" now belongs to another run (unlock token bbbbbbbbbbbbbbbb), so this run left it in place.',
      );
    });

    it('warns when the lock was already removed before release', async () => {
      (globalThis as Record<string, unknown>).__replaceLock = () => {
        heldLock = null;
      };
      await writeMigration('1700000000_a.js', 'globalThis.__replaceLock();');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(lockDestroyCalls).to.equal(0);
      expect(flat(stderr)).to.contain(
        `The run lock on "sandbox" (unlock token ${createdLockRunId()}) had already been removed before this run released it.`,
      );
    });

    it('refuses a mismatched --force-unlock token without clearing the lock', async () => {
      heldLock = lockItem();
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --force-unlock=0000000000000000 --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_UNLOCK_TOKEN_MISMATCH');
      expect(error?.message).to.equal(
        '--force-unlock=0000000000000000 does not match the current run lock on "sandbox" (unlock token feedfacefeedface). The lock may belong to a different run than the one you inspected. No lock was cleared.',
      );
      expect(lockDestroyCalls).to.equal(0);
      expect(heldLock).not.to.equal(null);
      expect(runEvents).to.deep.equal([]);
    });

    it('clears a matching stale lock, warns, and runs under a fresh lock', async () => {
      heldLock = lockItem();
      await writeMigration('1700000000_a.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --force-unlock=feedfacefeedface --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(flat(stderr)).to.contain(
        'Cleared the run lock of run feedfacefeedface (started ',
      );
      expect(flat(stderr)).to.contain(
        'on host "other-host"). Review "sandbox" for partially applied migrations or leftover temporary schema changes before relying on it.',
      );
      expect(runEvents).to.deep.equal([
        'lock-destroy',
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
      expect(createdLockRunId()).not.to.equal('feedfacefeedface');
    });

    it('warns that --force-unlock had no effect when no lock is held', async () => {
      await writeMigration('1700000000_a.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --force-unlock=feedfacefeedface --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(flat(stderr)).to.contain(
        'No run lock was held on "sandbox"; --force-unlock had no effect.',
      );
      expect(runEvents).to.include('script 1700000000_a.js');
    });

    it('rejects --force-unlock together with --dry-run', async () => {
      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --dry-run --force-unlock=feedfacefeedface --config-file=${configPath}`,
      );

      expect(error?.message).to.contain('--force-unlock');
      expect(error?.message).to.contain('--dry-run');
      expect(builtEnvironmentIds).to.deep.equal([]);
    });

    it('only warns about a held lock during a dry run', async () => {
      heldLock = lockItem();
      await writeMigration('1700000000_a.js');

      const { error, stderr, stdout } = await runCommand(
        `migrations:run --source=sandbox --in-place --dry-run --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(flat(stderr)).to.contain(
        'Environment "sandbox" is currently locked by another migrations:run (run feedfacefeedface',
      );
      expect(flat(stderr)).to.contain(
        'a run with pending migrations would refuse to start',
      );
      expect(stdout).to.contain('Successfully simulated 1 migration scripts');
      expect(runEvents).to.deep.equal([]);
      expect(lockCreateBodies).to.deep.equal([]);
      expect(lockDestroyCalls).to.equal(0);
    });

    it('warns about a held fork source during a dry run with the fork-mode clearing command', async () => {
      heldLock = lockItem(foreignLockMetadata({ environmentId: 'source' }));
      await writeMigration('1700000000_a.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=source --destination=review --dry-run --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(compact(stderr)).to.contain(
        compact(
          `"${BIN} migrations:run --source=source --destination=review --config-file=${configPath} --force-unlock=feedfacefeedface".`,
        ),
      );
      expect(forkCalls).to.deep.equal([]);
      expect(runEvents).to.deep.equal([]);
    });

    it('warns about a held lock and succeeds when nothing is pending', async () => {
      heldLock = lockItem();

      const { error, stderr, stdout } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(stdout).to.contain('No new migration scripts to run');
      expect(flat(stderr)).to.contain(
        'Environment "sandbox" is currently locked by another migrations:run',
      );
      expect(runEvents).to.deep.equal([]);
    });

    it('refuses to fork a locked source before creating any environment', async () => {
      heldLock = lockItem(foreignLockMetadata({ environmentId: 'source' }));
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_SOURCE_LOCKED');
      expect(error?.message).to.contain(
        'Cannot fork "source": another migrations:run is in progress there (run feedfacefeedface',
      );
      expect(error?.message).to.contain(
        'Forking now would copy a partially migrated environment. No environment was created.',
      );
      expect(suggestionsOf(error)).to.include(
        `If that run is no longer active, clear the stale lock with "${BIN} migrations:run --source=source --destination=generated-fork --config-file=${configPath} --force-unlock=feedfacefeedface".`,
      );
      expect(forkCalls).to.deep.equal([]);
      expect(runEvents).to.deep.equal([]);
    });

    it('refuses a new fork that copied a held lock and suggests destroying it', async () => {
      environmentClients.source = {
        ...targetClient,
        items: {
          async *listPagedIterator() {},
          find: async () => {
            throw apiError(404, 'Not Found');
          },
        },
      };
      heldLock = lockItem(foreignLockMetadata({ environmentId: 'source' }));
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_FORK_COPIED_LOCK');
      expect(error?.message).to.equal(
        'The new environment "generated-fork" was copied from "source" while run feedfacefeedface held its migration lock, so it may contain a partially migrated state. No migration was executed in "generated-fork".',
      );
      expect(suggestionsOf(error)).to.deep.equal([
        `Destroy it with "${BIN} environments:destroy generated-fork", then retry after the other run finishes.`,
      ]);
      expect(forkCalls).to.have.length(1);
      expect(runEvents).to.deep.equal(['lock-create']);
      expect(lockDestroyCalls).to.equal(0);
      expect(migrationRecordWrites).to.equal(0);
    });

    it('marks a lock copied from another environment', async () => {
      heldLock = lockItem(foreignLockMetadata({ environmentId: 'main' }));
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCKED');
      expect(error?.message).to.contain('copied from environment "main"');
      expect(suggestionsOf(error)).to.include(
        'This lock was copied from environment "main" by a fork, promote or rename while that run was in progress; the content may be partially migrated.',
      );
    });

    it('continues with a tracking model created concurrently by another run', async () => {
      let findCalls = 0;
      let modelCreateCalls = 0;
      let fieldCreateCalls = 0;
      targetClient.itemTypes = {
        find: async () => {
          findCalls += 1;
          if (findCalls <= 2) throw apiError(404, 'Not Found');
          return exactMigrationModel();
        },
        create: async () => {
          modelCreateCalls += 1;
          throw apiError(422, 'Unprocessable Entity');
        },
      };
      targetClient.fields = {
        list: async () => [exactMigrationNameField()],
        create: async () => {
          fieldCreateCalls += 1;
          return exactMigrationNameField();
        },
      };
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(modelCreateCalls).to.equal(1);
      expect(fieldCreateCalls).to.equal(0);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
    });

    it('waits for the name field of a tracking model another run is still creating', async () => {
      let findCalls = 0;
      let fieldListCalls = 0;
      targetClient.itemTypes = {
        find: async () => {
          findCalls += 1;
          if (findCalls <= 2) throw apiError(404, 'Not Found');
          return exactMigrationModel();
        },
        create: async () => {
          throw apiError(422, 'Unprocessable Entity');
        },
      };
      targetClient.fields = {
        list: async () => {
          fieldListCalls += 1;
          return fieldListCalls <= 2 ? [] : [exactMigrationNameField()];
        },
        create: async () => {
          throw new Error('the losing run must not add the name field');
        },
      };
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(sleeps).to.deep.equal([500, 500]);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
    });

    it('stops waiting when a concurrently created tracking model never gets its name field', async () => {
      let findCalls = 0;
      targetClient.itemTypes = {
        find: async () => {
          findCalls += 1;
          if (findCalls <= 2) throw apiError(404, 'Not Found');
          return exactMigrationModel();
        },
        create: async () => {
          throw apiError(422, 'Unprocessable Entity');
        },
      };
      targetClient.fields = { list: async () => [] };
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error?.message).to.equal(
        `Another migrations:run is creating the "schema_migration" migrations model (${
          exactMigrationModel().id
        }), but its "name" field did not appear in time. No migration was executed. Retry once that run has finished; if no run is active, rerun migrations:run to complete the model.`,
      );
      expect(sleeps).to.have.length(9);
      expect(runEvents).to.deep.equal([]);
    });

    it('still fails when a concurrently created tracking model is not exact', async () => {
      let findCalls = 0;
      targetClient.itemTypes = {
        find: async () => {
          findCalls += 1;
          if (findCalls <= 2) throw apiError(404, 'Not Found');
          return exactMigrationModel();
        },
        create: async () => {
          throw apiError(422, 'Unprocessable Entity');
        },
      };
      targetClient.fields = {
        list: async () => [
          { ...exactMigrationNameField(), field_type: 'text' },
        ],
      };
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error?.message).to.contain('422');
      expect(sleeps).to.deep.equal([]);
      expect(runEvents).to.deep.equal([]);
    });

    function fieldCreateRaceClient(
      fieldLists: CmaClient.ApiTypes.Field[][],
      options: Readonly<{ modelExists: boolean }>,
    ): { fieldCreateCalls: () => number } {
      let findCalls = 0;
      let fieldListCalls = 0;
      let fieldCreateCalls = 0;
      targetClient.itemTypes = {
        find: async () => {
          findCalls += 1;
          if (!options.modelExists && findCalls <= 2) {
            throw apiError(404, 'Not Found');
          }
          return exactMigrationModel();
        },
        create: async () => exactMigrationModel(),
      };
      targetClient.fields = {
        list: async () => {
          const fields =
            fieldLists[Math.min(fieldListCalls, fieldLists.length - 1)];
          fieldListCalls += 1;
          return fields;
        },
        create: async () => {
          fieldCreateCalls += 1;
          throw apiError(422, 'Unprocessable Entity');
        },
      };
      return { fieldCreateCalls: () => fieldCreateCalls };
    }

    it('continues when another run adds the name field right after this run created the model', async () => {
      const race = fieldCreateRaceClient([[exactMigrationNameField()]], {
        modelExists: false,
      });
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(race.fieldCreateCalls()).to.equal(1);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
    });

    it('continues when another run adds the name field while this run completes a fieldless model', async () => {
      // The source read and the upsert read both see a fieldless model.
      const race = fieldCreateRaceClient(
        [[], [], [exactMigrationNameField()]],
        { modelExists: true },
      );
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(race.fieldCreateCalls()).to.equal(1);
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
    });

    it('rethrows a rejected name field when the re-listed model is still not exact', async () => {
      const race = fieldCreateRaceClient([[]], { modelExists: false });
      await writeMigration('1700000000_a.js');

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.be.instanceOf(CmaClient.ApiError);
      expect((error as CmaClient.ApiError).response.status).to.equal(422);
      expect(race.fieldCreateCalls()).to.equal(1);
      expect(runEvents).to.deep.equal([]);
    });

    describe('printed commands repeat the explicit selection', () => {
      let clientDirectory: string;
      let tsconfigPath: string;

      beforeEach(async () => {
        clientDirectory = join(temporaryDirectory, 'client migrations');
        tsconfigPath = join(temporaryDirectory, 'tsconfig.migrations.json');
        await mkdir(clientDirectory);
        await writeFile(tsconfigPath, '{}');
        await writeFile(
          join(clientDirectory, '1700000000_client.js'),
          'module.exports = async function () {};',
        );
        await writeFile(
          configPath,
          JSON.stringify({
            profiles: {
              default: { migrations: { directory: 'migrations' } },
              client: { migrations: { directory: 'migrations' } },
            },
          }),
        );
      });

      const selection = () =>
        `--profile=client --config-file=${configPath} --migrations-dir='${clientDirectory}' --migrations-model=schema_migration --migrations-tsconfig=${tsconfigPath}`;
      const selectionFlags = () => [
        '--profile=client',
        `--config-file=${configPath}`,
        `--migrations-dir="${clientDirectory}"`,
        '--migrations-model=schema_migration',
        `--migrations-tsconfig=${tsconfigPath}`,
        '--api-token=explicit-token-value',
      ];

      it('in the locked error, with a reminder to add the --api-token', async () => {
        heldLock = lockItem();

        const { error } = await runCommand([
          'migrations:run',
          '--source=sandbox',
          '--in-place',
          ...selectionFlags(),
        ]);

        expect(codeOf(error)).to.equal('MIGRATIONS_RUN_LOCKED');
        expect(suggestionsOf(error)).to.include(
          `If that run is no longer active, clear the stale lock with "${BIN} migrations:run --source=sandbox --in-place ${selection()} --force-unlock=feedfacefeedface", adding the same --api-token you passed to this run.`,
        );
        expect(JSON.stringify(suggestionsOf(error))).not.to.contain(
          'explicit-token-value',
        );
        expect(runEvents).to.deep.equal([]);
      });

      it('in the dry-run warning about a held lock', async () => {
        heldLock = lockItem();

        const { error, stderr } = await runCommand([
          'migrations:run',
          '--source=sandbox',
          '--in-place',
          '--dry-run',
          ...selectionFlags(),
        ]);

        expect(error).to.equal(undefined);
        expect(compact(stderr)).to.contain(
          compact(
            `clear the lock with "${BIN} migrations:run --source=sandbox --in-place ${selection()} --force-unlock=feedfacefeedface", adding the same --api-token you passed to this run.`,
          ),
        );
        expect(stderr).not.to.contain('explicit-token-value');
      });

      it('when --profile comes from DATOCMS_PROFILE', async () => {
        heldLock = lockItem();
        await writeMigration('1700000000_a.js');
        const previous = process.env.DATOCMS_PROFILE;
        process.env.DATOCMS_PROFILE = 'client';
        try {
          const { error } = await runCommand(
            `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
          );

          expect(suggestionsOf(error)).to.include(
            `If that run is no longer active, clear the stale lock with "${BIN} migrations:run --source=sandbox --in-place --profile=client --config-file=${configPath} --force-unlock=feedfacefeedface".`,
          );
        } finally {
          if (previous === undefined) {
            Reflect.deleteProperty(process.env, 'DATOCMS_PROFILE');
          } else {
            process.env.DATOCMS_PROFILE = previous;
          }
        }
      });
    });

    it('treats a lock whose metadata carries terminal control characters as unreadable and never prints them', async () => {
      const esc = String.fromCharCode(27);
      const bell = String.fromCharCode(7);
      const name = `${MIGRATIONS_RUN_LOCK_NAME_PREFIX}${JSON.stringify({
        ...foreignLockMetadata(),
        host: `${esc}]52;c;Y3VybCBldmlsfHNo${bell}${esc}[2K\rbuild-box`,
      })}`;
      heldLock = { ...lockItem(), name };
      const token = createHash('sha256')
        .update(name)
        .digest('hex')
        .slice(0, 16);
      await writeMigration('1700000000_a.js');

      const locked = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(codeOf(locked.error)).to.equal('MIGRATIONS_RUN_LOCKED');
      expect(locked.error?.message).to.contain(
        `(unreadable lock metadata, unlock token ${token}, created `,
      );
      for (const output of [
        locked.error?.message ?? '',
        JSON.stringify(suggestionsOf(locked.error)),
        locked.stdout,
        locked.stderr,
      ]) {
        expect(output).not.to.contain(esc);
        expect(output).not.to.contain('build-box');
      }

      const cleared = await runCommand(
        `migrations:run --source=sandbox --in-place --force-unlock=${token} --config-file=${configPath}`,
      );

      expect(cleared.error).to.equal(undefined);
      expect(flat(cleared.stderr)).to.contain(
        `Cleared the run lock of run ${token} (started `,
      );
      expect(cleared.stderr).not.to.contain(esc);
      expect(cleared.stderr).not.to.contain('build-box');
    });
  });

  describe('interruption', () => {
    it('stops a cooperative content-diff script cleanly with exit 130 and releases the lock', async () => {
      await writeBoundContentMigration(migrationsDirectory, {
        body: `  globalThis.__abortSignalSeen = context.abortSignal instanceof AbortSignal;
  process.emit('SIGINT');
  if (context.abortSignal.aborted) {
    throw Object.assign(new Error('Content migration was interrupted'), { code: 'MIGRATION_INTERRUPTED' });
  }`,
      });
      await writeMigration('1700000200_after.js');

      const { error, stdout, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(130);
      expect(codeOf(error)).to.equal('MIGRATION_INTERRUPTED');
      expect(error?.message).to.equal(
        'Migration "1700000100_bound.js" was interrupted by SIGINT and stopped safely. Rerun migrations:run to resume.',
      );
      expect(flat(stderr)).to.contain(
        'Received SIGINT. Stopping "1700000100_bound.js" safely: the current CMA request will finish and temporary schema changes will be restored. Press Ctrl-C again to exit immediately (not recommended).',
      );
      expect(stdout).not.to.contain('----');
      expect(
        (globalThis as Record<string, unknown>).__abortSignalSeen,
      ).to.equal(true);
      expect(migrationRecordWrites).to.equal(0);
      expect(runEvents).to.deep.equal(['lock-create', 'lock-destroy']);
      expect(forcedExits).to.deep.equal([]);
    });

    it('lets an ordinary script finish, records it, and stops before the next one', async () => {
      await writeMigration('1700000000_a.js', "process.emit('SIGINT');");
      await writeMigration('1700000001_b.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(130);
      expect(codeOf(error)).to.equal('MIGRATIONS_RUN_INTERRUPTED');
      expect(error?.message).to.equal(
        'Interrupted by SIGINT after "1700000000_a.js" completed; 1 remaining migration(s) were not run. Rerun migrations:run to continue.',
      );
      expect(flat(stderr)).to.contain(
        'Received SIGINT. Migration "1700000000_a.js" cannot be interrupted safely; migrations:run will stop after it finishes and run no further migrations. Press Ctrl-C again to exit immediately.',
      );
      expect(runEvents).to.deep.equal([
        'lock-create',
        'script 1700000000_a.js',
        'history 1700000000_a.js',
        'lock-destroy',
      ]);
    });

    it('names the in-place command for the new fork after a fork-mode run stops', async () => {
      await writeMigration('1700000000_a.js', "process.emit('SIGINT');");
      await writeMigration('1700000001_b.js');

      const { error } = await runCommand(
        `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(130);
      expect(error?.message).to.equal(
        `Interrupted by SIGINT after "1700000000_a.js" completed; 1 remaining migration(s) were not run. Run "${BIN} migrations:run --source=generated-fork --in-place --config-file=${configPath}" to continue in "generated-fork"; rerunning the original command would try to create that fork again.`,
      );
      expect(forkCalls).to.have.length(1);
    });

    it('names the in-place command for the new fork after a cooperative stop in fork mode', async () => {
      await writeBoundContentMigration(migrationsDirectory, {
        body: `  process.emit('SIGINT');
  throw Object.assign(new Error('Content migration was interrupted'), { code: 'MIGRATION_INTERRUPTED' });`,
      });

      const { error } = await runCommand(
        `migrations:run --source=source --destination=generated-fork --api-token=explicit-token-value --config-file=${configPath}`,
      );

      expect(codeOf(error)).to.equal('MIGRATION_INTERRUPTED');
      expect(error?.message).to.equal(
        `Migration "1700000100_bound.js" was interrupted by SIGINT and stopped safely. Run "${BIN} migrations:run --source=generated-fork --in-place --config-file=${configPath}" (with the same --api-token you passed to this run) to resume in "generated-fork"; rerunning the original command would try to create that fork again.`,
      );
      expect(error?.message).not.to.contain('explicit-token-value');
    });

    it('uses exit 143 for a graceful SIGTERM stop', async () => {
      await writeMigration('1700000000_a.js', "process.emit('SIGTERM');");
      await writeMigration('1700000001_b.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(143);
      expect(error?.message).to.contain('Interrupted by SIGTERM after');
      expect(flat(stderr)).to.contain(
        'Send SIGTERM again to exit immediately.',
      );
      expect(runEvents).not.to.include('script 1700000001_b.js');
    });

    it('exits 0 with a note when the signal arrives during the last script', async () => {
      await writeMigration('1700000000_a.js', "process.emit('SIGINT');");

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(flat(stderr)).to.contain(
        'Received SIGINT, but every pending migration completed; there was nothing left to stop.',
      );
      expect(migrationRecordWrites).to.equal(1);
      expect(heldLock).to.equal(null);
    });

    it('stops before the first script when the signal arrives after acquiring the lock', async () => {
      let listCalls = 0;
      Object.assign(targetClient.items as object, {
        async *listPagedIterator() {
          listCalls += 1;
          if (listCalls > 1) process.emit('SIGINT');
          yield* [];
        },
      });
      await writeMigration('1700000000_a.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(130);
      expect(error?.message).to.equal(
        'Interrupted by SIGINT before any migration ran; 1 pending migration(s) were not run. Rerun migrations:run to continue.',
      );
      expect(flat(stderr)).to.contain(
        'Received SIGINT. migrations:run will stop before the next migration and release its run lock.',
      );
      expect(runEvents).to.deep.equal(['lock-create', 'lock-destroy']);
    });

    it('finishes releasing the lock when the first signal arrives during release', async () => {
      const items = lockItemsResource();
      const destroy = items.destroy as (id: string) => Promise<unknown>;
      items.destroy = (async (id: string) => {
        process.emit('SIGINT');
        return destroy(id);
      }) as never;
      await writeMigration('1700000000_a.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(flat(stderr)).to.contain(
        'Received SIGINT while releasing the run lock; finishing the release.',
      );
      expect(heldLock).to.equal(null);
    });

    it('shows the first-signal notice while the migration spinner is still running', () => {
      const written: string[] = [];
      const realWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      const command = Object.create(MigrationRunCommand.prototype);
      command.logToStderr = (message: string) => {
        process.stderr.write(`${message}\n`);
      };
      try {
        // The runner shows this spinner for the whole migration; it buffers
        // stderr until it stops.
        oclif.ux.action.start('Running migration "1700000000_a.js"');
        Reflect.apply(
          Reflect.get(command, 'writeInterruptionNotice'),
          command,
          ['Received SIGINT. Stopping safely.'],
        );
        expect(written.join('')).to.contain(
          'Received SIGINT. Stopping safely.',
        );
      } finally {
        oclif.ux.action.stop();
        process.stderr.write = realWrite;
      }
    });

    function emitDuringHistoryWrite(signals: number): void {
      const items = lockItemsResource();
      const create = items.create as (
        body: Record<string, unknown>,
      ) => Promise<unknown>;
      items.create = (async (body: Record<string, unknown>) => {
        if (body.id !== MIGRATIONS_RUN_LOCK_RECORD_ID) {
          for (let index = 0; index < signals; index += 1) {
            process.emit('SIGINT');
          }
        }
        return create(body);
      }) as never;
    }

    it('records a completed script when the first signal arrives during its history write', async () => {
      emitDuringHistoryWrite(1);
      await writeBoundContentMigration(migrationsDirectory);
      await writeMigration('1700000200_after.js');

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(130);
      expect(error?.message).to.equal(
        'Interrupted by SIGINT after "1700000100_bound.js" completed; 1 remaining migration(s) were not run. Rerun migrations:run to continue.',
      );
      expect(flat(stderr)).to.contain(
        'Received SIGINT. Migration "1700000100_bound.js" has completed; migrations:run will record it, stop before the next migration and release its run lock. Press Ctrl-C again to exit immediately.',
      );
      expect(flat(stderr)).not.to.contain('Stopping "1700000100_bound.js"');
      expect(runEvents).to.include('history 1700000100_bound.js');
      expect(runEvents).not.to.include('script 1700000200_after.js');
      expect(heldLock).to.equal(null);
    });

    it('reports an unrecorded completed script, not content-diff leftovers, on a second signal during its history write', async () => {
      emitDuringHistoryWrite(2);
      await writeBoundContentMigration(migrationsDirectory);

      await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );
      const runId = createdLockRunId();

      expect(forcedExits).to.deep.equal([130]);
      expect(synchronousStderr).to.have.length(1);
      const [message] = synchronousStderr;
      expect(message).to.contain(
        'Received SIGINT again. Exiting immediately without waiting for the migration history record of "1700000100_bound.js".',
      );
      expect(message).to.contain(
        'Migration "1700000100_bound.js" completed, but it may not be recorded in the migrations model of "sandbox". Check that model before rerunning migrations:run, or the migration may run again.',
      );
      expect(message).not.to.contain('temporarily relaxed field validators');
      expect(message).to.contain(`(unlock token ${runId})`);
    });

    it('exits immediately on a second signal and reports content-diff leftovers and the held lock', async () => {
      await writeBoundContentMigration(migrationsDirectory, {
        body: `  process.emit('SIGINT');
  process.emit('SIGINT');
  throw Object.assign(new Error('Content migration was interrupted'), { code: 'MIGRATION_INTERRUPTED' });`,
      });

      await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );
      const runId = createdLockRunId();

      expect(forcedExits).to.deep.equal([130]);
      expect(synchronousStderr).to.have.length(1);
      const [message] = synchronousStderr;
      expect(message).to.contain(
        'Received SIGINT again. Exiting immediately without waiting for "1700000100_bound.js".',
      );
      for (const leftover of [
        'temporarily relaxed field validators',
        'suppressed field defaults',
        'cancelled publication/unpublishing schedules',
        join(tmpdir(), 'datocms-content-diff-*'),
      ]) {
        expect(message).to.contain(leftover);
      }
      expect(message).to.contain(
        `The run lock on "sandbox" is still held (unlock token ${runId}). After confirming this process has exited, clear it with "${BIN} migrations:run --source=sandbox --in-place --config-file=${configPath} --force-unlock=${runId}".`,
      );
    });

    it('exits with 143 on a second SIGTERM and suggests destroying a fork', async () => {
      await writeMigration(
        '1700000000_a.js',
        "process.emit('SIGTERM'); process.emit('SIGTERM');",
      );

      await runCommand(
        `migrations:run --source=source --destination=generated-fork --config-file=${configPath}`,
      );
      const runId = createdLockRunId();

      expect(forcedExits).to.deep.equal([143]);
      expect(synchronousStderr[0]).to.contain(
        'Environment "generated-fork" may be partially migrated.',
      );
      expect(synchronousStderr[0]).to.contain(
        `clear it with "${BIN} migrations:run --source=generated-fork --in-place --config-file=${configPath} --force-unlock=${runId}" or destroy "generated-fork".`,
      );
    });

    it('passes the signal to runtime-v16 scripts but reports that they cannot be interrupted', async () => {
      await writeBoundContentMigration(migrationsDirectory, {
        runtimeVersion: '16',
        body: `  globalThis.__abortSignalSeen = context.abortSignal instanceof AbortSignal;
  process.emit('SIGINT');`,
      });

      const { error, stderr } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(
        (globalThis as Record<string, unknown>).__abortSignalSeen,
      ).to.equal(true);
      expect(flat(stderr)).to.contain(
        'Migration "1700000100_bound.js" cannot be interrupted safely',
      );
      expect(migrationRecordWrites).to.equal(1);
    });

    it('exits 1 when an interrupted content-diff script also failed restoration', async () => {
      await writeBoundContentMigration(migrationsDirectory, {
        body: `  process.emit('SIGINT');
  throw Object.assign(new Error('restoration failed'), { code: 'MIGRATION_AND_SCHEMA_RESTORATION_FAILURE' });`,
      });

      const { error, stdout } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(1);
      expect(codeOf(error)).to.equal(
        'MIGRATION_AND_SCHEMA_RESTORATION_FAILURE',
      );
      expect(error?.message).to.contain(
        'was interrupted by SIGINT, but restoring its temporary schema or schedule changes failed',
      );
      expect(stdout).to.contain('restoration failed');
      expect(heldLock).to.equal(null);
    });

    it('reports an unrelated failure after a signal with the signal exit code', async () => {
      await writeMigration(
        '1700000000_a.js',
        "process.emit('SIGINT'); throw new Error('unrelated');",
      );

      const { error, stdout } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(exitCodeOf(error)).to.equal(130);
      expect(error?.message).to.equal(
        'Migration "1700000000_a.js" failed after migrations:run received SIGINT. Rerun migrations:run to resume.',
      );
      expect(stdout).to.contain('unrelated');
      expect(migrationRecordWrites).to.equal(0);
    });

    it('installs one handler per signal only while the lock is held', async () => {
      await writeMigration(
        '1700000000_a.js',
        "globalThis.__listenerCounts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];",
      );

      const { error } = await runCommand(
        `migrations:run --source=sandbox --in-place --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(
        (globalThis as Record<string, unknown>).__listenerCounts,
      ).to.deep.equal([
        signalListenerBaseline.SIGINT + 1,
        signalListenerBaseline.SIGTERM + 1,
      ]);
    });

    for (const [label, flags] of [
      ['dry runs', '--dry-run'],
      ['runs with nothing pending', ''],
    ] as const) {
      it(`installs no signal handlers for ${label}`, async () => {
        if (flags) await writeMigration('1700000000_a.js');
        const registrations: string[] = [];
        const originalOn = process.on;
        process.on = function (this: NodeJS.Process, event, listener) {
          if (event === 'SIGINT' || event === 'SIGTERM') {
            registrations.push(String(event));
          }
          return originalOn.call(this, event, listener);
        } as typeof process.on;

        try {
          const { error } = await runCommand(
            `migrations:run --source=sandbox --in-place ${flags} --config-file=${configPath}`,
          );
          expect(error).to.equal(undefined);
        } finally {
          process.on = originalOn;
        }

        expect(registrations).to.deep.equal([]);
        expect(runEvents).to.deep.equal([]);
      });
    }
  });
});

/**
 * Drops all whitespace and oclif's warning gutter, for commands whose long
 * paths oclif hard-wraps in the middle of a word.
 */
function compact(output: string): string {
  return output.replace(/\s*\n\s*›/gu, '').replace(/\s+/gu, '');
}

/** Undoes the line wrapping oclif applies to warnings. */
function flat(output: string): string {
  return output.replace(/\s*\n\s*›\s*/gu, ' ');
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | undefined)?.code;
}

function exitCodeOf(error: unknown): unknown {
  return (error as { oclif?: { exit?: unknown } } | undefined)?.oclif?.exit;
}

function suggestionsOf(error: unknown): unknown {
  return (error as { suggestions?: unknown } | undefined)?.suggestions;
}

function isLockCreateRequest(request: FakeCmaRequest): boolean {
  const data = (request.body as { data?: { id?: unknown } } | undefined)?.data;
  return data?.id === MIGRATIONS_RUN_LOCK_RECORD_ID;
}

function migrationRunRoute(): (
  request: FakeCmaRequest,
) => FakeCmaResponse | undefined {
  const model = {
    id: 'migration-model',
    type: 'item_type',
    attributes: {
      name: 'Schema migration',
      api_key: 'schema_migration',
      modular_block: false,
      singleton: false,
      sortable: false,
      tree: false,
      draft_mode_active: false,
      draft_saving_active: false,
      all_locales_required: false,
    },
    relationships: { workflow: { data: null } },
  };
  const field = {
    id: 'migration-name-field',
    type: 'field',
    attributes: {
      label: 'Migration file name',
      api_key: 'name',
      field_type: 'string',
      localized: false,
      default_value: null,
      validators: { required: {} },
    },
    relationships: {
      item_type: { data: { id: model.id, type: 'item_type' } },
    },
  };
  let modelCreated = false;
  let lockRecord: Record<string, unknown> | null = null;
  const itemResource = (id: string, name: unknown) => ({
    id,
    type: 'item',
    attributes: { name },
    relationships: {
      item_type: { data: { id: model.id, type: 'item_type' } },
    },
    meta: { created_at: '2026-09-28T10:00:00.000Z' },
  });

  return (request) => {
    const { method, path } = request;
    const route = `${method} ${path}`;

    switch (route) {
      case 'GET /environments':
        return environmentsResponse([
          { id: 'primary', primary: true },
          { id: 'sandbox', primary: false },
        ]);
      case 'GET /environments/sandbox':
        return {
          status: 200,
          body: {
            data: environmentResource({ id: 'sandbox', primary: false }),
          },
        };
      case 'POST /environments/sandbox/fork':
        return {
          status: 200,
          body: {
            data: environmentResource({ id: 'generated-fork', primary: false }),
          },
        };
      case 'GET /site':
        return siteResponse('target-site');
      case 'GET /item-types/schema_migration':
        return modelCreated
          ? { status: 200, body: { data: model } }
          : apiErrorResponse(404, 'NOT_FOUND');
      case 'POST /item-types':
        modelCreated = true;
        return { status: 201, body: { data: model } };
      case `POST /item-types/${model.id}/fields`:
        return { status: 201, body: { data: field } };
      case `GET /item-types/${model.id}/fields`:
        return { status: 200, body: { data: modelCreated ? [field] : [] } };
      case 'GET /items':
        return {
          status: 200,
          body: {
            data: lockRecord ? [lockRecord] : [],
            meta: { total_count: lockRecord ? 1 : 0 },
          },
        };
      case 'POST /items': {
        if (isLockCreateRequest(request)) {
          if (lockRecord) return apiErrorResponse(422, 'INVALID_FIELD');
          const data = (
            request.body as { data: { attributes: { name: string } } }
          ).data;
          lockRecord = itemResource(
            MIGRATIONS_RUN_LOCK_RECORD_ID,
            data.attributes.name,
          );
          return { status: 201, body: { data: lockRecord } };
        }
        return {
          status: 201,
          body: { data: itemResource('migration-record', 'recorded') },
        };
      }
      case `GET /items/${MIGRATIONS_RUN_LOCK_RECORD_ID}`:
        return lockRecord
          ? { status: 200, body: { data: lockRecord } }
          : apiErrorResponse(404, 'NOT_FOUND');
      case `DELETE /items/${MIGRATIONS_RUN_LOCK_RECORD_ID}`: {
        const deleted = lockRecord;
        lockRecord = null;
        return deleted
          ? { status: 200, body: { data: deleted } }
          : apiErrorResponse(404, 'NOT_FOUND');
      }
      default:
        return undefined;
    }
  };
}
