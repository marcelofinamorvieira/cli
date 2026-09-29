import { expect } from 'chai';
import { semanticHash } from '../../src/content-diff/canonicalize';
import {
  applyCreateDefaultsToFields,
  deriveCreateDefaultValueSuppressions,
} from '../../src/content-diff/shared/create-defaults';
import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  RecordPlan,
  RecordSnapshot,
  SchemaSnapshot,
} from '../../src/content-diff/types';

const MODEL_ID = 'DefaultsModel123456789';
const BLOCK_MODEL_ID = 'DefaultsBlock123456789';
const RECORD_A = 'DefaultsRecordA1234567';
const RECORD_B = 'DefaultsRecordB1234567';

describe('CMA create-time field defaults', () => {
  it('applies block defaults only to Structured Text block slots and preserves metadata', () => {
    const schema = makeSchema();
    const model = itemType(schema, MODEL_ID);
    model.fields.find(({ apiKey }) => apiKey === 'feature')!.fieldType =
      'structured_text';
    const sidecar = nestedBlock({ nested_value: null });
    const content = {
      schema: 'dast',
      sidecar,
      document: {
        type: 'root',
        sidecar,
        children: [{ type: 'block', item: sidecar, sidecar }],
      },
    };
    const filled = applyCreateDefaultsToFields(
      { feature: content },
      model,
      schema,
    );
    expect(filled.feature).to.deep.equal({
      ...content,
      document: {
        ...content.document,
        children: [
          { type: 'block', item: nestedBlock({ nested_value: 99 }), sidecar },
        ],
      },
    });
  });

  it('models Ruby truthiness, localized locale filling, and recursive nested creates', () => {
    const schema = makeSchema();
    const model = itemType(schema, MODEL_ID);
    const filled = applyCreateDefaultsToFields(
      {
        zero_value: null,
        false_value: null,
        localized_value: { en: null, it: 7 },
        text_value: null,
        feature: nestedBlock({ nested_value: null }),
      },
      model,
      schema,
    );

    expect(filled).to.deep.equal({
      false_value: false,
      feature: nestedBlock({ nested_value: 99 }),
      localized_value: { en: 1.25, it: 7 },
      text_value: 'later text',
      zero_value: 0,
    });

    const falseDefaultSchema = replaceDefault(schema, 'field-localized', {
      en: false,
      it: true,
    });
    expect(
      applyCreateDefaultsToFields(
        {
          zero_value: 5,
          false_value: false,
          localized_value: { en: null, it: null },
          text_value: '',
          feature: null,
        },
        itemType(falseDefaultSchema, MODEL_ID),
        falseDefaultSchema,
      ).localized_value,
    ).to.deep.equal({ en: false, it: true });
  });

  it('derives exact per-locale and recursive suppressions from phase-5 projected seeds', () => {
    const schema = makeSchema();
    const firstFields: JsonObject = {
      zero_value: null,
      false_value: false,
      localized_value: { en: null, it: 7 },
      text_value: '',
      feature: nestedBlock({ nested_value: null }),
    };
    const secondFields: JsonObject = {
      zero_value: 8,
      false_value: false,
      localized_value: { en: 6, it: null },
      text_value: '',
      feature: null,
    };
    const records = [
      createPlan(RECORD_A, firstFields),
      createPlan(RECORD_B, secondFields),
      updatePlan('ExistingRecord12345678', firstFields),
    ];
    const projected = new Map<string, JsonObject>([
      [RECORD_A, firstFields],
      [RECORD_B, secondFields],
    ]);

    const suppressions = deriveCreateDefaultValueSuppressions(
      records,
      schema,
      projected,
    );

    expect(
      suppressions.map(
        ({ fieldId, suppressedDefaultValue, affectedRecordIds }) => ({
          fieldId,
          suppressedDefaultValue,
          affectedRecordIds,
        }),
      ),
    ).to.deep.equal([
      {
        fieldId: 'field-localized',
        suppressedDefaultValue: { en: null, it: null },
        affectedRecordIds: [RECORD_A, RECORD_B],
      },
      {
        fieldId: 'field-nested',
        suppressedDefaultValue: null,
        affectedRecordIds: [RECORD_A],
      },
      {
        fieldId: 'field-zero',
        suppressedDefaultValue: null,
        affectedRecordIds: [RECORD_A],
      },
    ]);
    expect(
      suppressions.every(({ allowedHashes }) => allowedHashes.length === 2),
    ).to.equal(true);
  });

  it('does not suppress a nested field removed from the exact projected create seed', () => {
    const schema = makeSchema();
    const rawDesired = {
      zero_value: 8,
      false_value: false,
      localized_value: { en: 6, it: 7 },
      text_value: '',
      feature: nestedBlock({ nested_value: null }),
    } satisfies JsonObject;
    const projectedSeed = {
      ...rawDesired,
      feature: null,
    } satisfies JsonObject;

    expect(
      deriveCreateDefaultValueSuppressions(
        [createPlan(RECORD_A, rawDesired)],
        schema,
        new Map([[RECORD_A, projectedSeed]]),
      ),
    ).to.deep.equal([]);
  });

  it('filters defaults whose CMA-normalized create result is already identical', () => {
    let schema = replaceDefault(makeSchema(), 'field-text', '');
    schema = replaceDefault(schema, 'field-localized', {
      en: false,
      it: false,
    });
    schema = {
      ...schema,
      itemTypes: schema.itemTypes.map((model) => ({
        ...model,
        fields: model.fields.map((field) =>
          field.id === 'field-localized'
            ? { ...field, fieldType: 'boolean' as const }
            : field,
        ),
      })),
    };
    const fields = {
      zero_value: 8,
      false_value: false,
      localized_value: { en: null, it: null },
      text_value: null,
      feature: null,
    } satisfies JsonObject;

    expect(
      deriveCreateDefaultValueSuppressions(
        [createPlan(RECORD_A, fields)],
        schema,
        new Map([[RECORD_A, fields]]),
      ),
    ).to.deep.equal([]);
  });

  it('keeps unique defaults and no-draft models in the exact suppression contract', () => {
    const schema = {
      ...makeSchema(),
      itemTypes: makeSchema().itemTypes.map((model) =>
        model.id === MODEL_ID
          ? {
              ...model,
              draftModeActive: false,
              fields: model.fields.map((field) =>
                field.id === 'field-zero'
                  ? { ...field, validators: { unique: {} } }
                  : field,
              ),
            }
          : model,
      ),
    };
    const fields = completeFields({ zero_value: null });
    const suppressions = deriveCreateDefaultValueSuppressions(
      [createPlan(RECORD_A, fields)],
      schema,
      new Map([[RECORD_A, fields]]),
    );

    expect(suppressions).to.have.length(1);
    expect(suppressions[0]).to.include({
      fieldId: 'field-zero',
      itemTypeId: MODEL_ID,
      originalDefaultValue: 0,
      suppressedDefaultValue: null,
    });
  });
});

