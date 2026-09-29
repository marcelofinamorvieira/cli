import { expect } from 'chai';
import { diagnoseInvalidSourceContent } from '../../src/content-diff';
import { semanticHash } from '../../src/content-diff/canonicalize';
import { buildRecordValidationPayload } from '../../src/content-diff/shared/validation-payload';
import type {
  ContentSnapshot,
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  JsonValue,
  SchemaSnapshot,
} from '../../src/content-diff/types';
import {
  CONTENT_SNAPSHOT_FORMAT_VERSION,
  ContentDiffError,
} from '../../src/content-diff/types';

const PAGE_MODEL_ID = 'page-model-exact-id';
const CONTAINER_BLOCK_ID = 'container-block-exact-id';
const LEAF_BLOCK_ID = 'leaf-block-exact-id';
const DEEP_BLOCK_ID = 'deep-block-exact-id';

describe('content diff validation payloads', () => {
  it('preserves item-shaped Structured Text metadata while removing real block IDs', () => {
    const sidecar = rawBlock('metadata-id', DEEP_BLOCK_ID, {
      label: 'metadata',
    });
    const content = {
      schema: 'dast',
      sidecar,
      document: {
        type: 'root',
        sidecar,
        children: [{ type: 'inlineBlock', item: sidecar, sidecar }],
      },
    };
    expect(
      buildRecordValidationPayload(
        { body: content },
        PAGE_MODEL_ID,
        makeSchema(),
      ),
    ).to.deep.equal({
      body: {
        ...content,
        document: {
          ...content.document,
          children: [
            {
              type: 'inlineBlock',
              item: validationBlock(DEEP_BLOCK_ID, { label: 'metadata' }),
              sidecar,
            },
          ],
        },
      },
    });
  });

  it('removes every recursive block ID while preserving content and exact model relationships', () => {
    const schema = makeSchema();

    const deepOne = rawBlock('deep-one-id', DEEP_BLOCK_ID, {
      label: 'deep one',
    });
    const expectedDeepOne = validationBlock(DEEP_BLOCK_ID, {
      label: 'deep one',
    });
    const deepTwo = rawBlock('deep-two-id', DEEP_BLOCK_ID, {
      label: 'deep two',
    });
    const expectedDeepTwo = validationBlock(DEEP_BLOCK_ID, {
      label: 'deep two',
    });
    const deepThree = rawBlock('deep-three-id', DEEP_BLOCK_ID, {
      label: 'deep three',
    });
    const expectedDeepThree = validationBlock(DEEP_BLOCK_ID, {
      label: 'deep three',
    });
    const deepFour = rawBlock('deep-four-id', DEEP_BLOCK_ID, {
      label: 'deep four',
    });
    const expectedDeepFour = validationBlock(DEEP_BLOCK_ID, {
      label: 'deep four',
    });

    const localizedLeaf = rawBlock('localized-leaf-id', LEAF_BLOCK_ID, {
      child: { en: deepOne, it: null },
      label: 'localized leaf',
      related: 'record-from-leaf',
    });
    const expectedLocalizedLeaf = validationBlock(LEAF_BLOCK_ID, {
      child: { en: expectedDeepOne, it: null },
      label: 'localized leaf',
      related: 'record-from-leaf',
    });

    const inlineLeaf = rawBlock('inline-leaf-id', LEAF_BLOCK_ID, {
      child: { en: null, it: deepFour },
      label: 'inline leaf',
      related: 'record-from-inline-leaf',
    });
    const expectedInlineLeaf = validationBlock(LEAF_BLOCK_ID, {
      child: { en: null, it: expectedDeepFour },
      label: 'inline leaf',
      related: 'record-from-inline-leaf',
    });

    const containerBody = dast([
      { item: deepThree, type: 'block' },
      {
        children: [
          { type: 'span', value: 'Container prose' },
          {
            children: [{ type: 'span', value: 'linked' }],
            item: 'record-item-link-in-container',
            type: 'itemLink',
          },
          { item: 'record-inline-item-in-container', type: 'inlineItem' },
          { item: inlineLeaf, type: 'inlineBlock' },
        ],
        type: 'paragraph',
      },
    ]);
    const expectedContainerBody = dast([
      { item: expectedDeepThree, type: 'block' },
      {
        children: [
          { type: 'span', value: 'Container prose' },
          {
            children: [{ type: 'span', value: 'linked' }],
            item: 'record-item-link-in-container',
            type: 'itemLink',
          },
          { item: 'record-inline-item-in-container', type: 'inlineItem' },
          { item: expectedInlineLeaf, type: 'inlineBlock' },
        ],
        type: 'paragraph',
      },
    ]);

    const container = rawBlock('container-id', CONTAINER_BLOCK_ID, {
      body: containerBody,
      child: deepTwo,
      future_block_attribute: { opaqueId: 'leave-this-id-alone' },
      label: 'container',
      localized_children: { en: [localizedLeaf], it: [] },
      related: 'record-from-container',
    });
    const expectedContainer = validationBlock(CONTAINER_BLOCK_ID, {
      body: expectedContainerBody,
      child: expectedDeepTwo,
      future_block_attribute: { opaqueId: 'leave-this-id-alone' },
      label: 'container',
      localized_children: { en: [expectedLocalizedLeaf], it: [] },
      related: 'record-from-container',
    });

    const flatHero = flatBlockWithItemType('flat-hero-id', LEAF_BLOCK_ID, {
      child: { en: null, it: null },
      label: 'flat hero',
      related: 'record-from-flat-hero',
    });
    const expectedFlatHero = validationBlock(LEAF_BLOCK_ID, {
      child: { en: null, it: null },
      label: 'flat hero',
      related: 'record-from-flat-hero',
    });

    const localizedHero = flatBlockWithItemTypeRelationship(
      'localized-hero-id',
      DEEP_BLOCK_ID,
      { label: 'localized hero' },
    );
    const expectedLocalizedHero = validationBlock(DEEP_BLOCK_ID, {
      label: 'localized hero',
    });

    const structuredLeaf = rawBlock('structured-leaf-id', LEAF_BLOCK_ID, {
      child: {
        en: rawBlock('structured-deep-id', DEEP_BLOCK_ID, {
          label: 'structured deep',
        }),
        it: null,
      },
      label: 'structured leaf',
      related: 'record-from-structured-leaf',
    });
    const expectedStructuredLeaf = validationBlock(LEAF_BLOCK_ID, {
      child: {
        en: validationBlock(DEEP_BLOCK_ID, { label: 'structured deep' }),
        it: null,
      },
      label: 'structured leaf',
      related: 'record-from-structured-leaf',
    });
    const structuredInline = rawBlock('structured-inline-id', DEEP_BLOCK_ID, {
      label: 'structured inline',
    });
    const expectedStructuredInline = validationBlock(DEEP_BLOCK_ID, {
      label: 'structured inline',
    });

    const body = dast([
      { item: structuredLeaf, type: 'block' },
      {
        children: [
          { type: 'span', value: 'Top-level prose' },
          {
            children: [{ type: 'span', value: 'record link text' }],
            item: 'record-item-link-at-top',
            type: 'itemLink',
          },
          { item: 'record-inline-item-at-top', type: 'inlineItem' },
          { item: structuredInline, type: 'inlineBlock' },
        ],
        type: 'paragraph',
      },
    ]);
    const expectedBody = dast([
      { item: expectedStructuredLeaf, type: 'block' },
      {
        children: [
          { type: 'span', value: 'Top-level prose' },
          {
            children: [{ type: 'span', value: 'record link text' }],
            item: 'record-item-link-at-top',
            type: 'itemLink',
          },
          { item: 'record-inline-item-at-top', type: 'inlineItem' },
          { item: expectedStructuredInline, type: 'inlineBlock' },
        ],
        type: 'paragraph',
      },
    ]);

    const fields: JsonObject = {
      body,
      future_top_level_attribute: {
        id: 'opaque-top-level-id',
        nested: { value: true },
      },
      hero: flatHero,
      localized_hero: { en: localizedHero, it: null },
      related: 'record-from-page',
      sections: { en: [container], it: [] },
      title: 'Scalar title',
    };

    const result = buildRecordValidationPayload(fields, PAGE_MODEL_ID, schema);

    expect(result).to.deep.equal({
      body: expectedBody,
      future_top_level_attribute: {
        id: 'opaque-top-level-id',
        nested: { value: true },
      },
      hero: expectedFlatHero,
      localized_hero: { en: expectedLocalizedHero, it: null },
      related: 'record-from-page',
      sections: { en: [expectedContainer], it: [] },
      title: 'Scalar title',
    });

    const blocks = collectValidationBlocks(result);
    expect(blocks).to.have.length(12);
    expect(
      blocks.every(
        (block) => !Object.prototype.hasOwnProperty.call(block, 'id'),
      ),
    ).to.equal(true);
    expect(
      blocks.map(
        (block) =>
          ((block.relationships as JsonObject).item_type as JsonObject).data,
      ),
    ).to.have.deep.members([
      itemTypeRelationshipData(LEAF_BLOCK_ID),
      itemTypeRelationshipData(DEEP_BLOCK_ID),
      itemTypeRelationshipData(DEEP_BLOCK_ID),
      itemTypeRelationshipData(CONTAINER_BLOCK_ID),
      itemTypeRelationshipData(DEEP_BLOCK_ID),
      itemTypeRelationshipData(LEAF_BLOCK_ID),
      itemTypeRelationshipData(DEEP_BLOCK_ID),
      itemTypeRelationshipData(LEAF_BLOCK_ID),
      itemTypeRelationshipData(DEEP_BLOCK_ID),
      itemTypeRelationshipData(DEEP_BLOCK_ID),
      itemTypeRelationshipData(LEAF_BLOCK_ID),
      itemTypeRelationshipData(DEEP_BLOCK_ID),
    ]);
  });

  it('fails closed when embedded content refers to an unknown model', () => {
    const error = captureContentDiffError(() =>
      buildRecordValidationPayload(
        {
          hero: rawBlock('unknown-block-id', 'unknown-block-model', {
            label: 'unknown',
          }),
        },
        PAGE_MODEL_ID,
        makeSchema(),
      ),
    );

    expect(error.code).to.equal('UNSUPPORTED_CONTENT_STATE');
    expect(error.message).to.contain('unknown model unknown-block-model');
    expect(error.details).to.deep.equal({
      itemTypeId: 'unknown-block-model',
    });
  });

  it('fails closed when embedded content refers to a known non-block model', () => {
    const error = captureContentDiffError(() =>
      buildRecordValidationPayload(
        {
          hero: rawBlock('non-block-id', PAGE_MODEL_ID, {
            title: 'not a block',
          }),
        },
        PAGE_MODEL_ID,
        makeSchema(),
      ),
    );

    expect(error.code).to.equal('UNSUPPORTED_CONTENT_STATE');
    expect(error.message).to.contain(`non-block model ${PAGE_MODEL_ID}`);
    expect(error.details).to.deep.equal({ itemTypeId: PAGE_MODEL_ID });
  });

  it('sends converted ID-free bodies for current, published, and intermediate diagnostics', async () => {
    const schema = makeSchema();
    const currentFields = diagnosticFields('current', 'current-block-id');
    const publishedFields = diagnosticFields('published', 'published-block-id');
    const intermediateFields = diagnosticFields(
      'intermediate',
      'intermediate-block-id',
    );
    const source = makeInvalidSnapshot(schema, currentFields, publishedFields);
    const calls: Array<{ body: JsonObject; id: string }> = [];
    const client = {
      items: {
        validateExisting: async (id: string, body: JsonObject) => {
          calls.push({ body, id });
        },
      },
    } as Parameters<typeof diagnoseInvalidSourceContent>[0];

    const diagnostics = await diagnoseInvalidSourceContent(client, source, [
      {
        fields: intermediateFields,
        recordId: 'record-id',
        versionHash: 'intermediate-hash',
      },
    ]);

    expect(calls).to.deep.equal([
      {
        body: expectedDiagnosticFields('current'),
        id: 'record-id',
      },
      {
        body: expectedDiagnosticFields('published'),
        id: 'record-id',
      },
      {
        body: expectedDiagnosticFields('intermediate'),
        id: 'record-id',
      },
    ]);
    expect(diagnostics).to.deep.equal([
      {
        issues: [],
        recordId: 'record-id',
        slice: 'current',
        valid: true,
        versionHash: 'current-hash',
      },
      {
        issues: [],
        recordId: 'record-id',
        slice: 'published',
        valid: true,
        versionHash: 'published-hash',
      },
      {
        issues: [],
        recordId: 'record-id',
        slice: 'intermediate',
        valid: true,
        versionHash: 'intermediate-hash',
      },
    ]);
  });
});

