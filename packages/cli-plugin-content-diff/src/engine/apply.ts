import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { assertNotAborted } from './cancellation';
import { DiffFile } from './diff-file';
import { ContentError, contentErrorReport, destinationChanged } from './errors';
import { assertExpectations, runOperations } from './execution';
import { projectMigrationSchema } from './migration-schema';
import { fetchSchema } from './schema';
import type { ApplyOptions, ApplyOutcome, Client } from './types';

interface Arguments {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  diffPath: string;
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

/**
 * Checks an environment against the diff: the destination project, the
 * schema (without the migration tracking model), and everything the diff
 * touches, before any write. Returns the number of operations.
 */
async function assertDestination(
  client: Client,
  environmentId: string,
  diff: DiffFile,
  options: ApplyOptions,
): Promise<number> {
  const { manifest } = diff;
  let schemaHash: string;
  try {
    const schema = await fetchSchema(client, environmentId, (schema) =>
      projectMigrationSchema(schema, manifest.destinationTracking),
    );
    if (schema.siteId !== manifest.destination.siteId)
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project does not match the diff.',
      );
    schemaHash = schema.hash;
  } catch (error) {
    if (
      error instanceof ContentError &&
      error.code === 'INVALID_MIGRATION_TRACKING_MODEL'
    )
      throw destinationChanged({ reason: 'schema' });
    throw error;
  }
  if (schemaHash !== manifest.schemaHash)
    throw destinationChanged({ reason: 'schema' });
  options.log?.(`Checking what the diff touches in "${environmentId}".`);
  return assertExpectations(client, diff, options);
}

/** Opens a diff and applies it, or with --preflight-only only checks it. */
export async function applyContentDiff(args: Arguments): Promise<ApplyOutcome> {
  const diff = await DiffFile.open(args.diffPath);
  try {
    return await applyDiff({ ...args, diff });
  } finally {
    diff.close();
  }
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
 * Checks the destination and runs the diff, in a new fork unless in place.
 * With --preflight-only this is a read-only check: no fork, no writes.
 */
async function applyDiff(
  args: Arguments & { diff: DiffFile },
): Promise<ApplyOutcome> {
  const { diff, options } = args;
  const { manifest } = diff;
  let forkId: string | undefined;
  let forkRequested = false;
  let forkAppeared = false;
  let runStarted = false;
  let destinationId: string | undefined;
  try {
    assertNotAborted(options.signal);
    destinationId =
      options.destinationEnvironmentId ?? manifest.destination.environmentId;
    const [rootSite, environment] = await Promise.all([
      args.rootClient.site.find(),
      args.rootClient.environments.find(destinationId),
    ]);
    if (rootSite.id !== manifest.destination.siteId)
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project does not match the diff.',
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
      // Fails fast before the checks; the fork request itself leaves the
      // ID's validation to the CMA.
      await assertForkIdUnused(args.rootClient, forkId);
    }
    // Before a fork the check only fails fast: a change made meanwhile is
    // part of the fork, whose own check sees it.
    const operations = await assertDestination(
      args.buildEnvironmentClient(destinationId),
      destinationId,
      diff,
      options,
    );
    const partial = Object.values(manifest.counts).some(
      (counts) => counts.skip > 0,
    );
    assertNotAborted(options.signal);
    if (options.preflightOnly)
      return {
        environmentId: destinationId,
        preflightOnly: true,
        executed: false,
        operations,
        partial,
        generatedCounts: manifest.counts,
      };
    let environmentId = destinationId;
    if (forkId) {
      // The check can take minutes, so the ID is checked again right before
      // the request: whatever answers to it afterwards was created by this
      // request and is removed on failure.
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
      await assertDestination(
        args.buildEnvironmentClient(environmentId),
        environmentId,
        diff,
        options,
      );
    }
    assertNotAborted(options.signal);
    options.log?.(`Running ${operations} operations in "${environmentId}".`);
    runStarted = true;
    await runOperations(
      args.buildEnvironmentClient(environmentId),
      diff,
      options,
    );
    return { environmentId, executed: true, operations, partial };
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
        return runStarted
          ? `The fork "${forkId}" was kept; "${destinationId}" was not changed.`
          : `The fork "${forkId}" was kept.`;
      if (!runStarted) return undefined;
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
  }
}
