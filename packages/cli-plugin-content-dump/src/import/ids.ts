import { createHash } from 'node:crypto';

/**
 * The ID a record, block, upload or upload folder gets in the destination.
 * The CMA accepts only UUIDs (version 4, in URL-safe base64) as the ID of a
 * new entity, while older projects still hold numeric IDs. Each numeric ID
 * is replaced by a UUID derived from it, so every reference to it gets the
 * same one, in every import of the dump. Other IDs are kept.
 */
export function importedId(id: string): string {
  if (!/^\d+$/.test(id)) return id;
  const bytes = createHash('sha256')
    .update(`datocms-legacy-id:${id}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytes.toString('base64url');
}
