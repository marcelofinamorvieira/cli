import assert from 'node:assert/strict';
import {
  NO_DRAFT_SINGLETON_FIELD_API_KEYS,
  noDraftSingletonApiKeys,
} from './no-draft-singleton-scenario';

// Mirrors Field::INVALID_API_KEYS in the API. Keeping the full set here makes
// fixture schema changes fail offline before the real-CMA setup reaches a 422.
const CURRENT_API_RESERVED_FIELD_API_KEYS = new Set([
  'position',
  'is_valid',
  'id',
  'type',
  'updated_at',
  'attributes',
  'fields',
  'item_type',
  'is_singleton',
  'seo_meta_tags',
  'parent_id',
  'parent',
  'children',
  'status',
  'created_at',
  'meta',
  'eq',
  'neq',
  'all_in',
  'any_in',
  'creator',
  'exists',
  'is_current_version_valid',
  'is_published_version_valid',
  'item_type_id',
  'item_id',
]);

describe('no-draft singleton real-CMA fixture contract', () => {
  it('uses deterministic valid model API keys for long run IDs', () => {
    const first = noDraftSingletonApiKeys('long-run-id-with-punctuation-123');
    const second = noDraftSingletonApiKeys('long-run-id-with-punctuation-123');
    assert.deepEqual(first, second);
    assert.notEqual(first.parent, first.singleton);
    for (const apiKey of Object.values(first)) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30);
    }
  });

  it('keeps every fixture field API key outside the current API reserved set', () => {
    assert.equal(
      CURRENT_API_RESERVED_FIELD_API_KEYS.has('parent'),
      true,
      'the original failing key must remain covered by this regression',
    );
    assert.equal(NO_DRAFT_SINGLETON_FIELD_API_KEYS.dependency, 'dependency');
    for (const apiKey of Object.values(NO_DRAFT_SINGLETON_FIELD_API_KEYS)) {
      assert.equal(
        CURRENT_API_RESERVED_FIELD_API_KEYS.has(apiKey),
        false,
        `fixture field API key ${apiKey} is reserved by the API`,
      );
    }
  });
});
