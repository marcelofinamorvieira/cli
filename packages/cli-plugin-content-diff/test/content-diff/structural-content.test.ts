import { expect } from 'chai';
import {
  canonicalizeRecord,
  semanticHash,
} from '../../src/content-diff/canonicalize';
import { buildBlockOwnershipIndex } from '../../src/content-diff/dependencies';
import {
  buildContentInspectionSnapshot,
  contentTraversalSchema,
} from '../../src/content-diff/inspection-schema';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import {
  inspectRecordStructuralContent,
  nestedBlockIdentity,
} from '../../src/content-diff/structural-content';
import type {
  ContentSnapshot,
  ItemTypeSchemaSnapshot,
  RecordScheduleSnapshot,
  SchemaSnapshot,
  StructuralBlockValidatorKey,
} from '../../src/content-diff/types';
import {
  CONTENT_SNAPSHOT_FORMAT_VERSION,
  ContentDiffError,
} from '../../src/content-diff/types';

const RECORD_A = 'YhEa5SbeSl6KwIFizzkzig';
const RECORD_B = 'XSPMXvayT-yMUrVxP-YoSw';
const BLOCK_A = 'w3a6zOGbS_Kj91LgAyXISA';
const BLOCK_B = 'LQQiCYCfSU6DTmCQ63-JRw';
const OWNER_MODEL = '4QI3BfBvQs-hcv_YEkk1wg';
const ALLOWED_BLOCK_MODEL = 'mzmy5RRCSwCzMvmKgvsHUA';
const RETIRED_BLOCK_MODEL = '6lbNvQx7R4aX9tZsKc2M0g';

