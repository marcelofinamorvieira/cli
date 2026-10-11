import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import type { Client as DashboardClient } from '@datocms/dashboard-client';
import {
  buildTestDashboardClient,
  createTestSite,
  destroyTestSite,
} from '../../../../test-helpers/dashboardClient';
import { requireEnv } from '../../../../test-helpers/preflight';
import { applyContentDiff } from '../../src/engine/apply';
import { writeDump } from '../../src/engine/dump';
import { generateContentDiff } from '../../src/engine/generation';

/**
 * The one check that the CMA accepts what the in-memory CMA of the default
 * suite accepts: export, diff and apply against a throwaway project, with the
 * content the planner reasons about (nested blocks, links, trees, sortable
 * groups, folders, assets, schedules, deletions). It runs with the account
 * credentials described in the repository's `.env.sample` and is excluded
 * from `npm test`.
 */

type Client = CmaClient.Client;

// A 1x1 PNG and a 2x1 PNG, so a replaced file has another MD5 and size.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_2X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR42mNk+M9QDwADgQF/eBpYlAAAAABJRU5ErkJggg==',
  'base64',
);

const itemType = (id: string) => ({ type: 'item_type' as const, id });
const block = (
  modelId: string,
  attributes: Record<string, unknown>,
  id?: string,
) =>
  CmaClient.buildBlockRecord({
    ...(id ? { id } : {}),
    item_type: itemType(modelId),
    ...attributes,
  });

