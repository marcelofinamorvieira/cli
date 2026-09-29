import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  canonicalizeRecord,
  semanticHash,
  stableStringify,
} from '../../src/content-diff/canonicalize';
import { buildBlockOwnershipIndex } from '../../src/content-diff/dependencies';
import {
  buildContentInspectionSnapshot,
  contentTraversalSchema,
} from '../../src/content-diff/inspection-schema';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import { inspectRecordStructuralContent } from '../../src/content-diff/structural-content';
import {
  CONTENT_SNAPSHOT_FORMAT_VERSION,
  ContentDiffError,
  type ContentSnapshot,
  type FieldSchemaSnapshot,
  type ItemTypeSchemaSnapshot,
  type JsonObject,
  type JsonValue,
  type SchemaSnapshot,
  type StructuralContentIssue,
} from '../../src/content-diff/types';

const RECORD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const OWNER_MODEL = '4QI3BfBvQs-hcv_YEkk1wg';
const CONTAINER_MODEL = 'mzmy5RRCSwCzMvmKgvsHUA';
const RETIRED_MODEL = '6lbNvQx7R4aX9tZsKc2M0g';
const PORTABLE_CONTAINER_ID = 'w3a6zOGbS_Kj91LgAyXISA';
const PORTABLE_LEAF_ID = 'LQQiCYCfSU6DTmCQ63-JRw';

const CONTAINERS = [
  {
    name: 'Modular Content',
    fieldType: 'rich_text',
    validatorKey: 'rich_text_blocks',
    wrap: (block: JsonObject): JsonValue => [block],
  },
  {
    name: 'single block',
    fieldType: 'single_block',
    validatorKey: 'single_block_blocks',
    wrap: (block: JsonObject): JsonValue => block,
  },
  {
    name: 'Structured Text block',
    fieldType: 'structured_text',
    validatorKey: 'structured_text_blocks',
    wrap: (block: JsonObject): JsonValue => documentWith('block', block),
  },
  {
    name: 'Structured Text inline block',
    fieldType: 'structured_text',
    validatorKey: 'structured_text_inline_blocks',
    wrap: (block: JsonObject): JsonValue => documentWith('inlineBlock', block),
  },
] as const;