describe('structurally invalid nested content', () => {
  for (const scenario of [
    {
      fieldType: 'rich_text' as const,
      validatorKey: 'rich_text_blocks' as const,
      value: (block: Record<string, unknown>) => [block],
    },
    {
      fieldType: 'single_block' as const,
      validatorKey: 'single_block_blocks' as const,
      value: (block: Record<string, unknown>) => block,
    },
    {
      fieldType: 'structured_text' as const,
      validatorKey: 'structured_text_blocks' as const,
      value: (block: Record<string, unknown>) => ({
        schema: 'dast',
        document: {
          type: 'root',
          children: [{ type: 'block', item: block }],
        },
      }),
    },
    {
      fieldType: 'structured_text' as const,
      validatorKey: 'structured_text_inline_blocks' as const,
      value: (block: Record<string, unknown>) => ({
        schema: 'dast',
        document: {
          type: 'root',
          children: [{ type: 'inlineBlock', item: block }],
        },
      }),
    },
  ]) {
    it(`diagnoses ${scenario.validatorKey} without adding its block model to managed schema`, () => {
      const { full, owner } = makeSchemas('source', {
        fieldType: scenario.fieldType,
        validatorKey: scenario.validatorKey,
        localized: true,
      });
      const block = makeBlock(BLOCK_A, RETIRED_BLOCK_MODEL, {
        child: null,
      });
      const record = makeRawRecord(RECORD_A, {
        content: { en: scenario.value(block) },
      });

      const result = inspectRecordStructuralContent(
        record,
        owner,
        full,
        RECORD_A,
        'current',
      );

      expect(result.encounteredItemTypeIds).to.deep.equal([
        RETIRED_BLOCK_MODEL,
      ]);
      expect(result.issues).to.deep.equal([
        {
          recordId: RECORD_A,
          itemTypeId: OWNER_MODEL,
          slice: 'current',
          fieldId: 'content-field',
          fieldPath:
            scenario.fieldType === 'rich_text'
              ? 'content[0]'
              : scenario.fieldType === 'single_block'
                ? 'content'
                : 'content.document.children[0].item',
          locale: 'en',
          validatorKey: scenario.validatorKey,
          blockId: BLOCK_A,
          blockItemTypeId: RETIRED_BLOCK_MODEL,
        },
      ]);
    });
  }

  it('recurses from Structured Text through a retired block into another invalid nested block', () => {
    const { full, owner } = makeSchemas('source', {
      fieldType: 'structured_text',
      validatorKey: 'structured_text_blocks',
    });
    const child = makeBlock(BLOCK_B, RETIRED_BLOCK_MODEL, { child: null });
    const outer = makeBlock(BLOCK_A, RETIRED_BLOCK_MODEL, { child });
    const record = makeRawRecord(RECORD_A, {
      content: {
        schema: 'dast',
        document: {
          type: 'root',
          children: [{ type: 'block', item: outer }],
        },
      },
    });

    const result = inspectRecordStructuralContent(
      record,
      owner,
      full,
      RECORD_A,
      'published',
    );

    expect(
      result.issues.map(({ blockId, validatorKey, fieldPath }) => ({
        blockId,
        validatorKey,
        fieldPath,
      })),
    ).to.deep.equal([
      {
        blockId: BLOCK_A,
        validatorKey: 'structured_text_blocks',
        fieldPath: 'content.document.children[0].item',
      },
      {
        blockId: BLOCK_B,
        validatorKey: 'single_block_blocks',
        fieldPath: `content.document.children[0].item.block:${BLOCK_A}.child`,
      },
    ]);
  });

  it('preserves Structured Text sidecars without treating item-shaped metadata as blocks', () => {
    const { full, owner } = makeSchemas('source', {
      fieldType: 'structured_text',
      validatorKey: 'structured_text_blocks',
    });
    const sidecar = {
      type: 'block',
      item: makeBlock('example-id', 'example-model', { value: 'metadata' }),
    };
    const content = {
      schema: 'custom-content-v1',
      sidecar,
      document: {
        type: 'root',
        sidecar,
        children: [
          {
            type: 'block',
            item: {
              id: BLOCK_A,
              type: 'item',
              item_type: { id: ALLOWED_BLOCK_MODEL, type: 'item_type' },
              caption: 'real block',
            },
            sidecar,
          },
        ],
      },
    };
    const record = makeRawRecord(RECORD_A, { content });
    const inspection = inspectRecordStructuralContent(
      record,
      owner,
      full,
      RECORD_A,
      'current',
    );
    expect(inspection).to.deep.equal({
      encounteredItemTypeIds: [ALLOWED_BLOCK_MODEL],
      issues: [],
    });

    const normalized = canonicalizeRecord(record, null, owner, full, {
      publication: null,
      unpublishing: null,
    });
    expect(normalized.current.fields.content).to.deep.equal({
      ...content,
      document: {
        ...content.document,
        children: [
          {
            ...content.document.children[0],
            item: makeBlock(BLOCK_A, ALLOWED_BLOCK_MODEL, {
              caption: 'real block',
            }),
          },
        ],
      },
    });
    expect(
      Object.keys(buildBlockOwnershipIndex({ [RECORD_A]: normalized }, full)),
    ).to.deep.equal([BLOCK_A]);
  });

  it('fails closed on missing, conflicting, unknown, and malformed block identities', () => {
    const { full, owner } = makeSchemas('source');
    const missingModel = { id: BLOCK_A, type: 'item', attributes: {} };
    const conflicting = {
      ...makeBlock(BLOCK_A, RETIRED_BLOCK_MODEL, {}),
      item_type: { id: ALLOWED_BLOCK_MODEL, type: 'item_type' },
    };
    const unknown = makeBlock(BLOCK_A, 'missing-block-model', {});
    const malformedAttributes = {
      ...makeBlock(BLOCK_A, RETIRED_BLOCK_MODEL, {}),
      attributes: null,
    };

    for (const block of [
      missingModel,
      conflicting,
      unknown,
      malformedAttributes,
    ]) {
      expect(() =>
        inspectRecordStructuralContent(
          makeRawRecord(RECORD_A, { content: block }),
          owner,
          full,
          RECORD_A,
          'current',
        ),
      ).to.throw(ContentDiffError);
    }

    expect(
      nestedBlockIdentity(
        { item_type: { data: { id: RETIRED_BLOCK_MODEL } } },
        'relationship wrapper',
      ),
    ).to.equal(null);

    const structured = makeSchemas('source', {
      fieldType: 'structured_text',
      validatorKey: 'structured_text_blocks',
    });
    for (const node of [{ type: 'block' }, { type: 'block', item: null }]) {
      const content = {
        schema: 'dast',
        document: { type: 'root', children: [node] },
      };
      const raw = makeRawRecord(RECORD_A, { content }, false);
      expect(() =>
        inspectRecordStructuralContent(
          raw,
          structured.owner,
          structured.full,
          RECORD_A,
          'current',
        ),
      ).to.throw(ContentDiffError);
      expect(
        canonicalizeRecord(raw, null, structured.owner, structured.full, {
          publication: null,
          unpublishing: null,
        }).current.fields.content,
      ).to.deep.equal(content);
    }

    for (const content of [
      null,
      { schema: 'dast' },
      { schema: 'dast', document: null },
    ]) {
      const raw = makeRawRecord(RECORD_A, { content }, false);
      expect(
        inspectRecordStructuralContent(
          raw,
          structured.owner,
          structured.full,
          RECORD_A,
          'current',
        ),
      ).to.deep.equal({ encounteredItemTypeIds: [], issues: [] });
      const record = canonicalizeRecord(
        raw,
        null,
        structured.owner,
        structured.full,
        {
          publication: null,
          unpublishing: null,
        },
      );
      expect(record.current.fields.content).to.deep.equal(content);
      expect(record.validity.current).to.equal(false);
    }
  });

  it('skips the whole aggregate in both modes and propagates the skip to consumers', () => {
    const source = makeSnapshot('source', [
      makeRawRecord(
        RECORD_A,
        {
          content: makeBlock(BLOCK_A, RETIRED_BLOCK_MODEL, { child: null }),
          related: null,
        },
        false,
      ),
      makeRawRecord(RECORD_B, { content: null, related: RECORD_A }),
    ]);
    const target = makeSnapshot('target', []);

    for (const migrateInvalidContent of [false, true]) {
      const plan = buildContentDiffPlan(source, target, {
        includeDeletions: true,
        uploads: 'referenced',
        migrateInvalidContent,
      });

      expect(plan.records).to.deep.equal([]);
      expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
      expect(
        plan.invalidContent.skippedRecords.map(({ id }) => id).sort(),
      ).to.deep.equal([RECORD_A, RECORD_B].sort());
      expect(
        plan.invalidContent.skippedRecords.find(({ id }) => id === RECORD_A)
          ?.reasons[0],
      ).to.include({
        code: 'STRUCTURAL_VALIDATION',
        validatorKey: 'single_block_blocks',
        dependencyId: BLOCK_A,
      });
      expect(
        plan.invalidContent.skippedRecords
          .find(({ id }) => id === RECORD_B)
          ?.reasons.some(({ code }) => code === 'DEPENDENCY_ON_SKIPPED_RECORD'),
      ).to.equal(true);
      expect(plan.requiredPermissions.editSchema).to.equal(false);
    }
  });

  it('keeps an identical invalid aggregate as a semantic noop', () => {
    const raw = makeRawRecord(
      RECORD_A,
      {
        content: makeBlock(BLOCK_A, RETIRED_BLOCK_MODEL, { child: null }),
        related: null,
      },
      false,
    );
    const source = makeSnapshot('source', [raw]);
    const target = makeSnapshot('target', [raw]);
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
    });

    expect(plan.records).to.have.length(1);
    expect(plan.records[0].action).to.equal('noop');
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.invalidContent.detectedRecordIds).to.deep.equal([RECORD_A]);
    expect(
      plan.warnings.some(({ code }) => code === 'INVALID_CONTENT_NOOP'),
    ).to.equal(true);
    expect(plan.targetInspection.itemTypes.map(({ id }) => id)).to.deep.equal([
      RETIRED_BLOCK_MODEL,
    ]);
  });

  it('can update or delete a structurally invalid destination aggregate', () => {
    const invalidTarget = makeRawRecord(
      RECORD_A,
      {
        content: makeBlock(BLOCK_A, RETIRED_BLOCK_MODEL, { child: null }),
        related: null,
      },
      false,
    );
    const target = makeSnapshot('target', [invalidTarget]);
    const validSource = makeSnapshot('source', [
      makeRawRecord(RECORD_A, { content: null, related: null }),
    ]);
    const updatePlan = buildContentDiffPlan(validSource, target, {
      includeDeletions: false,
      uploads: 'referenced',
    });
    const deletePlan = buildContentDiffPlan(
      makeSnapshot('source', []),
      target,
      {
        includeDeletions: true,
        uploads: 'referenced',
      },
    );

    expect(updatePlan.records.map(({ action }) => action)).to.deep.equal([
      'update',
    ]);
    expect(deletePlan.records.map(({ action }) => action)).to.deep.equal([
      'delete',
    ]);
    expect(
      updatePlan.targetInspection.itemTypes.map(({ id }) => id),
    ).to.deep.equal([RETIRED_BLOCK_MODEL]);
    expect(
      deletePlan.targetInspection.itemTypes.map(({ id }) => id),
    ).to.deep.equal([RETIRED_BLOCK_MODEL]);
  });

  it('skips an invalid current version when adding a future publication schedule', () => {
    const raw = makeRawRecord(
      RECORD_A,
      { content: null, related: null },
      false,
    );
    const publication = {
      publication: {
        at: '2035-01-01T00:00:00.000Z',
        selective: null,
      },
      unpublishing: null,
    } satisfies RecordScheduleSnapshot;
    const source = makeSnapshot('source', [raw], publication);
    const target = makeSnapshot('target', [raw]);

    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: [
        {
          recordId: RECORD_A,
          slice: 'current',
          versionHash: source.records[RECORD_A].current.hash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_REQUIRED',
              fieldId: 'content-field',
              details: {},
            },
          ],
        },
      ],
    });

    expect(plan.records).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.skippedRecords[0].reasons[0]).to.include({
      code: 'UNSAFE_SCHEDULED_PUBLICATION',
      slice: 'schedule',
    });
  });

  it('skips an invalid current write when an unchanged future publication schedule remains', () => {
    const publication = {
      publication: {
        at: '2035-01-01T00:00:00.000Z',
        selective: null,
      },
      unpublishing: null,
    } satisfies RecordScheduleSnapshot;
    const source = makeSnapshot(
      'source',
      [
        makeRawRecord(
          RECORD_A,
          {
            content: makeBlock(BLOCK_A, ALLOWED_BLOCK_MODEL, {}),
            related: null,
          },
          false,
        ),
      ],
      publication,
    );
    const target = makeSnapshot(
      'target',
      [makeRawRecord(RECORD_A, { content: null, related: null }, false)],
      publication,
    );

    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: [
        {
          recordId: RECORD_A,
          slice: 'current',
          versionHash: source.records[RECORD_A].current.hash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_REQUIRED',
              fieldId: 'content-field',
              details: {},
            },
          ],
        },
      ],
    });

    expect(plan.records).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.skippedRecords[0].reasons[0]).to.include({
      code: 'UNSAFE_SCHEDULED_PUBLICATION',
      slice: 'schedule',
    });
  });
});

