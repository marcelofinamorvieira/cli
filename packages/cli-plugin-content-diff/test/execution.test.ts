import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pbkdf2 } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { describe, it } from 'mocha';
import { ContentError } from '../src/engine/errors';
import {
  cmaFailure,
  runTrackedMigration,
  trackRequests,
} from '../src/engine/execution';
import { runMigrationPart } from '../src/migration';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const recordData = (id: string) => ({
  id,
  type: 'item',
  attributes: {},
  relationships: {
    item_type: { data: { id: 'model', type: 'item_type' } },
  },
  meta: { current_version: '1' },
});

const record = (id: string) => json(200, { data: recordData(id) });

const unawaited = (error: ContentError) =>
  error.code === 'UNAWAITED_MIGRATION_CALL';

/** A fake CMA transport that records requests and can hold them open. */
function transport() {
  const requests: string[] = [];
  const settled: string[] = [];
  let gate: Promise<void> | undefined;
  const fetchFn: typeof fetch = async (input, init) => {
    const label = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    requests.push(label);
    if (gate) await gate;
    settled.push(label);
    return record(label.split('/').at(-1)!);
  };
  return {
    requests,
    settled,
    fetchFn,
    hold() {
      const pending = deferred();
      gate = pending.promise;
      return () => {
        gate = undefined;
        pending.resolve();
      };
    },
  };
}

const build = (fetchFn: typeof fetch) =>
  CmaClient.buildClient({
    apiToken: 'local-mock-only',
    environment: 'fork',
    autoRetry: false,
    fetchFn,
  });

const apiError = (status: number, url: string, errors: unknown[]) =>
  new CmaClient.ApiError({
    request: { method: 'PUT', url, headers: {} },
    response: {
      status,
      statusText: '',
      headers: {},
      body: { data: errors },
    },
  });

