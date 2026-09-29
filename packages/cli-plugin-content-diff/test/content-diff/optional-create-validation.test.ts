import { expect } from 'chai';
import {
  canonicalizeRecord,
  semanticHash,
} from '../../src/content-diff/canonicalize';
import {
  buildBlockOwnershipIndex,
  collectCreateCycleIntermediateCandidates,
  collectCreateCycleShellCandidates,
} from '../../src/content-diff/dependencies';
import { diagnoseInvalidSourceContent } from '../../src/content-diff/index';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import {
  projectCreateSeedFields,
  projectPlanCreateSeedFields,
} from '../../src/content-diff/shared/create-seeds';
import {
  CONTENT_SNAPSHOT_FORMAT_VERSION,
  ContentDiffError,
  type ContentSnapshot,
  type InvalidContentDiagnostic,
  type RecordSnapshot,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

const ANCHOR_ID = 'C4xSoA0zT8MrN5oV7uY9Bi';
const FIRST_ID = '-40RNzgBSJaJsXiLSYhtVA';
const SECOND_ID = 'XSPMXvayT-yMUrVxP-YoSw';
const THIRD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const COMPONENT_IDS = [FIRST_ID, SECOND_ID, THIRD_ID] as const;
const MODEL_ID = '4QI3BfBvQs-hcv_YEkk1wg';
const FIELD_ID = 'B3wRnZ9yS7LqM4nU6tX8Ah';

describe('strict optional source-only create-cycle validation', () => {
  it('projects every exact order-dependent seed instead of a component-wide shell', () => {
    const { source, records } = fixture();
    const creationIds = new Set(COMPONENT_IDS);
    const fullShells = collectCreateCycleShellCandidates(
      records,
      source.schema,
      creationIds,
    );
    const exact = collectCreateCycleIntermediateCandidates(
      records,
      source.schema,
      creationIds,
    );

    expect(fullShells.map(({ fields }) => fields.peers)).to.deep.equal([
      [ANCHOR_ID],
      [ANCHOR_ID],
      [ANCHOR_ID],
    ]);
    expect(exact.map(({ recordId }) => recordId)).to.deep.equal(COMPONENT_IDS);
    expect(exact.map(({ fields }) => fields.peers)).to.deep.equal([
      [ANCHOR_ID],
      [ANCHOR_ID],
      [ANCHOR_ID, FIRST_ID],
    ]);
  });

  it('runs read-only diagnostics for every strict seed and preserves exact hashes', async () => {
    const { source, records } = fixture();
    const candidates = collectCreateCycleIntermediateCandidates(
      records,
      source.schema,
      new Set(COMPONENT_IDS),
    );
    const calls: Array<{ id: string; body: Record<string, unknown> }> = [];
    const diagnostics = await diagnoseInvalidSourceContent(
      {
        items: {
          validateExisting: async (
            id: string,
            body: Record<string, unknown>,
          ) => {
            calls.push({ id, body });
            const peers = body.peers;
            if (Array.isArray(peers) && peers.length % 2 !== 0) {
              throw validationError('VALIDATION_SIZE');
            }
          },
        },
      } as never,
      source,
      candidates,
    );

    expect(calls.map(({ id }) => id)).to.deep.equal(COMPONENT_IDS);
    expect(calls.map(({ body }) => body.peers)).to.deep.equal([
      [ANCHOR_ID],
      [ANCHOR_ID],
      [ANCHOR_ID, FIRST_ID],
    ]);
    expect(diagnostics).to.deep.equal(
      candidates.map((candidate, index) => ({
        recordId: candidate.recordId,
        slice: 'intermediate',
        versionHash: candidate.versionHash,
        valid: index === 2,
        issues:
          index === 2
            ? []
            : [
                {
                  code: 'VALIDATION_SIZE',
                  fieldId: FIELD_ID,
                  details: {
                    code: 'VALIDATION_SIZE',
                    field_id: FIELD_ID,
                  },
                },
              ],
      })),
    );
  });

  it('preserves the complete SCC by default and relaxes exactly size with opt-in', () => {
    const { source, target, records } = fixture();
    const candidates = collectCreateCycleIntermediateCandidates(
      records,
      source.schema,
      new Set(COMPONENT_IDS),
    );
    const diagnostics = sizeDiagnostics(candidates);
    const defaultPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      invalidContentDiagnostics: diagnostics,
    });

    expect(
      defaultPlan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([...COMPONENT_IDS]);
    expect(defaultPlan.records.map(({ id }) => id)).to.deep.equal([ANCHOR_ID]);
    for (const skipped of defaultPlan.invalidContent.skippedRecords) {
      expect(skipped.reasons).to.deep.include({
        code: 'INVALID_INTERMEDIATE',
        slice: 'intermediate',
        message: `Record ${FIRST_ID} needs an order-dependent create seed while its later optional cyclic dependencies are unavailable.`,
        dependencyChain: [...COMPONENT_IDS],
      });
    }

    const migrated = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: diagnostics,
    });
    expect(migrated.invalidContent.skippedRecords).to.deep.equal([]);
    expect(migrated.invalidContent.detectedRecordIds).to.deep.equal([
      ...COMPONENT_IDS,
    ]);
    expect(migrated.invalidContent.migratedRecordIds).to.deep.equal([
      ...COMPONENT_IDS,
    ]);
    expect(migrated.execution.createOrder).to.deep.equal([...COMPONENT_IDS]);
    expect(migrated.execution.shellRecordIds).to.deep.equal([]);
    expect(migrated.execution.shellComponents).to.deep.equal([]);
    expect(migrated.execution.revalidateBeforePublishIds).to.deep.equal([
      FIRST_ID,
      SECOND_ID,
    ]);
    expect(migrated.invalidContent.validatorRelaxations).to.have.length(1);
    expect(migrated.invalidContent.validatorRelaxations[0]).to.deep.include({
      fieldId: FIELD_ID,
      itemTypeId: MODEL_ID,
      relaxedValidatorKeys: ['size'],
      affectedRecordIds: [FIRST_ID, SECOND_ID],
      originalValidators: validators(),
      relaxedValidators: {
        items_item_type: relationshipValidator(),
      },
    });
  });

  it('diagnoses exactly the create seeds phase 5 sends (D51)', () => {
    const { source, target, records } = fixture();
    const candidates = collectCreateCycleIntermediateCandidates(
      records,
      source.schema,
      new Set(COMPONENT_IDS),
    );
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: sizeDiagnostics(candidates),
    });
    const seeds = projectPlanCreateSeedFields(plan);

    expect([...seeds.keys()].sort()).to.deep.equal(
      candidates.map(({ recordId }) => recordId).sort(),
    );
    for (const candidate of candidates) {
      expect(candidate.fields).to.deep.equal(seeds.get(candidate.recordId));
      expect(candidate.versionHash).to.equal(
        semanticHash(seeds.get(candidate.recordId)),
      );
    }
  });

  it('rejects a required reference to a later create in the diagnosed seed projection (D51)', () => {
    // Planner-built orders always create required targets first, so this
    // pins the phase-5 projection the diagnostics delegate to directly.
    const schema = makeSchema('source');
    schema.itemTypes[0].fields[0].validators = {
      ...validators(),
      required: {},
    };
    schema.digest = computeSchemaDigest(schema);
    const record = makeRecord(schema, FIRST_ID, [ANCHOR_ID, SECOND_ID]);
    const project = (createOrder: string[]) =>
      projectCreateSeedFields(
        record,
        schema,
        createOrder,
        new Set(COMPONENT_IDS),
        new Set(),
        [],
      );

    expect(project([SECOND_ID, FIRST_ID, THIRD_ID])).to.deep.equal(
      (record.published ?? record.current).fields,
    );
    let error: unknown;
    try {
      project([FIRST_ID, SECOND_ID, THIRD_ID]);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(ContentDiffError);
    expect((error as ContentDiffError).code).to.equal(
      'REQUIRED_REFERENCE_CYCLE',
    );
    expect((error as ContentDiffError).message).to.equal(
      `record ${FIRST_ID}.peers contains references that cannot be seeded safely.`,
    );
  });

  it('rolls back partial relaxation and skips every SCC member on one unrelaxable seed', () => {
    const { source, target, records } = fixture();
    const candidates = collectCreateCycleIntermediateCandidates(
      records,
      source.schema,
      new Set(COMPONENT_IDS),
    );
    const diagnostics = sizeDiagnostics(candidates);
    diagnostics[1] = {
      ...diagnostics[1],
      issues: [
        ...diagnostics[1].issues,
        {
          code: 'VALIDATION_ITEMS_ITEM_TYPE',
          fieldId: FIELD_ID,
          details: {},
        },
      ],
    };
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: diagnostics,
    });

    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([...COMPONENT_IDS]);
    expect(plan.execution.createOrder).to.deep.equal([]);
  });
});

