// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

/**
 * Maps `values` with at most `concurrency` mappers in flight, keeping input
 * order in the result. After the first failure no queued value is started,
 * but mappers already running are allowed to finish before the first error
 * is rethrown, so callers never clean up under work that is still active
 * (open streams, staging files, pending CMA requests).
 */
export async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  async function worker(): Promise<void> {
    while (!failed && next < values.length) {
      const index = next;
      next += 1;
      try {
        output[index] = await mapper(values[index], index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  if (failed) throw firstError;
  return output;
}
