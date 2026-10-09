/** Code unit order, like SQLite, so baselines do not depend on the machine locale. */
export const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
