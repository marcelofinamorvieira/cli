import type { MigrationExecutionContext } from '@datocms/cli-utils';
import { hashJson, object } from './codec';
import { ContentError } from './errors';
import { schemaHash } from './schema';
import type { ModelSchema, SchemaState } from './types';

/** Generation records absence too, rather than ignoring a model by name later. */
export interface MigrationTrackingBinding {
  apiKey: string;
  model: { id: string; nameFieldId: string } | null;
}

type RuntimeTrackingModel = MigrationExecutionContext['trackingModel'];

function invalid(message: string): never {
  throw new ContentError('INVALID_MIGRATION_TRACKING_MODEL', message);
}

/** Validate the minimal model created by the native migration runner. */
function assertCanonicalTrackingModel(model: ModelSchema): void {
  if (
    model.block ||
    model.singleton ||
    model.sortable ||
    model.tree ||
    model.draftMode ||
    model.workflowId !== null ||
    model.fields.length !== 1
  )
    invalid(
      `Model ${model.apiKey} is not a canonical migration tracking model.`,
    );
  const field = model.fields[0];
  if (
    field.apiKey !== 'name' ||
    field.type !== 'string' ||
    field.localized ||
    hashJson(field.validators) !== hashJson({ required: {} }) ||
    (field.defaultValue !== null && field.defaultValue !== '')
  )
    invalid(
      `Model ${model.apiKey} must contain only a required nonlocalized string name field without a default.`,
    );
}

/**
 * Excluding a tracking model is safe only if ordinary content cannot reference
 * its receipts. Validate every schema model, including retained and block models.
 */
function assertNoTrackingReferences(
  schema: SchemaState,
  tracking: ModelSchema,
): void {
  for (const model of schema.models) {
    if (model.id === tracking.id) continue;
    for (const field of model.fields)
      for (const rule of Object.values(field.validators))
        if (
          object(rule) &&
          Array.isArray(rule.item_types) &&
          rule.item_types.includes(tracking.id)
        )
          invalid(
            `Field ${model.apiKey}.${field.apiKey} allows references to migration tracking model ${tracking.apiKey}.`,
          );
  }
}

function withoutTrackingModel(
  schema: SchemaState,
  model: ModelSchema | null,
): SchemaState {
  const projected: SchemaState = {
    ...schema,
    models: model
      ? schema.models.filter((candidate) => candidate.id !== model.id)
      : [...schema.models],
    hash: '',
  };
  projected.hash = schemaHash(projected);
  return projected;
}

/** Capture the exact configured tracking identity and project it at generation. */
export function prepareMigrationSchema(
  schema: SchemaState,
  apiKey = 'schema_migration',
): { schema: SchemaState; tracking: MigrationTrackingBinding } {
  if (!apiKey)
    invalid('The migration tracking model API key must be nonempty.');
  const matches = schema.models.filter((model) => model.apiKey === apiKey);
  if (matches.length > 1)
    invalid(`Migration model API key ${apiKey} is ambiguous.`);
  const model = matches[0] ?? null;
  if (model) {
    assertCanonicalTrackingModel(model);
    assertNoTrackingReferences(schema, model);
  }
  return {
    schema: withoutTrackingModel(schema, model),
    tracking: {
      apiKey,
      model: model ? { id: model.id, nameFieldId: model.fields[0].id } : null,
    },
  };
}

/**
 * Project the recorded identity during execution. Undefined host metadata is
 * the content:apply path; null explicitly means the native runner failed to
 * establish its tracking model and cannot safely execute this migration.
 */
export function projectMigrationSchema(
  schema: SchemaState,
  binding: MigrationTrackingBinding,
  runtimeTrackingModel?: RuntimeTrackingModel,
): SchemaState {
  if (!binding.apiKey)
    invalid('The recorded migration tracking API key is missing.');
  if (runtimeTrackingModel === null)
    invalid('The migration runner did not establish a tracking model.');
  if (runtimeTrackingModel && runtimeTrackingModel.apiKey !== binding.apiKey)
    invalid('The migration runner uses a different tracking model API key.');

  const boundId = binding.model?.id;
  if (boundId && runtimeTrackingModel && runtimeTrackingModel.id !== boundId)
    invalid(
      'The migration runner tracking model differs from the generated identity.',
    );
  if (
    !boundId &&
    runtimeTrackingModel &&
    !runtimeTrackingModel.createdByThisRun
  )
    invalid(
      'An unrecorded tracking model was not created by this migration run.',
    );

  const expectedId = boundId ?? runtimeTrackingModel?.id;
  const candidates = schema.models.filter((model) =>
    expectedId
      ? model.id === expectedId || model.apiKey === binding.apiKey
      : model.apiKey === binding.apiKey,
  );
  if (!expectedId) {
    if (candidates.length)
      invalid(
        'A tracking model appeared after generation without native runner ownership.',
      );
    return withoutTrackingModel(schema, null);
  }
  if (
    candidates.length !== 1 ||
    candidates[0].id !== expectedId ||
    candidates[0].apiKey !== binding.apiKey
  )
    invalid(
      'The exact migration tracking model is missing, renamed, or replaced.',
    );
  const model = candidates[0];
  assertCanonicalTrackingModel(model);
  if (binding.model && model.fields[0].id !== binding.model.nameFieldId)
    invalid('The recorded migration name field was replaced.');
  assertNoTrackingReferences(schema, model);
  return withoutTrackingModel(schema, model);
}
