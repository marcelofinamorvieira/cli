import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

// Compile real public exports, including the inferred defineContentMigration
// callback. A weakened type makes an @ts-expect-error unused and fails this test.
const script = `
import type { CmaClient } from '@datocms/cli-utils';
import { defineContentMigration, reorderRecords, runMigrationPart, type ContentMigrationClient } from '@datocms/cli-plugin-content-diff/migration';
declare const actualClient: CmaClient.Client;
const migration = defineContentMigration({ baseline: './fixture.content' }, async client => {
  const created = await client.items.create({ item_type: { id: 'model', type: 'item_type' }, title: 'Live' });
  const version: string = created.meta.current_version;
  const nested = await client.items.find(created.id, { nested: true });
  await client.items.update(nested.id, { title: 'Changed', meta: { current_version: version } });
  await client.items.publish(created.id);
  await client.scheduledPublication.create('record', { publication_scheduled_at: '2090-01-01' });
  const folder = await client.uploadCollections.find('folder');
  await client.uploadCollections.reorder([{ id: folder.id, type: 'upload_collection', position: 1, parent: null }]);
  const upload = await client.uploads.createFromUrl({ url: 'https://example.com/image.png' });
  const url: string = upload.url;
  const replaced = await client.uploads.updateFromUrl(upload.id, { url: 'https://example.com/other.png', filename: 'other.png' });
  const md5: string = replaced.md5;
  await reorderRecords(client, { model: 'model', parent: null, order: ['a', 'b'] });
  // @ts-expect-error The order lists record IDs.
  await reorderRecords(client, { model: 'model', parent: null, order: [1] });
  for await (const record of client.items.listPagedIterator({ filter: { type: 'model' } })) record.id;
  const environment: string | undefined = client.config.environment;
  await runMigrationPart(client, './part.ts');
  // @ts-expect-error Real SDK signatures reject malformed options.
  client.items.destroy(123);
});
const format: 'datocms-content-migration' = migration.format;
const version: 1 = migration.version;
const sameClient: ContentMigrationClient = actualClient;
migration(sameClient);
// @ts-expect-error Metadata is readonly.
migration.version = 3;
export default migration;
export async function part(client: ContentMigrationClient) { return client.items.find('record'); }

`;

describe('public content migration client types', () => {
  it('exposes the full SDK client with its real signatures and responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-client-types-'));
    try {
      const source = join(directory, 'migration.ts');
      await writeFile(source, script);
      const root = resolve(__dirname, '../../..');
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