function makeSchema(): SchemaSnapshot {
  return {
    digest: 'schema-digest',
    environmentId: 'source',
    environmentSemantics: {
      improvedBooleanFields: true,
      improvedHexManagement: true,
      improvedTimezoneManagement: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      timezone: 'UTC',
    },
    itemTypes: [
      itemType(PAGE_MODEL_ID, false, [
        field('page-title', 'title', 'string', false, 1),
        field('page-related', 'related', 'link', false, 2),
        field('page-sections', 'sections', 'rich_text', true, 3),
        field('page-hero', 'hero', 'single_block', false, 4),
        field('page-localized-hero', 'localized_hero', 'single_block', true, 5),
        field('page-body', 'body', 'structured_text', false, 6),
      ]),
      itemType(CONTAINER_BLOCK_ID, true, [
        field('container-label', 'label', 'string', false, 1),
        field('container-related', 'related', 'link', false, 2),
        field(
          'container-localized-children',
          'localized_children',
          'rich_text',
          true,
          3,
        ),
        field('container-child', 'child', 'single_block', false, 4),
        field('container-body', 'body', 'structured_text', false, 5),
      ]),
      itemType(LEAF_BLOCK_ID, true, [
        field('leaf-label', 'label', 'string', false, 1),
        field('leaf-related', 'related', 'link', false, 2),
        field('leaf-child', 'child', 'single_block', true, 3),
      ]),
      itemType(DEEP_BLOCK_ID, true, [
        field('deep-label', 'label', 'string', false, 1),
      ]),
    ],
    locales: ['en', 'it'],
    siteId: 'site-id',
    workflows: [],
  };
}

