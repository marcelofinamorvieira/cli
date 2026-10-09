import { ContentError } from './errors';
import { schemaHash } from './schema';
import type { ModelSchema, SchemaState } from './types';

/** Generation records absence too, rather than ignoring a model by name later. */
export interface MigrationTrackingBinding {
  apiKey: string;
  model: { id: string } | null;
}

function invalid(message: string): never {
  throw new ContentError('INVALID_MIGRATION_TRACKING_MODEL', message);
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

/**
 * Excludes the configured migration tracking model, which the native
 * migration runner writes to, and binds its exact identity at generation.
 */
export function prepareMigrationSchema(
  schema: SchemaState,
  apiKey = 'schema_migration',
): { schema: SchemaState; tracking: MigrationTrackingBinding } {
  if (!apiKey)
    invalid('The migration tracking model API key must be nonempty.');
  const model = schema.models.find((entry) => entry.apiKey === apiKey) ?? null;
  return {
    schema: withoutTrackingModel(schema, model),
    tracking: { apiKey, model: model ? { id: model.id } : null },
  };
}

/** Excludes the tracking model bound at generation, refusing a replaced one. */
export function projectMigrationSchema(
  schema: SchemaState,
  binding: MigrationTrackingBinding,
): SchemaState {
  if (!binding.model) return withoutTrackingModel(schema, null);
  const expectedId = binding.model.id;
  const model = schema.models.find((entry) => entry.id === expectedId);
  if (!model || model.apiKey !== binding.apiKey)
    invalid(
      'The exact migration tracking model is missing, renamed, or replaced.',
    );
  return withoutTrackingModel(schema, model);
}
