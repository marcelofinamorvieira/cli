import assert from 'node:assert/strict';
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
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'mocha';
import * as execution from '../../src/engine/apply';
import * as capture from '../../src/engine/capture';
import { inspectRecord, recordHash } from '../../src/engine/codec';
import { writeMigration } from '../../src/engine/migration-artifact';
import { loadMigrationModule } from '../../src/engine/migration-loader';
import { buildPlanPreview } from '../../src/engine/migration-preview';
import { createPlan } from '../../src/engine/planner';
import * as schemaApi from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  ApplyOptions,
  Client,
  FieldSchema,
  JsonObject,
  PlanEntry,
  RecordPlan,
  RecordState,
  SchemaState,
} from '../../src/engine/types';
import {
  type ContentMigration,
  applyContentMigration,
} from '../../src/migration';
import { fixtureId } from './fixture-id';

const id = fixtureId;
const FAQ = id('runtime-faq');
const PAGE = id('runtime-page');
const CHANGED = id('runtime-changed');
const UNCHANGED = id('runtime-unchanged');
const UNSELECTED = id('runtime-unselected');
const tracking = { apiKey: 'schema_migration', model: null };
const restorations: Array<() => void> = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

function replace(target: object, key: string, replacement: unknown): void {
  const original = Reflect.get(target, key);
  Reflect.set(target, key, replacement);
  restorations.push(() => Reflect.set(target, key, original));
}

function field(apiKey: string, localized = false): FieldSchema {
  return {
    id: id(`runtime-field-${apiKey}`),
    apiKey,
    type: localized ? 'text' : 'string',
    localized,
    validators: {},
    defaultValue: localized ? { en: null, it: null } : null,
  };
}

function schema(): SchemaState {
  const common = {
    block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: true,
    saveInvalidDrafts: true,
    allLocalesRequired: false,
    workflowId: null,
  };
  const value: SchemaState = {
    siteId: 'runtime-site',
    environmentId: 'source',
    locales: ['en', 'it'],
    semantics: {},
    workflows: [],
    hash: '',
    models: [
      {
        ...common,
        id: FAQ,
        apiKey: 'faq',
        name: 'FAQ',
        fields: [field('title'), field('summary', true)],
      },
      {
        ...common,
        id: PAGE,
        apiKey: 'page',
        name: 'Page',
        fields: [field('page_title')],
      },
    ],
  };
  value.hash = schemaApi.schemaHash(value);
  return value;
}

function record(
  recordId: string,
  current: JsonObject,
  modelId = FAQ,
): RecordState {
  const value: RecordState = {
    id: recordId,
    modelId,
    current,
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
  };
  value.hash = recordHash(value);
  return value;
}

function put(
  store: SnapshotStore,
  side: 'source' | 'target',
  value: RecordState,
  state: SchemaState,
) {
  store.putRecord(side, value);
  const inspected = inspectRecord(value, state);
  for (const reference of inspected.references)
    store.putReference(side, reference);
  for (const owner of inspected.blockOwners) store.putBlockOwner(side, owner);
  for (const unique of inspected.uniqueValues)
    store.putUniqueValue(side, unique);
}

