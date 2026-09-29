// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface AssetDownloadTimeouts {
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface AssetDownloadOptions extends AssetDownloadTimeouts {
  /**
   * Cancels the request and the body transfer. The download then rejects
   * with code UPLOAD_DOWNLOAD_ABORTED after closing its output file.
   */
  signal?: AbortSignal;
}

/**
 * Streams an upload binary to `destination` while hashing it. Generation
 * (--bundle-assets) and the migration runtime (upload staging) run this same
 * function. The fallback deadlines equal the defaults of the asset timeout
 * variables in ./tuning, whose resolved values both callers pass in.
 * The migration runtime also passes its runner's abort signal.
 */
export async function downloadAsset(
  url: string,
  destination: string,
  fetchFn: typeof fetch = fetch,
  options: AssetDownloadOptions = {},
): Promise<{ md5: string; sha256: string; size: number }> {
  const duration = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(Math.max(1, value), 2_147_483_647)
      : fallback;
  const headersTimeout = duration(options.headersTimeoutMs, 2 * 60 * 1000);
  const idleTimeout = duration(options.idleTimeoutMs, 5 * 60 * 1000);
  const signal = options.signal;
  const abortedError = (reason: unknown) =>
    Object.assign(new Error('Upload download was cancelled.'), {
      code: 'UPLOAD_DOWNLOAD_ABORTED',
      cause: reason,
    });
  if (signal?.aborted) throw abortedError(signal.reason);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: Error | undefined;
  let abortError: Error | undefined;
  let readable: Readable | undefined;
  let output: ReturnType<typeof createWriteStream> | undefined;
  let outputClosed: Promise<void> | undefined;
  let response: Response | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const arm = (phase: 'headers' | 'body', milliseconds: number) => {
    clearTimeout(timeout);
    // A chunk already in flight must not re-arm a deadline after an abort.
    if (abortError) return;
    timeout = setTimeout(() => {
      timeoutError = Object.assign(
        new Error(
          phase === 'headers'
            ? `Upload download did not receive response headers within ${milliseconds}ms.`
            : `Upload download received no data for ${milliseconds}ms.`,
        ),
        {
          code: 'UPLOAD_DOWNLOAD_TIMEOUT',
          details: { phase, timeoutMilliseconds: milliseconds },
        },
      );
      rejectDeadline(timeoutError);
      controller.abort(timeoutError);
      readable?.destroy(timeoutError);
    }, milliseconds);
  };
  arm('headers', headersTimeout);
  const onAbort = () => {
    abortError = abortedError(signal?.reason);
    clearTimeout(timeout);
    rejectDeadline(abortError);
    controller.abort(abortError);
    readable?.destroy(abortError);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Observe late responses from custom fetch implementations that ignore
  // abort. They must not leave a response body open after a header timeout.
  const request = Promise.resolve().then(() =>
    fetchFn(url, { signal: controller.signal }),
  );
  void request.then(
    (lateResponse) => {
      if (controller.signal.aborted && !lateResponse.body?.locked) {
        void lateResponse.body
          ?.cancel(controller.signal.reason)
          .catch(() => undefined);
      }
    },
    () => undefined,
  );

  try {
    response = await Promise.race([request, deadline]);
    if (!response.ok || !response.body) {
      throw Object.assign(
        new Error(
          !response.ok
            ? `Cannot download upload binary (${response.status} ${response.statusText}).`
            : 'Cannot download upload binary: response has no body.',
        ),
        { code: 'UPLOAD_DOWNLOAD_FAILURE' },
      );
    }
    readable = Readable.fromWeb(response.body as never);
    arm('body', idleTimeout);
    const md5 = createHash('md5');
    const sha = createHash('sha256');
    let size = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (chunk.length > 0) arm('body', idleTimeout);
        md5.update(chunk);
        sha.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    output = createWriteStream(destination, { flags: 'wx' });
    outputClosed = new Promise<void>((resolve) => {
      output!.once('close', resolve);
    });
    const streamFailure = new Promise<never>((_resolve, reject) => {
      readable!.once('error', reject);
      hasher.once('error', reject);
      output!.once('error', reject);
    });
    // fromWeb destruction may wait forever for a custom body's cancel().
    // Race the deadline/errors, but close the output before callers clean up.
    // Promise.race also observes any later pipeline rejection after timeout.
    await Promise.race([
      pipeline(readable, hasher, output, { signal: controller.signal }),
      deadline,
      streamFailure,
    ]);
    return { md5: md5.digest('hex'), sha256: sha.digest('hex'), size };
  } catch (error) {
    const primaryError = timeoutError ?? abortError ?? error;
    controller.abort(primaryError);
    readable?.destroy(primaryError instanceof Error ? primaryError : undefined);
    output?.destroy();
    if (outputClosed) await outputClosed;
    if (response?.body && !response.body.locked) {
      void response.body.cancel(error).catch(() => undefined);
    }
    throw primaryError;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
