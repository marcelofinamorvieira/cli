/** Shared by generation and loading; importing limits must not load TypeScript. */
export const MAX_MIGRATION_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_MIGRATION_CHUNK_BYTES = MAX_MIGRATION_FILE_BYTES - 1024;
export const DEFAULT_MIGRATION_CHUNK_BYTES = 1024 * 1024;
