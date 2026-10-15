import { CmaClient, oclif } from '@datocms/cli-utils';

/** The code of every failure the plugin reports itself. */
export type ErrorCode =
  | 'ASSET_DOWNLOAD_FAILED'
  | 'ENVIRONMENT_NOT_FOUND'
  | 'IMPORT_FAILED'
  | 'INVALID_DUMP'
  | 'INVALID_RECORDS'
  | 'OUTPUT_EXISTS'
  | 'PRIMARY_ENVIRONMENT'
  | 'SCHEMA_MISMATCH';

/**
 * A failure the user can act on. oclif prints it as native errors are
 * printed: the message, its code and the suggestions.
 */
export function userError(
  code: ErrorCode,
  message: string,
  suggestions?: string[],
): oclif.Errors.CLIError {
  return new oclif.Errors.CLIError(message, { code, suggestions });
}

/**
 * The asset CDN answers 422 only for raw video files, while the project's
 * asset settings block serving them (the default). `purpose` says what the
 * download was for.
 */
export function rawVideoBlocked(
  assetId: string,
  purpose: string,
): oclif.Errors.CLIError {
  return userError(
    'ASSET_DOWNLOAD_FAILED',
    `Asset ${assetId} is a video, and its project blocks downloading video files, which is the default. ${purpose}, turn off "Block serving URLs for raw video assets" in that project's Project settings > Asset CDN settings (the change can take about a minute to apply), and turn it back on afterwards.`,
  );
}

/** How many lines a list in an error message shows. */
const LISTED_LINES = 20;

/** Lines as an indented list, the ones past LISTED_LINES counted instead. */
export function bulletList(lines: string[]): string {
  const shown = lines.slice(0, LISTED_LINES).map((line) => `  - ${line}`);
  if (lines.length > LISTED_LINES)
    shown.push(`  - and ${lines.length - LISTED_LINES} more`);
  return shown.join('\n');
}

/**
 * What went wrong, as a clause to follow a colon, without a final period:
 * the CMA's error codes (with the field and validation code of a rejected
 * value) and the documentation link of the first one, or the message of any
 * other error.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof CmaClient.TimeoutError)
    return `the request ${error.request.method} ${requestPath(
      error.request.url,
    )} timed out`;
  if (!(error instanceof CmaClient.ApiError))
    return (error instanceof Error ? error.message : String(error)).replace(
      /\.$/,
      '',
    );
  const codes = error.errors.map(({ attributes }) => {
    const details = attributes.details as Record<string, unknown> | undefined;
    const field = details?.field;
    const code = details?.code;
    const reasons = Array.isArray(details?.errors)
      ? `, ${details.errors.join('; ')}`
      : '';
    return typeof field === 'string' && typeof code === 'string'
      ? `${attributes.code} (${field}: ${code}${reasons})`
      : attributes.code;
  });
  const docUrl = error.errors.find(({ attributes }) => attributes.doc_url)
    ?.attributes.doc_url;
  return `the CMA answered ${error.request.method} ${requestPath(
    error.request.url,
  )} with ${error.response.status} ${codes.join(', ')}${
    docUrl ? ` (see ${docUrl})` : ''
  }`;
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
