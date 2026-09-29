import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import {
  ASSET_FIXTURE_PNG,
  md5,
  waitForUploadAntivirusClean,
} from './assets-deletions-scenario';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

export const PROVEN_FEATURES = [
  'localized file values in en and it',
  'localized gallery values in en and it',
  'localized SEO values in en and it',
  'localized external-video values in en and it',
  'field-level localized file and gallery metadata',
  'explicit null versus empty gallery distinctions',
  'omitted it locale keys preserved independently from explicit nulls',
  'file reference inside a localized single-block value',
  'source-only upload bundled with exact bytes and writable metadata',
  'historical null under later color default',
  'historical null under later date default',
  'historical null under later date-time default',
  'historical null under later float default',
  'historical null under later integer default',
  'historical null under later JSON default',
  'historical null under later latitude-longitude default',
  'historical false under later boolean default because CMA normalizes null to false',
  'historical empty text under later text default because CMA normalizes null to empty text',
  'exact opt-in field-default suppression plan for only create-time historical nulls',
  'exact raw current and published source-to-applied state',
  'exact raw schema default JSON bytes',
  'mutation-free migration replay and empty regeneration via the real-CMA harness',
] as const;

type ScalarApiKey =
  | 'boolean_value'
  | 'color_value'
  | 'date_value'
  | 'date_time_value'
  | 'float_value'
  | 'integer_value'
  | 'json_value'
  | 'lat_lon_value'
  | 'text_value';

type ScalarFieldType =
  | 'boolean'
  | 'color'
  | 'date'
  | 'date_time'
  | 'float'
  | 'integer'
  | 'json'
  | 'lat_lon'
  | 'text';

type ScalarDefaultSpec = Readonly<{
  apiKey: ScalarApiKey;
  fieldType: ScalarFieldType;
  label: string;
  historicalInput: unknown;
  historicalStored: unknown;
  defaultValue: unknown;
  /** Exact CMA-serialized value when the write input is normalized. */
  storedDefaultValue?: unknown;
}>;

export const SCALAR_DEFAULT_SPECS: readonly ScalarDefaultSpec[] = [
  {
    apiKey: 'boolean_value',
    fieldType: 'boolean',
    label: 'Boolean value',
    historicalInput: null,
    historicalStored: false,
    defaultValue: true,
  },
  {
    apiKey: 'color_value',
    fieldType: 'color',
    label: 'Color value',
    historicalInput: null,
    historicalStored: null,
    defaultValue: { red: 17, green: 34, blue: 51, alpha: 204 },
  },
  {
    apiKey: 'date_value',
    fieldType: 'date',
    label: 'Date value',
    historicalInput: null,
    historicalStored: null,
    defaultValue: '2042-02-03',
  },
  {
    apiKey: 'date_time_value',
    fieldType: 'date_time',
    label: 'Date-time value',
    historicalInput: null,
    historicalStored: null,
    defaultValue: '2042-02-03T04:05:06+01:00',
    storedDefaultValue: '2042-02-03T04:05:06.000+01:00',
  },
  {
    apiKey: 'float_value',
    fieldType: 'float',
    label: 'Float value',
    historicalInput: null,
    historicalStored: null,
    defaultValue: 42.625,
  },
  {
    apiKey: 'integer_value',
    fieldType: 'integer',
    label: 'Integer value',
    historicalInput: null,
    historicalStored: null,
    defaultValue: 73,
  },
  {
    apiKey: 'json_value',
    fieldType: 'json',
    label: 'JSON value',
    historicalInput: null,
    historicalStored: null,
    defaultValue: JSON.stringify(
      { alpha: [1, true, null], beta: { exact: 'default JSON bytes' } },
      null,
      2,
    ),
  },
  {
    apiKey: 'lat_lon_value',
    fieldType: 'lat_lon',
    label: 'Latitude-longitude value',
    historicalInput: null,
    historicalStored: null,
    defaultValue: { latitude: 45.0703, longitude: 7.6869 },
  },
  {
    apiKey: 'text_value',
    fieldType: 'text',
    label: 'Text value',
    historicalInput: null,
    historicalStored: '',
    defaultValue: 'Later text default must not replace historical empty text',
  },
] as const;

const MEDIA_FIELD_API_KEYS = [
  'hero',
  'gallery',
  'seo',
  'external_video',
  'feature',
] as const;

