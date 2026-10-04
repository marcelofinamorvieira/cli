import { assertNotAborted } from '../engine/cancellation';
import { ContentError } from '../engine/errors';

/** Allow in-flight work to settle and the engine's owned cleanup to finish. */
export async function withInterruptHandling<T>(
  work: (signal: AbortSignal) => Promise<T>,
  onInterrupt?: (name: 'SIGINT' | 'SIGTERM') => void,
): Promise<T> {
  const controller = new AbortController();
  const interrupt = (name: 'SIGINT' | 'SIGTERM') => {
    if (controller.signal.aborted) return;
    controller.abort(
      Object.assign(
        new ContentError(
          'INTERRUPTED',
          `Content operation interrupted by ${name}.`,
        ),
        {
          exitCode: name === 'SIGINT' ? 130 : 143,
          oclif: { exit: name === 'SIGINT' ? 130 : 143 },
        },
      ),
    );
    try {
      onInterrupt?.(name);
    } catch {
      // A reporting failure must not bypass the operation's owned cleanup.
    }
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const result = await work(controller.signal);
    assertNotAborted(controller.signal);
    return result;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
