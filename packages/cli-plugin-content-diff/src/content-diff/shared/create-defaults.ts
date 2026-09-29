// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  ContentDiffPlan,
  ItemTypeSchemaSnapshot,
  JsonObject,
  JsonValue,
  RecordPlan,
  SchemaSnapshot,
} from '../types';
import { projectPlanCreateSeedFields } from './create-seeds';
import { mapNonLocalizedFieldBlocks } from './embedded-blocks';
import { sharedFailure } from './failure-factory';
import { canonicalizeJson, isObject, semanticHash } from './json';
import {
  nestedBlockFields,
  nestedBlockIdentity,
  requireBlockType,
} from './nested-blocks';
import { compareStrings } from './ordering';

export interface CreateDefaultValueSuppression {
  fieldId: string;
  itemTypeId: string;
  originalDefaultValue: JsonValue;
  suppressedDefaultValue: JsonValue;
  originalHash: string;
  suppressedHash: string;
  allowedHashes: [string, string];
  affectedRecordIds: string[];
}

/** A field default that some CREATE would apply, while it is being collected. */
export interface CollectedCreateDefaultSuppression {
  fieldId: string;
  itemTypeId: string;
  originalDefaultValue: JsonValue;
  suppressedDefaultValue: JsonValue;
  affectedRecordIds: Set<string>;
}

/** Where applyCreateDefaultsToFields records the defaults a CREATE applies. */
export interface CreateDefaultSuppressionCollection {
  recordId: string;
  suppressions: Map<string, CollectedCreateDefaultSuppression>;
}

type CreateDefaultsSchema = Pick<SchemaSnapshot, 'itemTypes' | 'locales'>;

/**
 * Reproduces the CMA's create-time default filling on an already-canonical
 * record payload. Defaults are applied to top-level records and recursively to
 * every new nested block. Existing-record updates deliberately do not use this
 * transform: the CMA preserves explicit nulls on that path. With a
 * collection, every default that replaces a null is recorded as a suppression
 * candidate.
 */
export function applyCreateDefaultsToFields(
  fields: JsonObject,
  itemType: ItemTypeSchemaSnapshot,
  schema: CreateDefaultsSchema,
  collection?: CreateDefaultSuppressionCollection,
  prefix = '',
): JsonObject {
  const locales = localesFilledByCreate(fields, itemType, schema);
  const knownApiKeys = new Set(itemType.fields.map(({ apiKey }) => apiKey));
  const result: JsonObject = {};

  for (const field of itemType.fields) {
    const fieldPath = prefix ? `${prefix}.${field.apiKey}` : field.apiKey;
    const hasValue = Object.prototype.hasOwnProperty.call(fields, field.apiKey);
    let value: JsonValue = hasValue
      ? fields[field.apiKey]
      : field.localized
        ? Object.fromEntries(locales.map((locale) => [locale, null]))
        : null;

    if (field.localized && isCreateDefaultsJsonObject(value)) {
      const localizedValue: JsonObject = { ...value };
      for (const locale of locales) {
        if (!Object.prototype.hasOwnProperty.call(localizedValue, locale)) {
          localizedValue[locale] = null;
        }
      }
      const localizedDefault: JsonObject | null = isCreateDefaultsJsonObject(
        field.defaultValue,
      )
        ? field.defaultValue
        : null;
      if (localizedDefault !== null) {
        const suppressedLocales = Object.entries(localizedValue)
          .filter(
            ([locale, localeValue]) =>
              localeValue === null &&
              localizedDefault[locale] !== null &&
              localizedDefault[locale] !== undefined,
          )
          .map(([locale]) => locale);
        if (suppressedLocales.length > 0 && collection) {
          collectCreateDefaultSuppression(
            collection,
            itemType.id,
            field.id,
            localizedDefault,
            Object.fromEntries(
              Object.entries(localizedDefault).map(([locale, defaultValue]) => [
                locale,
                suppressedLocales.includes(locale) ? null : defaultValue,
              ]),
            ),
          );
        }
      }
      value = Object.fromEntries(
        Object.entries(localizedValue).map(([locale, localeValue]) => [
          locale,
          normalizeCreatedFieldValue(
            localeValue === null &&
              localizedDefault !== null &&
              localizedDefault[locale] !== null &&
              localizedDefault[locale] !== undefined
              ? localizedDefault[locale]
              : localeValue,
            field.fieldType,
            schema,
            fieldPath,
            collection,
          ),
        ]),
      );
    } else {
      if (value === null && cmaDefaultIsActive(field.defaultValue)) {
        if (collection) {
          collectCreateDefaultSuppression(
            collection,
            itemType.id,
            field.id,
            field.defaultValue,
            null,
          );
        }
        value = field.defaultValue;
      }
      value = normalizeCreatedFieldValue(
        value,
        field.fieldType,
        schema,
        fieldPath,
        collection,
      );
    }

    result[field.apiKey] = value;
  }

  for (const [key, value] of Object.entries(fields)) {
    if (!knownApiKeys.has(key)) {
      result[key] = canonicalizeJson(value);
    }
  }

  return canonicalizeJson(result) as JsonObject;
}

