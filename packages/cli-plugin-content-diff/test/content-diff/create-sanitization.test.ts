import { expect } from 'chai';
import { semanticHash } from '../../src/content-diff/canonicalize';
import {
  type SanitizedHtmlWriteExecution,
  findSanitizedHtmlWriteRisks,
  isProvablyCmaSanitizerByteStableText,
} from '../../src/content-diff/shared/create-sanitization';
import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  RecordPlan,
  RecordSnapshot,
  SchemaSnapshot,
} from '../../src/content-diff/types';

const MODEL_ID = 'SanitizeModel12345678';
const BLOCK_MODEL_ID = 'SanitizeBlock12345678';
const RECORD_ID = 'SanitizeRecord1234567';
const BLOCK_ID = 'SanitizeNested12345678';

describe('CMA sanitized_html write-byte stability', () => {
  it('accepts only the parser-free subset whose bytes are provably stable', () => {
    expect(isProvablyCmaSanitizerByteStableText(undefined)).to.equal(true);
    expect(isProvablyCmaSanitizerByteStableText(null)).to.equal(true);
    expect(isProvablyCmaSanitizerByteStableText('')).to.equal(true);
    expect(
      isProvablyCmaSanitizerByteStableText('Plain text, line two\n'),
    ).to.equal(true);

    // Canonical/unsafe HTML, parser control characters, Nokogiri's NBSP
    // entity serialization, and sanitize 6.0.2 unsuitable Unicode code points
    // can all change before the CMA persists a CREATE/UPDATE.
    for (const value of [
      // Even known-canonical markup stays outside the deliberately parser-free
      // proof subset; the runtime does not embed a second HTML5 serializer.
      '<p>This <br> text</p>',
      '<p>This <br /> text</p>',
      '<p>&copy; &rsquo;</p>',
      '<script>alert(1)</script><p>x</p>',
      'C1:\u0085',
      'raw NBSP:\u00a0',
      'BMP noncharacter:\ufdd0',
      `supplementary noncharacter:${String.fromCodePoint(0x1fffe)}`,
    ]) {
      expect(isProvablyCmaSanitizerByteStableText(value), value).to.equal(
        false,
      );
    }
  });

  it('finds exact top-level, localized-null, and recursively nested CREATE paths', () => {
    const fields = {
      body: '<p>This <br> text</p>',
      localized_body: { en: null, it: '<p>&copy; &rsquo;</p>' },
      feature: nestedBlock({
        nested_body: '<script>alert(1)</script><p>x</p>',
      }),
      inactive_body: '<p>This stays outside the active sanitizer</p>',
      marker: 'create',
      slug: 'create',
    } satisfies JsonObject;
    const risks = findRisks(
      [createPlan(RECORD_ID, fields)],
      makeSchema(),
      new Map([[RECORD_ID, fields]]),
      { createOrder: [RECORD_ID] },
    );

    expect(risks).to.deep.equal([
      risk('body-field', 'create', `record:${RECORD_ID}.body`),
      risk(
        'localized-body-field',
        'create',
        `record:${RECORD_ID}.localized_body.en`,
        'en',
      ),
      risk(
        'localized-body-field',
        'create',
        `record:${RECORD_ID}.localized_body.it`,
        'it',
      ),
      risk(
        'nested-body-field',
        'create',
        `record:${RECORD_ID}.feature.block:${BLOCK_ID}.nested_body`,
        null,
        BLOCK_MODEL_ID,
      ),
    ]);
    expect(JSON.stringify(risks)).not.to.contain('<p>');
    expect(JSON.stringify(risks)).not.to.contain('alert(1)');
  });

  it('preserves the parent locale in a localized embedded-block path', () => {
    const schema = makeSchema();
    schema.itemTypes
      .find(({ id }) => id === MODEL_ID)!
      .fields.find(({ apiKey }) => apiKey === 'feature')!.localized = true;
    const fields = completeFields({
      feature: {
        en: nestedBlock({ nested_body: '<p>&copy;</p>' }),
        it: null,
      },
    });
    expect(
      findRisks(
        [createPlan(RECORD_ID, fields)],
        schema,
        new Map([[RECORD_ID, fields]]),
        { createOrder: [RECORD_ID] },
      ),
    ).to.deep.equal([
      risk(
        'nested-body-field',
        'create',
        `record:${RECORD_ID}.feature.en.block:${BLOCK_ID}.nested_body`,
        null,
        BLOCK_MODEL_ID,
      ),
    ]);
  });

  it('walks only real Structured Text children and ignores metadata decoys', () => {
    const decoyId = 'SanitizeDecoy123456789';
    const fields = completeFields({
      structured: {
        schema: 'dast',
        document: {
          type: 'root',
          metadata: {
            decoy: nestedBlock({ nested_body: '<p>Decoy &copy;</p>' }, decoyId),
          },
          children: [
            {
              type: 'block',
              item: nestedBlock({ nested_body: '<p>Real &copy;</p>' }),
            },
          ],
        },
      },
    });
    expect(
      findRisks(
        [createPlan(RECORD_ID, fields)],
        makeSchema(),
        new Map([[RECORD_ID, fields]]),
        { createOrder: [RECORD_ID] },
      ).map(({ path }) => path),
    ).to.deep.equal([
      `record:${RECORD_ID}.structured.document.children[0].item.block:${BLOCK_ID}.nested_body`,
    ]);
  });

  it('does not parse item-shaped metadata when projecting a field update', () => {
    const baseline = completeFields();
    const desired = completeFields({
      structured: {
        schema: 'dast',
        document: {
          type: 'root',
          metadata: { type: 'item', id: 'metadata-without-model' },
          children: [],
        },
      },
    });
    expect(
      findRisks(
        [updatePlan(RECORD_ID, baseline, desired)],
        makeSchema(),
        new Map(),
        { updateOrder: [RECORD_ID] },
      ),
    ).to.deep.equal([]);
  });

  it('checks complete rehydrated current after an unrelated phase-8 patch', () => {
    const baselineFields = completeFields({
      body: '<p>Historical <br /> body</p>',
      localized_body: { en: null, it: 'Testo semplice' },
      marker: 'before',
    });
    // Desired intentionally omits both sanitizer fields. Full Rehydrate
    // reverse-merges them from persisted current before sanitization.
    const plan = updatePlan(RECORD_ID, baselineFields, { marker: 'after' });
    expect(
      findRisks([plan], makeSchema(), new Map(), {
        updateOrder: [RECORD_ID],
      }).map(({ fieldId, stage, path }) => ({ fieldId, stage, path })),
    ).to.deep.equal([
      {
        fieldId: 'body-field',
        stage: 'current-restore',
        path: `record:${RECORD_ID}.body`,
      },
      {
        fieldId: 'localized-body-field',
        stage: 'current-restore',
        path: `record:${RECORD_ID}.localized_body.en`,
      },
    ]);
  });

  it('finds a rehydrated inspection-block risk during phase-7 staging', () => {
    const nested = nestedBlock({
      nested_body: '<p>Historical &copy; block</p>',
    });
    const baselineFields = completeFields({
      feature: nested,
      marker: 'before',
    });
    const desiredCurrent = completeFields({
      feature: nested,
      marker: 'published',
    });
    const plan = updatePlan(RECORD_ID, baselineFields, desiredCurrent, {
      baselinePublished: baselineFields,
      desiredPublished: { marker: 'published' },
    });

    expect(
      findRisks([plan], makeSchema(), new Map(), {
        publishOrder: [RECORD_ID],
        updateOrder: [RECORD_ID],
      }).map(({ itemTypeId, stage, path }) => ({
        itemTypeId,
        stage,
        path,
      })),
    ).to.deep.equal([
      {
        itemTypeId: BLOCK_MODEL_ID,
        stage: 'published-stage',
        path: `record:${RECORD_ID}.feature.block:${BLOCK_ID}.nested_body`,
      },
    ]);
  });

  it('does not report phase-7 risks when publication needs no attribute patch', () => {
    const noncanonical = completeFields({
      body: '<p>Historical <br /> body</p>',
      marker: 'current',
    });
    const alreadyPublished = completeFields({ marker: 'published' });
    const publishedAlreadyDesired = updatePlan(
      RECORD_ID,
      noncanonical,
      noncanonical,
      {
        baselinePublished: alreadyPublished,
        desiredPublished: alreadyPublished,
      },
    );
    expect(
      findRisks([publishedAlreadyDesired], makeSchema(), new Map(), {
        publishOrder: [RECORD_ID],
      }),
    ).to.deep.equal([]);

    const oldPublished = completeFields({ marker: 'old published' });
    const currentAlreadyDesired = completeFields({
      body: '<p>Historical <br /> body</p>',
      marker: 'next published',
    });
    const publishOnly = updatePlan(
      RECORD_ID,
      currentAlreadyDesired,
      currentAlreadyDesired,
      {
        baselinePublished: oldPublished,
        desiredPublished: currentAlreadyDesired,
      },
    );
    expect(
      findRisks([publishOnly], makeSchema(), new Map(), {
        publishOrder: [RECORD_ID],
      }),
    ).to.deep.equal([]);
  });

  it('finds full-rehydrate risks during unique and delete releases', () => {
    const uniqueId = 'SanitizeUnique1234567';
    const deleteId = 'SanitizeDelete1234567';
    const unique = updatePlan(
      uniqueId,
      completeFields({ body: '<p>Unique owner <br /></p>', slug: 'taken' }),
      completeFields({ body: '<p>Unique owner <br /></p>', slug: 'taken' }),
    );
    const deleting = deletePlan(
      deleteId,
      completeFields({
        feature: nestedBlock({ nested_body: '<p>Delete &copy;</p>' }),
        marker: 'linked',
      }),
    );
    const risks = findRisks([unique, deleting], makeSchema(), new Map(), {
      uniqueReleases: [
        {
          recordId: uniqueId,
          fields: { slug: 'released' },
          consumerRecordIds: [],
          intermediateCurrentHash: 'unique-release-hash',
        },
      ],
      deleteReleases: [
        {
          recordId: deleteId,
          fields: { marker: 'released' },
          intermediateCurrentHash: 'delete-release-hash',
          publish: false,
          transientNestedBlockIds: [],
        },
      ],
      deleteOrder: [deleteId],
    });
    expect(
      risks.map(({ recordId, stage, fieldId }) => ({
        recordId,
        stage,
        fieldId,
      })),
    ).to.deep.equal([
      {
        recordId: deleteId,
        stage: 'delete-release',
        fieldId: 'nested-body-field',
      },
      {
        recordId: uniqueId,
        stage: 'unique-release',
        fieldId: 'body-field',
      },
      {
        recordId: uniqueId,
        stage: 'current-restore',
        fieldId: 'body-field',
      },
    ]);
  });

  it('models parent_id and position as field-rehydrating attributes', () => {
    const reparentId = 'SanitizeReparent12345';
    const reparentFields = completeFields({
      body: '<p>Reparent <br /></p>',
    });
    const reparent = updatePlan(reparentId, reparentFields, reparentFields, {
      baselineTopology: { parentId: null, position: 1 },
      desiredTopology: { parentId: 'ParentRecord123456789', position: 1 },
      topologyChanged: true,
    });
    expect(
      findRisks([reparent], makeSchema({ tree: true }), new Map()).map(
        ({ stage, fieldId }) => ({ stage, fieldId }),
      ),
    ).to.deep.equal([{ stage: 'tree-reparent', fieldId: 'body-field' }]);

    const positionId = 'SanitizePosition12345';
    const positionFields = completeFields({
      body: '<p>Position &copy;</p>',
    });
    const positioned = updatePlan(positionId, positionFields, positionFields, {
      baselineTopology: { parentId: null, position: 2 },
      desiredTopology: { parentId: null, position: 1 },
      topologyChanged: true,
    });
    expect(
      findRisks([positioned], makeSchema({ sortable: true }), new Map()).map(
        ({ stage, fieldId }) => ({ stage, fieldId }),
      ),
    ).to.deep.equal([{ stage: 'position-finalize', fieldId: 'body-field' }]);
  });

  it('finds a position write to a no-op sibling shifted by another record', () => {
    const movedId = 'SanitizeMoved123456789';
    const noopSiblingId = 'SanitizeNoop123456789';
    const movedFields = completeFields({ body: 'Plain moved record' });
    const siblingFields = completeFields({
      body: '<p>Historical no-op sibling &copy;</p>',
    });
    const moved = updatePlan(movedId, movedFields, movedFields, {
      baselineTopology: { parentId: null, position: 3 },
      desiredTopology: { parentId: null, position: 1 },
      topologyChanged: true,
    });
    const sibling = noopPlan(noopSiblingId, siblingFields, {
      parentId: null,
      position: 2,
    });

    expect(
      findRisks(
        [moved, sibling],
        makeSchema({ sortable: true }),
        new Map(),
      ).map(({ recordId, stage, fieldId }) => ({
        recordId,
        stage,
        fieldId,
      })),
    ).to.deep.equal([
      {
        recordId: noopSiblingId,
        stage: 'position-finalize',
        fieldId: 'body-field',
      },
    ]);
  });

  it('does not reject unchanged content with no attribute-bearing write', () => {
    const fields = completeFields({ body: '<p>Historical <br /></p>' });
    expect(
      findRisks([noopPlan(RECORD_ID, fields)], makeSchema(), new Map()),
    ).to.deep.equal([]);
  });

  it('uses the exact fully-relaxed phase schema', () => {
    const fields = completeFields({ body: '<p>Historical <br /></p>' });
    const plan = updatePlan(RECORD_ID, fields, { marker: 'after' });
    const sanitizerRemoved = makeSchema();
    sanitizerRemoved.itemTypes
      .find(({ id }) => id === MODEL_ID)!
      .fields.find(({ apiKey }) => apiKey === 'body')!.validators = {};
    expect(findRisks([plan], sanitizerRemoved, new Map())).to.deep.equal([]);

    const sanitizerRetained = makeSchema();
    expect(
      findRisks([plan], sanitizerRetained, new Map()).map(
        ({ fieldId }) => fieldId,
      ),
    ).to.deep.equal(['body-field']);
  });

  it('fails closed when a nested block model is absent', () => {
    const schema = makeSchema();
    schema.itemTypes = schema.itemTypes.filter(
      ({ id }) => id !== BLOCK_MODEL_ID,
    );
    const fields = completeFields({
      feature: nestedBlock({ nested_body: '<p>Unknown block</p>' }),
    });
    expect(() =>
      findRisks(
        [createPlan(RECORD_ID, fields)],
        schema,
        new Map([[RECORD_ID, fields]]),
        { createOrder: [RECORD_ID] },
      ),
    )
      .to.throw('absent from the captured traversal schema')
      .with.property('code', 'UNSUPPORTED_CONTENT_STATE');
  });
});

