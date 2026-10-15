import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureId } from '../fixture-id';
import { FakeCma, type FakeEnvironment, type SchemaDocument } from './cma';

/*
 * The source project of the offline export and import tests, built through
 * the emulated CMA's write API the way a user would, publishing in an order
 * the CMA accepts. Its content has every shape whose import order is not
 * trivial: links in both directions and to itself, a required link to a
 * newer record, links inside blocks and Structured Text, drafts and newer
 * drafts, a tree and a sortable model out of creation order, a singleton,
 * schedules, nested folders and asset files.
 */

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
);

const modelId = (apiKey: string) => fixtureId(`model ${apiKey}`);

type FieldSpec = [apiKey: string, type: string, options?: object];

function itemType(apiKey: string, settings: object, fields: FieldSpec[]) {
  const id = modelId(apiKey);
  return [
    {
      id,
      type: 'item_type',
      attributes: {
        name: apiKey,
        api_key: apiKey,
        modular_block: false,
        singleton: false,
        sortable: false,
        tree: false,
        draft_mode_active: false,
        draft_saving_active: false,
        all_locales_required: false,
        ...settings,
      },
      relationships: {
        fields: {
          data: fields.map(([key]) => ({
            type: 'field',
            id: fixtureId(`field ${apiKey}.${key}`),
          })),
        },
        workflow: { data: null },
      },
    },
    ...fields.map(([key, type, options], index) => ({
      id: fixtureId(`field ${apiKey}.${key}`),
      type: 'field',
      attributes: {
        label: key,
        api_key: key,
        field_type: type,
        localized: false,
        validators: {},
        position: index + 1,
        ...options,
      },
      relationships: { item_type: { data: { type: 'item_type', id } } },
    })),
  ];
}

const linksTo = (key: string, ...apiKeys: string[]) => ({
  [key]: { item_types: apiKeys.map(modelId) },
});
const block = { modular_block: true };
const drafts = { draft_mode_active: true };

const MODELS = [
  'inner_block',
  'text_block',
  'category',
  'author',
  'article',
  'page',
  'step',
  'setting',
  'schema_migration',
];

/** The schema of the source project, as the CMA returns it. */
export function projectSchema(siteId: string): SchemaDocument {
  return {
    site: {
      data: {
        id: siteId,
        type: 'site',
        attributes: { name: 'Fixture', locales: ['en', 'it'], timezone: 'UTC' },
        relationships: {
          item_types: {
            data: MODELS.map((apiKey) => ({
              type: 'item_type',
              id: modelId(apiKey),
            })),
          },
        },
      },
      included: [
        ...itemType('inner_block', block, [['label', 'string']]),
        ...itemType('text_block', block, [
          ['text', 'string'],
          [
            'inner',
            'single_block',
            { validators: linksTo('single_block_blocks', 'inner_block') },
          ],
          [
            'body',
            'structured_text',
            {
              validators: {
                ...linksTo('structured_text_blocks', 'inner_block'),
                ...linksTo('structured_text_inline_blocks'),
                ...linksTo('structured_text_links'),
              },
            },
          ],
        ]),
        ...itemType('category', {}, [
          ['name', 'string', { validators: { required: {} } }],
        ]),
        ...itemType('author', drafts, [
          ['name', 'string'],
          [
            'featured_article',
            'link',
            { validators: linksTo('item_item_type', 'article') },
          ],
        ]),
        ...itemType('article', drafts, [
          ['title', 'string', { localized: true }],
          [
            'author',
            'link',
            {
              validators: {
                ...linksTo('item_item_type', 'author'),
                required: {},
              },
            },
          ],
          [
            'category',
            'link',
            { validators: linksTo('item_item_type', 'category') },
          ],
          [
            'related',
            'links',
            { validators: linksTo('items_item_type', 'article') },
          ],
          [
            'blocks',
            'rich_text',
            {
              validators: linksTo(
                'rich_text_blocks',
                'text_block',
                'inner_block',
              ),
            },
          ],
          [
            'content',
            'structured_text',
            {
              localized: true,
              validators: {
                ...linksTo('structured_text_blocks', 'text_block'),
                ...linksTo('structured_text_inline_blocks', 'inner_block'),
                ...linksTo('structured_text_links', 'article'),
              },
            },
          ],
          ['cover', 'file'],
          ['gallery', 'gallery'],
          ['seo', 'seo'],
        ]),
        // The model that saves invalid drafts.
        ...itemType(
          'page',
          { ...drafts, tree: true, draft_saving_active: true },
          [
            ['title', 'string'],
            [
              'featured',
              'link',
              { validators: linksTo('item_item_type', 'article') },
            ],
          ],
        ),
        ...itemType('step', { sortable: true }, [['title', 'string']]),
        ...itemType('setting', { singleton: true }, [
          ['home', 'link', { validators: linksTo('item_item_type', 'page') }],
        ]),
        // The model the native migration runner tracks migrations in.
        ...itemType('schema_migration', {}, [['name', 'string']]),
      ],
    },
    workflows: [],
  };
}

