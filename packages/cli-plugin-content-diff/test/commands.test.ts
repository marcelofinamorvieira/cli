import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CmaClient, CmaClientCommand, oclif } from '@datocms/cli-utils';
import { afterEach, describe, it } from 'mocha';
import ContentApplyCommand from '../src/commands/content/apply';
import ContentDiffCommand from '../src/commands/content/diff';
import ContentExportCommand from '../src/commands/content/export';
import * as apply from '../src/engine/apply';
import * as capture from '../src/engine/capture';
import * as dump from '../src/engine/dump';
import type { DumpManifest } from '../src/engine/dump';
import { ContentError } from '../src/engine/errors';
import * as generation from '../src/engine/generation';
import {
  type ContentGenerationArguments,
  environmentId,
  selectedModels,
} from '../src/engine/generation';
import * as planner from '../src/engine/planner';
import * as schema from '../src/engine/schema';
import * as side from '../src/engine/side';
import type { SideIndex } from '../src/engine/side';
import type { PreflightResult, SchemaState } from '../src/engine/types';

const root = resolve(__dirname, '..');
const restorations: (() => void)[] = [];
function replace(target: object, key: string, implementation: unknown): void {
  const original = Reflect.get(target, key);
  Reflect.set(target, key, implementation);
  restorations.push(() => Reflect.set(target, key, original));
}

/** A command instance with `members` in place of oclif's initialization. */
function instance(Command: { prototype: object }, members: object) {
  return Object.assign(Object.create(Command.prototype), members);
}

function schemaState(environmentId = 'source'): SchemaState {
  const model = {
    name: 'Article',
    block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: true,
    saveInvalidDrafts: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [],
  };
  return {
    siteId: 'site',
    environmentId,
    locales: ['en'],
    semantics: {},
    workflows: [],
    hash: 'schema',
    models: [
      { ...model, id: 'article-id', apiKey: 'article' },
      { ...model, id: 'page-id', apiKey: 'page' },
      { ...model, id: 'block-id', apiKey: 'block', block: true },
    ],
  };
}

/** A root client that lists `ids`, the first one primary. */
function listing(ids: string[]) {
  return {
    environments: {
      list: async () =>
        ids.map((id, index) => ({ id, meta: { primary: index === 0 } })),
    },
  };
}

/**
 * A stand-in for the native `buildClient`: a client that records the options
 * it was built with and lists `ids`.
 */
function clientBuilder(ids: string[] = []) {
  return async (options: object) => ({ options, ...listing(ids) });
}

const none = { create: 0, update: 0, delete: 0, noop: 0 };
/**
 * A command whose root client is built from the native client options, as
 * `CmaClientCommand.init` builds it, counting how often they are resolved.
 */
async function nativeClientCommand(
  Command: { prototype: object },
  args: Record<string, string>,
  flags: Record<string, unknown>,
  members: object = {},
) {
  let resolutions = 0;
  const command = instance(Command, {
    parse: async () => ({
      args,
      flags: { 'api-token': 'native-token', 'log-level': 'BODY', ...flags },
    }),
    profileId: 'default',
    datoProfileConfig: { baseUrl: 'http://127.0.0.1:9' },
    log: () => undefined,
    logToStderr: () => undefined,
    jsonEnabled: () => true,
    ...members,
  });
  const native = Reflect.get(
    CmaClientCommand.prototype,
    'buildBaseClientInitializationOptions',
  );
  replace(
    CmaClientCommand.prototype,
    'buildBaseClientInitializationOptions',
    function (this: unknown) {
      resolutions++;
      return native.call(this);
    },
  );
  command.client = await command.buildClient();
  return { command, resolutions: () => resolutions };
}

/** The native options a client was built with. */
function clientOptions({ config }: CmaClient.Client) {
  return [config.apiToken, config.baseUrl, config.logLevel, config.environment];
}

interface Rejection {
  args: string[];
  message: RegExp;
  code?: string;
  status: number;
}

/**
 * Runs each case through the CLI, with and without --json. No case may get
 * as far as a token lookup failure or a request: cases that must pass the
 * native init carry a placeholder token, which must never be printed.
 */
