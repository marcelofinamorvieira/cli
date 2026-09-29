import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  canonicalTimestamp,
  canonicalizeRecord,
  canonicalizeUpload,
  canonicalizeUploadCollection,
  isPortableDatoId,
  semanticHash,
  stableStringify,
} from '../../src/content-diff/canonicalize';
import {
  buildBlockOwnershipIndex,
  buildRecordDependencyGraph,
  collectCreateCycleIntermediateCandidates,
  collectCreateCycleShellCandidates,
  collectOptionalDeletionCycleReleaseCandidates,
  collectRecordReferences,
  collectRequiredDeletionCycleReleaseCandidates,
  collectUnsupportedPublishedNestedDeletionComponents,
  collectUploadReferences,
} from '../../src/content-diff/dependencies';
import {
  applyLegacyIdMappingsToSnapshot,
  assertNoManagedRelationshipToMappingModel,
  emptyLegacyIdMappingPlan,
  prepareLegacyIdMappings,
  prettyStableStringify,
  readLegacyIdMappingRegistry,
} from '../../src/content-diff/legacy-ids';
import type { LegacyIdMappingRegistry } from '../../src/content-diff/legacy-ids';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import {
  assertSchemasCompatible,
  computeSchemaDigest,
  schemaForScope,
} from '../../src/content-diff/schema';
import { findNonPortableCreateIds } from '../../src/content-diff/shared/create-id-contract';
import { snapshotSemanticState } from '../../src/content-diff/snapshot';
import type {
  ContentSnapshot,
  FieldSchemaSnapshot,
  InvalidContentDiagnostic,
  InvalidContentValidationIssue,
  ItemTypeSchemaSnapshot,
  RecordSnapshot,
  SchemaSnapshot,
} from '../../src/content-diff/types';
import {
  CONTENT_SNAPSHOT_FORMAT_VERSION,
  ContentDiffError,
  DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
} from '../../src/content-diff/types';

const RECORD_A = 'YhEa5SbeSl6KwIFizzkzig';
const RECORD_B = 'XSPMXvayT-yMUrVxP-YoSw';
const RECORD_C = '-40RNzgBSJaJsXiLSYhtVA';
const RECORD_D = 'hRHwQszvQHCNFNcaH6MHKg';
const BLOCK_ID = 'w3a6zOGbS_Kj91LgAyXISA';
const UPLOAD_ID = 'LQQiCYCfSU6DTmCQ63-JRw';
const MODEL_ID = '4QI3BfBvQs-hcv_YEkk1wg';
const BLOCK_MODEL_ID = 'mzmy5RRCSwCzMvmKgvsHUA';
const NO_DRAFT_MODEL_ID = 'NoDraftModel1234567890';

function emptyUploadDefaultFieldMetadata(
  locales: readonly string[],
): Record<string, unknown> {
  return {
    alt: Object.fromEntries(locales.map((locale) => [locale, null])),
    title: Object.fromEntries(locales.map((locale) => [locale, null])),
    custom_data: Object.fromEntries(locales.map((locale) => [locale, {}])),
    focal_point: null,
    poster_time: null,
  };
}

