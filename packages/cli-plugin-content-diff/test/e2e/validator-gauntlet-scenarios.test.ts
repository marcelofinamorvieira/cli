import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { SAFELY_RELAXABLE_VALIDATOR_KEYS } from '../../src/content-diff/plan';
import {
  ASSET_SEO_VALIDATOR_GAUNTLET_KEYS,
  SCALAR_VALIDATOR_GAUNTLET_KEYS,
  assertExactValidatorState,
  assetSeoValidatorGauntletScenario,
  buildValidatorGauntletModelApiKey,
  scalarValidatorGauntletScenario,
} from './validator-gauntlet-scenarios';

const PREVIOUSLY_PROVED_LIVE_VALIDATORS = [
  'enum',
  'length',
  'number_range',
  'required',
  'unique',
] as const;

describe('validator gauntlet real-CMA fixture contract', () => {
  it('covers every previously unproved content-invalidating validator exactly once', () => {
    const gauntletKeys = [
      ...Object.values(SCALAR_VALIDATOR_GAUNTLET_KEYS).flat(),
      ...Object.values(ASSET_SEO_VALIDATOR_GAUNTLET_KEYS).flat(),
    ];

    assert.equal(new Set(gauntletKeys).size, gauntletKeys.length);
    assert.deepEqual(
      [...PREVIOUSLY_PROVED_LIVE_VALIDATORS, ...gauntletKeys].sort(),
      SAFELY_RELAXABLE_VALIDATOR_KEYS.filter(
        (validatorKey) => validatorKey !== 'slug_title_field',
      ).sort(),
    );
    assert.equal(gauntletKeys.includes('slug_title_field' as never), false);
  });

  it('keeps invalid migration opt-in and asset bundling explicit', () => {
    assert.deepEqual(scalarValidatorGauntletScenario.contentDiffArgs, [
      '--migrate-invalid-content',
    ]);
    assert.deepEqual(assetSeoValidatorGauntletScenario.contentDiffArgs, [
      '--migrate-invalid-content',
      '--uploads=referenced',
      '--bundle-assets',
    ]);
  });

  it('preserves the slug title field while narrowing slug format in both environments', async () => {
    const created = new Map<string, unknown>();
    const sourceUpdates = new Map<string, unknown>();
    const destinationUpdates = new Map<string, unknown>();
    const stopAfterUpdates = new Error('validator updates observed');
    const sourceClient = {
      itemTypes: { create: async () => ({ id: 'model' }) },
      fields: {
        create: async (
          _model: string,
          field: { api_key: string; validators: unknown },
        ) => {
          created.set(field.api_key, field.validators);
          return { id: `${field.api_key}-id` };
        },
        update: async (id: string, field: { validators: unknown }) => {
          sourceUpdates.set(id, field.validators);
        },
      },
      items: {
        create: async () => ({ id: 'record' }),
        publish: async () => undefined,
        update: async () => undefined,
        find: async () => {
          throw stopAfterUpdates;
        },
      },
    } as unknown as CmaClient.Client;
    const destinationClient = {
      fields: {
        update: async (id: string, field: { validators: unknown }) => {
          destinationUpdates.set(id, field.validators);
        },
      },
    } as unknown as CmaClient.Client;
    const seed = await scalarValidatorGauntletScenario.seedSource({
      client: sourceClient,
      runId: 'slug-title-preservation',
    });
    const titleValidator = { title_field_id: seed.formatFieldId };

    assert.deepEqual(created.get('slug_value'), {
      slug_title_field: titleValidator,
    });
    await assert.rejects(
      scalarValidatorGauntletScenario.introduceDrift({
        seed,
        sourceClient,
        destinationClient,
      }),
      (error) => error === stopAfterUpdates,
    );
    for (const updates of [sourceUpdates, destinationUpdates]) {
      assert.deepEqual(updates.get(seed.slugFieldId), {
        slug_title_field: titleValidator,
        slug_format: { predefined_pattern: 'webpage_slug' },
      });
    }
    assert.deepEqual(SCALAR_VALIDATOR_GAUNTLET_KEYS.slug, ['slug_format']);
  });

  it('requires the plan to retain the exact slug title reference in original and relaxed validators', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'slug-title-plan-'));
    try {
      const { seed, expected } = slugTitleFixture();
      const planFilePath = join(directory, 'plan.json');
      const originalValidators = expected.validators[0].validators;
      const relaxation = {
        fieldId: seed.slugFieldId,
        itemTypeId: seed.modelId,
        originalValidators,
        relaxedValidators: {
          slug_title_field: { title_field_id: seed.formatFieldId },
        },
        relaxedValidatorKeys: ['slug_format'],
        affectedRecordIds: [expected.recordId],
        reasons: ['current', 'published'].map((slice) => ({
          fieldId: seed.slugFieldId,
          validatorKey: 'slug_format',
          slice,
        })),
      };
      const envelope = {
        plan: {
          invalidContent: {
            validatorRelaxations: [relaxation],
            skippedRecords: [],
            detectedRecordIds: [expected.recordId],
            migratedRecordIds: [expected.recordId],
            propagatedSkipCount: 0,
          },
          requiredPermissions: { editSchema: true },
          options: { migrateInvalidContent: true },
          records: [{ id: expected.recordId, action: 'create' }],
          summary: {
            invalidContent: {
              status: 'complete',
              detectedRecords: 1,
              migratedRecords: 1,
              skippedRecords: 0,
              propagatedSkipCount: 0,
              validatorRelaxations: 1,
              relaxedFieldCount: 1,
              relaxedValidatorCount: 1,
              requiresTemporaryValidatorRelaxation: true,
            },
          },
        },
      };
      const verify = scalarValidatorGauntletScenario.verifyGeneratedPlan!;
      const context = {
        seed,
        expected,
        sourceClient: {} as CmaClient.Client,
        destinationClient: {} as CmaClient.Client,
        migrationFilename: 'migration.js',
        migrationFilePath: join(directory, 'migration.js'),
        planFilePath,
      };
      await writeFile(planFilePath, JSON.stringify(envelope));
      await verify(context);

      for (const side of ['originalValidators', 'relaxedValidators'] as const) {
        for (const replacement of [
          undefined,
          { title_field_id: 'wrong-field' },
        ]) {
          const corrupted = structuredClone(envelope);
          const validators =
            corrupted.plan.invalidContent.validatorRelaxations[0][side];
          if (replacement) validators.slug_title_field = replacement;
          else Reflect.deleteProperty(validators, 'slug_title_field');
          await writeFile(planFilePath, JSON.stringify(corrupted));
          await assert.rejects(verify(context), /validators/);
        }
      }
      const missingEverywhere = structuredClone(envelope);
      const missingExpected = structuredClone(expected);
      for (const side of ['originalValidators', 'relaxedValidators'] as const) {
        Reflect.deleteProperty(
          missingEverywhere.plan.invalidContent.validatorRelaxations[0][side],
          'slug_title_field',
        );
      }
      Reflect.deleteProperty(
        missingExpected.validators[0].validators,
        'slug_title_field',
      );
      await writeFile(planFilePath, JSON.stringify(missingEverywhere));
      await assert.rejects(
        verify({ ...context, expected: missingExpected }),
        /did not retain its exact title field reference/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts reordered restored validators but rejects a lost or changed slug title reference', async () => {
    const { seed, expected } = slugTitleFixture();
    const makeClient = (present: boolean, validators: unknown) =>
      ({
        fields: {
          rawList: async () => ({
            data: [
              {
                id: seed.slugFieldId,
                attributes: { api_key: 'slug_value', validators },
              },
            ],
          }),
        },
        items: {
          find: async () => ({
            meta: {
              is_current_version_valid: false,
              is_published_version_valid: false,
            },
          }),
          rawFind: async (
            _id: string,
            { version }: { version: 'current' | 'published' },
          ) => {
            if (!present)
              throw new CmaClient.ApiError({
                request: { url: '/items/record', method: 'GET', headers: {} },
                response: {
                  status: 404,
                  statusText: 'Not Found',
                  headers: {},
                  body: {
                    data: [
                      {
                        type: 'api_error',
                        id: 'not-found',
                        attributes: { code: 'NOT_FOUND', details: {} },
                      },
                    ],
                  },
                },
              });
            const slice = expected.source[version];
            return {
              data: {
                id: expected.recordId,
                attributes: slice.attributes,
                relationships: { item_type: { data: { id: seed.modelId } } },
                meta: {
                  is_valid: false,
                  is_current_version_valid: false,
                  is_published_version_valid: false,
                },
              },
            };
          },
        },
      }) as unknown as CmaClient.Client;
    const validators = expected.validators[0].validators;
    const sourceClient = makeClient(true, validators);
    const destinationClient = makeClient(false, validators);
    const context = {
      seed,
      expected,
      sourceClient,
      destinationClient,
      migrationFilename: 'migration.js',
      migrationFilePath: '/unused/migration.js',
      planFilePath: '/unused/plan.json',
      migrationModelApiKey: 'schema_migration',
    };
    const verify = scalarValidatorGauntletScenario.verify!;
    await verify({ ...context, appliedClient: makeClient(true, validators) });
    await verify({
      ...context,
      appliedClient: makeClient(
        true,
        Object.fromEntries(Object.entries(validators).reverse()),
      ),
    });
    for (const replacement of [undefined, { title_field_id: 'wrong-field' }]) {
      const corrupted = structuredClone(validators);
      if (replacement) corrupted.slug_title_field = replacement;
      else Reflect.deleteProperty(corrupted, 'slug_title_field');
      await assert.rejects(
        verify({ ...context, appliedClient: makeClient(true, corrupted) }),
        /not restored exactly/,
      );
    }
  });

  it('ignores nested validator object ordering while retaining exact keys, values, and array order', () => {
    const validators = {
      extension: { extensions: ['png', 'jpg'] },
      file_size: { min_value: 1, max_value: 5 },
    };
    const reordered = {
      file_size: { max_value: 5, min_value: 1 },
      extension: { extensions: ['png', 'jpg'] },
    };
    const state = (value: typeof validators) => [
      {
        fieldId: 'asset-field',
        itemTypeId: 'model',
        apiKey: 'hero',
        validators: value,
        serializedValidators: JSON.stringify(value),
      },
    ];
    const expected = state(validators);
    assertExactValidatorState(state(reordered), expected, 'validator mismatch');

    const missingKey = structuredClone(reordered);
    Reflect.deleteProperty(missingKey.file_size, 'min_value');
    const changedValue = structuredClone(reordered);
    changedValue.file_size.max_value = 6;
    const changedArrayOrder = structuredClone(reordered);
    changedArrayOrder.extension.extensions.reverse();
    for (const changed of [missingKey, changedValue, changedArrayOrder]) {
      assert.throws(
        () =>
          assertExactValidatorState(
            state(changed),
            expected,
            'validator mismatch',
          ),
        /validator mismatch/,
      );
    }
    for (const side of ['validators', 'serializedValidators'] as const) {
      const mismatchedCapture = state(reordered);
      Object.assign(mismatchedCapture[0], {
        [side]: state(changedValue)[0][side],
      });
      assert.throws(
        () =>
          assertExactValidatorState(
            mismatchedCapture,
            expected,
            'validator mismatch',
          ),
        /validator mismatch/,
      );
    }
  });

  it('builds deterministic, distinct, live-compatible model API keys', () => {
    const scalar = buildValidatorGauntletModelApiKey('vgs', 'long-run-id-123');
    const asset = buildValidatorGauntletModelApiKey('vga', 'long-run-id-123');
    assert.equal(
      scalar,
      buildValidatorGauntletModelApiKey('vgs', 'long-run-id-123'),
    );
    assert.notEqual(scalar, asset);
    for (const apiKey of [scalar, asset]) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30);
    }
  });
});

