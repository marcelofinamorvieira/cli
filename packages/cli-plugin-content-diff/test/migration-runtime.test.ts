import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { applyContentMigration } from '../src/engine/apply';
import { loadContentMigration } from '../src/engine/migration-loader';
import {
  type ContentMigrationClient,
  defineContentMigration,
  runMigrationPart,
} from '../src/migration';
import { fixtureId } from './fixture-id';

describe('TypeScript content execution', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-runtime-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('passes the same real CMA client and actual server responses to inline scripts', async () => {
    const id = fixtureId('server-record');
    const model = fixtureId('server-model');
    const requests: Array<{ method: string; url: string }> = [];
    const client = CmaClient.buildClient({
      apiToken: 'local-mock-only',
      environment: 'sandbox',
      fetchFn: async (url, init) => {
        requests.push({ method: init?.method ?? 'GET', url: String(url) });
        return new Response(
          JSON.stringify({
            data: {
              id,
              type: 'item',
              attributes: { title: 'Real response' },
              relationships: {
                item_type: { data: { id: model, type: 'item_type' } },
              },
              meta: { current_version: 'server-version' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const original = client.items.update;
    const migration = defineContentMigration(
      { baseline: directory },
      async (supplied) => {
        assert.equal(supplied, client);
        const response = await supplied.items.update(id, { title: 'Edited' });
        assert.equal(response.meta.current_version, 'server-version');
        assert.equal(response.title, 'Real response');
        await supplied.items.find(response.id, { nested: true });
      },
    );
    assert.equal(typeof migration, 'function');
    assert.equal(migration.format, 'datocms-content-migration');
    assert.equal(migration.version, 1);
    await migration(client);
    assert.equal(client.items.update, original);
    assert.deepEqual(
      requests.map((request) => request.method),
      ['PUT', 'GET'],
    );
    assert.equal(requests.length, 2);
  });

  it('forwards real results between part calls only after the previous request finishes', async () => {
    const file = join(directory, 'part.ts');
    await writeFile(
      file,
      `export default async client => {
      const found = await client.items.find('existing');
      const updated = await client.items.update(found.id, { title: found.title, meta: { current_version: found.meta.current_version } });
      await client.items.publish(updated.id);
    };`,
    );
    const events: string[] = [];
    const client = {
      items: {
        async find() {
          events.push('read');
          return {
            id: 'actual-id',
            title: 'server-value',
            meta: { current_version: 'v8' },
          };
        },
        async update(id: string, payload: unknown) {
          assert.equal(id, 'actual-id');
          assert.deepEqual(payload, {
            title: 'server-value',
            meta: { current_version: 'v8' },
          });
          await new Promise((resolve) => setTimeout(resolve, 15));
          events.push('write-complete');
          return { id: 'updated-id' };
        },
        async publish(id: string) {
          assert.equal(id, 'updated-id');
          assert.equal(events.at(-1), 'write-complete');
          events.push('publish');
        },
      },
    } as unknown as ContentMigrationClient;
    await defineContentMigration({ baseline: directory }, (client) =>
      runMigrationPart(client, file),
    )(client);
    assert.deepEqual(events, ['read', 'write-complete', 'publish']);
  });

  it('runs each part in-process with the real client and observes edits on the next run', async () => {
    const file = join(directory, 'part.ts');
    const seen: unknown[] = [];
    const client = {
      record: (value: unknown) => seen.push(value),
    } as unknown as ContentMigrationClient;
    await writeFile(
      file,
      'export default async (client: any) => { client.record(client); client.record(process.pid); };',
    );
    await runMigrationPart(client, file);
    assert.deepEqual(seen, [client, process.pid]);
    await writeFile(
      file,
      'export default async (client: any) => { client.record("edited"); };',
    );
    await runMigrationPart(client, file);
    assert.deepEqual(seen, [client, process.pid, 'edited']);
    await writeFile(
      file,
      'export default async () => { throw new Error("part failed"); };',
    );
    await assert.rejects(runMigrationPart(client, file), /part failed/);
  });

  it('preflights source and companion without evaluating top-level side effects or imports', async () => {
    const file = join(directory, 'paired.ts');
    const marker = join(directory, 'evaluated');
    await writeFile(
      file,
      `import { writeFileSync } from 'node:fs';
      import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../src/migration.ts'),
      )};
      writeFileSync(${JSON.stringify(marker)}, 'evaluated');
      export default defineContentMigration({ baseline: './paired.content' }, async () => {});`,
    );
    const args = {
      rootClient: {} as CmaClient.Client,
      buildEnvironmentClient: () => {
        throw new Error('No API before companion verification');
      },
      scriptPath: file,
      options: {
        inPlace: false,
        allowPrimary: false,
        keepFailedFork: false,
        concurrency: 8,
        fastFork: true,
      },
    };
    await assert.rejects(
      applyContentMigration({
        ...args,
        options: { ...args.options, preflightOnly: true },
      }),
      (error) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    await assert.rejects(
      readFile(marker),
      (error) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    // Normal application imports trusted executable code before baseline checks.
    await assert.rejects(
      applyContentMigration(args),
      (error) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    assert.equal(await readFile(marker, 'utf8'), 'evaluated');
    await writeFile(
      file,
      'import "missing-and-must-not-be-loaded"; throw new Error("MUST_NOT_EXECUTE");',
    );
    await assert.rejects(
      applyContentMigration({
        ...args,
        options: { ...args.options, preflightOnly: true },
      }),
      (error) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  });

  it('rejects a normal script bound to a different companion before any API access', async () => {
    const file = join(directory, 'paired.ts');
    await writeFile(
      file,
      `import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../src/migration.ts'),
      )}; export default defineContentMigration({baseline: './other.content'}, async () => {});`,
    );
    await assert.rejects(
      applyContentMigration({
        rootClient: {} as CmaClient.Client,
        buildEnvironmentClient: () => {
          throw new Error('No API');
        },
        scriptPath: file,
        options: {
          inPlace: false,
          allowPrimary: false,
          keepFailedFork: false,
          concurrency: 8,
          fastFork: true,
        },
      }),
      (error) =>
        (error as { code?: string }).code === 'MIGRATION_BASELINE_MISMATCH',
    );
  });

  it('accepts a generated script reached through a symlinked directory', async () => {
    const real = join(directory, 'real');
    await mkdir(real);
    await symlink(real, join(directory, 'link'), 'dir');
    const file = join(directory, 'link', 'paired.ts');
    await writeFile(
      file,
      `import { join } from 'node:path';
      import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../src/migration.ts'),
      )};
      export default defineContentMigration({ baseline: join(__dirname, 'paired.content') }, async () => {});`,
    );
    // The binding check passes; the missing companion fails the baseline load.
    await assert.rejects(
      applyContentMigration({
        rootClient: {} as CmaClient.Client,
        buildEnvironmentClient: () => {
          throw new Error('No API');
        },
        scriptPath: file,
        options: {
          inPlace: false,
          allowPrimary: false,
          keepFailedFork: false,
          concurrency: 8,
          fastFork: true,
        },
      }),
      (error) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  });

  it('checks the companion beside the real file of a symlinked script', async () => {
    const real = join(directory, 'real');
    await mkdir(real);
    const file = join(real, '1_sync.ts');
    await writeFile(
      file,
      `import { join } from 'node:path';
      import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../src/migration.ts'),
      )};
      export default defineContentMigration({ baseline: join(__dirname, '1_sync.content') }, async () => {});`,
    );
    await symlink(file, join(directory, 'latest.ts'), 'file');
    // A stale companion beside the link must not be the one checked.
    await mkdir(join(directory, 'latest.content'));
    for (const preflightOnly of [true, false])
      await assert.rejects(
        applyContentMigration({
          rootClient: {} as CmaClient.Client,
          buildEnvironmentClient: () => {
            throw new Error('No API');
          },
          scriptPath: join(directory, 'latest.ts'),
          options: {
            inPlace: false,
            allowPrimary: false,
            keepFailedFork: false,
            concurrency: 8,
            fastFork: true,
            preflightOnly,
          },
        }),
        (error) =>
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          String((error as NodeJS.ErrnoException).path).includes(
            join('real', '1_sync.content'),
          ),
      );
  });

  it('loads callable scripts', async () => {
    const file = join(directory, 'migration.ts');
    await writeFile(
      file,
      `import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../src/migration.ts'),
      )}; export default defineContentMigration({baseline: './proof'}, async client => { await client.items.find('record'); });`,
    );
    const loaded = await loadContentMigration(file);
    assert.equal(typeof loaded, 'function');
    assert.equal(loaded.options.baseline, './proof');
  });
});
