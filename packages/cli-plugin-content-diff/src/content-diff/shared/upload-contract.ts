// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { ContentDiffPlan, UploadPlan, UploadSnapshot } from '../types';
import { sharedFailure } from './failure-factory';
import { isPortableDatoId } from './ids';
import { semanticHash, stableStringify } from './json';

const UPLOAD_MANUAL_KEYS = [
  'author',
  'collectionId',
  'copyright',
  'defaultFieldMetadata',
  'notes',
  'tags',
] as const;

const UPLOAD_SNAPSHOT_KEYS = [
  'basename',
  'consistency',
  'filename',
  'hash',
  'id',
  'manual',
  'md5',
  'mimeType',
  'size',
  'transport',
] as const;

/**
 * The final extension of a filename, dot included, or '' when it has none.
 * Missing filenames read as '' because the runtime also passes live CMA
 * values here.
 */
export function uploadFilenameExtension(filename: unknown): string {
  const value = String(filename || '');
  const finalSlash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const finalDot = value.lastIndexOf('.');

  return finalDot > finalSlash + 1 ? value.slice(finalDot) : '';
}

/** The filename stem DatoCMS derives as an upload's basename. */
export function uploadBasenameFromFilename(filename: unknown): string {
  const value = String(filename || '');
  const finalSlash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const finalDot = value.lastIndexOf('.');
  const stemEnd = finalDot > finalSlash + 1 ? finalDot : value.length;
  return value.slice(finalSlash + 1, stemEnd);
}

/**
 * The staged binary's file name for an upload (callers append `.bin`): the
 * upload ID with every character outside `[A-Za-z0-9_-]` replaced by `_`.
 * Bundling at generation and staging at execution use the same name.
 */
export function uploadStagingFilename(id: string): string {
  const filename = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  if (!filename) {
    throw sharedFailure(
      'invalidUploadId',
      `Cannot derive a staging filename from upload ID "${String(id)}".`,
    );
  }
  return filename;
}

export function compareUploadChanges(
  desired: UploadSnapshot,
  baseline: UploadSnapshot,
): UploadPlan['changes'] {
  const desiredMetadata = {
    basename: desired.basename,
    filename: desired.filename,
    manual: { ...desired.manual, collectionId: null },
  };
  const baselineMetadata = {
    basename: baseline.basename,
    filename: baseline.filename,
    manual: { ...baseline.manual, collectionId: null },
  };

  return {
    binary:
      desired.md5 !== baseline.md5 ||
      uploadFilenameExtension(desired.filename) !==
        uploadFilenameExtension(baseline.filename),
    metadata:
      stableStringify(desiredMetadata) !== stableStringify(baselineMetadata),
    collection: desired.manual.collectionId !== baseline.manual.collectionId,
  };
}

export function uploadManualMetadataChanged(
  baseline: UploadSnapshot,
  desired: UploadSnapshot,
): boolean {
  const baselineManual = { ...baseline.manual, collectionId: null };
  const desiredManual = { ...desired.manual, collectionId: null };
  return stableStringify(baselineManual) !== stableStringify(desiredManual);
}

/**
 * Proves that the current UploadRequest filename normalizer will preserve the
 * requested filename byte-for-byte. The API transliterates and lowercases,
 * replaces non `[a-z0-9_-]` bytes with `-`, collapses adjacent separators,
 * and trims separators. Restricting both parts to this ASCII fixed-point
 * language is deliberately fail-closed for Unicode transliteration.
 */
export function isUploadRequestFilenameFixedPoint(filename: unknown): boolean {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    containsAsciiControl(filename)
  ) {
    return false;
  }

  const extension = uploadFilenameExtension(filename);
  const basename = uploadBasenameFromFilename(filename);
  const fixedPointPart = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

  if (!fixedPointPart.test(basename)) return false;
  if (extension && !fixedPointPart.test(extension.slice(1))) return false;

  return `${basename}${extension}` === filename;
}

export function uploadPlanRequiresFilenameRequest(upload: UploadPlan): boolean {
  if (upload.action === 'create') return true;
  if (upload.action !== 'update' || !upload.baseline || !upload.desired) {
    return false;
  }
  const changes = compareUploadChanges(upload.desired, upload.baseline);
  return (
    changes.binary ||
    upload.baseline.basename !== upload.desired.basename ||
    upload.baseline.filename !== upload.desired.filename
  );
}

