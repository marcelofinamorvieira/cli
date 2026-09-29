import { dirname, resolve } from 'node:path';
import type { ProfileConfig } from '@datocms/cli-utils';
import { CONTENT_DIFF_MAPPING_MODEL_API_KEY } from './environments-diff/fetch-schema';

export const DEFAULT_MIGRATIONS_MODEL_API_KEY = 'schema_migration';

export const RESERVED_MIGRATIONS_MODEL_MESSAGE = `The model API key "${CONTENT_DIFF_MAPPING_MODEL_API_KEY}" is reserved for the content-diff legacy-ID mapping ledger and cannot be used to track migrations. Choose a different migrations.modelApiKey or --migrations-model value.`;

type ProfileMigrations = ProfileConfig['migrations'];

/**
 * Shared by migrations:run and content:diff so generation writes into, and
 * validates against, the same directory and tracking model that execution
 * later uses. Precedence: an explicit flag (relative to the working
 * directory), then the profile's migrations settings (relative to the config
 * file), then the CLI defaults.
 */
export function resolveMigrationsSettings({
  directoryOverride,
  modelApiKeyOverride,
  profileMigrations,
  configPath,
}: {
  directoryOverride?: string;
  modelApiKeyOverride?: string;
  profileMigrations: ProfileMigrations;
  configPath: string;
}): { directory: string; modelApiKey: string } {
  return {
    directory: resolve(
      directoryOverride ||
        (profileMigrations?.directory
          ? resolve(dirname(configPath), profileMigrations.directory)
          : undefined) ||
        './migrations',
    ),
    modelApiKey:
      modelApiKeyOverride ||
      profileMigrations?.modelApiKey ||
      DEFAULT_MIGRATIONS_MODEL_API_KEY,
  };
}

export function isReservedMigrationsModelApiKey(modelApiKey: string): boolean {
  return modelApiKey === CONTENT_DIFF_MAPPING_MODEL_API_KEY;
}
