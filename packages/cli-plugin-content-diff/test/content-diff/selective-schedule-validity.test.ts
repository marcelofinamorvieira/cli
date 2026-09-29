import { expect } from 'chai';
import {
  canonicalizeRecord,
  semanticHash,
} from '../../src/content-diff/canonicalize';
import { buildBlockOwnershipIndex } from '../../src/content-diff/dependencies';
import { diagnoseInvalidSourceContent } from '../../src/content-diff/index';
import { buildContentInspectionSnapshot } from '../../src/content-diff/inspection-schema';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import type {
  ContentSnapshot,
  InvalidContentDiagnostic,
  ItemTypeSchemaSnapshot,
  PublicationScheduleSnapshot,
  SchemaSnapshot,
} from '../../src/content-diff/types';
import { CONTENT_SNAPSHOT_FORMAT_VERSION } from '../../src/content-diff/types';

const MODEL_ID = 'Q5nXrV8mT2pL7sK4wY9Bdg';
const TITLE_FIELD_ID = 'R6oYsW9nU3qM8tL5xZ0Ceh';
const BODY_FIELD_ID = 'S7pZtX0oV4rN9uM6yA1Dfi';
const RECORD_ID = 'T8qAuY1pW5sO0vN7zB2Egj';
const FUTURE = '2035-01-01T00:00:00.000Z';