type Definition = {
  settings: { locales: 'en' | 'it' };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    hero: { type: 'file'; localized: true };
    gallery: { type: 'gallery'; localized: true };
    seo: { type: 'seo'; localized: true };
    external_video: { type: 'video'; localized: true };
    feature: { type: 'single_block'; localized: true };
    boolean_value: { type: 'boolean'; localized: false };
    color_value: { type: 'color'; localized: false };
    date_value: { type: 'date'; localized: false };
    date_time_value: { type: 'date_time'; localized: false };
    float_value: { type: 'float'; localized: false };
    integer_value: { type: 'integer'; localized: false };
    json_value: { type: 'json'; localized: false };
    lat_lon_value: { type: 'lat_lon'; localized: false };
    text_value: { type: 'text'; localized: false };
  };
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    blockModelId: string;
    mainRecordId: string;
    omittedLocaleRecordId: string;
    scalarFieldIds: Readonly<Record<ScalarApiKey, string>>;
  }>;

export type CanonicalRecord = Readonly<{
  id: string;
  itemTypeId: string;
  status: string;
  currentValid: boolean | null;
  publishedValid: boolean | null;
  fields: Readonly<Record<string, unknown>>;
}>;

export type RawMediaState = Readonly<{
  current: readonly CanonicalRecord[];
  published: readonly CanonicalRecord[];
}>;

export type RawUploadState = Readonly<{
  id: string;
  size: number;
  md5: string;
  filename: string;
  basename: string;
  mimeType: string | null;
  author: string | null;
  copyright: string | null;
  notes: string | null;
  tags: readonly string[];
  defaultFieldMetadata: unknown;
}>;

export type RawSchemaDefault = Readonly<{
  id: string;
  fieldType: string;
  localized: boolean;
  defaultValue: unknown;
  rawJsonUtf8Hex: string;
}>;

type Expected = Readonly<{
  uploadId: string;
  source: RawMediaState;
  destination: RawMediaState;
  upload: RawUploadState;
  schemaDefaults: Readonly<Record<ScalarApiKey, RawSchemaDefault>>;
}>;

const EMPTY_DESTINATION: RawMediaState = { current: [], published: [] };

