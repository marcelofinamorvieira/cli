import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import {
  ASSET_FIXTURE_PNG,
  waitForUploadAntivirusClean,
} from './assets-deletions-scenario';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type Validators = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

type RawRecordSlice = Readonly<{
  id: string;
  itemTypeId: string;
  attributes: Readonly<Record<string, JsonValue>>;
  validity: Readonly<{
    slice: boolean;
    current: boolean | null;
    published: boolean | null;
  }>;
}>;

type RawRecordState = Readonly<{
  current: RawRecordSlice | null;
  published: RawRecordSlice | null;
}>;

type RawUploadState = Readonly<{
  id: string;
  filename: string;
  format: string;
  size: number;
  md5: string;
  width: number;
  height: number;
  defaultFieldMetadata: JsonValue;
}>;

type ValidatorState = readonly Readonly<{
  fieldId: string;
  itemTypeId: string;
  apiKey: string;
  validators: JsonValue;
  serializedValidators: string;
}>[];

type RelaxationExpectation = Readonly<{
  fieldId: string;
  removedValidatorKeys: readonly string[];
}>;

type ScalarDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    date_value: { type: 'date'; localized: false };
    datetime_value: { type: 'date_time'; localized: false };
    formatted_value: { type: 'string'; localized: false };
    html_value: { type: 'text'; localized: false };
    slug_value: { type: 'slug'; localized: false };
  };
};

type AssetDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    hero: { type: 'file'; localized: false };
    gallery: { type: 'gallery'; localized: false };
    seo: { type: 'seo'; localized: false };
  };
};

type ScalarSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    dateFieldId: string;
    dateTimeFieldId: string;
    formatFieldId: string;
    htmlFieldId: string;
    slugFieldId: string;
  }>;

type AssetSeed = RealCmaScenarioSeed &
  Readonly<{
    locale: string;
    modelId: string;
    heroFieldId: string;
    galleryFieldId: string;
    seoFieldId: string;
  }>;

type ScalarExpected = Readonly<{
  recordId: string;
  source: RawRecordState;
  destination: RawRecordState;
  validators: ValidatorState;
  relaxations: readonly RelaxationExpectation[];
}>;

type AssetExpected = Readonly<{
  recordId: string;
  uploadId: string;
  source: RawRecordState;
  destination: RawRecordState;
  upload: RawUploadState;
  validators: ValidatorState;
  relaxations: readonly RelaxationExpectation[];
}>;

const SCALAR_FIELD_KEYS = [
  'date_value',
  'datetime_value',
  'formatted_value',
  'html_value',
  'slug_value',
] as const;

const ASSET_FIELD_KEYS = ['hero', 'gallery', 'seo'] as const;

const API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;
const API_KEY_MAX_LENGTH = 30;
const VALIDITY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

export const SCALAR_VALIDATOR_GAUNTLET_KEYS = {
  date: ['date_range'],
  dateTime: ['date_time_range'],
  format: ['format'],
  html: ['sanitized_html'],
  slug: ['slug_format'],
} as const;

export const ASSET_SEO_VALIDATOR_GAUNTLET_KEYS = {
  hero: [
    'extension',
    'file_size',
    'image_aspect_ratio',
    'image_dimensions',
    'required_alt_title',
  ],
  gallery: ['size'],
  seo: ['description_length', 'required_seo_fields', 'title_length'],
} as const;

export const scalarValidatorGauntletScenario: RealCmaScenario<
  ScalarSeed,
  ScalarExpected
