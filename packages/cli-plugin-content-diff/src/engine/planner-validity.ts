import { hashJson, modelIndex } from './codec';
import type {
  FieldSchema,
  JsonObject,
  JsonValue,
  ModelSchema,
  SchemaState,
} from './types';

export interface FieldFailure {
  field: FieldSchema;
  modelId: string;
  validator: string;
}

/** Native collection fields use arrays; nullable singular fields use null. */
export function creationEmptyValue(type: string): JsonValue {
  return type === 'rich_text' || type === 'links' ? [] : null;
}

/** Native localized field settings require every environment locale. */
export function suppressedDefaultValue(
  field: Pick<FieldSchema, 'localized'>,
  locales: string[],
): JsonValue {
  return field.localized
    ? Object.fromEntries(locales.map((locale) => [locale, null]))
    : null;
}

function object(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function empty(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === 'string') return /^\p{White_Space}*$/u.test(value);
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

const EMPTY_DAST = hashJson({
  schema: 'dast',
  document: {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'span', value: '' }] }],
  },
});

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length++;
  return length;
}

function validatorSize(
  field: FieldSchema,
  value: JsonValue | undefined,
): number {
  if (field.type === 'structured_text') {
    if (!object(value)) return 0;
    let length = 0;
    const pending: JsonValue[] = [value.document ?? null];
    while (pending.length) {
      const node = pending.pop();
      if (!object(node)) continue;
      if (node.type === 'span' && typeof node.value === 'string')
        length += characterLength(node.value);
      if (node.type === 'code' && typeof node.code === 'string')
        length += characterLength(node.code);
      if (Array.isArray(node.children)) pending.push(...node.children);
    }
    return length;
  }
  if (['rich_text', 'gallery', 'links', 'tokens'].includes(field.type))
    return value === null || value === undefined
      ? 0
      : Array.isArray(value)
        ? value.length
        : 1;
  return characterLength(
    value === null || value === undefined ? '' : String(value),
  );
}

/** Mirrors the native Required/Size/Length/Enum/NumberRange value checks. */
export function fieldFailures(
  field: FieldSchema,
  value: JsonValue | undefined,
): string[] {
  const failures: string[] = [];
  const values =
    field.localized && object(value) ? Object.values(value) : [value];
  for (const [key, config] of Object.entries(field.validators)) {
    if (
      key === 'required' &&
      values.some(
        (entry) =>
          empty(entry) ||
          (field.type === 'structured_text' &&
            object(entry) &&
            hashJson(entry) === EMPTY_DAST),
      )
    )
      failures.push(key);
    if ((key === 'size' || key === 'length') && object(config)) {
      const bounded = ['min', 'max', 'eq'].some(
        (name) => typeof config[name] === 'number',
      );
      if (
        values.some((entry) => {
          const size = validatorSize(field, entry);
          return (
            (typeof config.min === 'number' && size < config.min) ||
            (typeof config.max === 'number' && size > config.max) ||
            (typeof config.eq === 'number' && size !== config.eq) ||
            (bounded &&
              typeof config.multiple_of === 'number' &&
              size % config.multiple_of !== 0)
          );
        })
      )
        failures.push(key);
    }
    if (
      key === 'number_range' &&
      object(config) &&
      values.some(
        (entry) =>
          typeof entry === 'number' &&
          ((typeof config.min === 'number' && entry < config.min) ||
            (typeof config.max === 'number' && entry > config.max)),
      )
    )
      failures.push(key);
    if (key === 'enum' && object(config) && Array.isArray(config.values)) {
      const allowed = config.values;
      if (
        values.some(
          (entry) => !empty(entry) && !allowed.includes(entry as JsonValue),
        )
      )
        failures.push(key);
    }
  }
  return [...new Set(failures)];
}

export function provenFailures(
  fields: JsonObject,
  model: ModelSchema,
  schema: SchemaState,
): FieldFailure[] {
  const failures: FieldFailure[] = [];
  for (const entry of aggregateFields(fields, model, schema)) {
    for (const validator of fieldFailures(entry.field, entry.value))
      failures.push({ field: entry.field, modelId: entry.modelId, validator });
  }
  return failures;
}

export function* aggregateFields(
  fields: JsonObject,
  model: ModelSchema,
  schema: SchemaState,
): Generator<{
  field: FieldSchema;
  modelId: string;
  blockId: string | null;
  value: JsonValue | undefined;
}> {
  const models = modelIndex(schema);
  const queue: {
    fields: JsonObject;
    model: ModelSchema;
    blockId: string | null;
  }[] = [{ fields, model, blockId: null }];
  // The queue is bounded by one captured aggregate, never the project size.
  while (queue.length) {
    const entry = queue.pop()!;
    for (const field of entry.model.fields) {
      yield {
        field,
        modelId: entry.model.id,
        blockId: entry.blockId,
        value: entry.fields[field.apiKey],
      };
      if (
        !['rich_text', 'single_block', 'structured_text'].includes(field.type)
      )
        continue;
      const pending: JsonValue[] = [entry.fields[field.apiKey] ?? null];
      while (pending.length) {
        const value = pending.pop();
        if (Array.isArray(value)) pending.push(...value);
        else if (object(value)) {
          if (
            typeof value.__itemTypeId === 'string' &&
            object(value.attributes)
          ) {
            const block = models.get(value.__itemTypeId);
            if (block)
              queue.push({
                fields: value.attributes,
                model: block,
                blockId: typeof value.id === 'string' ? value.id : null,
              });
          } else pending.push(...Object.values(value));
        }
      }
    }
  }
}

export function fieldNeedsDefaultSuppression(
  field: FieldSchema,
  value: JsonValue | undefined,
): boolean {
  if (field.defaultValue === null) return false;
  if (field.localized && object(value)) {
    return Object.entries(value).some(([locale, entry]) => {
      if (entry !== null) return false;
      const configured = object(field.defaultValue)
        ? field.defaultValue[locale]
        : field.defaultValue;
      return configured !== null && configured !== undefined;
    });
  }
  return value === null || value === undefined;
}