describe('historical structural-content preservation', () => {
  // 4 containers x 2 locale shapes x 2 ID representations x 3 invalid-slice
  // combinations. Both invalid-content modes must skip changed aggregates and
  // preserve identical aggregates, including the valid sibling version.
  for (const container of CONTAINERS) {
    it(`preserves historical inline blocks with an absent optional allowlist inside ${container.name}`, () => {
      for (const localized of [false, true]) {
        for (const legacyIds of [false, true]) {
          for (const invalidSlice of [
            'current',
            'published',
            'both',
          ] as const) {
            const context = `${container.name}/${localized}/${legacyIds}/${invalidSlice}`;
            const containerId = legacyIds ? '123456' : PORTABLE_CONTAINER_ID;
            const leafId = legacyIds ? '123457' : PORTABLE_LEAF_ID;
            const fields = (invalid: boolean): JsonObject => {
              const value = container.wrap(
                block(containerId, CONTAINER_MODEL, {
                  body: invalid
                    ? documentWith(
                        'inlineBlock',
                        block(leafId, RETIRED_MODEL, { caption: 'historical' }),
                      )
                    : emptyDocument(),
                }),
              );
              return { content: localized ? { en: value, it: null } : value };
            };
            const currentValid = invalidSlice === 'published';
            const publishedValid = invalidSlice === 'current';
            const versions = {
              current: fields(!currentValid),
              published: fields(!publishedValid),
              currentValid,
              publishedValid,
            };
            const owner = itemType(OWNER_MODEL, false, [
              field(
                'content',
                container.fieldType,
                {
                  ...structuredTextValidators(container.fieldType),
                  [container.validatorKey]: { item_types: [CONTAINER_MODEL] },
                },
                localized,
              ),
            ]);
            const enclosingBlock = itemType(CONTAINER_MODEL, true, [
              // Historical schema: structured_text_inline_blocks is optional
              // and omitted. It has no allowed inline block model IDs.
              field(
                'body',
                'structured_text',
                structuredTextValidators('structured_text'),
              ),
            ]);
            const retired = itemType(RETIRED_MODEL, true, [
              field('caption', 'string', {}),
            ]);
            const managed = [owner, enclosingBlock];
            const source = snapshot('source', managed, [retired], versions);
            const emptyTarget = snapshot('target', managed, [retired]);
            const identicalTarget = snapshot(
              'target',
              managed,
              [retired],
              versions,
            );
            const before = stableStringify({
              source,
              emptyTarget,
              identicalTarget,
            });

            const expectedSlices =
              invalidSlice === 'both'
                ? ['current', 'published']
                : [invalidSlice];
            expect(
              source.inspection.structuralIssues.map(({ slice }) => slice),
              context,
            ).to.deep.equal(expectedSlices);
            for (const issue of source.inspection.structuralIssues) {
              expect(issue, context).to.include({
                recordId: RECORD_ID,
                itemTypeId: OWNER_MODEL,
                fieldId: 'body-field',
                validatorKey: 'structured_text_inline_blocks',
                blockId: leafId,
                blockItemTypeId: RETIRED_MODEL,
                locale: localized ? 'en' : null,
              });
            }
            expect(
              source.inspection.itemTypes.map(({ id }) => id),
              context,
            ).to.deep.equal([RETIRED_MODEL]);
            expect(
              source.schema.itemTypes.some(({ id }) => id === RETIRED_MODEL),
              context,
            ).to.equal(false);

            for (const migrateInvalidContent of [false, true]) {
              const options = {
                includeDeletions: true,
                uploads: 'referenced' as const,
                migrateInvalidContent,
              };
              const skipped = buildContentDiffPlan(
                source,
                emptyTarget,
                options,
              );
              expect(skipped.records, context).to.deep.equal([]);
              expect(
                skipped.invalidContent.validatorRelaxations,
                context,
              ).to.deep.equal([]);
              expect(
                skipped.invalidContent.skippedRecords,
                context,
              ).to.have.length(1);
              expect(
                skipped.invalidContent.skippedRecords[0],
                context,
              ).to.include({
                id: RECORD_ID,
                disposition: 'must_remain_absent',
              });
              const structuralReasons =
                skipped.invalidContent.skippedRecords[0].reasons.filter(
                  ({ code }) => code === 'STRUCTURAL_VALIDATION',
                );
              expect(
                structuralReasons.map(({ slice }) => slice),
                context,
              ).to.deep.equal(expectedSlices);
              for (const reason of structuralReasons) {
                expect(reason, context).to.include({
                  code: 'STRUCTURAL_VALIDATION',
                  fieldId: 'body-field',
                  validatorKey: 'structured_text_inline_blocks',
                  dependencyId: leafId,
                });
              }
              expect(skipped.requiredPermissions.editSchema, context).to.equal(
                false,
              );

              const noop = buildContentDiffPlan(
                source,
                identicalTarget,
                options,
              );
              expect(
                noop.records.map(({ action }) => action),
                context,
              ).to.deep.equal(['noop']);
              expect(noop.records[0].desired, context).to.deep.equal(
                source.records[RECORD_ID],
              );
              expect(noop.records[0].baseline, context).to.deep.equal(
                identicalTarget.records[RECORD_ID],
              );
              expect(noop.invalidContent.skippedRecords, context).to.deep.equal(
                [],
              );
              expect(
                noop.invalidContent.validatorRelaxations,
                context,
              ).to.deep.equal([]);
              expect(
                noop.warnings.some(
                  ({ code }) => code === 'INVALID_CONTENT_NOOP',
                ),
                context,
              ).to.equal(true);
            }
            expect(
              stableStringify({ source, emptyTarget, identicalTarget }),
              context,
            ).to.equal(before);
          }
        }
      }
    });
  }

  it('lets the runtime validate noop plans that keep historical blocks from inspection-only models', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-historical-noop-'));
    try {
      const path = join(directory, 'runtime.cjs');
      await writeFile(
        path,
        `${renderRuntime(
          'js',
        )}\nmodule.exports.__validatePlan = validateContentDiffPlan;\nmodule.exports.__verifyLegacyIdMappingRegistryPlanOwnership = verifyLegacyIdMappingRegistryPlanOwnership;\n`,
      );
      const runtime = createRequire(join(directory, 'loader.cjs'))(path) as {
        __validatePlan(plan: unknown): void;
        __verifyLegacyIdMappingRegistryPlanOwnership(
          context: Record<string, unknown>,
          registry: Record<string, unknown>,
        ): void;
      };
      for (const container of CONTAINERS) {
        const fields = {
          content: container.wrap(
            block(PORTABLE_CONTAINER_ID, CONTAINER_MODEL, {
              body: documentWith(
                'inlineBlock',
                block(PORTABLE_LEAF_ID, RETIRED_MODEL, {
                  caption: 'historical',
                }),
              ),
            }),
          ),
        };
        const versions = {
          current: fields,
          published: fields,
          currentValid: false,
          publishedValid: false,
        };
        const managed = [
          itemType(OWNER_MODEL, false, [
            field('content', container.fieldType, {
              ...structuredTextValidators(container.fieldType),
              [container.validatorKey]: { item_types: [CONTAINER_MODEL] },
            }),
          ]),
          itemType(CONTAINER_MODEL, true, [
            field(
              'body',
              'structured_text',
              structuredTextValidators('structured_text'),
            ),
          ]),
        ];
        const retired = itemType(RETIRED_MODEL, true, [
          field('caption', 'string', {}),
        ]);
        const plan = buildContentDiffPlan(
          snapshot('source', managed, [retired], versions),
          snapshot('target', managed, [retired], versions),
          {
            includeDeletions: true,
            uploads: 'referenced',
            migrateInvalidContent: false,
          },
        );
        expect(
          plan.records.map(({ action }) => action),
          container.name,
        ).to.deep.equal(['noop']);
        expect(
          plan.targetInspection.itemTypes.map(({ id }) => id),
          container.name,
        ).to.deep.equal([RETIRED_MODEL]);

        // Legacy-ID availability walks the same managed plus inspection
        // models as the rest of plan validation.
        expect(
          () => runtime.__validatePlan(plan),
          container.name,
        ).not.to.throw();

        const context = {
          plan,
          schemaById: new Map(
            plan.schema.itemTypes.map((entry) => [entry.id, entry]),
          ),
          captureSchemaById: new Map(
            [...plan.schema.itemTypes, ...plan.targetInspection.itemTypes].map(
              (entry) => [entry.id, entry],
            ),
          ),
        };
        expect(
          () =>
            runtime.__verifyLegacyIdMappingRegistryPlanOwnership(context, {
              targetClaims: new Map(),
              recordsById: new Map(),
            }),
          container.name,
        ).not.to.throw();
        // The historical block is visited, so an unowned durable claim on its
        // ID is a mapping conflict rather than an unknown-model rejection.
        expect(
          () =>
            runtime.__verifyLegacyIdMappingRegistryPlanOwnership(context, {
              targetClaims: new Map([
                [
                  `item\u0000${PORTABLE_LEAF_ID}`,
                  {
                    entityType: 'block',
                    sourceId: '123457',
                    targetId: PORTABLE_LEAF_ID,
                  },
                ],
              ]),
              recordsById: new Map(),
            }),
          container.name,
        )
          .to.throw()
          .with.property('code', 'LEGACY_MAPPING_CONFLICT');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a forged structural path, locale, version, or validator even when its block exists', () => {
    const owner = itemType(OWNER_MODEL, false, [
      field(
        'content',
        'structured_text',
        structuredTextValidators('structured_text'),
        true,
      ),
    ]);
    const retired = itemType(RETIRED_MODEL, true, [
      field('caption', 'string', {}),
    ]);
    const source = snapshot('source', [owner], [retired], {
      current: {
        content: {
          en: documentWith(
            'inlineBlock',
            block(PORTABLE_LEAF_ID, RETIRED_MODEL, { caption: 'historical' }),
          ),
        },
      },
      published: { content: { en: emptyDocument() } },
      currentValid: false,
      publishedValid: true,
    });
    const target = snapshot('target', [owner], [retired]);
    const captured = source.inspection.structuralIssues[0];
    expect(captured).to.include({
      slice: 'current',
      locale: 'en',
      blockId: PORTABLE_LEAF_ID,
    });
    for (const forged of [
      { ...captured, fieldPath: 'content.document.children[999].item' },
      { ...captured, locale: 'it' },
      { ...captured, slice: 'published' as const },
      { ...captured, validatorKey: 'structured_text_blocks' as const },
    ]) {
      const tampered = {
        ...source,
        inspection: { ...source.inspection, structuralIssues: [forged] },
      };
      expect(
        () =>
          buildContentDiffPlan(tampered, target, {
            includeDeletions: false,
            uploads: 'referenced',
            migrateInvalidContent: true,
          }),
        stableStringify(forged),
      ).to.throw(ContentDiffError, 'invalid structural-content diagnostic');
    }
  });

  it('preserves slug_title_field configuration while relaxing only a diagnosed slug length rule', () => {
    // slug_title_field configures a same-model string title field; its CMA
    // content validator always returns true. Length supplies the actual
    // current/published invalidity, so this verifies configuration preservation.
    const validators: JsonObject = {
      length: { max: 3 },
      slug_title_field: { title_field_id: 'title-field' },
    };
    const owner = {
      ...itemType(OWNER_MODEL, false, [
        field('title', 'string', {}, true),
        field('slug', 'slug', validators, true),
      ]),
      draftSavingActive: false,
    };
    const versions = {
      current: {
        title: { en: 'Current', it: 'Attuale' },
        slug: { en: 'current-slug', it: 'slug-attuale' },
      },
      published: {
        title: { en: 'Published', it: 'Pubblicato' },
        slug: { en: 'published-slug', it: 'slug-pubblicato' },
      },
      currentValid: false,
      publishedValid: false,
    };
    const source = snapshot('source', [owner], [], versions);
    const target = snapshot('target', [owner], []);
    const before = stableStringify({ source, target });
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: (['current', 'published'] as const).map(
        (slice) => ({
          recordId: RECORD_ID,
          slice,
          versionHash: source.records[RECORD_ID][slice]!.hash,
          valid: false,
          issues: [
            { code: 'VALIDATION_LENGTH', fieldId: 'slug-field', details: {} },
          ],
        }),
      ),
    });

    expect(plan.records.map(({ action }) => action)).to.deep.equal(['create']);
    expect(plan.records[0].desired?.current.fields).to.deep.equal(
      versions.current,
    );
    expect(plan.records[0].desired?.published?.fields).to.deep.equal(
      versions.published,
    );
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.have.length(1);
    expect(plan.invalidContent.validatorRelaxations[0]).to.include({
      itemTypeId: OWNER_MODEL,
      fieldId: 'slug-field',
    });
    expect(
      plan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['length']);
    expect(
      plan.invalidContent.validatorRelaxations[0].relaxedValidators,
    ).to.deep.equal({
      slug_title_field: { title_field_id: 'title-field' },
    });
    expect(
      plan.invalidContent.validatorRelaxations[0].originalValidators,
    ).to.deep.equal(validators);
    expect(
      plan.schema.itemTypes[0].fields.find(({ apiKey }) => apiKey === 'slug')
        ?.validators,
    ).to.deep.equal(validators);
    expect(stableStringify({ source, target })).to.equal(before);
  });
});

