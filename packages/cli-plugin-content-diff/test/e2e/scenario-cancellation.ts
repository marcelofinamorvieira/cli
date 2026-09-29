import type { ChildProcess } from 'node:child_process';
import { setMaxListeners } from 'node:events';

/** Leave five minutes for ownership recovery/cleanup before Mocha's deadline. */
export const SCENARIO_WORK_TIMEOUT_MS = 25 * 60 * 1000;

export class ScenarioCancelledError extends Error {
  readonly code = 'E2E_SCENARIO_CANCELLED';

  constructor(message = 'Real-CMA scenario work was cancelled') {
    super(message);
    this.name = 'ScenarioCancelledError';
  }
}

export interface ScenarioCancellation {
  readonly signal: AbortSignal;
  readonly fetchFn: typeof fetch;
  throwIfAborted(): void;
  abort(reason?: Error): void;
  /** Register immediately after spawn; resolves only after the close event. */
  trackChild(child: ChildProcess): Promise<void>;
  /** Always abort first so later SDK retries cannot start another request. */
  drain(): Promise<void>;
  /** Cancels even on success, then waits for all local work to settle. */
  shutdown(reason?: Error): Promise<void>;
}

/**
 * Tracks actual fetch/body settlement, including fetches abandoned by the SDK's
 * own header timeout. No timeout race leaves a transport running in the
 * background. Native fetch must honor AbortSignal; an uncooperative replacement
 * keeps drain pending, so callers cannot start cleanup under active work.
 *
 * This cannot roll back a request accepted by CMA. Ownership recovery and
 * cleanup must use an independent client after shutdown, including discovery
 * of a fork whose response was lost before cancellation.
 */
export function createScenarioCancellation(
  options: Readonly<{
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    childKillGraceMs?: number;
  }> = {},
): ScenarioCancellation {
  const timeoutMs = options.timeoutMs ?? SCENARIO_WORK_TIMEOUT_MS;
  const killGraceMs = options.childKillGraceMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1)
    throw new Error('Scenario timeout must be a positive timer duration');
  if (
    !Number.isFinite(killGraceMs) ||
    killGraceMs < 0 ||
    killGraceMs > 2 ** 31 - 1
  )
    throw new Error('Child termination grace must be nonnegative');

  const controller = new AbortController();
  // Schema fingerprints can have more than ten requests sharing this signal.
  // Each request removes its listener when its response body settles.
  setMaxListeners(0, controller.signal);
  const fetchTransport = options.fetchFn ?? globalThis.fetch;
  const pending = new Set<Promise<void>>();
  const deadline = setTimeout(
    () => abort(new ScenarioCancelledError(`Scenario exceeded ${timeoutMs}ms`)),
    timeoutMs,
  );
  deadline.unref?.();

  function abort(reason: Error = new ScenarioCancelledError()): void {
    clearTimeout(deadline);
    if (!controller.signal.aborted) controller.abort(reason);
  }

  function throwIfAborted(): void {
    if (controller.signal.aborted) throw controller.signal.reason;
  }

  function track(): () => void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    pending.add(promise);
    return () => {
      pending.delete(promise);
      resolve();
    };
  }

  const fetchFn: typeof fetch = async (input, init) => {
    throwIfAborted();
    const complete = track();
    const requestController = new AbortController();
    let bodyOwnsCompletion = false;
    let cancelBody: ((reason: unknown) => void) | undefined;
    const callerSignal =
      init?.signal ??
      (typeof Request !== 'undefined' && input instanceof Request
        ? input.signal
        : undefined);
    const forwardScopeAbort = () =>
      requestController.abort(controller.signal.reason);
    const forwardCallerAbort = () =>
      requestController.abort(
        new ScenarioCancelledError('The caller cancelled this request'),
      );
    controller.signal.addEventListener('abort', forwardScopeAbort, {
      once: true,
    });
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
    if (callerSignal?.aborted) forwardCallerAbort();
    const finish = () => {
      controller.signal.removeEventListener('abort', forwardScopeAbort);
      callerSignal?.removeEventListener('abort', forwardCallerAbort);
      complete();
    };

    try {
      if (requestController.signal.aborted)
        throw requestController.signal.reason;
      const response = await fetchTransport(input, {
        ...init,
        signal: requestController.signal,
      });
      if (!response.body) {
        if (requestController.signal.aborted)
          throw requestController.signal.reason;
        finish();
        return response;
      }

      const reader = response.body.getReader();
      let output: ReadableStreamDefaultController<Uint8Array>;
      let cancelling: Promise<void> | undefined;
      const cancelReader = (reason: unknown) => {
        if (!cancelling)
          cancelling = reader.cancel(reason).catch(() => undefined);
        return cancelling;
      };
      const abortBody = () => {
        cancelBody!(requestController.signal.reason);
      };
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          output = streamController;
        },
        async pull(streamController) {
          try {
            const chunk = await reader.read();
            if (chunk.done) streamController.close();
            else streamController.enqueue(chunk.value);
          } catch (error) {
            streamController.error(
              requestController.signal.aborted
                ? requestController.signal.reason
                : error,
            );
          }
        },
        cancel: cancelReader,
      });
      cancelBody = (reason) => {
        output.error(reason);
        void cancelReader(reason);
      };
      bodyOwnsCompletion = true;
      requestController.signal.addEventListener('abort', abortBody, {
        once: true,
      });
      // Observe both normal completion and errors, and also wait for underlying
      // cancellation rather than treating reader.closed as producer teardown.
      void reader.closed
        .catch(() => undefined)
        .then(async () => {
          if (cancelling) await cancelling;
          requestController.signal.removeEventListener('abort', abortBody);
          finish();
        });
      if (requestController.signal.aborted) {
        abortBody();
        throw requestController.signal.reason;
      }
      const wrapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperties(wrapped, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      });
      return wrapped;
    } catch (error) {
      if (bodyOwnsCompletion) cancelBody!(error);
      else finish();
      throw requestController.signal.aborted
        ? requestController.signal.reason
        : error;
    }
  };

  function trackChild(child: ChildProcess): Promise<void> {
    const complete = track();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      };
      child.once('close', () => {
        if (killTimer) clearTimeout(killTimer);
        controller.signal.removeEventListener('abort', onAbort);
        complete();
        resolve();
      });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
  }

  async function drain(): Promise<void> {
    if (!controller.signal.aborted)
      throw new Error('Abort scenario work before draining it');
    while (pending.size) await Promise.all([...pending]);
  }

  return {
    signal: controller.signal,
    fetchFn,
    throwIfAborted,
    abort,
    trackChild,
    drain,
    async shutdown(reason) {
      abort(reason);
      await drain();
    },
  };
}
