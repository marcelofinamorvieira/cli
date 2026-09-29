import assert from 'node:assert/strict';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

export const SCHEMA_GATE_FAILURE_PATTERN =
  /Incompatible schema:[\s\S]*No content records were read and no migration artifacts were created\.[\s\S]*datocms migrations:new[\s\S]*datocms migrations:run[\s\S]*datocms content:diff[\s\S]*does not bypass schema compatibility/;

type SchemaGateDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
  };
};

type SchemaGateSeed = RealCmaScenarioSeed &
  Readonly<{
    managedModelId: string;
    managedFieldId: string;
    managedRecordId: string;
    unrelatedModelId: string;
    unrelatedFieldId: string;
  }>;

type RawManagedRecord = Readonly<{
  id: string;
  itemTypeId: string;
  title: string;
}>;

type RawManagedState = Readonly<{
  current: RawManagedRecord;
  published: RawManagedRecord;
}>;

type RawFieldContract = Readonly<{
  id: string;
  itemTypeId: string;
  apiKey: string;
  fieldType: string;
  defaultValue: unknown;
  validators: unknown;
}>;

type OutOfScopeExpected = Readonly<{
  sourceManaged: RawManagedState;
  destinationUnrelatedField: RawFieldContract;
  sourceUnrelatedField: RawFieldContract;
}>;

export const managedSchemaMismatchScenario: RealCmaScenario<
  SchemaGateSeed,
  void
> = {
  name: 'managed validator and default schema mismatch fails generation',
  expectedGenerationFailure: { messagePattern: SCHEMA_GATE_FAILURE_PATTERN },

  seedSource: ({ client, runId }) => seedSchemaGate(client, runId, 'mismatch'),

  async introduceDrift({ seed, sourceClient }) {
    console.log('[content-diff e2e] Drifting a selected field schema');
    await sourceClient.fields.update(seed.managedFieldId, {
      default_value: 'source-only default',
      validators: {
        required: {},
        length: { min: 3, max: 120 },
      },
    });
    await sourceClient.items.update<SchemaGateDefinition>(
      seed.managedRecordId,
      { title: 'source content that must not be read or applied' },
    );
    await sourceClient.items.publish<SchemaGateDefinition>(
      seed.managedRecordId,
    );
  },
};

export const outOfScopeSchemaDriftScenario: RealCmaScenario<
  SchemaGateSeed,
  OutOfScopeExpected
> = {
  name: 'unrelated schema drift is ignored while managed content converges',

  seedSource: ({ client, runId }) =>
    seedSchemaGate(client, runId, 'out_of_scope'),

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Drifting only an out-of-scope field schema',
    );
    await sourceClient.items.update<SchemaGateDefinition>(
      seed.managedRecordId,
      { title: 'source managed value' },
    );
    await sourceClient.items.publish<SchemaGateDefinition>(
      seed.managedRecordId,
    );
    await destinationClient.items.update<SchemaGateDefinition>(
      seed.managedRecordId,
      { title: 'destination managed drift' },
    );
    await destinationClient.items.publish<SchemaGateDefinition>(
      seed.managedRecordId,
    );
    await destinationClient.fields.update(seed.unrelatedFieldId, {
      default_value: 'destination-only unrelated default',
      validators: { length: { min: 7, max: 240 } },
    });

    return {
      sourceManaged: await captureRawManagedState(
        sourceClient,
        seed.managedRecordId,
        seed.managedModelId,
      ),
      destinationUnrelatedField: await captureRawField(
        destinationClient,
        seed.unrelatedFieldId,
        seed.unrelatedModelId,
      ),
      sourceUnrelatedField: await captureRawField(
        sourceClient,
        seed.unrelatedFieldId,
        seed.unrelatedModelId,
      ),
    };
  },

  async verify({ seed, expected, appliedClient }) {
    console.log('[content-diff e2e] Verifying managed-only schema scope');
    const [actualManaged, actualUnrelatedField] = await Promise.all([
      captureRawManagedState(
        appliedClient,
        seed.managedRecordId,
        seed.managedModelId,
      ),
      captureRawField(
        appliedClient,
        seed.unrelatedFieldId,
        seed.unrelatedModelId,
      ),
    ]);

    assert.deepEqual(
      actualManaged,
      expected.sourceManaged,
      'selected managed record did not converge to source current/published state',
    );
    assert.deepEqual(
      actualUnrelatedField,
      expected.destinationUnrelatedField,
      'content migration changed an unrelated destination field schema',
    );
    assert.notDeepEqual(
      actualUnrelatedField,
      expected.sourceUnrelatedField,
      'the out-of-scope schema drift was not present in the live fixture',
    );
  },
};

