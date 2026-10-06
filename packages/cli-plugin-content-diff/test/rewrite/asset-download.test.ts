import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { ContentError } from '../../src/engine/errors';
import type { BaselineManifest } from '../../src/engine/migration-artifact';
import { SnapshotStore } from '../../src/engine/store';
import type { PlanEntry } from '../../src/engine/types';
import {
  binaryFor,
  digest,
  metadata,
  readFixture,
  upload,
  uploadCreate,
  withUploadHash,
  writeFixture,
} from './artifact-fixture';
describe('TypeScript companion asset downloads', () => {
  let directory: string;
  const stores: SnapshotStore[] = [];
  const store = () => {
    const result = new SnapshotStore(directory);
    stores.push(result);
    return result;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-assets-test-'));
  });
  afterEach(async () => {
    for (const value of stores.splice(0)) value.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('streams and checks asset downloads, deduplicates binaries, and omits an asset list from the manifest', async () => {
    const source = store();
    const bytes = Buffer.from('binary content '.repeat(200));
    const desired = upload('one', bytes);
    const second = upload('two', bytes);
    const old = withUploadHash({
      ...second,
      md5: digest('old', 'md5'),
      size: 3,
    });
    const entries: PlanEntry[] = [
      {
        kind: 'upload',
        id: 'one',
        action: 'create',
        guard: null,
        baseline: null,
        desired,
        diagnostics: [],
      },
      {
        kind: 'upload',
        id: 'two',
        action: 'update',
        guard: { hash: old.hash },
        baseline: old,
        desired: second,
        diagnostics: [],
      },
    ];
    for (const entry of entries) source.putPlan(entry);
    let pulls = 0;
    const fetchFn = (async () => {
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 257, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
        }),
      );
    }) as typeof fetch;
    const output = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'bundle'),
      fetchFn,
    });
    assert.ok(pulls > 10);
    const files = await readdir(join(output, 'binaries'));
    assert.equal(files.length, 2);
    const [first, secondFile] = await Promise.all(
      files.map((file) => lstat(join(output, 'binaries', file))),
    );
    assert.equal(first.ino, secondFile.ino, 'identical bytes share an inode');
    const manifest = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    ) as BaselineManifest;
    assert.equal('binaries' in manifest, false);
    const imported = store();
    await readFixture({ directory: output, store: imported });
    for (const id of ['one', 'two']) {
      const saved = binaryFor(imported, id)!;
      assert.equal(saved.binary.sha256, digest(bytes));
      assert.equal(saved.binary.md5, digest(bytes, 'md5'));
      assert.equal(saved.binary.bytes, bytes.length);
      assert.deepEqual(await readFile(join(output, saved.binary.file)), bytes);
    }
  });

  it('downloads original asset bytes with dashboard controls while preserving captured URLs and other query parameters', async () => {
    for (const format of ['svg', 'jpg']) {
      const source = store();
      const bytes =
        format === 'svg'
          ? Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0"/></svg>\n',
            )
          : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 0xff, 0xd9]);
      const filename = `original + copy.${format}`;
      const capturedUrl = `https://assets.example/original.${format}?download_key=opaque%2Bvalue&keep=one&keep=two&dl=preview&skip-default-optimizations=false&svg-sanitize=true`;
      const desired = withUploadHash({
        ...upload(format, bytes),
        filename,
        url: capturedUrl,
      });
      const entry: PlanEntry = {
        kind: 'upload',
        id: format,
        action: 'create',
        baseline: null,
        desired,
        guard: null,
        diagnostics: [],
      };
      source.putPlan(entry);
      const requested: URL[] = [];
      const output = await writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: join(directory, `original-${format}`),
        fetchFn: (async (input) => {
          const url = new URL(String(input));
          requested.push(url);
          const original =
            url.searchParams.get('svg-sanitize') === 'false' &&
            url.searchParams.get('skip-default-optimizations') === 'true';
          // Imgix's default SVG sanitization adds a declaration/formatting;
          // project-level image optimizations can also change raster bytes.
          return new Response(
            original
              ? bytes
              : Buffer.concat([Buffer.from('<?xml version="1.0"?>\n'), bytes]),
          );
        }) as typeof fetch,
      });
      assert.equal(requested.length, 1);
      assert.equal(requested[0].pathname, `/original.${format}`);
      assert.equal(requested[0].searchParams.get('dl'), filename);
      assert.equal(requested[0].searchParams.get('svg-sanitize'), 'false');
      assert.equal(
        requested[0].searchParams.get('skip-default-optimizations'),
        'true',
      );
      assert.equal(
        requested[0].searchParams.get('download_key'),
        'opaque+value',
      );
      assert.deepEqual(requested[0].searchParams.getAll('keep'), [
        'one',
        'two',
      ]);
      const imported = store();
      await readFixture({ directory: output, store: imported });
      const saved = binaryFor(imported, format)!;
      assert(saved.binary);
      assert.equal(saved.url, capturedUrl);
      assert.equal(saved.binary.md5, digest(bytes, 'md5'));
      assert.equal(saved.binary.bytes, bytes.length);
      assert.deepEqual(await readFile(join(output, saved.binary.file)), bytes);
    }
  });

  it('retains exact size and checksum enforcement on original-download requests', async () => {
    const bytes = Buffer.from('unchanged original binary');
    for (const corruption of ['size', 'checksum']) {
      const source = store();
      const desired = upload(corruption, bytes);
      const entry: PlanEntry = {
        kind: 'upload',
        id: corruption,
        action: 'create',
        baseline: null,
        desired,
        guard: null,
        diagnostics: [],
      };
      source.putPlan(entry);
      const output = join(directory, `corrupt-original-${corruption}`);
      const corrupted =
        corruption === 'size'
          ? Buffer.concat([bytes, Buffer.from('extra')])
          : Buffer.from(bytes);
      if (corruption === 'checksum') corrupted[0] ^= 1;
      await assert.rejects(
        writeFixture({
          store: source,
          metadata: metadata([entry]),
          outputPath: output,
          fetchFn: (async (input) => {
            const url = new URL(String(input));
            assert.equal(
              url.searchParams.get('skip-default-optimizations'),
              'true',
            );
            assert.equal(url.searchParams.get('svg-sanitize'), 'false');
            return new Response(corrupted);
          }) as typeof fetch,
        }),
        /exceeds its captured size|differs from the captured binary/,
      );
      assert.equal(existsSync(`${output}.content`), false);
      assert.equal(existsSync(`${output}.ts`), false);
      assert.equal(
        (await readdir(directory)).some((name) =>
          name.startsWith(`.corrupt-original-${corruption}-`),
        ),
        false,
      );
    }
  });

  it('does not download an upload metadata-only update', async () => {
    const source = store();
    const baseline = upload('one', Buffer.from('asset'));
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'update',
      guard: { hash: baseline.hash },
      baseline,
      desired: withUploadHash({ ...baseline, filename: 'renamed.bin' }),
      diagnostics: [],
    };
    source.putPlan(entry);
    const output = await writeFixture({
      store: source,
      metadata: metadata([entry]),
      outputPath: join(directory, 'bundle'),
      fetchFn: (async () => {
        assert.fail('Unexpected asset download');
      }) as typeof fetch,
    });
    const imported = store();
    await readFixture({ directory: output, store: imported });
    assert.equal(binaryFor(imported, 'one'), undefined);
  });

  it('rejects overwrite and removes staging files after a mismatched or failed download', async () => {
    const source = store();
    const desired = upload('one', Buffer.from('expected'));
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired,
      diagnostics: [],
    };
    source.putPlan(entry);
    const output = join(directory, 'bundle');
    await mkdir(`${output}.content`);
    await assert.rejects(
      writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'MIGRATION_EXISTS',
    );
    assert.deepEqual(await readdir(`${output}.content`), []);
    await rm(`${output}.content`, { recursive: true });
    await assert.rejects(
      writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        fetchFn: (async () =>
          new Response(Buffer.from('wrong'))) as typeof fetch,
      }),
      /differs from the captured binary/,
    );
    assert.equal(existsSync(`${output}.content`), false);
    assert.equal(existsSync(`${output}.ts`), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-migration-'),
      ),
      false,
    );
    await assert.rejects(
      writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        fetchFn: (async () => {
          throw new Error('connection lost');
        }) as typeof fetch,
        retryWait: async () => undefined,
      }),
      /connection lost/,
    );
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-migration-'),
      ),
      false,
    );
  });

  it('cancels an unsuccessful asset response before removing its incomplete migration', async () => {
    const source = store();
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired: upload('one', Buffer.from('asset')),
      diagnostics: [],
    };
    source.putPlan(entry);
    let cancelled = false;
    const output = join(directory, 'bundle');
    await assert.rejects(
      writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        fetchFn: (async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 404 },
          )) as typeof fetch,
      }),
      /could not be downloaded \(404\)/,
    );
    assert.equal(cancelled, true);
    assert.equal(existsSync(`${output}.content`), false);
    assert.equal(existsSync(`${output}.ts`), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-migration-'),
      ),
      false,
    );
  });

  it('aborts pending asset fetches with the supplied signal and removes their incomplete migration', async () => {
    const source = store();
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired: upload('one', Buffer.from('asset')),
      diagnostics: [],
    };
    source.putPlan(entry);
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const output = join(directory, 'bundle');
    const writing = writeFixture({
      store: source,
      metadata: metadata([entry]),
      outputPath: output,
      signal: controller.signal,
      fetchFn: (async (_url, init) => {
        // The request signal combines the caller's with the idle timeout.
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        ready();
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new Error('native fetch aborted')),
            { once: true },
          );
        });
      }) as typeof fetch,
    });
    const rejected = assert.rejects(
      writing,
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    await started;
    controller.abort();
    await rejected;
    assert.equal(existsSync(`${output}.content`), false);
    assert.equal(existsSync(`${output}.ts`), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-migration-'),
      ),
      false,
    );
  });

  it('releases an interrupted asset body and rejects pre-aborted output before creating directories', async () => {
    const source = store();
    const bytes = Buffer.from('asset');
    const entry: PlanEntry = {
      kind: 'upload',
      id: 'one',
      action: 'create',
      guard: null,
      baseline: null,
      desired: upload('one', bytes),
      diagnostics: [],
    };
    source.putPlan(entry);
    const controller = new AbortController();
    let cancelled = false;
    let pulls = 0;
    const output = join(directory, 'bundle');
    await assert.rejects(
      writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        signal: controller.signal,
        fetchFn: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(stream) {
                if (++pulls > 1) controller.abort();
                stream.enqueue(bytes.subarray(0, 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
          )) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.equal(cancelled, true);
    assert.equal(existsSync(`${output}.content`), false);
    assert.equal(existsSync(`${output}.ts`), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-migration-'),
      ),
      false,
    );
    const parent = join(directory, 'never-created');
    await assert.rejects(
      writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: join(parent, 'bundle'),
        signal: controller.signal,
        fetchFn: (async () =>
          assert.fail('Pre-aborted bundle must not download')) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    assert.equal(existsSync(parent), false);
  });

  it('retries transient asset responses with capped Retry-After delays and exponential backoff', async () => {
    const source = store();
    const bytes = Buffer.from('retried asset');
    const entry = uploadCreate('one', bytes);
    source.putPlan(entry);
    const failures: [number, Record<string, string>][] = [
      [503, { 'retry-after': '3600' }],
      [429, {}],
      [502, { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }],
    ];
    let requests = 0;
    let cancelled = 0;
    const waits: number[] = [];
    const output = await writeFixture({
      store: source,
      metadata: metadata([entry]),
      outputPath: join(directory, 'bundle'),
      fetchFn: (async () => {
        const failure = failures[requests++];
        if (!failure) return new Response(bytes);
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { status: failure[0], headers: failure[1] },
        );
      }) as typeof fetch,
      retryWait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.equal(requests, 4);
    assert.equal(cancelled, 3);
    assert.deepEqual(waits, [30_000, 2000, 0]);
    const imported = store();
    await readFixture({ directory: output, store: imported });
    const saved = binaryFor(imported, 'one')!;
    assert(saved.binary);
    assert.deepEqual(await readFile(join(output, saved.binary.file)), bytes);
  });

  it('downloads asset files concurrently and writes the plan in order', async () => {
    const source = store();
    const entries = ['a', 'b', 'c'].map((id) =>
      uploadCreate(id, Buffer.from(`asset ${id}`)),
    );
    for (const entry of entries) source.putPlan(entry);
    let active = 0;
    let maximum = 0;
    const output = await writeFixture({
      store: source,
      metadata: metadata(entries),
      outputPath: join(directory, 'bundle'),
      concurrency: 2,
      fetchFn: (async (url: URL) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return new Response(Buffer.from(`asset ${url.pathname.slice(1)}`));
      }) as typeof fetch,
    });
    assert.equal(maximum, 2);
    const imported = store();
    await readFixture({ directory: output, store: imported });
    for (const id of ['a', 'b', 'c']) {
      const saved = binaryFor(imported, id)!;
      assert(saved.binary);
      assert.deepEqual(
        await readFile(join(output, saved.binary.file)),
        Buffer.from(`asset ${id}`),
      );
    }
  });

  it('retries an asset download that stalls without sending bytes', async () => {
    const source = store();
    const bytes = Buffer.from('stalled asset');
    const entry = uploadCreate('one', bytes);
    source.putPlan(entry);
    let requests = 0;
    const output = await writeFixture({
      store: source,
      metadata: metadata([entry]),
      outputPath: join(directory, 'bundle'),
      idleTimeout: 20,
      retryWait: async () => undefined,
      fetchFn: (async (_url: URL, init?: RequestInit) => {
        if (++requests === 1)
          // Never answers; only the idle timeout ends this request.
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => reject(new Error('stalled')),
              { once: true },
            );
          });
        return new Response(bytes);
      }) as typeof fetch,
    });
    assert.equal(requests, 2);
    const imported = store();
    await readFixture({ directory: output, store: imported });
    const saved = binaryFor(imported, 'one')!;
    assert(saved.binary);
  });

  it('restarts an asset download from an empty file after a network or stream failure', async () => {
    const source = store();
    const bytes = Buffer.from('restarted asset '.repeat(64));
    const entry = uploadCreate('one', bytes);
    source.putPlan(entry);
    let requests = 0;
    const waits: number[] = [];
    const output = await writeFixture({
      store: source,
      metadata: metadata([entry]),
      outputPath: join(directory, 'bundle'),
      fetchFn: (async () => {
        if (++requests === 1) throw new TypeError('fetch failed');
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (requests === 3) {
                controller.enqueue(bytes);
                controller.close();
              } else if (!sent) {
                sent = true;
                controller.enqueue(bytes.subarray(0, bytes.length / 2));
              } else controller.error(new TypeError('terminated'));
            },
          }),
        );
      }) as typeof fetch,
      retryWait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.equal(requests, 3);
    assert.deepEqual(waits, [1000, 2000]);
    const imported = store();
    await readFixture({ directory: output, store: imported });
    const saved = binaryFor(imported, 'one')!;
    assert.equal((await readdir(join(output, 'binaries'))).length, 1);
    assert.deepEqual(await readFile(join(output, saved.binary.file)), bytes);
  });

  it('stops after bounded transient attempts and never retries client or integrity failures', async () => {
    const bytes = Buffer.from('expected asset');
    const corrupted = Buffer.from(bytes);
    corrupted[0] ^= 1;
    const scenarios: [
      string,
      () => Response,
      number,
      (error: unknown) => boolean,
    ][] = [
      [
        'unavailable',
        () => new Response('busy', { status: 503 }),
        4,
        (error) =>
          error instanceof ContentError &&
          error.code === 'ASSET_DOWNLOAD_FAILED' &&
          /\(503\)/.test(error.message),
      ],
      [
        'network',
        () => {
          throw new TypeError('fetch failed');
        },
        4,
        (error) =>
          error instanceof TypeError && error.message === 'fetch failed',
      ],
      [
        'missing',
        () => new Response('missing', { status: 404 }),
        1,
        (error) =>
          error instanceof ContentError &&
          error.code === 'ASSET_DOWNLOAD_FAILED' &&
          /\(404\)/.test(error.message),
      ],
      [
        'checksum',
        () => new Response(corrupted),
        1,
        (error) =>
          error instanceof ContentError &&
          error.code === 'ASSET_INTEGRITY_FAILED',
      ],
      [
        'size',
        () => new Response(Buffer.concat([bytes, bytes])),
        1,
        (error) =>
          error instanceof ContentError &&
          error.code === 'ASSET_INTEGRITY_FAILED',
      ],
    ];
    for (const [name, respond, attempts, expected] of scenarios) {
      const source = store();
      const entry = uploadCreate(name, bytes);
      source.putPlan(entry);
      let requests = 0;
      const waits: number[] = [];
      const output = join(directory, name);
      await assert.rejects(
        writeFixture({
          store: source,
          metadata: metadata([entry]),
          outputPath: output,
          fetchFn: (async () => {
            requests++;
            return respond();
          }) as typeof fetch,
          retryWait: async (milliseconds) => {
            waits.push(milliseconds);
          },
        }),
        expected,
        name,
      );
      assert.equal(requests, attempts, name);
      assert.deepEqual(waits, [1000, 2000, 4000].slice(0, attempts - 1), name);
      assert.equal(existsSync(`${output}.content`), false);
      assert.equal(existsSync(`${output}.ts`), false);
    }
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-migration-'),
      ),
      false,
    );
  });

  it('interrupts an asset retry backoff promptly and removes its incomplete migration', async () => {
    const source = store();
    const entry = uploadCreate('one', Buffer.from('asset'));
    source.putPlan(entry);
    const controller = new AbortController();
    let requests = 0;
    const output = join(directory, 'bundle');
    const started = Date.now();
    await assert.rejects(
      writeFixture({
        store: source,
        metadata: metadata([entry]),
        outputPath: output,
        signal: controller.signal,
        fetchFn: (async () => {
          requests++;
          setTimeout(() => controller.abort(), 20);
          return new Response('busy', { status: 503 });
        }) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof ContentError && error.code === 'INTERRUPTED',
    );
    // The default first backoff is one second.
    assert.ok(Date.now() - started < 900);
    assert.equal(requests, 1);
    assert.equal(existsSync(`${output}.content`), false);
    assert.equal(existsSync(`${output}.ts`), false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith('.content-migration-'),
      ),
      false,
    );
  });
});
