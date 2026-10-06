import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import type { ContentMigrationClient } from './content-migration-client';
export type * from './content-migration-client';
import { assertNotAborted } from './engine/cancellation';
import { ContentError } from './engine/errors';
import {
  executeDirectMigrationPart,
  loadMigrationModule,
  validateMigrationSource,
} from './engine/migration-loader';
import type {
  Client,
  DirectApplyOptions,
  DirectApplyOutcome,
  RepairOptions,
  RepairResult,
} from './engine/types';

export interface ContentMigrationOptions {
  baseline: string;
  allowTemporarySchemaChanges?: boolean;
  concurrency?: number;
}

/** An executable CMA script with immutable metadata for the plugin runner. */
export type ContentMigration = ((
  client: ContentMigrationClient,
  signal?: AbortSignal,
) => Promise<void>) & {
  readonly format: 'datocms-content-migration';
  readonly version: 2;
  readonly options: ContentMigrationOptions;
};

interface ExecutionSession {
  signal: AbortSignal;
  controller: AbortController;
  pendingParts: Set<Promise<void>>;
  pendingCalls: Set<Promise<unknown>>;
  failure?: unknown;
  closed: boolean;
}
const activeExecutions = new WeakMap<
  ContentMigrationClient,
  ExecutionSession
>();
const calls = new AsyncLocalStorage<ExecutionSession>();
const transportKey = Symbol.for('datocms.contentMigration.transport');
const methods = {
  items: ['create', 'update', 'find', 'destroy', 'publish', 'unpublish'],
  fields: ['find', 'update'],
  scheduledPublication: ['create', 'destroy'],
  scheduledUnpublishing: ['create', 'destroy'],
  uploads: [
    'create',
    'find',
    'update',
    'destroy',
    'createFromLocalFile',
    'updateFromLocalFile',
  ],
  uploadCollections: ['create', 'find', 'update', 'destroy'],
} as const;

type Transport = (
  resource: string,
  method: string,
  args: unknown[],
) => Promise<unknown>;
function transport(client: ContentMigrationClient): Transport | undefined {
  const invoke = Reflect.get(client, transportKey);
  return typeof invoke === 'function' ? invoke : undefined;
}

function sessionFor(client: ContentMigrationClient): ExecutionSession {
  const session = activeExecutions.get(client);
  if (!session || session.closed)
    throw new ContentError(
      'INACTIVE_CONTENT_MIGRATION',
      'Migration operations must run inside defineContentMigration.',
    );
  assertNotAborted(session.signal);
  return session;
}

/** Cooperative cancellation before the next generated operation. */
export function checkMigration(client: ContentMigrationClient): void {
  // A part has no local client state. Its next IPC call is checked by the parent
  // before touching the actual CMA client; cancellation also stops the process.
  if (transport(client)) return;
  const session = sessionFor(client);
  if (session.failure !== undefined) throw session.failure;
}

function track<T>(session: ExecutionSession, operation: () => T): T {
  if (calls.getStore() === session) return operation();
  assertNotAborted(session.signal);
  const result = calls.run(session, operation);
  const pending = Promise.resolve(result);
  session.pendingCalls.add(pending);
  void pending.then(
    () => session.pendingCalls.delete(pending),
    () => session.pendingCalls.delete(pending),
  );
  return result;
}

/** Track only outstanding SDK work, while preserving the real client identity. */
function trackClient(
  client: ContentMigrationClient,
  session: ExecutionSession,
): () => void {
  const restore: Array<() => void> = [];
  try {
    for (const [resourceName, names] of Object.entries(methods)) {
      const resource = Reflect.get(client, resourceName);
      if (!resource) continue;
      for (const method of names) {
        const original = Reflect.get(resource, method);
        if (typeof original !== 'function') continue;
        const descriptor = Object.getOwnPropertyDescriptor(resource, method);
        Object.defineProperty(resource, method, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            // An SDK helper's internal calls belong to its already submitted
            // operation. Do not count them twice or interrupt its drain.
            if (calls.getStore() === session)
              return Reflect.apply(original, resource, args);
            sessionFor(client);
            return track(session, () =>
              Reflect.apply(original, resource, args),
            );
          },
        });
        restore.push(() => {
          if (descriptor) Object.defineProperty(resource, method, descriptor);
          else Reflect.deleteProperty(resource, method);
        });
      }
    }
  } catch (error) {
    for (const undo of restore.reverse()) undo();
    throw error;
  }
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}

/** Upload verified companion bytes using the public SDK's normal upload flow. */
export function uploadMigrationFile(
  client: ContentMigrationClient,
  localPath: string,
  filename: string,
): Promise<string> {
  const invoke = transport(client);
  if (invoke)
    return invoke('$migration', 'uploadFile', [
      localPath,
      filename,
    ]) as Promise<string>;
  const session = sessionFor(client);
  return track(session, () =>
    CmaClient.uploadLocalFileAndReturnPath(client as Client, localPath, {
      filename: `${randomUUID()}-${filename}`,
    }),
  );
}

