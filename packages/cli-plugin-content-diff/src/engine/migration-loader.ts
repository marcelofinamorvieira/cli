import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { require as tsxRequire } from 'tsx/cjs/api';
import { assertNotAborted } from './cancellation';
import { ContentError } from './errors';
import { MAX_MIGRATION_FILE_BYTES } from './migration-limits';

/** Generated parts normally target much less; one large record may exceed it. */
export const DEFAULT_MIGRATION_FILE_BYTES = MAX_MIGRATION_FILE_BYTES;

export interface MigrationLoadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
}

export interface RecordedMigrationCall {
  resource: string;
  method: string;
  args: unknown[];
}

export type MigrationCallHandler = (
  call: RecordedMigrationCall,
) => unknown | Promise<unknown>;

async function sourceFile(
  filename: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<string> {
  const handle = await open(filename, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new ContentError(
        'INVALID_MIGRATION',
        `Migration source must be a regular file: ${filename}`,
      );
    if (info.size > maximum)
      throw new ContentError(
        'MIGRATION_FILE_TOO_LARGE',
        `Migration source exceeds ${maximum} bytes: ${filename}`,
      );
    const chunks: Buffer[] = [];
    let bytes = 0;
    const stream = handle.createReadStream({ autoClose: false });
    try {
      for await (const chunk of stream) {
        assertNotAborted(signal);
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        if (bytes > maximum)
          throw new ContentError(
            'MIGRATION_FILE_TOO_LARGE',
            `Migration source exceeds ${maximum} bytes: ${filename}`,
          );
        chunks.push(buffer);
      }
    } finally {
      stream.destroy();
    }
    assertNotAborted(signal);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      );
    } catch {
      throw new ContentError(
        'INVALID_MIGRATION',
        `Migration source is not valid UTF-8: ${filename}`,
      );
    }
  } finally {
    await handle.close();
  }
}

/**
 * Load trusted code through the same public tsx API as native migrations.
 * tsx owns TypeScript imports, project configuration and source maps. The small
 * entrypoint is evicted after loading so edits are observed on the next run;
 * dependencies retain ordinary module semantics. Large generated parts use
 * disposable processes, which release compiler services, modules and source maps.
 */
export async function loadMigrationModule<T = unknown>(
  path: string,
  options: MigrationLoadOptions = {},
): Promise<T> {
  assertNotAborted(options.signal);
  const maximum = options.maxBytes ?? DEFAULT_MIGRATION_FILE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new ContentError(
      'INVALID_MIGRATION_LIMIT',
      'Migration file size limit must be a positive safe integer.',
    );
  const filename = resolve(path);
  await sourceFile(filename, maximum, options.signal);
  assertNotAborted(options.signal);
  const moduleId = tsxRequire.resolve(filename, __filename);
  delete tsxRequire.cache[moduleId];
  try {
    const loaded = tsxRequire(filename, __filename) as T;
    assertNotAborted(options.signal);
    return loaded;
  } finally {
    delete tsxRequire.cache[moduleId];
  }
}

/** Load and await a small trusted module in the current isolate. */
export async function executeMigrationPart<
  Args extends unknown[],
  Result = unknown,
>(
  path: string,
  args: Args,
  options: MigrationLoadOptions = {},
): Promise<Result> {
  const loaded = await loadMigrationModule<unknown>(path, options);
  const work =
    typeof loaded === 'function'
      ? loaded
      : loaded && typeof loaded === 'object' && 'default' in loaded
        ? loaded.default
        : undefined;
  if (typeof work !== 'function')
    throw new ContentError(
      'INVALID_MIGRATION',
      `Migration part must export a default function: ${resolve(path)}`,
    );
  assertNotAborted(options.signal);
  const result = await work(...args);
  assertNotAborted(options.signal);
  return result as Result;
}

function transferError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error))
    return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...('code' in error && typeof error.code === 'string'
      ? { code: error.code }
      : {}),
  };
}

function receivedError(value: Record<string, unknown>): Error {
  const error =
    typeof value.code === 'string'
      ? new ContentError(value.code, String(value.message))
      : new Error(String(value.message));
  if (typeof value.name === 'string') error.name = value.name;
  if (typeof value.stack === 'string') error.stack = value.stack;
  return error;
}

