import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

// Compile real public exports, including the inferred defineContentMigration
// callback. A weakened facade makes an @ts-expect-error unused and fails this test.
const script = `
import type { CmaClient } from '@datocms/cli-utils';
import { defineContentMigration, checkMigration, runMigrationPart, uploadMigrationFile, type ContentMigrationClient } from '@datocms/cli-plugin-content-diff/migration';
declare const actualClient: CmaClient.Client;
const migration = defineContentMigration({ baseline: './fixture.content' }, async client => {
  checkMigration(client);
  const created = await client.items.create({ item_type: { id: 'model', type: 'item_type' }, title: 'Live' });
  const version: string = created.meta.current_version;
  const nested = await client.items.find(created.id, { nested: true });
  await client.items.update(nested.id, { title: 'Changed' });
  await client.items.publish(created.id);
  await client.items.unpublish(created.id);
  await client.items.destroy(created.id);
  const field = await client.fields.find('field');
  await client.fields.update(field.id, { validators: {} });
  await client.scheduledPublication.create('record', { publication_scheduled_at: '2090-01-01' });
  await client.scheduledPublication.destroy('record');
  await client.scheduledUnpublishing.create('record', { unpublishing_scheduled_at: '2090-01-01' });
  await client.scheduledUnpublishing.destroy('record');
  const folder = await client.uploadCollections.find('folder');
  await client.uploadCollections.create({ label: 'Folder', parent: folder });
  await client.uploadCollections.update(folder.id, { label: 'Changed' });
  await client.uploadCollections.destroy(folder.id);
  const upload = await client.uploads.createFromLocalFile({ localPath: './image.png' });
  const url: string = upload.url;
  const uploadedPath = await uploadMigrationFile(client, './image.png', 'image.png');
  await client.uploads.create({ path: uploadedPath });
  await client.uploads.update(upload.id, { path: uploadedPath }, { replace_strategy: 'create_new_url' });
  await client.uploads.updateFromLocalFile(upload.id, { localPath: './image.png' });
  await client.uploads.find(upload.id);
  await client.uploads.destroy(upload.id);
  await runMigrationPart(client, './part.ts');
  // @ts-expect-error Only transferable, awaited public methods are exposed.
  client.items.listPagedIterator();
  // @ts-expect-error Client configuration is not part of the generated-call interface.
  client.config;
  // @ts-expect-error Generated scripts do not manage environments.
  client.environments.destroy('main');
  // @ts-expect-error Real SDK signatures reject malformed options.
  client.items.destroy(123);
});
const format: 'datocms-content-migration' = migration.format;
const version: 2 = migration.version;
migration(actualClient);
// @ts-expect-error Metadata is readonly.
migration.version = 3;
export default migration;
export async function part(client: ContentMigrationClient) { return client.items.find('record'); }

`;

describe('public content migration client types', () => {
  it('retains SDK signatures and real responses while excluding unavailable client members', async () => {
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
          '@datocms/cli-utils': [
            join(root, 'packages/cli-utils/lib/index.d.ts'),
          ],
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