function makeSnapshot(
  environmentId: string,
  rawRecords: Record<string, unknown>[],
  schedules: RecordScheduleSnapshot = {
    publication: null,
    unpublishing: null,
  },
): ContentSnapshot {
  const { managed, full, owner } = makeSchemas(environmentId);
  const encountered = new Set<string>();
  const issues = rawRecords.flatMap((raw) => {
    const id = String(raw.id);
    const result = inspectRecordStructuralContent(
      raw,
      owner,
      full,
      id,
      'current',
    );
    result.encounteredItemTypeIds.forEach((itemTypeId) =>
      encountered.add(itemTypeId),
    );
    return result.issues;
  });
  const inspection = buildContentInspectionSnapshot(
    full,
    managed,
    encountered,
    issues,
  );
  const traversalSchema = contentTraversalSchema({
    schema: managed,
    inspection,
  });
  const records = Object.fromEntries(
    rawRecords.map((raw) => {
      const record = canonicalizeRecord(
        raw,
        null,
        owner,
        traversalSchema,
        schedules,
      );
      return [record.id, record];
    }),
  );
  const blockOwnership = buildBlockOwnershipIndex(records, traversalSchema);

  return {
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    siteId: managed.siteId,
    environmentId,
    capturedAt: '2026-01-01T00:00:00.000Z',
    schema: managed,
    inspection,
    scope: { itemTypeIds: [OWNER_MODEL], uploads: 'referenced' },
    readItemTypes: [{ id: OWNER_MODEL, workflowId: null }],
    records,
    uploads: {},
    uploadCollections: {},
    visibleRecordIds: Object.keys(records).sort(),
    blockOwnership,
    digest: semanticHash({
      records: Object.values(records).map(({ hash }) => hash),
      inspection,
    }),
  };
}