> = {
  name: 'scalar date slug and HTML validator gauntlet',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating scalar validator gauntlet schema');
    const modelApiKey = buildValidatorGauntletModelApiKey('vgs', runId);
    const model = await createModel(client, modelApiKey, runId);
    const dateField = await client.fields.create(model.id, {
      label: 'Date value',
      api_key: 'date_value',
      field_type: 'date',
      localized: false,
      validators: {},
    });
    const dateTimeField = await client.fields.create(model.id, {
      label: 'Date-time value',
      api_key: 'datetime_value',
      field_type: 'date_time',
      localized: false,
      validators: {},
    });
    const formatField = await client.fields.create(model.id, {
      label: 'Formatted value',
      api_key: 'formatted_value',
      field_type: 'string',
      localized: false,
      validators: {},
    });
    const htmlField = await client.fields.create(model.id, {
      label: 'HTML value',
      api_key: 'html_value',
      field_type: 'text',
      localized: false,
      validators: {},
    });
    const slugField = await client.fields.create(model.id, {
      label: 'Slug value',
      api_key: 'slug_value',
      field_type: 'slug',
      localized: false,
      validators: {
        slug_title_field: { title_field_id: formatField.id },
      },
    });

    return {
      itemTypeApiKeys: [modelApiKey],
      modelId: model.id,
      dateFieldId: dateField.id,
      dateTimeFieldId: dateTimeField.id,
      formatFieldId: formatField.id,
      htmlFieldId: htmlField.id,
      slugFieldId: slugField.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating independently invalid scalar current and published slices',
    );
    const record = await sourceClient.items.create<ScalarDefinition>({
      item_type: { id: seed.modelId, type: 'item_type' },
      date_value: '2020-01-01',
      datetime_value: '2020-01-01T01:02:03Z',
      formatted_value: 'published-not-an-email',
      html_value:
        '<script>alert("published")</script><p>Published unsafe HTML</p>',
      slug_value: 'Published Invalid Slug!',
    });
    await sourceClient.items.publish<ScalarDefinition>(record.id);
    await sourceClient.items.update<ScalarDefinition>(record.id, {
      date_value: '2021-02-03',
      datetime_value: '2021-02-03T04:05:06Z',
      formatted_value: 'current-not-an-email',
      html_value: '<script>alert("current")</script><p>Current unsafe HTML</p>',
      slug_value: 'Current Invalid Slug!',
    });

    const contracts: readonly (readonly [string, Validators])[] = [
      [seed.dateFieldId, { date_range: { min: '2099-01-01' } }],
      [
        seed.dateTimeFieldId,
        { date_time_range: { min: '2099-01-01T00:00:00Z' } },
      ],
      [seed.formatFieldId, { format: { predefined_pattern: 'email' } }],
      [
        seed.htmlFieldId,
        { sanitized_html: { sanitize_before_validation: false } },
      ],
      [
        seed.slugFieldId,
        {
          slug_title_field: { title_field_id: seed.formatFieldId },
          slug_format: { predefined_pattern: 'webpage_slug' },
        },
      ],
    ];
    await updateValidatorsInBothEnvironments(
      sourceClient,
      destinationClient,
      contracts,
    );
    await waitForValidity(sourceClient, record.id, false, false);

    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureRawRecordState(
          sourceClient,
          record.id,
          seed.modelId,
          SCALAR_FIELD_KEYS,
        ),
        captureRawRecordState(
          destinationClient,
          record.id,
          seed.modelId,
          SCALAR_FIELD_KEYS,
        ),
        captureValidatorState(sourceClient, seed.modelId),
        captureValidatorState(destinationClient, seed.modelId),
      ]);
    assertInvalidCurrentAndPublished(source, 'scalar gauntlet source');
    assert.deepEqual(destination, { current: null, published: null });
    assertExactValidatorState(
      destinationValidators,
      sourceValidators,
      'scalar destination schema differs from source',
    );

    return {
      recordId: record.id,
      source,
      destination,
      validators: sourceValidators,
      relaxations: [
        {
          fieldId: seed.dateFieldId,
          removedValidatorKeys: SCALAR_VALIDATOR_GAUNTLET_KEYS.date,
        },
        {
          fieldId: seed.dateTimeFieldId,
          removedValidatorKeys: SCALAR_VALIDATOR_GAUNTLET_KEYS.dateTime,
        },
        {
          fieldId: seed.formatFieldId,
          removedValidatorKeys: SCALAR_VALIDATOR_GAUNTLET_KEYS.format,
        },
        {
          fieldId: seed.htmlFieldId,
          removedValidatorKeys: SCALAR_VALIDATOR_GAUNTLET_KEYS.html,
        },
        {
          fieldId: seed.slugFieldId,
          removedValidatorKeys: SCALAR_VALIDATOR_GAUNTLET_KEYS.slug,
        },
      ],
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const plan = await assertValidatorGauntletPlan({
      planFilePath,
      modelId: seed.modelId,
      recordId: expected.recordId,
      expectedValidators: expected.validators,
      expectedRelaxations: expected.relaxations,
    });
    const slugRelaxation = requiredArray(
      requiredObject(plan.invalidContent, 'invalid content')
        .validatorRelaxations,
      'validator relaxations',
    )
      .map((entry) => requiredObject(entry, 'validator relaxation'))
      .find(({ fieldId }) => fieldId === seed.slugFieldId);
    assert.ok(slugRelaxation, 'slug format relaxation is absent');
    for (const key of ['originalValidators', 'relaxedValidators']) {
      assert.deepEqual(
        requiredObject(slugRelaxation[key], `slug ${key}`).slug_title_field,
        { title_field_id: seed.formatFieldId },
        `slug ${key} did not retain its exact title field reference`,
      );
    }
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying scalar invalid slices and exact validator restoration',
    );
    await waitForValidity(appliedClient, expected.recordId, false, false);
    const [source, destination, applied] = await Promise.all([
      captureRawRecordState(
        sourceClient,
        expected.recordId,
        seed.modelId,
        SCALAR_FIELD_KEYS,
      ),
      captureRawRecordState(
        destinationClient,
        expected.recordId,
        seed.modelId,
        SCALAR_FIELD_KEYS,
      ),
      captureRawRecordState(
        appliedClient,
        expected.recordId,
        seed.modelId,
        SCALAR_FIELD_KEYS,
      ),
    ]);
    assert.deepEqual(source, expected.source, 'scalar source content changed');
    assert.deepEqual(
      destination,
      expected.destination,
      'scalar destination content changed',
    );
    assert.deepEqual(
      applied,
      expected.source,
      'scalar raw current/published content or validity was not reproduced',
    );

    await assertRestoredValidatorState(
      [sourceClient, destinationClient, appliedClient],
      seed.modelId,
      expected.validators,
      'scalar gauntlet',
    );
  },
};

