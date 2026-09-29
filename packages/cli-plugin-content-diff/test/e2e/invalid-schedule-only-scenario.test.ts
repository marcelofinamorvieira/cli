import assert from 'node:assert/strict';
import {
  INVALID_SCHEDULE_CHANGED_TITLE,
  INVALID_SCHEDULE_INITIAL_TITLE,
  assertInvalidScheduleOnlyManifest,
  assertUnchangedScheduleInvalidCurrentWriteState,
  buildInvalidScheduleOnlyModelApiKey,
  invalidScheduleOnlyScenario,
  invalidUnchangedScheduleCurrentWriteScenario,
} from './invalid-schedule-only-scenario';

const MODEL_ID = 'schedule-model';
const RECORD_ID = 'schedule-record';

describe('invalid schedule-only real-CMA scenario contract', () => {
  it('uses a deterministic API-safe model key and explicit invalid-content opt-in', () => {
    const runId = 'very-long-invalid-schedule-only-run-id';
    const apiKey = buildInvalidScheduleOnlyModelApiKey(runId);

    assert.equal(apiKey, buildInvalidScheduleOnlyModelApiKey(runId));
    assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    assert.ok(apiKey.length <= 30);
    assert.deepEqual(invalidScheduleOnlyScenario.contentDiffArgs, [
      '--migrate-invalid-content',
    ]);
    assert.equal(
      typeof invalidScheduleOnlyScenario.verifyGeneratedPlan,
      'function',
    );
    assert.equal(typeof invalidScheduleOnlyScenario.verify, 'function');
  });

  it('requires an exact partial schedule skip with no operations or relaxation', () => {
    const manifest = validManifest();
    assert.doesNotThrow(() =>
      assertInvalidScheduleOnlyManifest(manifest, {
        modelId: MODEL_ID,
        recordId: RECORD_ID,
      }),
    );

    const withRelaxation = structuredClone(manifest);
    withRelaxation.invalidContent.validatorRelaxations = [
      { fieldId: 'title-field' },
    ];
    assert.throws(
      () =>
        assertInvalidScheduleOnlyManifest(withRelaxation, {
          modelId: MODEL_ID,
          recordId: RECORD_ID,
        }),
      /Expected values to be strictly deep-equal/,
    );

    const withScheduleMutation = structuredClone(manifest);
    withScheduleMutation.records = [{ id: RECORD_ID, action: 'update' }];
    assert.throws(
      () =>
        assertInvalidScheduleOnlyManifest(withScheduleMutation, {
          modelId: MODEL_ID,
          recordId: RECORD_ID,
        }),
      /Expected values to be strictly deep-equal/,
    );

    const wrongReason = structuredClone(manifest);
    wrongReason.invalidContent.skippedRecords[0].reasons[0].code =
      'INVALID_CURRENT';
    assert.throws(
      () =>
        assertInvalidScheduleOnlyManifest(wrongReason, {
          modelId: MODEL_ID,
          recordId: RECORD_ID,
        }),
      /Expected values to be strictly deep-equal/,
    );
  });

  it('requires a changed invalid current value with an exactly unchanged future schedule', () => {
    assert.deepEqual(
      invalidUnchangedScheduleCurrentWriteScenario.contentDiffArgs,
      ['--migrate-invalid-content'],
    );
    assert.equal(
      typeof invalidUnchangedScheduleCurrentWriteScenario.verifyGeneratedPlan,
      'function',
    );
    assert.equal(
      typeof invalidUnchangedScheduleCurrentWriteScenario.verify,
      'function',
    );

    const destination = {
      record: {
        id: RECORD_ID,
        itemTypeId: MODEL_ID,
        title: INVALID_SCHEDULE_INITIAL_TITLE,
        currentValid: false,
        publishedValid: null,
      },
      publication: {
        at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        contentInLocales: ['it'],
        nonLocalizedContent: true,
      },
    };
    const source = {
      ...structuredClone(destination),
      record: {
        ...destination.record,
        title: INVALID_SCHEDULE_CHANGED_TITLE,
      },
    };

    assert.doesNotThrow(() =>
      assertUnchangedScheduleInvalidCurrentWriteState(source, destination),
    );

    const scheduleDrift = structuredClone(source);
    scheduleDrift.publication.contentInLocales = ['en'];
    assert.throws(
      () =>
        assertUnchangedScheduleInvalidCurrentWriteState(
          scheduleDrift,
          destination,
        ),
      /source and destination publication schedules must be identical/,
    );

    const unchangedCurrent = {
      ...structuredClone(source),
      record: {
        ...source.record,
        title: INVALID_SCHEDULE_INITIAL_TITLE,
      },
    };
    assert.throws(
      () =>
        assertUnchangedScheduleInvalidCurrentWriteState(
          unchangedCurrent,
          destination,
        ),
      /source current must differ from destination only by the changed invalid value/,
    );
  });
});

function validManifest() {
  return {
    records: [] as unknown[],
    uploads: [] as unknown[],
    uploadCollections: [] as unknown[],
    invalidContent: {
      migrateInvalidContent: true,
      schemaStates: {
        originalDigest: 'schema-digest',
        fullyRelaxedDigest: 'schema-digest',
      },
      detectedRecordIds: [RECORD_ID],
      migratedRecordIds: [],
      propagatedSkipCount: 0,
      validatorRelaxations: [] as unknown[],
      skippedRecords: [
        {
          id: RECORD_ID,
          itemTypeId: MODEL_ID,
          disposition: 'preserve_target',
          sourceHash: 'source-schedule-hash',
          expectedTargetHash: 'target-schedule-hash',
          sourceValidity: { current: false, published: null },
          targetValidity: { current: false, published: null },
          sourceNestedBlockIds: [],
          preservedExternalBlockIds: [],
          targetNestedBlockIds: [],
          reasons: [
            {
              code: 'UNSAFE_SCHEDULED_PUBLICATION',
              slice: 'schedule',
              message: `Record ${RECORD_ID} has an invalid desired current version whose future publication scope cannot be proven valid under the restored validators.`,
              dependencyChain: [RECORD_ID],
            },
          ],
        },
      ],
    },
    options: { migrateInvalidContent: true },
    requiredPermissions: {
      itemTypes: [{ id: MODEL_ID, actions: ['read'] }],
      manageSchedules: false,
      editSchema: false,
    },
    summary: {
      records: { create: 0, update: 0, delete: 0 },
      invalidContent: {
        status: 'partial',
        detectedRecords: 1,
        migratedRecords: 0,
        skippedRecords: 1,
        propagatedSkipCount: 0,
        validatorRelaxations: 0,
        relaxedFieldCount: 0,
        relaxedValidatorCount: 0,
        requiresTemporaryValidatorRelaxation: false,
      },
    },
    warnings: [
      {
        code: 'INVALID_CONTENT_SKIPPED',
        message: `Record ${RECORD_ID} was skipped as a whole (UNSAFE_SCHEDULED_PUBLICATION).`,
        entityIds: [RECORD_ID],
      },
    ],
  };
}
