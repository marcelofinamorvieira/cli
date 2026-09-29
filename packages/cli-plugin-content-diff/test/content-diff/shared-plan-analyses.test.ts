import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import {
  applyCreateDefaultsToFields,
  deriveCreateDefaultValueSuppressions,
} from '../../src/content-diff/shared/create-defaults';
import {
  findPlanSanitizedHtmlWriteRisks,
  findSanitizedHtmlWriteRisks,
} from '../../src/content-diff/shared/create-sanitization';
import { projectPlanCreateSeedFields } from '../../src/content-diff/shared/create-seeds';
import {
  collectFreshNestedBlockCreateIds,
  findUnsupportedFreshNestedBlockUpdates,
  unsafeFreshNestedCreateRecordIds,
} from '../../src/content-diff/shared/fresh-nested-updates';
import { schemaWithValidatorRelaxations } from '../../src/content-diff/shared/schema-state';
import {
  absoluteRecordPositionsReproducible,
  parentFirst,
  positionGoalReached,
} from '../../src/content-diff/shared/topology';
import { uniqueReleaseFieldError } from '../../src/content-diff/shared/unique-releases';
import { buildRecordValidationPayload } from '../../src/content-diff/shared/validation-payload';
import {
  ContentDiffError,
  type ContentDiffPlan,
  type FieldSchemaSnapshot,
  type ItemTypeSchemaSnapshot,
  type JsonObject,
  type RecordPlan,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

type Failure = Error & { code?: string; details?: unknown };
type AnyFunction = (...args: any[]) => any;

const RUNTIME_EXPORTS = [
  'absoluteRecordPositionsReproducible',
  'applyCreateDefaultsToFields',
  'buildRecordValidationPayload',
  'buildRuntimeRecordValidationPayload',
  'collectFreshNestedBlockCreateIds',
  'deriveCreateDefaultValueSuppressions',
  'findPlanSanitizedHtmlWriteRisks',
  'findSanitizedHtmlWriteRisks',
  'findUnsupportedFreshNestedBlockUpdates',
  'parentFirst',
  'positionGoalReached',
  'recordPositionGoalReached',
  'uniqueReleaseFieldError',
  'unsafeFreshNestedCreateRecordIds',
] as const;

type RuntimePlanAnalyses = Record<
  `__${(typeof RUNTIME_EXPORTS)[number]}`,
  AnyFunction
>;

const OWNER_MODEL = 'Kp3vQ8mT2xL7sN4wY9Bdga';
const BLOCK_MODEL = 'Lq4wR9nU3yM8tO5xZ0Cehb';
const REGULAR_MODEL = 'Mr5xS0oV4zN9uP6yA1Dfic';
const INSPECTION_MODEL = 'Ns6yT1pW5aO0vQ7zB2Egjd';
const RECORD_A = 'Ot7zU2qX6bP1wR8aC3Fhke';
const RECORD_B = 'Pu8aV3rY7cQ2xS9bD4Gilf';
const BLOCK_ID = 'Qv9bW4sZ8dR3yT0cE5Hjmg';
const SANITIZED = { sanitized_html: { sanitize_before_validation: true } };

function field(
  apiKey: string,
  fieldType: FieldSchemaSnapshot['fieldType'],
  validators: JsonObject | null = {},
  extra: Partial<FieldSchemaSnapshot> = {},
): FieldSchemaSnapshot {
  return {
    id: `field-${apiKey}`,
    apiKey,
    fieldType,
    localized: false,
    position: 1,
    validators: validators as JsonObject,
    ...extra,
  };
}

function itemType(
  id: string,
  fields: FieldSchemaSnapshot[],
  extra: Partial<ItemTypeSchemaSnapshot> = {},
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey: `model_${id}`,
    name: id,
    modularBlock: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: false,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields,
    ...extra,
  };
}

function makeSchema(ownerFields: FieldSchemaSnapshot[] = []): SchemaSnapshot {
  return {
    siteId: 'site',
    environmentId: 'main',
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
      itemType(
        OWNER_MODEL,
        [
          field('title', 'text', SANITIZED),
          field('peer', 'link', { required: {} }),
          field('content', 'rich_text'),
          field('translated', 'rich_text', {}, { localized: true }),
          ...ownerFields,
        ],
        { tree: true },
      ),
      itemType(
        BLOCK_MODEL,
        [
          field('caption', 'string', {}, { defaultValue: 'Default caption' }),
          field('children', 'rich_text'),
        ],
        { modularBlock: true },
      ),
      itemType(REGULAR_MODEL, [field('name', 'string')]),
    ],
    workflows: [],
    digest: 'schema-digest',
  };
}

