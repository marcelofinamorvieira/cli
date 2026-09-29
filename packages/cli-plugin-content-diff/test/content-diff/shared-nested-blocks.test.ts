import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  buildBlockOwnershipIndex,
  collectNestedBlocksFromFields,
  collectRecordReferences,
  collectRequiredDeletionCycleReleaseCandidates,
} from '../../src/content-diff/dependencies';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import { applyLegacyIdMappingsToSnapshot } from '../../src/content-diff/legacy-ids';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import { mapFieldBlocks } from '../../src/content-diff/shared/embedded-blocks';
import {
  collectNestedBlockIds,
  itemTypesById,
  nestedBlockFields,
  nestedBlockIdentity,
  visitNestedBlocksInFields,
} from '../../src/content-diff/shared/nested-blocks';
import { buildRecordValidationPayload } from '../../src/content-diff/shared/validation-payload';
import * as structuralContent from '../../src/content-diff/structural-content';
import {
  ContentDiffError,
  type ContentSnapshot,
  type FieldSchemaSnapshot,
  type ItemTypeSchemaSnapshot,
  type JsonObject,
  type JsonValue,
  type LegacyIdMappingPlan,
  type RecordSnapshot,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

type RuntimeError = Error & { code: string; details: unknown };

interface RuntimeNestedBlocks {
  __nestedBlockIdentity(value: unknown, path: string): unknown;
  __nestedBlockFields(value: unknown, path: string): unknown;
  __itemTypesById(lookup: unknown): unknown;
  __mapFieldBlocks(
    value: unknown,
    field: unknown,
    mapper: (block: unknown) => unknown,
  ): unknown;
  __collectNestedBlocks(
    fields: unknown,
    output: Map<string, unknown>,
    itemType: unknown,
    lookup: unknown,
  ): void;
  __collectBlockOwnershipLocations(
    fields: unknown,
    itemType: unknown,
    context: unknown,
    topRecordId: string,
    output: Map<string, Set<string>>,
  ): void;
  __applyCreateDefaultsToFields(
    fields: unknown,
    itemType: unknown,
    schema: unknown,
  ): unknown;
  __buildRuntimeRecordValidationPayload(
    context: unknown,
    fields: unknown,
    itemTypeId: string,
  ): unknown;
  __buildVersionPatch(
    desiredFields: unknown,
    currentFields: unknown,
    liveRecord: unknown,
    itemType: unknown,
    schemaById: unknown,
  ): unknown;
}

const RECORD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const OWNER_MODEL = '4QI3BfBvQs-hcv_YEkk1wg';
const BLOCK_MODEL = 'LkT6QfLoRXmEO7nLt6x0uA';
const OTHER_BLOCK_MODEL = 'mzmy5RRCSwCzMvmKgvsHUA';
const BLOCK_ID = 'X4h0kJ7xQy2oO3UscO9V6Q';
const INNER_BLOCK_ID = 'LQQiCYCfSU6DTmCQ63-JRw';
const PEER_RECORD_ID = 'XSPMXvayT-yMUrVxP-YoSw';
const DAST_BLOCK_ID = 'w3a6zOGbS_Kj91LgAyXISA';
const JSON_DECOY_ID = 'dc2q6SS5SFWIR5SfPTDGGw';

function field(
  apiKey: string,
  fieldType: FieldSchemaSnapshot['fieldType'],
  localized = false,
): FieldSchemaSnapshot {
  return {
    id: `field-${apiKey}`,
    apiKey,
    fieldType,
    localized,
    position: 1,
    validators: {},
  };
}

function itemType(
  id: string,
  modularBlock: boolean,
  fields: FieldSchemaSnapshot[],
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey: `model_${id}`,
    name: id,
    modularBlock,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: false,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}

/** An owner with a Modular Content field whose blocks can nest again. */
function makeSchema(
  ownerFields: FieldSchemaSnapshot[] = [field('content', 'rich_text')],
): SchemaSnapshot {
  return {
    siteId: 'site',
    environmentId: 'main',
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
    itemTypes: [
      itemType(OWNER_MODEL, false, ownerFields),
      itemType(BLOCK_MODEL, true, [
        field('caption', 'string'),
        field('children', 'rich_text'),
      ]),
      itemType(OTHER_BLOCK_MODEL, true, [field('caption', 'string')]),
    ],
    workflows: [],
    digest: 'schema-digest',
  };
}

function block(
  id: string,
  attributes: JsonObject,
  modelId = BLOCK_MODEL,
): JsonObject {
  return {
    id,
    type: 'item',
    attributes,
    relationships: {
      item_type: { data: { id: modelId, type: 'item_type' } },
    },
  };
}

function record(fields: JsonObject, itemTypeId = OWNER_MODEL): RecordSnapshot {
  return {
    id: RECORD_ID,
    itemTypeId,
    current: { fields, hash: 'current-hash' },
    published: null,
    topology: { parentId: null, position: null },
    lifecycle: { createdAt: '2025-01-01T00:00:00Z', firstPublishedAt: null },
    stage: null,
    schedules: { publication: null, unpublishing: null },
  } as unknown as RecordSnapshot;
}

function snapshot(
  schema: SchemaSnapshot,
  records: RecordSnapshot[],
): ContentSnapshot {
  return {
    schema,
    records: Object.fromEntries(records.map((entry) => [entry.id, entry])),
    uploads: {},
    uploadCollections: {},
    visibleRecordIds: records.map(({ id }) => id),
    blockOwnership: {},
    inspection: { itemTypes: [], structuralIssues: [] },
    missingUploadReferences: {},
    digest: 'digest',
  } as unknown as ContentSnapshot;
}

function captureError(task: () => unknown): Error {
  try {
    task();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to throw.');
}

function expectPlannerFailure(
  task: () => unknown,
  code: string,
  message: string,
  details?: unknown,
): void {
  const error = captureError(task) as ContentDiffError;
  expect(error).to.be.instanceOf(ContentDiffError);
  expect(error.code).to.equal(code);
  expect(error.message).to.equal(message);
  if (details !== undefined) expect(error.details).to.deep.equal(details);
}

function expectRuntimeFailure(
  task: () => unknown,
  code: string,
  message: string,
  details?: unknown,
): void {
  const error = captureError(task) as RuntimeError;
  expect(error.name).to.equal('ContentDiffRuntimeError');
  expect(error.code).to.equal(code);
  expect(error.message).to.equal(message);
  if (details !== undefined) expect(error.details).to.deep.equal(details);
}

describe('shared nested-block structure', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimeNestedBlocks;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-shared-nested-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        'module.exports.__nestedBlockIdentity = nestedBlockIdentity;',
        'module.exports.__nestedBlockFields = nestedBlockFields;',
        'module.exports.__itemTypesById = itemTypesById;',
        'module.exports.__mapFieldBlocks = mapFieldBlocks;',
        'module.exports.__collectNestedBlocks = collectNestedBlocks;',
        'module.exports.__collectBlockOwnershipLocations = collectBlockOwnershipLocations;',
        'module.exports.__applyCreateDefaultsToFields = applyCreateDefaultsToFields;',
        'module.exports.__buildRuntimeRecordValidationPayload = buildRuntimeRecordValidationPayload;',
        'module.exports.__buildVersionPatch = buildVersionPatch;',
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimeNestedBlocks;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('is the nested-block code the generated runtime runs', () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include.members([
      'src/content-diff/shared/embedded-blocks.ts',
      'src/content-diff/shared/nested-blocks.ts',
    ]);
    expect(structuralContent.nestedBlockIdentity).to.equal(nestedBlockIdentity);
    expect(structuralContent.nestedBlockFields).to.equal(nestedBlockFields);
  });

  it('reports malformed identities with one message and each side keeping its code (D2)', () => {
    const path = 'content[0]';
    const cases: Array<{ value: unknown; message: string; details: unknown }> =
      [
        {
          value: {
            id: BLOCK_ID,
            type: 'block',
            item_type: { id: BLOCK_MODEL },
          },
          message: `Nested content at ${path} declares a block model identity without type="item".`,
          details: { path },
        },
        {
          value: { id: '', type: 'item', item_type: { id: BLOCK_MODEL } },
          message: `Nested content at ${path} has no non-empty block ID.`,
          details: { path },
        },
        {
          value: { id: BLOCK_ID, type: 'item', item_type: { id: '' } },
          message: `Nested content at ${path} has a malformed item_type identity.`,
          details: { path },
        },
        {
          value: {
            id: BLOCK_ID,
            type: 'item',
            relationships: { item_type: { data: null } },
          },
          message: `Nested content at ${path} has a malformed relationships.item_type.data identity.`,
          details: { path },
        },
        {
          value: { id: BLOCK_ID, type: 'item', __itemTypeId: 7 },
          message: `Nested content at ${path} has a malformed __itemTypeId identity.`,
          details: { path },
        },
        {
          value: { id: BLOCK_ID, type: 'item' },
          message: `Nested content at ${path} has no authoritative block model identity.`,
          details: { path },
        },
        {
          value: {
            ...block(BLOCK_ID, {}),
            item_type: { id: OTHER_BLOCK_MODEL, type: 'item_type' },
          },
          message: `Nested item ${BLOCK_ID} has conflicting block model identities at ${path}.`,
          details: {
            blockId: BLOCK_ID,
            path,
            representations: {
              'item_type.id': OTHER_BLOCK_MODEL,
              'relationships.item_type.data.id': BLOCK_MODEL,
            },
          },
        },
      ];
    for (const { value, message, details } of cases) {
      expectPlannerFailure(
        () => nestedBlockIdentity(value, path),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        details,
      );
      expectRuntimeFailure(
        () => runtime.__nestedBlockIdentity(value, path),
        'INVALID_CMA_RESPONSE',
        message,
        details,
      );
    }

    const identity = { id: BLOCK_ID, itemTypeId: BLOCK_MODEL };
    for (const value of [
      block(BLOCK_ID, {}),
      { id: BLOCK_ID, type: 'item', item_type: { id: BLOCK_MODEL } },
      { id: BLOCK_ID, type: 'item', __itemTypeId: BLOCK_MODEL },
    ]) {
      expect(nestedBlockIdentity(value, path)).to.deep.equal(identity);
      expect(runtime.__nestedBlockIdentity(value, path)).to.deep.equal(
        identity,
      );
    }
    for (const value of [
      null,
      [block(BLOCK_ID, {})],
      { type: 'block', item: BLOCK_ID },
      { item_type: { data: { id: BLOCK_MODEL } } },
    ]) {
      expect(nestedBlockIdentity(value, path)).to.equal(null);
      expect(runtime.__nestedBlockIdentity(value, path)).to.equal(null);
    }
  });

  it('reads nested block fields with seven reserved keys and rejects malformed attributes (D3, D7)', () => {
    const flat = {
      __itemTypeId: BLOCK_MODEL,
      creator: { id: 'user', type: 'user' },
      id: BLOCK_ID,
      item_type: { id: BLOCK_MODEL, type: 'item_type' },
      meta: { created_at: '2025-01-01T00:00:00Z' },
      relationships: {
        item_type: { data: { id: BLOCK_MODEL, type: 'item_type' } },
      },
      type: 'item',
      caption: 'flat caption',
    };
    for (const read of [
      nestedBlockFields,
      runtime.__nestedBlockFields.bind(runtime),
    ]) {
      expect(read(flat, 'content')).to.deep.equal({ caption: 'flat caption' });
      expect(
        read(block(BLOCK_ID, { caption: 'wrapped' }), 'content'),
      ).to.deep.equal({ caption: 'wrapped' });
    }

    for (const attributes of [null, [], 'caption']) {
      const malformed = { ...block(BLOCK_ID, {}), attributes };
      const message =
        'Nested content at content has malformed block attributes.';
      expectPlannerFailure(
        () => nestedBlockFields(malformed, 'content'),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        { path: 'content' },
      );
      expectRuntimeFailure(
        () => runtime.__nestedBlockFields(malformed, 'content'),
        'INVALID_CMA_RESPONSE',
        message,
        { path: 'content' },
      );
    }
  });

  it('rejects a block with malformed attributes in the block walkers, create defaults and validation payload (D3)', () => {
    const schema = makeSchema();
    const schemaById = new Map(
      schema.itemTypes.map((entry) => [entry.id, entry]),
    );
    const owner = schema.itemTypes[0];
    const fields = {
      content: [{ ...block(BLOCK_ID, {}), attributes: null }],
    };
    const context = { schemaById, captureSchemaById: schemaById };
    const walked = 'Nested content at content has malformed block attributes.';

    expectRuntimeFailure(
      () => runtime.__collectNestedBlocks(fields, new Map(), owner, schemaById),
      'INVALID_CMA_RESPONSE',
      walked,
    );
    expectRuntimeFailure(
      () =>
        runtime.__collectBlockOwnershipLocations(
          fields,
          owner,
          context,
          RECORD_ID,
          new Map(),
        ),
      'INVALID_CMA_RESPONSE',
      walked,
    );
    expectRuntimeFailure(
      () => runtime.__applyCreateDefaultsToFields(fields, owner, schema),
      'INVALID_CMA_RESPONSE',
      walked,
    );
    expectRuntimeFailure(
      () =>
        runtime.__buildRuntimeRecordValidationPayload(
          context,
          fields,
          OWNER_MODEL,
        ),
      'INVALID_CMA_RESPONSE',
      walked,
    );

    expectPlannerFailure(
      () => buildBlockOwnershipIndex({ [RECORD_ID]: record(fields) }, schema),
      'UNSUPPORTED_CONTENT_STATE',
      walked,
    );
    expectPlannerFailure(
      () => buildRecordValidationPayload(fields, OWNER_MODEL, schema),
      'UNSUPPORTED_CONTENT_STATE',
      walked,
    );
  });

  it('makes the planner walkers reject malformed identities instead of skipping them (D4)', () => {
    const schema = makeSchema();
    const conflicting = {
      ...block(BLOCK_ID, { caption: 'x' }),
      __itemTypeId: OTHER_BLOCK_MODEL,
    };
    const modelless = { id: BLOCK_ID, type: 'item', caption: 'x' };

    for (const value of [conflicting, modelless]) {
      const fields = { content: [value] };
      for (const task of [
        () => buildBlockOwnershipIndex({ [RECORD_ID]: record(fields) }, schema),
        () => collectNestedBlocksFromFields(fields, OWNER_MODEL, schema),
        () => collectRecordReferences(record(fields), schema),
        () => buildRecordValidationPayload(fields, OWNER_MODEL, schema),
      ]) {
        const error = captureError(task) as ContentDiffError;
        expect(error).to.be.instanceOf(ContentDiffError);
        expect(error.code).to.equal('UNSUPPORTED_CONTENT_STATE');
        expect(error.message).to.match(/^Nested (item|content) /);
      }
    }
  });

  it('requires a block model for every nested item on both sides (D5)', () => {
    const schema = makeSchema();
    const schemaById = new Map(
      schema.itemTypes.map((entry) => [entry.id, entry]),
    );
    const owner = schema.itemTypes[0];
    const fields = { content: [block(BLOCK_ID, {}, OWNER_MODEL)] };
    const message = `Nested block ${BLOCK_ID} refers to unknown block model ${OWNER_MODEL}.`;
    const details = {
      blockId: BLOCK_ID,
      itemTypeId: OWNER_MODEL,
      fieldPath: 'content',
    };

    expectPlannerFailure(
      () => buildBlockOwnershipIndex({ [RECORD_ID]: record(fields) }, schema),
      'INCOMPATIBLE_SCHEMA',
      message,
      details,
    );
    expectRuntimeFailure(
      () =>
        runtime.__collectBlockOwnershipLocations(
          fields,
          owner,
          { schemaById, captureSchemaById: schemaById },
          RECORD_ID,
          new Map(),
        ),
      'SCHEMA_MISMATCH',
      message,
      details,
    );
    expectPlannerFailure(
      () =>
        applyLegacyIdMappingsToSnapshot(snapshot(schema, [record(fields)]), {
          entries: [],
        } as unknown as LegacyIdMappingPlan),
      'INCOMPATIBLE_SCHEMA',
      message,
      details,
    );
  });

  it('reads only own fields, so a constructor field absent from the record stays absent (D6)', () => {
    const schema = makeSchema([
      field('title', 'string'),
      field('constructor', 'string'),
      field('content', 'rich_text'),
    ]);
    const fields = { title: 'Hello', content: [block(BLOCK_ID, {})] };
    const visited: string[] = [];
    visitNestedBlocksInFields(
      fields,
      schema.itemTypes[0],
      schema,
      (entry, blockType, location) => {
        visited.push(`${entry.id}:${blockType.id}:${location.fieldPath}`);
      },
    );
    expect(visited).to.deep.equal([`${BLOCK_ID}:${BLOCK_MODEL}:content`]);

    const mapped = applyLegacyIdMappingsToSnapshot(
      snapshot(schema, [record(fields)]),
      { entries: [] } as unknown as LegacyIdMappingPlan,
    );
    expect(mapped.records[RECORD_ID].current.fields).to.deep.equal(fields);
    expect(
      Object.prototype.hasOwnProperty.call(
        mapped.records[RECORD_ID].current.fields,
        'constructor',
      ),
    ).to.equal(false);
  });

  it('remaps legacy block IDs only through an unambiguous block model (D21)', () => {
    const schema = makeSchema();
    const ambiguous = {
      ...block(BLOCK_ID, { caption: 'x' }),
      item_type: { id: OTHER_BLOCK_MODEL, type: 'item_type' },
    };
    const error = captureError(() =>
      applyLegacyIdMappingsToSnapshot(
        snapshot(schema, [record({ content: [ambiguous] })]),
        {
          entries: [
            {
              entityType: 'block',
              sourceId: BLOCK_ID,
              targetId: INNER_BLOCK_ID,
            },
          ],
        } as unknown as LegacyIdMappingPlan,
      ),
    ) as ContentDiffError;
    expect(error).to.be.instanceOf(ContentDiffError);
    expect(error.code).to.equal('UNSUPPORTED_CONTENT_STATE');
    expect(error.message).to.equal(
      `Nested item ${BLOCK_ID} has conflicting block model identities at content.`,
    );
    expect(error.details).to.deep.include({
      blockId: BLOCK_ID,
      path: 'content',
    });
  });

  it('walks blocks and records ownership identically in the planner and the runtime', () => {
    const schema = makeSchema([
      field('content', 'rich_text', true),
      field('body', 'structured_text'),
      field('single', 'single_block'),
    ]);
    const schemaById = new Map(
      schema.itemTypes.map((entry) => [entry.id, entry]),
    );
    const inner = block(
      INNER_BLOCK_ID,
      { caption: 'inner' },
      OTHER_BLOCK_MODEL,
    );
    const fields: JsonObject = {
      content: {
        en: [block(BLOCK_ID, { caption: 'outer', children: [inner] })],
        it: [],
      },
      body: {
        schema: 'dast',
        document: {
          type: 'root',
          children: [
            { type: 'block', item: block('w3a6zOGbS_Kj91LgAyXISA', {}) },
            { type: 'paragraph', children: [{ type: 'span', value: 'x' }] },
          ],
          sidecar: { type: 'block', item: block('decoy', {}, 'unknown') },
        },
      },
      single: null,
    };

    const planner = collectNestedBlocksFromFields(fields, OWNER_MODEL, schema);
    const runtimeBlocks = new Map<string, unknown>();
    runtime.__collectNestedBlocks(
      fields,
      runtimeBlocks,
      schema.itemTypes[0],
      schemaById,
    );
    expect([...runtimeBlocks.keys()]).to.deep.equal([...planner.keys()]);
    expect([...planner.keys()]).to.deep.equal([
      BLOCK_ID,
      INNER_BLOCK_ID,
      'w3a6zOGbS_Kj91LgAyXISA',
    ]);

    const ownership = buildBlockOwnershipIndex(
      { [RECORD_ID]: record(fields) },
      schema,
    );
    const runtimeLocations = new Map<string, Set<string>>();
    runtime.__collectBlockOwnershipLocations(
      fields,
      schema.itemTypes[0],
      { schemaById, captureSchemaById: schemaById },
      RECORD_ID,
      runtimeLocations,
    );
    expect(
      Object.fromEntries(
        [...runtimeLocations].map(([id, locations]) => [id, [...locations]]),
      ),
    ).to.deep.equal(
      Object.fromEntries(
        Object.entries(ownership).map(([id, entries]) => [
          id,
          entries.map(
            (entry) =>
              `${entry.topRecordId}:${entry.itemTypeId}:${entry.fieldPath}:${
                entry.locale ?? ''
              }`,
          ),
        ]),
      ),
    );
    expect(ownership[INNER_BLOCK_ID][0].fieldPath).to.equal(
      `content.block:${BLOCK_ID}.children`,
    );
    expect(ownership[BLOCK_ID][0].locale).to.equal('en');
    // A nested block's own fields start a new locale scope.
    expect(ownership[INNER_BLOCK_ID][0].locale).to.equal(null);

    const localized = schema.itemTypes[0].fields[0];
    const seen: unknown[] = [];
    const runtimeSeen: unknown[] = [];
    expect(
      runtime.__mapFieldBlocks(fields.content, localized, (entry) => {
        runtimeSeen.push(entry);
        return 'mapped';
      }),
    ).to.deep.equal(
      mapFieldBlocks(fields.content as JsonValue, localized, (entry) => {
        seen.push(entry);
        return 'mapped';
      }),
    );
    expect(runtimeSeen).to.deep.equal(seen);
  });

  it('rekeys a published deletion release through the schema only (D50)', () => {
    const schema = makeSchema([
      { ...field('target', 'link'), validators: { required: {} } },
      field('content', 'rich_text'),
      field('body', 'structured_text'),
      field('meta', 'json'),
    ]);
    schema.itemTypes[0].draftModeActive = true;
    // Values shaped like blocks outside a block slot: a JSON field and DAST
    // metadata. Neither is a nested block, so neither may be rekeyed.
    const jsonDecoy = block(JSON_DECOY_ID, { caption: 'json' });
    const sidecar = { type: 'block', item: block('decoy', {}, 'unknown') };
    const published = (fields: JsonObject): RecordSnapshot =>
      ({
        ...record(fields),
        published: { fields, hash: 'published-hash' },
      }) as RecordSnapshot;
    const owner = published({
      target: PEER_RECORD_ID,
      content: [block(BLOCK_ID, { caption: 'outer', children: [] })],
      body: {
        schema: 'dast',
        sidecar,
        document: {
          type: 'root',
          sidecar,
          children: [{ type: 'block', item: block(DAST_BLOCK_ID, {}) }],
        },
      },
      meta: jsonDecoy,
    });
    const peer = {
      ...published({ target: RECORD_ID }),
      id: PEER_RECORD_ID,
    } as RecordSnapshot;

    const [candidate] = collectRequiredDeletionCycleReleaseCandidates(
      { [RECORD_ID]: owner, [PEER_RECORD_ID]: peer },
      schema,
    );
    const release = candidate.releases.find(
      ({ recordId }) => recordId === RECORD_ID,
    )!;
    expect(release.publish).to.equal(true);
    expect(release.fields.target).to.equal(null);
    expect(release.fields.meta).to.deep.equal(jsonDecoy);
    const body = release.fields.body as JsonObject;
    expect(body.sidecar).to.deep.equal(sidecar);
    expect((body.document as JsonObject).sidecar).to.deep.equal(sidecar);

    // Exactly the blocks the shared walker finds get fresh IDs, which is what
    // plan validation and the runtime compare transientNestedBlockIds with.
    const walked = new Set<string>();
    collectNestedBlockIds(release.fields, walked, schema.itemTypes[0], schema);
    expect(release.transientNestedBlockIds).to.have.length(2);
    expect([...walked].sort()).to.deep.equal(release.transientNestedBlockIds);
    for (const id of [BLOCK_ID, DAST_BLOCK_ID, JSON_DECOY_ID]) {
      expect(walked.has(id)).to.equal(false);
    }
    expect(
      candidate.releases.find(({ recordId }) => recordId === PEER_RECORD_ID)!
        .transientNestedBlockIds,
    ).to.deep.equal([]);
  });

  it('compacts a version patch only through a block model at execution (D52)', () => {
    const schema = makeSchema();
    const schemaById = new Map(
      schema.itemTypes.map((entry) => [entry.id, entry]),
    );
    const owner = schema.itemTypes[0];
    const live = { current: { fields: { content: [] } } };

    for (const modelId of [OWNER_MODEL, 'missing']) {
      expectRuntimeFailure(
        () =>
          runtime.__buildVersionPatch(
            { content: [block(BLOCK_ID, { caption: 'x' }, modelId)] },
            { content: [] },
            live,
            owner,
            schemaById,
          ),
        'SCHEMA_MISMATCH',
        `Nested block ${BLOCK_ID} refers to unknown block model ${modelId}.`,
        { blockId: BLOCK_ID, itemTypeId: modelId, fieldPath: 'content' },
      );
    }
    const valid = block(BLOCK_ID, { caption: 'x' });
    expect(
      runtime.__buildVersionPatch(
        { content: [valid] },
        { content: [] },
        live,
        owner,
        schemaById,
      ),
    ).to.deep.equal({ content: [valid] });
  });

  it('accepts a schema or a Map as item type lookup and rejects anything else', () => {
    const schema = makeSchema();
    const map = itemTypesById(schema);
    expect([...map.keys()]).to.deep.equal(schema.itemTypes.map(({ id }) => id));
    expect(itemTypesById(map)).to.equal(map);
    expect(runtime.__itemTypesById(map)).to.equal(map);

    for (const lookup of [schema.itemTypes, null, 'schema']) {
      const message =
        'An item type lookup must be a schema snapshot or a Map of item types.';
      expectPlannerFailure(
        () => itemTypesById(lookup as never),
        'UNSUPPORTED_CONTENT_STATE',
        message,
      );
      expectRuntimeFailure(
        () => runtime.__itemTypesById(lookup),
        'INVALID_PLAN',
        message,
      );
    }
  });
});