async function assertRejectedBeforeAnyRequest(
  cases: Rejection[],
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'content-command-parse-'));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATOCMS_CONFIG_FILE: join(directory, 'missing.json'),
  };
  environment.DATOCMS_PROFILE = undefined;
  for (const key of Object.keys(environment))
    if (/^DATOCMS_.*API_TOKEN$/.test(key)) delete environment[key];
  try {
    for (const { args, message, code, status } of cases) {
      for (const json of [false, true]) {
        const label = `${args.join(' ')}${json ? ' --json' : ''}`;
        const result = spawnSync(
          process.execPath,
          [join(root, 'bin/dev'), ...args, ...(json ? ['--json'] : [])],
          {
            cwd: directory,
            env: environment,
            encoding: 'utf8',
            timeout: 20_000,
          },
        );
        assert.equal(result.error, undefined, label);
        const output = `${result.stdout}${result.stderr}`;
        assert.doesNotMatch(
          output,
          /Cannot find an API token|No API token is available|OAuth credentials|ECONNREFUSED|ENOTFOUND|placeholder-flag-token/,
          `${label}\n${output}`,
        );
        assert.equal(result.status, status, label);
        if (json) {
          const { error } = JSON.parse(result.stdout);
          assert.match(error.message, message, label);
          assert.equal(error.code, code, label);
        } else {
          assert.match(result.stderr, message, label);
          if (code) assert.match(result.stdout, new RegExp(code), label);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('content command integration', () => {
  afterEach(() => {
    for (const restore of restorations.splice(0).reverse()) restore();
  });

  it('validates model selection, environment aliases, and bounded concurrency', () => {
    assert.deepEqual(selectedModels(schemaState(), 'article,article'), [
      'article-id',
    ]);
    assert.deepEqual(selectedModels(schemaState(), 'all'), [
      'article-id',
      'page-id',
    ]);
    for (const invalid of ['', 'all,article', 'block', 'unknown'])
      assert.throws(() => selectedModels(schemaState(), invalid));
    assert.equal(
      environmentId('primary', [{ id: 'main', meta: { primary: true } }]),
      'main',
    );
    assert.throws(() => environmentId('missing', []));
  });

  for (const sourceProfile of [false, true]) {
    it(`rejects incompatible schemas before capturing content with ${
      sourceProfile ? 'a source profile' : 'one project'
    }`, async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'content-command-schema-'),
      );
      const source = schemaState('source');
      const destination = schemaState('target');
      const reads: string[] = [];
      replace(
        schema,
        'fetchSchema',
        async (_client: unknown, environment: string) => {
          reads.push(environment);
          return environment === 'source' ? source : destination;
        },
      );
      replace(
        side,
        'SideIndex',
        class {
          constructor() {
            assert.fail(
              'An incompatible schema must fail before indexing either side',
            );
          }
        },
      );
      replace(capture, 'captureEnvironment', async () => {
        assert.fail('Neither environment should have its content read');
      });
      const command = instance(ContentDiffCommand, {
        parse: async () => ({
          args: { NAME: 'firstDiff' },
          flags: {
            source: 'source',
            destination: 'target',
            out: join(directory, 'diff.zip'),
            'item-types': 'article',
            concurrency: 4,
            ...(sourceProfile
              ? { 'source-profile': 'source', 'source-api-token': 'token' }
              : {}),
          },
        }),
        datoConfig: sourceProfile ? { profiles: { source: {} } } : undefined,
        client: listing(['target', 'source']),
        buildClient: clientBuilder(['target', 'source']),
        jsonEnabled: () => true,
      });
      try {
        for (const mismatch of ['locales', 'selected-model', 'block-model']) {
          destination.locales = mismatch === 'locales' ? ['it'] : ['en'];
          destination.models = schemaState('target').models.filter(
            (model) =>
              model.id !==
              (mismatch === 'selected-model'
                ? 'article-id'
                : mismatch === 'block-model'
                  ? 'block-id'
                  : undefined),
          );
          reads.length = 0;
          await assert.rejects(command.run(), (error: unknown) => {
            assert.ok(error instanceof ContentError, String(error));
            assert.equal(error.code, 'SCHEMA_INCOMPATIBLE', mismatch);
            return true;
          });
          assert.deepEqual(reads, ['source', 'target']);
          assert.equal(existsSync(join(directory, 'diff.zip')), false);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it('passes generation options and profile settings through and renders its result outside JSON mode', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'content-command-generation-'),
    );
    const destinationClient = { project: 'destination' };
    const result = {
      diffPath: join(directory, '1700000000_syncFaqContent.diff-records.zip'),
      sourceEnvironmentId: 'source',
      destinationEnvironmentId: 'main',
      counts: {
        record: { ...none, update: 2 },
        upload: none,
        collection: none,
      },
      operations: 5,
    };
    let calls = 0;
    replace(Date, 'now', () => 1_700_000_000_000);
    replace(
      generation,
      'generateContentDiff',
      async (args: ContentGenerationArguments) => {
        calls++;
        const {
          signal,
          progress,
          outputPath,
          source,
          destination,
          ...options
        } = args;
        assert.ok(signal instanceof AbortSignal);
        assert.deepEqual(options, {
          sourceMigrationModelApiKey: 'source_migration',
          destinationMigrationModelApiKey: 'destination_migration',
          options: {
            itemTypes: 'article',
            uploads: 'all',
            includeDeletions: true,
            concurrency: 3,
          },
        });
        if (!('endpoint' in source)) assert.fail('the source is live');
        assert.equal(source.environment, 'source');
        assert.equal(destination.environment, 'primary');
        // The source project gets its own clients, from its profile and
        // token; the destination reuses the native one.
        assert.deepEqual(source.endpoint.rootClient, {
          options: {
            apiToken: 'source-token',
            baseUrl: 'http://source.invalid',
            environment: undefined,
          },
        });
        assert.deepEqual(await source.endpoint.buildEnvironmentClient('x'), {
          options: {
            apiToken: 'source-token',
            baseUrl: 'http://source.invalid',
            environment: 'x',
          },
        });
        assert.equal(destination.endpoint.rootClient, destinationClient);
        assert.deepEqual(
          await destination.endpoint.buildEnvironmentClient('main'),
          { options: { environment: 'main' } },
        );
        // A diff that carries asset files gets its own name.
        assert.deepEqual(
          [outputPath(false), outputPath(true)],
          [
            result.diffPath,
            join(
              directory,
              '1700000000_syncFaqContent.diff-records-assets.zip',
            ),
          ],
        );
        progress?.('Generation progress.');
        return result;
      },
    );
    try {
      for (const json of [false, true]) {
        const output: string[] = [];
        const progress: string[] = [];
        const command = instance(ContentDiffCommand, {
          datoConfig: {
            profiles: {
              source: {
                baseUrl: 'http://source.invalid',
                migrations: { modelApiKey: 'source_migration' },
              },
              destination: {
                migrations: { modelApiKey: 'destination_migration' },
              },
            },
          },
          datoProfileConfig: {
            migrations: { modelApiKey: 'destination_migration' },
          },
          parse: async () => ({
            args: { NAME: 'sync FAQ content' },
            flags: {
              source: 'source',
              destination: 'primary',
              'source-profile': 'source',
              'source-api-token': 'source-token',
              out: directory,
              'item-types': 'article',
              uploads: 'all',
              'include-deletions': true,
              concurrency: 3,
            },
          }),
          client: destinationClient,
          buildClient: async (options: object) => ({ options }),
          jsonEnabled: () => json,
          // oclif's log and logToStderr print nothing under --json.
          log: (message: string) => json || output.push(message),
          logToStderr: (message: string) => json || progress.push(message),
        });
        assert.equal(await command.run(), result);
        assert.deepEqual(progress, json ? [] : ['Generation progress.']);
        assert.deepEqual(
          output,
          json
            ? []
            : [
                `Content diff: ${result.diffPath} (5 operations)`,
                'record: 0 create, 2 update, 0 delete, 0 noop',
                'upload: 0 create, 0 update, 0 delete, 0 noop',
                'collection: 0 create, 0 update, 0 delete, 0 noop',
              ],
        );
      }
      assert.equal(calls, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('passes a source dump through with the destination endpoint and profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-command-dump-'));
    const destination = { project: 'destination' };
    replace(
      generation,
      'generateContentDiff',
      async (args: ContentGenerationArguments) => {
        assert.deepEqual(args.source, {
          dump: resolve('backup.dump-records.zip'),
        });
        assert.equal(args.destination.endpoint.rootClient, destination);
        assert.deepEqual(
          await args.destination.endpoint.buildEnvironmentClient('main'),
          { options: { environment: 'main' } },
        );
        assert.equal(args.destination.environment, 'main');
        // The dump carries no profile: the destination's tracking model
        // names the one it leaves out.
        assert.equal(args.sourceMigrationModelApiKey, 'tracking');
        assert.equal(args.destinationMigrationModelApiKey, 'tracking');
        return {
          counts: { record: none, upload: none, collection: none },
        };
      },
    );
    try {
      const command = instance(ContentDiffCommand, {
        datoProfileConfig: { migrations: { modelApiKey: 'tracking' } },
        parse: async () => ({
          args: { NAME: 'restore' },
          flags: {
            'source-dump': 'backup.dump-records.zip',
            destination: 'main',
            out: directory,
            'item-types': 'all',
            uploads: 'referenced',
            concurrency: 4,
          },
        }),
        client: destination,
        buildClient: async (options: object) => ({ options }),
        // Only the destination project is authenticated.
        requireDatoConfig: () =>
          assert.fail('a dump source must not resolve a source profile'),
        jsonEnabled: () => true,
      });
      await command.run();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps default diffs below the schema migration directory and honors explicit output', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'content-command-path-')),
    );
    const previousDirectory = process.cwd();
    const timestamp = 1_700_000_000;
    replace(Date, 'now', () => timestamp * 1000);
    const nested = join(directory, 'config');
    await mkdir(nested);
    const name = `${timestamp}_syncFaqContent.diff-records.zip`;
    const cases = [
      {
        out: join(directory, 'explicit.zip'),
        profiles: undefined,
        selected: undefined,
        path: join(directory, 'explicit.zip'),
      },
      {
        out: directory,
        profiles: undefined,
        selected: undefined,
        path: join(directory, name),
      },
      // The name of a diff carrying asset files is reserved too.
      {
        out: join(directory, 'assets'),
        profiles: undefined,
        selected: undefined,
        path: join(
          directory,
          'assets',
          `${timestamp}_syncFaqContent.diff-records-assets.zip`,
        ),
      },
      {
        out: undefined,
        profiles: undefined,
        selected: undefined,
        path: join(directory, 'migrations', 'content', name),
      },
      {
        out: undefined,
        profiles: undefined,
        selected: { migrations: { directory: '../single-profile' } },
        path: join(directory, 'single-profile', 'content', name),
      },
      // The destination profile's directory, never the source profile's.
      {
        out: undefined,
        profiles: { source: { migrations: { directory: '../wrong-source' } } },
        selected: { migrations: { directory: '../destination-profile' } },
        path: join(directory, 'destination-profile', 'content', name),
      },
    ];
    try {
      process.chdir(directory);
      for (const entry of cases) {
        await mkdir(dirname(entry.path), { recursive: true });
        await writeFile(entry.path, 'existing');
        const command = instance(ContentDiffCommand, {
          parse: async () => ({
            args: { NAME: 'sync FAQ content' },
            flags: {
              source: 'source',
              out: entry.out,
              concurrency: 4,
              ...(entry.profiles ? { 'source-profile': 'source' } : {}),
            },
          }),
          datoConfigPath: join(nested, 'datocms.config.json'),
          datoConfig: entry.profiles ? { profiles: entry.profiles } : undefined,
          datoProfileConfig: entry.selected,
          buildClient: async () =>
            assert.fail(
              'existing output must fail before the source project is authenticated',
            ),
          jsonEnabled: () => true,
        });
        await assert.rejects(command.run(), (error: ContentError) => {
          assert.equal(error.code, 'OUTPUT_EXISTS');
          assert.equal(
            error.message,
            `${entry.path} already exists. Choose another name.`,
          );
          return true;
        });
      }
    } finally {
      process.chdir(previousDirectory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves each profile's migration tracking model out of capture and planning", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'content-command-tracking-'),
    );
    const raw = (environment: string) => {
      const result = schemaState(environment);
      result.models.push({
        ...result.models[0]!,
        id: `${environment}-tracking`,
        apiKey: `${environment}_migration`,
        draftMode: false,
        fields: [
          {
            id: `${environment}-name`,
            apiKey: 'name',
            type: 'string',
            localized: false,
            validators: { required: {} },
            defaultValue: null,
          },
        ],
      });
      return result;
    };
    replace(
      schema,
      'fetchSchema',
      async (_client: unknown, environment: string) => raw(environment),
    );
    const captured: string[] = [];
    replace(
      capture,
      'captureEnvironment',
      async (options: Parameters<typeof capture.captureEnvironment>[0]) => {
        captured.push(options.schema.environmentId);
        assert.deepEqual(
          options.schema.models.map((model) => model.id),
          ['article-id', 'page-id', 'block-id'],
        );
      },
    );
    replace(planner, 'createPlan', (source: SideIndex, target: SideIndex) => {
      assert.equal(source.schema.models.length, 3);
      assert.equal(target.schema.models.length, 3);
      throw new Error('projection verified');
    });
    const command = instance(ContentDiffCommand, {
      datoConfig: {
        profiles: {
          source: { migrations: { modelApiKey: 'source_migration' } },
        },
      },
      datoProfileConfig: {
        migrations: { modelApiKey: 'destination_migration' },
      },
      parse: async () => ({
        args: { NAME: 'content' },
        flags: {
          source: 'source',
          destination: 'destination',
          out: join(directory, 'diff.zip'),
          'source-profile': 'source',
          'source-api-token': 'source-token',
          'item-types': 'all',
          uploads: 'referenced',
          concurrency: 4,
        },
      }),
      client: listing(['destination']),
      buildClient: clientBuilder(['source']),
      jsonEnabled: () => true,
    });
    try {
      await assert.rejects(command.run(), /projection verified/);
      assert.deepEqual(captured.sort(), ['destination', 'source']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('exports the requested environment to a timestamped dump and reports it', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'content-command-export-')),
    );
    replace(Date, 'now', () => 1_700_000_000_000);
    const manifest = {
      format: 'datocms-project-dump',
      counts: { records: 2, uploads: 1, uploadCollections: 0 },
    } as DumpManifest;
    const exported: unknown[] = [];
    replace(
      dump,
      'writeDump',
      async (args: Parameters<typeof dump.writeDump>[0]) => {
        const { signal, progress, ...options } = args.options;
        assert.ok(signal instanceof AbortSignal);
        progress?.('Export progress.');
        exported.push({
          client: clientOptions(args.client),
          environmentId: args.environmentId,
          primary: args.primary,
          path: args.path,
          includeAssets: args.includeAssets,
          options,
        });
        return manifest;
      },
    );
    let listed = 0;
    const command = (
      flags: Record<string, unknown>,
      json: boolean,
      logged: string[] = [],
      progress: string[] = [],
    ) =>
      instance(ContentExportCommand, {
        parse: async () => ({
          args: { NAME: 'nightly backup' },
          flags: { out: directory, concurrency: 3, ...flags },
        }),
        client: {
          environments: {
            list: async () => {
              listed++;
              return [
                { id: 'main', meta: { primary: true } },
                { id: 'staging', meta: { primary: false } },
              ];
            },
          },
        },
        buildBaseClientInitializationOptions: async () => ({
          apiToken: 'fixture-token',
        }),
        jsonEnabled: () => json,
        // oclif's log and logToStderr print nothing under --json.
        log: (message: string) => json || logged.push(message),
        logToStderr: (message: string) => json || progress.push(message),
      });
    const records = join(
      directory,
      '1700000000_nightlyBackup.dump-records.zip',
    );
    const assets = join(
      directory,
      '1700000000_nightlyBackup.dump-records-assets.zip',
    );
    try {
      const logged: string[] = [];
      const progress: string[] = [];
      assert.deepEqual(
        await command(
          { environment: 'primary', 'include-assets': false },
          false,
          logged,
          progress,
        ).run(),
        { ...manifest, dumpPath: records },
      );
      assert.deepEqual(logged, [
        `Project dump: ${records} (2 records, 1 uploads, 0 folders)`,
      ]);
      assert.deepEqual(progress, ['Export progress.']);
      assert.deepEqual(
        await command(
          { environment: 'staging', 'include-assets': true },
          true,
          logged,
          progress,
        ).run(),
        { ...manifest, dumpPath: assets },
      );
      assert.equal(logged.length, 1);
      assert.equal(progress.length, 1);
      assert.deepEqual(exported, [
        {
          client: ['fixture-token', undefined, undefined, 'main'],
          environmentId: 'main',
          primary: true,
          path: records,
          includeAssets: false,
          options: { concurrency: 3 },
        },
        {
          client: ['fixture-token', undefined, undefined, 'staging'],
          environmentId: 'staging',
          primary: false,
          path: assets,
          includeAssets: true,
          options: { concurrency: 3 },
        },
      ]);
      // Both names are reserved before any request.
      await writeFile(assets, 'existing');
      listed = 0;
      await assert.rejects(
        command(
          { environment: 'primary', 'include-assets': false },
          true,
        ).run(),
        (error: ContentError) => {
          assert.equal(error.code, 'OUTPUT_EXISTS');
          assert.equal(
            error.message,
            `${assets} already exists. Choose another name.`,
          );
          return true;
        },
      );
      assert.equal(listed, 0);
      assert.equal(exported.length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parses content:export arguments and flags with their defaults', async () => {
    const parse = (argv: string[]) =>
      oclif.Parser.parse(argv, {
        args: ContentExportCommand.args,
        flags: ContentExportCommand.flags,
      });
    const defaults = await parse([]);
    assert.deepEqual(defaults.args, { NAME: 'dump' });
    assert.equal(defaults.flags.environment, 'primary');
    assert.equal(defaults.flags['include-assets'], false);
    assert.equal(defaults.flags.out, undefined);
    assert.equal(defaults.flags.concurrency, 8);
    const given = await parse([
      'backup',
      '--environment=staging',
      '--include-assets',
      '--out=./backups',
      '--concurrency=16',
    ]);
    assert.deepEqual(given.args, { NAME: 'backup' });
    assert.equal(given.flags.environment, 'staging');
    assert.equal(given.flags['include-assets'], true);
    assert.equal(given.flags.out, './backups');
    assert.equal(given.flags.concurrency, 16);
  });

  it('builds the content:export environment client from the native client options', async () => {
    const { command, resolutions } = await nativeClientCommand(
      ContentExportCommand,
      { NAME: 'dump' },
      { environment: 'primary', 'include-assets': false, concurrency: 4 },
    );
    Reflect.set(command.client.environments, 'list', async () => [
      { id: 'main', meta: { primary: true } },
    ]);
    replace(
      dump,
      'writeDump',
      async (args: Parameters<typeof dump.writeDump>[0]) => {
        assert.deepEqual(clientOptions(args.client), [
          'native-token',
          'http://127.0.0.1:9',
          CmaClient.LogLevel.BODY,
          'main',
        ]);
        return { counts: { records: 0, uploads: 0, uploadCollections: 0 } };
      },
    );
    await command.run();
    // Resolving them again would repeat a linked project's Dashboard request.
    assert.equal(resolutions(), 1);
  });

  it('builds content:diff clients for the source project and the destination from the native client options', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-command-tokens-'));
    const { command, resolutions } = await nativeClientCommand(
      ContentDiffCommand,
      { NAME: 'contentMigration' },
      {
        source: 'source',
        destination: 'primary',
        out: directory,
        'source-profile': 'one',
        'source-api-token': 'source-token',
        'item-types': 'all',
        uploads: 'referenced',
        concurrency: 4,
      },
      {
        datoConfig: { profiles: { one: { baseUrl: 'http://source.invalid' } } },
      },
    );
    replace(
      generation,
      'generateContentDiff',
      async (args: ContentGenerationArguments) => {
        if (!('endpoint' in args.source)) assert.fail('the source is live');
        assert.equal(args.destination.endpoint.rootClient, command.client);
        assert.deepEqual(
          [
            args.source.endpoint.rootClient,
            await args.source.endpoint.buildEnvironmentClient('staging'),
            args.destination.endpoint.rootClient,
            await args.destination.endpoint.buildEnvironmentClient('main'),
          ].map(clientOptions),
          [
            [
              'source-token',
              'http://source.invalid',
              CmaClient.LogLevel.BODY,
              undefined,
            ],
            [
              'source-token',
              'http://source.invalid',
              CmaClient.LogLevel.BODY,
              'staging',
            ],
            [
              'native-token',
              'http://127.0.0.1:9',
              CmaClient.LogLevel.BODY,
              undefined,
            ],
            [
              'native-token',
              'http://127.0.0.1:9',
              CmaClient.LogLevel.BODY,
              'main',
            ],
          ],
        );
        return {
          diffPath: join(directory, 'diff.zip'),
          sourceEnvironmentId: 'source',
          destinationEnvironmentId: 'main',
          counts: { record: none, upload: none, collection: none },
          operations: 0,
        };
      },
    );
    try {
      await command.run();
      assert.equal(resolutions(), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports preflight without running operations and keeps JSON output quiet', async () => {
    const preview: PreflightResult = {
      preflightOnly: true,
      environmentId: 'main',
      executed: false,
      operations: 3,
      generatedCounts: {
        record: { ...none, update: 2 },
        upload: none,
        collection: none,
      },
    };
    replace(
      apply,
      'applyContentDiff',
      async (args: Parameters<typeof apply.applyContentDiff>[0]) => {
        assert.equal(args.diffPath, './diff.zip');
        assert.equal(args.options.preflightOnly, true);
        assert.equal(args.options.forkName, 'content-review');
        assert.equal(args.options.destinationEnvironmentId, 'main');
        return preview;
      },
    );
    for (const json of [false, true]) {
      const logs: string[] = [];
      const command = instance(ContentApplyCommand, {
        parse: async () => ({
          args: { FILE: './diff.zip' },
          flags: {
            destination: 'main',
            'preflight-only': true,
            'fork-name': 'content-review',
            'in-place': false,
            'allow-primary': false,
            'keep-failed-fork': false,
            concurrency: 4,
          },
        }),
        client: {},
        buildBaseClientInitializationOptions: async () => ({
          apiToken: 'fixture-token',
        }),
        log: (message: string) => json || logs.push(message),
        jsonEnabled: () => json,
      });
      assert.deepEqual(await command.run(), preview);
      assert.deepEqual(
        logs,
        json
          ? []
          : [
              'Preflight checks passed against environment "main" for 3 operations. Nothing was run.',
            ],
      );
    }
  });

  it('passes explicit application authorization to the executor and returns its result', async () => {
    const result = {
      environmentId: 'isolated',
      executed: true,
      operations: 2,
    };
    // Fast forks and forcing them are off unless asked for.
    for (const [flags, expected] of [
      [{}, { fastFork: false, force: false }],
      [
        { 'fast-fork': true, force: true },
        { fastFork: true, force: true },
      ],
    ] as const) {
      replace(
        apply,
        'applyContentDiff',
        async (args: Parameters<typeof apply.applyContentDiff>[0]) => {
          assert.equal(args.diffPath, './diff.zip');
          const { signal, ...options } = args.options;
          assert.ok(signal instanceof AbortSignal);
          assert.equal(signal.aborted, false);
          assert.deepEqual(
            { ...options, log: undefined },
            {
              inPlace: false,
              allowPrimary: false,
              keepFailedFork: true,
              destinationEnvironmentId: 'target',
              concurrency: 2,
              ...expected,
              log: undefined,
            },
          );
          return result;
        },
      );
      const command = instance(ContentApplyCommand, {
        parse: async () => ({
          args: { FILE: './diff.zip' },
          flags: {
            destination: 'target',
            'in-place': false,
            'allow-primary': false,
            'keep-failed-fork': true,
            concurrency: 2,
            ...flags,
          },
        }),
        client: {},
        buildBaseClientInitializationOptions: async () => ({
          apiToken: 'fixture-token',
        }),
        jsonEnabled: () => true,
      });
      assert.deepEqual(await command.run(), result);
    }
  });

  it('parses --fast-fork and --force as opt-ins, --force only beside --fast-fork', async () => {
    const parse = async (argv: string[]) => {
      const { flags } = await oclif.Parser.parse(argv, {
        args: ContentApplyCommand.args,
        flags: ContentApplyCommand.flags,
      });
      return [flags['fast-fork'], flags.force, flags['fork-name']];
    };
    assert.deepEqual(await parse(['./diff.zip']), [
      undefined,
      undefined,
      undefined,
    ]);
    assert.deepEqual(await parse(['./diff.zip', '--fast-fork']), [
      true,
      undefined,
      undefined,
    ]);
    assert.deepEqual(
      await parse(['./diff.zip', '--fast-fork', '--force', '--fork-name=qa']),
      [true, true, 'qa'],
    );
    await assert.rejects(
      parse(['./diff.zip', '--force']),
      /All of the following must be provided when using --force: --fast-fork/,
    );
  });

  it('builds content:apply environment clients from the native client options', async () => {
    const { command, resolutions } = await nativeClientCommand(
      ContentApplyCommand,
      { FILE: './diff.zip' },
      {
        'in-place': false,
        'allow-primary': false,
        'keep-failed-fork': false,
        concurrency: 4,
      },
    );
    replace(
      apply,
      'applyContentDiff',
      async (args: Parameters<typeof apply.applyContentDiff>[0]) => {
        assert.equal(args.rootClient, command.client);
        assert.deepEqual(
          [
            args.rootClient,
            await args.buildEnvironmentClient('review'),
            await args.buildEnvironmentClient('main'),
          ].map(clientOptions),
          [undefined, 'review', 'main'].map((environment) => [
            'native-token',
            'http://127.0.0.1:9',
            CmaClient.LogLevel.BODY,
            environment,
          ]),
        );
        return {
          environmentId: 'review',
          executed: true,
          operations: 0,
        };
      },
    );
    await command.run();
    assert.equal(resolutions(), 1);
  });

  it('reports the run and a kept fork in human-readable output', async () => {
    let outcome: unknown = {
      environmentId: 'isolated',
      executed: true,
      operations: 4,
    };
    replace(
      apply,
      'applyContentDiff',
      async (args: Parameters<typeof apply.applyContentDiff>[0]) => {
        if (outcome instanceof Error) {
          args.options.log?.('Kept failed fork content-apply-kept');
          throw outcome;
        }
        return outcome;
      },
    );
    const logged: string[] = [];
    const progress: string[] = [];
    const command = (diffPath: string) =>
      instance(ContentApplyCommand, {
        parse: async () => ({
          args: { FILE: diffPath },
          flags: {
            'in-place': false,
            'allow-primary': false,
            'keep-failed-fork': true,
            concurrency: 4,
          },
        }),
        client: {},
        buildBaseClientInitializationOptions: async () => ({
          apiToken: 'fixture-token',
        }),
        log: (message: string) => logged.push(message),
        logToStderr: (message: string) => progress.push(message),
        jsonEnabled: () => false,
      });
    await command('./diff.zip').run();
    await command('./missing.zip').run();
    outcome = {
      environmentId: 'isolated',
      executed: true,
      operations: 1,
    };
    await command('./diff.zip').run();
    assert.deepEqual(logged, [
      'Ran 4 operations in environment "isolated".',
      'Ran 4 operations in environment "isolated".',
      'Ran 1 operations in environment "isolated".',
    ]);
    outcome = new ContentError('FORK_FAILED', 'Injected failure.');
    await assert.rejects(command('./diff.zip').run(), /Injected failure/);
    assert.deepEqual(progress, ['Kept failed fork content-apply-kept']);
  });

  for (const Command of [
    ContentApplyCommand,
    ContentDiffCommand,
    ContentExportCommand,
  ])
    it(`reports ${Command.name} --json failures as JSON errors with the human exit status`, async () => {
      const reported: unknown[] = [];
      const command = instance(Command, {
        jsonEnabled: () => true,
        logJson: (json: unknown) => reported.push(json),
      });
      const previousExitCode = process.exitCode;
      const exitCodes: unknown[] = [];
      try {
        for (const error of [
          Object.assign(
            new ContentError('CMA_REQUEST_FAILED', 'Request failed.', {
              step: 'records',
            }),
            { keptForkEnvironmentId: 'content-apply-kept' },
          ),
          Object.assign(new Error('Invalid flags.'), {
            oclif: { exit: 2 },
            suggestions: ['See --help'],
            parse: { input: { argv: ['--api-token=failure-token'] } },
          }),
          Object.assign(new ContentError('INTERRUPTED', 'Interrupted.'), {
            exitCode: 130,
            oclif: { exit: 130 },
          }),
          Object.assign(new Error('PUT /items/1: 401 Unauthorized'), {
            name: 'ApiError',
            errors: [{ attributes: { code: 'INVALID_AUTHORIZATION_HEADER' } }],
          }),
        ]) {
          process.exitCode = undefined;
          await command.catch(error);
          exitCodes.push(process.exitCode);
        }
      } finally {
        process.exitCode = previousExitCode;
      }
      assert.deepEqual(exitCodes, [1, 2, 130, 1]);
      assert.deepEqual(JSON.parse(JSON.stringify(reported)), [
        {
          error: {
            name: 'ContentError',
            message: 'Request failed.',
            code: 'CMA_REQUEST_FAILED',
            details: { step: 'records' },
            keptForkEnvironmentId: 'content-apply-kept',
          },
        },
        {
          error: {
            name: 'Error',
            message: 'Invalid flags.',
            suggestions: ['See --help'],
          },
        },
        {
          error: {
            name: 'ContentError',
            message: 'Interrupted.',
            code: 'INTERRUPTED',
          },
        },
        {
          error: {
            name: 'ApiError',
            message: 'PUT /items/1: 401 Unauthorized',
            code: 'INVALID_AUTHORIZATION_HEADER',
          },
        },
      ]);
      const human = instance(Command, {
        jsonEnabled: () => false,
        logJson: () => assert.fail(),
      });
      const failure = Object.assign(new Error('Invalid flags.'), {
        oclif: { exit: 2 },
      });
      await assert.rejects(human.catch(failure), (error) => error === failure);
    });

  it('rejects incompatible or unknown CLI flags before resolving client authentication', () =>
    assertRejectedBeforeAnyRequest([
      ...['versions', 'full'].map((verification) => ({
        args: ['content:diff', '--source=a', `--verification=${verification}`],
        message: /Nonexistent flag: --verification/,
        status: 2,
      })),
      ...[
        '--output=b',
        '--destination-profile=two',
        '--allow-partial',
        '--chunk-bytes=1024',
      ].map((flag) => ({
        args: ['content:diff', '--source=a', flag],
        message: new RegExp(`Nonexistent flag: ${flag.split('=')[0]}`),
        status: 2,
      })),
      {
        args: ['content:diff', '--out=b'],
        message:
          /Exactly one of the following must be provided: --source, --source-dump/,
        status: 2,
      },
      {
        args: ['content:diff', '--source=a', '--source-dump=b.zip'],
        message: /--source-dump cannot also be provided when using --source/,
        status: 2,
      },
      {
        args: ['content:diff', '--source-dump=b.zip', '--source-profile=one'],
        message:
          /--source-profile=one cannot also be provided when using --source-dump/,
        status: 2,
      },
      {
        args: ['content:diff', '--source=a', '--out=b', '--concurrency=0'],
        message: /Expected an integer greater than or equal to 1/,
        status: 2,
      },
      {
        args: ['content:diff', '--source=a', '--out=b', '--concurrency=17'],
        message: /Expected an integer less than or equal to 16/,
        status: 2,
      },
      {
        args: [
          'content:diff',
          '--source=a',
          '--out=b',
          '--api-token=placeholder-flag-token',
          '--autogenerate=schema',
        ],
        message: /Nonexistent flag: --autogenerate=schema/,
        status: 2,
      },
      {
        args: [
          'content:apply',
          './diff.zip',
          '--preflight-only',
          '--keep-failed-fork',
        ],
        message: /cannot also be provided when using/,
        status: 2,
      },
      {
        args: [
          'content:apply',
          './diff.zip',
          '--fork-name=review',
          '--in-place',
        ],
        message: /cannot also be provided when using/,
        status: 2,
      },
      {
        args: ['content:apply', './diff.zip', '--allow-primary'],
        message:
          /All of the following must be provided when using --allow-primary: --in-place/,
        status: 2,
      },
      {
        args: ['content:apply', './diff.zip', '--force'],
        message:
          /All of the following must be provided when using --force: --fast-fork/,
        status: 2,
      },
      ...['--verification=full', '--no-fast-fork'].map((flag) => ({
        args: ['content:apply', './diff.zip', flag],
        message: new RegExp(`Nonexistent flag: ${flag.split('=')[0]}`),
        status: 2,
      })),
      ...['./migration.ts', './migration.content'].map((file) => ({
        args: ['content:apply', file],
        message: /Pass the \.zip diff written by content:diff/,
        code: 'INVALID_DIFF_PATH',
        status: 1,
      })),
      {
        args: ['content:apply', './diff.zip', '--fork-name=Review_1'],
        message:
          /fork name can only contain lowercase letters, numbers and dashes/,
        code: 'INVALID_FORK_NAME',
        status: 1,
      },
      {
        args: ['content:export', '--concurrency=0'],
        message: /Expected an integer greater than or equal to 1/,
        status: 2,
      },
      {
        args: ['content:export', '--concurrency=17'],
        message: /Expected an integer less than or equal to 16/,
        status: 2,
      },
      {
        args: ['content:export', '--source=a'],
        message: /Nonexistent flag: --source=a/,
        status: 2,
      },
    ])).timeout(300_000);

  // content:diff checks its name and output path in `run`, after the native
  // init resolved the token, but still before any request.
  it('rejects content:diff names and output paths before any request', () =>
    assertRejectedBeforeAnyRequest([
      {
        args: [
          'content:diff',
          '!!!',
          '--source=a',
          '--out=b',
          '--api-token=placeholder-flag-token',
        ],
        message: /name must contain letters or numbers/,
        code: 'INVALID_NAME',
        status: 1,
      },
      ...['script.js', 'sync.tsx', 'migration.ts'].map((out) => ({
        args: [
          'content:diff',
          '--source=a',
          `--out=${out}`,
          '--api-token=placeholder-flag-token',
        ],
        message: /output must be a \.zip file or a directory/,
        code: 'INVALID_OUTPUT_PATH',
        status: 1,
      })),
    ])).timeout(120_000);

  it('rejects content:export names and output paths before resolving client authentication', () =>
    assertRejectedBeforeAnyRequest([
      {
        args: ['content:export', '!!!'],
        message: /name must contain letters or numbers/,
        code: 'INVALID_NAME',
        status: 1,
      },
      {
        args: ['content:export', '--out=dump.ts'],
        message: /output must be a \.zip file or a directory/,
        code: 'INVALID_OUTPUT_PATH',
        status: 1,
      },
    ])).timeout(60_000);

  it('rejects a source API token beside a source dump without printing the token', () =>
    assertRejectedBeforeAnyRequest([
      {
        args: [
          'content:diff',
          '--source-dump=b.zip',
          '--source-api-token=placeholder-flag-token',
        ],
        message:
          /All of the following must be provided when using --source-api-token: --source-profile/,
        status: 2,
      },
    ])).timeout(60_000);
});
