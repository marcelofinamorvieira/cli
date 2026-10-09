import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { assertNotAborted } from './cancellation';
import { captureSnapshot } from './capture';
import { companionDirectory } from './companion';
import { ContentError, contentErrorReport, destinationChanged } from './errors';
import { runTrackedMigration } from './execution';
import {
  type BaselineManifest,
  compareBaseline,
  loadBaseline,
} from './migration-artifact';
import { assertMigrationFile, loadContentMigration } from './migration-loader';
import { projectMigrationSchema } from './migration-schema';
import { fetchSchema } from './schema';
import { SnapshotStore } from './store';
import type { ApplyOptions, ApplyOutcome, Client, SchemaState } from './types';

type Definition = (client: Client) => Promise<void>;
interface Arguments {
  rootClient: Client;
  buildEnvironmentClient: (
    environmentId: string,
    fetchFn?: typeof fetch,
  ) => Client;
  scriptPath: string;
  options: ApplyOptions;
}

async function findMaybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.response.status === 404)
      return null;
    throw error;
  }
}
async function waitForFork(
  client: Client,
  id: string,
  signal?: AbortSignal,
  log?: (message: string) => void,
) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  for (let wait = 1000; ; wait = Math.min(wait * 2, 10_000)) {
    assertNotAborted(signal);
    const environment = await findMaybe(() => client.environments.find(id));
    if (!environment)
      throw new ContentError(
        'FORK_FAILED',
        `DatoCMS removed failed fork "${id}".`,
      );
    if (environment.meta.status === 'ready') return environment;
    if (environment.meta.status !== 'creating')
      throw new ContentError(
        'FORK_FAILED',
        `Fork "${id}" ended in status ${environment.meta.status}.`,
      );
    if (Date.now() >= deadline)
      throw new ContentError(
        'FORK_TIMEOUT',
        `Fork "${id}" was still being created after 120 minutes.`,
      );
    log?.(
      `Waiting for fork "${id}" (${
        environment.meta.fork_completion_percentage ?? 0
      }%).`,
    );
    try {
      await delay(wait, undefined, signal ? { signal } : undefined);
    } finally {
      assertNotAborted(signal);
    }
  }
}
/** Listing keeps the requested name out of a request path. */
async function environmentExists(client: Client, id: string): Promise<boolean> {
  const existing = await client.environments.list();
  return existing.some((environment) => environment.id === id);
}

async function assertForkIdUnused(client: Client, id: string): Promise<void> {
  if (await environmentExists(client, id))
    throw new ContentError(
      'FORK_ID_COLLISION',
      `Environment "${id}" already exists. Choose another --fork-name.`,
    );
}

/**
 * A 4xx answer means the CMA did not create the fork. Anything else (a
 * timeout, a network error, a server error) may hide a fork that exists.
 */
function forkMayExist(error: unknown): boolean {
  return !(
    error instanceof CmaClient.ApiError &&
    error.response.status >= 400 &&
    error.response.status < 500
  );
}

/** The native message for a fast fork refused while editors are at work. */
function fastForkBlocked(
  error: unknown,
  destinationId: string,
): ContentError | undefined {
  if (
    !(error instanceof CmaClient.ApiError) ||
    !error.findError('ACTIVE_EDITING_SESSIONS')
  )
    return undefined;
  return Object.assign(
    new ContentError(
      'FAST_FORK_BLOCKED',
      `Cannot proceed with a fast fork of "${destinationId}", as some users are currently editing records.`,
    ),
    {
      suggestions: [
        'Run again once nobody is editing records in the destination',
        'Use --no-fast-fork to create a regular fork, which does not block the destination while it copies',
      ],
    },
  );
}

function projection(baseline: BaselineManifest) {
  return (schema: SchemaState) =>
    projectMigrationSchema(schema, baseline.destinationTracking);
}

/** Codes that mean the destination differs from what was captured. */
const BASELINE_DRIFT = new Set([
  'CAPTURE_DRIFT',
  'INVALID_MIGRATION_TRACKING_MODEL',
  // Generation captured every destination record through the same codec, so
  // a value it refuses at apply time was written after generation.
  'UNSUPPORTED_INTEGER_PRECISION',
  'INVALID_BLOCK',
]);

/** Whether the projected schema now differs from the baseline's. */
async function schemaChanged(
  client: Client,
  environmentId: string,
  baseline: BaselineManifest,
): Promise<boolean> {
  try {
    const schema = await fetchSchema(
      client,
      environmentId,
      projection(baseline),
    );
    return schema.hash !== baseline.schema.hash;
  } catch (error) {
    return (
      error instanceof ContentError &&
      error.code === 'INVALID_MIGRATION_TRACKING_MODEL'
    );
  }
}

