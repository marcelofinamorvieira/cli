import { CmaClient } from '@datocms/cli-utils';
import { assertNotAborted } from './cancellation';
import { ContentError } from './errors';
import type { Client } from './types';

function requestMethod(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  return (
    init?.method ??
    (typeof Request !== 'undefined' && input instanceof Request
      ? input.method
      : 'GET')
  ).toUpperCase();
}

const isRead = (method: string) => method === 'GET' || method === 'HEAD';

/**
 * Keeps a rejection nobody handled, such as a call the script never awaited
 * that failed, from ending the process (Node's default) while the migration
 * runs. A rejection the script handles later (a call it awaits after it
 * failed) is forgotten again; the first one still unhandled is kept.
 */
function observeUnhandledRejections(): {
  readonly first: { reason: unknown } | undefined;
  dispose(): void;
} {
  const unhandled = new Map<Promise<unknown>, unknown>();
  const onUnhandled = (reason: unknown, promise: Promise<unknown>) => {
    unhandled.set(promise, reason);
  };
  const onHandled = (promise: Promise<unknown>) => {
    unhandled.delete(promise);
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('rejectionHandled', onHandled);
  return {
    get first() {
      for (const reason of unhandled.values()) return { reason };
      return undefined;
    },
    dispose() {
      process.off('unhandledRejection', onUnhandled);
      process.off('rejectionHandled', onHandled);
    },
  };
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0]!;
  }
}

const REFERENCE_CODE = /LINK|REFERENC|UNPUBLISHED|^VALIDATION_ITEMS?_/;

/** Turns a CMA rejection raised by the script into a reportable error. */
export function cmaFailure(error: unknown): unknown {
  if (error instanceof CmaClient.TimeoutError) {
    const { method, url } = error.request;
    const path = requestPath(url);
    return new ContentError(
      'CMA_REQUEST_FAILED',
      `The CMA request ${method} ${path} timed out; it may still have been applied.`,
      { method, url, status: null, errors: [] },
    );
  }
  if (!(error instanceof CmaClient.ApiError)) return error;
  const { method } = error.request;
  const path = requestPath(error.request.url);
  const errors = error.errors.map((entry) => ({
    code: entry.attributes.code,
    details: entry.attributes.details ?? {},
  }));
  const details = {
    method,
    url: error.request.url,
    status: error.response.status,
    errors,
  };
  if (error.findError('STALE_ITEM_VERSION')) {
    const id = /\/items\/([^/]+)/.exec(path)?.[1] ?? 'unknown';
    return new ContentError(
      'RECORD_CHANGED_DURING_APPLY',
      `Record ${id} was modified by someone else while the migration was running.`,
      details,
    );
  }
  const codes = errors.flatMap(({ code, details }) =>
    typeof details.code === 'string' ? [code, details.code] : [code],
  );
  const summary =
    errors
      .map(({ code, details }) =>
        typeof details.field === 'string' && typeof details.code === 'string'
          ? `${code} (${details.field}: ${details.code})`
          : code,
      )
      .join('; ') || `HTTP ${error.response.status}`;
  if (error.response.status !== 422)
    return new ContentError(
      'CMA_REQUEST_FAILED',
      `The CMA request ${method} ${path} failed: ${summary}.`,
      details,
    );
  const hints: string[] = [];
  if (codes.includes('VALIDATION_UNIQUE'))
    hints.push(
      'A unique value may still be held by another record; reorder or edit the script so that record releases it first.',
    );
  if (codes.some((code) => REFERENCE_CODE.test(code)))
    hints.push(
      'A referenced record or asset may be missing or unpublished; make sure the script creates or publishes it first.',
    );
  return new ContentError(
    'CMA_VALIDATION_FAILED',
    [`The CMA rejected ${method} ${path}: ${summary}.`, ...hints].join(' '),
    details,
  );
}

/**
 * Runs a migration callback with a client whose requests are tracked, and
 * returns or throws only once every request the script started has settled,
 * so apply never reports, or removes a fork, while a write is still running.
 * The SDK sends every request (retries, job polling and file transfers
 * included) through `fetchFn`; the client's `request` is tracked too, so a
 * call waiting between attempts, or before polling its job, counts as in
 * flight. After an interrupt new writes are refused, while reads continue so
 * jobs already submitted can be observed. A call the script did not await
 * still runs to completion; if one fails without being handled, the
 * migration fails.
 */
export async function runTrackedMigration(
  run: (client: Client) => Promise<void>,
  buildClient: (fetchFn: typeof fetch) => Client,
  signal?: AbortSignal,
  baseFetch?: typeof fetch,
): Promise<void> {
  const inFlight = new Set<Promise<unknown>>();
  // The caller gets a derived promise, so a rejection it never handles is
  // still reported as unhandled; draining waits on `work` itself.
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    return work.finally(() => inFlight.delete(work));
  };
  const client = buildClient((input, init) => {
    if (!isRead(requestMethod(input, init))) {
      try {
        assertNotAborted(signal);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return track((baseFetch ?? globalThis.fetch)(input, init));
  });
  const request = client.request;
  if (typeof request === 'function')
    client.request = ((options) =>
      track(request.call(client, options))) as Client['request'];
  const floating = observeUnhandledRejections();
  try {
    let failure: { error: unknown } | undefined;
    try {
      assertNotAborted(signal);
      await run(client);
    } catch (error) {
      failure = { error };
    }
    do {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      // A settled call can resume a chain whose next call starts after
      // pending callbacks run.
      await new Promise((resolve) => setImmediate(resolve));
    } while (inFlight.size);
    assertNotAborted(signal);
    if (failure)
      throw failure.error instanceof Error
        ? cmaFailure(failure.error)
        : new ContentError(
            'MIGRATION_FAILED',
            `The migration callback failed: ${String(failure.error)}`,
          );
    if (!floating.first) return;
    const unseen = cmaFailure(floating.first.reason);
    throw new ContentError(
      'UNAWAITED_MIGRATION_CALL',
      `A call the migration did not await failed: ${
        unseen instanceof Error ? unseen.message : String(unseen)
      } Await every client call.`,
      unseen instanceof ContentError
        ? { cause: { code: unseen.code, details: unseen.details } }
        : undefined,
    );
  } finally {
    floating.dispose();
  }
}