/** The loosely typed client the fixtures write with. */
export function writer(environment: FakeEnvironment) {
  const api = environment.client() as any;
  const create = async (
    apiKey: string,
    attributes: Record<string, unknown>,
  ): Promise<string> => {
    const { data } = await api.items.rawCreate({
      data: {
        type: 'item',
        attributes,
        relationships: {
          item_type: { data: { type: 'item_type', id: modelId(apiKey) } },
        },
      },
    });
    return data.id;
  };
  const update = (id: string, attributes: Record<string, unknown>) =>
    api.items.rawUpdate(id, { data: { type: 'item', id, attributes } });
  const publish = (id: string) => api.items.publish(id);
  return { api, create, update, publish };
}

/** A block to write, under the ID named by `name` when one is given. */
export function blockOf(
  apiKey: string,
  attributes: Record<string, unknown>,
  name?: string,
) {
  return {
    type: 'item',
    ...(name && { id: fixtureId(`block ${name}`) }),
    attributes,
    relationships: {
      item_type: { data: { type: 'item_type', id: modelId(apiKey) } },
    },
  };
}

const span = (value: string) => ({ type: 'span', value });
const dast = (...children: unknown[]) => ({
  schema: 'dast',
  document: { type: 'root', children },
});
export const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();

/** A new environment of `cma` with the schema of `main` and no content. */
export function emptyEnvironment(cma: FakeCma, id: string): FakeEnvironment {
  return cma.addEnvironment(id, cma.environment('main').schema);
}

/**
 * Builds the source project in its primary environment `main`, writing the
 * files it uploads to `directory`. Returns the IDs tests refer to.
 */