describe('tracked migration execution', () => {
  it('drains an in-flight write on interrupt, rejects later writes and lets reads continue', async () => {
    const fake = transport();
    const controller = new AbortController();
    const interruption = Object.assign(
      new ContentError(
        'INTERRUPTED',
        'Content operation interrupted by SIGINT.',
      ),
      { exitCode: 130 },
    );
    const release = fake.hold();
    let laterWrite: unknown;
    const execution = runTrackedMigration(
      async (client) => {
        await client.items.update('first', { title: 'one' });
        await client.items.find('still-readable');
        try {
          await client.items.update('second', { title: 'two' });
        } catch (error) {
          laterWrite = error;
          throw error;
        }
      },
      build,
      controller.signal,
      fake.fetchFn,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.requests, ['PUT /items/first']);
    controller.abort(interruption);
    let finished = false;
    void execution.catch(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false, 'the runner must wait for the write');
    release();
    await assert.rejects(execution, (error) => error === interruption);
    assert.equal(laterWrite, interruption);
    assert.deepEqual(fake.settled, [
      'PUT /items/first',
      'GET /items/still-readable',
    ]);
  });

  it('drains and refuses a callback that returns before its requests settle', async () => {
    const fake = transport();
    const release = fake.hold();
    const execution = runTrackedMigration(
      async (client) => {
        void client.items.update('unawaited', { title: 'late' });
      },
      build,
      undefined,
      fake.fetchFn,
    );
    let finished = false;
    void execution.catch(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    await assert.rejects(execution, unawaited);
    assert.deepEqual(fake.settled, ['PUT /items/unawaited']);
  });

  it('reports an unawaited part even while file I/O is slow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-execution-'));
    const part = join(directory, 'part.ts');
    await writeFile(
      part,
      "export default async (client: any) => { await client.items.update('from-part', { title: 'late' }); };",
    );
    // Occupy libuv's thread pool so asynchronous file I/O completes late.
    const busy = Array.from(
      { length: 8 },
      () =>
        new Promise((resolve) =>
          pbkdf2('busy', 'salt', 300_000, 32, 'sha256', resolve),
        ),
    );
    try {
      await assert.rejects(
        runTrackedMigration(
          async (client) => {
            void runMigrationPart(client, part);
          },
          build,
          undefined,
          transport().fetchFn,
        ),
        unawaited,
      );
    } finally {
      await Promise.all(busy);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('settles every request before reporting a callback failure', async () => {
    const fake = transport();
    const release = fake.hold();
    const failure = new Error('script failed');
    const execution = runTrackedMigration(
      async (client) => {
        void client.items.update('pending', {});
        throw failure;
      },
      build,
      undefined,
      fake.fetchFn,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.settled, []);
    release();
    await assert.rejects(execution, (error) => error === failure);
    assert.deepEqual(fake.settled, ['PUT /items/pending']);
  });

  it('rejects writes issued after the callback settled', async () => {
    const fake = transport();
    const tracker = trackRequests(undefined, fake.fetchFn);
    tracker.close();
    await assert.rejects(
      tracker.fetchFn('https://site-api.datocms.com/items/x', {
        method: 'DELETE',
      }),
      (error: ContentError) => error.code === 'UNAWAITED_MIGRATION_CALL',
    );
    await tracker.fetchFn('https://site-api.datocms.com/items/x');
    assert.deepEqual(fake.requests, ['GET /items/x']);
    assert.equal(tracker.pending, 0);
  });

  it('waits for a call that is waiting to poll its job, and reports it unawaited', async () => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const { pathname } = new URL(String(input));
      requests.push(`${init?.method ?? 'GET'} ${pathname}`);
      return pathname === '/items/x'
        ? json(202, { data: { id: 'job', type: 'job' } })
        : json(200, {
            data: {
              id: 'job',
              type: 'job_result',
              attributes: { status: 200, payload: { data: recordData('x') } },
            },
          });
    };
    await assert.rejects(
      runTrackedMigration(
        async (client) => {
          // The 202 settles at once; the SDK then waits before polling.
          void client.items.destroy('x');
          await delay(50);
        },
        build,
        undefined,
        fetchFn,
      ),
      unawaited,
    );
    assert.deepEqual(requests, ['DELETE /items/x', 'GET /job-results/job']);
  });

  it('waits for a rate-limited call through its retry and refuses the retry once closed', async () => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const { pathname } = new URL(String(input));
      requests.push(`${init?.method ?? 'GET'} ${pathname}`);
      return requests.length % 2
        ? json(429, {}, { 'x-ratelimit-reset': '1' })
        : record(pathname.split('/').at(-1)!);
    };
    const retrying = (fetchFn: typeof fetch) =>
      CmaClient.buildClient({
        apiToken: 'local-mock-only',
        environment: 'fork',
        fetchFn,
      });
    await runTrackedMigration(
      async (client) => {
        await client.items.update('awaited', {});
      },
      retrying,
      undefined,
      fetchFn,
    );
    assert.deepEqual(requests, ['PUT /items/awaited', 'PUT /items/awaited']);
    let retry: unknown;
    await assert.rejects(
      runTrackedMigration(
        async (client) => {
          client.items.update('floating', {}).catch((error) => {
            retry = error;
          });
          await delay(50);
        },
        retrying,
        undefined,
        fetchFn,
      ),
      unawaited,
    );
    assert.deepEqual(requests.slice(2), ['PUT /items/floating']);
    assert(retry instanceof ContentError);
    assert.equal(retry.code, 'UNAWAITED_MIGRATION_CALL');
  });

  it('keeps rejections of unawaited calls from ending the process before cleanup', async () => {
    const execution = resolve(__dirname, '../src/engine/execution.ts');
    const script = `
      const { setTimeout: delay } = require('node:timers/promises');
      const { CmaClient } = require('@datocms/cli-utils');
      const { runTrackedMigration } = require(${JSON.stringify(execution)});
      const fetchFn = async (input, init) => {
        const { pathname } = new URL(String(input));
        const id = pathname.split('/').at(-1);
        if (id === 'invalid')
          return new Response(JSON.stringify({ data: [{ id: 'e', type: 'api_error', attributes: { code: 'INVALID_FIELD', details: {} } }] }), { status: 422, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ data: { id, type: 'item', attributes: {}, relationships: { item_type: { data: { id: 'model', type: 'item_type' } } }, meta: {} } }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const build = (fetchFn) => CmaClient.buildClient({ apiToken: 'local-mock-only', environment: 'fork', autoRetry: false, fetchFn });
      const attempt = async (run) => {
        try {
          await runTrackedMigration(run, build, undefined, fetchFn);
          return 'completed';
        } catch (error) {
          await delay(50);
          return error.code + ': ' + error.message;
        }
      };
      (async () => {
        const chained = await attempt(async (client) => {
          void (async () => {
            await client.items.find('a');
            await client.items.update('a', {});
          })();
        });
        const failed = await attempt(async (client) => {
          void client.items.update('invalid', {});
          await delay(20);
        });
        const rawRequest = await attempt(async (client) => {
          void client.request({ method: 'PUT', url: '/items/invalid', body: {} });
          await delay(20);
          await client.items.find('a');
        });
        const rawMethod = await attempt(async (client) => {
          void client.uploadCollections.rawDestroy('invalid');
          await delay(20);
          await client.items.find('a');
        });
        const handledLate = await attempt(async (client) => {
          const update = client.items.update('invalid', {});
          await delay(20);
          await update.catch(() => undefined);
        });
        process.stdout.write(JSON.stringify({
          chained,
          failed,
          rawRequest,
          rawMethod,
          handledLate,
          listeners: process.listenerCount('unhandledRejection'),
        }));
      })();
    `;
    const child = spawn(
      process.execPath,
      ['--require', 'ts-node/register/transpile-only', '-e', script],
      { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let errors = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      errors += data.toString();
    });
    const code = await new Promise<number | null>((complete, reject) => {
      child.once('error', reject);
      child.once('exit', complete);
    });
    assert.equal(code, 0, errors);
    const result = JSON.parse(output);
    assert.match(result.chained, /^UNAWAITED_MIGRATION_CALL: /);
    assert.match(
      result.failed,
      /^UNAWAITED_MIGRATION_CALL: .* An unawaited call failed: The CMA rejected PUT \/items\/invalid: INVALID_FIELD\.$/,
    );
    // Calls that hand the SDK request promise straight to the script.
    assert.match(
      result.rawRequest,
      /^UNAWAITED_MIGRATION_CALL: .* An unawaited call failed: The CMA rejected PUT \/items\/invalid: INVALID_FIELD\.$/,
    );
    assert.match(
      result.rawMethod,
      /^UNAWAITED_MIGRATION_CALL: .* An unawaited call failed: The CMA rejected DELETE \/upload-collections\/invalid: INVALID_FIELD\.$/,
    );
    // Awaiting a call after it failed handles its rejection.
    assert.equal(result.handledLate, 'completed');
    assert.equal(result.listeners, 0);
  }).timeout(120_000);

  it('completes a script that leaves a paged listing early while queued page reads are in flight', async () => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('page[offset]') ?? 0);
      requests.push(`GET ${url.pathname} ${offset}`);
      // The last page is still loading when the script returns.
      if (offset === 2) await delay(30);
      return json(200, {
        data: [recordData(`r${offset}`)],
        meta: { total_count: 3 },
      });
    };
    let found: string | undefined;
    await runTrackedMigration(
      async (client) => {
        for await (const item of client.items.listPagedIterator(
          {},
          { perPage: 1 },
        )) {
          if (item.id === 'r1') {
            found = item.id;
            break;
          }
        }
      },
      build,
      undefined,
      fetchFn,
    );
    assert.equal(found, 'r1');
    assert.deepEqual(requests, [
      'GET /items 0',
      'GET /items 1',
      'GET /items 2',
    ]);
  });

  it('completes awaited scripts without inventing failures', async () => {
    const fake = transport();
    await runTrackedMigration(
      async (client) => {
        await Promise.all([
          client.items.update('a', {}),
          client.items.update('b', {}),
        ]);
      },
      build,
      undefined,
      fake.fetchFn,
    );
    assert.deepEqual(fake.settled.sort(), ['PUT /items/a', 'PUT /items/b']);
  });
});