function makeSchemas(
  environmentId: string,
  options: {
    fieldType?: 'rich_text' | 'single_block' | 'structured_text';
    validatorKey?: StructuralBlockValidatorKey;
    localized?: boolean;
  } = {},
): {
  managed: SchemaSnapshot;
  full: SchemaSnapshot;
  owner: ItemTypeSchemaSnapshot;
} {
  const fieldType = options.fieldType ?? 'single_block';
  const validatorKey = options.validatorKey ?? 'single_block_blocks';
  const owner = itemType(OWNER_MODEL, 'article', false, [
    {
      id: 'content-field',
      apiKey: 'content',
      fieldType,
      localized: options.localized ?? false,
      position: 1,
      defaultValue: null,
      validators: {
        [validatorKey]: { item_types: [ALLOWED_BLOCK_MODEL] },
      },
    },
    {
      id: 'related-field',
      apiKey: 'related',
      fieldType: 'link',
      localized: false,
      position: 2,
      defaultValue: null,
      validators: { item_item_type: { item_types: [OWNER_MODEL] } },
    },
  ]);
  const allowed = itemType(ALLOWED_BLOCK_MODEL, 'allowed_block', true, []);
  const retired = itemType(RETIRED_BLOCK_MODEL, 'retired_block', true, [
    {
      id: 'retired-child-field',
      apiKey: 'child',
      fieldType: 'single_block',
      localized: false,
      position: 1,
      defaultValue: null,
      validators: {
        single_block_blocks: { item_types: [ALLOWED_BLOCK_MODEL] },
      },
    },
  ]);
  const managed = schema(environmentId, [owner, allowed]);
  const full = schema(environmentId, [owner, allowed, retired]);
  return { managed, full, owner };
}

