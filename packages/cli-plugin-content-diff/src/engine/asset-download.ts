import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNotAborted } from './cancellation';
import { ContentError } from './errors';
import type { BinaryFile, UploadPlan } from './types';
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_RETRY_MS = 1000;
const MAX_DOWNLOAD_RETRY_MS = 30_000;
export function requiresBinary(entry: UploadPlan): boolean {
  return (
    (entry.action === 'create' || entry.action === 'update') &&
    Boolean(entry.desired) &&
    (!entry.baseline ||
      entry.baseline.md5 !== entry.desired!.md5 ||
      entry.baseline.size !== entry.desired!.size)
  );
}

async function writeBytes(
  handle: FileHandle,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    assertNotAborted(signal);
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (bytesWritten === 0)
      throw new ContentError(
        'ASSET_WRITE_FAILED',
        'The asset output could not be written.',
      );
    offset += bytesWritten;
  }
  assertNotAborted(signal);
}

type RetryWait = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<unknown>;

/** A network or server failure that a fresh request may not repeat. */
class TransientDownloadError extends Error {
  constructor(
    readonly failure: unknown,
    readonly retryAfter?: number,
  ) {
    super('Asset download failed transiently.');
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After holds either delay seconds or an HTTP date. */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay)
    ? Math.min(Math.max(delay, 0), MAX_DOWNLOAD_RETRY_MS)
    : undefined;
}

/** Body stream failures, such as a reset or terminated connection, are transient. */
async function* transferred(
  body: NonNullable<Response['body']>,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body) yield chunk;
  } catch (error) {
    throw new TransientDownloadError(error);
  }
}

export async function fetchBinary(
  entry: UploadPlan,
  staging: string,
  fetchFn: typeof fetch,
  retryWait: RetryWait,
  idleTimeout: number,
  signal?: AbortSignal,
): Promise<BinaryFile> {
  assertNotAborted(signal);
  const desired = entry.desired!;
  const url = new URL(desired.url);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ContentError(
      'INVALID_ASSET_URL',
      `Upload ${entry.id} has an unsupported asset URL.`,
    );
  // The ordinary CMA URL can serve optimized images or a sanitized SVG whose
  // bytes differ from the stored upload. Match the dashboard's original-file
  // download controls on this request only; retain the captured URL and other
  // query values, and still require the exact captured byte count and MD5.
  url.searchParams.set('dl', desired.filename);
  url.searchParams.set('skip-default-optimizations', 'true');
  url.searchParams.set('svg-sanitize', 'false');
  // Downloads run concurrently, so each writes its own temporary file.
  const temporary = join(staging, 'binaries', `.download-${randomUUID()}`);
  let download: Omit<BinaryFile, 'file'> | undefined;
  // Asset GETs bypass the CMA client's retries. Integrity failures and other
  // client errors are final; a retry restarts with an empty file and hashes.
  for (let attempt = 1; !download; attempt++) {
    try {
      download = await transferBinary(
        entry,
        url,
        temporary,
        fetchFn,
        idleTimeout,
        signal,
      );
    } catch (error) {
      if (!(error instanceof TransientDownloadError)) throw error;
      await rm(temporary, { force: true });
      if (attempt === DOWNLOAD_ATTEMPTS) throw error.failure;
      try {
        await retryWait(
          error.retryAfter ?? DOWNLOAD_RETRY_MS * 2 ** (attempt - 1),
          signal,
        );
      } finally {
        assertNotAborted(signal);
      }
    }
  }
  const { bytes, md5: actualMd5, sha256: actualSha256 } = download;
  if (bytes !== desired.size || actualMd5 !== desired.md5)
    throw new ContentError(
      'ASSET_INTEGRITY_FAILED',
      `Upload ${entry.id} differs from the captured binary.`,
    );
  const file = `binaries/${actualSha256}.bin`;
  assertNotAborted(signal);
  const destination = join(staging, file);
  try {
    await lstat(destination);
    await rm(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await rename(temporary, destination);
  }
  return { file, sha256: actualSha256, md5: actualMd5, bytes };
}

/** Stream one request into the temporary file, hashing what was written. */
async function transferBinary(
  entry: UploadPlan,
  url: URL,
  temporary: string,
  fetchFn: typeof fetch,
  idleTimeout: number,
  signal?: AbortSignal,
): Promise<Omit<BinaryFile, 'file'>> {
  assertNotAborted(signal);
  const desired = entry.desired!;
  // A stalled connection is abandoned after idleTimeout without any bytes and
  // retried like a dropped one; the caller's own signal still cancels.
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = globalThis.setTimeout(() => idle.abort(), idleTimeout);
  };
  const requestSignal = signal
    ? AbortSignal.any([signal, idle.signal])
    : idle.signal;
  touch();
  let response: Response;
  try {
    response = await fetchFn(url, { signal: requestSignal });
  } catch (error) {
    clearTimeout(timer);
    assertNotAborted(signal);
    throw new TransientDownloadError(error);
  }
  let handle: FileHandle | undefined;
  const md5 = createHash('md5');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    assertNotAborted(signal);
    if (!response.ok || !response.body) {
      const failure = new ContentError(
        'ASSET_DOWNLOAD_FAILED',
        `Upload ${entry.id} could not be downloaded (${response.status}).`,
      );
      throw transientStatus(response.status)
        ? new TransientDownloadError(failure, retryAfter(response))
        : failure;
    }
    handle = await open(temporary, 'wx', 0o600);
    for await (const chunk of transferred(response.body)) {
      touch();
      assertNotAborted(signal);
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > desired.size)
        throw new ContentError(
          'ASSET_INTEGRITY_FAILED',
          `Upload ${entry.id} exceeds its captured size.`,
        );
      md5.update(buffer);
      hash.update(buffer);
      await writeBytes(handle, buffer, signal);
    }
    assertNotAborted(signal);
  } catch (error) {
    // Release unread error responses and interrupted downloads alike. Native
    // fetch receives the signal too, so an idle network stream can be aborted.
    await response.body?.cancel().catch(() => undefined);
    assertNotAborted(signal);
    throw error;
  } finally {
    clearTimeout(timer);
    await handle?.close();
  }
  return { sha256: hash.digest('hex'), md5: md5.digest('hex'), bytes };
}
