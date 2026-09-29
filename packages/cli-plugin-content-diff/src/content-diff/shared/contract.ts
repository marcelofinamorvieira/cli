// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

/** Version of the immutable runtime copied next to generated migrations. */
export const CONTENT_DIFF_RUNTIME_VERSION = '17' as const;
/** Protocol `migrations:run` passes through the execution context. */
export const CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION = 1 as const;
export const CONTENT_DIFF_PLAN_VERSION = 10 as const;
export const CONTENT_DIFF_MANIFEST_VERSION = 10 as const;

// The internal model that stores legacy-ID mapping documents.
export const LEGACY_ID_MAPPING_FORMAT_VERSION = 1 as const;
export const LEGACY_ID_MAPPING_MODEL_API_KEY = 'datocms_content_diff' as const;
export const LEGACY_ID_MAPPING_MODEL_NAME = 'Content diff' as const;
export const LEGACY_ID_MAPPING_NAME_FIELD_API_KEY = 'name' as const;
export const LEGACY_ID_MAPPING_NAME_FIELD_LABEL = 'Name' as const;
export const LEGACY_ID_MAPPING_FIELD_API_KEY = 'mapping' as const;
export const LEGACY_ID_MAPPING_FIELD_LABEL = 'Mapping' as const;
export const LEGACY_ID_MAPPING_MAX_DOCUMENT_BYTES = 128 * 1024;
export const LEGACY_ID_MAPPING_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'record',
  'block',
  'upload',
  'upload_collection',
]);

/** Validators a migration may drop temporarily and restore afterwards. */
export const SAFELY_RELAXABLE_VALIDATOR_KEYS = [
  'date_range',
  'date_time_range',
  'description_length',
  'enum',
  'extension',
  'file_size',
  'format',
  'image_aspect_ratio',
  'image_dimensions',
  'length',
  'number_range',
  'required',
  'required_alt_title',
  'required_seo_fields',
  'sanitized_html',
  'size',
  'slug_format',
  'slug_title_field',
  'title_length',
  'unique',
] as const;
export const RELAXABLE_VALIDATOR_KEYS: ReadonlySet<string> = new Set(
  SAFELY_RELAXABLE_VALIDATOR_KEYS,
);