function snapshot(
  environmentId: string,
  managedTypes: ItemTypeSchemaSnapshot[],
  inspectionTypes: ItemTypeSchemaSnapshot[],
  versions?: {
    current: JsonObject;
    published: JsonObject;
    currentValid: boolean;
    publishedValid: boolean;
  },
): ContentSnapshot {
  const managed = schema(environmentId, managedTypes);
  const full = schema(environmentId, [...managedTypes, ...inspectionTypes]);
  const owner = managedTypes.find(({ id }) => id === OWNER_MODEL)!;
  const encountered = new Set<string>();
  const issues: StructuralContentIssue[] = [];
  const raw = versions && {
    current: rawRecord(
      versions.current,
      versions.currentValid,
      versions.publishedValid,
    ),
    published: rawRecord(
      versions.published,
      versions.publishedValid,
      versions.publishedValid,
    ),
  };
  if (raw) {
    for (const slice of ['current', 'published'] as const) {
      const result = inspectRecordStructuralContent(
        raw[slice],
        owner,
        full,
        RECORD_ID,
        slice,
      );
      for (const id of result.encounteredItemTypeIds) encountered.add(id);
      issues.push(...result.issues);
    }
  }
  const inspection = buildContentInspectionSnapshot(
    full,
    managed,
    encountered,
    issues,
  );
  const traversal = contentTraversalSchema({ schema: managed, inspection });
  const records: ContentSnapshot['records'] = raw
    ? {
        [RECORD_ID]: canonicalizeRecord(
          raw.current,
          raw.published,
          owner,
          traversal,
          {
            publication: null,
            unpublishing: null,
          },
        ),
      }
    : {};
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
    blockOwnership: buildBlockOwnershipIndex(records, traversal),
    digest: semanticHash({
      records: Object.values(records).map(({ hash }) => hash),
      inspection,
    }),
  };
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
  modularBlock: boolean,
  fields: FieldSchemaSnapshot[],
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey: modularBlock
      ? `block_${id.replace(/[^a-z]/gi, '').toLowerCase()}`
      : 'article',
    name: id,
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

