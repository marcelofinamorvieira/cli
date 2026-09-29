import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type ScheduleOnlyDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: true };
  };
};

type ScheduleOnlySeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    titleFieldId: string;
    recordId: string;
  }>;

export type SelectivePublicationState = Readonly<{
  at: string;
  contentInLocales: readonly string[];
  nonLocalizedContent: boolean;
}>;

export type RawRecordState = Readonly<{
  id: string;
  itemTypeId: string;
  title: Readonly<{ en: string; it: string }>;
  currentValid: boolean;
  publishedValid: boolean | null;
}>;

export type ScheduleOnlyState = Readonly<{
  record: RawRecordState;
  publication: SelectivePublicationState;
}>;

type ScheduleOnlyExpected = Readonly<{
  source: ScheduleOnlyState;
  destination: ScheduleOnlyState;
  validators: Readonly<Record<string, unknown>>;
}>;

export type InvalidScheduleManifestExpectation = Readonly<{
  modelId: string;
  recordId: string;
}>;

export const INVALID_SCHEDULE_TITLE_VALIDATORS = {
  length: { min: 100 },
} as const;

export const INVALID_SCHEDULE_INITIAL_TITLE = {
  en: 'identical draft',
  it: 'bozza identica',
} as const;

export const INVALID_SCHEDULE_CHANGED_TITLE = {
  en: 'changed invalid current',
  it: 'corrente invalida cambiata',
} as const;

export function buildInvalidScheduleOnlyModelApiKey(runId: string): string {
  return `cde2e_isc_r${createHash('sha256')
    .update(runId)
    .digest('hex')
    .slice(0, 12)}`;
}

export const invalidScheduleOnlyScenario: RealCmaScenario<
  ScheduleOnlySeed,
  ScheduleOnlyExpected
