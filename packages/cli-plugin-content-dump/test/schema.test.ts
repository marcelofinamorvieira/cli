import assert from 'node:assert/strict';
import { CmaClient, oclif } from '@datocms/cli-utils';
import type { Dump } from '../src/dump/format';
import type { ZipReader } from '../src/dump/zip';
import { assertSameSchema } from '../src/import/schema-check';
import {
  type FieldView,
  type ModelSettings,
  type ModelView,
  type RawSchema,
  type SchemaView,
  readRawSchema,
  schemaDifferences,
  schemaView,
} from '../src/schema';
import { fixtureId } from './fixture-id';

const SITE_ID = '4242';
const ARTICLE = fixtureId('article');
const TEXT = fixtureId('text_block');
const TRACKING = fixtureId('schema_migration');
const EDITORIAL = fixtureId('editorial');

/** What the schema view ignores: how the schema looks in the dashboard. */
interface Look {
  name: string;
  hint: string | null;
  appearance: unknown;
  defaultValue: unknown;
  fieldIds: string;
  timezone: string;
  position: number;
  reversed: boolean;
}

const LOOK: Look = {
  name: 'Article',
  hint: null,
  appearance: { editor: 'single_line', parameters: {}, addons: [] },
  defaultValue: null,
  fieldIds: 'field',
  timezone: 'Europe/Rome',
  position: 1,
  reversed: false,
};

function rawSchema(options: {
  siteId?: string;
  locales?: string[];
  timezone?: string;
  included?: unknown[];
  workflows?: unknown[];
}): RawSchema {
  return {
    site: {
      data: {
        type: 'site',
        id: options.siteId ?? SITE_ID,
        attributes: {
          name: 'Blog',
          locales: options.locales ?? ['en', 'it'],
          timezone: options.timezone ?? 'Europe/Rome',
        },
        relationships: {},
      },
      included: options.included ?? [],
    },
    workflows: options.workflows ?? [],
  } as unknown as RawSchema;
}

function rawModel(
  id: string,
  apiKey: string,
  attributes: Record<string, unknown> = {},
  workflow: string | null = null,
) {
  return {
    type: 'item_type',
    id,
    attributes: {
      name: apiKey,
      api_key: apiKey,
      hint: null,
      modular_block: false,
      singleton: false,
      sortable: false,
      tree: false,
      draft_mode_active: false,
      draft_saving_active: false,
      all_locales_required: false,
      ...attributes,
    },
    relationships: {
      workflow: { data: workflow && { type: 'workflow', id: workflow } },
    },
  };
}

function rawField(
  id: string,
  modelId: string,
  apiKey: string,
  fieldType: string,
  attributes: Record<string, unknown> = {},
) {
  return {
    type: 'field',
    id,
    attributes: {
      label: apiKey,
      api_key: apiKey,
      field_type: fieldType,
      localized: false,
      validators: {},
      hint: null,
      default_value: null,
      position: 1,
      ...attributes,
    },
    relationships: {
      item_type: { data: { type: 'item_type', id: modelId } },
    },
  };
}

/** An article model with a block model and a workflow. */
function blogSchema(look: Look = LOOK): RawSchema {
  const named = { name: look.name, hint: look.hint };
  const field = (position: number) => ({
    label: look.name,
    hint: look.hint,
    appearance: look.appearance,
    default_value: look.defaultValue,
    position: look.position + position,
  });
  const included = [
    rawModel(
      ARTICLE,
      'article',
      { ...named, sortable: true, draft_mode_active: true },
      EDITORIAL,
    ),
    rawModel(TEXT, 'text_block', { ...named, modular_block: true }),
    rawField(`${look.fieldIds} title`, ARTICLE, 'title', 'string', {
      ...field(0),
      localized: true,
      validators: { required: {} },
    }),
    rawField(`${look.fieldIds} blocks`, ARTICLE, 'blocks', 'rich_text', {
      ...field(1),
      validators: { rich_text_blocks: { item_types: [TEXT] } },
    }),
    rawField(`${look.fieldIds} text`, TEXT, 'text', 'string', field(0)),
  ];
  return rawSchema({
    timezone: look.timezone,
    included: look.reversed ? included.reverse() : included,
    workflows: [
      {
        id: EDITORIAL,
        type: 'workflow',
        name: look.name,
        api_key: 'editorial',
        stages: [
          { id: 'draft', name: `${look.name} draft`, initial: true },
          { id: 'review', name: `${look.name} review` },
        ],
      },
    ],
  });
}