describe('content diff engine', () => {
  it('excludes only the exact core migrations tracking model from managed schema', () => {
    const schema = makeSchema('source');
    const trackingModel: ItemTypeSchemaSnapshot = {
      ...schema.itemTypes[0],
      id: 'HxJ7nR2gQ1yLp4Zv6sT8WA',
      apiKey: 'schema_migration',
      name: 'Schema migration',
      draftModeActive: false,
      draftSavingActive: false,
      fields: [
        {
          id: 'VvP4rT7mS9qLk2Nc5xY8ZA',
          apiKey: 'name',
          fieldType: 'string',
          localized: false,
          position: 1,
          defaultValue: null,
          validators: { required: {} },
        },
      ],
    };
    const withTracking = {
      ...schema,
      itemTypes: [...schema.itemTypes, trackingModel],
    };

    const scoped = schemaForScope(withTracking, 'all', 'schema_migration');
    expect(scoped.itemTypes.map(({ id }) => id)).not.to.include(
      trackingModel.id,
    );

    const conflicting = {
      ...withTracking,
      itemTypes: withTracking.itemTypes.map((itemType) =>
        itemType.id === trackingModel.id
          ? { ...itemType, fields: [] }
          : itemType,
      ),
    };
    expect(() =>
      schemaForScope(conflicting, 'all', 'schema_migration'),
    ).to.throw('does not match the exact internal tracking-model contract');
  });

  it('scopes schema closure through relationship validators only', () => {
    const schema = makeSchema('source');
    const unrelatedId = 'UnrelatedItemType1234';
    const unrelated: ItemTypeSchemaSnapshot = {
      ...schema.itemTypes.find(({ id }) => id === MODEL_ID)!,
      id: unrelatedId,
      apiKey: 'unrelated',
      name: 'Unrelated',
      fields: [],
    };
    const withCoincidentalEnum = {
      ...schema,
      itemTypes: [
        ...schema.itemTypes.map((itemType) =>
          itemType.id === MODEL_ID
            ? {
                ...itemType,
                fields: itemType.fields.map((field) =>
                  field.apiKey === 'title'
                    ? {
                        ...field,
                        validators: { enum: { values: [unrelatedId] } },
                      }
                    : field,
                ),
              }
            : itemType,
        ),
        unrelated,
      ],
      digest: '',
    };
    withCoincidentalEnum.digest = computeSchemaDigest(withCoincidentalEnum);

    const scoped = schemaForScope(withCoincidentalEnum, [MODEL_ID]);

    expect(scoped.itemTypes.map(({ id }) => id)).to.include(MODEL_ID);
    expect(scoped.itemTypes.map(({ id }) => id)).not.to.include(unrelatedId);
  });

  it('reports managed schema drift with environment-aware details', () => {
    const source = makeSchema('source');
    const destination = replaceTargetValidators(
      { ...source, environmentId: 'destination' },
      { required: {} },
    );

    expect(() => assertSchemasCompatible(source, destination)).to.throw(
      ContentDiffError,
    );

    try {
      assertSchemasCompatible(source, destination);
    } catch (error) {
      expect((error as ContentDiffError).code).to.equal('SCHEMA_MISMATCH');
      expect((error as ContentDiffError).details).to.deep.equal({
        sourceEnvironmentId: 'source',
        destinationEnvironmentId: 'destination',
      });
    }
  });

  it('accepts identical managed schemas across aligned projects', () => {
    const source = makeSchema('main');
    source.siteId = 'source-site';
    const destination = { ...source, siteId: 'destination-site' };

    expect(() => assertSchemasCompatible(source, destination)).not.to.throw();

    const plan = buildContentDiffPlan(
      makeSnapshot(source, {}),
      makeSnapshot(destination, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.source).to.include({
      siteId: 'source-site',
      environmentId: 'main',
    });
    expect(plan.target).to.include({
      siteId: 'destination-site',
      environmentId: 'main',
    });
    expect(plan.options.projectMode).to.equal('aligned_projects');
  });

  it('rejects only an identical project/environment endpoint', () => {
    const schema = makeSchema('main');
    const snapshot = makeSnapshot(schema, {});

    expect(() =>
      buildContentDiffPlan(snapshot, snapshot, {
        includeDeletions: false,
        uploads: 'referenced',
      }),
    ).to.throw(
      ContentDiffError,
      'must identify different project/environment endpoints',
    );

    const otherEnvironment = makeSchema('staging');
    expect(
      buildContentDiffPlan(snapshot, makeSnapshot(otherEnvironment, {}), {
        includeDeletions: false,
        uploads: 'referenced',
      }).options.projectMode,
    ).to.equal('same_project');
  });

  it('scopes new and finalized legacy-ID ledger state to the destination project', () => {
    const sourceSchema = makeSchema('main');
    sourceSchema.siteId = 'source-site';
    const destinationSchema = {
      ...sourceSchema,
      siteId: 'destination-site',
    };
    const alternateDestinationSchema = {
      ...sourceSchema,
      siteId: 'alternate-destination-site',
    };
    const source = makeSnapshot(sourceSchema, {
      '100': makeCanonicalRecord(sourceSchema, '100', {
        title: { en: 'legacy' },
      }),
    });
    const destination = makeSnapshot(destinationSchema, {});
    const alternateDestination = makeSnapshot(alternateDestinationSchema, {});

    const mappings = prepareLegacyIdMappings(
      source,
      destination,
      emptyMappingRegistry(destination),
    );
    const alternateMappings = prepareLegacyIdMappings(
      source,
      alternateDestination,
      emptyMappingRegistry(alternateDestination),
    );
    const plan = buildContentDiffPlan(source, destination, {
      includeDeletions: false,
      uploads: 'referenced',
      legacyIdMappings: mappings,
    });

    expect(mappings.entries[0].targetId).not.to.equal(
      alternateMappings.entries[0].targetId,
    );
    expect(
      plan.legacyIdMappings.newMappingBatch?.chunks[0].document.projectId,
    ).to.equal('destination-site');
    expect(plan.legacyIdMappings.schema.model.id).to.equal(
      emptyLegacyIdMappingPlan(destination).schema.model.id,
    );
    expect(plan.legacyIdMappings.schema.model.id).not.to.equal(
      emptyLegacyIdMappingPlan(source).schema.model.id,
    );
  });

  it('treats field default-value drift as an incompatible managed schema', () => {
    const source = makeSchema('source');
    const target = makeSchema('destination');
    source.itemTypes[0].fields[0].defaultValue = null;
    target.itemTypes[0].fields[0].defaultValue = 'destination default';
    source.digest = computeSchemaDigest(source);
    target.digest = computeSchemaDigest(target);

    expect(() => assertSchemasCompatible(source, target)).to.throw(
      'do not have identical managed schemas',
    );
  });

  it('distinguishes environment activation/settings drift from schema drift', () => {
    const source = makeSchema('source');
    const target = makeSchema('destination');
    target.environmentSemantics = {
      ...target.environmentSemantics,
      improvedValidationAtPublishing: false,
    };
    target.digest = computeSchemaDigest(target);

    try {
      assertSchemasCompatible(source, target);
    } catch (error) {
      expect(error).to.be.instanceOf(ContentDiffError);
      expect((error as ContentDiffError).code).to.equal(
        'ENVIRONMENT_SEMANTICS_MISMATCH',
      );
      expect((error as Error).message).to.contain(
        'schema autogeneration alone may not repair this mismatch',
      );
      return;
    }

    throw new Error('Expected environment semantics mismatch');
  });

  it('fails closed on reserved ledger name collisions and managed inbound relationships', async () => {
    const schema = makeSchema('source');
    const collidingModel: ItemTypeSchemaSnapshot = {
      ...schema.itemTypes.find(({ id }) => id === MODEL_ID)!,
      id: 'colliding-model-id',
      apiKey: 'some_other_model',
      name: 'Content diff',
      fields: [],
    };
    const collisionSchema = withRecomputedSchemaDigest({
      ...schema,
      itemTypes: [...schema.itemTypes, collidingModel],
    });
    let collisionError: unknown;
    try {
      await readLegacyIdMappingRegistry({} as never, collisionSchema);
    } catch (error) {
      collisionError = error;
    }
    expect(collisionError).to.be.instanceOf(ContentDiffError);
    expect((collisionError as ContentDiffError).message).to.include(
      'Model name Content diff is already used',
    );

    const withLedger = addExactMappingModel(schema);
    const ledgerModel = withLedger.itemTypes.find(
      ({ apiKey }) => apiKey === DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
    )!;
    const inbound = withRecomputedSchemaDigest({
      ...withLedger,
      itemTypes: withLedger.itemTypes.map((itemType) =>
        itemType.id === MODEL_ID
          ? {
              ...itemType,
              fields: itemType.fields.map((field) =>
                field.apiKey === 'target'
                  ? {
                      ...field,
                      validators: {
                        item_item_type: { item_types: [ledgerModel.id] },
                      },
                    }
                  : field,
              ),
            }
          : itemType,
      ),
    });
    expect(() => assertNoManagedRelationshipToMappingModel(inbound)).to.throw(
      ContentDiffError,
      'refers to reserved internal model',
    );
  });

  it('validates reserved-model defaults and accepts frozen v16 ledger bytes only in their project', async () => {
    const schema = addExactMappingModel(makeSchema('source'));
    const model = schema.itemTypes.find(
      ({ apiKey }) => apiKey === DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
    )!;
    const nameField = model.fields.find(({ apiKey }) => apiKey === 'name')!;
    let collectionAppearance = 'table';
    let nameHeading = false;
    let mappingName = 'legacy-id-map:test:1/1';
    let mappingValue = '{}';
    const mappingRecordMeta = {
      status: 'published',
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: null,
      stage: null,
      publication_scheduled_at: null,
      unpublishing_scheduled_at: null,
      published_at: null,
      first_published_at: null,
    };
    const rawClient = {
      itemTypes: {
        find: async () => ({
          id: model.id,
          name: 'Content diff',
          api_key: DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
          singleton: false,
          modular_block: false,
          sortable: false,
          tree: false,
          draft_mode_active: true,
          draft_saving_active: false,
          all_locales_required: false,
          inverse_relationships_enabled: false,
          collection_appearance: collectionAppearance,
          ordering_direction: null,
          ordering_meta: null,
          has_singleton_item: false,
          hint: null,
          workflow: null,
          singleton_item: null,
          ordering_field: null,
          presentation_image_field: null,
          image_preview_field: null,
          excerpt_field: null,
          title_field: { id: nameField.id },
          presentation_title_field: { id: nameField.id },
        }),
      },
      fields: {
        list: async () =>
          model.fields.map((field) => ({
            id: field.id,
            api_key: field.apiKey,
            label: field.apiKey === 'name' ? 'Name' : 'Mapping',
            field_type: field.fieldType,
            localized: field.localized,
            position: field.position,
            validators: field.validators,
            appearance:
              field.apiKey === 'name'
                ? {
                    addons: [],
                    editor: 'single_line',
                    parameters: {
                      heading: nameHeading,
                      placeholder: null,
                    },
                  }
                : { addons: [], editor: 'json', parameters: {} },
            default_value: null,
            hint: null,
            deep_filtering_enabled: false,
            content_link_enabled: true,
            fieldset: null,
          })),
      },
      items: {
        listPagedIterator: async function* () {
          yield {
            id: RECORD_A,
            item_type: { id: model.id, type: 'item_type' },
            name: mappingName,
            mapping: mappingValue,
            meta: mappingRecordMeta,
          };
        },
      },
    };
    let shapeError: unknown;
    try {
      await readLegacyIdMappingRegistry(
        rawClient as never,
        schema,
        DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
        false,
      );
    } catch (error) {
      shapeError = error;
    }
    expect(shapeError).to.be.instanceOf(ContentDiffError);
    expect((shapeError as ContentDiffError).message).to.include(
      'does not match the reserved content-diff ledger contract',
    );

    collectionAppearance = 'compact';
    nameHeading = true;
    shapeError = undefined;

    try {
      await readLegacyIdMappingRegistry(
        rawClient as never,
        schema,
        DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
        false,
      );
    } catch (error) {
      shapeError = error;
    }

    expect(shapeError).to.be.instanceOf(ContentDiffError);
    expect((shapeError as ContentDiffError).message).to.include(
      'does not match the reserved content-diff ledger schema',
    );

    nameHeading = false;
    shapeError = undefined;

    try {
      await readLegacyIdMappingRegistry(
        rawClient as never,
        schema,
        DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
      );
    } catch (error) {
      shapeError = error;
    }

    expect(shapeError).to.be.instanceOf(ContentDiffError);
    expect((shapeError as ContentDiffError).message).to.include(
      'must remain a valid, unscheduled, workflow-free draft',
    );

    mappingRecordMeta.status = 'draft';
    const entries = [
      { entityType: 'record' as const, sourceId: '100', targetId: RECORD_C },
    ];
    const wholeHash = semanticHash(entries);
    mappingName = `legacy-id-map:${RECORD_B}:1/1`;
    mappingValue = prettyStableStringify({
      formatVersion: 1,
      projectId: 'foreign-site',
      batchId: RECORD_B,
      chunkIndex: 0,
      chunkCount: 1,
      wholeHash,
      entries,
    });
    shapeError = undefined;

    try {
      await readLegacyIdMappingRegistry(rawClient as never, schema);
    } catch (error) {
      shapeError = error;
    }

    expect(shapeError).to.be.instanceOf(ContentDiffError);
    expect((shapeError as ContentDiffError).message).to.include(
      'invalid ledger metadata',
    );

    mappingValue = readFileSync(
      join(__dirname, '../fixtures/legacy-id-ledger-v16.json'),
      'utf8',
    ).trimEnd();
    const frozenLedger = JSON.parse(mappingValue);
    const registry = await readLegacyIdMappingRegistry(
      rawClient as never,
      schema,
    );
    expect(registry.entries).to.deep.equal(frozenLedger.entries);
    expect(prettyStableStringify(frozenLedger)).to.equal(mappingValue);
    expect(registry.records).to.deep.equal([
      {
        id: RECORD_A,
        hash: 'e725b73840fee861b5d3a8cbd0eac3913bfa5cef9a5502b2b8519fe1f9525159',
      },
    ]);
  });

  it('produces deterministic semantic hashes without changing array order', () => {
    expect(stableStringify({ z: 1, a: [{ y: 2, x: 1 }] })).to.equal(
      stableStringify({ a: [{ x: 1, y: 2 }], z: 1 }),
    );
    expect(semanticHash({ links: [RECORD_A, RECORD_B] })).not.to.equal(
      semanticHash({ links: [RECORD_B, RECORD_A] }),
    );
    expect(semanticHash({ value: -0 })).to.equal(semanticHash({ value: 0 }));
    expect(isPortableDatoId(RECORD_A)).to.equal(true);
    expect(isPortableDatoId('12345')).to.equal(false);
    expect(isPortableDatoId(`${RECORD_A}=`)).to.equal(false);
    expect(canonicalTimestamp('2026-01-01T01:00:00+01:00', 'test')).to.equal(
      '2026-01-01T00:00:00.000Z',
    );
    expect(() => canonicalTimestamp('not-a-date', 'test')).to.throw(
      ContentDiffError,
      'invalid timestamp',
    );

    const schema = makeSchema('source');
    const model = schema.itemTypes.find(({ id }) => id === MODEL_ID)!;
    const atPositionOne = canonicalizeRecord(
      { ...makeItem(RECORD_A, { title: { en: 'A' } }), position: 1 },
      null,
      model,
      schema,
      { publication: null, unpublishing: null },
    );
    const atPositionTwo = canonicalizeRecord(
      { ...makeItem(RECORD_A, { title: { en: 'A' } }), position: 2 },
      null,
      model,
      schema,
      { publication: null, unpublishing: null },
    );
    expect(atPositionOne.topology.position).to.equal(1);
    expect(atPositionTwo.topology.position).to.equal(2);
    expect(atPositionOne.hash).to.equal(atPositionTwo.hash);
  });

  it('orders JSON keys independently of locale and Unicode collation equivalence', () => {
    const composed = '\u00e9';
    const decomposed = 'e\u0301';
    const left = { [composed]: 'composed', [decomposed]: 'decomposed' };
    const right = { [decomposed]: 'decomposed', [composed]: 'composed' };

    expect(stableStringify(left)).to.equal(stableStringify(right));
    expect(semanticHash(left)).to.equal(semanticHash(right));
    expect(stableStringify({ z: 1, A: 2, _: 3, a: 4 })).to.equal(
      '{"A":2,"_":3,"a":4,"z":1}',
    );
  });

  it('maps numeric legacy records and recursively nested blocks without rewriting ordinary strings', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const source = makeSnapshot(sourceSchema, {
      '100': makeCanonicalRecord(sourceSchema, '100', {
        title: { en: '101' },
        target: '101',
        blocks: [makeRawBlock('200', '101')],
      }),
      '101': makeCanonicalRecord(sourceSchema, '101', {
        title: { en: 'dependency' },
        target: null,
        blocks: [],
      }),
    });
    const target = makeSnapshot(targetSchema, {});
    const mappings = prepareLegacyIdMappings(
      source,
      target,
      emptyMappingRegistry(source),
    );
    const mapped = applyLegacyIdMappingsToSnapshot(source, mappings);
    const bySource = new Map(
      mappings.entries.map((entry) => [
        `${entry.entityType}:${entry.sourceId}`,
        entry.targetId,
      ]),
    );
    const mappedRecord = mapped.records[bySource.get('record:100')!];
    const mappedBlock = mappedRecord.current.fields.blocks as Array<{
      id: string;
      attributes: { target: string };
    }>;

    expect(mappings.entries).to.have.length(3);
    expect(
      mappings.entries.every(
        ({ status, managed }) => status === 'new' && managed,
      ),
    ).to.equal(true);
    expect(mappedRecord.current.fields.title).to.deep.equal({ en: '101' });
    expect(mappedRecord.current.fields.target).to.equal(
      bySource.get('record:101'),
    );
    expect(mappedBlock[0].id).to.equal(bySource.get('block:200'));
    expect(mappedBlock[0].attributes.target).to.equal(
      bySource.get('record:101'),
    );
    expect(mappings.newMappingBatch?.chunks).to.have.length(1);
    expect(mappings.newMappingBatch?.chunks[0].byteLength).to.be.lessThan(
      128 * 1024 + 1,
    );

    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      legacyIdMappings: mappings,
    });
    expect(plan.records.map(({ id }) => id)).to.have.members([
      bySource.get('record:100'),
      bySource.get('record:101'),
    ]);
    expect(plan.legacyIdMappings.entries).to.have.length(3);
    expect(plan.requiredPermissions.editSchema).to.equal(true);

    const firstLedgerRecordId =
      plan.legacyIdMappings.newMappingBatch!.chunks[0].id;
    const collisionPlan = buildContentDiffPlan(
      source,
      { ...target, visibleRecordIds: [firstLedgerRecordId] },
      {
        includeDeletions: false,
        uploads: 'referenced',
        legacyIdMappings: mappings,
      },
    );
    expect(
      collisionPlan.legacyIdMappings.newMappingBatch!.chunks[0].id,
    ).not.to.equal(firstLedgerRecordId);
  });

  it('rewrites only typed IDs through every localized block and Structured Text permutation', () => {
    const sourceSchema = makeRecursiveMappingSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const nestedStructuredBlock = makeRawBlockWithFields('200', {
      target: { en: '101', it: null },
      image: '300',
      body: {
        en: makeDast([
          {
            type: 'paragraph',
            children: [{ type: 'inlineItem', item: '101' }],
          },
          {
            type: 'block',
            item: makeRawBlockWithFields('201', {
              target: { en: '101' },
              image: '300',
              json_data: { record: '101', upload: '300', block: '201' },
            }),
          },
        ]),
      },
      child: {
        it: makeRawBlockWithFields('202', {
          target: { en: '101' },
          image: '300',
        }),
      },
      children: {
        en: [
          makeRawBlockWithFields('203', {
            target: { en: '101' },
            image: '300',
          }),
        ],
      },
      json_data: { record: '101', upload: '300', block: '200' },
    });
    const source = makeSnapshot(sourceSchema, {
      '100': makeCanonicalRecord(sourceSchema, '100', {
        title: { en: '101' },
        target: '101',
        structured: {
          en: makeCustomStructuredText(
            [
              {
                type: 'paragraph',
                children: [{ type: 'inlineItem', item: '101' }],
              },
              { type: 'itemLink', item: '101', children: [] },
              { type: 'block', item: nestedStructuredBlock },
            ],
            { type: 'inlineItem', item: '101' },
          ),
        },
        single: {
          it: makeRawBlockWithFields('204', {
            target: { en: '101' },
            image: '300',
          }),
        },
        blocks: [
          makeRawBlockWithFields('205', {
            target: { it: '101' },
            image: '300',
            child: {
              en: makeRawBlockWithFields('206', {
                target: { en: '101' },
                image: '300',
              }),
            },
          }),
        ],
        asset: '300',
        gallery: ['300'],
        seo: { title: '300', image: '300' },
        json_data: { record: '101', upload: '300', block: '200' },
      }),
      '101': makeCanonicalRecord(sourceSchema, '101', {
        title: { en: 'dependency' },
        target: null,
      }),
    });
    const collection = canonicalizeUploadCollection({
      id: '400',
      label: 'Legacy',
      parent: null,
      position: 1,
    });
    source.uploadCollections[collection.id] = collection;
    source.uploads['300'] = canonicalizeUpload(
      {
        id: '300',
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'legacy',
        filename: 'legacy.jpg',
        url: 'https://example.test/legacy.jpg',
        size: 10,
        mime_type: 'image/jpeg',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          sourceSchema.locales,
        ),
        upload_collection: { id: '400', type: 'upload_collection' },
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
    const target = makeSnapshot(targetSchema, {});
    const mappings = prepareLegacyIdMappings(
      source,
      target,
      emptyMappingRegistry(source),
    );
    const mapped = applyLegacyIdMappingsToSnapshot(source, mappings);
    const ids = new Map(
      mappings.entries.map((entry) => [
        `${entry.entityType}:${entry.sourceId}`,
        entry.targetId,
      ]),
    );
    const fields = mapped.records[ids.get('record:100')!].current.fields as any;
    const structuredChildren = fields.structured.en.document.children;
    const mappedBlock = structuredChildren[2].item;
    const nestedBodyChildren = mappedBlock.attributes.body.en.document.children;

    expect(structuredChildren[0].children[0].item).to.equal(
      ids.get('record:101'),
    );
    expect(structuredChildren[1].item).to.equal(ids.get('record:101'));
    expect(fields.structured.en.document.sidecar).to.deep.equal({
      type: 'inlineItem',
      item: '101',
    });
    expect(mappedBlock.id).to.equal(ids.get('block:200'));
    expect(mappedBlock.attributes.target.en).to.equal(ids.get('record:101'));
    expect(mappedBlock.attributes.image).to.equal(ids.get('upload:300'));
    expect(nestedBodyChildren[0].children[0].item).to.equal(
      ids.get('record:101'),
    );
    expect(nestedBodyChildren[1].item.id).to.equal(ids.get('block:201'));
    expect(mappedBlock.attributes.child.it.id).to.equal(ids.get('block:202'));
    expect(mappedBlock.attributes.children.en[0].id).to.equal(
      ids.get('block:203'),
    );
    expect(fields.single.it.id).to.equal(ids.get('block:204'));
    expect(fields.blocks[0].id).to.equal(ids.get('block:205'));
    expect(fields.blocks[0].attributes.child.en.id).to.equal(
      ids.get('block:206'),
    );
    expect(fields.asset).to.equal(ids.get('upload:300'));
    expect(fields.gallery).to.deep.equal([ids.get('upload:300')]);
    expect(fields.seo).to.deep.equal({
      title: '300',
      image: ids.get('upload:300'),
    });
    expect(fields.title).to.deep.equal({ en: '101' });
    expect(fields.json_data).to.deep.equal({
      block: '200',
      record: '101',
      upload: '300',
    });
    expect(mappedBlock.attributes.json_data).to.deep.equal({
      block: '200',
      record: '101',
      upload: '300',
    });
    expect(mapped.uploads[ids.get('upload:300')!].manual.collectionId).to.equal(
      ids.get('upload_collection:400'),
    );
  });

  it('reuses an existing alias, including external published dependencies', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const mappedLegacyId = RECORD_B;
    const source = makeSnapshot(sourceSchema, {
      [RECORD_A]: makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: 'consumer' }, target: '100', blocks: [] },
        { title: { en: 'consumer' }, target: '100', blocks: [] },
      ),
    });
    const target = makeSnapshot(targetSchema, {});
    target.visibleRecordIds = [mappedLegacyId];
    const registry = existingMappingRegistry(source, [
      { entityType: 'record', sourceId: '100', targetId: mappedLegacyId },
    ]);
    const mappings = prepareLegacyIdMappings(source, target, registry);
    expect(() =>
      buildContentDiffPlan(source, target, {
        includeDeletions: false,
        uploads: 'referenced',
        legacyIdMappings: mappings,
      }),
    ).to.throw(ContentDiffError, 'not available in the destination slices');
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      legacyIdMappings: mappings,
      externalLegacyRecordTargets: {
        [mappedLegacyId]: {
          itemTypeId: MODEL_ID,
          current: true,
          published: true,
        },
      },
    });

    expect(plan.records[0].desired?.current.fields.target).to.equal(
      mappedLegacyId,
    );
    expect(plan.legacyIdMappings.entries).to.deep.include({
      entityType: 'record',
      sourceId: '100',
      targetId: mappedLegacyId,
      status: 'existing',
      managed: false,
      expectedItemTypeId: MODEL_ID,
      requiredAvailability: { current: true, published: true },
    });
    expect(plan.legacyIdMappings.newMappingBatch).to.equal(null);
    expect(plan.requiredPermissions.editSchema).to.equal(false);
  });

  it('drops tentative mappings for invalid skipped aggregates and plans no ledger mutation', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { length: { min: 1 } }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const source = makeSnapshot(sourceSchema, {
      '100': markCurrentInvalid(
        makeCanonicalRecord(sourceSchema, '100', {
          title: { en: '' },
          blocks: [makeRawBlock('200', null)],
        }),
      ),
    });
    const target = makeSnapshot(targetSchema, {});
    const mappings = prepareLegacyIdMappings(
      source,
      target,
      emptyMappingRegistry(source),
    );
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      legacyIdMappings: mappings,
    });

    expect(plan.records).to.deep.equal([]);
    expect(plan.legacyIdMappings.entries).to.deep.equal([]);
    expect(plan.legacyIdMappings.skippedEntries).to.deep.equal([
      {
        entityType: 'block',
        sourceId: '200',
        reason:
          'owning or referring aggregate skipped: INVALID_CURRENT (current)',
      },
      {
        entityType: 'record',
        sourceId: '100',
        reason: 'top-level aggregate skipped: INVALID_CURRENT (current)',
      },
    ]);
    expect(plan.legacyIdMappings.newMappingBatch).to.equal(null);
    expect(plan.summary.legacyIdMappings).to.deep.equal({
      detected: 2,
      existing: 0,
      created: 0,
      skipped: 2,
      records: 0,
    });
    expect(plan.requiredPermissions.editSchema).to.equal(false);
  });

  it('fails closed on malformed IDs and shared record/block legacy claims', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const malformed = makeSnapshot(sourceSchema, {
      legacy_bad: makeCanonicalRecord(sourceSchema, 'legacy_bad', {
        title: { en: 'bad' },
      }),
    });
    expect(() =>
      prepareLegacyIdMappings(
        malformed,
        makeSnapshot(targetSchema, {}),
        emptyMappingRegistry(malformed),
      ),
    ).to.throw(ContentDiffError, 'neither a canonical portable');

    const collision = makeSnapshot(sourceSchema, {
      '100': makeCanonicalRecord(sourceSchema, '100', {
        title: { en: 'collision' },
        blocks: [makeRawBlock('100', null)],
      }),
    });
    expect(() =>
      prepareLegacyIdMappings(
        collision,
        makeSnapshot(targetSchema, {}),
        emptyMappingRegistry(collision),
      ),
    ).to.throw(ContentDiffError, 'Conflicting legacy mapping claim');
  });

  it('does not require or create the internal ledger for a portable zero diff', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const record = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'same' },
    });
    const targetRecord = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'same' },
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: record }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetRecord }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.legacyIdMappings.entries).to.deep.equal([]);
    expect(plan.legacyIdMappings.skippedEntries).to.deep.equal([]);
    expect(plan.legacyIdMappings.newMappingBatch).to.equal(null);
    expect(plan.summary.legacyIdMappings).to.deep.equal({
      detected: 0,
      existing: 0,
      created: 0,
      skipped: 0,
      records: 0,
    });
    expect(plan.requiredPermissions.editSchema).to.equal(false);
  });

  it('keeps validity outside record hashes but inside snapshot state', () => {
    const schema = makeSchema('source');
    const model = schema.itemTypes.find(({ id }) => id === MODEL_ID)!;
    const validInput = makeItem(RECORD_A, { title: { en: '' } });
    const invalidInput = {
      ...validInput,
      meta: {
        ...validInput.meta,
        is_valid: false,
        is_current_version_valid: false,
      },
    };
    const valid = canonicalizeRecord(validInput, null, model, schema, {
      publication: null,
      unpublishing: null,
    });
    const invalid = canonicalizeRecord(invalidInput, null, model, schema, {
      publication: null,
      unpublishing: null,
    });

    expect(invalid.hash).to.equal(valid.hash);
    expect(invalid.current.hash).to.equal(valid.current.hash);
    expect(invalid.validity).to.deep.equal({ current: false, published: null });
    expect(invalid.consistency.currentValid).to.equal(false);
    expect(
      semanticHash(
        snapshotSemanticState(makeSnapshot(schema, { [RECORD_A]: invalid })),
      ),
    ).not.to.equal(
      semanticHash(
        snapshotSemanticState(makeSnapshot(schema, { [RECORD_A]: valid })),
      ),
    );
  });

  it('skips strict invalid writes by default and relaxes only diagnosed validators', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { length: { min: 1 } }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const invalid = markCurrentInvalid(
      makeCanonicalRecord(sourceSchema, RECORD_A, {
        title: { en: '' },
      }),
    );
    const source = makeSnapshot(sourceSchema, { [RECORD_A]: invalid });
    const target = makeSnapshot(targetSchema, {});

    const defaultPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
    });
    expect(defaultPlan.records).to.deep.equal([]);
    expect(defaultPlan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_A,
      disposition: 'must_remain_absent',
    });
    expect(defaultPlan.summary.invalidContent).to.include({
      status: 'partial',
      detectedRecords: 1,
      migratedRecords: 0,
      skippedRecords: 1,
      requiresTemporaryValidatorRelaxation: false,
    });

    const migratedPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: [
        {
          recordId: RECORD_A,
          slice: 'current',
          versionHash: invalid.current.hash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_LENGTH',
              fieldId: 'field-title',
              details: {},
            },
          ],
        },
      ],
    });
    expect(migratedPlan.records.map(({ action }) => action)).to.deep.equal([
      'create',
    ]);
    expect(migratedPlan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(migratedPlan.invalidContent.validatorRelaxations[0]).to.include({
      fieldId: 'field-title',
      itemTypeId: MODEL_ID,
    });
    expect(
      migratedPlan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['length']);
    expect(migratedPlan.requiredPermissions.editSchema).to.equal(true);
    expect(migratedPlan.summary.invalidContent).to.include({
      status: 'complete',
      detectedRecords: 1,
      migratedRecords: 1,
      skippedRecords: 0,
      relaxedFieldCount: 1,
      relaxedValidatorCount: 1,
      requiresTemporaryValidatorRelaxation: true,
    });

    const unmappedPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: [
        {
          recordId: RECORD_A,
          slice: 'current',
          versionHash: invalid.current.hash,
          valid: false,
          issues: [
            {
              code: 'INVALID_FORMAT',
              fieldId: null,
              details: {},
            },
          ],
        },
      ],
    });
    expect(unmappedPlan.records).to.deep.equal([]);
    expect(
      unmappedPlan.invalidContent.skippedRecords[0].reasons[0].code,
    ).to.equal('STRUCTURAL_VALIDATION');
    expect(unmappedPlan.requiredPermissions.editSchema).to.equal(false);
  });

  it('propagates a fresh nested UPDATE skip and removes its pending validator recovery', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { length: { min: 1 } }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const unsafe = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        {
          title: { en: '' },
          target: null,
          blocks: [makeRawBlock(RECORD_C, null)],
        },
        {
          title: { en: '' },
          target: null,
          blocks: [makeRawBlock(BLOCK_ID, null)],
        },
      ),
    );
    const dependent = makeCanonicalRecord(sourceSchema, RECORD_B, {
      title: { en: 'dependent' },
      target: RECORD_A,
      blocks: [],
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: unsafe,
        [RECORD_B]: dependent,
      }),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: invalidDiagnostics(unsafe, [
          {
            code: 'VALIDATION_LENGTH',
            fieldId: 'field-title',
            details: {},
          },
        ]),
      },
    );

    expect(plan.records).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(
      plan.invalidContent.skippedRecords
        .find(({ id }) => id === RECORD_A)!
        .reasons.some(
          ({ code }) => code === 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE',
        ),
    ).to.equal(true);
    expect(
      plan.invalidContent.skippedRecords.find(({ id }) => id === RECORD_B)!
        .reasons[0],
    ).to.include({
      code: 'DEPENDENCY_ON_SKIPPED_RECORD',
      dependencyId: RECORD_A,
    });
    expect(plan.invalidContent.propagatedSkipCount).to.equal(1);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.execution.revalidateBeforePublishIds).to.deep.equal([]);
    expect(plan.requiredPermissions.editSchema).to.equal(false);
  });

  it('propagates a skip when a two-way uniqueness-invalid peer is omitted', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { unique: {} }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: 'duplicate', it: 'a' } },
        { title: { en: 'duplicate', it: 'a' } },
      ),
    );
    const sourceB = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_B,
        { title: { en: 'duplicate', it: 'b' } },
        { title: { en: 'duplicate', it: 'b' } },
      ),
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourceA, [
            { code: 'INVALID_FORMAT', fieldId: null, details: {} },
          ]),
          ...invalidDiagnostics(sourceB, [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ]),
        ],
      },
    );

    expect(plan.records).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(
      plan.invalidContent.skippedRecords
        .find(({ id }) => id === RECORD_B)
        ?.reasons.some(
          ({ code, validatorKey, dependencyId }) =>
            code === 'DEPENDENCY_ON_SKIPPED_RECORD' &&
            validatorKey === 'unique' &&
            dependencyId === RECORD_A,
        ),
    ).to.equal(true);
    expect(plan.invalidContent.propagatedSkipCount).to.equal(1);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
  });

  it('uses default-mode diagnostics to keep native invalid drafts with their skipped uniqueness peers', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { unique: {} }),
      true,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourcePublishedPeer = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: 'duplicate', it: 'published-peer' } },
        { title: { en: 'duplicate', it: 'published-peer' } },
      ),
    );
    const sourceNativeDraft = markCurrentInvalid(
      makeCanonicalRecord(sourceSchema, RECORD_B, {
        title: { en: 'duplicate', it: 'native-draft' },
      }),
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourcePublishedPeer,
        [RECORD_B]: sourceNativeDraft,
      }),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourcePublishedPeer, [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ]),
          {
            recordId: RECORD_B,
            slice: 'current',
            versionHash: sourceNativeDraft.current.hash,
            valid: false,
            issues: [
              {
                code: 'VALIDATION_UNIQUE',
                fieldId: 'field-title',
                details: {},
              },
            ],
          },
        ],
      },
    );

    expect(plan.options.migrateInvalidContent).to.equal(false);
    expect(plan.records).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(
      plan.invalidContent.skippedRecords
        .find(({ id }) => id === RECORD_B)
        ?.reasons.some(
          ({ code, validatorKey, dependencyId }) =>
            code === 'DEPENDENCY_ON_SKIPPED_RECORD' &&
            validatorKey === 'unique' &&
            dependencyId === RECORD_A,
        ),
    ).to.equal(true);
    expect(plan.invalidContent.propagatedSkipCount).to.equal(1);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.requiredPermissions.editSchema).to.equal(false);
  });

  it('keeps a three-way uniqueness-invalid component when two peers remain', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { unique: {} }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const records = [RECORD_A, RECORD_B, RECORD_C].map((recordId, index) =>
      markCurrentAndPublishedInvalid(
        makeCanonicalRecordWithPublished(
          sourceSchema,
          recordId,
          { title: { en: 'duplicate', it: `current-${index}` } },
          { title: { en: 'duplicate', it: `published-${index}` } },
        ),
      ),
    );
    const [sourceA, sourceB, sourceC] = records;
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
        [RECORD_C]: sourceC,
      }),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourceA, [
            { code: 'INVALID_FORMAT', fieldId: null, details: {} },
          ]),
          ...invalidDiagnostics(sourceB, [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ]),
          ...invalidDiagnostics(sourceC, [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ]),
        ],
      },
    );

    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal(
      [RECORD_B, RECORD_C].sort(),
    );
    expect(plan.invalidContent.propagatedSkipCount).to.equal(0);
    expect(plan.records.map(({ id }) => id).sort()).to.deep.equal(
      [RECORD_B, RECORD_C].sort(),
    );
    expect(plan.invalidContent.validatorRelaxations).to.have.length(1);
    expect(plan.invalidContent.validatorRelaxations[0]).to.include({
      fieldId: 'field-title',
    });
    expect(
      plan.invalidContent.validatorRelaxations[0].affectedRecordIds,
    ).to.deep.equal([RECORD_B, RECORD_C].sort());
  });

  it('accepts an invalid preserved target peer with matching slice values', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { unique: {} }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: 'duplicate', it: 'a' }, blocks: [] },
        { title: { en: 'duplicate', it: 'a' }, blocks: [] },
      ),
    );
    const sourceB = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_B,
        { title: { en: 'duplicate', it: 'b' } },
        { title: { en: 'duplicate', it: 'b' } },
      ),
    );
    const targetA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_A,
        { title: { en: 'duplicate', it: 'target' }, blocks: null },
        { title: { en: 'duplicate', it: 'target' }, blocks: null },
      ),
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetA }),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourceA, [
            { code: 'INVALID_FORMAT', fieldId: null, details: {} },
          ]),
          ...invalidDiagnostics(sourceB, [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ]),
        ],
      },
    );

    expect(plan.invalidContent.skippedRecords).to.have.length(1);
    expect(plan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_A,
      disposition: 'preserve_target',
    });
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([RECORD_B]);
    expect(plan.records.map(({ id }) => id)).to.deep.equal([RECORD_B]);
  });

  it('requires uniqueness peers in the exact current and published slices', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { unique: {} }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: 'duplicate', it: 'a' }, blocks: [] },
        { title: { en: 'duplicate', it: 'a' }, blocks: [] },
      ),
    );
    const sourceB = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_B,
        { title: { en: 'duplicate', it: 'b' } },
        { title: { en: 'duplicate', it: 'b' } },
      ),
    );
    const targetA = markCurrentInvalid(
      makeCanonicalRecord(targetSchema, RECORD_A, {
        title: { en: 'duplicate', it: 'target' },
        blocks: null,
      }),
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetA }),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourceA, [
            { code: 'INVALID_FORMAT', fieldId: null, details: {} },
          ]),
          ...invalidDiagnostics(sourceB, [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ]),
        ],
      },
    );

    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(
      plan.invalidContent.skippedRecords.find(({ id }) => id === RECORD_B)
        ?.reasons,
    ).to.deep.include({
      code: 'DEPENDENCY_ON_SKIPPED_RECORD',
      slice: 'published',
      fieldId: 'field-title',
      validatorKey: 'unique',
      dependencyId: RECORD_A,
      dependencyChain: [RECORD_B, RECORD_A],
      message: `Record ${RECORD_B} cannot preserve its source published invalidity because every matching uniqueness peer is skipped and the destination does not preserve an equivalent published peer.`,
    });
  });

  it('requires uniqueness peers in the exact localized value', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { unique: {} }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: 'duplicate', it: 'a' }, blocks: [] },
        { title: { en: 'duplicate', it: 'a' }, blocks: [] },
      ),
    );
    const sourceB = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_B,
        { title: { en: 'duplicate', it: 'b' } },
        { title: { en: 'duplicate', it: 'b' } },
      ),
    );
    const targetA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_A,
        { title: { en: 'different', it: 'duplicate' }, blocks: null },
        { title: { en: 'different', it: 'duplicate' }, blocks: null },
      ),
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetA }),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourceA, [
            { code: 'INVALID_FORMAT', fieldId: null, details: {} },
          ]),
          ...invalidDiagnostics(sourceB, [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ]),
        ],
      },
    );

    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(
      plan.invalidContent.skippedRecords.find(({ id }) => id === RECORD_B)
        ?.reasons,
    ).to.deep.include({
      code: 'DEPENDENCY_ON_SKIPPED_RECORD',
      slice: 'current',
      fieldId: 'field-title',
      validatorKey: 'unique',
      dependencyId: RECORD_A,
      dependencyChain: [RECORD_B, RECORD_A],
      message: `Record ${RECORD_B} cannot preserve its source current invalidity because every matching uniqueness peer is skipped and the destination does not preserve an equivalent current peer.`,
    });
  });

  it('keeps a record invalid through a non-unique diagnostic after its peer is skipped', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), {
        length: { min: 20 },
        unique: {},
      }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: 'duplicate', it: 'a' } },
        { title: { en: 'duplicate', it: 'a' } },
      ),
    );
    const sourceB = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_B,
        { title: { en: 'duplicate', it: 'b' } },
        { title: { en: 'duplicate', it: 'b' } },
      ),
    );
    const uniqueAndLengthIssues: InvalidContentValidationIssue[] = [
      {
        code: 'VALIDATION_LENGTH',
        fieldId: 'field-title',
        details: {},
      },
      {
        code: 'VALIDATION_UNIQUE',
        fieldId: 'field-title',
        details: {},
      },
    ];
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourceA, [
            { code: 'INVALID_FORMAT', fieldId: null, details: {} },
          ]),
          ...invalidDiagnostics(sourceB, uniqueAndLengthIssues),
        ],
      },
    );

    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([RECORD_B]);
    expect(
      plan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['length', 'unique']);
  });

  it('does not treat whitespace-only unique values as collision support', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { unique: {} }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        { title: { en: '   ', it: 'a' } },
        { title: { en: '   ', it: 'a' } },
      ),
    );
    const sourceB = markCurrentAndPublishedInvalid(
      makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_B,
        { title: { en: '   ', it: 'b' } },
        { title: { en: '   ', it: 'b' } },
      ),
    );
    const uniqueIssue: InvalidContentValidationIssue = {
      code: 'VALIDATION_UNIQUE',
      fieldId: 'field-title',
      details: {},
    };
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          ...invalidDiagnostics(sourceA, [uniqueIssue]),
          ...invalidDiagnostics(sourceB, [uniqueIssue]),
        ],
      },
    );

    expect(plan.records).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    for (const skipped of plan.invalidContent.skippedRecords) {
      expect(
        skipped.reasons.some(
          ({ code }) => code === 'VALIDATION_CONTRACT_CHANGED',
        ),
      ).to.equal(true);
    }
  });

  it('propagates skips only when the destination cannot satisfy a dependency', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { length: { min: 1 } }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const invalidDependency = markCurrentInvalid(
      makeCanonicalRecord(sourceSchema, RECORD_B, {
        title: { en: '' },
      }),
    );
    const consumer = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'consumer' },
      target: RECORD_B,
    });

    const absentDependencyPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: consumer,
        [RECORD_B]: invalidDependency,
      }),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      absentDependencyPlan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(absentDependencyPlan.invalidContent.detectedRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(absentDependencyPlan.invalidContent.migratedRecordIds).to.deep.equal(
      [],
    );
    expect(
      absentDependencyPlan.invalidContent.skippedRecords.some(({ id }) =>
        absentDependencyPlan.invalidContent.migratedRecordIds.includes(id),
      ),
    ).to.equal(false);
    expect(absentDependencyPlan.invalidContent.propagatedSkipCount).to.equal(1);

    const existingDependency = makeCanonicalRecord(targetSchema, RECORD_B, {
      title: { en: 'destination value' },
    });
    const existingDependencyPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: consumer,
        [RECORD_B]: invalidDependency,
      }),
      makeSnapshot(targetSchema, { [RECORD_B]: existingDependency }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      existingDependencyPlan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_B]);
    expect(
      existingDependencyPlan.records.find(({ id }) => id === RECORD_A),
    ).to.include({ id: RECORD_A, action: 'create' });
  });

  it('falls back to a no-relaxation partial plan around preserved schedules', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { length: { min: 1 } }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = markCurrentInvalid(
      makeCanonicalRecord(sourceSchema, RECORD_A, { title: { en: '' } }),
    );
    const sourceB = markCurrentInvalid(
      makeCanonicalRecord(sourceSchema, RECORD_B, { title: { en: '' } }),
    );
    const targetModel = targetSchema.itemTypes.find(
      ({ id }) => id === MODEL_ID,
    )!;
    const targetB = canonicalizeRecord(
      makeItem(RECORD_B, { title: { en: 'target' } }),
      null,
      targetModel,
      targetSchema,
      {
        publication: {
          at: '2035-01-01T00:00:00Z',
          selective: null,
        },
        unpublishing: null,
      },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceA, [RECORD_B]: sourceB }),
      makeSnapshot(targetSchema, { [RECORD_B]: targetB }),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: [
          {
            recordId: RECORD_A,
            slice: 'current',
            versionHash: sourceA.current.hash,
            valid: false,
            issues: [
              {
                code: 'VALIDATION_LENGTH',
                fieldId: 'field-title',
                details: {},
              },
            ],
          },
        ],
      },
    );

    expect(plan.records).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([]);
    expect(plan.requiredPermissions.editSchema).to.equal(false);
    expect(plan.summary.invalidContent).to.include({
      status: 'partial',
      requiresTemporaryValidatorRelaxation: false,
    });
  });

  it('preserves destination validity for semantic noops', () => {
    const schema = setInvalidDraftSaving(
      replaceTitleValidators(makeSchema('source'), { length: { min: 1 } }),
      false,
    );
    const targetSchema = { ...schema, environmentId: 'target' };
    const sourceInvalid = markCurrentInvalid(
      makeCanonicalRecord(schema, RECORD_A, { title: { en: '' } }),
    );
    const targetValid = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: '' },
    });
    const invalidSourcePlan = buildContentDiffPlan(
      makeSnapshot(schema, { [RECORD_A]: sourceInvalid }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetValid }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(invalidSourcePlan.records[0].action).to.equal('noop');
    expect(invalidSourcePlan.records[0].desired?.validity).to.deep.equal(
      targetValid.validity,
    );
    expect(invalidSourcePlan.invalidContent.detectedRecordIds).to.deep.equal([
      RECORD_A,
    ]);
    expect(invalidSourcePlan.invalidContent.skippedRecords).to.deep.equal([]);

    const sourceValid = makeCanonicalRecord(schema, RECORD_A, {
      title: { en: '' },
    });
    const targetInvalid = markCurrentInvalid(
      makeCanonicalRecord(targetSchema, RECORD_A, { title: { en: '' } }),
    );
    const invalidTargetPlan = buildContentDiffPlan(
      makeSnapshot(schema, { [RECORD_A]: sourceValid }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetInvalid }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(invalidTargetPlan.records[0]).to.include({ action: 'noop' });
    expect(invalidTargetPlan.records[0].desired?.validity).to.deep.equal(
      targetInvalid.validity,
    );
  });

  it('normalizes raw nested blocks and preserves missing localized keys', () => {
    const schema = makeSchema('source');
    const model = schema.itemTypes.find(({ id }) => id === MODEL_ID)!;
    const rawBlock = {
      id: BLOCK_ID,
      type: 'item',
      __itemTypeId: BLOCK_MODEL_ID,
      attributes: {
        target: RECORD_B,
        image: { upload_id: UPLOAD_ID, alt: null },
      },
      relationships: {
        item_type: {
          data: { id: BLOCK_MODEL_ID, type: 'item_type' },
        },
      },
      meta: { created_at: 'ignored' },
    };
    const current = makeItem(RECORD_A, {
      title: { en: 'Hello' },
      blocks: [rawBlock],
    });
    const record = canonicalizeRecord(current, null, model, schema, {
      publication: null,
      unpublishing: null,
    });
    const blocks = record.current.fields.blocks as any[];

    expect(record.current.fields.title).to.deep.equal({ en: 'Hello' });
    expect(blocks[0]).to.deep.equal({
      id: BLOCK_ID,
      type: 'item',
      relationships: {
        item_type: {
          data: { id: BLOCK_MODEL_ID, type: 'item_type' },
        },
      },
      attributes: {
        target: RECORD_B,
        image: { alt: null, upload_id: UPLOAD_ID },
      },
    });
    expect(collectUploadReferences(record, schema)).to.deep.equal([UPLOAD_ID]);

    const ownership = buildBlockOwnershipIndex({ [record.id]: record }, schema);
    expect(ownership[BLOCK_ID][0]).to.include({
      topRecordId: RECORD_A,
      itemTypeId: BLOCK_MODEL_ID,
      fieldPath: 'blocks',
    });

    const withNullLocale = canonicalizeRecord(
      makeItem(RECORD_A, {
        title: { en: 'Hello', it: null },
        blocks: [rawBlock],
      }),
      null,
      model,
      schema,
      { publication: null, unpublishing: null },
    );
    expect(withNullLocale.current.hash).not.to.equal(record.current.hash);

    const legacyTopLevelMeta = canonicalizeRecord(
      makeItem(RECORD_A, {
        title: { en: 'Hello' },
        created_at: 'must-not-be-content',
        status: 'published',
        custom_unknown_field: 'preserved',
      }),
      null,
      model,
      schema,
      { publication: null, unpublishing: null },
    );
    expect(legacyTopLevelMeta.current.fields).not.to.have.property(
      'created_at',
    );
    expect(legacyTopLevelMeta.current.fields).not.to.have.property('status');
    expect(legacyTopLevelMeta.current.fields.custom_unknown_field).to.equal(
      'preserved',
    );

    const duplicateBlock = canonicalizeRecord(
      makeItem(RECORD_A, { blocks: [rawBlock, rawBlock] }),
      null,
      model,
      schema,
      { publication: null, unpublishing: null },
    );
    expect(() =>
      buildBlockOwnershipIndex({ [RECORD_A]: duplicateBlock }, schema),
    ).to.throw(ContentDiffError, 'reused or relocated');
  });

  it('normalizes set-like upload tags and excludes transport from its hash', () => {
    const input = {
      id: UPLOAD_ID,
      md5: '900150983cd24fb0d6963f7d28e17f72',
      basename: 'hero.jpg',
      filename: 'hero.jpg',
      url: 'https://example.test/hero.jpg',
      size: 10,
      mime_type: 'image/jpeg',
      author: null,
      copyright: null,
      notes: null,
      default_field_metadata: {
        alt: { it: 'Eroe', en: 'Hero' },
        title: {},
        custom_data: {},
        focal_point: null,
        poster_time: null,
      },
      tags: ['b', 'a', 'b'],
      upload_collection: null,
      updated_at: '2026-01-01T00:00:00Z',
      meta: { antivirus: { status: 'clean' } },
    };
    const upload = canonicalizeUpload(input, ['en', 'it']);
    const changedTransport = {
      ...upload,
      transport: { ...upload.transport, sourceUrl: 'https://other.test/x' },
    };

    expect(upload.manual.tags).to.deep.equal(['a', 'b']);
    expect(upload.manual.defaultFieldMetadata.alt).to.deep.equal({
      en: 'Hero',
      it: 'Eroe',
    });
    expect(changedTransport.hash).to.equal(upload.hash);
    expect(
      canonicalizeUpload(
        { ...input, size: 999, mime_type: 'application/octet-stream' },
        ['en', 'it'],
      ).hash,
    ).to.equal(upload.hash);

    const legacyMetadata = canonicalizeUpload(
      {
        ...input,
        default_field_metadata: {
          it: {
            alt: 'Eroe',
            title: null,
            custom_data: { b: 2, a: 1 },
            focal_point: null,
          },
          en: {
            alt: 'Hero',
            title: null,
            custom_data: {},
            focal_point: null,
          },
        },
      },
      ['en', 'it'],
    );
    expect(legacyMetadata.manual.defaultFieldMetadata).to.deep.equal({
      en: {
        alt: 'Hero',
        custom_data: {},
        focal_point: null,
        title: null,
      },
      it: {
        alt: 'Eroe',
        custom_data: { a: 1, b: 2 },
        focal_point: null,
        title: null,
      },
    });
  });

  it('supports optional create cycles and declares only invalid-draft shells', () => {
    const schema = makeSchema('source');
    const optionalSchema = replaceTargetValidators(schema, {});
    const optionalA = makeCanonicalRecord(optionalSchema, RECORD_A, {
      target: RECORD_B,
    });
    const optionalB = makeCanonicalRecord(optionalSchema, RECORD_B, {
      target: RECORD_A,
    });
    const existing = buildRecordDependencyGraph(
      { [RECORD_A]: optionalA, [RECORD_B]: optionalB },
      optionalSchema,
      [],
      new Set(),
    );

    expect(existing.shellRecordIds).to.deep.equal([]);
    expect(existing.shellComponents).to.deep.equal([]);
    expect(existing.temporarySeedRecordIds).to.deep.equal([]);
    expect(existing.updateOrder).to.have.members([RECORD_A, RECORD_B]);
    expect(existing.createOrder).to.deep.equal([]);

    const optionalCreates = buildRecordDependencyGraph(
      { [RECORD_A]: optionalA, [RECORD_B]: optionalB },
      optionalSchema,
    );
    expect(optionalCreates.shellRecordIds).to.deep.equal([]);
    expect(optionalCreates.shellComponents).to.deep.equal([]);
    expect(optionalCreates.createOrder).to.have.members([RECORD_A, RECORD_B]);
    expect(optionalCreates.publicationSeedOrder).to.deep.equal(
      optionalCreates.createOrder,
    );
    expect(optionalCreates.temporarySeedRecordIds).to.deep.equal([
      optionalCreates.createOrder[0],
    ]);

    const requiredSchema = replaceTargetValidators(schema, { required: {} });
    const requiredA = makeCanonicalRecord(requiredSchema, RECORD_A, {
      target: RECORD_B,
    });
    const requiredB = makeCanonicalRecord(requiredSchema, RECORD_B, {
      target: RECORD_A,
    });

    const requiredCreates = buildRecordDependencyGraph(
      { [RECORD_A]: requiredA, [RECORD_B]: requiredB },
      requiredSchema,
    );
    expect(requiredCreates.shellRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(requiredCreates.shellComponents).to.deep.equal([
      [RECORD_A, RECORD_B].sort(),
    ]);
    expect(requiredCreates.publicationSeedOrder).to.deep.equal([]);
    expect(requiredCreates.createOrder).to.have.members([RECORD_A, RECORD_B]);
    expect(requiredCreates.temporarySeedRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );

    const strictRequiredSchema = setInvalidDraftSaving(requiredSchema, false);
    const strictRequiredA = makeCanonicalRecord(
      strictRequiredSchema,
      RECORD_A,
      { target: RECORD_B },
    );
    const strictRequiredB = makeCanonicalRecord(
      strictRequiredSchema,
      RECORD_B,
      { target: RECORD_A },
    );
    expect(() =>
      buildRecordDependencyGraph(
        { [RECORD_A]: strictRequiredA, [RECORD_B]: strictRequiredB },
        strictRequiredSchema,
      ),
    ).to.throw(ContentDiffError, 'not every model allows');

    const selfReference = makeCanonicalRecord(optionalSchema, RECORD_A, {
      target: RECORD_A,
    });
    const selfGraph = buildRecordDependencyGraph(
      { [RECORD_A]: selfReference },
      optionalSchema,
    );
    expect(selfGraph.shellRecordIds).to.deep.equal([RECORD_A]);
    expect(selfGraph.shellComponents).to.deep.equal([[RECORD_A]]);

    const strictOptionalSchema = setInvalidDraftSaving(optionalSchema, false);
    const strictOptionalA = makeCanonicalRecord(
      strictOptionalSchema,
      RECORD_A,
      { target: RECORD_B },
    );
    const strictOptionalB = makeCanonicalRecord(
      strictOptionalSchema,
      RECORD_B,
      { target: RECORD_A },
    );
    const strictOptionalGraph = buildRecordDependencyGraph(
      { [RECORD_A]: strictOptionalA, [RECORD_B]: strictOptionalB },
      strictOptionalSchema,
    );
    expect(strictOptionalGraph.shellRecordIds).to.deep.equal([]);
    expect(strictOptionalGraph.createOrder).to.have.members([
      RECORD_A,
      RECORD_B,
    ]);
    expect(strictOptionalGraph.temporarySeedRecordIds).to.deep.equal([
      strictOptionalGraph.createOrder[0],
    ]);

    const strictOptionalRecords = {
      [RECORD_A]: strictOptionalA,
      [RECORD_B]: strictOptionalB,
    };
    const strictOptionalPlan = buildContentDiffPlan(
      makeSnapshot(strictOptionalSchema, strictOptionalRecords),
      makeSnapshot({ ...strictOptionalSchema, environmentId: 'target' }, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        invalidContentDiagnostics: validCreateCycleDiagnostics(
          strictOptionalRecords,
          strictOptionalSchema,
        ),
      },
    );
    expect(strictOptionalPlan.execution.shellRecordIds).to.deep.equal([]);
    expect(strictOptionalPlan.requiredPermissions.itemTypes).to.deep.equal([
      { id: MODEL_ID, actions: ['read', 'create', 'update'] },
    ]);
    const strictSelfReference = makeCanonicalRecord(
      strictOptionalSchema,
      RECORD_A,
      { target: RECORD_A },
    );
    expect(() =>
      buildRecordDependencyGraph(
        { [RECORD_A]: strictSelfReference },
        strictOptionalSchema,
      ),
    ).to.throw(ContentDiffError, 'does not allow saving an invalid draft');

    const targetSchema = { ...requiredSchema, environmentId: 'target' };
    const requiredPlan = buildContentDiffPlan(
      makeSnapshot(requiredSchema, {
        [RECORD_A]: requiredA,
        [RECORD_B]: requiredB,
      }),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(requiredPlan.execution.shellRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(requiredPlan.execution.shellComponents).to.deep.equal([
      [RECORD_A, RECORD_B].sort(),
    ]);
    expect(requiredPlan.requiredPermissions.itemTypes).to.deep.equal([
      { id: MODEL_ID, actions: ['read', 'create', 'update'] },
    ]);

    const safePublishedSeedA = makeCanonicalRecordWithPublished(
      requiredSchema,
      RECORD_A,
      { target: RECORD_B },
      { target: RECORD_B },
    );
    const safePublishedSeedB = makeCanonicalRecordWithPublished(
      requiredSchema,
      RECORD_B,
      { target: RECORD_A },
      { target: RECORD_C },
    );
    const safePublishedSeeds = buildRecordDependencyGraph(
      {
        [RECORD_A]: safePublishedSeedA,
        [RECORD_B]: safePublishedSeedB,
      },
      requiredSchema,
    );
    expect(safePublishedSeeds.createOrder).to.deep.equal([RECORD_B, RECORD_A]);
    expect(safePublishedSeeds.shellRecordIds).to.deep.equal([]);
    expect(safePublishedSeeds.temporarySeedRecordIds).to.deep.equal([]);
  });

  it('keeps required one-way dependencies outside each exact create-shell SCC', () => {
    const schema = addRequiredUpstreamField(
      replaceTargetValidators(makeSchema('source'), { required: {} }),
    );
    const targetSchema = { ...schema, environmentId: 'target' };
    const records = {
      [RECORD_A]: makeCanonicalRecord(schema, RECORD_A, {
        target: RECORD_B,
        upstream: RECORD_B,
      }),
      [RECORD_B]: makeCanonicalRecord(schema, RECORD_B, {
        target: RECORD_A,
        upstream: RECORD_A,
      }),
      [RECORD_C]: makeCanonicalRecord(schema, RECORD_C, {
        target: RECORD_D,
        upstream: RECORD_A,
      }),
      [RECORD_D]: makeCanonicalRecord(schema, RECORD_D, {
        target: RECORD_C,
        upstream: RECORD_B,
      }),
    };

    const graph = buildRecordDependencyGraph(records, schema);
    const expectedComponents = [
      [RECORD_A, RECORD_B].sort(),
      [RECORD_C, RECORD_D].sort(),
    ].sort((left, right) => left.join(',').localeCompare(right.join(',')));
    expect(graph.shellComponents).to.deep.equal(expectedComponents);
    expect(graph.shellRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B, RECORD_C, RECORD_D].sort(),
    );
    expect(
      Math.max(
        graph.createOrder.indexOf(RECORD_A),
        graph.createOrder.indexOf(RECORD_B),
      ),
    ).to.be.lessThan(
      Math.min(
        graph.createOrder.indexOf(RECORD_C),
        graph.createOrder.indexOf(RECORD_D),
      ),
    );

    const plan = buildContentDiffPlan(
      makeSnapshot(schema, records),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(plan.execution.shellComponents).to.deep.equal(expectedComponents);
    expect(plan.execution.createOrder).to.deep.equal(graph.createOrder);
  });

  it('plans relaxed shells for required references inside nested Structured Text', () => {
    const sourceSchema = setInvalidDraftSaving(
      makeNestedStructuredTextSchema('source'),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceAFields = {
      title: { en: 'A' },
      blocks: structuredTextWithBlock(BLOCK_ID, RECORD_B),
    };
    const sourceBFields = {
      title: { en: 'B' },
      blocks: structuredTextWithBlock(RECORD_C, RECORD_A),
    };
    const sourceA = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      sourceAFields,
      sourceAFields,
    );
    const sourceB = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      sourceBFields,
      sourceBFields,
    );
    const records = { [RECORD_A]: sourceA, [RECORD_B]: sourceB };
    const references = Object.values(records).flatMap((record) =>
      collectRecordReferences(record, sourceSchema),
    );
    expect([
      ...new Set(references.map(({ toRecordId }) => toRecordId)),
    ]).to.have.members([RECORD_A, RECORD_B]);

    const candidates = collectCreateCycleShellCandidates(
      records,
      sourceSchema,
      new Set([RECORD_A, RECORD_B]),
    );
    expect(candidates.map(({ recordId }) => recordId)).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    for (const candidate of candidates) {
      const removedId = candidate.recordId === RECORD_A ? RECORD_B : RECORD_A;
      expect(stableStringify(candidate.fields)).not.to.contain(removedId);
    }

    const defaultPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, records),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      defaultPlan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());

    const invalidDefaultPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: markCurrentAndPublishedInvalid(sourceA),
        [RECORD_B]: markCurrentAndPublishedInvalid(sourceB),
      }),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    for (const skipped of invalidDefaultPlan.invalidContent.skippedRecords) {
      expect(skipped.reasons.map(({ code }) => code)).to.include.members([
        'INVALID_PUBLISHED',
        'REQUIRED_REFERENCE_CYCLE',
      ]);
      expect(
        skipped.reasons.some(
          ({ code, slice, dependencyChain }) =>
            code === 'REQUIRED_REFERENCE_CYCLE' &&
            slice === 'intermediate' &&
            stableStringify(dependencyChain) ===
              stableStringify([RECORD_A, RECORD_B].sort()),
        ),
      ).to.equal(true);
    }

    const migratedPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, records),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: candidates.map((candidate) => ({
          recordId: candidate.recordId,
          slice: 'intermediate',
          versionHash: candidate.versionHash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_REQUIRED',
              fieldId: 'field-block-target',
              details: {},
            },
            {
              code: 'VALIDATION_LENGTH',
              fieldId: 'field-block-target',
              details: {},
            },
          ],
        })),
      },
    );
    expect(migratedPlan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(migratedPlan.execution.shellRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(migratedPlan.execution.publicationSeedOrder).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(migratedPlan.execution.revalidateBeforePublishIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(migratedPlan.invalidContent.validatorRelaxations).to.have.length(1);
    expect(migratedPlan.invalidContent.validatorRelaxations[0]).to.include({
      fieldId: 'field-block-target',
      itemTypeId: BLOCK_MODEL_ID,
    });
    expect(
      migratedPlan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['length', 'required']);
    expect(
      migratedPlan.invalidContent.validatorRelaxations[0].relaxedValidators,
    ).to.deep.equal({
      structured_text_links: { item_types: [MODEL_ID] },
    });
  });

  it('follows only document children in custom Structured Text while retaining real nested blocks', () => {
    const baseSchema = makeSchema('source');
    const sourceSchema: SchemaSnapshot = {
      ...baseSchema,
      itemTypes: baseSchema.itemTypes.map((itemType) => ({
        ...itemType,
        fields: itemType.fields.map((field) =>
          itemType.id === MODEL_ID && field.apiKey === 'blocks'
            ? {
                ...field,
                fieldType: 'structured_text' as const,
                validators: {
                  structured_text_blocks: { item_types: [BLOCK_MODEL_ID] },
                  structured_text_links: { item_types: [MODEL_ID] },
                },
              }
            : field,
        ),
      })),
      digest: '',
    };
    sourceSchema.digest = computeSchemaDigest(sourceSchema);
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const customStructuredText = (targetId: string, blockId: string) => ({
      schema: 'custom-content-v1',
      document: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'inlineItem', item: targetId },
              {
                type: 'itemLink',
                item: targetId,
                children: [{ type: 'span', value: 'retained label' }],
              },
            ],
          },
          { type: 'block', item: makeRawBlock(blockId, targetId) },
        ],
        sidecar: { type: 'inlineItem', item: RECORD_D },
      },
    });
    const records = {
      [RECORD_A]: makeCanonicalRecord(sourceSchema, RECORD_A, {
        title: { en: 'A' },
        blocks: customStructuredText(RECORD_B, BLOCK_ID),
        target: null,
      }),
      [RECORD_B]: makeCanonicalRecord(sourceSchema, RECORD_B, {
        title: { en: 'B' },
        blocks: customStructuredText(RECORD_A, RECORD_C),
        target: null,
      }),
    };

    for (const [recordId, record] of Object.entries(records)) {
      const expectedTarget = recordId === RECORD_A ? RECORD_B : RECORD_A;
      const references = collectRecordReferences(record, sourceSchema);
      expect(
        new Set(references.map(({ toRecordId }) => toRecordId)),
      ).to.deep.equal(new Set([expectedTarget]));
      expect(
        references.some(({ toRecordId }) => toRecordId === RECORD_D),
      ).to.equal(false);
    }
    expect(
      Object.keys(buildBlockOwnershipIndex(records, sourceSchema)),
    ).to.have.members([BLOCK_ID, RECORD_C]);

    const candidates = collectCreateCycleShellCandidates(
      records,
      sourceSchema,
      new Set([RECORD_A, RECORD_B]),
    );
    expect(candidates.map(({ recordId }) => recordId)).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    for (const candidate of candidates) {
      const body = candidate.fields.blocks as any;
      expect(body.document.sidecar).to.deep.equal({
        type: 'inlineItem',
        item: RECORD_D,
      });
      expect(stableStringify(body.document.children)).not.to.contain(
        candidate.recordId === RECORD_A ? RECORD_B : RECORD_A,
      );
      expect(body.document.children[0].children).to.deep.equal([
        { type: 'span', value: 'retained label' },
      ]);
      expect(body.document.children[1].item.attributes.target).to.equal(null);
    }

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, records),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(plan.records.map(({ id }) => id)).to.have.members([
      RECORD_A,
      RECORD_B,
    ]);
  });

  it('updates Structured Text metadata without treating new item-shaped sidecars as fresh blocks', () => {
    const baseSchema = makeSchema('source');
    const sourceSchema: SchemaSnapshot = {
      ...baseSchema,
      itemTypes: baseSchema.itemTypes.map((itemType) => ({
        ...itemType,
        fields: itemType.fields.map((field) =>
          itemType.id === MODEL_ID && field.apiKey === 'blocks'
            ? {
                ...field,
                fieldType: 'structured_text' as const,
                validators: {},
              }
            : field,
        ),
      })),
    };
    sourceSchema.digest = computeSchemaDigest(sourceSchema);
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const content = {
      schema: 'custom-content-v1',
      document: { type: 'root', children: [] },
    };
    const sourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'A' },
      target: null,
      blocks: {
        ...content,
        sidecar: makeRawBlock(BLOCK_ID, RECORD_B),
      },
    });
    const targetRecord = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'A' },
      target: null,
      blocks: content,
    });

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetRecord }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.records[0].action).to.equal('update');
    expect(plan.records[0].desired?.current.fields.blocks).to.deep.equal(
      sourceRecord.current.fields.blocks,
    );
  });

  it('treats a Structured Text length minimum as a required cycle edge', () => {
    const schemaWithRequired = setInvalidDraftSaving(
      makeNestedStructuredTextSchema('source'),
      false,
    );
    const sourceSchema: SchemaSnapshot = {
      ...schemaWithRequired,
      itemTypes: schemaWithRequired.itemTypes.map((itemType) => ({
        ...itemType,
        fields: itemType.fields.map((field) => {
          if (
            itemType.id !== BLOCK_MODEL_ID ||
            field.id !== 'field-block-target'
          ) {
            return field;
          }
          const { required: _required, ...validators } = field.validators;
          return { ...field, validators };
        }),
      })),
      digest: '',
    };
    sourceSchema.digest = computeSchemaDigest(sourceSchema);
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = makeCanonicalRecord(sourceSchema, RECORD_A, {
      blocks: structuredTextWithBlock(BLOCK_ID, RECORD_B),
    });
    const sourceB = makeCanonicalRecord(sourceSchema, RECORD_B, {
      blocks: structuredTextWithBlock(RECORD_C, RECORD_A),
    });
    const records = { [RECORD_A]: sourceA, [RECORD_B]: sourceB };
    const candidates = collectCreateCycleShellCandidates(
      records,
      sourceSchema,
      new Set([RECORD_A, RECORD_B]),
    );

    const defaultPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, records),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      defaultPlan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());

    const migratedPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, records),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: candidates.map((candidate) => ({
          recordId: candidate.recordId,
          slice: 'intermediate',
          versionHash: candidate.versionHash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_LENGTH',
              fieldId: 'field-block-target',
              details: {},
            },
          ],
        })),
      },
    );
    expect(migratedPlan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(
      migratedPlan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['length']);
    expect(
      migratedPlan.invalidContent.validatorRelaxations[0].originalValidators,
    ).not.to.have.property('size');
  });

  it('plans deterministic unlink releases for optional deletion cycles', () => {
    const sourceSchema = replaceTargetValidators(makeSchema('source'), {});
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetA = makeCanonicalRecord(targetSchema, RECORD_A, {
      target: RECORD_B,
    });
    const targetB = makeCanonicalRecord(targetSchema, RECORD_B, {
      target: RECORD_A,
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetA,
        [RECORD_B]: targetB,
      }),
      { includeDeletions: true, uploads: 'referenced' },
    );

    expect(plan.execution.deleteReleases).to.deep.equal(
      [RECORD_A, RECORD_B].sort().map((recordId) => ({
        recordId,
        fields: {
          target: null,
        },
        intermediateCurrentHash: semanticHash({ target: null }),
        publish: false,
        transientNestedBlockIds: [],
      })),
    );
    expect(plan.execution.deleteOrder).to.have.members([RECORD_A, RECORD_B]);
    expect(plan.requiredPermissions.itemTypes).to.deep.equal([
      { id: MODEL_ID, actions: ['read', 'update', 'delete'] },
    ]);
    for (const recordPlan of plan.records) {
      expect(recordPlan.allowedIntermediateHashes).to.include(
        semanticHash({ target: null }),
      );
    }

    const requiredSourceSchema = replaceTargetValidators(makeSchema('source'), {
      required: {},
    });
    const requiredTargetSchema = {
      ...requiredSourceSchema,
      environmentId: 'target',
    };
    const requiredTargetA = makeCanonicalRecord(
      requiredTargetSchema,
      RECORD_A,
      { target: RECORD_B },
    );
    const requiredTargetB = makeCanonicalRecord(
      requiredTargetSchema,
      RECORD_B,
      { target: RECORD_A },
    );

    const requiredTarget = makeSnapshot(requiredTargetSchema, {
      [RECORD_A]: requiredTargetA,
      [RECORD_B]: requiredTargetB,
    });
    const defaultRequiredPlan = buildContentDiffPlan(
      makeSnapshot(requiredSourceSchema, {}),
      requiredTarget,
      { includeDeletions: true, uploads: 'referenced' },
    );
    expect(defaultRequiredPlan.records).to.deep.equal([]);
    expect(
      defaultRequiredPlan.invalidContent.skippedRecords.map(
        ({ id, disposition }) => ({ id, disposition }),
      ),
    ).to.deep.equal(
      [RECORD_A, RECORD_B].sort().map((id) => ({
        id,
        disposition: 'preserve_target',
      })),
    );
    expect(defaultRequiredPlan.summary.invalidContent).to.include({
      status: 'partial',
      detectedRecords: 2,
      migratedRecords: 0,
      skippedRecords: 2,
    });
    expect(
      defaultRequiredPlan.targetPreconditions?.desiredRecordIds,
    ).to.deep.equal([RECORD_A, RECORD_B].sort());

    const nativeDraftRequiredPlan = buildContentDiffPlan(
      makeSnapshot(requiredSourceSchema, {}),
      requiredTarget,
      {
        includeDeletions: true,
        uploads: 'referenced',
        migrateInvalidContent: true,
      },
    );
    expect(nativeDraftRequiredPlan.invalidContent.skippedRecords).to.deep.equal(
      [],
    );
    expect(
      nativeDraftRequiredPlan.invalidContent.validatorRelaxations,
    ).to.deep.equal([]);
    expect(
      nativeDraftRequiredPlan.invalidContent.migratedRecordIds,
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(nativeDraftRequiredPlan.execution.deleteReleases).to.deep.equal(
      [RECORD_A, RECORD_B].sort().map((recordId) => ({
        recordId,
        fields: { target: null },
        intermediateCurrentHash: semanticHash({ target: null }),
        publish: false,
        transientNestedBlockIds: [],
      })),
    );
  });

  it('relaxes only the diagnosed required validator for strict required deletion SCCs', () => {
    const sourceSchema = setInvalidDraftSaving(
      replaceTargetValidators(makeSchema('source'), { required: {} }),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetRecords = {
      [RECORD_A]: makeCanonicalRecord(targetSchema, RECORD_A, {
        target: RECORD_B,
      }),
      [RECORD_B]: makeCanonicalRecord(targetSchema, RECORD_B, {
        target: RECORD_A,
      }),
    };
    const target = makeSnapshot(targetSchema, targetRecords);
    const candidates = collectRequiredDeletionCycleReleaseCandidates(
      targetRecords,
      targetSchema,
    );
    expect(candidates).to.have.length(1);
    expect(candidates[0].unsupportedPaths).to.deep.equal([]);

    const plan = buildContentDiffPlan(makeSnapshot(sourceSchema, {}), target, {
      includeDeletions: true,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: candidates[0].releases.map((release) => ({
        recordId: release.recordId,
        slice: 'intermediate',
        versionHash: release.intermediateCurrentHash,
        valid: false,
        issues: [
          {
            code: 'VALIDATION_REQUIRED',
            fieldId: 'field-target',
            details: {},
          },
        ],
      })),
    });

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.execution.deleteReleases).to.deep.equal(candidates[0].releases);
    expect(plan.invalidContent.validatorRelaxations).to.have.length(1);
    expect(plan.invalidContent.validatorRelaxations[0]).to.include({
      fieldId: 'field-target',
    });
    expect(
      plan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['required']);
    expect(
      plan.invalidContent.validatorRelaxations[0].affectedRecordIds,
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(plan.requiredPermissions.editSchema).to.equal(true);
    expect(plan.requiredPermissions.itemTypes).to.deep.equal([
      {
        id: MODEL_ID,
        actions: ['read', 'update', 'delete'],
      },
    ]);
  });

  it('preserves published nested-block deletion SCCs whose unlink state needs fresh block IDs', () => {
    const sourceSchema = setInvalidDraftSaving(
      makeNestedStructuredTextSchema('source'),
      false,
    );
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetRecords = {
      [RECORD_A]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_A,
        { blocks: structuredTextWithBlock(BLOCK_ID, RECORD_B) },
        { blocks: structuredTextWithBlock(BLOCK_ID, RECORD_B) },
      ),
      [RECORD_B]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_B,
        { blocks: structuredTextWithBlock(RECORD_C, RECORD_A) },
        { blocks: structuredTextWithBlock(RECORD_C, RECORD_A) },
      ),
    };
    const candidates = collectRequiredDeletionCycleReleaseCandidates(
      targetRecords,
      targetSchema,
    );
    expect(candidates).to.have.length(1);
    expect(
      collectRequiredDeletionCycleReleaseCandidates(
        targetRecords,
        targetSchema,
      ),
    ).to.deep.equal(candidates);
    expect(candidates[0].releases.every(({ publish }) => publish)).to.equal(
      true,
    );
    const originalPublishedBlockIds = new Set([BLOCK_ID, RECORD_C]);
    const transientIds = candidates[0].releases.flatMap(
      ({ fields, transientNestedBlockIds }) => {
        expect(transientNestedBlockIds).to.have.length(1);
        expect(transientNestedBlockIds.every(isPortableDatoId)).to.equal(true);
        const serialized = stableStringify(fields);
        for (const id of transientNestedBlockIds) {
          expect(serialized).to.include(id);
          expect(originalPublishedBlockIds.has(id)).to.equal(false);
        }
        for (const id of originalPublishedBlockIds) {
          expect(serialized).not.to.include(id);
        }
        return transientNestedBlockIds;
      },
    );
    expect(new Set(transientIds).size).to.equal(transientIds.length);
    const collisionReserved = collectRequiredDeletionCycleReleaseCandidates(
      targetRecords,
      targetSchema,
      { reservedItemIds: new Set([transientIds[0]]) },
    );
    expect(
      collisionReserved[0].releases.flatMap(
        ({ transientNestedBlockIds }) => transientNestedBlockIds,
      ),
    ).not.to.include(transientIds[0]);
    expect(
      collectRequiredDeletionCycleReleaseCandidates(
        targetRecords,
        targetSchema,
        { reservedItemIds: new Set([transientIds[0]]) },
      ),
    ).to.deep.equal(collisionReserved);
    expect(
      candidates[0].releases.every(
        ({ fields }) =>
          !stableStringify(fields).includes(RECORD_A) &&
          !stableStringify(fields).includes(RECORD_B),
      ),
    ).to.equal(true);
    expect(
      candidates[0].releases.every(({ fields }) =>
        stableStringify(fields).includes('field-block-target')
          ? false
          : stableStringify(fields).includes('item_type'),
      ),
    ).to.equal(true);
    for (const release of candidates[0].releases) {
      const nestedBody = (
        (
          (release.fields.blocks as Record<string, any>).document.children[0]
            .item as Record<string, any>
        ).attributes as Record<string, any>
      ).target as Record<string, any>;
      expect(nestedBody).to.deep.equal(
        makeDast([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: '' }],
          },
        ]),
      );
    }

    const defaultPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, targetRecords),
      { includeDeletions: true, uploads: 'referenced' },
    );
    expect(
      defaultPlan.invalidContent.skippedRecords.map(({ id, reasons }) => ({
        id,
        reasonCodes: reasons.map(({ code }) => code).sort(),
      })),
    ).to.deep.equal(
      [RECORD_A, RECORD_B].sort().map((id) => ({
        id,
        reasonCodes: [
          'REQUIRED_REFERENCE_CYCLE',
          'UNSUPPORTED_PUBLISHED_BLOCK_RELEASE',
        ],
      })),
    );

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, targetRecords),
      {
        includeDeletions: true,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: candidates[0].releases.map((release) => ({
          recordId: release.recordId,
          slice: 'intermediate',
          versionHash: release.intermediateCurrentHash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_REQUIRED',
              fieldId: 'field-block-target',
              details: {},
            },
            {
              code: 'VALIDATION_LENGTH',
              fieldId: 'field-block-target',
              details: {},
            },
          ],
        })),
      },
    );

    expect(plan.records).to.deep.equal([]);
    expect(plan.execution.deleteReleases).to.deep.equal([]);
    expect(plan.execution.revalidateBeforePublishIds).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(
        ({ id, disposition, reasons }) => ({
          id,
          disposition,
          reasonCodes: reasons.map(({ code }) => code),
        }),
      ),
    ).to.deep.equal(
      [RECORD_A, RECORD_B].sort().map((id) => ({
        id,
        disposition: 'preserve_target',
        reasonCodes: ['UNSUPPORTED_PUBLISHED_BLOCK_RELEASE'],
      })),
    );
    expect(plan.summary.invalidContent).to.include({
      status: 'partial',
      detectedRecords: 2,
      migratedRecords: 0,
      skippedRecords: 2,
    });
    expect(plan.targetPreconditions?.desiredRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(plan.requiredPermissions.editSchema).to.equal(false);
  });

  it('preserves optional published nested-block deletion SCCs before artifact generation', () => {
    const base = makeNestedStructuredTextSchema('source');
    const sourceSchema = withRecomputedSchemaDigest({
      ...base,
      itemTypes: base.itemTypes.map((itemType) => ({
        ...itemType,
        fields: itemType.fields.map((field) =>
          itemType.id === BLOCK_MODEL_ID && field.id === 'field-block-target'
            ? {
                ...field,
                validators: {
                  structured_text_links: { item_types: [MODEL_ID] },
                },
              }
            : field,
        ),
      })),
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetRecords = {
      [RECORD_A]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_A,
        { blocks: structuredTextWithBlock(BLOCK_ID, RECORD_B) },
        { blocks: structuredTextWithBlock(BLOCK_ID, RECORD_B) },
      ),
      [RECORD_B]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_B,
        { blocks: structuredTextWithBlock(RECORD_C, RECORD_A) },
        { blocks: structuredTextWithBlock(RECORD_C, RECORD_A) },
      ),
    };

    expect(
      collectRequiredDeletionCycleReleaseCandidates(
        targetRecords,
        targetSchema,
      ),
    ).to.deep.equal([]);
    expect(
      collectUnsupportedPublishedNestedDeletionComponents(
        targetRecords,
        targetSchema,
      ),
    ).to.deep.equal([[RECORD_A, RECORD_B].sort()]);

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, targetRecords),
      { includeDeletions: true, uploads: 'referenced' },
    );

    expect(plan.records).to.deep.equal([]);
    expect(plan.execution.deleteReleases).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(
        ({ id, disposition, reasons }) => ({
          id,
          disposition,
          reasonCodes: reasons.map(({ code }) => code),
        }),
      ),
    ).to.deep.equal(
      [RECORD_A, RECORD_B].sort().map((id) => ({
        id,
        disposition: 'preserve_target',
        reasonCodes: ['UNSUPPORTED_PUBLISHED_BLOCK_RELEASE'],
      })),
    );
  });

  it('projects localized links and Structured Text item references canonically for required deletion SCCs', () => {
    const base = setInvalidDraftSaving(makeSchema('source'), false);
    const sourceSchema = withRecomputedSchemaDigest({
      ...base,
      itemTypes: base.itemTypes.map((itemType) =>
        itemType.id !== MODEL_ID
          ? itemType
          : {
              ...itemType,
              fields: itemType.fields.map((field) =>
                field.id !== 'field-target'
                  ? field
                  : {
                      ...field,
                      fieldType: 'structured_text',
                      localized: true,
                      validators: {
                        required: {},
                        length: { min: 1 },
                        structured_text_links: { item_types: [MODEL_ID] },
                      },
                    },
              ),
            },
      ),
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const structuredReferences = (recordId: string) => ({
      en: makeDast([
        {
          type: 'paragraph',
          children: [{ type: 'inlineItem', item: recordId }],
        },
      ]),
      it: makeDast([
        {
          type: 'paragraph',
          children: [
            {
              type: 'itemLink',
              item: recordId,
              children: [{ type: 'span', value: 'peer' }],
            },
          ],
        },
      ]),
    });
    const targetRecords = {
      [RECORD_A]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_A,
        { target: structuredReferences(RECORD_B) },
        { target: structuredReferences(RECORD_B) },
      ),
      [RECORD_B]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_B,
        { target: structuredReferences(RECORD_A) },
        { target: structuredReferences(RECORD_A) },
      ),
    };
    const candidates = collectRequiredDeletionCycleReleaseCandidates(
      targetRecords,
      targetSchema,
    );
    expect(candidates).to.have.length(1);
    for (const release of candidates[0].releases) {
      const serialized = stableStringify(release.fields);
      expect(serialized).not.to.include(RECORD_A);
      expect(serialized).not.to.include(RECORD_B);
      expect((release.fields.target as Record<string, any>).en.schema).to.equal(
        'dast',
      );
      expect((release.fields.target as Record<string, any>).it.schema).to.equal(
        'dast',
      );
      expect((release.fields.target as Record<string, any>).en).to.deep.equal(
        makeDast([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: '' }],
          },
        ]),
      );
      expect((release.fields.target as Record<string, any>).it).to.deep.equal(
        makeDast([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: 'peer' }],
          },
        ]),
      );
    }

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, targetRecords),
      {
        includeDeletions: true,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: candidates[0].releases.map((release) => ({
          recordId: release.recordId,
          slice: 'intermediate',
          versionHash: release.intermediateCurrentHash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_REQUIRED',
              fieldId: 'field-target',
              details: {},
            },
            {
              code: 'VALIDATION_LENGTH',
              fieldId: 'field-target',
              details: {},
            },
          ],
        })),
      },
    );
    expect(plan.invalidContent.validatorRelaxations[0]).to.deep.include({
      fieldId: 'field-target',
      relaxedValidatorKeys: ['length', 'required'],
      relaxedValidators: {
        structured_text_links: { item_types: [MODEL_ID] },
      },
    });
    expect(
      plan.invalidContent.validatorRelaxations[0].originalValidators,
    ).to.deep.equal({
      required: {},
      length: { min: 1 },
      structured_text_links: { item_types: [MODEL_ID] },
    });
  });

  it('retains itemLink child text without relaxing valid Structured Text deletion releases', () => {
    const base = setInvalidDraftSaving(makeSchema('source'), false);
    const sourceSchema = withRecomputedSchemaDigest({
      ...base,
      itemTypes: base.itemTypes.map((itemType) =>
        itemType.id !== MODEL_ID
          ? itemType
          : {
              ...itemType,
              fields: itemType.fields.map((field) =>
                field.id !== 'field-target'
                  ? field
                  : {
                      ...field,
                      fieldType: 'structured_text',
                      localized: true,
                      validators: {
                        required: {},
                        length: { min: 1 },
                        structured_text_links: { item_types: [MODEL_ID] },
                      },
                    },
              ),
            },
      ),
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const retainedReferences = (recordId: string) => ({
      en: makeDast([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'safe ' },
            { type: 'inlineItem', item: recordId },
            {
              type: 'itemLink',
              item: recordId,
              children: [{ type: 'span', value: 'peer' }],
            },
          ],
        },
      ]),
      it: makeDast([
        {
          type: 'paragraph',
          children: [
            {
              type: 'itemLink',
              item: recordId,
              children: [{ type: 'span', value: 'collega' }],
            },
          ],
        },
      ]),
    });
    const targetRecords = {
      [RECORD_A]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_A,
        { target: retainedReferences(RECORD_B) },
        { target: retainedReferences(RECORD_B) },
      ),
      [RECORD_B]: makeCanonicalRecordWithPublished(
        targetSchema,
        RECORD_B,
        { target: retainedReferences(RECORD_A) },
        { target: retainedReferences(RECORD_A) },
      ),
    };
    const candidates = collectRequiredDeletionCycleReleaseCandidates(
      targetRecords,
      targetSchema,
    );
    expect(candidates).to.have.length(1);
    for (const release of candidates[0].releases) {
      expect((release.fields.target as Record<string, any>).en).to.deep.equal(
        makeDast([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: 'safe peer' }],
          },
        ]),
      );
      expect((release.fields.target as Record<string, any>).it).to.deep.equal(
        makeDast([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: 'collega' }],
          },
        ]),
      );
    }

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, targetRecords),
      {
        includeDeletions: true,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: candidates[0].releases.map((release) => ({
          recordId: release.recordId,
          slice: 'intermediate',
          versionHash: release.intermediateCurrentHash,
          valid: true,
          issues: [],
        })),
      },
    );

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.execution.deleteReleases).to.deep.equal(candidates[0].releases);
  });

  it('protects uploads and ordered destination topology for a default-preserved required deletion SCC', () => {
    const base = replaceTargetValidators(makeSchema('source'), {
      required: {},
    });
    const sourceSchema = withRecomputedSchemaDigest({
      ...base,
      itemTypes: base.itemTypes.map((itemType) =>
        itemType.id === MODEL_ID ? { ...itemType, sortable: true } : itemType,
      ),
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const positioned = (
      record: RecordSnapshot,
      position: number,
    ): RecordSnapshot => ({
      ...record,
      topology: { parentId: null, position },
    });
    const targetRecords = {
      [RECORD_A]: positioned(
        makeCanonicalRecord(targetSchema, RECORD_A, {
          target: RECORD_B,
          blocks: [
            makeRawBlockWithFields(BLOCK_ID, {
              target: null,
              image: UPLOAD_ID,
            }),
          ],
        }),
        1,
      ),
      [RECORD_B]: positioned(
        makeCanonicalRecord(targetSchema, RECORD_B, {
          target: RECORD_A,
          blocks: [],
        }),
        2,
      ),
      [RECORD_C]: positioned(
        makeCanonicalRecord(targetSchema, RECORD_C, {
          target: null,
          blocks: [],
        }),
        3,
      ),
    };
    const source = makeSnapshot(sourceSchema, {});
    const target = makeSnapshot(targetSchema, targetRecords);
    source.scope.uploads = 'all';
    target.scope.uploads = 'all';
    target.uploads[UPLOAD_ID] = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: 'd41d8cd98f00b204e9800998ecf8427e',
        basename: 'protected',
        filename: 'protected.jpg',
        url: 'https://example.test/protected.jpg',
        size: 17,
        mime_type: 'image/jpeg',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          targetSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      targetSchema.locales,
    );

    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: true,
      uploads: 'all',
    });

    expect(plan.records).to.deep.equal([]);
    expect(plan.uploads).to.have.length(1);
    expect(plan.uploads[0]).to.include({ id: UPLOAD_ID, action: 'noop' });
    expect(plan.targetPreconditions?.desiredRecordIds).to.deep.equal(
      [RECORD_A, RECORD_B, RECORD_C].sort(),
    );
    expect(plan.targetPreconditions?.desiredUploadIds).to.deep.equal([
      UPLOAD_ID,
    ]);
    expect(
      plan.warnings.some(
        ({ code, entityIds }) =>
          code === 'RETAINED_TARGET_RECORD' && entityIds.includes(RECORD_C),
      ),
    ).to.equal(true);
    for (const skipped of plan.invalidContent.skippedRecords) {
      expect(skipped.sourceNestedBlockIds).to.deep.equal(
        skipped.targetNestedBlockIds,
      );
    }
  });

  it('relaxes a localized links minimum without touching its item-type validator and fails closed on mixed min/max', () => {
    const linksSchema = (includeMaximum: boolean) => {
      const base = setInvalidDraftSaving(makeSchema('source'), false);
      return withRecomputedSchemaDigest({
        ...base,
        itemTypes: base.itemTypes.map((itemType) =>
          itemType.id !== MODEL_ID
            ? itemType
            : {
                ...itemType,
                fields: itemType.fields.map((field) =>
                  field.id !== 'field-target'
                    ? field
                    : {
                        ...field,
                        fieldType: 'links',
                        localized: true,
                        validators: {
                          items_item_type: { item_types: [MODEL_ID] },
                          size: {
                            min: 1,
                            ...(includeMaximum ? { max: 3 } : {}),
                          },
                        },
                      },
                ),
              },
        ),
      });
    };
    const sourceSchema = linksSchema(false);
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetRecords = {
      [RECORD_A]: makeCanonicalRecord(targetSchema, RECORD_A, {
        target: { en: [RECORD_B], it: [RECORD_B] },
      }),
      [RECORD_B]: makeCanonicalRecord(targetSchema, RECORD_B, {
        target: { en: [RECORD_A], it: [RECORD_A] },
      }),
    };
    const candidates = collectRequiredDeletionCycleReleaseCandidates(
      targetRecords,
      targetSchema,
    );
    const diagnostics = candidates[0].releases.map((release) => ({
      recordId: release.recordId,
      slice: 'intermediate' as const,
      versionHash: release.intermediateCurrentHash,
      valid: false,
      issues: [
        {
          code: 'VALIDATION_SIZE',
          fieldId: 'field-target',
          details: {},
        },
      ],
    }));
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, targetRecords),
      {
        includeDeletions: true,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: diagnostics,
      },
    );
    expect(plan.invalidContent.validatorRelaxations[0]).to.deep.include({
      relaxedValidatorKeys: ['size'],
      relaxedValidators: {
        items_item_type: { item_types: [MODEL_ID] },
      },
    });

    const mixedSourceSchema = linksSchema(true);
    const mixedTargetSchema = {
      ...mixedSourceSchema,
      environmentId: 'target',
    };
    const mixedTargetRecords = {
      [RECORD_A]: makeCanonicalRecord(mixedTargetSchema, RECORD_A, {
        target: { en: [RECORD_B], it: [RECORD_B] },
      }),
      [RECORD_B]: makeCanonicalRecord(mixedTargetSchema, RECORD_B, {
        target: { en: [RECORD_A], it: [RECORD_A] },
      }),
    };
    const mixedCandidates = collectRequiredDeletionCycleReleaseCandidates(
      mixedTargetRecords,
      mixedTargetSchema,
    );
    const mixedPlan = buildContentDiffPlan(
      makeSnapshot(mixedSourceSchema, {}),
      makeSnapshot(mixedTargetSchema, mixedTargetRecords),
      {
        includeDeletions: true,
        uploads: 'referenced',
        migrateInvalidContent: true,
        invalidContentDiagnostics: mixedCandidates[0].releases.map(
          (release) => ({
            recordId: release.recordId,
            slice: 'intermediate',
            versionHash: release.intermediateCurrentHash,
            valid: false,
            issues: [
              {
                code: 'VALIDATION_SIZE',
                fieldId: 'field-target',
                details: {},
              },
            ],
          }),
        ),
      },
    );
    expect(mixedPlan.execution.deleteReleases).to.deep.equal([]);
    expect(mixedPlan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(
      mixedPlan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
  });

  it('publishes a safe published-derived unlink state for deletion cycles', () => {
    const sourceSchema = replaceTargetValidators(makeSchema('source'), {});
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetA = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'private-draft-a' }, target: null },
      { title: { en: 'published-a' }, target: RECORD_B },
    );
    const targetB = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'private-draft-b' }, target: null },
      { title: { en: 'published-b' }, target: RECORD_A },
    );
    const targetRecords = {
      [RECORD_A]: targetA,
      [RECORD_B]: targetB,
    };
    const candidates = collectOptionalDeletionCycleReleaseCandidates(
      targetRecords,
      targetSchema,
    );
    expect(candidates).to.have.length(1);
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {}),
      makeSnapshot(targetSchema, targetRecords),
      {
        includeDeletions: true,
        uploads: 'referenced',
        invalidContentDiagnostics: candidates[0].releases.map((release) => ({
          recordId: release.recordId,
          slice: 'intermediate',
          versionHash: release.intermediateCurrentHash,
          valid: true,
          issues: [],
        })),
      },
    );

    expect(plan.execution.deleteReleases).to.have.length(2);
    expect(plan.execution.deleteReleases).to.deep.equal(
      [
        {
          recordId: RECORD_A,
          fields: { title: { en: 'published-a' }, target: null },
          intermediateCurrentHash: semanticHash({
            title: { en: 'published-a' },
            target: null,
          }),
          publish: true,
          transientNestedBlockIds: [],
        },
        {
          recordId: RECORD_B,
          fields: { title: { en: 'published-b' }, target: null },
          intermediateCurrentHash: semanticHash({
            title: { en: 'published-b' },
            target: null,
          }),
          publish: true,
          transientNestedBlockIds: [],
        },
      ].sort((left, right) => left.recordId.localeCompare(right.recordId)),
    );
    expect(plan.requiredPermissions.itemTypes).to.deep.equal([
      { id: MODEL_ID, actions: ['read', 'update', 'publish', 'delete'] },
    ]);
  });

  it('regenerates a no-op plan for identical current duplicate claimant sets', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceRecords = Object.fromEntries(
      [RECORD_A, RECORD_B].map((recordId, index) => [
        recordId,
        markCurrentInvalid(
          makeCanonicalRecord(sourceSchema, recordId, {
            title: { en: 'duplicate', it: `source-${index}` },
          }),
        ),
      ]),
    );
    const targetRecords = Object.fromEntries(
      [RECORD_A, RECORD_B].map((recordId, index) => [
        recordId,
        markCurrentInvalid(
          makeCanonicalRecord(targetSchema, recordId, {
            title: { en: 'duplicate', it: `source-${index}` },
          }),
        ),
      ]),
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, sourceRecords),
      makeSnapshot(targetSchema, targetRecords),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
      },
    );

    expect(plan.records.map(({ action }) => action)).to.deep.equal([
      'noop',
      'noop',
    ]);
    expect(plan.execution.uniqueReleases).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
  });

  it('regenerates a no-op plan for identical published duplicate claimant sets', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const makeInvalidPublishedRecords = (schema: SchemaSnapshot) =>
      Object.fromEntries(
        [RECORD_A, RECORD_B].map((recordId, index) => {
          const record = makeCanonicalRecordWithPublished(
            schema,
            recordId,
            { title: { en: `current-${index}`, it: `current-it-${index}` } },
            { title: { en: 'duplicate', it: `published-it-${index}` } },
          );

          return [
            recordId,
            {
              ...record,
              validity: { current: true, published: false },
              consistency: {
                ...record.consistency,
                currentValid: true,
                publishedValid: false,
              },
            },
          ];
        }),
      );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, makeInvalidPublishedRecords(sourceSchema)),
      makeSnapshot(targetSchema, makeInvalidPublishedRecords(targetSchema)),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: true,
      },
    );

    expect(plan.records.map(({ action }) => action)).to.deep.equal([
      'noop',
      'noop',
    ]);
    expect(plan.execution.uniqueReleases).to.deep.equal([]);
    expect(
      plan.records.flatMap(({ publishedDependencies }) =>
        publishedDependencies.filter((id) => [RECORD_A, RECORD_B].includes(id)),
      ),
    ).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
  });

  it('skips a new current claimant when an invalid target set has multiple owners', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const record = (schema: SchemaSnapshot, recordId: string) =>
      makeCanonicalRecord(schema, recordId, {
        title: { en: 'duplicate', it: recordId },
      });

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: record(sourceSchema, RECORD_A),
        [RECORD_B]: record(sourceSchema, RECORD_B),
        [RECORD_C]: record(sourceSchema, RECORD_C),
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: record(targetSchema, RECORD_A),
        [RECORD_B]: record(targetSchema, RECORD_B),
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.records.map(({ id }) => id).sort()).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(plan.records.every(({ action }) => action === 'noop')).to.equal(
      true,
    );
    expect(plan.invalidContent.skippedRecords).to.have.length(1);
    expect(plan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_C,
      disposition: 'must_remain_absent',
    });
    expect(plan.invalidContent.skippedRecords[0].reasons[0]).to.include({
      code: 'INVALID_INTERMEDIATE',
      fieldId: 'field-title',
      validatorKey: 'unique',
    });
  });

  it('fails closed when unequal published duplicate sets have ambiguous owners', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const record = (schema: SchemaSnapshot, recordId: string, index: number) =>
      makeCanonicalRecordWithPublished(
        schema,
        recordId,
        { title: { en: `current-${index}`, it: recordId } },
        { title: { en: 'published-duplicate', it: recordId } },
      );

    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, {
          [RECORD_A]: record(sourceSchema, RECORD_A, 0),
          [RECORD_B]: record(sourceSchema, RECORD_B, 1),
          [RECORD_C]: record(sourceSchema, RECORD_C, 2),
        }),
        makeSnapshot(targetSchema, {
          [RECORD_A]: record(targetSchema, RECORD_A, 0),
          [RECORD_B]: record(targetSchema, RECORD_B, 1),
        }),
        { includeDeletions: false, uploads: 'referenced' },
      ),
    ).to.throw(ContentDiffError, 'multiple destination claimants');
  });

  it('ignores whitespace-only values in current and published unique ordering', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const source = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: '   ', it: 'source-current' } },
      { title: { en: '\t', it: 'source-published' } },
    );
    const retainedTarget = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: '\n', it: 'target-current' } },
      { title: { en: '  ', it: 'target-published' } },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: source }),
      makeSnapshot(targetSchema, { [RECORD_B]: retainedTarget }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.records.find(({ id }) => id === RECORD_A)?.action).to.equal(
      'create',
    );
    expect(plan.execution.uniqueReleases).to.deep.equal([]);
  });

  it('plans deterministic pre-create releases for acyclic unique handoffs', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceOwner = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'released' },
    });
    const targetOwner = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'claimed' },
    });
    const sourceConsumer = makeCanonicalRecord(sourceSchema, RECORD_B, {
      title: { en: 'claimed' },
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceOwner,
        [RECORD_B]: sourceConsumer,
      }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetOwner }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    const intermediateHash = semanticHash({
      ...targetOwner.current.fields,
      title: sourceOwner.current.fields.title,
    });

    expect(plan.execution.uniqueReleases).to.deep.equal([
      {
        recordId: RECORD_A,
        fields: { title: { en: 'released' } },
        consumerRecordIds: [RECORD_B],
        intermediateCurrentHash: intermediateHash,
      },
    ]);
    expect(
      plan.records.find(({ id }) => id === RECORD_A)?.allowedIntermediateHashes,
    ).to.deep.equal([intermediateHash]);
    expect(plan.execution.createOrder).to.deep.equal([RECORD_B]);

    const seededConsumer = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'final-value' } },
      { title: { en: 'claimed' } },
    );
    const seededPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceOwner,
        [RECORD_B]: seededConsumer,
      }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetOwner }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(seededPlan.execution.uniqueReleases[0].recordId).to.equal(RECORD_A);
    expect(
      seededPlan.records.find(({ id }) => id === RECORD_B)?.dependencies,
    ).to.include(RECORD_A);
  });

  it('skips consumers blocked by target-only unique owners', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceConsumer = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'claimed' },
    });
    const targetOwner = makeCanonicalRecord(targetSchema, RECORD_C, {
      title: { en: 'claimed' },
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceConsumer }),
      makeSnapshot(targetSchema, { [RECORD_C]: targetOwner }),
      { includeDeletions: true, uploads: 'referenced' },
    );

    expect(plan.records).to.deep.equal([]);
    expect(plan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_A,
      disposition: 'must_remain_absent',
    });
    expect(plan.invalidContent.skippedRecords[0].reasons[0]).to.include({
      code: 'UNRELAXABLE_VALIDATOR',
      fieldId: 'field-title',
      validatorKey: 'unique',
      dependencyId: RECORD_C,
    });
    expect(plan.targetPreconditions?.desiredRecordIds).to.deep.equal([
      RECORD_C,
    ]);
    expect(plan.warnings).to.deep.include({
      code: 'RETAINED_TARGET_RECORD',
      message: `Destination-only record ${RECORD_C} is retained because skipped content still depends on it.`,
      entityIds: [RECORD_C],
    });
  });

  it('orders publications after published unique values are released', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceOwner = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'new-owner-value' } },
      { title: { en: 'new-owner-value' } },
    );
    const targetOwner = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'new-owner-value' } },
      { title: { en: 'released-published-value' } },
    );
    const sourceConsumer = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'released-published-value' } },
      { title: { en: 'released-published-value' } },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceConsumer,
        [RECORD_B]: sourceOwner,
      }),
      makeSnapshot(targetSchema, { [RECORD_B]: targetOwner }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.execution.publishOrder).to.deep.equal([RECORD_B, RECORD_A]);
    expect(
      plan.records.find(({ id }) => id === RECORD_A)?.dependencies,
    ).to.include(RECORD_B);

    const targetSwapA = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'current-a' } },
      { title: { en: 'published-a' } },
    );
    const targetSwapB = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'current-b' } },
      { title: { en: 'published-b' } },
    );
    const sourceSwapA = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'current-a' } },
      { title: { en: 'published-b' } },
    );
    const sourceSwapB = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'current-b' } },
      { title: { en: 'published-a' } },
    );
    const skippedSwap = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceSwapA,
        [RECORD_B]: sourceSwapB,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetSwapA,
        [RECORD_B]: targetSwapB,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      skippedSwap.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    expect(skippedSwap.summary.invalidContent.status).to.equal('partial');
  });

  it('orders localized published staging and current restoration around a retained unique value', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetOwner = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'shared', it: 'owner-current-it' } },
      { title: { en: 'owner-old', it: 'owner-published-it' } },
    );
    const sourceOwner = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'shared', it: 'owner-current-it' } },
      { title: { en: 'owner-new', it: 'owner-published-it' } },
    );
    const targetConsumer = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'consumer-old', it: 'consumer-published-it' } },
    );
    const sourceConsumer = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'shared', it: 'consumer-published-it' } },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceOwner,
        [RECORD_B]: sourceConsumer,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetOwner,
        [RECORD_B]: targetConsumer,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.execution.uniqueReleases).to.deep.equal([]);
    expect(plan.execution.publishOrder.indexOf(RECORD_A)).to.be.lessThan(
      plan.execution.publishOrder.indexOf(RECORD_B),
    );
    expect(plan.execution.updateOrder.indexOf(RECORD_B)).to.be.lessThan(
      plan.execution.updateOrder.indexOf(RECORD_A),
    );
  });

  it('orders phase-8 current acquisition after a published staging owner restores away', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetCurrentClaimant = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'owner-baseline', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const sourceCurrentClaimant = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'shared', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const targetPublishedStager = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'consumer-published', it: 'consumer-published-it' } },
    );
    const sourcePublishedStager = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'shared', it: 'consumer-published-it' } },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceCurrentClaimant,
        [RECORD_B]: sourcePublishedStager,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetCurrentClaimant,
        [RECORD_B]: targetPublishedStager,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.execution.updateOrder.indexOf(RECORD_B)).to.be.lessThan(
      plan.execution.updateOrder.indexOf(RECORD_A),
    );
  });

  it('detects a published staging claim created by a phase-3 unique release', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetReleaseOwner = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'released-in-phase-three', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const sourceReleaseOwner = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'shared-after-release', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const sourceReleaseConsumer = makeCanonicalRecord(sourceSchema, RECORD_C, {
      title: { en: 'released-in-phase-three', it: 'release-consumer-it' },
    });
    const targetPublishedStager = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'consumer-published', it: 'consumer-published-it' } },
    );
    const sourcePublishedStager = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'shared-after-release', it: 'consumer-published-it' } },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceReleaseOwner,
        [RECORD_B]: sourcePublishedStager,
        [RECORD_C]: sourceReleaseConsumer,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetReleaseOwner,
        [RECORD_B]: targetPublishedStager,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.execution.uniqueReleases).to.deep.include({
      recordId: RECORD_A,
      fields: { title: sourceReleaseOwner.current.fields.title },
      consumerRecordIds: [RECORD_C],
      intermediateCurrentHash: semanticHash({
        ...targetReleaseOwner.current.fields,
        title: sourceReleaseOwner.current.fields.title,
      }),
    });
    expect(plan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_B,
      disposition: 'preserve_target',
    });
    expect(plan.invalidContent.skippedRecords[0].reasons[0]).to.include({
      code: 'INVALID_INTERMEDIATE',
      dependencyId: RECORD_A,
      fieldId: 'field-title',
      validatorKey: 'unique',
    });
  });

  it('skips an unpublished create seed when its target owner is preserved', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetOwner = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'shared', it: 'owner-it' },
    });
    const sourceOwner = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'released', it: 'owner-it' },
    });
    const sourceDraft = makeCanonicalRecord(sourceSchema, RECORD_B, {
      title: { en: 'shared', it: 'draft-it' },
    });
    const source = makeSnapshot(sourceSchema, {
      [RECORD_A]: sourceOwner,
      [RECORD_B]: sourceDraft,
    });
    source.missingUploadReferences = { [RECORD_A]: [UPLOAD_ID] };

    const plan = buildContentDiffPlan(
      source,
      makeSnapshot(targetSchema, { [RECORD_A]: targetOwner }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.records).to.deep.equal([]);
    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id).sort(),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    const draftSkip = plan.invalidContent.skippedRecords.find(
      ({ id }) => id === RECORD_B,
    );
    expect(draftSkip).to.include({ disposition: 'must_remain_absent' });
    expect(draftSkip?.reasons[0]).to.include({
      code: 'INVALID_INTERMEDIATE',
      fieldId: 'field-title',
      validatorKey: 'unique',
      dependencyId: RECORD_A,
    });
  });

  it('skips a cyclic phase-8 current restoration across published slices', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetA = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'baseline-a', it: 'current-a-it' } },
      { title: { en: 'published-a', it: 'published-a-it' } },
    );
    const targetB = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'baseline-b', it: 'current-b-it' } },
      { title: { en: 'published-b', it: 'published-b-it' } },
    );
    const sourceA = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'restored-a', it: 'current-a-it' } },
      { title: { en: 'restored-b', it: 'published-a-it' } },
    );
    const sourceB = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'restored-b', it: 'current-b-it' } },
      { title: { en: 'restored-a', it: 'published-b-it' } },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceA, [RECORD_B]: sourceB }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetA, [RECORD_B]: targetB }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(
      plan.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
    for (const skipped of plan.invalidContent.skippedRecords) {
      expect(
        skipped.reasons.some(({ code }) => code === 'INVALID_INTERMEDIATE'),
      ).to.equal(true);
    }
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
  });

  it('skips or minimally relaxes an unorderable localized published staging claim', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetOwner = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'shared', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const sourceOwner = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'shared', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const targetConsumer = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'consumer-published', it: 'consumer-published-it' } },
    );
    const sourceConsumer = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'shared', it: 'consumer-published-it' } },
    );
    const source = makeSnapshot(sourceSchema, {
      [RECORD_A]: sourceOwner,
      [RECORD_B]: sourceConsumer,
    });
    const target = makeSnapshot(targetSchema, {
      [RECORD_A]: targetOwner,
      [RECORD_B]: targetConsumer,
    });

    const defaultPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
    });

    expect(defaultPlan.records.map(({ id }) => id)).to.deep.equal([RECORD_A]);
    expect(defaultPlan.records[0].action).to.equal('noop');
    expect(defaultPlan.invalidContent.skippedRecords).to.have.length(1);
    expect(defaultPlan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_B,
      disposition: 'preserve_target',
    });
    expect(
      defaultPlan.invalidContent.skippedRecords[0].reasons,
    ).to.deep.include({
      code: 'INVALID_INTERMEDIATE',
      slice: 'intermediate',
      message: `Record ${RECORD_B} must stage its desired published version into CURRENT while record ${RECORD_A} still owns the same unique value on field field-title.`,
      fieldId: 'field-title',
      validatorKey: 'unique',
      dependencyId: RECORD_A,
      dependencyChain: [RECORD_B, RECORD_A],
    });
    expect(defaultPlan.requiredPermissions.editSchema).to.equal(false);

    const missingDiagnosticPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
    });
    expect(missingDiagnosticPlan.invalidContent.skippedRecords).to.have.length(
      1,
    );
    expect(
      missingDiagnosticPlan.invalidContent.skippedRecords[0].reasons.some(
        ({ code }) => code === 'VALIDATION_CONTRACT_CHANGED',
      ),
    ).to.equal(true);
    expect(
      missingDiagnosticPlan.invalidContent.validatorRelaxations,
    ).to.deep.equal([]);

    const relaxedPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: [
        {
          recordId: RECORD_B,
          slice: 'published',
          versionHash: sourceConsumer.published!.hash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ],
        },
      ],
    });

    expect(relaxedPlan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(relaxedPlan.invalidContent.validatorRelaxations).to.have.length(1);
    expect(relaxedPlan.invalidContent.validatorRelaxations[0]).to.include({
      fieldId: 'field-title',
      itemTypeId: MODEL_ID,
    });
    expect(
      relaxedPlan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['unique']);
    expect(
      relaxedPlan.invalidContent.validatorRelaxations[0].affectedRecordIds,
    ).to.deep.equal([RECORD_B]);
    expect(relaxedPlan.execution.revalidateBeforePublishIds).to.deep.equal([
      RECORD_B,
    ]);
    expect(relaxedPlan.requiredPermissions.editSchema).to.equal(true);
  });

  it('skips or minimally relaxes a source-only published seed that collides in CURRENT', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetOwner = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'shared', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const sourceOwner = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'shared', it: 'owner-current-it' } },
      { title: { en: 'owner-published', it: 'owner-published-it' } },
    );
    const sourceConsumer = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_C,
      { title: { en: 'consumer-current', it: 'consumer-current-it' } },
      { title: { en: 'shared', it: 'consumer-published-it' } },
    );
    const source = makeSnapshot(sourceSchema, {
      [RECORD_A]: sourceOwner,
      [RECORD_C]: sourceConsumer,
    });
    const target = makeSnapshot(targetSchema, { [RECORD_A]: targetOwner });

    const defaultPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
    });
    expect(defaultPlan.records.map(({ id }) => id)).to.deep.equal([RECORD_A]);
    expect(defaultPlan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_C,
      disposition: 'must_remain_absent',
    });
    expect(
      defaultPlan.invalidContent.skippedRecords[0].reasons,
    ).to.deep.include({
      code: 'INVALID_INTERMEDIATE',
      slice: 'intermediate',
      message: `Record ${RECORD_C} must create its published seed in CURRENT while record ${RECORD_A} still owns the same unique value on field field-title.`,
      fieldId: 'field-title',
      validatorKey: 'unique',
      dependencyId: RECORD_A,
      dependencyChain: [RECORD_C, RECORD_A],
    });

    const relaxedPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
      invalidContentDiagnostics: [
        {
          recordId: RECORD_C,
          slice: 'intermediate',
          versionHash: sourceConsumer.published!.hash,
          valid: false,
          issues: [
            {
              code: 'VALIDATION_UNIQUE',
              fieldId: 'field-title',
              details: {},
            },
          ],
        },
      ],
    });
    expect(relaxedPlan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(
      relaxedPlan.invalidContent.validatorRelaxations[0].relaxedValidatorKeys,
    ).to.deep.equal(['unique']);
    expect(
      relaxedPlan.invalidContent.validatorRelaxations[0].affectedRecordIds,
    ).to.deep.equal([RECORD_C]);
    expect(relaxedPlan.execution.revalidateBeforePublishIds).to.deep.equal([
      RECORD_C,
    ]);
    expect(
      relaxedPlan.records.find(({ id }) => id === RECORD_C)?.action,
    ).to.equal('create');
  });

  it('publishes desired record references before their consumers', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceDependency = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { target: null },
      { target: null },
    );
    const sourceConsumer = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { target: RECORD_A },
      { target: RECORD_A },
    );
    const targetDependency = makeCanonicalRecord(targetSchema, RECORD_A, {
      target: null,
    });
    const targetConsumer = makeCanonicalRecord(targetSchema, RECORD_B, {
      target: RECORD_A,
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceDependency,
        [RECORD_B]: sourceConsumer,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetDependency,
        [RECORD_B]: targetConsumer,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.execution.publishOrder).to.deep.equal([RECORD_A, RECORD_B]);
  });

  it('accepts existing and valid-seed publication cycles', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'new-a' }, target: RECORD_B },
      { title: { en: 'new-a' }, target: RECORD_B },
    );
    const sourceB = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'new-b' }, target: RECORD_A },
      { title: { en: 'new-b' }, target: RECORD_A },
    );
    const unchangedTargetA = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      sourceA.current.fields,
      sourceA.published!.fields,
    );
    const unchangedTargetB = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      sourceB.current.fields,
      sourceB.published!.fields,
    );
    const unchangedPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: unchangedTargetA,
        [RECORD_B]: unchangedTargetB,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(
      unchangedPlan.records.every(({ action }) => action === 'noop'),
    ).to.equal(true);
    expect(unchangedPlan.execution.publishOrder).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );

    const changedTargetA = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'old-a' }, target: RECORD_B },
      { title: { en: 'old-a' }, target: RECORD_B },
    );
    const changedTargetB = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { title: { en: 'old-b' }, target: RECORD_A },
      { title: { en: 'old-b' }, target: RECORD_A },
    );
    const changedPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: changedTargetA,
        [RECORD_B]: changedTargetB,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(
      changedPlan.records.every(({ action }) => action === 'update'),
    ).to.equal(true);

    const sourceOnlyRecords = {
      [RECORD_A]: sourceA,
      [RECORD_B]: sourceB,
    };
    const sourceOnlyPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, sourceOnlyRecords),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        invalidContentDiagnostics: validCreateCycleDiagnostics(
          sourceOnlyRecords,
          sourceSchema,
        ),
      },
    );
    expect(sourceOnlyPlan.execution.publicationSeedOrder).to.deep.equal(
      [RECORD_A, RECORD_B].sort(),
    );
    expect(sourceOnlyPlan.execution.shellRecordIds).to.deep.equal([]);

    const prerequisite = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_C,
      { target: null },
      { target: null },
    );
    const blockReferencingPrerequisite = {
      id: BLOCK_ID,
      type: 'item',
      relationships: {
        item_type: {
          data: { id: BLOCK_MODEL_ID, type: 'item_type' },
        },
      },
      attributes: { target: RECORD_C, image: null },
    };
    const sourceBWithPrerequisite = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { target: RECORD_A, blocks: [blockReferencingPrerequisite] },
      { target: RECORD_A, blocks: [blockReferencingPrerequisite] },
    );
    const transitiveSeedRecords = {
      [RECORD_A]: sourceA,
      [RECORD_B]: sourceBWithPrerequisite,
      [RECORD_C]: prerequisite,
    };
    const transitiveSeedPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, transitiveSeedRecords),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        invalidContentDiagnostics: validCreateCycleDiagnostics(
          transitiveSeedRecords,
          sourceSchema,
        ),
      },
    );
    expect(transitiveSeedPlan.execution.publicationSeedOrder[0]).to.equal(
      RECORD_C,
    );
    expect(transitiveSeedPlan.execution.publicationSeedOrder).to.have.members([
      RECORD_A,
      RECORD_B,
      RECORD_C,
    ]);

    const requiredSourceSchema = replaceTargetValidators(sourceSchema, {
      required: {},
    });
    const requiredTargetSchema = {
      ...requiredSourceSchema,
      environmentId: 'target',
    };
    const requiredSourceA = makeCanonicalRecordWithPublished(
      requiredSourceSchema,
      RECORD_A,
      { target: RECORD_B },
      { target: RECORD_B },
    );
    const requiredSourceB = makeCanonicalRecordWithPublished(
      requiredSourceSchema,
      RECORD_B,
      { target: RECORD_A },
      { target: RECORD_A },
    );
    const skippedRequiredCycle = buildContentDiffPlan(
      makeSnapshot(requiredSourceSchema, {
        [RECORD_A]: requiredSourceA,
        [RECORD_B]: requiredSourceB,
      }),
      makeSnapshot(requiredTargetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      skippedRequiredCycle.invalidContent.skippedRecords.map(({ id }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B].sort());
  });

  it('orders safe unpublishes and rejects retained or deletion-island referrers', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = makeCanonicalRecord(sourceSchema, RECORD_A, {
      target: null,
    });
    const sourceB = makeCanonicalRecord(sourceSchema, RECORD_B, {
      target: null,
    });
    const targetA = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { target: null },
      { target: null },
    );
    const targetB = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_B,
      { target: RECORD_A },
      { target: RECORD_A },
    );
    const bothDraftPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: sourceB,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetA,
        [RECORD_B]: targetB,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(bothDraftPlan.execution.publishOrder).to.deep.equal([
      RECORD_B,
      RECORD_A,
    ]);

    const publishedBWithoutLink = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { target: null },
      { target: null },
    );
    const reconcileThenUnpublishPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: sourceA,
        [RECORD_B]: publishedBWithoutLink,
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: targetA,
        [RECORD_B]: targetB,
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(reconcileThenUnpublishPlan.execution.publishOrder).to.deep.equal([
      RECORD_B,
      RECORD_A,
    ]);

    const publishedBRetainingLink = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { target: RECORD_A },
      { target: RECORD_A },
    );
    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, {
          [RECORD_A]: sourceA,
          [RECORD_B]: publishedBRetainingLink,
        }),
        makeSnapshot(targetSchema, {
          [RECORD_A]: targetA,
          [RECORD_B]: targetB,
        }),
        { includeDeletions: false, uploads: 'referenced' },
      ),
    ).to.throw(ContentDiffError, 'desired dependency is unpublished');

    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, { [RECORD_A]: sourceA }),
        makeSnapshot(targetSchema, {
          [RECORD_A]: targetA,
          [RECORD_B]: targetB,
        }),
        { includeDeletions: true, uploads: 'referenced' },
      ),
    ).to.throw(ContentDiffError, 'later deletion phase');
  });

  it('rejects a publication seed blocked by an existing published unique value', () => {
    const sourceSchema = replaceTitleValidators(makeSchema('source'), {
      unique: {},
    });
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'claimed' }, target: RECORD_B },
      { title: { en: 'claimed' }, target: RECORD_B },
    );
    const sourceB = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { title: { en: 'b' }, target: RECORD_A },
      { title: { en: 'b' }, target: RECORD_A },
    );
    const sourceOwner = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_C,
      { title: { en: 'released' }, target: null },
      { title: { en: 'released' }, target: null },
    );
    const targetOwner = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_C,
      { title: { en: 'claimed' }, target: null },
      { title: { en: 'claimed' }, target: null },
    );

    const sourceRecords = {
      [RECORD_A]: sourceA,
      [RECORD_B]: sourceB,
      [RECORD_C]: sourceOwner,
    };
    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, sourceRecords),
        makeSnapshot(targetSchema, { [RECORD_C]: targetOwner }),
        {
          includeDeletions: false,
          uploads: 'referenced',
          invalidContentDiagnostics: validCreateCycleDiagnostics(
            sourceRecords,
            sourceSchema,
            new Set([RECORD_C]),
          ),
        },
      ),
    ).to.throw(ContentDiffError, 'releases its published unique value');
  });

  it('requires no-draft create seeds to depend only on already published records', () => {
    const sourceSchema = addNoDraftModel(makeSchema('source'));
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const draftDependency = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      { target: null },
      { target: null },
    );
    const noDraftConsumer = makeCanonicalRecordForItemType(
      sourceSchema,
      RECORD_A,
      NO_DRAFT_MODEL_ID,
      { target: RECORD_B },
    );

    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, {
          [RECORD_A]: noDraftConsumer,
          [RECORD_B]: draftDependency,
        }),
        makeSnapshot(targetSchema, {}),
        { includeDeletions: false, uploads: 'referenced' },
      ),
    ).to.throw(ContentDiffError, 'source-only draft-mode record');

    const targetDraftDependency = makeCanonicalRecord(targetSchema, RECORD_B, {
      target: null,
    });
    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, {
          [RECORD_A]: noDraftConsumer,
          [RECORD_B]: draftDependency,
        }),
        makeSnapshot(targetSchema, { [RECORD_B]: targetDraftDependency }),
        { includeDeletions: false, uploads: 'referenced' },
      ),
    ).to.throw(ContentDiffError, 'no published destination version');

    const noDraftDependency = makeCanonicalRecordForItemType(
      sourceSchema,
      RECORD_B,
      NO_DRAFT_MODEL_ID,
      { target: null },
    );
    const safePlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: noDraftConsumer,
        [RECORD_B]: noDraftDependency,
      }),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(safePlan.execution.createOrder).to.deep.equal([RECORD_B, RECORD_A]);
  });

  it('creates a source-only singleton with its exact ID after its no-draft dependency', () => {
    const sourceSchema = makeNoDraftSingletonSchema('source');
    const targetSchema = makeNoDraftSingletonSchema('target');
    const dependency = makeCanonicalRecordForItemType(
      sourceSchema,
      RECORD_B,
      MODEL_ID,
      { target: null },
    );
    const singleton = makeCanonicalRecordForItemType(
      sourceSchema,
      RECORD_A,
      NO_DRAFT_MODEL_ID,
      { target: RECORD_B },
    );

    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: singleton,
        [RECORD_B]: dependency,
      }),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.records.find(({ id }) => id === RECORD_A)).to.include({
      id: RECORD_A,
      itemTypeId: NO_DRAFT_MODEL_ID,
      action: 'create',
      expectedTargetHash: null,
    });
    expect(plan.execution.createOrder).to.deep.equal([RECORD_B, RECORD_A]);
  });

  it('rejects divergent and target-only singleton identities', () => {
    const sourceSchema = makeNoDraftSingletonSchema('source');
    const targetSchema = makeNoDraftSingletonSchema('target');
    const sourceSingleton = makeCanonicalRecordForItemType(
      sourceSchema,
      RECORD_A,
      NO_DRAFT_MODEL_ID,
      { target: null },
    );
    const targetSingleton = makeCanonicalRecordForItemType(
      targetSchema,
      RECORD_C,
      NO_DRAFT_MODEL_ID,
      { target: null },
    );

    for (const [sourceRecords, targetRecords] of [
      [{ [RECORD_A]: sourceSingleton }, { [RECORD_C]: targetSingleton }],
      [{}, { [RECORD_C]: targetSingleton }],
    ] as const) {
      try {
        buildContentDiffPlan(
          makeSnapshot(sourceSchema, sourceRecords),
          makeSnapshot(targetSchema, targetRecords),
          { includeDeletions: true, uploads: 'referenced' },
        );
      } catch (error) {
        expect(error).to.be.instanceOf(ContentDiffError);
        expect((error as ContentDiffError).code).to.equal(
          'SINGLETON_ID_MISMATCH',
        );
        expect((error as ContentDiffError).details).to.deep.equal({
          itemTypeId: NO_DRAFT_MODEL_ID,
          sourceIds: Object.keys(sourceRecords),
          targetIds: [RECORD_C],
        });
        continue;
      }

      throw new Error('Expected singleton identity mismatch');
    }
  });

  it('emits a record plan for a position-only change', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const canonical = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'unchanged' },
    });
    const sourceRecord = {
      ...canonical,
      topology: { ...canonical.topology, position: 1 },
    };
    const targetRecord = {
      ...canonical,
      topology: { ...canonical.topology, position: 2 },
    };
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetRecord }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(sourceRecord.hash).to.equal(targetRecord.hash);
    expect(plan.records).to.have.length(1);
    expect(plan.records[0]).to.include({ id: RECORD_A, action: 'update' });
    expect(plan.records[0].changes.topology).to.equal(true);
  });

  it('skips source creates colliding with out-of-scope record IDs', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'source' },
    });
    const source = makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord });
    const target = makeSnapshot(targetSchema, {});
    target.visibleRecordIds = [RECORD_A];

    const collisionPlan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
    });
    expect(collisionPlan.records).to.deep.equal([]);
    expect(collisionPlan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_A,
      disposition: 'preserve_external',
      expectedTargetHash: null,
    });

    const linkedSourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'source' },
      target: RECORD_C,
    });
    const linkedSource = makeSnapshot(sourceSchema, {
      [RECORD_A]: linkedSourceRecord,
    });
    const linkedTarget = makeSnapshot(targetSchema, {});
    linkedTarget.visibleRecordIds = [RECORD_C];
    const linkedPlan = buildContentDiffPlan(linkedSource, linkedTarget, {
      includeDeletions: false,
      uploads: 'referenced',
    });
    expect(linkedPlan.records[0].dependencies).to.include(RECORD_C);
  });

  it('preserves invalid destination aggregates whose UPDATE would introduce a fresh nested block ID', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const target = makeSnapshot(targetSchema, {
      [RECORD_A]: markCurrentInvalid(
        makeCanonicalRecordWithPublished(
          targetSchema,
          RECORD_A,
          {
            title: { en: 'baseline draft' },
            blocks: [makeRawBlock(BLOCK_ID, null)],
          },
          {
            title: { en: 'baseline published' },
            blocks: [makeRawBlock(BLOCK_ID, null)],
          },
        ),
      ),
    });
    const source = makeSnapshot(sourceSchema, {
      [RECORD_A]: makeCanonicalRecordWithPublished(
        sourceSchema,
        RECORD_A,
        {
          title: { en: 'desired current' },
          blocks: [makeRawBlock(UPLOAD_ID, null)],
        },
        {
          title: { en: 'desired published' },
          blocks: [makeRawBlock(RECORD_D, null), makeRawBlock(RECORD_C, null)],
        },
      ),
    });

    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
    });

    expect(plan.records).to.deep.equal([]);
    expect(plan.invalidContent.skippedRecords).to.have.length(1);
    expect(plan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_A,
      disposition: 'preserve_target',
      expectedTargetHash: target.records[RECORD_A].hash,
    });
    expect(
      plan.invalidContent.skippedRecords[0].reasons.filter(
        ({ code }) => code === 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE',
      ),
    ).to.deep.include.members([
      {
        code: 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE',
        slice: 'published',
        message: `Record ${RECORD_A} would introduce nested block ${RECORD_C} while staging its desired published version into CURRENT. Fresh custom IDs require a proven valid UPDATE path and cannot refer to blocks retained only in PUBLISHED.`,
        dependencyId: RECORD_C,
        dependencyChain: [RECORD_A, RECORD_C],
      },
      {
        code: 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE',
        slice: 'current',
        message: `Record ${RECORD_A} would introduce nested block ${UPLOAD_ID} while restoring its desired current version. Fresh custom IDs require a proven valid UPDATE path and cannot refer to blocks retained only in PUBLISHED.`,
        dependencyId: UPLOAD_ID,
        dependencyChain: [RECORD_A, UPLOAD_ID],
      },
    ]);
    expect(plan.invalidContent.detectedRecordIds).to.deep.equal([RECORD_A]);
    expect(plan.invalidContent.migratedRecordIds).to.deep.equal([]);
    expect(plan.invalidContent.validatorRelaxations).to.deep.equal([]);
    expect(plan.execution.revalidateBeforePublishIds).to.deep.equal([]);
  });

  it('uses the actual CURRENT prestate when an existing published slice already matches', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const publishedFields = {
      title: { en: 'published' },
      blocks: [makeRawBlock(RECORD_C, null)],
    };
    const targetRecord = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      {
        title: { en: 'baseline draft' },
        blocks: [makeRawBlock(BLOCK_ID, null)],
      },
      publishedFields,
    );
    const sourceRecord = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      publishedFields,
      publishedFields,
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetRecord }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    const reason = plan.invalidContent.skippedRecords[0].reasons.find(
      ({ code }) => code === 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE',
    );
    expect(reason).to.include({
      slice: 'current',
      dependencyId: RECORD_C,
    });
    expect(reason?.dependencyChain).to.deep.equal([RECORD_A, RECORD_C]);
    expect(
      plan.invalidContent.skippedRecords[0].reasons.some(
        ({ slice }) => slice === 'published',
      ),
    ).to.equal(false);
  });

  it('allows nested block IDs already present in the immediately preceding CURRENT version', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const targetRecord = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'baseline' },
      blocks: [makeRawBlock(BLOCK_ID, null)],
    });
    const sourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'desired' },
      blocks: [
        makeRawBlockWithFields(BLOCK_ID, {
          target: null,
          image: null,
        }),
      ],
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetRecord }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.records).to.have.length(1);
    expect(plan.records[0]).to.include({ id: RECORD_A, action: 'update' });
  });

  it('allows unused recursively nested descendant IDs in a valid destination UPDATE', () => {
    const sourceSchema = makeRecursiveMappingSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const outerTarget = makeRawBlockWithFields(BLOCK_ID, {
      target: { en: null },
      image: null,
      child: {},
    });
    const outerSource = makeRawBlockWithFields(BLOCK_ID, {
      target: { en: null },
      image: null,
      child: {
        en: makeRawBlockWithFields(RECORD_D, {
          target: { en: null },
          image: null,
        }),
      },
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: makeCanonicalRecord(sourceSchema, RECORD_A, {
          title: { en: 'desired' },
          blocks: [outerSource],
        }),
      }),
      makeSnapshot(targetSchema, {
        [RECORD_A]: makeCanonicalRecord(targetSchema, RECORD_A, {
          title: { en: 'baseline' },
          blocks: [outerTarget],
        }),
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
    expect(plan.records).to.have.length(1);
    expect(plan.records[0]).to.include({ id: RECORD_A, action: 'update' });
  });

  it('allows valid source-only creation with a divergent unused phase-8 block', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const unsafe = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      {
        title: { en: 'current' },
        blocks: [makeRawBlock(RECORD_C, null)],
      },
      {
        title: { en: 'published seed' },
        blocks: [makeRawBlock(BLOCK_ID, null)],
      },
    );
    const sharedId = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_B,
      {
        title: { en: 'current' },
        blocks: [makeRawBlock(RECORD_D, null)],
      },
      {
        title: { en: 'published seed' },
        blocks: [makeRawBlock(RECORD_D, null)],
      },
    );
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: unsafe,
        [RECORD_B]: sharedId,
      }),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(
      plan.records.map(({ id, action }) => ({ id, action })),
    ).to.deep.equal(
      [
        { id: RECORD_A, action: 'create' },
        { id: RECORD_B, action: 'create' },
      ].sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
    expect(plan.invalidContent.skippedRecords).to.deep.equal([]);
  });

  it('requires portable IDs for new nested UPDATE blocks while retaining existing legacy IDs', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const baseline = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'baseline' },
      blocks: [],
    });
    const desired = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'desired' },
      blocks: [makeRawBlock(BLOCK_ID, null)],
    });
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: desired }),
      makeSnapshot(targetSchema, { [RECORD_A]: baseline }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(plan.records[0].action).to.equal('update');
    for (const id of ['123456', 'bad/block']) {
      const alteredPlan = structuredClone(plan);
      (
        alteredPlan.records[0].desired!.current.fields.blocks as Array<{
          id: string;
        }>
      )[0].id = id;
      expect(findNonPortableCreateIds(alteredPlan), id).to.deep.equal([id]);
    }
    const retainedBaseline = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'baseline' },
      blocks: [makeRawBlock('123456', null)],
    });
    const retainedDesired = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'desired' },
      blocks: [makeRawBlock('123456', null)],
    });
    const retainedPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: retainedDesired }),
      makeSnapshot(targetSchema, { [RECORD_A]: retainedBaseline }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(retainedPlan.records[0].action).to.equal('update');
    expect(findNonPortableCreateIds(retainedPlan)).to.deep.equal([]);
  });

  it('rejects a legacy block ID recreated after its published-only copy is removed', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const baseline = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'baseline current' }, blocks: [] },
      {
        title: { en: 'old publication' },
        blocks: [makeRawBlock('123456', null)],
      },
    );
    const desired = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'desired draft' },
      blocks: [makeRawBlock('123456', null)],
    });
    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, { [RECORD_A]: desired }),
        makeSnapshot(targetSchema, { [RECORD_A]: baseline }),
        { includeDeletions: false, uploads: 'referenced' },
      ),
    ).to.throw(ContentDiffError, 'cannot be requested on create');
  });

  it('preserves a source-only projected create shell with a later fresh block ID', () => {
    const sourceSchema = makeSchema('source');
    const desired = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      {
        title: { en: 'current' },
        target: RECORD_A,
        blocks: [makeRawBlock(RECORD_C, null)],
      },
      {
        title: { en: 'published' },
        target: RECORD_A,
        blocks: [makeRawBlock(BLOCK_ID, null)],
      },
    );
    const records = { [RECORD_A]: desired };
    const candidates = collectCreateCycleIntermediateCandidates(
      records,
      sourceSchema,
      new Set([RECORD_A]),
    );
    expect(candidates).to.have.length(1);
    const plan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, records),
      makeSnapshot({ ...sourceSchema, environmentId: 'target' }, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        invalidContentDiagnostics: candidates.map(
          ({ recordId, versionHash }) => ({
            recordId,
            versionHash,
            slice: 'intermediate',
            valid: true,
            issues: [],
          }),
        ),
      },
    );
    expect(plan.records).to.deep.equal([]);
    expect(plan.invalidContent.skippedRecords[0].reasons[0]).to.include({
      code: 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE',
      slice: 'current',
      dependencyId: RECORD_C,
    });
    expect(plan.execution.shellRecordIds).to.deep.equal([]);
  });

  it('blocks fresh writes in a valid peer model affected by another record validator relaxation', () => {
    for (const blockValidator of [false, true]) {
      let sourceSchema = replaceTitleValidators(
        makeSchema('source'),
        blockValidator ? {} : { length: { min: 1 } },
      );
      if (blockValidator) {
        sourceSchema = withRecomputedSchemaDigest({
          ...sourceSchema,
          itemTypes: sourceSchema.itemTypes.map((itemType) =>
            itemType.id !== BLOCK_MODEL_ID
              ? itemType
              : {
                  ...itemType,
                  fields: itemType.fields.map((field) =>
                    field.id !== 'field-block-target'
                      ? field
                      : {
                          ...field,
                          validators: { required: {} },
                        },
                  ),
                },
          ),
        });
      }
      sourceSchema = setInvalidDraftSaving(sourceSchema, false);
      const targetSchema = { ...sourceSchema, environmentId: 'target' };
      const invalid = markCurrentAndPublishedInvalid(
        makeCanonicalRecordWithPublished(
          sourceSchema,
          RECORD_A,
          {
            title: { en: '' },
            blocks: blockValidator ? [makeRawBlock(BLOCK_ID, null)] : [],
          },
          {
            title: { en: '' },
            blocks: blockValidator ? [makeRawBlock(BLOCK_ID, null)] : [],
          },
        ),
      );
      const peer = makeCanonicalRecord(sourceSchema, RECORD_B, {
        title: { en: 'valid desired peer' },
        blocks: [makeRawBlock(RECORD_C, blockValidator ? RECORD_A : null)],
      });
      const baselinePeer = makeCanonicalRecord(targetSchema, RECORD_B, {
        title: { en: 'baseline peer' },
        blocks: [],
      });
      const plan = buildContentDiffPlan(
        makeSnapshot(sourceSchema, { [RECORD_A]: invalid, [RECORD_B]: peer }),
        makeSnapshot(targetSchema, { [RECORD_B]: baselinePeer }),
        {
          includeDeletions: false,
          uploads: 'referenced',
          migrateInvalidContent: true,
          invalidContentDiagnostics: invalidDiagnostics(invalid, [
            {
              code: blockValidator
                ? 'VALIDATION_REQUIRED'
                : 'VALIDATION_LENGTH',
              fieldId: blockValidator ? 'field-block-target' : 'field-title',
              details: {},
            },
          ]),
        },
      );
      expect(plan.invalidContent.validatorRelaxations).to.have.length(1);
      expect(
        plan.invalidContent.validatorRelaxations[0].affectedRecordIds,
      ).to.deep.equal([RECORD_A]);
      expect(
        plan.invalidContent.skippedRecords.find(({ id }) => id === RECORD_B)
          ?.reasons,
      ).to.deep.include({
        code: 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE',
        slice: 'current',
        message: `Record ${RECORD_B} would introduce nested block ${RECORD_C} while restoring its desired current version. Fresh custom IDs require a proven valid UPDATE path and cannot refer to blocks retained only in PUBLISHED.`,
        dependencyId: RECORD_C,
        dependencyChain: [RECORD_B, RECORD_C],
      });
    }
  });

  it('preserves external nested-block collisions and skips missing references', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'source' },
      blocks: [makeRawBlock(BLOCK_ID, RECORD_C)],
    });
    const collisionPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
      makeSnapshot(targetSchema, {}),
      {
        includeDeletions: false,
        uploads: 'referenced',
        entityIdCollisions: [
          { id: BLOCK_ID, kind: 'block', topRecordId: RECORD_A },
        ],
      },
    );
    expect(collisionPlan.records).to.deep.equal([]);
    expect(collisionPlan.invalidContent.skippedRecords[0]).to.include({
      id: RECORD_A,
      disposition: 'must_remain_absent',
    });
    expect(
      collisionPlan.invalidContent.skippedRecords[0].sourceNestedBlockIds,
    ).to.deep.equal([BLOCK_ID]);
    expect(
      collisionPlan.invalidContent.skippedRecords[0].preservedExternalBlockIds,
    ).to.deep.equal([BLOCK_ID]);

    const relocatedBlockPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, {
        [RECORD_A]: makeCanonicalRecord(sourceSchema, RECORD_A, {
          title: { en: 'source' },
          blocks: [makeRawBlock(BLOCK_ID, null)],
        }),
      }),
      makeSnapshot(targetSchema, {
        [RECORD_B]: makeCanonicalRecord(targetSchema, RECORD_B, {
          title: { en: 'target owner' },
          blocks: [makeRawBlock(BLOCK_ID, null)],
        }),
      }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    const relocatedBlockSkip =
      relocatedBlockPlan.invalidContent.skippedRecords[0];
    expect(relocatedBlockPlan.records).to.deep.equal([]);
    expect(relocatedBlockSkip).to.include({
      id: RECORD_A,
      disposition: 'must_remain_absent',
    });
    expect(relocatedBlockSkip.reasons).to.deep.include({
      code: 'ENTITY_ID_COLLISION',
      slice: 'intermediate',
      message: `Nested block ${BLOCK_ID} would relocate across aggregates, fields, or locales.`,
      dependencyId: BLOCK_ID,
      dependencyChain: [RECORD_A],
    });
    expect(relocatedBlockSkip.preservedExternalBlockIds).to.deep.equal([
      BLOCK_ID,
    ]);
    expect(relocatedBlockPlan.invalidContent.detectedRecordIds).to.deep.equal([
      RECORD_A,
    ]);
    expect(relocatedBlockPlan.invalidContent.migratedRecordIds).to.deep.equal(
      [],
    );

    const missingRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'source' },
      target: RECORD_C,
    });
    const missingRecordPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: missingRecord }),
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      missingRecordPlan.invalidContent.skippedRecords[0].reasons[0],
    ).to.include({ code: 'MISSING_REFERENCE', dependencyId: RECORD_C });

    const missingUploadSource = makeSnapshot(sourceSchema, {
      [RECORD_A]: makeCanonicalRecord(sourceSchema, RECORD_A, {
        title: { en: 'source' },
      }),
    });
    missingUploadSource.missingUploadReferences = {
      [RECORD_A]: [UPLOAD_ID],
    };
    const missingUploadPlan = buildContentDiffPlan(
      missingUploadSource,
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      missingUploadPlan.invalidContent.skippedRecords[0].reasons[0],
    ).to.include({ code: 'MISSING_REFERENCE', dependencyId: UPLOAD_ID });
  });

  it('retains unchanged managed entities as drift-detecting noops', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const record = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'unchanged' },
    });
    const collection = canonicalizeUploadCollection({
      id: 'shared-collection',
      label: 'Shared',
      parent: null,
      position: 1,
    });
    const upload = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'hero',
        filename: 'hero.jpg',
        url: 'https://example.test/hero.jpg',
        size: 10,
        mime_type: 'image/jpeg',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          sourceSchema.locales,
        ),
        upload_collection: { id: collection.id, type: 'upload_collection' },
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
    const source = makeSnapshot(sourceSchema, { [RECORD_A]: record });
    const target = makeSnapshot(targetSchema, { [RECORD_A]: record });
    source.uploads[UPLOAD_ID] = upload;
    target.uploads[UPLOAD_ID] = upload;
    source.uploadCollections[collection.id] = collection;
    target.uploadCollections[collection.id] = collection;
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
    });
    expect(plan.records.map(({ action }) => action)).to.deep.equal(['noop']);
    expect(plan.uploads.map(({ action }) => action)).to.deep.equal(['noop']);
    expect(plan.uploadCollections.map(({ action }) => action)).to.deep.equal([
      'noop',
    ]);
    expect(plan.uploadCollections[0].baseline).to.deep.equal(collection);
    expect(plan.execution.uploadOrder).to.deep.equal([]);
    expect(plan.execution.collectionOrder).to.deep.equal([]);
    expect(plan.summary).to.deep.include({ warnings: 0 });
    expect(plan.summary.records).to.deep.equal({
      create: 0,
      update: 0,
      delete: 0,
    });
    expect(plan.summary.uploads).to.deep.equal({
      create: 0,
      update: 0,
      delete: 0,
    });
    expect(plan.summary.uploadCollections).to.deep.equal({
      create: 0,
      update: 0,
    });
    expect(plan.requiredPermissions.itemTypes).to.deep.equal([
      { id: MODEL_ID, actions: ['read'] },
    ]);
    expect(plan.requiredPermissions.readItemTypes).to.deep.equal([
      { id: MODEL_ID, workflowId: null },
    ]);
    expect(plan.requiredPermissions.manageUploadCollections).to.equal(true);
  });

  it('rejects collection label collisions against full target occupancy and permits an ordered vacancy', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const uploadInCollection = (
      id: string,
      collectionId: string,
      basename: string,
    ) =>
      canonicalizeUpload(
        {
          id,
          md5: '900150983cd24fb0d6963f7d28e17f72',
          basename,
          filename: `${basename}.jpg`,
          url: `https://example.test/${basename}.jpg`,
          size: 10,
          mime_type: 'image/jpeg',
          tags: [],
          default_field_metadata: emptyUploadDefaultFieldMetadata(
            sourceSchema.locales,
          ),
          upload_collection: { id: collectionId, type: 'upload_collection' },
          meta: { antivirus: { status: 'clean' } },
        },
        sourceSchema.locales,
      );
    const source = makeSnapshot(sourceSchema, {});
    const target = makeSnapshot(targetSchema, {});
    const desiredCreate = canonicalizeUploadCollection({
      id: RECORD_B,
      label: 'Taken',
      parent: null,
      position: 2,
    });
    const unmanagedOccupant = canonicalizeUploadCollection({
      id: RECORD_C,
      label: 'Taken',
      parent: null,
      position: 1,
    });
    source.uploadCollections[desiredCreate.id] = desiredCreate;
    source.uploads[UPLOAD_ID] = uploadInCollection(
      UPLOAD_ID,
      desiredCreate.id,
      'collision-create',
    );
    target.uploadCollections[unmanagedOccupant.id] = unmanagedOccupant;

    expect(() =>
      buildContentDiffPlan(source, target, {
        includeDeletions: false,
        uploads: 'referenced',
      }),
    ).to.throw(/occupied by/);

    const orderedSource = makeSnapshot(sourceSchema, {});
    const orderedTarget = makeSnapshot(targetSchema, {});
    const vacaterBaseline = canonicalizeUploadCollection({
      id: RECORD_C,
      label: 'Taken',
      parent: null,
      position: 1,
    });
    const vacaterDesired = canonicalizeUploadCollection({
      id: RECORD_C,
      label: 'Vacated',
      parent: null,
      position: 1,
    });
    const createAfterVacate = canonicalizeUploadCollection({
      id: RECORD_B,
      label: 'Taken',
      parent: null,
      position: 2,
    });
    orderedSource.uploadCollections = {
      [vacaterDesired.id]: vacaterDesired,
      [createAfterVacate.id]: createAfterVacate,
    };
    orderedTarget.uploadCollections = {
      [vacaterBaseline.id]: vacaterBaseline,
    };
    const vacaterUpload = uploadInCollection(
      UPLOAD_ID,
      vacaterDesired.id,
      'vacater',
    );
    orderedSource.uploads = {
      [UPLOAD_ID]: vacaterUpload,
      [BLOCK_ID]: uploadInCollection(
        BLOCK_ID,
        createAfterVacate.id,
        'create-after-vacate',
      ),
    };
    orderedTarget.uploads = { [UPLOAD_ID]: vacaterUpload };
    const orderedPlan = buildContentDiffPlan(orderedSource, orderedTarget, {
      includeDeletions: false,
      uploads: 'referenced',
    });
    expect(orderedPlan.execution.collectionOrder).to.deep.equal([
      RECORD_C,
      RECORD_B,
    ]);

    const swapSource = makeSnapshot(sourceSchema, {});
    const swapTarget = makeSnapshot(targetSchema, {});
    swapTarget.uploadCollections = {
      [RECORD_B]: canonicalizeUploadCollection({
        id: RECORD_B,
        label: 'Alpha',
        parent: null,
        position: 1,
      }),
      [RECORD_C]: canonicalizeUploadCollection({
        id: RECORD_C,
        label: 'Beta',
        parent: null,
        position: 2,
      }),
    };
    swapSource.uploadCollections = {
      [RECORD_B]: canonicalizeUploadCollection({
        id: RECORD_B,
        label: 'Beta',
        parent: null,
        position: 1,
      }),
      [RECORD_C]: canonicalizeUploadCollection({
        id: RECORD_C,
        label: 'Alpha',
        parent: null,
        position: 2,
      }),
    };
    const alphaUpload = uploadInCollection(
      UPLOAD_ID,
      RECORD_B,
      'alpha-collection',
    );
    const betaUpload = uploadInCollection(
      BLOCK_ID,
      RECORD_C,
      'beta-collection',
    );
    swapSource.uploads = {
      [UPLOAD_ID]: alphaUpload,
      [BLOCK_ID]: betaUpload,
    };
    swapTarget.uploads = {
      [UPLOAD_ID]: alphaUpload,
      [BLOCK_ID]: betaUpload,
    };
    expect(() =>
      buildContentDiffPlan(swapSource, swapTarget, {
        includeDeletions: false,
        uploads: 'referenced',
      }),
    ).to.throw(/occupied by/);
  });

  it('derives publish, staging-update, schedule, and upload permissions from actual operations', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceRecord = makeCanonicalRecordWithPublished(
      sourceSchema,
      RECORD_A,
      { title: { en: 'draft-current' } },
      { title: { en: 'source-published' } },
    );
    const targetRecord = makeCanonicalRecordWithPublished(
      targetSchema,
      RECORD_A,
      { title: { en: 'draft-current' } },
      { title: { en: 'target-published' } },
    );
    const publicationPlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
      makeSnapshot(targetSchema, { [RECORD_A]: targetRecord }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(publicationPlan.records[0].changes).to.include({
      current: false,
      published: true,
    });
    expect(publicationPlan.requiredPermissions.itemTypes).to.deep.equal([
      { id: MODEL_ID, actions: ['read', 'update', 'publish'] },
    ]);

    const model = sourceSchema.itemTypes.find(({ id }) => id === MODEL_ID)!;
    const scheduledSource = canonicalizeRecord(
      makeItem(RECORD_A, { title: { en: 'unchanged' } }),
      null,
      model,
      sourceSchema,
      {
        publication: {
          at: '2035-01-01T00:00:00Z',
          selective: null,
        },
        unpublishing: null,
      },
    );
    const unscheduledTarget = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'unchanged' },
    });
    const schedulePlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: scheduledSource }),
      makeSnapshot(targetSchema, { [RECORD_A]: unscheduledTarget }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(schedulePlan.requiredPermissions).to.deep.include({
      itemTypes: [{ id: MODEL_ID, actions: ['read', 'publish'] }],
      manageSchedules: true,
    });

    const identicalScheduleSource = canonicalizeRecord(
      makeItem(RECORD_A, { title: { en: 'changed while scheduled' } }),
      null,
      model,
      sourceSchema,
      scheduledSource.schedules,
    );
    const identicalScheduleTarget = canonicalizeRecord(
      makeItem(RECORD_A, { title: { en: 'unchanged' } }),
      null,
      model,
      targetSchema,
      scheduledSource.schedules,
    );
    const unchangedScheduledUpdatePlan = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: identicalScheduleSource }),
      makeSnapshot(targetSchema, { [RECORD_A]: identicalScheduleTarget }),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(unchangedScheduledUpdatePlan.records[0]).to.deep.include({
      action: 'update',
    });
    expect(unchangedScheduledUpdatePlan.records[0].changes).to.include({
      current: true,
      schedules: false,
    });
    expect(unchangedScheduledUpdatePlan.requiredPermissions).to.deep.include({
      itemTypes: [{ id: MODEL_ID, actions: ['read', 'update', 'publish'] }],
      manageSchedules: true,
    });

    const scheduledNoop = canonicalizeRecord(
      makeItem(RECORD_B, { title: { en: 'scheduled dependency' } }),
      null,
      model,
      sourceSchema,
      scheduledSource.schedules,
    );
    const mutatingSource = makeSnapshot(sourceSchema, {
      [RECORD_A]: identicalScheduleSource,
      [RECORD_B]: scheduledNoop,
    });
    const mutatingTarget = makeSnapshot(targetSchema, {
      [RECORD_A]: identicalScheduleTarget,
      [RECORD_B]: scheduledNoop,
    });
    const scheduledNoopDependencyPlan = buildContentDiffPlan(
      mutatingSource,
      mutatingTarget,
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      scheduledNoopDependencyPlan.records.find(({ id }) => id === RECORD_B)
        ?.action,
    ).to.equal('noop');
    expect(scheduledNoopDependencyPlan.requiredPermissions).to.deep.include({
      manageSchedules: true,
    });
    expect(
      scheduledNoopDependencyPlan.requiredPermissions.itemTypes,
    ).to.deep.equal([{ id: MODEL_ID, actions: ['read', 'update', 'publish'] }]);

    const upload = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'hero',
        filename: 'hero.jpg',
        url: 'https://example.test/hero.jpg',
        size: 10,
        mime_type: 'image/jpeg',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          sourceSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
    const uploadSource = makeSnapshot(sourceSchema, {});
    uploadSource.uploads[UPLOAD_ID] = upload;
    const uploadPlan = buildContentDiffPlan(
      uploadSource,
      makeSnapshot(targetSchema, {}),
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(uploadPlan.requiredPermissions.uploadActions).to.deep.equal([
      'read',
      'create',
    ]);

    const renamedUpload = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'editorial-hero',
        filename: 'editorial-hero.jpg',
        url: 'https://example.test/editorial-hero.jpg',
        size: 10,
        mime_type: 'image/jpeg',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          sourceSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
    const renameSource = makeSnapshot(sourceSchema, {});
    const renameTarget = makeSnapshot(targetSchema, {});
    renameSource.uploads[UPLOAD_ID] = renamedUpload;
    renameTarget.uploads[UPLOAD_ID] = upload;
    const renamePlan = buildContentDiffPlan(renameSource, renameTarget, {
      includeDeletions: false,
      uploads: 'referenced',
    });

    expect(renamePlan.uploads[0]).to.deep.include({ action: 'update' });
    expect(renamePlan.uploads[0].changes).to.deep.include({
      binary: false,
      metadata: true,
      collection: false,
    });
    expect(renamePlan.requiredPermissions.uploadActions).to.deep.equal([
      'read',
      'replace_asset',
    ]);

    const renamedUploadWithManualMetadata = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'editorial-hero',
        filename: 'editorial-hero.jpg',
        url: 'https://example.test/editorial-hero.jpg',
        size: 10,
        mime_type: 'image/jpeg',
        author: 'Editorial team',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          sourceSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
    const renameAndMetadataSource = makeSnapshot(sourceSchema, {});
    renameAndMetadataSource.uploads[UPLOAD_ID] =
      renamedUploadWithManualMetadata;
    const renameAndMetadataPlan = buildContentDiffPlan(
      renameAndMetadataSource,
      renameTarget,
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(
      renameAndMetadataPlan.requiredPermissions.uploadActions,
    ).to.deep.equal(['read', 'update', 'replace_asset']);

    const sameBinaryDifferentExtension = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'hero',
        filename: 'hero.png',
        url: 'https://example.test/hero.png',
        size: 10,
        mime_type: 'image/png',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          targetSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      targetSchema.locales,
    );
    const extensionTarget = makeSnapshot(targetSchema, {});
    extensionTarget.uploads[UPLOAD_ID] = sameBinaryDifferentExtension;
    const extensionPlan = buildContentDiffPlan(uploadSource, extensionTarget, {
      includeDeletions: false,
      uploads: 'referenced',
    });

    expect(extensionPlan.uploads[0].changes.binary).to.equal(true);
    expect(extensionPlan.requiredPermissions.uploadActions).to.include(
      'replace_asset',
    );

    const sameBinaryDifferentExtensionCase = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'hero',
        filename: 'hero.JPG',
        url: 'https://example.test/hero.JPG',
        size: 10,
        mime_type: 'image/jpeg',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          targetSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      targetSchema.locales,
    );
    const extensionCaseTarget = makeSnapshot(targetSchema, {});
    extensionCaseTarget.uploads[UPLOAD_ID] = sameBinaryDifferentExtensionCase;
    const extensionCasePlan = buildContentDiffPlan(
      uploadSource,
      extensionCaseTarget,
      { includeDeletions: false, uploads: 'referenced' },
    );

    expect(extensionCasePlan.uploads[0].changes.binary).to.equal(true);
    expect(extensionCasePlan.requiredPermissions.uploadActions).to.include(
      'replace_asset',
    );
  });

  it('fails generation when an upload write filename cannot survive current CMA normalization byte-for-byte', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const stableUpload = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'asset-name_1',
        filename: 'asset-name_1.png',
        url: 'https://example.test/asset-name_1.png',
        size: 10,
        mime_type: 'image/png',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          sourceSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
    const stableSource = makeSnapshot(sourceSchema, {});
    stableSource.uploads[UPLOAD_ID] = stableUpload;
    expect(
      buildContentDiffPlan(stableSource, makeSnapshot(targetSchema, {}), {
        includeDeletions: false,
        uploads: 'referenced',
      }).uploads[0].action,
    ).to.equal('create');

    const unstableFilenames = [
      'Asset.png',
      'asset name.png',
      'fôô.png',
      'asset--name.png',
      'folder/asset.png',
      'asset\\name.png',
      'asset\u0000name.png',
      '',
    ];
    for (const filename of unstableFilenames) {
      const desired = structuredClone(stableUpload);
      const slash = Math.max(
        filename.lastIndexOf('/'),
        filename.lastIndexOf('\\'),
      );
      const dot = filename.lastIndexOf('.');
      desired.filename = filename;
      desired.basename = filename.slice(
        slash + 1,
        dot > slash + 1 ? dot : filename.length,
      );
      desired.hash = semanticHash({
        id: desired.id,
        md5: desired.md5,
        basename: desired.basename,
        filename: desired.filename,
        manual: desired.manual,
      });
      const source = makeSnapshot(sourceSchema, {});
      source.uploads[UPLOAD_ID] = desired;

      expect(() =>
        buildContentDiffPlan(source, makeSnapshot(targetSchema, {}), {
          includeDeletions: false,
          uploads: 'referenced',
        }),
      ).to.throw(/cannot be reproduced exactly/i);
    }

    const unstableReplacement = structuredClone(stableUpload);
    unstableReplacement.filename = 'Replacement Asset.PNG';
    unstableReplacement.basename = 'Replacement Asset';
    unstableReplacement.md5 = '4ed9407630eb1000c0f6b63842defa7d';
    unstableReplacement.hash = semanticHash({
      id: unstableReplacement.id,
      md5: unstableReplacement.md5,
      basename: unstableReplacement.basename,
      filename: unstableReplacement.filename,
      manual: unstableReplacement.manual,
    });
    const replacementSource = makeSnapshot(sourceSchema, {});
    const replacementTarget = makeSnapshot(targetSchema, {});
    replacementSource.uploads[UPLOAD_ID] = unstableReplacement;
    replacementTarget.uploads[UPLOAD_ID] = stableUpload;
    expect(() =>
      buildContentDiffPlan(replacementSource, replacementTarget, {
        includeDeletions: false,
        uploads: 'referenced',
      }),
    ).to.throw(/normalization fixed point/i);
  });

  it('fails generation when either upload snapshot basename disagrees with its filename stem', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const upload = canonicalizeUpload(
      {
        id: UPLOAD_ID,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename: 'asset',
        filename: 'asset.png',
        url: 'https://example.test/asset.png',
        size: 10,
        mime_type: 'image/png',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(
          sourceSchema.locales,
        ),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
    for (const label of ['source', 'target'] as const) {
      const source = makeSnapshot(sourceSchema, {});
      const target = makeSnapshot(targetSchema, {});
      const inconsistent = structuredClone(upload);
      inconsistent.basename = 'different';
      (label === 'source' ? source : target).uploads[UPLOAD_ID] = inconsistent;
      expect(() =>
        buildContentDiffPlan(source, target, {
          includeDeletions: false,
          uploads: 'referenced',
        }),
      ).to.throw(
        new RegExp(`${label} upload.*does not match filename stem`, 'i'),
      );
    }
  });

  it('builds deterministic create/update/delete plans and destructive sets', () => {
    const sourceSchema = makeSchema('source');
    const targetSchema = { ...sourceSchema, environmentId: 'target' };
    const sourceA = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'new' },
      blocks: [],
      target: null,
    });
    const targetA = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: { en: 'old' },
      blocks: [],
      target: null,
    });
    const sourceB = makeCanonicalRecord(sourceSchema, RECORD_B, {
      title: { en: 'created' },
      blocks: [],
      target: null,
    });
    const targetC = makeCanonicalRecord(targetSchema, RECORD_C, {
      title: { en: 'deleted' },
      blocks: [],
      target: null,
    });
    const source = makeSnapshot(sourceSchema, {
      [RECORD_A]: sourceA,
      [RECORD_B]: sourceB,
    });
    const target = makeSnapshot(targetSchema, {
      [RECORD_A]: targetA,
      [RECORD_C]: targetC,
    });
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: true,
      uploads: 'referenced',
    });

    expect(plan.summary.records).to.deep.equal({
      create: 1,
      update: 1,
      delete: 1,
    });
    expect(
      plan.records.find(({ id }) => id === RECORD_A)?.baseline?.hash,
    ).to.equal(targetA.hash);
    expect(plan.targetPreconditions).to.deep.equal({
      itemTypeIds: [MODEL_ID],
      selectedRecordIds: [RECORD_A, RECORD_C].sort(),
      desiredRecordIds: [RECORD_A, RECORD_B].sort(),
      selectedUploadIds: [],
      desiredUploadIds: [],
    });
    expect(plan.requiredPermissions.itemTypes).to.deep.equal([
      {
        id: MODEL_ID,
        actions: ['read', 'create', 'update', 'delete'],
      },
    ]);
    expect(
      plan.records.find(({ id }) => id === RECORD_B)?.changes,
    ).to.deep.equal({
      current: true,
      published: false,
      topology: false,
      lifecycle: true,
      stage: false,
      schedules: false,
    });
  });

  it('fails closed on create-time default replacement without explicit schema-mutation opt-in', () => {
    const sourceSchema = withHistoricalFloatDefault(makeSchema('source'));
    const targetSchema = {
      ...sourceSchema,
      environmentId: 'target',
    };
    const sourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: { en: 'historical null' },
      blocks: [],
      target: null,
      historical_number: null,
    });
    const source = makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord });
    const target = makeSnapshot(targetSchema, {});

    expect(() =>
      buildContentDiffPlan(source, target, {
        includeDeletions: false,
        uploads: 'referenced',
      }),
    ).to.throw(
      ContentDiffError,
      '--migrate-invalid-content to authorize exact temporary default suppression',
    );

    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
    });
    expect(plan.options.migrateInvalidContent).to.equal(true);
    expect(plan.requiredPermissions.editSchema).to.equal(true);
    expect(
      plan.warnings.find(({ code }) => code === 'DEFAULT_VALUE_SUPPRESSION'),
    ).to.deep.include({
      code: 'DEFAULT_VALUE_SUPPRESSION',
      entityIds: ['field-historical-number'],
    });
  });

  it('fails generation before artifacts when active CREATE sanitization can rewrite source bytes', () => {
    const withActiveCreateSanitizer = (environmentId: string) => {
      const schema = makeSchema(environmentId);
      return withRecomputedSchemaDigest({
        ...schema,
        itemTypes: schema.itemTypes.map((itemType) =>
          itemType.id === MODEL_ID
            ? {
                ...itemType,
                fields: itemType.fields.map((field) =>
                  field.id === 'field-title'
                    ? {
                        ...field,
                        fieldType: 'text' as const,
                        validators: {
                          sanitized_html: {
                            sanitize_before_validation: true,
                          },
                        },
                      }
                    : field,
                ),
              }
            : itemType,
        ),
      });
    };
    const sourceSchema = withActiveCreateSanitizer('source');
    const targetSchema = withActiveCreateSanitizer('target');
    const sourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      // Current CMA specs prove this valid input is persisted as <br>.
      title: { en: '<p>This <br /> text</p>', it: 'Testo semplice' },
      blocks: [],
      target: null,
    });
    const source = makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord });
    const target = makeSnapshot(targetSchema, {});

    for (const migrateInvalidContent of [false, true]) {
      expect(() =>
        buildContentDiffPlan(source, target, {
          includeDeletions: false,
          uploads: 'referenced',
          migrateInvalidContent,
        }),
      ).to.throw(
        ContentDiffError,
        'CMA may rewrite 1 projected text value(s) during attribute-bearing CREATE/UPDATE stages',
      );
    }
  });

  it('fails on an unrelated UPDATE that can full-rehydrate unchanged sanitized text', () => {
    const withSanitizedBody = (environmentId: string) => {
      const schema = makeSchema(environmentId);
      return withRecomputedSchemaDigest({
        ...schema,
        itemTypes: schema.itemTypes.map((itemType) =>
          itemType.id !== MODEL_ID
            ? itemType
            : {
                ...itemType,
                fields: [
                  ...itemType.fields.map((field) =>
                    field.id !== 'field-title'
                      ? field
                      : {
                          ...field,
                          fieldType: 'text' as const,
                          validators: {
                            sanitized_html: {
                              sanitize_before_validation: true,
                            },
                          },
                        },
                  ),
                  {
                    id: 'field-marker',
                    apiKey: 'marker',
                    fieldType: 'string' as const,
                    localized: false,
                    position: 4,
                    defaultValue: null,
                    validators: {},
                  },
                ],
              },
        ),
      });
    };
    const sourceSchema = withSanitizedBody('source');
    const targetSchema = withSanitizedBody('target');
    const historicalTitle = {
      en: '<p>Historical <br /> text</p>',
      it: 'Testo semplice',
    };
    const sourceRecord = makeCanonicalRecord(sourceSchema, RECORD_A, {
      title: historicalTitle,
      blocks: [],
      target: null,
      marker: 'after',
    });
    const targetRecord = makeCanonicalRecord(targetSchema, RECORD_A, {
      title: historicalTitle,
      blocks: [],
      target: null,
      marker: 'before',
    });

    expect(() =>
      buildContentDiffPlan(
        makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
        makeSnapshot(targetSchema, { [RECORD_A]: targetRecord }),
        { includeDeletions: false, uploads: 'referenced' },
      ),
    )
      .to.throw(ContentDiffError, 'attribute-bearing CREATE/UPDATE stages')
      .with.property('details')
      .deep.include({ stages: ['current-restore'] });

    const unchanged = buildContentDiffPlan(
      makeSnapshot(sourceSchema, { [RECORD_A]: sourceRecord }),
      makeSnapshot(targetSchema, { [RECORD_A]: sourceRecord }),
      { includeDeletions: false, uploads: 'referenced' },
    );
    expect(unchanged.records[0].action).to.equal('noop');
  });
});

