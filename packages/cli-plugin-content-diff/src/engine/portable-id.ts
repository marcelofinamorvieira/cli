import { CmaClient } from '@datocms/cli-utils';

/** New entities require canonical UUID IDs; legacy numeric IDs remain readable. */
export function isPortableCreationId(id: string): boolean {
  return (
    /^[A-Za-z0-9_-]{22}$/.test(id) &&
    !/^\d+$/.test(id) &&
    CmaClient.isValidId(id) &&
    // The SDK decoder accepts base64 aliases, but our identity maps use strings.
    Buffer.from(id, 'base64url').toString('base64url') === id
  );
}