/** The schema with the model the native migration runner tracks runs in. */
function withTrackingModel(schema: RawSchema): RawSchema {
  return {
    ...schema,
    site: {
      ...schema.site,
      included: [
        ...(schema.site.included ?? []),
        rawModel(TRACKING, 'schema_migration'),
        rawField('tracking name', TRACKING, 'name', 'string'),
      ] as NonNullable<RawSchema['site']['included']>,
    },
  };
}

describe('schemaView', () => {
  it('keys models by ID and fields by API key, with no settings for block models', () => {
    assert.deepStrictEqual(schemaView(blogSchema(), 'schema_migration'), {
      locales: ['en', 'it'],
      models: {
        [ARTICLE]: {
          apiKey: 'article',
          block: false,
          settings: {
            singleton: false,
            sortable: true,
            tree: false,
            draftMode: true,
            draftSaving: false,
            allLocalesRequired: false,
            workflow: EDITORIAL,
          },
          fields: {
            title: {
              type: 'string',
              localized: true,
              validators: { required: {} },
            },
            blocks: {
              type: 'rich_text',
              localized: false,
              validators: { rich_text_blocks: { item_types: [TEXT] } },
            },
          },
        },
        [TEXT]: {
          apiKey: 'text_block',
          block: true,
          settings: null,
          fields: {
            text: { type: 'string', localized: false, validators: {} },
          },
        },
      },
      workflows: {
        [EDITORIAL]: {
          apiKey: 'editorial',
          stages: ['draft', 'review'],
          initialStage: 'draft',
        },
      },
    });
  });

  it('leaves out the migration tracking model, by its API key', () => {
    const schema = withTrackingModel(blogSchema());
    assert.deepStrictEqual(
      schemaView(schema, 'schema_migration'),
      schemaView(blogSchema(), 'schema_migration'),
    );
    assert.equal(
      schemaView(schema, 'migration_log').models[TRACKING]?.apiKey,
      'schema_migration',
    );
  });

  it('ignores names, hints, appearance, default values, field IDs, the timezone and positions', () => {
    const restyled = blogSchema({
      name: 'Blog post',
      hint: 'What readers see first',
      appearance: { editor: 'textarea', parameters: {}, addons: [] },
      defaultValue: { en: 'Untitled', it: null },
      fieldIds: 'other field',
      timezone: 'America/New_York',
      position: 7,
      reversed: true,
    });
    assert.deepStrictEqual(
      schemaView(restyled, 'schema_migration'),
      schemaView(blogSchema(), 'schema_migration'),
    );
  });
});

const settings = (overrides: Partial<ModelSettings> = {}): ModelSettings => ({
  singleton: false,
  sortable: false,
  tree: false,
  draftMode: true,
  draftSaving: false,
  allLocalesRequired: false,
  workflow: null,
  ...overrides,
});
const field = (type: string, overrides: Partial<FieldView> = {}) => ({
  type,
  localized: false,
  validators: {},
  ...overrides,
});
const model = (
  apiKey: string,
  fields: ModelView['fields'],
  modelSettings: ModelSettings = settings(),
): ModelView => ({ apiKey, block: false, settings: modelSettings, fields });

