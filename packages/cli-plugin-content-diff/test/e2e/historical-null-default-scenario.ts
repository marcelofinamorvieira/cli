import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Definition = {
  settings: { locales: 'en' | 'it' };
  itemTypeId: string;
  fields: {
    plain: { type: 'float'; localized: false };
    localized: { type: 'float'; localized: true };
  };
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    recordId: string;
    plainFieldId: string;
    localizedFieldId: string;
  }>;

type RecordState = Readonly<{
  id: string;
  plain: number | null;
  localized: Readonly<{ en: number | null; it: number | null }>;
  status: string;
  currentValid: boolean | null;
  publishedValid: boolean | null;
}>;

type SliceState = Readonly<{
  current: RecordState | null;
  published: RecordState | null;
}>;

type Expected = Readonly<{
  source: SliceState;
  destination: SliceState;
}>;

export const HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT = {
  fieldType: 'float',
  plainDefault: 125.5,
  localizedDefault: {
    en: 250.25,
    it: 375.75,
  },
} as const;

export const PROVEN_FEATURES = [
  'source-only record creation with a historical null under a later non-localized float default',
  'localized en and it historical nulls under distinct later float defaults',
  'explicit migrate-invalid-content authorization for temporary schema mutation',
  'exact default-suppression warning field IDs and schema-edit permission',
  'exact restoration of non-localized and localized field defaults',
  'exact raw current and published source-to-applied state',
  'mutation-free migration replay and empty regeneration via the real-CMA harness',
] as const;

export function historicalNullDefaultApiKey(runId: string): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return `cde2e_hnd_r${suffix}`;
}