> = {
  name: 'invalid identical draft with schedule-only drift is preserved',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating invalid schedule-only schema');
    await client.site.update({ locales: ['en', 'it'] });
    const apiKey = buildInvalidScheduleOnlyModelApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Invalid schedule only ${runId}`,
      api_key: apiKey,
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
    const titleField = await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: true,
      validators: {},
    });
    const record = await client.items.create<ScheduleOnlyDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      title: INVALID_SCHEDULE_INITIAL_TITLE,
    });

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      titleFieldId: titleField.id,
      recordId: record.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating future selective schedule-only drift',
    );
    const base = Date.now();
    await sourceClient.scheduledPublication.create(seed.recordId, {
      publication_scheduled_at: new Date(
        base + 72 * 60 * 60 * 1000,
      ).toISOString(),
      selective_publication: {
        content_in_locales: ['it'],
        non_localized_content: true,
      },
    });
    await destinationClient.scheduledPublication.create(seed.recordId, {
      publication_scheduled_at: new Date(
        base + 96 * 60 * 60 * 1000,
      ).toISOString(),
      selective_publication: {
        content_in_locales: ['en'],
        non_localized_content: false,
      },
    });

    await sourceClient.fields.update(seed.titleFieldId, {
      validators: INVALID_SCHEDULE_TITLE_VALIDATORS,
    });
    await destinationClient.fields.update(seed.titleFieldId, {
      validators: INVALID_SCHEDULE_TITLE_VALIDATORS,
    });
    await Promise.all([
      waitForValidity(sourceClient, seed.recordId, false, null),
      waitForValidity(destinationClient, seed.recordId, false, null),
    ]);

    const [source, destination, sourceField, destinationField] =
      await Promise.all([
        captureScheduleOnlyState(sourceClient, seed),
        captureScheduleOnlyState(destinationClient, seed),
        sourceClient.fields.find(seed.titleFieldId),
        destinationClient.fields.find(seed.titleFieldId),
      ]);

    assert.deepEqual(source.record, destination.record);
    assert.notDeepEqual(source.publication, destination.publication);
    assert.deepEqual(sourceField.validators, INVALID_SCHEDULE_TITLE_VALIDATORS);
    assert.deepEqual(destinationField.validators, sourceField.validators);

    return {
      source,
      destination,
      validators: sourceField.validators,
    };
  },

  async verifyGeneratedPlan({ seed, planFilePath }) {
    const envelope = object(
      JSON.parse(await readFile(planFilePath, 'utf8')),
      'plan envelope',
    );
    assertInvalidScheduleOnlyManifest(envelope.plan, {
      modelId: seed.modelId,
      recordId: seed.recordId,
    });
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying schedule-only skip preserved the destination',
    );
    const [
      source,
      destination,
      applied,
      sourceField,
      destinationField,
      appliedField,
    ] = await Promise.all([
      captureScheduleOnlyState(sourceClient, seed),
      captureScheduleOnlyState(destinationClient, seed),
      captureScheduleOnlyState(appliedClient, seed),
      sourceClient.fields.find(seed.titleFieldId),
      destinationClient.fields.find(seed.titleFieldId),
      appliedClient.fields.find(seed.titleFieldId),
    ]);

    assert.deepEqual(source, expected.source, 'source state changed');
    assert.deepEqual(
      destination,
      expected.destination,
      'destination state changed',
    );
    assert.deepEqual(
      applied,
      expected.destination,
      'applied fork did not preserve the destination content and schedule',
    );
    assert.deepEqual(sourceField.validators, expected.validators);
    assert.deepEqual(destinationField.validators, expected.validators);
    assert.deepEqual(
      appliedField.validators,
      expected.validators,
      'content migration changed the validator contract',
    );
  },
};

export const invalidUnchangedScheduleCurrentWriteScenario: RealCmaScenario<
  ScheduleOnlySeed,
  ScheduleOnlyExpected
> = {
  name: 'changed invalid current with unchanged future schedule is preserved',
  contentDiffArgs: ['--migrate-invalid-content'],
  seedSource: invalidScheduleOnlyScenario.seedSource,

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating an unchanged future schedule around a changed invalid current version',
    );
    const publicationScheduledAt = new Date(
      Date.now() + 72 * 60 * 60 * 1000,
    ).toISOString();
    const schedule = {
      publication_scheduled_at: publicationScheduledAt,
      selective_publication: {
        content_in_locales: ['it'],
        non_localized_content: true,
      },
    };
    await Promise.all([
      sourceClient.scheduledPublication.create(seed.recordId, schedule),
      destinationClient.scheduledPublication.create(seed.recordId, schedule),
    ]);

    const sourceBefore = await sourceClient.items.find(seed.recordId);
    await sourceClient.items.update<ScheduleOnlyDefinition>(seed.recordId, {
      title: INVALID_SCHEDULE_CHANGED_TITLE,
      meta: { current_version: sourceBefore.meta.current_version },
    });

    const [sourceField, destinationField] = await Promise.all([
      sourceClient.fields.update(seed.titleFieldId, {
        validators: INVALID_SCHEDULE_TITLE_VALIDATORS,
      }),
      destinationClient.fields.update(seed.titleFieldId, {
        validators: INVALID_SCHEDULE_TITLE_VALIDATORS,
      }),
    ]);
    await Promise.all([
      waitForValidity(sourceClient, seed.recordId, false, null),
      waitForValidity(destinationClient, seed.recordId, false, null),
    ]);

    const [source, destination] = await Promise.all([
      captureScheduleOnlyState(sourceClient, seed),
      captureScheduleOnlyState(destinationClient, seed),
    ]);
    assertUnchangedScheduleInvalidCurrentWriteState(source, destination);
    assert.deepEqual(sourceField.validators, INVALID_SCHEDULE_TITLE_VALIDATORS);
    assert.deepEqual(destinationField.validators, sourceField.validators);

    return {
      source,
      destination,
      validators: sourceField.validators,
    };
  },

  verifyGeneratedPlan: invalidScheduleOnlyScenario.verifyGeneratedPlan,

  async verify(context) {
    const verify = invalidScheduleOnlyScenario.verify;
    assert.ok(verify);
    await verify(context);
    assertUnchangedScheduleInvalidCurrentWriteState(
      context.expected.source,
      context.expected.destination,
    );
  },
};

export function assertUnchangedScheduleInvalidCurrentWriteState(
  source: ScheduleOnlyState,
  destination: ScheduleOnlyState,
): void {
  assert.deepEqual(
    source.publication,
    destination.publication,
    'source and destination publication schedules must be identical',
  );
  assert.ok(
    Date.parse(source.publication.at) > Date.now(),
    'the identical publication schedule must remain in the future',
  );
  assert.deepEqual(
    destination.record.title,
    INVALID_SCHEDULE_INITIAL_TITLE,
    'destination must retain the original invalid current value',
  );
  assert.deepEqual(
    source.record,
    {
      ...destination.record,
      title: INVALID_SCHEDULE_CHANGED_TITLE,
    },
    'source current must differ from destination only by the changed invalid value',
  );
  assert.equal(source.record.currentValid, false);
  assert.equal(source.record.publishedValid, null);
  assert.equal(destination.record.currentValid, false);
  assert.equal(destination.record.publishedValid, null);
}

export function assertInvalidScheduleOnlyManifest(
  value: unknown,
  expected: InvalidScheduleManifestExpectation,
): void {
  const plan = object(value, 'content plan');
  const invalidContent = object(plan.invalidContent, 'invalidContent');
  const skipped = array(invalidContent.skippedRecords, 'skippedRecords').map(
    (entry) => object(entry, 'skipped record'),
  );

  assert.deepEqual(plan.records, []);
  assert.deepEqual(plan.uploads, []);
  assert.deepEqual(plan.uploadCollections, []);
  assert.deepEqual(invalidContent.detectedRecordIds, [expected.recordId]);
  assert.deepEqual(invalidContent.migratedRecordIds, []);
  assert.equal(invalidContent.propagatedSkipCount, 0);
  assert.equal(invalidContent.migrateInvalidContent, true);
  assert.deepEqual(invalidContent.validatorRelaxations, []);
  const schemaStates = object(
    invalidContent.schemaStates,
    'invalidContent.schemaStates',
  );
  assert.equal(schemaStates.fullyRelaxedDigest, schemaStates.originalDigest);

  assert.equal(skipped.length, 1);
  const aggregate = skipped[0];
  assert.equal(aggregate.id, expected.recordId);
  assert.equal(aggregate.itemTypeId, expected.modelId);
  assert.equal(aggregate.disposition, 'preserve_target');
  assert.equal(typeof aggregate.sourceHash, 'string');
  assert.equal(typeof aggregate.expectedTargetHash, 'string');
  assert.notEqual(aggregate.sourceHash, aggregate.expectedTargetHash);
  assert.deepEqual(aggregate.sourceValidity, {
    current: false,
    published: null,
  });
  assert.deepEqual(aggregate.targetValidity, {
    current: false,
    published: null,
  });
  assert.deepEqual(aggregate.sourceNestedBlockIds, []);
  assert.deepEqual(aggregate.preservedExternalBlockIds, []);
  assert.deepEqual(aggregate.targetNestedBlockIds, []);
  assert.deepEqual(aggregate.reasons, [
    {
      code: 'UNSAFE_SCHEDULED_PUBLICATION',
      slice: 'schedule',
      message: `Record ${expected.recordId} has an invalid desired current version whose future publication scope cannot be proven valid under the restored validators.`,
      dependencyChain: [expected.recordId],
    },
  ]);

  const options = object(plan.options, 'options');
  assert.equal(options.migrateInvalidContent, true);
  const requiredPermissions = object(
    plan.requiredPermissions,
    'requiredPermissions',
  );
  assert.deepEqual(requiredPermissions.itemTypes, [
    { id: expected.modelId, actions: ['read'] },
  ]);
  assert.equal(requiredPermissions.manageSchedules, false);
  assert.equal(requiredPermissions.editSchema, false);

  const summary = object(plan.summary, 'summary');
  assert.deepEqual(summary.records, { create: 0, update: 0, delete: 0 });
  assert.deepEqual(summary.invalidContent, {
    status: 'partial',
    detectedRecords: 1,
    migratedRecords: 0,
    skippedRecords: 1,
    propagatedSkipCount: 0,
    validatorRelaxations: 0,
    relaxedFieldCount: 0,
    relaxedValidatorCount: 0,
    requiresTemporaryValidatorRelaxation: false,
  });
  assert.deepEqual(plan.warnings, [
    {
      code: 'INVALID_CONTENT_SKIPPED',
      message: `Record ${expected.recordId} was skipped as a whole (UNSAFE_SCHEDULED_PUBLICATION).`,
      entityIds: [expected.recordId],
    },
  ]);
}

async function captureScheduleOnlyState(
  client: CmaClient.Client,
  seed: ScheduleOnlySeed,
): Promise<ScheduleOnlyState> {
  const [itemResponse, scheduleResponse] = await Promise.all([
    client.items.rawFind(seed.recordId, { version: 'current' }),
    client.items.rawCurrentVsPublishedState(seed.recordId),
  ]);
  const resource = object(itemResponse.data, 'raw item');
  const attributes = object(resource.attributes, 'raw item attributes');
  const relationships = object(
    resource.relationships,
    'raw item relationships',
  );
  const itemType = object(
    object(relationships.item_type, 'item_type relationship').data,
    'item_type relationship data',
  );
  const meta = object(resource.meta, 'raw item meta');
  const title = object(attributes.title, 'localized title');

  const publicationRelationship = object(
    scheduleResponse.data.relationships.scheduled_publication,
    'scheduled publication relationship',
  );
  const publicationData = object(
    publicationRelationship.data,
    'scheduled publication relationship data',
  );
  const publicationId = string(publicationData.id, 'scheduled publication ID');
  const publication = scheduleResponse.included.find(
    ({ id, type }) => id === publicationId && type === 'scheduled_publication',
  );
  assert.ok(
    publication?.type === 'scheduled_publication',
    `scheduled publication ${publicationId} is missing from raw includes`,
  );
  const selective = publication.attributes.selective_publication;
  assert.ok(selective, 'publication schedule must stay selective');

  return {
    record: {
      id: string(resource.id, 'raw item ID'),
      itemTypeId: string(itemType.id, 'raw item model ID'),
      title: {
        en: string(title.en, 'title.en'),
        it: string(title.it, 'title.it'),
      },
      currentValid: boolean(meta.is_current_version_valid, 'current validity'),
      publishedValid: nullableBoolean(
        meta.is_published_version_valid,
        'published validity',
      ),
    },
    publication: {
      at: new Date(
        publication.attributes.publication_scheduled_at,
      ).toISOString(),
      contentInLocales: [...selective.content_in_locales],
      nonLocalizedContent: selective.non_localized_content,
    },
  };
}

async function waitForValidity(
  client: CmaClient.Client,
  recordId: string,
  current: boolean,
  published: boolean | null,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const record = await client.items.find(recordId);
    if (
      record.meta.is_current_version_valid === current &&
      record.meta.is_published_version_valid === published
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  const record = await client.items.find(recordId);
  throw new Error(
    `record validity did not converge: ${JSON.stringify({
      recordId,
      expected: { current, published },
      actual: {
        current: record.meta.is_current_version_valid,
        published: record.meta.is_published_version_valid,
      },
    })}`,
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error(`${label} must be a boolean or null`);
}
