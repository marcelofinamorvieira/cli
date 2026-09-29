import { expect } from 'chai';
import {
  assertCanEditSchema,
  assertUnrestrictedReadAccess,
} from '../../src/content-diff/permissions';
import type { ItemTypeSchemaSnapshot } from '../../src/content-diff/types';
import { ContentDiffError } from '../../src/content-diff/types';

type TestClient = Parameters<typeof assertUnrestrictedReadAccess>[0];

const MODEL: ItemTypeSchemaSnapshot = {
  id: 'model-id',
  apiKey: 'article',
  name: 'Article',
  modularBlock: false,
  singleton: false,
  sortable: false,
  tree: false,
  draftModeActive: true,
  draftSavingActive: false,
  allLocalesRequired: false,
  workflowId: null,
  fields: [],
};

const BLOCK: ItemTypeSchemaSnapshot = {
  ...MODEL,
  id: 'block-model-id',
  apiKey: 'hero',
  name: 'Hero',
  modularBlock: true,
};

describe('content diff permission proof', () => {
  it('accepts project owners and the hardcoded admin access token', async () => {
    for (const actor of [
      { type: 'account' },
      { type: 'organization' },
      { type: 'access_token', hardcoded_type: 'admin' },
    ]) {
      const { client } = makeClient(actor);

      await assertUnrestrictedReadAccess(
        client,
        ['source', 'destination'],
        [MODEL],
      );
    }
  });

  it('rejects access tokens that cannot read upload collections', async () => {
    const readonlyError = await expectUnproven(
      assertUnrestrictedReadAccess(
        makeClient({ type: 'access_token', hardcoded_type: 'readonly' }).client,
        ['source'],
        [MODEL],
      ),
    );
    expect(readonlyError.message).to.contain('read upload collections');

    const restricted = broadPermissions(['source']);
    restricted.can_manage_upload_collections = false;
    await expectUnproven(
      assertUnrestrictedReadAccess(
        makeClient({
          type: 'access_token',
          role: {
            id: 'role-id',
            meta: { final_permissions: restricted },
          },
        }).client,
        ['source'],
        [MODEL],
      ),
    );

    const permitted = broadPermissions(['source']);
    await assertUnrestrictedReadAccess(
      makeClient({
        type: 'access_token',
        role: {
          id: 'role-id',
          meta: { final_permissions: permitted },
        },
      }).client,
      ['source'],
      [MODEL],
    );
  });

  it('accepts broad effective read permissions for every environment', async () => {
    const permissions = broadPermissions(['source', 'destination']);
    const { client, roleRequests } = makeClient({
      type: 'user',
      role: { id: 'role-id', meta: { final_permissions: permissions } },
    });

    await assertUnrestrictedReadAccess(
      client,
      ['source', 'destination'],
      [MODEL, BLOCK],
    );

    expect(roleRequests).to.deep.equal([]);
  });

  it('fetches the role when the included reference lacks effective permissions', async () => {
    const role = {
      id: 'role-id',
      meta: { final_permissions: broadPermissions(['source']) },
    };
    const { client, roleRequests } = makeClient(
      { type: 'user', role: { id: 'role-id' } },
      role,
    );

    await assertUnrestrictedReadAccess(client, ['source'], [MODEL]);

    expect(roleRequests).to.deep.equal(['role-id']);
  });

  it('rejects creator-filtered or negatively scoped record reads', async () => {
    const creatorFiltered = broadPermissions(['source']);
    creatorFiltered.positive_item_type_permissions[0].on_creator = 'self';
    const creatorError = await expectUnproven(
      assertUnrestrictedReadAccess(
        makeClient({
          type: 'user',
          role: {
            id: 'role-id',
            meta: { final_permissions: creatorFiltered },
          },
        }).client,
        ['source'],
        [MODEL],
      ),
    );

    expect(creatorError.details).to.deep.equal({
      environmentId: 'source',
      itemTypeId: MODEL.id,
    });

    const denied = broadPermissions(['source']);
    denied.negative_item_type_permissions.push({
      action: 'read',
      environment: 'source',
      item_type: MODEL.id,
      on_creator: 'anyone',
    });

    await expectUnproven(
      assertUnrestrictedReadAccess(
        makeClient({
          type: 'user',
          role: { id: 'role-id', meta: { final_permissions: denied } },
        }).client,
        ['source'],
        [MODEL],
      ),
    );
  });

  it('rejects upload reads restricted to a collection', async () => {
    const permissions = broadPermissions(['source']);
    permissions.positive_upload_permissions[0].upload_collection =
      'collection-id';
    const error = await expectUnproven(
      assertUnrestrictedReadAccess(
        makeClient({
          type: 'user',
          role: { id: 'role-id', meta: { final_permissions: permissions } },
        }).client,
        ['source'],
        [MODEL],
      ),
    );

    expect(error.details).to.deep.equal({ environmentId: 'source' });
    expect(error.message).to.contain('unrestricted upload reads');
  });

  it('rejects locale-restricted record and upload reads', async () => {
    const recordRestricted = broadPermissions(['source']);
    (
      recordRestricted.positive_item_type_permissions[0] as Record<
        string,
        unknown
      >
    ).localization_scope = ['en'];
    await expectUnproven(
      assertUnrestrictedReadAccess(
        makeClient({
          type: 'user',
          role: {
            id: 'role-id',
            meta: { final_permissions: recordRestricted },
          },
        }).client,
        ['source'],
        [MODEL],
      ),
    );

    const uploadRestricted = broadPermissions(['source']);
    (
      uploadRestricted.positive_upload_permissions[0] as Record<string, unknown>
    ).localization_scope = ['en'];
    const uploadError = await expectUnproven(
      assertUnrestrictedReadAccess(
        makeClient({
          type: 'user',
          role: {
            id: 'role-id',
            meta: { final_permissions: uploadRestricted },
          },
        }).client,
        ['source'],
        [MODEL],
      ),
    );

    expect(uploadError.message).to.contain('unrestricted upload reads');
  });

  it('proves schema-edit access for temporary validator relaxation', async () => {
    await assertCanEditSchema(makeClient({ type: 'account' }).client);
    await assertCanEditSchema(
      makeClient({ type: 'access_token', hardcoded_type: 'admin' }).client,
    );

    const granted = broadPermissions(['destination']);
    granted.can_edit_schema = true;
    await assertCanEditSchema(
      makeClient({
        type: 'user',
        role: { id: 'role-id', meta: { final_permissions: granted } },
      }).client,
    );

    const denied = broadPermissions(['destination']);
    try {
      await assertCanEditSchema(
        makeClient({
          type: 'access_token',
          role: { id: 'role-id', meta: { final_permissions: denied } },
        }).client,
      );
    } catch (error) {
      expect(error).to.be.instanceOf(ContentDiffError);
      expect((error as ContentDiffError).code).to.equal(
        'UNPROVEN_SCHEMA_EDIT_ACCESS',
      );
      return;
    }

    throw new Error('Expected schema-edit proof to fail closed');
  });
});

