// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

// Operator tuning shared by generation and the generated migration runtime.
//
// Every DATOCMS_CONTENT_DIFF_*_MS variable below is a decimal integer number
// of milliseconds from 1000 to 86400000; the schedule safety window can only
// be raised above its default. content:diff reads just the two asset download
// deadlines, and only with --bundle-assets. The runtime resolves every value
// from the environment where migrations:run executes, before any CMA request.
//
// The environment is always passed in: shared code never reads process.env.

export type ContentDiffTuningEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface ContentDiffTuning {
  /** Maximum wait for upload download response headers. */
  assetHeadersTimeoutMs: number;
  /** Maximum upload download inactivity between body chunks. */
  assetIdleTimeoutMs: number;
  /** Maximum wait for DatoCMS to finish processing a created upload. */
  uploadProcessingTimeoutMs: number;
  /** Maximum wait for DatoCMS to finish recomputing record validity. */
  validityTimeoutMs: number;
  /** Minimum distance between now and a schedule the runtime restores. */
  scheduleSafetyWindowMs: number;
}

export type ContentDiffTuningKey = keyof ContentDiffTuning;

export interface ContentDiffTuningDefinition {
  key: ContentDiffTuningKey;
  variable: string;
  defaultMs: number;
  minimumMs: number;
  maximumMs: number;
}

export interface ContentDiffTuningOverride {
  key: ContentDiffTuningKey;
  variable: string;
  valueMs: number;
  defaultMs: number;
}

export interface ContentDiffTuningError extends Error {
  name: 'ContentDiffTuningError';
  code: 'INVALID_TUNING';
  details: {
    variable: string;
    value: string;
    minimumMs: number;
    maximumMs: number;
    defaultMs: number;
  };
}

export const CONTENT_DIFF_TUNING_ERROR_CODE = 'INVALID_TUNING';
export const CONTENT_DIFF_TUNING_MINIMUM_MS = 1_000;
export const CONTENT_DIFF_TUNING_MAXIMUM_MS = 86_400_000;

export const CONTENT_DIFF_TUNING_DEFINITIONS: readonly ContentDiffTuningDefinition[] =
  [
    {
      key: 'assetHeadersTimeoutMs',
      variable: 'DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS',
      defaultMs: 120_000,
      minimumMs: CONTENT_DIFF_TUNING_MINIMUM_MS,
      maximumMs: CONTENT_DIFF_TUNING_MAXIMUM_MS,
    },
    {
      key: 'assetIdleTimeoutMs',
      variable: 'DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS',
      defaultMs: 300_000,
      minimumMs: CONTENT_DIFF_TUNING_MINIMUM_MS,
      maximumMs: CONTENT_DIFF_TUNING_MAXIMUM_MS,
    },
    {
      key: 'uploadProcessingTimeoutMs',
      variable: 'DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS',
      defaultMs: 600_000,
      minimumMs: CONTENT_DIFF_TUNING_MINIMUM_MS,
      maximumMs: CONTENT_DIFF_TUNING_MAXIMUM_MS,
    },
    {
      key: 'validityTimeoutMs',
      variable: 'DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS',
      defaultMs: 600_000,
      minimumMs: CONTENT_DIFF_TUNING_MINIMUM_MS,
      maximumMs: CONTENT_DIFF_TUNING_MAXIMUM_MS,
    },
    {
      // The window protects restored schedules from firing mid-migration, so
      // it can only be widened: its default is also its minimum.
      key: 'scheduleSafetyWindowMs',
      variable: 'DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS',
      defaultMs: 300_000,
      minimumMs: 300_000,
      maximumMs: CONTENT_DIFF_TUNING_MAXIMUM_MS,
    },
  ];

const CONTENT_DIFF_TUNING_MAXIMUM_ECHOED_VALUE_LENGTH = 64;

/**
 * Resolves one tuning value. An unset variable (undefined) uses the default;
 * any other value, including an empty string, must be a plain decimal integer
 * inside the variable's range or resolution fails closed.
 */
export function readContentDiffTuningValue(
  env: ContentDiffTuningEnvironment,
  key: ContentDiffTuningKey,
): number {
  const definition = contentDiffTuningDefinition(key);
  const raw = env[definition.variable];

  if (raw === undefined) return definition.defaultMs;

  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    throw createContentDiffTuningError(definition, raw);
  }

  const value = Number(raw);

  if (
    !Number.isSafeInteger(value) ||
    value < definition.minimumMs ||
    value > definition.maximumMs
  ) {
    throw createContentDiffTuningError(definition, raw);
  }

  return value;
}

