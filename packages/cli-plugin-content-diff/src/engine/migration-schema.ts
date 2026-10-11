import { schemaHash } from './schema';
import type { SchemaState } from './types';

/** The API key the native migration runner gives its tracking model. */
export const DEFAULT_TRACKING_MODEL_API_KEY = 'schema_migration';

/**
 * The schema without the native migration runner's tracking model, which the
 * plugin never compares or writes. Generation removes it from both sides and
 * records its API key in the diff; apply removes it again before comparing
 * the destination schema hash.
 */
export function withoutTrackingModel(
  schema: SchemaState,
  apiKey: string,
): SchemaState {
  const projected: SchemaState = {
    ...schema,
    models: schema.models.filter((model) => model.apiKey !== apiKey),
    hash: '',
  };
  projected.hash = schemaHash(projected);
  return projected;
}
