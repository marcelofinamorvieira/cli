import { expect } from 'chai';
import {
  buildOptionalCreateApiKey,
  buildOptionalCreateValidators,
  optionalCreateValidationScenario,
} from './optional-create-validation-scenario';

describe('strict optional create SCC real-CMA scenario contract', () => {
  it('uses a deterministic live-valid model API key', () => {
    const apiKey = buildOptionalCreateApiKey('test-run');
    expect(apiKey).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(apiKey).to.have.length.at.most(30);
    expect(buildOptionalCreateApiKey('test-run')).to.equal(apiKey);
    expect(buildOptionalCreateApiKey('another-run')).not.to.equal(apiKey);
  });

  it('constructs an even-cardinality final field with odd create prefixes', () => {
    expect(buildOptionalCreateValidators('node-model')).to.deep.equal({
      items_item_type: {
        item_types: ['node-model'],
        on_publish_with_unpublished_references_strategy: 'fail',
        on_reference_unpublish_strategy: 'fail',
        on_reference_delete_strategy: 'fail',
      },
      size: { min: 0, multiple_of: 2 },
    });
  });

  it('requires invalid-content opt-in but no destructive flag', () => {
    expect(optionalCreateValidationScenario.contentDiffArgs).to.deep.equal([
      '--migrate-invalid-content',
    ]);
  });
});