function risk(
  fieldId: string,
  stage: string,
  path: string,
  locale: string | null = null,
  itemTypeId = MODEL_ID,
) {
  return { recordId: RECORD_ID, itemTypeId, fieldId, stage, path, locale };
}

function findRisks(
  records: readonly RecordPlan[],
  schema: SchemaSnapshot,
  projectedCreates: ReadonlyMap<string, JsonObject>,
  overrides: Partial<SanitizedHtmlWriteExecution> = {},
) {
  return findSanitizedHtmlWriteRisks(
    records,
    schema,
    projectedCreates,
    execution(overrides),
  );
}

function execution(
  overrides: Partial<SanitizedHtmlWriteExecution> = {},
): SanitizedHtmlWriteExecution {
  return {
    createOrder: [],
    uniqueReleases: [],
    deleteReleases: [],
    deleteOrder: [],
    publicationSeedOrder: [],
    publishOrder: [],
    updateOrder: [],
    absoluteRecordPositionsReproducible: true,
    ...overrides,
  };
}

function makeSchema(
  options: { tree?: boolean; sortable?: boolean } = {},
): SchemaSnapshot {
  const textField = (
    id: string,
    apiKey: string,
    position: number,
    localized: boolean,
    sanitizeBeforeValidation: boolean | undefined,
  ): FieldSchemaSnapshot => ({
    id,
    apiKey,
    fieldType: 'text',
    localized,
    position,
    defaultValue: null,
    validators:
      sanitizeBeforeValidation === undefined
        ? { sanitized_html: {} }
        : {
            sanitized_html: {
              sanitize_before_validation: sanitizeBeforeValidation,
            },
          },
  });
  const block: ItemTypeSchemaSnapshot = {
    id: BLOCK_MODEL_ID,
    apiKey: 'sanitize_block',
    name: 'Sanitize block',
    modularBlock: true,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: false,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [textField('nested-body-field', 'nested_body', 1, false, true)],
  };
  const model: ItemTypeSchemaSnapshot = {
    id: MODEL_ID,
    apiKey: 'sanitize_model',
    name: 'Sanitize model',
    modularBlock: false,
    singleton: false,
    sortable: options.sortable ?? false,
    tree: options.tree ?? false,
    draftModeActive: true,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [
      textField('body-field', 'body', 1, false, true),
      textField('localized-body-field', 'localized_body', 2, true, true),
      {
        id: 'feature-field',
        apiKey: 'feature',
        fieldType: 'single_block',
        localized: false,
        position: 3,
        defaultValue: null,
        validators: {
          single_block_blocks: { item_types: [BLOCK_MODEL_ID] },
        },
      },
      textField('inactive-body-field', 'inactive_body', 4, false, false),
      stringField('marker-field', 'marker', 5),
      {
        ...stringField('slug-field', 'slug', 6),
        fieldType: 'slug',
        validators: { unique: {} },
      },
      {
        id: 'structured-field',
        apiKey: 'structured',
        fieldType: 'structured_text',
        localized: false,
        position: 7,
        defaultValue: null,
        validators: {
          structured_text_blocks: { item_types: [BLOCK_MODEL_ID] },
        },
      },
    ],
  };
  return {
    siteId: 'site',
    environmentId: 'source',
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
    itemTypes: [block, model],
    workflows: [],
    digest: 'schema-digest',
  };
}