export const assetSeoValidatorGauntletScenario: RealCmaScenario<
  AssetSeed,
  AssetExpected
> = {
  name: 'asset and SEO validator gauntlet',
  contentDiffArgs: [
    '--migrate-invalid-content',
    '--uploads=referenced',
    '--bundle-assets',
  ],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating asset validator gauntlet schema');
    const site = await client.site.find();
    const locale = site.locales[0];
    assert.ok(locale, 'the disposable project must expose at least one locale');
    const modelApiKey = buildValidatorGauntletModelApiKey('vga', runId);
    const model = await createModel(client, modelApiKey, runId);
    const heroField = await client.fields.create(model.id, {
      label: 'Hero',
      api_key: 'hero',
      field_type: 'file',
      localized: false,
      validators: {},
    });
    const galleryField = await client.fields.create(model.id, {
      label: 'Gallery',
      api_key: 'gallery',
      field_type: 'gallery',
      localized: false,
      validators: {},
    });
    const seoField = await client.fields.create(model.id, {
      label: 'SEO',
      api_key: 'seo',
      field_type: 'seo',
      localized: false,
      validators: {},
    });

    return {
      itemTypeApiKeys: [modelApiKey],
      locale,
      modelId: model.id,
      heroFieldId: heroField.id,
      galleryFieldId: galleryField.id,
      seoFieldId: seoField.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating invalid asset and SEO current/published slices',
    );
    const directory = await mkdtemp(join(tmpdir(), 'content-diff-validator-'));
    const pngPath = join(directory, 'validator-gauntlet.png');
    let uploadId: string;
    try {
      await writeFile(pngPath, ASSET_FIXTURE_PNG);
      const upload = await sourceClient.uploads.createFromLocalFile({
        localPath: pngPath,
        filename: 'validator-gauntlet.png',
        skipCreationIfAlreadyExists: false,
        author: 'Validator gauntlet',
        copyright: 'Validator gauntlet fixture',
        notes: 'Deterministic 1x1 PNG for content-diff validators',
        tags: ['content-diff', 'validator-gauntlet'],
        default_field_metadata: {
          alt: { [seed.locale]: null },
          title: { [seed.locale]: null },
          custom_data: { [seed.locale]: {} },
          focal_point: null,
          poster_time: null,
        },
      });
      uploadId = upload.id;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await waitForUploadAntivirusClean(
      { rawFindUpload: (id) => sourceClient.uploads.rawFind(id) },
      uploadId,
    );
    await waitForImageAnalysis(sourceClient, uploadId, 1, 1);

    const record = await sourceClient.items.create<AssetDefinition>({
      item_type: { id: seed.modelId, type: 'item_type' },
      hero: fileFieldValue(uploadId, 'published'),
      gallery: [fileFieldValue(uploadId, 'published-gallery')],
      seo: seoValue(uploadId, 'x', 'tiny'),
    });
    await sourceClient.items.publish<AssetDefinition>(record.id);
    await sourceClient.items.update<AssetDefinition>(record.id, {
      hero: fileFieldValue(uploadId, 'current'),
      gallery: [fileFieldValue(uploadId, 'current-gallery')],
      seo: seoValue(uploadId, 'xx', 'small'),
    });

    const contracts: readonly (readonly [string, Validators])[] = [
      [
        seed.heroFieldId,
        {
          extension: { extensions: ['jpg'] },
          file_size: { min_value: 2, min_unit: 'KB' },
          image_aspect_ratio: {
            eq_ar_numerator: 1,
            eq_ar_denominator: 2,
          },
          image_dimensions: { width_min_value: 2, height_min_value: 2 },
          required_alt_title: { alt: true, title: true },
        },
      ],
      [seed.galleryFieldId, { size: { min: 2 } }],
      [
        seed.seoFieldId,
        {
          description_length: { min: 20 },
          required_seo_fields: { twitter_card: true },
          title_length: { min: 10 },
        },
      ],
    ];
    await updateValidatorsInBothEnvironments(
      sourceClient,
      destinationClient,
      contracts,
    );
    await waitForValidity(sourceClient, record.id, false, false);

    const [
      source,
      destination,
      upload,
      destinationUpload,
      sourceValidators,
      destinationValidators,
    ] = await Promise.all([
      captureRawRecordState(
        sourceClient,
        record.id,
        seed.modelId,
        ASSET_FIELD_KEYS,
      ),
      captureRawRecordState(
        destinationClient,
        record.id,
        seed.modelId,
        ASSET_FIELD_KEYS,
      ),
      captureRawUploadOrNull(sourceClient, uploadId),
      captureRawUploadOrNull(destinationClient, uploadId),
      captureValidatorState(sourceClient, seed.modelId),
      captureValidatorState(destinationClient, seed.modelId),
    ]);
    assertInvalidCurrentAndPublished(source, 'asset gauntlet source');
    assert.deepEqual(destination, { current: null, published: null });
    assert.ok(upload, `source upload ${uploadId} is absent`);
    assert.equal(
      destinationUpload,
      null,
      'source-only validator upload unexpectedly exists in destination',
    );
    assertExactValidatorState(
      destinationValidators,
      sourceValidators,
      'asset destination schema differs from source',
    );

    return {
      recordId: record.id,
      uploadId,
      source,
      destination,
      upload,
      validators: sourceValidators,
      relaxations: [
        {
          fieldId: seed.heroFieldId,
          removedValidatorKeys: ASSET_SEO_VALIDATOR_GAUNTLET_KEYS.hero,
        },
        {
          fieldId: seed.galleryFieldId,
          removedValidatorKeys: ASSET_SEO_VALIDATOR_GAUNTLET_KEYS.gallery,
        },
        {
          fieldId: seed.seoFieldId,
          removedValidatorKeys: ASSET_SEO_VALIDATOR_GAUNTLET_KEYS.seo,
        },
      ],
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const plan = await assertValidatorGauntletPlan({
      planFilePath,
      modelId: seed.modelId,
      recordId: expected.recordId,
      expectedValidators: expected.validators,
      expectedRelaxations: expected.relaxations,
    });
    const uploadPlans = requiredArray(plan.uploads, 'plan uploads').map(
      (entry, index) => requiredObject(entry, `plan upload ${index}`),
    );
    const changedUploads = uploadPlans.filter(
      ({ action }) => action !== 'noop',
    );
    assert.deepEqual(
      changedUploads.map(({ id }) => String(id)).sort(),
      [expected.uploadId],
      'asset gauntlet plan did not contain exactly the bundled source upload',
    );
    assert.equal(changedUploads[0]?.action, 'create');
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying invalid asset/SEO slices, bundled upload, and validator restoration',
    );
    await Promise.all([
      waitForValidity(appliedClient, expected.recordId, false, false),
      waitForUploadAntivirusClean(
        { rawFindUpload: (id) => appliedClient.uploads.rawFind(id) },
        expected.uploadId,
      ),
      waitForImageAnalysis(appliedClient, expected.uploadId, 1, 1),
    ]);
    const [source, destination, applied, sourceUpload, appliedUpload] =
      await Promise.all([
        captureRawRecordState(
          sourceClient,
          expected.recordId,
          seed.modelId,
          ASSET_FIELD_KEYS,
        ),
        captureRawRecordState(
          destinationClient,
          expected.recordId,
          seed.modelId,
          ASSET_FIELD_KEYS,
        ),
        captureRawRecordState(
          appliedClient,
          expected.recordId,
          seed.modelId,
          ASSET_FIELD_KEYS,
        ),
        captureRawUploadOrNull(sourceClient, expected.uploadId),
        captureRawUploadOrNull(appliedClient, expected.uploadId),
      ]);
    assert.deepEqual(source, expected.source, 'asset source content changed');
    assert.deepEqual(
      destination,
      expected.destination,
      'asset destination content changed',
    );
    assert.deepEqual(
      applied,
      expected.source,
      'asset/SEO raw current/published content or validity was not reproduced',
    );
    assert.deepEqual(sourceUpload, expected.upload, 'source upload changed');
    assert.deepEqual(
      appliedUpload,
      expected.upload,
      'bundled validator upload was not reproduced byte-for-byte',
    );

    await assertRestoredValidatorState(
      [sourceClient, destinationClient, appliedClient],
      seed.modelId,
      expected.validators,
      'asset/SEO gauntlet',
    );
  },
};