export const localizedMediaDefaultsScenario: RealCmaScenario<Seed, Expected> = {
  name: 'localized media, nested upload, video, and cross-type historical defaults',
  contentDiffArgs: [
    '--uploads=all',
    '--bundle-assets',
    '--migrate-invalid-content',
  ],

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating localized media and scalar-default schema',
    );
    await client.site.update({
      locales: ['en', 'it'],
      timezone: 'Europe/Rome',
    } as never);
    const { modelApiKey, blockModelApiKey } = localizedMediaApiKeys(runId);
    const blockModel = await client.itemTypes.create({
      name: `Localized media block ${runId}`,
      api_key: blockModelApiKey,
      modular_block: true,
    });
    await client.fields.create(blockModel.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(blockModel.id, {
      label: 'Nested media',
      api_key: 'media',
      field_type: 'file',
      localized: false,
      validators: {},
    });

    const model = await client.itemTypes.create({
      name: `Localized media defaults ${runId}`,
      api_key: modelApiKey,
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
    await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await createLocalizedMediaFields(client, model.id, blockModel.id);

    const scalarFieldIds = {} as Record<ScalarApiKey, string>;
    for (const spec of SCALAR_DEFAULT_SPECS) {
      const field = await client.fields.create(model.id, {
        label: spec.label,
        api_key: spec.apiKey,
        field_type: spec.fieldType,
        localized: false,
        default_value: null,
        validators: {},
      } as never);
      scalarFieldIds[spec.apiKey] = field.id;
    }

    const mainRecord = (await client.items.create(
      historicalRecordPayload(model.id, 'explicit en/it historical record', [
        'en',
        'it',
      ]) as never,
    )) as unknown as { id: string };
    await client.items.publish<Definition>(mainRecord.id);
    const omittedLocaleRecord = (await client.items.create(
      historicalRecordPayload(model.id, 'omitted it locale record', [
        'en',
      ]) as never,
    )) as unknown as { id: string };
    await client.items.publish<Definition>(omittedLocaleRecord.id);

    const seed = {
      itemTypeApiKeys: [modelApiKey],
      modelId: model.id,
      blockModelId: blockModel.id,
      mainRecordId: mainRecord.id,
      omittedLocaleRecordId: omittedLocaleRecord.id,
      scalarFieldIds,
    } satisfies Seed;
    const baseline = await captureRawMediaState(client, seed);
    assertHistoricalScalarValues(baseline, seed);
    assertOmittedLocaleKeys(baseline, seed.omittedLocaleRecordId);
    return seed;
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Adding later defaults and source-only localized media',
    );
    const upload = await withFixturePng((localPath) =>
      sourceClient.uploads.createFromLocalFile({
        localPath,
        filename: 'localized-media-source.png',
        skipCreationIfAlreadyExists: false,
        author: 'Localized media author',
        copyright: 'Localized media copyright',
        notes: 'Exact en/it metadata and bundled PNG bytes',
        tags: ['localized', 'nested-media', 'schema-breadth'],
        default_field_metadata: {
          alt: {
            en: 'English upload default alt',
            it: '',
          },
          title: {
            en: null,
            it: 'Titolo predefinito upload',
          },
          custom_data: {
            en: { locale: 'en', exact: true },
            it: {},
          },
          focal_point: { x: 0.13, y: 0.87 },
          poster_time: null,
        },
      }),
    );
    await waitForUploadAntivirusClean(
      {
        rawFindUpload: (id) => sourceClient.uploads.rawFind(id),
      },
      upload.id,
    );

    await sourceClient.items.update<Definition>(
      seed.mainRecordId,
      publishedMediaFields(seed, upload.id) as never,
    );
    await sourceClient.items.publish<Definition>(seed.mainRecordId);
    await sourceClient.items.update<Definition>(
      seed.mainRecordId,
      currentMediaFields(seed, upload.id) as never,
    );

    // Defaults are intentionally introduced only after every source item
    // mutation. CMA default filling runs during item writes, so reversing this
    // order would erase the historical null/false/empty control values before
    // content:diff ever observes them.
    for (const spec of SCALAR_DEFAULT_SPECS) {
      await Promise.all([
        sourceClient.fields.update(seed.scalarFieldIds[spec.apiKey], {
          default_value: spec.defaultValue,
        } as never),
        destinationClient.fields.update(seed.scalarFieldIds[spec.apiKey], {
          default_value: spec.defaultValue,
        } as never),
      ]);
    }

    await destinationClient.items.destroy(seed.mainRecordId);
    await destinationClient.items.destroy(seed.omittedLocaleRecordId);

    const [source, destination, sourceUpload, sourceDefaults, targetDefaults] =
      await Promise.all([
        captureRawMediaState(sourceClient, seed),
        captureRawMediaState(destinationClient, seed),
        captureRawUpload(sourceClient, upload.id),
        captureRawSchemaDefaults(sourceClient, seed.scalarFieldIds),
        captureRawSchemaDefaults(destinationClient, seed.scalarFieldIds),
      ]);
    assert.deepEqual(destination, EMPTY_DESTINATION);
    assert.deepEqual(targetDefaults, sourceDefaults);
    assertHistoricalScalarValues(source, seed);
    assertOmittedLocaleKeys(source, seed.omittedLocaleRecordId);
    assertLocalizedMediaSemantics(source, seed, upload.id);
    assertUploadFixture(sourceUpload, upload.id);
    assertSchemaDefaults(sourceDefaults);

    return {
      uploadId: upload.id,
      source,
      destination,
      upload: sourceUpload,
      schemaDefaults: sourceDefaults,
    };
  },

  async verifyGeneratedPlan({
    seed,
    expected,
    migrationFilePath,
    planFilePath,
  }) {
    const envelope = object(JSON.parse(await readFile(planFilePath, 'utf8')));
    const plan = object(envelope.plan);
    const records = array(plan.records).map((value, index) =>
      object(value, `plan.records[${index}]`),
    );
    assert.deepEqual(
      records.map(({ id }) => String(id)).sort(),
      [seed.mainRecordId, seed.omittedLocaleRecordId].sort(),
    );
    assert.ok(
      records.every(({ action }) => action === 'create'),
      'both destination-absent records must be planned as creates',
    );
    assert.deepEqual(
      array(object(plan.invalidContent, 'plan.invalidContent').skippedRecords),
      [],
      'localized media records were unexpectedly skipped',
    );
    assertLocalizedMediaDefaultSuppressionPlan(plan, seed.scalarFieldIds);

    const uploads = array(plan.uploads).map((value, index) =>
      object(value, `plan.uploads[${index}]`),
    );
    const plannedUpload = uploads.find(({ id }) => id === expected.uploadId);
    assert.ok(
      plannedUpload,
      'source-only media upload is absent from the plan',
    );
    assert.equal(plannedUpload.action, 'create');
    const desired = object(plannedUpload.desired, 'planned upload desired');
    const transport = object(desired.transport, 'planned upload transport');
    const bundledPath = nonEmptyString(
      transport.bundledPath,
      'planned upload bundledPath',
    );
    assert.equal(
      transport.sha256,
      createHash('sha256').update(ASSET_FIXTURE_PNG).digest('hex'),
    );
    const bundledBytes = await readFile(
      resolve(dirname(planFilePath), bundledPath),
    );
    assert.deepEqual(bundledBytes, ASSET_FIXTURE_PNG);
    assert.equal(dirname(migrationFilePath), dirname(dirname(planFilePath)));
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying raw localized media, defaults, and upload bytes',
    );
    const [source, destination, applied, upload, defaults] = await Promise.all([
      captureRawMediaState(sourceClient, seed),
      captureRawMediaState(destinationClient, seed),
      captureRawMediaState(appliedClient, seed),
      captureRawUpload(appliedClient, expected.uploadId),
      captureRawSchemaDefaults(appliedClient, seed.scalarFieldIds),
    ]);
    assert.deepEqual(source, expected.source, 'source fixture changed');
    assert.deepEqual(
      destination,
      expected.destination,
      'destination fixture changed',
    );
    assert.deepEqual(
      applied,
      expected.source,
      'raw item slices did not converge',
    );
    assert.deepEqual(upload, expected.upload, 'raw upload did not converge');
    assert.deepEqual(
      defaults,
      expected.schemaDefaults,
      'raw field default JSON bytes did not converge',
    );
    assertHistoricalScalarValues(applied, seed);
    assertOmittedLocaleKeys(applied, seed.omittedLocaleRecordId);
    assertLocalizedMediaSemantics(applied, seed, expected.uploadId);
    assertUploadFixture(upload, expected.uploadId);
    assertSchemaDefaults(defaults);
  },
};

