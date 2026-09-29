import assert from 'node:assert/strict';
import {
  buildNormalizedEmptyShellReferenceDast,
  buildRecursiveBlockFieldDefinitions,
  buildRecursiveModelApiKeys,
  buildRequiredStructuredTextValidators,
  compareDatoIds,
  waitForRecordValidityStateFromPort,
} from './recursive-content-scenarios';

describe('recursive real-CMA fixture names', () => {
  it('builds deterministic, unique model API keys accepted by the live API', () => {
    const first = buildRecursiveModelApiKeys(
      'mep8yy15-123456-an-intentionally-long-regression-run-id',
    );
    const second = buildRecursiveModelApiKeys(
      'mep8yy15-123456-an-intentionally-long-regression-run-id',
    );

    assert.deepEqual(first, second);
    assert.equal(new Set(Object.values(first)).size, 3);
    for (const apiKey of Object.values(first)) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30, apiKey);
    }
  });

  it('declares every modular-block field as nonlocalized', () => {
    const definitions = buildRecursiveBlockFieldDefinitions({
      nodeModelId: 'node-model',
      containerBlockModelId: 'container-block',
      leafBlockModelId: 'leaf-block',
    });

    assert.equal(definitions.length, 9);
    for (const { definition } of definitions) {
      assert.equal(definition.localized, false, definition.api_key);
    }
  });

  it('uses the real Structured Text required and length validators without legacy size', () => {
    assert.deepEqual(
      buildRequiredStructuredTextValidators({
        blockModelIds: ['block-a', 'block-b'],
        linkModelId: 'node-model',
      }),
      {
        structured_text_blocks: { item_types: ['block-a', 'block-b'] },
        structured_text_inline_blocks: {
          item_types: ['block-a', 'block-b'],
        },
        structured_text_links: {
          item_types: ['node-model'],
          on_publish_with_unpublished_references_strategy: 'fail',
          on_reference_unpublish_strategy: 'delete_references',
          on_reference_delete_strategy: 'delete_references',
        },
        required: {},
        length: { min: 1 },
      },
    );
  });

  it('uses a reference-only paragraph that becomes canonically empty when stripped', () => {
    assert.deepEqual(buildNormalizedEmptyShellReferenceDast('peer-id'), {
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'inlineItem', item: 'peer-id' }],
          },
        ],
      },
    });
  });

  it('uses no field API key reserved by the current CMA', () => {
    // Mirrors api/app/models/field.rb::INVALID_API_KEYS so fixture failures are
    // caught offline before a disposable environment is created.
    const reserved = new Set([
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
    const blockDefinitions = buildRecursiveBlockFieldDefinitions({
      nodeModelId: 'node-model',
      containerBlockModelId: 'container-block',
      leafBlockModelId: 'leaf-block',
    });
    const fixtureApiKeys = [
      'title',
      'required_peer',
      'localized_peer',
      'localized_peers',
      'modules',
      'hero',
      'body',
      'safe_body',
      ...blockDefinitions.map(({ definition }) => definition.api_key),
    ];

    assert.equal(fixtureApiKeys.includes('children'), false);
    for (const apiKey of fixtureApiKeys) {
      assert.equal(reserved.has(apiKey), false, apiKey);
    }
  });

  it('uses code-unit ordering for expected and captured Dato IDs', () => {
    assert.deepEqual(
      ['a123456789012345678901', 'Z123456789012345678901'].sort(compareDatoIds),
      ['Z123456789012345678901', 'a123456789012345678901'],
    );
  });

  it('waits through stale valid flags until asynchronous revalidation marks the reference-only records invalid', async () => {
    const states = [
      { current: true, published: true },
      { current: false, published: false },
    ];
    let reads = 0;
    let sleeps = 0;

    await waitForRecordValidityStateFromPort(
      async () => {
        const state = states[Math.min(reads, states.length - 1)];
        reads += 1;
        return [
          {
            meta: {
              is_current_version_valid: state.current,
              is_published_version_valid: state.published,
            },
          },
        ];
      },
      { current: false, published: false },
      {
        attempts: 2,
        label: 'reference-only records',
        sleep: async () => {
          sleeps += 1;
        },
      },
    );

    assert.equal(reads, 2);
    assert.equal(sleeps, 1);
  });

  it('fails closed when asynchronous validity never reaches the expected state', async () => {
    await assert.rejects(
      waitForRecordValidityStateFromPort(
        async () => [
          {
            meta: {
              is_current_version_valid: true,
              is_published_version_valid: true,
            },
          },
        ],
        { current: false, published: false },
        { attempts: 1, label: 'reference-only records' },
      ),
      /reference-only records did not reach validity.*"current":false.*last observed.*"current":true/,
    );
  });
});