function makeSchema(environmentId: string): SchemaSnapshot {
  const model: ItemTypeSchemaSnapshot = {
    id: MODEL_ID,
    apiKey: 'article',
    name: 'Article',
    modularBlock: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: true,
    draftSavingActive: true,
    allLocalesRequired: false,
    workflowId: null,
    fields: [
      {
        id: 'field-title',
        apiKey: 'title',
        fieldType: 'string',
        localized: true,
        position: 1,
        validators: {},
      },
      {
        id: 'field-blocks',
        apiKey: 'blocks',
        fieldType: 'rich_text',
        localized: false,
        position: 2,
        validators: { rich_text_blocks: { item_types: [BLOCK_MODEL_ID] } },
      },
      {
        id: 'field-target',
        apiKey: 'target',
        fieldType: 'link',
        localized: false,
        position: 3,
        validators: {},
      },
    ],
  };
  const block: ItemTypeSchemaSnapshot = {
    id: BLOCK_MODEL_ID,
    apiKey: 'hero',
    name: 'Hero',
    modularBlock: true,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: false,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [
      {
        id: 'field-block-target',
        apiKey: 'target',
        fieldType: 'link',
        localized: false,
        position: 1,
        validators: {},
      },
      {
        id: 'field-block-image',
        apiKey: 'image',
        fieldType: 'file',
        localized: false,
        position: 2,
        validators: {},
      },
    ],
  };
  const schema: SchemaSnapshot = {
    siteId: 'site',
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
    itemTypes: [block, model].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    workflows: [],
    digest: '',
  };
  schema.digest = computeSchemaDigest(schema);
  return schema;
}

