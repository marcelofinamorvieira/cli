import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentMigrationClient } from './content-migration-client';
export type * from './content-migration-client';
export { type RecordOrder, reorderRecords } from './reorder-records';
import { companionDirectory } from './engine/companion';
import { ContentError } from './engine/errors';
import { loadMigrationModule } from './engine/migration-loader';

/**
 * An executable CMA script with immutable metadata for the plugin runner. Its
 * destination baseline is the same-named `.content` directory beside it.
 */
export type ContentMigration = ((
  client: ContentMigrationClient,
) => Promise<void>) & {
  readonly format: 'datocms-content-migration';
  readonly version: 1;
};

/**
 * Run one part of a split migration: the file `part` in the `parts` directory
 * of the script's companion, found beside the script's real file as
 * content:apply finds the baseline. The part is loaded through the same tsx
 * API as the main script, its default export is awaited with the real client,
 * and it is dropped from the module cache afterwards; tsx keeps its compiled
 * source in memory until the process ends.
 */
export async function runMigrationPart(
  client: ContentMigrationClient,
  script: string,
  part: string,
): Promise<void> {
  const path = join(companionDirectory(realpathSync(script)), 'parts', part);
  const run = (await loadMigrationModule<{ default?: unknown } | null>(path))
    ?.default;
  if (typeof run !== 'function')
    throw new ContentError(
      'INVALID_CONTENT_MIGRATION',
      `Migration part must export a default function: ${path}`,
    );
  await run(client);
}

/**
 * Declare a content migration. The callback receives the real CMA client and
 * must await every call; content:apply tracks the client's requests and
 * refuses to finish while any of them is still running.
 */
export function defineContentMigration(
  run: (client: ContentMigrationClient) => Promise<void>,
): ContentMigration {
  return Object.assign((client: ContentMigrationClient) => run(client), {
    format: 'datocms-content-migration' as const,
    version: 1 as const,
  });
}
