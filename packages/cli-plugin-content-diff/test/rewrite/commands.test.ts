import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'mocha';
import ContentApplyCommand from '../../src/commands/content/apply';
import ContentDiffCommand from '../../src/commands/content/diff';
import * as apply from '../../src/engine/apply';
import * as bundle from '../../src/engine/bundle';
import * as capture from '../../src/engine/capture';
import * as planner from '../../src/engine/planner';
import * as schema from '../../src/engine/schema';
import type { SnapshotStore } from '../../src/engine/store';
import type { PlanMetadata, SchemaState } from '../../src/engine/types';
import {
  concurrency,
  environmentId,
  selectedModels,
} from '../../src/utils/content-command';

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
      const cases = [
        ['content:diff', '--source=a', '--output=b', '--source-profile=one'],
        [
          'content:diff',
          '--source=a',
          '--output=b',
          '--source-profile=one',
          '--destination-profile=two',
          '--profile=three',
        ],
        [
          'content:diff',
          '--source=a',
          '--output=b',
          '--source-profile=one',
          '--destination-profile=two',
          '--api-token=placeholder',
        ],
        ['content:diff', '--source=a', '--output=b', '--concurrency=0'],
        ['content:diff', '--source=a', '--output=b', '--chunk-bytes=0'],
        ['content:diff', '--source=a', '--output=b', '--autogenerate=legacy'],
        ['content:apply', './bundle', '--allow-primary'],
      ];
      for (const args of cases) {
        const result = spawnSync(
          process.execPath,
          [join(root, 'bin/dev'), ...args],
          {
            cwd: directory,
            env: environment,
            encoding: 'utf8',
            timeout: 20_000,
          },
        );
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0, args.join(' '));
        assert.doesNotMatch(
          `${result.stdout}${result.stderr}`,
          /Cannot find an API token|No API token is available|OAuth credentials|ECONNREFUSED|ENOTFOUND/,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