async function seedSchemaGate(
  client: CmaClient.Client,
  runId: string,
  lane: string,
): Promise<SchemaGateSeed> {
  console.log(`[content-diff e2e] Creating ${lane} schema-gating fixture`);
  const managedApiKey = schemaGateApiKey('managed', lane, runId);
  const unrelatedApiKey = schemaGateApiKey('unrelated', lane, runId);
  const managedModel = await createModel(client, managedApiKey, 'Managed');
  const managedField = await client.fields.create(managedModel.id, {
    label: 'Title',
    api_key: 'title',
    field_type: 'string',
    localized: false,
    default_value: null,
    validators: { required: {} },
  });
  const unrelatedModel = await createModel(
    client,
    unrelatedApiKey,
    'Unrelated',
  );
  const unrelatedField = await client.fields.create(unrelatedModel.id, {
    label: 'Note',
    api_key: 'note',
    field_type: 'text',
    localized: false,
    default_value: null,
    validators: {},
  });
  const managedRecord = await client.items.create<SchemaGateDefinition>({
    item_type: { id: managedModel.id, type: 'item_type' },
    title: 'shared managed baseline',
  });
  await client.items.publish<SchemaGateDefinition>(managedRecord.id);

  return {
    itemTypeApiKeys: [managedApiKey],
    managedModelId: managedModel.id,
    managedFieldId: managedField.id,
    managedRecordId: managedRecord.id,
    unrelatedModelId: unrelatedModel.id,
    unrelatedFieldId: unrelatedField.id,
  };
}

function createModel(
  client: CmaClient.Client,
  apiKey: string,
  label: string,
): Promise<CmaClient.ApiTypes.ItemType> {
  return client.itemTypes.create({
    name: `${label} schema gate`,
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

async function captureRawManagedState(
  client: CmaClient.Client,
  recordId: string,
  modelId: string,
): Promise<RawManagedState> {
  const [current, published] = await Promise.all([
    client.items.rawFind<SchemaGateDefinition>(recordId, {
      version: 'current',
    }),
    client.items.rawFind<SchemaGateDefinition>(recordId, {
      version: 'published',
    }),
  ]);
  return {
    current: normalizeRawManagedRecord(current, recordId, modelId),
    published: normalizeRawManagedRecord(published, recordId, modelId),
  };
}

function normalizeRawManagedRecord(
  response: unknown,
  recordId: string,
  modelId: string,
): RawManagedRecord {
  const resource = resourceData(response, 'record response');
  if (resource.type !== 'item' || resource.id !== recordId) {
    throw new Error('record response contains an unexpected resource');
  }
  const itemTypeId = relationshipId(resource, 'item_type');
  if (itemTypeId !== modelId) {
    throw new Error(`record ${recordId} belongs to an unexpected model`);
  }
  return {
    id: resource.id,
    itemTypeId,
    title: requiredString(resource.attributes.title, `${recordId}.title`),
  };
}

async function captureRawField(
  client: CmaClient.Client,
  fieldId: string,
  modelId: string,
): Promise<RawFieldContract> {
  const resource = resourceData(
    await client.fields.rawFind(fieldId),
    'field response',
  );
  if (resource.type !== 'field' || resource.id !== fieldId) {
    throw new Error('field response contains an unexpected resource');
  }
  const itemTypeId = relationshipId(resource, 'item_type');
  if (itemTypeId !== modelId) {
    throw new Error(`field ${fieldId} belongs to an unexpected model`);
  }
  return {
    id: resource.id,
    itemTypeId,
    apiKey: requiredString(resource.attributes.api_key, `${fieldId}.api_key`),
    fieldType: requiredString(
      resource.attributes.field_type,
      `${fieldId}.field_type`,
    ),
    defaultValue: canonicalJson(resource.attributes.default_value),
    validators: canonicalJson(resource.attributes.validators),
  };
}

type RawResource = Readonly<{
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
}>;

function resourceData(response: unknown, path: string): RawResource {
  const resource = object(object(response, path).data, `${path}.data`);
  return {
    type: requiredString(resource.type, `${path}.data.type`),
    id: requiredString(resource.id, `${path}.data.id`),
    attributes: object(resource.attributes, `${path}.data.attributes`),
    relationships: object(resource.relationships, `${path}.data.relationships`),
  };
}

function relationshipId(resource: RawResource, key: string): string {
  const relationship = object(
    resource.relationships[key],
    `${resource.id}.${key}`,
  );
  return requiredString(
    object(relationship.data, `${resource.id}.${key}.data`).id,
    `${resource.id}.${key}.data.id`,
  );
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

export function schemaGateApiKey(
  scope: 'managed' | 'unrelated',
  lane: string,
  runId: string,
): string {
  const compactRunId = runId.replace(/-/g, '');
  const compactLane = lane.replace(/_/g, '');
  if (!/^[a-z]+$/.test(compactLane) || !/^[a-z0-9]+$/.test(compactRunId)) {
    throw new Error(
      'schema-gating API key inputs contain unsupported characters',
    );
  }
  const scopeCode = scope === 'managed' ? 'm' : 'u';
  return `cde2e_gate_${scopeCode}${compactLane[0]}r${compactRunId.slice(-12)}`;
}