describe('schemaDifferences', () => {
  const id = (name: string) => fixtureId(`model ${name}`);
  const dump: SchemaView = {
    locales: ['en', 'it'],
    models: {
      [id('tag')]: model('tag', {}),
      [id('author')]: model('author', { name: field('string') }),
      [id('article')]: model(
        'article',
        {
          title: field('string'),
          subtitle: field('string'),
          body: field('structured_text', {
            localized: true,
            validators: { structured_text_blocks: { item_types: [] } },
          }),
        },
        settings({ sortable: true, workflow: id('editorial') }),
      ),
    },
    workflows: {
      [id('legal')]: {
        apiKey: 'legal',
        stages: ['draft', 'approved'],
        initialStage: 'draft',
      },
      [id('editorial')]: {
        apiKey: 'editorial',
        stages: ['draft', 'review'],
        initialStage: 'draft',
      },
    },
  };
  const target: SchemaView = {
    locales: ['en'],
    models: {
      [id('quote')]: {
        apiKey: 'quote',
        block: true,
        settings: null,
        fields: {},
      },
      [id('article')]: model(
        'article',
        {
          body: field('structured_text'),
          summary: field('string'),
          title: field('text'),
        },
        settings({ draftMode: false }),
      ),
      [id('tag')]: model('label', {}),
    },
    workflows: {
      [id('editorial')]: {
        apiKey: 'editorial',
        stages: ['draft', 'review', 'done'],
        initialStage: 'review',
      },
    },
  };
  const expected = [
    'locales: en, it in the dump, en in "sandbox"',
    'model article: different sortable, draft mode, workflow',
    'field article.body: different localization, validators',
    'field article.subtitle: only in the dump',
    'field article.summary: only in "sandbox"',
    'field article.title: different type',
    `model author (ID ${id('author')}): only in the dump`,
    `block quote (ID ${id('quote')}): only in "sandbox"`,
    'model tag: different API key',
    'workflow legal: only in the dump',
    'workflow editorial: different stages, initial stage',
  ];

  it('reports locales, models, settings by label, fields and workflows, in a stable order', () => {
    assert.deepStrictEqual(
      schemaDifferences(dump, target, 'sandbox'),
      expected,
    );
  });

  it('sorts models and fields by API key, whatever order they come in', () => {
    const reversed = (view: SchemaView): SchemaView => ({
      ...view,
      models: Object.fromEntries(
        Object.entries(view.models)
          .reverse()
          .map(([modelId, { fields, ...rest }]) => [
            modelId,
            {
              ...rest,
              fields: Object.fromEntries(Object.entries(fields).reverse()),
            },
          ]),
      ),
    });
    assert.deepStrictEqual(
      schemaDifferences(reversed(dump), reversed(target), 'sandbox'),
      expected,
    );
  });

  it('reports nothing between equal schemas', () => {
    assert.deepStrictEqual(
      schemaDifferences(dump, structuredClone(dump), 'sandbox'),
      [],
    );
  });
});

describe('readRawSchema', () => {
  it('reads the site with its models and fields, and the workflows', async () => {
    const finds: unknown[] = [];
    const schema = blogSchema();
    const client = {
      site: {
        rawFind: async (query: unknown) => {
          finds.push(query);
          return schema.site;
        },
      },
      workflows: { list: async () => schema.workflows },
    } as unknown as CmaClient.Client;
    assert.deepStrictEqual(await readRawSchema(client), schema);
    assert.deepStrictEqual(finds, [
      { include: 'item_types,item_types.fields' },
    ]);
  });
});

