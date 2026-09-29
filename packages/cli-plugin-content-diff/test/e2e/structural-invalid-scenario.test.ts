import assert from 'node:assert/strict';
import {
  buildStructuralInvalidApiKeys,
  buildStructuralInvalidValidators,
} from './structural-invalid-scenario';

describe('structural-invalid real-CMA fixture contract', () => {
  it('builds deterministic API-safe model keys', () => {
    const runId = 'structural-invalid-contract';
    const first = buildStructuralInvalidApiKeys(runId);
    const second = buildStructuralInvalidApiKeys(runId);

    assert.deepEqual(first, second);
    assert.equal(new Set(Object.values(first)).size, 5);
    for (const apiKey of Object.values(first)) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30);
    }
  });

  it('keeps retired block models outside every structural validator', () => {
    const validators = buildStructuralInvalidValidators({
      ownerModelId: 'owner',
      allowedContainerModelId: 'allowed-container',
      allowedLeafModelId: 'allowed-leaf',
    });

    assert.deepEqual(validators, {
      body: {
        structured_text_blocks: { item_types: ['allowed-container'] },
        structured_text_inline_blocks: { item_types: ['allowed-container'] },
        structured_text_links: { item_types: ['owner'] },
      },
      child: {
        single_block_blocks: { item_types: ['allowed-leaf'] },
      },
      related: { item_item_type: { item_types: ['owner'] } },
    });
  });
});