export function assertLocalizedMediaDefaultSuppressionPlan(
  plan: Record<string, unknown>,
  scalarFieldIds: Readonly<Record<ScalarApiKey, string>>,
): void {
  assert.equal(
    object(plan.options, 'plan.options').migrateInvalidContent,
    true,
    'historical-null creation must carry explicit schema-mutation opt-in',
  );
  assert.equal(
    object(plan.requiredPermissions, 'plan.requiredPermissions').editSchema,
    true,
    'historical-null creation must require schema-edit permission',
  );

  const suppressionWarnings = array(plan.warnings, 'plan.warnings')
    .map((value, index) => object(value, `plan.warnings[${index}]`))
    .filter(({ code }) => code === 'DEFAULT_VALUE_SUPPRESSION');
  assert.equal(
    suppressionWarnings.length,
    1,
    'plan must contain exactly one default-suppression warning',
  );
  const expectedFieldIds = SCALAR_DEFAULT_SPECS.filter(
    ({ historicalStored }) => historicalStored === null,
  )
    .map(({ apiKey }) => scalarFieldIds[apiKey])
    .sort();
  assert.equal(expectedFieldIds.length, 7);
  assert.deepEqual(
    array(
      suppressionWarnings[0]?.entityIds,
      'DEFAULT_VALUE_SUPPRESSION.entityIds',
    )
      .map((value, index) =>
        nonEmptyString(value, `DEFAULT_VALUE_SUPPRESSION.entityIds[${index}]`),
      )
      .sort(),
    expectedFieldIds,
    'default suppression must target only the seven scalar fields whose historical value remains null after CMA normalization',
  );
}

export function localizedMediaApiKeys(runId: string): {
  modelApiKey: string;
  blockModelApiKey: string;
} {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return {
    modelApiKey: `cde2e_lmd_r${suffix}`,
    blockModelApiKey: `cde2e_lmb_r${suffix}`,
  };
}

async function createLocalizedMediaFields(
  client: CmaClient.Client,
  modelId: string,
  blockModelId: string,
): Promise<void> {
  const fields = [
    { label: 'Hero', api_key: 'hero', field_type: 'file', validators: {} },
    {
      label: 'Gallery',
      api_key: 'gallery',
      field_type: 'gallery',
      validators: {},
    },
    { label: 'SEO', api_key: 'seo', field_type: 'seo', validators: {} },
    {
      label: 'External video',
      api_key: 'external_video',
      field_type: 'video',
      validators: {},
    },
    {
      label: 'Feature block',
      api_key: 'feature',
      field_type: 'single_block',
      validators: { single_block_blocks: { item_types: [blockModelId] } },
    },
  ] as const;
  for (const field of fields) {
    await client.fields.create(modelId, {
      ...field,
      localized: true,
      default_value: { en: null, it: null },
    } as never);
  }
}

function historicalRecordPayload(
  modelId: string,
  title: string,
  locales: readonly ('en' | 'it')[],
): Record<string, unknown> {
  const nullableLocales = Object.fromEntries(
    locales.map((locale) => [locale, null]),
  );
  const galleryLocales = Object.fromEntries(
    locales.map((locale) => [locale, []]),
  );
  return {
    item_type: { id: modelId, type: 'item_type' },
    title,
    hero: nullableLocales,
    gallery: galleryLocales,
    seo: nullableLocales,
    external_video: nullableLocales,
    feature: nullableLocales,
    ...Object.fromEntries(
      SCALAR_DEFAULT_SPECS.map(({ apiKey, historicalInput }) => [
        apiKey,
        historicalInput,
      ]),
    ),
  };
}

