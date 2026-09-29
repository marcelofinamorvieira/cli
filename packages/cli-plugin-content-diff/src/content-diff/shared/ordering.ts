// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

/** Stable ordering for identifiers and canonical state across process locales. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Orders missing values (null or undefined) first, then by string form. */
export function compareNullable(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return compareStrings(String(left), String(right));
}
