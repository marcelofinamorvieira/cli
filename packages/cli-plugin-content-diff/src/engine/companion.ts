import { basename, dirname, join, resolve } from 'node:path';

/**
 * The `.content` companion beside a migration script, holding its baseline
 * and its parts. Apply and the part runner both find it from the script's
 * real path, so they always agree on which companion a script uses.
 */
export function companionDirectory(scriptPath: string): string {
  const script = resolve(scriptPath);
  return join(dirname(script), `${basename(script, '.ts')}.content`);
}
