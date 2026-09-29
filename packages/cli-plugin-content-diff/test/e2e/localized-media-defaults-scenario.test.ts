import assert from 'node:assert/strict';
import { expect } from 'chai';
import { ASSET_FIXTURE_PNG, md5 } from './assets-deletions-scenario';
import {
  PROVEN_FEATURES,
  type RawSchemaDefault,
  SCALAR_DEFAULT_SPECS,
  assertLocalizedMediaDefaultSuppressionPlan,
  assertSchemaDefaults,
  expectedStoredScalarDefault,
  localizedMediaApiKeys,
  localizedMediaDefaultsScenario,
  localizedMediaStageBlockIds,
  projectRawLocalizedMediaRecord,
  projectRawLocalizedUpload,
} from './localized-media-defaults-scenario';

describe('localized media/defaults real-CMA fixture contract', () => {
  it('declares only executable features and every API-supported scalar default type', () => {
    expect(PROVEN_FEATURES).to.have.length(22);
    expect(
      SCALAR_DEFAULT_SPECS.map(({ fieldType }) => fieldType),
    ).to.deep.equal([
      'boolean',
      'color',
      'date',
      'date_time',
      'float',
      'integer',
      'json',
      'lat_lon',
      'text',
    ]);
    expect(PROVEN_FEATURES.join('\n')).not.to.match(
      /file default|video default/i,
    );
    expect(localizedMediaDefaultsScenario.contentDiffArgs).to.deep.equal([
      '--uploads=all',
      '--bundle-assets',
      '--migrate-invalid-content',
    ]);
  });

  it('requires an exact schema-edit warning for only the seven historical null scalar fields', () => {
    const scalarFieldIds = Object.fromEntries(
      SCALAR_DEFAULT_SPECS.map(({ apiKey }) => [apiKey, `field-${apiKey}`]),
    ) as Parameters<typeof assertLocalizedMediaDefaultSuppressionPlan>[1];
    const expectedFieldIds = SCALAR_DEFAULT_SPECS.filter(
      ({ historicalStored }) => historicalStored === null,
    ).map(({ apiKey }) => scalarFieldIds[apiKey]);
    const plan = {
      options: { migrateInvalidContent: true },
      requiredPermissions: { editSchema: true },
      warnings: [
        {
          code: 'DEFAULT_VALUE_SUPPRESSION',
          message: 'exact temporary suppression and restoration',
          entityIds: [...expectedFieldIds].reverse(),
        },
      ],
    };

    assert.doesNotThrow(() =>
      assertLocalizedMediaDefaultSuppressionPlan(plan, scalarFieldIds),
    );

    const includesCmaNormalizedControl = structuredClone(plan);
    includesCmaNormalizedControl.warnings[0].entityIds.push(
      scalarFieldIds.boolean_value,
    );
    assert.throws(
      () =>
        assertLocalizedMediaDefaultSuppressionPlan(
          includesCmaNormalizedControl,
          scalarFieldIds,
        ),
      /default suppression must target only the seven scalar fields/,
    );

    const noSchemaOptIn = structuredClone(plan);
    noSchemaOptIn.options.migrateInvalidContent = false;
    assert.throws(
      () =>
        assertLocalizedMediaDefaultSuppressionPlan(
          noSchemaOptIn,
          scalarFieldIds,
        ),
      /historical-null creation must carry explicit schema-mutation opt-in/,
    );
  });

  it('uses deterministic valid model and block API keys', () => {
    const first = localizedMediaApiKeys('long-run-id-123');
    const second = localizedMediaApiKeys('long-run-id-123');
    expect(first).to.deep.equal(second);
    for (const apiKey of Object.values(first)) {
      expect(apiKey).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      expect(apiKey.length).to.be.lessThanOrEqual(30);
    }
  });

  it('seeds every current nested block ID in the published phase', () => {
    const first = localizedMediaStageBlockIds('record-id');
    const second = localizedMediaStageBlockIds('record-id');
    expect(first).to.deep.equal(second);
    expect(first.en).not.to.equal(first.it);

    const publishedIds = new Set([first.en, first.it]);
    const currentIds = [first.it];
    expect(currentIds.every((id) => publishedIds.has(id))).to.equal(true);
  });

  it('asserts the CMA millisecond-normalized date-time default byte for byte', () => {
    const dateTime = SCALAR_DEFAULT_SPECS.find(
      ({ fieldType }) => fieldType === 'date_time',
    );
    assert.ok(dateTime);
    expect(dateTime.defaultValue).to.equal('2042-02-03T04:05:06+01:00');
    expect(expectedStoredScalarDefault(dateTime)).to.equal(
      '2042-02-03T04:05:06.000+01:00',
    );
    expect(
      Buffer.from(
        JSON.stringify(expectedStoredScalarDefault(dateTime)),
        'utf8',
      ).toString('hex'),
    ).to.equal(
      Buffer.from(
        JSON.stringify('2042-02-03T04:05:06.000+01:00'),
        'utf8',
      ).toString('hex'),
    );
  });

  it('preserves omitted locale keys separately from explicit null and empty values', () => {
    const projected = projectRawLocalizedMediaRecord(
      rawRecord({
        hero: { en: null },
        gallery: { en: [], it: [] },
        seo: { en: null, it: null },
        external_video: { en: null, it: null },
        feature: { en: null },
      }),
      'model-id',
    );

    expect(Object.keys(projected.fields.hero as object)).to.deep.equal(['en']);
    expect(projected.fields.gallery).to.deep.equal({ en: [], it: [] });
    expect(projected.fields.seo).to.deep.equal({ en: null, it: null });
    expect(Object.keys(projected.fields.feature as object)).to.deep.equal([
      'en',
    ]);
  });

  it('canonicalizes a raw nested media block while retaining its exact upload field value', () => {
    const projected = projectRawLocalizedMediaRecord(
      rawRecord({
        feature: {
          en: {
            type: 'item',
            id: 'block-id',
            attributes: {
              media: {
                upload_id: 'upload-id',
                title: null,
                alt: '',
                custom_data: {},
                focal_point: { y: 0.4, x: 0.6 },
                poster_time: null,
              },
              label: 'Nested media',
            },
            relationships: {
              item_type: {
                data: { type: 'item_type', id: 'block-model-id' },
              },
            },
          },
          it: null,
        },
      }),
      'model-id',
    );

    expect(projected.fields.feature).to.deep.equal({
      en: {
        id: 'block-id',
        itemTypeId: 'block-model-id',
        attributes: {
          label: 'Nested media',
          media: {
            alt: '',
            custom_data: {},
            focal_point: { x: 0.6, y: 0.4 },
            poster_time: null,
            title: null,
            upload_id: 'upload-id',
          },
        },
      },
      it: null,
    });
  });

  it('projects exact upload bytes and localized writable metadata', () => {
    const upload = projectRawLocalizedUpload(
      {
        data: {
          type: 'upload',
          id: 'upload-id',
          attributes: {
            size: ASSET_FIXTURE_PNG.byteLength,
            md5: md5(ASSET_FIXTURE_PNG),
            filename: 'localized-media-source.png',
            basename: 'localized-media-source',
            mime_type: 'image/png',
            author: 'Author',
            copyright: null,
            notes: 'Notes',
            tags: ['z', 'a'],
            default_field_metadata: {
              title: { it: 'Titolo', en: null },
              alt: { it: '', en: 'English alt' },
              custom_data: { it: {}, en: { exact: true } },
              focal_point: { y: 0.87, x: 0.13 },
              poster_time: null,
            },
          },
        },
      },
      'upload-id',
    );

    expect(upload.size).to.equal(68);
    expect(upload.md5).to.equal('e44e7ecfec99356632c13cd3eaa3e250');
    expect(upload.tags).to.deep.equal(['a', 'z']);
    expect(upload.defaultFieldMetadata).to.deep.equal({
      alt: { en: 'English alt', it: '' },
      custom_data: { en: { exact: true }, it: {} },
      focal_point: { x: 0.13, y: 0.87 },
      poster_time: null,
      title: { en: null, it: 'Titolo' },
    });
  });

  it('checks exact JSON bytes as well as parsed schema default values', () => {
    const defaults = Object.fromEntries(
      SCALAR_DEFAULT_SPECS.map((spec, index) => [
        spec.apiKey,
        {
          id: `field-${index}`,
          fieldType: spec.fieldType,
          localized: false,
          defaultValue: expectedStoredScalarDefault(spec),
          rawJsonUtf8Hex: Buffer.from(
            JSON.stringify(expectedStoredScalarDefault(spec)),
            'utf8',
          ).toString('hex'),
        } satisfies RawSchemaDefault,
      ]),
    ) as Parameters<typeof assertSchemaDefaults>[0];

    assert.doesNotThrow(() => assertSchemaDefaults(defaults));
    const changedBytes = {
      ...defaults,
      color_value: {
        ...defaults.color_value,
        rawJsonUtf8Hex: Buffer.from(
          JSON.stringify({ alpha: 204, blue: 51, green: 34, red: 17 }),
          'utf8',
        ).toString('hex'),
      },
    };
    assert.throws(
      () => assertSchemaDefaults(changedBytes),
      /color_value default JSON bytes differ/,
    );
  });
});

function rawRecord(attributes: Record<string, unknown>) {
  return {
    data: {
      type: 'item',
      id: 'record-id',
      attributes,
      relationships: {
        item_type: { data: { type: 'item_type', id: 'model-id' } },
      },
      meta: {
        status: 'published',
        is_current_version_valid: true,
        is_published_version_valid: true,
      },
    },
  };
}
