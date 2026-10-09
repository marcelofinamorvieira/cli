import { resolve } from 'node:path';
import type { ContentMigrationClient } from './content-migration-client';
export type * from './content-migration-client';
export { type RecordOrder, reorderRecords } from './reorder-records';
import { ContentError } from './engine/errors';
import { loadMigrationModule } from './engine/migration-loader';

export interface ContentMigrationOptions {
  baseline: string;
}

/** An executable CMA script with immutable metadata for the plugin runner. */
export type ContentMigration = ((
  client: ContentMigrationClient,
) => Promise<void>) & {
  readonly format: 'datocms-content-migration';
  readonly version: 1;
  readonly options: ContentMigrationOptions;
};

/**
 * Load one generated part through the same tsx API as the main script and
 * await its default export with the real client. The part is dropped from the
 * module cache afterwards; tsx keeps its compiled source in memory until the
 * process ends.
 */
export async function runMigrationPart(
  client: ContentMigrationClient,
  path: string,
): Promise<void> {
  const part = (await loadMigrationModule<{ default?: unknown } | null>(path))
    ?.default;
  if (typeof part !== 'function')
    throw new ContentError(
      'INVALID_CONTENT_MIGRATION',
      `Migration part must export a default function: ${resolve(path)}`,
    );
  await part(client);
}

/**
 * Declare a content migration. The callback receives the real CMA client and
 * must await every call; content:apply tracks the client's requests and
 * refuses to finish while any of them is still running.
 */
export function defineContentMigration(
  options: ContentMigrationOptions,
  run: (client: ContentMigrationClient) => Promise<void>,
): ContentMigration {
  return Object.assign((client: ContentMigrationClient) => run(client), {
    format: 'datocms-content-migration' as const,
    version: 1 as const,
    options,
  });
}
