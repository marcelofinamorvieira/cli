import assert from 'node:assert/strict';
import {
  DEFAULT_TRACKING_MODEL_API_KEY,
  withoutTrackingModel,
} from '../src/engine/migration-schema';
import { schemaHash } from '../src/engine/schema';
import type { ModelSchema, SchemaState } from '../src/engine/types';

function tracking(overrides: Partial<ModelSchema> = {}): ModelSchema {
  return {
    id: 'tracking-model',
    apiKey: 'custom_migration',
    name: 'Schema migration',
    block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: false,
    saveInvalidDrafts: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [
      {
        id: 'migration-name',
        apiKey: 'name',
        type: 'string',
        localized: false,
        validators: { required: {} },
        defaultValue: null,
      },
    ],
    ...overrides,
  };
}

const article = () =>
  tracking({ id: 'article', apiKey: 'article', name: 'Article' });

function fixture(
  models: ModelSchema[] = [tracking()],
  side: Partial<Pick<SchemaState, 'siteId' | 'environmentId'>> = {},
): SchemaState {
  const schema: SchemaState = {
    siteId: side.siteId ?? 'project',
    environmentId: side.environmentId ?? 'main',
    models,
    workflows: [],
    locales: ['en', 'it'],
    semantics: { improved_validation_at_publishing: true },
    hash: '',
  };
  schema.hash = schemaHash(schema);
  return schema;
}

describe('migration tracking model removal', () => {
  it('names the native migration runner tracking model by default', () => {
    assert.equal(DEFAULT_TRACKING_MODEL_API_KEY, 'schema_migration');
  });

  it('removes the model holding the API key from either side and recomputes the hash', () => {
    for (const side of [
      { siteId: 'source', environmentId: 'sandbox' },
      { siteId: 'destination', environmentId: 'main' },
    ]) {
      const schema = fixture([tracking(), article()], side);
      const before = JSON.stringify(schema);
      const projected = withoutTrackingModel(schema, 'custom_migration');
      assert.deepEqual(projected.models, [article()]);
      assert.equal(projected.hash, schemaHash(projected));
      assert.notEqual(projected.hash, schema.hash);
      assert.equal(projected.siteId, side.siteId);
      assert.equal(projected.environmentId, side.environmentId);
      assert.equal(JSON.stringify(schema), before);
    }
  });

  it('hashes a schema that lost the model like one that never had it', () => {
    const never = fixture([article()]);
    const removed = withoutTrackingModel(
      fixture([tracking(), article()]),
      'custom_migration',
    );
    assert.deepEqual(removed.models, never.models);
    assert.equal(removed.hash, never.hash);
  });

  it('hashes a tracking model recreated under another ID the same once removed', () => {
    const generated = fixture([tracking(), article()]);
    const recreated = fixture([tracking({ id: 'replacement' }), article()]);
    assert.notEqual(recreated.hash, generated.hash);
    assert.equal(
      withoutTrackingModel(recreated, 'custom_migration').hash,
      withoutTrackingModel(generated, 'custom_migration').hash,
    );
  });

  it('leaves a schema without the model as it is, canonical-looking other names included', () => {
    const schema = fixture([
      tracking({ apiKey: 'other_migration' }),
      article(),
    ]);
    const projected = withoutTrackingModel(schema, 'custom_migration');
    assert.deepEqual(projected.models, schema.models);
    assert.equal(projected.hash, schema.hash);
    const empty = fixture([]);
    assert.deepEqual(withoutTrackingModel(empty, 'custom_migration'), empty);
  });

  it('excludes the model holding the API key whatever its shape, validators or inbound links', () => {
    const shaped = tracking({
      sortable: true,
      draftMode: true,
      fields: [
        { ...tracking().fields[0], validators: { unique: {} } },
        { ...tracking().fields[0], id: 'extra', apiKey: 'body' },
      ],
    });
    const inbound = tracking({
      id: 'article',
      apiKey: 'article',
      fields: [
        {
          ...tracking().fields[0],
          id: 'reference',
          type: 'link',
          validators: { item_item_type: { item_types: ['tracking-model'] } },
        },
      ],
    });
    const result = withoutTrackingModel(
      fixture([shaped, inbound]),
      'custom_migration',
    );
    assert.deepEqual(result.models, [inbound]);
    assert.equal(result.hash, fixture([inbound]).hash);
  });
});