function stringField(
  id: string,
  apiKey: string,
  position: number,
): FieldSchemaSnapshot {
  return {
    id,
    apiKey,
    fieldType: 'string',
    localized: false,
    position,
    defaultValue: null,
    validators: {},
  };
}

function completeFields(overrides: JsonObject = {}): JsonObject {
  return {
    body: 'Plain body',
    localized_body: { en: 'Plain', it: 'Testo' },
    feature: null,
    inactive_body: '',
    marker: 'stable',
    slug: 'stable',
    ...overrides,
  };
}

function nestedBlock(attributes: JsonObject, id = BLOCK_ID): JsonObject {
  return {
    id,
    type: 'item',
    attributes,
    relationships: {
      item_type: { data: { id: BLOCK_MODEL_ID, type: 'item_type' } },
    },
  };
}

function createPlan(id: string, fields: JsonObject): RecordPlan {
  return recordPlan(id, 'create', null, snapshot(id, fields));
}

function updatePlan(
  id: string,
  baselineFields: JsonObject,
  desiredFields: JsonObject,
  options: {
    baselinePublished?: JsonObject | null;
    desiredPublished?: JsonObject | null;
    baselineTopology?: RecordSnapshot['topology'];
    desiredTopology?: RecordSnapshot['topology'];
    topologyChanged?: boolean;
  } = {},
): RecordPlan {
  return recordPlan(
    id,
    'update',
    snapshot(
      id,
      baselineFields,
      options.baselinePublished ?? null,
      options.baselineTopology,
    ),
    snapshot(
      id,
      desiredFields,
      options.desiredPublished ?? null,
      options.desiredTopology,
    ),
    options.topologyChanged ?? false,
  );
}