function itemType(
  id: string,
  modularBlock: boolean,
  fields: FieldSchemaSnapshot[],
): ItemTypeSchemaSnapshot {
  return {
    allLocalesRequired: false,
    apiKey: id,
    draftModeActive: !modularBlock,
    draftSavingActive: false,
    fields,
    id,
    modularBlock,
    name: id,
    singleton: false,
    sortable: false,
    tree: false,
    workflowId: null,
  };
}

function field(
  id: string,
  apiKey: string,
  fieldType: FieldSchemaSnapshot['fieldType'],
  localized: boolean,
  position: number,
): FieldSchemaSnapshot {
  return {
    apiKey,
    fieldType,
    id,
    localized,
    position,
    validators: {},
  };
}

function rawBlock(
  id: string,
  itemTypeId: string,
  attributes: JsonObject,
): JsonObject {
  return {
    attributes,
    id,
    meta: { current_version: `version-${id}` },
    relationships: {
      item_type: { data: itemTypeRelationshipData(itemTypeId) },
    },
    type: 'item',
  };
}

function flatBlockWithItemType(
  id: string,
  itemTypeId: string,
  attributes: JsonObject,
): JsonObject {
  return {
    ...attributes,
    __itemTypeId: itemTypeId,
    creator: 'creator-id',
    id,
    meta: { current_version: `version-${id}` },
    type: 'item',
  };
}

