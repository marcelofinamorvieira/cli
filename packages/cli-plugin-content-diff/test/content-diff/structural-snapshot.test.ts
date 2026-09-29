import type { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import { captureContentSnapshot } from '../../src/content-diff/snapshot';
import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  SchemaSnapshot,
} from '../../src/content-diff/types';

const RECORD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const BLOCK_ID = 'w3a6zOGbS_Kj91LgAyXISA';
const OWNER_MODEL = '4QI3BfBvQs-hcv_YEkk1wg';
const ALLOWED_BLOCK_MODEL = 'mzmy5RRCSwCzMvmKgvsHUA';
const RETIRED_BLOCK_MODEL = '6lbNvQx7R4aX9tZsKc2M0g';
const UNRELATED_BLOCK_MODEL = 'Wr3t4AvNQYShLfmUDc6yng';

describe('structural-invalid snapshot capture', () => {
  it('captures a retired persisted block model without widening the managed schema', async () => {
    const schema = makeFullSchema('source');
    const client = makeClient(schema);

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'source',
      schema,
      scope: { itemTypes: ['article'], uploads: 'referenced' },
      fullAccessVerified: true,
    });

    expect(snapshot.schema.itemTypes.map(({ id }) => id).sort()).to.deep.equal(
      [OWNER_MODEL, ALLOWED_BLOCK_MODEL].sort(),
    );
    expect(snapshot.inspection.itemTypes.map(({ id }) => id)).to.deep.equal([
      RETIRED_BLOCK_MODEL,
    ]);
    expect(snapshot.inspection.structuralIssues).to.deep.equal([
      {
        recordId: RECORD_ID,
        itemTypeId: OWNER_MODEL,
        slice: 'current',
        fieldId: 'content-field',
        fieldPath: 'content',
        locale: null,
        validatorKey: 'single_block_blocks',
        blockId: BLOCK_ID,
        blockItemTypeId: RETIRED_BLOCK_MODEL,
      },
    ]);
    expect(snapshot.blockOwnership[BLOCK_ID][0]).to.include({
      topRecordId: RECORD_ID,
      itemTypeId: RETIRED_BLOCK_MODEL,
      version: 'current',
      fieldPath: 'content',
    });
    expect(
      (snapshot.records[RECORD_ID].current.fields.content as { id: string }).id,
    ).to.equal(BLOCK_ID);
  });

  it('allows unrelated out-of-scope block-schema drift during consistency verification', async () => {
    const capturedSchema = makeFullSchema('source');
    const refreshedSchema = replaceFieldValidators(
      capturedSchema,
      'unrelated-value-field',
      { length: { min: 9 } },
    );
    let nestedCurrentReads = 0;
    const client = makeClient(refreshedSchema, () => {
      nestedCurrentReads += 1;
    });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'source',
      schema: capturedSchema,
      scope: { itemTypes: ['article'], uploads: 'referenced' },
      fullAccessVerified: true,
      maxAttempts: 2,
    });

    expect(nestedCurrentReads).to.equal(1);
    expect(snapshot.inspection.itemTypes.map(({ id }) => id)).to.deep.equal([
      RETIRED_BLOCK_MODEL,
    ]);
    expect(snapshot.inspection.itemTypes[0].fields[0].validators).to.deep.equal(
      {},
    );
  });

  it('retries when the exact inspection-only block schema changes', async () => {
    const capturedSchema = makeFullSchema('source');
    const refreshedSchema = replaceFieldValidators(
      capturedSchema,
      'retired-value-field',
      { length: { min: 2 } },
    );
    let nestedCurrentReads = 0;
    const client = makeClient(refreshedSchema, () => {
      nestedCurrentReads += 1;
    });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'source',
      schema: capturedSchema,
      scope: { itemTypes: ['article'], uploads: 'referenced' },
      fullAccessVerified: true,
      maxAttempts: 2,
    });

    expect(nestedCurrentReads).to.equal(2);
    expect(snapshot.inspection.itemTypes[0].fields[0].validators).to.deep.equal(
      { length: { min: 2 } },
    );
  });
});