describe('CMA failure reporting', () => {
  it('names the request, error codes and field validations of a 422', () => {
    const error = cmaFailure(
      apiError(422, 'https://site-api.datocms.com/items/abc?nested=true', [
        {
          id: '1',
          type: 'api_error',
          attributes: {
            code: 'INVALID_FIELD',
            details: { field: 'slug', code: 'VALIDATION_UNIQUE' },
          },
        },
        {
          id: '2',
          type: 'api_error',
          attributes: {
            code: 'INVALID_FIELD',
            details: { field: 'author', code: 'VALIDATION_ITEM_ITEM_TYPE' },
          },
        },
      ]),
    ) as ContentError;
    assert.equal(error.code, 'CMA_VALIDATION_FAILED');
    assert.equal(
      error.message,
      'The CMA rejected PUT /items/abc: INVALID_FIELD (slug: VALIDATION_UNIQUE); INVALID_FIELD (author: VALIDATION_ITEM_ITEM_TYPE). A unique value may still be held by another record; reorder or edit the script so that record releases it first. A referenced record or asset may be missing or unpublished; make sure the script creates or publishes it first.',
    );
    assert.deepEqual(error.details, {
      method: 'PUT',
      url: 'https://site-api.datocms.com/items/abc?nested=true',
      status: 422,
      errors: [
        {
          code: 'INVALID_FIELD',
          details: { field: 'slug', code: 'VALIDATION_UNIQUE' },
        },
        {
          code: 'INVALID_FIELD',
          details: { field: 'author', code: 'VALIDATION_ITEM_ITEM_TYPE' },
        },
      ],
    });
  });

  it('reports a stale record version as a concurrent edit', () => {
    const error = cmaFailure(
      apiError(422, 'https://site-api.datocms.com/items/abc', [
        {
          id: '1',
          type: 'api_error',
          attributes: { code: 'STALE_ITEM_VERSION', details: {} },
        },
      ]),
    ) as ContentError;
    assert.equal(error.code, 'RECORD_CHANGED_DURING_APPLY');
    assert.match(
      error.message,
      /^Record abc was modified by someone else while the migration was running\./,
    );
  });

  it('reports other CMA errors with the same context and leaves other errors alone', () => {
    const error = cmaFailure(
      apiError(404, 'https://site-api.datocms.com/uploads/u1', [
        {
          id: '1',
          type: 'api_error',
          attributes: { code: 'NOT_FOUND', details: {} },
        },
      ]),
    ) as ContentError;
    assert.equal(error.code, 'CMA_REQUEST_FAILED');
    assert.equal(
      error.message,
      'The CMA request PUT /uploads/u1 failed: NOT_FOUND.',
    );
    assert.equal(error.details?.status, 404);
    const timeout = cmaFailure(
      new CmaClient.TimeoutError({
        request: {
          method: 'PUT',
          url: 'https://site-api.datocms.com/items/rec1',
          headers: {},
        },
      }),
    ) as ContentError;
    assert.equal(timeout.code, 'CMA_REQUEST_FAILED');
    assert.equal(
      timeout.message,
      'The CMA request PUT /items/rec1 timed out; it may still have been applied.',
    );
    assert.deepEqual(timeout.details, {
      method: 'PUT',
      url: 'https://site-api.datocms.com/items/rec1',
      status: null,
      errors: [],
    });
    const plain = new Error('plain');
    assert.equal(cmaFailure(plain), plain);
  });
});
