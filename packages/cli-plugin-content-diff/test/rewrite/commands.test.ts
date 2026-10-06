import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { afterEach, describe, it } from 'mocha';
import ContentApplyCommand from '../../src/commands/content/apply';
import ContentDiffCommand from '../../src/commands/content/diff';
import * as capture from '../../src/engine/capture';
import { ContentError } from '../../src/engine/errors';
import * as artifact from '../../src/engine/migration-artifact';
import { MAX_MIGRATION_CHUNK_BYTES } from '../../src/engine/migration-limits';
import * as planner from '../../src/engine/planner';
import * as schema from '../../src/engine/schema';
import * as storage from '../../src/engine/store';
import type { SnapshotStore } from '../../src/engine/store';
import type {
  ApplyPreviewResult,
  PlanMetadata,
  RecordState,
  SchemaState,
} from '../../src/engine/types';
import * as apply from '../../src/migration';
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
        storage,
        'SnapshotStore',
        class {
          constructor() {
            assert.fail(
              'An incompatible schema must fail before allocating SQLite',
            );
          }
        },
      );
      replace(capture, 'captureSnapshot', async () => {
        assert.fail('Neither environment should have its content read');
      });
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
            args: { NAME: 'firstDiff' },
            flags: {
              source: 'source',
              destination: 'target',
              output: join(directory, 'migration.ts'),
              'item-types': 'article',
              concurrency: 4,
              'chunk-bytes': 1024,
              ...(pairedProfiles
                ? {
                    'source-profile': 'source',
                    'destination-profile': 'target',
                  }
                : {}),
            },
          }),
          endpoint: async () => ({ ...endpoint }),
          progress: () => undefined,
          jsonEnabled: () => true,
        },
      );
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
          assert.equal(existsSync(join(directory, 'migration.ts')), false);
          assert.equal(existsSync(join(directory, 'migration.content')), false);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

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
        assert.equal(args.verify, false);
        assert.equal(args.options.schemaProjection, undefined);
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
      artifact,
      'writeMigration',
      async (args: Parameters<typeof artifact.writeMigration>[0]) => {
        assert.equal(args.store, working);
        assert.equal(existsSync(args.store.filename), true);
        assert.deepEqual(args.sourceTracking, {
          apiKey: 'schema_migration',
          model: null,
        });
        assert.deepEqual(args.destinationTracking, {
          apiKey: 'schema_migration',
          model: null,
        });
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
              output: join(directory, 'migrations'),
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
      assert.match(result.scriptPath, /\d+_contentMigration\.ts$/);
      assert.equal('bundlePath' in result, false);
      assert.deepEqual(captures, ['source', 'target']);
      assert.ok(working);
      assert.equal(existsSync(working.directory), false);
      replace(artifact, 'writeMigration', async () => {
        throw new Error('download failed');
      });
      await assert.rejects(command.run(), /download failed/);
      assert.equal(existsSync(working.directory), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('generates with one capture per environment and no schema or content verification rereads', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'content-command-single-pass-'),
    );
    const schemaReads: string[] = [];
    const recordReads: string[] = [];
    const assetReads: string[] = [];
    const collectionReads: string[] = [];
    const permissions: string[] = [];
    const progress: string[] = [];
    replace(
      schema,
      'fetchSchema',
      async (
        _client: unknown,
        environment: string,
        projection?: (state: SchemaState) => SchemaState,
      ) => {
        schemaReads.push(environment);
        const state = schemaState(environment);
        state.hash = schema.schemaHash(state);
        return projection ? projection(state) : state;
      },
    );
    replace(
      schema,
      'assertFullReadAccess',
      async (_client: unknown, state: SchemaState) => {
        permissions.push(state.environmentId);
      },
    );
    replace(schema, 'assertApplyAccess', async () => undefined);
    replace(
      artifact,
      'writeMigration',
      async (args: Parameters<typeof artifact.writeMigration>[0]) =>
        args.outputPath,
    );
    const command = Object.assign(Object.create(ContentDiffCommand.prototype), {
      parse: async () => ({
        args: { NAME: 'firstDiff' },
        flags: {
          source: 'source',
          destination: 'target',
          output: join(directory, 'migration.ts'),
          'item-types': 'all',
          uploads: 'referenced',
          concurrency: 4,
          'chunk-bytes': 1024,
          'include-deletions': false,
          'allow-partial': false,
          'allow-temporary-schema-changes': false,
        },
      }),
      endpoint: async () => ({
        rootClient: {
          environments: {
            list: async () => [
              { id: 'source', meta: { primary: false } },
              { id: 'target', meta: { primary: true } },
            ],
          },
        },
        buildEnvironmentClient: (environment: string) => ({
          request: async ({
            queryParams,
          }: {
            queryParams: { filter: { type: string }; version: string };
          }) => {
            recordReads.push(
              `${environment}:${queryParams.filter.type}:${queryParams.version}`,
            );
            return { data: [], meta: { total_count: 0 } };
          },
          uploads: {
            rawList: async () => {
              assetReads.push(environment);
              return { data: [], meta: { total_count: 0 } };
            },
          },
          uploadCollections: {
            list: async () => {
              collectionReads.push(environment);
              return [];
            },
          },
        }),
      }),
      progress: (message: string) => progress.push(message),
      jsonEnabled: () => true,
    });
    try {
      await command.run();
      assert.deepEqual(schemaReads, ['source', 'target']);
      assert.deepEqual(
        recordReads,
        ['source', 'target'].flatMap((environment) =>
          ['article-id', 'page-id'].flatMap((model) =>
            ['current', 'published'].map(
              (version) => `${environment}:${model}:${version}`,
            ),
          ),
        ),
      );
      assert.deepEqual(assetReads, ['source', 'target']);
      assert.deepEqual(collectionReads, ['source', 'target']);
      assert.deepEqual(permissions, ['source', 'target']);
      assert.doesNotMatch(
        progress.join('\n'),
        /Checking capture consistency|Listing .* versions/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps default content scripts below the schema migration directory and honors explicit output', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'content-command-path-')),
    );
    const previousDirectory = process.cwd();
    const timestamp = 1_700_000_000;
    replace(Date, 'now', () => timestamp * 1000);
    const nested = join(directory, 'config');
    await mkdir(nested);
    const cases = [
      {
        output: join(directory, 'explicit.ts'),
        profiles: undefined,
        selected: undefined,
        path: join(directory, 'explicit.ts'),
      },
      {
        output: directory,
        profiles: undefined,
        selected: undefined,
        path: join(directory, `${timestamp}_syncFaqContent.ts`),
      },
      {
        output: undefined,
        profiles: undefined,
        selected: undefined,
        path: join(
          directory,
          'migrations',
          'content',
          `${timestamp}_syncFaqContent.ts`,
        ),
      },
      {
        output: undefined,
        profiles: undefined,
        selected: { migrations: { directory: '../single-profile' } },
        path: join(
          directory,
          'single-profile',
          'content',
          `${timestamp}_syncFaqContent.ts`,
        ),
      },
      {
        output: undefined,
        profiles: {
          source: { migrations: { directory: '../wrong-source' } },
          destination: { migrations: { directory: '../destination-profile' } },
        },
        selected: undefined,
        path: join(
          directory,
          'destination-profile',
          'content',
          `${timestamp}_syncFaqContent.ts`,
        ),
      },
    ];
    try {
      process.chdir(directory);
      for (const entry of cases) {
        await mkdir(resolve(entry.path, '..'), { recursive: true });
        await writeFile(entry.path, 'existing');
        const command = Object.assign(
          Object.create(ContentDiffCommand.prototype),
          {
            parse: async () => ({
              args: { NAME: 'sync FAQ content' },
              flags: {
                source: 'source',
                output: entry.output,
                concurrency: 4,
                'chunk-bytes': 1024,
                ...(entry.profiles
                  ? {
                      'source-profile': 'source',
                      'destination-profile': 'destination',
                    }
                  : {}),
              },
            }),
            datoConfigPath: join(nested, 'datocms.config.json'),
            datoConfig: entry.profiles
              ? { profiles: entry.profiles }
              : undefined,
            datoProfileConfig: entry.selected,
            endpoint: async () =>
              assert.fail('existing output must fail before authentication'),
            progress: () => undefined,
            jsonEnabled: () => true,
          },
        );
        await assert.rejects(command.run(), (error: ContentError) => {
          assert.equal(error.code, 'MIGRATION_EXISTS');
          assert.equal(
            error.message,
            `Migration output already exists: ${entry.path}`,
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
        ...result.models[0],
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
      'captureSnapshot',
      async (options: Parameters<typeof capture.captureSnapshot>[0]) => {
        captured.push(options.side);
        assert.deepEqual(
          options.schema.models.map((model) => model.id),
          ['article-id', 'page-id', 'block-id'],
        );
        assert.equal(options.verify, false);
        assert.equal(options.options.schemaProjection, undefined);
        assert.deepEqual(options.options.modelIds, ['article-id', 'page-id']);
      },
    );
    replace(
      planner,
      'createPlan',
      async (
        _store: unknown,
        source: SchemaState,
        destination: SchemaState,
      ) => {
        assert.equal(source.models.length, 3);
        assert.equal(destination.models.length, 3);
        throw new Error('projection verified');
      },
    );
    const endpoints = Object.fromEntries(
      ['source', 'destination'].map((environment) => [
        environment,
        {
          rootClient: {
            environments: {
              list: async () => [{ id: environment, meta: { primary: true } }],
            },
          },
          buildEnvironmentClient: () => ({}),
        },
      ]),
    );
    const command = Object.assign(Object.create(ContentDiffCommand.prototype), {
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
          output: join(directory, 'migration.ts'),
          'source-profile': 'source',
          'destination-profile': 'destination',
          'item-types': 'all',
          uploads: 'referenced',
          concurrency: 4,
          'chunk-bytes': 1024,
        },
      }),
      endpoint: async (profile: string) => endpoints[profile],
      progress: () => undefined,
      jsonEnabled: () => true,
    });
    try {
      await assert.rejects(command.run(), /projection verified/);
      assert.deepEqual(captured.sort(), ['source', 'target']);
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
        assert.equal(args.verify, false);
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
              output: join(directory, 'migrations'),
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
    replace(apply, 'applyContentMigration', async () =>
      assert.fail('apply ran'),
    );
    replace(
      apply,
      'repairContentMigration',
      async (args: Parameters<typeof apply.repairContentMigration>[0]) => {
        assert.equal(args.scriptPath, './migration.ts');
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
          args: { SCRIPT: './migration.ts' },
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

  it('previews rebuilt groups without an applied message and keeps JSON output quiet', async () => {
    const empty = { create: 0, update: 0, delete: 0, noop: 0, skip: 0 };
    const preview: ApplyPreviewResult = {
      dryRun: true,
      environmentId: 'main',
      mutations: 0,
      partial: true,
      counts: {
        record: { ...empty, update: 2 },
        upload: empty,
        collection: empty,
      },
      groups: [
        {
          kind: 'record',
          model: { id: 'article', apiKey: 'article', name: 'Articles' },
          counts: { ...empty, update: 2 },
        },
      ],
      temporarySchemaChanges: 1,
    };
    replace(
      apply,
      'applyContentMigration',
      async (args: Parameters<typeof apply.applyContentMigration>[0]) => {
        assert.equal(args.options.dryRun, true);
        assert.equal(args.options.forkName, 'content-review');
        assert.equal(args.options.destinationEnvironmentId, 'main');
        return preview;
      },
    );
    for (const json of [false, true]) {
      const logs: string[] = [];
      const command = Object.assign(
        Object.create(ContentApplyCommand.prototype),
        {
          parse: async () => ({
            args: { SCRIPT: './migration.ts' },
            flags: {
              destination: 'main',
              'dry-run': true,
              'fork-name': 'content-review',
              'in-place': false,
              'allow-primary': false,
              repair: false,
              'schedule-window': 120,
              'keep-failed-fork': false,
              'allow-temporary-schema-changes': true,
              concurrency: 4,
            },
          }),
          endpoint: async () => ({
            rootClient: {},
            buildEnvironmentClient: () => ({}),
          }),
          progress: () => undefined,
          log: (message: string) => logs.push(message),
          jsonEnabled: () => json,
        },
      );
      assert.deepEqual(await command.run(), preview);
      if (json) assert.deepEqual(logs, []);
      else {
        assert.match(
          logs.join('\n'),
          /Articles \(article\): 0 create, 2 update, 0 delete/,
        );
        assert.match(logs.join('\n'), /1 temporary field changes required/);
        assert.match(logs.join('\n'), /Partial migration/);
        assert.doesNotMatch(logs.join('\n'), /Applied \d+ mutations/);
      }
    }
  });

  it('passes explicit application authorization to the executor and returns its result', async () => {
    const result = { environmentId: 'isolated', mutations: 3 };
    replace(
      apply,
      'applyContentMigration',
      async (args: Parameters<typeof apply.applyContentMigration>[0]) => {
        assert.equal(args.scriptPath, './migration.ts');
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
            fastFork: true,
            verification: 'full',
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
          args: { SCRIPT: './migration.ts' },
          flags: {
            destination: 'target',
            'in-place': false,
            'allow-primary': false,
            repair: false,
            'schedule-window': 45,
            'fast-fork': true,
            verification: 'full',
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

  it('reports a partial migration and a kept fork in human-readable output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-command-apply-'));
    try {
      let outcome: unknown = {
        environmentId: 'isolated',
        mutations: 3,
        partial: true,
      };
      replace(
        apply,
        'applyContentMigration',
        async (args: Parameters<typeof apply.applyContentMigration>[0]) => {
          if (outcome instanceof Error) {
            args.options.log?.('Kept failed fork content-apply-kept');
            throw outcome;
          }
          return outcome;
        },
      );
      const logged: string[] = [];
      const progress: string[] = [];
      const command = (scriptPath: string) =>
        Object.assign(Object.create(ContentApplyCommand.prototype), {
          parse: async () => ({
            args: { SCRIPT: scriptPath },
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
      await command(join(directory, 'migration.ts')).run();
      await command(join(directory, 'missing.ts')).run();
      outcome = { environmentId: 'isolated', mutations: 3, partial: false };
      await command(join(directory, 'migration.ts')).run();
      assert.deepEqual(logged, [
        'Applied 3 mutations in environment "isolated" from a partial migration; skipped entries were not applied.',
        'Applied 3 mutations in environment "isolated" from a partial migration; skipped entries were not applied.',
        'Applied 3 mutations in environment "isolated".',
      ]);
      outcome = new ContentError('APPLY_FAILED', 'Injected failure.');
      await assert.rejects(
        command(join(directory, 'migration.ts')).run(),
        /Injected failure/,
      );
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
              output: './migration.ts',
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
        ...['versions', 'full'].map((verification) => ({
          args: [
            'content:diff',
            '--source=a',
            `--verification=${verification}`,
          ],
          message: /Nonexistent flag: --verification/,
          status: 2,
        })),
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
          message: /--chunk-bytes must be an integer from 1 to 16776192 bytes/,
          code: 'INVALID_CHUNK_SIZE',
          status: 1,
        },
        ...[MAX_MIGRATION_CHUNK_BYTES + 1, 32 * 1024 * 1024].map(
          (chunkBytes) => ({
            args: [
              'content:diff',
              '--source=a',
              '--output=b',
              `--chunk-bytes=${chunkBytes}`,
            ],
            message:
              /--chunk-bytes must be an integer from 1 to 16776192 bytes/,
            code: 'INVALID_CHUNK_SIZE',
            status: 1,
          }),
        ),
        {
          args: ['content:diff', '!!!', '--source=a', '--output=b'],
          message: /migration name must contain letters or numbers/,
          code: 'INVALID_MIGRATION_NAME',
          status: 1,
        },
        {
          args: ['content:diff', '--source=a', '--output=legacy.js'],
          message: /output must be a \.ts file or a directory/,
          code: 'INVALID_MIGRATION_PATH',
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
          args: ['content:apply', './migration.ts', '--schedule-window=-5'],
          message: /--schedule-window must be a whole number of minutes/,
          code: 'INVALID_SCHEDULE_WINDOW',
          status: 1,
        },
        {
          args: ['content:apply', './migration.ts', '--fork-name=Invalid Name'],
          message: /Fork names must contain only lowercase letters/,
          code: 'INVALID_FORK_NAME',
          status: 1,
        },
        {
          args: ['content:apply', './migration.ts', '--dry-run', '--repair'],
          message: /cannot also be provided when using/,
          status: 2,
        },
        {
          args: [
            'content:apply',
            './migration.ts',
            '--fork-name=review',
            '--in-place',
          ],
          message: /cannot also be provided when using/,
          status: 2,
        },
        {
          args: ['content:apply', './migration.ts', '--repair', '--in-place'],
          message:
            /--in-place=true cannot also be provided when using --repair/,
          status: 2,
        },
        {
          args: ['content:apply', './migration.ts', '--allow-primary'],
          message: /--allow-primary requires --in-place or --repair\./,
          code: 'INVALID_PRIMARY_AUTHORIZATION',
          status: 1,
        },
        {
          args: ['content:apply', './legacy-bundle'],
          message: /Pass the generated \.ts migration entrypoint/,
          code: 'INVALID_MIGRATION_PATH',
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
