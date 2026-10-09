import type { Kind } from './types';

/** Context that callers need when an operation cannot finish safely. */
export interface ContentFailureContext {
  /** A fork this run created, or may have created, that still exists. */
  keptForkEnvironmentId?: string;
  /** What the failure left in the fork or the destination, in one sentence. */
  outcome?: string;
}

/** The only error fields exposed by the plugin's JSON command contract. */
interface ContentErrorReport {
  name: string;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  suggestions?: string[];
  keptForkEnvironmentId?: string;
}

export class ContentError extends Error implements ContentFailureContext {
  keptForkEnvironmentId?: string;
  outcome?: string;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentError';
  }
}

/**
 * Pick fields explicitly: oclif parse errors contain flags and tokens, and
 * CMA errors contain request headers. Neither belongs in command JSON.
 */
export function contentErrorReport(error: Error): ContentErrorReport {
  const failure = error as Error &
    ContentFailureContext & {
      code?: unknown;
      details?: unknown;
      suggestions?: unknown;
      errors?: Array<{ attributes?: { code?: unknown } }>;
    };
  const apiCode = Array.isArray(failure.errors)
    ? failure.errors[0]?.attributes?.code
    : undefined;
  return {
    name: error.name,
    message:
      typeof failure.outcome === 'string'
        ? `${error.message} ${failure.outcome}`
        : error.message,
    code:
      typeof failure.code === 'string'
        ? failure.code
        : typeof apiCode === 'string'
          ? apiCode
          : undefined,
    details:
      failure.details !== null &&
      typeof failure.details === 'object' &&
      !Array.isArray(failure.details)
        ? (failure.details as Record<string, unknown>)
        : undefined,
    suggestions: Array.isArray(failure.suggestions)
      ? failure.suggestions.filter(
          (value): value is string => typeof value === 'string',
        )
      : undefined,
    keptForkEnvironmentId:
      typeof failure.keptForkEnvironmentId === 'string'
        ? failure.keptForkEnvironmentId
        : undefined,
  };
}

/** The first observed difference between the destination and its baseline. */
type DestinationDifference =
  | {
      kind: Kind;
      id: string;
      reason: 'added' | 'removed' | 'changed';
    }
  | { reason: 'schema' };

export const DESTINATION_CHANGED_MESSAGE =
  'The destination environment has changed since the diff generation. Please re-generate a diff to apply.';

/** Every apply-time baseline failure reports the same instruction. */
export function destinationChanged(
  difference: DestinationDifference,
): ContentError {
  return new ContentError(
    'DESTINATION_CHANGED',
    DESTINATION_CHANGED_MESSAGE,
    difference,
  );
}

/** The exit status a failure asks for: its own, oclif's, or 1. */
export function exitStatus(
  error: Error & { exitCode?: number; oclif?: { exit?: number } },
): number {
  return error.exitCode ?? error.oclif?.exit ?? 1;
}

/**
 * One human-readable line naming the first difference of a changed
 * destination, also when it is the cause of a failed fork cleanup.
 */
export function firstDifference(
  report: ContentErrorReport,
): string | undefined {
  const cause = report.details?.cause as
    | { code?: unknown; details?: Record<string, unknown> }
    | undefined;
  const details =
    report.code === 'DESTINATION_CHANGED'
      ? report.details
      : cause?.code === 'DESTINATION_CHANGED'
        ? cause.details
        : undefined;
  if (!details) return undefined;
  if (details.reason === 'schema')
    return 'First difference: the schema changed.';
  if (typeof details.kind === 'string' && typeof details.id === 'string')
    return `First difference: ${details.kind} ${details.id} was ${details.reason}.`;
  return undefined;
}
