import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners, getMaxListeners, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CmaClient } from '@datocms/cli-utils';
import {
  ScenarioCancelledError,
  createScenarioCancellation,
} from './scenario-cancellation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('real-CMA scenario cancellation', function () {
  this.timeout(10000);

  it('preserves successful streamed responses and rejects every future request after shutdown', async () => {
    let requests = 0;
    const scope = createScenarioCancellation({
      fetchFn: async () => {
        requests++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"answer":'));
              controller.enqueue(new TextEncoder().encode('42}'));
              controller.close();
            },
          }),
          { status: 201, statusText: 'Created', headers: { 'x-test': 'kept' } },
        );
      },
    });
    try {
      const response = await scope.fetchFn('https://example.invalid/items');
      assert.equal(response.status, 201);
      assert.equal(response.statusText, 'Created');
      assert.equal(response.headers.get('x-test'), 'kept');
      assert.deepEqual(await response.json(), { answer: 42 });
      await assert.rejects(scope.drain(), /Abort scenario work/);
      await scope.shutdown();
      await assert.rejects(
        scope.fetchFn('https://example.invalid/later'),
        (error) => error === scope.signal.reason,
      );
      assert.throws(
        scope.throwIfAborted,
        (error) => error === scope.signal.reason,
      );
      assert.equal(requests, 1);
    } finally {
      await scope.shutdown();
    }
  });

  it('handles bodyless responses and already-cancelled caller signals without starting work', async () => {
    let requests = 0;
    const scope = createScenarioCancellation({
      fetchFn: async () => {
        requests++;
        return new Response(null, { status: 204 });
      },
    });
    try {
      assert.equal(
        (await scope.fetchFn('https://example.invalid/empty')).status,
        204,
      );
      const caller = new AbortController();
      caller.abort();
      await assert.rejects(
        scope.fetchFn('https://example.invalid/cancelled', {
          signal: caller.signal,
        }),
        ScenarioCancelledError,
      );
      assert.equal(requests, 1);
    } finally {
      await scope.shutdown();
    }
  });

  it('releases every listener after repeated parallel response bodies and cancellation without changing other signals', async () => {
    const unrelatedSignal = new AbortController().signal;
    const unrelatedLimit = getMaxListeners(unrelatedSignal);
    let respond: ((response: Response) => void)[] = [];
    let cancelledBodies = 0;
    const scope = createScenarioCancellation({
      fetchFn: async () =>
        new Promise<Response>((resolve) => respond.push(resolve)),
    });
    const warnings: Error[] = [];
    const onWarning = (warning: Error & { target?: unknown }) => {
      if (warning.target === scope.signal) warnings.push(warning);
    };
    process.on('warning', onWarning);

    async function openResponses() {
      respond = [];
      const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
      const pending = Array.from({ length: 16 }, () =>
        scope.fetchFn('https://example.invalid/parallel'),
      );
      assert.equal(getEventListeners(scope.signal, 'abort').length, 16);
      for (const send of respond) {
        send(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                bodies.push(controller);
                controller.enqueue(new TextEncoder().encode('content'));
              },
              cancel() {
                cancelledBodies++;
              },
            }),
          ),
        );
      }
      const responses = await Promise.all(pending);
      assert.equal(getEventListeners(scope.signal, 'abort').length, 16);
      return { bodies, responses };
    }

    try {
      for (let batch = 0; batch < 3; batch++) {
        const { bodies, responses } = await openResponses();
        const content = responses.map((response) => response.text());
        for (const body of bodies) body.close();
        assert.deepEqual(await Promise.all(content), Array(16).fill('content'));
        await nextTurn();
        assert.equal(getEventListeners(scope.signal, 'abort').length, 0);
      }

      await openResponses();
      await scope.shutdown();
      await nextTurn();
      assert.equal(cancelledBodies, 16);
      assert.equal(getEventListeners(scope.signal, 'abort').length, 0);
      assert.equal(getMaxListeners(unrelatedSignal), unrelatedLimit);
      assert.equal(
        getMaxListeners(new AbortController().signal),
        unrelatedLimit,
      );
      assert.deepEqual(warnings, []);
    } finally {
      await scope.shutdown();
      process.removeListener('warning', onWarning);
    }
  });

  it('uses an actual abort signal at its deadline and drains a header wait abandoned by its caller', async () => {
    const started = deferred<AbortSignal>();
    let transportSettled = false;
    const scope = createScenarioCancellation({
      timeoutMs: 30,
      fetchFn: async (_url, init) => {
        const signal = init!.signal!;
        started.resolve(signal);
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              transportSettled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
        throw new Error('unreachable');
      },
    });
    const request = scope
      .fetchFn('https://example.invalid/headers')
      .catch((error: unknown) => error);
    const signal = await started.promise;
    await once(signal, 'abort');
    const error = await request;
    assert.ok(error instanceof ScenarioCancelledError);
    assert.equal(error, scope.signal.reason);
    await scope.drain();
    assert.equal(transportSettled, true);
    await assert.rejects(
      scope.fetchFn('https://example.invalid/retry'),
      ScenarioCancelledError,
    );
  });

  it('retains and cancels the real SDK fetch after the SDK header-only timeout has rejected', async () => {
    let signal!: AbortSignal;
    let settled = false;
    const scope = createScenarioCancellation({
      fetchFn: async (_url, init) => {
        signal = init!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              settled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });
    const client = CmaClient.buildClient({
      apiToken: 'offline-fixture',
      autoRetry: false,
      requestTimeout: 10,
      fetchFn: scope.fetchFn,
    });
    try {
      await assert.rejects(
        client.site.find(),
        (error: unknown) =>
          error instanceof Error && error.name === 'TimeoutError',
      );
      assert.equal(
        signal.aborted,
        false,
        'SDK timeout does not abort its fetch',
      );
      assert.equal(settled, false);
      await scope.shutdown();
      assert.equal(signal.aborted, true);
      assert.equal(settled, true);
    } finally {
      await scope.shutdown();
    }
  });

  for (const phase of ['headers', 'body'] as const) {
    it(`aborts native Node fetch during ${phase} and closes its local socket`, async () => {
      const accepted = deferred<void>();
      const socketClosed = deferred<void>();
      const server = createServer((_request, response) => {
        response.on('close', () => socketClosed.resolve());
        if (phase === 'body') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('{"partial":');
        }
        accepted.resolve();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const url = `http://127.0.0.1:${
        (server.address() as AddressInfo).port
      }/pending`;
      const scope = createScenarioCancellation();
      try {
        const bodyStarted = deferred<void>();
        const request = scope
          .fetchFn(url)
          .then((response) => {
            bodyStarted.resolve();
            return response.json();
          })
          .catch((error: unknown) => error);
        await accepted.promise;
        if (phase === 'body') await bodyStarted.promise;
        const reason = new ScenarioCancelledError('test cancellation');
        scope.abort(reason);
        assert.equal(await request, reason);
        await scope.drain();
        await socketClosed.promise;
      } finally {
        await scope.shutdown();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }

  it('does not declare a late ignored-abort fetch or unresolved body cancellation drained', async () => {
    const responseReady = deferred<Response>();
    const cancellationFinished = deferred<void>();
    const cancelled = deferred<void>();
    const scope = createScenarioCancellation({
      fetchFn: async () => responseReady.promise,
    });
    const request = scope
      .fetchFn('https://example.invalid/late')
      .catch((error: unknown) => error);
    scope.abort();
    let drained = false;
    const draining = scope.drain().then(() => {
      drained = true;
    });
    await nextTurn();
    assert.equal(drained, false, 'fetch has not settled yet');
    responseReady.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled.resolve();
            return cancellationFinished.promise;
          },
        }),
      ),
    );
    await cancelled.promise;
    assert.equal(await request, scope.signal.reason);
    await nextTurn();
    assert.equal(
      drained,
      false,
      'underlying producer has not finished cancelling',
    );
    cancellationFinished.resolve();
    await draining;
    assert.equal(drained, true);
  });

  it('cancels an unread body during shutdown and waits for producer teardown', async () => {
    const finished = deferred<void>();
    const cancelled = deferred<void>();
    const scope = createScenarioCancellation({
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled.resolve();
              return finished.promise;
            },
          }),
        ),
    });
    const response = await scope.fetchFn('https://example.invalid/unread');
    let drained = false;
    const shutdown = scope.shutdown().then(() => {
      drained = true;
    });
    await cancelled.promise;
    await assert.rejects(
      response.text(),
      (error) => error === scope.signal.reason,
    );
    await nextTurn();
    assert.equal(drained, false);
    finished.resolve();
    await shutdown;
  });

  it('propagates response errors and consumer cancellation without unhandled late failures', async () => {
    const producerError = new Error('producer failed');
    const scope = createScenarioCancellation({
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(producerError);
            },
          }),
        ),
    });
    await assert.rejects(
      (await scope.fetchFn('https://example.invalid/error')).text(),
      (error) => error === producerError,
    );
    await scope.shutdown();

    let cancelled = false;
    const consumer = createScenarioCancellation({
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await (
      await consumer.fetchFn('https://example.invalid/consumer')
    ).body!.cancel('consumer stopped');
    await consumer.shutdown();
    assert.equal(cancelled, true);
  });

  it('kills a CLI child on abort, escalates ignored SIGTERM, and drains only after close', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const scope = createScenarioCancellation({ childKillGraceMs: 30 });
    const childClosed = scope.trackChild(child);
    try {
      await once(child.stdout!, 'data');
      scope.abort();
      await scope.drain();
      await childClosed;
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(child.killed, true);
    } finally {
      await scope.shutdown();
    }
  });

  it('drains successful children and immediately terminates children registered after cancellation', async () => {
    const scope = createScenarioCancellation();
    await scope.trackChild(
      spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }),
    );
    await scope.shutdown();
    const late = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    const closed = scope.trackChild(late);
    await scope.drain();
    await closed;
    assert.ok(late.signalCode);
  });
});
