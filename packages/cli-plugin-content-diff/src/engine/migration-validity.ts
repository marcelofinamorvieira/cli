import { CmaClient } from '@datocms/cli-utils';
import { boundedWork } from './apply-work';
import { assertNotAborted } from './cancellation';
import { inspectRecord, recordPayloadFields } from './codec';
import { ContentError } from './errors';
import type { IntentRecorder, IntentValidation } from './migration-intent';
import {
  aggregateFields,
  fieldNeedsDefaultSuppression,
} from './planner-validity';
import type { SnapshotStore } from './store';
import type { Client, SchemaState } from './types';

// These are native value validators. Structural relationship/block validators
// and INVALID_FORMAT are intentionally excluded: those cannot establish the
// validity of the desired record in this destination context.
const VALUE_VALIDATORS = new Set([
  'VALIDATION_REQUIRED',
  'VALIDATION_SIZE',
  'VALIDATION_LENGTH',
  'VALIDATION_ENUM',
  'VALIDATION_NUMBER_RANGE',
  'VALIDATION_UNIQUE',
  'VALIDATION_FORMAT',
  'VALIDATION_SLUG_FORMAT',
  'VALIDATION_SLUG_TITLE_FIELD',
  'VALIDATION_DATE_RANGE',
  'VALIDATION_DATE_TIME_RANGE',
  'VALIDATION_TITLE_LENGTH',
  'VALIDATION_DESCRIPTION_LENGTH',
  'VALIDATION_REQUIRED_SEO_FIELDS',
  'VALIDATION_REQUIRED_ALT_TITLE',
  'VALIDATION_EXTENSION',
  'VALIDATION_IMAGE_DIMENSIONS',
  'VALIDATION_IMAGE_ASPECT_RATIO',
  'VALIDATION_FILE_SIZE',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ordinaryFieldFailure(error: unknown, schema: SchemaState): boolean {
  if (!(error instanceof CmaClient.ApiError) || error.response.status !== 422)
    return false;
  const body: unknown = error.response.body;
  if (!object(body) || !Array.isArray(body.data) || body.data.length === 0)
    return false;
  const fields = new Map(
    schema.models.flatMap((model) =>
      model.fields.map((field) => [field.id, field] as const),
    ),
  );
  return body.data.every((entry: unknown) => {
    if (!object(entry) || !object(entry.attributes)) return false;
    const attributes = entry.attributes;
    const details = attributes.details;
    if (
      attributes.code !== 'INVALID_FIELD' ||
      !object(details) ||
      typeof details.code !== 'string' ||
      !VALUE_VALIDATORS.has(details.code) ||
      typeof details.field_id !== 'string' ||
      !fields.has(details.field_id) ||
      typeof details.field !== 'string' ||
      details.field.length === 0
    )
      return false;
    return true;
  });
}

function unsupported(entry: IntentValidation, reason: string): never {
  throw new ContentError(
    'UNSUPPORTED_EDIT_VALIDATION',
    `Cannot validate edited ${entry.slice} content for record ${entry.recordId} before writes: ${reason}`,
    { recordId: entry.recordId, slice: entry.slice },
  );
}

/**
 * Validate only edited slices whose fields no longer match captured evidence.
 * These native validation endpoints do not save records or persist validity
 * stamps. Unexpected failures remain failures, never invented validity data.
 */
export async function resolveIntentValidity(args: {
  recorder: IntentRecorder;
  store: SnapshotStore;
  schema: SchemaState;
  client: Client;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { recorder, store, schema, client, signal } = args;
  const models = new Map(schema.models.map((model) => [model.id, model]));
  await boundedWork(
    recorder.needsValidation(),
    args.concurrency ?? 4,
    async (entry) => {
      assertNotAborted(signal);
      const state = store.getRecord('source', entry.recordId);
      const model = models.get(entry.modelId);
      if (!state || !model)
        unsupported(entry, 'the intended record or model is missing.');
      const baseline = store.getRecord('target', entry.recordId);
      // A validation call reads today's destination, not the future records
      // and binaries a script intends to create. Never misclassify missing
      // dependencies or old file metadata as invalid desired content.
      const inspected = inspectRecord(
        { ...state, current: entry.fields, published: null },
        schema,
      );
      for (const reference of inspected.references) {
        if (reference.kind === 'upload') {
          const previous = store.getUpload('target', reference.targetId);
          const desired = store.getUpload('source', reference.targetId);
          if (!previous || !desired || previous.hash !== desired.hash)
            unsupported(
              entry,
              `referenced upload ${reference.targetId} is new, removed, or changed by this migration.`,
            );
        } else if (
          !store.getRecord('target', reference.targetId) ||
          !store.getRecord('source', reference.targetId)
        ) {
          unsupported(
            entry,
            `referenced record ${reference.targetId} is unavailable in the current destination.`,
          );
        }
      }
      // validateNew fills defaults, as does validation of every nested block
      // whose ID is stripped below. Its success would prove the defaulted
      // value, not the explicit null that the script intends to preserve.
      for (const value of aggregateFields(entry.fields, model, schema)) {
        if (
          (!baseline || value.blockId !== null) &&
          fieldNeedsDefaultSuppression(value.field, value.value)
        )
          unsupported(
            entry,
            `native validation would replace null with the default of ${value.field.apiKey}.`,
          );
      }
      const payload = recordPayloadFields(entry.fields, entry.modelId, schema, {
        validation: true,
      });
      let valid: boolean;
      try {
        if (baseline) {
          await client.items.validateExisting(
            entry.recordId,
            payload as Parameters<Client['items']['validateExisting']>[1],
          );
        } else {
          await client.items.validateNew({
            ...payload,
            item_type: { id: entry.modelId, type: 'item_type' },
          } as Parameters<Client['items']['validateNew']>[0]);
        }
        valid = true;
      } catch (error) {
        assertNotAborted(signal);
        if (ordinaryFieldFailure(error, schema)) valid = false;
        else if (
          error instanceof CmaClient.ApiError &&
          error.response.status === 422
        )
          unsupported(
            entry,
            'DatoCMS returned structural or inconclusive validation errors.',
          );
        else throw error;
      }
      assertNotAborted(signal);
      recorder.resolveValidity({ ...entry, valid });
    },
    (entry) => entry.recordId,
    signal,
  );
  recorder.assertReady();
}