function publishedMediaFields(
  seed: Seed,
  uploadId: string,
): Record<string, unknown> {
  const blockIds = localizedMediaStageBlockIds(seed.mainRecordId);
  return {
    hero: {
      en: fileValue(uploadId, {
        alt: '',
        title: null,
        customData: {},
        focalPoint: { x: 0.21, y: 0.79 },
      }),
      it: null,
    },
    gallery: {
      en: [
        fileValue(uploadId, {
          alt: 'Published English gallery alt',
          title: '',
          customData: { slice: 'published', locale: 'en' },
          focalPoint: { x: 0.31, y: 0.69 },
        }),
      ],
      it: [],
    },
    seo: {
      en: {
        title: '',
        description: null,
        image: uploadId,
        twitter_card: 'summary',
        no_index: false,
      },
      it: null,
    },
    external_video: {
      en: externalVideo('youtube', 'published-en'),
      it: null,
    },
    feature: {
      en: mediaBlock(
        seed.blockModelId,
        blockIds.en,
        uploadId,
        'Published English nested media',
      ),
      it: mediaBlock(
        seed.blockModelId,
        blockIds.it,
        uploadId,
        'Published Italian nested media',
      ),
    },
  };
}

function currentMediaFields(
  seed: Seed,
  uploadId: string,
): Record<string, unknown> {
  const blockIds = localizedMediaStageBlockIds(seed.mainRecordId);
  return {
    hero: {
      en: null,
      it: fileValue(uploadId, {
        alt: null,
        title: '',
        customData: { slice: 'current', locale: 'it' },
        focalPoint: { x: 0.41, y: 0.59 },
      }),
    },
    gallery: {
      en: [],
      it: [
        fileValue(uploadId, {
          alt: '',
          title: 'Current Italian gallery title',
          customData: {},
          focalPoint: { x: 0.51, y: 0.49 },
        }),
      ],
    },
    seo: {
      en: null,
      it: {
        title: 'SEO corrente italiano',
        description: '',
        image: uploadId,
        twitter_card: 'summary_large_image',
        no_index: true,
      },
    },
    external_video: {
      en: null,
      it: externalVideo('vimeo', 'current-it'),
    },
    feature: {
      en: null,
      it: mediaBlock(
        seed.blockModelId,
        blockIds.it,
        uploadId,
        'Current Italian nested media',
      ),
    },
  };
}

/**
 * Every block used by the current slice is first materialized by the published
 * slice. This is the content-diff V9 stage-safety invariant: phase 8 may update
 * an existing nested ID, but must never introduce a fresh nested ID.
 */
export function localizedMediaStageBlockIds(recordId: string): Readonly<{
  en: string;
  it: string;
}> {
  return {
    en: deterministicPortableId(`${recordId}:block:en`),
    it: deterministicPortableId(`${recordId}:block:it`),
  };
}

function fileValue(
  uploadId: string,
  input: Readonly<{
    alt: string | null;
    title: string | null;
    customData: Readonly<Record<string, string>>;
    focalPoint: Readonly<{ x: number; y: number }>;
  }>,
): Record<string, unknown> {
  return {
    upload_id: uploadId,
    alt: input.alt,
    title: input.title,
    custom_data: input.customData,
    focal_point: input.focalPoint,
    poster_time: null,
  };
}

function externalVideo(
  provider: 'youtube' | 'vimeo',
  label: string,
): Record<string, unknown> {
  const providerUid = provider === 'youtube' ? 'dQw4w9WgXcQ' : '76979871';
  return {
    url:
      provider === 'youtube'
        ? `https://www.youtube.com/watch?v=${providerUid}`
        : `https://vimeo.com/${providerUid}`,
    width: 1920,
    height: 1080,
    thumbnail_url: `https://example.invalid/${label}.jpg`,
    title: `${label} external video`,
    provider,
    provider_uid: providerUid,
  };
}

function mediaBlock(
  blockModelId: string,
  id: string,
  uploadId: string,
  label: string,
): ReturnType<typeof CmaClient.buildBlockRecord> {
  return CmaClient.buildBlockRecord({
    id,
    item_type: { id: blockModelId, type: 'item_type' },
    label,
    media: fileValue(uploadId, {
      alt: `${label} alt`,
      title: null,
      customData: { nested: 'true', label },
      focalPoint: { x: 0.61, y: 0.39 },
    }),
  });
}