function broadPermissions(environmentIds: string[]) {
  return {
    can_edit_schema: false,
    can_manage_upload_collections: true,
    positive_item_type_permissions: environmentIds.map((environment) => ({
      action: 'all',
      environment,
      item_type: null,
      workflow: null,
      on_creator: 'anyone',
    })),
    negative_item_type_permissions: [] as Array<Record<string, unknown>>,
    positive_upload_permissions: environmentIds.map((environment) => ({
      action: 'all',
      environment,
      upload_collection: null as string | null,
      on_creator: 'anyone',
    })),
    negative_upload_permissions: [] as Array<Record<string, unknown>>,
  };
}

function makeClient(actor: unknown, role?: unknown) {
  const roleRequests: string[] = [];
  const client = {
    users: {
      findMe: async () => actor,
    },
    roles: {
      find: async (roleId: string) => {
        roleRequests.push(roleId);
        return role;
      },
    },
  } as unknown as TestClient;

  return { client, roleRequests };
}

async function expectUnproven(
  promise: Promise<void>,
): Promise<ContentDiffError> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(ContentDiffError);
    expect((error as ContentDiffError).code).to.equal('UNPROVEN_FULL_ACCESS');
    return error as ContentDiffError;
  }

  throw new Error('Expected unrestricted-read proof to fail');
}