function withRecomputedSchemaDigest(schema: SchemaSnapshot): SchemaSnapshot {
  const result = { ...schema, digest: '' };
  result.digest = computeSchemaDigest(result);
  return result;
}

function withHistoricalFloatDefault(schema: SchemaSnapshot): SchemaSnapshot {
  return withRecomputedSchemaDigest({
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) =>
      itemType.id === MODEL_ID
        ? {
            ...itemType,
            fields: [
              ...itemType.fields,
              {
                id: 'field-historical-number',
                apiKey: 'historical_number',
                fieldType: 'float' as const,
                localized: false,
                position: itemType.fields.length + 1,
                defaultValue: 42.625,
                validators: {},
              },
            ],
          }
        : itemType,
    ),
  });
}

function addExactMappingModel(schema: SchemaSnapshot): SchemaSnapshot {
  const model: ItemTypeSchemaSnapshot = {
    id: 'internal-content-diff-model',
    apiKey: DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
    name: 'Content diff',
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
        id: 'internal-content-diff-name',
        apiKey: 'name',
        fieldType: 'string',
        localized: false,
        position: 1,
        validators: { required: {}, unique: {} },
      },
      {
        id: 'internal-content-diff-mapping',
        apiKey: 'mapping',
        fieldType: 'json',
        localized: false,
        position: 2,
        validators: { required: {} },
      },
    ],
  };
  return withRecomputedSchemaDigest({
    ...schema,
    itemTypes: [...schema.itemTypes, model].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  });
}

