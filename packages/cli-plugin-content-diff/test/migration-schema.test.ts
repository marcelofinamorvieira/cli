import assert from 'node:assert/strict';
import { ContentError } from '../src/engine/errors';
import {
  prepareMigrationSchema,
  projectMigrationSchema,
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

function fixture(models: ModelSchema[] = [tracking()]): SchemaState {
  const schema: SchemaState = {
    siteId: 'project',
    environmentId: 'main',
    models,
    workflows: [],
    locales: ['en', 'it'],
    semantics: { improved_validation_at_publishing: true },
    hash: '',
  };
  schema.hash = schemaHash(schema);
  return schema;
}

function rejected(work: () => unknown): void {
  assert.throws(
    work,
    (error: unknown) =>
      error instanceof ContentError &&
      error.code === 'INVALID_MIGRATION_TRACKING_MODEL',
  );
}

describe('migration tracking schema projection', () => {
  it('records a configured exact identity and recomputes the projected schema hash', () => {
    const source = fixture();
    const before = JSON.stringify(source);
    const result = prepareMigrationSchema(source, 'custom_migration');
    assert.deepEqual(result.tracking, {
      apiKey: 'custom_migration',
      model: { id: 'tracking-model' },
    });
    assert.deepEqual(result.schema.models, []);
    assert.equal(result.schema.hash, schemaHash(result.schema));
    assert.notEqual(result.schema.hash, source.hash);
    assert.equal(result.schema.siteId, source.siteId);
    assert.equal(JSON.stringify(source), before);
  });

  it('records absence and preserves unrelated models, including canonical-looking other names', () => {
    const source = fixture([tracking({ apiKey: 'other_migration' })]);
    const prepared = prepareMigrationSchema(source, 'custom_migration');
    assert.deepEqual(prepared.tracking, {
      apiKey: 'custom_migration',
      model: null,
    });
    assert.deepEqual(prepared.schema.models, source.models);
    assert.equal(
      projectMigrationSchema(source, prepared.tracking).hash,
      source.hash,
    );
  });

  it('accepts the exact pre-existing identity without a native runner context', () => {
    const source = fixture();
    const prepared = prepareMigrationSchema(source, 'custom_migration');
    assert.equal(
      projectMigrationSchema(source, prepared.tracking).hash,
      prepared.schema.hash,
    );
  });

  it('leaves a tracking model that appeared after generation to the schema hash check', () => {
    const before = prepareMigrationSchema(fixture([]), 'custom_migration');
    const after = fixture();
    assert.equal(
      projectMigrationSchema(after, before.tracking).hash,
      after.hash,
    );
    assert.notEqual(after.hash, before.schema.hash);
  });

  it('rejects replaced, renamed, missing, and wrongly bound tracking identities', () => {
    const source = fixture();
    const prepared = prepareMigrationSchema(source, 'custom_migration');
    for (const changed of [
      fixture([]),
      fixture([tracking({ id: 'replacement' })]),
      fixture([tracking({ apiKey: 'renamed' })]),
    ])
      rejected(() => projectMigrationSchema(changed, prepared.tracking));
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
    const source = fixture([shaped, inbound]);
    const result = prepareMigrationSchema(source, 'custom_migration');
    assert.deepEqual(result.schema.models, [inbound]);
    assert.deepEqual(result.tracking.model, { id: 'tracking-model' });
    assert.equal(
      projectMigrationSchema(source, result.tracking).hash,
      result.schema.hash,
    );
  });
});