export function uploadPlanRequiresBinaryTransfer(upload: UploadPlan): boolean {
  if (upload.action === 'create') return true;
  return (
    upload.action === 'update' &&
    Boolean(
      upload.baseline &&
        upload.desired &&
        compareUploadChanges(upload.desired, upload.baseline).binary,
    )
  );
}

/**
 * The exact change flags an upload plan must declare, or null when its action
 * and snapshots do not determine them. Every call returns a fresh object.
 */
export function expectedUploadPlanChanges(
  upload: UploadPlan,
): UploadPlan['changes'] | null {
  if (upload.action === 'create') {
    return { binary: true, metadata: true, collection: true };
  }
  if (upload.action === 'delete' || upload.action === 'noop') {
    return { binary: false, metadata: false, collection: false };
  }
  if (upload.action === 'update' && upload.baseline && upload.desired) {
    return compareUploadChanges(upload.desired, upload.baseline);
  }
  return null;
}

/**
 * Why an upload plan cannot be executed exactly, or null when it can. A
 * missing plan entry reads as an invalid action.
 */
export function uploadPlanContractError(
  upload: UploadPlan,
  schema: ContentDiffPlan['schema'],
): string | null {
  if (
    !upload ||
    !['create', 'update', 'delete', 'noop'].includes(upload.action)
  ) {
    return 'action is invalid';
  }
  const { action, baseline, desired } = upload;
  if (action === 'create' && !isPortableDatoId(upload.id)) {
    return 'create ID is not a portable DatoCMS ID';
  }

  if (baseline && baseline.id !== upload.id) {
    return 'baseline ID does not match the plan ID';
  }
  if (desired && desired.id !== upload.id) {
    return 'desired ID does not match the plan ID';
  }

  if (
    (action === 'create' &&
      (baseline !== null || !desired || upload.expectedTargetHash !== null)) ||
    (action === 'update' &&
      (!baseline || !desired || upload.expectedTargetHash !== baseline.hash)) ||
    (action === 'delete' &&
      (!baseline ||
        desired !== null ||
        upload.expectedTargetHash !== baseline.hash)) ||
    (action === 'noop' &&
      (!baseline ||
        !desired ||
        baseline.hash !== desired.hash ||
        upload.expectedTargetHash !== baseline.hash))
  ) {
    return `action ${action} is inconsistent with baseline, desired, or expectedTargetHash`;
  }

  for (const [label, snapshot] of [
    ['baseline', baseline],
    ['desired', desired],
  ] as const) {
    if (
      snapshot &&
      (stableStringify(Object.keys(snapshot).sort()) !==
        stableStringify(UPLOAD_SNAPSHOT_KEYS) ||
        typeof snapshot.id !== 'string' ||
        snapshot.id.length === 0 ||
        typeof snapshot.md5 !== 'string' ||
        !/^[a-f0-9]{32}$/.test(snapshot.md5) ||
        typeof snapshot.basename !== 'string' ||
        snapshot.basename.length === 0 ||
        typeof snapshot.filename !== 'string' ||
        snapshot.filename.length === 0 ||
        typeof snapshot.hash !== 'string' ||
        !Number.isSafeInteger(snapshot.size) ||
        snapshot.size < 0 ||
        (snapshot.mimeType !== null && typeof snapshot.mimeType !== 'string') ||
        uploadTransportContractError(snapshot.transport, false) !== null ||
        uploadConsistencyContractError(snapshot.consistency) !== null ||
        uploadManualContractError(snapshot, schema, false) !== null)
    ) {
      return `${label} snapshot is malformed`;
    }
    if (
      snapshot &&
      snapshot.basename !== uploadBasenameFromFilename(snapshot.filename)
    ) {
      return `${label} basename does not match its filename stem`;
    }
    if (
      snapshot &&
      snapshot.hash !==
        semanticHash({
          id: snapshot.id,
          md5: snapshot.md5,
          basename: snapshot.basename,
          filename: snapshot.filename,
          manual: snapshot.manual,
        })
    ) {
      return `${label} semantic hash does not match its upload state`;
    }
  }

  if (desired && uploadPlanRequiresDefaultFieldMetadataWrite(upload)) {
    const metadataError = uploadDefaultFieldMetadataContractError(
      desired.manual.defaultFieldMetadata,
      schema,
      desired,
      true,
    );
    if (metadataError) {
      return `desired defaultFieldMetadata is not safely writable: ${metadataError}`;
    }
  }

  const expectedChanges = expectedUploadPlanChanges(upload);
  if (
    !expectedChanges ||
    stableStringify(upload.changes) !== stableStringify(expectedChanges)
  ) {
    return 'changes do not match the exact baseline/desired deltas';
  }
  if (action === 'update' && !Object.values(expectedChanges).some(Boolean)) {
    return 'update action has no baseline/desired delta';
  }

  if (
    desired &&
    uploadPlanRequiresBinaryTransfer(upload) &&
    uploadTransportContractError(desired.transport, true) !== null
  ) {
    return 'desired binary transport is not an exact HTTP(S) or bundled source contract';
  }
  if (
    desired &&
    uploadPlanRequiresFilenameRequest(upload) &&
    !isUploadRequestFilenameFixedPoint(desired.filename)
  ) {
    return 'desired filename is not a byte-stable UploadRequest normalization fixed point';
  }

  return null;
}