async function assertBaseline(
  client: Client,
  environmentId: string,
  baseline: BaselineManifest,
  store: SnapshotStore,
  options: ApplyOptions,
  verify: 'none' | 'versions' | 'full',
): Promise<void> {
  try {
    const schema = await fetchSchema(
      client,
      environmentId,
      projection(baseline),
    );
    if (schema.siteId !== baseline.destination.siteId)
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project does not match the migration.',
      );
    if (schema.hash !== baseline.schema.hash)
      throw destinationChanged({ reason: 'schema' });
    store.clearSide('target');
    options.log?.(
      `Checking original migration baseline in "${environmentId}".`,
    );
    // DatoCMS has no persistent sandbox freeze; maintenance mode only protects
    // primary. These checks reject observed drift before the script starts.
    try {
      await captureSnapshot({
        client,
        environmentId,
        schema,
        store,
        side: 'target',
        options: {
          concurrency: options.concurrency,
          signal: options.signal,
          progress: options.log,
          schemaProjection: projection(baseline),
        },
        verify,
      });
    } catch (error) {
      // A schema change while records are listed can surface as a failed
      // request (a removed model, a changed field) or as content the
      // baseline schema cannot read (a new block model) rather than as drift.
      if (
        !options.signal?.aborted &&
        !(error instanceof ContentError && error.code === 'INTERRUPTED') &&
        (await schemaChanged(client, environmentId, baseline))
      )
        throw destinationChanged({ reason: 'schema' });
      throw error;
    }
  } catch (error) {
    if (!(error instanceof ContentError) || !BASELINE_DRIFT.has(error.code))
      throw error;
    throw error.code === 'INVALID_MIGRATION_TRACKING_MODEL'
      ? destinationChanged({ reason: 'schema' })
      : destinationChanged({ reason: 'drift', description: error.message });
  }
  compareBaseline(store, 'target');
}

/**
 * Load the script and apply it with the baseline in its sibling `.content`
 * companion. --preflight-only checks the file without evaluating it.
 */
export async function applyContentMigration(
  args: Arguments,
): Promise<ApplyOutcome> {
  let definition: Definition | undefined;
  if (args.options.preflightOnly)
    assertMigrationFile(args.scriptPath, args.options.signal);
  else
    definition = await loadContentMigration(
      args.scriptPath,
      args.options.signal,
    );
  // Node runs a module under its real path, so a generated script's
  // `__dirname`, which its parts are found from, has every symlink resolved;
  // its companion is found beside the same path.
  const scriptPath = await realpath(resolve(args.scriptPath));
  return applyMigration({ ...args, scriptPath, definition });
}

/**
 * The failure to report when removing the fork failed too. Its message says
 * the fork was not removed; the original failure stays machine-readable
 * under `cause`, with its exit status.
 */
function cleanupIncomplete(
  error: unknown,
  forkId: string,
  cleanup: unknown,
): ContentError {
  const original =
    error instanceof Error ? contentErrorReport(error) : undefined;
  const exit = error as { exitCode?: number; oclif?: { exit?: number } };
  return Object.assign(
    new ContentError(
      'APPLY_FAILED_CLEANUP_INCOMPLETE',
      `${
        error instanceof Error ? error.message : String(error)
      } The failed fork "${forkId}" could not be removed: ${String(cleanup)}`,
      {
        forkId,
        ...(original && {
          cause: { code: original.code, details: original.details },
        }),
      },
    ),
    { exitCode: exit?.exitCode, oclif: exit?.oclif },
  );
}

/**
 * Check the destination baseline and run a loaded migration, in a new fork
 * unless in place. Without a definition this is the read-only preflight:
 * no script, no fork.
 */
