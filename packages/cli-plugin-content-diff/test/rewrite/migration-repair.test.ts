import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashJson, recordHash } from '../../src/engine/codec';
import { writeMigration } from '../../src/engine/migration-artifact';
import {
  assertRepairSchema,
  repairMigrationDefinition,
} from '../../src/engine/migration-repair';
import { createPlan } from '../../src/engine/planner';
import { schemaHash } from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  Client,
  JsonObject,
  ModelSchema,
  RecordState,
  SchemaState,
} from '../../src/engine/types';
import type { ContentMigrationDefinition } from '../../src/migration';

const id = (value: string) =>
  createHash('sha256').update(value).digest('base64url').slice(0, 22);
const MODEL = id('repair-model');
const TITLE = id('repair-title');
const A = id('repair-a');
const B = id('repair-b');
const CREATED = '2020-01-01T00:00:00.000Z';
const ORIGINAL_DATE = '2090-01-01T00:00:00.000Z';
const DESIRED_DATE = '2091-01-01T00:00:00.000Z';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function schema(required = false): SchemaState {
  const model: ModelSchema = {
    id: MODEL,
    apiKey: 'page',
    name: 'Page',
    block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: true,
    saveInvalidDrafts: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [
      {
        id: TITLE,
        apiKey: 'title',
        type: 'string',
        localized: false,
        validators: required ? { required: {} } : {},
        defaultValue: null,
      },
    ],
  };
  const state: SchemaState = {
    siteId: 'destination-site',
    environmentId: 'main',
    locales: ['en'],
    semantics: {
      timezone: 'UTC',
      improved_timezone_management: true,
      improved_boolean_fields: true,
      improved_validation_at_publishing: true,
      milliseconds_in_datetime: true,
      non_localized_focal_points: true,
      improved_hex_management: true,
    },
    models: [model],
    workflows: [],
    hash: '',
  };
  state.hash = schemaHash(state);
  return state;
}
function record(
  recordId = A,
  title = 'Original',
  schedule: string | null = ORIGINAL_DATE,
): RecordState {
  const state: RecordState = {
    id: recordId,
    modelId: MODEL,
    current: { title },
    published: null,
    currentVersion: 'original-version',
    publishedUpdatedAt: null,
    createdAt: CREATED,
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: {
      publication: schedule ? { at: schedule, selective: null } : null,
      unpublishing: null,
    },
    validity: { current: true, published: null },
    hash: '',
  };
  state.hash = recordHash(state);
  return state;
}

