import assert from 'node:assert/strict';
import {
  HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT,
  PROVEN_FEATURES,
  assertHistoricalNullDefaultSuppressionPlan,
  historicalNullDefaultApiKey,
  historicalNullDefaultScenario,
} from './historical-null-default-scenario';

describe('historical-null default real-CMA fixture contract', () => {
  it('uses a deterministic valid model API key', () => {
    const first = historicalNullDefaultApiKey('long-run-id-123');
    const second = historicalNullDefaultApiKey('long-run-id-123');
    assert.equal(first, second);
    assert.match(first, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    assert.ok(first.length <= 30);
  });

  it('uses float fields because CMA preserves float null instead of normalizing it', () => {
    assert.deepEqual(HISTORICAL_NULL_DEFAULT_FIELD_CONTRACT, {
      fieldType: 'float',
      plainDefault: 125.5,
      localizedDefault: { en: 250.25, it: 375.75 },
    });
    assert.deepEqual(historicalNullDefaultScenario.contentDiffArgs, [
      '--migrate-invalid-content',
    ]);
    assert.equal(
      typeof historicalNullDefaultScenario.verifyGeneratedPlan,
      'function',
    );
    assert.deepEqual(PROVEN_FEATURES, [
      'source-only record creation with a historical null under a later non-localized float default',
      'localized en and it historical nulls under distinct later float defaults',
      'explicit migrate-invalid-content authorization for temporary schema mutation',
      'exact default-suppression warning field IDs and schema-edit permission',
      'exact restoration of non-localized and localized field defaults',
      'exact raw current and published source-to-applied state',
      'mutation-free migration replay and empty regeneration via the real-CMA harness',
    ]);
  });

  it('requires exact default-suppression authorization for both float fields', () => {
    const fieldIds = {
      plainFieldId: 'plain-field',
      localizedFieldId: 'localized-field',
    };
    const plan = {
      options: { migrateInvalidContent: true },
      requiredPermissions: { editSchema: true },
      warnings: [
        {
          code: 'DEFAULT_VALUE_SUPPRESSION',
          message: 'exact temporary suppression and restoration',
          entityIds: ['localized-field', 'plain-field'],
        },
      ],
    };

    assert.doesNotThrow(() =>
      assertHistoricalNullDefaultSuppressionPlan(plan, fieldIds),
    );

    const incompleteWarning = structuredClone(plan);
    incompleteWarning.warnings[0].entityIds = ['plain-field'];
    assert.throws(
      () =>
        assertHistoricalNullDefaultSuppressionPlan(incompleteWarning, fieldIds),
      /default suppression must target exactly the plain and localized float fields/,
    );

    const noSchemaPermission = structuredClone(plan);
    noSchemaPermission.requiredPermissions.editSchema = false;
    assert.throws(
      () =>
        assertHistoricalNullDefaultSuppressionPlan(
          noSchemaPermission,
          fieldIds,
        ),
      /historical-null creation must require schema-edit permission/,
    );
  });
});
