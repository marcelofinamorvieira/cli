import { assertNotAborted } from '../engine/cancellation';
import { ContentError } from '../engine/errors';

type InterruptSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

// Conventional 128 + signal number exit statuses.
const EXIT_CODES: Record<InterruptSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/** Allow in-flight work to settle and the engine's owned cleanup to finish. */
export async function withInterruptHandling<T>(
  work: (signal: AbortSignal) => Promise<T>,
  onInterrupt?: (name: InterruptSignal) => void,
): Promise<T> {
  const controller = new AbortController();
  const interrupt = (name: InterruptSignal) => {
    if (name === 'SIGHUP') ignoreOutputErrors();
    if (controller.signal.aborted) {
      // Cleanup is never abandoned; a repeated signal only gets feedback.
      process.stderr.write(
        'Cleanup is still in progress, waiting for pending requests to settle. Forced termination skips cleanup.\n',
      );
      return;
    }
    const exit = EXIT_CODES[name];
    controller.abort(
      Object.assign(
        new ContentError(
          'INTERRUPTED',
          `Content operation interrupted by ${name}.`,
        ),
        { exitCode: exit, oclif: { exit } },
      ),
    );
    try {
      onInterrupt?.(name);
    } catch {
      // A reporting failure must not bypass the operation's owned cleanup.
    }
  };
  const onSighup = () => interrupt('SIGHUP');
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.on('SIGHUP', onSighup);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const result = await work(controller.signal);
    assertNotAborted(controller.signal);
    return result;
  } finally {
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

/**
 * After a hangup (closed terminal, dropped SSH session) every write fails with
 * EIO or EPIPE. Unhandled, the error event ends the process before its owned
 * cleanup; oclif's own stdout handler rethrows everything except EPIPE.
 */
function ignoreOutputErrors(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.removeAllListeners('error');
    stream.on('error', () => undefined);
  }
}