describe('assertSameSchema', () => {
  const CREATED_AT = '2026-10-15T09:45:00.000Z';
  const DUMP_PATH = '/dumps/main-20261015T094500Z.dump.zip';
  const RESTYLED = { ...LOOK, name: 'Post', fieldIds: 'main field' };

  function dumpOf(schema: RawSchema): Dump {
    return {
      path: DUMP_PATH,
      manifest: {
        format: 'datocms-project-dump',
        version: 1,
        createdAt: CREATED_AT,
        pluginVersion: '4.2.1',
        site: { id: SITE_ID, environment: 'main', primary: true },
        locales: ['en', 'it'],
        includesAssets: false,
        counts: { records: 0, uploads: 0, uploadCollections: 0 },
      },
      schema,
      zip: undefined as unknown as ZipReader,
    };
  }

  /** What reading an environment the CMA does not have fails with. */
  const notFound = (status = 404, code = 'NOT_FOUND') =>
    new CmaClient.ApiError({
      request: {
        url: 'https://site-api.datocms.com/site',
        method: 'GET',
        headers: {},
      },
      response: {
        status,
        statusText: 'Refused',
        headers: {},
        body: {
          data: [
            {
              id: 'error',
              type: 'api_error',
              attributes: { code, details: {} },
            },
          ],
        },
      },
    });

  /** Serves the schema of each environment, recording what it reads. */
  function readerOf(schemas: Record<string, RawSchema | Error>) {
    const reads: string[] = [];
    const readSchema = async (environment: string) => {
      reads.push(environment);
      const schema = schemas[environment] ?? notFound();
      if (schema instanceof Error) throw schema;
      return schema;
    };
    return { readSchema, reads };
  }

  /** The check of the blog dump against a target environment "sandbox". */
  function checkOf(
    environments: Record<string, RawSchema | Error>,
    dump = dumpOf(blogSchema()),
  ) {
    const reader = readerOf(environments);
    return {
      reader,
      check: {
        dump,
        expected: schemaView(dump.schema, 'schema_migration'),
        target: 'sandbox',
        trackingModelApiKey: 'schema_migration',
        readSchema: reader.readSchema,
      },
    };
  }

  /** A target without the dump's schema, and the given source environment. */
  const blankCheck = (source?: RawSchema | Error) =>
    checkOf({
      sandbox: rawSchema({}),
      ...(source && { main: source }),
    });

  async function refusal(
    check: Parameters<typeof assertSameSchema>[0],
  ): Promise<oclif.Errors.CLIError> {
    try {
      await assertSameSchema(check);
    } catch (error) {
      assert.ok(error instanceof oclif.Errors.CLIError, String(error));
      assert.equal(error.code, 'SCHEMA_MISMATCH');
      return error;
    }
    assert.fail('The schemas were accepted as the same.');
  }

  const advice = (error: Error) => error.message.split('\n').at(-1)!;
  const migration = (from: string) => [
    `datocms migrations:new copyDumpSchema --autogenerate=${from}:sandbox`,
    'datocms migrations:run --source=sandbox --in-place --migrations-dir=<a directory holding only the generated script>',
  ];
  const ANOTHER_WAY = migration("<an environment with the dump's schema>");

  it('accepts a target with the same schema, apart from looks and the tracking model, reading nothing else', async () => {
    const { check, reader } = checkOf({
      sandbox: withTrackingModel(blogSchema(RESTYLED)),
    });
    await assertSameSchema(check);
    assert.deepStrictEqual(reader.reads, ['sandbox']);
  });

  it('lists the differences, then the advice', async () => {
    const { check } = blankCheck(blogSchema());
    const error = await refusal(check);
    assert.deepStrictEqual(error.message.split('\n').slice(0, -1), [
      'Environment "sandbox" does not have the schema of the dump, so the dump cannot be imported into it. Differences between the dump and "sandbox":',
      `  - model article (ID ${ARTICLE}): only in the dump`,
      `  - block text_block (ID ${TEXT}): only in the dump`,
      '  - workflow editorial: only in the dump',
    ]);
  });

  it('lists at most 20 differences, then how many more there are', async () => {
    const many = rawSchema({
      included: Array.from({ length: 22 }, (_, index) =>
        rawModel(fixtureId(`model ${index}`), `model_${10 + index}`),
      ),
    });
    const { check } = checkOf({ sandbox: rawSchema({}) }, dumpOf(many));
    const error = await refusal(check);
    assert.deepStrictEqual(error.message.split('\n').slice(1, -1), [
      ...Array.from(
        { length: 20 },
        (_, index) =>
          `  - model model_${10 + index} (ID ${fixtureId(
            `model ${index}`,
          )}): only in the dump`,
      ),
      '  - and 2 more',
    ]);
  });

  it("when the source environment still has the dump's schema, suggests copying it with the native CLI and importing again", async () => {
    const { check, reader } = blankCheck(
      withTrackingModel(blogSchema(RESTYLED)),
    );
    const error = await refusal(check);
    assert.match(
      advice(error),
      /^The dump was exported from environment "main" of this project on 2026-10-15T09:45:00\.000Z, and "main" still has the dump's schema\. .*datocms\.config\.json.*"schema_migration"/,
    );
    assert.deepStrictEqual(error.suggestions, [
      ...migration('main'),
      `datocms content:import "${DUMP_PATH}" --environment=sandbox`,
    ]);
    assert.deepStrictEqual(reader.reads, ['sandbox', 'main']);
  });

  it('quotes a dump path with spaces in the suggested import command', async () => {
    const dump = {
      ...dumpOf(blogSchema()),
      path: '/Users/me/My dumps/main.dump.zip',
    };
    const { check } = checkOf(
      { sandbox: rawSchema({}), main: blogSchema() },
      dump,
    );
    const error = await refusal(check);
    assert.equal(
      error.suggestions?.[2],
      'datocms content:import "/Users/me/My dumps/main.dump.zip" --environment=sandbox',
    );
  });

  it("when the source environment's schema has changed, says so and suggests giving the target the schema another way", async () => {
    const changed = withTrackingModel(blogSchema());
    changed.site.included!.push(
      rawField('added', ARTICLE, 'added', 'string') as never,
    );
    const { check } = blankCheck(changed);
    const error = await refusal(check);
    assert.match(
      advice(error),
      /^The dump was exported from environment "main" of this project on 2026-10-15T09:45:00\.000Z, but the schema of "main" has changed since, /,
    );
    assert.deepStrictEqual(error.suggestions, ANOTHER_WAY);
  });

  it('when the source environment no longer exists, says so', async () => {
    const { check, reader } = blankCheck();
    const error = await refusal(check);
    assert.match(
      advice(error),
      /^The dump was exported from environment "main" of this project on 2026-10-15T09:45:00\.000Z, which no longer exists or cannot be read with this API token, /,
    );
    assert.deepStrictEqual(error.suggestions, ANOTHER_WAY);
    assert.deepStrictEqual(reader.reads, ['sandbox', 'main']);
  });

  it('when the CMA refuses reading the source environment, gives the same advice', async () => {
    const { check } = blankCheck(notFound(401, 'INVALID_AUTHORIZATION_HEADER'));
    const error = await refusal(check);
    assert.match(advice(error), /which no longer exists or cannot be read/);
    assert.deepStrictEqual(error.suggestions, ANOTHER_WAY);
  });

  it('lets any other failure reading the source environment through', async () => {
    const failure = new TypeError('fetch failed');
    const { check } = blankCheck(failure);
    await assert.rejects(assertSameSchema(check), (error) => error === failure);
  });

  it('when the target belongs to another project, suggests importing into the original project, with no commands', async () => {
    const { check, reader } = checkOf({
      sandbox: rawSchema({ siteId: '9999' }),
      main: blogSchema(),
    });
    const error = await refusal(check);
    assert.match(
      advice(error),
      /^The dump was exported from environment "main" of another project \(4242\) on 2026-10-15T09:45:00\.000Z\. .* import the dump into an empty sandbox environment of the project it was exported from\.$/,
    );
    assert.equal(error.suggestions, undefined);
    assert.deepStrictEqual(reader.reads, ['sandbox']);
  });
});
