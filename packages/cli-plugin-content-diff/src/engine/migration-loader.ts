import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { require as tsxRequire } from 'tsx/cjs/api';
import type { ContentMigration } from '../migration';
import { assertNotAborted } from './cancellation';
import { ContentError } from './errors';

/**
 * Check the migration file without reading, importing or evaluating it. The
 * check is synchronous so a part runs up to its first request in the same
 * turn as the `runMigrationPart` call: a script that does not await that call
 * then still has the part's write in flight when its callback returns, and
 * the runner reports it.
 */
export function assertMigrationFile(path: string, signal?: AbortSignal): void {
  assertNotAborted(signal);
  const filename = resolve(path);
  if (!statSync(filename).isFile())
    throw new ContentError(
      'INVALID_CONTENT_MIGRATION',
      `Migration source must be a regular file: ${filename}`,
    );
}

/**
 * Load trusted code through the same public tsx API as native migrations.
 * tsx owns TypeScript imports, project configuration and source maps. The
 * entrypoint is dropped from the module cache and from its parent's children
 * after loading, so edits are observed on the next run and a part's exports
 * are not kept alive. tsx keeps every compiled source in an in-memory cache
 * for the rest of the process, so memory still grows with the total size of
 * the files loaded. Dependencies retain ordinary module semantics.
 */
export async function loadMigrationModule<T = unknown>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const filename = resolve(path);
  assertMigrationFile(filename, signal);
  const moduleId = tsxRequire.resolve(filename, __filename);
  delete tsxRequire.cache[moduleId];
  try {
    const loaded = tsxRequire(filename, __filename) as T;
    assertNotAborted(signal);
    return loaded;
  } finally {
    const loaded = tsxRequire.cache[moduleId];
    delete tsxRequire.cache[moduleId];
    const siblings = loaded?.parent?.children ?? [];
    const index = loaded ? siblings.indexOf(loaded) : -1;
    if (index >= 0) siblings.splice(index, 1);
  }
}

/** Load a script whose default export comes from defineContentMigration. */
export async function loadContentMigration(
  path: string,
  signal?: AbortSignal,
): Promise<ContentMigration> {
  const module = await loadMigrationModule<unknown>(path, signal);
  const declaration =
    module && typeof module === 'object' && 'default' in module
      ? module.default
      : module;
  if (
    typeof declaration !== 'function' ||
    Reflect.get(declaration, 'format') !== 'datocms-content-migration' ||
    Reflect.get(declaration, 'version') !== 1 ||
    !Reflect.get(declaration, 'options') ||
    typeof Reflect.get(declaration, 'options').baseline !== 'string' ||
    !Reflect.get(declaration, 'options').baseline
  )
    throw new ContentError(
      'INVALID_CONTENT_MIGRATION',
      'content:apply expects a default callable exported by defineContentMigration.',
    );
  return declaration as ContentMigration;
}
