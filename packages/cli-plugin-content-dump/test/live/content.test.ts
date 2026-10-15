import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CmaClient } from '@datocms/cli-utils';
import { runCommand } from '@oclif/test';
import {
  buildTestDashboardClient,
  createTestSite,
  destroyTestSite,
} from '../../../../test-helpers/dashboardClient';
import { requireEnv } from '../../../../test-helpers/preflight';
import { assertSameContents, comparableContents } from '../dump-contents';

/**
 * The check that the CMA accepts what the import writes. On a throwaway
 * project it builds a schema, keeps two environments without content (one
 * forked before the schema existed, one after), fills the primary
 * environment with the content the import has to order (links in both
 * directions, a required link to a newer record, links inside blocks and
 * Structured Text, a tree, a sortable model, a singleton, drafts, newer
 * drafts, schedules, nested folders and asset files), exports it, and
 * imports the dump:
 *
 * - into the environment without the schema, which is refused with the
 *   schema autogenerate advice, and then, after following that advice with
 *   the native CLI, accepted;
 * - into the environment with the schema.
 *
 * Each import is exported again and compared with the first dump. Excluded
 * from `npm test`; it needs the account credentials of `.env.sample`.
 */

type Client = CmaClient.Client;

const NATIVE_CLI = resolve(__dirname, '../../../cli/bin/run');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
);

const itemType = (id: string) => ({ type: 'item_type' as const, id });
const block = (modelId: string, attributes: Record<string, unknown>) =>
  CmaClient.buildBlockRecord({ item_type: itemType(modelId), ...attributes });
const span = (value: string) => ({ type: 'span', value });
const dast = (...children: unknown[]) => ({
  schema: 'dast',
  document: { type: 'root', children },
});
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();

