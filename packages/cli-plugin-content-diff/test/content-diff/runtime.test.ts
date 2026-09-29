import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import type { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import MigrationRunCommand from '../../src/commands/migrations/run';
import {
  canonicalizeJson,
  canonicalizeRecord,
  canonicalizeUpload,
  semanticHash,
  stableStringify,
} from '../../src/content-diff/canonicalize';
import {
  buildBlockOwnershipIndex,
  collectCreateCycleShellCandidates,
  collectRecordReferences,
  collectUploadReferences,
} from '../../src/content-diff/dependencies';
import { inspectionItemTypesDigest } from '../../src/content-diff/inspection-schema';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import {
  CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
  RUNTIME_VERSION,
  renderRuntime,
} from '../../src/content-diff/runtime-template';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import {
  findNonPortableCreateIds,
  findRecordSnapshotIdentityMismatches,
} from '../../src/content-diff/shared/create-id-contract';
import {
  findUnsupportedFreshNestedBlockUpdates,
  itemTypeIdsAffectedByValidatorChanges,
} from '../../src/content-diff/shared/fresh-nested-updates';
import {
  LEGACY_ID_MAPPING_FIELD_CONTRACT,
  LEGACY_ID_MAPPING_MODEL_ATTRIBUTES,
  LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT,
  legacyMappingFieldAttributes,
  legacyMappingFieldMismatches,
  legacyMappingModelMismatches,
} from '../../src/content-diff/shared/legacy-id-ledger';
import {
  uploadCollectionOrderContractError,
  uploadCollectionPlanContractError,
} from '../../src/content-diff/shared/upload-collection-contract';
import {
  compareUploadChanges,
  deriveRequiredUploadActions,
  isUploadRequestFilenameFixedPoint,
  uploadPlanContractError,
} from '../../src/content-diff/shared/upload-contract';
import { buildRecordValidationPayload } from '../../src/content-diff/shared/validation-payload';
import { inspectRecordStructuralContent } from '../../src/content-diff/structural-content';
import type {
  ContentDiffPlan,
  ContentSnapshot,
  JsonObject,
  RecordSnapshot,
  SchemaSnapshot,
  UploadCollectionSnapshot,
  UploadPlan,
  UploadSnapshot,
} from '../../src/content-diff/types';
import { CONTENT_SNAPSHOT_FORMAT_VERSION } from '../../src/content-diff/types';
import {
  EMBEDDING_KINDS,
  RECURSIVE_SEED,
  embeddingPaths,
  expandGeneratedPatch,
  generatedId,
  generatedRecursiveFixture,
  reverseObjectKeys,
  setValueAt,
  valueAt,
} from './generated-recursive-fixtures';

const RECORD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const MODEL_ID = '4QI3BfBvQs-hcv_YEkk1wg';
const BLOCK_ID = 'X4h0kJ7xQy2oO3UscO9V6Q';
const BLOCK_MODEL_ID = 'LkT6QfLoRXmEO7nLt6x0uA';
const EXTERNAL_PARENT_ID = 'N_x2F8mBRZivlvO0fD1q6A';
const MAPPING_MODEL_ID = '1I2mdfF_Qre8M0AGrWCDEg';
const MAPPING_NAME_FIELD_ID = 'QYqiNoqFQnWsQQyklwAEmw';
const MAPPING_FIELD_ID = 'gUrEai2rSwqtrVEYKJKgnw';
const MAPPING_BATCH_ID = 'MhFdacOuSjWkDS9TYlAsbw';
const MAPPING_RECORD_ID = 'ZI2O3FaURp6J5OpD7AtI_A';
const MIGRATIONS_MODEL_ID = 'HxJ7nR2gQ1yLp4Zv6sT8WA';
const MIGRATIONS_NAME_FIELD_ID = 'VvP4rT7mS9qLk2Nc5xY8ZA';
const temporaryDirectories: string[] = [];

describe('generated content migration runtime', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  for (let depth = 1; depth <= 5; depth += 1) {
    it(`preserves every recursive embedding path at depth ${depth} (seed ${RECURSIVE_SEED})`, async () => {
      const runtime = await loadRuntime(
        [
          'module.exports.__canonicalizeRuntimeRecord = canonicalizeRecord;',
          'module.exports.__collectRecordReferencesFromFields = collectRecordReferencesFromFields;',
          'module.exports.__collectUploadReferencesFromFields = collectUploadReferencesFromFields;',
          'module.exports.__collectNestedBlocks = collectNestedBlocks;',
          'module.exports.__buildRuntimeRecordValidationPayload = buildRuntimeRecordValidationPayload;',
          'module.exports.__applyCreateDefaultsToFields = applyCreateDefaultsToFields;',
          'module.exports.__buildVersionPatch = buildVersionPatch;',
        ].join('\n'),
      );
      let assertions = 0;
      const paths = embeddingPaths(depth);
      for (const path of paths) {
        const baseline = generatedRecursiveFixture(path, 0);
        const fixture = generatedRecursiveFixture(path, 2);
        const published = generatedRecursiveFixture(path, 1);
        for (const record of [fixture.input, published.input]) {
          Object.assign(record.meta, {
            is_published_version_valid: true,
            first_published_at: '2025-01-01T00:00:00Z',
            published_at: '2025-01-01T00:00:00Z',
          });
        }
        const untouched = structuredClone([
          fixture.input,
          published.input,
          fixture.schema,
        ]);
        const owner = fixture.schema.itemTypes[0];
        const schemaById = new Map(
          fixture.schema.itemTypes.map((itemType) => [itemType.id, itemType]),
        );
        const context = { schemaById, captureSchemaById: schemaById };
        const schedules = { publication: null, unpublishing: null };
        const current = canonicalizeRecord(
          fixture.input,
          published.input,
          owner,
          fixture.schema,
          schedules,
        );
        const check = (actual: unknown) => {
          assertions += 1;
          return expect(actual, fixture.label);
        };
        check(current.current.fields).to.deep.equal(fixture.canonicalFields);
        check(current.published?.fields).to.deep.equal(
          published.canonicalFields,
        );
        check(
          runtime.__canonicalizeRuntimeRecord!(
            fixture.input,
            published.input,
            owner,
            fixture.schema,
            schedules,
          ),
        ).to.deep.equal(current);
        check(
          canonicalizeRecord(
            reverseObjectKeys(fixture.input),
            reverseObjectKeys(published.input),
            owner,
            fixture.schema,
            schedules,
          ),
        ).to.deep.equal(current);
        const inspection = inspectRecordStructuralContent(
          fixture.input,
          owner,
          fixture.schema,
          RECORD_ID,
          'current',
        );
        check(inspection.issues).to.deep.equal([]);
        check(inspection.encounteredItemTypeIds).to.deep.equal(
          [...new Set(fixture.slots.map((slot) => slot.itemTypeId))].sort(),
        );
        check(
          [
            ...new Set(
              collectRecordReferences(current, fixture.schema).map(
                (entry) => entry.toRecordId,
              ),
            ),
          ].sort(),
        ).to.deep.equal(fixture.referenceIds);
        check(collectUploadReferences(current, fixture.schema)).to.deep.equal(
          fixture.uploadIds,
        );
        check(
          [
            ...runtime.__collectRecordReferencesFromFields!(
              current.current.fields,
              owner,
              context,
            ),
          ].sort(),
        ).to.deep.equal(fixture.referenceIds);
        const runtimeUploads = new Set<string>();
        runtime.__collectUploadReferencesFromFields!(
          current.current.fields,
          owner,
          context,
          runtimeUploads,
        );
        check([...runtimeUploads].sort()).to.deep.equal(fixture.uploadIds);
        const ownership = buildBlockOwnershipIndex(
          { [RECORD_ID]: current },
          fixture.schema,
        );
        check(Object.keys(ownership).sort()).to.deep.equal(
          fixture.slots.map((slot) => slot.id).sort(),
        );
        const expectedOwnership = fixture.slots.flatMap((slot) =>
          ['current', 'published'].map((version) => ({
            blockId: slot.id,
            topRecordId: RECORD_ID,
            itemTypeId: slot.itemTypeId,
            version,
            fieldPath: slot.fieldPath,
            locale: slot.locale,
          })),
        );
        check(
          Object.values(ownership)
            .flat()
            .map((entry) => stableStringify(entry))
            .sort(),
        ).to.deep.equal(
          expectedOwnership.map((entry) => stableStringify(entry)).sort(),
        );
        const runtimeBlocks = new Map<string, JsonObject>();
        runtime.__collectNestedBlocks!(
          current.current.fields,
          runtimeBlocks,
          owner,
          schemaById,
        );
        check([...runtimeBlocks.keys()].sort()).to.deep.equal(
          fixture.slots.map((slot) => slot.id).sort(),
        );
        const validation = structuredClone(fixture.canonicalFields);
        for (const slot of fixture.slots) {
          setValueAt(
            validation,
            slot.path,
            Object.fromEntries(
              Object.entries(valueAt(validation, slot.path)).filter(
                ([key]) => key !== 'id',
              ),
            ),
          );
        }
        check(
          buildRecordValidationPayload(
            current.current.fields,
            MODEL_ID,
            fixture.schema,
          ),
        ).to.deep.equal(validation);
        check(
          runtime.__buildRuntimeRecordValidationPayload!(
            context,
            current.current.fields,
            MODEL_ID,
          ),
        ).to.deep.equal(validation);
        check(
          runtime.__applyCreateDefaultsToFields!(
            current.current.fields,
            owner,
            fixture.schema,
          ),
        ).to.deep.equal(fixture.canonicalFields);
        const patch = runtime.__buildVersionPatch!(
          current.current.fields,
          baseline.canonicalFields,
          { current: { fields: baseline.canonicalFields } },
          owner,
          schemaById,
        );
        const reconstructed = expandGeneratedPatch(
          { ...baseline.canonicalFields, ...patch },
          baseline.canonicalFields,
          fixture.slots,
        );
        check(reconstructed).to.deep.equal(fixture.canonicalFields);
        check(
          runtime.__buildVersionPatch!(
            current.current.fields,
            reconstructed,
            { current: { fields: reconstructed } },
            owner,
            schemaById,
          ),
        ).to.deep.equal({});
        check([fixture.input, published.input, fixture.schema]).to.deep.equal(
          untouched,
        );
      }
      expect(paths).to.have.length(4 ** depth);
      console.info(
        `Recursive depth ${depth}: ${paths.length} generated paths; ${assertions} semantic assertions; seed ${RECURSIVE_SEED}.`,
      );
    });
  }

  it('keeps absent, null, empty localized content and meaningful DAST order distinct', () => {
    for (const kind of EMBEDDING_KINDS) {
      const fixture = generatedRecursiveFixture([kind]);
      const owner = fixture.schema.itemTypes[0];
      owner.fields.find((field) => field.apiKey === 'content')!.localized =
        true;
      const empty =
        kind === 'rich_text'
          ? []
          : kind === 'single_block'
            ? null
            : {
                schema: 'dast',
                document: {
                  type: 'root',
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'span', value: '' }],
                    },
                  ],
                },
              };
      const { content: _content, ...withoutContent } = fixture.canonicalFields;
      const variants: JsonObject[] = [
        withoutContent,
        { ...withoutContent, content: null },
        { ...withoutContent, content: {} },
        { ...withoutContent, content: { en: null } },
        ...(empty === null
          ? []
          : [{ ...withoutContent, content: { en: empty } }]),
      ];
      const hashes = variants.map(
        (fields) =>
          canonicalizeRecord(
            fixture.resource(fields),
            null,
            owner,
            fixture.schema,
            { publication: null, unpublishing: null },
          ).current.hash,
      );
      expect(new Set(hashes).size, kind).to.equal(variants.length);
    }
    const fixture = generatedRecursiveFixture(['block']);
    const changed = structuredClone(fixture.canonicalFields);
    const root = fixture.localized
      ? (changed.content as any).en.document
      : (changed.content as any).document;
    root.children.reverse();
    expect(semanticHash(changed)).not.to.equal(
      semanticHash(fixture.canonicalFields),
    );
  });

  it('converges and replays generated deep compositions through create, update and split publication states', async () => {
    const runtime = await loadRuntime();
    let migrations = 0;
    for (const pair of embeddingPaths(2)) {
      const path = [
        ...pair,
        ...EMBEDDING_KINDS.filter((kind) => kind !== pair[0]),
      ];
      for (const create of [false, true]) {
        for (const hasPublished of [false, true]) {
          const baseline = generatedRecursiveFixture(path, 0, {
            withUploads: false,
            wireJson: true,
            sharedPeer: true,
          });
          const desired = generatedRecursiveFixture(path, 2, {
            withUploads: false,
            wireJson: true,
            sharedPeer: true,
          });
          const published = generatedRecursiveFixture(path, 1, {
            withUploads: false,
            wireJson: true,
            sharedPeer: true,
          });
          const sourceSchema = desired.schema;
          const targetSchema = {
            ...sourceSchema,
            environmentId: 'destination',
          };
          const record = (
            fields: JsonObject,
            publishedFields: JsonObject | null,
          ) => {
            const currentInput = desired.resource(fields);
            const publishedInput = publishedFields
              ? desired.resource(publishedFields)
              : null;
            for (const input of [currentInput, publishedInput]) {
              if (input && publishedFields)
                Object.assign(input.meta, {
                  is_published_version_valid: true,
                  first_published_at: '2025-01-01T00:00:00Z',
                  published_at: '2025-01-01T00:00:00Z',
                });
            }
            return canonicalizeRecord(
              currentInput,
              publishedInput,
              sourceSchema.itemTypes[0],
              sourceSchema,
              { publication: null, unpublishing: null },
            );
          };
          const sourceRecord = record(
            desired.canonicalFields,
            hasPublished ? published.canonicalFields : null,
          );
          const source = makeSnapshot(sourceSchema, sourceRecord);
          const target = create
            ? makeEmptySnapshot(targetSchema)
            : makeSnapshot(
                targetSchema,
                record(
                  baseline.canonicalFields,
                  hasPublished ? baseline.canonicalFields : null,
                ),
              );
          source.visibleRecordIds.push(EXTERNAL_PARENT_ID);
          target.visibleRecordIds.push(EXTERNAL_PARENT_ID);
          const plan = buildContentDiffPlan(source, target, {
            includeDeletions: false,
            uploads: 'referenced',
            migrateInvalidContent: false,
          });
          const inputBefore = structuredClone([source, target, plan]);
          const mock = makeGeneratedRecursiveRuntimeClient(
            desired,
            create ? null : baseline.canonicalFields,
            !create && hasPublished ? baseline.canonicalFields : null,
          );
          const label = `${desired.label} create=${create} published=${hasPublished}`;
          await runtime.runContentDiffMigration(
            mock.client,
            makeEnvelope(plan),
            { log: () => undefined },
          );
          expect(mock.fields(), label).to.deep.equal(desired.canonicalFields);
          expect(mock.publishedFields(), label).to.deep.equal(
            hasPublished ? published.canonicalFields : null,
          );
          expect(mock.writes(), label).to.be.greaterThan(0);
          const firstWrites = mock.writes();
          await runtime.runContentDiffMigration(
            mock.client,
            makeEnvelope(plan),
            { log: () => undefined },
          );
          expect(mock.writes(), label).to.equal(firstWrites);
          expect([source, target, plan], label).to.deep.equal(inputBefore);
          migrations += 2;
        }
      }
    }
    expect(migrations).to.equal(128);
    console.info(
      'Generated lifecycle matrix: 64 plans, 128 full runtime executions, 320 semantic assertions.',
    );
  });

  it('converges fresh nested IDs across valid updates, publication releases and source creation', async () => {
    const runtime = await loadRuntime();
    let executions = 0;
    for (const pair of embeddingPaths(2)) {
      for (const scenario of [
        'unused-update',
        'unused-split-update',
        'create-split',
        'unpublish-reintroduce',
        'publish-reintroduce',
      ] as const) {
        const state = makeGeneratedFreshIdRuntimeCase(pair, scenario);
        const inputBefore = structuredClone(state.plan);
        const label = `${pair.join('/')} ${scenario}`;
        expect(state.plan.records, label).to.have.length(1);
        await runtime.runContentDiffMigration(
          state.mock.client,
          makeEnvelope(state.plan),
          { log: () => undefined },
        );
        expect(state.mock.fields(), label).to.deep.equal(state.desiredFields);
        expect(state.mock.publishedFields(), label).to.deep.equal(
          state.desiredPublished,
        );
        expect(state.mock.validatedPayloads.length, label).to.be.greaterThan(0);
        const writes = state.mock.writes();
        const validations = state.mock.validatedPayloads.length;
        await runtime.runContentDiffMigration(
          state.mock.client,
          makeEnvelope(state.plan),
          { log: () => undefined },
        );
        expect(state.mock.writes(), label).to.equal(writes);
        expect(state.mock.validatedPayloads.length, label).to.equal(
          validations,
        );
        expect(state.plan, label).to.deep.equal(inputBefore);
        executions += 2;
      }
    }
    expect(executions).to.equal(160);
  });

  it('preflights fresh nested IDs without stripping them and stops before writes on validation failure', async () => {
    const runtime = await loadRuntime();
    for (const failure of ['model-revalidation', 'validation-error'] as const) {
      const state = makeGeneratedFreshIdRuntimeCase(
        ['single_block', 'inlineBlock'],
        'unused-update',
        failure === 'model-revalidation'
          ? { modelValidating: true }
          : {
              validateExistingError: new Error(
                'Validation service unavailable',
              ),
            },
      );
      expect(state.plan.records).to.have.length(1);
      const error = await expectRejects(
        runtime.runContentDiffMigration(
          state.mock.client,
          makeEnvelope(state.plan),
          { log: () => undefined },
        ),
      );
      expect((error as RuntimeError).code).to.equal(
        'FRESH_NESTED_BLOCK_VALIDATION_FAILURE',
      );
      expect(state.mock.writes()).to.equal(0);
      expect(state.mock.validatedPayloads).to.have.length(1);
      const expected = valueAt(state.desiredFields, state.leaf.path);
      expect(
        valueAt(state.mock.validatedPayloads[0], state.leaf.path),
      ).to.deep.equal(expected);
    }
  });

  it('rechecks the current version after exact fresh-ID validation and rejects late ID occupancy before writes', async () => {
    const runtime = await loadRuntime();
    for (const [options, expectedCode, validations] of [
      [{ changeVersionAfterValidation: true }, 'TARGET_CONFLICT', 1],
      [{ occupyFreshIdAfterInitialRead: true }, 'BLOCK_ID_CONFLICT', 0],
    ] as const) {
      const state = makeGeneratedFreshIdRuntimeCase(
        ['block', 'rich_text'],
        'unused-update',
        options,
      );
      const error = await expectRejects(
        runtime.runContentDiffMigration(
          state.mock.client,
          makeEnvelope(state.plan),
          { log: () => undefined },
        ),
      );
      expect((error as RuntimeError).code).to.equal(expectedCode);
      expect(state.mock.writes()).to.equal(0);
      expect(state.mock.validatedPayloads).to.have.length(validations);
    }
  });

  it('rejects non-portable fresh UPDATE IDs and deleted-then-recreated legacy IDs before CMA reads', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__findNonPortableCreateIds = findNonPortableCreateIds;\n',
    );
    for (const scenario of [
      'unused-update',
      'publish-reintroduce',
      'unpublish-reintroduce',
    ] as const) {
      const state = makeGeneratedFreshIdRuntimeCase(
        ['single_block', 'block'],
        scenario,
      );
      const record = state.plan.records[0];
      const legacyId = '12345';
      valueAt(record.desired!.current.fields, state.leaf.path).id = legacyId;
      if (scenario === 'publish-reintroduce') {
        valueAt(record.baseline!.current.fields, state.leaf.path).id = legacyId;
        valueAt(record.baseline!.published!.fields, state.leaf.path).id =
          legacyId;
      } else if (scenario === 'unpublish-reintroduce') {
        valueAt(record.baseline!.published!.fields, state.leaf.path).id =
          legacyId;
      }
      for (const snapshot of [record.baseline, record.desired]) {
        if (!snapshot) continue;
        for (const version of [snapshot.current, snapshot.published]) {
          if (version) version.hash = semanticHash(version.fields);
        }
      }
      expect(findNonPortableCreateIds(state.plan), scenario).to.deep.equal([
        legacyId,
      ]);
      expect(
        runtime.__findNonPortableCreateIds!(state.plan),
        scenario,
      ).to.deep.equal([legacyId]);
      const client = new Proxy(
        {},
        {
          get() {
            throw new Error('CMA was accessed');
          },
        },
      ) as CmaClient.Client;
      const error = await expectRejects(
        runtime.runContentDiffMigration(client, makeEnvelope(state.plan), {
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(error.message).to.contain(
        'non-portable IDs for CMA creates: 12345',
      );
    }
    const retained = makeGeneratedFreshIdRuntimeCase(
      ['rich_text', 'inlineBlock'],
      'unused-update',
    );
    for (const snapshot of [
      retained.plan.records[0].baseline!,
      retained.plan.records[0].desired!,
    ]) {
      valueAt(snapshot.current.fields, retained.leaf.path).id = '12345';
      snapshot.current.hash = semanticHash(snapshot.current.fields);
    }
    expect(findNonPortableCreateIds(retained.plan)).to.deep.equal([]);
    expect(runtime.__findNonPortableCreateIds!(retained.plan)).to.deep.equal(
      [],
    );
  });

  it('keeps runtime admission aligned for transitive validator changes and projected creation seeds', async () => {
    const runtime = await loadRuntime(
      [
        'module.exports.__findUnsupportedFreshNestedBlockUpdates = findUnsupportedFreshNestedBlockUpdates;',
        'module.exports.__itemTypeIdsAffectedByValidatorChanges = itemTypeIdsAffectedByValidatorChanges;',
        'module.exports.__unsafeFreshNestedCreateRecordIds = unsafeFreshNestedCreateRecordIds;',
      ].join('\n'),
    );
    for (const pair of embeddingPaths(2)) {
      const state = makeGeneratedFreshIdRuntimeCase(pair, 'unused-update');
      const schemaById = new Map(
        state.plan.schema.itemTypes.map((type) => [type.id, type]),
      );
      const changedTypes = new Set([state.leaf.itemTypeId]);
      const blocked = itemTypeIdsAffectedByValidatorChanges(
        state.plan.schema,
        changedTypes,
      );
      expect([...blocked].sort()).to.deep.equal(
        state.plan.schema.itemTypes.map((type) => type.id).sort(),
      );
      expect(
        [
          ...runtime.__itemTypeIdsAffectedByValidatorChanges!(
            schemaById,
            changedTypes,
          ),
        ].sort(),
      ).to.deep.equal([...blocked].sort());
      expect(
        runtime.__findUnsupportedFreshNestedBlockUpdates!(
          state.plan.records,
          schemaById,
          schemaById,
          blocked,
        ),
      ).to.deep.equal(
        findUnsupportedFreshNestedBlockUpdates(
          state.plan.records,
          state.plan.schema,
          state.plan.schema,
          blocked,
        ),
      );
      expect(
        runtime.__findUnsupportedFreshNestedBlockUpdates!(
          state.plan.records,
          schemaById,
          schemaById,
          blocked,
        ),
      ).to.have.length(1);
    }
    const projected = makeGeneratedFreshIdRuntimeCase(
      ['single_block', 'block'],
      'create-split',
    );
    const record = projected.plan.records[0];
    record.desired!.published!.fields.peer = RECORD_ID;
    record.desired!.published!.hash = semanticHash(
      record.desired!.published!.fields,
    );
    const schemaById = new Map(
      projected.plan.schema.itemTypes.map((type) => [type.id, type]),
    );
    const unsafeCreates = runtime.__unsafeFreshNestedCreateRecordIds!(
      projected.plan,
    );
    expect([...unsafeCreates]).to.deep.equal([RECORD_ID]);
    expect(
      runtime.__findUnsupportedFreshNestedBlockUpdates!(
        projected.plan.records,
        schemaById,
        schemaById,
        new Set(),
        unsafeCreates,
      ),
    ).to.have.length(1);
  });

  it('removes each uncreated self reference inside an optional multi-record cycle', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__expectedCreateSeedFields = expectedCreateSeedFields;\n',
    );
    const records = [RECORD_ID, EXTERNAL_PARENT_ID].map((id) => ({
      id,
      itemTypeId: MODEL_ID,
      action: 'create',
      desired: {
        current: { fields: { peers: [RECORD_ID, EXTERNAL_PARENT_ID] } },
        published: null,
      },
    }));
    const context = {
      plan: {
        records,
        execution: {
          createOrder: [RECORD_ID, EXTERNAL_PARENT_ID],
          shellRecordIds: [],
          shellComponents: [],
        },
      },
      schemaById: new Map([
        [
          MODEL_ID,
          {
            id: MODEL_ID,
            fields: [
              {
                apiKey: 'peers',
                fieldType: 'links',
                localized: false,
                validators: {},
              },
            ],
          },
        ],
      ]),
    };
    expect(
      runtime.__expectedCreateSeedFields!(context, records[0]),
    ).to.deep.equal({ peers: [] });
    expect(
      runtime.__expectedCreateSeedFields!(context, records[1]),
    ).to.deep.equal({ peers: [RECORD_ID] });
  });

  it('bounds fresh block ownership lookups to five concurrent individual reads', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifyBlockOwnershipSafety = verifyBlockOwnershipSafety;\n',
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximum = 0;
    const reads: string[] = [];
    const context = makeGeneratedBlockOwnershipContext(
      12,
      async (id, query) => {
        expect(query).to.deep.equal({ version: 'current', nested: false });
        reads.push(id);
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        throw Object.assign(new Error('missing'), {
          response: { status: 404 },
        });
      },
    );
    const pending = runtime.__verifyBlockOwnershipSafety!(context);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).to.have.length(5);
      expect(active).to.equal(5);
    } finally {
      release();
      await pending;
    }
    expect(reads).to.have.length(12);
    expect(new Set(reads).size).to.equal(12);
    expect(maximum).to.equal(5);
    expect(active).to.equal(0);
  });

  it('drains in-flight block ownership reads and stops queued work after a permission failure', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifyBlockOwnershipSafety = verifyBlockOwnershipSafety;\n',
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let active = 0;
    let settled = false;
    const failure = Object.assign(new Error('forbidden block'), {
      response: { status: 403 },
    });
    const context = makeGeneratedBlockOwnershipContext(12, async () => {
      const index = started++;
      active += 1;
      try {
        if (index === 0) {
          await Promise.resolve();
          throw failure;
        }
        await gate;
        return null;
      } finally {
        active -= 1;
      }
    });
    const pending = runtime.__verifyBlockOwnershipSafety!(context).then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started).to.equal(5);
      expect(active).to.equal(4);
      expect(settled).to.equal(false);
    } finally {
      release();
    }
    expect(await pending).to.equal(failure);
    expect(started).to.equal(5);
    expect(active).to.equal(0);
  });

  it('preserves exact resumed block ownership and rejects misplaced or occupied IDs', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifyBlockOwnershipSafety = verifyBlockOwnershipSafety;\n',
    );
    const context = makeGeneratedBlockOwnershipContext(8, async (id) => ({
      id,
      type: 'item',
    }));
    const record = context.plan.records[0];
    context.initialRecords.set(RECORD_ID, structuredClone(record.desired));
    await runtime.__verifyBlockOwnershipSafety!(context);
    const moved = structuredClone(record.desired);
    moved.current.fields.content.reverse();
    context.initialRecords.set(RECORD_ID, moved);
    await runtime.__verifyBlockOwnershipSafety!(context);
    const owner = context.schemaById.get(MODEL_ID)!;
    owner.fields.push({
      ...owner.fields.find((field) => field.apiKey === 'content')!,
      id: 'other-content',
      apiKey: 'other_content',
    });
    context.initialRecords.set(RECORD_ID, {
      current: {
        fields: { content: [], other_content: moved.current.fields.content },
      },
      published: null,
    });
    const collision = await expectRejects(
      runtime.__verifyBlockOwnershipSafety!(context),
    );
    expect((collision as RuntimeError).code).to.equal(
      'BLOCK_OWNERSHIP_CONFLICT',
    );
    context.initialRecords.clear();
    const occupied = await expectRejects(
      runtime.__verifyBlockOwnershipSafety!(context),
    );
    expect((occupied as RuntimeError).code).to.equal(
      'BLOCK_OWNERSHIP_CONFLICT',
    );
  });

  it('rejects block ownership lookup failures before creating the aggregate', async () => {
    const fixture = generatedRecursiveFixture(
      ['block', 'single_block', 'inlineBlock'],
      0,
      { withUploads: false, wireJson: true, sharedPeer: true },
    );
    const sourceRecord = canonicalizeRecord(
      fixture.input,
      null,
      fixture.schema.itemTypes[0],
      fixture.schema,
      { publication: null, unpublishing: null },
    );
    const source = makeSnapshot(fixture.schema, sourceRecord);
    const target = makeEmptySnapshot({
      ...fixture.schema,
      environmentId: 'destination',
    });
    source.visibleRecordIds.push(EXTERNAL_PARENT_ID);
    target.visibleRecordIds.push(EXTERNAL_PARENT_ID);
    const plan = buildContentDiffPlan(source, target, {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
    });
    const runtime = await loadRuntime();
    for (const status of [403, 500]) {
      const mock = makeGeneratedRecursiveRuntimeClient(fixture, null, null);
      const originalFind = mock.client.items.find.bind(mock.client.items);
      const failure = Object.assign(new Error(`block lookup ${status}`), {
        response: { status },
      });
      mock.client.items.find = (async (id: string, options: any) => {
        if (fixture.slots.some((slot) => slot.id === id)) throw failure;
        return originalFind(id, options);
      }) as typeof mock.client.items.find;
      const error = await expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          log: () => undefined,
        }),
      );
      expect(error).to.equal(failure);
      expect(mock.writes()).to.equal(0);
    }
  });

  it('retains fresh descendant restrictions for invalid states and published-only IDs across every deep embedding transition', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__findUnsupportedFreshNestedBlockUpdates = findUnsupportedFreshNestedBlockUpdates;\n',
    );
    let contracts = 0;
    for (const pair of embeddingPaths(2)) {
      const fixture = generatedRecursiveFixture(
        [...pair, 'block', 'single_block', 'inlineBlock'],
        0,
        { withUploads: false },
      );
      const changed = generatedRecursiveFixture(
        [...pair, 'block', 'single_block', 'inlineBlock'],
        1,
        { withUploads: false },
      );
      const leaf = fixture.slots.find(
        (slot) =>
          slot.path.length ===
          Math.max(...fixture.slots.map((entry) => entry.path.length)),
      )!;
      const freshId = generatedId(`${fixture.label}:fresh-descendant`);
      const fresh = structuredClone(changed.canonicalFields);
      valueAt(fresh, leaf.path).id = freshId;
      const historicalPublished = structuredClone(fresh);
      valueAt(historicalPublished, leaf.path).attributes.caption =
        'older publication';
      const version = (fields: JsonObject) => ({
        fields,
        hash: semanticHash(fields),
      });
      const snapshot = (current: JsonObject, published: JsonObject | null) => ({
        itemTypeId: MODEL_ID,
        current: version(current),
        published: published ? version(published) : null,
        validity: { current: true, published: published ? true : null },
      });
      const invalidBaseline = snapshot(fixture.canonicalFields, null);
      invalidBaseline.validity.current = false;
      const invalidCreate = snapshot(fresh, fixture.canonicalFields);
      invalidCreate.validity.published = false;
      const cases = [
        {
          action: 'update',
          baseline: invalidBaseline,
          desired: snapshot(fresh, null),
          stage: 'current-restore',
          slice: 'current',
        },
        {
          action: 'update',
          baseline: snapshot(fixture.canonicalFields, historicalPublished),
          desired: snapshot(fresh, fresh),
          stage: 'published-stage',
          slice: 'published',
        },
        {
          action: 'create',
          baseline: null,
          desired: invalidCreate,
          stage: 'current-restore',
          slice: 'current',
        },
      ];
      for (const entry of cases) {
        const record = {
          id: RECORD_ID,
          itemTypeId: MODEL_ID,
          action: entry.action,
          baseline: entry.baseline,
          desired: entry.desired,
        } as ContentDiffPlan['records'][number];
        const expected = [
          {
            recordId: RECORD_ID,
            stage: entry.stage,
            slice: entry.slice,
            blockId: freshId,
          },
        ];
        expect(
          findUnsupportedFreshNestedBlockUpdates([record], fixture.schema),
          fixture.label,
        ).to.deep.equal(expected);
        expect(
          runtime.__findUnsupportedFreshNestedBlockUpdates!(
            [record],
            new Map(fixture.schema.itemTypes.map((type) => [type.id, type])),
          ),
          fixture.label,
        ).to.deep.equal(expected);
        contracts += 1;
      }
    }
    expect(contracts).to.equal(48);
  });

  it('rejects missing and mismatched runner protocols before manifest or CMA access', async () => {
    const runtime = await loadRuntime();
    let clientReads = 0;
    const client = new Proxy(
      {},
      {
        get() {
          clientReads += 1;
          throw new Error('CMA client was accessed');
        },
      },
    ) as CmaClient.Client;

    for (const executionContext of [
      undefined,
      {},
      {
        contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION + 1,
      },
    ]) {
      const error = await expectRejects(
        runtime.__runContentDiffMigrationWithoutProtocolDefaults!(
          client,
          null as unknown as RuntimeEnvelope,
          { executionContext },
        ),
      );

      expect((error as RuntimeError).code).to.equal(
        'UNSUPPORTED_RUNNER_PROTOCOL',
      );
      expect(error.message).to.contain(
        `expected ${CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION}`,
      );
      expect(error.message).to.contain('Upgrade the datocms CLI');
    }

    expect(clientReads).to.equal(0);
  });

  it('accepts the current runner protocol and then validates the manifest before CMA access', async () => {
    const runtime = await loadRuntime();
    let clientReads = 0;
    const client = new Proxy(
      {},
      {
        get() {
          clientReads += 1;
          throw new Error('CMA client was accessed');
        },
      },
    ) as CmaClient.Client;

    const error = await expectRejects(
      runtime.__runContentDiffMigrationWithoutProtocolDefaults!(
        client,
        null as unknown as RuntimeEnvelope,
        {
          executionContext: {
            contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
          },
        },
      ),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_MANIFEST');
    expect(clientReads).to.equal(0);
  });

  it('runs a no-op plan repeatedly without issuing a CMA mutation', async () => {
    const plan = makeRuntimePlan('unchanged', 'unchanged');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');
    const logs: string[] = [];

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: (message: string) => logs.push(message),
    });
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: (message: string) => logs.push(message),
    });

    expect(mock.mutations).to.deep.equal({ update: 0 });
    expect(
      logs.filter((line) => line.includes('0 CMA mutations')),
    ).to.have.length(2);
    expect(logs.filter((line) => line.includes('[12/12]'))).to.have.length(2);
  });

  it('drains active concurrent work and stops queued work before propagating a failure', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__mapWithConcurrency = mapWithConcurrency;\n',
    );
    let releaseActiveWork!: () => void;
    const activeWork = new Promise<void>((resolve) => {
      releaseActiveWork = resolve;
    });
    const started: number[] = [];
    const completed: number[] = [];
    const originalError = new Error('download failed');
    let settled = false;
    const operation = expectRejects(
      runtime.__mapWithConcurrency!([0, 1, 2], 2, async (value) => {
        started.push(value);
        if (value === 0) throw originalError;
        await activeWork;
        completed.push(value);
        return value;
      }),
    ).then((error) => {
      settled = true;
      return error;
    });
    let settledBeforeActiveWorkFinished: boolean;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      settledBeforeActiveWorkFinished = settled;
    } finally {
      releaseActiveWork();
    }

    expect(await operation).to.equal(originalError);
    expect(settledBeforeActiveWorkFinished).to.equal(false);
    expect(started).to.deep.equal([0, 1]);
    expect(completed).to.deep.equal([1]);
  });

  it('matches generator inspection hashes and ID ordering regardless of the ambient locale', async () => {
    const runtime = await loadRuntime(
      [
        'module.exports.__validateTargetInspection = validateTargetInspection;',
        'module.exports.__inspectionItemTypesDigest = inspectionItemTypesDigest;',
      ].join('\n'),
    );
    const plan = makeRuntimePlan('same', 'same');
    const blockType = plan.schema.itemTypes.find(
      ({ modularBlock }) => modularBlock,
    )!;
    plan.targetInspection.itemTypes = [
      'IhEa5SbeSl6KwIFizzkzig',
      'ihEa5SbeSl6KwIFizzkzig',
    ].map((id) => ({
      ...structuredClone(blockType),
      id,
      apiKey: `inspection_${id}`,
      fields: [],
    }));
    plan.targetInspection.digest = inspectionItemTypesDigest(
      plan.targetInspection.itemTypes,
    );
    const localeCompare = String.prototype.localeCompare;
    try {
      for (const locale of ['en', 'tr']) {
        const collator = new Intl.Collator(locale);
        String.prototype.localeCompare = function (other) {
          return collator.compare(String(this), other);
        };
        runtime.__validateTargetInspection!(plan);
        expect(
          runtime.__inspectionItemTypesDigest!(
            plan.targetInspection.itemTypes.slice().reverse(),
          ),
        ).to.equal(plan.targetInspection.digest);
      }
    } finally {
      String.prototype.localeCompare = localeCompare;
    }
  });

  it('accepts aligned projects even when both endpoint environments have the same ID', async () => {
    const plan = makeAlignedRuntimePlan('unchanged', 'unchanged');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', { siteId: 'target-site' });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });

    expect(plan.options.projectMode).to.equal('aligned_projects');
    expect(plan.source.environmentId).to.equal('main');
    expect(plan.target.environmentId).to.equal('main');
    expect(mock.reads.site).to.be.greaterThan(0);
    expect(mock.mutations.update).to.equal(0);
  });

  it('rejects inconsistent project modes and identical endpoints before CMA access', async () => {
    const runtime = await loadRuntime();
    const cases = [
      (() => {
        const plan = makeAlignedRuntimePlan('unchanged', 'unchanged');
        plan.options.projectMode = 'same_project';
        return plan;
      })(),
      (() => {
        const plan = makeRuntimePlan('unchanged', 'unchanged');
        plan.options.projectMode = 'aligned_projects';
        return plan;
      })(),
      (() => {
        const plan = makeRuntimePlan('unchanged', 'unchanged');
        plan.target.environmentId = plan.source.environmentId;
        return plan;
      })(),
    ];

    for (const plan of cases) {
      const mock = makeRuntimeClient('unchanged');
      const error = await expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(mock.reads.site).to.equal(0);
      expect(mock.mutations.update).to.equal(0);
    }
  });

  it('retains the target-site check as runtime defense in depth', async () => {
    const plan = makeAlignedRuntimePlan('unchanged', 'unchanged');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', { siteId: 'wrong-site' });

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('WRONG_TARGET_SITE');
    expect(mock.mutations.update).to.equal(0);
  });

  it('converges an update and treats a second run as already desired', async () => {
    const plan = makeRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline');

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });
    expect(mock.current().title).to.equal('desired');
    expect(mock.mutations.update).to.equal(1);

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });
    expect(mock.current().title).to.equal('desired');
    expect(mock.mutations.update).to.equal(1);
  });

  it('projects localized and nested Structured Text cycle shells exactly like the generator', async () => {
    const schema = makeStructuredTextProjectionSchema('source');
    const model = schema.itemTypes.find(({ id }) => id === MODEL_ID)!;
    const records: Record<
      string,
      ReturnType<typeof makeStructuredTextProjectionRecord>
    > = {
      [RECORD_ID]: makeStructuredTextProjectionRecord(
        schema,
        RECORD_ID,
        EXTERNAL_PARENT_ID,
        BLOCK_ID,
      ),
      [EXTERNAL_PARENT_ID]: makeStructuredTextProjectionRecord(
        schema,
        EXTERNAL_PARENT_ID,
        RECORD_ID,
        MAPPING_RECORD_ID,
      ),
    };
    const componentIds = new Set(Object.keys(records));
    const candidates = collectCreateCycleShellCandidates(
      records,
      schema,
      componentIds,
    );
    const lengthOnlySchema = structuredClone(schema);
    const lengthOnlyBody = lengthOnlySchema.itemTypes
      .find(({ id }) => id === MODEL_ID)!
      .fields.find(({ apiKey }) => apiKey === 'body')!;
    const { required: _required, ...lengthOnlyValidators } =
      lengthOnlyBody.validators;
    lengthOnlyBody.validators = lengthOnlyValidators;
    expect(
      collectRecordReferences(records[RECORD_ID], lengthOnlySchema)
        .filter(({ path }) => path.includes('.body.'))
        .every(({ required }) => required),
    ).to.equal(true);
    const runtime = await loadRuntime(
      '\nmodule.exports.__stripUnavailableReferences = stripUnavailableReferences;\nmodule.exports.__fieldIsRequired = fieldIsRequired;\n',
    );
    const context = {
      schemaById: new Map(
        schema.itemTypes.map((itemType) => [itemType.id, itemType]),
      ),
    };

    expect(candidates.map(({ recordId }) => recordId)).to.deep.equal(
      [...componentIds].sort(),
    );
    expect(
      runtime.__fieldIsRequired?.({
        fieldType: 'structured_text',
        validators: { length: { min: 1 } },
      }),
    ).to.equal(true);
    expect(
      runtime.__fieldIsRequired?.({
        fieldType: 'structured_text',
        validators: { size: { min: 1 } },
      }),
    ).to.equal(false);

    for (const candidate of candidates) {
      const record = records[candidate.recordId];
      const projected = runtime.__stripUnavailableReferences?.(
        record.current.fields,
        model,
        context.schemaById,
        componentIds,
        `record ${candidate.recordId}`,
        'strip',
      );

      expect(projected).to.deep.equal(candidate.fields);
      expect(semanticHash(projected)).to.equal(candidate.versionHash);
      expect(stableStringify(projected)).not.to.contain(
        candidate.recordId === RECORD_ID ? EXTERNAL_PARENT_ID : RECORD_ID,
      );
      expect(
        (projected as any).body.en.document.children[0].children,
      ).to.deep.equal([{ type: 'span', value: 'linked en' }]);
      expect(
        (projected as any).safe_body.en.document.children[0].children,
      ).to.deep.equal([{ type: 'span', value: 'safe enlinked en' }]);
      expect(
        (projected as any).blocks.document.children[0].item.attributes.body
          .document.children[0].children,
      ).to.deep.equal([{ type: 'span', value: 'linked nested' }]);
    }

    const emptyDast = {
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'span', value: '' }],
          },
        ],
      },
    };
    const inlineOnlyRecords: Record<
      string,
      ReturnType<typeof makeStructuredTextProjectionRecord>
    > = Object.fromEntries(
      Object.entries(records).map(([recordId, record]) => {
        const targetId =
          recordId === RECORD_ID ? EXTERNAL_PARENT_ID : RECORD_ID;
        const inlineOnly = makeStructuredTextDocument([
          {
            type: 'paragraph',
            children: [{ type: 'inlineItem', item: targetId }],
          },
        ]);
        return [
          recordId,
          {
            ...record,
            current: {
              ...record.current,
              fields: {
                ...record.current.fields,
                body: { en: inlineOnly, it: inlineOnly } as any,
              },
            },
          },
        ];
      }),
    );
    const inlineOnlyCandidates = collectCreateCycleShellCandidates(
      inlineOnlyRecords,
      schema,
      componentIds,
    );
    for (const candidate of inlineOnlyCandidates) {
      const record = inlineOnlyRecords[candidate.recordId];
      const projected = runtime.__stripUnavailableReferences?.(
        record.current.fields,
        model,
        context.schemaById,
        componentIds,
        `record ${candidate.recordId}`,
        'strip',
      );
      expect(projected).to.deep.equal(candidate.fields);
      expect((projected as any).body.en).to.deep.equal(emptyDast);
      expect((projected as any).body.it).to.deep.equal(emptyDast);
    }
  });

  it('keeps custom Structured Text decoys outside children inert in generator and runtime traversal', async () => {
    const schema = makeStructuredTextProjectionSchema('source');
    const model = schema.itemTypes.find(({ id }) => id === MODEL_ID)!;
    const decoyId = MAPPING_BATCH_ID;
    const customDocument = (targetId: string, label: string): JsonObject =>
      ({
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
                  children: [{ type: 'span', value: label }],
                },
              ],
            },
          ],
          sidecar: { type: 'inlineItem', item: decoyId },
        },
      }) as JsonObject;
    const makeCustomRecord = (
      id: string,
      targetId: string,
      blockId: string,
    ): RecordSnapshot => {
      const base = makeStructuredTextProjectionRecord(
        schema,
        id,
        targetId,
        blockId,
      );
      const fields = {
        ...base.current.fields,
        body: {
          en: customDocument(targetId, 'linked en'),
          it: customDocument(targetId, 'linked it'),
        },
        safe_body: {
          en: customDocument(targetId, 'safe en'),
          it: customDocument(targetId, 'safe it'),
        },
        blocks: {
          schema: 'custom-content-v1',
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
                    body: customDocument(targetId, 'nested label'),
                  },
                },
              },
            ],
            sidecar: { type: 'itemLink', item: decoyId, children: [] },
          },
        },
      } as JsonObject;
      return {
        ...base,
        current: { fields, hash: semanticHash(fields) },
      };
    };
    const records: Record<string, RecordSnapshot> = {
      [RECORD_ID]: makeCustomRecord(RECORD_ID, EXTERNAL_PARENT_ID, BLOCK_ID),
      [EXTERNAL_PARENT_ID]: makeCustomRecord(
        EXTERNAL_PARENT_ID,
        RECORD_ID,
        MAPPING_RECORD_ID,
      ),
    };
    const componentIds = new Set(Object.keys(records));
    const candidates = collectCreateCycleShellCandidates(
      records,
      schema,
      componentIds,
    );
    const runtime = await loadRuntime(
      '\nmodule.exports.__stripUnavailableReferences = stripUnavailableReferences;\nmodule.exports.__collectRecordReferencesFromFields = collectRecordReferencesFromFields;\n',
    );
    const schemaById = new Map(
      schema.itemTypes.map((itemType) => [itemType.id, itemType]),
    );
    const context = { schemaById, captureSchemaById: schemaById };

    for (const candidate of candidates) {
      const record = records[candidate.recordId];
      const expectedTarget =
        candidate.recordId === RECORD_ID ? EXTERNAL_PARENT_ID : RECORD_ID;
      const generatorReferences = new Set(
        collectRecordReferences(record, schema).map(
          ({ toRecordId }) => toRecordId,
        ),
      );
      const runtimeReferences = runtime.__collectRecordReferencesFromFields?.(
        record.current.fields,
        model,
        context,
      );
      expect(generatorReferences).to.deep.equal(new Set([expectedTarget]));
      expect(runtimeReferences).to.deep.equal(new Set([expectedTarget]));

      const projected = runtime.__stripUnavailableReferences?.(
        record.current.fields,
        model,
        context.schemaById,
        componentIds,
        `record ${candidate.recordId}`,
        'strip',
      );
      expect(projected).to.deep.equal(candidate.fields);
      expect((projected as any).body.en.document.sidecar.item).to.equal(
        decoyId,
      );
      expect((projected as any).blocks.document.sidecar.item).to.equal(decoyId);
      expect(stableStringify(projected)).to.contain(decoyId);
      expect(
        stableStringify((projected as any).body.en.document.children),
      ).not.to.contain(expectedTarget);
      expect(
        (projected as any).blocks.document.children[0].item.attributes.body
          .document.children[0].children,
      ).to.deep.equal([{ type: 'span', value: 'nested label' }]);
    }
  });

  it('strips only the current shell SCC and retains required links to earlier shell components', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__expectedCreateSeedFields = expectedCreateSeedFields;\n',
    );
    const firstA = RECORD_ID;
    const firstB = EXTERNAL_PARENT_ID;
    const secondA = MAPPING_RECORD_ID;
    const secondB = MIGRATIONS_MODEL_ID;
    const itemType = {
      id: MODEL_ID,
      fields: [
        {
          apiKey: 'peer',
          fieldType: 'link',
          localized: false,
          validators: { required: {} },
        },
        {
          apiKey: 'upstream',
          fieldType: 'link',
          localized: false,
          validators: { required: {} },
        },
      ],
    };
    const createRecord = (id: string, peer: string, upstream: string) => ({
      id,
      itemTypeId: MODEL_ID,
      action: 'create',
      desired: {
        current: { fields: { peer, upstream } },
        published: null,
      },
    });
    const records = [
      createRecord(firstA, firstB, firstB),
      createRecord(firstB, firstA, firstA),
      createRecord(secondA, secondB, firstA),
      createRecord(secondB, secondA, firstB),
    ];
    const context = {
      plan: {
        records,
        execution: {
          createOrder: [firstA, firstB, secondA, secondB],
          shellRecordIds: [firstA, firstB, secondA, secondB].sort(),
          shellComponents: [
            [firstA, firstB].sort(),
            [secondA, secondB].sort(),
          ].sort((left, right) =>
            left.join(',').localeCompare(right.join(',')),
          ),
        },
      },
      schemaById: new Map([[MODEL_ID, itemType]]),
    };

    expect(
      runtime.__expectedCreateSeedFields?.(context, records[2]),
    ).to.deep.equal({ peer: null, upstream: firstA });
    expect(
      runtime.__expectedCreateSeedFields?.(context, records[3]),
    ).to.deep.equal({ peer: null, upstream: firstB });
  });

  it('rejects a shell-component contract that is not an exact canonical partition', async () => {
    const plan = makeRuntimePlan('unchanged', 'unchanged');
    plan.execution.shellComponents = [[]];
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );
    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(mock.mutations.update).to.equal(0);
  });

  it('rejects every transient nested-block deletion release before schema or content mutation', async () => {
    const plan = makePublishedDeleteReleaseRuntimePlan();
    plan.execution.deleteReleases[0].transientNestedBlockIds = [BLOCK_ID];
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('obsolete', { published: true });

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );
    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(error.message).to.contain(
      'CMA full-validation update path cannot create safely',
    );
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('rejects an invalid TARGET record UPDATE introducing a fresh nested block before any CMA read', async () => {
    const plan = makeRuntimePlan('desired', 'baseline');
    const record = plan.records[0];
    const baselineBlock = makeNestedBlock();
    const freshBlock = {
      ...structuredClone(baselineBlock),
      id: EXTERNAL_PARENT_ID,
    };
    record.baseline!.validity.current = false;
    record.baseline!.consistency.currentValid = false;
    record.baseline!.current = {
      fields: {
        ...record.baseline!.current.fields,
        content: baselineBlock,
      },
      hash: semanticHash({
        ...record.baseline!.current.fields,
        content: baselineBlock,
      }),
    };
    record.desired!.current = {
      fields: {
        ...record.desired!.current.fields,
        content: freshBlock,
      },
      hash: semanticHash({
        ...record.desired!.current.fields,
        content: freshBlock,
      }),
    };
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline');

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(error.message).to.contain(
      `fresh nested block ${EXTERNAL_PARENT_ID} during current-restore`,
    );
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('retains the fresh-ID restriction for an invalid source-only creation seed', async () => {
    const seedBlock = makeNestedBlock();
    const plan = makeNestedBlockRuntimePlan(seedBlock);
    const record = plan.records[0];
    const freshBlock = {
      ...structuredClone(seedBlock),
      id: EXTERNAL_PARENT_ID,
    };
    record.desired!.published = {
      fields: { ...record.desired!.current.fields, content: seedBlock },
      hash: semanticHash({
        ...record.desired!.current.fields,
        content: seedBlock,
      }),
    };
    record.desired!.current = {
      fields: { ...record.desired!.current.fields, content: freshBlock },
      hash: semanticHash({
        ...record.desired!.current.fields,
        content: freshBlock,
      }),
    };
    record.desired!.validity.published = false;
    const runtime = await loadRuntime(
      '\nmodule.exports.__findUnsupportedFreshNestedBlockUpdates = findUnsupportedFreshNestedBlockUpdates;\n',
    );
    expect(
      runtime.__findUnsupportedFreshNestedBlockUpdates!(
        plan.records,
        new Map(plan.schema.itemTypes.map((type) => [type.id, type])),
      ),
    ).to.deep.equal([
      {
        recordId: RECORD_ID,
        blockId: EXTERNAL_PARENT_ID,
        stage: 'current-restore',
        slice: 'current',
      },
    ]);
  });

  it('rejects a rehashed unique release containing an embedded item before any CMA read', async () => {
    const plan = makeRuntimePlan('desired', 'baseline');
    const record = plan.records[0];
    const titleField = plan.schema.itemTypes[0].fields.find(
      ({ apiKey }) => apiKey === 'title',
    )!;
    titleField.validators = { unique: {} };
    plan.schema.digest = computeSchemaDigest(plan.schema);
    plan.source.schemaDigest = plan.schema.digest;
    plan.target.schemaDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.originalDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.fullyRelaxedDigest = plan.schema.digest;
    const nestedValue = makeNestedBlock();
    const intermediateCurrentHash = semanticHash({
      ...record.baseline!.current.fields,
      title: nestedValue,
    });
    record.allowedIntermediateHashes.push(intermediateCurrentHash);
    plan.execution.uniqueReleases.push({
      recordId: record.id,
      fields: { title: nestedValue },
      consumerRecordIds: [],
      intermediateCurrentHash,
    });
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline');

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(error.message).to.contain('contains a non-scalar or embedded value');
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('rejects a legacy V8 manifest before reading or mutating the destination', async () => {
    const plan = makeRuntimePlan('unchanged', 'unchanged');
    Object.defineProperty(plan, 'formatVersion', { value: 8 });
    const envelope = makeEnvelope(plan);
    envelope.formatVersion = 8;
    envelope.runtimeVersion = '8';
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, envelope, {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('UNSUPPORTED_MANIFEST');
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('executes an original runtime-v16 migration bundle through the current scoped loader', async () => {
    const fixture = JSON.parse(
      gunzipSync(
        await readFile(
          join(__dirname, '../fixtures/content-diff-v16/no-op-bundle.json.gz'),
        ),
      ).toString('utf8'),
    ) as {
      runtime: string;
      runtimeSha256: string;
      manifest: string;
      entrypoint: string;
      migrationBasename: string;
    };
    expect(createHash('sha256').update(fixture.runtime).digest('hex')).to.equal(
      '2a4ac6ea924fd6f3cbdb82b92c32713f48be9a5e29ec1c2c4d9315641f803200',
    );
    const directory = await mkdtemp(
      join(tmpdir(), 'datocms-historical-runtime-'),
    );
    temporaryDirectories.push(directory);
    const contentDirectory = join(directory, '.datocms-content');
    await mkdir(contentDirectory);
    const migrationPath = join(directory, `${fixture.migrationBasename}.js`);
    await writeFile(migrationPath, fixture.entrypoint);
    await writeFile(join(contentDirectory, 'runtime-v16.js'), fixture.runtime);
    await writeFile(
      join(contentDirectory, `${fixture.migrationBasename}.plan.json`),
      fixture.manifest,
    );
    const script = {
      filename: `${fixture.migrationBasename}.js`,
      path: migrationPath,
      legacy: false,
    };
    const command = Object.create(MigrationRunCommand.prototype);
    for (const method of [
      'startSpinner',
      'stopSpinner',
      'stopSpinnerWithFailure',
      'log',
    ]) {
      command[method] = () => undefined;
    }
    command.error = (message: string): never => {
      throw new Error(message);
    };
    const mock = makeRuntimeClient('unchanged', { traceReads: true });
    await Reflect.apply(
      Reflect.get(command, 'validatePendingContentDiffBindings'),
      command,
      [[script], directory, 'site-id'],
    );
    const logs: string[] = [];
    const previousLog = console.log;
    try {
      console.log = (message) => {
        logs.push(String(message));
      };
      await Reflect.apply(Reflect.get(command, 'runMigrationScript'), command, [
        script,
        mock.client,
        null,
        false,
        null,
        directory,
        undefined,
        {
          environmentId: 'destination-fork',
          inPlace: false,
          allowPrimary: false,
          contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
        },
      ]);
    } finally {
      console.log = previousLog;
    }
    expect(mock.reads.site).to.be.greaterThan(0);
    expect(mock.mutations).to.deep.equal({ update: 0 });
    expect(logs.some((line) => line.includes('[12/12]'))).to.equal(true);
  });

  it('rejects a runtime-v15 envelope before reading or mutating the destination', async () => {
    const envelope = makeEnvelope(makeRuntimePlan('unchanged', 'unchanged'));
    envelope.runtimeVersion = '15';
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, envelope, {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('UNSUPPORTED_RUNTIME');
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('persists a new legacy-ID reservation before content writes and reuses it on rerun', async () => {
    const schedules: RuntimeScheduleState = {
      publication: {
        at: '2099-01-01T00:00:00.000Z',
        selective: null,
      },
      unpublishing: null,
    };
    const plan = withLegacyIdMapping(
      makeRuntimePlan('desired', 'baseline', schedules),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
    );
    const runtime = await loadRuntime();
    const events: string[] = [];
    const mock = makeRuntimeClient('baseline', { events, schedules });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 1,
      fieldCreate: 2,
      recordCreate: 1,
    });
    expect(events.indexOf('mapping-record-create')).to.be.lessThan(
      events.indexOf('record-update'),
    );
    expect(events.indexOf('publication-schedule-destroy')).to.be.lessThan(
      events.indexOf('mapping-model-create'),
    );
    expect(mock.mappingRecords()).to.have.length(1);
    expect(mock.mappingRecords()[0].mapping).to.equal(
      plan.legacyIdMappings.newMappingBatch!.chunks[0].serializedDocument,
    );

    const eventCountBeforeReplay = events.length;
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 1,
      fieldCreate: 2,
      recordCreate: 1,
    });
    expect(mock.mutations.update).to.equal(1);
    expect(events).to.have.length(eventCountBeforeReplay);
  });

  it('accepts the exact tracking model created by migrations:run after generation', async () => {
    const plan = withLegacyIdMapping(makeRuntimePlan('desired', 'baseline'), {
      entityType: 'record',
      sourceId: '178178741',
      targetId: RECORD_ID,
      status: 'new',
    });
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      migrationsTrackingModel: 'exact',
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.mutations.update).to.equal(1);
    expect(mock.mappingMutations.recordCreate).to.equal(1);
  });

  it('rejects a configured tracking-model key with a non-tracking schema', async () => {
    const plan = withLegacyIdMapping(makeRuntimePlan('desired', 'baseline'), {
      entityType: 'record',
      sourceId: '178178741',
      targetId: RECORD_ID,
      status: 'new',
    });
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      migrationsTrackingModel: 'invalid',
    });

    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as Error & { code?: string }).code).to.equal(
      'MIGRATIONS_MODEL_CONFLICT',
    );
    expect(mock.mutations.update).to.equal(0);
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('rejects a legacy source ID that appeared in the destination before any mutation', async () => {
    const plan = withLegacyIdMapping(
      makeValidatorRelaxationRuntimePlan('desired', 'baseline'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': {} },
      occupiedLegacyItemIds: ['178178741'],
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('LEGACY_SOURCE_ID_OCCUPIED');
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 0,
      fieldCreate: 0,
      recordCreate: 0,
    });
  });

  it('rejects concurrent adoption of a new mapping outside its complete planned batch', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('desired', 'baseline'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
      'existing',
    );
    const concurrentRecord = makeStoredLegacyMappingChunk(
      [
        {
          entityType: 'record',
          sourceId: '178178741',
          targetId: RECORD_ID,
        },
      ],
      {
        id: 'T8x4VhMPT_KxTHtz9r7mCA',
        batchId: 'VcYAYCBFT2yY7H_AW3fw7Q',
      },
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      legacyMapping: {
        schemaState: 'complete',
        records: [concurrentRecord],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_CONCURRENT_APPEND',
    );
    expect(mock.mutations.update).to.equal(0);
    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 0,
      fieldCreate: 0,
      recordCreate: 0,
    });
  });

  it('resumes an exact partial prefix of its own multi-chunk mapping batch', async () => {
    const uploadId = 'T8x4VhMPT_KxTHtz9r7mCA';
    const plan = withLegacyIdMapping(
      makeRuntimePlan('desired', 'baseline'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
      'existing',
    );
    const upload = canonicalizeUpload(makeExistingUpload(uploadId), ['en']);
    plan.uploads.push({
      id: uploadId,
      action: 'noop',
      expectedTargetHash: upload.hash,
      baseline: upload,
      desired: upload,
      changes: { binary: false, metadata: false, collection: false },
    });
    const uploadMapping = {
      entityType: 'upload' as const,
      sourceId: '178178742',
      targetId: uploadId,
      status: 'new' as const,
      managed: true,
      expectedItemTypeId: null,
      requiredAvailability: { current: true, published: false },
    };
    plan.legacyIdMappings.entries.push(uploadMapping);
    const documentEntries = plan.legacyIdMappings.entries.map(
      ({ entityType, sourceId, targetId }) => ({
        entityType,
        sourceId,
        targetId,
      }),
    );
    const wholeHash = createHash('sha256')
      .update(stableStringify(documentEntries))
      .digest('hex');
    const mappingRecordIds = [MAPPING_RECORD_ID, 'IMbO7Yw8QHqn8rKj0o1kTA'];
    const chunks = documentEntries.map((entry, chunkIndex) => {
      const document = {
        formatVersion: 1 as const,
        projectId: 'site-id',
        batchId: MAPPING_BATCH_ID,
        chunkIndex,
        chunkCount: documentEntries.length,
        wholeHash,
        entries: [entry],
      };
      const serializedDocument = JSON.stringify(
        canonicalizeJson(document),
        null,
        2,
      );
      return {
        id: mappingRecordIds[chunkIndex],
        name: `legacy-id-map:${MAPPING_BATCH_ID}:${chunkIndex + 1}/${
          documentEntries.length
        }`,
        chunkIndex,
        chunkCount: documentEntries.length,
        hash: createHash('sha256').update(serializedDocument).digest('hex'),
        byteLength: Buffer.byteLength(serializedDocument, 'utf8'),
        serializedDocument,
        document,
      };
    });
    plan.legacyIdMappings.newMappingBatch = {
      batchId: MAPPING_BATCH_ID,
      wholeHash,
      chunks,
    };
    plan.summary.legacyIdMappings = {
      detected: 2,
      existing: 0,
      created: 2,
      skipped: 0,
      records: 2,
    };

    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      existingUploadIds: [uploadId],
      legacyMapping: {
        schemaState: 'complete',
        records: [
          {
            id: chunks[0].id,
            name: chunks[0].name,
            serializedDocument: chunks[0].serializedDocument,
          },
        ],
      },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.mappingMutations.recordCreate).to.equal(1);
    expect(mock.mappingRecords()).to.have.length(2);
    expect(mock.current().title).to.equal('desired');
  });

  it('fails final verification if a reserved mapping chunk disappears mid-run', async () => {
    const plan = withLegacyIdMapping(makeRuntimePlan('desired', 'baseline'), {
      entityType: 'record',
      sourceId: '178178741',
      targetId: RECORD_ID,
      status: 'new',
    });
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      legacyMapping: { deleteRecordsOnContentUpdate: true },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_RECORD_CONFLICT',
    );
    expect(mock.current().title).to.equal('desired');
    expect(mock.mappingRecords()).to.have.length(0);
  });

  it('recovers a partially created mapping model and fields idempotently', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: { schemaState: 'model-only' },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 0,
      fieldCreate: 2,
      recordCreate: 1,
    });
  });

  it('creates the mapping model and fields from the shared ledger contract (D27)', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');
    const itemTypes = mock.client.itemTypes as Record<string, any>;
    const fields = mock.client.fields as Record<string, any>;
    const createModel = itemTypes.create;
    const createField = fields.create;
    const modelCreates: unknown[][] = [];
    const fieldCreates: Array<Record<string, any>> = [];
    itemTypes.create = async (...args: unknown[]) => {
      modelCreates.push(structuredClone(args));
      return createModel(...args);
    };
    fields.create = async (itemTypeId: string, body: Record<string, any>) => {
      fieldCreates.push(structuredClone(body));
      return createField(itemTypeId, body);
    };

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    const schema = plan.legacyIdMappings.schema;
    // Literal payloads: the shared tables must not drift from the bytes the
    // runtime has always sent.
    expect(modelCreates).to.deep.equal([
      [
        {
          id: schema.model.id,
          name: 'Content diff',
          api_key: 'datocms_content_diff',
          modular_block: false,
          singleton: false,
          sortable: false,
          tree: false,
          draft_mode_active: true,
          draft_saving_active: false,
          all_locales_required: false,
          inverse_relationships_enabled: false,
          collection_appearance: 'compact',
          ordering_direction: null,
          ordering_meta: null,
          hint: null,
        },
        { skip_menu_item_creation: true },
      ],
    ]);
    expect(modelCreates[0][0]).to.deep.equal({
      id: schema.model.id,
      ...LEGACY_ID_MAPPING_MODEL_ATTRIBUTES,
    });
    expect(Object.keys(modelCreates[0][0] as object)).to.deep.equal([
      'id',
      'name',
      'api_key',
      'modular_block',
      'singleton',
      'sortable',
      'tree',
      'draft_mode_active',
      'draft_saving_active',
      'all_locales_required',
      'inverse_relationships_enabled',
      'collection_appearance',
      'ordering_direction',
      'ordering_meta',
      'hint',
    ]);
    expect(
      legacyMappingModelMismatches({
        ...(modelCreates[0][0] as object),
        has_singleton_item: false,
      }),
    ).to.deep.equal([]);
    expect(fieldCreates).to.deep.equal([
      {
        id: schema.nameField.id,
        label: 'Name',
        api_key: 'name',
        field_type: 'string',
        localized: false,
        position: 1,
        validators: { required: {}, unique: {} },
        appearance: {
          addons: [],
          editor: 'single_line',
          parameters: { heading: false, placeholder: null },
        },
        default_value: null,
        hint: null,
        deep_filtering_enabled: false,
        content_link_enabled: true,
      },
      {
        id: schema.mappingField.id,
        label: 'Mapping',
        api_key: 'mapping',
        field_type: 'json',
        localized: false,
        position: 2,
        validators: { required: {} },
        appearance: { addons: [], editor: 'json', parameters: {} },
        default_value: null,
        hint: null,
        deep_filtering_enabled: false,
        content_link_enabled: true,
      },
    ]);
    for (const fieldCreate of fieldCreates) {
      expect(Object.keys(fieldCreate)).to.deep.equal([
        'id',
        'label',
        'api_key',
        'field_type',
        'localized',
        'position',
        'validators',
        'appearance',
        'default_value',
        'hint',
        'deep_filtering_enabled',
        'content_link_enabled',
      ]);
    }
    expect(fieldCreates).to.deep.equal([
      {
        id: schema.nameField.id,
        ...legacyMappingFieldAttributes(LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT),
      },
      {
        id: schema.mappingField.id,
        ...legacyMappingFieldAttributes(LEGACY_ID_MAPPING_FIELD_CONTRACT),
      },
    ]);
    expect(
      legacyMappingFieldMismatches(
        fieldCreates[0],
        LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT,
      ),
    ).to.deep.equal([]);
    expect(
      legacyMappingFieldMismatches(
        fieldCreates[1],
        LEGACY_ID_MAPPING_FIELD_CONTRACT,
      ),
    ).to.deep.equal([]);
    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 1,
      fieldCreate: 2,
      recordCreate: 1,
    });
  });

  it('rejects global field-ID and item-type-name collisions before mapping schema writes', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
    );
    const runtime = await loadRuntime();
    const fieldCollision = makeRuntimeClient('unchanged', {
      legacyMapping: {
        fieldIdCollision: {
          id: MAPPING_NAME_FIELD_ID,
          apiKey: 'unrelated_field',
          itemTypeId: 'unrelated-model',
        },
      },
    });
    const fieldError = await expectRejects(
      runtime.runContentDiffMigration(
        fieldCollision.client,
        makeEnvelope(plan),
        { log: () => undefined },
      ),
    );
    expect((fieldError as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_SCHEMA_CONFLICT',
    );
    expect(fieldCollision.mappingMutations).to.deep.equal({
      modelCreate: 0,
      fieldCreate: 0,
      recordCreate: 0,
    });

    const nameCollision = makeRuntimeClient('unchanged', {
      legacyMapping: { itemTypeNameCollision: true },
    });
    const nameError = await expectRejects(
      runtime.runContentDiffMigration(
        nameCollision.client,
        makeEnvelope(plan),
        { log: () => undefined },
      ),
    );
    expect((nameError as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_SCHEMA_CONFLICT',
    );
    expect(nameCollision.mappingMutations).to.deep.equal({
      modelCreate: 0,
      fieldCreate: 0,
      recordCreate: 0,
    });
  });

  it('rejects drift in exact mapping-model defaults and title relationships', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        modelOverrides: {
          collection_appearance: 'table',
          title_field: null,
        },
        records: [
          makeStoredLegacyMappingChunk([
            {
              entityType: 'record',
              sourceId: '178178741',
              targetId: RECORD_ID,
            },
          ]),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_SCHEMA_CONFLICT',
    );
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('rejects drift in exact mapping-field defaults', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        mappingFieldOverrides: { content_link_enabled: false },
        records: [
          makeStoredLegacyMappingChunk([
            {
              entityType: 'record',
              sourceId: '178178741',
              targetId: RECORD_ID,
            },
          ]),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_SCHEMA_CONFLICT',
    );
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('rejects a published, invalid, staged, or scheduled mapping record', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [
          makeStoredLegacyMappingChunk(
            [
              {
                entityType: 'record',
                sourceId: '178178741',
                targetId: RECORD_ID,
              },
            ],
            {
              metaOverrides: {
                status: 'published',
                is_published_version_valid: true,
                published_at: '2026-01-01T00:00:00Z',
              },
            },
          ),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_RECORD_CONFLICT',
    );
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('does not require schema-edit permission to append to an exact existing mapping model', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const broad = (itemTypeId: string, action: string) => ({
      environment: 'destination-fork',
      action,
      item_type: itemTypeId,
      on_creator: 'anyone',
      localization_scope: 'all',
    });
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: { schemaState: 'complete' },
      identity: {
        type: 'user',
        role: {
          meta: {
            final_permissions: {
              can_edit_schema: false,
              can_manage_upload_collections: false,
              positive_item_type_permissions: [
                broad(MODEL_ID, 'read'),
                broad(MAPPING_MODEL_ID, 'read'),
                broad(MAPPING_MODEL_ID, 'create'),
              ],
              negative_item_type_permissions: [],
              positive_upload_permissions: [
                {
                  environment: 'destination-fork',
                  action: 'read',
                  upload_collection: null,
                  on_creator: 'anyone',
                  localization_scope: 'all',
                  move_to_upload_collection: null,
                },
              ],
              negative_upload_permissions: [],
            },
          },
        },
      },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 0,
      fieldCreate: 0,
      recordCreate: 1,
    });
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('rejects a built-in read-only token before creating a mapping chunk', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      identity: {
        type: 'access_token',
        can_access_cma: true,
        hardcoded_type: 'readonly',
      },
      legacyMapping: { schemaState: 'complete' },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INSUFFICIENT_PERMISSIONS');
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('fails closed on a conflicting persistent legacy-ID mapping', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mappingRecord = makeStoredLegacyMappingChunk([
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: EXTERNAL_PARENT_ID,
      },
    ]);
    plan.legacyIdMappings.existingMappingRecords[0].hash = mappingRecord.hash;
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [mappingRecord],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('LEGACY_MAPPING_CONFLICT');
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('inspects an existing ledger with no planned mappings and rejects tampering', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    plan.legacyIdMappings.entries = [];
    plan.legacyIdMappings.newMappingBatch = null;
    plan.summary.legacyIdMappings = {
      detected: 0,
      existing: 0,
      created: 0,
      skipped: 0,
      records: 0,
    };
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [
          makeStoredLegacyMappingChunk(
            [
              {
                entityType: 'record',
                sourceId: '178178741',
                targetId: RECORD_ID,
              },
            ],
            { wholeHash: '0'.repeat(64) },
          ),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_RECORD_CONFLICT',
    );
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('rejects a durable target claim omitted from final managed ownership', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    plan.legacyIdMappings.entries = [];
    plan.summary.legacyIdMappings = {
      detected: 0,
      existing: 0,
      created: 0,
      skipped: 0,
      records: 0,
    };
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [
          makeStoredLegacyMappingChunk([
            {
              entityType: 'record',
              sourceId: '178178741',
              targetId: RECORD_ID,
            },
          ]),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('LEGACY_MAPPING_CONFLICT');
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('rejects a durable target claim colliding with a ledger record ID', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const mappingRecord = makeStoredLegacyMappingChunk([
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: MAPPING_RECORD_ID,
      },
    ]);
    plan.legacyIdMappings.entries = [];
    plan.legacyIdMappings.existingMappingRecords[0].hash = mappingRecord.hash;
    plan.summary.legacyIdMappings = {
      detected: 0,
      existing: 0,
      created: 0,
      skipped: 0,
      records: 0,
    };
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [mappingRecord],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('LEGACY_MAPPING_CONFLICT');
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('requires generation-time hashes for every existing ledger record', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [
          makeStoredLegacyMappingChunk(
            [
              {
                entityType: 'record',
                sourceId: '178178741',
                targetId: RECORD_ID,
              },
            ],
            { batchId: 'VcYAYCBFT2yY7H_AW3fw7Q' },
          ),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_RECORD_CONFLICT',
    );
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('rechecks existing ledger hashes after content writes', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('desired', 'baseline'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const original = makeStoredLegacyMappingChunk([
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
      },
    ]);
    const replacement = makeStoredLegacyMappingChunk(
      [
        {
          entityType: 'record',
          sourceId: '178178741',
          targetId: RECORD_ID,
        },
      ],
      { batchId: 'VcYAYCBFT2yY7H_AW3fw7Q' },
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      legacyMapping: {
        schemaState: 'complete',
        records: [original],
        replaceRecordsOnContentUpdate: [replacement],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_RECORD_CONFLICT',
    );
    expect(mock.current().title).to.equal('desired');
  });

  it('rejects a mapping ledger copied from another project', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'existing',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [
          makeStoredLegacyMappingChunk(
            [
              {
                entityType: 'record',
                sourceId: '178178741',
                targetId: RECORD_ID,
              },
            ],
            { projectId: 'another-site' },
          ),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_RECORD_CONFLICT',
    );
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('treats record and block mappings as one Item ID namespace', async () => {
    const plan = withLegacyIdMapping(
      makeNestedBlockRuntimePlan(makeNestedBlock()),
      {
        entityType: 'block',
        sourceId: '178178741',
        targetId: BLOCK_ID,
        status: 'existing',
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mappingRecord = makeStoredLegacyMappingChunk([
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
      },
    ]);
    plan.legacyIdMappings.existingMappingRecords[0].hash = mappingRecord.hash;
    const mock = makeRuntimeClient('unchanged', {
      legacyMapping: {
        schemaState: 'complete',
        records: [mappingRecord],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('LEGACY_MAPPING_CONFLICT');
  });

  it('proves current and published availability for an external mapped dependency', async () => {
    const plan = withLegacyIdMapping(
      makeExternalRecordReferenceRuntimePlan(true),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: EXTERNAL_PARENT_ID,
        status: 'existing',
        managed: false,
        requiredAvailability: { current: true, published: true },
      },
      'existing',
    );
    const mappingRecord = makeStoredLegacyMappingChunk([
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: EXTERNAL_PARENT_ID,
      },
    ]);
    const runtime = await loadRuntime();
    const missingPublished = makeRuntimeClient('unchanged', {
      published: true,
      recordFields: { external_link: EXTERNAL_PARENT_ID },
      externalParent: true,
      externalParentPublished: false,
      legacyMapping: {
        schemaState: 'complete',
        records: [mappingRecord],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(
        missingPublished.client,
        makeEnvelope(plan),
        { log: () => undefined },
      ),
    );
    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_TARGET_MISSING',
    );
    expect(missingPublished.mappingMutations.recordCreate).to.equal(0);

    const available = makeRuntimeClient('unchanged', {
      published: true,
      recordFields: { external_link: EXTERNAL_PARENT_ID },
      externalParent: true,
      externalParentPublished: true,
      legacyMapping: {
        schemaState: 'complete',
        records: [mappingRecord],
      },
    });
    await runtime.runContentDiffMigration(
      available.client,
      makeEnvelope(plan),
      {
        log: () => undefined,
      },
    );
    expect(available.mappingMutations).to.deep.equal({
      modelCreate: 0,
      fieldCreate: 0,
      recordCreate: 0,
    });
  });

  it('rejects an external mapped dependency recreated under another model', async () => {
    const plan = withLegacyIdMapping(
      makeExternalRecordReferenceRuntimePlan(false),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: EXTERNAL_PARENT_ID,
        status: 'existing',
        managed: false,
        expectedItemTypeId: MODEL_ID,
        requiredAvailability: { current: true, published: false },
      },
      'existing',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      recordFields: { external_link: EXTERNAL_PARENT_ID },
      externalParent: true,
      externalParentItemTypeId: BLOCK_MODEL_ID,
      legacyMapping: {
        schemaState: 'complete',
        records: [
          makeStoredLegacyMappingChunk([
            {
              entityType: 'record',
              sourceId: '178178741',
              targetId: EXTERNAL_PARENT_ID,
            },
          ]),
        ],
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'LEGACY_MAPPING_TARGET_CONFLICT',
    );
    expect(mock.mappingMutations.recordCreate).to.equal(0);
  });

  it('allows mapping schema creation on primary only with core double opt-in', async () => {
    const plan = withLegacyIdMapping(
      makeRuntimePlan('unchanged', 'unchanged'),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', { primary: true });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );
    expect((error as RuntimeError).code).to.equal(
      'PRIMARY_MAPPING_SCHEMA_FORBIDDEN',
    );
    expect(mock.mappingMutations.modelCreate).to.equal(0);

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: {
        environmentId: 'destination-fork',
        inPlace: true,
        allowPrimary: true,
      },
      log: () => undefined,
    });
    expect(mock.mappingMutations).to.deep.equal({
      modelCreate: 1,
      fieldCreate: 2,
      recordCreate: 1,
    });
  });

  it('rejects baseline drift during preflight before any mutation', async () => {
    const plan = makeRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('concurrent-edit');
    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('TARGET_CONFLICT');
    expect(error.message).to.contain(`record ${RECORD_ID}`);
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('rejects field default-value drift before a content mutation', async () => {
    const plan = makeRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldDefaultValues: { 'title-field': 'destination default' },
    });
    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('SCHEMA_MISMATCH');
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('rejects environment content-semantics drift before a mutation', async () => {
    const plan = makeRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      environmentSemantics: { improvedBooleanFields: false },
    });
    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal(
      'ENVIRONMENT_SEMANTICS_MISMATCH',
    );
    expect(error.message).to.contain(
      'schema autogeneration alone may not repair this mismatch',
    );
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('validates and runs a zero-relaxation plan with a non-null field default', async () => {
    const plan = makeRuntimePlan('unchanged', 'unchanged');
    const field = plan.schema.itemTypes[0].fields.find(
      ({ id }) => id === 'title-field',
    )!;
    field.defaultValue = 'planned default';
    plan.schema.digest = computeSchemaDigest(plan.schema);
    plan.source.schemaDigest = plan.schema.digest;
    plan.target.schemaDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.originalDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.fullyRelaxedDigest = plan.schema.digest;
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      fieldDefaultValues: { 'title-field': 'planned default' },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });

    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('suppresses a unique create default only around phase 5, restores it exactly, and replays without writes', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan({ unique: true });
    const runtime = await loadRuntime();
    const events: string[] = [];
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      failIfCreateDefaultActive: true,
      fieldDefaultValues: { 'historical-number-field': 42.625 },
      events,
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.recordCreates()).to.equal(1);
    expect(mock.current().historical_number).to.equal(null);
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(42.625);
    expect(mock.schemaMutations.update).to.equal(2);
    expect(events).to.deep.equal([
      'schema-write',
      'schema-default:null',
      'record-create:null',
      'schema-write',
      'schema-default:42.625',
    ]);

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });
    expect(mock.recordCreates()).to.equal(1);
    expect(mock.schemaMutations.update).to.equal(2);
  });

  it('performs zero default-schema writes when every phase-5 create already exists at its resumable seed', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan({ divergentDraft: true });
    const runtime = await loadRuntime();
    const events: string[] = [];
    const mock = makeRuntimeClient('historical null', {
      published: true,
      separatePublishedVersion: true,
      recordFields: { content: null, historical_number: null },
      fieldDefaultValues: { 'historical-number-field': 42.625 },
      events,
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.recordCreates()).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(42.625);
    expect(mock.current().title).to.equal('current desired');
    expect(events).not.to.include('schema-write');
  });

  it('creates no-draft content with the historical null atomically published, never the active default', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan({ noDraft: true });
    const runtime = await loadRuntime();
    const events: string[] = [];
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      noDraft: true,
      fieldDefaultValues: { 'historical-number-field': 42.625 },
      events,
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.recordCreates()).to.equal(1);
    expect(mock.current().historical_number).to.equal(null);
    expect(mock.current().meta.is_published_version_valid).to.equal(true);
    expect(events).to.include('record-create:null');
    expect(events).not.to.include('record-create:42.625');
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(42.625);
  });

  it('restores independent validators when interrupted default recovery fails', async () => {
    const plan = makeCombinedSchemaRecoveryRuntimePlan();
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      fieldDefaultValues: { 'historical-number-field': null },
      fieldValidators: { 'title-field': {} },
    });
    const update = mock.client.fields.update.bind(mock.client.fields);
    mock.client.fields.update = (async (id, body) => {
      if (id === 'historical-number-field') {
        throw new Error('injected default restoration failure');
      }
      return update(id, body);
    }) as typeof mock.client.fields.update;

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal(
      'SCHEMA_DEFAULT_RESTORATION_FAILURE',
    );
    expect(JSON.stringify(error)).to.include(
      'injected default restoration failure',
    );
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(null);
    expect(mock.recordCreates()).to.equal(0);

    mock.client.fields.update = update;
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(42.625);
    expect(mock.current().historical_number).to.equal(null);
    expect(mock.recordCreates()).to.equal(1);
  });

  it('preserves both errors when independent interrupted-schema restorations fail', async () => {
    const plan = makeCombinedSchemaRecoveryRuntimePlan();
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      fieldDefaultValues: { 'historical-number-field': null },
      fieldValidators: { 'title-field': {} },
    });
    const attempted: string[] = [];
    mock.client.fields.update = (async (id) => {
      attempted.push(String(id));
      throw new Error(`injected restoration failure: ${id}`);
    }) as typeof mock.client.fields.update;

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect(attempted).to.deep.equal(['historical-number-field', 'title-field']);
    expect((error as RuntimeError).code).to.equal(
      'MIGRATION_AND_SCHEMA_RESTORATION_FAILURE',
    );
    expect(JSON.stringify(error)).to.include(
      'SCHEMA_DEFAULT_RESTORATION_FAILURE',
    );
    expect(JSON.stringify(error)).to.include(
      'injected restoration failure: historical-number-field',
    );
    expect(JSON.stringify(error)).to.include(
      'injected restoration failure: title-field',
    );
    expect(mock.recordCreates()).to.equal(0);
  });

  it('recovers before and after every write in a combined schema, nested-content, schedule and ledger migration', async () => {
    const schedules: RuntimeScheduleState = {
      publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
      unpublishing: { at: '2099-01-02T00:00:00.000Z', locales: ['en'] },
    };
    const plan = withLegacyIdMapping(
      makeCombinedSchemaRecoveryRuntimePlan({
        content: makeNestedBlock(),
        schedules,
      }),
      {
        entityType: 'record',
        sourceId: '178178741',
        targetId: RECORD_ID,
        status: 'new',
      },
    );
    const runtime = await loadRuntime();
    const makeMock = () =>
      makeRuntimeClient('absent', {
        recordAbsent: true,
        allowRecordCreate: true,
        fieldDefaultValues: { 'historical-number-field': 42.625 },
        fieldValidators: { 'title-field': { required: {} } },
        schedules: { publication: null, unpublishing: null },
      });
    const run = (mock: ReturnType<typeof makeMock>) =>
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      });
    const verify = (mock: ReturnType<typeof makeMock>) => {
      expect(mock.fieldDefaultValue('historical-number-field')).to.equal(
        42.625,
      );
      expect(mock.fieldValidators('title-field')).to.deep.equal({
        required: {},
      });
      expect(mock.schedules()).to.deep.equal(schedules);
      expect(mock.recordCreates()).to.equal(1);
      expect(mock.mappingRecords()).to.have.length(1);
      expect(mock.mappingRecords()[0].mapping).to.equal(
        plan.legacyIdMappings.newMappingBatch!.chunks[0].serializedDocument,
      );
      const snapshot = canonicalizeRecord(
        mock.current(),
        null,
        plan.schema.itemTypes[0],
        plan.schema,
        mock.schedules(),
      );
      expect(snapshot.hash).to.equal(plan.records[0].desired!.hash);
    };
    const baseline = makeMock();
    const baselineFault = injectRuntimeMutationFault(baseline.client);
    await run(baseline);
    verify(baseline);
    expect(baselineFault.writes).to.have.length(11);
    expect(
      baselineFault.writes.map(({ operation }) => operation),
    ).to.include.members([
      'itemTypes.create',
      'fields.create',
      'fields.update',
      'items.create',
      'scheduledPublication.create',
      'scheduledUnpublishing.create',
    ]);

    for (const timing of ['before', 'after'] as const) {
      for (let index = 0; index < baselineFault.writes.length; index += 1) {
        const mock = makeMock();
        const fault = injectRuntimeMutationFault(mock.client, {
          index,
          timing,
        });
        let firstError: unknown;
        await withMutedConsoleError(async () => {
          try {
            await run(mock);
          } catch (error) {
            firstError = error;
          }
        });
        const boundary = `${timing} write ${index}: ${baselineFault.writes[index].operation}`;
        expect(fault.injected(), boundary).to.equal(true);
        if (firstError)
          expect(
            String(firstError) + JSON.stringify(firstError),
            boundary,
          ).to.include('injected write interruption');
        try {
          await run(mock);
          verify(mock);
          const writesAfterRecovery = fault.writes.length;
          await run(mock);
          expect(fault.writes.length, boundary).to.equal(writesAfterRecovery);
        } catch (error) {
          throw Object.assign(
            new Error(`Recovery failed ${boundary}: ${String(error)}`),
            { cause: error },
          );
        }
      }
    }
  });

  it('recovers interrupted schedule cancellations, publication and draft restoration without changing nested content', async () => {
    const schedules: RuntimeScheduleState = {
      publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
      unpublishing: { at: '2099-01-02T00:00:00.000Z', locales: ['en'] },
    };
    const runtime = await loadRuntime();
    for (const unpublish of [false, true]) {
      const plan = makePublicationRecoveryRuntimePlan(schedules, unpublish);
      const makeMock = () =>
        makeRuntimeClient('baseline', {
          published: true,
          separatePublishedVersion: true,
          allowPublication: true,
          recordFields: { content: makeNestedBlock() },
          schedules,
        });
      const run = (mock: ReturnType<typeof makeMock>) =>
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        });
      const verify = async (mock: ReturnType<typeof makeMock>) => {
        const published = unpublish
          ? null
          : await mock.client.items.find(RECORD_ID, { version: 'published' });
        const snapshot = canonicalizeRecord(
          mock.current(),
          published as Record<string, any> | null,
          plan.schema.itemTypes[0],
          plan.schema,
          mock.schedules(),
        );
        expect(snapshot.hash).to.equal(plan.records[0].desired!.hash);
        expect(mock.schedules()).to.deep.equal(schedules);
        expect(mock.current().content).to.deep.equal(makeNestedBlock());
      };
      const baseline = makeMock();
      const baselineFault = injectRuntimeMutationFault(baseline.client);
      await run(baseline);
      await verify(baseline);
      expect(
        baselineFault.writes.map(({ operation }) => operation),
      ).to.include.members([
        'scheduledPublication.destroy',
        'scheduledUnpublishing.destroy',
        'items.update',
        unpublish ? 'items.unpublish' : 'items.publish',
        'scheduledPublication.create',
        'scheduledUnpublishing.create',
      ]);
      expect(baselineFault.writes).to.have.length(unpublish ? 6 : 7);
      for (const timing of ['before', 'after'] as const) {
        for (let index = 0; index < baselineFault.writes.length; index += 1) {
          const mock = makeMock();
          const fault = injectRuntimeMutationFault(mock.client, {
            index,
            timing,
          });
          await withMutedConsoleError(async () => {
            try {
              await run(mock);
            } catch {
              /* The exact replay below proves the partial state is recoverable. */
            }
          });
          const boundary = `${
            unpublish ? 'unpublish' : 'publish'
          } ${timing} write ${index}: ${baselineFault.writes[index].operation}`;
          expect(fault.injected(), boundary).to.equal(true);
          try {
            await run(mock);
            await verify(mock);
            const writesAfterRecovery = fault.writes.length;
            await run(mock);
            expect(fault.writes.length, boundary).to.equal(writesAfterRecovery);
          } catch (error) {
            throw Object.assign(
              new Error(`Recovery failed ${boundary}: ${String(error)}`),
              { cause: error },
            );
          }
        }
      }
    }
  });

  it('rejects a collaborator edit after an interrupted create without overwriting it on retry', async () => {
    const plan = makeCombinedSchemaRecoveryRuntimePlan({
      content: makeNestedBlock(),
    });
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      fieldDefaultValues: { 'historical-number-field': 42.625 },
      fieldValidators: { 'title-field': { required: {} } },
    });
    const fault = injectRuntimeMutationFault(mock.client, {
      index: 2,
      timing: 'after',
    });
    const run = () =>
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      });
    await withMutedConsoleError(() => expectRejects(run()));
    expect(fault.injected()).to.equal(true);
    expect(mock.recordCreates()).to.equal(1);
    await mock.client.items.update(RECORD_ID, {
      title: 'collaborator content',
    });
    const writesBeforeRetry = fault.writes.length;
    const error = await withMutedConsoleError(() => expectRejects(run()));
    expect((error as RuntimeError).code).to.equal('TARGET_CONFLICT');
    expect(mock.current().title).to.equal('collaborator content');
    expect(mock.current().content).to.deep.equal(makeNestedBlock());
    expect(fault.writes).to.have.length(writesBeforeRetry);
  });

  it('retries generated content without repeating its writes when migration-history recording fails', async () => {
    const plan = makeRuntimePlan('desired', 'baseline');
    const directory = await mkdtemp(
      join(tmpdir(), 'datocms-history-recovery-'),
    );
    temporaryDirectories.push(directory);
    await writeFile(join(directory, 'runtime.cjs'), renderRuntime('js'));
    const migrationPath = join(directory, 'history-recovery.js');
    await writeFile(
      migrationPath,
      `const { runContentDiffMigration } = require('./runtime.cjs');\nmodule.exports = async (client, executionContext) => runContentDiffMigration(client, ${JSON.stringify(
        makeEnvelope(plan),
      )}, { executionContext, log: () => undefined });\n`,
    );
    const command = Object.create(MigrationRunCommand.prototype);
    for (const method of [
      'startSpinner',
      'stopSpinner',
      'stopSpinnerWithFailure',
      'log',
    ])
      command[method] = () => undefined;
    command.error = (message: string): never => {
      throw new Error(message);
    };
    const mock = makeRuntimeClient('baseline');
    const historyError = new Error('history recording unavailable');
    let attempts = 0;
    const recordedNames: string[] = [];
    mock.client.items.create = (async (body: Record<string, any>) => {
      attempts += 1;
      if (attempts === 1) throw historyError;
      recordedNames.push(body.name);
      return { id: 'history-row' };
    }) as unknown as typeof mock.client.items.create;
    const run = (): Promise<void> =>
      Reflect.apply(Reflect.get(command, 'runMigrationScript'), command, [
        { filename: 'history-recovery.js', path: migrationPath, legacy: false },
        mock.client,
        null,
        false,
        { id: MIGRATIONS_MODEL_ID },
        directory,
        undefined,
        {
          environmentId: 'destination-fork',
          inPlace: false,
          allowPrimary: false,
          contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
        },
      ]) as Promise<void>;

    expect(await expectRejects(run())).to.equal(historyError);
    expect(mock.current().title).to.equal('desired');
    expect(mock.mutations.update).to.equal(1);
    expect(recordedNames).to.deep.equal([]);
    await run();
    expect(mock.current().title).to.equal('desired');
    expect(mock.mutations.update).to.equal(1);
    expect(recordedNames).to.deep.equal(['history-recovery.js']);
  });

  it('recovers upload writes whose responses are lost while antivirus processing is pending', async () => {
    const bytes = Buffer.from('abc');
    const runtime = await loadRuntime();
    for (const action of ['create', 'update'] as const) {
      const sourceSchema = makeSchema('source');
      const targetSchema = makeSchema('destination');
      const source = makeEmptySnapshot(sourceSchema);
      const target = makeEmptySnapshot(targetSchema);
      const desiredResource = {
        id: 'QtiP3aRYQhK9jRVGDL6kPg',
        md5: createHash('md5').update(bytes).digest('hex'),
        basename: 'asset',
        filename: 'asset.txt',
        size: bytes.length,
        mime_type: 'text/plain',
        url: 'https://example.test/asset.txt',
        author: null,
        copyright: null,
        notes: 'desired metadata',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      };
      const baselineResource = {
        ...structuredClone(desiredResource),
        md5: createHash('md5').update('old').digest('hex'),
        notes: 'baseline metadata',
      };
      source.uploads[desiredResource.id] = canonicalizeUpload(
        desiredResource,
        sourceSchema.locales,
      );
      if (action === 'update')
        target.uploads[desiredResource.id] = canonicalizeUpload(
          baselineResource,
          targetSchema.locales,
        );
      const plan = buildContentDiffPlan(source, target, {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: false,
      });
      const makeMock = () => {
        const mock = makeRuntimeClient('absent', { recordAbsent: true });
        let live: Record<string, any> | null =
          action === 'update' ? structuredClone(baselineResource) : null;
        let pendingReads = 0;
        let transfers = 0;
        const installBinary = async (body: Record<string, any>) => {
          const transferred = await readFile(body.localPath);
          expect(transferred.equals(bytes)).to.equal(true);
          transfers += 1;
          live = {
            ...(live ?? {}),
            ...structuredClone(body),
            id: desiredResource.id,
            md5: createHash('md5').update(transferred).digest('hex'),
            basename: 'asset',
            size: transferred.length,
            mime_type: 'text/plain',
            url: desiredResource.url,
            meta: { antivirus: { status: 'pending' } },
          };
          pendingReads = 3;
          return structuredClone(live);
        };
        mock.client.uploads = {
          find: async () => {
            if (!live) throw { response: { status: 404 } };
            if (pendingReads > 0) pendingReads -= 1;
            else live.meta.antivirus.status = 'clean';
            return structuredClone(live);
          },
          createFromLocalFile: async (body: Record<string, any>) => {
            expect(live).to.equal(null);
            return installBinary(body);
          },
          updateFromLocalFile: async (_id: string, body: Record<string, any>) =>
            installBinary(body),
          update: async (_id: string, body: Record<string, any>) => {
            live = { ...live, ...structuredClone(body) };
            return structuredClone(live);
          },
        } as unknown as CmaClient.Client['uploads'];
        return { ...mock, upload: () => live!, transfers: () => transfers };
      };
      const run = (mock: ReturnType<typeof makeMock>) =>
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
          uploadFilenameCollisionWindowMs: 0,
          uploadProcessingPollIntervalMs: 0,
          fetchFn: async () => ({
            ok: true,
            body: Readable.toWeb(Readable.from(bytes)),
          }),
        });
      for (const timing of ['before', 'after'] as const) {
        for (let index = 0; index < (action === 'create' ? 1 : 2); index += 1) {
          const mock = makeMock();
          const fault = injectRuntimeMutationFault(mock.client, {
            index,
            timing,
          });
          await withMutedConsoleError(async () => {
            try {
              await run(mock);
            } catch {
              /* Retry must classify the accepted binary and finish metadata. */
            }
          });
          expect(fault.injected(), `${action} ${timing} ${index}`).to.equal(
            true,
          );
          await run(mock);
          expect(
            canonicalizeUpload(mock.upload(), sourceSchema.locales).hash,
          ).to.equal(plan.uploads[0].desired!.hash);
          expect(mock.transfers()).to.equal(1);
          const writesAfterRecovery = fault.writes.length;
          await run(mock);
          expect(fault.writes).to.have.length(writesAfterRecovery);
        }
      }
    }
  });

  it('recovers an exact interrupted default suppression before reapplying it for create', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan();
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      fieldDefaultValues: { 'historical-number-field': null },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.recordCreates()).to.equal(1);
    expect(mock.current().historical_number).to.equal(null);
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(42.625);
    expect(mock.schemaMutations.update).to.equal(3);
  });

  it('recovers an owned default suppression before unrelated asset staging can fail', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan();
    const uploadId = 'T8x4VhMPT_KxTHtz9r7mCA';
    const bytes = Buffer.from('bytes-that-do-not-match-the-plan');
    plan.uploads.push({
      id: uploadId,
      action: 'create',
      expectedTargetHash: null,
      baseline: null,
      desired: {
        id: uploadId,
        md5: '00000000000000000000000000000000',
        basename: 'asset',
        filename: 'asset.bin',
        size: bytes.length,
        mimeType: 'application/octet-stream',
        manual: {
          author: null,
          copyright: null,
          notes: null,
          defaultFieldMetadata: emptyUploadDefaultFieldMetadata(),
          tags: [],
          collectionId: null,
        },
        transport: {
          sourceUrl: 'https://assets.example/asset.bin',
          bundledPath: null,
          sha256: null,
        },
        hash: '',
        consistency: {
          updatedAt: '2025-01-01T00:00:00Z',
          antivirusStatus: 'clean',
        },
      },
      changes: { binary: true, metadata: true, collection: true },
    });
    refreshUploadSnapshotHash(plan.uploads.at(-1)!.desired!);
    plan.execution.uploadOrder = [uploadId];
    plan.requiredPermissions.uploadActions = ['read', 'create'];
    const runtime = await loadRuntime();
    const events: string[] = [];
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      fieldDefaultValues: { 'historical-number-field': null },
      events,
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          fetchFn: async () => {
            const stream = Readable.from(
              (async function* () {
                yield bytes;
                events.push('asset-stream-finished');
              })(),
            );
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              body: Readable.toWeb(stream),
            };
          },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('UPLOAD_CHECKSUM_FAILURE');
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(42.625);
    expect(mock.schemaMutations.update).to.equal(1);
    expect(mock.recordCreates()).to.equal(0);
    expect(events.indexOf('schema-default:42.625')).to.be.lessThan(
      events.indexOf('asset-stream-finished'),
    );
  });

  it('restores the exact field default in finally when phase-5 create fails', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan();
    const runtime = await loadRuntime();
    const createError = new Error('injected create failure');
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      recordCreateError: createError,
      fieldDefaultValues: { 'historical-number-field': 42.625 },
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect(error).to.equal(createError);
    expect(mock.recordCreates()).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(2);
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(42.625);
  });

  it('rejects unknown default drift without overwriting it or creating content', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan();
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      fieldDefaultValues: { 'historical-number-field': 99 },
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('SCHEMA_MUTATION_CONFLICT');
    expect(mock.recordCreates()).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.fieldDefaultValue('historical-number-field')).to.equal(99);
  });

  it('rejects tampered default-suppression authorization, permission, and warning contracts before CMA reads', async () => {
    const runtime = await loadRuntime();
    const cases = [
      (plan: ContentDiffPlan) => {
        plan.options.migrateInvalidContent = false;
        plan.invalidContent.migrateInvalidContent = false;
      },
      (plan: ContentDiffPlan) => {
        plan.requiredPermissions.editSchema = false;
      },
      (plan: ContentDiffPlan) => {
        plan.warnings = plan.warnings.filter(
          ({ code }) => code !== 'DEFAULT_VALUE_SUPPRESSION',
        );
      },
    ];

    for (const tamper of cases) {
      const plan = makeHistoricalNullCreateRuntimePlan();
      tamper(plan);
      const mock = makeRuntimeClient('absent', {
        recordAbsent: true,
        allowRecordCreate: true,
        fieldDefaultValues: { 'historical-number-field': 42.625 },
      });
      const error = await expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(mock.reads.site).to.equal(0);
      expect(mock.schemaMutations.update).to.equal(0);
      expect(mock.recordCreates()).to.equal(0);
    }
  });

  it('rejects a re-signed existing-upload rename plan that omits replace_asset before CMA reads', async () => {
    const plan = makeUploadStemRenameRuntimePlan();
    expect(plan.requiredPermissions.uploadActions).to.include('replace_asset');
    plan.requiredPermissions.uploadActions =
      plan.requiredPermissions.uploadActions.filter(
        (action) => action !== 'replace_asset',
      );
    let clientReads = 0;
    const client = new Proxy(
      {},
      {
        get() {
          clientReads += 1;
          throw new Error('CMA client was accessed');
        },
      },
    ) as CmaClient.Client;
    const runtime = await loadRuntime();

    const error = await expectRejects(
      runtime.runContentDiffMigration(client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(error.message).to.contain('replace_asset');
    expect(clientReads).to.equal(0);
  });

  it('rejects re-signed upload delta and permission tampering before CMA reads', async () => {
    const runtime = await loadRuntime();
    const cases: Array<(plan: ContentDiffPlan) => void> = [
      (plan) => {
        const desired = plan.uploads[0].desired!;
        desired.manual = [] as unknown as UploadSnapshot['manual'];
        refreshUploadSnapshotHash(desired);
      },
      (plan) => {
        const desired = plan.uploads[0].desired!;
        Reflect.deleteProperty(desired.manual, 'notes');
        refreshUploadSnapshotHash(desired);
      },
      (plan) => {
        const desired = plan.uploads[0].desired!;
        desired.manual.notes = '   ';
        refreshUploadSnapshotHash(desired);
      },
      (plan) => {
        const desired = plan.uploads[0].desired!;
        desired.manual.defaultFieldMetadata = {};
        refreshUploadSnapshotHash(desired);
      },
      (plan) => {
        Object.assign(plan.uploads[0].desired!, {
          bundledPath: 'migration.assets/injected.bin',
          bundledSha256: 'a'.repeat(64),
        });
      },
      (plan) => {
        const desired = plan.uploads[0].desired!;
        desired.manual.tags = [' Foo ', 'foo'];
        refreshUploadSnapshotHash(desired);
      },
      (plan) => {
        const desired = plan.uploads[0].desired!;
        desired.md5 = '900150983CD24FB0D6963F7D28E17F72';
        refreshUploadSnapshotHash(desired);
      },
      (plan) => {
        plan.uploads[0].desired!.size = -1;
      },
      (plan) => {
        const desired = plan.uploads[0].desired!;
        desired.manual.collectionId = '';
        refreshUploadSnapshotHash(desired);
      },
      (plan) => {
        const upload = plan.uploads[0];
        upload.desired!.md5 = 'ffffffffffffffffffffffffffffffff';
        upload.desired!.transport.sourceUrl = 'ftp://example.test/asset.txt';
        refreshUploadSnapshotHash(upload.desired!);
        upload.changes = compareUploadChanges(
          upload.desired!,
          upload.baseline!,
        );
      },
      (plan) => {
        const upload = plan.uploads[0];
        upload.desired!.md5 = 'ffffffffffffffffffffffffffffffff';
        upload.desired!.transport.sourceUrl = 'http:asset.txt';
        refreshUploadSnapshotHash(upload.desired!);
        upload.changes = compareUploadChanges(
          upload.desired!,
          upload.baseline!,
        );
      },
      ...[
        'C:/migration.assets/upload.bin',
        'migration.assets/./upload.bin',
        'migration.assets/\u0000upload.bin',
      ].map((bundledPath) => (plan: ContentDiffPlan) => {
        plan.uploads[0].desired!.transport.bundledPath = bundledPath;
        plan.uploads[0].desired!.transport.sha256 = 'a'.repeat(64);
      }),
      (plan) => {
        const upload = plan.uploads[0];
        upload.action = 'create';
        upload.expectedTargetHash = null;
      },
      (plan) => {
        plan.uploads[0].desired!.hash = 'stale-upload-hash';
      },
      (plan) => {
        const upload = plan.uploads[0];
        upload.desired!.md5 = 'ffffffffffffffffffffffffffffffff';
        refreshUploadSnapshotHash(upload.desired!);
        upload.changes.binary = false;
        plan.requiredPermissions.uploadActions = ['read'];
      },
      (plan) => {
        const upload = plan.uploads[0];
        upload.desired!.manual.collectionId = 'collection-id';
        refreshUploadSnapshotHash(upload.desired!);
        upload.changes.collection = false;
        plan.requiredPermissions.uploadActions = ['read', 'replace_asset'];
      },
      (plan) => {
        const upload = plan.uploads[0];
        upload.desired!.basename = upload.baseline!.basename;
        upload.desired!.filename = upload.baseline!.filename;
        upload.desired!.manual.notes = 'changed notes';
        refreshUploadSnapshotHash(upload.desired!);
        upload.changes = {
          binary: false,
          metadata: true,
          collection: false,
        };
        plan.requiredPermissions.uploadActions = ['read'];
      },
    ];

    for (const tamper of cases) {
      const plan = makeUploadStemRenameRuntimePlan();
      tamper(plan);
      let clientReads = 0;
      const client = new Proxy(
        {},
        {
          get() {
            clientReads += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;
      const error = await expectRejects(
        runtime.runContentDiffMigration(client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(clientReads).to.equal(0);
    }
  });

  it('keeps the shared and embedded upload contracts in exact parity', async () => {
    const runtime = await loadRuntime(
      [
        'module.exports.__uploadPlanContractError = uploadPlanContractError;',
        'module.exports.__deriveRequiredUploadActions = deriveRequiredUploadActions;',
        'module.exports.__isUploadRequestFilenameFixedPoint = isUploadRequestFilenameFixedPoint;',
        'module.exports.__findNonPortableCreateIds = findNonPortableCreateIds;',
      ].join('\n'),
    );
    const uploadCreatePlan = makeUploadCreateRuntimePlan();
    const uploadSchema = uploadCreatePlan.schema;
    const create = structuredClone(uploadCreatePlan.uploads[0]);
    const createWithCanonicalTag = structuredClone(create);
    createWithCanonicalTag.desired!.manual.tags = ['blue'];
    refreshUploadSnapshotHash(createWithCanonicalTag.desired!);
    const bundledCreate = structuredClone(create);
    bundledCreate.desired!.transport = {
      sourceUrl: '',
      bundledPath: 'migration.assets/upload.bin',
      sha256: 'a'.repeat(64),
    };
    const rename = structuredClone(
      makeUploadStemRenameRuntimePlan().uploads[0],
    );
    const sparseRename = structuredClone(rename);
    const sparseMetadata = emptyUploadDefaultFieldMetadata([]);
    sparseRename.baseline!.manual.defaultFieldMetadata =
      structuredClone(sparseMetadata);
    sparseRename.desired!.manual.defaultFieldMetadata =
      structuredClone(sparseMetadata);
    refreshUploadSnapshotHash(sparseRename.baseline!);
    refreshUploadSnapshotHash(sparseRename.desired!);
    sparseRename.expectedTargetHash = sparseRename.baseline!.hash;
    sparseRename.changes = compareUploadChanges(
      sparseRename.desired!,
      sparseRename.baseline!,
    );
    const sparseNoop = structuredClone(sparseRename);
    sparseNoop.action = 'noop';
    sparseNoop.desired = structuredClone(sparseNoop.baseline);
    sparseNoop.expectedTargetHash = sparseNoop.baseline!.hash;
    sparseNoop.changes = { binary: false, metadata: false, collection: false };
    const manual = structuredClone(rename);
    manual.desired!.basename = manual.baseline!.basename;
    manual.desired!.filename = manual.baseline!.filename;
    manual.desired!.manual.notes = 'changed notes';
    refreshUploadSnapshotHash(manual.desired!);
    manual.changes = compareUploadChanges(manual.desired!, manual.baseline!);
    const collection = structuredClone(manual);
    collection.desired!.manual.notes = collection.baseline!.manual.notes;
    collection.desired!.manual.collectionId = 'collection-id';
    refreshUploadSnapshotHash(collection.desired!);
    collection.changes = compareUploadChanges(
      collection.desired!,
      collection.baseline!,
    );
    const binary = structuredClone(manual);
    binary.desired!.manual.notes = binary.baseline!.manual.notes;
    binary.desired!.md5 = 'ffffffffffffffffffffffffffffffff';
    refreshUploadSnapshotHash(binary.desired!);
    binary.changes = compareUploadChanges(binary.desired!, binary.baseline!);
    const binaryWithExplicitManual = structuredClone(binary);
    for (const key of ['author', 'copyright', 'notes'] as const) {
      binaryWithExplicitManual.baseline!.manual[key] = `${key} value`;
      binaryWithExplicitManual.desired!.manual[key] = `${key} value`;
    }
    refreshUploadSnapshotHash(binaryWithExplicitManual.baseline!);
    refreshUploadSnapshotHash(binaryWithExplicitManual.desired!);
    binaryWithExplicitManual.expectedTargetHash =
      binaryWithExplicitManual.baseline!.hash;
    binaryWithExplicitManual.changes = compareUploadChanges(
      binaryWithExplicitManual.desired!,
      binaryWithExplicitManual.baseline!,
    );
    const combined = structuredClone(rename);
    combined.desired!.md5 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    combined.desired!.manual.notes = 'combined notes';
    combined.desired!.manual.collectionId = 'collection-id';
    refreshUploadSnapshotHash(combined.desired!);
    combined.changes = compareUploadChanges(
      combined.desired!,
      combined.baseline!,
    );
    const noop = structuredClone(rename);
    noop.action = 'noop';
    noop.desired = structuredClone(noop.baseline);
    noop.expectedTargetHash = noop.baseline!.hash;
    noop.changes = { binary: false, metadata: false, collection: false };
    const deleted = structuredClone(noop);
    deleted.action = 'delete';
    deleted.desired = null;
    const invalidChanges = structuredClone(rename);
    invalidChanges.changes.binary = true;
    const invalidBaseline = structuredClone(create);
    invalidBaseline.baseline = structuredClone(create.desired);
    const invalidBasename = structuredClone(rename);
    invalidBasename.baseline!.basename = 'inconsistent';
    const invalidFilename = structuredClone(create);
    invalidFilename.desired!.basename = 'Asset Name';
    invalidFilename.desired!.filename = 'Asset Name.PNG';
    refreshUploadSnapshotHash(invalidFilename.desired!);
    const invalidManualArray = structuredClone(create);
    invalidManualArray.desired!.manual =
      [] as unknown as UploadSnapshot['manual'];
    refreshUploadSnapshotHash(invalidManualArray.desired!);
    const invalidManualMissingKey = structuredClone(create);
    Reflect.deleteProperty(invalidManualMissingKey.desired!.manual, 'notes');
    refreshUploadSnapshotHash(invalidManualMissingKey.desired!);
    const invalidBlankManual = structuredClone(create);
    invalidBlankManual.desired!.manual.author = '   ';
    refreshUploadSnapshotHash(invalidBlankManual.desired!);
    const invalidNelBlankManual = structuredClone(create);
    invalidNelBlankManual.desired!.manual.author = '\u0085';
    refreshUploadSnapshotHash(invalidNelBlankManual.desired!);
    const invalidNulManual = structuredClone(create);
    invalidNulManual.desired!.manual.notes = 'note\u0000suffix';
    refreshUploadSnapshotHash(invalidNulManual.desired!);
    const invalidDefaultFieldMetadata = structuredClone(create);
    invalidDefaultFieldMetadata.desired!.manual.defaultFieldMetadata = {};
    refreshUploadSnapshotHash(invalidDefaultFieldMetadata.desired!);
    const invalidSparseWritableMetadata = structuredClone(create);
    invalidSparseWritableMetadata.desired!.manual.defaultFieldMetadata =
      emptyUploadDefaultFieldMetadata([]);
    refreshUploadSnapshotHash(invalidSparseWritableMetadata.desired!);
    const invalidNulDefaultMetadata = structuredClone(create);
    (
      invalidNulDefaultMetadata.desired!.manual.defaultFieldMetadata as Record<
        string,
        any
      >
    ).alt.en = 'alt\u0000suffix';
    refreshUploadSnapshotHash(invalidNulDefaultMetadata.desired!);
    const invalidLegacyTransportFields = structuredClone(create);
    Object.assign(invalidLegacyTransportFields.desired!, {
      bundledPath: 'migration.assets/injected.bin',
      bundledSha256: 'a'.repeat(64),
    });
    const invalidTags = structuredClone(create);
    invalidTags.desired!.manual.tags = [' Foo ', 'foo'];
    refreshUploadSnapshotHash(invalidTags.desired!);
    const invalidControlTag = structuredClone(create);
    invalidControlTag.desired!.manual.tags = ['blue\u0007tag'];
    refreshUploadSnapshotHash(invalidControlTag.desired!);
    const invalidNelTag = structuredClone(create);
    invalidNelTag.desired!.manual.tags = ['blue\u0085tag'];
    refreshUploadSnapshotHash(invalidNelTag.desired!);
    const invalidUnicodeWhitespaceTag = structuredClone(create);
    invalidUnicodeWhitespaceTag.desired!.manual.tags = ['blue\u2003tag'];
    refreshUploadSnapshotHash(invalidUnicodeWhitespaceTag.desired!);
    const invalidMd5 = structuredClone(create);
    invalidMd5.desired!.md5 = '900150983CD24FB0D6963F7D28E17F72';
    refreshUploadSnapshotHash(invalidMd5.desired!);
    const invalidSize = structuredClone(create);
    invalidSize.desired!.size = -1;
    const invalidCollectionId = structuredClone(create);
    invalidCollectionId.desired!.manual.collectionId = '';
    refreshUploadSnapshotHash(invalidCollectionId.desired!);
    const invalidTransport = structuredClone(create);
    invalidTransport.desired!.transport.sourceUrl =
      'ftp://example.test/asset.txt';
    const invalidHttpShorthand = structuredClone(create);
    invalidHttpShorthand.desired!.transport.sourceUrl = 'http:asset.txt';
    const invalidCreateId = structuredClone(create);
    invalidCreateId.id = 'bad/id';
    invalidCreateId.desired!.id = 'bad/id';
    refreshUploadSnapshotHash(invalidCreateId.desired!);
    const invalidBundledPaths = [
      'C:/migration.assets/upload.bin',
      'migration.assets/./upload.bin',
      'migration.assets/../upload.bin',
      'migration.assets/\u0000upload.bin',
    ].map((bundledPath) => {
      const plan = structuredClone(bundledCreate);
      plan.desired!.transport.bundledPath = bundledPath;
      return plan;
    });

    const cases: UploadPlan[] = [
      create,
      createWithCanonicalTag,
      bundledCreate,
      rename,
      sparseRename,
      sparseNoop,
      manual,
      collection,
      binary,
      binaryWithExplicitManual,
      combined,
      noop,
      deleted,
      invalidChanges,
      invalidBaseline,
      invalidBasename,
      invalidFilename,
      invalidManualArray,
      invalidManualMissingKey,
      invalidBlankManual,
      invalidNelBlankManual,
      invalidNulManual,
      invalidDefaultFieldMetadata,
      invalidSparseWritableMetadata,
      invalidNulDefaultMetadata,
      invalidLegacyTransportFields,
      invalidTags,
      invalidControlTag,
      invalidNelTag,
      invalidUnicodeWhitespaceTag,
      invalidMd5,
      invalidSize,
      invalidCollectionId,
      invalidTransport,
      invalidHttpShorthand,
      invalidCreateId,
      ...invalidBundledPaths,
    ];
    const validActionMatrix = [
      { upload: create, actions: ['read', 'create'] },
      { upload: createWithCanonicalTag, actions: ['read', 'create'] },
      { upload: bundledCreate, actions: ['read', 'create'] },
      { upload: rename, actions: ['read', 'replace_asset'] },
      { upload: sparseRename, actions: ['read', 'replace_asset'] },
      { upload: sparseNoop, actions: ['read'] },
      { upload: manual, actions: ['read', 'update'] },
      { upload: collection, actions: ['read', 'move'] },
      { upload: binary, actions: ['read', 'update', 'replace_asset'] },
      {
        upload: binaryWithExplicitManual,
        actions: ['read', 'replace_asset'],
      },
      {
        upload: combined,
        actions: ['read', 'update', 'replace_asset', 'move'],
      },
      { upload: noop, actions: ['read'] },
      { upload: deleted, actions: ['read', 'delete'] },
    ] as const;
    for (const { upload, actions } of validActionMatrix) {
      expect(uploadPlanContractError(upload, uploadSchema)).to.equal(null);
      expect(deriveRequiredUploadActions([upload])).to.deep.equal(actions);
    }
    for (const upload of cases) {
      expect(runtime.__uploadPlanContractError!(upload, uploadSchema)).to.equal(
        uploadPlanContractError(upload, uploadSchema),
      );
      expect(runtime.__deriveRequiredUploadActions!([upload])).to.deep.equal(
        deriveRequiredUploadActions([upload]),
      );
    }

    const legacySchema = structuredClone(uploadSchema);
    legacySchema.environmentSemantics.nonLocalizedFocalPoints = false;
    legacySchema.locales = ['en', 'it'];
    // The CMA client reads and writes the field-keyed shape on every
    // environment, so it is the only valid one even where the wire format is
    // locale-keyed.
    const legacyCreate = structuredClone(create);
    legacyCreate.desired!.manual.defaultFieldMetadata = {
      alt: { en: null, it: null },
      title: { en: null, it: null },
      custom_data: { en: {}, it: {} },
      focal_point: null,
      poster_time: null,
    };
    refreshUploadSnapshotHash(legacyCreate.desired!);
    expect(uploadPlanContractError(legacyCreate, legacySchema)).to.equal(null);
    expect(
      runtime.__uploadPlanContractError!(legacyCreate, legacySchema),
    ).to.equal(null);
    const localeKeyedCreate = structuredClone(create);
    localeKeyedCreate.desired!.manual.defaultFieldMetadata = Object.fromEntries(
      ['en', 'it'].map((locale) => [
        locale,
        {
          alt: null,
          title: null,
          custom_data: {},
          focal_point: null,
          poster_time: null,
        },
      ]),
    ) as never;
    refreshUploadSnapshotHash(localeKeyedCreate.desired!);
    expect(uploadPlanContractError(localeKeyedCreate, legacySchema)).to.equal(
      'desired snapshot is malformed',
    );
    expect(
      runtime.__uploadPlanContractError!(localeKeyedCreate, legacySchema),
    ).to.equal('desired snapshot is malformed');
    const legacySparseRename = structuredClone(rename);
    const legacySparseMetadata = {
      alt: { en: null },
      title: { en: null },
      custom_data: { en: {} },
      focal_point: null,
      poster_time: null,
    };
    legacySparseRename.baseline!.manual.defaultFieldMetadata =
      structuredClone(legacySparseMetadata);
    legacySparseRename.desired!.manual.defaultFieldMetadata =
      structuredClone(legacySparseMetadata);
    refreshUploadSnapshotHash(legacySparseRename.baseline!);
    refreshUploadSnapshotHash(legacySparseRename.desired!);
    legacySparseRename.expectedTargetHash = legacySparseRename.baseline!.hash;
    legacySparseRename.changes = compareUploadChanges(
      legacySparseRename.desired!,
      legacySparseRename.baseline!,
    );
    expect(uploadPlanContractError(legacySparseRename, legacySchema)).to.equal(
      null,
    );
    expect(
      runtime.__uploadPlanContractError!(legacySparseRename, legacySchema),
    ).to.equal(null);
    expect(runtime.__findNonPortableCreateIds!(uploadCreatePlan)).to.deep.equal(
      findNonPortableCreateIds(uploadCreatePlan),
    );

    const filenames = [
      'asset.png',
      'asset-name_1.tar-gz',
      'Asset.png',
      'asset name.png',
      'fôô.png',
      'asset--name.png',
      'asset/_name.png',
      'asset\\name.png',
      'asset\u0000name.png',
      '',
      '.png',
      'asset.',
    ];
    for (const filename of filenames) {
      expect(runtime.__isUploadRequestFilenameFixedPoint!(filename)).to.equal(
        isUploadRequestFilenameFixedPoint(filename),
      );
    }
  });

  it('binds upload-collection plans and label transitions before CMA reads', async () => {
    const runtime = await loadRuntime(
      [
        'module.exports.__uploadCollectionPlanContractError = uploadCollectionPlanContractError;',
        'module.exports.__uploadCollectionOrderContractError = uploadCollectionOrderContractError;',
        'module.exports.__verifyLiveUploadCollectionLabelSafety = verifyLiveUploadCollectionLabelSafety;',
      ].join('\n'),
    );
    const collectionId = RECORD_ID;
    const baseline = makeCollectionState(
      collectionId,
      1,
    ) as UploadCollectionSnapshot;
    const desired: UploadCollectionSnapshot = {
      ...(makeCollectionState(collectionId, 2) as UploadCollectionSnapshot),
      label: 'desired-label',
      hash: '',
    };
    desired.hash = semanticHash({
      id: desired.id,
      label: desired.label,
      parentId: desired.parentId,
      position: desired.position,
    });
    const validUpdate: ContentDiffPlan['uploadCollections'][number] = {
      id: collectionId,
      action: 'update',
      expectedTargetHash: baseline.hash,
      baseline,
      desired,
    };
    const validCreate: ContentDiffPlan['uploadCollections'][number] = {
      id: BLOCK_ID,
      action: 'create',
      expectedTargetHash: null,
      baseline: null,
      desired: {
        ...(makeCollectionState(BLOCK_ID, 2) as UploadCollectionSnapshot),
        label: baseline.label,
        hash: '',
      },
    };
    validCreate.desired.hash = semanticHash({
      id: validCreate.desired.id,
      label: validCreate.desired.label,
      parentId: validCreate.desired.parentId,
      position: validCreate.desired.position,
    });
    const validNoop: ContentDiffPlan['uploadCollections'][number] = {
      id: baseline.id,
      action: 'noop',
      expectedTargetHash: baseline.hash,
      baseline,
      desired: structuredClone(baseline),
    };
    for (const collection of [validUpdate, validCreate, validNoop]) {
      expect(uploadCollectionPlanContractError(collection)).to.equal(null);
      expect(runtime.__uploadCollectionPlanContractError!(collection)).to.equal(
        null,
      );
    }

    expect(
      uploadCollectionOrderContractError(
        [validUpdate, validCreate],
        [validUpdate.id, validCreate.id],
      ),
    ).to.equal(null);
    expect(
      runtime.__uploadCollectionOrderContractError!(
        [validUpdate, validCreate],
        [validUpdate.id, validCreate.id],
      ),
    ).to.equal(null);
    expect(
      uploadCollectionOrderContractError(
        [validUpdate, validCreate],
        [validCreate.id, validUpdate.id],
      ),
    ).to.contain('occupied');

    const invalidCases = [
      (() => {
        const value = structuredClone(validUpdate);
        value.desired.id = 'bad/collection';
        value.desired.hash = semanticHash({
          id: value.desired.id,
          label: value.desired.label,
          parentId: value.desired.parentId,
          position: value.desired.position,
        });
        return value;
      })(),
      (() => {
        const value = structuredClone(validUpdate);
        value.desired.hash = 'stale-hash';
        return value;
      })(),
      {
        ...structuredClone(validNoop),
        action: 'update' as const,
      },
      (() => {
        const value = structuredClone(validNoop);
        value.desired.position = 2;
        value.desired.hash = semanticHash({
          id: value.desired.id,
          label: value.desired.label,
          parentId: value.desired.parentId,
          position: value.desired.position,
        });
        return value;
      })(),
      (() => {
        const value = structuredClone(validCreate);
        value.desired.position = 1.5;
        return value;
      })(),
      (() => {
        const value = structuredClone(validCreate);
        Object.assign(value.desired, { extra: true });
        return value;
      })(),
    ] as ContentDiffPlan['uploadCollections'];

    for (const collection of invalidCases) {
      expect(runtime.__uploadCollectionPlanContractError!(collection)).to.equal(
        uploadCollectionPlanContractError(collection),
      );
      expect(uploadCollectionPlanContractError(collection)).not.to.equal(null);
      const plan = makeRuntimePlan('desired', 'baseline');
      plan.uploadCollections = [collection];
      plan.execution.collectionOrder =
        collection.action === 'noop' ? [] : [collection.id];
      plan.requiredPermissions.manageUploadCollections = true;
      let clientReads = 0;
      const client = new Proxy(
        {},
        {
          get() {
            clientReads += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;
      const error = await expectRejects(
        runtime.runContentDiffMigration(client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(clientReads).to.equal(0);
    }

    for (const tamper of [
      (plan: ContentDiffPlan) => {
        plan.execution.collectionOrder = [];
      },
      (plan: ContentDiffPlan) => {
        plan.requiredPermissions.manageUploadCollections = false;
      },
    ]) {
      const plan = makeRuntimePlan('desired', 'baseline');
      plan.uploadCollections = [structuredClone(validUpdate)];
      plan.execution.collectionOrder = [validUpdate.id];
      plan.requiredPermissions.manageUploadCollections = true;
      tamper(plan);
      let clientReads = 0;
      const client = new Proxy(
        {},
        {
          get() {
            clientReads += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;
      const error = await expectRejects(
        runtime.runContentDiffMigration(client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(clientReads).to.equal(0);
    }

    const unmanagedOccupant = makeCollectionState('unmanaged-occupant', 9);
    const occupancyError = await expectRejects(
      runtime.__verifyLiveUploadCollectionLabelSafety!({
        client: {
          uploadCollections: {
            list: async () => [
              {
                id: unmanagedOccupant.id,
                label: validCreate.desired.label,
                parent: null,
                position: unmanagedOccupant.position,
              },
            ],
          },
        },
        plan: {
          execution: { collectionOrder: [validCreate.id] },
          uploadCollections: [validCreate],
        },
      }),
    );
    expect((occupancyError as RuntimeError).code).to.equal(
      'UPLOAD_COLLECTION_LABEL_CONFLICT',
    );
  });

  it('rejects a re-signed plan block with malformed attributes before reads', async () => {
    const runtime = await loadRuntime();
    for (const attributes of [null, []]) {
      const plan = makeNestedBlockRuntimePlan(makeNestedBlock());
      const content = plan.records[0].desired!.current.fields
        .content as JsonObject;
      content.attributes = attributes;
      let clientReads = 0;
      const client = new Proxy(
        {},
        {
          get() {
            clientReads += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;
      const error = await expectRejects(
        runtime.runContentDiffMigration(client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_CMA_RESPONSE');
      expect(error.message).to.equal(
        'Nested content at content has malformed block attributes.',
      );
      expect(
        (error as RuntimeError & { details: unknown }).details,
      ).to.deep.equal({ path: 'content' });
      expect(clientReads).to.equal(0);
    }
  });

  it('rejects a re-signed plan whose warnings are not an array before reads (D46)', async () => {
    const runtime = await loadRuntime();
    for (const warnings of [null, {}, 'none']) {
      const plan = makeNestedBlockRuntimePlan(makeNestedBlock());
      (plan as unknown as { warnings: unknown }).warnings = warnings;
      let clientReads = 0;
      const client = new Proxy(
        {},
        {
          get() {
            clientReads += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;
      const error = await expectRejects(
        runtime.runContentDiffMigration(client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(error.message).to.equal(
        'Content diff plan property warnings must be an array.',
      );
      expect(clientReads).to.equal(0);
    }
  });

  it('rejects every re-signed non-portable CMA create ID before reads', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__findNonPortableCreateIds = findNonPortableCreateIds;\n' +
        'module.exports.__findRecordSnapshotIdentityMismatches = findRecordSnapshotIdentityMismatches;\n',
    );
    const recordPlan = makeNestedBlockRuntimePlan(makeNestedBlock());
    recordPlan.records[0].id = 'bad/record';

    const nestedPlan = makeNestedBlockRuntimePlan(makeNestedBlock());
    expect(
      mutateNestedBlockId(
        nestedPlan.records[0].desired!.current.fields,
        BLOCK_ID,
        'bad/block',
      ),
    ).to.equal(true);

    const uploadPlan = makeUploadCreateRuntimePlan();
    uploadPlan.uploads[0].id = 'bad/upload';
    uploadPlan.uploads[0].desired!.id = 'bad/upload';
    refreshUploadSnapshotHash(uploadPlan.uploads[0].desired!);

    const collectionPlan = makeRuntimePlan('desired', 'baseline');
    const collectionState = {
      id: 'bad/collection',
      label: 'Bad collection',
      parentId: null,
      position: 0,
      hash: '',
    };
    collectionState.hash = semanticHash({
      id: collectionState.id,
      label: collectionState.label,
      parentId: collectionState.parentId,
      position: collectionState.position,
    });
    collectionPlan.uploadCollections = [
      {
        id: collectionState.id,
        action: 'create',
        expectedTargetHash: null,
        baseline: null,
        desired: collectionState,
      },
    ];

    const desiredIdMismatchPlan = makeNestedBlockRuntimePlan(makeNestedBlock());
    desiredIdMismatchPlan.records[0].desired!.id = 'bad/record';
    const itemTypeMismatchPlan = makeNestedBlockRuntimePlan(makeNestedBlock());
    itemTypeMismatchPlan.records[0].desired!.itemTypeId = BLOCK_MODEL_ID;

    for (const plan of [
      recordPlan,
      nestedPlan,
      uploadPlan,
      collectionPlan,
      desiredIdMismatchPlan,
      itemTypeMismatchPlan,
    ]) {
      const sharedIds = findNonPortableCreateIds(plan);
      const sharedIdentityMismatches =
        findRecordSnapshotIdentityMismatches(plan);
      expect(
        sharedIds.length + sharedIdentityMismatches.length,
      ).to.be.greaterThan(0);
      expect(runtime.__findNonPortableCreateIds!(plan)).to.deep.equal(
        sharedIds,
      );
      expect(
        runtime.__findRecordSnapshotIdentityMismatches!(plan),
      ).to.deep.equal(sharedIdentityMismatches);
      let clientReads = 0;
      const client = new Proxy(
        {},
        {
          get() {
            clientReads += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;
      const error = await expectRejects(
        runtime.runContentDiffMigration(client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
      expect(clientReads).to.equal(0);
    }

    const jsonDecoyPlan = makeNestedBlockRuntimePlan(makeNestedBlock());
    const ownerType = jsonDecoyPlan.schema.itemTypes.find(
      ({ id }) => id === jsonDecoyPlan.records[0].itemTypeId,
    )!;
    ownerType.fields.push({
      ...ownerType.fields[0],
      id: 'json-decoy-field',
      apiKey: 'json_decoy',
      fieldType: 'json',
      position: ownerType.fields.length + 1,
      validators: {},
    });
    jsonDecoyPlan.records[0].desired!.current.fields.json_decoy = {
      id: '123',
      type: 'item',
      relationships: {
        item_type: {
          data: { id: BLOCK_MODEL_ID, type: 'item_type' },
        },
      },
    };
    expect(findNonPortableCreateIds(jsonDecoyPlan)).to.deep.equal([]);
    expect(runtime.__findNonPortableCreateIds!(jsonDecoyPlan)).to.deep.equal(
      [],
    );

    const legacyNonCreates = makeRuntimePlan('desired', 'baseline');
    legacyNonCreates.records[0].id = '178178741';
    legacyNonCreates.records[0].baseline!.id = '178178741';
    legacyNonCreates.records[0].desired!.id = '178178741';
    legacyNonCreates.uploads = [
      {
        ...structuredClone(makeUploadStemRenameRuntimePlan().uploads[0]),
        id: '178178742',
        baseline: {
          ...structuredClone(
            makeUploadStemRenameRuntimePlan().uploads[0].baseline!,
          ),
          id: '178178742',
        },
        desired: {
          ...structuredClone(
            makeUploadStemRenameRuntimePlan().uploads[0].desired!,
          ),
          id: '178178742',
        },
      },
    ];
    refreshUploadSnapshotHash(legacyNonCreates.uploads[0].baseline!);
    refreshUploadSnapshotHash(legacyNonCreates.uploads[0].desired!);
    legacyNonCreates.uploads[0].expectedTargetHash =
      legacyNonCreates.uploads[0].baseline!.hash;
    legacyNonCreates.uploadCollections = [
      {
        id: '178178743',
        action: 'noop',
        expectedTargetHash: null,
        baseline: null,
        desired: makeCollectionState(
          '178178743',
          1,
        ) as UploadCollectionSnapshot,
      },
    ];
    legacyNonCreates.uploadCollections[0].baseline = structuredClone(
      legacyNonCreates.uploadCollections[0].desired,
    );
    legacyNonCreates.uploadCollections[0].expectedTargetHash =
      legacyNonCreates.uploadCollections[0].desired.hash;
    expect(findNonPortableCreateIds(legacyNonCreates)).to.deep.equal([]);
    expect(runtime.__findNonPortableCreateIds!(legacyNonCreates)).to.deep.equal(
      [],
    );
  });

  it('rejects a re-signed active CREATE sanitizer risk before any CMA read', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan();
    const titleField = plan.schema.itemTypes[0].fields.find(
      ({ id }) => id === 'title-field',
    )!;
    titleField.fieldType = 'text';
    titleField.validators = {
      sanitized_html: { sanitize_before_validation: true },
    };
    const desired = plan.records[0].desired!;
    desired.current.fields.title = '<p>This <br /> text</p>';
    desired.current.hash = semanticHash(desired.current.fields);
    plan.schema.digest = computeSchemaDigest(plan.schema);
    plan.source.schemaDigest = plan.schema.digest;
    plan.target.schemaDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.originalDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.fullyRelaxedDigest = plan.schema.digest;

    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      fieldDefaultValues: { 'historical-number-field': 42.625 },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(error.message).to.contain('active sanitized_html');
    expect(mock.reads.site).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.recordCreates()).to.equal(0);
  });

  it('rejects re-signed full-rehydrate UPDATE sanitizer risks before any CMA read', async () => {
    const runtime = await loadRuntime();
    for (const historicalValue of [
      '<p>Historical <br /> text</p>',
      'C1:\u0085',
      'raw NBSP:\u00a0',
      `noncharacter:${String.fromCodePoint(0x1fffe)}`,
    ]) {
      const plan = makeRuntimePlan('desired title', 'baseline title');
      plan.schema.itemTypes[0].fields.push({
        id: 'historical-html-field',
        apiKey: 'historical_html',
        fieldType: 'text',
        localized: false,
        position: 3,
        defaultValue: null,
        validators: {
          sanitized_html: { sanitize_before_validation: true },
        },
      });
      const record = plan.records[0];
      record.baseline!.current.fields.historical_html = historicalValue;
      record.baseline!.current.hash = semanticHash(
        record.baseline!.current.fields,
      );
      record.desired!.current.fields.historical_html = historicalValue;
      record.desired!.current.hash = semanticHash(
        record.desired!.current.fields,
      );
      plan.schema.digest = computeSchemaDigest(plan.schema);
      plan.source.schemaDigest = plan.schema.digest;
      plan.target.schemaDigest = plan.schema.digest;
      plan.invalidContent.schemaStates.originalDigest = plan.schema.digest;
      plan.invalidContent.schemaStates.fullyRelaxedDigest = plan.schema.digest;

      const mock = makeRuntimeClient('baseline title');
      const error = await expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      );

      expect((error as RuntimeError).code, historicalValue).to.equal(
        'INVALID_PLAN',
      );
      expect(
        (
          error as RuntimeError & {
            details?: { stages?: string[] };
          }
        ).details?.stages,
      ).to.deep.equal(['current-restore']);
      expect(mock.reads.site).to.equal(0);
      expect(mock.mutations.update).to.equal(0);
      expect(mock.schemaMutations.update).to.equal(0);
      expect(mock.recordCreates()).to.equal(0);
    }
  });

  it('rejects a re-signed inspection-only nested sanitizer risk before any CMA read', async () => {
    let plan = makeNestedBlockUpdateRuntimePlan(
      'desired title',
      'baseline title',
      '<p>Historical nested &copy; text</p>',
    );
    const blockType = plan.schema.itemTypes.find(
      ({ id }) => id === BLOCK_MODEL_ID,
    )!;
    const blockText = blockType.fields.find(
      ({ id }) => id === 'block-text-field',
    )!;
    blockText.fieldType = 'text';
    blockText.validators = {
      sanitized_html: { sanitize_before_validation: true },
    };
    plan = moveBlockModelToTargetInspection(plan);

    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline title');
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(
      (
        error as RuntimeError & {
          details?: { stages?: string[]; paths?: string[] };
        }
      ).details,
    ).to.deep.include({ stages: ['current-restore'] });
    expect(
      (
        error as RuntimeError & {
          details?: { paths?: string[] };
        }
      ).details?.paths,
    ).to.deep.equal([`record:${RECORD_ID}.content.block:${BLOCK_ID}.text`]);
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('rejects a phase-10 sanitizer risk on a shifted no-op sibling before any CMA read', async () => {
    const plan = makePositionShiftedNoopSiblingRuntimePlan();
    const titleField = plan.schema.itemTypes[0].fields.find(
      ({ id }) => id === 'title-field',
    )!;
    titleField.fieldType = 'text';
    titleField.validators = {
      sanitized_html: { sanitize_before_validation: true },
    };
    plan.schema.digest = computeSchemaDigest(plan.schema);
    plan.source.schemaDigest = plan.schema.digest;
    plan.target.schemaDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.originalDigest = plan.schema.digest;
    plan.invalidContent.schemaStates.fullyRelaxedDigest = plan.schema.digest;

    expect(
      plan.records.find(({ id }) => id === MAPPING_RECORD_ID)?.action,
    ).to.equal('noop');

    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('irrelevant');
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(
      (
        error as RuntimeError & {
          details?: {
            recordIds?: string[];
            stages?: string[];
            paths?: string[];
          };
        }
      ).details,
    ).to.deep.include({
      recordIds: [MAPPING_RECORD_ID],
      stages: ['position-finalize'],
      paths: [`record:${MAPPING_RECORD_ID}.title`],
    });
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('requires core in-place and allow-primary opt-ins before suppressing a default on primary', async () => {
    const plan = makeHistoricalNullCreateRuntimePlan();
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('absent', {
      recordAbsent: true,
      allowRecordCreate: true,
      primary: true,
      fieldDefaultValues: { 'historical-number-field': 42.625 },
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal(
      'PRIMARY_SCHEMA_RELAXATION_FORBIDDEN',
    );
    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.recordCreates()).to.equal(0);
  });

  it('verifies destination-only inspection schema without widening the managed digest', async () => {
    const plan = moveBlockModelToTargetInspection(
      makeRuntimePlan('unchanged', 'unchanged'),
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });

    expect(mock.mutations).to.deep.equal({ update: 0 });
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('rejects inspection-only block-schema drift before content mutation', async () => {
    const plan = moveBlockModelToTargetInspection(
      makeRuntimePlan('unchanged', 'unchanged'),
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      fieldValidators: { 'block-text-field': { length: { min: 2 } } },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INSPECTION_SCHEMA_MISMATCH');
    expect(mock.mutations).to.deep.equal({ update: 0 });
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('rejects a tampered inspection contract before reading the target', async () => {
    const plan = moveBlockModelToTargetInspection(
      makeRuntimePlan('unchanged', 'unchanged'),
    );
    plan.targetInspection.digest = 'tampered';
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INVALID_PLAN');
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('recovers an owned partial relaxation before reporting inspection-schema drift', async () => {
    const plan = moveBlockModelToTargetInspection(
      makeValidatorRelaxationRuntimePlan('desired', 'baseline'),
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: {
        'title-field': {},
        'block-text-field': { length: { min: 2 } },
      },
    });
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('INSPECTION_SCHEMA_MISMATCH');
    expect(mock.schemaMutations.update).to.equal(1);
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('validates plan integrity before reading the target project', async () => {
    const plan = makeRuntimePlan('unchanged', 'unchanged');
    const envelope = makeEnvelope(plan);
    envelope.plan.source.environmentId = 'tampered-source';
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged');
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, envelope, {
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal('PLAN_INTEGRITY_FAILURE');
    expect(mock.reads.site).to.equal(0);
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('accepts a source-only nested block already created at its exact desired location', async () => {
    const block = makeNestedBlock();
    const plan = makeNestedBlockRuntimePlan(block);
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', { content: block });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });

    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('rejects a source-only nested block ID found outside its desired location', async () => {
    const block = makeNestedBlock();
    const plan = makeNestedBlockRuntimePlan(block);
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      content: null,
      detachedBlock: block,
      recordAbsent: true,
    });
    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('BLOCK_OWNERSHIP_CONFLICT');
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('validates a published deletion release before issuing any mutation', async () => {
    const plan = makePublishedDeleteReleaseRuntimePlan();
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('obsolete', {
      published: true,
      validateExistingError: new Error('release payload is invalid'),
    });
    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal(
      'DELETE_RELEASE_VALIDATION_FAILURE',
    );
    expect(error.message).to.contain(RECORD_ID);
    expect(mock.reads.validateExisting).to.equal(1);
    expect(mock.mutations).to.deep.equal({ update: 0 });
  });

  it('validates a relaxed deletion release immediately after schema relaxation and before content mutations', async () => {
    const plan = makePublishedDeleteReleaseRuntimePlan();
    const relaxationPlan = makeValidatorRelaxationRuntimePlan(
      'desired',
      'baseline',
    );
    plan.schema = relaxationPlan.schema;
    plan.source.schemaDigest = relaxationPlan.source.schemaDigest;
    plan.target.schemaDigest = relaxationPlan.target.schemaDigest;
    plan.options.migrateInvalidContent = true;
    plan.requiredPermissions.editSchema = true;
    plan.invalidContent = relaxationPlan.invalidContent;

    const runtime = await loadRuntime();
    const events: string[] = [];
    const mock = makeRuntimeClient('obsolete', {
      published: true,
      fieldValidators: { 'title-field': { required: {} } },
      validateExistingError: new Error('relaxed release remains invalid'),
      events,
    });
    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal(
      'DELETE_RELEASE_VALIDATION_FAILURE',
    );
    expect(mock.reads.validateExisting).to.equal(1);
    expect(mock.mutations.update).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(2);
    expect(events).to.deep.equal(['schema-write', 'schema-write']);
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
  });

  it('defers validator-owned deletion-release validation until schema relaxation is active', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifyPublishedDeleteReleases = verifyPublishedDeleteReleases;\n',
    );
    let calls = 0;
    const context = {
      client: {
        items: {
          validateExisting: async () => {
            calls += 1;
          },
        },
      },
      initialRecords: new Map([[RECORD_ID, {}]]),
      recordPlansById: new Map([
        [RECORD_ID, { id: RECORD_ID, itemTypeId: MODEL_ID }],
      ]),
      captureSchemaById: new Map([[MODEL_ID, { id: MODEL_ID, fields: [] }]]),
      plan: {
        execution: {
          deleteReleases: [
            {
              recordId: RECORD_ID,
              fields: { title: null },
              intermediateCurrentHash: semanticHash({ title: null }),
              publish: true,
              transientNestedBlockIds: [],
            },
          ],
        },
        invalidContent: {
          validatorRelaxations: [{ affectedRecordIds: [RECORD_ID] }],
        },
      },
    };

    await runtime.__verifyPublishedDeleteReleases!(context, false);
    expect(calls).to.equal(0);

    await runtime.__verifyPublishedDeleteReleases!(context, true);
    expect(calls).to.equal(1);
  });

  it('strips transient block IDs only from deletion-release validation payloads', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__buildRuntimeRecordValidationPayload = buildRuntimeRecordValidationPayload;\n',
    );
    const schema = makeSchema('destination');
    const payload = runtime.__buildRuntimeRecordValidationPayload!(
      {
        captureSchemaById: new Map(
          schema.itemTypes.map((itemType) => [itemType.id, itemType]),
        ),
      },
      { content: makeNestedBlock() },
      MODEL_ID,
    );

    expect((payload.content as any).id).to.equal(undefined);
    expect((payload.content as any).attributes).to.deep.equal({
      text: 'Already created',
    });
    expect((payload.content as any).relationships.item_type.data.id).to.equal(
      BLOCK_MODEL_ID,
    );
  });

  it('preserves Structured Text metadata through canonicalization, validation, defaults, and field patches', async () => {
    const runtime = await loadRuntime(
      [
        'module.exports.__canonicalizeRuntimeRecord = canonicalizeRecord;',
        'module.exports.__buildRuntimeRecordValidationPayload = buildRuntimeRecordValidationPayload;',
        'module.exports.__applyCreateDefaultsToFields = applyCreateDefaultsToFields;',
        'module.exports.__buildVersionPatch = buildVersionPatch;',
      ].join('\n'),
    );
    const schema = makeSchema('source');
    const itemType = schema.itemTypes[0];
    itemType.fields.find(({ apiKey }) => apiKey === 'content')!.fieldType =
      'structured_text';
    schema.itemTypes[1].fields[0].defaultValue = 'Block default';
    itemType.fields.push({
      id: 'json-field',
      apiKey: 'json',
      fieldType: 'json',
      localized: false,
      position: 3,
      validators: {},
    });
    const schemaById = new Map(
      schema.itemTypes.map((entry) => [entry.id, entry]),
    );
    const block = { ...makeNestedBlock(), attributes: { text: null } };
    const sidecar = structuredClone(block);
    const content = {
      schema: 'dast',
      sidecar,
      document: {
        type: 'root',
        sidecar,
        children: [{ type: 'block', item: block, sidecar }],
      },
    };
    const fields = {
      content,
      json: Object.fromEntries([
        ['sidecar', sidecar],
        ['\u00e9', 1],
        ['e\u0301', 2],
        ['__proto__', 'ordinary metadata'],
        ['constructor', 'another metadata label'],
      ]),
    };
    const current = { ...makeRecord('baseline', 'current-version'), ...fields };
    const schedules = { publication: null, unpublishing: null };
    const normalized = runtime.__canonicalizeRuntimeRecord!(
      current,
      null,
      itemType,
      schema,
      schedules,
    );
    expect(normalized).to.deep.equal(
      canonicalizeRecord(current, null, itemType, schema, schedules),
    );
    expect(normalized.current.fields.content).to.deep.equal(content);

    const validation = runtime.__buildRuntimeRecordValidationPayload!(
      { captureSchemaById: schemaById },
      fields,
      MODEL_ID,
    );
    const validationBlock = Object.fromEntries(
      Object.entries(block).filter(([key]) => key !== 'id'),
    );
    expect(validation.content).to.deep.equal({
      ...content,
      document: {
        ...content.document,
        children: [{ type: 'block', item: validationBlock, sidecar }],
      },
    });
    expect(validation.json).to.deep.equal(fields.json);

    const created = runtime.__applyCreateDefaultsToFields!(
      fields,
      itemType,
      schema,
    );
    expect(created.content).to.deep.equal({
      ...content,
      document: {
        ...content.document,
        children: [
          {
            type: 'block',
            item: { ...block, attributes: { text: 'Block default' } },
            sidecar,
          },
        ],
      },
    });
    expect(created.json).to.deep.equal(fields.json);

    const desiredFields = {
      content: { ...content, revision: 2 },
      json: { sidecar, revision: 2 },
    };
    const patch = runtime.__buildVersionPatch!(
      desiredFields,
      fields,
      { current: { fields } },
      itemType,
      schemaById,
    );
    expect(patch.content).to.deep.equal({
      ...desiredFields.content,
      document: {
        ...content.document,
        children: [{ type: 'block', item: BLOCK_ID, sidecar }],
      },
    });
    expect(patch.json).to.deep.equal(desiredFields.json);
    expect(
      runtime.__buildVersionPatch!(
        { newly_present: { value: 1 } },
        fields,
        { current: { fields } },
        itemType,
        schemaById,
      ),
    ).to.deep.equal({ newly_present: { value: 1 } });
  });

  it('writes a published-derived release with its fresh transient block instead of reusing the published-only block', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__buildVersionPatch = buildVersionPatch;\n',
    );
    const transientBlock = {
      ...makeNestedBlock(),
      id: MAPPING_BATCH_ID,
      attributes: { text: 'Published release' },
    };
    const patch = runtime.__buildVersionPatch!(
      { content: transientBlock },
      { content: null },
      {
        current: { fields: { content: null } },
        published: { fields: { content: makeNestedBlock() } },
      },
      makeSchema('source').itemTypes[0],
      new Map(
        makeSchema('source').itemTypes.map((itemType) => [
          itemType.id,
          itemType,
        ]),
      ),
    );

    expect(patch).to.deep.equal({ content: transientBlock });
    expect((patch.content as any).id).to.equal(MAPPING_BATCH_ID);
    expect((patch.content as any).id).not.to.equal(BLOCK_ID);
  });

  it('reserves transient deletion-release block IDs across fresh and resumed runs', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifyTransientDeleteReleaseBlockIds = verifyTransientDeleteReleaseBlockIds;\n',
    );
    const block = makeNestedBlock();
    const schemaContext = {
      captureSchemaById: new Map(
        makeSchema('source').itemTypes.map((itemType) => [
          itemType.id,
          itemType,
        ]),
      ),
      recordPlansById: new Map([[RECORD_ID, { itemTypeId: MODEL_ID }]]),
    };
    const fields = { content: block };
    const release = {
      recordId: RECORD_ID,
      fields,
      intermediateCurrentHash: semanticHash(fields),
      publish: true,
      transientNestedBlockIds: [BLOCK_ID],
    };
    const absentClient = {
      items: {
        find: async () => {
          throw { response: { status: 404 } };
        },
      },
    };

    await runtime.__verifyTransientDeleteReleaseBlockIds!({
      ...schemaContext,
      client: absentClient,
      initialRecords: new Map([
        [RECORD_ID, { current: { fields: {}, hash: 'baseline' } }],
      ]),
      plan: { execution: { deleteReleases: [release] } },
    });

    const occupiedError = await expectRejects(
      runtime.__verifyTransientDeleteReleaseBlockIds!({
        ...schemaContext,
        client: { items: { find: async () => structuredClone(block) } },
        initialRecords: new Map([
          [RECORD_ID, { current: { fields: {}, hash: 'baseline' } }],
        ]),
        plan: { execution: { deleteReleases: [release] } },
      }),
    );
    expect((occupiedError as RuntimeError).code).to.equal(
      'BLOCK_OWNERSHIP_CONFLICT',
    );

    await runtime.__verifyTransientDeleteReleaseBlockIds!({
      ...schemaContext,
      client: { items: { find: async () => structuredClone(block) } },
      initialRecords: new Map([
        [
          RECORD_ID,
          {
            current: {
              fields: structuredClone(fields),
              hash: release.intermediateCurrentHash,
            },
          },
        ],
      ]),
      plan: { execution: { deleteReleases: [release] } },
    });
  });

  it('resumes after a tree reparent whose retained-sibling position is unknowable', async () => {
    const plan = makeReparentRuntimePlan();
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      tree: true,
      parentId: EXTERNAL_PARENT_ID,
      position: 7,
      externalParent: true,
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      log: () => undefined,
    });

    expect(mock.current().parent_id).to.equal(EXTERNAL_PARENT_ID);
    expect(mock.current().position).to.equal(7);
    expect(mock.mutations.update).to.equal(0);
  });

  it('requires exact positions for a fully managed 65-record sortable group', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__recordPositionGoalReached = recordPositionGoalReached;\n',
    );
    const positional = Array.from({ length: 65 }, (_, position) => ({
      id: `record-${String(position).padStart(2, '0')}`,
      itemTypeId: MODEL_ID,
      desired: { topology: { parentId: null, position } },
    }));
    const shiftedState = new Map(
      positional.map((recordPlan, position) => [
        recordPlan.id,
        { parentId: null, position: position + 25 },
      ]),
    );
    const context = {
      plan: {
        options: { includeDeletions: false },
        warnings: [] as Array<{ code: string }>,
      },
    };

    expect(
      runtime.__recordPositionGoalReached!(context, positional, shiftedState),
      'relative order alone must not make an exactly reproducible group converge',
    ).to.equal(false);

    const exactState = new Map(
      positional.map((recordPlan, position) => [
        recordPlan.id,
        { parentId: null, position },
      ]),
    );
    expect(
      runtime.__recordPositionGoalReached!(context, positional, exactState),
    ).to.equal(true);

    context.plan.warnings.push({
      code: 'ABSOLUTE_POSITION_NOT_REPRODUCIBLE',
    });
    expect(
      runtime.__recordPositionGoalReached!(context, positional, shiftedState),
      'retained ordered siblings intentionally reduce the goal to relative order',
    ).to.equal(true);
  });

  it('treats upload extension case as a binary replacement', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__uploadNeedsBinaryTransfer = uploadNeedsBinaryTransfer;\n',
    );

    expect(
      runtime.__uploadNeedsBinaryTransfer!(
        { md5: 'aa', filename: 'photo.jpg' },
        { md5: 'aa', filename: 'photo.JPG' },
      ),
    ).to.equal(true);
  });

  it('accepts only canonical unpadded portable DatoCMS IDs', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__isPortableDatoId = isPortableDatoId;\nmodule.exports.__isCanonicalLegacyDatoId = isCanonicalLegacyDatoId;\n',
    );

    expect(runtime.__isPortableDatoId!(RECORD_ID)).to.equal(true);
    expect(runtime.__isPortableDatoId!(`${RECORD_ID}==`)).to.equal(false);
    expect(
      runtime.__isPortableDatoId!(
        MODEL_ID.replace(/-/g, '+').replace(/_/g, '/'),
      ),
    ).to.equal(false);
    expect(runtime.__isPortableDatoId!('178178741')).to.equal(false);
    expect(runtime.__isCanonicalLegacyDatoId!('0')).to.equal(true);
    expect(runtime.__isCanonicalLegacyDatoId!('281474976710655')).to.equal(
      true,
    );
    expect(runtime.__isCanonicalLegacyDatoId!('01')).to.equal(false);
    expect(runtime.__isCanonicalLegacyDatoId!('281474976710656')).to.equal(
      false,
    );
  });

  it('checks legacy source occupancy in Item, upload, and collection namespaces', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifyLegacySourceIdsAbsent = verifyLegacySourceIdsAbsent;\n',
    );
    const notFound = () => {
      const error = new Error('not found') as Error & {
        response: { status: number };
      };
      error.response = { status: 404 };
      return error;
    };
    const cases = [
      { entityType: 'record', namespace: 'item' },
      { entityType: 'block', namespace: 'item' },
      { entityType: 'upload', namespace: 'upload' },
      { entityType: 'upload_collection', namespace: 'collection' },
    ] as const;

    for (const testCase of cases) {
      const client = {
        items: {
          find: async (id: string) => {
            if (testCase.namespace !== 'item') throw notFound();
            return {
              id,
              item_type: { id: MODEL_ID, type: 'item_type' },
            };
          },
        },
        uploads: {
          find: async (id: string) => {
            if (testCase.namespace !== 'upload') throw notFound();
            return { id, type: 'upload' };
          },
        },
        uploadCollections: {
          find: async (id: string) => {
            if (testCase.namespace !== 'collection') throw notFound();
            return { id, type: 'upload_collection' };
          },
        },
      };
      const error = await expectRejects(
        runtime.__verifyLegacySourceIdsAbsent!({
          client,
          plan: {
            legacyIdMappings: {
              entries: [
                {
                  entityType: testCase.entityType,
                  sourceId: '178178741',
                  targetId: RECORD_ID,
                },
              ],
            },
          },
        }),
      );

      expect((error as RuntimeError).code).to.equal(
        'LEGACY_SOURCE_ID_OCCUPIED',
      );
    }
  });

  it('rejects a Cartesian upload state the runtime never produces', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__isSafeUploadIntermediate = isSafeUploadIntermediate;\n' +
        'module.exports.__uploadBinaryUpdateBody = uploadBinaryUpdateBody;\n' +
        'module.exports.__uploadBinaryIntermediateManual = uploadBinaryIntermediateManual;\n' +
        'module.exports.__uploadManualUpdateBody = uploadManualUpdateBody;\n',
    );
    const baseline = makeUploadState('aa', 'before.jpg', 'before', 'before');
    const desired = makeUploadState('bb', 'after.png', 'custom-after', 'after');
    const externallyMixed = makeUploadState(
      baseline.md5,
      baseline.filename,
      baseline.basename,
      'after',
    );

    expect(
      runtime.__isSafeUploadIntermediate!(externallyMixed, {
        action: 'update',
        baseline,
        desired,
        changes: { binary: true },
      }),
    ).to.equal(false);
    const uploadPlan = {
      action: 'update',
      baseline,
      desired,
      changes: { binary: true },
    };
    const crashPrefix = makeUploadState('bb', 'after.png', 'after', 'before');
    crashPrefix.manual = runtime.__uploadBinaryIntermediateManual!(uploadPlan);
    expect(
      runtime.__uploadBinaryUpdateBody!(uploadPlan, '/tmp/staged.png'),
    ).to.deep.equal({
      localPath: '/tmp/staged.png',
      filename: 'after.png',
      author: '__dcd_null__',
      copyright: '__dcd_null__',
    });
    expect(
      runtime.__isSafeUploadIntermediate!(crashPrefix, uploadPlan),
    ).to.equal(true);
    expect(
      runtime.__uploadManualUpdateBody!(crashPrefix, desired),
    ).to.deep.equal({
      basename: 'custom-after',
      author: null,
      copyright: null,
      notes: 'after',
    });
  });

  it('waits out a possible external collision before the first request and spaces later same-name requests', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__waitForUploadFilenameWindow = waitForUploadFilenameWindow;\n',
    );
    const context = {
      options: { uploadFilenameCollisionWindowMs: 20 },
      uploadRequestTimes: new Map<string, number>(),
      uploadFilenameWindowStartedAt: Date.now(),
    };

    const startedAt = context.uploadFilenameWindowStartedAt;
    await runtime.__waitForUploadFilenameWindow!(context, 'same.jpg');
    const first = context.uploadRequestTimes.get('same.jpg')!;
    const simulatedServerFilename =
      first < startedAt + 20 ? 'same-2.jpg' : 'same.jpg';
    await runtime.__waitForUploadFilenameWindow!(context, 'same.jpg');
    const second = context.uploadRequestTimes.get('same.jpg')!;

    expect(first - startedAt).to.be.at.least(20);
    expect(simulatedServerFilename).to.equal('same.jpg');
    expect(second - first).to.be.at.least(20);
  });

  it('waits before rename-only metadata updates without double-waiting after binary replacement', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__uploadManualUpdateNeedsFilenameWindow = uploadManualUpdateNeedsFilenameWindow;\n' +
        'module.exports.__uploadManualUpdateBody = uploadManualUpdateBody;\n' +
        'module.exports.__canonicalizeUpload = canonicalizeUploadState;\n',
    );
    const desired = makeUploadState(
      'bb',
      'renamed.png',
      'renamed',
      'desired notes',
    );
    const renameOnlyLive = makeUploadState(
      'bb',
      'baseline.png',
      'baseline',
      'desired notes',
    );
    const postBinaryLive = makeUploadState(
      'bb',
      'renamed.png',
      'renamed',
      'baseline notes',
    );

    expect(
      runtime.__uploadManualUpdateNeedsFilenameWindow!(renameOnlyLive, desired),
    ).to.equal(true);
    expect(
      runtime.__uploadManualUpdateNeedsFilenameWindow!(postBinaryLive, desired),
    ).to.equal(false);

    const rawRenameLive = makeExistingUpload(RECORD_ID);
    rawRenameLive.tags = ['zeta', 'alpha'];
    rawRenameLive.filename = 'baseline.png';
    rawRenameLive.basename = 'baseline';
    const canonicalRenameLive = runtime.__canonicalizeUpload!(rawRenameLive, [
      'en',
    ]);
    const canonicalRenameDesired = structuredClone(canonicalRenameLive);
    canonicalRenameDesired.filename = 'renamed.png';
    canonicalRenameDesired.basename = 'renamed';
    expect(canonicalRenameLive.manual.tags).to.deep.equal(['alpha', 'zeta']);
    expect(
      runtime.__uploadManualUpdateBody!(
        canonicalRenameLive,
        canonicalRenameDesired,
      ),
    ).to.deep.equal({ basename: 'renamed' });

    const canonicalPostBinaryLive = structuredClone(canonicalRenameDesired);
    canonicalPostBinaryLive.manual.notes = 'baseline notes';
    canonicalRenameDesired.manual.notes = 'desired notes';
    expect(
      runtime.__uploadManualUpdateBody!(
        canonicalPostBinaryLive,
        canonicalRenameDesired,
      ),
    ).to.deep.equal({ notes: 'desired notes' });
  });

  it('accepts only deterministic upload-collection reorder intermediates', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__matchesPlannedCollectionState = matchesPlannedCollectionState;\n',
    );
    const baselineA = makeCollectionState('collection-a', 1);
    const baselineB = makeCollectionState('collection-b', 2);
    const desiredA = makeCollectionState('collection-a', 2);
    const desiredB = makeCollectionState('collection-b', 1);
    const context = {
      plan: {
        uploadCollections: [
          {
            id: 'collection-a',
            action: 'noop',
            baseline: baselineA,
            desired: desiredA,
          },
          {
            id: 'collection-b',
            action: 'update',
            baseline: baselineB,
            desired: desiredB,
          },
        ],
        execution: { collectionOrder: ['collection-b'] },
      },
    };
    const plannedPartial = JSON.stringify([
      {
        id: 'collection-a',
        label: 'collection-a',
        parentId: null,
        position: 2,
      },
      {
        id: 'collection-b',
        label: 'collection-b',
        parentId: null,
        position: 1,
      },
    ]);
    const externalDrift = JSON.stringify([
      {
        id: 'collection-a',
        label: 'collection-a',
        parentId: null,
        position: 7,
      },
      {
        id: 'collection-b',
        label: 'collection-b',
        parentId: null,
        position: 2,
      },
    ]);

    expect(
      runtime.__matchesPlannedCollectionState!(context, plannedPartial).matched,
    ).to.equal(true);
    expect(
      runtime.__matchesPlannedCollectionState!(context, externalDrift).matched,
    ).to.equal(false);
  });

  it('models collection reordering as a replay-closed canonical pass', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__matchesPlannedCollectionState = matchesPlannedCollectionState;\n',
    );
    const ids = [
      'collection-a',
      'collection-b',
      'collection-c',
      'collection-d',
    ];
    const desiredPositions = [2, 3, 4, 1];
    const context = {
      plan: {
        uploadCollections: ids.map((id, index) => ({
          id,
          action: 'update',
          baseline: makeCollectionState(id, index + 1),
          desired: makeCollectionState(id, desiredPositions[index]),
        })),
        execution: { collectionOrder: ids },
      },
    };
    const nonCanonicalPrefix = JSON.stringify([
      { id: ids[0], label: ids[0], parentId: null, position: 1 },
      { id: ids[1], label: ids[1], parentId: null, position: 3 },
      { id: ids[2], label: ids[2], parentId: null, position: 2 },
      { id: ids[3], label: ids[3], parentId: null, position: 4 },
    ]);
    const canonicalPrefix = JSON.stringify(
      ids.map((id, index) => ({
        id,
        label: id,
        parentId: null,
        position: desiredPositions[index],
      })),
    );

    expect(
      runtime.__matchesPlannedCollectionState!(context, nonCanonicalPrefix)
        .matched,
    ).to.equal(false);
    expect(
      runtime.__matchesPlannedCollectionState!(context, canonicalPrefix)
        .matched,
    ).to.equal(true);
  });

  it('accepts the exact collection state reached after restarting a crash prefix', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__matchesPlannedCollectionState = matchesPlannedCollectionState;\n',
    );
    const ids = ['collection-a', 'collection-b', 'collection-c'];
    const context = {
      plan: {
        uploadCollections: ids.map((id, index) => ({
          id,
          action: 'update',
          baseline: makeCollectionState(id, index + 1),
          desired: makeCollectionState(id, index + 2),
        })),
        execution: { collectionOrder: ids },
      },
    };
    const crashAfterB = JSON.stringify([
      { id: ids[0], label: ids[0], parentId: null, position: 1 },
      { id: ids[1], label: ids[1], parentId: null, position: 3 },
      { id: ids[2], label: ids[2], parentId: null, position: 2 },
    ]);
    const afterRestartedA = JSON.stringify([
      { id: ids[0], label: ids[0], parentId: null, position: 2 },
      { id: ids[1], label: ids[1], parentId: null, position: 3 },
      { id: ids[2], label: ids[2], parentId: null, position: 1 },
    ]);

    expect(
      runtime.__matchesPlannedCollectionState!(context, crashAfterB).matched,
    ).to.equal(true);
    expect(
      runtime.__matchesPlannedCollectionState!(context, afterRestartedA)
        .matched,
    ).to.equal(true);
  });

  it('accepts an appended create position determined by target-only collection siblings', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__matchesPlannedCollectionState = matchesPlannedCollectionState;\n',
    );
    const desired = makeCollectionState('collection-new', 1);
    const context = {
      plan: {
        uploadCollections: [
          {
            id: desired.id,
            action: 'create',
            baseline: null,
            desired,
          },
        ],
        execution: { collectionOrder: [desired.id] },
      },
    };
    const appendedAfterUnmanagedSibling = JSON.stringify([
      {
        id: desired.id,
        label: desired.label,
        parentId: null,
        position: 6,
      },
    ]);

    expect(
      runtime.__matchesPlannedCollectionState!(
        context,
        appendedAfterUnmanagedSibling,
      ).matched,
    ).to.equal(true);
  });

  it('accepts every bounded collection fixed-point pass with omitted siblings', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__matchesPlannedCollectionState = matchesPlannedCollectionState;\n',
    );
    const desiredA = makeCollectionState('collection-a', 2);
    const desiredB = makeCollectionState('collection-b', 4);
    const context = {
      plan: {
        uploadCollections: [
          {
            id: desiredA.id,
            action: 'update',
            baseline: makeCollectionState(desiredA.id, 3),
            desired: desiredA,
          },
          {
            id: desiredB.id,
            action: 'update',
            baseline: makeCollectionState(desiredB.id, 1),
            desired: desiredB,
          },
        ],
        execution: { collectionOrder: [desiredA.id, desiredB.id] },
      },
    };
    const afterFirstPass = JSON.stringify([
      { id: desiredA.id, label: desiredA.label, parentId: null, position: 1 },
      { id: desiredB.id, label: desiredB.label, parentId: null, position: 4 },
    ]);
    const afterSecondPass = JSON.stringify([
      { id: desiredA.id, label: desiredA.label, parentId: null, position: 2 },
      { id: desiredB.id, label: desiredB.label, parentId: null, position: 4 },
    ]);

    expect(
      runtime.__matchesPlannedCollectionState!(context, afterFirstPass).matched,
    ).to.equal(true);
    expect(
      runtime.__matchesPlannedCollectionState!(context, afterSecondPass)
        .matched,
    ).to.equal(true);
  });

  it('recognizes both publication-seed crash states for a source-only create', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__isKnownCreateRecordPhaseState = isKnownCreateRecordPhaseState;\n',
    );
    const dependencyId = 'QYQL8Qz2SLqVzpARvepgtg';
    const itemType = {
      id: MODEL_ID,
      draftModeActive: true,
      workflowId: null,
      fields: [
        {
          apiKey: 'target',
          fieldType: 'link',
          localized: false,
          validators: {},
        },
      ],
    };
    const seedHash = semanticHash({ target: null });
    const desiredHash = semanticHash({ target: dependencyId });
    const desired = {
      current: { fields: { target: dependencyId }, hash: desiredHash },
      published: { fields: { target: dependencyId }, hash: desiredHash },
      topology: { parentId: null, position: 1 },
      lifecycle: {
        createdAt: '2025-01-01T00:00:00.000Z',
        firstPublishedAt: null,
      },
      stage: null,
      schedules: { publication: null, unpublishing: null },
    };
    const recordPlan = {
      id: RECORD_ID,
      itemTypeId: MODEL_ID,
      action: 'create',
      baseline: null,
      desired,
    };
    const context = {
      plan: {
        records: [recordPlan, { id: dependencyId, action: 'create' }],
        execution: {
          createOrder: [RECORD_ID, dependencyId],
          shellRecordIds: [],
          shellComponents: [],
          publicationSeedOrder: [RECORD_ID],
        },
      },
      schemaById: new Map([[MODEL_ID, itemType]]),
    };
    const seedPublished = {
      current: { hash: seedHash },
      published: { hash: seedHash },
      topology: { parentId: null },
      lifecycle: desired.lifecycle,
      stage: null,
      schedules: desired.schedules,
    };

    expect(
      runtime.__isKnownCreateRecordPhaseState!(
        context,
        seedPublished,
        recordPlan,
        itemType,
      ),
    ).to.equal(true);
    expect(
      runtime.__isKnownCreateRecordPhaseState!(
        context,
        { ...seedPublished, current: { hash: desiredHash } },
        recordPlan,
        itemType,
      ),
    ).to.equal(true);
  });

  it('creates an exact-ID source-only no-draft singleton only after its dependency is published', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__createMissingRecords = createMissingRecords;\n',
    );
    const dependencyId = EXTERNAL_PARENT_ID;
    const singletonId = RECORD_ID;
    const dependencyModel = {
      id: MODEL_ID,
      singleton: false,
      tree: false,
      sortable: false,
      draftModeActive: false,
      fields: [
        {
          id: 'dependency-title-field',
          apiKey: 'title',
          fieldType: 'string',
          localized: false,
          position: 1,
          validators: { required: {} },
        },
      ],
    };
    const singletonModel = {
      id: MAPPING_MODEL_ID,
      singleton: true,
      tree: false,
      sortable: false,
      draftModeActive: false,
      fields: [
        {
          id: 'singleton-title-field',
          apiKey: 'title',
          fieldType: 'string',
          localized: false,
          position: 1,
          validators: { required: {} },
        },
        {
          id: 'singleton-dependency-field',
          apiKey: 'dependency',
          fieldType: 'link',
          localized: false,
          position: 2,
          validators: { required: {} },
        },
      ],
    };
    const desired = (fields: Record<string, any>) => {
      const version = { fields, hash: semanticHash(fields) };
      return {
        current: version,
        published: version,
        topology: { parentId: null, position: null },
        lifecycle: {
          createdAt: '2025-01-01T00:00:00.000Z',
          firstPublishedAt: null,
        },
        stage: null,
        schedules: { publication: null, unpublishing: null },
      };
    };
    const dependencyPlan = {
      id: dependencyId,
      itemTypeId: dependencyModel.id,
      action: 'create',
      baseline: null,
      desired: desired({ title: 'published dependency' }),
    };
    const singletonPlan = {
      id: singletonId,
      itemTypeId: singletonModel.id,
      action: 'create',
      baseline: null,
      desired: desired({
        title: 'published singleton',
        dependency: dependencyId,
      }),
    };
    const created = new Set<string>();
    const published = new Set<string>();
    const createdRecords = new Map<string, Record<string, any>>();
    const createBodies: Record<string, any>[] = [];
    const notFound = () => ({ response: { status: 404 } });
    const client = {
      items: {
        find: async (id: string, options: { version?: string } = {}) => {
          const available =
            options.version === 'published' ? published : created;
          if (!available.has(id)) throw notFound();
          return structuredClone(createdRecords.get(id));
        },
        create: async (body: Record<string, any>) => {
          if (body.id === singletonId) {
            expect(published.has(dependencyId)).to.equal(
              true,
              'singleton create ran before its no-draft dependency was published',
            );
          }
          createBodies.push(structuredClone(body));
          created.add(body.id);
          published.add(body.id);
          const record = {
            ...structuredClone(body),
            type: 'item',
            meta: {
              created_at: body.meta.created_at,
              first_published_at: body.meta.first_published_at,
              current_version: `created-${body.id}`,
              updated_at: '2025-01-01T00:00:00.000Z',
              published_at: '2025-01-01T00:00:00.000Z',
              stage: null,
              is_valid: true,
              is_current_version_valid: true,
              is_published_version_valid: true,
            },
          };
          createdRecords.set(body.id, record);
          return structuredClone(record);
        },
      },
    };
    const plans = [dependencyPlan, singletonPlan];
    const context = {
      client,
      plan: {
        records: plans,
        execution: {
          createOrder: [dependencyId, singletonId],
          shellRecordIds: [],
          shellComponents: [],
        },
        invalidContent: { validatorRelaxations: [] },
      },
      recordPlansById: new Map(plans.map((plan) => [plan.id, plan])),
      schemaById: new Map([
        [dependencyModel.id, dependencyModel],
        [singletonModel.id, singletonModel],
      ]),
      captureSchemaById: new Map([
        [dependencyModel.id, dependencyModel],
        [singletonModel.id, singletonModel],
      ]),
      captureSchema: {
        locales: ['en'],
        itemTypes: [dependencyModel, singletonModel],
      },
      mutationCount: 0,
    };

    await runtime.__createMissingRecords!(context);

    expect(createBodies.map(({ id }) => id)).to.deep.equal([
      dependencyId,
      singletonId,
    ]);
    expect(createBodies[1]).to.include({
      id: singletonId,
      dependency: dependencyId,
    });
    expect(createBodies[1].item_type).to.deep.equal({
      id: singletonModel.id,
      type: 'item_type',
    });
    expect(context.mutationCount).to.equal(2);
  });

  it('rejects incomplete schedule relationships instead of silently treating them as absent', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__readSchedules = readSchedules;\n',
    );
    const schedules: RuntimeScheduleState = {
      publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
      unpublishing: null,
    };
    const malformedRelationships = [
      undefined,
      null,
      {},
      { data: undefined },
      { data: [] },
      { data: 'schedule' },
      { data: { id: '', type: 'scheduled_unpublishing' } },
      { data: { id: 'missing-resource', type: 'scheduled_unpublishing' } },
      { data: { id: 'publication-schedule', type: 'scheduled_publication' } },
    ];

    for (const relationship of malformedRelationships) {
      const mock = makeRuntimeClient('baseline', { schedules });
      const response =
        await mock.client.items.rawCurrentVsPublishedState(RECORD_ID);
      (
        response.data.relationships as Record<string, unknown>
      ).scheduled_unpublishing = relationship;
      const client = {
        items: { rawCurrentVsPublishedState: async () => response },
      };
      const error = await expectRejects(
        runtime.__readSchedules!(
          { client, plan: makeRuntimePlan('desired', 'baseline', schedules) },
          mock.current(),
        ),
      );
      expect((error as RuntimeError).code).to.equal(
        'SCHEDULE_CONTRACT_CHANGED',
      );
    }
  });

  it('rejects incomplete schedule scopes before schedule or content mutation', async () => {
    const schedules: RuntimeScheduleState = {
      publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
      unpublishing: { at: '2099-02-01T00:00:00.000Z', locales: null },
    };
    const runtime = await loadRuntime();
    const cases = [
      {
        type: 'scheduled_publication',
        key: 'selective_publication',
        value: undefined,
      },
      {
        type: 'scheduled_publication',
        key: 'selective_publication',
        value: false,
      },
      {
        type: 'scheduled_publication',
        key: 'selective_publication',
        value: { content_in_locales: ['en'] },
      },
      {
        type: 'scheduled_publication',
        key: 'selective_publication',
        value: { content_in_locales: [42], non_localized_content: true },
      },
      {
        type: 'scheduled_unpublishing',
        key: 'content_in_locales',
        value: undefined,
      },
      {
        type: 'scheduled_unpublishing',
        key: 'content_in_locales',
        value: false,
      },
      {
        type: 'scheduled_unpublishing',
        key: 'content_in_locales',
        value: [42],
      },
    ];
    for (const testCase of cases) {
      const plan = makeRuntimePlan('desired', 'baseline', schedules);
      const mock = makeRuntimeClient('baseline', { schedules });
      const rawRead = mock.client.items.rawCurrentVsPublishedState.bind(
        mock.client.items,
      );
      mock.client.items.rawCurrentVsPublishedState = async (...args) => {
        const response = await rawRead(...args);
        const resource = response.included!.find(
          ({ type }) => type === testCase.type,
        )!;
        (resource.attributes as Record<string, unknown>)[testCase.key] =
          testCase.value;
        return response;
      };
      const error = await withMutedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            log: () => undefined,
          }),
        ),
      );
      expect((error as RuntimeError).code).to.equal(
        'SCHEDULE_CONTRACT_CHANGED',
      );
      expect(mock.mutations.update).to.equal(0);
      expect(mock.schedules()).to.deep.equal(schedules);
    }
  });

  it('rejects an unchanged live schedule that can fire before phase-2 quiescence', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__validateSchedulesBeforeCancellation = validateSchedulesBeforeCancellation;\n',
    );
    const publication = {
      at: new Date(Date.now() + 1000).toISOString(),
      selective: null,
    };
    const recordPlan = {
      id: RECORD_ID,
      action: 'update',
      changes: { current: true, schedules: false },
      desired: {
        schedules: { publication, unpublishing: null },
      },
    };
    const context = {
      options: { scheduleSafetyWindowMs: 5 * 60 * 1000 },
      plan: {
        records: [recordPlan],
        uploads: [],
        uploadCollections: [],
        requiredPermissions: { editSchema: false },
        legacyIdMappings: { newMappingBatch: null },
      },
      initialRecords: new Map([
        [
          RECORD_ID,
          {
            schedules: {
              publication,
              unpublishing: null,
            },
          },
        ],
      ]),
    };

    expect(() =>
      runtime.__validateSchedulesBeforeCancellation!(context),
    ).to.throw('may fire before phase 2');
  });

  it('rechecks schedule lead time immediately before cancellation', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__assertScheduleStillSafe = assertScheduleStillSafe;\n',
    );
    const context = { options: { scheduleSafetyWindowMs: 5 * 60 * 1000 } };

    expect(() =>
      runtime.__assertScheduleStillSafe!(
        context,
        RECORD_ID,
        'live publication cancellation',
        new Date(Date.now() + 1000).toISOString(),
      ),
    ).to.throw('became too close');
  });

  it('rejects an exact desired schedule recreated while records must remain quiesced', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__assertRecordSafeForResume = assertRecordSafeForResume;\n',
    );
    const plan = makeRuntimePlan('desired title', 'baseline title');
    const recordPlan = plan.records[0];
    const publication = {
      at: '2099-01-01T00:00:00.000Z',
      selective: null,
    };
    const live = {
      hash: recordPlan.desired!.hash,
      schedules: { publication, unpublishing: null },
    };

    expect(() =>
      runtime.__assertRecordSafeForResume!(
        { schedulesQuiesced: true },
        recordPlan,
        live,
      ),
    ).to.throw('required schedules to remain quiesced');
  });

  it('proves schedule quiescence from the current shell and rejects a recreated schedule without reading published content', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifySchedulesRemainQuiesced = verifySchedulesRemainQuiesced;\n',
    );
    const publication = {
      at: '2099-01-01T00:00:00.000Z',
      selective: null,
    };
    let recreated = false;
    const reads: string[] = [];
    const client = {
      items: {
        find: async (
          id: string,
          options: { version?: string; nested?: boolean } = {},
        ) => {
          reads.push(`${String(options.version)}:${String(options.nested)}`);
          if (options.version === 'published') {
            throw new Error(
              'Published content must not be read for schedule quiescence',
            );
          }
          return {
            id,
            meta: {
              publication_scheduled_at: recreated ? publication.at : null,
              unpublishing_scheduled_at: null,
            },
          };
        },
        rawCurrentVsPublishedState: async () => {
          reads.push('schedule-state');
          return {
            data: {
              relationships: {
                scheduled_publication: {
                  data: recreated
                    ? {
                        id: 'recreated-publication',
                        type: 'scheduled_publication',
                      }
                    : null,
                },
                scheduled_unpublishing: { data: null },
              },
            },
            included: recreated
              ? [
                  {
                    id: 'recreated-publication',
                    type: 'scheduled_publication',
                    attributes: {
                      publication_scheduled_at: publication.at,
                      selective_publication: null,
                    },
                  },
                ]
              : [],
          };
        },
      },
    };
    const context = {
      client,
      schedulesQuiesced: true,
      plan: {
        records: [
          {
            id: RECORD_ID,
            itemTypeId: MODEL_ID,
            action: 'update',
            desired: {
              schedules: { publication: null, unpublishing: null },
            },
          },
        ],
        schema: { locales: ['en'] },
      },
    };

    await runtime.__verifySchedulesRemainQuiesced!(context);
    expect(reads).to.deep.equal(['current:false']);

    recreated = true;
    const error = await expectRejects(
      runtime.__verifySchedulesRemainQuiesced!(context),
    );
    expect((error as RuntimeError).code).to.equal(
      'SCHEDULE_RECREATED_DURING_MIGRATION',
    );
    expect(reads).to.deep.equal([
      'current:false',
      'current:false',
      'schedule-state',
    ]);
  });

  it('batches fresh shell reads for repeated 65-record position and schedule sweeps', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__captureLiveRecordPositionStateSignature = captureLiveRecordPositionStateSignature;\nmodule.exports.__verifySchedulesRemainQuiesced = verifySchedulesRemainQuiesced;\n',
    );
    const ids = Array.from({ length: 65 }, (_, index) => `record-${index}`);
    const resources = new Map(
      ids.map((id, index) => [id, makeRawRecordShell(id, index + 1)]),
    );
    const requests: Record<string, any>[] = [];
    const context = makeShellSweepContext(
      {
        items: {
          rawList: async (query: Record<string, any>) => {
            requests.push(query);
            const selected = (query.filter.ids as string).split(',');
            return {
              data: selected
                .map((id) => structuredClone(resources.get(id)!))
                .reverse(),
              meta: { total_count: selected.length },
            };
          },
          find: async () => {
            throw new Error('Listed records must not be read individually');
          },
        },
      },
      ids,
    );

    const first =
      await runtime.__captureLiveRecordPositionStateSignature!(context);
    await runtime.__verifySchedulesRemainQuiesced!(context);
    expect(
      await runtime.__captureLiveRecordPositionStateSignature!(context),
    ).to.equal(first);
    await runtime.__verifySchedulesRemainQuiesced!(context);
    expect(requests).to.have.length(4);
    for (const query of requests) {
      expect(query).to.deep.equal({
        filter: { ids: ids.join(',') },
        version: 'current',
        nested: false,
        page: { offset: 0, limit: 100 },
      });
    }

    resources.get(ids[0])!.attributes.position = 99;
    const next =
      await runtime.__captureLiveRecordPositionStateSignature!(context);
    expect(next).not.to.equal(first);
    expect(
      JSON.parse(next).find((row: { id: string }) => row.id === ids[0])
        .position,
    ).to.equal(99);
    expect(requests).to.have.length(5);
  });

  it('bounds targeted shell lists to one page and directly resolves every omitted ID', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__findItemsCurrentShells = findItemsCurrentShells;\n',
    );
    const ids = Array.from({ length: 205 }, (_, index) => `record-${index}`);
    const missing = new Set([ids[3], ids[204]]);
    const batches: string[][] = [];
    const directReads: string[] = [];
    const client = {
      items: {
        rawList: async (query: Record<string, any>) => {
          expect(query.page).to.deep.equal({ offset: 0, limit: 100 });
          const selected = (query.filter.ids as string).split(',');
          batches.push(selected);
          const data = selected
            .filter((id) => !missing.has(id))
            .map((id) => makeRawRecordShell(id));
          return { data: data.reverse(), meta: { total_count: data.length } };
        },
        find: async (id: string, query: Record<string, any>) => {
          directReads.push(id);
          expect(query).to.deep.equal({ version: 'current', nested: false });
          if (id === ids[3]) throw { response: { status: 404 } };
          return {
            id,
            position: 8,
            meta: {
              publication_scheduled_at: null,
              unpublishing_scheduled_at: null,
            },
          };
        },
      },
    };

    expect((await runtime.__findItemsCurrentShells!(client, [])).size).to.equal(
      0,
    );
    expect(batches).to.have.length(0);
    const result = await runtime.__findItemsCurrentShells!(client, [
      ...ids,
      ids[0],
    ]);
    expect(batches.map((batch) => batch.length)).to.deep.equal([100, 100, 5]);
    expect(batches.flat()).to.deep.equal(ids);
    expect(directReads).to.deep.equal([...missing]);
    expect(result.size).to.equal(205);
    expect(result.get(ids[3])).to.equal(null);
    expect(result.get(ids[204])?.position).to.equal(8);
    expect(result.get(ids[0])).to.include({
      id: ids[0],
      position: 1,
      parent_id: null,
    });
    expect(result.get(ids[0])?.item_type).to.deep.equal({
      id: MODEL_ID,
      type: 'item_type',
    });
    expect(result.get(ids[0])?.meta.publication_scheduled_at).to.equal(null);
  });

  it('detects recreated schedules in fresh targeted lists and omitted-ID lookups', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifySchedulesRemainQuiesced = verifySchedulesRemainQuiesced;\n',
    );
    for (const omitted of [false, true]) {
      let recreated = false;
      let batches = 0;
      let directReads = 0;
      let exactScheduleReads = 0;
      const at = '2099-01-01T00:00:00.000Z';
      const context = makeShellSweepContext(
        {
          items: {
            rawList: async () => {
              batches += 1;
              const current = makeRawRecordShell(RECORD_ID);
              current.meta.publication_scheduled_at = recreated ? at : null;
              return {
                data: omitted ? [] : [current],
                meta: { total_count: omitted ? 0 : 1 },
              };
            },
            find: async (id: string, query: Record<string, any>) => {
              directReads += 1;
              expect(query).to.deep.equal({
                version: 'current',
                nested: false,
              });
              return {
                id,
                meta: {
                  publication_scheduled_at: recreated ? at : null,
                  unpublishing_scheduled_at: null,
                },
              };
            },
            rawCurrentVsPublishedState: async () => {
              exactScheduleReads += 1;
              return {
                data: {
                  relationships: {
                    scheduled_publication: {
                      data: {
                        id: 'new-schedule',
                        type: 'scheduled_publication',
                      },
                    },
                    scheduled_unpublishing: { data: null },
                  },
                },
                included: [
                  {
                    id: 'new-schedule',
                    type: 'scheduled_publication',
                    attributes: {
                      publication_scheduled_at: at,
                      selective_publication: null,
                    },
                  },
                ],
              };
            },
          },
        },
        [RECORD_ID],
      );
      await runtime.__verifySchedulesRemainQuiesced!(context);
      recreated = true;
      const error = await expectRejects(
        runtime.__verifySchedulesRemainQuiesced!(context),
      );
      expect((error as RuntimeError).code).to.equal(
        'SCHEDULE_RECREATED_DURING_MIGRATION',
      );
      expect(batches).to.equal(2);
      expect(directReads).to.equal(omitted ? 2 : 0);
      expect(exactScheduleReads).to.equal(1);
    }
  });

  it('propagates targeted-list and omitted-ID errors before content mutations', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__findItemsCurrentShells = findItemsCurrentShells;\n',
    );
    for (const status of [403, 500]) {
      const failure = Object.assign(new Error(`CMA status ${status}`), {
        response: { status },
      });
      const client = {
        items: {
          rawList: async () => ({ data: [], meta: { total_count: 0 } }),
          find: async () => {
            throw failure;
          },
        },
      };
      expect(
        await expectRejects(
          runtime.__findItemsCurrentShells!(client, [RECORD_ID]),
        ),
      ).to.equal(failure);

      const mock = makeRuntimeClient('baseline');
      mock.client.items.rawList = async () => {
        throw failure;
      };
      expect(
        await expectRejects(
          runtime.runContentDiffMigration(
            mock.client,
            makeEnvelope(makeRuntimePlan('desired', 'baseline')),
          ),
        ),
      ).to.equal(failure);
      expect(mock.mutations).to.deep.equal({ update: 0 });
    }
  });

  it('rejects incomplete or malformed targeted shell responses without assuming absent records', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__findItemsCurrentShells = findItemsCurrentShells;\n',
    );
    const valid = () => ({
      data: [makeRawRecordShell(RECORD_ID)],
      meta: { total_count: 1 },
    });
    const malformed: unknown[] = [
      {},
      { data: [], meta: { total_count: 1 } },
      { data: [], meta: { total_count: -1 } },
      { data: [], meta: { total_count: 0.5 } },
      {
        data: [makeRawRecordShell(RECORD_ID), makeRawRecordShell(RECORD_ID)],
        meta: { total_count: 2 },
      },
      { data: [makeRawRecordShell('unrequested')], meta: { total_count: 1 } },
    ];
    for (const mutate of [
      (row: Record<string, any>) => {
        row.type = 'upload';
      },
      (row: Record<string, any>) => {
        row.attributes = null;
      },
      (row: Record<string, any>) => {
        row.relationships.item_type.data.type = 'upload';
      },
      (row: Record<string, any>) => {
        row.meta = null;
      },
      (row: Record<string, any>) => {
        row.meta.publication_scheduled_at = undefined;
      },
      (row: Record<string, any>) => {
        row.meta.unpublishing_scheduled_at = 123;
      },
    ]) {
      const response = valid();
      mutate(response.data[0]);
      malformed.push(response);
    }
    for (const response of malformed) {
      let directReads = 0;
      const client = {
        items: {
          rawList: async () => response,
          find: async () => {
            directReads += 1;
            throw new Error('Unexpected fallback');
          },
        },
      };
      const error = await expectRejects(
        runtime.__findItemsCurrentShells!(client, [
          RECORD_ID,
          EXTERNAL_PARENT_ID,
        ]),
      );
      expect((error as RuntimeError).code).to.equal('INVALID_CMA_RESPONSE');
      expect(directReads).to.equal(0);
    }
  });

  it('quiesces unchanged schedules on changed and noop records, restores them last, and makes converged replay zero-write', async () => {
    const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
    const changed = plan.records.find(({ id }) => id === RECORD_ID)!;
    const noop = plan.records.find(({ id }) => id === EXTERNAL_PARENT_ID)!;
    expect(changed.action).to.equal('update');
    expect(changed.changes.schedules).to.equal(false);
    expect(noop.action).to.equal('noop');
    expect(plan.requiredPermissions.manageSchedules).to.equal(true);
    expect(plan.requiredPermissions.itemTypes).to.deep.equal([
      { id: MODEL_ID, actions: ['read', 'update', 'publish'] },
    ]);

    const runtime = await loadRuntime();
    const mock = makeScheduleQuiescenceRuntimeClient(schedules);
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    const firstRunEvents = mock.events();
    const recordUpdate = firstRunEvents.indexOf(`record-update:${RECORD_ID}`);
    for (const id of [RECORD_ID, EXTERNAL_PARENT_ID]) {
      expect(
        firstRunEvents.indexOf(`publication-destroy:${id}`),
      ).to.be.lessThan(recordUpdate);
      expect(
        firstRunEvents.indexOf(`unpublishing-destroy:${id}`),
      ).to.be.lessThan(recordUpdate);
      expect(
        firstRunEvents.indexOf(`publication-create:${id}`),
      ).to.be.greaterThan(recordUpdate);
      expect(
        firstRunEvents.indexOf(`unpublishing-create:${id}`),
      ).to.be.greaterThan(recordUpdate);
      expect(mock.schedules(id)).to.deep.equal(schedules);
    }
    expect(mock.title(RECORD_ID)).to.equal('desired title');
    expect(mock.title(EXTERNAL_PARENT_ID)).to.equal('scheduled dependency');

    const eventCountBeforeReplay = firstRunEvents.length;
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.events()).to.have.length(eventCountBeforeReplay);
    expect(mock.schedules(RECORD_ID)).to.deep.equal(schedules);
    expect(mock.schedules(EXTERNAL_PARENT_ID)).to.deep.equal(schedules);
  });

  it('allows a converged guarded replay inside the schedule window but rejects the same nonconverged plan before writes', async () => {
    const nearSchedules: RuntimeScheduleState = {
      publication: {
        at: new Date(Date.now() + 1000).toISOString(),
        selective: null,
      },
      unpublishing: null,
    };
    const { plan } = makeScheduleQuiescenceRuntimePlan(nearSchedules);
    const runtime = await loadRuntime();
    const converged = makeScheduleQuiescenceRuntimeClient(
      nearSchedules,
      'desired title',
    );

    await runtime.runContentDiffMigration(
      converged.client,
      makeEnvelope(plan),
      {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      },
    );
    expect(converged.events()).to.deep.equal([]);
    expect(converged.schedules(RECORD_ID)).to.deep.equal(nearSchedules);

    const nonconverged = makeScheduleQuiescenceRuntimeClient(nearSchedules);
    const error = await expectRejects(
      runtime.runContentDiffMigration(nonconverged.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      }),
    );
    expect((error as RuntimeError).code).to.equal('SCHEDULE_TOO_CLOSE');
    expect(nonconverged.events()).to.deep.equal([]);
  });

  it('stages upload binaries before quiescing schedules and leaves them untouched when staging fails', async () => {
    const schedules: RuntimeScheduleState = {
      publication: {
        at: '2099-01-01T00:00:00.000Z',
        selective: null,
      },
      unpublishing: null,
    };
    const plan = makeRuntimePlan('desired title', 'baseline title', schedules);
    const uploadOnlyPlan = makeUploadCreateRuntimePlan();
    plan.uploads = uploadOnlyPlan.uploads;
    plan.execution.uploadOrder = uploadOnlyPlan.execution.uploadOrder;
    plan.requiredPermissions.uploadActions =
      uploadOnlyPlan.requiredPermissions.uploadActions;
    const events: string[] = [];
    const mock = makeRuntimeClient('baseline title', { events, schedules });
    const runtime = await loadRuntime();

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          fetchFn: async () => {
            events.push('upload-fetch');
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              body: Readable.toWeb(Readable.from(Buffer.from('wrong bytes'))),
            };
          },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('UPLOAD_CHECKSUM_FAILURE');
    expect(events).to.include('upload-fetch');
    expect(events).not.to.include('publication-schedule-destroy');
    expect(events).not.to.include('publication-schedule-create');
    expect(mock.schedules().publication).to.deep.equal(schedules.publication);
    expect(mock.mutations.update).to.equal(0);
  });

  it('aborts a stalled source download before quiescing schedules and before content writes', async () => {
    const schedules: RuntimeScheduleState = {
      publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
      unpublishing: null,
    };
    const plan = makeRuntimePlan('desired title', 'baseline title', schedules);
    const assets = makeUploadCreateRuntimePlan();
    plan.uploads = assets.uploads;
    plan.execution.uploadOrder = assets.execution.uploadOrder;
    plan.requiredPermissions.uploadActions =
      assets.requiredPermissions.uploadActions;
    const mock = makeRuntimeClient('baseline title', { schedules });
    const runtime = await loadRuntime();
    let cancelled = false;
    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
          uploadDownloadIdleTimeoutMs: 10,
          fetchFn: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Buffer.from('a'));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        }),
      ),
    );
    expect((error as RuntimeError).code).to.equal('UPLOAD_DOWNLOAD_TIMEOUT');
    expect(cancelled).to.equal(true);
    expect(mock.schedules().publication).to.deep.equal(schedules.publication);
    expect(mock.current().title).to.equal('baseline title');
    expect(mock.mutations.update).to.equal(0);
  });

  it('waits for restored validity and proves final content before recreating schedules', async () => {
    const schedules: RuntimeScheduleState = {
      publication: {
        at: '2099-01-01T00:00:00.000Z',
        selective: null,
      },
      unpublishing: null,
    };
    const plan = makeValidatorRelaxationRuntimePlan(
      'desired title',
      'baseline title',
      undefined,
      schedules,
    );
    const events: string[] = [];
    const mock = makeRuntimeClient('baseline title', {
      events,
      schedules,
      traceReads: true,
      fieldValidators: { 'title-field': { required: {} } },
    });
    const runtime = await loadRuntime();

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    const scheduleCreate = events.indexOf('publication-schedule-create');
    const lastSchemaWrite = events.lastIndexOf('schema-write');
    const finalProofEvents = events.slice(lastSchemaWrite + 1, scheduleCreate);
    expect(lastSchemaWrite).to.be.greaterThan(events.indexOf('record-update'));
    expect(scheduleCreate).to.be.greaterThan(lastSchemaWrite);
    expect(finalProofEvents).to.include('record-read');
    expect(finalProofEvents).to.include('site-read');
    expect(mock.schedules()).to.deep.equal(schedules);
  });

  it('waits on atomic current-response validity snapshots without reading published content or schedules', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__waitForExpectedRecordValidity = waitForExpectedRecordValidity;\n',
    );
    const neverPublishedId = 'rXxM1cAJT9ydXTKzrS7zJg';
    const initiallyMissingId = 'AnISQ7xNRGWQh5QctJXHEw';
    const reads = new Map<string, number>();
    let publishedReads = 0;
    let scheduleReads = 0;
    const notFound = () => ({ response: { status: 404 } });
    const client = {
      items: {
        find: async (
          id: string,
          options: { version?: string; nested?: boolean } = {},
        ) => {
          if (options.version === 'published') {
            publishedReads += 1;
            throw new Error(
              'Published content must not be read while waiting for validity',
            );
          }
          expect(options).to.deep.equal({ version: 'current', nested: false });
          const read = (reads.get(id) ?? 0) + 1;
          reads.set(id, read);
          if (id === initiallyMissingId && read === 1) throw notFound();
          if (id === RECORD_ID && read === 1) {
            return {
              id,
              meta: {
                is_valid: true,
                is_current_version_valid: true,
                is_published_version_valid: true,
              },
            };
          }
          return {
            id,
            meta: {
              is_valid: false,
              is_current_version_valid: false,
              is_published_version_valid: id === RECORD_ID ? false : null,
            },
          };
        },
        rawCurrentVsPublishedState: async () => {
          scheduleReads += 1;
          throw new Error(
            'Schedules must not be read while waiting for validity',
          );
        },
      },
    };
    const recordPlans = [
      {
        id: RECORD_ID,
        itemTypeId: MODEL_ID,
        desired: { validity: { current: false, published: false } },
      },
      ...[neverPublishedId, initiallyMissingId].map((id) => ({
        id,
        itemTypeId: MODEL_ID,
        desired: { validity: { current: false, published: null } },
      })),
    ];
    const context = {
      client,
      options: {
        validityProcessingTimeoutMs: 1000,
        validityProcessingPollIntervalMs: 0,
      },
      plan: {
        records: recordPlans,
        execution: { revalidateBeforePublishIds: [] },
        invalidContent: {
          validatorRelaxations: [
            {
              affectedRecordIds: [
                RECORD_ID,
                neverPublishedId,
                initiallyMissingId,
              ],
            },
          ],
          skippedRecords: [],
        },
      },
      recordPlansById: new Map(
        recordPlans.map((recordPlan) => [recordPlan.id, recordPlan]),
      ),
    };

    await runtime.__waitForExpectedRecordValidity!(context);

    expect(reads.get(RECORD_ID)).to.equal(2);
    expect(reads.get(neverPublishedId)).to.equal(2);
    expect(reads.get(initiallyMissingId)).to.equal(2);
    expect(publishedReads).to.equal(0);
    expect(scheduleReads).to.equal(0);
  });

  it('keeps strict cross-slice validity canonicalization after the atomic validity barrier', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__canonicalizeRuntimeRecord = canonicalizeRecord;\n',
    );
    const schema = makeSchema('source');
    const current = makePublishedRecord('title', 'current-version');
    current.meta.is_valid = false;
    current.meta.is_current_version_valid = false;
    current.meta.is_published_version_valid = false;
    const published = makePublishedRecord('title', 'published-version');
    published.meta.is_valid = true;

    expect(() =>
      runtime.__canonicalizeRuntimeRecord!(
        current,
        published,
        schema.itemTypes[0],
        schema,
        { publication: null, unpublishing: null },
      ),
    ).to.throw('reports inconsistent published validity flags');
  });

  it('refuses a tree destroy while an authoritative live child remains', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__assertNoUnsafeTreeChildren = assertNoUnsafeTreeChildren;\n',
    );
    const childId = 'd69jfDxMQdO5ksk1YVQqhQ';
    const recordPlan = { id: RECORD_ID, itemTypeId: MODEL_ID };
    const context = {
      client: {
        items: {
          listPagedIterator: async function* () {
            yield { id: childId, parent_id: RECORD_ID };
          },
        },
      },
      schemaById: new Map([[MODEL_ID, { tree: true }]]),
      recordPlansById: new Map(),
      plan: { execution: { deleteOrder: [RECORD_ID], publishOrder: [] } },
    };

    const error = await expectRejects(
      runtime.__assertNoUnsafeTreeChildren!(
        context,
        recordPlan,
        'current',
        false,
        'delete',
      ),
    );
    expect((error as RuntimeError).code).to.equal(
      'TREE_RECORD_STILL_HAS_CHILDREN',
    );
  });

  it('rejects record position drift immediately before an ordering write', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__assertLiveRecordPositionStateSafe = assertLiveRecordPositionStateSafe;\n',
    );
    let livePosition = 1;
    const recordPlan = {
      id: RECORD_ID,
      itemTypeId: MODEL_ID,
      action: 'update',
      baseline: { topology: { parentId: null, position: 1 } },
      desired: { topology: { parentId: null, position: 2 } },
      changes: { topology: true },
    };
    const context = {
      client: {
        items: {
          find: async () => ({
            id: RECORD_ID,
            parent_id: null,
            position: livePosition,
          }),
        },
      },
      schemaById: new Map([
        [MODEL_ID, { id: MODEL_ID, tree: false, sortable: true }],
      ]),
      plan: {
        records: [recordPlan],
        execution: { createOrder: [], deleteOrder: [] },
        options: { includeDeletions: false },
        warnings: [],
      },
    };

    await runtime.__assertLiveRecordPositionStateSafe!(context);
    livePosition = 7;
    const error = await expectRejects(
      runtime.__assertLiveRecordPositionStateSafe!(context),
    );
    expect((error as RuntimeError).code).to.equal('TARGET_CONFLICT');
  });

  it('rejects primary validator relaxation without the core double opt-in before schema writes', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': { required: {} } },
      primary: true,
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: {
            environmentId: 'destination-fork',
            inPlace: true,
            allowPrimary: false,
          },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal(
      'PRIMARY_SCHEMA_RELAXATION_FORBIDDEN',
    );
    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
  });

  it('does not trust a declared sandbox when the CMA client has no environment header', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': { required: {} } },
      omitConfiguredEnvironment: true,
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: {
            environmentId: 'destination-fork',
            inPlace: true,
            allowPrimary: true,
          },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('EXECUTION_CONTEXT_MISMATCH');
    expect(mock.schemaMutations.update).to.equal(0);
  });

  it('allows primary relaxation only with plan and core double opt-in', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': { required: {} } },
      primary: true,
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: {
        environmentId: 'destination-fork',
        inPlace: true,
        allowPrimary: true,
      },
      log: () => undefined,
    });

    expect(mock.current().title).to.equal('desired');
    expect(mock.schemaMutations.update).to.equal(2);
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
  });

  it('restores validators after a content failure and preserves the original error', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const originalError = new Error('content update failed');
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': { required: {} } },
      updateError: originalError,
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect(error).to.equal(originalError);
    expect(mock.schemaMutations.update).to.equal(2);
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
  });

  it('retains a non-null field default through validator relaxation', async () => {
    const plan = makeValidatorRelaxationRuntimePlan(
      'desired',
      'baseline',
      'planned default',
    );
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': { required: {} } },
      fieldDefaultValues: { 'title-field': 'planned default' },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.current().title).to.equal('desired');
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
  });

  it('recovers a partial validator prefix and converges in the same invocation', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': {} },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.current().title).to.equal('desired');
    expect(mock.schemaMutations.update).to.equal(3);
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
  });

  it('restores interrupted validator relaxations before external upload staging', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const bytes = Buffer.from('staged-before-schema');
    const uploadId = 'T8x4VhMPT_KxTHtz9r7mCA';
    plan.uploads.push({
      id: uploadId,
      action: 'create',
      expectedTargetHash: null,
      baseline: null,
      desired: {
        id: uploadId,
        md5: createHash('md5').update(bytes).digest('hex'),
        basename: 'asset',
        filename: 'asset.bin',
        size: bytes.length,
        mimeType: 'application/octet-stream',
        manual: {
          author: null,
          copyright: null,
          notes: null,
          defaultFieldMetadata: emptyUploadDefaultFieldMetadata(),
          tags: [],
          collectionId: null,
        },
        transport: {
          sourceUrl: 'https://assets.example/asset.bin',
          bundledPath: null,
          sha256: null,
        },
        hash: '',
        consistency: {
          updatedAt: '2025-01-01T00:00:00Z',
          antivirusStatus: 'clean',
        },
      },
      changes: { binary: true, metadata: true, collection: true },
    });
    refreshUploadSnapshotHash(plan.uploads.at(-1)!.desired!);
    plan.requiredPermissions.uploadActions = ['read', 'create'];

    const events: string[] = [];
    const runtime = await loadRuntime(
      '\nmodule.exports.__prepareManagedSchema = prepareManagedSchema;\n',
    );
    const mock = makeRuntimeClient('baseline', {
      events,
      fieldValidators: { 'title-field': {} },
    });
    const context: Record<string, any> = {
      client: mock.client,
      plan,
      options: {
        executionContext: { environmentId: 'destination-fork' },
        fetchFn: async () => {
          events.push('asset-fetch');
          const stream = Readable.from(
            (async function* () {
              yield bytes;
              events.push('asset-stream-finished');
            })(),
          );
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            body: Readable.toWeb(stream),
          };
        },
        log: () => undefined,
      },
      schemaById: new Map(
        plan.schema.itemTypes.map((itemType) => [itemType.id, itemType]),
      ),
      initialUploads: new Map(),
      stagedUploads: new Map(),
      stagedDirectory: null,
      executionEnvironmentId: null,
      executionEnvironment: null,
      targetItemTypes: [],
      validatorRelaxationStarted: false,
      relaxedFieldIds: new Set(),
      mutationCount: 0,
    };

    try {
      await runtime.__prepareManagedSchema!(context);
    } finally {
      if (context.stagedDirectory) {
        await rm(context.stagedDirectory, { recursive: true, force: true });
      }
    }

    expect(events).to.deep.equal(['schema-write']);
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
  });

  it('restores interrupted validators and rejects a recaptured skipped schedule before fetch or schedule/content mutation', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const upload = structuredClone(makeUploadCreateRuntimePlan().uploads[0]);
    plan.uploads = [upload];
    plan.execution.uploadOrder = [upload.id];
    plan.requiredPermissions.uploadActions = ['read', 'create'];

    const dependencySchedules: RuntimeScheduleState = {
      publication: {
        at: '2099-01-01T00:00:00.000Z',
        selective: null,
      },
      unpublishing: null,
    };
    const skippedInput = makeRecord(
      'scheduled dependency',
      `scheduled-version-${EXTERNAL_PARENT_ID}`,
    );
    skippedInput.id = EXTERNAL_PARENT_ID;
    const skippedSnapshot = canonicalizeRecord(
      skippedInput,
      null,
      plan.schema.itemTypes[0],
      plan.schema,
      dependencySchedules,
    );
    plan.invalidContent.detectedRecordIds.push(EXTERNAL_PARENT_ID);
    plan.invalidContent.skippedRecords.push({
      id: EXTERNAL_PARENT_ID,
      itemTypeId: MODEL_ID,
      disposition: 'preserve_target',
      sourceHash: skippedSnapshot.hash,
      expectedTargetHash: skippedSnapshot.hash,
      expectedTargetPosition: skippedSnapshot.topology.position,
      sourceValidity: skippedSnapshot.validity,
      targetValidity: skippedSnapshot.validity,
      sourceNestedBlockIds: [],
      preservedExternalBlockIds: [],
      targetNestedBlockIds: [],
      reasons: [
        {
          code: 'INVALID_CURRENT',
          slice: 'current',
          message: 'Preserved scheduled test aggregate',
          dependencyChain: [EXTERNAL_PARENT_ID],
        },
      ],
    });

    let fetches = 0;
    const runtime = await loadRuntime();
    const mock = makeScheduleQuiescenceRuntimeClient(
      { publication: null, unpublishing: null },
      'baseline',
      {
        dependencySchedules,
        fieldValidators: { 'title-field': {} },
      },
    );
    const error = await expectRejects(
      runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        fetchFn: async () => {
          fetches += 1;
          throw new Error('asset fetch must not start');
        },
        log: () => undefined,
      }),
    );

    expect((error as RuntimeError).code).to.equal(
      'SKIPPED_RECORD_SCHEDULE_CONFLICT',
    );
    expect(fetches).to.equal(0);
    expect(mock.schemaMutations.update).to.equal(1);
    expect(mock.fieldValidators('title-field')).to.deep.equal({ required: {} });
    expect(mock.events()).to.deep.equal(['schema-write']);
    expect(mock.title(RECORD_ID)).to.equal('baseline');
  });

  it('rejects a scheduled preserved aggregate before any mutating plan', async () => {
    const skippedId = 'E7qj8sB4Q3OgvOLiFjSAxQ';
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifySkippedScheduleSafety = verifySkippedScheduleSafety;\n',
    );
    const context = {
      plan: {
        records: [{ id: RECORD_ID, action: 'update' }],
        uploads: [],
        uploadCollections: [],
        requiredPermissions: { editSchema: false },
        legacyIdMappings: { newMappingBatch: null },
        invalidContent: {
          validatorRelaxations: [],
          skippedRecords: [
            {
              id: skippedId,
              itemTypeId: MODEL_ID,
              disposition: 'preserve_target',
            },
          ],
        },
      },
      initialSkippedRecords: new Map([
        [
          skippedId,
          {
            schedules: {
              publication: { at: '2035-01-01T00:00:00.000Z', selective: null },
              unpublishing: null,
            },
          },
        ],
      ]),
    };

    const error = await expectRejects(
      runtime.__verifySkippedScheduleSafety!(context, false),
    );
    expect((error as RuntimeError).code).to.equal(
      'SKIPPED_RECORD_SCHEDULE_CONFLICT',
    );
  });

  it('recaptures skipped schedules at the mutating boundary instead of trusting stale preflight state', async () => {
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifySkippedScheduleSafety = verifySkippedScheduleSafety;\n',
    );
    const schedules: RuntimeScheduleState = {
      publication: {
        at: '2099-01-01T00:00:00.000Z',
        selective: null,
      },
      unpublishing: null,
    };
    const mock = makeScheduleQuiescenceRuntimeClient(schedules);
    const schema = makeSchema('destination');
    const context = {
      client: mock.client,
      plan: {
        schema,
        records: [{ id: EXTERNAL_PARENT_ID, action: 'update' }],
        uploads: [],
        uploadCollections: [],
        requiredPermissions: { editSchema: false },
        legacyIdMappings: { newMappingBatch: null },
        invalidContent: {
          skippedRecords: [
            {
              id: RECORD_ID,
              itemTypeId: MODEL_ID,
              disposition: 'preserve_target',
            },
          ],
        },
      },
      captureSchema: schema,
      captureSchemaById: new Map(
        schema.itemTypes.map((itemType) => [itemType.id, itemType]),
      ),
      initialSkippedRecords: new Map([
        [RECORD_ID, { schedules: { publication: null, unpublishing: null } }],
      ]),
    };

    const error = await expectRejects(
      runtime.__verifySkippedScheduleSafety!(context, true),
    );
    expect((error as RuntimeError).code).to.equal(
      'SKIPPED_RECORD_SCHEDULE_CONFLICT',
    );
    expect(mock.events()).to.deep.equal([]);
  });

  it('preserves explicit external record and nested-block ID collisions', async () => {
    const skippedId = 'E7qj8sB4Q3OgvOLiFjSAxQ';
    const externalId = 'A5_V9jJ9R12IbtQvK1gxAw';
    const collidedBlockId = 'DFuP2y_8SU2Cct18hzpcIg';
    const existingIds = new Set([externalId, collidedBlockId]);
    const runtime = await loadRuntime(
      '\nmodule.exports.__verifySkippedRecords = verifySkippedRecords;\n',
    );
    const notFound = () => {
      const error = new Error('not found') as Error & {
        response: { status: number };
      };
      error.response = { status: 404 };
      return error;
    };
    const context = {
      client: {
        items: {
          find: async (id: string) => {
            if (!existingIds.has(id)) throw notFound();
            return { id, type: 'item' };
          },
        },
      },
      plan: {
        invalidContent: {
          skippedRecords: [
            {
              id: skippedId,
              itemTypeId: MODEL_ID,
              disposition: 'must_remain_absent',
              sourceNestedBlockIds: [collidedBlockId],
              targetNestedBlockIds: [],
              preservedExternalBlockIds: [collidedBlockId],
            },
            {
              id: externalId,
              itemTypeId: MODEL_ID,
              disposition: 'preserve_external',
              sourceNestedBlockIds: [],
              targetNestedBlockIds: [],
              preservedExternalBlockIds: [],
            },
          ],
        },
      },
      initialSkippedRecords: new Map(),
    };

    await runtime.__verifySkippedRecords!(context, false);
    await runtime.__verifySkippedRecords!(context, true);
    existingIds.delete(collidedBlockId);
    const error = await expectRejects(
      runtime.__verifySkippedRecords!(context, true),
    );
    expect((error as RuntimeError).code).to.equal('BLOCK_OWNERSHIP_CONFLICT');
  });

  it('does not touch validators when relaxed content is already converged', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('unchanged', 'unchanged');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('unchanged', {
      fieldValidators: { 'title-field': { required: {} } },
    });

    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });
    await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
      executionContext: { environmentId: 'destination-fork' },
      log: () => undefined,
    });

    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
  });

  it('rejects an unknown third-party validator state before any mutation', async () => {
    const plan = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
    const runtime = await loadRuntime();
    const mock = makeRuntimeClient('baseline', {
      fieldValidators: { 'title-field': { required: {}, length: { min: 3 } } },
    });

    const error = await withMutedConsoleError(() =>
      expectRejects(
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork' },
          log: () => undefined,
        }),
      ),
    );

    expect((error as RuntimeError).code).to.equal('SCHEMA_RELAXATION_CONFLICT');
    expect(mock.schemaMutations.update).to.equal(0);
    expect(mock.mutations.update).to.equal(0);
  });

  describe('phase 2 stages external inputs before quiescing schedules', () => {
    const farSchedules: RuntimeScheduleState = {
      publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
      unpublishing: null,
    };

    it('rejects a live schedule that entered the safety window while binaries were staged', async () => {
      await withShiftedClock(async (shift) => {
        const liveSchedules: RuntimeScheduleState = {
          publication: {
            at: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
            selective: null,
          },
          unpublishing: null,
        };
        const plan = withUploadCreate(
          makeRuntimePlan(
            'desired title',
            'baseline title',
            farSchedules,
            liveSchedules,
          ),
        );
        const events: string[] = [];
        const mock = makeRuntimeClient('baseline title', {
          events,
          schedules: liveSchedules,
        });
        const writes = injectRuntimeMutationFault(mock.client).writes;
        const runtime = await loadRuntime();
        const fetch = uploadCreateFetch(events);

        const { result: error, errors } = await withCapturedConsoleError(() =>
          expectRejects(
            runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
              executionContext: { environmentId: 'destination-fork' },
              log: () => undefined,
              fetchFn: async () => {
                shift(2 * 60 * 1000);
                return fetch();
              },
            }),
          ),
        );

        expect((error as RuntimeError).code).to.equal('SCHEDULE_TOO_CLOSE');
        expect(error.message).to.contain('may fire before phase 2');
        expect(error.message).to.contain(
          'entered the safety window while upload binaries were staged',
        );
        expect(
          (error as RuntimeError & { details: Record<string, unknown> }).details
            .recheckedAfterStaging,
        ).to.equal(true);
        expect(events).to.deep.equal(['upload-fetch']);
        expect(writes).to.deep.equal([]);
        expect(mock.schedules()).to.deep.equal(liveSchedules);
        expect(errors).to.include(
          '[content-diff] No destination changes were made.',
        );
      });
    });

    it('rejects a live schedule that fired while binaries were staged', async () => {
      await withShiftedClock(async (shift) => {
        const scheduledAt = Date.now() + 6 * 60 * 1000;
        const liveSchedules: RuntimeScheduleState = {
          publication: {
            at: new Date(scheduledAt).toISOString(),
            selective: null,
          },
          unpublishing: null,
        };
        const plan = withUploadCreate(
          makeRuntimePlan(
            'desired title',
            'baseline title',
            farSchedules,
            liveSchedules,
          ),
        );
        const mock = makeRuntimeClient('baseline title', {
          schedules: liveSchedules,
          allowPublication: true,
        });
        // The CMA fires the schedule itself, outside the migration's writes.
        const fireSchedule = mock.client.scheduledPublication.destroy as (
          id: string,
        ) => Promise<unknown>;
        const publish = mock.client.items.publish as (
          id: string,
        ) => Promise<unknown>;
        const writes = injectRuntimeMutationFault(mock.client).writes;
        const runtime = await loadRuntime();
        const fetch = uploadCreateFetch();

        const error = await withMutedConsoleError(() =>
          expectRejects(
            runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
              executionContext: { environmentId: 'destination-fork' },
              log: () => undefined,
              fetchFn: async () => {
                await fireSchedule(RECORD_ID);
                await publish(RECORD_ID);
                shift(7 * 60 * 1000);
                return fetch();
              },
            }),
          ),
        );

        expect(['SCHEDULE_TOO_CLOSE', 'TARGET_CONFLICT']).to.include(
          (error as RuntimeError).code,
        );
        expect(writes).to.deep.equal([]);
        expect(mock.current().title).to.equal('baseline title');
      });
    });

    it('rejects a schedule added to a preserved skipped record while binaries were staged', async () => {
      const plan = withUploadCreate(
        makeValidatorRelaxationRuntimePlan('desired', 'baseline'),
      );
      addPreservedSkippedRecord(plan, {
        publication: null,
        unpublishing: null,
      });
      const mock = makeScheduleQuiescenceRuntimeClient(
        { publication: null, unpublishing: null },
        'baseline',
        { fieldValidators: { 'title-field': { required: {} } } },
      );
      const runtime = await loadRuntime();
      const fetch = uploadCreateFetch();

      const error = await withMutedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            fetchFn: async () => {
              await mock.client.scheduledPublication.create(
                EXTERNAL_PARENT_ID,
                {
                  publication_scheduled_at: '2099-01-01T00:00:00.000Z',
                  selective_publication: null,
                } as never,
              );
              return fetch();
            },
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal(
        'SKIPPED_RECORD_SCHEDULE_CONFLICT',
      );
      expect(mock.events()).to.deep.equal([
        `publication-create:${EXTERNAL_PARENT_ID}`,
      ]);
      expect(mock.schemaMutations.update).to.equal(0);
      expect(mock.title(RECORD_ID)).to.equal('baseline');
    });

    it('proves every scheduled record before cancelling any schedule', async () => {
      const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
      withUploadCreate(plan);
      const lastRecordId = plan.records.at(-1)!.id;
      const mock = makeScheduleQuiescenceRuntimeClient(schedules);
      const runtime = await loadRuntime();
      const fetch = uploadCreateFetch();

      const error = await withMutedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            fetchFn: async () => {
              await mock.client.items.update(lastRecordId, {
                title: 'collaborator edit',
              });
              return fetch();
            },
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal('TARGET_CONFLICT');
      expect(mock.events()).to.deep.equal([`record-update:${lastRecordId}`]);
      for (const { id } of plan.records) {
        expect(mock.schedules(id)).to.deep.equal(schedules);
      }
    });

    it('orders staging, schedule cancellation, ledger reservations and content writes', async () => {
      const plan = withUploadCreate(
        withLegacyIdMapping(
          makeRuntimePlan('desired', 'baseline', farSchedules),
          {
            entityType: 'record',
            sourceId: '178178741',
            targetId: RECORD_ID,
            status: 'new',
          },
        ),
      );
      const runtime = await loadRuntime();
      const run = (bytes: Buffer) => {
        const events: string[] = [];
        const mock = makeRuntimeClient('baseline', {
          events,
          schedules: farSchedules,
        });
        const store = installUploadCreateStore(mock, { events });
        const result = runtime.runContentDiffMigration(
          mock.client,
          makeEnvelope(plan),
          {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            uploadFilenameCollisionWindowMs: 0,
            uploadProcessingPollIntervalMs: 0,
            fetchFn: async () => {
              events.push('upload-fetch');
              return {
                ok: true,
                body: Readable.toWeb(Readable.from(bytes)),
              };
            },
          },
        );
        return { events, mock, store, result };
      };

      const success = run(UPLOAD_CREATE_BYTES);
      await success.result;
      const order = [
        'upload-fetch',
        'publication-schedule-destroy',
        'mapping-model-create',
        'upload-create',
        'record-update',
        'publication-schedule-create',
      ].map((event) => success.events.indexOf(event));
      expect(order).not.to.include(-1);
      expect(order).to.deep.equal([...order].sort((a, b) => a - b));
      expect(success.store.upload()).not.to.equal(null);
      expect(success.mock.schedules()).to.deep.equal(farSchedules);

      const failure = run(Buffer.from('wrong bytes'));
      const error = await withMutedConsoleError(() =>
        expectRejects(failure.result),
      );
      expect((error as RuntimeError).code).to.equal('UPLOAD_CHECKSUM_FAILURE');
      expect(failure.events).to.deep.equal(['upload-fetch']);
      expect(failure.mock.mappingMutations).to.deep.equal({
        modelCreate: 0,
        fieldCreate: 0,
        recordCreate: 0,
      });
      expect(failure.mock.schedules()).to.deep.equal(farSchedules);
    });
  });

  describe('cooperative interruption through executionContext.abortSignal', () => {
    type RecordedWrite = { operation: string; args: unknown[] };

    // Aborts the runner's signal after each write of a baseline run in turn.
    // Every aborted run must stop with MIGRATION_INTERRUPTED (or complete when
    // the abort lands after the last checkpoint), issue only restoration writes
    // after the abort, leave no abort listener behind, and converge on rerun.
    async function sweepAbortBoundaries<
      Mock extends { client: CmaClient.Client },
    >(sweep: {
      makeMock: () => Mock;
      run: (mock: Mock, abortSignal?: AbortSignal) => Promise<unknown>;
      verify: (mock: Mock) => void | Promise<void>;
      verifyRestored: (mock: Mock) => void;
      isRestorationWrite: (write: RecordedWrite) => boolean;
      expectedOperations: string[];
    }): Promise<{ interrupted: number; restoring: number }> {
      const baseline = sweep.makeMock();
      const baselineWrites = injectRuntimeMutationFault(baseline.client).writes;
      await sweep.run(baseline);
      await sweep.verify(baseline);
      expect(
        baselineWrites.map(({ operation }) => operation),
      ).to.include.members(sweep.expectedOperations);

      let interrupted = 0;
      let restoring = 0;
      for (let index = 0; index < baselineWrites.length; index += 1) {
        const boundary = `abort after write ${index}: ${baselineWrites[index].operation}`;
        const mock = sweep.makeMock();
        const controller = new AbortController();
        const abort = injectRuntimeAbort(mock.client, controller, {
          index,
          timing: 'after',
        });
        let error: unknown = null;
        await withMutedConsoleError(async () => {
          try {
            await sweep.run(mock, controller.signal);
          } catch (caught) {
            error = caught;
          }
        });
        expect(abort.abortedAt(), boundary).to.equal(index);
        if (error) {
          expect(
            (error as RuntimeError).code,
            `${boundary}: ${String(error)}`,
          ).to.equal('MIGRATION_INTERRUPTED');
          interrupted += 1;
        }
        const afterAbort = abort.writes.slice(index + 1);
        expect(
          afterAbort
            .filter((write) => !sweep.isRestorationWrite(write))
            .map(({ operation }) => operation),
          boundary,
        ).to.deep.equal([]);
        if (afterAbort.length > 0) restoring += 1;
        sweep.verifyRestored(mock);
        expect(
          getEventListeners(controller.signal, 'abort'),
          boundary,
        ).to.have.length(0);

        try {
          await sweep.run(mock);
          await sweep.verify(mock);
          const writesAfterRecovery = abort.writes.length;
          await sweep.run(mock);
          expect(abort.writes.length, boundary).to.equal(writesAfterRecovery);
        } catch (recoveryError) {
          throw Object.assign(
            new Error(`Recovery failed ${boundary}: ${String(recoveryError)}`),
            { cause: recoveryError },
          );
        }
      }
      return { interrupted, restoring };
    }

    it('stops at every write boundary of a schema, default, upload and schedule migration and converges on rerun', async () => {
      const schedules: RuntimeScheduleState = {
        publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
        unpublishing: { at: '2099-01-02T00:00:00.000Z', locales: ['en'] },
      };
      const plan = withUploadCreate(
        makeCombinedSchemaRecoveryRuntimePlan({
          content: makeNestedBlock(),
          schedules,
        }),
      );
      const runtime = await loadRuntime();
      const originalValidators = stableStringify({
        validators: { required: {} },
      });
      const originalDefault = stableStringify({ default_value: 42.625 });
      const sweep = await sweepAbortBoundaries({
        makeMock: () => {
          const mock = makeRuntimeClient('absent', {
            recordAbsent: true,
            allowRecordCreate: true,
            fieldDefaultValues: { 'historical-number-field': 42.625 },
            fieldValidators: { 'title-field': { required: {} } },
            schedules: { publication: null, unpublishing: null },
          });
          return { ...mock, ...installUploadCreateStore(mock) };
        },
        run: (mock, abortSignal) =>
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: {
              environmentId: 'destination-fork',
              abortSignal,
            },
            log: () => undefined,
            uploadFilenameCollisionWindowMs: 0,
            uploadProcessingPollIntervalMs: 0,
            fetchFn: uploadCreateFetch(),
          }),
        verify: (mock) => {
          expect(mock.fieldDefaultValue('historical-number-field')).to.equal(
            42.625,
          );
          expect(mock.fieldValidators('title-field')).to.deep.equal({
            required: {},
          });
          expect(mock.schedules()).to.deep.equal(schedules);
          expect(mock.recordCreates()).to.equal(1);
          const snapshot = canonicalizeRecord(
            mock.current(),
            null,
            plan.schema.itemTypes[0],
            plan.schema,
            mock.schedules(),
          );
          expect(snapshot.hash).to.equal(plan.records[0].desired!.hash);
          expect(
            canonicalizeUpload(mock.upload()!, plan.schema.locales).hash,
          ).to.equal(plan.uploads[0].desired!.hash);
        },
        verifyRestored: (mock) => {
          expect(mock.fieldDefaultValue('historical-number-field')).to.equal(
            42.625,
          );
          expect(mock.fieldValidators('title-field')).to.deep.equal({
            required: {},
          });
        },
        isRestorationWrite: ({ operation, args }) =>
          operation === 'fields.update' &&
          [originalValidators, originalDefault].includes(
            stableStringify(args[1]),
          ),
        expectedOperations: [
          'fields.update',
          'uploads.createFromLocalFile',
          'items.create',
          'scheduledPublication.create',
          'scheduledUnpublishing.create',
        ],
      });
      expect(sweep.interrupted).to.be.greaterThan(0);
      // Aborts inside the relaxed/suppressed window restore the schema.
      expect(sweep.restoring).to.be.greaterThan(0);
    });

    it('stops at every write boundary of a schedule cancellation and restoration and converges on rerun', async () => {
      const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
      const runtime = await loadRuntime();
      const sweep = await sweepAbortBoundaries({
        makeMock: () => makeScheduleQuiescenceRuntimeClient(schedules),
        run: (mock, abortSignal) =>
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: {
              environmentId: 'destination-fork',
              abortSignal,
            },
            log: () => undefined,
          }),
        verify: (mock) => {
          expect(mock.title(RECORD_ID)).to.equal('desired title');
          expect(mock.title(EXTERNAL_PARENT_ID)).to.equal(
            'scheduled dependency',
          );
          expect(mock.schedules(RECORD_ID)).to.deep.equal(schedules);
          expect(mock.schedules(EXTERNAL_PARENT_ID)).to.deep.equal(schedules);
        },
        verifyRestored: () => undefined,
        isRestorationWrite: () => false,
        expectedOperations: [
          'scheduledPublication.destroy',
          'scheduledUnpublishing.destroy',
          'items.update',
          'scheduledPublication.create',
          'scheduledUnpublishing.create',
        ],
      });
      expect(sweep.interrupted).to.be.greaterThan(0);
      expect(sweep.restoring).to.equal(0);
    });

    it('reports cancelled schedules once phase 2 has started cancelling them', async () => {
      const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
      const runtime = await loadRuntime();
      const mock = makeScheduleQuiescenceRuntimeClient(schedules);
      const controller = new AbortController();
      const abort = injectRuntimeAbort(mock.client, controller, {
        index: 0,
        timing: 'after',
      });

      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: {
              environmentId: 'destination-fork',
              abortSignal: controller.signal,
            },
            log: () => undefined,
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      expect(abort.writes.map(({ operation }) => operation)).to.deep.equal([
        'scheduledPublication.destroy',
      ]);
      expect(errors).to.deep.equal([
        '[content-diff] Migration interrupted after completed phases: 1.',
        '[content-diff] Publication/unpublishing schedules on migrated records were cancelled (1 this run) and stay cancelled until this exact migration is rerun to completion.',
        '[content-diff] The destination may contain partially applied content. Do not promote it; rerun this exact migration to resume.',
      ]);
    });

    it('keeps MIGRATION_INTERRUPTED at CMA calls whose failures are wrapped in domain errors', async () => {
      const runtime = await loadRuntime();
      const interruptedAt = async (
        client: CmaClient.Client,
        plan: ContentDiffPlan,
        resource: string,
        method: string,
      ) => {
        const controller = new AbortController();
        abortOnCmaMethodAccess(client, resource, method, () =>
          controller.abort(),
        );
        const { result: error, errors } = await withCapturedConsoleError(() =>
          expectRejects(
            runtime.runContentDiffMigration(client, makeEnvelope(plan), {
              executionContext: {
                environmentId: 'destination-fork',
                abortSignal: controller.signal,
              },
              log: () => undefined,
            }),
          ),
        );
        expect((error as RuntimeError).code, String(error)).to.equal(
          'MIGRATION_INTERRUPTED',
        );
        expect(
          (error as RuntimeError & { details: Record<string, unknown> }).details
            .checkpoint,
        ).to.equal(`CMA request ${resource}.${method}`);
        expect(errors).to.include(
          '[content-diff] No destination changes were made.',
        );
        expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
      };

      // Credential inspection (PERMISSION_PROOF_UNAVAILABLE otherwise).
      const permissions = makeRuntimeClient('baseline');
      await interruptedAt(
        permissions.client,
        makeRuntimePlan('desired', 'baseline'),
        'users',
        'findMe',
      );

      // Deletion-release preflight (DELETE_RELEASE_VALIDATION_FAILURE).
      const release = makeRuntimeClient('obsolete', { published: true });
      await interruptedAt(
        release.client,
        makePublishedDeleteReleaseRuntimePlan(),
        'items',
        'validateExisting',
      );
      expect(release.reads.validateExisting).to.equal(0);
      expect(release.mutations).to.deep.equal({ update: 0 });

      // Fresh nested block preflight (FRESH_NESTED_BLOCK_VALIDATION_FAILURE).
      const fresh = makeGeneratedFreshIdRuntimeCase(
        ['single_block', 'inlineBlock'],
        'unused-update',
      );
      await interruptedAt(
        fresh.mock.client,
        fresh.plan,
        'items',
        'validateExisting',
      );
      expect(fresh.mock.validatedPayloads).to.have.length(0);
      expect(fresh.mock.writes()).to.equal(0);
    });

    it('keeps MIGRATION_INTERRUPTED at the relaxed create-seed preflight', async () => {
      const runtime = await loadRuntime(
        '\nmodule.exports.__createInterruptibleClient = createInterruptibleClient;\nmodule.exports.__verifyOneRelaxedCreateSeed = verifyOneRelaxedCreateSeed;\n',
      );
      // A two-record cycle: the first create seed cannot reference the second
      // record yet, so its relaxed seed differs from its desired version.
      const modelId = 'relaxed-seed-model';
      const fieldId = 'relaxed-seed-field';
      const [firstId, secondId] = ['relaxed-seed-first', 'relaxed-seed-second'];
      const itemType = {
        id: modelId,
        draftModeActive: true,
        draftSavingActive: false,
        fields: [
          {
            id: fieldId,
            apiKey: 'peers',
            fieldType: 'links',
            localized: false,
            validators: { items_item_type: { item_types: [modelId] } },
          },
        ],
      };
      const records = [
        [firstId, secondId],
        [secondId, firstId],
      ].map(([id, peer]) => {
        const fields = { peers: ['existing-anchor', peer] };
        const version = { fields, hash: semanticHash(fields) };
        return {
          id,
          itemTypeId: modelId,
          action: 'create',
          baseline: null,
          desired: { current: version, published: version },
        };
      });
      const controller = new AbortController();
      const validations: unknown[] = [];
      const client = {
        items: {
          validateNew: async (body: unknown) => {
            validations.push(body);
          },
        },
      } as unknown as CmaClient.Client;
      abortOnCmaMethodAccess(client, 'items', 'validateNew', () =>
        controller.abort(),
      );
      const context: Record<string, any> = {
        abortSignal: controller.signal,
        abortSuspensionDepth: 0,
        completedPhases: ['1'],
        mutationCount: 0,
        plan: {
          records,
          execution: {
            createOrder: [firstId, secondId],
            shellRecordIds: [],
            shellComponents: [],
          },
          invalidContent: {
            validatorRelaxations: [
              { fieldId, affectedRecordIds: [firstId, secondId] },
            ],
          },
        },
        schemaById: new Map([[modelId, itemType]]),
        captureSchemaById: new Map([[modelId, itemType]]),
        recordPlansById: new Map(records.map((record) => [record.id, record])),
        initialRecords: new Map(records.map((record) => [record.id, null])),
      };
      context.client = runtime.__createInterruptibleClient!(client, context);

      const error = await expectRejects(
        runtime.__verifyOneRelaxedCreateSeed!(context, records[0], false),
      );
      expect((error as RuntimeError).code, String(error)).to.equal(
        'MIGRATION_INTERRUPTED',
      );
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details
          .checkpoint,
      ).to.equal('CMA request items.validateNew');
      expect(validations).to.deep.equal([]);
    });

    it('does not report cancelled schedules when the abort lands before the first cancellation request', async () => {
      const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
      const runtime = await loadRuntime();
      const mock = makeScheduleQuiescenceRuntimeClient(schedules);
      const writes = injectRuntimeMutationFault(mock.client).writes;
      const controller = new AbortController();
      const uninstall = abortOnCmaMethodAccess(
        mock.client,
        'scheduledPublication',
        'destroy',
        () => controller.abort(),
      );

      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: {
              environmentId: 'destination-fork',
              abortSignal: controller.signal,
            },
            log: () => undefined,
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details
          .checkpoint,
      ).to.equal('CMA request scheduledPublication.destroy');
      expect(writes).to.deep.equal([]);
      expect(mock.schedules(RECORD_ID)).to.deep.equal(schedules);
      expect(mock.schedules(EXTERNAL_PARENT_ID)).to.deep.equal(schedules);
      expect(errors).to.deep.equal([
        '[content-diff] Migration interrupted after completed phases: 1.',
        '[content-diff] No destination changes were made.',
      ]);

      uninstall();
      await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      });
      expect(mock.title(RECORD_ID)).to.equal('desired title');
      expect(mock.schedules(RECORD_ID)).to.deep.equal(schedules);
    });

    it('reports schedules cancelled by an earlier run when a resumed run is interrupted while restoring them', async () => {
      const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
      const runtime = await loadRuntime();
      const mock = makeScheduleQuiescenceRuntimeClient(schedules);
      const runInterruptedAtRestoration = async () => {
        const controller = new AbortController();
        const uninstall = abortOnCmaMethodAccess(
          mock.client,
          'scheduledPublication',
          'create',
          () => controller.abort(),
        );
        try {
          return await withCapturedConsoleError(() =>
            expectRejects(
              runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
                executionContext: {
                  environmentId: 'destination-fork',
                  abortSignal: controller.signal,
                },
                log: () => undefined,
              }),
            ),
          );
        } finally {
          uninstall();
        }
      };
      const cancelledLine = (count: number) =>
        `[content-diff] Publication/unpublishing schedules on migrated records were cancelled (${count} this run) and stay cancelled until this exact migration is rerun to completion.`;
      const quiesced = { publication: null, unpublishing: null };

      const first = await runInterruptedAtRestoration();
      expect((first.result as RuntimeError).code).to.equal(
        'MIGRATION_INTERRUPTED',
      );
      expect(
        (first.result as RuntimeError & { details: Record<string, unknown> })
          .details.checkpoint,
      ).to.equal('CMA request scheduledPublication.create');
      expect(first.errors).to.include(cancelledLine(4));
      expect(mock.schedules(RECORD_ID)).to.deep.equal(quiesced);

      // The resumed run cancels nothing itself, yet the schedules it has not
      // restored yet stay cancelled.
      const writes = injectRuntimeMutationFault(mock.client).writes;
      const resumed = await runInterruptedAtRestoration();
      expect((resumed.result as RuntimeError).code).to.equal(
        'MIGRATION_INTERRUPTED',
      );
      expect(
        writes.filter(({ operation }) => operation.endsWith('.destroy')),
      ).to.deep.equal([]);
      expect(resumed.errors).to.include(cancelledLine(0));
      expect(mock.schedules(RECORD_ID)).to.deep.equal(quiesced);

      await runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
        executionContext: { environmentId: 'destination-fork' },
        log: () => undefined,
      });
      expect(mock.schedules(RECORD_ID)).to.deep.equal(schedules);
      expect(mock.schedules(EXTERNAL_PARENT_ID)).to.deep.equal(schedules);
    });

    it('restores suppressed defaults in the phase-5 finally although the signal is aborted', async () => {
      const plan = makeHistoricalNullCreateRuntimePlan();
      const runtime = await loadRuntime();
      const mock = makeRuntimeClient('absent', {
        recordAbsent: true,
        allowRecordCreate: true,
        fieldDefaultValues: { 'historical-number-field': 42.625 },
      });
      const controller = new AbortController();
      const abort = injectRuntimeAbort(mock.client, controller, {
        index: 0,
        timing: 'after',
      });

      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: {
              environmentId: 'destination-fork',
              abortSignal: controller.signal,
            },
            log: () => undefined,
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      expect(controller.signal.aborted).to.equal(true);
      expect(
        abort.writes.map(({ operation, args }) => [operation, args[1]]),
      ).to.deep.equal([
        ['fields.update', { default_value: null }],
        ['fields.update', { default_value: 42.625 }],
      ]);
      expect(mock.fieldDefaultValue('historical-number-field')).to.equal(
        42.625,
      );
      expect(mock.recordCreates()).to.equal(0);
      expect(errors).to.include(
        '[content-diff] Temporary field validator/default changes were restored.',
      );
      expect(errors).not.to.include(
        '[content-diff] No destination changes were made.',
      );
    });

    it('cancels a stalled source download promptly and removes the staged directory', async () => {
      const schedules: RuntimeScheduleState = {
        publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
        unpublishing: null,
      };
      const plan = withUploadCreate(
        makeRuntimePlan('desired title', 'baseline title', schedules),
      );
      const mock = makeRuntimeClient('baseline title', { schedules });
      const writes = injectRuntimeMutationFault(mock.client).writes;
      const runtime = await loadRuntime();
      const controller = new AbortController();
      let cancelled = false;

      await withIsolatedTemporaryDirectory(async (directory) => {
        const started = Date.now();
        const { result: error, errors } = await withCapturedConsoleError(() =>
          expectRejects(
            runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
              executionContext: {
                environmentId: 'destination-fork',
                abortSignal: controller.signal,
              },
              log: () => undefined,
              fetchFn: async () => {
                setTimeout(() => controller.abort(), 10);
                return new Response(
                  new ReadableStream({
                    start(body) {
                      body.enqueue(Buffer.from('a'));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                );
              },
            }),
          ),
        );

        expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
        expect(
          (error as RuntimeError & { details: Record<string, unknown> }).details
            .checkpoint,
        ).to.equal('upload staging');
        expect(Date.now() - started).to.be.lessThan(5_000);
        expect(cancelled).to.equal(true);
        expect(writes).to.deep.equal([]);
        expect(mock.schedules()).to.deep.equal(schedules);
        expect(await readdir(directory)).to.deep.equal([]);
        expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
        expect(errors).to.deep.equal([
          '[content-diff] Migration interrupted after completed phases: 1.',
          '[content-diff] No destination changes were made.',
        ]);
      });
    });

    it('ends an upload processing wait promptly instead of at its timeout', async () => {
      const plan = makeUploadCreateRuntimePlan();
      const runtime = await loadRuntime();
      const mock = makeRuntimeClient('absent', { recordAbsent: true });
      installUploadCreateStore(mock, { antivirusStatus: 'pending' });
      const controller = new AbortController();
      const createFromLocalFile = mock.client.uploads.createFromLocalFile;
      mock.client.uploads.createFromLocalFile = (async (body: never) => {
        const created = await createFromLocalFile.call(
          mock.client.uploads,
          body,
        );
        setTimeout(() => controller.abort(), 20);
        return created;
      }) as typeof createFromLocalFile;

      const started = Date.now();
      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: {
              environmentId: 'destination-fork',
              abortSignal: controller.signal,
            },
            log: () => undefined,
            uploadFilenameCollisionWindowMs: 0,
            uploadProcessingPollIntervalMs: 60_000,
            uploadProcessingTimeoutMs: 600_000,
            fetchFn: uploadCreateFetch(),
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details
          .checkpoint,
      ).to.equal('waiting for CMA processing');
      expect(Date.now() - started).to.be.lessThan(5_000);
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
      expect(errors).to.include(
        '[content-diff] The destination may contain partially applied content. Do not promote it; rerun this exact migration to resume.',
      );
    });

    it('ends phase-12 validity polling promptly and reports that schedules stay cancelled', async () => {
      const schedules: RuntimeScheduleState = {
        publication: { at: '2099-01-01T00:00:00.000Z', selective: null },
        unpublishing: null,
      };
      const plan = makeValidatorRelaxationRuntimePlan(
        'desired title',
        'baseline title',
        undefined,
        schedules,
      );
      const runtime = await loadRuntime();
      const mock = makeRuntimeClient('baseline title', {
        schedules,
        fieldValidators: { 'title-field': { required: {} } },
      });
      const controller = new AbortController();
      let reportStaleValidity = false;
      const find = mock.client.items.find;
      mock.client.items.find = (async (
        id: string,
        options?: Record<string, unknown>,
      ) => {
        const record = (await find.call(
          mock.client.items,
          id,
          options as never,
        )) as Record<string, any>;
        if (!reportStaleValidity || options?.nested !== false) return record;
        if (!controller.signal.aborted) {
          setTimeout(() => controller.abort(), 10);
        }
        return {
          ...record,
          meta: {
            ...record.meta,
            is_valid: false,
            is_current_version_valid: false,
          },
        };
      }) as typeof find;
      const run = (abortSignal?: AbortSignal) =>
        runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
          executionContext: { environmentId: 'destination-fork', abortSignal },
          log: (message: string) => {
            if (abortSignal && message.includes('[12/12]')) {
              reportStaleValidity = true;
            }
          },
          validityProcessingPollIntervalMs: 60_000,
          validityProcessingTimeoutMs: 600_000,
        });

      const started = Date.now();
      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(run(controller.signal)),
      );

      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details
          .checkpoint,
      ).to.equal('waiting for CMA processing');
      expect(Date.now() - started).to.be.lessThan(5_000);
      expect(getEventListeners(controller.signal, 'abort')).to.have.length(0);
      expect(mock.schedules().publication).to.equal(null);
      expect(mock.fieldValidators('title-field')).to.deep.equal({
        required: {},
      });
      expect(errors).to.include(
        '[content-diff] Migration interrupted after completed phases: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11.',
      );
      expect(errors).to.include(
        '[content-diff] Temporary field validator/default changes were restored.',
      );
      expect(errors).to.include(
        '[content-diff] Publication/unpublishing schedules on migrated records were cancelled (1 this run) and stay cancelled until this exact migration is rerun to completion.',
      );

      reportStaleValidity = false;
      await run();
      expect(mock.schedules()).to.deep.equal(schedules);
      expect(mock.current().title).to.equal('desired title');
    });

    it('never touches the client when the signal is already aborted', async () => {
      const runtime = await loadRuntime();
      const controller = new AbortController();
      controller.abort();
      let clientReads = 0;
      const client = new Proxy(
        {},
        {
          get() {
            clientReads += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;

      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(
            client,
            makeEnvelope(makeRuntimePlan('desired', 'baseline')),
            {
              executionContext: {
                environmentId: 'destination-fork',
                abortSignal: controller.signal,
              },
              log: () => undefined,
            },
          ),
        ),
      );

      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details,
      ).to.deep.equal({
        checkpoint: 'preflight',
        completedPhases: [],
        mutationCount: 0,
      });
      expect(clientReads).to.equal(0);
      expect(errors).to.deep.equal([
        '[content-diff] Migration interrupted after completed phases: none.',
        '[content-diff] No destination changes were made.',
      ]);
    });

    it('rejects an abortSignal that is not an AbortSignal before touching the client', async () => {
      const runtime = await loadRuntime();
      for (const abortSignal of [
        {},
        null,
        'aborted',
        { aborted: 'no', addEventListener() {}, removeEventListener() {} },
        { aborted: false, addEventListener() {} },
      ]) {
        let clientReads = 0;
        const client = new Proxy(
          {},
          {
            get() {
              clientReads += 1;
              throw new Error('CMA client was accessed');
            },
          },
        ) as CmaClient.Client;
        const error = await expectRejects(
          runtime.runContentDiffMigration(
            client,
            makeEnvelope(makeRuntimePlan('desired', 'baseline')),
            {
              executionContext: { abortSignal },
              log: () => undefined,
            },
          ),
        );
        expect((error as RuntimeError).code).to.equal(
          'INVALID_EXECUTION_CONTEXT',
        );
        expect(error.message).to.contain('must be an AbortSignal');
        expect(clientReads).to.equal(0);
      }
    });

    it('stops copying a bundled binary when the signal aborts', async () => {
      const runtime = await loadRuntime(
        '\nmodule.exports.__streamAndHash = streamAndHash;\nmodule.exports.__copyAndHash = copyAndHash;\n',
      );
      const directory = await mkdtemp(join(tmpdir(), 'datocms-bundled-copy-'));
      temporaryDirectories.push(directory);
      const controller = new AbortController();
      let destroyed = false;
      const stalled = new Readable({
        read() {},
        destroy(error, callback) {
          destroyed = true;
          callback(error);
        },
      });
      const copy = runtime.__streamAndHash!(
        stalled,
        join(directory, 'stalled.bin'),
        controller.signal,
      ).catch((error) => error);
      setTimeout(() => controller.abort(), 10);
      expect((await copy).name).to.equal('AbortError');
      expect(destroyed).to.equal(true);

      const source = join(directory, 'source.bin');
      await writeFile(source, 'abc');
      const context: Record<string, unknown> = {
        abortSignal: controller.signal,
        abortSuspensionDepth: 0,
        completedPhases: ['1'],
        mutationCount: 0,
      };
      const error = await expectRejects(
        runtime.__copyAndHash!(context, source, join(directory, 'copy.bin')),
      );
      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      expect(context.interrupted).to.equal(true);
      expect(
        await runtime.__copyAndHash!(
          { abortSignal: null },
          source,
          join(directory, 'unsignalled.bin'),
        ),
      ).to.deep.equal({
        md5: createHash('md5').update('abc').digest('hex'),
        sha256: createHash('sha256').update('abc').digest('hex'),
        size: 3,
      });
    });

    it('checks the signal before every CMA call without changing client behaviour', async () => {
      const runtime = await loadRuntime(
        '\nmodule.exports.__createInterruptibleClient = createInterruptibleClient;\nmodule.exports.__withAbortSuspended = withAbortSuspended;\n',
      );
      const createClient = runtime.__createInterruptibleClient!;
      const withAbortSuspended = runtime.__withAbortSuspended!;
      const calls: string[] = [];
      const client = {
        config: { environment: 'destination-fork' },
        items: {
          prefix: 'item',
          async find(this: { prefix: string }, id: string) {
            calls.push(`find:${id}`);
            return `${this.prefix}:${id}`;
          },
          async *listPagedIterator() {
            try {
              calls.push('page');
              yield 'first';
              calls.push('page');
              yield 'second';
            } finally {
              calls.push('closed');
            }
          },
        },
        async request() {
          calls.push('request');
          return 'raw';
        },
      };
      // Without a signal the client is still wrapped, only to count writes.
      const unsignalled = createClient(client, { abortSignal: null });
      expect(unsignalled.config).to.deep.equal(client.config);
      expect(await unsignalled.items.find('z')).to.equal('item:z');
      expect(calls.splice(0)).to.deep.equal(['find:z']);

      const controller = new AbortController();
      const context: Record<string, unknown> = {
        abortSignal: controller.signal,
        abortSuspensionDepth: 0,
        completedPhases: ['1'],
        mutationCount: 2,
      };
      const wrapped = createClient(client, context);
      expect(wrapped.config.environment).to.equal('destination-fork');
      expect(wrapped.items).to.equal(wrapped.items);
      expect(wrapped.items.prefix).to.equal('item');
      expect(typeof wrapped.items.update).to.equal('undefined');
      expect(await wrapped.items.find('a')).to.equal('item:a');
      expect(await wrapped.request()).to.equal('raw');

      const pages: string[] = [];
      let iterationError: unknown = null;
      try {
        for await (const page of wrapped.items.listPagedIterator()) {
          pages.push(page);
          controller.abort();
        }
      } catch (error) {
        iterationError = error;
      }
      expect(pages).to.deep.equal(['first']);
      expect((iterationError as RuntimeError).code).to.equal(
        'MIGRATION_INTERRUPTED',
      );

      // An interrupted call returns a rejected promise instead of throwing,
      // so requests already created in the same expression stay handled.
      const interruptedFind = wrapped.items.find('b');
      expect(interruptedFind).to.be.an.instanceOf(Promise);
      const error = await expectRejects(interruptedFind);
      expect((error as RuntimeError).code).to.equal('MIGRATION_INTERRUPTED');
      const interruptedPages = wrapped.items.listPagedIterator();
      const pageError = await expectRejects(
        interruptedPages[Symbol.asyncIterator]().next(),
      );
      expect((pageError as RuntimeError).code).to.equal(
        'MIGRATION_INTERRUPTED',
      );
      expect(error.message).to.contain('before CMA request items.find');
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details,
      ).to.deep.equal({
        checkpoint: 'CMA request items.find',
        completedPhases: ['1'],
        mutationCount: 2,
      });
      expect(context.interrupted).to.equal(true);
      expect(
        await withAbortSuspended(context, () => wrapped.items.find('c')),
      ).to.equal('item:c');
      expect(context.abortSuspensionDepth).to.equal(0);
      // The interrupted iterator was closed although for await does not
      // call return() after a rejected next().
      expect(calls).to.deep.equal([
        'find:a',
        'request',
        'page',
        'closed',
        'find:c',
      ]);
    });

    for (const [label, fieldUpdatesBeforeAbort] of [
      ['validator relaxation', 1],
      ['default-value suppression', 2],
    ] as const) {
      it(`restores the schema without an unhandled rejection when the signal aborts during the ${label} schema re-read`, async () => {
        const plan = makeCombinedSchemaRecoveryRuntimePlan();
        const runtime = await loadRuntime();
        const mock = makeRuntimeClient('absent', {
          recordAbsent: true,
          allowRecordCreate: true,
          // Also read by fetchTargetSchemaState, next to the managed fields.
          migrationsTrackingModel: 'exact',
          fieldDefaultValues: { 'historical-number-field': 42.625 },
          fieldValidators: { 'title-field': { required: {} } },
        });
        const client = mock.client as unknown as Record<
          string,
          Record<string, (...args: any[]) => Promise<any>>
        >;
        const controller = new AbortController();
        const updateField = client.fields.update;
        let fieldUpdates = 0;
        client.fields.update = async (...args) => {
          fieldUpdates += 1;
          return updateField.apply(client.fields, args);
        };
        const findSite = client.site.find;
        client.site.find = async (...args) => {
          const site = await findSite.apply(client.site, args);
          if (
            fieldUpdates === fieldUpdatesBeforeAbort &&
            !controller.signal.aborted
          ) {
            // The abort lands while this request, and the two requests
            // started beside it, are in flight.
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.abort();
          }
          return site;
        };

        const {
          result: { result: error, errors },
          unhandled,
        } = await withRecordedUnhandledRejections(() =>
          withCapturedConsoleError(() =>
            expectRejects(
              runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
                executionContext: {
                  environmentId: 'destination-fork',
                  abortSignal: controller.signal,
                },
                log: () => undefined,
              }),
            ),
          ),
        );

        expect(unhandled).to.deep.equal([]);
        expect((error as RuntimeError).code, String(error)).to.equal(
          'MIGRATION_INTERRUPTED',
        );
        expect(
          (error as RuntimeError & { details: Record<string, unknown> }).details
            .checkpoint,
        ).to.equal('CMA request fields.list');
        expect(mock.fieldValidators('title-field')).to.deep.equal({
          required: {},
        });
        expect(mock.fieldDefaultValue('historical-number-field')).to.equal(
          42.625,
        );
        expect(mock.recordCreates()).to.equal(0);
        expect(errors).to.include(
          '[content-diff] Temporary field validator/default changes were restored.',
        );
      });
    }

    it('keeps a plain node process alive to restore the schema when the abort lands during the schema re-read', async () => {
      // Mocha handles unhandled rejections itself, so this runs the rendered
      // runtime in a child process with node's default of exiting on one.
      const directory = await mkdtemp(
        join(tmpdir(), 'datocms-runtime-interrupt-'),
      );
      temporaryDirectories.push(directory);
      const probeExports = [
        'fetchTargetSchemaState',
        'createInterruptibleClient',
        'withAbortSuspended',
        'environmentSemanticsFromSite',
        'SCHEMA_STATE_ENVIRONMENT_FLAGS',
      ].join(', ');
      await writeFile(
        join(directory, 'runtime.cjs'),
        `${renderRuntime(
          'js',
        )}\nmodule.exports.__probe = { ${probeExports} };\n`,
      );
      await writeFile(
        join(directory, 'probe.cjs'),
        [
          "'use strict';",
          "const runtime = require('./runtime.cjs').__probe;",
          'const meta = {};',
          'for (const [, key] of runtime.SCHEMA_STATE_ENVIRONMENT_FLAGS) meta[key] = false;',
          "const site = { id: 'site-1', timezone: 'UTC', meta };",
          'const controller = new AbortController();',
          'const rawClient = {',
          '  site: { find: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); controller.abort(); return site; } },',
          "  itemTypes: { list: async () => [{ id: 'model-1', api_key: 'article' }, { id: 'model-2', api_key: 'schema_migration' }] },",
          '  workflows: { list: async () => [] },',
          '  fields: { list: async () => [] },',
          '};',
          'const plan = {',
          "  target: { siteId: 'site-1' },",
          "  schema: { environmentSemantics: runtime.environmentSemanticsFromSite(site), itemTypes: [{ id: 'model-1' }], workflows: [] },",
          '  targetInspection: { itemTypes: [] },',
          "  options: { migrationsModelApiKey: 'schema_migration' },",
          '};',
          'const context = { plan, abortSignal: controller.signal, abortSuspensionDepth: 0, completedPhases: [], mutationCount: 0 };',
          'context.client = runtime.createInterruptibleClient(rawClient, context);',
          '(async () => {',
          '  try {',
          '    await runtime.fetchTargetSchemaState(context);',
          "    console.log('not interrupted');",
          '  } catch (error) {',
          "    console.log('interrupted ' + error.details.checkpoint);",
          '  }',
          '  await runtime.withAbortSuspended(context, async () => {',
          '    for (let step = 0; step < 3; step += 1) await new Promise((resolve) => setTimeout(resolve, 10));',
          '  });',
          "  console.log('restored');",
          '})();',
          '',
        ].join('\n'),
      );

      const child = spawnSync(
        process.execPath,
        ['--unhandled-rejections=throw', join(directory, 'probe.cjs')],
        { encoding: 'utf8', timeout: 60_000 },
      );

      expect(
        { status: child.status, stdout: child.stdout },
        child.stderr,
      ).to.deep.equal({
        status: 0,
        stdout: 'interrupted CMA request fields.list\nrestored\n',
      });
    });

    it('does not claim an unchanged destination after a write whose response was lost', async () => {
      const bytes = Buffer.from('abc');
      const runtime = await loadRuntime();
      const sourceSchema = makeSchema('source');
      const targetSchema = makeSchema('destination');
      const source = makeEmptySnapshot(sourceSchema);
      const target = makeEmptySnapshot(targetSchema);
      const desiredResource = {
        id: 'QtiP3aRYQhK9jRVGDL6kPg',
        md5: createHash('md5').update(bytes).digest('hex'),
        basename: 'asset',
        filename: 'asset.txt',
        size: bytes.length,
        mime_type: 'text/plain',
        url: 'https://example.test/asset.txt',
        author: null,
        copyright: null,
        notes: 'desired metadata',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      };
      source.uploads[desiredResource.id] = canonicalizeUpload(
        desiredResource,
        sourceSchema.locales,
      );
      const plan = buildContentDiffPlan(source, target, {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: false,
      });
      const mock = makeRuntimeClient('absent', { recordAbsent: true });
      let live: Record<string, any> | null = null;
      mock.client.uploads = {
        find: async () => {
          if (!live) throw { response: { status: 404 } };
          return structuredClone(live);
        },
        // The server creates the upload, but its response never arrives.
        createFromLocalFile: async (body: Record<string, any>) => {
          live = { ...structuredClone(body), ...desiredResource };
          throw Object.assign(new Error('socket hang up'), {
            code: 'ECONNRESET',
          });
        },
      } as unknown as CmaClient.Client['uploads'];

      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            uploadFilenameCollisionWindowMs: 0,
            uploadProcessingPollIntervalMs: 0,
            fetchFn: async () => ({
              ok: true,
              body: Readable.toWeb(Readable.from(bytes)),
            }),
          }),
        ),
      );

      expect(live).not.to.equal(null);
      expect(error.message).to.contain('socket hang up');
      expect(errors).to.deep.equal([
        '[content-diff] Migration stopped after completed phases: 1, 2, 3.',
        '[content-diff] The runtime is idempotent: resolve the reported conflict, then rerun the migration.',
        '[content-diff] A destination write request failed without confirming whether it was applied, so the destination may have changed; rerun this exact migration to reconcile it.',
      ]);
    });

    it('reports cancelled schedules after a failed cancellation that may have been applied', async () => {
      const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
      const runtime = await loadRuntime();
      const mock = makeScheduleQuiescenceRuntimeClient(schedules);
      const resource = mock.client.scheduledPublication as unknown as Record<
        string,
        (...args: any[]) => Promise<any>
      >;
      const destroy = resource.destroy;
      resource.destroy = async (...args) => {
        await destroy.apply(resource, args);
        throw Object.assign(new Error('Internal Server Error'), {
          response: { status: 500 },
        });
      };

      const { result: error, errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
          }),
        ),
      );

      expect(error.message).to.equal('Internal Server Error');
      expect(
        [RECORD_ID, EXTERNAL_PARENT_ID].filter(
          (id) => mock.schedules(id).publication === null,
        ),
      ).to.have.length(1);
      expect(errors).to.deep.equal([
        '[content-diff] Migration stopped after completed phases: 1.',
        '[content-diff] The runtime is idempotent: resolve the reported conflict, then rerun the migration.',
        '[content-diff] A destination write request failed without confirming whether it was applied, so the destination may have changed; rerun this exact migration to reconcile it.',
        '[content-diff] Publication/unpublishing schedules on migrated records were cancelled (0 this run) and stay cancelled until this exact migration is rerun to completion.',
      ]);
    });

    it('still reports an unchanged destination when the API refuses the first write', async () => {
      const { plan, schedules } = makeScheduleQuiescenceRuntimePlan();
      const runtime = await loadRuntime();
      const mock = makeScheduleQuiescenceRuntimeClient(schedules);
      const resource = mock.client.scheduledPublication as unknown as Record<
        string,
        (...args: any[]) => Promise<any>
      >;
      resource.destroy = async () => {
        throw Object.assign(new Error('Unprocessable Entity'), {
          response: { status: 422 },
        });
      };

      const { errors } = await withCapturedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
          }),
        ),
      );

      expect(mock.schedules(RECORD_ID)).to.deep.equal(schedules);
      expect(mock.schedules(EXTERNAL_PARENT_ID)).to.deep.equal(schedules);
      expect(errors).to.deep.equal([
        '[content-diff] Migration stopped after completed phases: 1.',
        '[content-diff] The runtime is idempotent: resolve the reported conflict, then rerun the migration.',
        '[content-diff] No destination changes were made.',
      ]);
    });
  });

  describe('tuning from DATOCMS_CONTENT_DIFF_*_MS variables', () => {
    const untouchableClient = () => {
      const access = { count: 0 };
      const client = new Proxy(
        {},
        {
          get() {
            access.count += 1;
            throw new Error('CMA client was accessed');
          },
        },
      ) as CmaClient.Client;
      return { client, access };
    };
    const schedulesAt = (at: number): RuntimeScheduleState => ({
      publication: { at: new Date(at).toISOString(), selective: null },
      unpublishing: null,
    });

    it('rejects each invalid variable with INVALID_TUNING before any CMA access', async () => {
      const runtime = await loadRuntime();
      const envelope = makeEnvelope(makeRuntimePlan('desired', 'baseline'));
      const cases: Array<[string, string, number]> = [
        ['DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS', '999', 1_000],
        ['DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS', '86400001', 1_000],
        ['DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS', '10m', 1_000],
        ['DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS', '', 1_000],
        // Below its default: the schedule safety window can only be raised.
        ['DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS', '299999', 300_000],
      ];

      for (const [variable, value, minimumMs] of cases) {
        const { client, access } = untouchableClient();
        const error = await expectRejects(
          runtime.runContentDiffMigration(client, envelope, {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            tuningEnv: { [variable]: value },
          }),
        );

        expect((error as RuntimeError).code, variable).to.equal(
          'INVALID_TUNING',
        );
        expect(error.name).to.equal('ContentDiffRuntimeError');
        expect(error.message).to.contain(
          `Invalid ${variable} value ${JSON.stringify(value)}`,
        );
        expect(
          (error as RuntimeError & { details: unknown }).details,
        ).to.deep.include({
          variable,
          value,
          minimumMs,
          maximumMs: 86_400_000,
        });
        expect(access.count).to.equal(0);
      }
    });

    it('reads process.env when no tuning environment is passed', async () => {
      const runtime = await loadRuntime();
      const variable = 'DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS';
      const previous = process.env[variable];
      const { client, access } = untouchableClient();
      process.env[variable] = 'soon';
      try {
        const error = await expectRejects(
          runtime.runContentDiffMigration(
            client,
            makeEnvelope(makeRuntimePlan('desired', 'baseline')),
            {
              executionContext: { environmentId: 'destination-fork' },
              log: () => undefined,
            },
          ),
        );
        expect((error as RuntimeError).code).to.equal('INVALID_TUNING');
        expect(error.message).to.contain(variable);
        expect(access.count).to.equal(0);
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    });

    it('widens the schedule safety window from the environment, below explicit options', async () => {
      const runtime = await loadRuntime();
      const run = (
        schedules: RuntimeScheduleState,
        extra: Record<string, unknown>,
      ) => {
        const plan = makeRuntimePlan('desired', 'baseline', schedules);
        const mock = makeRuntimeClient('baseline', { schedules });
        const result = runtime.runContentDiffMigration(
          mock.client,
          makeEnvelope(plan),
          {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            ...extra,
          },
        );
        return { mock, result };
      };
      const widened = {
        DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS: '600000',
      };

      const rejected = run(schedulesAt(Date.now() + 7 * 60 * 1000), {
        tuningEnv: widened,
      });
      const error = await withMutedConsoleError(() =>
        expectRejects(rejected.result),
      );
      expect((error as RuntimeError).code).to.equal('SCHEDULE_TOO_CLOSE');
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details
          .minimumLeadMilliseconds,
      ).to.equal(600_000);
      expect(rejected.mock.mutations.update).to.equal(0);

      const accepted = run(schedulesAt(Date.now() + 7 * 60 * 1000), {
        tuningEnv: {},
      });
      await accepted.result;
      expect(accepted.mock.current().title).to.equal('desired');

      const overridden = run(schedulesAt(Date.now() + 7 * 60 * 1000), {
        tuningEnv: widened,
        scheduleSafetyWindowMs: 5 * 60 * 1000,
      });
      await overridden.result;
      expect(overridden.mock.current().title).to.equal('desired');
    });

    it('bounds upload processing by DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS and names it in the error', async () => {
      const runtime = await loadRuntime();
      const bytes = Buffer.from('abc');
      const plan = makeUploadCreateRuntimePlan();
      const uploadId = plan.uploads[0].id;
      const mock = makeRuntimeClient('absent', { recordAbsent: true });
      let live: Record<string, any> | null = null;
      mock.client.uploads = {
        find: async () => {
          if (!live) throw { response: { status: 404 } };
          return structuredClone(live);
        },
        createFromLocalFile: async (body: Record<string, any>) => {
          live = {
            ...structuredClone(body),
            id: uploadId,
            md5: createHash('md5').update(bytes).digest('hex'),
            basename: 'asset',
            size: bytes.length,
            mime_type: 'text/plain',
            url: 'https://example.test/asset.txt',
            meta: { antivirus: { status: 'pending' } },
          };
          return structuredClone(live);
        },
      } as unknown as CmaClient.Client['uploads'];

      const error = await withMutedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            uploadFilenameCollisionWindowMs: 0,
            uploadProcessingPollIntervalMs: 50,
            tuningEnv: {
              DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS: '1000',
            },
            fetchFn: async () => ({
              ok: true,
              body: Readable.toWeb(Readable.from(bytes)),
            }),
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal(
        'UPLOAD_PROCESSING_TIMEOUT',
      );
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details
          .timeoutMilliseconds,
      ).to.equal(1_000);
      expect(error.message).to.contain(
        'Set DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS to wait longer.',
      );
    });

    it('bounds a stalled download by DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS unless an explicit option wins', async () => {
      const runtime = await loadRuntime();
      const stalledRun = (extra: Record<string, unknown>) => {
        const plan = makeUploadCreateRuntimePlan();
        const mock = makeRuntimeClient('absent', { recordAbsent: true });
        return withMutedConsoleError(() =>
          expectRejects(
            runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
              executionContext: { environmentId: 'destination-fork' },
              log: () => undefined,
              fetchFn: async () =>
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(Buffer.from('a'));
                    },
                  }),
                ),
              ...extra,
            }),
          ),
        );
      };
      const idleEnv = { DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS: '1000' };

      const tuned = await stalledRun({ tuningEnv: idleEnv });
      expect((tuned as RuntimeError).code).to.equal('UPLOAD_DOWNLOAD_TIMEOUT');
      expect(tuned.name).to.equal('ContentDiffRuntimeError');
      expect(
        (tuned as RuntimeError & { details: unknown }).details,
      ).to.deep.equal({
        phase: 'body',
        timeoutMilliseconds: 1_000,
        variable: 'DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS',
      });
      expect(tuned.message).to.equal(
        'Upload download received no data for 1000ms. Set DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS to wait longer.',
      );

      const overridden = await stalledRun({
        tuningEnv: idleEnv,
        uploadDownloadIdleTimeoutMs: 10,
      });
      expect(
        (overridden as RuntimeError & { details: Record<string, unknown> })
          .details.timeoutMilliseconds,
      ).to.equal(10);
    });

    it('bounds missing response headers by DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS and names it in the error', async () => {
      const runtime = await loadRuntime();
      const plan = makeUploadCreateRuntimePlan();
      const mock = makeRuntimeClient('absent', { recordAbsent: true });

      const error = await withMutedConsoleError(() =>
        expectRejects(
          runtime.runContentDiffMigration(mock.client, makeEnvelope(plan), {
            executionContext: { environmentId: 'destination-fork' },
            log: () => undefined,
            tuningEnv: {
              DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS: '1000',
            },
            fetchFn: () => new Promise<never>(() => undefined),
          }),
        ),
      );

      expect((error as RuntimeError).code).to.equal('UPLOAD_DOWNLOAD_TIMEOUT');
      expect(error.name).to.equal('ContentDiffRuntimeError');
      expect(
        (error as RuntimeError & { details: unknown }).details,
      ).to.deep.equal({
        phase: 'headers',
        timeoutMilliseconds: 1_000,
        variable: 'DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS',
      });
      expect(error.message).to.equal(
        'Upload download did not receive response headers within 1000ms. Set DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS to wait longer.',
      );
    });

    it('bounds validity polling by the resolved DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS and names it in the error', async () => {
      const runtime = await loadRuntime(
        '\nmodule.exports.__waitForExpectedRecordValidity = waitForExpectedRecordValidity;\n',
      );
      const recordPlan = {
        id: RECORD_ID,
        itemTypeId: MODEL_ID,
        desired: { validity: { current: true, published: null } },
      };
      const context = {
        client: {
          items: {
            find: async (id: string) => ({
              id,
              meta: {
                is_valid: false,
                is_current_version_valid: false,
                is_published_version_valid: null,
              },
            }),
          },
        },
        options: { validityProcessingPollIntervalMs: 0 },
        tuning: { validityTimeoutMs: 20 },
        plan: {
          records: [recordPlan],
          execution: { revalidateBeforePublishIds: [RECORD_ID] },
          invalidContent: {
            validatorRelaxations: [{ affectedRecordIds: [RECORD_ID] }],
            skippedRecords: [],
          },
        },
        recordPlansById: new Map([[RECORD_ID, recordPlan]]),
      };

      const error = await expectRejects(
        runtime.__waitForExpectedRecordValidity!(context),
      );

      expect((error as RuntimeError).code).to.equal(
        'VALIDITY_REVALIDATION_TIMEOUT',
      );
      expect(
        (error as RuntimeError & { details: Record<string, unknown> }).details
          .timeoutMs,
      ).to.equal(20);
      expect(error.message).to.contain(
        'before timeout. Set DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS to wait longer. Pending: ',
      );
    });

    it('logs each overridden variable after the start line and nothing for defaults', async () => {
      const runtime = await loadRuntime();
      const run = async (
        tuningEnv: Record<string, string>,
        extra: Record<string, unknown> = {},
      ) => {
        const messages: string[] = [];
        const mock = makeRuntimeClient('baseline');
        await runtime.runContentDiffMigration(
          mock.client,
          makeEnvelope(makeRuntimePlan('desired', 'baseline')),
          {
            executionContext: { environmentId: 'destination-fork' },
            log: (message) => messages.push(message),
            tuningEnv,
            ...extra,
          },
        );
        return messages;
      };

      const tuned = await run({
        DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS: '900000',
        // Equal to its default, so it is not an override.
        DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS: '120000',
        DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS: '360000',
      });
      const start = tuned.findIndex((message) =>
        message.startsWith('[content-diff] Starting DatoCMS content migration'),
      );
      expect(start).to.equal(0);
      expect(tuned.slice(1, 3)).to.deep.equal([
        '[content-diff] Runtime tuning: DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS=900000 ms (default 600000 ms).',
        '[content-diff] Runtime tuning: DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS=360000 ms (default 300000 ms).',
      ]);
      expect(
        tuned.filter((message) => message.includes('Runtime tuning:')),
      ).to.have.length(2);

      const defaults = await run({});
      expect(
        defaults.filter((message) => message.includes('Runtime tuning:')),
      ).to.deep.equal([]);

      // An explicit runtime option wins, so the shadowed variable is not
      // reported as a value the run uses.
      const shadowed = await run(
        {
          DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS: '900000',
          DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS: '360000',
        },
        { scheduleSafetyWindowMs: 300_000 },
      );
      expect(
        shadowed.filter((message) => message.includes('Runtime tuning:')),
      ).to.deep.equal([
        '[content-diff] Runtime tuning: DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS=900000 ms (default 600000 ms).',
      ]);
    });
  });
});

interface RuntimeModule {
  __verifyBlockOwnershipSafety?: (
    context: Record<string, any>,
  ) => Promise<void>;
  __findUnsupportedFreshNestedBlockUpdates?: (
    records: ContentDiffPlan['records'],
    schemaById: Map<string, any>,
    baselineSchemaById?: Map<string, any>,
    blockedItemTypeIds?: Set<string>,
    unsafeCreateRecordIds?: Set<string>,
  ) => unknown[];
  __itemTypeIdsAffectedByValidatorChanges?: (
    schemaById: Map<string, any>,
    changedItemTypeIds: Set<string>,
  ) => Set<string>;
  __unsafeFreshNestedCreateRecordIds?: (plan: ContentDiffPlan) => Set<string>;
  __collectNestedBlocks?: (
    fields: JsonObject,
    output: Map<string, JsonObject>,
    itemType: Record<string, any>,
    schemaById: Map<string, any>,
  ) => void;
  __collectUploadReferencesFromFields?: (
    fields: JsonObject,
    itemType: Record<string, any>,
    context: Record<string, any>,
    output: Set<string>,
  ) => void;
  __findItemsCurrentShells?: (
    client: Record<string, any>,
    ids: string[],
  ) => Promise<Map<string, Record<string, any> | null>>;
  __captureLiveRecordPositionStateSignature?: (
    context: Record<string, any>,
  ) => Promise<string>;
  __validateTargetInspection?: (plan: ContentDiffPlan) => void;
  __inspectionItemTypesDigest?: (
    itemTypes: SchemaSnapshot['itemTypes'],
  ) => string;
  __applyCreateDefaultsToFields?: (
    fields: Record<string, any>,
    itemType: SchemaSnapshot['itemTypes'][number],
    schema: SchemaSnapshot,
  ) => Record<string, any>;
  __readSchedules?: (
    context: Record<string, any>,
    current: Record<string, unknown>,
  ) => Promise<RuntimeScheduleState>;
  __mapWithConcurrency?: <T>(
    values: T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<T>,
  ) => Promise<T[]>;
  RUNTIME_VERSION: string;
  __runContentDiffMigrationWithoutProtocolDefaults?: RuntimeRunner;
  __stripUnavailableReferences?: (
    fields: Record<string, any>,
    itemType: Record<string, any>,
    lookup: Map<string, any>,
    unavailable: ReadonlySet<string>,
    path: string,
    requiredReferences: 'keep' | 'reject' | 'strip',
  ) => Record<string, any>;
  __fieldIsRequired?: (field: Record<string, any>) => boolean;
  __collectRecordReferencesFromFields?: (
    fields: Record<string, any>,
    itemType: Record<string, any>,
    context: Record<string, any>,
  ) => Set<string>;
  __expectedCreateSeedFields?: (
    context: Record<string, any>,
    recordPlan: Record<string, any>,
  ) => Record<string, any>;
  __verifyLegacySourceIdsAbsent?: (
    context: Record<string, any>,
  ) => Promise<void>;
  __isPortableDatoId?: (id: string) => boolean;
  __isCanonicalLegacyDatoId?: (id: string) => boolean;
  __uploadNeedsBinaryTransfer?: (
    live: Record<string, any>,
    desired: Record<string, any>,
  ) => boolean;
  __isSafeUploadIntermediate?: (
    live: Record<string, any>,
    plan: Record<string, any>,
  ) => boolean;
  __uploadBinaryUpdateBody?: (
    plan: Record<string, any>,
    stagedPath: string,
  ) => Record<string, unknown>;
  __uploadBinaryIntermediateManual?: (
    plan: Record<string, any>,
  ) => Record<string, unknown>;
  __waitForUploadFilenameWindow?: (
    context: Record<string, any>,
    filename: string,
  ) => Promise<void>;
  __uploadPlanContractError?: (
    upload: UploadPlan,
    schema: ContentDiffPlan['schema'],
  ) => string | null;
  __deriveRequiredUploadActions?: (
    uploads: UploadPlan[],
  ) => ContentDiffPlan['requiredPermissions']['uploadActions'];
  __isUploadRequestFilenameFixedPoint?: (filename: string) => boolean;
  __uploadManualUpdateNeedsFilenameWindow?: (
    live: Record<string, any>,
    desired: Record<string, any>,
  ) => boolean;
  __uploadManualUpdateBody?: (
    live: Record<string, any>,
    desired: Record<string, any>,
  ) => Record<string, unknown>;
  __canonicalizeUpload?: (
    input: Record<string, any>,
    locales: readonly string[],
  ) => Record<string, any>;
  __findNonPortableCreateIds?: (plan: ContentDiffPlan) => string[];
  __findRecordSnapshotIdentityMismatches?: (plan: ContentDiffPlan) => string[];
  __uploadCollectionPlanContractError?: (
    plan: ContentDiffPlan['uploadCollections'][number],
  ) => string | null;
  __uploadCollectionOrderContractError?: (
    plans: ContentDiffPlan['uploadCollections'],
    order: readonly string[],
  ) => string | null;
  __verifyLiveUploadCollectionLabelSafety?: (
    context: Record<string, any>,
  ) => Promise<void>;
  __matchesPlannedCollectionState?: (
    context: Record<string, any>,
    signature: string,
  ) => { matched: boolean; allowedStateCount: number };
  __isKnownCreateRecordPhaseState?: (
    context: Record<string, any>,
    live: Record<string, any>,
    plan: Record<string, any>,
    itemType: Record<string, any>,
  ) => boolean;
  __createMissingRecords?: (context: Record<string, any>) => Promise<void>;
  __validateSchedulesBeforeCancellation?: (
    context: Record<string, any>,
  ) => void;
  __assertScheduleStillSafe?: (
    context: Record<string, any>,
    recordId: string,
    kind: string,
    at: string,
  ) => void;
  __assertRecordSafeForResume?: (
    context: Record<string, any>,
    recordPlan: Record<string, any>,
    live: Record<string, any>,
  ) => void;
  __verifySchedulesRemainQuiesced?: (
    context: Record<string, any>,
  ) => Promise<void>;
  __waitForExpectedRecordValidity?: (
    context: Record<string, any>,
  ) => Promise<void>;
  __canonicalizeRuntimeRecord?: (
    current: Record<string, any>,
    published: Record<string, any> | null,
    itemType: Record<string, any>,
    schema: Record<string, any>,
    schedules: Record<string, any>,
  ) => Record<string, any>;
  __assertNoUnsafeTreeChildren?: (
    context: Record<string, any>,
    plan: Record<string, any>,
    version: string,
    preflight: boolean,
    operation: string,
  ) => Promise<void>;
  __assertLiveRecordPositionStateSafe?: (
    context: Record<string, any>,
  ) => Promise<string>;
  __recordPositionGoalReached?: (
    context: Record<string, any>,
    positional: Record<string, any>[],
    state: Map<string, Record<string, any>>,
  ) => boolean;
  __prepareManagedSchema?: (context: Record<string, any>) => Promise<void>;
  __verifySkippedScheduleSafety?: (
    context: Record<string, any>,
    recapture: boolean,
  ) => Promise<void>;
  __verifySkippedRecords?: (
    context: Record<string, any>,
    finalCheck: boolean,
  ) => Promise<void>;
  __verifyPublishedDeleteReleases?: (
    context: Record<string, any>,
    validatorsAreRelaxed: boolean,
  ) => Promise<void>;
  __buildRuntimeRecordValidationPayload?: (
    context: Record<string, any>,
    fields: Record<string, any>,
    itemTypeId: string,
  ) => Record<string, any>;
  __buildVersionPatch?: (
    desiredFields: Record<string, any>,
    currentFields: Record<string, any>,
    liveRecord: Record<string, any>,
    itemType: SchemaSnapshot['itemTypes'][number],
    schemaById: Map<string, SchemaSnapshot['itemTypes'][number]>,
  ) => Record<string, any>;
  __verifyTransientDeleteReleaseBlockIds?: (
    context: Record<string, any>,
  ) => Promise<void>;
  __createInterruptibleClient?: (
    client: unknown,
    context: Record<string, unknown>,
  ) => any;
  __withAbortSuspended?: (
    context: Record<string, unknown>,
    task: () => Promise<unknown>,
  ) => Promise<unknown>;
  __streamAndHash?: (
    readable: Readable,
    destination: string,
    signal: AbortSignal | null,
  ) => Promise<{ md5: string; sha256: string; size: number }>;
  __copyAndHash?: (
    context: Record<string, unknown>,
    source: string,
    destination: string,
  ) => Promise<{ md5: string; sha256: string; size: number }>;
  __verifyOneRelaxedCreateSeed?: (
    context: Record<string, any>,
    recordPlan: Record<string, any>,
    onlyCurrentlyResolvable: boolean,
  ) => Promise<void>;
  runContentDiffMigration: RuntimeRunner;
}

type RuntimeRunner = (
  client: CmaClient.Client,
  envelope: RuntimeEnvelope,
  options?: {
    executionContext?: {
      environmentId?: string;
      inPlace?: boolean;
      allowPrimary?: boolean;
      contentDiffProtocolVersion?: number;
      // Deliberately loose so tests can pass malformed signals.
      abortSignal?: unknown;
    };
    fetchFn?: (...args: any[]) => Promise<any>;
    uploadFilenameCollisionWindowMs?: number;
    uploadProcessingPollIntervalMs?: number;
    uploadDownloadHeadersTimeoutMs?: number;
    uploadDownloadIdleTimeoutMs?: number;
    uploadProcessingTimeoutMs?: number;
    validityProcessingPollIntervalMs?: number;
    validityProcessingTimeoutMs?: number;
    scheduleSafetyWindowMs?: number;
    tuningEnv?: Record<string, string | undefined>;
    log?: (message: string) => void;
  },
) => Promise<void>;

interface RuntimeEnvelope {
  formatVersion: number;
  runtimeVersion: string;
  integrity: { algorithm: 'sha256'; planSha256: string };
  plan: ContentDiffPlan;
}

interface RuntimeError extends Error {
  code: string;
}

async function loadRuntime(testExports = ''): Promise<RuntimeModule> {
  const directory = await mkdtemp(join(tmpdir(), 'datocms-runtime-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'runtime.cjs');
  await writeFile(path, renderRuntime('js') + testExports);
  const localRequire = createRequire(join(directory, 'loader.cjs'));

  const runtime = localRequire(path) as RuntimeModule;
  const rawRunner = runtime.runContentDiffMigration;
  runtime.__runContentDiffMigrationWithoutProtocolDefaults = rawRunner;
  runtime.runContentDiffMigration = (client, envelope, options) =>
    rawRunner(client, envelope, {
      ...options,
      executionContext: {
        ...options?.executionContext,
        contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
      },
    });
  return runtime;
}

function makeEnvelope(plan: ContentDiffPlan): RuntimeEnvelope {
  return {
    formatVersion: 10,
    runtimeVersion: RUNTIME_VERSION,
    integrity: {
      algorithm: 'sha256',
      planSha256: createHash('sha256')
        .update(stableStringify(plan))
        .digest('hex'),
    },
    plan,
  };
}

function makeRuntimePlan(
  sourceTitle: string,
  targetTitle: string,
  schedules: RuntimeScheduleState = {
    publication: null,
    unpublishing: null,
  },
  targetSchedules: RuntimeScheduleState = schedules,
): ContentDiffPlan {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const sourceRecord = canonicalizeRecord(
    makeRecord(sourceTitle, 'source-version'),
    null,
    sourceSchema.itemTypes[0],
    sourceSchema,
    schedules,
  );
  const targetRecord = canonicalizeRecord(
    makeRecord(targetTitle, 'target-version'),
    null,
    targetSchema.itemTypes[0],
    targetSchema,
    targetSchedules,
  );

  return buildContentDiffPlan(
    makeSnapshot(sourceSchema, sourceRecord),
    makeSnapshot(targetSchema, targetRecord),
    {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
    },
  );
}

function makeAlignedRuntimePlan(
  sourceTitle: string,
  targetTitle: string,
): ContentDiffPlan {
  const sourceSchema = makeSchema('main');
  sourceSchema.siteId = 'source-site';
  const targetSchema = makeSchema('main');
  targetSchema.siteId = 'target-site';
  const sourceRecord = canonicalizeRecord(
    makeRecord(sourceTitle, 'source-version'),
    null,
    sourceSchema.itemTypes[0],
    sourceSchema,
    { publication: null, unpublishing: null },
  );
  const targetRecord = canonicalizeRecord(
    makeRecord(targetTitle, 'target-version'),
    null,
    targetSchema.itemTypes[0],
    targetSchema,
    { publication: null, unpublishing: null },
  );

  return buildContentDiffPlan(
    makeSnapshot(sourceSchema, sourceRecord),
    makeSnapshot(targetSchema, targetRecord),
    {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
    },
  );
}

type RuntimeScheduleState = {
  publication: {
    at: string;
    selective: {
      locales: string[];
      nonLocalized: boolean;
    } | null;
  } | null;
  unpublishing: {
    at: string;
    locales: string[] | null;
  } | null;
};

function makeScheduleQuiescenceRuntimePlan(
  scheduleOverrides: RuntimeScheduleState | null = null,
): {
  plan: ContentDiffPlan;
  schedules: RuntimeScheduleState;
} {
  const schedules: RuntimeScheduleState = scheduleOverrides ?? {
    publication: {
      at: '2099-01-01T00:00:00.000Z',
      selective: { locales: ['en'], nonLocalized: true },
    },
    unpublishing: {
      at: '2099-01-02T00:00:00.000Z',
      locales: ['en'],
    },
  };
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const record = (
    id: string,
    title: string,
    version: string,
    schema: SchemaSnapshot,
  ) => {
    const raw = makeRecord(title, version);
    raw.id = id;
    return canonicalizeRecord(
      raw,
      null,
      schema.itemTypes[0],
      schema,
      schedules,
    );
  };
  const sourceRecords = [
    record(RECORD_ID, 'desired title', 'source-update', sourceSchema),
    record(
      EXTERNAL_PARENT_ID,
      'scheduled dependency',
      'source-dependency',
      sourceSchema,
    ),
  ];
  const targetRecords = [
    record(RECORD_ID, 'baseline title', 'target-update', targetSchema),
    record(
      EXTERNAL_PARENT_ID,
      'scheduled dependency',
      'target-dependency',
      targetSchema,
    ),
  ];
  return {
    plan: buildContentDiffPlan(
      makeSnapshotWithRecords(sourceSchema, sourceRecords),
      makeSnapshotWithRecords(targetSchema, targetRecords),
      {
        includeDeletions: false,
        uploads: 'referenced',
        migrateInvalidContent: false,
      },
    ),
    schedules,
  };
}

function makeUploadCreateRuntimePlan(): ContentDiffPlan {
  const uploadId = 'QtiP3aRYQhK9jRVGDL6kPg';
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const source = makeEmptySnapshot(sourceSchema);
  source.uploads[uploadId] = canonicalizeUpload(
    {
      id: uploadId,
      md5: '900150983cd24fb0d6963f7d28e17f72',
      basename: 'asset',
      filename: 'asset.txt',
      url: 'https://example.test/asset.txt',
      size: 3,
      mime_type: 'text/plain',
      tags: [],
      default_field_metadata: emptyUploadDefaultFieldMetadata(),
      upload_collection: null,
      meta: { antivirus: { status: 'clean' } },
    },
    sourceSchema.locales,
  );
  return buildContentDiffPlan(source, makeEmptySnapshot(targetSchema), {
    includeDeletions: false,
    uploads: 'referenced',
    migrateInvalidContent: false,
  });
}

function makeUploadStemRenameRuntimePlan(): ContentDiffPlan {
  const uploadId = 'QtiP3aRYQhK9jRVGDL6kPg';
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const source = makeEmptySnapshot(sourceSchema);
  const target = makeEmptySnapshot(targetSchema);
  const upload = (basename: string) =>
    canonicalizeUpload(
      {
        id: uploadId,
        md5: '900150983cd24fb0d6963f7d28e17f72',
        basename,
        filename: `${basename}.txt`,
        url: `https://example.test/${basename}.txt`,
        size: 3,
        mime_type: 'text/plain',
        tags: [],
        default_field_metadata: emptyUploadDefaultFieldMetadata(),
        upload_collection: null,
        meta: { antivirus: { status: 'clean' } },
      },
      sourceSchema.locales,
    );
  source.uploads[uploadId] = upload('renamed-asset');
  target.uploads[uploadId] = upload('asset');
  return buildContentDiffPlan(source, target, {
    includeDeletions: false,
    uploads: 'referenced',
    migrateInvalidContent: false,
  });
}

function makeNestedBlockUpdateRuntimePlan(
  sourceTitle: string,
  targetTitle: string,
  blockText: string,
): ContentDiffPlan {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const sourceBlock = makeNestedBlock();
  sourceBlock.attributes.text = blockText;
  const targetBlock = structuredClone(sourceBlock);
  const sourceRecord = canonicalizeRecord(
    makeRecord(sourceTitle, 'source-version', sourceBlock),
    null,
    sourceSchema.itemTypes[0],
    sourceSchema,
    { publication: null, unpublishing: null },
  );
  const targetRecord = canonicalizeRecord(
    makeRecord(targetTitle, 'target-version', targetBlock),
    null,
    targetSchema.itemTypes[0],
    targetSchema,
    { publication: null, unpublishing: null },
  );

  return buildContentDiffPlan(
    makeSnapshot(sourceSchema, sourceRecord),
    makeSnapshot(targetSchema, targetRecord),
    {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
    },
  );
}

function makePositionShiftedNoopSiblingRuntimePlan(): ContentDiffPlan {
  const sourceSchema = makeSchema('source', { sortable: true });
  const targetSchema = makeSchema('destination', { sortable: true });
  const makePositioned = (
    id: string,
    title: string,
    version: string,
    position: number,
  ) => {
    const input = makeRecord(title, version, undefined, {
      parentId: null,
      position,
    });
    input.id = id;
    return input;
  };
  const sourceRecords = [
    canonicalizeRecord(
      makePositioned(RECORD_ID, 'Plain moved record', 'source-moved', 1),
      null,
      sourceSchema.itemTypes[0],
      sourceSchema,
      { publication: null, unpublishing: null },
    ),
    canonicalizeRecord(
      makePositioned(
        MAPPING_RECORD_ID,
        '<p>Historical no-op sibling &copy;</p>',
        'source-sibling',
        2,
      ),
      null,
      sourceSchema.itemTypes[0],
      sourceSchema,
      { publication: null, unpublishing: null },
    ),
  ];
  const targetRecords = [
    canonicalizeRecord(
      makePositioned(RECORD_ID, 'Plain moved record', 'target-moved', 3),
      null,
      targetSchema.itemTypes[0],
      targetSchema,
      { publication: null, unpublishing: null },
    ),
    canonicalizeRecord(
      makePositioned(
        MAPPING_RECORD_ID,
        '<p>Historical no-op sibling &copy;</p>',
        'target-sibling',
        2,
      ),
      null,
      targetSchema.itemTypes[0],
      targetSchema,
      { publication: null, unpublishing: null },
    ),
  ];

  return buildContentDiffPlan(
    makeSnapshotWithRecords(sourceSchema, sourceRecords),
    makeSnapshotWithRecords(targetSchema, targetRecords),
    {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
    },
  );
}

function makeHistoricalNullCreateRuntimePlan(
  options: {
    divergentDraft?: boolean;
    noDraft?: boolean;
    unique?: boolean;
    content?: Record<string, any>;
    schedules?: RuntimeScheduleState;
  } = {},
): ContentDiffPlan {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  for (const schema of [sourceSchema, targetSchema]) {
    const model = schema.itemTypes.find(({ id }) => id === MODEL_ID)!;
    model.draftModeActive = options.noDraft !== true;
    model.fields.push({
      id: 'historical-number-field',
      apiKey: 'historical_number',
      fieldType: 'float',
      localized: false,
      position: 3,
      defaultValue: 42.625,
      validators: options.unique ? { unique: {} } : {},
    });
    schema.digest = computeSchemaDigest(schema);
  }
  const sourceInput =
    options.noDraft || options.divergentDraft
      ? makePublishedRecord(
          options.divergentDraft ? 'current desired' : 'historical null',
          'source-version',
        )
      : makeRecord('historical null', 'source-version');
  sourceInput.content = options.content ?? null;
  sourceInput.historical_number = null;
  const publishedInput = options.divergentDraft
    ? makePublishedRecord('historical null', 'published-source-version')
    : options.noDraft
      ? sourceInput
      : null;
  if (publishedInput) {
    publishedInput.content = null;
    publishedInput.historical_number = null;
  }
  const sourceRecord = canonicalizeRecord(
    sourceInput,
    publishedInput,
    sourceSchema.itemTypes[0],
    sourceSchema,
    options.schedules ?? { publication: null, unpublishing: null },
  );

  return buildContentDiffPlan(
    makeSnapshot(sourceSchema, sourceRecord),
    makeEmptySnapshot(targetSchema),
    {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: true,
    },
  );
}

function makeCombinedSchemaRecoveryRuntimePlan(
  options: {
    content?: Record<string, any>;
    schedules?: RuntimeScheduleState;
  } = {},
): ContentDiffPlan {
  const plan = makeHistoricalNullCreateRuntimePlan(options);
  const relaxation = makeValidatorRelaxationRuntimePlan('desired', 'baseline');
  const field = plan.schema.itemTypes[0].fields.find(
    ({ id }) => id === 'title-field',
  )!;
  field.validators = { required: {} };
  plan.schema.digest = computeSchemaDigest(plan.schema);
  plan.source.schemaDigest = plan.schema.digest;
  plan.target.schemaDigest = plan.schema.digest;
  plan.invalidContent.validatorRelaxations =
    relaxation.invalidContent.validatorRelaxations;
  plan.invalidContent.detectedRecordIds = [RECORD_ID];
  plan.invalidContent.migratedRecordIds = [RECORD_ID];
  plan.invalidContent.schemaStates.originalDigest = plan.schema.digest;
  const relaxedSchema = structuredClone(plan.schema);
  relaxedSchema.itemTypes[0].fields.find(
    ({ id }) => id === 'title-field',
  )!.validators = {};
  plan.invalidContent.schemaStates.fullyRelaxedDigest =
    computeSchemaDigest(relaxedSchema);
  plan.execution.revalidateBeforePublishIds = [];
  return plan;
}

function makePublicationRecoveryRuntimePlan(
  schedules: RuntimeScheduleState,
  unpublish: boolean,
): ContentDiffPlan {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const sourceCurrent = makePublishedRecord('desired draft', 'source-current');
  sourceCurrent.content = makeNestedBlock();
  const sourcePublished = makePublishedRecord(
    'desired published',
    'source-published',
  );
  sourcePublished.content = makeNestedBlock();
  if (unpublish) {
    sourceCurrent.meta.published_at = null;
    sourceCurrent.meta.is_published_version_valid = null;
  }
  const target = makePublishedRecord('baseline', 'target-version');
  target.content = makeNestedBlock();
  const sourceRecord = canonicalizeRecord(
    sourceCurrent,
    unpublish ? null : sourcePublished,
    sourceSchema.itemTypes[0],
    sourceSchema,
    schedules,
  );
  const targetRecord = canonicalizeRecord(
    target,
    target,
    targetSchema.itemTypes[0],
    targetSchema,
    schedules,
  );
  return buildContentDiffPlan(
    makeSnapshot(sourceSchema, sourceRecord),
    makeSnapshot(targetSchema, targetRecord),
    {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
    },
  );
}

function injectRuntimeMutationFault(
  client: CmaClient.Client,
  fault?: {
    index: number;
    timing: 'before' | 'after';
  },
) {
  const writes: Array<{ operation: string; args: unknown[] }> = [];
  let injected = false;
  const resources = client as unknown as Record<
    string,
    Record<string, (...args: any[]) => Promise<any>>
  >;
  for (const resource of [
    'itemTypes',
    'fields',
    'items',
    'uploads',
    'uploadCollections',
    'scheduledPublication',
    'scheduledUnpublishing',
  ]) {
    for (const method of [
      'create',
      'update',
      'destroy',
      'publish',
      'unpublish',
      'moveToStage',
      'updatePosition',
      'createFromLocalFile',
      'updateFromLocalFile',
    ]) {
      const original = resources[resource]?.[method];
      if (typeof original !== 'function') continue;
      resources[resource][method] = async (...args) => {
        const index = writes.length;
        writes.push({
          operation: `${resource}.${method}`,
          args: structuredClone(args),
        });
        const inject = () => {
          injected = true;
          throw new Error(
            `injected write interruption ${
              fault!.timing
            } ${resource}.${method}`,
          );
        };
        const shouldInject = !injected && fault?.index === index;
        if (shouldInject && fault.timing === 'before') inject();
        const result = await original.apply(resources[resource], args);
        if (shouldInject && fault.timing === 'after') inject();
        return result;
      };
    }
  }
  return { writes, injected: () => injected };
}

// Records every CMA write like injectRuntimeMutationFault, but aborts the
// runner's signal before or after the write at `index` instead of failing it.
function injectRuntimeAbort(
  client: CmaClient.Client,
  controller: AbortController,
  abort?: {
    index: number;
    timing: 'before' | 'after';
  },
) {
  const writes: Array<{ operation: string; args: unknown[] }> = [];
  let abortedAt: number | null = null;
  const resources = client as unknown as Record<
    string,
    Record<string, (...args: any[]) => Promise<any>>
  >;
  for (const resource of [
    'itemTypes',
    'fields',
    'items',
    'uploads',
    'uploadCollections',
    'scheduledPublication',
    'scheduledUnpublishing',
  ]) {
    for (const method of [
      'create',
      'update',
      'destroy',
      'publish',
      'unpublish',
      'moveToStage',
      'updatePosition',
      'createFromLocalFile',
      'updateFromLocalFile',
    ]) {
      const original = resources[resource]?.[method];
      if (typeof original !== 'function') continue;
      resources[resource][method] = async (...args) => {
        const index = writes.length;
        writes.push({
          operation: `${resource}.${method}`,
          args: structuredClone(args),
        });
        const shouldAbort = abortedAt === null && abort?.index === index;
        if (shouldAbort && abort.timing === 'before') {
          abortedAt = index;
          controller.abort();
        }
        const result = await original.apply(resources[resource], args);
        if (shouldAbort && abort.timing === 'after') {
          abortedAt = index;
          controller.abort();
        }
        return result;
      };
    }
  }
  return { writes, abortedAt: () => abortedAt };
}

// Aborts when the runtime reads client[resource][method], which is right
// before its interruption check for that CMA call. Returns an uninstaller.
function abortOnCmaMethodAccess(
  client: CmaClient.Client,
  resource: string,
  method: string,
  abort: () => void,
): () => void {
  const resources = client as unknown as Record<string, object>;
  const original = resources[resource];
  resources[resource] = new Proxy(original, {
    get(target, property, receiver) {
      if (property === method) abort();
      return Reflect.get(target, property, receiver);
    },
  });
  return () => {
    resources[resource] = original;
  };
}

function withUploadCreate(plan: ContentDiffPlan): ContentDiffPlan {
  const assets = makeUploadCreateRuntimePlan();
  plan.uploads = assets.uploads;
  plan.execution.uploadOrder = assets.execution.uploadOrder;
  plan.requiredPermissions.uploadActions =
    assets.requiredPermissions.uploadActions;
  return plan;
}

// The binary of the upload in makeUploadCreateRuntimePlan.
const UPLOAD_CREATE_BYTES = Buffer.from('abc');

function uploadCreateFetch(events?: string[]) {
  return async () => {
    events?.push('upload-fetch');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: Readable.toWeb(Readable.from(UPLOAD_CREATE_BYTES)),
    };
  };
}

// Replaces the mock's uploads resource with one that accepts the upload of
// makeUploadCreateRuntimePlan and reports it processed.
function installUploadCreateStore(
  mock: { client: CmaClient.Client },
  options: { events?: string[]; antivirusStatus?: string } = {},
) {
  let live: Record<string, any> | null = null;
  mock.client.uploads = {
    find: async () => {
      if (!live) throw { response: { status: 404 } };
      return structuredClone(live);
    },
    createFromLocalFile: async (body: Record<string, any>) => {
      options.events?.push('upload-create');
      const transferred = await readFile(body.localPath);
      live = {
        ...structuredClone(body),
        md5: createHash('md5').update(transferred).digest('hex'),
        basename: 'asset',
        size: transferred.length,
        mime_type: 'text/plain',
        url: 'https://example.test/asset.txt',
        meta: { antivirus: { status: options.antivirusStatus ?? 'clean' } },
      };
      return structuredClone(live);
    },
    update: async (_id: string, body: Record<string, any>) => {
      live = { ...live, ...structuredClone(body) };
      return structuredClone(live);
    },
  } as unknown as CmaClient.Client['uploads'];
  return { upload: () => live };
}

function addPreservedSkippedRecord(
  plan: ContentDiffPlan,
  schedules: RuntimeScheduleState,
): void {
  const skippedInput = makeRecord(
    'scheduled dependency',
    `scheduled-version-${EXTERNAL_PARENT_ID}`,
  );
  skippedInput.id = EXTERNAL_PARENT_ID;
  const skippedSnapshot = canonicalizeRecord(
    skippedInput,
    null,
    plan.schema.itemTypes[0],
    plan.schema,
    schedules,
  );
  plan.invalidContent.detectedRecordIds.push(EXTERNAL_PARENT_ID);
  plan.invalidContent.skippedRecords.push({
    id: EXTERNAL_PARENT_ID,
    itemTypeId: MODEL_ID,
    disposition: 'preserve_target',
    sourceHash: skippedSnapshot.hash,
    expectedTargetHash: skippedSnapshot.hash,
    expectedTargetPosition: skippedSnapshot.topology.position,
    sourceValidity: skippedSnapshot.validity,
    targetValidity: skippedSnapshot.validity,
    sourceNestedBlockIds: [],
    preservedExternalBlockIds: [],
    targetNestedBlockIds: [],
    reasons: [
      {
        code: 'INVALID_CURRENT',
        slice: 'current',
        message: 'Preserved scheduled test aggregate',
        dependencyChain: [EXTERNAL_PARENT_ID],
      },
    ],
  });
}

async function withShiftedClock<T>(
  task: (shift: (milliseconds: number) => void) => Promise<T>,
): Promise<T> {
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  try {
    return await task((milliseconds) => {
      offset = milliseconds;
    });
  } finally {
    Date.now = originalNow;
  }
}

async function withCapturedConsoleError<T>(
  task: () => Promise<T>,
): Promise<{ result: T; errors: string[] }> {
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    return { result: await task(), errors };
  } finally {
    console.error = original;
  }
}

// Points os.tmpdir() at a fresh directory so a test can prove the runtime
// removed its staging directory.
async function withIsolatedTemporaryDirectory<T>(
  task: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'datocms-runtime-staging-'));
  temporaryDirectories.push(directory);
  const variables = ['TMPDIR', 'TMP', 'TEMP'] as const;
  const original = variables.map((name) => process.env[name]);
  for (const name of variables) process.env[name] = directory;
  try {
    return await task(directory);
  } finally {
    variables.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  }
}

function makeExternalRecordReferenceRuntimePlan(
  published: boolean,
): ContentDiffPlan {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  for (const schema of [sourceSchema, targetSchema]) {
    schema.itemTypes[0].fields.push({
      id: 'external-link-field',
      apiKey: 'external_link',
      fieldType: 'link',
      localized: false,
      position: 3,
      validators: {},
    });
    schema.digest = computeSchemaDigest(schema);
  }
  const makeInput = (version: string) => {
    const record = published
      ? makePublishedRecord('unchanged', version)
      : makeRecord('unchanged', version);
    record.external_link = EXTERNAL_PARENT_ID;
    return record;
  };
  const sourceInput = makeInput('source-version');
  const targetInput = makeInput('target-version');
  const sourceRecord = canonicalizeRecord(
    sourceInput,
    published ? sourceInput : null,
    sourceSchema.itemTypes[0],
    sourceSchema,
    { publication: null, unpublishing: null },
  );
  const targetRecord = canonicalizeRecord(
    targetInput,
    published ? targetInput : null,
    targetSchema.itemTypes[0],
    targetSchema,
    { publication: null, unpublishing: null },
  );
  const source = makeSnapshot(sourceSchema, sourceRecord);
  const target = makeSnapshot(targetSchema, targetRecord);
  source.visibleRecordIds.push(EXTERNAL_PARENT_ID);
  target.visibleRecordIds.push(EXTERNAL_PARENT_ID);
  return buildContentDiffPlan(source, target, {
    includeDeletions: false,
    uploads: 'referenced',
    migrateInvalidContent: false,
  });
}

function withLegacyIdMapping(
  plan: ContentDiffPlan,
  entry: {
    entityType: 'record' | 'block' | 'upload' | 'upload_collection';
    sourceId: string;
    targetId: string;
    status: 'existing' | 'new';
    managed?: boolean;
    expectedItemTypeId?: string | null;
    requiredAvailability?: { current: boolean; published: boolean };
  },
  schemaStatus: 'existing' | 'new' = 'new',
): ContentDiffPlan {
  const documentEntries = [
    {
      entityType: entry.entityType,
      sourceId: entry.sourceId,
      targetId: entry.targetId,
    },
  ];
  const wholeHash = createHash('sha256')
    .update(stableStringify(documentEntries))
    .digest('hex');
  const document = {
    formatVersion: 1 as const,
    projectId: 'site-id',
    batchId: MAPPING_BATCH_ID,
    chunkIndex: 0,
    chunkCount: 1,
    wholeHash,
    entries: documentEntries,
  };
  const serializedDocument = JSON.stringify(
    canonicalizeJson(document),
    null,
    2,
  );
  const chunk = {
    id: MAPPING_RECORD_ID,
    name: `legacy-id-map:${MAPPING_BATCH_ID}:1/1`,
    chunkIndex: 0,
    chunkCount: 1,
    hash: createHash('sha256').update(serializedDocument).digest('hex'),
    byteLength: Buffer.byteLength(serializedDocument, 'utf8'),
    serializedDocument,
    document,
  };

  const managed = entry.managed ?? true;
  const defaultPublished =
    entry.entityType === 'record'
      ? Boolean(
          plan.records.find(({ id }) => id === entry.targetId)?.desired
            ?.published,
        )
      : entry.entityType === 'block'
        ? false
        : false;
  const planEntry = {
    entityType: entry.entityType,
    sourceId: entry.sourceId,
    targetId: entry.targetId,
    status: entry.status,
    managed,
    expectedItemTypeId: entry.expectedItemTypeId ?? (managed ? null : MODEL_ID),
    requiredAvailability:
      entry.requiredAvailability ??
      ({ current: true, published: defaultPublished } as const),
  };

  plan.legacyIdMappings = {
    formatVersion: 1,
    schema: {
      model: {
        id: MAPPING_MODEL_ID,
        apiKey: 'datocms_content_diff',
        name: 'Content diff',
        modularBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: true,
        draftSavingActive: false,
        allLocalesRequired: false,
        inverseRelationshipsEnabled: false,
        workflowId: null,
        status: schemaStatus,
      },
      nameField: {
        id: MAPPING_NAME_FIELD_ID,
        apiKey: 'name',
        label: 'Name',
        fieldType: 'string',
        localized: false,
        position: 1,
        validators: { required: {}, unique: {} },
        status: schemaStatus,
      },
      mappingField: {
        id: MAPPING_FIELD_ID,
        apiKey: 'mapping',
        label: 'Mapping',
        fieldType: 'json',
        localized: false,
        position: 2,
        validators: { required: {} },
        status: schemaStatus,
      },
    },
    existingMappingRecords:
      entry.status === 'existing'
        ? [{ id: MAPPING_RECORD_ID, hash: chunk.hash }]
        : [],
    entries: [planEntry],
    skippedEntries: [],
    newMappingBatch:
      entry.status === 'new'
        ? {
            batchId: MAPPING_BATCH_ID,
            wholeHash,
            chunks: [chunk],
          }
        : null,
  };
  plan.requiredPermissions.editSchema = schemaStatus === 'new';
  plan.summary.legacyIdMappings = {
    detected: 1,
    existing: entry.status === 'existing' ? 1 : 0,
    created: entry.status === 'new' ? 1 : 0,
    skipped: 0,
    records: entry.status === 'new' ? 1 : 0,
  };
  return plan;
}

function makeStoredLegacyMappingChunk(
  entries: Array<{
    entityType: 'record' | 'block' | 'upload' | 'upload_collection';
    sourceId: string;
    targetId: string;
  }>,
  options: {
    batchId?: string;
    id?: string;
    projectId?: string;
    wholeHash?: string;
    metaOverrides?: Record<string, any>;
  } = {},
): {
  id: string;
  name: string;
  serializedDocument: string;
  hash: string;
  metaOverrides?: Record<string, any>;
} {
  const batchId = options.batchId ?? MAPPING_BATCH_ID;
  const wholeHash =
    options.wholeHash ??
    createHash('sha256').update(stableStringify(entries)).digest('hex');
  const document = {
    formatVersion: 1,
    projectId: options.projectId ?? 'site-id',
    batchId,
    chunkIndex: 0,
    chunkCount: 1,
    wholeHash,
    entries,
  };
  const serializedDocument = JSON.stringify(
    canonicalizeJson(document),
    null,
    2,
  );
  return {
    id: options.id ?? MAPPING_RECORD_ID,
    name: `legacy-id-map:${batchId}:1/1`,
    serializedDocument,
    hash: createHash('sha256').update(serializedDocument).digest('hex'),
    ...(options.metaOverrides
      ? { metaOverrides: structuredClone(options.metaOverrides) }
      : {}),
  };
}

function makeValidatorRelaxationRuntimePlan(
  sourceTitle: string,
  targetTitle: string,
  defaultValue?: string,
  schedules?: RuntimeScheduleState,
): ContentDiffPlan {
  const plan = makeRuntimePlan(sourceTitle, targetTitle, schedules);
  const field = plan.schema.itemTypes
    .flatMap((itemType) => itemType.fields)
    .find(({ id }) => id === 'title-field')!;
  const originalValidators = { required: {} };
  const relaxedValidators = {};
  field.validators = originalValidators;
  if (defaultValue !== undefined) field.defaultValue = defaultValue;
  plan.schema.digest = computeSchemaDigest(plan.schema);
  plan.source.schemaDigest = plan.schema.digest;
  plan.target.schemaDigest = plan.schema.digest;
  plan.options.migrateInvalidContent = true;
  plan.requiredPermissions.editSchema = true;
  plan.execution.revalidateBeforePublishIds = [];

  const relaxedSchema = structuredClone(plan.schema);
  relaxedSchema.itemTypes
    .flatMap((itemType) => itemType.fields)
    .find(({ id }) => id === 'title-field')!.validators = relaxedValidators;
  relaxedSchema.digest = computeSchemaDigest(relaxedSchema);

  const originalHash = semanticHash(originalValidators);
  const relaxedHash = semanticHash(relaxedValidators);
  plan.invalidContent = {
    formatVersion: 1,
    migrateInvalidContent: true,
    schemaStates: {
      originalDigest: plan.schema.digest,
      fullyRelaxedDigest: relaxedSchema.digest,
      partialRelaxationContract: 'per_field_original_or_relaxed',
    },
    detectedRecordIds: [RECORD_ID],
    migratedRecordIds: [RECORD_ID],
    propagatedSkipCount: 0,
    validatorRelaxations: [
      {
        fieldId: 'title-field',
        itemTypeId: MODEL_ID,
        originalValidators,
        relaxedValidators,
        originalHash,
        relaxedHash,
        allowedValidatorHashes: [originalHash, relaxedHash],
        relaxedValidatorKeys: ['required'],
        affectedRecordIds: [RECORD_ID],
        reasons: [
          {
            code: 'INVALID_CURRENT',
            slice: 'current',
            message: 'Test validator relaxation',
            fieldId: 'title-field',
            validatorKey: 'required',
            dependencyChain: [RECORD_ID],
          },
        ],
      },
    ],
    skippedRecords: [],
  };
  return plan;
}

function moveBlockModelToTargetInspection(
  plan: ContentDiffPlan,
): ContentDiffPlan {
  const blockItemType = plan.schema.itemTypes.find(
    ({ id }) => id === BLOCK_MODEL_ID,
  )!;
  plan.schema = {
    ...plan.schema,
    itemTypes: plan.schema.itemTypes.filter(({ id }) => id !== BLOCK_MODEL_ID),
    digest: '',
  };
  plan.schema.digest = computeSchemaDigest(plan.schema);
  plan.source.schemaDigest = plan.schema.digest;
  plan.target.schemaDigest = plan.schema.digest;
  plan.targetInspection = {
    itemTypes: [blockItemType],
    digest: inspectionItemTypesDigest([blockItemType]),
  };
  plan.invalidContent.schemaStates.originalDigest = plan.schema.digest;

  const relaxedValidators = new Map(
    plan.invalidContent.validatorRelaxations.map((entry) => [
      entry.fieldId,
      entry.relaxedValidators,
    ]),
  );
  const relaxedSchema = {
    ...plan.schema,
    itemTypes: plan.schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field) => ({
        ...field,
        validators: relaxedValidators.get(field.id) ?? field.validators,
      })),
    })),
  };
  plan.invalidContent.schemaStates.fullyRelaxedDigest =
    computeSchemaDigest(relaxedSchema);
  return plan;
}

function makeNestedBlockRuntimePlan(
  block: Record<string, any>,
): ContentDiffPlan {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const sourceRecord = canonicalizeRecord(
    makeRecord('unchanged', 'source-version', block),
    null,
    sourceSchema.itemTypes[0],
    sourceSchema,
    { publication: null, unpublishing: null },
  );
  return buildContentDiffPlan(
    makeSnapshot(sourceSchema, sourceRecord),
    makeEmptySnapshot(targetSchema),
    {
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
    },
  );
}

function mutateNestedBlockId(
  value: unknown,
  oldId: string,
  newId: string,
): boolean {
  if (Array.isArray(value)) {
    return value.some((child) => mutateNestedBlockId(child, oldId, newId));
  }
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (object.type === 'item' && object.id === oldId) {
    object.id = newId;
    return true;
  }
  return Object.values(object).some((child) =>
    mutateNestedBlockId(child, oldId, newId),
  );
}

function makePublishedDeleteReleaseRuntimePlan(): ContentDiffPlan {
  const sourceSchema = makeSchema('source');
  const targetSchema = makeSchema('destination');
  const targetInput = makePublishedRecord('obsolete', 'target-version');
  const targetRecord = canonicalizeRecord(
    targetInput,
    targetInput,
    targetSchema.itemTypes[0],
    targetSchema,
    { publication: null, unpublishing: null },
  );
  const plan = buildContentDiffPlan(
    makeEmptySnapshot(sourceSchema),
    makeSnapshot(targetSchema, targetRecord),
    {
      includeDeletions: true,
      uploads: 'referenced',
      migrateInvalidContent: false,
    },
  );
  const recordPlan = plan.records[0];
  const releaseFields = recordPlan.baseline!.published!.fields;
  const intermediateCurrentHash = semanticHash(releaseFields);
  recordPlan.allowedIntermediateHashes.push(intermediateCurrentHash);
  plan.execution.deleteReleases.push({
    recordId: recordPlan.id,
    fields: releaseFields,
    intermediateCurrentHash,
    publish: true,
    transientNestedBlockIds: [],
  });
  const permissions = plan.requiredPermissions.itemTypes.find(
    ({ id }) => id === recordPlan.itemTypeId,
  )!;
  permissions.actions = [
    ...new Set([...permissions.actions, 'update' as const, 'publish' as const]),
  ];
  return plan;
}

function makeReparentRuntimePlan(): ContentDiffPlan {
  const sourceSchema = makeSchema('source', { tree: true });
  const targetSchema = makeSchema('destination', { tree: true });
  const sourceRecord = canonicalizeRecord(
    makeRecord('unchanged', 'source-version', undefined, {
      parentId: EXTERNAL_PARENT_ID,
      position: 3,
    }),
    null,
    sourceSchema.itemTypes[0],
    sourceSchema,
    { publication: null, unpublishing: null },
  );
  const targetRecord = canonicalizeRecord(
    makeRecord('unchanged', 'target-version', undefined, {
      parentId: null,
      position: 1,
    }),
    null,
    targetSchema.itemTypes[0],
    targetSchema,
    { publication: null, unpublishing: null },
  );
  const source = makeSnapshot(sourceSchema, sourceRecord);
  const target = makeSnapshot(targetSchema, targetRecord);
  source.visibleRecordIds.push(EXTERNAL_PARENT_ID);
  target.visibleRecordIds.push(EXTERNAL_PARENT_ID);
  const plan = buildContentDiffPlan(source, target, {
    includeDeletions: false,
    uploads: 'referenced',
    migrateInvalidContent: false,
  });
  plan.warnings.push({
    code: 'ABSOLUTE_POSITION_NOT_REPRODUCIBLE',
    message:
      'A retained destination-only sibling makes the intermediate end position unknowable.',
    entityIds: ['retained-sibling'],
  });
  return plan;
}

function makeSnapshot(
  schema: SchemaSnapshot,
  record: ReturnType<typeof canonicalizeRecord>,
): ContentSnapshot {
  return makeSnapshotWithRecords(schema, [record]);
}

function makeSnapshotWithRecords(
  schema: SchemaSnapshot,
  recordList: readonly ReturnType<typeof canonicalizeRecord>[],
): ContentSnapshot {
  const records = Object.fromEntries(
    recordList.map((record) => [record.id, record]),
  );

  return {
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    siteId: schema.siteId,
    environmentId: schema.environmentId,
    capturedAt: '2026-01-01T00:00:00.000Z',
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
    visibleRecordIds: recordList.map(({ id }) => id).sort(),
    blockOwnership: buildBlockOwnershipIndex(records, schema),
    digest: semanticHash({
      records: Object.fromEntries(
        recordList.map((record) => [record.id, record.hash]),
      ),
    }),
  };
}

function makeEmptySnapshot(schema: SchemaSnapshot): ContentSnapshot {
  return {
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    siteId: schema.siteId,
    environmentId: schema.environmentId,
    capturedAt: '2026-01-01T00:00:00.000Z',
    schema,
    inspection: {
      itemTypes: [],
      digest: semanticHash({ itemTypes: [] }),
      structuralIssues: [],
    },
    scope: { itemTypeIds: [MODEL_ID], uploads: 'referenced' },
    readItemTypes: [{ id: MODEL_ID, workflowId: null }],
    records: {},
    uploads: {},
    uploadCollections: {},
    visibleRecordIds: [],
    blockOwnership: {},
    digest: semanticHash({ records: {} }),
  };
}

function makeSchema(
  environmentId: string,
  options: { sortable?: boolean; tree?: boolean } = {},
): SchemaSnapshot {
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
        apiKey: 'article',
        name: 'Article',
        modularBlock: false,
        singleton: false,
        sortable: options.sortable === true,
        tree: options.tree === true,
        draftModeActive: true,
        draftSavingActive: true,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: 'title-field',
            apiKey: 'title',
            fieldType: 'string',
            localized: false,
            position: 1,
            validators: {},
          },
          {
            id: 'content-field',
            apiKey: 'content',
            fieldType: 'single_block',
            localized: false,
            position: 2,
            validators: {},
          },
        ],
      },
      {
        id: BLOCK_MODEL_ID,
        apiKey: 'text_block',
        name: 'Text block',
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
            id: 'block-text-field',
            apiKey: 'text',
            fieldType: 'string',
            localized: false,
            position: 1,
            validators: {},
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

function makeStructuredTextProjectionSchema(
  environmentId: string,
): SchemaSnapshot {
  const structuredTextLinks = {
    structured_text_links: { item_types: [MODEL_ID] },
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
    itemTypes: [
      {
        id: MODEL_ID,
        apiKey: 'article',
        name: 'Article',
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
            id: 'cycle-body-field',
            apiKey: 'body',
            fieldType: 'structured_text',
            localized: true,
            position: 1,
            validators: {
              required: {},
              length: { min: 1 },
              ...structuredTextLinks,
            },
          },
          {
            id: 'safe-body-field',
            apiKey: 'safe_body',
            fieldType: 'structured_text',
            localized: true,
            position: 2,
            validators: {
              required: {},
              length: { min: 1 },
              ...structuredTextLinks,
            },
          },
          {
            id: 'blocks-field',
            apiKey: 'blocks',
            fieldType: 'structured_text',
            localized: false,
            position: 3,
            validators: {
              structured_text_blocks: { item_types: [BLOCK_MODEL_ID] },
            },
          },
        ],
      },
      {
        id: BLOCK_MODEL_ID,
        apiKey: 'embedded',
        name: 'Embedded',
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
            id: 'block-cycle-body-field',
            apiKey: 'body',
            fieldType: 'structured_text',
            localized: false,
            position: 1,
            validators: {
              required: {},
              length: { min: 1 },
              ...structuredTextLinks,
            },
          },
        ],
      },
    ],
    workflows: [],
    digest: '',
  };
  schema.itemTypes.sort((left, right) => left.id.localeCompare(right.id));
  schema.digest = computeSchemaDigest(schema);
  return schema;
}

function makeStructuredTextProjectionRecord(
  schema: SchemaSnapshot,
  id: string,
  targetId: string,
  blockId: string,
) {
  const emptyReferences = (locale: string) =>
    makeStructuredTextDocument([
      {
        type: 'paragraph',
        children: [
          { type: 'span', value: '' },
          { type: 'inlineItem', item: targetId },
          {
            type: 'itemLink',
            item: targetId,
            children: [{ type: 'span', value: `linked ${locale}` }],
          },
        ],
      },
    ]);
  const safeReferences = (locale: string) =>
    makeStructuredTextDocument([
      {
        type: 'paragraph',
        children: [
          { type: 'span', value: `safe ${locale}` },
          { type: 'inlineItem', item: targetId },
          {
            type: 'itemLink',
            item: targetId,
            children: [{ type: 'span', value: `linked ${locale}` }],
          },
        ],
      },
    ]);
  const item = {
    id,
    type: 'item',
    item_type: { id: MODEL_ID, type: 'item_type' },
    body: { en: emptyReferences('en'), it: emptyReferences('it') },
    safe_body: { en: safeReferences('en'), it: safeReferences('it') },
    blocks: makeStructuredTextDocument([
      {
        type: 'block',
        item: {
          id: blockId,
          type: 'item',
          item_type: { id: BLOCK_MODEL_ID, type: 'item_type' },
          body: emptyReferences('nested'),
        },
      },
    ]),
    meta: {
      created_at: '2025-01-01T00:00:00Z',
      first_published_at: null,
      current_version: `version-${id}`,
      updated_at: '2025-01-01T00:00:00Z',
      published_at: null,
      stage: null,
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: null,
    },
  };
  const itemType = schema.itemTypes.find(
    ({ id: typeId }) => typeId === MODEL_ID,
  )!;

  return canonicalizeRecord(item, null, itemType, schema, {
    publication: null,
    unpublishing: null,
  });
}

function makeStructuredTextDocument(children: readonly unknown[]) {
  return {
    schema: 'dast',
    document: { type: 'root', children },
  };
}

function makeGeneratedBlockOwnershipContext(
  count: number,
  find: (id: string, query: Record<string, any>) => Promise<any>,
) {
  const schema = makeSchema('source');
  schema.itemTypes[0].fields.find(
    (field) => field.apiKey === 'content',
  )!.fieldType = 'rich_text';
  const blocks = Array.from({ length: count }, (_, index) => ({
    ...makeNestedBlock(),
    id: generatedId(`ownership:${index}`),
  }));
  const schemaById = new Map(schema.itemTypes.map((type) => [type.id, type]));
  return {
    client: {
      items: {
        find,
        rawList: async () => {
          throw new Error('Block ownership must use individual lookups');
        },
      },
    },
    schemaById,
    captureSchemaById: schemaById,
    initialRecords: new Map<string, any>(),
    plan: {
      records: [
        {
          id: RECORD_ID,
          itemTypeId: MODEL_ID,
          baseline: null,
          desired: {
            current: { fields: { content: blocks } },
            published: null,
          },
        },
      ],
    },
  };
}

function makeGeneratedFreshIdRuntimeCase(
  pair: (typeof EMBEDDING_KINDS)[number][],
  scenario:
    | 'unused-update'
    | 'unused-split-update'
    | 'create-split'
    | 'unpublish-reintroduce'
    | 'publish-reintroduce',
  options: {
    modelValidating?: boolean;
    validateExistingError?: Error;
    changeVersionAfterValidation?: boolean;
    occupyFreshIdAfterInitialRead?: boolean;
  } = {},
) {
  const path = [
    ...pair,
    'block',
    'single_block',
    'inlineBlock',
  ] as (typeof EMBEDDING_KINDS)[number][];
  const fixtureOptions = {
    withUploads: false,
    wireJson: true,
    sharedPeer: true,
  };
  const fixture = generatedRecursiveFixture(path, 0, fixtureOptions);
  const current = generatedRecursiveFixture(path, 2, fixtureOptions);
  const publication = generatedRecursiveFixture(path, 1, fixtureOptions);
  const leaf = fixture.slots.find(
    (slot) =>
      slot.path.length ===
      Math.max(...fixture.slots.map((entry) => entry.path.length)),
  )!;
  const baselineFields = structuredClone(fixture.canonicalFields);
  const desiredFields = structuredClone(current.canonicalFields);
  let baselinePublished: JsonObject | null = null;
  let desiredPublished: JsonObject | null = null;
  const id = (name: string) =>
    generatedId(`${fixture.label}:${scenario}:${name}`);
  valueAt(desiredFields, leaf.path).id = id('new-current');
  if (scenario === 'unused-split-update') {
    baselinePublished = structuredClone(baselineFields);
    desiredPublished = structuredClone(publication.canonicalFields);
    valueAt(desiredPublished, leaf.path).id = id('new-published');
  } else if (scenario === 'create-split') {
    desiredPublished = structuredClone(publication.canonicalFields);
  } else if (scenario === 'unpublish-reintroduce') {
    baselinePublished = structuredClone(publication.canonicalFields);
    valueAt(baselineFields, leaf.path).id = id('baseline-current');
    valueAt(desiredFields, leaf.path).id = leaf.id;
  } else if (scenario === 'publish-reintroduce') {
    baselinePublished = structuredClone(baselineFields);
    desiredPublished = structuredClone(publication.canonicalFields);
    valueAt(desiredPublished, leaf.path).id = id('new-published');
    valueAt(desiredFields, leaf.path).id = leaf.id;
  }
  const record = (fields: JsonObject, published: JsonObject | null) => {
    const input = fixture.resource(fields);
    if (published)
      Object.assign(input.meta, {
        is_published_version_valid: true,
        first_published_at: '2025-01-01T00:00:00Z',
        published_at: '2025-01-01T00:00:00Z',
      });
    return canonicalizeRecord(
      input,
      published ? fixture.resource(published) : null,
      fixture.schema.itemTypes[0],
      fixture.schema,
      { publication: null, unpublishing: null },
    );
  };
  const source = makeSnapshot(
    fixture.schema,
    record(desiredFields, desiredPublished),
  );
  const targetSchema = { ...fixture.schema, environmentId: 'destination' };
  const target =
    scenario === 'create-split'
      ? makeEmptySnapshot(targetSchema)
      : makeSnapshot(targetSchema, record(baselineFields, baselinePublished));
  source.visibleRecordIds.push(EXTERNAL_PARENT_ID);
  target.visibleRecordIds.push(EXTERNAL_PARENT_ID);
  const plan = buildContentDiffPlan(source, target, {
    includeDeletions: false,
    uploads: 'referenced',
    migrateInvalidContent: false,
  });
  return {
    plan,
    leaf,
    desiredFields,
    desiredPublished,
    mock: makeGeneratedRecursiveRuntimeClient(
      fixture,
      scenario === 'create-split' ? null : baselineFields,
      baselinePublished,
      {
        ...options,
        lateOccupiedId: options.occupyFreshIdAfterInitialRead
          ? valueAt(desiredFields, leaf.path).id
          : undefined,
      },
    ),
  };
}

function makeGeneratedRecursiveRuntimeClient(
  fixture: ReturnType<typeof generatedRecursiveFixture>,
  initialFields: JsonObject | null,
  initialPublished: JsonObject | null,
  options: {
    currentValid?: boolean;
    modelValidating?: boolean;
    validateExistingError?: Error;
    changeVersionAfterValidation?: boolean;
    lateOccupiedId?: string;
  } = {},
) {
  const mock = makeRuntimeClient('baseline');
  const client = mock.client as any;
  let fields = structuredClone(initialFields);
  let published = structuredClone(initialPublished);
  let writes = 0;
  const validatedPayloads: JsonObject[] = [];
  let versionOffset = 0;
  let lateOccupiedReads = 0;
  let firstPublishedAt: string | null = published
    ? '2025-01-01T00:00:00Z'
    : null;
  const missing = () =>
    Object.assign(new Error('not found'), { response: { status: 404 } });
  const resource = (selected = fields): Record<string, any> => {
    if (!selected) throw missing();
    const value = fixture.resource(structuredClone(selected));
    Object.assign(value.meta, {
      current_version: `live-${writes + versionOffset}`,
      first_published_at: firstPublishedAt,
      published_at: published ? '2025-01-01T00:00:00Z' : null,
      is_published_version_valid: published ? true : null,
      is_current_version_valid: options.currentValid !== false,
    });
    return value;
  };
  const originalSiteFind = client.site.find.bind(client.site);
  client.site.find = async () => ({
    ...(await originalSiteFind()),
    locales: fixture.schema.locales,
  });
  client.itemTypes.list = async () =>
    fixture.schema.itemTypes.map((type) => ({
      id: type.id,
      name: type.name,
      api_key: type.apiKey,
      modular_block: type.modularBlock,
      singleton: false,
      sortable: false,
      tree: false,
      draft_mode_active: type.draftModeActive,
      draft_saving_active: type.draftSavingActive,
      all_locales_required: false,
      workflow: null,
    }));
  client.fields.list = async (id: string) =>
    fixture.schema.itemTypes
      .find((type) => type.id === id)!
      .fields.map((field) => ({
        id: field.id,
        api_key: field.apiKey,
        field_type: field.fieldType,
        localized: field.localized,
        position: field.position,
        validators: field.validators,
        default_value: null,
      }));
  client.items.find = async (id: string, query: { version?: string } = {}) => {
    if (id === EXTERNAL_PARENT_ID)
      return {
        ...makePublishedRecord('Retained dependency', 'external-version'),
        id,
      };
    if (id === RECORD_ID)
      return resource(query.version === 'published' ? published : fields);
    if (id === options.lateOccupiedId) {
      lateOccupiedReads += 1;
      if (lateOccupiedReads > 1)
        return {
          id,
          type: 'item',
          item_type: { id: MODEL_ID, type: 'item_type' },
        };
    }
    for (const version of [fields, published]) {
      if (!version) continue;
      const slot = fixture.slots.find(
        (entry) => valueAt(version, entry.path).id === id,
      );
      if (slot) return structuredClone(valueAt(version, slot.path));
    }
    throw missing();
  };
  client.items.rawList = async (query: any) => {
    const data =
      fields && query.filter.ids.split(',').includes(RECORD_ID)
        ? [
            {
              id: RECORD_ID,
              type: 'item',
              attributes: structuredClone(fields),
              relationships: {
                item_type: { data: { id: MODEL_ID, type: 'item_type' } },
              },
              meta: resource().meta,
            },
          ]
        : [];
    return { data, meta: { total_count: data.length } };
  };
  client.items.listPagedIterator = async function* () {
    if (fields) yield resource();
  };
  const bodyFields = (body: any): JsonObject =>
    Object.fromEntries(
      fixture.schema.itemTypes[0].fields
        .filter((field) =>
          Object.prototype.hasOwnProperty.call(body, field.apiKey),
        )
        .map((field) => [field.apiKey, body[field.apiKey]]),
    );
  client.items.create = async (body: any) => {
    expect(fields).to.equal(null);
    expect(body.id).to.equal(RECORD_ID);
    fields = structuredClone(bodyFields(body));
    firstPublishedAt = body.meta?.first_published_at ?? null;
    writes += 1;
    return resource();
  };
  const validateProjection = (body: any) => {
    const persistedIds = new Set(
      fixture.slots.map((slot) => valueAt(fields, slot.path).id),
    );
    const publishedIds = new Set(
      published
        ? fixture.slots.map((slot) => valueAt(published, slot.path).id)
        : [],
    );
    const nextFields = expandGeneratedPatch(
      { ...fields, ...bodyFields(body) },
      fields!,
      fixture.slots,
      true,
    );
    for (const slot of fixture.slots) {
      const nextBlock = valueAt(nextFields, slot.path);
      if (persistedIds.has(nextBlock.id)) continue;
      if (options.currentValid === false || options.modelValidating)
        throw missing();
      expect(
        publishedIds.has(nextBlock.id),
        'A published-only block still occupies its ID',
      ).to.equal(false);
      expect(nextBlock.relationships.item_type.data.id).to.equal(
        slot.itemTypeId,
      );
    }
    return nextFields;
  };
  client.items.validateExisting = async (id: string, body: any) => {
    expect(id).to.equal(RECORD_ID);
    validatedPayloads.push(structuredClone(body));
    if (options.validateExistingError) throw options.validateExistingError;
    validateProjection(body);
    if (options.changeVersionAfterValidation) versionOffset += 1;
  };
  client.items.update = async (id: string, body: any) => {
    expect(id).to.equal(RECORD_ID);
    expect(body.meta.current_version).to.equal(
      `live-${writes + versionOffset}`,
    );
    const nextFields = validateProjection(body);
    if (Object.prototype.hasOwnProperty.call(body.meta, 'first_published_at'))
      firstPublishedAt = body.meta.first_published_at;
    fields = nextFields;
    writes += 1;
    return resource();
  };
  client.items.publish = async (id: string) => {
    expect(id).to.equal(RECORD_ID);
    published = structuredClone(fields);
    firstPublishedAt ??= '2025-01-01T00:00:00Z';
    writes += 1;
    return resource();
  };
  client.items.unpublish = async () => {
    published = null;
    writes += 1;
    return resource();
  };
  return {
    client: client as CmaClient.Client,
    fields: () => fields,
    publishedFields: () => published,
    writes: () => writes,
    validatedPayloads,
  };
}

function makeRawRecordShell(id: string, position = 1): Record<string, any> {
  return {
    id,
    type: 'item',
    attributes: { position, parent_id: null },
    relationships: { item_type: { data: { id: MODEL_ID, type: 'item_type' } } },
    meta: { publication_scheduled_at: null, unpublishing_scheduled_at: null },
  };
}

function makeShellSweepContext(client: Record<string, any>, ids: string[]) {
  return {
    client,
    schedulesQuiesced: true,
    schemaById: new Map([[MODEL_ID, { id: MODEL_ID, sortable: true }]]),
    plan: {
      records: ids.map((id) => ({ id, itemTypeId: MODEL_ID })),
      schema: { locales: ['en'] },
    },
  };
}

function makeRecord(
  title: string,
  version: string,
  content?: Record<string, any> | null,
  topology?: { parentId: string | null; position: number },
): Record<string, any> {
  return Object.assign(
    {
      id: RECORD_ID,
      type: 'item',
      item_type: { id: MODEL_ID, type: 'item_type' },
      title,
      meta: {
        created_at: '2025-01-01T00:00:00Z',
        first_published_at: null,
        current_version: version,
        updated_at: '2025-01-01T00:00:00Z',
        published_at: null,
        stage: null,
        is_valid: true,
        is_current_version_valid: true,
        is_published_version_valid: null,
      },
    },
    content === undefined ? {} : { content },
    topology
      ? { parent_id: topology.parentId, position: topology.position }
      : {},
  );
}

function makePublishedRecord(
  title: string,
  version: string,
): Record<string, any> {
  const record = makeRecord(title, version);
  record.meta.first_published_at = '2025-01-01T00:00:00Z';
  record.meta.published_at = '2025-01-01T00:00:00Z';
  record.meta.is_published_version_valid = true;
  return record;
}

function makeNestedBlock(): Record<string, any> {
  return {
    id: BLOCK_ID,
    type: 'item',
    attributes: { text: 'Already created' },
    relationships: {
      item_type: { data: { id: BLOCK_MODEL_ID, type: 'item_type' } },
    },
  };
}

function makeUploadState(
  md5: string,
  filename: string,
  basename: string,
  notes: string,
): Record<string, any> {
  return {
    md5,
    filename,
    basename,
    manual: {
      author: null,
      copyright: null,
      notes,
      defaultFieldMetadata: emptyUploadDefaultFieldMetadata(),
      tags: [],
      collectionId: null,
    },
  };
}

function emptyUploadDefaultFieldMetadata(
  locales: readonly string[] = ['en'],
): UploadSnapshot['manual']['defaultFieldMetadata'] {
  return {
    alt: Object.fromEntries(locales.map((locale) => [locale, null])),
    title: Object.fromEntries(locales.map((locale) => [locale, null])),
    custom_data: Object.fromEntries(locales.map((locale) => [locale, {}])),
    focal_point: null,
    poster_time: null,
  };
}

function refreshUploadSnapshotHash(upload: UploadSnapshot): void {
  upload.hash = semanticHash({
    id: upload.id,
    md5: upload.md5,
    basename: upload.basename,
    filename: upload.filename,
    manual: upload.manual,
  });
}

function makeExistingUpload(id: string): Record<string, any> {
  return {
    id,
    type: 'upload',
    md5: 'd41d8cd98f00b204e9800998ecf8427e',
    basename: 'asset',
    filename: 'asset.bin',
    size: 1,
    mime_type: 'application/octet-stream',
    author: null,
    copyright: null,
    notes: null,
    default_field_metadata: emptyUploadDefaultFieldMetadata(),
    tags: [],
    upload_collection: null,
    url: 'https://assets.example/asset.bin',
    updated_at: null,
    meta: { antivirus: { status: 'clean' } },
  };
}

function makeCollectionState(
  id: string,
  position: number,
): Record<string, any> {
  const state = { id, label: id, parentId: null, position };
  return { ...state, hash: semanticHash(state) };
}

function makeLegacyMappingModel(
  id: string,
  overrides: Record<string, any> = {},
  titleFieldId: string | null = null,
): Record<string, any> {
  return {
    id,
    name: 'Content diff',
    api_key: 'datocms_content_diff',
    modular_block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draft_mode_active: true,
    draft_saving_active: false,
    all_locales_required: false,
    inverse_relationships_enabled: false,
    collection_appearance: 'compact',
    ordering_direction: null,
    ordering_meta: null,
    hint: null,
    has_singleton_item: false,
    ordering_field: null,
    presentation_title_field: titleFieldId
      ? { id: titleFieldId, type: 'field' }
      : null,
    presentation_image_field: null,
    title_field: titleFieldId ? { id: titleFieldId, type: 'field' } : null,
    image_preview_field: null,
    excerpt_field: null,
    singleton_item: null,
    workflow: null,
    ...structuredClone(overrides),
  };
}

function makeLegacyMappingNameField(
  id: string,
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    id,
    label: 'Name',
    api_key: 'name',
    field_type: 'string',
    localized: false,
    position: 1,
    validators: { required: {}, unique: {} },
    appearance: {
      addons: [],
      editor: 'single_line',
      parameters: { heading: false, placeholder: null },
    },
    default_value: null,
    hint: null,
    deep_filtering_enabled: false,
    content_link_enabled: true,
    fieldset: null,
    ...structuredClone(overrides),
  };
}

function makeLegacyMappingField(
  id: string,
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    id,
    label: 'Mapping',
    api_key: 'mapping',
    field_type: 'json',
    localized: false,
    position: 2,
    validators: { required: {} },
    appearance: { addons: [], editor: 'json', parameters: {} },
    default_value: null,
    hint: null,
    deep_filtering_enabled: false,
    content_link_enabled: true,
    fieldset: null,
    ...structuredClone(overrides),
  };
}

function makeLegacyMappingSchemaMenuItems(
  modelId: string,
  drift?: 'missing' | 'duplicate' | 'child',
): Record<string, any>[] {
  if (drift === 'missing') return [];
  const root = {
    id: 'mapping-schema-menu',
    kind: 'item_type',
    item_type: { id: modelId, type: 'item_type' },
    parent: null,
  };
  if (drift === 'duplicate') {
    return [
      root,
      {
        ...root,
        id: 'mapping-schema-menu-duplicate',
      },
    ];
  }
  if (drift === 'child') {
    return [
      root,
      {
        id: 'mapping-schema-child',
        kind: 'item_type',
        item_type: null,
        parent: { id: root.id, type: 'schema_menu_item' },
      },
    ];
  }
  return [root];
}

function makeLegacyMappingRecord(
  input: {
    id: string;
    name: string;
    serializedDocument: string;
    metaOverrides?: Record<string, any>;
  },
  modelId: string,
): Record<string, any> {
  return {
    id: input.id,
    type: 'item',
    item_type: { id: modelId, type: 'item_type' },
    name: input.name,
    mapping: input.serializedDocument,
    meta: {
      current_version: `mapping-version-${input.id}`,
      status: 'draft',
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: null,
      stage: null,
      publication_scheduled_at: null,
      unpublishing_scheduled_at: null,
      published_at: null,
      first_published_at: null,
      ...structuredClone(input.metaOverrides ?? {}),
    },
  };
}

function makeRuntimeClient(
  initialTitle: string,
  options: {
    content?: Record<string, any> | null;
    detachedBlock?: Record<string, any>;
    recordAbsent?: boolean;
    published?: boolean;
    separatePublishedVersion?: boolean;
    allowPublication?: boolean;
    validateExistingError?: Error;
    tree?: boolean;
    parentId?: string | null;
    position?: number;
    externalParent?: boolean;
    externalParentPublished?: boolean;
    externalParentItemTypeId?: string;
    occupiedLegacyItemIds?: string[];
    recordFields?: Record<string, any>;
    existingUploadIds?: string[];
    existingCollectionIds?: string[];
    migrationsTrackingModel?: 'exact' | 'invalid';
    fieldDefaultValues?: Record<string, unknown>;
    allowRecordCreate?: boolean;
    noDraft?: boolean;
    failIfCreateDefaultActive?: boolean;
    recordCreateError?: Error;
    environmentSemantics?: Partial<{
      timezone: string;
      improvedTimezoneManagement: boolean;
      improvedBooleanFields: boolean;
      improvedValidationAtPublishing: boolean;
      millisecondsInDatetime: boolean;
      nonLocalizedFocalPoints: boolean;
      improvedHexManagement: boolean;
    }>;
    siteId?: string;
    fieldValidators?: Record<string, Record<string, any>>;
    primary?: boolean;
    updateError?: Error;
    omitConfiguredEnvironment?: boolean;
    events?: string[];
    schedules?: RuntimeScheduleState;
    traceReads?: boolean;
    identity?: Record<string, any>;
    legacyMapping?: {
      schemaState?: 'absent' | 'model-only' | 'name-only' | 'complete';
      modelId?: string;
      records?: Array<{
        id: string;
        name: string;
        serializedDocument: string;
        metaOverrides?: Record<string, any>;
      }>;
      modelOverrides?: Record<string, any>;
      nameFieldOverrides?: Record<string, any>;
      mappingFieldOverrides?: Record<string, any>;
      fieldIdCollision?: {
        id: string;
        apiKey: string;
        itemTypeId: string;
      };
      itemTypeNameCollision?: boolean;
      schemaMenuDrift?: 'missing' | 'duplicate' | 'child';
      contentMenuReference?: boolean;
      filterReference?: boolean;
      deleteRecordsOnContentUpdate?: boolean;
      replaceRecordsOnContentUpdate?: Array<{
        id: string;
        name: string;
        serializedDocument: string;
        metaOverrides?: Record<string, any>;
      }>;
    };
  } = {},
): {
  client: CmaClient.Client;
  current: () => Record<string, any>;
  mutations: { update: number };
  schemaMutations: { update: number };
  mappingMutations: {
    modelCreate: number;
    fieldCreate: number;
    recordCreate: number;
  };
  mappingRecords: () => Array<Record<string, any>>;
  fieldValidators: (fieldId: string) => Record<string, any>;
  fieldDefaultValue: (fieldId: string) => unknown;
  recordCreates: () => number;
  schedules: () => RuntimeScheduleState;
  reads: { site: number; validateExisting: number };
} {
  let current = options.published
    ? makePublishedRecord(initialTitle, 'live-version-1')
    : makeRecord(
        initialTitle,
        'live-version-1',
        options.content,
        options.tree
          ? {
              parentId: options.parentId ?? null,
              position: options.position ?? 1,
            }
          : undefined,
      );
  if (options.recordFields) {
    current = { ...current, ...structuredClone(options.recordFields) };
  }
  let recordExists = options.recordAbsent !== true;
  let recordPublished = options.published === true;
  let schedules: RuntimeScheduleState = structuredClone(
    options.schedules ?? { publication: null, unpublishing: null },
  );
  const syncScheduleMeta = () => {
    current.meta.publication_scheduled_at = schedules.publication?.at ?? null;
    current.meta.unpublishing_scheduled_at = schedules.unpublishing?.at ?? null;
  };
  syncScheduleMeta();
  const separatePublishedVersion =
    options.separatePublishedVersion === true && recordPublished;
  let publishedCurrent = separatePublishedVersion
    ? structuredClone(current)
    : null;
  let recordCreateCount = 0;
  const mutations = { update: 0 };
  const schemaMutations = { update: 0 };
  const mappingMutations = {
    modelCreate: 0,
    fieldCreate: 0,
    recordCreate: 0,
  };
  const mappingOptions = options.legacyMapping;
  const initialMappingSchemaState = mappingOptions?.schemaState ?? 'absent';
  const initialMappingModelId = mappingOptions?.modelId ?? MAPPING_MODEL_ID;
  let mappingModel: Record<string, any> | null =
    initialMappingSchemaState === 'absent'
      ? null
      : makeLegacyMappingModel(
          initialMappingModelId,
          mappingOptions?.modelOverrides,
          initialMappingSchemaState === 'name-only' ||
            initialMappingSchemaState === 'complete'
            ? MAPPING_NAME_FIELD_ID
            : null,
        );
  const mappingFields = new Map<string, Record<string, any>>();
  if (
    initialMappingSchemaState === 'name-only' ||
    initialMappingSchemaState === 'complete'
  ) {
    const field = makeLegacyMappingNameField(
      MAPPING_NAME_FIELD_ID,
      mappingOptions?.nameFieldOverrides,
    );
    mappingFields.set(field.id, field);
  }
  if (initialMappingSchemaState === 'complete') {
    const field = makeLegacyMappingField(
      MAPPING_FIELD_ID,
      mappingOptions?.mappingFieldOverrides,
    );
    mappingFields.set(field.id, field);
  }
  const storedMappingRecords = new Map<string, Record<string, any>>(
    (mappingOptions?.records ?? []).map((record) => [
      record.id,
      makeLegacyMappingRecord(record, initialMappingModelId),
    ]),
  );
  let mappingSchemaMenuItems: Record<string, any>[] = mappingModel
    ? makeLegacyMappingSchemaMenuItems(
        mappingModel.id,
        mappingOptions?.schemaMenuDrift,
      )
    : [];
  const validatorState = new Map<string, Record<string, any>>(
    Object.entries(options.fieldValidators ?? {}).map(([id, validators]) => [
      id,
      structuredClone(validators),
    ]),
  );
  const defaultValueState = new Map<string, unknown>(
    Object.entries(options.fieldDefaultValues ?? {}).map(([id, value]) => [
      id,
      structuredClone(value),
    ]),
  );
  const reads = { site: 0, validateExisting: 0 };
  const forbiddenMutation = (name: string) => async () => {
    throw new Error(`Unexpected ${name} mutation`);
  };
  const notFound = () => {
    const error = new Error('not found') as Error & {
      response: { status: number };
    };
    error.response = { status: 404 };
    return error;
  };

  const client = {
    ...(options.omitConfiguredEnvironment
      ? {}
      : { config: { environment: 'destination-fork' } }),
    site: {
      find: async () => {
        if (options.traceReads) options.events?.push('site-read');
        reads.site += 1;
        return {
          id: options.siteId ?? 'site-id',
          locales: ['en'],
          timezone: options.environmentSemantics?.timezone ?? 'UTC',
          meta: {
            improved_timezone_management:
              options.environmentSemantics?.improvedTimezoneManagement ?? true,
            improved_boolean_fields:
              options.environmentSemantics?.improvedBooleanFields ?? true,
            improved_validation_at_publishing:
              options.environmentSemantics?.improvedValidationAtPublishing ??
              true,
            milliseconds_in_datetime:
              options.environmentSemantics?.millisecondsInDatetime ?? true,
            non_localized_focal_points:
              options.environmentSemantics?.nonLocalizedFocalPoints ?? true,
            improved_hex_management:
              options.environmentSemantics?.improvedHexManagement ?? true,
          },
        };
      },
    },
    itemTypes: {
      list: async () => [
        {
          id: MODEL_ID,
          name: 'Article',
          api_key: 'article',
          modular_block: false,
          singleton: false,
          sortable: false,
          tree: options.tree === true,
          draft_mode_active: options.noDraft !== true,
          draft_saving_active: true,
          all_locales_required: false,
          workflow: null,
        },
        {
          id: BLOCK_MODEL_ID,
          name: mappingOptions?.itemTypeNameCollision
            ? 'Content diff'
            : 'Text block',
          api_key: 'text_block',
          modular_block: true,
          singleton: false,
          sortable: false,
          tree: false,
          draft_mode_active: false,
          draft_saving_active: false,
          all_locales_required: false,
          workflow: null,
        },
        ...(options.migrationsTrackingModel
          ? [
              {
                id: MIGRATIONS_MODEL_ID,
                name: 'Schema migration',
                api_key: 'schema_migration',
                modular_block: false,
                singleton: false,
                sortable: false,
                tree: false,
                draft_mode_active: false,
                draft_saving_active: false,
                all_locales_required: false,
                workflow: null,
              },
            ]
          : []),
        ...(mappingModel ? [structuredClone(mappingModel)] : []),
      ],
      create: async (body: Record<string, any>) => {
        if (body.api_key !== 'datocms_content_diff' || mappingModel) {
          throw new Error('Unexpected mapping model create');
        }
        mappingMutations.modelCreate += 1;
        options.events?.push('mapping-model-create');
        mappingModel = makeLegacyMappingModel(body.id);
        mappingSchemaMenuItems = makeLegacyMappingSchemaMenuItems(body.id);
        return structuredClone(mappingModel);
      },
    },
    fields: {
      find: async (fieldId: string) => {
        const mappingField = mappingFields.get(fieldId);
        if (mappingField && mappingModel) {
          return {
            ...structuredClone(mappingField),
            item_type: { id: mappingModel.id, type: 'item_type' },
          };
        }
        if (mappingOptions?.fieldIdCollision?.id === fieldId) {
          return {
            id: fieldId,
            api_key: mappingOptions.fieldIdCollision.apiKey,
            item_type: {
              id: mappingOptions.fieldIdCollision.itemTypeId,
              type: 'item_type',
            },
          };
        }
        throw notFound();
      },
      list: async (itemTypeId: string) => {
        if (itemTypeId === MIGRATIONS_MODEL_ID) {
          return [
            {
              id: MIGRATIONS_NAME_FIELD_ID,
              api_key:
                options.migrationsTrackingModel === 'invalid'
                  ? 'not_name'
                  : 'name',
              field_type: 'string',
              localized: false,
              position: 1,
              default_value: null,
              validators: { required: {} },
            },
          ];
        }
        if (mappingModel && itemTypeId === mappingModel.id) {
          return Array.from(mappingFields.values())
            .sort((left, right) => left.position - right.position)
            .map((field) => structuredClone(field));
        }
        return itemTypeId === BLOCK_MODEL_ID
          ? [
              {
                id: 'block-text-field',
                api_key: 'text',
                field_type: 'string',
                localized: false,
                position: 1,
                default_value: defaultValueState.has('block-text-field')
                  ? structuredClone(defaultValueState.get('block-text-field'))
                  : null,
                validators: structuredClone(
                  validatorState.get('block-text-field') ?? {},
                ),
              },
            ]
          : [
              {
                id: 'title-field',
                api_key: 'title',
                field_type: 'string',
                localized: false,
                position: 1,
                default_value: defaultValueState.has('title-field')
                  ? structuredClone(defaultValueState.get('title-field'))
                  : null,
                validators: structuredClone(
                  validatorState.get('title-field') ?? {},
                ),
              },
              {
                id: 'content-field',
                api_key: 'content',
                field_type: 'single_block',
                localized: false,
                position: 2,
                default_value: defaultValueState.has('content-field')
                  ? structuredClone(defaultValueState.get('content-field'))
                  : null,
                validators: structuredClone(
                  validatorState.get('content-field') ?? {},
                ),
              },
              ...(options.recordFields &&
              Object.prototype.hasOwnProperty.call(
                options.recordFields,
                'external_link',
              )
                ? [
                    {
                      id: 'external-link-field',
                      api_key: 'external_link',
                      field_type: 'link',
                      localized: false,
                      position: 3,
                      default_value: defaultValueState.has(
                        'external-link-field',
                      )
                        ? structuredClone(
                            defaultValueState.get('external-link-field'),
                          )
                        : null,
                      validators: {},
                    },
                  ]
                : []),
              ...(defaultValueState.has('historical-number-field')
                ? [
                    {
                      id: 'historical-number-field',
                      api_key: 'historical_number',
                      field_type: 'float',
                      localized: false,
                      position: 3,
                      default_value: structuredClone(
                        defaultValueState.get('historical-number-field'),
                      ),
                      validators: options.failIfCreateDefaultActive
                        ? { unique: {} }
                        : {},
                    },
                  ]
                : []),
            ];
      },
      create: async (itemTypeId: string, body: Record<string, any>) => {
        if (!mappingModel || itemTypeId !== mappingModel.id) {
          throw new Error('Unexpected mapping field create');
        }
        const field =
          body.api_key === 'name'
            ? makeLegacyMappingNameField(body.id)
            : body.api_key === 'mapping'
              ? makeLegacyMappingField(body.id)
              : null;
        if (!field || mappingFields.has(field.id)) {
          throw new Error('Unexpected mapping field create');
        }
        mappingMutations.fieldCreate += 1;
        options.events?.push(`mapping-field-create:${field.api_key}`);
        mappingFields.set(field.id, field);
        if (field.api_key === 'name') {
          mappingModel.title_field = { id: field.id, type: 'field' };
          mappingModel.presentation_title_field = {
            id: field.id,
            type: 'field',
          };
        }
        return structuredClone(field);
      },
      update: async (
        fieldId: string,
        body: {
          validators?: Record<string, any>;
          default_value?: unknown;
        },
      ) => {
        options.events?.push('schema-write');
        schemaMutations.update += 1;
        if (Object.prototype.hasOwnProperty.call(body, 'validators')) {
          validatorState.set(fieldId, structuredClone(body.validators ?? {}));
        }
        if (Object.prototype.hasOwnProperty.call(body, 'default_value')) {
          defaultValueState.set(fieldId, structuredClone(body.default_value));
          options.events?.push(
            `schema-default:${JSON.stringify(body.default_value)}`,
          );
        }
        return {
          id: fieldId,
          validators: structuredClone(validatorState.get(fieldId) ?? {}),
          default_value: structuredClone(defaultValueState.get(fieldId)),
        };
      },
    },
    environments: {
      list: async () =>
        options.primary
          ? [
              {
                id: 'destination-fork',
                meta: {
                  primary: true,
                  status: 'ready',
                  read_only_mode: false,
                },
              },
            ]
          : [
              {
                id: 'destination-fork',
                meta: {
                  primary: false,
                  status: 'ready',
                  read_only_mode: false,
                },
              },
              {
                id: 'primary',
                meta: {
                  primary: true,
                  status: 'ready',
                  read_only_mode: false,
                },
              },
            ],
    },
    workflows: { list: async () => [] },
    users: {
      findMe: async () =>
        structuredClone(options.identity ?? { type: 'account' }),
    },
    schemaMenuItems: {
      list: async () => structuredClone(mappingSchemaMenuItems),
    },
    menuItems: {
      list: async () =>
        mappingModel && mappingOptions?.contentMenuReference
          ? [
              {
                id: 'mapping-content-menu',
                item_type: { id: mappingModel.id, type: 'item_type' },
                item_type_filter: null,
              },
            ]
          : [],
    },
    itemTypeFilters: {
      list: async () =>
        mappingModel && mappingOptions?.filterReference
          ? [
              {
                id: 'mapping-filter',
                item_type: { id: mappingModel.id, type: 'item_type' },
              },
            ]
          : [],
    },
    items: {
      find: async (id: string, findOptions: { version?: string } = {}) => {
        const mappingRecord = storedMappingRecords.get(id);
        if (mappingRecord) return structuredClone(mappingRecord);
        if (options.occupiedLegacyItemIds?.includes(id)) {
          return {
            id,
            type: 'item',
            item_type: { id: MODEL_ID, type: 'item_type' },
            meta: { current_version: 'occupied-legacy-version' },
          };
        }
        if (id === BLOCK_ID) {
          if (current.content) return structuredClone(current.content);
          if (options.detachedBlock) {
            return structuredClone(options.detachedBlock);
          }
          throw notFound();
        }
        if (id === EXTERNAL_PARENT_ID && options.externalParent) {
          if (
            findOptions.version === 'published' &&
            !options.externalParentPublished
          ) {
            throw notFound();
          }
          return {
            ...(options.externalParentPublished
              ? makePublishedRecord('External parent', 'external-version')
              : makeRecord('External parent', 'external-version')),
            id: EXTERNAL_PARENT_ID,
            item_type: {
              id: options.externalParentItemTypeId ?? MODEL_ID,
              type: 'item_type',
            },
          };
        }
        if (id === RECORD_ID && recordExists) {
          if (options.traceReads) options.events?.push('record-read');
          if (findOptions.version === 'published') {
            if (!recordPublished) throw notFound();
            return structuredClone(
              separatePublishedVersion ? publishedCurrent : current,
            );
          }
          return structuredClone(current);
        }
        throw notFound();
      },
      listPagedIterator: async function* (params?: Record<string, any>) {
        if (mappingModel && params?.filter?.type === mappingModel.id) {
          for (const record of Array.from(storedMappingRecords.values()).sort(
            (left, right) => String(left.id).localeCompare(String(right.id)),
          )) {
            yield structuredClone(record);
          }
          return;
        }
        if (recordExists) yield structuredClone(current);
      },
      rawCurrentVsPublishedState: async () => ({
        data: {
          relationships: {
            scheduled_publication: {
              data: schedules.publication
                ? { id: 'publication-schedule', type: 'scheduled_publication' }
                : null,
            },
            scheduled_unpublishing: {
              data: schedules.unpublishing
                ? {
                    id: 'unpublishing-schedule',
                    type: 'scheduled_unpublishing',
                  }
                : null,
            },
          },
        },
        included: [
          ...(schedules.publication
            ? [
                {
                  id: 'publication-schedule',
                  type: 'scheduled_publication',
                  attributes: {
                    publication_scheduled_at: schedules.publication.at,
                    selective_publication: schedules.publication.selective
                      ? {
                          content_in_locales:
                            schedules.publication.selective.locales,
                          non_localized_content:
                            schedules.publication.selective.nonLocalized,
                        }
                      : null,
                  },
                },
              ]
            : []),
          ...(schedules.unpublishing
            ? [
                {
                  id: 'unpublishing-schedule',
                  type: 'scheduled_unpublishing',
                  attributes: {
                    unpublishing_scheduled_at: schedules.unpublishing.at,
                    content_in_locales: schedules.unpublishing.locales,
                  },
                },
              ]
            : []),
        ],
      }),
      references: async () => [],
      validateExisting: async () => {
        reads.validateExisting += 1;
        if (options.validateExistingError) {
          throw options.validateExistingError;
        }
      },
      update: async (_id: string, body: Record<string, any>) => {
        options.events?.push('record-update');
        mutations.update += 1;
        if (options.updateError) {
          throw options.updateError;
        }
        current = {
          ...current,
          ...body,
          meta: {
            ...current.meta,
            current_version: `live-version-${mutations.update + 1}`,
            updated_at: `2025-01-01T00:00:0${mutations.update}Z`,
          },
        };
        syncScheduleMeta();
        if (mappingOptions?.deleteRecordsOnContentUpdate) {
          storedMappingRecords.clear();
        }
        if (mappingOptions?.replaceRecordsOnContentUpdate) {
          storedMappingRecords.clear();
          for (const input of mappingOptions.replaceRecordsOnContentUpdate) {
            const replacement = makeLegacyMappingRecord(
              input,
              mappingModel?.id ?? initialMappingModelId,
            );
            storedMappingRecords.set(replacement.id, replacement);
          }
        }
        return structuredClone(current);
      },
      create: async (body: Record<string, any>) => {
        if (
          options.allowRecordCreate &&
          body.item_type?.id === MODEL_ID &&
          body.id === RECORD_ID &&
          !recordExists
        ) {
          const activeDefault = defaultValueState.get(
            'historical-number-field',
          );
          if (
            options.failIfCreateDefaultActive &&
            activeDefault !== null &&
            activeDefault !== undefined &&
            activeDefault !== false
          ) {
            throw new Error('unique default collision before create');
          }
          if (options.recordCreateError) {
            throw options.recordCreateError;
          }
          const historicalNumber =
            body.historical_number === null &&
            activeDefault !== null &&
            activeDefault !== undefined &&
            activeDefault !== false
              ? structuredClone(activeDefault)
              : body.historical_number;
          recordCreateCount += 1;
          options.events?.push(
            `record-create:${JSON.stringify(historicalNumber)}`,
          );
          recordExists = true;
          recordPublished = options.noDraft === true;
          current = {
            id: RECORD_ID,
            type: 'item',
            item_type: { id: MODEL_ID, type: 'item_type' },
            title: body.title,
            content: body.content,
            historical_number: historicalNumber,
            meta: {
              created_at: body.meta?.created_at,
              first_published_at: body.meta?.first_published_at,
              current_version: 'live-created-version-1',
              updated_at: '2025-01-01T00:00:00Z',
              published_at: recordPublished ? '2025-01-01T00:00:00Z' : null,
              stage: null,
              is_valid: true,
              is_current_version_valid: true,
              is_published_version_valid: recordPublished ? true : null,
            },
          };
          syncScheduleMeta();
          return structuredClone(current);
        }
        if (
          !mappingModel ||
          body.item_type?.id !== mappingModel.id ||
          typeof body.name !== 'string' ||
          typeof body.mapping !== 'string' ||
          storedMappingRecords.has(body.id)
        ) {
          return forbiddenMutation('record create')();
        }
        mappingMutations.recordCreate += 1;
        options.events?.push('mapping-record-create');
        const record = makeLegacyMappingRecord(
          {
            id: body.id,
            name: body.name,
            serializedDocument: body.mapping,
          },
          mappingModel.id,
        );
        storedMappingRecords.set(record.id, record);
        return structuredClone(record);
      },
      destroy: forbiddenMutation('record delete'),
      publish: options.allowPublication
        ? async () => {
            recordPublished = true;
            current.meta.published_at = '2025-01-01T00:00:00Z';
            current.meta.is_published_version_valid = true;
            publishedCurrent = structuredClone(current);
            return structuredClone(current);
          }
        : forbiddenMutation('record publish'),
      unpublish: options.allowPublication
        ? async () => {
            recordPublished = false;
            current.meta.published_at = null;
            current.meta.is_published_version_valid = null;
            publishedCurrent = null;
            return structuredClone(current);
          }
        : forbiddenMutation('record unpublish'),
      moveToStage: forbiddenMutation('record stage move'),
      updatePosition: forbiddenMutation('record position'),
    },
    uploads: {
      find: async (id: string) => {
        if (options.existingUploadIds?.includes(id)) {
          return makeExistingUpload(id);
        }
        throw notFound();
      },
      create: forbiddenMutation('upload create'),
      update: forbiddenMutation('upload update'),
      destroy: forbiddenMutation('upload delete'),
    },
    uploadCollections: {
      find: async (id: string) => {
        if (options.existingCollectionIds?.includes(id)) {
          return { id, type: 'upload_collection', label: 'External' };
        }
        throw notFound();
      },
      create: forbiddenMutation('upload collection create'),
      update: forbiddenMutation('upload collection update'),
    },
    scheduledPublication: {
      create: options.schedules
        ? async (
            _id: string,
            body: {
              publication_scheduled_at: string;
              selective_publication: {
                content_in_locales: string[];
                non_localized_content: boolean;
              } | null;
            },
          ) => {
            options.events?.push('publication-schedule-create');
            schedules = {
              ...schedules,
              publication: {
                at: body.publication_scheduled_at,
                selective: body.selective_publication
                  ? {
                      locales: [
                        ...body.selective_publication.content_in_locales,
                      ],
                      nonLocalized:
                        body.selective_publication.non_localized_content,
                    }
                  : null,
              },
            };
            syncScheduleMeta();
          }
        : forbiddenMutation('publication schedule create'),
      destroy: options.schedules
        ? async () => {
            options.events?.push('publication-schedule-destroy');
            schedules = { ...schedules, publication: null };
            syncScheduleMeta();
          }
        : forbiddenMutation('publication schedule delete'),
    },
    scheduledUnpublishing: {
      create: options.schedules
        ? async (
            _id: string,
            body: {
              unpublishing_scheduled_at: string;
              content_in_locales: string[] | null;
            },
          ) => {
            options.events?.push('unpublishing-schedule-create');
            schedules = {
              ...schedules,
              unpublishing: {
                at: body.unpublishing_scheduled_at,
                locales: body.content_in_locales
                  ? [...body.content_in_locales]
                  : null,
              },
            };
            syncScheduleMeta();
          }
        : forbiddenMutation('unpublishing schedule create'),
      destroy: options.schedules
        ? async () => {
            options.events?.push('unpublishing-schedule-destroy');
            schedules = { ...schedules, unpublishing: null };
            syncScheduleMeta();
          }
        : forbiddenMutation('unpublishing schedule delete'),
    },
  } as unknown as CmaClient.Client;

  return {
    client,
    current: () => structuredClone(current),
    mutations,
    schemaMutations,
    mappingMutations,
    mappingRecords: () =>
      Array.from(storedMappingRecords.values()).map((record) =>
        structuredClone(record),
      ),
    fieldValidators: (fieldId: string) =>
      structuredClone(validatorState.get(fieldId) ?? {}),
    fieldDefaultValue: (fieldId: string) =>
      structuredClone(defaultValueState.get(fieldId)),
    recordCreates: () => recordCreateCount,
    schedules: () => structuredClone(schedules),
    reads,
  };
}

function makeScheduleQuiescenceRuntimeClient(
  initialSchedules: RuntimeScheduleState,
  initialChangedTitle = 'baseline title',
  options: {
    dependencySchedules?: RuntimeScheduleState;
    fieldValidators?: Record<string, Record<string, any>>;
  } = {},
): {
  client: CmaClient.Client;
  events: () => string[];
  schedules: (id: string) => RuntimeScheduleState;
  title: (id: string) => string;
  schemaMutations: { update: number };
  fieldValidators: (fieldId: string) => Record<string, any>;
} {
  const events: string[] = [];
  const base = makeRuntimeClient('unused', {
    events,
    fieldValidators: options.fieldValidators,
  });
  const client = base.client as unknown as Record<string, any>;
  let version = 0;
  const records = new Map<string, Record<string, any>>();
  const scheduleStates = new Map<string, RuntimeScheduleState>();
  for (const [id, title] of [
    [RECORD_ID, initialChangedTitle],
    [EXTERNAL_PARENT_ID, 'scheduled dependency'],
  ] as const) {
    const record = makeRecord(title, `scheduled-version-${id}`);
    record.id = id;
    records.set(id, record);
    scheduleStates.set(
      id,
      structuredClone(
        id === EXTERNAL_PARENT_ID && options.dependencySchedules
          ? options.dependencySchedules
          : initialSchedules,
      ),
    );
  }

  const notFound = () => {
    const error = new Error('not found') as Error & {
      response: { status: number };
    };
    error.response = { status: 404 };
    return error;
  };
  const syncScheduleMeta = (id: string) => {
    const record = records.get(id);
    const schedules = scheduleStates.get(id);
    if (!record || !schedules) throw notFound();
    record.meta.publication_scheduled_at = schedules.publication?.at ?? null;
    record.meta.unpublishing_scheduled_at = schedules.unpublishing?.at ?? null;
  };
  for (const id of records.keys()) syncScheduleMeta(id);

  const rawScheduleState = (id: string) => {
    const schedules = scheduleStates.get(id);
    if (!schedules) throw notFound();
    const publicationId = `publication-${id}`;
    const unpublishingId = `unpublishing-${id}`;
    return {
      data: {
        relationships: {
          scheduled_publication: {
            data: schedules.publication
              ? { id: publicationId, type: 'scheduled_publication' }
              : null,
          },
          scheduled_unpublishing: {
            data: schedules.unpublishing
              ? { id: unpublishingId, type: 'scheduled_unpublishing' }
              : null,
          },
        },
      },
      included: [
        ...(schedules.publication
          ? [
              {
                id: publicationId,
                type: 'scheduled_publication',
                attributes: {
                  publication_scheduled_at: schedules.publication.at,
                  selective_publication: schedules.publication.selective
                    ? {
                        content_in_locales:
                          schedules.publication.selective.locales,
                        non_localized_content:
                          schedules.publication.selective.nonLocalized,
                      }
                    : null,
                },
              },
            ]
          : []),
        ...(schedules.unpublishing
          ? [
              {
                id: unpublishingId,
                type: 'scheduled_unpublishing',
                attributes: {
                  unpublishing_scheduled_at: schedules.unpublishing.at,
                  content_in_locales: schedules.unpublishing.locales,
                },
              },
            ]
          : []),
      ],
    };
  };
  const forbidden = (operation: string) => async () => {
    throw new Error(`Unexpected ${operation}`);
  };

  client.items = {
    find: async (id: string, options: { version?: string } = {}) => {
      if (options.version === 'published') throw notFound();
      const record = records.get(id);
      if (!record) throw notFound();
      return structuredClone(record);
    },
    listPagedIterator: async function* () {
      for (const record of [...records.values()].sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      )) {
        yield structuredClone(record);
      }
    },
    references: async () => [],
    validateExisting: async () => undefined,
    rawCurrentVsPublishedState: async (id: string) =>
      structuredClone(rawScheduleState(id)),
    update: async (id: string, body: Record<string, any>) => {
      const record = records.get(id);
      if (!record) throw notFound();
      version += 1;
      events.push(`record-update:${id}`);
      records.set(id, {
        ...record,
        ...structuredClone(body),
        meta: {
          ...record.meta,
          ...(body.meta ?? {}),
          current_version: `scheduled-version-${version}`,
          updated_at: `2025-01-01T00:00:${String(version).padStart(2, '0')}Z`,
        },
      });
      syncScheduleMeta(id);
      return structuredClone(records.get(id));
    },
    create: forbidden('record create'),
    destroy: forbidden('record delete'),
    publish: forbidden('record publish'),
    unpublish: forbidden('record unpublish'),
    moveToStage: forbidden('record stage move'),
    updatePosition: forbidden('record position'),
  };

  const updateSchedule = (
    id: string,
    update: Partial<RuntimeScheduleState>,
  ) => {
    const current = scheduleStates.get(id);
    if (!current) throw notFound();
    scheduleStates.set(id, { ...current, ...structuredClone(update) });
    syncScheduleMeta(id);
  };
  client.scheduledPublication = {
    destroy: async (id: string) => {
      events.push(`publication-destroy:${id}`);
      updateSchedule(id, { publication: null });
    },
    create: async (
      id: string,
      body: {
        publication_scheduled_at: string;
        selective_publication: {
          content_in_locales: readonly string[];
          non_localized_content: boolean;
        } | null;
      },
    ) => {
      events.push(`publication-create:${id}`);
      updateSchedule(id, {
        publication: {
          at: body.publication_scheduled_at,
          selective: body.selective_publication
            ? {
                locales: [...body.selective_publication.content_in_locales],
                nonLocalized: body.selective_publication.non_localized_content,
              }
            : null,
        },
      });
    },
  };
  client.scheduledUnpublishing = {
    destroy: async (id: string) => {
      events.push(`unpublishing-destroy:${id}`);
      updateSchedule(id, { unpublishing: null });
    },
    create: async (
      id: string,
      body: {
        unpublishing_scheduled_at: string;
        content_in_locales: readonly string[] | null;
      },
    ) => {
      events.push(`unpublishing-create:${id}`);
      updateSchedule(id, {
        unpublishing: {
          at: body.unpublishing_scheduled_at,
          locales: body.content_in_locales
            ? [...body.content_in_locales]
            : null,
        },
      });
    },
  };

  return {
    client: client as CmaClient.Client,
    events: () => [...events],
    schedules: (id) => structuredClone(scheduleStates.get(id)!),
    title: (id) => String(records.get(id)?.title),
    schemaMutations: base.schemaMutations,
    fieldValidators: base.fieldValidators,
  };
}

async function expectRejects(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    return error as Error;
  }

  throw new Error('Expected promise to reject');
}

async function withRecordedUnhandledRejections<T>(
  task: () => Promise<T>,
): Promise<{ result: T; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', record);
  try {
    const result = await task();
    // Node reports a rejection once the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { result, unhandled };
  } finally {
    process.off('unhandledRejection', record);
  }
}

async function withMutedConsoleError<T>(task: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;

  try {
    return await task();
  } finally {
    console.error = original;
  }
}