async function createModel(
  client: CmaClient.Client,
  apiKey: string,
  runId: string,
) {
  return client.itemTypes.create({
    name: `Validator gauntlet ${runId}`,
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
}

export function buildValidatorGauntletModelApiKey(
  lane: 'vgs' | 'vga',
  runId: string,
): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const apiKey = `cde2e_${lane}_r${suffix}`;
  assert.match(apiKey, API_KEY_PATTERN);
  assert.ok(
    apiKey.length <= API_KEY_MAX_LENGTH,
    `validator gauntlet model API key exceeds ${API_KEY_MAX_LENGTH} characters`,
  );
  return apiKey;
}

async function updateValidatorsInBothEnvironments(
  sourceClient: CmaClient.Client,
  destinationClient: CmaClient.Client,
  updates: readonly (readonly [string, Validators])[],
): Promise<void> {
  for (const [fieldId, validators] of updates) {
    await sourceClient.fields.update(fieldId, { validators });
    await destinationClient.fields.update(fieldId, { validators });
  }
}

function fileFieldValue(uploadId: string, slice: string) {
  return {
    upload_id: uploadId,
    alt: null,
    title: null,
    custom_data: { slice, fixture: 'validator-gauntlet' },
    focal_point: null,
    poster_time: null,
  };
}

function seoValue(uploadId: string, title: string, description: string) {
  return {
    title,
    description,
    image: uploadId,
    twitter_card: null,
    no_index: false,
  };
}

async function waitForValidity(
  client: CmaClient.Client,
  recordId: string,
  current: boolean,
  published: boolean | null,
): Promise<void> {
  const deadline = Date.now() + VALIDITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const record = await client.items.find(recordId);
    if (
      record.meta.is_current_version_valid === current &&
      record.meta.is_published_version_valid === published
    ) {
      return;
    }
    await wait(POLL_INTERVAL_MS);
  }

  const record = await client.items.find(recordId);
  throw new Error(
    `record ${recordId} validity did not converge: ${JSON.stringify({
      expected: { current, published },
      actual: {
        current: record.meta.is_current_version_valid,
        published: record.meta.is_published_version_valid,
      },
    })}`,
  );
}

