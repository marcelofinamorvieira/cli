import { createHash } from 'node:crypto';

/** Reproducible canonical UUIDv4 IDs with the same structure as CMA-generated IDs. */
export function fixtureId(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('base64url');
}