function uploadPlanRequiresDefaultFieldMetadataWrite(
  upload: UploadPlan,
): boolean {
  if (upload.action === 'create') return true;
  return (
    upload.action === 'update' &&
    Boolean(
      upload.baseline &&
        upload.desired &&
        stableStringify(upload.baseline.manual.defaultFieldMetadata) !==
          stableStringify(upload.desired.manual.defaultFieldMetadata),
    )
  );
}

function uploadTransportContractError(
  value: unknown,
  requireUsableSource: boolean,
): string | null {
  if (!isPlainJsonObject(value)) return 'transport must be an object';
  if (
    stableStringify(Object.keys(value).sort()) !==
    stableStringify(['bundledPath', 'sha256', 'sourceUrl'])
  ) {
    return 'transport keys are not exact';
  }
  const sourceUrl = value.sourceUrl;
  const bundledPath = value.bundledPath;
  const sha256 = value.sha256;
  if (typeof sourceUrl !== 'string') return 'sourceUrl is not a string';
  if (bundledPath !== null && typeof bundledPath !== 'string') {
    return 'bundledPath is not string|null';
  }
  if (sha256 !== null && typeof sha256 !== 'string') {
    return 'sha256 is not string|null';
  }
  const bundled =
    typeof bundledPath === 'string' &&
    bundledPath.length > 0 &&
    !bundledPath.startsWith('/') &&
    !/^[a-z]:/i.test(bundledPath) &&
    !bundledPath.includes('\\') &&
    !containsAsciiControl(bundledPath) &&
    !bundledPath
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..') &&
    typeof sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(sha256);
  if ((bundledPath === null) !== (sha256 === null)) {
    return 'bundledPath and sha256 must be present together';
  }
  if (bundled) return null;
  if (bundledPath !== null || sha256 !== null) {
    return 'bundled transport is malformed';
  }
  if (!requireUsableSource) return null;
  return isAbsoluteHttpUrl(sourceUrl) ? null : 'sourceUrl is invalid';
}

function uploadConsistencyContractError(value: unknown): string | null {
  if (!isPlainJsonObject(value)) return 'consistency must be an object';
  if (
    stableStringify(Object.keys(value).sort()) !==
    stableStringify(['antivirusStatus', 'updatedAt'])
  ) {
    return 'consistency keys are not exact';
  }
  if (value.updatedAt !== null && typeof value.updatedAt !== 'string') {
    return 'updatedAt is not string|null';
  }
  if (!['clean', 'skipped'].includes(String(value.antivirusStatus))) {
    return 'antivirusStatus is not terminal';
  }
  return null;
}

