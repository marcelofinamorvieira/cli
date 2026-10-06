import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

// Compile real public exports, including the inferred defineContentMigration
// callback. A weakened facade makes an @ts-expect-error unused and fails this test.
const script = `
import { defineContentMigration, runMigrationPart, type ContentMigrationClient } from '@datocms/cli-plugin-content-diff/migration';

export default defineContentMigration({ baseline: './fixture.content' }, async (client) => {
  const created = await client.items.create({
    id: 'new-record', item_type: { id: 'model', type: 'item_type' },
    meta: { created_at: '2026-01-01T00:00:00Z', first_published_at: null, stage: null },
    title: 'A', localized: { en: 'Hello' }, body: [{ id: 'block', type: 'item', attributes: { text: 'Hello' }, relationships: { item_type: { data: { id: 'block-model', type: 'item_type' } } } }],
  });
  const recordId: string = created.id;
  const recordType: 'item' = created.type;
  const modelId: string = created.item_type.id;
  await client.items.update(recordId, { title: 'B', related: recordId, position: 1, parent_id: null, meta: { first_published_at: '2026-01-01T00:00:00Z' } });
  await client.items.publish(created, undefined, { recursive: false });
  await client.items.unpublish(recordId);
  await client.items.destroy(recordId);
  const publication = await client.scheduledPublication.create(recordId, { publication_scheduled_at: '2090-01-01', selective_publication: { content_in_locales: ['en'], non_localized_content: true } });
  const publicationAt: string = publication.publication_scheduled_at;
  await client.scheduledPublication.destroy(recordId);
  await client.scheduledUnpublishing.create(recordId, { unpublishing_scheduled_at: '2091-01-01', content_in_locales: null });
  await client.scheduledUnpublishing.destroy(recordId);
  const folder = await client.uploadCollections.create({ id: 'folder', label: 'Images', parent: null });
  const parent: string | null = folder.parentId;
  await client.uploadCollections.update(folder, { position: 1 });
  await client.uploadCollections.destroy(folder);
  const upload = await client.uploads.createFromLocalFile({ id: 'image', localPath: './fixture.content/assets/image.png', filename: 'image.png', tags: ['hero'], default_field_metadata: { alt: { en: 'Hero' }, custom_data: { en: { caption: 'A' } }, focal_point: { x: 0.5, y: 0.5 } } });
  const uploadId: string = upload.id;
  await client.uploads.update(uploadId, { author: 'Editor', upload_collection: null });
  await client.uploads.update(uploadId, { path: './fixture.content/assets/replacement.png' }, { replace_strategy: 'create_new_url' });
  await client.uploads.destroy(upload);
  await runMigrationPart(client, './fixture.content/parts/000001.ts');

  // @ts-expect-error Reads are not available while recording intent.
  await client.items.find(recordId);
  // @ts-expect-error Lists are not available while recording intent.
  await client.items.list();
  // @ts-expect-error Schema mutations are not available.
  await client.itemTypes.create({ name: 'Model' });
  // @ts-expect-error Client settings are unavailable.
  client.config;
  // @ts-expect-error The recorder cannot return a server version.
  created.meta.current_version;
  // @ts-expect-error Upload responses have no CDN URL.
  upload.url;
  // @ts-expect-error Folder responses use local parentId, not a CMA relationship.
  folder.parent;
  // @ts-expect-error Record creation requires an explicit ID.
  await client.items.create({ item_type: 'model', meta: { created_at: '2026-01-01' } });
  // @ts-expect-error Record creation requires an explicit model.
  await client.items.create({ id: 'new', meta: { created_at: '2026-01-01' } });
  // @ts-expect-error Record creation requires an explicit creation timestamp.
  await client.items.create({ id: 'new', item_type: 'model', meta: {} });
  // @ts-expect-error Unsupported record metadata cannot be changed.
  await client.items.update(recordId, { meta: { current_version: '2' } });
  // @ts-expect-error Field content must be JSON, not executable code.
  await client.items.update(recordId, { title: () => 'A' });
  // @ts-expect-error Immediate selective publication is unsupported.
  await client.items.publish(recordId, { content_in_locales: ['en'] });
  // @ts-expect-error Recursive publication is unsupported.
  await client.items.publish(recordId, undefined, { recursive: true });
  // @ts-expect-error Extra request options are unsupported.
  await client.items.destroy(recordId, { force: true });
  // @ts-expect-error A schedule must contain an explicit timestamp.
  await client.scheduledPublication.create(recordId, {});
  // @ts-expect-error Selective schedules require the non-localized flag.
  await client.scheduledPublication.create(recordId, { publication_scheduled_at: '2090-01-01', selective_publication: { content_in_locales: ['en'] } });
  // @ts-expect-error Upload creation requires an explicit ID.
  await client.uploads.createFromLocalFile({ localPath: './image.png' });
  // @ts-expect-error Folder creation requires an explicit ID.
  await client.uploadCollections.create({ label: 'Images' });
  // @ts-expect-error Arbitrary remote downloads are unsupported.
  await client.uploads.createFromUrl({ url: 'https://example.com/image.png' });
  // @ts-expect-error A replacement requires its explicit strategy.
  await client.uploads.update(uploadId, { path: './replacement.png' });
  // @ts-expect-error Replacement options are only supported with a binary path.
  await client.uploads.update(uploadId, { author: 'Editor' }, { replace_strategy: 'create_new_url' });
  // @ts-expect-error Keeping the original CDN URL is unsupported.
  await client.uploads.update(uploadId, { path: './replacement.png' }, { replace_strategy: 'keep_url' });
  // @ts-expect-error Direct resource replacement is forbidden.
  client.items = client.items;
  // @ts-expect-error The recorder methods cannot be replaced.
  client.items.update = client.items.update;
});

export async function generatedPart(client: ContentMigrationClient): Promise<void> {
  await client.items.update('record', { title: 'Part content' });
}
`;

describe('public content migration client types', () => {
  it('types generated operations and rejects unavailable methods, options and server results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-client-types-'));
    try {
      const source = join(directory, 'migration.ts');
      await writeFile(source, script);
      const root = resolve(__dirname, '../../../..');
      const program = ts.createProgram([source], {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        typeRoots: [join(root, 'node_modules/@types')],
        paths: {
          '@datocms/cli-plugin-content-diff/migration': [
            join(root, 'packages/cli-plugin-content-diff/src/migration.ts'),
          ],
        },
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      assert.equal(
        diagnostics.length,
        0,
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (filename) => filename,
          getCurrentDirectory: () => root,
          getNewLine: () => '\n',
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