function replaceTargetValidators(
  schema: SchemaSnapshot,
  validators: Record<string, any>,
): SchemaSnapshot {
  const result: SchemaSnapshot = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field) =>
        itemType.id === MODEL_ID && field.apiKey === 'target'
          ? { ...field, validators }
          : field,
      ),
    })),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function addRequiredUpstreamField(schema: SchemaSnapshot): SchemaSnapshot {
  const result: SchemaSnapshot = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) =>
      itemType.id === MODEL_ID
        ? {
            ...itemType,
            fields: [
              ...itemType.fields,
              {
                id: 'field-upstream',
                apiKey: 'upstream',
                fieldType: 'link' as const,
                localized: false,
                position: itemType.fields.length + 1,
                validators: { required: {} },
              },
            ],
          }
        : itemType,
    ),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function replaceTitleValidators(
  schema: SchemaSnapshot,
  validators: Record<string, any>,
): SchemaSnapshot {
  const result = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field) =>
        itemType.id === MODEL_ID && field.apiKey === 'title'
          ? { ...field, validators }
          : field,
      ),
    })),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function makeNestedStructuredTextSchema(environmentId: string): SchemaSnapshot {
  const schema = makeSchema(environmentId);
  const result: SchemaSnapshot = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field): FieldSchemaSnapshot => {
        if (itemType.id === MODEL_ID && field.apiKey === 'blocks') {
          return {
            ...field,
            fieldType: 'structured_text',
            validators: {
              structured_text_blocks: { item_types: [BLOCK_MODEL_ID] },
            },
          };
        }

        if (itemType.id === BLOCK_MODEL_ID && field.apiKey === 'target') {
          return {
            ...field,
            fieldType: 'structured_text',
            validators: {
              required: {},
              length: { min: 1 },
              structured_text_links: { item_types: [MODEL_ID] },
            },
          };
        }

        return field;
      }),
    })),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function makeRecursiveMappingSchema(environmentId: string): SchemaSnapshot {
  const schema = makeSchema(environmentId);
  const nestedField = (
    id: string,
    apiKey: string,
    fieldType: FieldSchemaSnapshot['fieldType'],
    localized: boolean,
    position: number,
  ): FieldSchemaSnapshot => ({
    id,
    apiKey,
    fieldType,
    localized,
    position,
    validators:
      fieldType === 'structured_text'
        ? { structured_text_blocks: { item_types: [BLOCK_MODEL_ID] } }
        : fieldType === 'single_block'
          ? { single_block_blocks: { item_types: [BLOCK_MODEL_ID] } }
          : fieldType === 'rich_text'
            ? { rich_text_blocks: { item_types: [BLOCK_MODEL_ID] } }
            : {},
  });
  const result: SchemaSnapshot = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => {
      if (itemType.id === MODEL_ID) {
        return {
          ...itemType,
          fields: [
            ...itemType.fields,
            nestedField(
              'field-structured',
              'structured',
              'structured_text',
              true,
              4,
            ),
            nestedField('field-single', 'single', 'single_block', true, 5),
            nestedField('field-asset', 'asset', 'file', false, 6),
            nestedField('field-gallery', 'gallery', 'gallery', false, 7),
            nestedField('field-seo', 'seo', 'seo', false, 8),
            nestedField('field-json-data', 'json_data', 'json', false, 9),
          ],
        };
      }

      return {
        ...itemType,
        fields: [
          ...itemType.fields.map((field) =>
            field.apiKey === 'target' ? { ...field, localized: true } : field,
          ),
          nestedField('field-block-body', 'body', 'structured_text', true, 3),
          nestedField('field-block-child', 'child', 'single_block', true, 4),
          nestedField('field-block-children', 'children', 'rich_text', true, 5),
          nestedField('field-block-json-data', 'json_data', 'json', false, 6),
        ],
      };
    }),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function addNoDraftModel(schema: SchemaSnapshot): SchemaSnapshot {
  const sourceModel = schema.itemTypes.find(({ id }) => id === MODEL_ID)!;
  const noDraftModel: ItemTypeSchemaSnapshot = {
    ...sourceModel,
    id: NO_DRAFT_MODEL_ID,
    apiKey: 'always_published_article',
    name: 'Always-published article',
    draftModeActive: false,
    draftSavingActive: false,
    fields: sourceModel.fields.map((field) => ({
      ...field,
      id: `no-draft-${field.id}`,
    })),
  };
  const result = {
    ...schema,
    itemTypes: [...schema.itemTypes, noDraftModel].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function makeNoDraftSingletonSchema(environmentId: string): SchemaSnapshot {
  const schema = addNoDraftModel(makeSchema(environmentId));
  const result: SchemaSnapshot = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => {
      if (itemType.id === MODEL_ID) {
        return {
          ...itemType,
          draftModeActive: false,
          draftSavingActive: false,
        };
      }
      if (itemType.id === NO_DRAFT_MODEL_ID) {
        return { ...itemType, singleton: true };
      }
      return itemType;
    }),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function setInvalidDraftSaving(
  schema: SchemaSnapshot,
  enabled: boolean,
): SchemaSnapshot {
  const result = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) =>
      itemType.id === MODEL_ID
        ? { ...itemType, draftSavingActive: enabled }
        : itemType,
    ),
    digest: '',
  };
  result.digest = computeSchemaDigest(result);
  return result;
}