function field(
  apiKey: string,
  fieldType: FieldSchemaSnapshot['fieldType'],
  validators: JsonObject,
  localized = false,
): FieldSchemaSnapshot {
  return {
    id: `${apiKey}-field`,
    apiKey,
    fieldType,
    validators,
    localized,
    position: 1,
    defaultValue: null,
  };
}

function structuredTextValidators(fieldType: string): JsonObject {
  return fieldType === 'structured_text'
    ? {
        structured_text_blocks: { item_types: [] },
        structured_text_links: { item_types: [] },
      }
    : {};
}

function block(
  id: string,
  itemTypeId: string,
  attributes: JsonObject,
): JsonObject {
  return {
    id,
    type: 'item',
    attributes,
    relationships: {
      item_type: { data: { id: itemTypeId, type: 'item_type' } },
    },
  };
}

function emptyDocument(): JsonObject {
  return { schema: 'dast', document: { type: 'root', children: [] } };
}

function documentWith(
  type: 'block' | 'inlineBlock',
  item: JsonObject,
): JsonObject {
  const node = { type, item };
  return {
    schema: 'dast',
    document: {
      type: 'root',
      children:
        type === 'inlineBlock'
          ? [{ type: 'paragraph', children: [node] }]
          : [node],
    },
  };
}

function rawRecord(
  attributes: JsonObject,
  valid: boolean,
  publishedValid: boolean,
): Record<string, unknown> {
  return {
    id: RECORD_ID,
    type: 'item',
    item_type: { id: OWNER_MODEL, type: 'item_type' },
    attributes,
    meta: {
      created_at: '2025-01-01T00:00:00.000Z',
      first_published_at: '2025-01-01T00:00:00.000Z',
      current_version: 'version-id',
      is_valid: valid,
      is_current_version_valid: valid,
      is_published_version_valid: publishedValid,
      updated_at: '2025-01-01T00:00:00.000Z',
      published_at: '2025-01-01T00:00:00.000Z',
      stage: null,
    },
  };
}