function uploadManualContractError(
  snapshot: UploadSnapshot,
  schema: ContentDiffPlan['schema'],
  requireWritableMetadata: boolean,
): string | null {
  const value = snapshot.manual;
  if (!isPlainJsonObject(value)) return 'manual metadata must be an object';
  if (
    stableStringify(Object.keys(value).sort()) !==
    stableStringify(UPLOAD_MANUAL_KEYS)
  ) {
    return 'manual metadata keys are not exact';
  }
  const manual = value as Record<string, unknown>;
  for (const key of ['author', 'copyright', 'notes'] as const) {
    if (manual[key] !== null && typeof manual[key] !== 'string') {
      return `${key} is not string|null`;
    }
    if (
      typeof manual[key] === 'string' &&
      (isRubyBlank(manual[key]) || manual[key].includes('\u0000'))
    ) {
      return `${key} is blank or contains NUL and cannot round-trip`;
    }
  }
  if (
    manual.collectionId !== null &&
    (typeof manual.collectionId !== 'string' ||
      manual.collectionId.length === 0)
  ) {
    return 'collectionId is not string|null';
  }
  const metadataError = uploadDefaultFieldMetadataContractError(
    manual.defaultFieldMetadata,
    schema,
    snapshot,
    requireWritableMetadata,
  );
  if (metadataError) {
    return metadataError;
  }
  if (
    !Array.isArray(manual.tags) ||
    manual.tags.some(
      (tag) =>
        typeof tag !== 'string' ||
        tag.length === 0 ||
        containsAsciiControl(tag) ||
        tag !== rubySquish(tag).toLowerCase(),
    ) ||
    stableStringify(manual.tags) !==
      stableStringify([...new Set(manual.tags)].sort())
  ) {
    return 'tags are not sorted unique strings';
  }
  return null;
}

function uploadDefaultFieldMetadataContractError(
  value: unknown,
  schema: ContentDiffPlan['schema'],
  snapshot: UploadSnapshot,
  requireWritable: boolean,
): string | null {
  if (!isPlainJsonObject(value)) {
    return 'defaultFieldMetadata is not a plain JSON object';
  }
  if (containsJsonNullByte(value)) {
    return 'defaultFieldMetadata contains a NUL byte that cannot be stored';
  }
  const locales: unknown = schema.locales;
  if (!Array.isArray(locales)) return 'schema locales are not an array';
  const localeKeys = [...locales].sort();
  // The CMA client's `uploads` methods always read and write the field-keyed
  // shape, converting to and from the legacy locale-keyed one on environments
  // without non-localized focal points. A locale-keyed value would be dropped
  // by that conversion, so it is never a valid plan value.
  if (
    !hasExactKeys(value, [
      'alt',
      'custom_data',
      'focal_point',
      'poster_time',
      'title',
    ])
  ) {
    return 'defaultFieldMetadata field-keyed shape is not exact';
  }
  for (const key of ['alt', 'title'] as const) {
    const localized = value[key];
    if (
      !isPlainJsonObject(localized) ||
      !hasAllowedLocaleKeys(localized, localeKeys, requireWritable)
    ) {
      return `defaultFieldMetadata.${key} locales are not ${
        requireWritable ? 'complete' : 'a canonical subset'
      }`;
    }
    if (
      Object.values(localized).some(
        (entry) =>
          entry !== null &&
          (typeof entry !== 'string' || !isRubyStripFixedPoint(entry)),
      )
    ) {
      return `defaultFieldMetadata.${key} values are not canonical`;
    }
  }
  const customData = value.custom_data;
  if (
    !isPlainJsonObject(customData) ||
    !hasAllowedLocaleKeys(customData, localeKeys, requireWritable)
  ) {
    return `defaultFieldMetadata.custom_data locales are not ${
      requireWritable ? 'complete' : 'a canonical subset'
    }`;
  }
  if (
    Object.values(customData).some(
      (entry) => !isPlainJsonObject(entry) || !isJsonValue(entry),
    )
  ) {
    return 'defaultFieldMetadata.custom_data values are not JSON objects';
  }
  const focalPointError = uploadFocalPointContractError(
    value.focal_point,
    snapshot,
    requireWritable,
  );
  if (focalPointError) return focalPointError;
  return uploadPosterTimeContractError(value.poster_time);
}

