import assert from 'node:assert/strict';
import {
  SELECTIVE_SCHEDULE_BASELINE_TITLE,
  SELECTIVE_SCHEDULE_INVALID_TITLE,
  SELECTIVE_SCHEDULE_MODEL_CAPABILITIES,
  SELECTIVE_SCHEDULE_SCOPES,
  SELECTIVE_SCHEDULE_VALIDATORS,
  assertSelectiveSchedulePlan,
  selectiveScheduleModelApiKey,
  selectiveScheduleValidityScenario,
} from './selective-schedule-validity-scenario';

describe('selective schedule validity real-CMA scenario contract', () => {
  it('uses a deterministic API-safe key and owns replay and regeneration verification', () => {
    const runId = 'very-long-selective-schedule-validity-run-id';
    const apiKey = selectiveScheduleModelApiKey(runId);
    assert.equal(apiKey, selectiveScheduleModelApiKey(runId));
    assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    assert.ok(apiKey.length <= 30);
    assert.equal(
      typeof selectiveScheduleValidityScenario.verifyGeneratedPlan,
      'function',
    );
    assert.equal(typeof selectiveScheduleValidityScenario.verify, 'function');
    assert.deepEqual(SELECTIVE_SCHEDULE_VALIDATORS, {
      title: { required: {} },
      body: { required: {} },
    });
    assert.notDeepEqual(
      SELECTIVE_SCHEDULE_INVALID_TITLE,
      SELECTIVE_SCHEDULE_BASELINE_TITLE,
    );
    assert.equal(SELECTIVE_SCHEDULE_INVALID_TITLE.it, '');
    assert.ok(SELECTIVE_SCHEDULE_INVALID_TITLE.en.length > 0);
  });

  it('declares a constructible first-publication selective scope', () => {
    assert.deepEqual(SELECTIVE_SCHEDULE_MODEL_CAPABILITIES, {
      all_locales_required: false,
      draft_mode_active: true,
      draft_saving_active: true,
    });
    assert.deepEqual(SELECTIVE_SCHEDULE_SCOPES, {
      en: {
        content_in_locales: ['en'],
        non_localized_content: true,
      },
      it: {
        content_in_locales: ['it'],
        non_localized_content: true,
      },
    });
  });

  it('requires one migrated en schedule and one exact it-scope preservation', () => {
    const plan = validPlan();
    assert.doesNotThrow(() =>
      assertSelectiveSchedulePlan(plan, {
        modelId: 'model-id',
        enScheduleRecordId: 'en-record',
        itScheduleRecordId: 'it-record',
      }),
    );

    const unsafeEn = structuredClone(plan);
    unsafeEn.records = [];
    assert.throws(
      () =>
        assertSelectiveSchedulePlan(unsafeEn, {
          modelId: 'model-id',
          enScheduleRecordId: 'en-record',
          itScheduleRecordId: 'it-record',
        }),
      /Expected values to be strictly equal/,
    );

    const migratedIt = structuredClone(plan);
    migratedIt.invalidContent.migratedRecordIds.push('it-record');
    assert.throws(
      () =>
        assertSelectiveSchedulePlan(migratedIt, {
          modelId: 'model-id',
          enScheduleRecordId: 'en-record',
          itScheduleRecordId: 'it-record',
        }),
      /Expected values to be strictly deep-equal/,
    );

    const relaxed = structuredClone(plan);
    relaxed.invalidContent.validatorRelaxations.push({ fieldId: 'title' });
    assert.throws(
      () =>
        assertSelectiveSchedulePlan(relaxed, {
          modelId: 'model-id',
          enScheduleRecordId: 'en-record',
          itScheduleRecordId: 'it-record',
        }),
      /Expected values to be strictly deep-equal/,
    );
  });
});

function validPlan() {
  return {
    records: [
      {
        id: 'en-record',
        action: 'update',
        changes: {
          current: true,
          published: false,
          topology: false,
          lifecycle: false,
          stage: false,
          schedules: true,
        },
      },
    ],
    invalidContent: {
      detectedRecordIds: ['en-record', 'it-record'],
      migratedRecordIds: ['en-record'],
      validatorRelaxations: [] as unknown[],
      skippedRecords: [
        {
          id: 'it-record',
          itemTypeId: 'model-id',
          disposition: 'preserve_target',
          reasons: [{ code: 'UNSAFE_SCHEDULED_PUBLICATION' }],
        },
      ],
      schemaStates: {
        originalDigest: 'schema-digest',
        fullyRelaxedDigest: 'schema-digest',
      },
    },
    requiredPermissions: {
      manageSchedules: true,
      editSchema: false,
    },
  };
}
