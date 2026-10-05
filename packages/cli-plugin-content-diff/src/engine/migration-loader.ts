import { open } from 'node:fs/promises';
import { SourceMap, createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { compileFunction } from 'node:vm';
import { Worker } from 'node:worker_threads';
import * as ts from 'typescript';
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
 * Source maps stay local to this compilation, rather than entering Node's
 * process-wide source-map/module caches with every generated part.
 */
function mapError(
  error: unknown,
  filename: string,
  sourceMap: SourceMap,
): void {
  if (!(error instanceof Error) || !error.stack) return;
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  error.stack = error.stack.replace(
    new RegExp(`${escaped}:(\\d+):(\\d+)`, 'g'),
    (location, line: string, column: string) => {
      const entry = sourceMap.findEntry(Number(line) - 1, Number(column) - 1);
      return 'originalLine' in entry
        ? `${filename}:${entry.originalLine + 1}:${entry.originalColumn + 1}`
        : location;
    },
  );
}

function mappedFunction(
  original: (...args: unknown[]) => unknown,
  filename: string,
  sourceMap: SourceMap,
): (...args: unknown[]) => Promise<unknown> {
  const wrapped = async (...args: unknown[]) => {
    try {
      return await original(...args);
    } catch (error) {
      mapError(error, filename, sourceMap);
      throw error;
    }
  };
  // Preserve runtime markers attached by defineContentMigration, including
  // non-enumerable and symbol properties. Function internals stay on the wrapper.
  for (const key of Reflect.ownKeys(original)) {
    if (
      typeof key === 'string' &&
      ['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)
    )
      continue;
    Object.defineProperty(
      wrapped,
      key,
      Object.getOwnPropertyDescriptor(original, key)!,
    );
  }
  return wrapped;
}

/**
 * Load trusted migration code into a fresh CommonJS scope. This is not a
 * security sandbox: filesystem, network, and normal dependency imports are
 * available. Dependencies use ordinary Node resolution/caching; the migration
 * file itself is never registered in require.cache. V8 may nevertheless retain
 * compiled code in this isolate. Use this for the small primary entrypoint;
 * large generated parts use executeRecordedMigrationPart in disposable workers.
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
  const source = await sourceFile(filename, maximum, options.signal);
  // .mts/.mjs otherwise override CommonJS in transpileModule. The compiler's
  // synthetic suffix does not affect dependency resolution or error filenames.
  const result = ts.transpileModule(source, {
    fileName: `${filename}.ts`,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      sourceMap: true,
      inlineSources: false,
    },
  });
  const diagnostics = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostics?.length) {
    const messages = diagnostics.map((diagnostic) => {
      const position =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;
      return `${filename}${
        position ? `:${position.line + 1}:${position.character + 1}` : ''
      }: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    });
    throw new ContentError('INVALID_MIGRATION', messages.join('\n'));
  }
  assertNotAborted(options.signal);
  const sourceMap = new SourceMap(JSON.parse(result.sourceMapText!));
  const module = { exports: {} as unknown };
  try {
    const evaluate = compileFunction(
      result.outputText.replace(/\n\/\/# sourceMappingURL=.*(?:\r?\n)?$/, ''),
      ['exports', 'require', 'module', '__filename', '__dirname'],
      { filename },
    );
    evaluate(
      module.exports,
      createRequire(filename),
      module,
      filename,
      dirname(filename),
    );
  } catch (error) {
    mapError(error, filename, sourceMap);
    throw error;
  }
  assertNotAborted(options.signal);
  if (typeof module.exports === 'function') {
    module.exports = mappedFunction(
      module.exports as (...args: unknown[]) => unknown,
      filename,
      sourceMap,
    );
  } else if (
    module.exports &&
    typeof module.exports === 'object' &&
    'default' in module.exports &&
    typeof module.exports.default === 'function'
  ) {
    module.exports.default = mappedFunction(
      module.exports.default as (...args: unknown[]) => unknown,
      filename,
      sourceMap,
    );
  }
  return module.exports as T;
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
const { parentPort, workerData } = require('node:worker_threads');
const { executeMigrationPart } = require(workerData.loader);
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
parentPort.on('message', (message) => {
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
    parentPort.postMessage({ type: 'call', id, call: { resource, method, args } });
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
(async () => {
  try {
    await executeMigrationPart(workerData.path, [client], { maxBytes: workerData.maxBytes });
    await tail;
    if (firstError) throw firstError;
    parentPort.postMessage({ type: 'complete' });
  } catch (error) {
    await tail;
    parentPort.postMessage({ type: 'failure', error: errorValue(error) });
  }
})();
`;

/**
 * Compile and execute one generated part in a disposable isolate. Each awaited
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
  // Repository tests execute this source via ts-node. Published packages only
  // contain compiled .js, so production workers need no TypeScript require hook.
  if (__filename.endsWith('.ts'))
    execArgv.push(
      '--require',
      require.resolve('ts-node/register/transpile-only'),
    );
  const worker = new Worker(recordingWorker, {
    eval: true,
    execArgv,
    workerData: {
      loader: __filename,
      path: resolve(path),
      maxBytes: options.maxBytes,
    },
  });
  await new Promise<void>((resolveCompletion, rejectCompletion) => {
    let finishing = false;
    let inFlight: Promise<void> | undefined;
    const finish = async (error?: unknown) => {
      if (finishing) return;
      finishing = true;
      options.signal?.removeEventListener('abort', onAbort);
      await inFlight;
      await worker.terminate();
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
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message) => {
      if (finishing) return;
      if (message.type === 'complete') void finish();
      else if (message.type === 'failure')
        void finish(receivedError(message.error));
      else if (message.type === 'call') {
        // Install the pending promise before a handler can synchronously abort.
        inFlight = Promise.resolve().then(async () => {
          try {
            const result = await onCall(message.call);
            if (!finishing) worker.postMessage({ id: message.id, result });
          } catch (error) {
            if (!finishing)
              worker.postMessage({
                id: message.id,
                error: transferError(error),
              });
          }
        });
      }
    });
    worker.once('error', (error) => void finish(error));
    worker.once('exit', (code) => {
      if (!finishing)
        void finish(
          new ContentError(
            'MIGRATION_WORKER_EXIT',
            `Migration part exited before completing (${code}): ${resolve(
              path,
            )}`,
          ),
        );
    });
    if (options.signal?.aborted) onAbort();
  });
}
