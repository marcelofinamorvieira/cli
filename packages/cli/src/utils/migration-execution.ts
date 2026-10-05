import type { MigrationExecutionContext } from '@datocms/cli-utils';

type Signal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';
const exitCodes: Record<Signal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/** One script plus its completion receipt; ordinary scripts never activate it. */
export function createMigrationExecution(
  options: Omit<
    MigrationExecutionContext,
    'version' | 'signal' | 'activate'
  > & {
    ownedForkEnvironmentId?: string;
  },
) {
  const controller = new AbortController();
  let active = false;
  let disposed = false;
  let discardOwnedFork = false;
  const report = (message: string) => {
    try {
      options.log(message);
    } catch {
      // A closed terminal must not prevent cleanup.
    }
  };
  const interrupt = (name: Signal) => {
    if (name === 'SIGHUP') ignoreOutputErrors();
    if (controller.signal.aborted) {
      report(
        'Migration cleanup is still running; waiting for active requests.',
      );
      return;
    }
    const exit = exitCodes[name];
    controller.abort(
      Object.assign(new Error(`Migration interrupted by ${name}.`), {
        code: 'INTERRUPTED',
        exitCode: exit,
        oclif: { exit },
      }),
    );
    report('Interrupted. Waiting for active requests and migration cleanup.');
  };
  const handlers = {
    SIGHUP: () => interrupt('SIGHUP'),
    SIGINT: () => interrupt('SIGINT'),
    SIGTERM: () => interrupt('SIGTERM'),
  };
  const { ownedForkEnvironmentId, ...contextOptions } = options;
  const context: MigrationExecutionContext = Object.freeze({
    ...contextOptions,
    trackingModel: contextOptions.trackingModel
      ? Object.freeze({ ...contextOptions.trackingModel })
      : null,
    version: 1,
    signal: controller.signal,
    activate({ discardOwnedForkOnFailure = false } = {}) {
      if (disposed)
        throw new Error('Migration execution has already finished.');
      discardOwnedFork ||= discardOwnedForkOnFailure;
      if (active) return;
      active = true;
      for (const name of Object.keys(handlers) as Signal[])
        process.on(name, handlers[name]);
    },
  });

  return {
    context,
    get active() {
      return active;
    },
    assertNotAborted() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    async cleanupAfterFailure(originalError: unknown) {
      if (
        !active ||
        !discardOwnedFork ||
        options.inPlace ||
        !ownedForkEnvironmentId
      )
        return;
      // The private ownership token is supplied only after this runner's fork
      // request succeeds. A script cannot nominate another environment here.
      if (ownedForkEnvironmentId !== options.environmentId)
        throw new Error(
          'Owned migration fork does not match execution environment.',
        );
      report(`Removing failed migration fork "${ownedForkEnvironmentId}".`);
      try {
        await options.rootClient.environments.destroy(ownedForkEnvironmentId);
        report(`Removed failed migration fork "${ownedForkEnvironmentId}".`);
      } catch (cleanupError) {
        if (
          originalError instanceof Error &&
          Object.isExtensible(originalError)
        ) {
          Object.assign(originalError, {
            keptForkEnvironmentId: ownedForkEnvironmentId,
            cleanupError:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          });
        }
        report(
          `Could not remove failed migration fork "${ownedForkEnvironmentId}". Remove it after checking the failed run.`,
        );
      }
    },
    dispose() {
      disposed = true;
      if (!active) return;
      for (const name of Object.keys(handlers) as Signal[])
        process.removeListener(name, handlers[name]);
    },
  };
}

/** A lost terminal otherwise emits EIO/EPIPE before cleanup can finish. */
function ignoreOutputErrors(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.removeAllListeners('error');
    stream.on('error', () => undefined);
  }
}
