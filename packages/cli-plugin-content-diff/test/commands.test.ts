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

/** A project whose root client lists `ids`, the first one primary. */
function project(
  ids: string[],
  client: (id: string) => unknown = (id) => ({ id }),
) {
  return {
    rootClient: {
      environments: {
        list: async () =>
          ids.map((id, index) => ({ id, meta: { primary: index === 0 } })),
      },
    },
    buildEnvironmentClient: client,
  } as unknown as ContentGenerationArguments['destination']['endpoint'];
}

const none = { create: 0, update: 0, delete: 0, noop: 0, skip: 0 };
/**
 * A command whose root client is built from the native client options, as
 * `CmaClientCommand.init` builds it, counting how often they are resolved.
 */
async function nativeClientCommand(
  Command: { prototype: object },
  args: Record<string, string>,
  flags: Record<string, unknown>,
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

/** Runs each case through the CLI, with and without --json, without a token. */
async function assertRejectedBeforeAuthentication(
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

  for (const pairedProfiles of [false, true]) {
    it(`rejects incompatible schemas before capturing content with ${
      pairedProfiles ? 'paired profiles' : 'one profile'
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
            output: join(directory, 'diff.zip'),
            'item-types': 'article',
            concurrency: 4,
            ...(pairedProfiles
              ? {
                  'source-profile': 'source',
                  'destination-profile': 'target',
                }
              : {}),
          },
        }),
        endpoint: async () => project(['target', 'source']),
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
    const endpoints = {
      source: { project: 'source' },
      destination: { project: 'destination' },
    };
    const result = {
      diffPath: join(directory, '1700000000_syncFaqContent.diff-records.zip'),
      sourceEnvironmentId: 'source',
      destinationEnvironmentId: 'main',
      counts: {
        record: { ...none, update: 2, skip: 1 },
        upload: none,
        collection: none,
      },
      operations: 5,
      skipped: [
        {
          kind: 'record' as const,
          id: 'cycle',
          code: 'PUBLICATION_CYCLE',
          message: 'Record cycle is in a publication cycle.',
        },
      ],
    };
    let calls = 0;
    replace(Date, 'now', () => 1_700_000_000_000);
    replace(
      generation,
      'generateContentDiff',
      async (args: ContentGenerationArguments) => {
        calls++;
        const { signal, progress, outputPath, ...options } = args;
        assert.ok(signal instanceof AbortSignal);
        assert.deepEqual(options, {
          source: { endpoint: endpoints.source, environment: 'source' },
          destination: {
            endpoint: endpoints.destination,
            environment: 'primary',
          },
          sourceMigrationModelApiKey: 'source_migration',
          destinationMigrationModelApiKey: 'destination_migration',
          options: {
            itemTypes: 'article',
            uploads: 'all',
            includeDeletions: true,
            allowPartial: true,
            concurrency: 3,
          },
        });
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
              source: { migrations: { modelApiKey: 'source_migration' } },
              destination: {
                migrations: { modelApiKey: 'destination_migration' },
              },
            },
          },
          parse: async () => ({
            args: { NAME: 'sync FAQ content' },
            flags: {
              source: 'source',
              destination: 'primary',
              'source-profile': 'source',
              'destination-profile': 'destination',
              output: directory,
              'item-types': 'article',
              uploads: 'all',
              'include-deletions': true,
              'allow-partial': true,
              concurrency: 3,
            },
          }),
          endpoint: async (profile: keyof typeof endpoints) =>
            endpoints[profile],
          jsonEnabled: () => json,
          // oclif's log and logToStderr print nothing under --json.
          log: (message: string) => json || output.push(message),
          logToStderr: (message: string) => json || progress.push(message),
        });
        assert.equal(await command.run(), result);
        assert.deepEqual(
          progress,
          json
            ? []
            : [
                'Generation progress.',
                'Skipped record cycle (PUBLICATION_CYCLE): Record cycle is in a publication cycle.',
              ],
        );
        assert.deepEqual(
          output,
          json
            ? []
            : [
                `Content diff: ${result.diffPath} (5 operations)`,
                'record: 0 create, 2 update, 0 delete, 0 noop, 1 skip',
                'upload: 0 create, 0 update, 0 delete, 0 noop, 0 skip',
                'collection: 0 create, 0 update, 0 delete, 0 noop, 0 skip',
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
    const requested: unknown[][] = [];
    replace(
      generation,
      'generateContentDiff',
      async (args: ContentGenerationArguments) => {
        assert.deepEqual(args.source, {
          dump: resolve('backup.dump-records.zip'),
        });
        assert.equal(args.destination.endpoint, destination);
        assert.equal(args.destination.environment, 'main');
        // The dump carries no profile: the destination's tracking model
        // names the one it leaves out.
        assert.equal(args.sourceMigrationModelApiKey, 'tracking');
        assert.equal(args.destinationMigrationModelApiKey, 'tracking');
        return {
          counts: { record: none, upload: none, collection: none },
          skipped: [],
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
            output: directory,
            'item-types': 'all',
            uploads: 'referenced',
            concurrency: 4,
          },
        }),
        endpoint: async (...args: unknown[]) => {
          requested.push(args);
          return destination;
        },
        jsonEnabled: () => true,
      });
      await command.run();
      // Only the destination project is authenticated.
      assert.deepEqual(requested, [[]]);
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
        output: join(directory, 'explicit.zip'),
        profiles: undefined,
        selected: undefined,
        path: join(directory, 'explicit.zip'),
      },
      {
        output: directory,
        profiles: undefined,
        selected: undefined,
        path: join(directory, name),
      },
      // The name of a diff carrying asset files is reserved too.
      {
        output: join(directory, 'assets'),
        profiles: undefined,
        selected: undefined,
        path: join(
          directory,
          'assets',
          `${timestamp}_syncFaqContent.diff-records-assets.zip`,
        ),
      },
      {
        output: undefined,
        profiles: undefined,
        selected: undefined,
        path: join(directory, 'migrations', 'content', name),
      },
      {
        output: undefined,
        profiles: undefined,
        selected: { migrations: { directory: '../single-profile' } },
        path: join(directory, 'single-profile', 'content', name),
      },
      {
        output: undefined,
        profiles: {
          source: { migrations: { directory: '../wrong-source' } },
          destination: { migrations: { directory: '../destination-profile' } },
        },
        selected: undefined,
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
              output: entry.output,
              concurrency: 4,
              ...(entry.profiles
                ? {
                    'source-profile': 'source',
                    'destination-profile': 'destination',
                  }
                : {}),
            },
          }),
          datoConfigPath: join(nested, 'datocms.config.json'),
          datoConfig: entry.profiles ? { profiles: entry.profiles } : undefined,
          datoProfileConfig: entry.selected,
          endpoint: async () =>
            assert.fail('existing output must fail before authentication'),
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

  it('projects each configured migration tracking model from capture and planning', async () => {
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
    const endpoints: Record<string, unknown> = {
      source: project(['source']),
      destination: project(['destination']),
    };
    const command = instance(ContentDiffCommand, {
      datoConfig: {
        profiles: {
          source: { migrations: { modelApiKey: 'source_migration' } },
          destination: { migrations: { modelApiKey: 'destination_migration' } },
        },
      },
      parse: async () => ({
        args: { NAME: 'content' },
        flags: {
          source: 'source',
          destination: 'destination',
          output: join(directory, 'diff.zip'),
          'source-profile': 'source',
          'destination-profile': 'destination',
          'item-types': 'all',
          uploads: 'referenced',
          concurrency: 4,
        },
      }),
      endpoint: async (profile: string) => endpoints[profile],
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
          flags: { output: directory, concurrency: 3, ...flags },
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
    assert.equal(defaults.flags.output, undefined);
    assert.equal(defaults.flags.concurrency, 8);
    const given = await parse([
      'backup',
      '--environment=staging',
      '--include-assets',
      '--output=./backups',
      '--concurrency=16',
    ]);
    assert.deepEqual(given.args, { NAME: 'backup' });
    assert.equal(given.flags.environment, 'staging');
    assert.equal(given.flags['include-assets'], true);
    assert.equal(given.flags.output, './backups');
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

  it('reports preflight without running operations and keeps JSON output quiet', async () => {
    const preview: PreflightResult = {
      preflightOnly: true,
      environmentId: 'main',
      executed: false,
      operations: 3,
      partial: true,
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
              'Partial diff: generation omitted unsupported content.',
            ],
      );
    }
  });

  it('passes explicit application authorization to the executor and returns its result', async () => {
    const result = {
      environmentId: 'isolated',
      executed: true,
      operations: 2,
      partial: false,
    };
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
            fastFork: false,
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
          'fast-fork': false,
          'keep-failed-fork': true,
          concurrency: 2,
        },
      }),
      client: {},
      buildBaseClientInitializationOptions: async () => ({
        apiToken: 'fixture-token',
      }),
      jsonEnabled: () => true,
    });
    assert.deepEqual(await command.run(), result);
  });

  it('creates fast forks unless --no-fast-fork is given', async () => {
    const parse = async (argv: string[]) =>
      (
        await oclif.Parser.parse(argv, {
          args: ContentApplyCommand.args,
          flags: ContentApplyCommand.flags,
        })
      ).flags['fast-fork'];
    assert.equal(await parse(['./diff.zip']), true);
    assert.equal(await parse(['./diff.zip', '--no-fast-fork']), false);
    assert.equal(await parse(['./diff.zip', '--fast-fork']), true);
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
            args.buildEnvironmentClient('review'),
            args.buildEnvironmentClient('main'),
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
          partial: false,
        };
      },
    );
    await command.run();
    assert.equal(resolutions(), 1);
  });

  it('passes each paired profile its own endpoint API token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-command-tokens-'));
    const requested: [string | undefined, string | undefined][] = [];
    const command = instance(ContentDiffCommand, {
      parse: async () => ({
        args: { NAME: 'contentMigration' },
        flags: {
          source: 'source',
          destination: 'primary',
          output: directory,
          'source-profile': 'one',
          'destination-profile': 'two',
          'source-api-token': 'source-token',
          'destination-api-token': 'destination-token',
          'item-types': 'all',
          uploads: 'referenced',
          concurrency: 4,
        },
      }),
      endpoint: async (profileId?: string, apiToken?: string) => {
        requested.push([profileId, apiToken]);
        return {
          rootClient: {
            environments: {
              list: async () => {
                throw new Error('stop after endpoint selection');
              },
            },
          },
          buildEnvironmentClient: () => ({}),
        };
      },
      jsonEnabled: () => true,
    });
    try {
      await assert.rejects(command.run(), /stop after endpoint selection/);
      assert.deepEqual(requested.sort(), [
        ['one', 'source-token'],
        ['two', 'destination-token'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a partial diff and a kept fork in human-readable output', async () => {
    let outcome: unknown = {
      environmentId: 'isolated',
      executed: true,
      operations: 4,
      partial: true,
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
      partial: false,
    };
    await command('./diff.zip').run();
    assert.deepEqual(logged, [
      'Ran 4 operations in environment "isolated" (generation omitted unsupported content).',
      'Ran 4 operations in environment "isolated" (generation omitted unsupported content).',
      'Ran 1 operations in environment "isolated".',
    ]);
    outcome = new ContentError('APPLY_FAILED', 'Injected failure.');
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
            new ContentError('APPLY_FAILED', 'Request failed.', {
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
            code: 'APPLY_FAILED',
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

  // Unlike CmaClientCommand, these commands' --output names a file, not an
  // output format, so it does not silence request logs.
  for (const [name, Command, level] of [
    [
      'content:diff',
      ContentDiffCommand,
      async (command: {
        endpoint(): Promise<{ rootClient: CmaClient.Client }>;
      }) => (await command.endpoint()).rootClient.config.logLevel,
    ],
    [
      'content:export',
      ContentExportCommand,
      async (command: {
        buildBaseClientInitializationOptions(): Promise<{ logLevel?: unknown }>;
      }) => (await command.buildBaseClientInitializationOptions()).logLevel,
    ],
  ] as const)
    it(`honors --log-level for ${name} despite its --output flag`, async () => {
      const levels: unknown[] = [];
      for (const [flags, profile] of [
        [{ 'log-level': 'BODY' }, undefined],
        [{}, { logLevel: 'BASIC' }],
        [{ 'log-level': 'BODY', json: true }, undefined],
        [{}, undefined],
      ] as const) {
        const command = instance(Command, {
          parse: async () => ({
            flags: {
              source: 'source',
              output: './diff.zip',
              'api-token': 'placeholder-token',
              ...flags,
            },
          }),
          profileId: 'default',
          datoProfileConfig: profile,
        });
        levels.push(await level(command));
      }
      assert.deepEqual(levels, [
        CmaClient.LogLevel.BODY,
        CmaClient.LogLevel.BASIC,
        CmaClient.LogLevel.NONE,
        CmaClient.LogLevel.NONE,
      ]);
    });

  it('rejects incompatible or unknown CLI flags before resolving client authentication', () =>
    assertRejectedBeforeAuthentication([
      ...['versions', 'full'].map((verification) => ({
        args: ['content:diff', '--source=a', `--verification=${verification}`],
        message: /Nonexistent flag: --verification/,
        status: 2,
      })),
      {
        args: ['content:diff', '--output=b'],
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
        args: [
          'content:diff',
          '--source-dump=b.zip',
          '--source-profile=one',
          '--destination-profile=two',
        ],
        message:
          /--source-profile=one cannot also be provided when using --source-dump/,
        status: 2,
      },
      {
        args: [
          'content:diff',
          '--source=a',
          '--output=b',
          '--source-profile=one',
        ],
        message:
          /All of the following must be provided when using --source-profile: --destination-profile/,
        status: 2,
      },
      {
        args: [
          'content:diff',
          '--source=a',
          '--output=b',
          '--source-profile=',
          '--destination-profile=two',
        ],
        message: /Both source and destination profiles must be nonempty\./,
        status: 2,
      },
      {
        args: [
          'content:diff',
          '--source=a',
          '--output=b',
          '--source-profile=one',
          '--destination-profile=two',
          '--profile=three',
        ],
        message: /--profile and --api-token select a single project\./,
        status: 2,
      },
      {
        args: [
          'content:diff',
          '--source=a',
          '--output=b',
          '--source-profile=one',
          '--destination-profile=two',
          '--api-token=placeholder-flag-token',
        ],
        message: /--profile and --api-token select a single project\./,
        status: 2,
      },
      {
        args: ['content:diff', '--source=a', '--output=b', '--concurrency=0'],
        message: /Expected an integer greater than or equal to 1/,
        status: 2,
      },
      {
        args: ['content:diff', '--source=a', '--output=b', '--concurrency=17'],
        message: /Expected an integer less than or equal to 16/,
        status: 2,
      },
      {
        args: ['content:diff', '--source=a', '--chunk-bytes=1024'],
        message: /Nonexistent flag: --chunk-bytes/,
        status: 2,
      },
      {
        args: ['content:diff', '!!!', '--source=a', '--output=b'],
        message: /name must contain letters or numbers/,
        code: 'INVALID_NAME',
        status: 1,
      },
      ...['script.js', 'sync.tsx', 'migration.ts'].map((output) => ({
        args: ['content:diff', '--source=a', `--output=${output}`],
        message: /output must be a \.zip file or a directory/,
        code: 'INVALID_OUTPUT_PATH',
        status: 1,
      })),
      {
        args: [
          'content:diff',
          '--source=a',
          '--output=b',
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
        args: ['content:apply', './diff.zip', '--verification=full'],
        message: /Nonexistent flag: --verification/,
        status: 2,
      },
      ...['./migration.ts', './migration.content'].map((file) => ({
        args: ['content:apply', file],
        message: /Pass the \.zip diff written by content:diff/,
        code: 'INVALID_DIFF_PATH',
        status: 1,
      })),
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
    ])).timeout(240_000);

  it('rejects content:export names and output paths before resolving client authentication', () =>
    assertRejectedBeforeAuthentication([
      {
        args: ['content:export', '!!!'],
        message: /name must contain letters or numbers/,
        code: 'INVALID_NAME',
        status: 1,
      },
      {
        args: ['content:export', '--output=dump.ts'],
        message: /output must be a \.zip file or a directory/,
        code: 'INVALID_OUTPUT_PATH',
        status: 1,
      },
    ])).timeout(60_000);

  it('rejects a source API token beside a source dump without printing the token', () =>
    assertRejectedBeforeAuthentication([
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
