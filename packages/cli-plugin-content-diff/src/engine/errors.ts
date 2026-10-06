/** Context that callers need when an operation cannot finish safely. */
export interface ContentFailureContext {
  keptForkEnvironmentId?: string;
  unconfirmedForkEnvironmentId?: string;
}

/** The only error fields exposed by the plugin's JSON command contract. */
export interface ContentErrorReport extends ContentFailureContext {
  name: string;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  suggestions?: string[];
}

export class ContentError extends Error implements ContentFailureContext {
  keptForkEnvironmentId?: string;
  unconfirmedForkEnvironmentId?: string;

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
    message: error.message,
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
    unconfirmedForkEnvironmentId:
      typeof failure.unconfirmedForkEnvironmentId === 'string'
        ? failure.unconfirmedForkEnvironmentId
        : undefined,
  };
}