// Trusted migration code runs with ordinary Node capabilities. Isolation here
// releases compiler and module memory; it does not restrict access to secrets,
// files, processes, or the network. Only the recording client crosses this IPC.
const recordingWorker = `
const { executeMigrationPart } = require(process.argv[1]);
const workerData = JSON.parse(process.argv[2]);
const pending = new Map();
let nextId = 0;
let tail = Promise.resolve();
let firstError;
const errorValue = (error) => ({
  name: error instanceof Error ? error.name : 'Error',
  message: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
  code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
});
process.on('message', (message) => {
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) {
    const error = Object.assign(new Error(message.error.message), message.error);
    item.reject(error);
  } else item.resolve(message.result);
});
const invoke = (resource, method, args) => {
  const result = tail.then(() => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    process.send({ type: 'call', id, call: { resource, method, args } }, (error) => { if (error) { pending.delete(id); reject(error); } });
  }));
  tail = result.catch((error) => { firstError ??= error; });
  return result;
};
const client = new Proxy({}, {
  get(_target, resource) {
    if (typeof resource !== 'string' || resource === 'then') return undefined;
    return new Proxy({}, {
      get(_resource, method) {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (...args) => invoke(resource, method, args);
      },
    });
  },
});
const complete = (message) => new Promise((resolve, reject) => {
  process.send(message, (error) => {
    if (process.connected) process.disconnect();
    if (error) reject(error); else resolve();
  });
});
(async () => {
  try {
    await executeMigrationPart(workerData.path, [client], { maxBytes: workerData.maxBytes });
    await tail;
    if (firstError) throw firstError;
    await complete({ type: 'complete' });
  } catch (error) {
    await tail;
    await complete({ type: 'failure', error: errorValue(error) });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
`;

/**
 * Compile and execute one generated part in a disposable Node process. Each awaited
 * client.resource.method(...args) is recorded by the parent and receives its
 * returned value. At most one handler runs at once, even for Promise.all calls.
 * Completion and cancellation both drain submitted handlers before teardown.
 */
export async function executeRecordedMigrationPart(
  path: string,
  onCall: MigrationCallHandler,
  options: MigrationLoadOptions = {},
): Promise<void> {
  assertNotAborted(options.signal);
  const execArgv: string[] = [];
  // Repository tests load this source; published workers receive compiled JS.
  // Resolve outside any scoped tsx namespace so --require receives a file path.
  if (__filename.endsWith('.ts'))
    execArgv.push('--require', createRequire(__filename).resolve('tsx/cjs'));
  // tsx uses esbuild's synchronous compiler worker and service subprocess.
  // Disposing a Node worker thread strands that service as a zombie until the
  // CLI exits. A process boundary releases the complete compiler process tree.
  const worker = spawn(
    process.execPath,
    [
      ...execArgv,
      '--eval',
      recordingWorker,
      __filename,
      JSON.stringify({ path: resolve(path), maxBytes: options.maxBytes }),
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced',
    },
  );
  await new Promise<void>((resolveCompletion, rejectCompletion) => {
    let finishing = false;
    let closed = false;
    let inFlight: Promise<void> | undefined;
    const exited = new Promise<void>((resolveExit) => {
      worker.once('close', () => {
        closed = true;
        resolveExit();
      });
    });
    const waitForExit = (milliseconds: number) =>
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, milliseconds);
        void exited.then(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    const finish = async (error?: unknown, graceful = false) => {
      if (finishing) return;
      finishing = true;
      options.signal?.removeEventListener('abort', onAbort);
      await inFlight;
      // Successful parts disconnect their IPC channel and exit naturally,
      // allowing Node to close the compiler's own workers and subprocesses.
      if (graceful && !closed) await waitForExit(1000);
      if (!closed) {
        worker.kill('SIGTERM');
        await waitForExit(1000);
      }
      if (!closed) worker.kill('SIGKILL');
      await exited;
      if (error !== undefined) rejectCompletion(error);
      else resolveCompletion();
    };
    const onAbort = () => {
      try {
        assertNotAborted(options.signal);
      } catch (error) {
        void finish(error);
      }
    };
    const reply = (message: unknown) => {
      if (finishing || !worker.connected) return;
      worker.send(message as object, (error) => {
        if (error && !finishing) void finish(error);
      });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (value) => {
      if (finishing || !value || typeof value !== 'object') return;
      const message = value as {
        type?: string;
        id?: number;
        call?: RecordedMigrationCall;
        error?: Record<string, unknown>;
      };
      if (message.type === 'complete') void finish(undefined, true);
      else if (message.type === 'failure')
        void finish(receivedError(message.error!), true);
      else if (message.type === 'call') {
        // Install the pending promise before a handler can synchronously abort.
        inFlight = Promise.resolve().then(async () => {
          try {
            const result = await onCall(message.call!);
            reply({ id: message.id, result });
          } catch (error) {
            reply({ id: message.id, error: transferError(error) });
          }
        });
      }
    });
    worker.once('error', (error) => void finish(error));
    worker.once('close', (code, signal) => {
      if (!finishing)
        void finish(
          new ContentError(
            'MIGRATION_WORKER_EXIT',
            `Migration part exited before completing (${
              code ?? signal
            }): ${resolve(path)}`,
          ),
        );
    });
    if (options.signal?.aborted) onAbort();
  });
}