function makeClient(
  liveSchema: SchemaSnapshot,
  onNestedCurrentRead: () => void = () => undefined,
): CmaClient.Client {
  const rawRecord = {
    id: RECORD_ID,
    type: 'item',
    item_type: { id: OWNER_MODEL, type: 'item_type' },
    attributes: {
      content: {
        id: BLOCK_ID,
        type: 'item',
        attributes: { value: 'persisted' },
        relationships: {
          item_type: {
            data: { id: RETIRED_BLOCK_MODEL, type: 'item_type' },
          },
        },
      },
    },
    meta: {
      created_at: '2025-01-01T00:00:00.000Z',
      first_published_at: null,
      current_version: 'version-1',
      is_valid: false,
      is_current_version_valid: false,
      is_published_version_valid: null,
      updated_at: '2025-01-01T00:00:00.000Z',
      published_at: null,
      publication_scheduled_at: null,
      unpublishing_scheduled_at: null,
      stage: null,
    },
  };

  return {
    site: {
      find: async () => ({
        id: liveSchema.siteId,
        locales: liveSchema.locales,
        timezone: liveSchema.environmentSemantics.timezone,
        meta: {
          improved_timezone_management:
            liveSchema.environmentSemantics.improvedTimezoneManagement,
          improved_boolean_fields:
            liveSchema.environmentSemantics.improvedBooleanFields,
          improved_validation_at_publishing:
            liveSchema.environmentSemantics.improvedValidationAtPublishing,
          milliseconds_in_datetime:
            liveSchema.environmentSemantics.millisecondsInDatetime,
          non_localized_focal_points:
            liveSchema.environmentSemantics.nonLocalizedFocalPoints,
          improved_hex_management:
            liveSchema.environmentSemantics.improvedHexManagement,
        },
      }),
    },
    itemTypes: {
      list: async () => liveSchema.itemTypes.map(rawItemType),
    },
    fields: {
      list: async (itemTypeId: string) =>
        liveSchema.itemTypes
          .find(({ id }) => id === itemTypeId)!
          .fields.map(rawField),
    },
    workflows: { list: async () => [] },
    items: {
      listPagedIterator(query: Record<string, unknown>) {
        const filter = query.filter as { type: string };
        const nested = query.nested === true;
        const current = query.version === 'current';
        if (nested && current && filter.type === OWNER_MODEL) {
          onNestedCurrentRead();
        }
        return iterate(
          current && filter.type === OWNER_MODEL ? [rawRecord] : [],
        );
      },
    },
    uploads: {
      listPagedIterator() {
        return iterate([]);
      },
    },
    uploadCollections: { list: async () => [] },
  } as unknown as CmaClient.Client;
}

function makeFullSchema(environmentId: string): SchemaSnapshot {
  const owner = itemType(OWNER_MODEL, 'article', false, [
    {
      id: 'content-field',
      apiKey: 'content',
      fieldType: 'single_block',
      localized: false,
      position: 1,
      defaultValue: null,
      validators: {
        single_block_blocks: { item_types: [ALLOWED_BLOCK_MODEL] },
      },
    },
  ]);
  const allowed = itemType(ALLOWED_BLOCK_MODEL, 'allowed_block', true, []);
  const retired = itemType(RETIRED_BLOCK_MODEL, 'retired_block', true, [
    {
      id: 'retired-value-field',
      apiKey: 'value',
      fieldType: 'string',
      localized: false,
      position: 1,
      defaultValue: null,
      validators: {},
    },
  ]);
  const unrelated = itemType(UNRELATED_BLOCK_MODEL, 'unrelated_block', true, [
    {
      id: 'unrelated-value-field',
      apiKey: 'value',
      fieldType: 'string',
      localized: false,
      position: 1,
      defaultValue: null,
      validators: {},
    },
  ]);
  const schema: SchemaSnapshot = {
    siteId: 'site-id',
    environmentId,
    locales: ['en'],
    environmentSemantics: {
      timezone: 'UTC',
      improvedTimezoneManagement: true,
      improvedBooleanFields: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    },
    itemTypes: [owner, allowed, retired, unrelated],
    workflows: [],
    digest: '',
  };
  schema.digest = computeSchemaDigest(schema);
  return schema;
}

function replaceFieldValidators(
  schema: SchemaSnapshot,
  fieldId: string,
  validators: FieldSchemaSnapshot['validators'],
): SchemaSnapshot {
  const result = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field) =>
        field.id === fieldId ? { ...field, validators } : field,
      ),
    })),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function itemType(
  id: string,
  apiKey: string,
  modularBlock: boolean,
  fields: FieldSchemaSnapshot[],
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey,
    name: apiKey,
    modularBlock,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: !modularBlock,
    draftSavingActive: !modularBlock,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}

function rawItemType(
  itemType: ItemTypeSchemaSnapshot,
): Record<string, unknown> {
  return {
    id: itemType.id,
    api_key: itemType.apiKey,
    name: itemType.name,
    modular_block: itemType.modularBlock,
    singleton: itemType.singleton,
    sortable: itemType.sortable,
    tree: itemType.tree,
    draft_mode_active: itemType.draftModeActive,
    draft_saving_active: itemType.draftSavingActive,
    all_locales_required: itemType.allLocalesRequired,
    workflow: null,
  };
}

function rawField(field: FieldSchemaSnapshot): Record<string, unknown> {
  return {
    id: field.id,
    api_key: field.apiKey,
    field_type: field.fieldType,
    localized: field.localized,
    position: field.position,
    default_value: field.defaultValue ?? null,
    validators: field.validators,
  };
}

async function* iterate(values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}