function block(
  id: string,
  attributes: JsonObject,
  itemTypeId = BLOCK_MODEL,
): JsonObject {
  return {
    attributes,
    id,
    relationships: {
      item_type: { data: { id: itemTypeId, type: 'item_type' } },
    },
    type: 'item',
  };
}

function version(fields: JsonObject, hash = 'hash') {
  return { fields, hash };
}

function recordPlan(
  id: string,
  action: RecordPlan['action'],
  desiredFields: JsonObject | null,
  baselineFields: JsonObject | null,
  parentId: string | null = null,
): RecordPlan {
  const snapshot = (fields: JsonObject, hash: string) =>
    ({
      id,
      itemTypeId: OWNER_MODEL,
      current: version(fields, hash),
      published: null,
      topology: { parentId, position: null },
      validity: { current: true, published: null },
    }) as unknown as RecordPlan['desired'];
  return {
    id,
    itemTypeId: OWNER_MODEL,
    action,
    expectedTargetHash: null,
    baseline: baselineFields ? snapshot(baselineFields, 'baseline') : null,
    desired: desiredFields ? snapshot(desiredFields, 'desired') : null,
    changes: {
      current: true,
      published: false,
      topology: false,
      lifecycle: false,
      stage: false,
      schedules: false,
    },
    dependencies: [],
    publishedDependencies: [],
    allowedIntermediateHashes: [],
  };
}

function makePlan(
  schema: SchemaSnapshot,
  records: RecordPlan[],
  inspectionItemTypes: ItemTypeSchemaSnapshot[] = [],
): ContentDiffPlan {
  return {
    schema,
    records,
    targetInspection: { itemTypes: inspectionItemTypes, digest: 'inspection' },
    options: { includeDeletions: true },
    warnings: [],
    invalidContent: { validatorRelaxations: [] },
    execution: {
      createOrder: records
        .filter(({ action }) => action === 'create')
        .map(({ id }) => id),
      shellRecordIds: [],
      shellComponents: [],
      uniqueReleases: [],
      deleteReleases: [],
      deleteOrder: [],
      publicationSeedOrder: [],
      publishOrder: [],
      updateOrder: records.map(({ id }) => id),
    },
  } as unknown as ContentDiffPlan;
}

function failure(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    return error as Failure;
  }
  throw new Error('Expected the call to fail.');
}

/** Asserts one message on both sides, each with its own class and code. */
function expectBothFail(
  planner: () => unknown,
  runtime: () => unknown,
  codes: { planner: string; runtime: string },
  message: string,
  details?: unknown,
): void {
  const plannerError = failure(planner);
  expect(plannerError).to.be.instanceOf(ContentDiffError);
  expect(plannerError.code).to.equal(codes.planner);
  expect(plannerError.message).to.equal(message);
  const runtimeError = failure(runtime);
  expect(runtimeError.name).to.equal('ContentDiffRuntimeError');
  expect(runtimeError.code).to.equal(codes.runtime);
  expect(runtimeError.message).to.equal(message);
  if (details !== undefined) {
    expect(plannerError.details).to.deep.equal(details);
    expect(runtimeError.details).to.deep.equal(details);
  }
}