function schema(
  environmentId: string,
  itemTypes: ItemTypeSchemaSnapshot[],
): SchemaSnapshot {
  const result: SchemaSnapshot = {
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
    itemTypes,
    workflows: [],
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function itemType(
  id: string,
  apiKey: string,
  modularBlock: boolean,
  fields: ItemTypeSchemaSnapshot['fields'],
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey,
    name: apiKey,
    modularBlock,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: !modularBlock,
    draftSavingActive: !modularBlock,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}

function makeRawRecord(
  id: string,
  attributes: Record<string, unknown>,
  valid = true,
): Record<string, unknown> {
  return {
    id,
    type: 'item',
    item_type: { id: OWNER_MODEL, type: 'item_type' },
    attributes,
    meta: {
      created_at: '2025-01-01T00:00:00.000Z',
      first_published_at: null,
      current_version: `version-${id}`,
      is_valid: valid,
      is_current_version_valid: valid,
      is_published_version_valid: null,
      updated_at: '2025-01-01T00:00:00.000Z',
      published_at: null,
      stage: null,
    },
  };
}

function makeBlock(
  id: string,
  itemTypeId: string,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    type: 'item',
    attributes,
    relationships: {
      item_type: {
        data: { id: itemTypeId, type: 'item_type' },
      },
    },
  };
}