function deterministicPortableId(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('base64url');
}

async function withFixturePng<T>(
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    join(tmpdir(), 'content-diff-localized-media-'),
  );
  const path = join(directory, 'localized-media.png');
  try {
    await writeFile(path, ASSET_FIXTURE_PNG);
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function captureRawMediaState(
  client: CmaClient.Client,
  selection: Pick<Seed, 'modelId' | 'mainRecordId' | 'omittedLocaleRecordId'>,
): Promise<RawMediaState> {
  const ids = [selection.mainRecordId, selection.omittedLocaleRecordId];
  const [current, published] = await Promise.all(
    (['current', 'published'] as const).map(async (version) => {
      const records = await Promise.all(
        ids.map(async (id) => {
          try {
            const response = await client.items.rawFind<Definition>(id, {
              nested: true,
              version,
            });
            return projectRawLocalizedMediaRecord(response, selection.modelId);
          } catch (error) {
            if (
              error instanceof CmaClient.ApiError &&
              error.findError('NOT_FOUND')
            ) {
              return null;
            }
            throw error;
          }
        }),
      );
      return records
        .filter((record): record is CanonicalRecord => record !== null)
        .sort((left, right) => left.id.localeCompare(right.id));
    }),
  );
  return { current, published };
}

export function projectRawLocalizedMediaRecord(
  response: unknown,
  expectedModelId: string,
): CanonicalRecord {
  const resource = object(
    object(response, 'record response').data,
    'record data',
  );
  assert.equal(resource.type, 'item');
  const relationships = object(resource.relationships, 'record relationships');
  const itemType = object(relationships.item_type, 'record item_type');
  const itemTypeData = object(itemType.data, 'record item_type data');
  const itemTypeId = nonEmptyString(itemTypeData.id, 'record item type ID');
  assert.equal(itemTypeId, expectedModelId);
  const meta = object(resource.meta ?? {}, 'record meta');
  return {
    id: nonEmptyString(resource.id, 'record ID'),
    itemTypeId,
    status: nonEmptyString(meta.status, 'record status'),
    currentValid: nullableBoolean(
      meta.is_current_version_valid,
      'is_current_version_valid',
    ),
    publishedValid: nullableBoolean(
      meta.is_published_version_valid,
      'is_published_version_valid',
    ),
    fields: canonicalizeValue(
      object(resource.attributes, 'record attributes'),
    ) as Record<string, unknown>,
  };
}

async function captureRawUpload(
  client: CmaClient.Client,
  uploadId: string,
): Promise<RawUploadState> {
  const response = await client.uploads.rawFind(uploadId);
  return projectRawLocalizedUpload(response, uploadId);
}

export function projectRawLocalizedUpload(
  response: unknown,
  uploadId: string,
): RawUploadState {
  const resource = object(
    object(response, 'upload response').data,
    'upload resource',
  );
  assert.equal(resource.type, 'upload');
  assert.equal(resource.id, uploadId);
  const attributes = object(resource.attributes, 'upload attributes');
  return {
    id: uploadId,
    size: finiteNumber(attributes.size, 'upload size'),
    md5: nonEmptyString(attributes.md5, 'upload md5'),
    filename: nonEmptyString(attributes.filename, 'upload filename'),
    basename: nonEmptyString(attributes.basename, 'upload basename'),
    mimeType: nullableString(attributes.mime_type, 'upload mime type'),
    author: nullableString(attributes.author, 'upload author'),
    copyright: nullableString(attributes.copyright, 'upload copyright'),
    notes: nullableString(attributes.notes, 'upload notes'),
    tags: array(attributes.tags, 'upload tags')
      .map((value, index) => nonEmptyString(value, `upload tags[${index}]`))
      .sort(),
    defaultFieldMetadata: canonicalizeValue(attributes.default_field_metadata),
  };
}

export async function captureRawSchemaDefaults(
  client: CmaClient.Client,
  fieldIds: Readonly<Record<ScalarApiKey, string>>,
): Promise<Readonly<Record<ScalarApiKey, RawSchemaDefault>>> {
  const entries = await Promise.all(
    SCALAR_DEFAULT_SPECS.map(async ({ apiKey }) => {
      const response = await client.fields.rawFind(fieldIds[apiKey]);
      const resource = object(response.data, `${apiKey} field resource`);
      const attributes = object(
        resource.attributes,
        `${apiKey} field attributes`,
      );
      const rawDefault = attributes.default_value;
      return [
        apiKey,
        {
          id: nonEmptyString(resource.id, `${apiKey} field ID`),
          fieldType: nonEmptyString(
            attributes.field_type,
            `${apiKey} field type`,
          ),
          localized: boolean(attributes.localized, `${apiKey} localized`),
          defaultValue: canonicalizeValue(rawDefault),
          rawJsonUtf8Hex: Buffer.from(
            JSON.stringify(rawDefault),
            'utf8',
          ).toString('hex'),
        } satisfies RawSchemaDefault,
      ] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<ScalarApiKey, RawSchemaDefault>;
}

export function assertSchemaDefaults(
  defaults: Readonly<Record<ScalarApiKey, RawSchemaDefault>>,
): void {
  for (const spec of SCALAR_DEFAULT_SPECS) {
    const actual = defaults[spec.apiKey];
    const storedDefaultValue = expectedStoredScalarDefault(spec);
    assert.equal(actual.fieldType, spec.fieldType);
    assert.equal(actual.localized, false);
    assert.deepEqual(
      actual.defaultValue,
      canonicalizeValue(storedDefaultValue),
    );
    assert.equal(
      actual.rawJsonUtf8Hex,
      Buffer.from(JSON.stringify(storedDefaultValue), 'utf8').toString('hex'),
      `${spec.apiKey} default JSON bytes differ`,
    );
  }
}

export function expectedStoredScalarDefault(spec: ScalarDefaultSpec): unknown {
  return spec.storedDefaultValue ?? spec.defaultValue;
}

function assertHistoricalScalarValues(state: RawMediaState, seed: Seed): void {
  for (const record of [...state.current, ...state.published]) {
    if (
      record.id !== seed.mainRecordId &&
      record.id !== seed.omittedLocaleRecordId
    ) {
      continue;
    }
    for (const spec of SCALAR_DEFAULT_SPECS) {
      assert.deepEqual(
        record.fields[spec.apiKey],
        spec.historicalStored,
        `${record.id}.${spec.apiKey} was replaced by its later default`,
      );
    }
  }
}

function assertOmittedLocaleKeys(state: RawMediaState, recordId: string): void {
  for (const slice of [state.current, state.published]) {
    const record = slice.find(({ id }) => id === recordId);
    assert.ok(record, `omitted-locale record ${recordId} is missing`);
    for (const apiKey of MEDIA_FIELD_API_KEYS) {
      assert.deepEqual(
        Object.keys(object(record.fields[apiKey], `${recordId}.${apiKey}`)),
        ['en'],
        `${recordId}.${apiKey} gained an omitted it locale key`,
      );
    }
  }
}

function assertLocalizedMediaSemantics(
  state: RawMediaState,
  seed: Seed,
  uploadId: string,
): void {
  const current = state.current.find(({ id }) => id === seed.mainRecordId);
  const published = state.published.find(({ id }) => id === seed.mainRecordId);
  assert.ok(current && published, 'main localized media record is missing');
  assert.equal(current.status, 'updated');
  assert.equal(current.currentValid, true);
  assert.equal(current.publishedValid, true);

  const currentHero = object(current.fields.hero, 'current.hero');
  assert.equal(currentHero.en, null);
  assert.equal(fileUploadId(currentHero.it, 'current.hero.it'), uploadId);
  assert.equal(
    object(currentHero.it, 'current.hero.it').alt,
    null,
    'null localized alt changed',
  );
  assert.equal(object(currentHero.it, 'current.hero.it').title, '');
  const publishedHero = object(published.fields.hero, 'published.hero');
  assert.equal(fileUploadId(publishedHero.en, 'published.hero.en'), uploadId);
  assert.equal(object(publishedHero.en, 'published.hero.en').alt, '');
  assert.equal(object(publishedHero.en, 'published.hero.en').title, null);
  assert.equal(publishedHero.it, null);

  const currentGallery = object(current.fields.gallery, 'current.gallery');
  assert.deepEqual(array(currentGallery.en, 'current.gallery.en'), []);
  assert.equal(
    fileUploadId(
      array(currentGallery.it, 'current.gallery.it')[0],
      'current.gallery.it[0]',
    ),
    uploadId,
  );
  const publishedGallery = object(
    published.fields.gallery,
    'published.gallery',
  );
  assert.equal(
    fileUploadId(
      array(publishedGallery.en, 'published.gallery.en')[0],
      'published.gallery.en[0]',
    ),
    uploadId,
  );
  assert.deepEqual(array(publishedGallery.it, 'published.gallery.it'), []);

  const currentSeo = object(current.fields.seo, 'current.seo');
  assert.equal(currentSeo.en, null);
  assert.equal(object(currentSeo.it, 'current.seo.it').image, uploadId);
  const publishedSeo = object(published.fields.seo, 'published.seo');
  assert.equal(object(publishedSeo.en, 'published.seo.en').image, uploadId);
  assert.equal(publishedSeo.it, null);

  const currentVideo = object(
    current.fields.external_video,
    'current.external_video',
  );
  assert.equal(currentVideo.en, null);
  assert.equal(
    object(currentVideo.it, 'current.external_video.it').provider,
    'vimeo',
  );
  const publishedVideo = object(
    published.fields.external_video,
    'published.external_video',
  );
  assert.equal(
    object(publishedVideo.en, 'published.external_video.en').provider,
    'youtube',
  );
  assert.equal(publishedVideo.it, null);

  assert.equal(
    nestedBlockUploadId(
      object(current.fields.feature, 'current.feature').it,
      'current.feature.it',
    ),
    uploadId,
  );
  const currentFeature = object(current.fields.feature, 'current.feature');
  const publishedFeature = object(
    published.fields.feature,
    'published.feature',
  );
  assert.equal(currentFeature.en, null);
  assert.equal(
    nonEmptyString(
      object(currentFeature.it, 'current.feature.it').id,
      'current.feature.it.id',
    ),
    nonEmptyString(
      object(publishedFeature.it, 'published.feature.it').id,
      'published.feature.it.id',
    ),
    'current phase introduced a fresh nested block ID',
  );
  assert.equal(
    nestedBlockUploadId(publishedFeature.en, 'published.feature.en'),
    uploadId,
  );
  assert.equal(
    nestedBlockUploadId(publishedFeature.it, 'published.feature.it'),
    uploadId,
  );
}

function assertUploadFixture(upload: RawUploadState, uploadId: string): void {
  assert.equal(upload.id, uploadId);
  assert.equal(upload.size, ASSET_FIXTURE_PNG.byteLength);
  assert.equal(upload.md5, md5(ASSET_FIXTURE_PNG));
  assert.equal(upload.mimeType, 'image/png');
  assert.equal(upload.filename, 'localized-media-source.png');
  assert.equal(upload.author, 'Localized media author');
  assert.equal(upload.copyright, 'Localized media copyright');
  assert.equal(upload.notes, 'Exact en/it metadata and bundled PNG bytes');
  assert.deepEqual(upload.tags, [
    'localized',
    'nested-media',
    'schema-breadth',
  ]);
  const metadata = object(
    upload.defaultFieldMetadata,
    'default field metadata',
  );
  assert.deepEqual(metadata.alt, {
    en: 'English upload default alt',
    it: '',
  });
  assert.deepEqual(metadata.title, {
    en: null,
    it: 'Titolo predefinito upload',
  });
  assert.deepEqual(metadata.custom_data, {
    en: { exact: true, locale: 'en' },
    it: {},
  });
  assert.deepEqual(metadata.focal_point, { x: 0.13, y: 0.87 });
  assert.equal(metadata.poster_time, null);
}

function nestedBlockUploadId(value: unknown, path: string): string {
  const block = object(value, path);
  const attributes = object(block.attributes, `${path}.attributes`);
  return fileUploadId(attributes.media, `${path}.attributes.media`);
}

function fileUploadId(value: unknown, path: string): string {
  return nonEmptyString(object(value, path).upload_id, `${path}.upload_id`);
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (!isObject(value)) return value;
  if (
    value.type === 'item' &&
    typeof value.id === 'string' &&
    isObject(value.attributes) &&
    isObject(value.relationships)
  ) {
    const itemType = object(
      value.relationships.item_type,
      `${value.id}.item_type`,
    );
    return {
      id: value.id,
      itemTypeId: nonEmptyString(
        object(itemType.data, `${value.id}.item_type.data`).id,
        `${value.id}.itemTypeId`,
      ),
      attributes: canonicalizeValue(value.attributes),
    };
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeValue(child)]),
  );
}

function object(value: unknown, path = 'value'): Record<string, unknown> {
  assert.ok(isObject(value), `${path} must be an object`);
  return value;
}

function array(value: unknown, path = 'value'): unknown[] {
  assert.ok(Array.isArray(value), `${path} must be an array`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, path: string): string {
  assert.ok(
    typeof value === 'string' && value.length > 0,
    `${path} must be a non-empty string`,
  );
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  assert.ok(
    value === null || typeof value === 'string',
    `${path} must be string/null`,
  );
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be boolean`);
  return value;
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  assert.ok(
    value === null || typeof value === 'boolean',
    `${path} must be boolean/null`,
  );
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  assert.ok(
    typeof value === 'number' && Number.isFinite(value),
    `${path} must be finite`,
  );
  return value;
}