describe('shared plan analyses', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimePlanAnalyses;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-plan-analyses-'));
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
    ) as RuntimePlanAnalyses;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('is the plan-analysis code the generated runtime runs', () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include.members([
      'src/content-diff/shared/topology.ts',
      'src/content-diff/shared/create-defaults.ts',
      'src/content-diff/shared/create-sanitization.ts',
      'src/content-diff/shared/fresh-nested-updates.ts',
      'src/content-diff/shared/create-id-contract.ts',
      'src/content-diff/shared/unique-releases.ts',
      'src/content-diff/shared/validation-payload.ts',
    ]);
    for (const name of RUNTIME_EXPORTS) {
      expect(runtime[`__${name}`], name).to.be.a('function');
    }
  });

  it('throws on a desired tree cycle on both sides (D12)', () => {
    const records = [
      recordPlan(RECORD_A, 'update', {}, {}, RECORD_B),
      recordPlan(RECORD_B, 'update', {}, {}, RECORD_A),
    ];
    // Which member of the cycle is named depends on the sort; both sides run
    // the same code, so they name the same one.
    const cycleFailures = (plan: ContentDiffPlan) => [
      failure(() => parentFirst(records)),
      failure(() => runtime.__parentFirst(records)),
      // The planner's sanitizer projection used to order a cycle silently.
      failure(() => findPlanSanitizedHtmlWriteRisks(plan, plan.schema)),
      failure(() =>
        runtime.__findPlanSanitizedHtmlWriteRisks(plan, plan.schema),
      ),
    ];
    const [planner, runtimeError, plannerSanitizer, runtimeSanitizer] =
      cycleFailures(makePlan(makeSchema(), records));
    const recordId = (planner.details as { recordId: string }).recordId;
    expect([RECORD_A, RECORD_B]).to.include(recordId);
    for (const error of [planner, plannerSanitizer]) {
      expect(error).to.be.instanceOf(ContentDiffError);
      expect(error.code).to.equal('UNSUPPORTED_CONTENT_STATE');
    }
    for (const error of [runtimeError, runtimeSanitizer]) {
      expect(error.name).to.equal('ContentDiffRuntimeError');
      expect(error.code).to.equal('TREE_CYCLE');
    }
    for (const error of [
      planner,
      runtimeError,
      plannerSanitizer,
      runtimeSanitizer,
    ]) {
      expect(error.message).to.equal(`Tree cycle includes record ${recordId}.`);
      expect(error.details).to.deep.equal({ recordId });
    }

    const ordered = [
      recordPlan(RECORD_B, 'update', {}, {}, RECORD_A),
      recordPlan(RECORD_A, 'update', {}, {}, null),
    ];
    expect(parentFirst(ordered).map(({ id }) => id)).to.deep.equal([
      RECORD_A,
      RECORD_B,
    ]);
    expect(
      runtime.__parentFirst(ordered).map(({ id }: { id: string }) => id),
    ).to.deep.equal([RECORD_A, RECORD_B]);
  });

  it('reads absolute-position reproducibility null-safely and only from includeDeletions === true', () => {
    const retained = [{ code: 'ABSOLUTE_POSITION_NOT_REPRODUCIBLE' }];
    const cases: Array<[unknown, boolean]> = [
      [{ options: { includeDeletions: true }, warnings: retained }, true],
      [{ options: { includeDeletions: false }, warnings: [] }, true],
      [{ options: { includeDeletions: false }, warnings: retained }, false],
      [{ options: { includeDeletions: 1 }, warnings: retained }, false],
      [{ options: { includeDeletions: 'yes' }, warnings: retained }, false],
      [{ options: null, warnings: [null, ...retained] }, false],
      [{ warnings: [{ code: 'OTHER' }] }, true],
      [{ warnings: null }, true],
      [null, true],
    ];
    for (const [plan, expected] of cases) {
      expect(
        absoluteRecordPositionsReproducible(plan as ContentDiffPlan),
        JSON.stringify(plan),
      ).to.equal(expected);
      expect(
        runtime.__absoluteRecordPositionsReproducible(plan),
        JSON.stringify(plan),
      ).to.equal(expected);
    }
  });

  it('decides the position goal the same way on both sides', () => {
    const positioned = [
      { id: RECORD_A, itemTypeId: OWNER_MODEL, position: 1 },
      { id: RECORD_B, itemTypeId: OWNER_MODEL, position: 2 },
    ].map(({ id, itemTypeId, position }) => ({
      id,
      itemTypeId,
      desired: { topology: { parentId: null, position } },
    }));
    const state = (a: unknown, b: unknown, parentB: string | null = null) =>
      new Map<string, any>([
        [RECORD_A, { itemTypeId: OWNER_MODEL, parentId: null, position: a }],
        [RECORD_B, { itemTypeId: OWNER_MODEL, parentId: parentB, position: b }],
      ]);
    const cases: Array<[Map<string, any>, boolean, boolean]> = [
      [state(1, 2), true, true],
      [state(4, 9), false, true],
      [state(9, 4), false, false],
      [state(1, 'unknown-until-positioned'), false, false],
      [state(1, 2, RECORD_A), false, false],
      [new Map([[RECORD_A, { parentId: null, position: 1 }]]), false, false],
    ];
    for (const [states, absolute, relative] of cases) {
      const label = JSON.stringify([...states]);
      expect(positionGoalReached(positioned, states, true), label).to.equal(
        absolute,
      );
      expect(positionGoalReached(positioned, states, false), label).to.equal(
        relative,
      );
      expect(
        runtime.__positionGoalReached(positioned, states, true),
        label,
      ).to.equal(absolute);
      expect(
        runtime.__positionGoalReached(positioned, states, false),
        label,
      ).to.equal(relative);
      for (const [plan, expected] of [
        [{ options: { includeDeletions: true }, warnings: [] }, absolute],
        [
          {
            options: { includeDeletions: false },
            warnings: [{ code: 'ABSOLUTE_POSITION_NOT_REPRODUCIBLE' }],
          },
          relative,
        ],
      ] as const) {
        expect(
          runtime.__recordPositionGoalReached({ plan }, positioned, states),
          label,
        ).to.equal(expected);
      }
    }
  });

  it('projects sanitizer and fresh-ID create seeds over plan.schema (D11)', () => {
    // plan.schema requires `peer`; the phase schema relaxes that validator.
    // Phase 5 seeds with plan.schema, so a non-shell create holding a
    // required reference to a later create must be rejected, not stripped.
    const schema = makeSchema();
    const records = [
      recordPlan(RECORD_A, 'create', { title: 'A', peer: RECORD_B }, null),
      recordPlan(RECORD_B, 'create', { title: 'B', peer: null }, null),
    ];
    const plan = makePlan(schema, records);
    const relaxed = schemaWithValidatorRelaxations(schema, [
      { fieldId: 'field-peer', relaxedValidators: {} },
    ]);
    const message = `record ${RECORD_A}.peer requires record ${RECORD_B} before it can be created.`;
    const cycle = {
      planner: 'REQUIRED_REFERENCE_CYCLE',
      runtime: 'REQUIRED_REFERENCE_CYCLE',
    };
    expectBothFail(
      () => findPlanSanitizedHtmlWriteRisks(plan, relaxed),
      () => runtime.__findPlanSanitizedHtmlWriteRisks(plan, relaxed),
      cycle,
      message,
    );
    expectBothFail(
      () => unsafeFreshNestedCreateRecordIds(plan),
      () => runtime.__unsafeFreshNestedCreateRecordIds(plan),
      cycle,
      message,
    );

    // A create seed holding a block of an inspection-only model cannot be
    // projected over plan.schema either, although the phase schema knows it.
    const inspection = itemType(INSPECTION_MODEL, [field('note', 'string')], {
      modularBlock: true,
    });
    const inspectionPlan = makePlan(
      schema,
      [
        recordPlan(
          RECORD_A,
          'create',
          {
            title: 'A',
            peer: null,
            content: [block(BLOCK_ID, { note: 'x' }, INSPECTION_MODEL)],
          },
          null,
        ),
      ],
      [inspection],
    );
    const unknownBlock = `Nested block ${BLOCK_ID} refers to unknown block model ${INSPECTION_MODEL}.`;
    const unknownModel = {
      planner: 'INCOMPATIBLE_SCHEMA',
      runtime: 'SCHEMA_MISMATCH',
    };
    expectBothFail(
      () => findPlanSanitizedHtmlWriteRisks(inspectionPlan, schema),
      () => runtime.__findPlanSanitizedHtmlWriteRisks(inspectionPlan, schema),
      unknownModel,
      unknownBlock,
    );
    expectBothFail(
      () => unsafeFreshNestedCreateRecordIds(inspectionPlan),
      () => runtime.__unsafeFreshNestedCreateRecordIds(inspectionPlan),
      unknownModel,
      unknownBlock,
    );
  });

  it('finds the same sanitizer risks from the planner and the runtime entry points', () => {
    const schema = makeSchema();
    const plan = makePlan(schema, [
      recordPlan(RECORD_A, 'create', { title: '<b>A</b>', peer: null }, null),
      recordPlan(
        RECORD_B,
        'update',
        { title: 'B & C', peer: RECORD_A },
        { title: 'B', peer: null },
      ),
    ]);
    const expected = [
      {
        recordId: RECORD_A,
        itemTypeId: OWNER_MODEL,
        fieldId: 'field-title',
        stage: 'create',
        path: `record:${RECORD_A}.title`,
        locale: null,
      },
      {
        recordId: RECORD_B,
        itemTypeId: OWNER_MODEL,
        fieldId: 'field-title',
        stage: 'current-restore',
        path: `record:${RECORD_B}.title`,
        locale: null,
      },
    ];
    expect(findPlanSanitizedHtmlWriteRisks(plan, schema)).to.deep.equal(
      expected,
    );
    expect(
      runtime.__findPlanSanitizedHtmlWriteRisks(plan, schema),
    ).to.deep.equal(expected);
    // The plan entry point is the lower-level projection over the exact
    // phase-5 seeds.
    expect(
      findSanitizedHtmlWriteRisks(
        plan.records,
        schema,
        projectPlanCreateSeedFields(plan),
        { ...plan.execution, absoluteRecordPositionsReproducible: true },
      ),
    ).to.deep.equal(expected);
  });

  it('reports an unresolvable sanitizer model with one message and each side keeping its code (D25)', () => {
    const schema = makeSchema();
    const unknownBlock = block(BLOCK_ID, { name: 'x' }, REGULAR_MODEL);
    const records = [
      recordPlan(
        RECORD_A,
        'update',
        { title: 'A2', content: [unknownBlock] },
        { title: 'A', content: [unknownBlock] },
      ),
    ];
    const execution = {
      ...makePlan(schema, records).execution,
      absoluteRecordPositionsReproducible: true,
    };
    const seeds = new Map<string, JsonObject>();
    const path = `record:${RECORD_A}.content[0]`;
    expectBothFail(
      () => findSanitizedHtmlWriteRisks(records, schema, seeds, execution),
      () =>
        runtime.__findSanitizedHtmlWriteRisks(
          records,
          schema,
          seeds,
          execution,
        ),
      { planner: 'UNSUPPORTED_CONTENT_STATE', runtime: 'INVALID_PLAN' },
      `Cannot prove sanitized_html byte stability because item type ${REGULAR_MODEL} at ${path} is absent from the captured traversal schema.`,
      { recordId: RECORD_A, itemTypeId: REGULAR_MODEL, path },
    );
  });

  it('reads sanitizer validators null-safely on both sides (D44)', () => {
    const schema = makeSchema([field('summary', 'text', null)]);
    const plan = makePlan(schema, [
      recordPlan(RECORD_A, 'create', { summary: '<b>x</b>', peer: null }, null),
    ]);
    expect(findPlanSanitizedHtmlWriteRisks(plan, schema)).to.deep.equal([]);
    expect(
      runtime.__findPlanSanitizedHtmlWriteRisks(plan, schema),
    ).to.deep.equal([]);
  });

  it('reports a missing projected create seed as an invalid plan on both sides (D33)', () => {
    const schema = makeSchema();
    const records = [recordPlan(RECORD_A, 'create', { title: 'A' }, null)];
    expectBothFail(
      () => deriveCreateDefaultValueSuppressions(records, schema, new Map()),
      () =>
        runtime.__deriveCreateDefaultValueSuppressions(
          records,
          schema,
          new Map(),
        ),
      { planner: 'UNSUPPORTED_CONTENT_STATE', runtime: 'INVALID_PLAN' },
      `Missing projected phase-5 create seed for record ${RECORD_A}.`,
      { recordId: RECORD_A },
    );
  });

  it('requires a block model and names the field path when applying create defaults (D5, D2)', () => {
    const schema = makeSchema();
    const owner = schema.itemTypes[0];
    const filled = applyCreateDefaultsToFields(
      { content: [block(BLOCK_ID, { children: [] })] },
      owner,
      schema,
    );
    expect(
      runtime.__applyCreateDefaultsToFields(
        { content: [block(BLOCK_ID, { children: [] })] },
        owner,
        schema,
      ),
    ).to.deep.equal(filled);
    expect(
      ((filled.content as JsonObject[])[0].attributes as JsonObject).caption,
    ).to.equal('Default caption');

    for (const itemTypeId of [REGULAR_MODEL, 'missing-model']) {
      const fields = { content: [block(BLOCK_ID, { name: 'x' }, itemTypeId)] };
      expectBothFail(
        () => applyCreateDefaultsToFields(fields, owner, schema),
        () => runtime.__applyCreateDefaultsToFields(fields, owner, schema),
        { planner: 'INCOMPATIBLE_SCHEMA', runtime: 'SCHEMA_MISMATCH' },
        `Nested block ${BLOCK_ID} refers to unknown block model ${itemTypeId}.`,
        { blockId: BLOCK_ID, itemTypeId, fieldPath: 'content' },
      );
    }

    const nested = {
      content: [
        block(BLOCK_ID, {
          children: [{ ...block(RECORD_B, {}), attributes: null }],
        }),
      ],
    };
    const path = `content.block:${BLOCK_ID}.children`;
    expectBothFail(
      () => applyCreateDefaultsToFields(nested, owner, schema),
      () => runtime.__applyCreateDefaultsToFields(nested, owner, schema),
      { planner: 'UNSUPPORTED_CONTENT_STATE', runtime: 'INVALID_CMA_RESPONSE' },
      `Nested content at ${path} has malformed block attributes.`,
      { path },
    );
  });

  it('resolves fresh-ID models through desired.itemTypeId and rejects unknown ones (D18)', () => {
    const schema = makeSchema();
    const desired = {
      title: 'A',
      content: [block(BLOCK_ID, { caption: 'x' })],
    };
    const created = recordPlan(RECORD_A, 'create', desired, null);
    const withoutTopLevelModel = {
      ...created,
      itemTypeId: undefined,
    } as unknown as RecordPlan;
    expect(
      collectFreshNestedBlockCreateIds([withoutTopLevelModel], schema),
    ).to.deep.equal([BLOCK_ID]);
    expect(
      runtime.__collectFreshNestedBlockCreateIds(
        [withoutTopLevelModel],
        schema,
      ),
    ).to.deep.equal([BLOCK_ID]);

    const unknown = {
      ...created,
      desired: { ...created.desired!, itemTypeId: 'missing-model' },
    } as RecordPlan;
    const message =
      'Content refers to item type missing-model, which is absent from the scoped schema.';
    const codes = {
      planner: 'INCOMPATIBLE_SCHEMA',
      runtime: 'SCHEMA_MISMATCH',
    };
    expectBothFail(
      () => collectFreshNestedBlockCreateIds([unknown], schema),
      () => runtime.__collectFreshNestedBlockCreateIds([unknown], schema),
      codes,
      message,
    );
    const updated = recordPlan(RECORD_A, 'update', desired, { title: 'old' });
    const unknownUpdate = {
      ...updated,
      desired: { ...updated.desired!, itemTypeId: 'missing-model' },
    } as RecordPlan;
    expectBothFail(
      () => findUnsupportedFreshNestedBlockUpdates([unknownUpdate], schema),
      () =>
        runtime.__findUnsupportedFreshNestedBlockUpdates(
          [unknownUpdate],
          schema,
        ),
      codes,
      message,
    );
  });

  it('checks unique releases with null-safe validators and fields on both sides (D34)', () => {
    const owner = itemType(OWNER_MODEL, [
      field('slug', 'slug', { unique: {} }),
      field('code', 'string', null),
      field('names', 'string', { unique: {} }, { localized: true }),
    ]);
    const cases: Array<[ItemTypeSchemaSnapshot | undefined, unknown, unknown]> =
      [
        [owner, { slug: 'a', names: { en: null } }, null],
        [
          undefined,
          { slug: 'a' },
          {
            fieldApiKey: '<item-type>',
            reason: 'does not belong to a managed item type',
          },
        ],
        [
          owner,
          null,
          { fieldApiKey: '<empty>', reason: 'contains no field release' },
        ],
        [
          owner,
          {},
          { fieldApiKey: '<empty>', reason: 'contains no field release' },
        ],
        [
          owner,
          { code: 'x' },
          {
            fieldApiKey: 'code',
            reason:
              'does not resolve to a string, slug, or link field carrying a unique validator',
          },
        ],
        [
          owner,
          { names: ['x'] },
          {
            fieldApiKey: 'names',
            reason:
              'contains a non-scalar or embedded value instead of string/null unique data',
          },
        ],
      ];
    for (const [model, fields, expected] of cases) {
      const release = { fields } as never;
      expect(uniqueReleaseFieldError(model, release)).to.deep.equal(expected);
      expect(runtime.__uniqueReleaseFieldError(model, release)).to.deep.equal(
        expected,
      );
    }
  });

  it('builds validation payloads with one message per failure and real paths', () => {
    const schema = makeSchema();
    const lookup = new Map(schema.itemTypes.map((entry) => [entry.id, entry]));
    const context = { captureSchemaById: lookup };
    const fields = {
      title: 'A',
      content: [block(BLOCK_ID, { caption: 'x', children: [] })],
    };
    const expected = {
      title: 'A',
      content: [
        {
          type: 'item',
          attributes: { caption: 'x', children: [] },
          relationships: {
            item_type: { data: { id: BLOCK_MODEL, type: 'item_type' } },
          },
        },
      ],
    };
    expect(
      buildRecordValidationPayload(fields, OWNER_MODEL, schema),
    ).to.deep.equal(expected);
    expect(
      runtime.__buildRuntimeRecordValidationPayload(
        context,
        fields,
        OWNER_MODEL,
      ),
    ).to.deep.equal(expected);

    const codes = {
      planner: 'UNSUPPORTED_CONTENT_STATE',
      runtime: 'INVALID_PLAN',
    };
    expectBothFail(
      () => buildRecordValidationPayload(fields, 'missing-model', schema),
      () =>
        runtime.__buildRuntimeRecordValidationPayload(
          context,
          fields,
          'missing-model',
        ),
      codes,
      'Validation payload refers to unknown item type missing-model.',
      { itemTypeId: 'missing-model' },
    );
    const unknownBlock = {
      content: [block(BLOCK_ID, { caption: 'x' }, 'missing-block-model')],
    };
    expectBothFail(
      () => buildRecordValidationPayload(unknownBlock, OWNER_MODEL, schema),
      () =>
        runtime.__buildRuntimeRecordValidationPayload(
          context,
          unknownBlock,
          OWNER_MODEL,
        ),
      codes,
      'Nested validation payload refers to unknown model missing-block-model.',
      { itemTypeId: 'missing-block-model' },
    );
    const regular = {
      content: [block(BLOCK_ID, { name: 'x' }, REGULAR_MODEL)],
    };
    expectBothFail(
      () => buildRecordValidationPayload(regular, OWNER_MODEL, schema),
      () =>
        runtime.__buildRuntimeRecordValidationPayload(
          context,
          regular,
          OWNER_MODEL,
        ),
      codes,
      `Nested validation payload refers to non-block model ${REGULAR_MODEL}.`,
      { itemTypeId: REGULAR_MODEL },
    );
    const malformed = {
      content: [
        block(BLOCK_ID, {
          children: [{ ...block(RECORD_B, {}), attributes: [] }],
        }),
      ],
    };
    const path = `content.block:${BLOCK_ID}.children`;
    expectBothFail(
      () => buildRecordValidationPayload(malformed, OWNER_MODEL, schema),
      () =>
        runtime.__buildRuntimeRecordValidationPayload(
          context,
          malformed,
          OWNER_MODEL,
        ),
      { planner: 'UNSUPPORTED_CONTENT_STATE', runtime: 'INVALID_CMA_RESPONSE' },
      `Nested content at ${path} has malformed block attributes.`,
      { path },
    );
  });

  it('copies a localized validation value that is not a locale object unchanged (D45)', () => {
    const schema = makeSchema();
    const fields = { translated: [block(BLOCK_ID, { caption: 'x' })] };
    expect(
      buildRecordValidationPayload(fields, OWNER_MODEL, schema),
    ).to.deep.equal(fields);
    expect(
      runtime.__buildRecordValidationPayload(fields, OWNER_MODEL, schema),
    ).to.deep.equal(fields);
    const localized = {
      translated: { en: [block(BLOCK_ID, { caption: 'x' })] },
    };
    const converted = buildRecordValidationPayload(
      localized,
      OWNER_MODEL,
      schema,
    );
    expect(
      ((converted.translated as JsonObject).en as JsonObject[])[0],
    ).to.not.have.property('id');
    expect(
      runtime.__buildRecordValidationPayload(localized, OWNER_MODEL, schema),
    ).to.deep.equal(converted);
  });
});
