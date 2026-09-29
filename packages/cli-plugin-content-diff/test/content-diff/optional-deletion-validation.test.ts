import { expect } from 'chai';
import {
  canonicalizeRecord,
  semanticHash,
} from '../../src/content-diff/canonicalize';
import {
  buildBlockOwnershipIndex,
  collectOptionalDeletionCycleReleaseCandidates,
} from '../../src/content-diff/dependencies';
import {
  assertPublishedDeleteReleasesValid,
  diagnoseDeletionCycleReleasesAgainstDestination,
} from '../../src/content-diff/index';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import type {
  ContentSnapshot,
  InvalidContentDiagnostic,
  RecordSnapshot,
  SchemaSnapshot,
} from '../../src/content-diff/types';
import { CONTENT_SNAPSHOT_FORMAT_VERSION } from '../../src/content-diff/types';

const MODEL_ID = 'A2vQnY8xR6KpL3mT5sW7Zg';
const FIELD_ID = 'B3wRnZ9yS7LqM4nU6tX8Ah';
const RECORD_A = 'C4xSoA0zT8MrN5oV7uY9Bi';
const RECORD_B = 'D5yTpB1aU9NsO6pW8vZ0Cj';
const RETAINED_PEER = 'E6zUqC2bV0OtP7qX9wA1Dk';

describe('strict optional deletion-cycle validation', () => {
  it('projects the exact retained-peer payload for an optional links SCC', () => {
    const target = fixture().target;
    const candidates = collectOptionalDeletionCycleReleaseCandidates(
      {
        [RECORD_A]: target.records[RECORD_A],
        [RECORD_B]: target.records[RECORD_B],
      },
      target.schema,
    );

    expect(candidates).to.have.length(1);
    expect(candidates[0].componentRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(candidates[0].unsupportedPaths).to.deep.equal([]);
    expect(candidates[0].releases).to.deep.equal(
      [RECORD_A, RECORD_B].sort().map((recordId) => ({
        recordId,
        fields: { peers: [RETAINED_PEER] },
        intermediateCurrentHash: semanticHash({ peers: [RETAINED_PEER] }),
        publish: false,
        transientNestedBlockIds: [],
      })),
    );
  });

  it('deletes a strictly valid optional SCC without relaxing validators', () => {
    const { source, target, candidates } = fixture();
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: true,
      uploads: 'referenced',
      invalidContentDiagnostics: diagnostics(candidates, true),
    });

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(
      plan.records
        .filter(({ action }) => action === 'delete')
        .map(({ id }) => id)
        .sort(),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(plan.execution.deleteReleases).to.deep.equal(candidates);
  });

  it('preserves the entire SCC by default when its strict unlink is invalid', () => {
    const { source, target, candidates } = fixture();
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: true,
      uploads: 'referenced',
      invalidContentDiagnostics: diagnostics(candidates, false),
    });

    expect(plan.execution.deleteReleases).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id).sort(),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    for (const skipped of plan.invalidContent.skippedRecords) {
      expect(skipped.disposition).to.equal('preserve_target');
      expect(skipped.reasons.map(({ code }) => code)).to.include(
        'INVALID_INTERMEDIATE',
      );
      expect(skipped.reasons[0].dependencyChain).to.deep.equal(
        [RECORD_A, RECORD_B].sort(),
      );
    }
  });

  it('fails closed when a strict optional unlink has no exact diagnostic', () => {
    const { source, target } = fixture();
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: true,
      uploads: 'referenced',
    });

    expect(plan.execution.deleteReleases).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id).sort(),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(
      plan.invalidContent.skippedRecords.every(({ reasons }) =>
        reasons.some(({ code }) => code === 'VALIDATION_CONTRACT_CHANGED'),
      ),
    ).to.equal(true);
  });

  it('relaxes only size for the invalid unlink and restores the SCC as deletions', () => {
    const { source, target, candidates } = fixture();
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: true,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: diagnostics(candidates, false),
    });

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.execution.deleteReleases).to.deep.equal(candidates);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(plan.invalidContent.validatorRelaxations).to.have.length(1);
    expect(plan.invalidContent.validatorRelaxations[0]).to.deep.include({
      fieldId: FIELD_ID,
      itemTypeId: MODEL_ID,
      relaxedValidatorKeys: ['size'],
      affectedRecordIds: [RECORD_A, RECORD_B].sort(),
      originalValidators: {
        items_item_type: relationshipValidator(),
        size: { min: 0, multiple_of: 2 },
      },
      relaxedValidators: { items_item_type: relationshipValidator() },
    });
    expect(plan.requiredPermissions.editSchema).to.equal(true);
  });

  it('rolls back partial relaxations when another SCC release is unrelaxable', () => {
    const { source, target, candidates } = fixture();
    const mixedDiagnostics = diagnostics(candidates, false);
    mixedDiagnostics[1] = {
      ...mixedDiagnostics[1],
      issues: [
        {
          code: 'VALIDATION_ITEMS_ITEM_TYPE',
          fieldId: FIELD_ID,
          details: {},
        },
      ],
    };
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: true,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: mixedDiagnostics,
    });

    expect(plan.execution.deleteReleases).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id).sort(),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(
      plan.invalidContent.skippedRecords.every(({ reasons }) =>
        reasons.some(({ code }) => code === 'UNRELAXABLE_VALIDATOR'),
      ),
    ).to.equal(true);
  });

  it('preflights a non-publishing release when its model cannot save drafts', async () => {
    const { target, candidates } = fixture();
    const calls: Array<{ id: string; body: unknown }> = [];

    await assertPublishedDeleteReleasesValid(
      {
        items: {
          validateExisting: async (id: string, body: unknown) => {
            calls.push({ id, body });
          },
        },
      } as any,
      candidates,
      new Set(),
      target,
    );

    expect(calls.map(({ id }) => id).sort()).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(calls.map(({ body }) => body)).to.deep.equal([
      { peers: [RETAINED_PEER] },
      { peers: [RETAINED_PEER] },
    ]);
  });

  it('maps each strict release validation failure to its exact intermediate hash', async () => {
    const { target, candidates } = fixture();
    const calls: Array<{ id: string; body: unknown }> = [];
    const result = await diagnoseDeletionCycleReleasesAgainstDestination(
      {
        items: {
          validateExisting: async (id: string, body: unknown) => {
            calls.push({ id, body });
            throw {
              errors: [
                {
                  attributes: {
                    code: 'INVALID_FIELD',
                    details: {
                      code: 'VALIDATION_SIZE',
                      field_id: FIELD_ID,
                    },
                  },
                },
              ],
            };
          },
        },
      } as any,
      target,
      candidates,
    );

    expect(calls.map(({ id }) => id).sort()).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(result).to.deep.equal(
      candidates.map((release) => ({
        recordId: release.recordId,
        slice: 'intermediate',
        versionHash: release.intermediateCurrentHash,
        valid: false,
        issues: [
          {
            code: 'VALIDATION_SIZE',
            fieldId: FIELD_ID,
            details: { code: 'VALIDATION_SIZE', field_id: FIELD_ID },
          },
        ],
      })),
    );
  });
});

