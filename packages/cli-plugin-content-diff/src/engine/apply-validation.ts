import { hashJson, inspectRecord, object } from './codec';
import { ContentError } from './errors';
import {
  aggregateFields,
  creationEmptyValue,
  fieldFailures,
  fieldNeedsDefaultSuppression,
} from './planner-validity';
import type { SnapshotStore } from './store';
import type { RecordPlan, SchemaState, TemporarySchemaChange } from './types';

/** Imported seeds may defer typed references, never introduce arbitrary prose. */
export function validateExecution(args: {
  entry: RecordPlan;
  store: SnapshotStore;
  schema: SchemaState;
  changes: TemporarySchemaChange[];
}): void {
  const { entry, store, schema, changes } = args;
  if (entry.action === 'noop' || entry.action === 'skip') return;
  const invalid = (reason: string): never => {
    throw new ContentError('INVALID_BUNDLE', `Record ${entry.id}: ${reason}`);
  };
  if (entry.action === 'update' && !entry.baseline?.currentVersion)
    invalid('missing optimistic locking version');
  for (const key of [
    'createOrder',
    'updateOrder',
    'publishOrder',
    'deleteOrder',
  ] as const) {
    const rank = entry.execution?.[key];
    if (rank !== undefined && (!Number.isSafeInteger(rank) || rank < 0))
      invalid('invalid execution rank');
  }
  if (entry.execution?.preclearFieldIds?.length)
    invalid('unsupported field preclear operation');
  const seed = entry.execution?.creationFields;
  if (!seed) return;
  if (entry.action !== 'create' || !entry.desired)
    invalid('creation fields without a create action');
  const desired = entry.desired!;
  const model = schema.models.find(
    (candidate) => candidate.id === entry.modelId,
  );
  if (!model) invalid('unknown creation model');
  const original = desired.published ?? desired.current;
  if (
    hashJson(Object.keys(original).sort()) !==
    hashJson(Object.keys(seed).sort())
  )
    invalid('creation seed changes its field set');
  const references = inspectRecord(
    { ...desired, current: original, published: null },
    schema,
  ).references;
  for (const [key, value] of Object.entries(seed)) {
    if (hashJson(value) === hashJson(original[key])) continue;
    const deferred = references.some(
      (reference) =>
        reference.kind !== 'upload' &&
        (reference.path === key || reference.path.startsWith(`${key}.`)) &&
        store.getPlan('record', reference.targetId)?.action === 'create',
    );
    const field = model!.fields.find((candidate) => candidate.apiKey === key);
    const emptyValue = creationEmptyValue(field?.type ?? '');
    const preservesLocaleKeys =
      field?.localized &&
      object(value) &&
      object(original[key]) &&
      hashJson(Object.keys(value).sort()) ===
        hashJson(Object.keys(original[key] as object).sort()) &&
      Object.values(value).every(
        (localeValue) => hashJson(localeValue) === hashJson(emptyValue),
      );
    if (
      !deferred ||
      !(field?.localized
        ? preservesLocaleKeys
        : hashJson(value) === hashJson(emptyValue))
    )
      invalid('creation seed replaces an undeferred field');
  }
  for (const field of aggregateFields(seed, model!, schema)) {
    const change = changes.find(
      (candidate) => candidate.fieldId === field.field.id,
    );
    const effective = change
      ? {
          ...field.field,
          validators: change.temporary.validators,
          defaultValue: change.temporary.defaultValue,
        }
      : field.field;
    if (
      !(model!.draftMode && model!.saveInvalidDrafts) &&
      fieldFailures(effective, field.value).length
    )
      invalid('creation seed requires an undeclared validator relaxation');
    if (fieldNeedsDefaultSuppression(effective, field.value))
      invalid('creation seed requires an undeclared default suppression');
  }
}