/**
 * Derives the smallest reversible schema-default change that makes every
 * planned CREATE seed byte-stable. Localized defaults are cleared only in the
 * locales where the CMA would otherwise replace an explicit/missing null.
 */
export function deriveCreateDefaultValueSuppressions(
  records: readonly Pick<
    RecordPlan,
    'action' | 'desired' | 'id' | 'itemTypeId'
  >[],
  schema: SchemaSnapshot,
  projectedCreateSeedFields: ReadonlyMap<string, JsonObject>,
): CreateDefaultValueSuppression[] {
  const collected = new Map<string, CollectedCreateDefaultSuppression>();

  for (const record of records) {
    if (record.action !== 'create' || !record.desired) continue;
    const itemType = schema.itemTypes.find(
      ({ id }) => id === record.itemTypeId,
    );
    if (!itemType) continue;
    const seedFields = projectedCreateSeedFields.get(record.id);
    if (!seedFields) {
      throw sharedFailure(
        'invalidPlan',
        `Missing projected phase-5 create seed for record ${record.id}.`,
        { recordId: record.id },
      );
    }
    applyCreateDefaultsToFields(seedFields, itemType, schema, {
      recordId: record.id,
      suppressions: collected,
    });
  }

  const candidates: CreateDefaultValueSuppression[] = [...collected.values()]
    .sort((left, right) => compareStrings(left.fieldId, right.fieldId))
    .map((entry) => {
      const originalHash = semanticHash(entry.originalDefaultValue);
      const suppressedHash = semanticHash(entry.suppressedDefaultValue);
      return {
        fieldId: entry.fieldId,
        itemTypeId: entry.itemTypeId,
        originalDefaultValue: entry.originalDefaultValue,
        suppressedDefaultValue: entry.suppressedDefaultValue,
        originalHash,
        suppressedHash,
        allowedHashes: [originalHash, suppressedHash],
        affectedRecordIds: [...entry.affectedRecordIds].sort(),
      };
    });

  const candidateSchema = schemaWithCreateDefaultSuppressions(
    schema,
    candidates,
  );
  const suppressions = candidates.filter((candidate) => {
    const withoutCandidate = schemaWithCreateDefaultSuppressions(
      schema,
      candidates.filter(({ fieldId }) => fieldId !== candidate.fieldId),
    );
    return records.some((record) => {
      if (record.action !== 'create' || !record.desired) return false;
      const seedFields = projectedCreateSeedFields.get(record.id);
      const suppressedItemType = candidateSchema.itemTypes.find(
        ({ id }) => id === record.itemTypeId,
      );
      const restoredItemType = withoutCandidate.itemTypes.find(
        ({ id }) => id === record.itemTypeId,
      );
      if (!seedFields || !suppressedItemType || !restoredItemType) return false;
      return (
        semanticHash(
          applyCreateDefaultsToFields(
            seedFields,
            suppressedItemType,
            candidateSchema,
          ),
        ) !==
        semanticHash(
          applyCreateDefaultsToFields(
            seedFields,
            restoredItemType,
            withoutCandidate,
          ),
        )
      );
    });
  });
  const suppressedSchema = schemaWithCreateDefaultSuppressions(
    schema,
    suppressions,
  );
  const defaultsDisabledSchema = schemaWithAllCreateDefaultsDisabled(schema);
  for (const record of records) {
    if (record.action !== 'create' || !record.desired) continue;
    const seedFields = projectedCreateSeedFields.get(record.id);
    const itemType = suppressedSchema.itemTypes.find(
      ({ id }) => id === record.itemTypeId,
    );
    if (!seedFields || !itemType) continue;
    const defaultsDisabledItemType = defaultsDisabledSchema.itemTypes.find(
      ({ id }) => id === record.itemTypeId,
    );
    if (!defaultsDisabledItemType) continue;
    const filled = applyCreateDefaultsToFields(
      seedFields,
      itemType,
      suppressedSchema,
    );
    const expected = applyCreateDefaultsToFields(
      seedFields,
      defaultsDisabledItemType,
      defaultsDisabledSchema,
    );
    if (semanticHash(filled) !== semanticHash(expected)) {
      throw sharedFailure(
        'invalidPlan',
        `Exact temporary field-default suppression cannot reproduce the planned create seed for record ${record.id}.`,
        {
          recordId: record.id,
          expectedCreateHash: semanticHash(expected),
          modeledCreateHash: semanticHash(filled),
        },
      );
    }
  }

  return suppressions;
}

/**
 * The default suppressions an executable plan needs, derived from the exact
 * phase-5 create seeds over plan.schema.
 */
export function planCreateDefaultValueSuppressions(
  plan: Pick<ContentDiffPlan, 'execution' | 'records' | 'schema'>,
): CreateDefaultValueSuppression[] {
  return deriveCreateDefaultValueSuppressions(
    plan.records,
    plan.schema,
    projectPlanCreateSeedFields(plan),
  );
}

