import assert from 'node:assert/strict';
import { SAFELY_RELAXABLE_VALIDATOR_KEYS } from '../../src/content-diff/plan';
import {
  buildInvalidContentModelApiKeys,
  buildNestedBlockInvalidLabels,
  buildRelaxableValidatorContracts,
} from './invalid-content-scenarios';

describe('invalid-content real-CMA fixture contract', () => {
  it('builds deterministic live-compatible model API keys', () => {
    const runId = 'very-long-run-id-that-must-not-leak-into-model-api-keys';
    const first = buildInvalidContentModelApiKeys(runId);
    const second = buildInvalidContentModelApiKeys(runId);

    assert.deepEqual(first, second);
    assert.equal(new Set(Object.values(first)).size, 5);
    for (const apiKey of Object.values(first)) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30, apiKey);
    }
  });

  it('removes only diagnosed allowlisted validators and retains passing validators', () => {
    const allowlisted = new Set<string>(SAFELY_RELAXABLE_VALIDATOR_KEYS);
    const contracts = buildRelaxableValidatorContracts();

    assert.deepEqual(contracts.title.relaxed, {});
    assert.deepEqual(contracts.score.relaxed, { required: {} });
    assert.deepEqual(contracts.code.relaxed, { required: {} });
    assert.deepEqual(contracts.blockLabel.relaxed, {});

    for (const contract of Object.values(contracts)) {
      for (const validatorKey of contract.removed) {
        assert.equal(
          allowlisted.has(validatorKey),
          true,
          `${validatorKey} must stay in the product relaxation allowlist`,
        );
        assert.ok(validatorKey in contract.original);
        assert.equal(validatorKey in contract.relaxed, false);
      }
      for (const [validatorKey, value] of Object.entries(contract.relaxed)) {
        assert.deepEqual(contract.original[validatorKey], value);
      }
    }
  });

  it('covers required, length, enum, number range, and uniqueness failures', () => {
    const removed = new Set(
      Object.values(buildRelaxableValidatorContracts()).flatMap(
        ({ removed: keys }) => keys,
      ),
    );

    assert.deepEqual([...removed].sort(), [
      'enum',
      'length',
      'number_range',
      'required',
      'unique',
    ]);
    assert.equal(removed.has('rich_text_blocks'), false);
    assert.equal(removed.has('item_item_type'), false);
    assert.equal(removed.has('structured_text_blocks'), false);
  });

  it('uses separate nested-block values for blank and enum diagnostics without needing an update', () => {
    const labels = buildNestedBlockInvalidLabels();
    const contract = buildRelaxableValidatorContracts().blockLabel;
    const allowedValues = contract.original.enum.values;
    const minimumLength = contract.original.length.min;

    assert.ok(Array.isArray(allowedValues));
    assert.ok(typeof minimumLength === 'number');

    assert.equal(labels.en.trim(), '');
    assert.ok(labels.en.length < minimumLength);

    assert.notEqual(labels.it.trim(), '');
    assert.ok(labels.it.length >= minimumLength);
    assert.equal(allowedValues.includes(labels.it), false);

    assert.deepEqual(contract.removed, ['enum', 'length', 'required']);
  });
});
