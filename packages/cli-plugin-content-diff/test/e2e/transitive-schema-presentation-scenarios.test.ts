import assert from 'node:assert/strict';
import { transitiveSchemaApiKeys } from './transitive-schema-presentation-scenarios';

describe('transitive schema and presentation real-CMA fixture contracts', () => {
  it('uses deterministic distinct API-safe keys for every schema node', () => {
    const first = transitiveSchemaApiKeys('very-long-run-id-123');
    const second = transitiveSchemaApiKeys('very-long-run-id-123');
    assert.deepEqual(first, second);
    assert.equal(
      new Set(Object.values(first)).size,
      Object.values(first).length,
    );
    for (const key of Object.values(first)) {
      assert.match(key, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(key.length <= 30);
    }
  });
});