async function waitForImageAnalysis(
  client: CmaClient.Client,
  uploadId: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<void> {
  const deadline = Date.now() + VALIDITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await client.uploads.rawFind(uploadId);
    const attributes = requiredObject(
      requiredObject(response.data, `upload ${uploadId}`).attributes,
      `upload ${uploadId} attributes`,
    );
    if (
      attributes.width === expectedWidth &&
      attributes.height === expectedHeight
    ) {
      return;
    }
    await wait(POLL_INTERVAL_MS);
  }
  throw new Error(
    `upload ${uploadId} did not expose the expected ${expectedWidth}x${expectedHeight} image analysis`,
  );
}

async function captureRawRecordState(
  client: CmaClient.Client,
  recordId: string,
  expectedItemTypeId: string,
  fieldKeys: readonly string[],
): Promise<RawRecordState> {
  const [current, published] = await Promise.all([
    captureRawRecordSlice(
      client,
      recordId,
      expectedItemTypeId,
      fieldKeys,
      'current',
    ),
    captureRawRecordSlice(
      client,
      recordId,
      expectedItemTypeId,
      fieldKeys,
      'published',
    ),
  ]);
  return { current, published };
}

async function captureRawRecordSlice(
  client: CmaClient.Client,
  recordId: string,
  expectedItemTypeId: string,
  fieldKeys: readonly string[],
  version: 'current' | 'published',
): Promise<RawRecordSlice | null> {
  let response: unknown;
  try {
    response = await client.items.rawFind(recordId, { version });
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return null;
    }
    throw error;
  }
  const resource = requiredObject(
    requiredObject(response, `${version} item response`).data,
    `${version} item resource`,
  );
  const id = requiredString(resource.id, `${version} item ID`);
  assert.equal(id, recordId);
  const relationships = requiredObject(
    resource.relationships,
    `${id} relationships`,
  );
  const itemTypeId = requiredString(
    requiredObject(
      requiredObject(relationships.item_type, `${id}.item_type`).data,
      `${id}.item_type.data`,
    ).id,
    `${id}.item_type.data.id`,
  );
  assert.equal(itemTypeId, expectedItemTypeId);
  const attributes = requiredObject(resource.attributes, `${id}.attributes`);
  const selectedAttributes = Object.fromEntries(
    [...fieldKeys].sort().map((key) => {
      assert.ok(key in attributes, `${id}.${key} is absent from raw content`);
      return [key, canonicalJson(attributes[key])];
    }),
  );
  const meta = requiredObject(resource.meta, `${id}.meta`);

  return {
    id,
    itemTypeId,
    attributes: selectedAttributes,
    validity: {
      slice: requiredBoolean(meta.is_valid, `${id}.meta.is_valid`),
      current: nullableBoolean(
        meta.is_current_version_valid,
        `${id}.meta.is_current_version_valid`,
      ),
      published: nullableBoolean(
        meta.is_published_version_valid,
        `${id}.meta.is_published_version_valid`,
      ),
    },
  };
}