function flatBlockWithItemTypeRelationship(
  id: string,
  itemTypeId: string,
  attributes: JsonObject,
): JsonObject {
  return {
    ...attributes,
    id,
    item_type: itemTypeRelationshipData(itemTypeId),
    meta: { current_version: `version-${id}` },
    type: 'item',
  };
}

function validationBlock(
  itemTypeId: string,
  attributes: JsonObject,
): JsonObject {
  return {
    attributes,
    relationships: {
      item_type: { data: itemTypeRelationshipData(itemTypeId) },
    },
    type: 'item',
  };
}

function itemTypeRelationshipData(itemTypeId: string): JsonObject {
  return { id: itemTypeId, type: 'item_type' };
}

function dast(children: JsonValue[]): JsonObject {
  return {
    document: { children, type: 'root' },
    schema: 'dast',
  };
}

function collectValidationBlocks(value: JsonValue): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(collectValidationBlocks);
  if (!isJsonObject(value)) return [];

  const nested = Object.values(value).flatMap(collectValidationBlocks);
  const relationship = isJsonObject(value.relationships)
    ? value.relationships.item_type
    : undefined;

  return value.type === 'item' && isJsonObject(relationship)
    ? [value, ...nested]
    : nested;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function captureContentDiffError(operation: () => void): ContentDiffError {
  try {
    operation();
  } catch (error) {
    expect(error).to.be.instanceOf(ContentDiffError);
    return error as ContentDiffError;
  }

  throw new Error('Expected content validation payload conversion to fail');
}