function uploadFocalPointContractError(
  value: unknown,
  snapshot: UploadSnapshot,
  requireWritable: boolean,
): string | null {
  if (value === null) return null;
  if (!isPlainJsonObject(value) || !hasExactKeys(value, ['x', 'y'])) {
    return 'defaultFieldMetadata focal_point is not exact';
  }
  for (const coordinate of [value.x, value.y]) {
    if (
      typeof coordinate !== 'number' ||
      !Number.isFinite(coordinate) ||
      coordinate < 0 ||
      coordinate > 1 ||
      Math.round(coordinate * 100) / 100 !== coordinate
    ) {
      return 'defaultFieldMetadata focal_point coordinates are not canonical';
    }
  }
  const imgixExtensions = new Set([
    '.ai',
    '.avif',
    '.bmp',
    '.gif',
    '.heic',
    '.ico',
    '.icns',
    '.jpg',
    '.jpeg',
    '.pct',
    '.png',
    '.psd',
    '.tif',
    '.tiff',
    '.webp',
  ]);
  if (
    requireWritable &&
    !imgixExtensions.has(
      uploadFilenameExtension(snapshot.filename).toLowerCase(),
    )
  ) {
    return 'defaultFieldMetadata focal_point is unsupported for this upload format';
  }
  return null;
}

function hasAllowedLocaleKeys(
  value: Record<string, unknown>,
  locales: readonly string[],
  requireComplete: boolean,
): boolean {
  const keys = Object.keys(value).sort();
  return requireComplete
    ? stableStringify(keys) === stableStringify(locales)
    : keys.every((key) => locales.includes(key));
}

function uploadPosterTimeContractError(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    Math.round(value * 1000) / 1000 !== value
  ) {
    return 'defaultFieldMetadata poster_time is not canonical';
  }
  return null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return stableStringify(Object.keys(value).sort()) === stableStringify(keys);
}

function isRubyStripFixedPoint(value: string): boolean {
  return rubyStrip(value) === value;
}

function isRubyBlank(value: string): boolean {
  return /^\p{White_Space}*$/u.test(value);
}

function rubySquish(value: string): string {
  return rubyStrip(value.replace(/\p{White_Space}+/gu, ' '));
}

function rubyStrip(value: string): string {
  const isStrippedByte = (code: number) =>
    code === 0 || (code >= 9 && code <= 13) || code === 32;
  let start = 0;
  let end = value.length;
  while (start < end && isStrippedByte(value.charCodeAt(start))) start += 1;
  while (end > start && isStrippedByte(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function containsJsonNullByte(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsJsonNullByte);
  if (!isPlainJsonObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => key.includes('\u0000') || containsJsonNullByte(child),
  );
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * An absolute http(s) URL with a host. The runtime also checks staged
 * download sources with it.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * A plain object as JSON.parse builds it: not null, not an array, and with
 * Object.prototype or no prototype at all.
 */
export function isPlainJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainJsonObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export function deriveRequiredUploadActions(
  uploadPlans: ContentDiffPlan['uploads'],
): ContentDiffPlan['requiredPermissions']['uploadActions'] {
  const actions = new Set<
    ContentDiffPlan['requiredPermissions']['uploadActions'][number]
  >(['read']);
  for (const upload of uploadPlans) {
    if (upload.action === 'create') actions.add('create');
    if (upload.action === 'delete') actions.add('delete');
    if (upload.action !== 'update' || !upload.baseline || !upload.desired) {
      continue;
    }

    const changes = compareUploadChanges(upload.desired, upload.baseline);
    if (
      uploadManualMetadataChanged(upload.baseline, upload.desired) ||
      (changes.binary &&
        ['author', 'copyright', 'notes'].some(
          (key) =>
            upload.baseline!.manual[key as 'author' | 'copyright' | 'notes'] ===
              null &&
            upload.desired!.manual[key as 'author' | 'copyright' | 'notes'] ===
              null,
        ))
    ) {
      actions.add('update');
    }
    if (
      changes.binary ||
      upload.baseline.basename !== upload.desired.basename ||
      upload.baseline.filename !== upload.desired.filename
    ) {
      actions.add('replace_asset');
    }
    if (changes.collection) actions.add('move');
  }
  const order = [
    'read',
    'create',
    'update',
    'replace_asset',
    'move',
    'delete',
  ] as const;
  return order.filter((action) => actions.has(action));
}