function fixture(): {
  source: ContentSnapshot;
  target: ContentSnapshot;
  candidates: ReturnType<
    typeof collectOptionalDeletionCycleReleaseCandidates
  >[number]['releases'];
} {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('target');
  const sourcePeer = makeRecord(sourceSchema, RETAINED_PEER, []);
  const targetPeer = makeRecord(targetSchema, RETAINED_PEER, []);
  const targetA = makeRecord(targetSchema, RECORD_A, [RECORD_B, RETAINED_PEER]);
  const targetB = makeRecord(targetSchema, RECORD_B, [RECORD_A, RETAINED_PEER]);
  const source = makeSnapshot(sourceSchema, {
    [RETAINED_PEER]: sourcePeer,
  });
  const target = makeSnapshot(targetSchema, {
    [RECORD_A]: targetA,
    [RECORD_B]: targetB,
    [RETAINED_PEER]: targetPeer,
  });
  const candidates = collectOptionalDeletionCycleReleaseCandidates(
    { [RECORD_A]: targetA, [RECORD_B]: targetB },
    targetSchema,
  )[0].releases;
  return { source, target, candidates };
}

function diagnostics(
  releases: ReturnType<
    typeof collectOptionalDeletionCycleReleaseCandidates
  >[number]['releases'],
  valid: boolean,
): InvalidContentDiagnostic[] {
  return releases.map((release) => ({
    recordId: release.recordId,
    slice: 'intermediate',
    versionHash: release.intermediateCurrentHash,
    valid,
    issues: valid
      ? []
      : [{ code: 'VALIDATION_SIZE', fieldId: FIELD_ID, details: {} }],
  }));
}

function makeSchema(environmentId: string): SchemaSnapshot {
  const schema: SchemaSnapshot = {
    siteId: 'site-id',
    environmentId,
    locales: ['en'],
    environmentSemantics: {
      timezone: 'UTC',
      improvedTimezoneManagement: true,
      improvedBooleanFields: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    },
    itemTypes: [
      {
        id: MODEL_ID,
        apiKey: 'strict_optional_node',
        name: 'Strict optional node',
        modularBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: false,
        draftSavingActive: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: FIELD_ID,
            apiKey: 'peers',
            fieldType: 'links',
            localized: false,
            position: 1,
            validators: {
              items_item_type: relationshipValidator(),
              size: { min: 0, multiple_of: 2 },
            },
          },
        ],
      },
    ],
    workflows: [],
    digest: '',
  };
  schema.digest = computeSchemaDigest(schema);
  return schema;
}

function relationshipValidator() {
  return {
    item_types: [MODEL_ID],
    on_publish_with_unpublished_references_strategy: 'fail',
    on_reference_unpublish_strategy: 'fail',
    on_reference_delete_strategy: 'fail',
  };
}

function makeRecord(
  schema: SchemaSnapshot,
  id: string,
  peers: string[],
): RecordSnapshot {
  const input = {
    id,
    type: 'item',
    item_type: { id: MODEL_ID, type: 'item_type' },
    peers,
    meta: {
      created_at: '2026-01-01T00:00:00Z',
      first_published_at: '2026-01-01T00:00:00Z',
      current_version: `version-${id}`,
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: true,
      updated_at: '2026-01-01T00:00:00Z',
      published_at: '2026-01-01T00:00:00Z',
      stage: null,
    },
  };
  return canonicalizeRecord(input, input, schema.itemTypes[0], schema, {
    publication: null,
    unpublishing: null,
  });
}

function makeSnapshot(
  schema: SchemaSnapshot,
  records: Record<string, RecordSnapshot>,
): ContentSnapshot {
  return {
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    siteId: schema.siteId,
    environmentId: schema.environmentId,
    capturedAt: '2026-01-01T00:00:00Z',
    schema,
    inspection: {
      itemTypes: [],
      digest: semanticHash({ itemTypes: [] }),
      structuralIssues: [],
    },
    scope: { itemTypeIds: [MODEL_ID], uploads: 'referenced' },
    readItemTypes: [{ id: MODEL_ID, workflowId: null }],
    records,
    uploads: {},
    uploadCollections: {},
    visibleRecordIds: Object.keys(records).sort(),
    blockOwnership: buildBlockOwnershipIndex(records, schema),
    digest: semanticHash(Object.values(records).map(({ hash }) => hash)),
  };
}