export const historicalNullDefaultScenario: RealCmaScenario<Seed, Expected> = {
  name: 'historical float null values under later non-null field defaults',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating historical-null schema');
    await client.site.update({ locales: ['en', 'it'] });
    const apiKey = historicalNullDefaultApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Historical null defaults ${runId}`,
      api_key: apiKey,
      singleton: false,
      all_locales_required: true,
      sortable: false,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: false,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });
    const plainField = await client.fields.create(model.id, {
      label: 'Plain float',
      api_key: 'plain',
      field_type: HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.fieldType,
      localized: false,
      default_value: null,
      validators: {},
    });
    const localizedField = await client.fields.create(model.id, {
      label: 'Localized float',
      api_key: 'localized',
      field_type: HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.fieldType,
      localized: true,
      default_value: { en: null, it: null },
      validators: {},
    });
    const record = await client.items.create<Definition>({
      item_type: { id: model.id, type: 'item_type' },
      plain: null,
      localized: { en: null, it: null },
    });
    await client.items.publish<Definition>(record.id);

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      recordId: record.id,
      plainFieldId: plainField.id,
      localizedFieldId: localizedField.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Adding equal non-null defaults after the null record exists',
    );
    await Promise.all([
      sourceClient.fields.update(seed.plainFieldId, {
        default_value: HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.plainDefault,
      }),
      destinationClient.fields.update(seed.plainFieldId, {
        default_value: HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.plainDefault,
      }),
    ]);
    await Promise.all([
      sourceClient.fields.update(seed.localizedFieldId, {
        default_value: HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.localizedDefault,
      }),
      destinationClient.fields.update(seed.localizedFieldId, {
        default_value: HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.localizedDefault,
      }),
    ]);
    await destinationClient.items.destroy(seed.recordId);

    const [source, destination] = await Promise.all([
      captureState(sourceClient, seed),
      captureState(destinationClient, seed),
    ]);
    assert.deepEqual(source.current?.plain, null);
    assert.deepEqual(source.current?.localized, { en: null, it: null });
    assert.deepEqual(source.published?.plain, null);
    assert.deepEqual(source.published?.localized, { en: null, it: null });
    assert.deepEqual(destination, { current: null, published: null });
    await assertFieldDefaults(sourceClient, seed);
    await assertFieldDefaults(destinationClient, seed);
    return { source, destination };
  },

  async verifyGeneratedPlan({ seed, planFilePath }) {
    const envelope = requiredObject(
      JSON.parse(await readFile(planFilePath, 'utf8')),
      'plan envelope',
    );
    assertHistoricalNullDefaultSuppressionPlan(
      requiredObject(envelope.plan, 'plan'),
      seed,
    );
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying explicit historical nulls survive CMA default filling',
    );
    const [source, destination, applied] = await Promise.all([
      captureState(sourceClient, seed),
      captureState(destinationClient, seed),
      captureState(appliedClient, seed),
    ]);
    assert.deepEqual(source, expected.source);
    assert.deepEqual(destination, expected.destination);
    assert.deepEqual(applied, expected.source);
    await assertFieldDefaults(appliedClient, seed);
  },
};

export function assertHistoricalNullDefaultSuppressionPlan(
  plan: Record<string, unknown>,
  fieldIds: Pick<Seed, 'plainFieldId' | 'localizedFieldId'>,
): void {
  assert.equal(
    requiredObject(plan.options, 'plan.options').migrateInvalidContent,
    true,
    'historical-null creation must carry explicit schema-mutation opt-in',
  );
  assert.equal(
    requiredObject(plan.requiredPermissions, 'plan.requiredPermissions')
      .editSchema,
    true,
    'historical-null creation must require schema-edit permission',
  );

  const warnings = requiredArray(plan.warnings, 'plan.warnings')
    .map((value, index) => requiredObject(value, `plan.warnings[${index}]`))
    .filter(({ code }) => code === 'DEFAULT_VALUE_SUPPRESSION');
  assert.equal(
    warnings.length,
    1,
    'plan must contain exactly one default-suppression warning',
  );
  assert.deepEqual(
    requiredArray(warnings[0]?.entityIds, 'DEFAULT_VALUE_SUPPRESSION.entityIds')
      .map(String)
      .sort(),
    [fieldIds.plainFieldId, fieldIds.localizedFieldId].sort(),
    'default suppression must target exactly the plain and localized float fields',
  );
}

async function assertFieldDefaults(
  client: CmaClient.Client,
  seed: Pick<Seed, 'plainFieldId' | 'localizedFieldId'>,
): Promise<void> {
  const [plain, localized] = await Promise.all([
    client.fields.rawFind(seed.plainFieldId),
    client.fields.rawFind(seed.localizedFieldId),
  ]);
  assert.equal(
    plain.data.attributes.default_value,
    HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.plainDefault,
  );
  assert.deepEqual(
    localized.data.attributes.default_value,
    HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT.localizedDefault,
  );
}

async function captureState(
  client: CmaClient.Client,
  seed: Pick<Seed, 'modelId' | 'recordId'>,
): Promise<SliceState> {
  const [current, published] = await Promise.all(
    (['current', 'published'] as const).map(async (version) => {
      const response = await client.items.rawList<Definition>({
        filter: { type: seed.modelId, ids: seed.recordId },
        version,
        page: { limit: 30 },
      });
      assert.ok(response.data.length <= 1);
      const record = response.data[0];
      if (!record) return null;
      return {
        id: record.id,
        plain: nullableNumber(record.attributes.plain, `${record.id}.plain`),
        localized: {
          en: nullableNumber(
            record.attributes.localized.en,
            `${record.id}.localized.en`,
          ),
          it: nullableNumber(
            record.attributes.localized.it,
            `${record.id}.localized.it`,
          ),
        },
        status: String(record.meta.status),
        currentValid:
          typeof record.meta.is_current_version_valid === 'boolean'
            ? record.meta.is_current_version_valid
            : null,
        publishedValid:
          typeof record.meta.is_published_version_valid === 'boolean'
            ? record.meta.is_published_version_valid
            : null,
      } satisfies RecordState;
    }),
  );
  return { current, published };
}

function nullableNumber(value: unknown, path: string): number | null {
  assert.ok(
    value === null || (typeof value === 'number' && Number.isFinite(value)),
    `${path} must be a finite number or null`,
  );
  return value;
}

function requiredObject(value: unknown, path: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${path} must be an object`,
  );
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, path: string): unknown[] {
  assert.ok(Array.isArray(value), `${path} must be an array`);
  return value;
}