function makeItem(id: string, fields: Record<string, any>) {
  return {
    id,
    type: 'item',
    item_type: { id: MODEL_ID, type: 'item_type' },
    ...fields,
    meta: {
      created_at: '2025-01-01T00:00:00Z',
      first_published_at: null,
      current_version: `version-${id}`,
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: true,
      updated_at: '2025-01-01T00:00:00Z',
      published_at: null,
      stage: null,
    },
  };
}

function makeRawBlock(id: string, target: string | null) {
  return {
    id,
    type: 'item',
    relationships: {
      item_type: {
        data: { id: BLOCK_MODEL_ID, type: 'item_type' },
      },
    },
    attributes: { target, image: null },
  };
}

function makeRawBlockWithFields(id: string, fields: Record<string, any>) {
  return {
    id,
    type: 'item',
    relationships: {
      item_type: {
        data: { id: BLOCK_MODEL_ID, type: 'item_type' },
      },
    },
    attributes: fields,
  };
}

function makeDast(children: any[]) {
  return {
    schema: 'dast',
    document: { type: 'root', children },
  };
}

function makeCustomStructuredText(children: any[], sidecar: any) {
  return {
    schema: 'custom-content-v1',
    document: { type: 'root', children, sidecar },
  };
}

function structuredTextWithBlock(blockId: string, targetRecordId: string) {
  return {
    schema: 'dast',
    document: {
      type: 'root',
      children: [
        {
          type: 'block',
          item: {
            id: blockId,
            type: 'item',
            relationships: {
              item_type: {
                data: { id: BLOCK_MODEL_ID, type: 'item_type' },
              },
            },
            attributes: {
              target: {
                schema: 'dast',
                document: {
                  type: 'root',
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'inlineItem', item: targetRecordId }],
                    },
                  ],
                },
              },
              image: null,
            },
          },
        },
      ],
    },
  };
}