/** Resolves every tuning value, failing on the first invalid variable. */
export function resolveContentDiffTuning(
  env: ContentDiffTuningEnvironment,
): ContentDiffTuning {
  return {
    assetHeadersTimeoutMs: readContentDiffTuningValue(
      env,
      'assetHeadersTimeoutMs',
    ),
    assetIdleTimeoutMs: readContentDiffTuningValue(env, 'assetIdleTimeoutMs'),
    uploadProcessingTimeoutMs: readContentDiffTuningValue(
      env,
      'uploadProcessingTimeoutMs',
    ),
    validityTimeoutMs: readContentDiffTuningValue(env, 'validityTimeoutMs'),
    scheduleSafetyWindowMs: readContentDiffTuningValue(
      env,
      'scheduleSafetyWindowMs',
    ),
  };
}

/**
 * Resolves only the upload download deadlines, shaped like the downloader's
 * options. Generation reads these alone because the other values are consumed
 * by the runtime wherever migrations:run executes.
 */
export function resolveAssetDownloadTimeouts(
  env: ContentDiffTuningEnvironment,
): { headersTimeoutMs: number; idleTimeoutMs: number } {
  return {
    headersTimeoutMs: readContentDiffTuningValue(env, 'assetHeadersTimeoutMs'),
    idleTimeoutMs: readContentDiffTuningValue(env, 'assetIdleTimeoutMs'),
  };
}

/** Lists resolved values that differ from their defaults, in a stable order. */
export function listContentDiffTuningOverrides(
  tuning: Partial<ContentDiffTuning>,
): ContentDiffTuningOverride[] {
  const overrides: ContentDiffTuningOverride[] = [];

  for (const definition of CONTENT_DIFF_TUNING_DEFINITIONS) {
    const valueMs = tuning[definition.key];

    if (typeof valueMs === 'number' && valueMs !== definition.defaultMs) {
      overrides.push({
        key: definition.key,
        variable: definition.variable,
        valueMs,
        defaultMs: definition.defaultMs,
      });
    }
  }

  return overrides;
}

/**
 * Describes one override for human-readable output, for example
 * "DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS=900000 ms (default 300000 ms)".
 */
export function formatContentDiffTuningOverride(
  override: ContentDiffTuningOverride,
): string {
  return [
    override.variable,
    '=',
    String(override.valueMs),
    ' ms (default ',
    String(override.defaultMs),
    ' ms)',
  ].join('');
}

export function isContentDiffTuningError(
  error: unknown,
): error is ContentDiffTuningError {
  return (
    error instanceof Error &&
    (error as Partial<ContentDiffTuningError>).code ===
      CONTENT_DIFF_TUNING_ERROR_CODE
  );
}

/** Returns the definition of one tuning value. */
export function contentDiffTuningDefinition(
  key: ContentDiffTuningKey,
): ContentDiffTuningDefinition {
  for (const definition of CONTENT_DIFF_TUNING_DEFINITIONS) {
    if (definition.key === key) return definition;
  }

  throw new Error(['Unknown content diff tuning key: ', String(key)].join(''));
}

function createContentDiffTuningError(
  definition: ContentDiffTuningDefinition,
  raw: unknown,
): ContentDiffTuningError {
  const value = String(raw);
  const echoedValue =
    value.length > CONTENT_DIFF_TUNING_MAXIMUM_ECHOED_VALUE_LENGTH
      ? [
          value.slice(0, CONTENT_DIFF_TUNING_MAXIMUM_ECHOED_VALUE_LENGTH),
          '...',
        ].join('')
      : value;
  const raiseOnly = definition.minimumMs === definition.defaultMs;
  const message = [
    'Invalid ',
    definition.variable,
    ' value ',
    JSON.stringify(echoedValue),
    ': expected a decimal integer number of milliseconds from ',
    String(definition.minimumMs),
    ' to ',
    String(definition.maximumMs),
    ' (default ',
    String(definition.defaultMs),
    ')',
    raiseOnly ? '; this value can only be raised above its default' : '',
    '. Unset the variable to use the default.',
  ].join('');

  return Object.assign(new Error(message), {
    name: 'ContentDiffTuningError' as const,
    code: 'INVALID_TUNING' as const,
    details: {
      variable: definition.variable,
      value: echoedValue,
      minimumMs: definition.minimumMs,
      maximumMs: definition.maximumMs,
      defaultMs: definition.defaultMs,
    },
  });
}
