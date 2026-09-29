import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import type { WriteStream } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import { downloadAsset } from '../../src/content-diff/shared/download-asset';
import { resolveAssetDownloadTimeouts } from '../../src/content-diff/shared/tuning';

// The module object both loaders read createWriteStream from, so a test can
// observe the output stream each download opens.
const nodeFs = createRequire(__filename)('node:fs') as typeof import('node:fs');

class DownloadClock {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private originalSetTimeout = globalThis.setTimeout;
  private originalClearTimeout = globalThis.clearTimeout;

  install() {
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.now + delay, callback });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      this.timers.delete(id);
    }) as unknown as typeof clearTimeout;
  }

  restore() {
    globalThis.setTimeout = this.originalSetTimeout;
    globalThis.clearTimeout = this.originalClearTimeout;
  }

  advance(milliseconds: number) {
    this.now += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }

  dueAt(at: number) {
    return [...this.timers.values()].some((timer) => timer.at === at);
  }

  get pending() {
    return this.timers.size;
  }
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Download did not reach the expected asynchronous state');
}

for (const implementation of ['generator', 'standalone runtime'] as const) {
  describe(`${implementation} asset download deadlines`, () => {
    let directory: string;
    let clock: DownloadClock;
    let download: typeof downloadAsset;
    let outputs: WriteStream[];
    const originalCreateWriteStream = nodeFs.createWriteStream;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'datocms-download-timeout-'));
      outputs = [];
      // Installed before the standalone runtime binds createWriteStream.
      nodeFs.createWriteStream = ((...args: unknown[]) => {
        const output = (
          originalCreateWriteStream as (...values: unknown[]) => WriteStream
        )(...args);
        outputs.push(output);
        return output;
      }) as typeof nodeFs.createWriteStream;
      if (implementation === 'generator') download = downloadAsset;
      else {
        const path = join(directory, 'runtime.cjs');
        await writeFile(
          path,
          `${renderRuntime(
            'js',
          )}\nmodule.exports.downloadAsset = downloadAsset;\n`,
        );
        download = createRequire(path)(path).downloadAsset;
      }
      clock = new DownloadClock();
      clock.install();
    });

    afterEach(async () => {
      nodeFs.createWriteStream = originalCreateWriteStream;
      clock.restore();
      await rm(directory, { recursive: true, force: true });
    });

    it('bounds header waits, aborts the request, and cancels late bodies without opening output', async () => {
      let resolveFetch!: (response: Response) => void;
      let requestSignal: AbortSignal | undefined;
      let cancelled = false;
      const path = join(directory, 'asset.bin');
      const result = download(path, path, (async (_url, options) => {
        requestSignal = options?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      }) as typeof fetch).catch(
        (error: Error & { code: string; details: unknown }) => error,
      );
      await eventually(() => requestSignal !== undefined);
      expect(clock.dueAt(120_000)).to.equal(true);
      clock.advance(120_000);
      const error = (await result) as Error & {
        code: string;
        details: unknown;
      };
      expect(error.code).to.equal('UPLOAD_DOWNLOAD_TIMEOUT');
      expect(error.details).to.deep.equal({
        phase: 'headers',
        timeoutMilliseconds: 120_000,
      });
      expect(requestSignal!.aborted).to.equal(true);
      expect(requestSignal!.reason).to.equal(error);
      expect(clock.pending).to.equal(0);
      await expectMissing(path);

      resolveFetch(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
      await eventually(() => cancelled);
      await expectMissing(path);
    });

    for (const partial of [false, true]) {
      it(`aborts and closes an idle body ${
        partial ? 'after partial data' : 'before its first chunk'
      }`, async () => {
        let body!: ReadableStreamDefaultController<Uint8Array>;
        let cancelled = false;
        let requestSignal!: AbortSignal;
        const path = join(directory, 'asset.bin');
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
        const result = download('https://example.test/asset', path, (async (
          _url,
          options,
        ) => {
          requestSignal = options!.signal!;
          return response;
        }) as typeof fetch).catch((error) => error);
        await eventually(() => clock.dueAt(300_000));
        if (partial) {
          clock.advance(20_000);
          body.enqueue(Buffer.from('partial'));
          await eventually(() => clock.dueAt(320_000));
        }
        clock.advance(300_000);
        const error = await result;
        expect(error.code).to.equal('UPLOAD_DOWNLOAD_TIMEOUT');
        expect(error.details).to.deep.equal({
          phase: 'body',
          timeoutMilliseconds: 300_000,
        });
        expect(requestSignal.aborted).to.equal(true);
        expect(cancelled).to.equal(true);
        expect(clock.pending).to.equal(0);
        const finishedBytes = await readFile(path);
        expect(partial ? ['', 'partial'] : ['']).to.include(
          finishedBytes.toString(),
        );
        clock.advance(600_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await readFile(path)).to.deep.equal(finishedBytes);
      });
    }

    for (const outputExists of [false, true]) {
      it(`settles ${
        outputExists ? 'output errors' : 'timeouts'
      } despite an uncooperative body cancellation`, async () => {
        const path = join(directory, 'asset.bin');
        if (outputExists) await writeFile(path, 'existing bytes');
        let finishCancel!: () => void;
        let cancelled = false;
        let settled = false;
        const cancel = new Promise<void>((resolve) => {
          finishCancel = resolve;
        });
        const response = new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
              return cancel;
            },
          }),
        );
        const result = download(
          'https://example.test/asset',
          path,
          (async () => response) as typeof fetch,
        )
          .catch((error) => error)
          .then((value) => {
            settled = true;
            return value;
          });
        try {
          await eventually(() => clock.dueAt(300_000));
          if (!outputExists) clock.advance(300_000);
          await eventually(() => settled);
          const error = await result;
          expect(error.code).to.equal(
            outputExists ? 'EEXIST' : 'UPLOAD_DOWNLOAD_TIMEOUT',
          );
          expect(cancelled).to.equal(true);
          expect(clock.pending).to.equal(0);
          expect(await readFile(path, 'utf8')).to.equal(
            outputExists ? 'existing bytes' : '',
          );
          // Removal succeeds after output closure although cancel() is still pending.
          await rm(path);
        } finally {
          finishCancel();
          await result;
        }
      });
    }

    it('honors tuning-resolved deadlines and defaults to the tuning defaults', async () => {
      const neverResponds = (async () =>
        new Promise<Response>(() => undefined)) as typeof fetch;
      const defaults = resolveAssetDownloadTimeouts({});
      const defaultResult = download(
        'https://example.test/default',
        join(directory, 'default.bin'),
        neverResponds,
      ).catch((error) => error);
      await eventually(() => clock.dueAt(defaults.headersTimeoutMs));
      clock.advance(defaults.headersTimeoutMs);
      expect((await defaultResult).details).to.deep.equal({
        phase: 'headers',
        timeoutMilliseconds: defaults.headersTimeoutMs,
      });

      const tuned = resolveAssetDownloadTimeouts({
        DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS: '1000',
        DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS: '2000',
      });
      const headers = download(
        'https://example.test/headers',
        join(directory, 'headers.bin'),
        neverResponds,
        tuned,
      ).catch((error) => error);
      await eventually(() => clock.dueAt(clock.now + 1_000));
      clock.advance(1_000);
      expect((await headers).details).to.deep.equal({
        phase: 'headers',
        timeoutMilliseconds: 1_000,
      });

      const body = download(
        'https://example.test/body',
        join(directory, 'body.bin'),
        (async () => new Response(new ReadableStream())) as typeof fetch,
        tuned,
      ).catch((error) => error);
      await eventually(() => clock.dueAt(clock.now + 2_000));
      clock.advance(2_000);
      expect((await body).details).to.deep.equal({
        phase: 'body',
        timeoutMilliseconds: 2_000,
      });
      expect(clock.pending).to.equal(0);
    });

    it('resets inactivity on data so a healthy transfer can exceed either deadline', async () => {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const path = join(directory, 'asset.bin');
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
        }),
      );
      const result = download(
        'https://example.test/asset',
        path,
        (async () => response) as typeof fetch,
        {
          headersTimeoutMs: 5,
          idleTimeoutMs: 10,
        },
      );
      await eventually(() => clock.dueAt(10));
      for (const chunk of ['a', 'b', 'c']) {
        clock.advance(9);
        body.enqueue(Buffer.from(chunk));
        await eventually(() => clock.dueAt(clock.now + 10));
      }
      body.close();
      expect(await result).to.deep.equal({
        md5: createHash('md5').update('abc').digest('hex'),
        sha256: createHash('sha256').update('abc').digest('hex'),
        size: 3,
      });
      expect(clock.now).to.equal(27);
      expect(await readFile(path, 'utf8')).to.equal('abc');
      expect(clock.pending).to.equal(0);
    });

    it('rejects an already aborted download before fetching', async () => {
      const controller = new AbortController();
      controller.abort(new Error('runner stopped'));
      let fetches = 0;
      const path = join(directory, 'asset.bin');
      const error = await download(
        'https://example.test/asset',
        path,
        (async () => {
          fetches += 1;
          return new Response('bytes');
        }) as typeof fetch,
        { signal: controller.signal },
      ).catch((caught) => caught);
      expect(error.code).to.equal('UPLOAD_DOWNLOAD_ABORTED');
      expect(error.cause).to.equal(controller.signal.reason);
      expect(fetches).to.equal(0);
      expect(clock.pending).to.equal(0);
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
      await expectMissing(path);
    });

    it('aborts a body mid-transfer, closes its output, and removes its abort listener', async () => {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      let requestSignal!: AbortSignal;
      const controller = new AbortController();
      const path = join(directory, 'asset.bin');
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            body = stream;
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      const result = download(
        'https://example.test/asset',
        path,
        (async (_url, options) => {
          requestSignal = options!.signal!;
          return response;
        }) as typeof fetch,
        { signal: controller.signal },
      ).catch((error) => error);
      await eventually(() => clock.dueAt(300_000));
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(1);
      body.enqueue(Buffer.from('partial'));
      for (let tick = 0; tick < 5; tick += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      controller.abort(new Error('runner stopped'));
      const error = await result;
      // The rejection waits for the output file to close, so callers can
      // remove the staging directory right away.
      expect(outputs).to.have.length(1);
      expect(outputs[0].closed).to.equal(true);
      expect(error.code).to.equal('UPLOAD_DOWNLOAD_ABORTED');
      expect(error.message).to.equal('Upload download was cancelled.');
      expect(error.cause).to.equal(controller.signal.reason);
      expect(requestSignal.aborted).to.equal(true);
      expect(requestSignal.reason).to.equal(error);
      expect(cancelled).to.equal(true);
      expect(clock.pending).to.equal(0);
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
      expect(['', 'partial']).to.include(await readFile(path, 'utf8'));
    });

    it('aborts while waiting for response headers and cancels a late body without opening output', async () => {
      let resolveFetch!: (response: Response) => void;
      let requestSignal: AbortSignal | undefined;
      let cancelled = false;
      const controller = new AbortController();
      const path = join(directory, 'asset.bin');
      // This fetch ignores its signal, so the abort must not wait for it.
      const result = download(
        'https://example.test/asset',
        path,
        (async (_url, options) => {
          requestSignal = options?.signal ?? undefined;
          return new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          });
        }) as typeof fetch,
        { signal: controller.signal },
      ).catch((error) => error);
      await eventually(() => requestSignal !== undefined);
      controller.abort(new Error('runner stopped'));
      const error = await result;
      expect(error.code).to.equal('UPLOAD_DOWNLOAD_ABORTED');
      expect(error.cause).to.equal(controller.signal.reason);
      expect(requestSignal!.aborted).to.equal(true);
      expect(requestSignal!.reason).to.equal(error);
      expect(clock.pending).to.equal(0);
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
      expect(outputs).to.deep.equal([]);
      await expectMissing(path);

      resolveFetch(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
      await eventually(() => cancelled);
      await expectMissing(path);
    });

    it('keeps a header timeout as the primary error when the signal aborts after it', async () => {
      let requestSignal: AbortSignal | undefined;
      const controller = new AbortController();
      const result = download(
        'https://example.test/asset',
        join(directory, 'asset.bin'),
        (async (_url, options) => {
          requestSignal = options?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch,
        { signal: controller.signal },
      ).catch((error) => error);
      await eventually(() => requestSignal !== undefined);
      clock.advance(120_000);
      controller.abort(new Error('runner stopped'));
      const error = await result;
      expect(error.code).to.equal('UPLOAD_DOWNLOAD_TIMEOUT');
      expect(error.details).to.deep.equal({
        phase: 'headers',
        timeoutMilliseconds: 120_000,
      });
      expect(requestSignal!.reason).to.equal(error);
      expect(clock.pending).to.equal(0);
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
    });

    it('removes its abort listener after a successful download', async () => {
      const controller = new AbortController();
      const result = await download(
        'https://example.test/asset',
        join(directory, 'asset.bin'),
        (async () => new Response('abc')) as typeof fetch,
        { signal: controller.signal },
      );
      expect(result.size).to.equal(3);
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
      expect(clock.pending).to.equal(0);
    });

    it('preserves a body failure and clears its deadline instead of replacing the primary error', async () => {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const originalError = new Error('source stream failed');
      const result = download(
        'https://example.test/asset',
        join(directory, 'asset.bin'),
        (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
            }),
          )) as typeof fetch,
      ).catch((error) => error);
      await eventually(() => clock.dueAt(300_000));
      body.error(originalError);
      expect(await result).to.equal(originalError);
      expect(clock.pending).to.equal(0);
    });
  });
}

async function expectMissing(path: string) {
  let error: unknown;
  try {
    await access(path);
  } catch (caught) {
    error = caught;
  }
  expect((error as NodeJS.ErrnoException | undefined)?.code).to.equal('ENOENT');
}
