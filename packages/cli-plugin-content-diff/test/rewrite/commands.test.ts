import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { afterEach, describe, it } from 'mocha';
import ContentApplyCommand from '../../src/commands/content/apply';
import ContentDiffCommand from '../../src/commands/content/diff';
import * as apply from '../../src/engine/apply';
import * as bundle from '../../src/engine/bundle';
import * as capture from '../../src/engine/capture';
import { ContentError } from '../../src/engine/errors';
import * as planner from '../../src/engine/planner';
import * as schema from '../../src/engine/schema';
import type { SnapshotStore } from '../../src/engine/store';
import type {
  PlanMetadata,
  RecordState,
  SchemaState,
} from '../../src/engine/types';
import {
  concurrency,
  environmentId,
  selectedModels,
} from '../../src/utils/content-command';
import { REDACTED_CREDENTIAL } from '../../src/utils/credential-redaction';

const root = resolve(__dirname, '../..');
const restorations: (() => void)[] = [];
function replace(target: object, key: string, implementation: unknown): void {
  const original = Reflect.get(target, key);
  Reflect.set(target, key, implementation);
  restorations.push(() => Reflect.set(target, key, original));
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
    assert.equal(concurrency(4), 4);
    for (const invalid of [0, 17, 1.5, Number.NaN])
      assert.throws(() => concurrency(invalid));
  });

  it('captures complete namespaces, plans only selected models, and removes its temporary store', async () => {
    replace(
      schema,
      'assertApplyAccess',
      async (
        _client: unknown,
        target: SchemaState,
        working: SnapshotStore,
        inPlace: boolean,
      ) => {
        assert.equal(target.environmentId, 'target');
        assert.equal(inPlace, true);
        assert.ok(working);
      },
    );
    let working: SnapshotStore | undefined;
    const captures: string[] = [];
    replace(
      schema,
      'fetchSchema',
      async (_client: unknown, environmentId: string) =>
        schemaState(environmentId),
    );
    replace(
      capture,
      'captureSnapshot',
      async (args: Parameters<typeof capture.captureSnapshot>[0]) => {
        working = args.store;
        assert.deepEqual(args.options.modelIds, ['article-id', 'page-id']);
        assert.equal(args.options.uploads, 'all');
        captures.push(args.side);
      },
    );
    const metadata = {
      source: { siteId: 'site', environmentId: 'source' },
      destination: { siteId: 'site', environmentId: 'target' },
      schema: schemaState('target'),
      options: {
        modelIds: ['article-id'],
        uploads: 'referenced',
        includeDeletions: false,
        allowPartial: false,
        allowTemporarySchemaChanges: false,
      },
      temporarySchemaChanges: [],
      counts: {
        record: { create: 0, update: 0, delete: 0, noop: 0, skip: 0 },
        upload: { create: 0, update: 0, delete: 0, noop: 0, skip: 0 },
        collection: { create: 0, update: 0, delete: 0, noop: 0, skip: 0 },
      },
    } as PlanMetadata;
    replace(
      planner,
      'createPlan',
      async (
        _store: SnapshotStore,
        _source: SchemaState,
        _target: SchemaState,
        options: Parameters<typeof planner.createPlan>[3],
      ) => {
        assert.deepEqual(options.modelIds, ['article-id']);
        assert.equal(options.uploads, 'referenced');
        return metadata;
      },
    );
    replace(
      bundle,
      'writeBundle',
      async (args: Parameters<typeof bundle.writeBundle>[0]) => {
        assert.equal(args.store, working);
        assert.equal(existsSync(args.store.filename), true);
        return args.outputPath;
      },
    );
    const directory = await mkdtemp(join(tmpdir(), 'content-command-test-'));
    try {
      const endpoint = {
        rootClient: {
          environments: {
            list: async () => [
              { id: 'source', meta: { primary: false } },
              { id: 'target', meta: { primary: true } },
            ],
          },
        },
        buildEnvironmentClient: (id: string) => ({ id }),
      };
      const command = Object.assign(
        Object.create(ContentDiffCommand.prototype),
        {
          parse: async () => ({
            flags: {
              source: 'source',
              destination: 'primary',
              output: join(directory, 'bundle'),
              'item-types': 'article',
              uploads: 'referenced',
              concurrency: 4,
              'chunk-bytes': 1024,
              'include-deletions': false,
              'allow-partial': false,
              'allow-temporary-schema-changes': false,
            },
          }),
          endpoint: async () => endpoint,
          progress: () => undefined,
          jsonEnabled: () => true,
        },
      );
      const result = await command.run();
      assert.equal(result.destinationEnvironmentId, 'target');
      assert.deepEqual(captures, ['source', 'target']);
      assert.ok(working);
      assert.equal(existsSync(working.directory), false);
      replace(bundle, 'writeBundle', async () => {
        throw new Error('download failed');
      });
      await assert.rejects(command.run(), /download failed/);
      assert.equal(existsSync(working.directory), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('captures two projects at once, each into its own store, and stops both on failure', async () => {
    replace(schema, 'assertApplyAccess', async () => undefined);
    replace(
      schema,
      'fetchSchema',
      async (_client: unknown, environmentId: string) =>
        schemaState(environmentId),
    );
    const record = (id: string): RecordState => ({
      id,
      modelId: 'article-id',
      current: {},
      published: null,
      currentVersion: '1',
      publishedUpdatedAt: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      firstPublishedAt: null,
      parentId: null,
      position: null,
      stage: null,
      schedules: { publication: null, unpublishing: null },
      validity: { current: true, published: null },
      hash: id,
    });
    let active = 0;
    let maximum = 0;
    const stores = new Map<string, SnapshotStore>();
    let failDestination = false;
    let sourceAborted = false;
    replace(
      capture,
      'captureSnapshot',
      async (args: Parameters<typeof capture.captureSnapshot>[0]) => {
        active++;
        maximum = Math.max(maximum, active);
        stores.set(args.side, args.store);
        try {
          if (failDestination) {
            if (args.side === 'target') throw new Error('destination failed');
            await new Promise<void>((resolve) =>
              args.options.signal!.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            sourceAborted = true;
            throw new ContentError('INTERRUPTED', 'Interrupted.');
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          args.store.putRecord(args.side, record(`${args.side}-record`));
        } finally {
          active--;
        }
      },
    );
    replace(planner, 'createPlan', async (store: SnapshotStore) => {
      // The destination was read into its own store and imported here.
      assert.equal(store, stores.get('source'));
      assert.notEqual(store, stores.get('target'));
      assert.ok(store.getRecord('source', 'source-record'));
      assert.ok(store.getRecord('target', 'target-record'));
      throw new Error('stop after planning input');
    });
    const directory = await mkdtemp(join(tmpdir(), 'content-command-test-'));
    try {
      const endpoint = (environmentId: string) => ({
        rootClient: {
          environments: {
            list: async () => [{ id: environmentId, meta: { primary: true } }],
          },
        },
        buildEnvironmentClient: (id: string) => ({ id }),
      });
      const endpoints = {
        'source-profile': endpoint('source'),
        'destination-profile': endpoint('target'),
      };
      const command = Object.assign(
        Object.create(ContentDiffCommand.prototype),
        {
          parse: async () => ({
            flags: {
              source: 'source',
              destination: 'target',
              'source-profile': 'source-profile',
              'destination-profile': 'destination-profile',
              output: join(directory, 'bundle'),
              'item-types': 'all',
              uploads: 'referenced',
              concurrency: 4,
              'chunk-bytes': 1024,
              'include-deletions': false,
              'allow-partial': false,
              'allow-temporary-schema-changes': false,
            },
          }),
          endpoint: async (profile: keyof typeof endpoints) =>
            endpoints[profile],
          progress: () => undefined,
          jsonEnabled: () => true,
        },
      );
      await assert.rejects(command.run(), /stop after planning input/);
      assert.equal(maximum, 2);
      for (const store of stores.values())
        assert.equal(existsSync(store.directory), false);
      failDestination = true;
      await assert.rejects(command.run(), /destination failed/);
      assert.equal(sourceAborted, true);
      for (const store of stores.values())
        assert.equal(existsSync(store.directory), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('routes --repair to the repair executor with its authorization', async () => {
    const result = {
      environmentId: 'destination',
      restoredSchedules: 2,
      restoredFields: 1,
    };
    replace(apply, 'applyBundle', async () => assert.fail('apply ran'));
    replace(
      apply,
      'repairBundle',
      async (args: Parameters<typeof apply.repairBundle>[0]) => {
        assert.equal(args.bundlePath, './bundle');
        const { signal, ...options } = args.options;
        assert.ok(signal instanceof AbortSignal);
        assert.deepEqual(
          { ...options, log: undefined },
          {
            allowPrimary: true,
            destinationEnvironmentId: 'main',
            log: undefined,
          },
        );
        return result;
      },
    );
    const command = Object.assign(
      Object.create(ContentApplyCommand.prototype),
      {
        parse: async () => ({
          args: { BUNDLE: './bundle' },
          flags: {
            destination: 'main',
            'in-place': false,
            'allow-primary': true,
            repair: true,
            'schedule-window': 120,
            'keep-failed-fork': false,
            'allow-temporary-schema-changes': false,
            concurrency: 4,
          },
        }),
        endpoint: async () => ({
          rootClient: {},
          buildEnvironmentClient: () => ({}),
        }),
        progress: () => undefined,
        jsonEnabled: () => true,
      },
    );
    assert.deepEqual(await command.run(), result);
  });

  it('passes explicit application authorization to the executor and returns its result', async () => {
    const result = { environmentId: 'isolated', mutations: 3 };
    replace(
      apply,
      'applyBundle',
      async (args: Parameters<typeof apply.applyBundle>[0]) => {
        assert.equal(args.bundlePath, './bundle');
        const { signal, ...options } = args.options;
        assert.ok(signal instanceof AbortSignal);
        assert.equal(signal.aborted, false);
        assert.deepEqual(
          { ...options, log: undefined },
          {
            inPlace: false,
            allowPrimary: false,
            keepFailedFork: true,
            allowTemporarySchemaChanges: true,
            destinationEnvironmentId: 'target',
            concurrency: 2,
            scheduleWindowMinutes: 45,
            log: undefined,
          },
        );
        return result;
      },
    );
    const command = Object.assign(
      Object.create(ContentApplyCommand.prototype),
      {
        parse: async () => ({
          args: { BUNDLE: './bundle' },
          flags: {
            destination: 'target',
            'in-place': false,
            'allow-primary': false,
            repair: false,
            'schedule-window': 45,
            'keep-failed-fork': true,
            'allow-temporary-schema-changes': true,
            concurrency: 2,
          },
        }),
        endpoint: async () => ({
          rootClient: {},
          buildEnvironmentClient: () => ({}),
        }),
        progress: () => undefined,
        jsonEnabled: () => true,
      },
    );
    assert.deepEqual(await command.run(), result);
  });

  it('passes each paired profile its own endpoint API token', async () => {
    const requested: [string | undefined, string | undefined][] = [];
    const command = Object.assign(Object.create(ContentDiffCommand.prototype), {
      parse: async () => ({
        flags: {
          source: 'source',
          destination: 'primary',
          output: join(tmpdir(), `content-command-missing-${process.pid}`),
          'source-profile': 'one',
          'destination-profile': 'two',
          'source-api-token': 'source-token',
          'destination-api-token': 'destination-token',
          'item-types': 'all',
          uploads: 'referenced',
          concurrency: 4,
          'chunk-bytes': 1024,
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
      progress: () => undefined,
      jsonEnabled: () => true,
    });
    await assert.rejects(command.run(), /stop after endpoint selection/);
    assert.deepEqual(requested, [
      ['one', 'source-token'],
      ['two', 'destination-token'],
    ]);
  });

  it('reports a partial bundle and a kept fork in human-readable output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-command-apply-'));
    try {
      const counts = (skip: number) => ({
        create: 0,
        update: 1,
        delete: 0,
        noop: 0,
        skip,
      });
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          counts: {
            record: counts(2),
            upload: counts(1),
            collection: counts(0),
          },
        }),
      );
      let outcome: unknown = {
        environmentId: 'isolated',
        mutations: 3,
        partial: true,
      };
      replace(
        apply,
        'applyBundle',
        async (args: Parameters<typeof apply.applyBundle>[0]) => {
          if (outcome instanceof Error) {
            args.options.log?.('Kept failed fork content-apply-kept');
            throw outcome;
          }
          return outcome;
        },
      );
      const logged: string[] = [];
      const progress: string[] = [];
      const command = (bundlePath: string) =>
        Object.assign(Object.create(ContentApplyCommand.prototype), {
          parse: async () => ({
            args: { BUNDLE: bundlePath },
            flags: {
              'in-place': false,
              'allow-primary': false,
              repair: false,
              'schedule-window': 120,
              'keep-failed-fork': true,
              'allow-temporary-schema-changes': false,
              concurrency: 4,
            },
          }),
          endpoint: async () => ({
            rootClient: {},
            buildEnvironmentClient: () => ({}),
          }),
          log: (message: string) => logged.push(message),
          logToStderr: (message: string) => progress.push(message),
          jsonEnabled: () => false,
        });
      await command(directory).run();
      await command(join(directory, 'missing')).run();
      outcome = { environmentId: 'isolated', mutations: 3, partial: false };
      await command(directory).run();
      assert.deepEqual(logged, [
        'Applied 3 mutations in environment "isolated" from a partial bundle; 3 skipped entries were not applied.',
        'Applied 3 mutations in environment "isolated" from a partial bundle; its skipped entries were not applied.',
        'Applied 3 mutations in environment "isolated".',
      ]);
      outcome = new ContentError('APPLY_FAILED', 'Injected failure.');
      await assert.rejects(command(directory).run(), /Injected failure/);
      assert.deepEqual(progress, ['Kept failed fork content-apply-kept']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports --json failures as redacted JSON errors with the human exit status', async () => {
    const reported: unknown[] = [];
    const command = Object.assign(
      Object.create(ContentApplyCommand.prototype),
      {
        jsonEnabled: () => true,
        logJson: (json: unknown) => reported.push(json),
      },
    );
    command.credentialRedactor.register('failure-token');
    const previousExitCode = process.exitCode;
    const exitCodes: unknown[] = [];
    try {
      for (const error of [
        Object.assign(
          new ContentError(
            'APPLY_FAILED',
            'Request with failure-token failed.',
            { step: 'records' },
          ),
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
          message: `Request with ${REDACTED_CREDENTIAL} failed.`,
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
    const human = Object.assign(Object.create(ContentApplyCommand.prototype), {
      jsonEnabled: () => false,
      logJson: () => assert.fail(),
    });
    human.credentialRedactor.register('failure-token');
    const failure = Object.assign(new Error('Uses failure-token.'), {
      oclif: { exit: 2 },
    });
    await assert.rejects(human.catch(failure), (error) => error === failure);
    assert.equal(failure.message, `Uses ${REDACTED_CREDENTIAL}.`);
  });

  it('honors --log-level for content:diff despite its --output flag', async () => {
    const levels: unknown[] = [];
    for (const [flags, profile] of [
      [{ 'log-level': 'BODY' }, undefined],
      [{}, { logLevel: 'BASIC' }],
      [{ 'log-level': 'BODY', json: true }, undefined],
      [{}, undefined],
    ] as const) {
      const command = Object.assign(
        Object.create(ContentDiffCommand.prototype),
        {
          parse: async () => ({
            flags: {
              source: 'source',
              output: './bundle',
              'api-token': 'placeholder-token',
              ...flags,
            },
          }),
          profileId: 'default',
          datoProfileConfig: profile,
        },
      );
      const { rootClient } = await command.endpoint();
      levels.push(rootClient.config.logLevel);
    }
    assert.deepEqual(levels, [
      CmaClient.LogLevel.BODY,
      CmaClient.LogLevel.BASIC,
      CmaClient.LogLevel.NONE,
      CmaClient.LogLevel.NONE,
    ]);
  });

  it('rejects incompatible or legacy CLI flags before resolving client authentication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-command-parse-'));
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DATOCMS_CONFIG_FILE: join(directory, 'missing.json'),
    };
    environment.DATOCMS_PROFILE = undefined;
    for (const key of Object.keys(environment))
      if (/^DATOCMS_.*API_TOKEN$/.test(key)) delete environment[key];
    try {
      const cases: {
        args: string[];
        message: RegExp;
        code?: string;
        status: number;
      }[] = [
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
          message: /Concurrency must be an integer from 1 to 16\./,
          code: 'INVALID_CONCURRENCY',
          status: 1,
        },
        {
          args: ['content:diff', '--source=a', '--output=b', '--chunk-bytes=0'],
          message: /--chunk-bytes must be a positive safe integer\./,
          code: 'INVALID_CHUNK_SIZE',
          status: 1,
        },
        {
          args: [
            'content:diff',
            '--source=a',
            '--output=b',
            '--api-token=placeholder-flag-token',
            '--autogenerate=legacy',
          ],
          message: /Nonexistent flag: --autogenerate=legacy/,
          status: 2,
        },
        {
          args: ['content:apply', './bundle', '--schedule-window=-5'],
          message: /--schedule-window must be a whole number of minutes/,
          code: 'INVALID_SCHEDULE_WINDOW',
          status: 1,
        },
        {
          args: ['content:apply', './bundle', '--repair', '--in-place'],
          message:
            /--in-place=true cannot also be provided when using --repair/,
          status: 2,
        },
        {
          args: ['content:apply', './bundle', '--allow-primary'],
          message: /--allow-primary requires --in-place or --repair\./,
          code: 'INVALID_PRIMARY_AUTHORIZATION',
          status: 1,
        },
      ];
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
          assert.equal(result.status, status, label);
          assert.doesNotMatch(
            `${result.stdout}${result.stderr}`,
            /Cannot find an API token|No API token is available|OAuth credentials|ECONNREFUSED|ENOTFOUND|placeholder-flag-token/,
            label,
          );
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
  });
});