function fixture(): {
  source: ContentSnapshot;
  target: ContentSnapshot;
  records: Record<string, RecordSnapshot>;
} {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('target');
  const sourceAnchor = makeRecord(sourceSchema, ANCHOR_ID, []);
  const targetAnchor = makeRecord(targetSchema, ANCHOR_ID, []);
  const records = {
    [ANCHOR_ID]: sourceAnchor,
    [FIRST_ID]: makeRecord(sourceSchema, FIRST_ID, [ANCHOR_ID, SECOND_ID]),
    [SECOND_ID]: makeRecord(sourceSchema, SECOND_ID, [ANCHOR_ID, THIRD_ID]),
    [THIRD_ID]: makeRecord(sourceSchema, THIRD_ID, [ANCHOR_ID, FIRST_ID]),
  };
  return {
    records,
    source: makeSnapshot(sourceSchema, records),
    target: makeSnapshot(targetSchema, { [ANCHOR_ID]: targetAnchor }),
  };
}

function sizeDiagnostics(
  candidates: ReturnType<typeof collectCreateCycleIntermediateCandidates>,
): InvalidContentDiagnostic[] {
  return candidates.map((candidate, index) => ({
    recordId: candidate.recordId,
    slice: 'intermediate',
    versionHash: candidate.versionHash,
    valid: index === 2,
    issues:
      index === 2
        ? []
        : [{ code: 'VALIDATION_SIZE', fieldId: FIELD_ID, details: {} }],
  }));
}

function validationError(code: string) {
  return {
    errors: [
      {
        attributes: {
          code: 'INVALID_FIELD',
          details: { code, field_id: FIELD_ID },
        },
      },
    ],
  };
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
        apiKey: 'strict_optional_create_node',
        name: 'Strict optional create node',
        modularBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: true,
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
            defaultValue: null,
            validators: validators(),
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

function validators() {
  return {
    items_item_type: relationshipValidator(),
    size: { min: 0, multiple_of: 2 },
  };
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
