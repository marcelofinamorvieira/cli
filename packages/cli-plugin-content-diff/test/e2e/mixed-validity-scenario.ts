import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

const CURRENT_VALID = 'current valid';
const PUBLISHED_VALID = 'published valid';
const CURRENT_INVALID = 'current invalid';
const PUBLISHED_INVALID = 'published invalid';

export const MIXED_VALIDITY_VALIDATORS = {
  enum: { values: [CURRENT_VALID, PUBLISHED_VALID] },
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    titleFieldId: string;
  }>;

type RecordState = Readonly<{
  id: string;
  currentTitle: string;
  publishedTitle: string;
  currentValid: boolean;
  publishedValid: boolean;
  status: string;
}>;

type Expected = Readonly<{
  currentValidRecord: RecordState;
  publishedValidRecord: RecordState;
  validators: Readonly<Record<string, unknown>>;
}>;

type MixedValidityDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: { title: { type: 'string'; localized: false } };
};

export function mixedValidityModelApiKey(runId: string): string {
  return `cde2e_mv_r${createHash('sha256')
    .update(runId)
    .digest('hex')
    .slice(0, 12)}`;
}

export const mixedValidityScenario: RealCmaScenario<Seed, Expected> = {
  name: 'opposite current and published validity states',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating mixed-validity schema');
    const apiKey = mixedValidityModelApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Mixed validity ${runId}`,
      api_key: apiKey,
      singleton: false,
      all_locales_required: false,
      sortable: false,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: true,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });
    const titleField = await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: {},
    });

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      titleFieldId: titleField.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log('[content-diff e2e] Creating opposite validity states');
    const currentValidRecord =
      await sourceClient.items.create<MixedValidityDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        title: PUBLISHED_INVALID,
      });
    await sourceClient.items.publish(currentValidRecord.id);
    await sourceClient.items.update<MixedValidityDefinition>(
      currentValidRecord.id,
      {
        title: CURRENT_VALID,
      },
    );

    const publishedValidRecord =
      await sourceClient.items.create<MixedValidityDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        title: PUBLISHED_VALID,
      });
    await sourceClient.items.publish(publishedValidRecord.id);
    await sourceClient.items.update<MixedValidityDefinition>(
      publishedValidRecord.id,
      {
        title: CURRENT_INVALID,
      },
    );

    const [sourceField, destinationField] = await Promise.all([
      sourceClient.fields.update(seed.titleFieldId, {
        validators: MIXED_VALIDITY_VALIDATORS,
      }),
      destinationClient.fields.update(seed.titleFieldId, {
        validators: MIXED_VALIDITY_VALIDATORS,
      }),
    ]);
    assert.deepEqual(sourceField.validators, MIXED_VALIDITY_VALIDATORS);
    assert.deepEqual(destinationField.validators, sourceField.validators);

    await Promise.all([
      waitForValidity(sourceClient, currentValidRecord.id, true, false),
      waitForValidity(sourceClient, publishedValidRecord.id, false, true),
    ]);
    const expected = {
      currentValidRecord: await captureRecordState(
        sourceClient,
        currentValidRecord.id,
      ),
      publishedValidRecord: await captureRecordState(
        sourceClient,
        publishedValidRecord.id,
      ),
      validators: sourceField.validators,
    };
    assert.deepEqual(pickValidity(expected.currentValidRecord), {
      current: true,
      published: false,
    });
    assert.deepEqual(pickValidity(expected.publishedValidRecord), {
      current: false,
      published: true,
    });
    await Promise.all([
      assertRecordAbsent(destinationClient, currentValidRecord.id),
      assertRecordAbsent(destinationClient, publishedValidRecord.id),
    ]);
    return expected;
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const envelope = object(
      JSON.parse(await readFile(planFilePath, 'utf8')),
      'plan envelope',
    );
    const plan = object(envelope.plan, 'content plan');
    const records = array(plan.records, 'record plans').map((entry) =>
      object(entry, 'record plan'),
    );
    const expectedIds = [
      expected.currentValidRecord.id,
      expected.publishedValidRecord.id,
    ].sort(compareDatoIds);
    assert.deepEqual(
      records
        .map((entry) => string(entry.id, 'record plan ID'))
        .sort(compareDatoIds),
      expectedIds,
    );
    assert.ok(records.every(({ action }) => action === 'create'));

    const invalidContent = object(plan.invalidContent, 'invalid content');
    assert.deepEqual(
      array(invalidContent.detectedRecordIds, 'detected record IDs')
        .map(String)
        .sort(compareDatoIds),
      expectedIds,
    );
    assert.deepEqual(
      array(invalidContent.migratedRecordIds, 'migrated record IDs')
        .map(String)
        .sort(compareDatoIds),
      expectedIds,
    );
    assert.deepEqual(invalidContent.skippedRecords, []);
    const relaxations = array(
      invalidContent.validatorRelaxations,
      'validator relaxations',
    ).map((entry) => object(entry, 'validator relaxation'));
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].fieldId, seed.titleFieldId);
    assert.deepEqual(
      relaxations[0].originalValidators,
      MIXED_VALIDITY_VALIDATORS,
    );
    assert.deepEqual(relaxations[0].relaxedValidators, {});
    assert.deepEqual(relaxations[0].relaxedValidatorKeys, ['enum']);
    assert.deepEqual(relaxations[0].affectedRecordIds, [
      expected.currentValidRecord.id,
    ]);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log('[content-diff e2e] Verifying opposite validity states');
    await Promise.all([
      waitForValidity(
        appliedClient,
        expected.currentValidRecord.id,
        true,
        false,
      ),
      waitForValidity(
        appliedClient,
        expected.publishedValidRecord.id,
        false,
        true,
      ),
    ]);
    const [
      sourceA,
      sourceB,
      appliedA,
      appliedB,
      sourceField,
      destinationField,
      appliedField,
    ] = await Promise.all([
      captureRecordState(sourceClient, expected.currentValidRecord.id),
      captureRecordState(sourceClient, expected.publishedValidRecord.id),
      captureRecordState(appliedClient, expected.currentValidRecord.id),
      captureRecordState(appliedClient, expected.publishedValidRecord.id),
      sourceClient.fields.find(seed.titleFieldId),
      destinationClient.fields.find(seed.titleFieldId),
      appliedClient.fields.find(seed.titleFieldId),
    ]);
    assert.deepEqual(sourceA, expected.currentValidRecord);
    assert.deepEqual(sourceB, expected.publishedValidRecord);
    assert.deepEqual(appliedA, expected.currentValidRecord);
    assert.deepEqual(appliedB, expected.publishedValidRecord);
    assert.deepEqual(sourceField.validators, expected.validators);
    assert.deepEqual(destinationField.validators, expected.validators);
    assert.deepEqual(appliedField.validators, expected.validators);
  },
};

async function captureRecordState(
  client: CmaClient.Client,
  recordId: string,
): Promise<RecordState> {
  const [current, published] = await Promise.all([
    client.items.find<MixedValidityDefinition>(recordId, {
      version: 'current',
    }),
    client.items.find<MixedValidityDefinition>(recordId, {
      version: 'published',
    }),
  ]);
  return {
    id: recordId,
    currentTitle: requiredString(current.title, `${recordId}.current.title`),
    publishedTitle: requiredString(
      published.title,
      `${recordId}.published.title`,
    ),
    currentValid: requiredBoolean(
      current.meta.is_current_version_valid,
      `${recordId}.current validity`,
    ),
    publishedValid: requiredBoolean(
      current.meta.is_published_version_valid,
      `${recordId}.published validity`,
    ),
    status: requiredString(current.meta.status, `${recordId}.status`),
  };
}

async function waitForValidity(
  client: CmaClient.Client,
  recordId: string,
  current: boolean,
  published: boolean,
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

async function assertRecordAbsent(
  client: CmaClient.Client,
  recordId: string,
): Promise<void> {
  try {
    await client.items.find(recordId);
    assert.fail(`record ${recordId} unexpectedly exists`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    const status =
      typeof error === 'object' && error !== null && 'response' in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
    assert.equal(status, 404, `record ${recordId} lookup did not return 404`);
  }
}

function pickValidity(record: RecordState): {
  current: boolean;
  published: boolean;
} {
  return {
    current: record.currentValid,
    published: record.publishedValid,
  };
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

function string(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value as string;
}

function requiredString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value as string;
}

function requiredBoolean(value: unknown, label: string): boolean {
  assert.equal(typeof value, 'boolean', `${label} must be a boolean`);
  return value as boolean;
}

function compareDatoIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