function markCurrentInvalid(record: RecordSnapshot): RecordSnapshot {
  return {
    ...record,
    validity: { ...record.validity, current: false },
    consistency: { ...record.consistency, currentValid: false },
  };
}

function markCurrentAndPublishedInvalid(
  record: RecordSnapshot,
): RecordSnapshot {
  return {
    ...record,
    validity: { current: false, published: false },
    consistency: {
      ...record.consistency,
      currentValid: false,
      publishedValid: false,
    },
  };
}

function invalidDiagnostics(
  record: RecordSnapshot,
  issues: readonly InvalidContentValidationIssue[],
): InvalidContentDiagnostic[] {
  if (!record.published) {
    throw new Error(`record ${record.id} has no published version`);
  }

  return (['current', 'published'] as const).map((slice) => ({
    recordId: record.id,
    slice,
    versionHash:
      slice === 'current' ? record.current.hash : record.published!.hash,
    valid: false,
    issues: [...issues],
  }));
}

function makeCanonicalRecord(
  schema: SchemaSnapshot,
  id: string,
  fields: Record<string, any>,
): RecordSnapshot {
  const model = schema.itemTypes.find(
    ({ id: itemTypeId }) => itemTypeId === MODEL_ID,
  )!;
  return canonicalizeRecord(makeItem(id, fields), null, model, schema, {
    publication: null,
    unpublishing: null,
  });
}

