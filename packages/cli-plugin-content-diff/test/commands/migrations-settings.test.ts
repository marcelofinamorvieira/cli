import { join, resolve } from 'node:path';
import { expect } from 'chai';
import {
  DEFAULT_MIGRATIONS_MODEL_API_KEY,
  RESERVED_MIGRATIONS_MODEL_MESSAGE,
  isReservedMigrationsModelApiKey,
  resolveMigrationsSettings,
} from '../../src/utils/migrations-settings';

describe('migrations settings resolution', () => {
  const configPath = join('/projects', 'app', 'config', 'datocms.config.json');

  it('prefers flags, resolved from the working directory', () => {
    expect(
      resolveMigrationsSettings({
        directoryOverride: 'flag-migrations',
        modelApiKeyOverride: 'flag_migration_log',
        profileMigrations: {
          directory: 'profile-migrations',
          modelApiKey: 'profile_migration_log',
        },
        configPath,
      }),
    ).to.deep.equal({
      directory: resolve('flag-migrations'),
      modelApiKey: 'flag_migration_log',
    });
  });

  it('falls back to profile settings, resolved from the config file', () => {
    expect(
      resolveMigrationsSettings({
        profileMigrations: {
          directory: 'profile-migrations',
          modelApiKey: 'profile_migration_log',
        },
        configPath,
      }),
    ).to.deep.equal({
      directory: join('/projects', 'app', 'config', 'profile-migrations'),
      modelApiKey: 'profile_migration_log',
    });
  });

  it('falls back to ./migrations and the CLI tracking model', () => {
    expect(
      resolveMigrationsSettings({
        directoryOverride: '',
        modelApiKeyOverride: '',
        profileMigrations: undefined,
        configPath,
      }),
    ).to.deep.equal({
      directory: resolve('migrations'),
      modelApiKey: DEFAULT_MIGRATIONS_MODEL_API_KEY,
    });
    expect(DEFAULT_MIGRATIONS_MODEL_API_KEY).to.equal('schema_migration');
  });

  it('identifies the reserved content-diff ledger model', () => {
    expect(isReservedMigrationsModelApiKey('datocms_content_diff')).to.equal(
      true,
    );
    expect(isReservedMigrationsModelApiKey('schema_migration')).to.equal(false);
    expect(RESERVED_MIGRATIONS_MODEL_MESSAGE).to.contain(
      '--migrations-model value',
    );
  });
});
