import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import * as inspectionSchema from '../../src/content-diff/inspection-schema';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import {
  fetchSchemaSnapshot,
  migrationsTrackingModelId,
  schemaForScope,
} from '../../src/content-diff/schema';
import * as schemaModule from '../../src/content-diff/schema';
import * as shared from '../../src/content-diff/shared/schema-state';
import {
  ContentDiffError,
  type ItemTypeSchemaSnapshot,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

type RuntimeError = Error & { code: string; details: unknown };

interface RuntimeSchemaState {
  __fetchTargetSchemaState(context: Record<string, any>): Promise<{
    semanticSchema: unknown;
    digest: string;
    inspectionDigest: string;
  }>;
  __environmentSemanticsFromSite(site: unknown): unknown;
  __isEnvironmentSemantics(value: unknown): boolean;
  __normalizeItemTypeSnapshot(itemType: unknown, fields: unknown[]): unknown;
  __schemaWithInspectionItemTypes(schema: unknown, itemTypes: unknown): unknown;
  __schemaWithValidatorRelaxations(schema: unknown, relaxations: unknown): any;
  __computeSchemaDigest(schema: unknown): string;
  __assertExactMigrationsTrackingModel(
    model: unknown,
    fields: unknown[],
    apiKey: string,
  ): void;
}

const MIGRATIONS_API_KEY = 'schema_migration';
const SETTINGS = [
  'improvedTimezoneManagement',
  'improvedBooleanFields',
  'improvedValidationAtPublishing',
  'millisecondsInDatetime',
  'nonLocalizedFocalPoints',
  'improvedHexManagement',
];

function cmaSite(): Record<string, any> {
  return {
    id: 'site',
    locales: ['en', 'it'],
    timezone: 'Europe/Rome',
    meta: {
      improved_timezone_management: true,
      improved_boolean_fields: false,
      improved_validation_at_publishing: true,
      milliseconds_in_datetime: false,
      non_localized_focal_points: true,
      improved_hex_management: true,
    },
  };
}

function cmaItemType(
  id: string,
  apiKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  return {
    id,
    type: 'item_type',
    name: apiKey,
    api_key: apiKey,
    modular_block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draft_mode_active: false,
    draft_saving_active: false,
    all_locales_required: false,
    workflow: null,
    ...overrides,
  };
}

function cmaField(
  id: string,
  apiKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  return {
    id,
    type: 'field',
    api_key: apiKey,
    field_type: 'string',
    localized: false,
    position: 1,
    default_value: null,
    validators: {},
    ...overrides,
  };
}

/** A project with a managed article, its block, an out-of-scope block and the tracking model. */
function cmaProject(): {
  site: Record<string, any>;
  itemTypes: Record<string, any>[];
  workflows: Record<string, any>[];
  fields: Map<string, Record<string, any>[]>;
} {
  return {
    site: cmaSite(),
    itemTypes: [
      cmaItemType('article-model', 'article', {
        draft_mode_active: true,
        workflow: { id: 'workflow-1', type: 'workflow' },
      }),
      cmaItemType('block-model', 'text_block', { modular_block: true }),
      cmaItemType('legacy-block-model', 'legacy_block', {
        modular_block: true,
      }),
      cmaItemType('other-model', 'other'),
      cmaItemType('migrations-model', MIGRATIONS_API_KEY, {
        name: 'Schema migration',
      }),
    ],
    workflows: [
      {
        id: 'workflow-1',
        type: 'workflow',
        api_key: 'review',
        stages: [
          { id: 'draft', name: 'Draft', initial: true },
          { id: 'review', name: 'Review' },
        ],
      },
      {
        id: 'workflow-2',
        type: 'workflow',
        api_key: 'unused',
        stages: [{ id: 'only', name: 'Only', initial: true }],
      },
    ],
    fields: new Map([
      [
        'article-model',
        [
          cmaField('title-field', 'title', {
            localized: true,
            default_value: { it: null, en: 'Untitled' },
            validators: { required: {}, length: { min: 1, max: 80 } },
          }),
          cmaField('a-subtitle-field', 'subtitle'),
          cmaField('body-field', 'body', {
            field_type: 'rich_text',
            position: 2,
            default_value: undefined,
            validators: {
              size: { max: 3 },
              rich_text_blocks: { item_types: ['block-model'] },
            },
          }),
        ],
      ],
      ['block-model', [cmaField('text-field', 'text')]],
      ['legacy-block-model', [cmaField('legacy-text-field', 'text')]],
      ['other-model', [cmaField('other-field', 'name')]],
      [
        'migrations-model',
        [cmaField('migration-name', 'name', { validators: { required: {} } })],
      ],
    ]),
  };
}

function cmaClient(project = cmaProject()): {
  client: any;
  fieldReads: string[];
} {
  const fieldReads: string[] = [];
  return {
    fieldReads,
    client: {
      site: { find: async () => structuredClone(project.site) },
      itemTypes: { list: async () => structuredClone(project.itemTypes) },
      workflows: { list: async () => structuredClone(project.workflows) },
      fields: {
        list: async (itemTypeId: string) => {
          fieldReads.push(itemTypeId);
          return structuredClone(project.fields.get(itemTypeId) ?? []);
        },
      },
    },
  };
}

/** The planner normalizer, fed hand-built CMA resources. */
function normalizeModel(
  model: unknown,
  fields: unknown[],
): ItemTypeSchemaSnapshot {
  type Input = Parameters<typeof shared.normalizeItemTypeSnapshot>;
  return shared.normalizeItemTypeSnapshot(
    model as Input[0],
    fields as unknown as Input[1],
  );
}

async function capture(task: () => unknown): Promise<Error> {
  try {
    await task();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail.');
}

async function expectPlannerFailure(
  task: () => unknown,
  code: string,
  message: string,
  details?: unknown,
): Promise<void> {
  const error = (await capture(task)) as ContentDiffError;
  expect(error).to.be.instanceOf(ContentDiffError);
  expect(error.code).to.equal(code);
  expect(error.message).to.equal(message);
  expect(error.details).to.deep.equal(details);
}

async function expectRuntimeFailure(
  task: () => unknown,
  code: string,
  message: string,
  details: unknown = null,
): Promise<void> {
  const error = (await capture(task)) as RuntimeError;
  expect(error.name).to.equal('ContentDiffRuntimeError');
  expect(error.code).to.equal(code);
  expect(error.message).to.equal(message);
  expect(error.details).to.deep.equal(details);
}

describe('shared schema semantic state and inspection helpers', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimeSchemaState;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-shared-schema-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        'module.exports.__fetchTargetSchemaState = fetchTargetSchemaState;',
        'module.exports.__environmentSemanticsFromSite = environmentSemanticsFromSite;',
        'module.exports.__isEnvironmentSemantics = isEnvironmentSemantics;',
        'module.exports.__normalizeItemTypeSnapshot = normalizeItemTypeSnapshot;',
        'module.exports.__schemaWithInspectionItemTypes = schemaWithInspectionItemTypes;',
        'module.exports.__schemaWithValidatorRelaxations = schemaWithValidatorRelaxations;',
        'module.exports.__computeSchemaDigest = computeSchemaDigest;',
        'module.exports.__assertExactMigrationsTrackingModel = assertExactMigrationsTrackingModel;',
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimeSchemaState;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  /** Captures and scopes the project the way content:diff does. */
  async function plannerSchema(project = cmaProject()): Promise<{
    scoped: SchemaSnapshot;
    inspection: ItemTypeSchemaSnapshot[];
  }> {
    const full = await fetchSchemaSnapshot(cmaClient(project).client, 'main');
    return {
      scoped: schemaForScope(full, ['article'], MIGRATIONS_API_KEY),
      inspection: full.itemTypes.filter(
        ({ id }) => id === 'legacy-block-model',
      ),
    };
  }

  function runtimeContext(
    client: unknown,
    scoped: SchemaSnapshot,
    inspection: ItemTypeSchemaSnapshot[],
  ): Record<string, any> {
    return {
      client,
      options: {},
      plan: structuredClone({
        target: { siteId: scoped.siteId },
        schema: scoped,
        targetInspection: { itemTypes: inspection },
        options: { migrationsModelApiKey: MIGRATIONS_API_KEY },
      }),
    };
  }

  it('is the schema-state code the generated runtime runs', () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include(
      'src/content-diff/shared/schema-state.ts',
    );
    expect(schemaModule.computeSchemaDigest).to.equal(
      shared.computeSchemaDigest,
    );
    expect(schemaModule.schemaSemanticState).to.equal(
      shared.schemaSemanticState,
    );
    expect(inspectionSchema.inspectionItemTypesDigest).to.equal(
      shared.inspectionItemTypesDigest,
    );
    expect(inspectionSchema.schemaWithInspectionItemTypes).to.equal(
      shared.schemaWithInspectionItemTypes,
    );
  });

  it('computes the runtime target digest exactly as the planner digests the scoped snapshot', async () => {
    const { scoped, inspection } = await plannerSchema();
    expect(scoped.itemTypes.map(({ id }) => id)).to.deep.equal([
      'article-model',
      'block-model',
    ]);
    expect(scoped.workflows.map(({ id }) => id)).to.deep.equal(['workflow-1']);
    expect(
      scoped.itemTypes[0].fields.map(({ id, defaultValue }) => [
        id,
        defaultValue,
      ]),
    ).to.deep.equal([
      ['a-subtitle-field', null],
      ['title-field', { en: 'Untitled', it: null }],
      ['body-field', null],
    ]);

    const { client } = cmaClient();
    const context = runtimeContext(client, scoped, inspection);
    const actual = await runtime.__fetchTargetSchemaState(context);
    expect(actual.digest).to.equal(scoped.digest);
    expect(actual.digest).to.equal(runtime.__computeSchemaDigest(scoped));
    expect(actual.semanticSchema).to.deep.equal(
      shared.schemaSemanticState(scoped),
    );
    expect(actual.inspectionDigest).to.equal(
      shared.inspectionItemTypesDigest(inspection),
    );
    expect(context.targetItemTypes).to.deep.equal([
      { id: 'article-model', modularBlock: false, workflowId: 'workflow-1' },
      { id: 'block-model', modularBlock: true, workflowId: null },
      { id: 'legacy-block-model', modularBlock: true, workflowId: null },
      { id: 'other-model', modularBlock: false, workflowId: null },
    ]);

    // A changed target validator moves both digests the same way.
    const changed = cmaProject();
    changed.fields.get('block-model')![0].validators = { required: {} };
    const refetched = await plannerSchema(changed);
    const changedActual = await runtime.__fetchTargetSchemaState(
      runtimeContext(cmaClient(changed).client, scoped, inspection),
    );
    expect(changedActual.digest).to.not.equal(scoped.digest);
    expect(changedActual.digest).to.equal(refetched.scoped.digest);
  });

  it('rejects a site response without exact environment semantics on both sides (D36)', async () => {
    const { scoped, inspection } = await plannerSchema();
    const cases: Array<[(site: Record<string, any>) => void, string[]]> = [
      [(site) => Reflect.deleteProperty(site, 'meta'), SETTINGS],
      [
        (site) => {
          site.meta = null;
        },
        SETTINGS,
      ],
      [
        (site) => Reflect.deleteProperty(site.meta, 'improved_hex_management'),
        ['improvedHexManagement'],
      ],
      [
        (site) => {
          site.meta.improved_boolean_fields = 'true';
        },
        ['improvedBooleanFields'],
      ],
      [
        (site) => {
          site.timezone = '';
        },
        ['timezone'],
      ],
      [
        (site) => {
          Reflect.deleteProperty(site, 'timezone');
          Reflect.deleteProperty(site.meta, 'milliseconds_in_datetime');
        },
        ['timezone', 'millisecondsInDatetime'],
      ],
    ];
    for (const [mutate, invalidSettings] of cases) {
      const project = cmaProject();
      mutate(project.site);
      const message = `The CMA site response is missing environment content-semantics settings: ${invalidSettings.join(
        ', ',
      )}.`;
      await expectPlannerFailure(
        () => fetchSchemaSnapshot(cmaClient(project).client, 'main'),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        { invalidSettings },
      );
      const { client, fieldReads } = cmaClient(project);
      await expectRuntimeFailure(
        () =>
          runtime.__fetchTargetSchemaState(
            runtimeContext(client, scoped, inspection),
          ),
        'INVALID_CMA_RESPONSE',
        message,
        { invalidSettings },
      );
      expect(fieldReads).to.deep.equal([]);
    }

    // Complete but different settings are still a semantics mismatch.
    const project = cmaProject();
    project.site.meta.improved_boolean_fields = true;
    const error = (await capture(() =>
      runtime.__fetchTargetSchemaState(
        runtimeContext(cmaClient(project).client, scoped, inspection),
      ),
    )) as RuntimeError;
    expect(error.code).to.equal('ENVIRONMENT_SEMANTICS_MISMATCH');
  });

  it('accepts only exact environment semantics on both sides', () => {
    const semantics = shared.environmentSemanticsFromSite(cmaSite());
    expect(semantics).to.deep.equal({
      timezone: 'Europe/Rome',
      improvedTimezoneManagement: true,
      improvedBooleanFields: false,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: false,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    });
    expect(runtime.__environmentSemanticsFromSite(cmaSite())).to.deep.equal(
      semantics,
    );
    const cases: Array<[unknown, boolean]> = [
      [semantics, true],
      [{ ...semantics, extra: true }, false],
      [{ ...semantics, improvedHexManagement: undefined }, false],
      [{ ...semantics, improvedHexManagement: 1 }, false],
      [{ ...semantics, timezone: '' }, false],
      [null, false],
      [[], false],
      ['semantics', false],
    ];
    for (const [value, expected] of cases) {
      expect(shared.isEnvironmentSemantics(value)).to.equal(expected);
      expect(runtime.__isEnvironmentSemantics(value)).to.equal(expected);
    }
  });

  it('decides the migrations tracking model with one predicate, each side keeping its code (D31)', async () => {
    const exactModel = () =>
      cmaItemType('migrations-model', MIGRATIONS_API_KEY, {
        name: 'Schema migration',
      });
    const exactFields = () => [
      cmaField('migration-name', 'name', { validators: { required: {} } }),
    ];
    const cases: Array<
      [string, (model: any, fields: any[]) => unknown, boolean]
    > = [
      ['exact', () => undefined, true],
      // Normalization reads a missing default value as null on both sides.
      [
        'missing default',
        (_, fields) => Reflect.deleteProperty(fields[0], 'default_value'),
        true,
      ],
      [
        'renamed',
        (model) => {
          model.name = 'Migrations';
        },
        false,
      ],
      [
        'localized',
        (_, fields) => {
          fields[0].localized = true;
        },
        false,
      ],
      [
        'default value',
        (_, fields) => {
          fields[0].default_value = 'x';
        },
        false,
      ],
      [
        'extra validator',
        (_, fields) => {
          fields[0].validators = { required: {}, unique: {} };
        },
        false,
      ],
      [
        'extra field',
        (_, fields) => fields.push(cmaField('other', 'other', { position: 2 })),
        false,
      ],
      [
        'workflow',
        (model) => {
          model.workflow = { id: 'workflow-1', type: 'workflow' };
        },
        false,
      ],
      [
        'draft mode',
        (model) => {
          model.draft_mode_active = true;
        },
        false,
      ],
    ];
    for (const [label, mutate, exact] of cases) {
      const model = exactModel();
      const fields = exactFields();
      mutate(model, fields);
      const normalized = normalizeModel(model, fields);
      expect(
        shared.isExactMigrationsTrackingModel(normalized, MIGRATIONS_API_KEY),
        label,
      ).to.equal(exact);
      const schema = { itemTypes: [normalized] } as unknown as SchemaSnapshot;
      if (exact) {
        expect(migrationsTrackingModelId(schema, MIGRATIONS_API_KEY)).to.equal(
          'migrations-model',
        );
        runtime.__assertExactMigrationsTrackingModel(
          model,
          fields,
          MIGRATIONS_API_KEY,
        );
      } else {
        await expectPlannerFailure(
          () => migrationsTrackingModelId(schema, MIGRATIONS_API_KEY),
          'INVALID_MIGRATIONS_MODEL',
          'Configured migrations model schema_migration does not match the exact internal tracking-model contract created by migrations:run.',
          {
            migrationsModelApiKey: MIGRATIONS_API_KEY,
            itemTypeId: 'migrations-model',
          },
        );
        await expectRuntimeFailure(
          () =>
            runtime.__assertExactMigrationsTrackingModel(
              model,
              fields,
              MIGRATIONS_API_KEY,
            ),
          'MIGRATIONS_MODEL_CONFLICT',
          'Configured migrations model schema_migration does not match the exact internal tracking-model contract created by migrations:run.',
          { itemTypeId: 'migrations-model' },
        );
      }
    }
    expect(
      shared.isExactMigrationsTrackingModel(
        normalizeModel(exactModel(), exactFields()),
        'other_key',
      ),
    ).to.equal(false);
  });

  it('reads a workflow relationship as a string ID or null and rejects anything else (D43)', async () => {
    const accepted: Array<[unknown, string | null]> = [
      [null, null],
      [undefined, null],
      [{ id: 'workflow-1', type: 'workflow' }, 'workflow-1'],
    ];
    for (const [workflow, workflowId] of accepted) {
      const model = cmaItemType('article-model', 'article', { workflow });
      const planner = normalizeModel(model, []);
      expect(planner.workflowId).to.equal(workflowId);
      expect(
        runtime.__normalizeItemTypeSnapshot(structuredClone(model), []),
      ).to.deep.equal(planner);
    }
    for (const workflow of [{ id: '' }, { data: null }, { id: 5 }, 'wf']) {
      const model = cmaItemType('article-model', 'article', { workflow });
      const message =
        'Item type article-model has a malformed workflow relationship.';
      await expectPlannerFailure(
        () => normalizeModel(model, []),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        { itemTypeId: 'article-model' },
      );
      await expectRuntimeFailure(
        () => runtime.__normalizeItemTypeSnapshot(model, []),
        'INVALID_CMA_RESPONSE',
        message,
        { itemTypeId: 'article-model' },
      );
    }

    // The runtime target fetch applies the same rule to managed models.
    const { scoped, inspection } = await plannerSchema();
    const project = cmaProject();
    project.itemTypes[0].workflow = { id: '' };
    await expectRuntimeFailure(
      () =>
        runtime.__fetchTargetSchemaState(
          runtimeContext(cmaClient(project).client, scoped, inspection),
        ),
      'INVALID_CMA_RESPONSE',
      'Item type article-model has a malformed workflow relationship.',
      { itemTypeId: 'article-model' },
    );

    // Models outside the plan feed the permission-proof model set, which the
    // planner reads from its full schema under the same rule.
    const context = runtimeContext(cmaClient().client, scoped, inspection);
    await runtime.__fetchTargetSchemaState(context);
    const full = await fetchSchemaSnapshot(cmaClient().client, 'main');
    expect(context.targetItemTypes).to.deep.equal(
      full.itemTypes
        .filter(({ id }) => id !== 'migrations-model')
        .map(({ id, modularBlock, workflowId }) => ({
          id,
          modularBlock,
          workflowId,
        })),
    );
    const outside = cmaProject();
    outside.itemTypes[3].workflow = { id: 5 };
    await expectPlannerFailure(
      () => fetchSchemaSnapshot(cmaClient(outside).client, 'main'),
      'UNSUPPORTED_CONTENT_STATE',
      'Item type other-model has a malformed workflow relationship.',
      { itemTypeId: 'other-model' },
    );
    await expectRuntimeFailure(
      () =>
        runtime.__fetchTargetSchemaState(
          runtimeContext(cmaClient(outside).client, scoped, inspection),
        ),
      'INVALID_CMA_RESPONSE',
      'Item type other-model has a malformed workflow relationship.',
      { itemTypeId: 'other-model' },
    );
  });

  it('merges inspection models and rejects an overlap on both sides (D13)', async () => {
    const { scoped, inspection } = await plannerSchema();
    const merged = shared.schemaWithInspectionItemTypes(scoped, inspection);
    expect(merged.itemTypes.map(({ id }) => id)).to.deep.equal([
      'article-model',
      'block-model',
      'legacy-block-model',
    ]);
    expect(merged.digest).to.equal(scoped.digest);
    expect(
      runtime.__schemaWithInspectionItemTypes(
        structuredClone(scoped),
        structuredClone(inspection),
      ),
    ).to.deep.equal(merged);

    const overlapping = [...scoped.itemTypes].reverse();
    const message =
      'Inspection schema overlaps managed item types: article-model, block-model.';
    const details = { itemTypeIds: ['article-model', 'block-model'] };
    await expectPlannerFailure(
      () => shared.schemaWithInspectionItemTypes(scoped, overlapping),
      'UNSUPPORTED_CONTENT_STATE',
      message,
      details,
    );
    await expectRuntimeFailure(
      () => runtime.__schemaWithInspectionItemTypes(scoped, overlapping),
      'INVALID_PLAN',
      message,
      details,
    );
  });

  it('relaxes validators into the full schema with its digest on both sides', async () => {
    const { scoped } = await plannerSchema();
    const relaxations = [
      { fieldId: 'title-field', relaxedValidators: { required: {} } },
    ];
    const relaxed = shared.schemaWithValidatorRelaxations(scoped, relaxations);
    expect(relaxed.siteId).to.equal(scoped.siteId);
    expect(relaxed.itemTypes[0].name).to.equal('article');
    expect(
      relaxed.itemTypes[0].fields.find(({ id }) => id === 'title-field')!
        .validators,
    ).to.deep.equal({ required: {} });
    expect(relaxed.digest).to.equal(shared.computeSchemaDigest(relaxed));
    expect(relaxed.digest).to.not.equal(scoped.digest);
    expect(
      scoped.itemTypes[0].fields.find(({ id }) => id === 'title-field')!
        .validators,
    ).to.deep.equal({ length: { max: 80, min: 1 }, required: {} });

    const executed = runtime.__schemaWithValidatorRelaxations(
      structuredClone(scoped),
      relaxations,
    );
    expect(executed).to.deep.equal(relaxed);
    expect(runtime.__computeSchemaDigest(executed)).to.equal(relaxed.digest);
    expect(shared.schemaWithValidatorRelaxations(scoped, []).digest).to.equal(
      scoped.digest,
    );
  });
});