describe('selective publication validity proof', () => {
  it('keeps an en plus non-localized schedule when only title.it is invalid', () => {
    const { source, target, diagnostic } = fixture({
      selective: { locales: ['en'], nonLocalized: true },
    });
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      invalidContentDiagnostics: [diagnostic],
    });

    expect(plan.records).to.have.length(1);
    expect(plan.records[0]).to.deep.include({
      id: RECORD_ID,
      action: 'update',
      changes: {
        current: true,
        published: false,
        topology: false,
        lifecycle: false,
        stage: false,
        schedules: true,
      },
    });
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.detectedRecordIds).to.deep.equal([RECORD_ID]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([RECORD_ID]);
    expect(plan.requiredPermissions.manageSchedules).to.equal(true);
  });

  it('skips the same invalid draft when its it locale is selected', () => {
    const { source, target, diagnostic } = fixture({
      selective: { locales: ['it'], nonLocalized: false },
    });
    assertUnsafeSchedule(source, target, [diagnostic]);
  });

  it('distinguishes non-localized validation from localized validation', () => {
    const outside = fixture({
      selective: { locales: ['en'], nonLocalized: false },
      issue: {
        code: 'VALIDATION_REQUIRED',
        fieldId: BODY_FIELD_ID,
        details: { field: 'body' },
      },
    });
    const outsidePlan = buildContentDiffPlan(outside.source, outside.target, {
      includeDeletions: false,
      uploads: 'referenced',
      invalidContentDiagnostics: [outside.diagnostic],
    });
    expect(outsidePlan.invalidContent.skippedRecords).to.deep.equal([]);

    const selected = fixture({
      selective: { locales: ['en'], nonLocalized: true },
      issue: {
        code: 'VALIDATION_REQUIRED',
        fieldId: BODY_FIELD_ID,
        details: { field: 'body' },
      },
    });
    assertUnsafeSchedule(selected.source, selected.target, [
      selected.diagnostic,
    ]);
  });

  it('requires draft-saving mode and a genuinely selective non-empty scope', () => {
    const noDraftSaving = fixture({
      selective: { locales: ['en'], nonLocalized: false },
      draftSavingActive: false,
    });
    assertUnsafeSchedule(noDraftSaving.source, noDraftSaving.target, [
      noDraftSaving.diagnostic,
    ]);

    const wholeRecord = fixture({ selective: null });
    assertUnsafeSchedule(wholeRecord.source, wholeRecord.target, [
      wholeRecord.diagnostic,
    ]);

    const empty = fixture({
      selective: { locales: [], nonLocalized: false },
    });
    assertUnsafeSchedule(empty.source, empty.target, [empty.diagnostic]);
  });

  it('fails closed when issue provenance cannot identify the exact locale', () => {
    const ambiguousIssues: InvalidContentDiagnostic['issues'] = [
      {
        code: 'VALIDATION_REQUIRED',
        fieldId: TITLE_FIELD_ID,
        details: {},
      },
      {
        code: 'VALIDATION_REQUIRED',
        fieldId: TITLE_FIELD_ID,
        details: { field: 'title.fr' },
      },
      {
        code: 'VALIDATION_CONTRACT_CHANGED',
        fieldId: null,
        details: { status: 422 },
      },
    ];
    for (const issue of ambiguousIssues) {
      const candidate = fixture({
        selective: { locales: ['en'], nonLocalized: false },
        issue,
      });
      assertUnsafeSchedule(candidate.source, candidate.target, [
        candidate.diagnostic,
      ]);
    }
  });

  it('accepts nested field paths only when their terminal field and locale are exact', () => {
    const nestedOutside = fixture({
      selective: { locales: ['en'], nonLocalized: false },
      issue: {
        code: 'VALIDATION_REQUIRED',
        fieldId: TITLE_FIELD_ID,
        details: {
          field: 'content.en.0.child.document.children.1.item.title.it',
          locale: 'en',
        },
      },
    });
    const plan = buildContentDiffPlan(
      nestedOutside.source,
      nestedOutside.target,
      {
        includeDeletions: false,
        uploads: 'referenced',
        invalidContentDiagnostics: [nestedOutside.diagnostic],
      },
    );
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);

    const malformed = fixture({
      selective: { locales: ['en'], nonLocalized: false },
      issue: {
        code: 'VALIDATION_REQUIRED',
        fieldId: TITLE_FIELD_ID,
        details: { field: 'content.en.0.title.it.trailing' },
      },
    });
    assertUnsafeSchedule(malformed.source, malformed.target, [
      malformed.diagnostic,
    ]);
  });

  it('requires every matching source/destination diagnostic to exclude the schedule scope', () => {
    const { source, target, diagnostic } = fixture({
      selective: { locales: ['en'], nonLocalized: false },
    });
    assertUnsafeSchedule(source, target, [
      diagnostic,
      {
        ...diagnostic,
        issues: [
          {
            code: 'VALIDATION_REQUIRED',
            fieldId: TITLE_FIELD_ID,
            details: { field: 'title.en' },
          },
        ],
      },
    ]);
  });

  it('accepts a full-payload valid diagnostic despite a stale invalidity flag', () => {
    const candidate = fixture({
      selective: { locales: ['en'], nonLocalized: true },
    });
    const plan = buildContentDiffPlan(candidate.source, candidate.target, {
      includeDeletions: false,
      uploads: 'referenced',
      invalidContentDiagnostics: [
        { ...candidate.diagnostic, valid: true, issues: [] },
      ],
    });
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
  });

  it('retains exact field-path provenance from the read-only CMA diagnostic', async () => {
    const candidate = fixture({
      selective: { locales: ['en'], nonLocalized: true },
    });
    const diagnostics = await diagnoseInvalidSourceContent(
      {
        items: {
          validateExisting: async () => {
            throw {
              errors: [
                {
                  attributes: {
                    code: 'INVALID_FIELD',
                    details: {
                      code: 'VALIDATION_REQUIRED',
                      field: 'title.it',
                      field_id: TITLE_FIELD_ID,
                    },
                  },
                },
              ],
            };
          },
        },
      } as never,
      candidate.source,
    );

    expect(diagnostics).to.have.length(1);
    expect(diagnostics[0]).to.deep.include({
      recordId: RECORD_ID,
      slice: 'current',
      versionHash: candidate.diagnostic.versionHash,
      valid: false,
    });
    expect(diagnostics[0].issues).to.deep.equal([
      {
        code: 'VALIDATION_REQUIRED',
        fieldId: TITLE_FIELD_ID,
        details: {
          code: 'VALIDATION_REQUIRED',
          field: 'title.it',
          field_id: TITLE_FIELD_ID,
        },
      },
    ]);
    const plan = buildContentDiffPlan(candidate.source, candidate.target, {
      includeDeletions: false,
      uploads: 'referenced',
      invalidContentDiagnostics: diagnostics,
    });
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
  });
});

function assertUnsafeSchedule(
  source: ContentSnapshot,
  target: ContentSnapshot,
  diagnostics: readonly InvalidContentDiagnostic[],
): void {
  const plan = buildContentDiffPlan(source, target, {
    includeDeletions: false,
    uploads: 'referenced',
    migrateInvalidContent: true,
    invalidContentDiagnostics: [...diagnostics],
  });

  expect(plan.records).to.deep.equal([]);
  expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
  expect(plan.invalidContent.skippedRecords).to.have.length(1);
  expect(plan.invalidContent.skippedRecords[0].reasons[0]).to.deep.include({
    code: 'UNSAFE_SCHEDULED_PUBLICATION',
    slice: 'schedule',
  });
}

