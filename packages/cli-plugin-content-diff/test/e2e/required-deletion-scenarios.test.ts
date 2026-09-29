import { expect } from 'chai';
import {
  buildRequiredDeletionApiKeys,
  buildRequiredDeletionStructuredTextValidators,
  requiredDeletionPreserveScenario,
  requiredDeletionRelaxationScenario,
} from './required-deletion-scenarios';

describe('required deletion SCC real-CMA scenario contract', () => {
  it('uses isolated, live-valid model API keys', () => {
    const keys = buildRequiredDeletionApiKeys('test-run');
    expect(keys.model).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(keys.block).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(keys.leafBlock).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(keys.model).to.have.length.at.most(30);
    expect(keys.block).to.have.length.at.most(30);
    expect(keys.leafBlock).to.have.length.at.most(30);
  });

  it('always names a real allowed block model in Structured Text validators', () => {
    expect(
      buildRequiredDeletionStructuredTextValidators('node-model', [
        'allowed-leaf-block',
      ]),
    ).to.deep.equal({
      structured_text_links: {
        item_types: ['node-model'],
        on_publish_with_unpublished_references_strategy: 'fail',
        on_reference_unpublish_strategy: 'delete_references',
        on_reference_delete_strategy: 'delete_references',
      },
      structured_text_blocks: { item_types: ['allowed-leaf-block'] },
      structured_text_inline_blocks: { item_types: ['allowed-leaf-block'] },
    });
  });

  it('keeps default and opt-in deletion behavior as separate lanes', () => {
    expect(requiredDeletionPreserveScenario.contentDiffArgs).to.deep.equal([
      '--include-deletions',
    ]);
    expect(requiredDeletionRelaxationScenario.contentDiffArgs).to.deep.equal([
      '--include-deletions',
      '--migrate-invalid-content',
    ]);
  });
});
