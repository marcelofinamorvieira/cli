import assert from 'node:assert/strict';
import { selectivePublicationModelApiKey } from './selective-publication-scenario';

describe('selective publication real-CMA fixture contract', () => {
  it('uses a deterministic valid model API key', () => {
    const first = selectivePublicationModelApiKey('very-long-run-id-123');
    const second = selectivePublicationModelApiKey('very-long-run-id-123');
    assert.equal(first, second);
    assert.match(first, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    assert.ok(first.length <= 30);
  });
});