function makeCanonicalRecordWithPublished(
  schema: SchemaSnapshot,
  id: string,
  currentFields: Record<string, any>,
  publishedFields: Record<string, any>,
): RecordSnapshot {
  const model = schema.itemTypes.find(
    ({ id: itemTypeId }) => itemTypeId === MODEL_ID,
  )!;
  return canonicalizeRecord(
    makeItem(id, currentFields),
    makeItem(id, publishedFields),
    model,
    schema,
    { publication: null, unpublishing: null },
  );
}

function makeCanonicalRecordForItemType(
  schema: SchemaSnapshot,
  id: string,
  itemTypeId: string,
  fields: Record<string, any>,
): RecordSnapshot {
  const itemType = schema.itemTypes.find(
    ({ id: candidateId }) => candidateId === itemTypeId,
  )!;
  const current = {
    ...makeItem(id, fields),
    item_type: { id: itemTypeId, type: 'item_type' },
  };

  return canonicalizeRecord(current, current, itemType, schema, {
    publication: null,
    unpublishing: null,
  });
}

function validCreateCycleDiagnostics(
  records: Record<string, RecordSnapshot>,
  schema: SchemaSnapshot,
  existingRecordIds: ReadonlySet<string> = new Set(),
): InvalidContentDiagnostic[] {
  return collectCreateCycleIntermediateCandidates(
    records,
    schema,
    new Set(
      Object.keys(records).filter(
        (recordId) => !existingRecordIds.has(recordId),
      ),
    ),
  )
    .filter(({ topologyCycle }) => !topologyCycle)
    .map(({ recordId, versionHash }) => ({
      recordId,
      slice: 'intermediate',
      versionHash,
      valid: true,
      issues: [],
    }));
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
    readItemTypes: schema.itemTypes
      .filter(({ modularBlock }) => !modularBlock)
      .map(({ id, workflowId }) => ({ id, workflowId })),
    records,
    uploads: {},
    uploadCollections: {},
    visibleRecordIds: Object.keys(records).sort(),
    blockOwnership: buildBlockOwnershipIndex(records, schema),
    digest: semanticHash(Object.values(records).map(({ hash }) => hash)),
  };
}

function emptyMappingRegistry(
  snapshot: ContentSnapshot,
): LegacyIdMappingRegistry {
  const empty = emptyLegacyIdMappingPlan(snapshot);
  return { schema: empty.schema, entries: [], records: [] };
}

function existingMappingRegistry(
  snapshot: ContentSnapshot,
  entries: LegacyIdMappingRegistry['entries'],
): LegacyIdMappingRegistry {
  const empty = emptyLegacyIdMappingPlan(snapshot);
  return {
    schema: {
      ...empty.schema,
      model: { ...empty.schema.model, status: 'existing' },
      nameField: { ...empty.schema.nameField, status: 'existing' },
      mappingField: { ...empty.schema.mappingField, status: 'existing' },
    },
    entries,
    records: [],
  };
}