export function schemaWithAllCreateDefaultsDisabled<
  Schema extends Pick<SchemaSnapshot, 'itemTypes'>,
>(schema: Schema): Schema {
  return {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field) => ({
        ...field,
        defaultValue: null,
      })),
    })),
  };
}

export function schemaWithCreateDefaultSuppressions<
  Schema extends Pick<SchemaSnapshot, 'itemTypes'>,
>(
  schema: Schema,
  suppressions: readonly Pick<
    CreateDefaultValueSuppression,
    'fieldId' | 'suppressedDefaultValue'
  >[],
): Schema {
  const byFieldId = new Map(
    suppressions.map((suppression) => [suppression.fieldId, suppression]),
  );
  return {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field) => {
        const suppression = byFieldId.get(field.id);
        return suppression
          ? { ...field, defaultValue: suppression.suppressedDefaultValue }
          : field;
      }),
    })),
  };
}

/**
 * The locales a CREATE fills: every project locale when the model requires
 * all of them, otherwise those of the first localized field present.
 */
function localesFilledByCreate(
  fields: JsonObject,
  itemType: ItemTypeSchemaSnapshot,
  schema: CreateDefaultsSchema,
): string[] {
  if (itemType.allLocalesRequired) return [...schema.locales];
  const firstLocalizedField = itemType.fields.find(
    ({ apiKey, localized }) =>
      localized && Object.prototype.hasOwnProperty.call(fields, apiKey),
  );
  if (!firstLocalizedField) return [];
  const value = fields[firstLocalizedField.apiKey];
  return isCreateDefaultsJsonObject(value) ? Object.keys(value) : [];
}

function normalizeCreatedFieldValue(
  value: JsonValue,
  fieldType: string,
  schema: CreateDefaultsSchema,
  fieldPath: string,
  collection?: CreateDefaultSuppressionCollection,
): JsonValue {
  if (value === null) {
    if (fieldType === 'string' || fieldType === 'text') return '';
    if (fieldType === 'boolean') return false;
    return null;
  }
  if (
    fieldType === 'rich_text' ||
    fieldType === 'single_block' ||
    fieldType === 'structured_text'
  ) {
    return mapNonLocalizedFieldBlocks(value, fieldType, (block) =>
      applyCreateDefaultsToEmbeddedValue(block, schema, fieldPath, collection),
    );
  }
  return canonicalizeJson(value);
}

/**
 * Applies create defaults inside every nested block of an embedded value.
 * Each block must resolve to a block model of the schema.
 */
function applyCreateDefaultsToEmbeddedValue(
  value: JsonValue,
  schema: CreateDefaultsSchema,
  fieldPath: string,
  collection?: CreateDefaultSuppressionCollection,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((child) =>
      applyCreateDefaultsToEmbeddedValue(child, schema, fieldPath, collection),
    );
  }
  if (!isCreateDefaultsJsonObject(value)) return canonicalizeJson(value);

  const identity = nestedBlockIdentity(value, fieldPath);
  if (identity) {
    const blockType = requireBlockType(schema, identity, fieldPath);
    return canonicalizeJson({
      ...value,
      attributes: applyCreateDefaultsToFields(
        canonicalizeJson(nestedBlockFields(value, fieldPath)) as JsonObject,
        blockType,
        schema,
        collection,
        `${fieldPath}.block:${identity.id}`,
      ),
    });
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      applyCreateDefaultsToEmbeddedValue(child, schema, fieldPath, collection),
    ]),
  );
}

function collectCreateDefaultSuppression(
  collection: CreateDefaultSuppressionCollection,
  itemTypeId: string,
  fieldId: string,
  originalDefaultValue: JsonValue,
  suppressedDefaultValue: JsonValue,
): void {
  const existing = collection.suppressions.get(fieldId);
  if (!existing) {
    collection.suppressions.set(fieldId, {
      fieldId,
      itemTypeId,
      originalDefaultValue: canonicalizeJson(originalDefaultValue),
      suppressedDefaultValue: canonicalizeJson(suppressedDefaultValue),
      affectedRecordIds: new Set([collection.recordId]),
    });
    return;
  }
  existing.affectedRecordIds.add(collection.recordId);
  if (
    isCreateDefaultsJsonObject(existing.suppressedDefaultValue) &&
    isCreateDefaultsJsonObject(suppressedDefaultValue)
  ) {
    const existingSuppressedDefault: JsonObject =
      existing.suppressedDefaultValue;
    existing.suppressedDefaultValue = canonicalizeJson({
      ...existingSuppressedDefault,
      ...Object.fromEntries(
        Object.entries(suppressedDefaultValue).filter(
          ([locale, value]) =>
            value === null || existingSuppressedDefault[locale] === undefined,
        ),
      ),
    });
  }
}

/** Ruby's `if field.default_value` treats only nil and false as inactive. */
function cmaDefaultIsActive(value: JsonValue | undefined): value is JsonValue {
  return value !== undefined && value !== null && value !== false;
}

function isCreateDefaultsJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return isObject(value);
}