async function fixture(chunkBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'content-migration-runtime-'));
  const state = schema();
  const before = [
    record(CHANGED, {
      title: 'Procurement FAQ',
      summary: { en: 'Before', it: 'Prima' },
    }),
    record(UNCHANGED, {
      title: 'Unchanged FAQ',
      summary: { en: 'Keep this', it: 'Conservare' },
    }),
    record(UNSELECTED, { page_title: 'Unselected page' }, PAGE),
  ];
  const after = [
    record(CHANGED, {
      title: 'Procurement FAQ',
      summary: { en: 'Generated English', it: 'Prima' },
    }),
    chunkBytes === undefined
      ? before[1]
      : record(UNCHANGED, {
          ...before[1].current,
          title: 'Second changed FAQ',
        }),
    before[2],
  ];
  const store = new SnapshotStore(directory);
  for (const value of before) put(store, 'target', value, state);
  for (const value of after) put(store, 'source', value, state);
  const metadata = await createPlan(
    store,
    state,
    { ...state, environmentId: 'destination' },
    {
      modelIds: [FAQ],
      uploads: 'referenced',
      includeDeletions: false,
      allowPartial: false,
      allowTemporarySchemaChanges: false,
    },
  );
  const output = join(directory, '123_change.ts');
  await writeMigration({
    store,
    metadata,
    outputPath: output,
    sourceTracking: tracking,
    destinationTracking: tracking,
    chunkBytes,
  });
  // Resolve the real public runtime to this test's source module. The emitted
  // migration remains unchanged and executes through its actual public import.
  const packageDirectory = join(
    directory,
    'node_modules/@datocms/cli-plugin-content-diff',
  );
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: '@datocms/cli-plugin-content-diff',
      exports: { './migration': './migration.cjs' },
    }),
  );
  await writeFile(
    join(packageDirectory, 'migration.cjs'),
    `module.exports = require(${JSON.stringify(
      resolve(__dirname, '../../src/migration.ts'),
    )});\n`,
  );
  const result = {
    directory,
    state,
    before,
    after,
    store,
    output,
    baseline: join(directory, '123_change.content'),
    async dispose() {
      store.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
  fixtures.push(result);
  return result;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function harness(test: Fixture) {
  const events: string[] = [];
  const validations: Array<{ recordId: string; payload: JsonObject }> = [];
  const plans: Array<{ entries: PlanEntry[]; options: ApplyOptions }> = [];
  const capturedStores: SnapshotStore[] = [];
  let primary = false;
  let wrongProject = false;
  let captureCalls = 0;
  let schemaCalls = 0;
  let writes = 0;
  const client = (environment: string) =>
    ({
      config: { environment },
      items: {
        validateExisting: async (recordId: string, payload: JsonObject) => {
          validations.push({ recordId, payload });
        },
        validateNew: async () => assert.fail('fixture does not create records'),
        create: async () => {
          writes++;
          assert.fail('recording must not create remotely');
        },
        update: async () => {
          writes++;
          assert.fail('recording must not update remotely');
        },
        destroy: async () => {
          writes++;
          assert.fail('recording must not delete remotely');
        },
      },
    }) as unknown as Client;
  const rootClient = {
    environments: {
      find: async (environment: string) => ({
        id: environment,
        meta: { primary },
      }),
    },
  } as unknown as Client;
  replace(
    schemaApi,
    'fetchSchema',
    async (
      _client: Client,
      environment: string,
      projection?: (schema: SchemaState) => SchemaState,
    ) => {
      events.push('schema');
      schemaCalls++;
      const raw: SchemaState = {
        ...test.state,
        environmentId: environment,
        siteId: wrongProject ? 'wrong-site' : test.state.siteId,
        models: [...test.state.models],
      };
      raw.hash = schemaApi.schemaHash(raw);
      return projection ? projection(raw) : raw;
    },
  );
  replace(
    capture,
    'captureSnapshot',
    async (args: Parameters<typeof capture.captureSnapshot>[0]) => {
      events.push('capture');
      captureCalls++;
      capturedStores.push(args.store);
      for (const value of test.before)
        put(args.store, 'target', value, args.schema);
    },
  );
  replace(
    execution,
    'applyPlan',
    async (args: Parameters<typeof execution.applyPlan>[0]) => {
      assert.ok(args.plan, 'public runtime must replan executed TypeScript');
      events.push('apply');
      plans.push({
        entries: [...args.plan.entries()],
        options: args.options,
      });
      if (args.options.dryRun) {
        const previewStore = new SnapshotStore();
        try {
          for (const entry of plans.at(-1)!.entries)
            previewStore.putPlan(entry);
          return buildPlanPreview(
            previewStore,
            args.plan.metadata,
            'destination',
          );
        } finally {
          args.plan.release?.();
          previewStore.dispose();
        }
      }
      args.plan.release?.();
      return {
        environmentId: args.options.inPlace
          ? args.options.destinationEnvironmentId ?? 'destination'
          : 'owned-fork',
        mutations: 1,
        partial: false,
      };
    },
  );
  const options: ApplyOptions = {
    inPlace: false,
    allowPrimary: false,
    keepFailedFork: false,
    allowTemporarySchemaChanges: false,
    concurrency: 2,
  };
  return {
    events,
    validations,
    plans,
    capturedStores,
    client,
    rootClient,
    options,
    setPrimary: (value: boolean) => {
      primary = value;
    },
    setWrongProject: (value: boolean) => {
      wrongProject = value;
    },
    counts: () => ({ schemaCalls, captureCalls, writes }),
    run: (overrides: Partial<ApplyOptions> = {}) =>
      applyContentMigration({
        rootClient,
        buildEnvironmentClient: client,
        scriptPath: test.output,
        options: { ...options, ...overrides },
      }),
  };
}

describe('generated TypeScript public runtime integration', () => {
  afterEach(async () => {
    for (const restore of restorations.splice(0).reverse()) restore();
    for (const test of fixtures.splice(0)) await test.dispose();
  });

  it('executes edited CMA payloads, rebuilds their plan, and preserves the unmentioned namespace', async () => {
    const test = await fixture();
    const emitted = await readFile(test.output, 'utf8');
    assert.match(emitted, /await client\.items\.update/);
    assert.match(emitted, /Generated English/);
    await writeFile(
      test.output,
      emitted.replace('Generated English', 'Edited English'),
    );
    const run = harness(test);
    assert.deepEqual(await run.run(), {
      environmentId: 'owned-fork',
      mutations: 1,
      partial: false,
    });
    const entries = run.plans[0].entries;
    const changed = entries.find((entry) => entry.id === CHANGED) as RecordPlan;
    assert.equal(changed.action, 'update');
    assert.deepEqual(changed.desired!.current, {
      title: 'Procurement FAQ',
      summary: { en: 'Edited English', it: 'Prima' },
    });
    assert.equal(changed.desired!.published, null);
    assert.deepEqual(
      entries
        .filter((entry) => entry.action === 'noop')
        .map((entry) => entry.id)
        .sort(),
      [UNCHANGED, UNSELECTED].sort(),
    );
    assert.equal(
      entries.some((entry) => entry.action === 'delete'),
      false,
    );
    assert.equal(run.validations.length, 1);
    assert.equal(run.validations[0].recordId, CHANGED);
    assert.deepEqual(run.validations[0].payload.summary, {
      en: 'Edited English',
      it: 'Prima',
    });
    assert.equal(run.counts().writes, 0);
    assert.ok(
      run.capturedStores.every((store) => !existsSync(store.directory)),
    );
  });

  it('dry-run evaluates edited TypeScript and returns its rebuilt plan without content writes', async () => {
    const test = await fixture();
    await writeFile(
      test.output,
      (await readFile(test.output, 'utf8')).replace(
        'Generated English',
        'Previewed English',
      ),
    );
    const run = harness(test);
    const result = await run.run({ dryRun: true, forkName: 'review-content' });
    assert.ok('dryRun' in result && result.dryRun);
    assert.equal(result.mutations, 0);
    assert.equal(result.counts.record.update, 1);
    assert.equal(result.groups.length, 1);
    const changed = run.plans[0].entries.find(
      (entry) => entry.id === CHANGED,
    ) as RecordPlan;
    assert.equal(
      (changed.desired!.current.summary as JsonObject).en,
      'Previewed English',
    );
    assert.equal(run.plans[0].options.dryRun, true);
    assert.equal(run.plans[0].options.forkName, 'review-content');
    assert.equal(run.validations.length, 1);
    assert.equal(run.counts().writes, 0);
    assert.ok(
      run.capturedStores.every((store) => !existsSync(store.directory)),
    );
  });

  it('refuses corrupted immutable baseline metadata before any API operation', async () => {
    const test = await fixture();
    const manifest = join(test.baseline, 'manifest.json');
    await writeFile(manifest, `${await readFile(manifest, 'utf8')} `);
    const run = harness(test);
    await assert.rejects(run.run(), /checksum/i);
    assert.deepEqual(run.counts(), {
      schemaCalls: 0,
      captureCalls: 0,
      writes: 0,
    });
    assert.equal(run.plans.length, 0);
  });

  it('rejects concurrent changes to an unselected record before recording the script', async () => {
    const test = await fixture();
    test.before[2] = record(
      UNSELECTED,
      { page_title: 'Concurrent edit' },
      PAGE,
    );
    const run = harness(test);
    await assert.rejects(run.run(), { code: 'APPLY_CONFLICT' });
    assert.equal(run.plans.length, 0);
    assert.equal(run.validations.length, 0);
    assert.equal(run.counts().writes, 0);
    assert.ok(
      run.capturedStores.every((store) => !existsSync(store.directory)),
    );
  });

  it('refuses unsupported edited methods without handing a plan to the executor', async () => {
    const test = await fixture();
    const source = await readFile(test.output, 'utf8');
    await writeFile(
      test.output,
      source.replace('client.items.update', 'client.items.bulkPublish'),
    );
    const run = harness(test);
    await assert.rejects(run.run(), /Unsupported CMA method or property/);
    assert.equal(run.plans.length, 0);
    assert.equal(run.validations.length, 0);
    assert.equal(run.counts().writes, 0);
    assert.ok(
      run.capturedStores.every((store) => !existsSync(store.directory)),
    );
  });

  it('executes real split TypeScript parts through the isolated recording bridge', async () => {
    const test = await fixture(1);
    const files = (await readdir(join(test.baseline, 'parts'))).filter((file) =>
      file.endsWith('.ts'),
    );
    assert.ok(files.length > 0);
    assert.match(await readFile(test.output, 'utf8'), /runMigrationPart/);
    let part = '';
    let source = '';
    for (const file of files) {
      const candidate = join(test.baseline, 'parts', file);
      const value = await readFile(candidate, 'utf8');
      if (value.includes('Generated English')) {
        part = candidate;
        source = value;
      }
    }
    assert.match(source, /Generated English/);
    await writeFile(
      part,
      source.replace('Generated English', 'Edited worker value'),
    );
    const run = harness(test);
    await run.run();
    const changed = run.plans[0].entries.find(
      (entry) => entry.id === CHANGED,
    ) as RecordPlan;
    assert.deepEqual(changed.desired!.current.summary, {
      en: 'Edited worker value',
      it: 'Prima',
    });
    assert.equal(run.validations.length, 1);
    assert.equal(require.cache[part], undefined);
    assert.equal(run.counts().writes, 0);
  });

  it('refuses the wrong project and primary writes without explicit authorization', async () => {
    const test = await fixture();
    const run = harness(test);
    run.setWrongProject(true);
    await assert.rejects(run.run(), /Destination project or schema differs/);
    run.setWrongProject(false);
    run.setPrimary(true);
    await assert.rejects(
      run.run({ inPlace: true }),
      /requires --allow-primary/,
    );
    assert.equal(run.counts().captureCalls, 0);
    assert.equal(run.plans.length, 0);
    await run.run({ inPlace: true, allowPrimary: true });
    assert.equal(run.plans[0].options.allowPrimary, true);
    assert.equal(run.counts().writes, 0);
  });

  it('exports a non-callable descriptor and executes it through content:apply', async () => {
    const test = await fixture();
    const run = harness(test);
    const module = await loadMigrationModule<{ default: ContentMigration }>(
      test.output,
    );
    assert.equal(typeof module.default, 'object');
    assert.equal(module.default.format, 'datocms-content-migration');
    assert.deepEqual(run.counts(), {
      schemaCalls: 0,
      captureCalls: 0,
      writes: 0,
    });
    assert.equal(run.plans.length, 0);
    assert.equal(module.default.version, 1);
    await run.run();
    assert.deepEqual(run.events, ['schema', 'capture', 'apply']);
    assert.equal(run.plans[0].options.inPlace, false);
    assert.equal(run.plans[0].options.keepFailedFork, false);
  });
});
