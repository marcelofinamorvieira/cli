import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Definition = {
  settings: { locales: 'en' | 'it' };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: true };
    body: { type: 'text'; localized: false };
  };
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    titleFieldId: string;
    bodyFieldId: string;
    enScheduleRecordId: string;
    itScheduleRecordId: string;
  }>;

type RawRecord = Readonly<{
  id: string;
  itemTypeId: string;
  title: Readonly<{ en: string; it: string }>;
  body: string;
  status: string;
  currentValid: boolean;
  publishedValid: boolean | null;
}>;

type RawSchedule = Readonly<{
  at: string;
  locales: readonly string[];
  nonLocalized: boolean;
}> | null;

type RawSchema = Readonly<{
  model: Readonly<{
    id: string;
    draftModeActive: boolean;
    draftSavingActive: boolean;
    allLocalesRequired: boolean;
  }>;
  fields: readonly Readonly<{
    id: string;
    apiKey: string;
    fieldType: string;
    localized: boolean;
    validators: unknown;
  }>[];
}>;

type RawState = Readonly<{
  current: readonly RawRecord[];
  publishedIds: readonly string[];
  schedules: Readonly<Record<string, RawSchedule>>;
  schema: RawSchema;
}>;

type Expected = Readonly<{
  source: RawState;
  destination: RawState;
}>;

export const SELECTIVE_SCHEDULE_VALIDATORS = {
  title: { required: {} },
  body: { required: {} },
} as const;

// Both schedules are first publications. The CMA permits a locale subset only
// when all locales are not required, and requires the existing shared content
// to be included in that first publication.
export const SELECTIVE_SCHEDULE_MODEL_CAPABILITIES = {
  all_locales_required: false,
  draft_mode_active: true,
  draft_saving_active: true,
} as const;

export const SELECTIVE_SCHEDULE_SCOPES = {
  en: {
    content_in_locales: ['en'],
    non_localized_content: true,
  },
  it: {
    content_in_locales: ['it'],
    non_localized_content: true,
  },
} as const;

export const SELECTIVE_SCHEDULE_BASELINE_TITLE = {
  en: 'English baseline',
  it: 'Italiano baseline',
} as const;

export const SELECTIVE_SCHEDULE_INVALID_TITLE = {
  en: 'English ready',
  it: '',
} as const;

export function selectiveScheduleModelApiKey(runId: string): string {
  return `cde2e_ssv_r${createHash('sha256')
    .update(runId)
    .digest('hex')
    .slice(0, 11)}`;
}

export const selectiveScheduleValidityScenario: RealCmaScenario<
  Seed,
  Expected