/** Execute a bounded TS part; every call goes straight to the actual CMA client. */
export function runMigrationPart(
  client: ContentMigrationClient,
  path: string,
): Promise<void> {
  let session: ExecutionSession;
  try {
    session = sessionFor(client);
  } catch (error) {
    const rejected = Promise.reject(error);
    void rejected.catch(() => undefined);
    return rejected;
  }
  const work = executeDirectMigrationPart(
    path,
    ({ resource, method, args }) => {
      checkMigration(client);
      if (resource === '$migration' && method === 'uploadFile')
        return uploadMigrationFile(
          client,
          args[0] as string,
          args[1] as string,
        );
      const allowed = methods[resource as keyof typeof methods] as
        | readonly string[]
        | undefined;
      if (!allowed?.includes(method))
        throw new ContentError(
          'UNSUPPORTED_MIGRATION_CALL',
          `Unsupported CMA operation in a migration part: ${resource}.${method}`,
        );
      const target = Reflect.get(client, resource);
      const operation = Reflect.get(target, method);
      return Reflect.apply(operation, target, args);
    },
    { signal: session.signal },
  );
  session.pendingParts.add(work);
  void work.then(
    () => session.pendingParts.delete(work),
    (error) => {
      session.failure ??= error;
      session.pendingParts.delete(work);
    },
  );
  return work;
}

/**
 * Run the supplied script directly. Authors must await every operation.
 * Session bookkeeping drains outstanding SDK work; it does not interpret
 * arbitrary unawaited JavaScript or alter native Promise identity/semantics.
 */
export function defineContentMigration(
  options: ContentMigrationOptions,
  run: (client: ContentMigrationClient) => Promise<void>,
): ContentMigration {
  return Object.assign(
    async (client: ContentMigrationClient, signal?: AbortSignal) => {
      if (activeExecutions.has(client))
        throw new ContentError(
          'ACTIVE_CONTENT_MIGRATION',
          'This CMA client already has an active content migration.',
        );
      const controller = new AbortController();
      const session: ExecutionSession = {
        controller,
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
        pendingParts: new Set(),
        pendingCalls: new Set(),
        closed: false,
      };
      activeExecutions.set(client, session);
      let restore = () => {};
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        restore = trackClient(client, session);
        try {
          assertNotAborted(session.signal);
          await run(client);
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
        }
        session.closed = true;
        if (callbackFailed) controller.abort(callbackError);
        else if (session.pendingParts.size) {
          session.failure ??= new ContentError(
            'UNAWAITED_MIGRATION_PART',
            'The migration callback finished with an active part. Await every runMigrationPart call.',
          );
          controller.abort(session.failure);
        } else if (session.pendingCalls.size) {
          session.failure ??= new ContentError(
            'UNAWAITED_MIGRATION_CALL',
            'The migration callback finished with an active CMA call. Await every operation.',
          );
        }
        const drained = await Promise.allSettled([
          ...session.pendingParts,
          ...session.pendingCalls,
        ]);
        if (callbackFailed) throw callbackError;
        if (session.failure !== undefined) throw session.failure;
        const rejected = drained.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (rejected) throw rejected.reason;
        assertNotAborted(session.signal);
      } finally {
        session.closed = true;
        controller.abort();
        await Promise.allSettled([
          ...session.pendingParts,
          ...session.pendingCalls,
        ]);
        restore();
        activeExecutions.delete(client);
      }
    },
    {
      format: 'datocms-content-migration' as const,
      version: 2 as const,
      options,
    },
  );
}

export async function loadContentMigration(
  path: string,
  signal?: AbortSignal,
): Promise<ContentMigration> {
  const module = await loadMigrationModule<unknown>(path, { signal });
  const declaration =
    module && typeof module === 'object' && 'default' in module
      ? module.default
      : module;
  if (
    typeof declaration !== 'function' ||
    Reflect.get(declaration, 'format') !== 'datocms-content-migration' ||
    Reflect.get(declaration, 'version') !== 2 ||
    !Reflect.get(declaration, 'options') ||
    typeof Reflect.get(declaration, 'options').baseline !== 'string' ||
    !Reflect.get(declaration, 'options').baseline
  )
    throw new ContentError(
      'INVALID_CONTENT_MIGRATION',
      'content:apply expects a default callable exported by defineContentMigration.',
    );
  return declaration as ContentMigration;
}

export interface ContentMigrationApplyArguments {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  scriptPath: string;
  options: DirectApplyOptions;
}
export interface ContentMigrationRepairArguments {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  scriptPath: string;
  options: RepairOptions;
}
export async function applyContentMigration(
  args: ContentMigrationApplyArguments,
): Promise<DirectApplyOutcome> {
  if (args.options.preflightOnly) {
    await validateMigrationSource(args.scriptPath, {
      signal: args.options.signal,
    });
    const { directPreflight } =
      require('./engine/direct-apply') as typeof import('./engine/direct-apply');
    return directPreflight(args);
  }
  const definition = await loadContentMigration(
    args.scriptPath,
    args.options.signal,
  );
  const script = resolve(args.scriptPath);
  const companion = resolve(
    dirname(script),
    `${basename(script, '.ts')}.content`,
  );
  if (resolve(dirname(script), definition.options.baseline) !== companion)
    throw new ContentError(
      'MIGRATION_BASELINE_MISMATCH',
      'The migration must reference its generated sibling .content companion directory.',
    );
  const { directApply } =
    require('./engine/direct-apply') as typeof import('./engine/direct-apply');
  return directApply({ ...args, definition });
}

export async function repairContentMigration(
  args: ContentMigrationRepairArguments,
): Promise<RepairResult> {
  // Repair uses only the retained generated companion; edited or broken TS is never loaded.
  const { directRepair } =
    require('./engine/direct-apply') as typeof import('./engine/direct-apply');
  return directRepair(args);
}