export async function buildProject(directory: string) {
  const cma = new FakeCma();
  const main = cma.addEnvironment('main', projectSchema(cma.siteId), true);
  const { api, create, update, publish } = writer(main);

  // Nested folders, one moved before its older siblings.
  const folder = async (label: string, parent?: string) =>
    (
      await api.uploadCollections.create({
        label,
        ...(parent && { parent: { type: 'upload_collection', id: parent } }),
      })
    ).id as string;
  const parentFolder = await folder('Parent');
  const [a, b, c] = [
    await folder('A', parentFolder),
    await folder('B', parentFolder),
    await folder('C', parentFolder),
  ];
  await api.uploadCollections.update(c, { position: 1 });
  const deepFolder = await folder('B1', b);

  // Uploads inside and outside folders.
  const pngPath = join(directory, 'pixel.png');
  const svgPath = join(directory, 'shape.svg');
  await writeFile(pngPath, PNG);
  await writeFile(svgPath, SVG);
  const png = (
    await api.uploads.createFromLocalFile({
      localPath: pngPath,
      filename: 'pixel.png',
      author: 'Someone',
      tags: ['pixel'],
      upload_collection: { type: 'upload_collection', id: b },
    })
  ).id as string;
  const svg = (
    await api.uploads.createFromLocalFile({
      localPath: svgPath,
      filename: 'shape.svg',
    })
  ).id as string;
  const file = (upload: string) => ({
    upload_id: upload,
    alt: 'Alt',
    title: null,
    custom_data: { source: 'test' },
    focal_point: null,
  });

  // A category, published on create: its model has no draft mode.
  const news = await create('category', { name: 'News' });

  // An article requiring an author newer than itself that features it back,
  // and two articles linking to each other, one also to itself, published
  // in turns.
  const ada = await create('author', { name: 'Ada' });
  await publish(ada);
  const first = await create('article', {
    title: { en: 'First', it: 'Primo' },
    author: ada,
    category: news,
    cover: file(png),
    gallery: [file(png), file(svg)],
    seo: { title: 'Seo', description: 'Desc', image: png },
  });
  const grace = await create('author', { name: 'Grace' });
  await publish(grace);
  await update(first, {
    author: grace,
    blocks: [
      blockOf(
        'text_block',
        {
          text: 'Kept',
          inner: blockOf('inner_block', { label: 'Nested' }),
          body: dast({
            type: 'block',
            item: blockOf('inner_block', { label: 'Deep' }),
          }),
        },
        'kept',
      ),
      blockOf('inner_block', { label: 'Removed in the draft' }),
    ],
  });
  await publish(first);
  await update(grace, { featured_article: first });
  await publish(grace);
  const second = await create('article', {
    title: { en: 'Second', it: null },
    author: grace,
    related: [first],
  });
  await update(second, { related: [first, second] });
  await publish(second);
  await update(first, {
    related: [second],
    content: {
      en: dast(
        {
          type: 'paragraph',
          children: [
            span('See '),
            { type: 'itemLink', item: second, children: [span('second')] },
            { type: 'inlineItem', item: second },
            {
              type: 'inlineBlock',
              item: blockOf('inner_block', { label: 'Inline' }),
            },
          ],
        },
        { type: 'block', item: blockOf('text_block', { text: 'In the text' }) },
      ),
      it: null,
    },
  });
  await publish(first);
  // A newer draft: one block kept and edited, one removed, one added.
  await update(first, {
    title: { en: 'First, edited', it: 'Primo' },
    blocks: [
      {
        type: 'item',
        id: fixtureId('block kept'),
        attributes: { text: 'Kept, edited' },
      },
      blockOf('inner_block', { label: 'Added in the draft' }),
    ],
  });

  // A draft that was published once, and a never-published one.
  const withdrawn = await create('article', {
    title: { en: 'Withdrawn', it: null },
    author: ada,
  });
  await publish(withdrawn);
  await api.items.unpublish(withdrawn);
  const draft = await create('article', {
    title: { en: 'Draft', it: null },
    author: ada,
    related: [first],
  });
  await api.scheduledPublication.create(draft, {
    publication_scheduled_at: inDays(30),
  });
  await api.scheduledUnpublishing.create(second, {
    unpublishing_scheduled_at: inDays(40),
  });

  // A tree whose children are not in creation order, one of them published.
  const home = await create('page', { title: 'Home', featured: first });
  await publish(home);
  const children: string[] = [];
  for (const title of ['One', 'Two', 'Three'])
    children.push(await create('page', { title, parent_id: home }));
  await update(children[2]!, { position: 1 });
  await publish(children[0]!);

  // A sortable model whose order is not the creation order.
  const steps: string[] = [];
  for (const title of ['S1', 'S2', 'S3', 'S4'])
    steps.push(await create('step', { title }));
  await update(steps[0]!, { position: 4 });

  // A singleton without draft mode, linking to a published page.
  const setting = await create('setting', { home });

  // A record of the migration tracking model.
  const migration = await create('schema_migration', {
    name: '1_initial.js',
  });

  return {
    cma,
    main,
    ids: {
      folders: { parent: parentFolder, a, b, c, deep: deepFolder },
      uploads: { png, svg },
      records: {
        news,
        ada,
        grace,
        first,
        second,
        withdrawn,
        draft,
        home,
        children,
        steps,
        setting,
        migration,
      },
    },
  };
}

export type Project = Awaited<ReturnType<typeof buildProject>>;