function noopPlan(
  id: string,
  fields: JsonObject,
  topology?: RecordSnapshot['topology'],
): RecordPlan {
  const state = snapshot(id, fields, null, topology);
  return recordPlan(id, 'noop', state, state);
}

function deletePlan(id: string, fields: JsonObject): RecordPlan {
  return recordPlan(id, 'delete', snapshot(id, fields), null);
}

function recordPlan(
  id: string,
  action: RecordPlan['action'],
  baseline: RecordSnapshot | null,
  desired: RecordSnapshot | null,
  topologyChanged = false,
): RecordPlan {
  return {
    id,
    itemTypeId: MODEL_ID,
    action,
    expectedTargetHash: baseline?.hash ?? null,
    baseline,
    desired,
    changes: {
      current: action === 'create' || action === 'update',
      published: baseline?.published?.hash !== desired?.published?.hash,
      topology: topologyChanged,
      lifecycle: false,
      stage: false,
      schedules: false,
    },
    dependencies: [],
    publishedDependencies: [],
    allowedIntermediateHashes: [],
  };
}

function snapshot(
  id: string,
  fields: JsonObject,
  publishedFields: JsonObject | null = null,
  topology: RecordSnapshot['topology'] = { parentId: null, position: null },
): RecordSnapshot {
  const current = { fields, hash: semanticHash(fields) };
  const published = publishedFields
    ? { fields: publishedFields, hash: semanticHash(publishedFields) }
    : null;
  const state = {
    id,
    itemTypeId: MODEL_ID,
    current,
    published,
    topology,
    lifecycle: { createdAt: '2026-01-01T00:00:00Z', firstPublishedAt: null },
    validity: { current: true, published: published ? true : null },
    stage: null,
    schedules: { publication: null, unpublishing: null },
  };
  return {
    ...state,
    hash: semanticHash(state),
    consistency: {
      currentVersion: 'version-1',
      updatedAt: '2026-01-01T00:00:00Z',
      publishedAt: published ? '2026-01-01T00:00:00Z' : null,
      currentValid: true,
      publishedValid: published ? true : null,
    },
  };
}
