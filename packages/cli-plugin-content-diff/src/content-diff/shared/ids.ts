// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

/**
 * Whether `id` is a canonical, unpadded URL-safe Base64 v4 UUID, the form
 * DatoCMS accepts for client-chosen IDs.
 */
export function isPortableDatoId(id: string): boolean {
  try {
    const bytes = Buffer.from(id, 'base64url');
    return (
      bytes.length === 16 &&
      (bytes[6] & 0xf0) === 0x40 &&
      (bytes[8] & 0xc0) === 0x80 &&
      bytes.toString('base64url') === id
    );
  } catch {
    return false;
  }
}

/**
 * Whether `id` is a canonical decimal legacy ID: no sign, no leading zeros,
 * and at most 2^48 - 1, the largest numeric ID DatoCMS assigns.
 */
export function isCanonicalLegacyDatoId(id: unknown): boolean {
  return (
    typeof id === 'string' &&
    id.length <= 15 &&
    /^(0|[1-9]\d*)$/.test(id) &&
    BigInt(id) <= BigInt('281474976710655')
  );
}
