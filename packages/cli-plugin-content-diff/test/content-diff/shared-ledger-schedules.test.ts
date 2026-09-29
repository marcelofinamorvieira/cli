import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'chai';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import {
  deterministicPortableDatoId,
  readLegacyIdMappingRegistry,
} from '../../src/content-diff/legacy-ids';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import { canonicalizeSchedules } from '../../src/content-diff/shared/canonicalize';
import { isCmaNotFoundError } from '../../src/content-diff/shared/cma-errors';
import {
  canonicalPrettyStringify,
  sha256,
  stableStringify,
} from '../../src/content-diff/shared/json';
import {
  LEGACY_ID_MAPPING_FIELD_CONTRACT,
  LEGACY_ID_MAPPING_MODEL_ATTRIBUTES,
  LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT,
  inspectLegacyMappingFields,
  legacyMappingFieldAttributes,
  legacyMappingFieldMismatches,
  legacyMappingModelMismatches,
  parseStoredLegacyIdMappingRecord,
  validateLegacyIdMappingLedger,
} from '../../src/content-diff/shared/legacy-id-ledger';
import { legacyIdMappingChunkName } from '../../src/content-diff/shared/legacy-id-mapping';
import { parseScheduleDetails } from '../../src/content-diff/shared/schedules';
import { readScheduleDetails } from '../../src/content-diff/snapshot';
import {
  ContentDiffError,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

type Failure = Error & { code?: string; details?: unknown };
type AnyFunction = (...args: any[]) => any;

const RUNTIME_EXPORTS = [
  'assertExactLegacyMappingModel',
  'assertLegacyMappingFields',
  'findUploadMaybe',
  'inspectLegacyMappingFields',
  'isCmaNotFoundError',
  'legacyMappingModelMismatches',
  'parseScheduleDetails',
  'parseStoredLegacyIdMappingRecord',
  'readSchedules',
  'validateLegacyIdMappingLedger',
] as const;

type RuntimeBindings = Record<
  `__${(typeof RUNTIME_EXPORTS)[number]}`,
  AnyFunction
>;

const SITE_ID = 'site-id';
const MODEL_ID = 'ledger-model';
const NAME_FIELD_ID = 'ledger-name-field';
const MAPPING_FIELD_ID = 'ledger-mapping-field';
const LOCALES = ['en', 'it'];

function portableId(seed: string): string {
  return deterministicPortableDatoId(`shared-ledger-test:${seed}`);
}

function capture(task: () => unknown): Failure {
  try {
    task();
  } catch (error) {
    return error as Failure;
  }
  throw new Error('Expected a failure.');
}

async function captureAsync(task: () => Promise<unknown>): Promise<Failure> {
  try {
    await task();
  } catch (error) {
    return error as Failure;
  }
  throw new Error('Expected a failure.');
}

function rawModel(overrides: Record<string, unknown> = {}) {
  return {
    id: MODEL_ID,
    ...LEGACY_ID_MAPPING_MODEL_ATTRIBUTES,
    has_singleton_item: false,
    workflow: null,
    ordering_field: null,
    presentation_image_field: null,
    image_preview_field: null,
    excerpt_field: null,
    singleton_item: null,
    title_field: { id: NAME_FIELD_ID, type: 'field' },
    presentation_title_field: { id: NAME_FIELD_ID, type: 'field' },
    ...overrides,
  };
}

function rawNameField(overrides: Record<string, unknown> = {}) {
  return {
    id: NAME_FIELD_ID,
    ...legacyMappingFieldAttributes(LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT),
    fieldset: null,
    ...overrides,
  };
}

function rawMappingField(overrides: Record<string, unknown> = {}) {
  return {
    id: MAPPING_FIELD_ID,
    ...legacyMappingFieldAttributes(LEGACY_ID_MAPPING_FIELD_CONTRACT),
    fieldset: null,
    ...overrides,
  };
}

const LEDGER_SCHEMA = {
  siteId: SITE_ID,
  itemTypes: [
    {
      id: MODEL_ID,
      apiKey: 'datocms_content_diff',
      name: 'Content diff',
      modularBlock: false,
      singleton: false,
      sortable: false,
      tree: false,
      draftModeActive: true,
      draftSavingActive: false,
      allLocalesRequired: false,
      workflowId: null,
      fields: [],
    },
  ],
} as unknown as SchemaSnapshot;

function ledgerClient(
  model: Record<string, unknown>,
  fields: unknown[],
  records: unknown[] = [],
) {
  return {
    itemTypes: { find: async () => structuredClone(model) },
    fields: { list: async () => structuredClone(fields) },
    items: {
      listPagedIterator: async function* () {
        for (const record of records) yield structuredClone(record);
      },
    },
  } as never;
}

interface ChunkOptions {
  batchId?: string;
  chunkIndex?: number;
  chunkCount?: number;
  wholeHash?: string;
  id?: string;
  withoutModel?: boolean;
}

function storedRecord(
  entries: Array<{ entityType: string; sourceId: string; targetId: string }>,
  options: ChunkOptions = {},
): Record<string, unknown> {
  const batchId = options.batchId ?? portableId('batch');
  const chunkIndex = options.chunkIndex ?? 0;
  const chunkCount = options.chunkCount ?? 1;
  const document = {
    formatVersion: 1,
    projectId: SITE_ID,
    batchId,
    chunkIndex,
    chunkCount,
    wholeHash: options.wholeHash ?? sha256(stableStringify(entries)),
    entries,
  };
  return {
    id: options.id ?? portableId(`record:${batchId}:${chunkIndex}`),
    ...(options.withoutModel
      ? {}
      : { item_type: { id: MODEL_ID, type: 'item_type' } }),
    name: legacyIdMappingChunkName(batchId, chunkIndex, chunkCount),
    mapping: canonicalPrettyStringify(document),
    meta: {
      status: 'draft',
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: null,
      stage: null,
      publication_scheduled_at: null,
      unpublishing_scheduled_at: null,
      published_at: null,
      first_published_at: null,
    },
  };
}

function entry(sourceId: string, target: string) {
  return { entityType: 'record', sourceId, targetId: portableId(target) };
}

describe('shared CMA not-found detection, schedule parsing, and ledger contract', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimeBindings;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-shared-ledger-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        ...RUNTIME_EXPORTS.map((name) => `module.exports.__${name} = ${name};`),
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimeBindings;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('embeds the three modules and leaves no private not-found check in the planner facade', () => {
    for (const module of ['cma-errors', 'schedules', 'legacy-id-ledger']) {
      expect(GENERATED_RUNTIME_SHARED_MODULES).to.include(
        `src/content-diff/shared/${module}.ts`,
      );
    }
    const index = readFileSync(
      resolve(__dirname, '../../src/content-diff/index.ts'),
      'utf8',
    );
    expect(index).to.include(
      "import { isCmaNotFoundError } from './shared/cma-errors';",
    );
    expect(index).not.to.match(/function isNotFoundError\b/);
  });

  it('detects CMA not-found errors by status or error code, never by error ID (D20)', async () => {
    const apiErrorLike = Object.create({
      get errors() {
        return [
          {
            id: 'error-instance',
            type: 'api_error',
            attributes: { code: 'ITEM_NOT_FOUND' },
          },
        ];
      },
    });
    const cases: Array<[string, unknown, boolean]> = [
      ['a 404 response', { response: { status: 404 } }, true],
      ['a 403 response', { response: { status: 403 } }, false],
      [
        'a JSON:API error code',
        { errors: [{ id: 'e1', attributes: { code: 'NOT_FOUND' } }] },
        true,
      ],
      ['a flat error code', { errors: [{ code: 'RECORD_NOT_FOUND' }] }, true],
      ['a not-found error ID', { errors: [{ id: 'NOT_FOUND' }] }, false],
      [
        'attributes that hold another code',
        {
          errors: [
            { code: 'NOT_FOUND', attributes: { code: 'INVALID_FIELD' } },
          ],
        },
        false,
      ],
      ['a prototype errors getter', apiErrorLike, true],
      ['an unrelated error', new Error('boom'), false],
      ['null', null, false],
      ['a string', 'NOT_FOUND', false],
    ];
    for (const [label, error, expected] of cases) {
      expect(isCmaNotFoundError(error), label).to.equal(expected);
      expect(runtime.__isCmaNotFoundError(error), label).to.equal(expected);
    }

    const byCode = {
      uploads: {
        find: async () => {
          throw { errors: [{ id: 'e1', attributes: { code: 'NOT_FOUND' } }] };
        },
      },
    };
    expect(await runtime.__findUploadMaybe(byCode, 'upload-id')).to.equal(null);
    const byId = {
      uploads: {
        find: async () => {
          throw { errors: [{ id: 'NOT_FOUND' }] };
        },
      },
    };
    const error = await captureAsync(() =>
      runtime.__findUploadMaybe(byId, 'upload-id'),
    );
    expect(error).to.deep.equal({ errors: [{ id: 'NOT_FOUND' }] });
  });

  describe('schedule details (D29)', () => {
    const RECORD_ID = 'scheduled-record';

    function response(
      overrides: {
        publication?: unknown;
        unpublishing?: unknown;
        included?: unknown[];
      } = {},
    ) {
      return {
        data: {
          id: RECORD_ID,
          relationships: {
            scheduled_publication: {
              data:
                overrides.publication === undefined
                  ? { id: 'publication-1', type: 'scheduled_publication' }
                  : overrides.publication,
            },
            scheduled_unpublishing: {
              data:
                overrides.unpublishing === undefined
                  ? { id: 'unpublishing-1', type: 'scheduled_unpublishing' }
                  : overrides.unpublishing,
            },
          },
        },
        included: overrides.included ?? [
          {
            id: 'publication-1',
            type: 'scheduled_publication',
            attributes: {
              publication_scheduled_at: '2035-01-01T13:00:00+01:00',
              selective_publication: {
                content_in_locales: ['it', 'en'],
                non_localized_content: true,
              },
            },
          },
          {
            id: 'unpublishing-1',
            type: 'scheduled_unpublishing',
            attributes: {
              unpublishing_scheduled_at: '2035-01-02T12:00:00Z',
              content_in_locales: null,
            },
          },
        ],
      };
    }

    function plannerRead(raw: unknown) {
      return readScheduleDetails(
        {
          items: { rawCurrentVsPublishedState: async () => raw },
        } as never,
        RECORD_ID,
      );
    }

    function runtimeRead(
      raw: unknown,
      markers = { publication: true, unpublishing: true },
    ) {
      return runtime.__readSchedules(
        {
          client: { items: { rawCurrentVsPublishedState: async () => raw } },
          plan: { schema: { locales: LOCALES } },
        },
        {
          id: RECORD_ID,
          meta: {
            publication_scheduled_at: markers.publication
              ? '2035-01-01T12:00:00Z'
              : null,
            unpublishing_scheduled_at: markers.unpublishing
              ? '2035-01-02T12:00:00Z'
              : null,
          },
        },
      );
    }

    function expectScheduleFailure(error: Failure, reason: string) {
      expect(error.code).to.equal('SCHEDULE_CONTRACT_CHANGED');
      expect(error.message).to.equal(
        `Cannot read complete schedule details for record ${RECORD_ID}; the private current-vs-published response contract changed. ${reason}`,
      );
      expect(error.details).to.deep.equal({ recordId: RECORD_ID });
    }

    it('reads the same schedules in the planner and the runtime', async () => {
      const planned = await plannerRead(response());
      expect(await runtimeRead(response())).to.deep.equal(
        canonicalizeSchedules(planned, LOCALES),
      );
      expect(await runtimeRead(response())).to.deep.equal({
        publication: {
          at: '2035-01-01T12:00:00.000Z',
          selective: { locales: ['en', 'it'], nonLocalized: true },
        },
        unpublishing: { at: '2035-01-02T12:00:00.000Z', locales: null },
      });
    });

    it('requires the first included resource a relationship names to be complete', async () => {
      const raw = response();
      raw.included = [
        { id: 'publication-1', type: 'scheduled_publication' },
        ...raw.included,
      ];
      const reason =
        'The exact scheduled_publication resource was not included.';
      const plannerError = await captureAsync(() => plannerRead(raw));
      expect(plannerError).to.be.instanceOf(ContentDiffError);
      expectScheduleFailure(plannerError, reason);
      const runtimeError = await captureAsync(() => runtimeRead(raw));
      expect(runtimeError.name).to.equal('ContentDiffRuntimeError');
      expectScheduleFailure(runtimeError, reason);
    });

    it('rejects a missing schedule time as a contract change on both sides', async () => {
      const raw = response();
      (
        raw.included[1] as Record<string, any>
      ).attributes.unpublishing_scheduled_at = 42;
      const reason = 'The exact scheduled_unpublishing time was not included.';
      expectScheduleFailure(await captureAsync(() => plannerRead(raw)), reason);
      expectScheduleFailure(await captureAsync(() => runtimeRead(raw)), reason);
    });

    it('cross-checks meta schedule markers when they are given', async () => {
      const raw = response({ unpublishing: null });
      const reason =
        'Unpublishing schedule metadata exists but its exact scope was not included.';
      expectScheduleFailure(await captureAsync(() => runtimeRead(raw)), reason);
      expectScheduleFailure(
        capture(() =>
          parseScheduleDetails(raw, RECORD_ID, {
            publication: true,
            unpublishing: true,
          }),
        ),
        reason,
      );
      expect((await plannerRead(raw)).unpublishing).to.equal(null);
      expect(
        (await runtimeRead(raw, { publication: true, unpublishing: false }))
          .unpublishing,
      ).to.equal(null);
    });

    it('rejects a response that is not an object with a contract error', async () => {
      const reason =
        'The current-vs-published schedule response has an unsupported shape.';
      expectScheduleFailure(
        await captureAsync(() => plannerRead(null)),
        reason,
      );
      expectScheduleFailure(
        await captureAsync(() => runtimeRead(null)),
        reason,
      );
    });
  });

  describe('ledger contract (D27, D28)', () => {
    const PLANNED_FIELDS = {
      nameField: { id: NAME_FIELD_ID, status: 'existing' },
      mappingField: { id: MAPPING_FIELD_ID, status: 'existing' },
    };

    async function plannerSchemaOutcome(
      model: Record<string, unknown>,
      fields: unknown[],
    ): Promise<string> {
      try {
        await readLegacyIdMappingRegistry(
          ledgerClient(model, fields),
          LEDGER_SCHEMA,
          'datocms_content_diff',
          false,
        );
        return 'accepted';
      } catch (error) {
        expect(error).to.be.instanceOf(ContentDiffError);
        expect((error as ContentDiffError).code).to.equal(
          'UNSUPPORTED_CONTENT_STATE',
        );
        return /ledger contract\.$/.test((error as Error).message)
          ? 'model'
          : 'fields';
      }
    }

    function runtimeSchemaOutcome(
      model: Record<string, unknown>,
      fields: unknown[],
      options: { newBatch?: boolean; requireComplete?: boolean } = {},
    ): string {
      const context = {
        plan: {
          legacyIdMappings: {
            newMappingBatch: options.newBatch ? { chunks: [] } : null,
            // A plan that appends a new batch to a ledger it is creating
            // declares new fields; one that reads a ledger pins their IDs.
            schema: options.newBatch
              ? {
                  nameField: { ...PLANNED_FIELDS.nameField, status: 'new' },
                  mappingField: {
                    ...PLANNED_FIELDS.mappingField,
                    status: 'new',
                  },
                }
              : PLANNED_FIELDS,
          },
        },
      };
      try {
        runtime.__assertExactLegacyMappingModel(model);
      } catch (error) {
        expect((error as Failure).code).to.equal(
          'LEGACY_MAPPING_SCHEMA_CONFLICT',
        );
        return 'model';
      }
      try {
        runtime.__assertLegacyMappingFields(
          context,
          model,
          fields,
          options.requireComplete ?? true,
        );
        return 'accepted';
      } catch (error) {
        expect((error as Failure).code).to.equal(
          'LEGACY_MAPPING_SCHEMA_CONFLICT',
        );
        return 'fields';
      }
    }

    it('judges the ledger model and fields with one contract on both sides (D27, D48, D49)', async () => {
      const cases: Array<
        [
          string,
          Record<string, unknown>,
          unknown[],
          'accepted' | 'model' | 'fields',
        ]
      > = [
        [
          'the exact ledger',
          rawModel(),
          [rawNameField(), rawMappingField()],
          'accepted',
        ],
        [
          'an absent workflow relationship',
          rawModel({ workflow: undefined }),
          [rawNameField(), rawMappingField()],
          'accepted',
        ],
        [
          'a malformed workflow relationship',
          rawModel({ workflow: { id: '' } }),
          [rawNameField(), rawMappingField()],
          'model',
        ],
        [
          'a malformed ordering-field relationship',
          rawModel({ ordering_field: { data: null } }),
          [rawNameField(), rawMappingField()],
          'model',
        ],
        [
          'a missing modular_block attribute',
          rawModel({ modular_block: undefined }),
          [rawNameField(), rawMappingField()],
          'model',
        ],
        [
          'a null localized flag',
          rawModel(),
          [rawNameField({ localized: null }), rawMappingField()],
          'fields',
        ],
        [
          'an absent fieldset relationship',
          rawModel(),
          [rawNameField({ fieldset: undefined }), rawMappingField()],
          'accepted',
        ],
        [
          'validators that are not JSON',
          rawModel(),
          [rawNameField(), rawMappingField({ validators: undefined })],
          'fields',
        ],
        [
          'a duplicate name field',
          rawModel(),
          [
            rawNameField(),
            rawMappingField(),
            rawNameField({ id: 'ledger-name-copy' }),
          ],
          'fields',
        ],
        [
          'a title relationship to another field',
          rawModel({ title_field: { id: MAPPING_FIELD_ID, type: 'field' } }),
          [rawNameField(), rawMappingField()],
          'fields',
        ],
      ];
      for (const [label, model, fields, expected] of cases) {
        expect(await plannerSchemaOutcome(model, fields), label).to.equal(
          expected,
        );
        expect(runtimeSchemaOutcome(model, fields), label).to.equal(expected);
        expect(
          runtime.__legacyMappingModelMismatches(model),
          label,
        ).to.deep.equal(legacyMappingModelMismatches(model));
      }
    });

    it('lets only a resuming runtime accept a partial field set (D28)', async () => {
      const model = rawModel();
      const nameOnly = [rawNameField()];
      expect(await plannerSchemaOutcome(model, nameOnly)).to.equal('fields');
      expect(
        runtimeSchemaOutcome(model, nameOnly, {
          newBatch: true,
          requireComplete: false,
        }),
      ).to.equal('accepted');
      expect(
        runtimeSchemaOutcome(model, nameOnly, {
          newBatch: true,
          requireComplete: true,
        }),
      ).to.equal('fields');
      expect(
        runtimeSchemaOutcome(model, nameOnly, { requireComplete: false }),
      ).to.equal('fields');

      const partial = inspectLegacyMappingFields(model, nameOnly, null, true);
      expect(partial.mismatches).to.deep.equal([]);
      expect(partial.mappingField).to.equal(null);
      expect(
        inspectLegacyMappingFields(model, nameOnly, null, false).mismatches,
      ).to.deep.equal([{ property: 'fieldCount', expected: 2, actual: 1 }]);
    });

    it('creates ledger fields that satisfy their own contract', () => {
      for (const contract of [
        LEGACY_ID_MAPPING_NAME_FIELD_CONTRACT,
        LEGACY_ID_MAPPING_FIELD_CONTRACT,
      ]) {
        const attributes = legacyMappingFieldAttributes(contract);
        expect(
          legacyMappingFieldMismatches(
            { id: 'created', ...attributes, fieldset: null },
            contract,
          ),
        ).to.deep.equal([]);
        expect(attributes.validators).not.to.equal(contract.validators);
      }
      expect(
        legacyMappingModelMismatches({
          ...LEGACY_ID_MAPPING_MODEL_ATTRIBUTES,
          has_singleton_item: false,
        }),
      ).to.deep.equal([]);
    });

    function recordFailures(record: unknown) {
      const planner = capture(() =>
        parseStoredLegacyIdMappingRecord(record, MODEL_ID, SITE_ID),
      );
      const runtimeFailure = capture(() =>
        runtime.__parseStoredLegacyIdMappingRecord(record, MODEL_ID, SITE_ID),
      );
      expect(planner).to.be.instanceOf(ContentDiffError);
      expect(planner.code).to.equal('UNSUPPORTED_CONTENT_STATE');
      expect(runtimeFailure.code).to.equal('LEGACY_MAPPING_RECORD_CONFLICT');
      expect(runtimeFailure.message).to.equal(planner.message);
      expect(runtimeFailure.details).to.deep.equal(planner.details);
      return planner;
    }

    it('rejects the same stored records on both sides with each side keeping its code (D27)', () => {
      const valid = storedRecord([entry('100', 'a'), entry('101', 'b')]);
      expect(
        runtime.__parseStoredLegacyIdMappingRecord(valid, MODEL_ID, SITE_ID),
      ).to.deep.equal(
        parseStoredLegacyIdMappingRecord(valid, MODEL_ID, SITE_ID),
      );

      const withoutModel = storedRecord([entry('100', 'a')], {
        withoutModel: true,
      });
      expect(recordFailures(withoutModel).message).to.equal(
        `Internal mapping record ${String(
          withoutModel.id,
        )} has an invalid ID, model relationship, or field value shape.`,
      );
      const repeated = storedRecord([entry('100', 'a'), entry('100', 'b')]);
      expect(recordFailures(repeated).message).to.equal(
        `Internal mapping record ${String(
          repeated.id,
        )} entries are not uniquely sorted.`,
      );
      const outOfRange = storedRecord([entry('100', 'a')], { chunkIndex: 1 });
      expect(recordFailures(outOfRange).message).to.equal(
        `Internal mapping record ${String(
          outOfRange.id,
        )} has invalid ledger metadata.`,
      );
      const extraKey = storedRecord([
        {
          entityType: 'record',
          sourceId: '100',
          targetId: portableId('a'),
        },
      ]);
      const document = JSON.parse(String(extraKey.mapping));
      document.entries[0].unexpected = true;
      extraKey.mapping = canonicalPrettyStringify(document);
      const invalidEntry = recordFailures(extraKey);
      expect(invalidEntry.message).to.equal(
        `Internal mapping record ${String(
          extraKey.id,
        )} contains an invalid mapping entry.`,
      );
      expect(invalidEntry.details).to.deep.equal({
        recordId: extraKey.id,
        cause: 'Invalid legacy-ID stored mapping entry.',
      });
    });

    it('validates ledger batches alike and permits only a planned prefix when resuming (D27, D28)', async () => {
      const batchId = portableId('two-chunk-batch');
      const first = storedRecord([entry('200', 'c')], {
        batchId,
        chunkIndex: 0,
        chunkCount: 2,
        wholeHash: 'a'.repeat(64),
      });
      const second = storedRecord([entry('100', 'd')], {
        batchId,
        chunkIndex: 1,
        chunkCount: 2,
        wholeHash: 'a'.repeat(64),
      });
      const parse = (record: unknown) =>
        parseStoredLegacyIdMappingRecord(record, MODEL_ID, SITE_ID);
      const unsorted = [parse(first), parse(second)];
      const ledgerFailure = capture(() =>
        validateLegacyIdMappingLedger(unsorted, null, false),
      );
      const runtimeLedgerFailure = capture(() =>
        runtime.__validateLegacyIdMappingLedger(unsorted, null, false),
      );
      expect(ledgerFailure.code).to.equal('UNSUPPORTED_CONTENT_STATE');
      expect(runtimeLedgerFailure.code).to.equal(
        'LEGACY_MAPPING_RECORD_CONFLICT',
      );
      expect(runtimeLedgerFailure.message).to.equal(ledgerFailure.message);
      expect(ledgerFailure.message).to.equal(
        `Internal mapping batch ${batchId} entries are not uniquely sorted across chunks.`,
      );
      const plannerRead = await captureAsync(() =>
        readLegacyIdMappingRegistry(
          ledgerClient(
            rawModel(),
            [rawNameField(), rawMappingField()],
            [first, second],
          ),
          LEDGER_SCHEMA,
        ),
      );
      expect(plannerRead.message).to.equal(ledgerFailure.message);

      const prefix = [parse(first)];
      const plannedBatch = {
        batchId,
        wholeHash: 'a'.repeat(64),
        chunks: [
          {
            id: prefix[0].id,
            name: prefix[0].name,
            hash: prefix[0].hash,
            byteLength: prefix[0].byteLength,
            serializedDocument: prefix[0].serializedDocument,
          },
          {
            id: 'second',
            name: 'second',
            hash: 'x',
            byteLength: 0,
            serializedDocument: '',
          },
        ],
      };
      expect(
        runtime.__validateLegacyIdMappingLedger(prefix, plannedBatch, true)
          .sourceClaims.size,
      ).to.equal(1);
      for (const [planned, permitPartial] of [
        [plannedBatch, false],
        [null, true],
      ] as const) {
        const failure = capture(() =>
          runtime.__validateLegacyIdMappingLedger(
            prefix,
            planned,
            permitPartial,
          ),
        );
        expect(failure.code).to.equal('LEGACY_MAPPING_RECORD_CONFLICT');
        expect(failure.message).to.equal(
          `Internal mapping batch ${batchId} is incomplete and is not a recoverable prefix of this migration.`,
        );
      }
      const plannerPrefix = await captureAsync(() =>
        readLegacyIdMappingRegistry(
          ledgerClient(
            rawModel(),
            [rawNameField(), rawMappingField()],
            [first],
          ),
          LEDGER_SCHEMA,
        ),
      );
      expect(plannerPrefix).to.be.instanceOf(ContentDiffError);
      expect(plannerPrefix.message).to.equal(
        `Internal mapping batch ${batchId} is incomplete and is not a recoverable prefix of this migration.`,
      );
    });

    it('reports duplicate claims across batches with each side keeping its code', () => {
      const claim = entry('100', 'shared-target');
      const records = [
        storedRecord([claim], { batchId: portableId('batch-a') }),
        storedRecord([{ ...claim, sourceId: '101' }], {
          batchId: portableId('batch-b'),
        }),
      ].map((record) =>
        parseStoredLegacyIdMappingRecord(record, MODEL_ID, SITE_ID),
      );
      const planner = capture(() =>
        validateLegacyIdMappingLedger(records, null, false),
      );
      const runtimeFailure = capture(() =>
        runtime.__validateLegacyIdMappingLedger(records, null, false),
      );
      expect(planner.code).to.equal('UNSUPPORTED_CONTENT_STATE');
      expect(runtimeFailure.code).to.equal('LEGACY_MAPPING_CONFLICT');
      expect(runtimeFailure.message).to.equal(
        'Persistent legacy-ID mappings contain duplicate source or target claims.',
      );
      expect(runtimeFailure.message).to.equal(planner.message);
      expect(runtimeFailure.details).to.deep.equal(planner.details);
    });
  });
});
