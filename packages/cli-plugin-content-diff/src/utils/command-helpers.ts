import { lstat, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import {
  CmaClient,
  type LogLevelFlagEnum,
  type ProfileConfig,
  logLevelMap,
} from '@datocms/cli-utils';
import { camelCase } from 'lodash';
import { ContentError, contentErrorReport, exitStatus } from '../engine/errors';

/**
 * Under --json, the host would report a failure as an object dump on stdout.
 * Commands log this JSON error object instead, with the error's own exit
 * status (1 when it has none). Human output can differ for CMA authorization
 * and permission errors, which `CmaClientCommand.catch` raises again as
 * native CLI errors. `contentErrorReport` picks the fields explicitly:
 * oclif parse errors carry the parsed flags, tokens included, and CMA errors
 * carry their request.
 */
export function jsonFailure(
  error: Error & { exitCode?: number; oclif?: { exit?: number } },
): { error: ReturnType<typeof contentErrorReport> } {
  process.exitCode ??= exitStatus(error);
  return { error: contentErrorReport(error) };
}

/**
 * The native request log level, except that `--output` does not silence it:
 * in this plugin it names a file, not an output format.
 */
export function requestLogLevel(
  flags: { json?: boolean; 'log-level'?: LogLevelFlagEnum },
  profile?: ProfileConfig,
): CmaClient.LogLevel {
  const level = flags['log-level'] ?? profile?.logLevel;
  return flags.json || !level ? CmaClient.LogLevel.NONE : logLevelMap[level];
}

async function assertOutputAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ContentError(
    'OUTPUT_EXISTS',
    `${path} already exists. Choose another name.`,
  );
}

/**
 * The path of a dump or diff zip: `--output` when it names a .zip file,
 * otherwise `<seconds>_<name>.<kind>-records.zip` (or `-records-assets.zip`
 * when it carries asset files) in `--output` or the default directory. Both
 * names are checked to be free before any work starts.
 */
export async function outputPath(args: {
  output?: string;
  directory: string;
  name: string;
  kind: 'dump' | 'diff';
}): Promise<(includesAssets: boolean) => string> {
  const name = camelCase(args.name);
  if (!name)
    throw new ContentError(
      'INVALID_NAME',
      'The name must contain letters or numbers.',
    );
  const requested = args.output ? resolve(args.output) : args.directory;
  const file = extname(requested) === '.zip';
  // A path with another extension is refused rather than created as a
  // directory, unless it already is one.
  if (
    !file &&
    extname(requested) &&
    !(await stat(requested).then(
      (entry) => entry.isDirectory(),
      () => false,
    ))
  )
    throw new ContentError(
      'INVALID_OUTPUT_PATH',
      'The output must be a .zip file or a directory.',
    );
  const seconds = Math.floor(Date.now() / 1000);
  const path = (includesAssets: boolean) =>
    file
      ? requested
      : join(
          requested,
          `${seconds}_${name}.${args.kind}-records${
            includesAssets ? '-assets' : ''
          }.zip`,
        );
  for (const includesAssets of [false, true])
    await assertOutputAbsent(path(includesAssets));
  return path;
}