function diagnosticFields(marker: string, blockId: string): JsonObject {
  return {
    body: dast([
      {
        children: [
          {
            item: rawBlock(`${blockId}-inline`, DEEP_BLOCK_ID, {
              label: `${marker} inline`,
            }),
            type: 'inlineBlock',
          },
        ],
        type: 'paragraph',
      },
    ]),
    hero: rawBlock(blockId, LEAF_BLOCK_ID, {
      child: {
        en: rawBlock(`${blockId}-child`, DEEP_BLOCK_ID, {
          label: `${marker} child`,
        }),
        it: null,
      },
      label: `${marker} hero`,
      related: `record-${marker}`,
    }),
    marker,
  };
}

function expectedDiagnosticFields(marker: string): JsonObject {
  return {
    body: dast([
      {
        children: [
          {
            item: validationBlock(DEEP_BLOCK_ID, {
              label: `${marker} inline`,
            }),
            type: 'inlineBlock',
          },
        ],
        type: 'paragraph',
      },
    ]),
    hero: validationBlock(LEAF_BLOCK_ID, {
      child: {
        en: validationBlock(DEEP_BLOCK_ID, {
          label: `${marker} child`,
        }),
        it: null,
      },
      label: `${marker} hero`,
      related: `record-${marker}`,
    }),
    marker,
  };
}

function makeInvalidSnapshot(
  schema: SchemaSnapshot,
  currentFields: JsonObject,
  publishedFields: JsonObject,
): ContentSnapshot {
  return {
    blockOwnership: {},
    capturedAt: '2026-08-20T00:00:00.000Z',
    digest: 'snapshot-digest',
    environmentId: schema.environmentId,
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    readItemTypes: [{ id: PAGE_MODEL_ID, workflowId: null }],
    records: {
      'record-id': {
        consistency: {
          currentValid: false,
          currentVersion: 'current-version',
          publishedAt: '2026-08-19T00:00:00.000Z',
          publishedValid: false,
          updatedAt: '2026-08-20T00:00:00.000Z',
        },
        current: { fields: currentFields, hash: 'current-hash' },
        hash: 'record-hash',
        id: 'record-id',
        itemTypeId: PAGE_MODEL_ID,
        lifecycle: {
          createdAt: '2026-08-18T00:00:00.000Z',
          firstPublishedAt: '2026-08-19T00:00:00.000Z',
        },
        published: { fields: publishedFields, hash: 'published-hash' },
        schedules: { publication: null, unpublishing: null },
        stage: null,
        topology: { parentId: null, position: null },
        validity: { current: false, published: false },
      },
    },
    inspection: {
      itemTypes: [],
      digest: semanticHash({ itemTypes: [] }),
      structuralIssues: [],
    },
    schema,
    scope: { itemTypeIds: [PAGE_MODEL_ID], uploads: 'referenced' },
    siteId: schema.siteId,
    uploadCollections: {},
    uploads: {},
    visibleRecordIds: ['record-id'],
  };
}