async function captureRawUploadOrNull(
  client: CmaClient.Client,
  uploadId: string,
): Promise<RawUploadState | null> {
  let response: unknown;
  try {
    response = await client.uploads.rawFind(uploadId);
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return null;
    }
    throw error;
  }
  const resource = requiredObject(
    requiredObject(response, `upload ${uploadId} response`).data,
    `upload ${uploadId}`,
  );
  const attributes = requiredObject(
    resource.attributes,
    `upload ${uploadId} attributes`,
  );
  return {
    id: requiredString(resource.id, `upload ${uploadId} ID`),
    filename: requiredString(
      attributes.filename,
      `upload ${uploadId} filename`,
    ),
    format: requiredString(attributes.format, `upload ${uploadId} format`),
    size: requiredNumber(attributes.size, `upload ${uploadId} size`),
    md5: requiredString(attributes.md5, `upload ${uploadId} md5`),
    width: requiredNumber(attributes.width, `upload ${uploadId} width`),
    height: requiredNumber(attributes.height, `upload ${uploadId} height`),
    defaultFieldMetadata: canonicalJson(attributes.default_field_metadata),
  };
}

async function captureValidatorState(
  client: CmaClient.Client,
  itemTypeId: string,
): Promise<ValidatorState> {
  const response = await client.fields.rawList(itemTypeId);
  return requiredArray(response.data, `fields for ${itemTypeId}`)
    .map((value, index) => {
      const resource = requiredObject(value, `field ${index}`);
      const attributes = requiredObject(
        resource.attributes,
        `field ${index} attributes`,
      );
      const validators = attributes.validators;
      assert.ok(
        validators !== undefined,
        `field ${String(resource.id)} validators are absent`,
      );
      return {
        fieldId: requiredString(resource.id, `field ${index} ID`),
        itemTypeId,
        apiKey: requiredString(attributes.api_key, `field ${index} API key`),
        validators: canonicalJson(validators),
        serializedValidators: JSON.stringify(validators),
      };
    })
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

async function assertValidatorGauntletPlan({
  planFilePath,
  modelId,
  recordId,
  expectedValidators,
  expectedRelaxations,
}: Readonly<{
  planFilePath: string;
  modelId: string;
  recordId: string;
  expectedValidators: ValidatorState;
  expectedRelaxations: readonly RelaxationExpectation[];
}>): Promise<Record<string, unknown>> {
  const envelope = requiredObject(
    JSON.parse(await readFile(planFilePath, 'utf8')),
    'plan envelope',
  );
  const plan = requiredObject(envelope.plan, 'plan');
  const invalidContent = requiredObject(
    plan.invalidContent,
    'plan.invalidContent',
  );
  const relaxations = requiredArray(
    invalidContent.validatorRelaxations,
    'validator relaxations',
  ).map((entry, index) =>
    requiredObject(entry, `validator relaxation ${index}`),
  );
  const byFieldId = new Map(
    relaxations.map((entry) => [
      requiredString(entry.fieldId, 'validator relaxation field ID'),
      entry,
    ]),
  );
  assert.deepEqual(
    [...byFieldId.keys()].sort(),
    expectedRelaxations.map(({ fieldId }) => fieldId).sort(),
    'plan did not contain exactly the expected validator-relaxation fields',
  );
  const validatorsByFieldId = new Map(
    expectedValidators.map((field) => [field.fieldId, field]),
  );

  for (const expectation of expectedRelaxations) {
    const entry = byFieldId.get(expectation.fieldId);
    assert.ok(entry, `missing relaxation for field ${expectation.fieldId}`);
    assert.equal(entry.itemTypeId, modelId);
    const field = validatorsByFieldId.get(expectation.fieldId);
    assert.ok(field, `missing captured validator field ${expectation.fieldId}`);
    assert.deepEqual(
      canonicalJson(entry.originalValidators),
      field.validators,
      `plan changed the original validators for field ${expectation.fieldId}`,
    );
    assert.deepEqual(
      entry.relaxedValidators,
      Object.fromEntries(
        Object.entries(
          requiredObject(field.validators, 'captured validators'),
        ).filter(([key]) => !expectation.removedValidatorKeys.includes(key)),
      ),
      `field ${expectation.fieldId} did not preserve its unrelaxed validators`,
    );
    assert.deepEqual(
      entry.relaxedValidatorKeys,
      [...expectation.removedValidatorKeys].sort(),
      `field ${expectation.fieldId} removed the wrong validator keys`,
    );
    assert.deepEqual(entry.affectedRecordIds, [recordId]);

    const reasons = requiredArray(
      entry.reasons,
      `${expectation.fieldId} relaxation reasons`,
    ).map((reason, index) =>
      requiredObject(reason, `${expectation.fieldId} reason ${index}`),
    );
    assert.deepEqual(
      reasons
        .map(({ validatorKey, slice, fieldId }) => {
          assert.equal(fieldId, expectation.fieldId);
          return `${String(validatorKey)}:${String(slice)}`;
        })
        .sort(),
      expectation.removedValidatorKeys
        .flatMap((validatorKey) => [
          `${validatorKey}:current`,
          `${validatorKey}:published`,
        ])
        .sort(),
      `field ${expectation.fieldId} did not preserve exact current/published diagnostic provenance`,
    );
  }

  assert.deepEqual(invalidContent.skippedRecords, []);
  assert.deepEqual(invalidContent.detectedRecordIds, [recordId]);
  assert.deepEqual(invalidContent.migratedRecordIds, [recordId]);
  assert.equal(invalidContent.propagatedSkipCount, 0);
  assert.equal(
    requiredObject(plan.requiredPermissions, 'required permissions').editSchema,
    true,
  );
  assert.equal(
    requiredObject(plan.options, 'plan options').migrateInvalidContent,
    true,
  );

  const changedRecords = requiredArray(plan.records, 'plan records')
    .map((entry, index) => requiredObject(entry, `plan record ${index}`))
    .filter(({ action }) => action !== 'noop');
  assert.deepEqual(
    changedRecords.map(({ id }) => String(id)).sort(),
    [recordId],
    'validator gauntlet plan did not contain exactly the source-only record',
  );
  assert.equal(changedRecords[0]?.action, 'create');

  const summary = requiredObject(
    requiredObject(plan.summary, 'plan summary').invalidContent,
    'plan summary invalidContent',
  );
  assert.deepEqual(summary, {
    status: 'complete',
    detectedRecords: 1,
    migratedRecords: 1,
    skippedRecords: 0,
    propagatedSkipCount: 0,
    validatorRelaxations: expectedRelaxations.length,
    relaxedFieldCount: expectedRelaxations.length,
    relaxedValidatorCount: expectedRelaxations.reduce(
      (total, { removedValidatorKeys }) => total + removedValidatorKeys.length,
      0,
    ),
    requiresTemporaryValidatorRelaxation: true,
  });
  return plan;
}

async function assertRestoredValidatorState(
  clients: readonly CmaClient.Client[],
  itemTypeId: string,
  expected: ValidatorState,
  lane: string,
): Promise<void> {
  const states = await Promise.all(
    clients.map((client) => captureValidatorState(client, itemTypeId)),
  );
  for (const [index, state] of states.entries()) {
    assertExactValidatorState(
      state,
      expected,
      `${lane} validator state ${index} was not restored exactly`,
    );
  }
}

export function assertExactValidatorState(
  actual: ValidatorState,
  expected: ValidatorState,
  message: string,
): void {
  // CMA object-key order is not a validator setting. Compare the captured JSON
  // structurally, preserving every key, value, and array position independently
  // of the production canonicalizer.
  assert.deepEqual(
    actual.map(({ serializedValidators, ...field }) => ({
      ...field,
      serializedValidators: JSON.parse(serializedValidators),
    })),
    expected.map(({ serializedValidators, ...field }) => ({
      ...field,
      serializedValidators: JSON.parse(serializedValidators),
    })),
    message,
  );
}

function assertInvalidCurrentAndPublished(
  state: RawRecordState,
  label: string,
): void {
  assert.ok(state.current, `${label} has no current slice`);
  assert.ok(state.published, `${label} has no published slice`);
  assert.deepEqual(state.current.validity, {
    slice: false,
    current: false,
    published: false,
  });
  assert.deepEqual(state.published.validity, {
    slice: false,
    current: false,
    published: false,
  });
  assert.notDeepEqual(
    state.current.attributes,
    state.published.attributes,
    `${label} current and published payloads must be independently observable`,
  );
}

function canonicalJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  const object = requiredObject(value, 'JSON value');
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

function requiredObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  return requiredBoolean(value, path);
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}