function slugTitleFixture() {
  const seed = {
    modelId: 'model',
    itemTypeApiKeys: ['scalar_model'],
    dateFieldId: 'date-field',
    dateTimeFieldId: 'datetime-field',
    formatFieldId: 'format-field',
    htmlFieldId: 'html-field',
    slugFieldId: 'slug-field',
  };
  const validators = {
    slug_title_field: { title_field_id: seed.formatFieldId },
    slug_format: { predefined_pattern: 'webpage_slug' },
  };
  const slice = (value: string) => ({
    id: 'record',
    itemTypeId: seed.modelId,
    attributes: {
      date_value: '2020-01-01',
      datetime_value: '2020-01-01T00:00:00Z',
      formatted_value: value,
      html_value: value,
      slug_value: value,
    },
    validity: { slice: false, current: false, published: false },
  });
  const expected = {
    recordId: 'record',
    source: { current: slice('current'), published: slice('published') },
    destination: { current: null, published: null },
    validators: [
      {
        fieldId: seed.slugFieldId,
        itemTypeId: seed.modelId,
        apiKey: 'slug_value',
        validators,
        serializedValidators: JSON.stringify(validators),
      },
    ],
    relaxations: [
      { fieldId: seed.slugFieldId, removedValidatorKeys: ['slug_format'] },
    ],
  };
  return { seed, expected };
}