> = {
  name: 'selective schedule validates only its exact locale and shared scope',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating selective schedule schema');
    await client.site.update({ locales: ['en', 'it'] });
    const apiKey = selectiveScheduleModelApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Selective schedule validity ${runId}`,
      api_key: apiKey,
      singleton: false,
      ...SELECTIVE_SCHEDULE_MODEL_CAPABILITIES,
      sortable: false,
      modular_block: false,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });
    const titleField = await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: true,
      validators: {},
    });
    const bodyField = await client.fields.create(model.id, {
      label: 'Body',
      api_key: 'body',
      field_type: 'text',
      localized: false,
      validators: {},
    });
    const [enScheduleRecord, itScheduleRecord] = await Promise.all([
      client.items.create<Definition>({
        item_type: { id: model.id, type: 'item_type' },
        title: SELECTIVE_SCHEDULE_BASELINE_TITLE,
        body: 'shared content is valid',
      }),
      client.items.create<Definition>({
        item_type: { id: model.id, type: 'item_type' },
        title: SELECTIVE_SCHEDULE_BASELINE_TITLE,
        body: 'shared content is valid',
      }),
    ]);

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      titleFieldId: titleField.id,
      bodyFieldId: bodyField.id,
      enScheduleRecordId: enScheduleRecord.id,
      itScheduleRecordId: itScheduleRecord.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating en-safe and it-unsafe schedules around the same invalid draft shape',
    );
    for (const recordId of [seed.enScheduleRecordId, seed.itScheduleRecordId]) {
      const record = await sourceClient.items.find<Definition>(recordId);
      await sourceClient.items.update<Definition>(recordId, {
        title: SELECTIVE_SCHEDULE_INVALID_TITLE,
        body: 'shared content is valid',
        meta: { current_version: record.meta.current_version },
      });
    }

    const now = Date.now();
    await Promise.all([
      sourceClient.scheduledPublication.create(seed.enScheduleRecordId, {
        publication_scheduled_at: new Date(
          now + 72 * 60 * 60 * 1000,
        ).toISOString(),
        selective_publication: {
          content_in_locales: [
            ...SELECTIVE_SCHEDULE_SCOPES.en.content_in_locales,
          ],
          non_localized_content:
            SELECTIVE_SCHEDULE_SCOPES.en.non_localized_content,
        },
      }),
      sourceClient.scheduledPublication.create(seed.itScheduleRecordId, {
        publication_scheduled_at: new Date(
          now + 96 * 60 * 60 * 1000,
        ).toISOString(),
        selective_publication: {
          content_in_locales: [
            ...SELECTIVE_SCHEDULE_SCOPES.it.content_in_locales,
          ],
          non_localized_content:
            SELECTIVE_SCHEDULE_SCOPES.it.non_localized_content,
        },
      }),
    ]);

    await Promise.all([
      sourceClient.fields.update(seed.titleFieldId, {
        validators: SELECTIVE_SCHEDULE_VALIDATORS.title,
      }),
      destinationClient.fields.update(seed.titleFieldId, {
        validators: SELECTIVE_SCHEDULE_VALIDATORS.title,
      }),
    ]);
    await Promise.all([
      sourceClient.fields.update(seed.bodyFieldId, {
        validators: SELECTIVE_SCHEDULE_VALIDATORS.body,
      }),
      destinationClient.fields.update(seed.bodyFieldId, {
        validators: SELECTIVE_SCHEDULE_VALIDATORS.body,
      }),
    ]);
    await Promise.all([
      waitForValidity(sourceClient, seed.enScheduleRecordId, false),
      waitForValidity(sourceClient, seed.itScheduleRecordId, false),
      waitForValidity(destinationClient, seed.enScheduleRecordId, true),
      waitForValidity(destinationClient, seed.itScheduleRecordId, true),
    ]);

    const [source, destination] = await Promise.all([
      captureRawState(sourceClient, seed),
      captureRawState(destinationClient, seed),
    ]);
    assertSourceAndDestinationPreconditions(source, destination, seed);
    return { source, destination };
  },

  async verifyGeneratedPlan({ seed, planFilePath }) {
    const envelope = object(
      JSON.parse(await readFile(planFilePath, 'utf8')),
      'plan envelope',
    );
    assertSelectiveSchedulePlan(envelope.plan, seed);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying the en-only schedule migrated and the it-only aggregate stayed untouched',
    );
    await Promise.all([
      waitForValidity(appliedClient, seed.enScheduleRecordId, false),
      waitForValidity(appliedClient, seed.itScheduleRecordId, true),
    ]);
    const [source, destination, applied] = await Promise.all([
      captureRawState(sourceClient, seed),
      captureRawState(destinationClient, seed),
      captureRawState(appliedClient, seed),
    ]);
    assert.deepEqual(source, expected.source, 'source state changed');
    assert.deepEqual(
      destination,
      expected.destination,
      'destination state changed',
    );
    assert.deepEqual(
      applied,
      expectedAppliedState(expected, seed),
      'applied state did not combine the safe source slice with the preserved destination aggregate',
    );
  },
};

export function assertSelectiveSchedulePlan(
  value: unknown,
  seed: Pick<Seed, 'modelId' | 'enScheduleRecordId' | 'itScheduleRecordId'>,
): void {
  const plan = object(value, 'content plan');
  const records = array(plan.records, 'record plans').map((entry) =>
    object(entry, 'record plan'),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].id, seed.enScheduleRecordId);
  assert.equal(records[0].action, 'update');
  assert.deepEqual(records[0].changes, {
    current: true,
    published: false,
    topology: false,
    lifecycle: false,
    stage: false,
    schedules: true,
  });

  const invalid = object(plan.invalidContent, 'invalid content');
  assert.deepEqual(
    array(invalid.detectedRecordIds, 'detected record IDs')
      .map((id) => requiredString(id, 'detected record ID'))
      .sort(compareIds),
    [seed.enScheduleRecordId, seed.itScheduleRecordId].sort(compareIds),
  );
  assert.deepEqual(invalid.migratedRecordIds, [seed.enScheduleRecordId]);
  assert.deepEqual(invalid.validatorRelaxations, []);
  const skipped = array(invalid.skippedRecords, 'skipped records').map(
    (entry) => object(entry, 'skipped record'),
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, seed.itScheduleRecordId);
  assert.equal(skipped[0].itemTypeId, seed.modelId);
  assert.equal(skipped[0].disposition, 'preserve_target');
  assert.deepEqual(
    array(skipped[0].reasons, 'skip reasons').map(
      (reason) => object(reason, 'skip reason').code,
    ),
    ['UNSAFE_SCHEDULED_PUBLICATION'],
  );

  const schemaStates = object(invalid.schemaStates, 'schema states');
  assert.equal(schemaStates.originalDigest, schemaStates.fullyRelaxedDigest);
  const requiredPermissions = object(
    plan.requiredPermissions,
    'required permissions',
  );
  assert.equal(requiredPermissions.manageSchedules, true);
  assert.equal(requiredPermissions.editSchema, false);
}

function expectedAppliedState(expected: Expected, seed: Seed): RawState {
  const sourceSafe = expected.source.current.find(
    ({ id }) => id === seed.enScheduleRecordId,
  );
  const destinationPreserved = expected.destination.current.find(
    ({ id }) => id === seed.itScheduleRecordId,
  );
  assert.ok(sourceSafe);
  assert.ok(destinationPreserved);
  return {
    current: [sourceSafe, destinationPreserved].sort(compareRecords),
    publishedIds: [],
    schedules: {
      [seed.enScheduleRecordId]:
        expected.source.schedules[seed.enScheduleRecordId],
      [seed.itScheduleRecordId]:
        expected.destination.schedules[seed.itScheduleRecordId],
    },
    schema: expected.source.schema,
  };
}

function assertSourceAndDestinationPreconditions(
  source: RawState,
  destination: RawState,
  seed: Seed,
): void {
  assert.deepEqual(source.schema, destination.schema);
  assert.deepEqual(source.schema.model, {
    id: seed.modelId,
    draftModeActive: true,
    draftSavingActive: true,
    allLocalesRequired: false,
  });
  const fieldsByKey = Object.fromEntries(
    source.schema.fields.map((field) => [field.apiKey, field]),
  );
  assert.deepEqual(fieldsByKey.title, {
    id: seed.titleFieldId,
    apiKey: 'title',
    fieldType: 'string',
    localized: true,
    validators: SELECTIVE_SCHEDULE_VALIDATORS.title,
  });
  assert.deepEqual(fieldsByKey.body, {
    id: seed.bodyFieldId,
    apiKey: 'body',
    fieldType: 'text',
    localized: false,
    validators: SELECTIVE_SCHEDULE_VALIDATORS.body,
  });
  assert.deepEqual(source.publishedIds, []);
  assert.deepEqual(destination.publishedIds, []);
  assert.equal(source.current.length, 2);
  assert.equal(destination.current.length, 2);
  assert.ok(source.current.every(({ currentValid }) => !currentValid));
  assert.ok(destination.current.every(({ currentValid }) => currentValid));
  assert.deepEqual(
    source.current.map(({ title }) => title),
    [SELECTIVE_SCHEDULE_INVALID_TITLE, SELECTIVE_SCHEDULE_INVALID_TITLE],
  );
  assert.deepEqual(
    destination.current.map(({ title }) => title),
    [SELECTIVE_SCHEDULE_BASELINE_TITLE, SELECTIVE_SCHEDULE_BASELINE_TITLE],
  );
  assert.deepEqual(
    source.schedules[seed.enScheduleRecordId]?.locales,
    SELECTIVE_SCHEDULE_SCOPES.en.content_in_locales,
  );
  assert.equal(
    source.schedules[seed.enScheduleRecordId]?.nonLocalized,
    SELECTIVE_SCHEDULE_SCOPES.en.non_localized_content,
  );
  assert.deepEqual(
    source.schedules[seed.itScheduleRecordId]?.locales,
    SELECTIVE_SCHEDULE_SCOPES.it.content_in_locales,
  );
  assert.equal(
    source.schedules[seed.itScheduleRecordId]?.nonLocalized,
    SELECTIVE_SCHEDULE_SCOPES.it.non_localized_content,
  );
  assert.equal(destination.schedules[seed.enScheduleRecordId], null);
  assert.equal(destination.schedules[seed.itScheduleRecordId], null);
}

async function captureRawState(
  client: CmaClient.Client,
  seed: Seed,
): Promise<RawState> {
  const recordIds = [seed.enScheduleRecordId, seed.itScheduleRecordId].sort(
    compareIds,
  );
  const [currentResponse, publishedResponse, model, titleField, bodyField] =
    await Promise.all([
      client.items.rawList<Definition>({
        filter: { type: seed.modelId },
        version: 'current',
        order_by: 'id_ASC',
        page: { limit: 500 },
      }),
      client.items.rawList<Definition>({
        filter: { type: seed.modelId },
        version: 'published',
        order_by: 'id_ASC',
        page: { limit: 500 },
      }),
      client.itemTypes.rawFind(seed.modelId),
      client.fields.rawFind(seed.titleFieldId),
      client.fields.rawFind(seed.bodyFieldId),
    ]);
  const selectedIds = new Set(recordIds);
  const current = currentResponse.data
    .filter(({ id }) => selectedIds.has(id))
    .map((record) => ({
      id: record.id,
      itemTypeId: record.relationships.item_type.data.id,
      title: {
        en: requiredString(record.attributes.title.en, `${record.id}.title.en`),
        it: requiredString(
          record.attributes.title.it,
          `${record.id}.title.it`,
          true,
        ),
      },
      body: requiredString(record.attributes.body, `${record.id}.body`),
      status: requiredString(record.meta.status, `${record.id}.status`),
      currentValid: requiredBoolean(
        record.meta.is_current_version_valid,
        `${record.id}.current validity`,
      ),
      publishedValid: nullableBoolean(
        record.meta.is_published_version_valid,
        `${record.id}.published validity`,
      ),
    }))
    .sort(compareRecords);
  assert.deepEqual(
    current.map(({ id }) => id),
    recordIds,
    'raw current slice omitted a selected record',
  );
  const publishedIds = publishedResponse.data
    .filter(({ id }) => selectedIds.has(id))
    .map(({ id }) => id)
    .sort(compareIds);
  const scheduleEntries = await Promise.all(
    recordIds.map(
      async (recordId) =>
        [recordId, await captureRawSchedule(client, recordId)] as const,
    ),
  );

  return {
    current,
    publishedIds,
    schedules: Object.fromEntries(scheduleEntries),
    schema: {
      model: {
        id: model.data.id,
        draftModeActive: requiredBoolean(
          model.data.attributes.draft_mode_active,
          `${seed.modelId}.draft_mode_active`,
        ),
        draftSavingActive: requiredBoolean(
          model.data.attributes.draft_saving_active,
          `${seed.modelId}.draft_saving_active`,
        ),
        allLocalesRequired: requiredBoolean(
          model.data.attributes.all_locales_required,
          `${seed.modelId}.all_locales_required`,
        ),
      },
      fields: [titleField.data, bodyField.data]
        .map((field) => ({
          id: field.id,
          apiKey: requiredString(
            field.attributes.api_key,
            `${field.id}.api_key`,
          ),
          fieldType: requiredString(
            field.attributes.field_type,
            `${field.id}.field_type`,
          ),
          localized: requiredBoolean(
            field.attributes.localized,
            `${field.id}.localized`,
          ),
          validators: canonicalJson(field.attributes.validators),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

async function captureRawSchedule(
  client: CmaClient.Client,
  recordId: string,
): Promise<RawSchedule> {
  const response = await client.items.rawCurrentVsPublishedState(recordId);
  const relationship = response.data.relationships.scheduled_publication.data;
  if (!relationship) return null;
  const resource = response.included.find(
    ({ id, type }) =>
      id === relationship.id && type === 'scheduled_publication',
  );
  assert.ok(resource?.type === 'scheduled_publication');
  const selective = resource.attributes.selective_publication;
  assert.ok(selective, 'publication schedule must be selective');
  return {
    at: new Date(resource.attributes.publication_scheduled_at).toISOString(),
    locales: [...selective.content_in_locales],
    nonLocalized: selective.non_localized_content,
  };
}

async function waitForValidity(
  client: CmaClient.Client,
  recordId: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const record = await client.items.find(recordId);
    if (record.meta.is_current_version_valid === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  const record = await client.items.find(recordId);
  throw new Error(
    `current validity did not converge: ${JSON.stringify({
      recordId,
      expected,
      actual: record.meta.is_current_version_valid,
    })}`,
  );
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

function compareRecords(left: RawRecord, right: RawRecord): number {
  return compareIds(left.id, right.id);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function requiredString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (!allowEmpty) assert.ok(value.length > 0, `${label} must not be empty`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  assert.ok(
    value === null || typeof value === 'boolean',
    `${label} must be boolean or null`,
  );
  return value;
}
