import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { afterEach, beforeEach, describe, it } from 'mocha';
import {
  type ContentMigrationClient,
  applyContentMigration,
  checkMigration,
  defineContentMigration,
  loadContentMigration,
  repairContentMigration,
  runMigrationPart,
  uploadMigrationFile,
} from '../../src/migration';
import { fixtureId } from './fixture-id';

describe('direct TypeScript content execution', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'direct-content-runtime-'));
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
    assert.equal(migration.version, 2);
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

  it('drains outstanding inline SDK work and restores methods before reporting callback failure', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const error = new Error('script failed');
    const events: string[] = [];
    const update = async () => {
      await pending;
      events.push('request completed');
    };
    const client = { items: { update } } as unknown as ContentMigrationClient;
    const migration = defineContentMigration(
      { baseline: directory },
      async (client) => {
        void client.items.update('record', {});
        throw error;
      },
    );
    const execution = migration(client);
    const rejected = assert
      .rejects(execution, (candidate) => candidate === error)
      .then(() => {
        events.push('runner cleanup');
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, []);
    release();
    await rejected;
    assert.deepEqual(events, ['request completed', 'runner cleanup']);
    assert.equal(client.items.update, update);
  });

  it('drains an inline SDK request on cancellation and prevents the next write', async () => {
    const controller = new AbortController();
    const interruption = Object.assign(new Error('interrupted'), {
      code: 'INTERRUPTED',
      exitCode: 130,
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ids: string[] = [];
    const update = async (id: string) => {
      ids.push(id);
      await pending;
      return {};
    };
    const client = { items: { update } } as unknown as ContentMigrationClient;
    const migration = defineContentMigration(
      { baseline: directory },
      async (client) => {
        await client.items.update('first', {});
        await client.items.update('must-not-run', {});
      },
    );
    const execution = migration(client, controller.signal);
    const rejected = assert.rejects(
      execution,
      (error) => error === interruption,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(interruption);
    assert.deepEqual(ids, ['first']);
    release();
    await rejected;
    assert.deepEqual(ids, ['first']);
    assert.equal(client.items.update, update);
  });

  it('preserves the original SDK Promise identity, cancellation and response values', async () => {
    let canceled = false;
    const value = { id: 'server-record', meta: { current_version: 'v3' } };
    const native = Object.assign(Promise.resolve(value), {
      cancel() {
        assert.equal(this, native);
        canceled = true;
      },
    });
    const client = {
      uploads: {
        createFromLocalFile() {
          return native;
        },
      },
    } as unknown as ContentMigrationClient;
    await defineContentMigration({ baseline: directory }, async (client) => {
      const promise = client.uploads.createFromLocalFile({
        localPath: './file',
      });
      assert(promise instanceof Promise);
      assert.equal(promise, native);
      promise.cancel();
      assert.equal(await promise, value);
    })(client);
    assert.equal(canceled, true);
  });

  it('allows ordinary caught SDK failures and finally restoration before explicit cancellation', async () => {
    const error = new Error('CMA refused write');
    const events: string[] = [];
    const client = {
      items: {
        async update() {
          throw error;
        },
      },
      fields: {
        async update() {
          events.push('restored');
        },
      },
    } as unknown as ContentMigrationClient;
    await defineContentMigration({ baseline: directory }, async (client) => {
      try {
        await client.items.update('record', {});
      } catch (caught) {
        assert.equal(caught, error);
      } finally {
        checkMigration(client);
        await client.fields.update('field', { validators: {} });
      }
    })(client);
    assert.deepEqual(events, ['restored']);
  });

  it('uploads companion bytes through the real SDK helper inline and across part IPC', async () => {
    const asset = join(directory, 'asset.txt');
    await writeFile(asset, 'asset bytes');
    const filenames: string[] = [];
    let uploads = 0;
    const client = {
      uploadRequest: {
        async create(body: { filename: string }) {
          filenames.push(body.filename);
          return {
            id: 'remote-upload-path',
            url: 'https://upload.invalid/path',
            request_headers: {},
          };
        },
      },
      config: {
        fetchFn: async () => {
          uploads++;
          return new Response('', { status: 200 });
        },
      },
    } as unknown as ContentMigrationClient;
    let received: unknown;
    await defineContentMigration({ baseline: directory }, async (client) => {
      received = await uploadMigrationFile(client, asset, 'asset.txt');
    })(client);
    assert.equal(received, 'remote-upload-path');
    const file = join(directory, 'upload.ts');
    await writeFile(
      file,
      `import { uploadMigrationFile } from ${JSON.stringify(
        resolve(__dirname, '../../src/migration.ts'),
      )};
      export default async client => {
        const path = await uploadMigrationFile(client, ${JSON.stringify(asset)}, 'asset.txt');
        if (path !== 'remote-upload-path') throw new Error('Expected the actual SDK upload path');
      };`,
    );
    await defineContentMigration({ baseline: directory }, (client) =>
      runMigrationPart(client, file),
    )(client);
    assert.equal(uploads, 2);
    assert.equal(filenames.length, 2);
    assert.notEqual(filenames[0], filenames[1]);
    for (const filename of filenames)
      assert.match(filename, /^[0-9a-f-]{36}-asset\.txt$/);
  });

  it('repairs without evaluating a throwing or broken migration entrypoint', async () => {
    const file = join(directory, 'repair.ts');
    await writeFile(file, 'throw new Error("ENTRYPOINT_MUST_NOT_EXECUTE");');
    await assert.rejects(
      repairContentMigration({
        rootClient: {} as CmaClient.Client,
        buildEnvironmentClient: () => {
          throw new Error('No API should be reached without a companion');
        },
        scriptPath: file,
        options: { allowPrimary: false },
      }),
      (error) => {
        assert.doesNotMatch(
          String(error),
          /ENTRYPOINT_MUST_NOT_EXECUTE|No API should be reached/,
        );
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
        assert.match(String(error), /repair\.content/);
        return true;
      },
    );
  });

  it('preflights source and companion without evaluating top-level side effects or imports', async () => {
    const file = join(directory, 'paired.ts');
    const marker = join(directory, 'evaluated');
    await writeFile(
      file,
      `import { writeFileSync } from 'node:fs';
      import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../../src/migration.ts'),
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
        allowTemporarySchemaChanges: false,
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
        resolve(__dirname, '../../src/migration.ts'),
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
          allowTemporarySchemaChanges: false,
        },
      }),
      (error) =>
        (error as { code?: string }).code === 'MIGRATION_BASELINE_MISMATCH',
    );
  });

  it('loads callable v2 scripts and excludes recording and replanning from the runtime', async () => {
    const file = join(directory, 'migration.ts');
    await writeFile(
      file,
      `import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../../src/migration.ts'),
      )}; export default defineContentMigration({baseline: './proof'}, async client => { await client.items.find('record'); });`,
    );
    const loaded = await loadContentMigration(file);
    assert.equal(typeof loaded, 'function');
    assert.equal(loaded.options.baseline, './proof');
    const source = await readFile(
      resolve(__dirname, '../../src/migration.ts'),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /createIntentRecorder|createPlan|SnapshotStore|migration-intent|migration-validity/,
    );
  });
});