export async function applyMigration(
  args: Arguments & { definition?: Definition },
): Promise<ApplyOutcome> {
  const { definition, options } = args;
  const store = new SnapshotStore();
  let forkId: string | undefined;
  let forkRequested = false;
  let forkAppeared = false;
  let scriptStarted = false;
  let destinationId: string | undefined;
  try {
    assertNotAborted(options.signal);
    options.log?.('Validating migration baseline.');
    const baseline = await loadBaseline(
      companionDirectory(args.scriptPath),
      store,
      options.signal,
    );
    destinationId =
      options.destinationEnvironmentId ?? baseline.destination.environmentId;
    const [rootSite, environment] = await Promise.all([
      args.rootClient.site.find(),
      args.rootClient.environments.find(destinationId),
    ]);
    if (rootSite.id !== baseline.destination.siteId)
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project does not match the migration.',
      );
    // Only an in-place run writes to the destination; whether it can be
    // forked is for the fork request to answer.
    if (
      options.inPlace &&
      (environment.meta.read_only_mode || environment.meta.status !== 'ready')
    )
      throw new ContentError(
        'DESTINATION_UNAVAILABLE',
        'Destination environment is not writable and ready.',
      );
    if (options.inPlace && environment.meta.primary && !options.allowPrimary)
      throw new ContentError(
        'PRIMARY_REQUIRES_APPROVAL',
        'Applying in place to primary requires --allow-primary.',
      );
    if (!options.inPlace) {
      forkId = options.forkName ?? `content-apply-${randomUUID()}`;
      // Fails fast before the baseline capture; the fork request itself
      // leaves the ID's validation to the CMA.
      await assertForkIdUnused(args.rootClient, forkId);
    }
    // Before a fork the destination check only fails fast: a change made
    // while it captures is part of the fork, whose own check sees it, so
    // confirming this capture cannot change the outcome.
    await assertBaseline(
      args.buildEnvironmentClient(destinationId),
      destinationId,
      baseline,
      store,
      options,
      forkId && definition ? 'none' : options.verification ?? 'versions',
    );
    const partial = Object.values(baseline.counts).some(
      (counts) => counts.skip > 0,
    );
    assertNotAborted(options.signal);
    if (!definition)
      return {
        environmentId: destinationId,
        preflightOnly: true,
        scriptExecuted: false,
        partial,
        generatedCounts: baseline.counts,
      };
    let environmentId = destinationId;
    if (forkId) {
      // The capture can take minutes, so the ID is checked again right
      // before the request: whatever answers to it afterwards was created by
      // this request and is removed on failure.
      await assertForkIdUnused(args.rootClient, forkId);
      assertNotAborted(options.signal);
      options.log?.(`Creating destination fork "${forkId}".`);
      try {
        await args.rootClient.environments.fork(
          destinationId,
          { id: forkId },
          {
            immediate_return: true,
            ...(options.fastFork ? { fast: true } : {}),
          },
        );
      } catch (error) {
        forkRequested = forkMayExist(error);
        const failure = fastForkBlocked(error, destinationId) ?? error;
        // The SDK retries a fork request that timed out, so a 4xx may answer
        // the retry of a request that did create the fork. An environment
        // under the ID may still belong to someone else: report it, never
        // remove it.
        if (!forkRequested)
          forkAppeared = await environmentExists(args.rootClient, forkId).catch(
            () => false,
          );
        throw failure;
      }
      forkRequested = true;
      await waitForFork(args.rootClient, forkId, options.signal, options.log);
      environmentId = forkId;
      await assertBaseline(
        args.buildEnvironmentClient(environmentId),
        environmentId,
        baseline,
        store,
        options,
        options.verification ?? 'versions',
      );
    }
    assertNotAborted(options.signal);
    options.log?.(
      `Executing TypeScript against the CMA in "${environmentId}".`,
    );
    scriptStarted = true;
    await runTrackedMigration(
      definition,
      (fetchFn) => args.buildEnvironmentClient(environmentId, fetchFn),
      options.signal,
    );
    return { environmentId, scriptExecuted: true, partial };
  } catch (error) {
    let failure = error;
    let kept = forkAppeared;
    // A fork name the CMA may never have accepted stays out of request
    // paths: the cleanup finds it in the listing before removing it.
    if (forkRequested && forkId && options.keepFailedFork)
      // Nothing is removed, so a failed lookup only means the fork may exist.
      kept = await environmentExists(args.rootClient, forkId).catch(() => true);
    else if (forkRequested && forkId) {
      try {
        if (await environmentExists(args.rootClient, forkId)) {
          options.log?.(`Removing failed fork "${forkId}".`);
          await args.rootClient.environments.destroy(forkId);
        }
      } catch (cleanup) {
        kept = true;
        failure = cleanupIncomplete(error, forkId, cleanup);
      }
    }
    // What the failure left behind, said once. A failed cleanup says it in
    // its own message.
    const outcome = (): string | undefined => {
      if (failure !== error) return undefined;
      if (forkAppeared)
        return `The fork "${forkId}" was kept: an environment with that ID exists after the fork request failed and may have been created by a retried request of this run.`;
      if (kept)
        return scriptStarted
          ? `The fork "${forkId}" was kept; "${destinationId}" was not changed.`
          : `The fork "${forkId}" was kept.`;
      if (!scriptStarted) return undefined;
      return forkId
        ? `The fork "${forkId}" was deleted; "${destinationId}" was not changed.`
        : `Writes made before the failure remain in "${destinationId}".`;
    };
    const said = outcome();
    // A frozen failure is reported as it is.
    if (failure instanceof Error && Object.isExtensible(failure))
      Object.assign(failure, {
        ...(kept && { keptForkEnvironmentId: forkId }),
        ...(said && { outcome: said }),
      });
    throw failure;
  } finally {
    store.dispose();
  }
}
