import { setTimeout as delay } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { assertNotAborted } from './cancellation';
import { DiffFile } from './diff-file';
import { ContentError, contentErrorReport, destinationChanged } from './errors';
import { assertExpectations, runOperations } from './execution';
import { environmentId as resolveEnvironmentId } from './generation';
import { withoutTrackingModel } from './migration-schema';
import { fetchSchema } from './schema';
import type { ApplyOptions, ApplyOutcome, Client } from './types';

interface Arguments {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Promise<Client>;
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

/**
 * Polls the fork until it is ready. The SDK's own wait on the fork job can
 * neither be interrupted nor report progress, so the fork is requested with
 * `immediate_return` and read back here.
 */
async function waitForFork(
  client: Client,
  id: string,
  signal?: AbortSignal,
  log?: (message: string) => void,
) {
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

function assertForkIdUnused(
  environments: Array<{ id: string }>,
  id: string,
): void {
  if (environments.some((environment) => environment.id === id))
    throw new ContentError(
      'FORK_ID_COLLISION',
      `Environment "${id}" already exists. Choose another --fork-name.`,
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
        'To proceed anyway, use the --force flag',
        'Or leave --fast-fork out: a regular fork does not block the destination while it copies',
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
  const schema = await fetchSchema(client, environmentId, (schema) =>
    withoutTrackingModel(schema, manifest.trackingModelApiKey),
  );
  if (schema.siteId !== manifest.destination.siteId)
    throw new ContentError(
      'DESTINATION_MISMATCH',
      'Destination project does not match the diff.',
    );
  if (schema.hash !== manifest.schemaHash)
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
  let forkCreated = false;
  let runStarted = false;
  let destinationId: string | undefined;
  try {
    assertNotAborted(options.signal);
    // The listing resolves "primary" as content:diff and content:export do
    // and answers the fork ID check; assertDestination checks the project.
    const environments = await args.rootClient.environments.list();
    destinationId = resolveEnvironmentId(
      options.destinationEnvironmentId ?? manifest.destination.environmentId,
      environments,
    );
    const environment = environments.find(
      (candidate) => candidate.id === destinationId,
    )!;
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
      forkId =
        options.forkName ?? `content-apply-${Math.floor(Date.now() / 1000)}`;
      // Fails fast before the checks; the fork request itself leaves the
      // ID's validation to the CMA.
      assertForkIdUnused(environments, forkId);
    }
    // Before a fork the check only fails fast: a change made meanwhile is
    // part of the fork, whose own check sees it.
    const operations = await assertDestination(
      await args.buildEnvironmentClient(destinationId),
      destinationId,
      diff,
      options,
    );
    assertNotAborted(options.signal);
    if (options.preflightOnly)
      return {
        environmentId: destinationId,
        preflightOnly: true,
        executed: false,
        operations,
        generatedCounts: manifest.counts,
      };
    let environmentId = destinationId;
    if (forkId) {
      options.log?.(`Creating destination fork "${forkId}".`);
      try {
        await args.rootClient.environments.fork(
          destinationId,
          { id: forkId },
          {
            immediate_return: true,
            ...(options.fastFork
              ? { fast: true, ...(options.force ? { force: true } : {}) }
              : {}),
          },
        );
      } catch (error) {
        throw fastForkBlocked(error, destinationId) ?? error;
      }
      forkCreated = true;
      await waitForFork(args.rootClient, forkId, options.signal, options.log);
      environmentId = forkId;
      await assertDestination(
        await args.buildEnvironmentClient(environmentId),
        environmentId,
        diff,
        options,
      );
    }
    assertNotAborted(options.signal);
    options.log?.(`Running ${operations} operations in "${environmentId}".`);
    runStarted = true;
    await runOperations(
      await args.buildEnvironmentClient(environmentId),
      diff,
      options,
    );
    return { environmentId, executed: true, operations };
  } catch (error) {
    let failure = error;
    let kept = false;
    if (forkCreated && forkId) {
      const id = forkId;
      const exists = () =>
        findMaybe(() => args.rootClient.environments.find(id));
      if (options.keepFailedFork)
        // Nothing is removed, so a failed lookup only means it may exist.
        kept = await exists().then(
          (found) => found !== null,
          () => true,
        );
      else {
        try {
          options.log?.(`Removing failed fork "${id}".`);
          if (await exists()) await args.rootClient.environments.destroy(id);
        } catch (cleanup) {
          kept = true;
          failure = cleanupIncomplete(error, id, cleanup);
        }
      }
    }
    // What the failure left behind, said once. A failed cleanup says it in
    // its own message.
    const outcome = (): string | undefined => {
      if (failure !== error) return undefined;
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
