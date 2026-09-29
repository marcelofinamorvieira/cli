// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { ItemTypeSchemaSnapshot, UniqueReleaseStep } from '../types';
import { isObject } from './json';

/** Why a unique-value release cannot be executed, naming the field. */
export interface UniqueReleaseFieldError {
  fieldApiKey: string;
  reason: string;
}

/**
 * Checks that a unique-value release only writes string or null values to
 * string, slug, or link fields of its owner that carry a unique validator.
 * A release without an owner model, or without fields, is rejected too.
 */
export function uniqueReleaseFieldError(
  itemType: ItemTypeSchemaSnapshot | null | undefined,
  release: Pick<UniqueReleaseStep, 'fields'>,
): UniqueReleaseFieldError | null {
  if (!itemType) {
    return {
      fieldApiKey: '<item-type>',
      reason: 'does not belong to a managed item type',
    };
  }
  const fields: unknown = release.fields;
  const fieldApiKeys = isObject(fields) ? Object.keys(fields).sort() : [];
  if (!isObject(fields) || fieldApiKeys.length === 0) {
    return { fieldApiKey: '<empty>', reason: 'contains no field release' };
  }
  for (const fieldApiKey of fieldApiKeys) {
    const field = itemType.fields.find(({ apiKey }) => apiKey === fieldApiKey);
    if (
      !field ||
      !['link', 'slug', 'string'].includes(field.fieldType) ||
      !isObject(field.validators) ||
      !Object.prototype.hasOwnProperty.call(field.validators, 'unique')
    ) {
      return {
        fieldApiKey,
        reason:
          'does not resolve to a string, slug, or link field carrying a unique validator',
      };
    }
    if (!isUniqueReleaseScalarValue(fields[fieldApiKey], field.localized)) {
      return {
        fieldApiKey,
        reason:
          'contains a non-scalar or embedded value instead of string/null unique data',
      };
    }
  }
  return null;
}

/** A string or null, or for a localized field an object of those. */
export function isUniqueReleaseScalarValue(
  value: unknown,
  localized: boolean,
): boolean {
  const isScalar = (candidate: unknown): boolean =>
    candidate === null || typeof candidate === 'string';
  if (!localized) return isScalar(value);
  return isObject(value) && Object.values(value).every(isScalar);
}
