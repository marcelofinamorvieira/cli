// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import { createHash } from 'node:crypto';
import type { JsonValue } from '../types';
import { sharedFailure } from './failure-factory';
import { compareStrings } from './ordering';

/** A plain JSON-like object: not null and not an array. */
export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted by code unit, undefined members dropped,
 * and -0 written as 0. Non-finite numbers and non-JSON values are rejected.
 */
export function canonicalizeJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw sharedFailure(
        'invalidJson',
        'Content contains a non-finite numeric value.',
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort(compareStrings)
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  }
  throw sharedFailure(
    'invalidJson',
    `Content contains a non-JSON value (${typeof value}).`,
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function semanticHash(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Canonical JSON indented by two spaces, as stored in mapping documents. */
export function canonicalPrettyStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value), null, 2);
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