async function waitForEnvironment(client: Client, id: string): Promise<void> {
  for (;;) {
    const environment = await client.environments.find(id);
    if (environment.meta.status === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Builds the schema in `main`: every model the content below needs. */
async function buildSchema(main: Client) {
  const inner = await main.itemTypes.create({
    name: 'Inner block',
    api_key: 'inner_block',
    modular_block: true,
  });
  await main.fields.create(inner.id, {
    label: 'Label',
    api_key: 'label',
    field_type: 'string',
  });
  const text = await main.itemTypes.create({
    name: 'Text block',
    api_key: 'text_block',
    modular_block: true,
  });
  await main.fields.create(text.id, {
    label: 'Text',
    api_key: 'text',
    field_type: 'string',
  });
  await main.fields.create(text.id, {
    label: 'Inner',
    api_key: 'inner',
    field_type: 'single_block',
    validators: { single_block_blocks: { item_types: [inner.id] } },
  });
  await main.fields.create(text.id, {
    label: 'Body',
    api_key: 'body',
    field_type: 'structured_text',
    validators: {
      structured_text_blocks: { item_types: [inner.id] },
      structured_text_inline_blocks: { item_types: [] },
      structured_text_links: { item_types: [] },
    },
  });
  const category = await main.itemTypes.create({
    name: 'Category',
    api_key: 'category',
    draft_mode_active: false,
  });
  await main.fields.create(category.id, {
    label: 'Name',
    api_key: 'name',
    field_type: 'string',
    validators: { required: {} },
  });
  const author = await main.itemTypes.create({
    name: 'Author',
    api_key: 'author',
    draft_mode_active: true,
  });
  await main.fields.create(author.id, {
    label: 'Name',
    api_key: 'name',
    field_type: 'string',
  });
  const article = await main.itemTypes.create({
    name: 'Article',
    api_key: 'article',
    draft_mode_active: true,
  });
  await main.fields.create(author.id, {
    label: 'Featured article',
    api_key: 'featured_article',
    field_type: 'link',
    validators: { item_item_type: { item_types: [article.id] } },
  });
  await main.fields.create(article.id, {
    label: 'Title',
    api_key: 'title',
    field_type: 'string',
    localized: true,
  });
  await main.fields.create(article.id, {
    label: 'Author',
    api_key: 'author',
    field_type: 'link',
    validators: { item_item_type: { item_types: [author.id] }, required: {} },
  });
  await main.fields.create(article.id, {
    label: 'Category',
    api_key: 'category',
    field_type: 'link',
    validators: { item_item_type: { item_types: [category.id] } },
  });
  await main.fields.create(article.id, {
    label: 'Related',
    api_key: 'related',
    field_type: 'links',
    validators: { items_item_type: { item_types: [article.id] } },
  });
  await main.fields.create(article.id, {
    label: 'Blocks',
    api_key: 'blocks',
    field_type: 'rich_text',
    validators: { rich_text_blocks: { item_types: [text.id, inner.id] } },
  });
  await main.fields.create(article.id, {
    label: 'Content',
    api_key: 'content',
    field_type: 'structured_text',
    localized: true,
    validators: {
      structured_text_blocks: { item_types: [text.id] },
      structured_text_inline_blocks: { item_types: [inner.id] },
      structured_text_links: { item_types: [article.id] },
    },
  });
  for (const [api_key, field_type] of [
    ['cover', 'file'],
    ['gallery', 'gallery'],
    ['seo', 'seo'],
  ] as const)
    await main.fields.create(article.id, {
      label: api_key,
      api_key,
      field_type,
    } as never);
  const page = await main.itemTypes.create({
    name: 'Page',
    api_key: 'page',
    tree: true,
    draft_mode_active: true,
  });
  await main.fields.create(page.id, {
    label: 'Title',
    api_key: 'title',
    field_type: 'string',
  });
  await main.fields.create(page.id, {
    label: 'Featured',
    api_key: 'featured',
    field_type: 'link',
    validators: { item_item_type: { item_types: [article.id] } },
  });
  const step = await main.itemTypes.create({
    name: 'Step',
    api_key: 'step',
    sortable: true,
    draft_mode_active: false,
  });
  await main.fields.create(step.id, {
    label: 'Title',
    api_key: 'title',
    field_type: 'string',
  });
  const setting = await main.itemTypes.create({
    name: 'Setting',
    api_key: 'setting',
    singleton: true,
    draft_mode_active: false,
  });
  await main.fields.create(setting.id, {
    label: 'Home',
    api_key: 'home',
    field_type: 'link',
    validators: { item_item_type: { item_types: [page.id] } },
  });
  return { inner, text, category, author, article, page, step, setting };
}

/** Fills `main` with content whose import order is not trivial. */
async function buildContent(
  main: Client,
  models: Awaited<ReturnType<typeof buildSchema>>,
  directory: string,
) {
  const { inner, text, category, author, article, page, step, setting } =
    models;
  const create = (model: { id: string }, attributes: Record<string, unknown>) =>
    main.items.create({
      item_type: itemType(model.id),
      ...attributes,
    } as never);

  // Folders, one of them moved before its older siblings, and uploads.
  const parent = await main.uploadCollections.create({ label: 'Parent' });
  const folders = [];
  for (const label of ['A', 'B', 'C'])
    folders.push(
      await main.uploadCollections.create({
        label,
        parent: { type: 'upload_collection', id: parent.id },
      }),
    );
  await main.uploadCollections.update(folders[2]!.id, { position: 1 });
  const pngPath = join(directory, 'pixel.png');
  const svgPath = join(directory, 'shape.svg');
  await writeFile(pngPath, PNG);
  await writeFile(svgPath, SVG);
  const png = await main.uploads.createFromLocalFile({
    localPath: pngPath,
    filename: 'pixel.png',
    author: 'Someone',
    upload_collection: { type: 'upload_collection', id: folders[1]!.id },
  });
  const svg = await main.uploads.createFromLocalFile({
    localPath: svgPath,
    filename: 'shape.svg',
  });
  const file = (upload: { id: string }) => ({
    upload_id: upload.id,
    alt: 'Alt',
    title: null,
    custom_data: { source: 'test' },
    focal_point: null,
  });

  // A category, published on create (no draft mode).
  const news = await create(category, { name: 'News' });

  // Two authors, the second newer than the article that requires it and
  // featuring it, and two articles that link to each other, one of them
  // also to itself. Records that link to each other are published in turns.
  const ada = await create(author, { name: 'Ada' });
  await main.items.publish(ada.id);
  const first = await create(article, {
    title: { en: 'First', it: 'Primo' },
    author: ada.id,
    category: news.id,
    cover: file(png),
    gallery: [file(png), file(svg)],
    seo: { title: 'Seo', description: 'Desc', image: png.id },
  });
  const grace = await create(author, { name: 'Grace' });
  await main.items.publish(grace.id);
  await main.items.update(first.id, {
    author: grace.id,
    blocks: [
      block(text.id, {
        text: 'Kept',
        inner: block(inner.id, { label: 'Nested' }),
        body: dast({ type: 'block', item: block(inner.id, { label: 'Deep' }) }),
      }),
      block(inner.id, { label: 'Removed in the draft' }),
    ],
  } as never);
  await main.items.publish(first.id);
  await main.items.update(grace.id, { featured_article: first.id });
  await main.items.publish(grace.id);
  const second = await create(article, {
    title: { en: 'Second', it: null },
    author: grace.id,
    related: [first.id],
  });
  await main.items.update(second.id, { related: [first.id, second.id] });
  await main.items.publish(second.id);
  await main.items.update(first.id, {
    related: [second.id],
    content: {
      en: dast(
        {
          type: 'paragraph',
          children: [
            span('See '),
            { type: 'itemLink', item: second.id, children: [span('second')] },
            { type: 'inlineItem', item: second.id },
            { type: 'inlineBlock', item: block(inner.id, { label: 'Inline' }) },
          ],
        },
        { type: 'block', item: block(text.id, { text: 'In the text' }) },
      ),
      it: null,
    },
  } as never);
  await main.items.publish(first.id);
  // A newer draft: one block changed, one removed, one added.
  const [kept] = (await main.items.find(first.id, { nested: true }))
    .blocks as Array<{ id: string }>;
  await main.items.rawUpdate(first.id, {
    data: {
      type: 'item',
      id: first.id,
      attributes: {
        title: { en: 'First, edited', it: 'Primo' },
        blocks: [
          { type: 'item', id: kept!.id, attributes: { text: 'Kept, edited' } },
          {
            type: 'item',
            attributes: { label: 'Added in the draft' },
            relationships: { item_type: { data: itemType(inner.id) } },
          },
        ],
      },
    },
  } as never);
  // A draft that was published once, and a never-published draft.
  const withdrawn = await create(article, {
    title: { en: 'Withdrawn', it: null },
    author: ada.id,
  });
  await main.items.publish(withdrawn.id);
  await main.items.unpublish(withdrawn.id);
  const draft = await create(article, {
    title: { en: 'Draft', it: null },
    author: ada.id,
    related: [first.id],
  });
  await main.scheduledPublication.create(draft.id, {
    publication_scheduled_at: inDays(30),
  });
  await main.scheduledUnpublishing.create(second.id, {
    unpublishing_scheduled_at: inDays(40),
  });

  // A tree whose children are not in creation order.
  const home = await create(page, { title: 'Home', featured: first.id });
  await main.items.publish(home.id);
  const children = [];
  for (const title of ['One', 'Two', 'Three'])
    children.push(await create(page, { title, parent_id: home.id }));
  await main.items.update(children[2]!.id, { position: 1 } as never);
  await main.items.publish(children[0]!.id);

  // A sortable model whose order is not the creation order.
  const steps = [];
  for (const title of ['S1', 'S2', 'S3', 'S4'])
    steps.push(await create(step, { title }));
  await main.items.update(steps[0]!.id, { position: 4 } as never);

  // A singleton, published on create, linking to a published page.
  await create(setting, { home: home.id });
}

describe('content:export and content:import against a live DatoCMS project', () => {
  let dashboard: Awaited<ReturnType<typeof buildTestDashboardClient>>;
  let siteId: string | undefined;
  let directory: string;
  const previousConfigFile = process.env.DATOCMS_CONFIG_FILE;

  before(async () => {
    requireEnv('DATOCMS_ACCOUNT_EMAIL', 'DATOCMS_ACCOUNT_PASSWORD');
    dashboard = await buildTestDashboardClient();
    directory = await mkdtemp(join(tmpdir(), 'content-dump-live-'));
    // No configuration file of the machine running the test applies.
    process.env.DATOCMS_CONFIG_FILE = join(directory, 'missing.json');
  });

  after(async () => {
    process.env.DATOCMS_CONFIG_FILE = previousConfigFile;
    await destroyTestSite(dashboard, siteId);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('exports an environment and imports it into empty sandboxes', async () => {
    const site = await createTestSite(dashboard, 'Content dump test');
    siteId = site.id;
    console.log(`Site ID: ${site.id}`);
    const apiToken = site.access_token!;
    const auth = `--api-token=${apiToken}`;
    const root = CmaClient.buildClient({ apiToken });
    const main = CmaClient.buildClient({ apiToken, environment: 'main' });
    await main.site.update({ locales: ['en', 'it'] });

    // An environment without the schema, then the schema, then one with it.
    await root.environments.fork('main', { id: 'blank' });
    await waitForEnvironment(root, 'blank');
    const models = await buildSchema(main);
    await root.environments.fork('main', { id: 'empty' });
    await waitForEnvironment(root, 'empty');
    await buildContent(main, models, directory);

    const dumpPath = join(directory, 'main.dump.zip');
    const exported = await runCommand([
      'content:export',
      '--environment=main',
      '--include-assets',
      `--out=${dumpPath}`,
      auth,
    ]);
    assert.ifError(exported.error);
    const expected = await comparableContents(dumpPath);
    assert.equal(Object.keys(expected.records).length, 16);

    // The primary environment is refused before anything else.
    const primary = await runCommand([
      'content:import',
      dumpPath,
      '--environment=main',
      auth,
    ]);
    assert.equal(
      (primary.error as { code?: string })?.code,
      'PRIMARY_ENVIRONMENT',
    );

    // Without the schema: refused, with the native autogenerate advice.
    const refused = await runCommand([
      'content:import',
      dumpPath,
      '--environment=blank',
      auth,
    ]);
    const mismatch = refused.error as Error & {
      code?: string;
      suggestions?: string[];
    };
    assert.equal(mismatch?.code, 'SCHEMA_MISMATCH');
    assert.match(mismatch.message, /"main" still has the dump's schema/);
    assert.deepEqual(mismatch.suggestions?.slice(0, 2), [
      'datocms migrations:new copyDumpSchema --autogenerate=main:blank',
      'datocms migrations:run --source=blank --in-place --migrations-dir=<a directory holding only the generated script>',
    ]);
    const blank = CmaClient.buildClient({ apiToken, environment: 'blank' });
    assert.equal((await blank.items.list()).length, 0);
    assert.equal((await blank.uploads.list()).length, 0);

    // Into the environment with the schema.
    const imported = await runCommand([
      'content:import',
      dumpPath,
      '--environment=empty',
      auth,
    ]);
    assert.ifError(imported.error);
    const emptyDump = join(directory, 'empty.dump.zip');
    assert.ifError(
      (
        await runCommand([
          'content:export',
          '--environment=empty',
          '--include-assets',
          `--out=${emptyDump}`,
          auth,
        ])
      ).error,
    );
    assertSameContents(await comparableContents(emptyDump), expected);

    // Following the advice with the native CLI, then importing into blank.
    const configFile = join(directory, 'datocms.config.json');
    await writeFile(
      configFile,
      JSON.stringify({
        profiles: { default: { migrations: { directory: './migrations' } } },
      }),
    );
    const { DATOCMS_CONFIG_FILE: _ignored, ...environment } = process.env;
    const native = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [NATIVE_CLI, ...args, `--config-file=${configFile}`, auth],
        { cwd: directory, env: environment },
      );
    await native(
      'migrations:new',
      'copyDumpSchema',
      '--js',
      '--autogenerate=main:blank',
    );
    // The generated script runs alone, from a directory of its own.
    const [script] = await readdir(join(directory, 'migrations'));
    await mkdir(join(directory, 'dump-schema'));
    await rename(
      join(directory, 'migrations', script!),
      join(directory, 'dump-schema', script!),
    );
    await native(
      'migrations:run',
      '--source=blank',
      '--in-place',
      `--migrations-dir=${join(directory, 'dump-schema')}`,
    );
    const followed = await runCommand([
      'content:import',
      dumpPath,
      '--environment=blank',
      auth,
    ]);
    assert.ifError(followed.error);
    const blankDump = join(directory, 'blank.dump.zip');
    assert.ifError(
      (
        await runCommand([
          'content:export',
          '--environment=blank',
          '--include-assets',
          `--out=${blankDump}`,
          auth,
        ])
      ).error,
    );
    assertSameContents(
      await comparableContents(blankDump, ['schema_migration']),
      expected,
    );
  });
});
