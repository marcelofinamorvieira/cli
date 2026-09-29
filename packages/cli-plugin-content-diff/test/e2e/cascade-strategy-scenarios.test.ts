import assert from 'node:assert/strict';
import {
  CASCADE_REFERENCE_STRATEGIES,
  EXTERNAL_UNPUBLISH_REFERRER_FAILURE_PATTERN,
  cascadeStrategyApiKey,
  externalFailUnpublishBoundaryScenario,
  managedCascadeStrategiesScenario,
} from './cascade-strategy-scenarios';

describe('cascade-strategy real-CMA fixture contract', () => {
  it('declares every remote strategy key explicitly for each independent lane', () => {
    assert.deepEqual(CASCADE_REFERENCE_STRATEGIES, {
      publishReferences: {
        on_publish_with_unpublished_references_strategy: 'publish_references',
        on_reference_unpublish_strategy: 'fail',
        on_reference_delete_strategy: 'fail',
      },
      unpublish: {
        on_publish_with_unpublished_references_strategy: 'fail',
        on_reference_unpublish_strategy: 'unpublish',
        on_reference_delete_strategy: 'fail',
      },
      deleteReferences: {
        on_publish_with_unpublished_references_strategy: 'fail',
        on_reference_unpublish_strategy: 'fail',
        on_reference_delete_strategy: 'delete_references',
      },
      fail: {
        on_publish_with_unpublished_references_strategy: 'fail',
        on_reference_unpublish_strategy: 'fail',
        on_reference_delete_strategy: 'fail',
      },
    });
  });

  it('uses deterministic, distinct API-safe keys for all models', () => {
    const keys = (['managed', 'target', 'referrer'] as const).map((lane) =>
      cascadeStrategyApiKey(lane, 'mepgph3k-012abc'),
    );
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) {
      assert.match(key, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(key.length <= 30);
    }
    assert.equal(cascadeStrategyApiKey('managed', 'mepgph3k-012abc'), keys[0]);
  });

  it('keeps destructive success and fail-boundary rejection explicit', () => {
    assert.deepEqual(managedCascadeStrategiesScenario.contentDiffArgs, [
      '--include-deletions',
    ]);
    assert.equal(
      managedCascadeStrategiesScenario.verifyGeneratedPlan instanceof Function,
      true,
    );
    assert.equal(
      managedCascadeStrategiesScenario.verify instanceof Function,
      true,
    );
    assert.equal(
      externalFailUnpublishBoundaryScenario.expectedGenerationFailure
        ?.messagePattern,
      EXTERNAL_UNPUBLISH_REFERRER_FAILURE_PATTERN,
    );
    assert.equal(externalFailUnpublishBoundaryScenario.verify, undefined);
  });

  it('requires the precise external unpublish refusal', () => {
    assert.equal(
      EXTERNAL_UNPUBLISH_REFERRER_FAILURE_PATTERN.test(
        'Record target cannot be unpublished safely because published referrer referrer is outside the selected reconciliation order or retains the reference.',
      ),
      true,
    );
    assert.equal(
      EXTERNAL_UNPUBLISH_REFERRER_FAILURE_PATTERN.test(
        'Record target cannot be unpublished safely',
      ),
      false,
    );
  });
});
