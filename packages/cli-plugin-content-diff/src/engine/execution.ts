import { CmaClient } from '@datocms/cli-utils';
import { assertNotAborted } from './cancellation';
import { ContentError } from './errors';
import type { Client } from './types';

/**
 * Observes the execution client's work. The SDK sends every request through
 * `client.config.fetchFn` (job polling, upload and download transfers
 * included), so wrapping it can refuse writes without touching the client the
 * script receives. Retries, job polling and response parsing happen inside the
 * SDK call, between raw fetches, so calls passed to `track` count as in flight
 * until they settle too. Work an SDK helper does with nothing in flight (such
 * as streaming a download to disk) is not observed.
 */
interface RequestTracker {
  readonly fetchFn: typeof fetch;
  /** Requests and tracked calls that have not settled yet. */
  readonly pending: number;
  /**
   * Pending work that may change content. Reads can outlive a correct
   * script: a paged iterator the script leaves early keeps fetching the
   * pages it already queued.
   */
  readonly pendingWrites: number;
  /** Writes refused because they started after `close()`. */
  readonly refusedWrites: number;
  /** Counts `work` as in flight until it settles. */
  track<T>(work: Promise<T>, method: string): Promise<T>;
  /** Rejects writes issued once the migration callback has settled. */
  close(): void;
  /** Waits until nothing is in flight, including work started meanwhile. */
  drain(): Promise<void>;
}

function requestMethod(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  return (
    init?.method ??
    (typeof Request !== 'undefined' && input instanceof Request
      ? input.method
      : 'GET')
  ).toUpperCase();
}

const isRead = (method: string) => method === 'GET' || method === 'HEAD';

export function trackRequests(
  signal?: AbortSignal,
  base?: typeof fetch,
): RequestTracker {
  const inFlight = new Set<Promise<unknown>>();
  const writes = new Set<Promise<unknown>>();
  let closed = false;
  let refusedWrites = 0;
  const track = <T>(work: Promise<T>, method: string): Promise<T> => {
    const write = !isRead(method.toUpperCase());
    inFlight.add(work);
    if (write) writes.add(work);
    // The caller gets a derived promise, so a rejection it never handles is
    // still reported as unhandled; draining waits on `work` and leaves the
    // caller's copy alone.
    return work.finally(() => {
      inFlight.delete(work);
      writes.delete(work);
    });
  };
  const fetchFn: typeof fetch = (input, init) => {
    const method = requestMethod(input, init);
    // Reads keep flowing after an interrupt so jobs the script already
    // submitted can still be observed to completion.
    if (!isRead(method)) {
      try {
        assertNotAborted(signal);
      } catch (error) {
        return Promise.reject(error);
      }
      if (closed) {
        refusedWrites++;
        return Promise.reject(
          new ContentError(
            'UNAWAITED_MIGRATION_CALL',
            `A ${method} request started after the migration callback finished. Await every client call.`,
          ),
        );
      }
    }
    return track((base ?? globalThis.fetch)(input, init), method);
  };
  return {
    fetchFn,
    track,
    get pending() {
      return inFlight.size;
    },
    get pendingWrites() {
      return writes.size;
    },
    get refusedWrites() {
      return refusedWrites;
    },
    close() {
      closed = true;
    },
    async drain() {
      do {
        while (inFlight.size) await Promise.allSettled([...inFlight]);
        // A settled call can resume a chain whose next call starts after
        // pending callbacks run.
        await new Promise((resolve) => setImmediate(resolve));
      } while (inFlight.size);
    },
  };
}

/**
 * Keeps a rejection nobody handled, such as a call the script never awaited
 * that failed or was refused, from ending the process (Node's default) while
 * a migration and its cleanup are running. A rejection the script handles
 * later (a call it awaits after it failed) is forgotten again; the first one
 * still unhandled is kept for the report.
 */
export function observeUnhandledRejections(): {
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
 * Runs a migration callback with a client whose requests are tracked. Every
 * request is settled before this returns or throws, so cleanup never races a
 * write the script submitted.
 */
export async function runTrackedMigration(
  run: (client: Client) => Promise<void>,
  buildClient: (fetchFn: typeof fetch) => Client,
  signal?: AbortSignal,
  baseFetch?: typeof fetch,
): Promise<void> {
  const tracker = trackRequests(signal, baseFetch);
  const client = buildClient(tracker.fetchFn);
  // The script receives the same client; only its `request` calls are
  // counted so draining also waits for SDK retries and job polling.
  const request = client.request;
  if (typeof request === 'function')
    client.request = ((options) =>
      tracker.track(
        request.call(client, options),
        options.method,
      )) as Client['request'];
  const floating = observeUnhandledRejections();
  try {
    let failure: { error: unknown } | undefined;
    try {
      assertNotAborted(signal);
      await run(client);
    } catch (error) {
      failure = { error };
    }
    tracker.close();
    const unawaited = tracker.pendingWrites > 0;
    await tracker.drain();
    assertNotAborted(signal);
    if (failure)
      throw failure.error instanceof Error
        ? cmaFailure(failure.error)
        : new ContentError(
            'MIGRATION_FAILED',
            `The migration callback failed: ${String(failure.error)}`,
          );
    if (!unawaited && !tracker.refusedWrites && !floating.first) return;
    const reason = floating.first?.reason;
    // A refused write is the unawaited call itself; any other rejection is a
    // failure the script never saw.
    const unseen =
      floating.first &&
      !(
        reason instanceof ContentError &&
        reason.code === 'UNAWAITED_MIGRATION_CALL'
      )
        ? cmaFailure(reason)
        : undefined;
    const message =
      'The migration callback did not await every CMA request. Await every client call.';
    throw new ContentError(
      'UNAWAITED_MIGRATION_CALL',
      unseen instanceof Error
        ? `${message} An unawaited call failed: ${unseen.message}`
        : message,
      unseen instanceof ContentError
        ? { cause: { code: unseen.code, details: unseen.details } }
        : undefined,
    );
  } finally {
    floating.dispose();
  }
}
