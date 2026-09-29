import assert from 'node:assert/strict';
import {
  MIXED_VALIDITY_VALIDATORS,
  mixedValidityModelApiKey,
} from './mixed-validity-scenario';

describe('mixed-validity real-CMA fixture contract', () => {
  it('uses one exact enum contract and a deterministic valid model API key', () => {
    assert.deepEqual(MIXED_VALIDITY_VALIDATORS, {
      enum: { values: ['current valid', 'published valid'] },
    });
    const first = mixedValidityModelApiKey('very-long-run-id-123');
    const second = mixedValidityModelApiKey('very-long-run-id-123');
    assert.equal(first, second);
    assert.match(first, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    assert.ok(first.length <= 30);
  });
});
