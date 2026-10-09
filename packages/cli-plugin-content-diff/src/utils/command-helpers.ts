import { contentErrorReport, exitStatus } from '../engine/errors';

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