function fixture({
  selective,
  draftSavingActive = true,
  issue = {
    code: 'VALIDATION_REQUIRED',
    fieldId: TITLE_FIELD_ID,
    details: { field: 'title.it' },
  },
}: {
  selective: PublicationScheduleSnapshot['selective'];
  draftSavingActive?: boolean;
  issue?: InvalidContentDiagnostic['issues'][number];
}): {
  source: ContentSnapshot;
  target: ContentSnapshot;
  diagnostic: InvalidContentDiagnostic;
} {
  const source = makeSnapshot({
    environmentId: 'source',
    title: { en: 'ready in English', it: '' },
    body: 'valid shared body',
    valid: false,
    draftSavingActive,
    publication: { at: FUTURE, selective },
  });
  const target = makeSnapshot({
    environmentId: 'target',
    title: { en: 'baseline English', it: 'baseline italiano' },
    body: 'valid shared body',
    valid: true,
    draftSavingActive,
    publication: null,
  });

  return {
    source,
    target,
    diagnostic: {
      recordId: RECORD_ID,
      slice: 'current',
      versionHash: source.records[RECORD_ID].current.hash,
      valid: false,
      issues: [issue],
    },
  };
}

function makeSnapshot({
  environmentId,
  title,
  body,
  valid,
  draftSavingActive,
  publication,
}: {
  environmentId: string;
  title: { en: string; it: string };
  body: string;
  valid: boolean;
  draftSavingActive: boolean;
  publication: PublicationScheduleSnapshot | null;
}): ContentSnapshot {
  const schema = makeSchema(environmentId, draftSavingActive);
  const itemType = schema.itemTypes[0];
  const inspection = buildContentInspectionSnapshot(
    schema,
    schema,
    new Set(),
    [],
  );
  const record = canonicalizeRecord(
    {
      id: RECORD_ID,
      type: 'item',
      item_type: { id: MODEL_ID, type: 'item_type' },
      attributes: { title, body },
      meta: {
        created_at: '2026-01-01T00:00:00.000Z',
        first_published_at: null,
        current_version: `version-${environmentId}`,
        is_valid: valid,
        is_current_version_valid: valid,
        is_published_version_valid: null,
        updated_at: '2026-01-01T00:00:00.000Z',
        published_at: null,
        status: 'draft',
      },
    },
    null,
    itemType,
    schema,
    { publication, unpublishing: null },
  );
  const records = { [RECORD_ID]: record };

  return {
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    siteId: 'site-id',
    environmentId,
    capturedAt: '2026-01-01T00:00:00.000Z',
    schema,
    scope: { itemTypeIds: [MODEL_ID], uploads: 'referenced' },
    readItemTypes: [{ id: MODEL_ID, workflowId: null }],
    records,
    uploads: {},
    uploadCollections: {},
    visibleRecordIds: [RECORD_ID],
    blockOwnership: buildBlockOwnershipIndex(records, schema),
    inspection,
    digest: semanticHash({ record: record.hash, inspection }),
  };
}

function makeSchema(
  environmentId: string,
  draftSavingActive: boolean,
): SchemaSnapshot {
  const itemType: ItemTypeSchemaSnapshot = {
    id: MODEL_ID,
    apiKey: 'selective_schedule_article',
    name: 'Selective schedule article',
    modularBlock: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: true,
    draftSavingActive,
    allLocalesRequired: true,
    workflowId: null,
    fields: [
      {
        id: TITLE_FIELD_ID,
        apiKey: 'title',
        fieldType: 'string',
        localized: true,
        position: 1,
        defaultValue: { en: null, it: null },
        validators: { required: {} },
      },
      {
        id: BODY_FIELD_ID,
        apiKey: 'body',
        fieldType: 'text',
        localized: false,
        position: 2,
        defaultValue: null,
        validators: { required: {} },
      },
    ],
  };
  const schema: SchemaSnapshot = {
    siteId: 'site-id',
    environmentId,
    locales: ['en', 'it'],
    environmentSemantics: {
      timezone: 'UTC',
      improvedTimezoneManagement: true,
      improvedBooleanFields: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    },
    itemTypes: [itemType],
    workflows: [],
    digest: '',
  };
  schema.digest = computeSchemaDigest(schema);
  return schema;
}