function makeSchema(): SchemaSnapshot {
  const field = (
    id: string,
    apiKey: string,
    fieldType: FieldSchemaSnapshot['fieldType'],
    position: number,
    defaultValue: FieldSchemaSnapshot['defaultValue'],
    localized = false,
  ): FieldSchemaSnapshot => ({
    id,
    apiKey,
    fieldType,
    localized,
    position,
    defaultValue,
    validators: {},
  });
  const block: ItemTypeSchemaSnapshot = {
    id: BLOCK_MODEL_ID,
    apiKey: 'defaults_block',
    name: 'Defaults block',
    modularBlock: true,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: false,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [field('field-nested', 'nested_value', 'float', 1, 99)],
  };
  const model: ItemTypeSchemaSnapshot = {
    id: MODEL_ID,
    apiKey: 'defaults_model',
    name: 'Defaults model',
    modularBlock: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: true,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [
      field('field-zero', 'zero_value', 'integer', 1, 0),
      field('field-false', 'false_value', 'boolean', 2, false),
      field(
        'field-localized',
        'localized_value',
        'float',
        3,
        { en: 1.25, it: 2.5 },
        true,
      ),
      field('field-text', 'text_value', 'text', 4, 'later text'),
      {
        ...field('field-feature', 'feature', 'single_block', 5, null),
        validators: { single_block_blocks: { item_types: [BLOCK_MODEL_ID] } },
      },
    ],
  };
  return {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en', 'it'],
    environmentSemantics: {
      timezone: 'UTC',
      improvedTimezoneManagement: true,
      improvedBooleanFields: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    },
    itemTypes: [block, model],
    workflows: [],
    digest: 'schema-digest',
  };
}

function replaceDefault(
  schema: SchemaSnapshot,
  fieldId: string,
  defaultValue: FieldSchemaSnapshot['defaultValue'],
): SchemaSnapshot {
  return {
    ...schema,
    itemTypes: schema.itemTypes.map((model) => ({
      ...model,
      fields: model.fields.map((field) =>
        field.id === fieldId ? { ...field, defaultValue } : field,
      ),
    })),
  };
}

function itemType(schema: SchemaSnapshot, id: string): ItemTypeSchemaSnapshot {
  const result = schema.itemTypes.find((model) => model.id === id);
  if (!result) throw new Error(`Missing model ${id}`);
  return result;
}

function nestedBlock(attributes: JsonObject): JsonObject {
  return {
    id: 'NestedBlock12345678901',
    type: 'item',
    attributes,
    relationships: {
      item_type: { data: { id: BLOCK_MODEL_ID, type: 'item_type' } },
    },
  };
}

function completeFields(overrides: JsonObject): JsonObject {
  return {
    zero_value: 8,
    false_value: false,
    localized_value: { en: 6, it: 7 },
    text_value: '',
    feature: null,
    ...overrides,
  };
}

function createPlan(id: string, fields: JsonObject): RecordPlan {
  return plan(id, 'create', fields);
}

function updatePlan(id: string, fields: JsonObject): RecordPlan {
  return plan(id, 'update', fields);
}

function plan(
  id: string,
  action: RecordPlan['action'],
  fields: JsonObject,
): RecordPlan {
  const desired = snapshot(id, fields);
  return {
    id,
    itemTypeId: MODEL_ID,
    action,
    expectedTargetHash: action === 'create' ? null : desired.hash,
    baseline: action === 'create' ? null : desired,
    desired,
    changes: {
      current: action !== 'noop',
      published: false,
      topology: false,
      lifecycle: false,
      stage: false,
      schedules: false,
    },
    dependencies: [],
    publishedDependencies: [],
    allowedIntermediateHashes: [],
  };
}

function snapshot(id: string, fields: JsonObject): RecordSnapshot {
  const current = { fields, hash: semanticHash(fields) };
  const state = {
    id,
    itemTypeId: MODEL_ID,
    current,
    published: null,
    topology: { parentId: null, position: null },
    lifecycle: { createdAt: '2026-01-01T00:00:00Z', firstPublishedAt: null },
    validity: { current: true, published: null },
    stage: null,
    schedules: { publication: null, unpublishing: null },
  };
  return {
    ...state,
    hash: semanticHash(state),
    consistency: {
      currentVersion: 'version-1',
      updatedAt: '2026-01-01T00:00:00Z',
      publishedAt: null,
      currentValid: true,
      publishedValid: null,
    },
  };
}
