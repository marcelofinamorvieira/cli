import { expect } from 'chai';
import { updateRole } from '../../../src/utils/environments-diff/resources/update-roles';

describe('schema role diff', () => {
  it('ignores permissions scoped to each environment content-diff model', () => {
    const role = {
      id: 'editor-role',
      attributes: {
        name: 'Editor',
        positive_item_type_permissions: [
          {
            action: 'read',
            environment: 'source',
            item_type: 'source-content-diff-model',
          },
          {
            action: 'read',
            environment: 'destination',
            item_type: 'destination-content-diff-model',
          },
        ],
        negative_item_type_permissions: [],
        positive_upload_permissions: [],
        negative_upload_permissions: [],
      },
    };

    expect(
      updateRole(role as never, 'source', 'destination', {
        newInternalItemTypeIds: ['source-content-diff-model'],
        oldInternalItemTypeIds: ['destination-content-diff-model'],
      }),
    ).to.deep.equal([]);
  });
});
