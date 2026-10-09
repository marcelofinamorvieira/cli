import type { CmaClient } from '@datocms/cli-utils';

/**
 * The client a content migration receives: the real CMA SDK client bound to
 * the environment being migrated. Calls execute immediately against the CMA.
 */
export type ContentMigrationClient = CmaClient.Client;