async function waitForEnvironment(client: Client, id: string): Promise<void> {
  for (;;) {
    const environment = await client.environments.find(id);
    if (environment.meta.status === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

describe('content diffs against a live DatoCMS project', () => {
  let dashboardClient: DashboardClient;
  let siteId: string | undefined;
  let directory: string;

  before(async () => {
    requireEnv('DATOCMS_ACCOUNT_EMAIL', 'DATOCMS_ACCOUNT_PASSWORD');
    dashboardClient = await buildTestDashboardClient();
    directory = await mkdtemp(join(tmpdir(), 'content-diff-live-'));
  });

  after(async () => {
    await destroyTestSite(dashboardClient, siteId);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('exports, diffs, applies and converges', async () => {
    const site = await createTestSite(dashboardClient, 'Content diff test');
    siteId = site.id;
    const apiToken = site.access_token!;
    const clientFor = (environment?: string) =>
      CmaClient.buildClient({ apiToken, environment });
    const root = clientFor();
    const endpoint = {
      rootClient: root,
      buildEnvironmentClient: async (environment: string) =>
        clientFor(environment),
    };
    const main = clientFor('main');

    // Schema: a block with a nested block, a draft-mode model with blocks, a
    // link and a file, a model without draft mode, a sortable and a tree model.
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
    const article = await main.itemTypes.create({
      name: 'Article',
      api_key: 'article',
      draft_mode_active: true,
    });
    await main.fields.create(article.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
    });
    for (const apiKey of ['body', 'sidebar'])
      await main.fields.create(article.id, {
        label: apiKey,
        api_key: apiKey,
        field_type: 'rich_text',
        validators: { rich_text_blocks: { item_types: [text.id] } },
      });
    await main.fields.create(article.id, {
      label: 'Related',
      api_key: 'related',
      field_type: 'link',
      validators: { item_item_type: { item_types: [article.id] } },
    });
    await main.fields.create(article.id, {
      label: 'Cover',
      api_key: 'cover',
      field_type: 'file',
    });
    const note = await main.itemTypes.create({
      name: 'Note',
      api_key: 'note',
      draft_mode_active: false,
    });
    await main.fields.create(note.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
    });
    const item = await main.itemTypes.create({
      name: 'Item',
      api_key: 'item',
      sortable: true,
    });
    await main.fields.create(item.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
    });
    const page = await main.itemTypes.create({
      name: 'Page',
      api_key: 'page',
      tree: true,
    });
    await main.fields.create(page.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
    });

    // Content.
    const folder = await main.uploadCollections.create({ label: 'Covers' });
    const png1 = join(directory, 'cover-1.png');
    const png2 = join(directory, 'cover-2.png');
    await writeFile(png1, PNG_1X1);
    await writeFile(png2, PNG_2X1);
    const cover = await main.uploads.createFromLocalFile({
      localPath: png1,
      upload_collection: { type: 'upload_collection', id: folder.id },
    });
    const a1 = await main.items.create({
      item_type: itemType(article.id),
      title: 'First article',
      body: [
        block(text.id, {
          text: 'Hello',
          inner: block(inner.id, { label: 'inner' }),
        }),
      ],
      sidebar: [],
      related: null,
      cover: { upload_id: cover.id },
    });
    await main.items.publish(a1.id);
    const a2 = await main.items.create({
      item_type: itemType(article.id),
      title: 'Second article',
      body: [],
      sidebar: [],
      related: a1.id,
      cover: null,
    });
    await main.items.publish(a2.id);
    const a3 = await main.items.create({
      item_type: itemType(article.id),
      title: 'Scheduled article',
      body: [],
      sidebar: [],
      related: null,
      cover: null,
    });
    const scheduledAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    scheduledAt.setMinutes(0, 0, 0);
    await main.scheduledPublication.create(a3.id, {
      publication_scheduled_at: scheduledAt.toISOString(),
    });
    const n1 = await main.items.create({
      item_type: itemType(note.id),
      title: 'Note',
    });
    const items = [];
    for (const title of ['one', 'two', 'three'])
      items.push(
        await main.items.create({ item_type: itemType(item.id), title }),
      );
    const p1 = await main.items.create({
      item_type: itemType(page.id),
      title: 'Root page',
    });
    const p2 = await main.items.create({
      item_type: itemType(page.id),
      title: 'Child page',
      parent_id: p1.id,
    });
    for (const record of [...items, p1, p2])
      await main.items.publish(record.id);

    // A backup of main before any change, with asset files.
    const dumpPath = join(directory, 'backup.dump-records-assets.zip');
    await writeDump({
      client: main,
      environmentId: 'main',
      primary: true,
      path: dumpPath,
      includeAssets: true,
      options: { concurrency: 4 },
    });

    // The source: a fork of main, edited.
    await root.environments.fork('main', { id: 'source' });
    await waitForEnvironment(root, 'source');
    const source = clientFor('source');
    const current = await source.items.find(a1.id, { nested: true });
    const [textBlock] = current.body as Array<Record<string, unknown>>;
    const innerBlock = textBlock.inner as Record<string, unknown>;
    // A nested block attribute changes; the block moves to the other field.
    await source.items.update(a1.id, {
      body: [],
      sidebar: [
        block(
          text.id,
          {
            text: 'Hello again',
            inner: block(
              inner.id,
              { label: 'edited' },
              innerBlock.id as string,
            ),
          },
          textBlock.id as string,
        ),
      ],
    });
    await source.items.publish(a1.id);
    // A published referrer is deleted and its target unpublished.
    await source.items.destroy(a2.id);
    await source.items.unpublish(a1.id);
    // A model without draft mode changes.
    await source.items.update(n1.id, { title: 'Note, edited' });
    // The sortable group is reordered.
    const positions = new Map(
      (await source.items.list({ filter: { type: item.id } })).map((record) => [
        record.id,
        record.position as number,
      ]),
    );
    await source.items.update(items[2].id, {
      position: positions.get(items[0].id),
    });
    // A tree record leaves its parent and a new child appears.
    await source.items.update(p2.id, { parent_id: null });
    const p3 = await source.items.create({
      item_type: itemType(page.id),
      title: 'New child',
      parent_id: p1.id,
    });
    await source.items.publish(p3.id);
    // The asset file is replaced and the schedule moves.
    await source.uploads.updateFromLocalFile(cover.id, { localPath: png2 });
    await source.scheduledPublication.destroy(a3.id);
    const laterAt = new Date(scheduledAt.getTime() + 24 * 3600 * 1000);
    await source.scheduledPublication.create(a3.id, {
      publication_scheduled_at: laterAt.toISOString(),
    });

    const signal = new AbortController().signal;
    const diffFrom = (
      from: { environment: string } | { dump: string },
      name: string,
    ) =>
      generateContentDiff({
        source:
          'dump' in from ? from : { endpoint, environment: from.environment },
        destination: { endpoint, environment: 'main' },
        outputPath: (includesAssets) =>
          join(directory, `${name}${includesAssets ? '-assets' : ''}.zip`),
        options: {
          itemTypes: 'all',
          uploads: 'referenced',
          includeDeletions: true,
          concurrency: 4,
        },
        signal,
      });
    const apply = (diffPath: string) =>
      applyContentDiff({
        rootClient: root,
        buildEnvironmentClient: endpoint.buildEnvironmentClient,
        diffPath,
        options: {
          signal,
          inPlace: true,
          allowPrimary: true,
          keepFailedFork: false,
          concurrency: 4,
          fastFork: false,
          force: false,
        },
      });
    const converged = (
      counts: Awaited<ReturnType<typeof diffFrom>>['counts'],
    ) => {
      for (const kind of ['record', 'upload', 'collection'] as const)
        for (const action of ['create', 'update', 'delete'] as const)
          assert.equal(counts[kind][action], 0, `${kind} ${action}`);
    };

    // Source to main, then nothing left to do.
    const forward = await diffFrom({ environment: 'source' }, 'forward');
    assert.ok(forward.operations > 0);
    await apply(forward.diffPath);
    converged(
      (await diffFrom({ environment: 'source' }, 'forward-again')).counts,
    );

    // The backup restores main, asset files included, then nothing left to do.
    const restore = await diffFrom({ dump: dumpPath }, 'restore');
    assert.ok(restore.diffPath.endsWith('-assets.zip'));
    await apply(restore.diffPath);
    converged((await diffFrom({ dump: dumpPath }, 'restore-again')).counts);
  });
});
