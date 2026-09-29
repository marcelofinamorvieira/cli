import { expect } from 'chai';
import {
  buildOptionalDeletionApiKey,
  buildOptionalDeletionValidators,
  optionalDeletionValidationScenario,
} from './optional-deletion-validation-scenario';

describe('strict optional deletion SCC real-CMA scenario contract', () => {
  it('uses a deterministic live-valid model API key', () => {
    const apiKey = buildOptionalDeletionApiKey('test-run');
    expect(apiKey).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(apiKey).to.have.length.at.most(30);
    expect(buildOptionalDeletionApiKey('test-run')).to.equal(apiKey);
    expect(buildOptionalDeletionApiKey('another-run')).not.to.equal(apiKey);
  });

  it('constructs a valid even-cardinality field whose unlink is invalid', () => {
    expect(buildOptionalDeletionValidators('node-model')).to.deep.equal({
      items_item_type: {
        item_types: ['node-model'],
        on_publish_with_unpublished_references_strategy: 'fail',
        on_reference_unpublish_strategy: 'fail',
        on_reference_delete_strategy: 'fail',
      },
      size: { min: 0, multiple_of: 2 },
    });
  });

  it('requires both destructive reconciliation and invalid-content opt-in', () => {
    expect(optionalDeletionValidationScenario.contentDiffArgs).to.deep.equal([
      '--include-deletions',
      '--migrate-invalid-content',
    ]);
  });
});
