const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * On SIGINT or SIGTERM, runs `cleanup`, prints `message` and exits with the
 * conventional status (130 or 143). Requests already sent may still land.
 * Returns a function that removes the handlers.
 */
export function onInterrupt(cleanup: () => void, message: string): () => void {
  const handler = (signal: keyof typeof EXIT_CODES) => {
    try {
      cleanup();
    } finally {
      process.stderr.write(`\n${message}\n`);
      process.exit(EXIT_CODES[signal]);
    }
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}
