import assert from 'node:assert/strict';
import { ContentError } from '../../src/engine/errors';
import {
  prepareMigrationSchema,
  projectMigrationSchema,
} from '../../src/engine/migration-schema';
import { schemaHash } from '../../src/engine/schema';
import type {
  FieldSchema,
  ModelSchema,
  SchemaState,
} from '../../src/engine/types';

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

const runtimeTracking = {
  id: 'tracking-model',
  apiKey: 'custom_migration',
  createdByThisRun: false,
};

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
      model: { id: 'tracking-model', nameFieldId: 'migration-name' },
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

  it('accepts the exact pre-existing identity under both execution hosts', () => {
    const source = fixture();
    const prepared = prepareMigrationSchema(source, 'custom_migration');
    assert.equal(
      projectMigrationSchema(source, prepared.tracking).hash,
      prepared.schema.hash,
    );
    assert.equal(
      projectMigrationSchema(source, prepared.tracking, runtimeTracking).hash,
      prepared.schema.hash,
    );
  });

  it('allows an absent model only when the native host created this exact canonical model', () => {
    const before = prepareMigrationSchema(fixture([]), 'custom_migration');
    const after = fixture();
    assert.equal(
      projectMigrationSchema(after, before.tracking, {
        ...runtimeTracking,
        createdByThisRun: true,
      }).hash,
      before.schema.hash,
    );
    rejected(() => projectMigrationSchema(after, before.tracking));
    rejected(() =>
      projectMigrationSchema(after, before.tracking, runtimeTracking),
    );
    rejected(() => projectMigrationSchema(after, before.tracking, null));
    rejected(() =>
      projectMigrationSchema(after, before.tracking, {
        ...runtimeTracking,
        createdByThisRun: true,
        id: 'another-model',
      }),
    );
  });

  it('rejects replaced, renamed, missing, and wrongly bound tracking identities', () => {
    const source = fixture();
    const prepared = prepareMigrationSchema(source, 'custom_migration');
    for (const changed of [
      fixture([]),
      fixture([tracking({ id: 'replacement' })]),
      fixture([tracking({ apiKey: 'renamed' })]),
      fixture([
        tracking({
          fields: [{ ...tracking().fields[0], id: 'replacement-field' }],
        }),
      ]),
    ])
      rejected(() => projectMigrationSchema(changed, prepared.tracking));
    rejected(() =>
      projectMigrationSchema(source, prepared.tracking, {
        ...runtimeTracking,
        id: 'another-model',
      }),
    );
    rejected(() =>
      projectMigrationSchema(source, prepared.tracking, {
        ...runtimeTracking,
        apiKey: 'other_migration',
      }),
    );
    rejected(() => projectMigrationSchema(source, prepared.tracking, null));
  });

  it('rejects content models that merely share the configured API key', () => {
    const canonical = tracking();
    const invalidFields: Partial<FieldSchema>[] = [
      { apiKey: 'title' },
      { type: 'text' },
      { localized: true },
      { validators: {} },
      { validators: { required: {}, unique: {} } },
      { defaultValue: 'receipt' },
    ];
    for (const model of [
      tracking({ block: true }),
      tracking({ singleton: true }),
      tracking({ sortable: true }),
      tracking({ tree: true }),
      tracking({ draftMode: true }),
      tracking({ workflowId: 'editorial' }),
      tracking({ fields: [] }),
      tracking({
        fields: [
          canonical.fields[0],
          { ...canonical.fields[0], id: 'extra', apiKey: 'body' },
        ],
      }),
      ...invalidFields.map((field) =>
        tracking({ fields: [{ ...canonical.fields[0], ...field }] }),
      ),
    ]) {
      rejected(() =>
        prepareMigrationSchema(fixture([model]), 'custom_migration'),
      );
      rejected(() =>
        projectMigrationSchema(
          fixture([model]),
          {
            apiKey: 'custom_migration',
            model: null,
          },
          { ...runtimeTracking, createdByThisRun: true },
        ),
      );
    }
  });

  it('rejects inbound model allowlists in regular, retained, and block schemas', () => {
    for (const validator of [
      'item_item_type',
      'items_item_type',
      'structured_text_links',
      'rich_text_blocks',
      'single_block_blocks',
      'structured_text_blocks',
      'structured_text_inline_blocks',
    ]) {
      for (const block of [false, true]) {
        const inbound = tracking({
          id: 'other-model',
          apiKey: 'other_model',
          block,
          fields: [
            {
              ...tracking().fields[0],
              id: 'reference-field',
              apiKey: 'reference',
              type: 'link',
              validators: { [validator]: { item_types: ['tracking-model'] } },
            },
          ],
        });
        const source = fixture([tracking(), inbound]);
        rejected(() => prepareMigrationSchema(source, 'custom_migration'));
        const binding = prepareMigrationSchema(
          fixture(),
          'custom_migration',
        ).tracking;
        rejected(() =>
          projectMigrationSchema(source, binding, runtimeTracking),
        );
      }
    }
  });

  it('preserves unrelated reference validators and native empty string defaults', () => {
    const ordinary = tracking({
      id: 'article',
      apiKey: 'article',
      fields: [
        {
          ...tracking().fields[0],
          id: 'reference',
          validators: { item_item_type: { item_types: ['other-content'] } },
        },
      ],
    });
    const source = fixture([
      tracking({ fields: [{ ...tracking().fields[0], defaultValue: '' }] }),
      ordinary,
    ]);
    const result = prepareMigrationSchema(source, 'custom_migration');
    assert.deepEqual(result.schema.models, [ordinary]);
  });
});
