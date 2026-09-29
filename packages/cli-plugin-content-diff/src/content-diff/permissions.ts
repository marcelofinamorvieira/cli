import type { CmaClient } from '@datocms/cli-utils';
import type { ItemTypeSchemaSnapshot } from './types';
import { ContentDiffError } from './types';

type Permission = Record<string, unknown> & {
  action?: string;
  environment?: string;
  item_type?: string | null;
  localization_scope?: unknown;
  workflow?: string | null;
  upload_collection?: string | null;
  on_creator?: string;
  on_stage?: string | null;
};

type EffectivePermissions = {
  can_edit_schema?: boolean;
  can_manage_upload_collections?: boolean;
  positive_item_type_permissions?: Permission[];
  negative_item_type_permissions?: Permission[];
  positive_upload_permissions?: Permission[];
  negative_upload_permissions?: Permission[];
};

/** Proves schema-edit authority before emitting a plan that will edit fields. */
export async function assertCanEditSchema(
  client: CmaClient.Client,
): Promise<void> {
  const actor = (await client.users.findMe({ include: 'role' })) as unknown as
    | Record<string, any>
    | undefined;

  if (!actor) {
    throw unprovenSchemaEditAccess('The CMA did not return the current actor.');
  }

  if (actor.type === 'account' || actor.type === 'organization') return;
  if (actor.type === 'access_token' && actor.hardcoded_type === 'admin') {
    return;
  }

  const roleReference = actor.role;

  if (!roleReference || typeof roleReference.id !== 'string') {
    throw unprovenSchemaEditAccess(
      'The current actor has no directly inspectable effective role.',
    );
  }

  const role = roleReference.meta?.final_permissions
    ? roleReference
    : ((await client.roles.find(roleReference.id)) as unknown as Record<
        string,
        any
      >);
  const permissions = role.meta?.final_permissions as
    | EffectivePermissions
    | undefined;

  if (permissions?.can_edit_schema !== true) {
    throw unprovenSchemaEditAccess(
      'The current effective role does not grant schema editing.',
    );
  }
}

/**
 * Collection endpoints are permission-filtered. A content diff is therefore
 * authoritative only after positively proving that its credential can read
 * every record and upload in both environments.
 */
export async function assertUnrestrictedReadAccess(
  client: CmaClient.Client,
  environmentIds: readonly string[],
  itemTypes: readonly ItemTypeSchemaSnapshot[],
): Promise<void> {
  const actor = (await client.users.findMe({ include: 'role' })) as unknown as
    | Record<string, any>
    | undefined;

  if (!actor) {
    throw unprovenAccess('The CMA did not return the current actor.');
  }

  if (actor.type === 'account' || actor.type === 'organization') {
    return;
  }

  if (actor.type === 'access_token' && actor.hardcoded_type === 'admin') {
    return;
  }

  if (actor.type === 'access_token' && actor.hardcoded_type === 'readonly') {
    throw unprovenAccess(
      'The built-in read-only API token cannot read upload collections.',
    );
  }

  const roleReference = actor.role;

  if (!roleReference || typeof roleReference.id !== 'string') {
    throw unprovenAccess(
      'The current actor has no directly inspectable effective role.',
    );
  }

  const role = roleReference.meta?.final_permissions
    ? roleReference
    : ((await client.roles.find(roleReference.id)) as unknown as Record<
        string,
        any
      >);
  const permissions = role.meta?.final_permissions as
    | EffectivePermissions
    | undefined;

  if (!permissions) {
    throw unprovenAccess(
      'The current role response does not expose effective permissions.',
    );
  }

  // Upload-collection index/show is additionally guarded for access tokens,
  // even when their upload read rules are otherwise unrestricted.
  if (
    actor.type === 'access_token' &&
    permissions.can_manage_upload_collections !== true
  ) {
    throw unprovenAccess(
      'The current access token cannot read upload collections.',
    );
  }

  const regularItemTypes = itemTypes.filter(
    ({ modularBlock }) => !modularBlock,
  );

  for (const environmentId of environmentIds) {
    for (const itemType of regularItemTypes) {
      if (!canReadEveryRecord(permissions, environmentId, itemType)) {
        throw unprovenAccess(
          `The current role cannot prove unrestricted reads for model "${itemType.apiKey}" in environment "${environmentId}".`,
          environmentId,
          itemType.id,
        );
      }
    }

    if (!canReadEveryUpload(permissions, environmentId)) {
      throw unprovenAccess(
        `The current role cannot prove unrestricted upload reads in environment "${environmentId}".`,
        environmentId,
      );
    }
  }
}

function canReadEveryRecord(
  permissions: EffectivePermissions,
  environmentId: string,
  itemType: ItemTypeSchemaSnapshot,
): boolean {
  const positives = permissions.positive_item_type_permissions ?? [];
  const negatives = permissions.negative_item_type_permissions ?? [];
  const granted = positives.some(
    (permission) =>
      isReadAction(permission.action) &&
      permission.environment === environmentId &&
      permission.on_creator === 'anyone' &&
      hasUnrestrictedLocalization(permission) &&
      !permission.on_stage &&
      matchesItemType(permission, itemType),
  );
  const denied = negatives.some(
    (permission) =>
      isReadAction(permission.action) &&
      permission.environment === environmentId &&
      matchesItemType(permission, itemType),
  );

  return granted && !denied;
}

function canReadEveryUpload(
  permissions: EffectivePermissions,
  environmentId: string,
): boolean {
  const positives = permissions.positive_upload_permissions ?? [];
  const negatives = permissions.negative_upload_permissions ?? [];
  const granted = positives.some(
    (permission) =>
      isReadAction(permission.action) &&
      permission.environment === environmentId &&
      permission.on_creator === 'anyone' &&
      hasUnrestrictedLocalization(permission) &&
      !permission.upload_collection,
  );
  const denied = negatives.some(
    (permission) =>
      isReadAction(permission.action) &&
      permission.environment === environmentId,
  );

  return granted && !denied;
}

function matchesItemType(
  permission: Permission,
  itemType: ItemTypeSchemaSnapshot,
): boolean {
  if (permission.item_type) {
    return permission.item_type === itemType.id;
  }

  if (permission.workflow) {
    return permission.workflow === itemType.workflowId;
  }

  return true;
}

function isReadAction(action: unknown): boolean {
  return action === 'read' || action === 'all';
}

function hasUnrestrictedLocalization(permission: Permission): boolean {
  return (
    permission.localization_scope === undefined ||
    permission.localization_scope === null ||
    permission.localization_scope === 'all'
  );
}

function unprovenAccess(
  message: string,
  environmentId?: string,
  itemTypeId?: string,
): ContentDiffError {
  return new ContentDiffError(
    'UNPROVEN_FULL_ACCESS',
    `${message} Content diff refuses to treat permission-filtered results as complete.`,
    {
      ...(environmentId ? { environmentId } : {}),
      ...(itemTypeId ? { itemTypeId } : {}),
    },
  );
}

function unprovenSchemaEditAccess(message: string): ContentDiffError {
  return new ContentDiffError(
    'UNPROVEN_SCHEMA_EDIT_ACCESS',
    `${message} Content diff refuses to generate temporary validator relaxations without proven schema-edit permission.`,
  );
}