function sdk(schemaState: SchemaState, states: RecordState[]) {
  const liveSchema = clone(schemaState);
  const records = new Map(states.map((state) => [state.id, clone(state)]));
  const writes: string[] = [];
  let validations = 0;
  const site = () => ({
    id: liveSchema.siteId,
    locales: liveSchema.locales,
    timezone: 'UTC',
    meta: liveSchema.semantics,
  });
  const raw = (state: RecordState, published = false) => ({
    id: state.id,
    type: 'item',
    attributes: published ? state.published : state.current,
    relationships: {
      item_type: { data: { id: state.modelId, type: 'item_type' } },
    },
    meta: {
      current_version: state.currentVersion,
      created_at: state.createdAt,
      updated_at: state.publishedUpdatedAt ?? CREATED,
      first_published_at: state.firstPublishedAt,
      published_at: state.published
        ? state.publishedUpdatedAt ?? CREATED
        : null,
      is_current_version_valid: state.validity.current,
      is_published_version_valid: state.validity.published,
      stage: state.stage,
      publication_scheduled_at: state.schedules.publication?.at ?? null,
      unpublishing_scheduled_at: state.schedules.unpublishing?.at ?? null,
    },
  });
  const currentState = (recordId: string) => {
    const state = records.get(recordId)!;
    const publication = state.schedules.publication;
    const unpublishing = state.schedules.unpublishing;
    return {
      data: {
        id: recordId,
        type: 'item_current_vs_published_state',
        relationships: {
          scheduled_publication: {
            data: publication
              ? { id: `p-${recordId}`, type: 'scheduled_publication' }
              : null,
          },
          scheduled_unpublishing: {
            data: unpublishing
              ? { id: `u-${recordId}`, type: 'scheduled_unpublishing' }
              : null,
          },
        },
      },
      included: [
        ...(publication
          ? [
              {
                id: `p-${recordId}`,
                type: 'scheduled_publication',
                attributes: {
                  publication_scheduled_at: publication.at,
                  selective_publication: null,
                },
              },
            ]
          : []),
        ...(unpublishing
          ? [
              {
                id: `u-${recordId}`,
                type: 'scheduled_unpublishing',
                attributes: {
                  unpublishing_scheduled_at: unpublishing.at,
                  content_in_locales: unpublishing.locales,
                },
              },
            ]
          : []),
      ],
    };
  };
  const client = {
    site: { find: async () => site() },
    users: { findMe: async () => ({ id: 'account', type: 'account' }) },
    workflows: { list: async () => [] },
    environments: {
      find: async (environmentId: string) => ({
        id: environmentId,
        meta: { primary: false, read_only_mode: false, status: 'ready' },
      }),
    },
    itemTypes: {
      list: async () =>
        liveSchema.models.map((model) => ({
          id: model.id,
          api_key: model.apiKey,
          name: model.name,
          modular_block: model.block,
          singleton: model.singleton,
          sortable: model.sortable,
          tree: model.tree,
          draft_mode_active: model.draftMode,
          draft_saving_active: model.saveInvalidDrafts,
          all_locales_required: model.allLocalesRequired,
          workflow: null,
        })),
    },
    fields: {
      list: async (modelId: string) =>
        liveSchema.models
          .find((model) => model.id === modelId)!
          .fields.map((field) => ({
            id: field.id,
            api_key: field.apiKey,
            field_type: field.type,
            localized: field.localized,
            validators: clone(field.validators),
            default_value: field.defaultValue,
          })),
      find: async (fieldId: string) => {
        const field = liveSchema.models
          .flatMap((model) => model.fields)
          .find((field) => field.id === fieldId)!;
        return {
          id: fieldId,
          validators: clone(field.validators),
          default_value: field.defaultValue,
        };
      },
      update: async (
        fieldId: string,
        body: { validators: JsonObject; default_value: null },
      ) => {
        writes.push(`field:${fieldId}`);
        const field = liveSchema.models
          .flatMap((model) => model.fields)
          .find((field) => field.id === fieldId)!;
        field.validators = clone(body.validators);
        field.defaultValue = body.default_value;
        return { id: fieldId };
      },
    },
    uploads: { rawList: async () => ({ data: [], meta: { total_count: 0 } }) },
    uploadCollections: { list: async () => [] },
    request: async ({
      method,
      url,
      queryParams,
    }: {
      method: string;
      url: string;
      queryParams: {
        filter?: { ids?: string; type?: string };
        version?: string;
        page?: { offset?: number; limit?: number };
      };
    }) => {
      assert.equal(method, 'GET');
      assert.equal(url, '/items');
      const published = queryParams.version === 'published';
      const ids = queryParams.filter?.ids?.split(',');
      const rows = [...records.values()]
        .filter(
          (state) =>
            (!ids || ids.includes(state.id)) &&
            (!queryParams.filter?.type ||
              queryParams.filter.type === state.modelId) &&
            (!published || state.published),
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      const offset = queryParams.page?.offset ?? 0;
      const limit = queryParams.page?.limit ?? 30;
      return {
        data: rows
          .slice(offset, offset + limit)
          .map((state) => raw(state, published)),
        meta: { total_count: rows.length },
      };
    },
    items: {
      rawCurrentVsPublishedState: async (recordId: string) =>
        currentState(recordId),
      validateExisting: async () => {
        validations++;
      },
      validateNew: async () => {
        validations++;
      },
      update: async () => {
        writes.push('FORBIDDEN-record-write');
        throw new Error('Repair must not save record content');
      },
    },
    scheduledPublication: {
      create: async (
        recordId: string,
        body: { publication_scheduled_at: string },
      ) => {
        writes.push(`publication:${recordId}`);
        const state = records.get(recordId)!;
        state.schedules.publication = {
          at: body.publication_scheduled_at,
          selective: null,
        };
        state.hash = recordHash(state);
        return { id: recordId };
      },
    },
    scheduledUnpublishing: {
      create: async (
        recordId: string,
        body: {
          unpublishing_scheduled_at: string;
          content_in_locales: string[] | null;
        },
      ) => {
        writes.push(`unpublishing:${recordId}`);
        const state = records.get(recordId)!;
        state.schedules.unpublishing = {
          at: body.unpublishing_scheduled_at,
          locales: body.content_in_locales,
        };
        state.hash = recordHash(state);
        return { id: recordId };
      },
    },
  } as unknown as Client;
  return {
    client,
    liveSchema,
    records,
    writes,
    get validations() {
      return validations;
    },
  };
}

describe('TypeScript migration repair', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'migration-repair-test-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function artifact(
    original: RecordState[],
    desired: RecordState[],
    schemaState = schema(),
  ) {
    const store = new SnapshotStore();
    try {
      for (const value of original) store.putRecord('target', value);
      for (const value of desired) store.putRecord('source', value);
      const metadata = await createPlan(
        store,
        { ...schemaState, siteId: 'source-site' },
        schemaState,
        {
          modelIds: [MODEL],
          uploads: 'all',
          includeDeletions: true,
          allowPartial: false,
          allowTemporarySchemaChanges: true,
        },
      );
      const scriptPath = join(directory, 'repair.ts');
      const tracking = { apiKey: 'schema_migration', model: null };
      await writeMigration({
        store,
        metadata,
        outputPath: scriptPath,
        sourceTracking: tracking,
        destinationTracking: tracking,
      });
      return { scriptPath, metadata };
    } finally {
      store.dispose();
    }
  }
  function definition(
    run: ContentMigrationDefinition['run'],
  ): ContentMigrationDefinition {
    return { version: 1, options: { baseline: './repair.content' }, run };
  }
  async function replay(client: Client, title = 'Desired') {
    await client.items.update(A, { title });
    await client.scheduledPublication.destroy(A);
    await client.scheduledPublication.create(A, {
      publication_scheduled_at: DESIRED_DATE,
      selective_publication: null,
    });
  }

  for (const current of ['Original', 'Desired']) {
    it(`restores the ${current.toLowerCase()} schedule according to observed content without saving records`, async () => {
      const { scriptPath } = await artifact(
        [record()],
        [record(A, 'Desired', DESIRED_DATE)],
      );
      const remote = sdk(schema(), [
        record(A, current, null),
        record(B, 'Unrelated new record', null),
      ]);
      const result = await repairMigrationDefinition({
        definition: definition((client) => replay(client)),
        scriptPath,
        rootClient: remote.client,
        buildEnvironmentClient: () => remote.client,
        options: { allowPrimary: false },
      });
      assert.equal(result.restoredSchedules, 1);
      assert.equal(
        remote.records.get(A)!.schedules.publication!.at,
        current === 'Original' ? ORIGINAL_DATE : DESIRED_DATE,
      );
      assert.deepEqual(remote.writes, [`publication:${A}`]);
      assert.equal(remote.records.get(A)!.current.title, current);
      assert.equal(remote.records.get(A)!.currentVersion, 'original-version');
      assert.ok(
        remote.records.has(B),
        'unexpected live IDs are excluded only from the local reconstructed baseline',
      );
    });
  }

  it('leaves unknown partial content untouched and reports its unresolved schedule', async () => {
    const { scriptPath } = await artifact(
      [record()],
      [record(A, 'Desired', DESIRED_DATE)],
    );
    const remote = sdk(schema(), [record(A, 'Unknown partial state', null)]);
    await assert.rejects(
      repairMigrationDefinition({
        definition: definition((client) => replay(client)),
        scriptPath,
        rootClient: remote.client,
        buildEnvironmentClient: () => remote.client,
        options: { allowPrimary: false },
      }),
      /matches neither the original nor/,
    );
    assert.deepEqual(remote.writes, []);
    assert.equal(remote.records.get(A)!.current.title, 'Unknown partial state');
    assert.equal(remote.records.get(A)!.schedules.publication, null);
  });

  it('replans ordinary edited TS against the reconstructed original and validates the edit read-only', async () => {
    const { scriptPath } = await artifact(
      [record()],
      [record(A, 'Desired', DESIRED_DATE)],
    );
    const remote = sdk(schema(), [record(A, 'Edited in TS', null)]);
    const result = await repairMigrationDefinition({
      definition: definition((client) => replay(client, 'Edited in TS')),
      scriptPath,
      rootClient: remote.client,
      buildEnvironmentClient: () => remote.client,
      options: { allowPrimary: false },
    });
    assert.equal(result.restoredSchedules, 1);
    assert.equal(remote.validations, 1);
    assert.deepEqual(remote.writes, [`publication:${A}`]);
  });

  it('restores exact temporary field settings without saving invalid content', async () => {
    const originalSchema = schema(true);
    const original = record(A, 'Original', null);
    const desired = record(A, '', null);
    desired.validity.current = false;
    const { scriptPath, metadata } = await artifact(
      [original],
      [desired],
      originalSchema,
    );
    assert.equal(metadata.temporarySchemaChanges.length, 1);
    const remote = sdk(originalSchema, [desired]);
    remote.liveSchema.models[0].fields[0].validators = {};
    const result = await repairMigrationDefinition({
      definition: definition(async (client) => {
        await client.items.update(A, { title: '' });
      }),
      scriptPath,
      rootClient: remote.client,
      buildEnvironmentClient: () => remote.client,
      options: { allowPrimary: false },
    });
    assert.equal(result.restoredFields, 1);
    assert.deepEqual(remote.liveSchema.models[0].fields[0].validators, {
      required: {},
    });
    assert.deepEqual(remote.writes, [`field:${TITLE}`]);
    assert.equal(remote.records.get(A)!.current.title, '');
  });

  it('refuses an edited unknown slice while native field rules remain temporary', async () => {
    const originalSchema = schema(true);
    const desired = record(A, '', null);
    desired.validity.current = false;
    const { scriptPath } = await artifact(
      [record(A, 'Original', null)],
      [desired],
      originalSchema,
    );
    const remote = sdk(originalSchema, [desired]);
    remote.liveSchema.models[0].fields[0].validators = {};
    await assert.rejects(
      repairMigrationDefinition({
        definition: definition(async (client) => {
          await client.items.update(A, { title: 'Edited' });
        }),
        scriptPath,
        rootClient: remote.client,
        buildEnvironmentClient: () => remote.client,
        options: { allowPrimary: false },
      }),
      /temporary or changed settings/,
    );
    assert.deepEqual(remote.writes, []);
    assert.equal(remote.validations, 0);
  });

  it('refuses unrecoverable originally unchanged content before any writes', async () => {
    const unchanged = record(B, 'Unchanged', null);
    const { scriptPath } = await artifact(
      [record(), unchanged],
      [record(A, 'Desired', DESIRED_DATE), unchanged],
    );
    const remote = sdk(schema(), [
      record(A, 'Desired', null),
      record(B, 'Unrecoverable edit', null),
    ]);
    await assert.rejects(
      repairMigrationDefinition({
        definition: definition((client) => replay(client)),
        scriptPath,
        rootClient: remote.client,
        buildEnvironmentClient: () => remote.client,
        options: { allowPrimary: false },
      }),
      /cannot reconstruct it safely/,
    );
    assert.deepEqual(remote.writes, []);
  });

  it('reports a stale invalid stamp without creating a record version to refresh it', async () => {
    const { scriptPath } = await artifact(
      [record()],
      [record(A, 'Desired', DESIRED_DATE)],
    );
    const current = record(A, 'Desired', null);
    current.validity.current = false;
    const remote = sdk(schema(), [current]);
    await assert.rejects(
      repairMigrationDefinition({
        definition: definition((client) => replay(client)),
        scriptPath,
        rootClient: remote.client,
        buildEnvironmentClient: () => remote.client,
        options: { allowPrimary: false },
      }),
      /needs a new content version.*repair cannot write record content/,
    );
    assert.deepEqual(remote.writes, []);
    assert.equal(remote.records.get(A)!.currentVersion, 'original-version');
  });

  it('allows only field validators/defaults to differ during repair capture', () => {
    const original = schema(true);
    const temporary = clone(original);
    temporary.models[0].fields[0].validators = {};
    assert.deepEqual([...assertRepairSchema(temporary, original)], [TITLE]);
    temporary.models[0].fields[0].type = 'text';
    assert.throws(
      () => assertRepairSchema(temporary, original),
      /original models, fields, types/,
    );
    temporary.models[0].fields[0].type = 'string';
    temporary.locales.push('it');
    assert.throws(
      () => assertRepairSchema(temporary, original),
      /original models, fields, types/,
    );
  });

  it('refuses an unrecorded migration tracking model instead of hiding it', async () => {
    const { scriptPath } = await artifact(
      [record()],
      [record(A, 'Desired', DESIRED_DATE)],
    );
    const remote = sdk(schema(), [record(A, 'Desired', null)]);
    remote.liveSchema.models.push({
      ...clone(remote.liveSchema.models[0]),
      id: id('new-tracking'),
      apiKey: 'schema_migration',
      draftMode: false,
      fields: [
        {
          id: id('tracking-name'),
          apiKey: 'name',
          type: 'string',
          localized: false,
          validators: { required: {} },
          defaultValue: null,
        },
      ],
    });
    await assert.rejects(
      repairMigrationDefinition({
        definition: definition((client) => replay(client)),
        scriptPath,
        rootClient: remote.client,
        buildEnvironmentClient: () => remote.client,
        options: { allowPrimary: false },
      }),
      /migration tracking model appeared after generation/,
    );
    assert.deepEqual(remote.writes, []);
  });
});
