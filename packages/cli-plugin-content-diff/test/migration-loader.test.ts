import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { require as tsxRequire } from 'tsx/cjs/api';
import {
  loadContentMigration,
  loadMigrationModule,
} from '../src/engine/migration-loader';
import {
  type ContentMigrationClient,
  runMigrationPart,
} from '../src/migration';

const fakeClient = (value: object) =>
  value as unknown as ContentMigrationClient;

describe('trusted TypeScript migration loader', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), 'content-migration-loader-')),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('awaits typed callbacks and resolves imports beside the migration', async () => {
    const filename = join(directory, 'part.ts');
    await writeFile(
      join(directory, 'helper.cjs'),
      'module.exports = { value: "relative dependency" };',
    );
    await writeFile(
      filename,
      `import { basename } from 'node:path';
       import helper from './helper.cjs';
       interface Client { save(value: unknown): Promise<void> }
       export default async function(client: Client): Promise<void> {
         await client.save({ helper: helper.value, file: basename(__filename), directory: __dirname });
       }`,
    );
    const calls: unknown[] = [];
    await runMigrationPart(
      fakeClient({
        async save(value: unknown) {
          await new Promise((resolve) => setImmediate(resolve));
          calls.push(value);
        },
      }),
      filename,
    );
    assert.deepEqual(calls, [
      {
        helper: 'relative dependency',
        file: 'part.ts',
        directory,
      },
    ]);
    assert.equal(require.cache[filename], undefined);
    // Ordinary imported dependencies intentionally retain standard semantics.
    const helperPath = tsxRequire.resolve(
      join(directory, 'helper.cjs'),
      __filename,
    );
    assert.ok(require.cache[helperPath]);
    delete require.cache[helperPath];
  });

  it('loads fresh code on each call and preserves exported runtime markers', async () => {
    const filename = join(directory, 'part.ts');
    await writeFile(
      filename,
      `const migration = Object.assign(async () => 1, { marker: 'migration', [Symbol.for('content-migration')]: true });
       Object.defineProperty(migration, 'hiddenMarker', { value: 'preserved' });
       export default migration;`,
    );
    const module = await loadMigrationModule<{
      default: (() => Promise<number>) & { marker: string };
    }>(filename);
    assert.equal(await module.default(), 1);
    assert.equal(module.default.marker, 'migration');
    assert.equal(Reflect.get(module.default, 'hiddenMarker'), 'preserved');
    assert.equal(
      Reflect.get(module.default, Symbol.for('content-migration')),
      true,
    );
    await writeFile(
      filename,
      'export default async (client: number[]) => { client.push(2); };',
    );
    const seen: number[] = [];
    await runMigrationPart(fakeClient(seen), filename);
    assert.deepEqual(seen, [2]);
    assert.equal(require.cache[filename], undefined);
  });

  it('keeps no loaded part among its parent module children', async () => {
    const filename = join(directory, 'part.ts');
    await writeFile(
      filename,
      'export const parent = module.parent; export default async () => {};',
    );
    for (let run = 0; run < 3; run++) {
      const { parent } = await loadMigrationModule<{ parent: NodeModule }>(
        filename,
      );
      assert.equal(
        parent.children.some((child) => child.filename === filename),
        false,
      );
    }
  });

  it('reports TypeScript syntax locations before evaluating source', async () => {
    const filename = join(directory, 'broken.ts');
    await writeFile(filename, 'export default async function( {\n');
    await assert.rejects(loadMigrationModule(filename), (error: Error) => {
      assert.match(error.message, /broken\.ts:\d+:\d+/);
      return true;
    });
  });

  it('maps initialization, inline callable callbacks and awaited part failures to source lines', async () => {
    const initialization = join(directory, 'initialization.ts');
    const execution = join(directory, 'execution.ts');
    const inline = join(directory, 'inline.ts');
    await writeFile(
      initialization,
      'interface Ignored { value: number }\nthrow new Error("initialization failed");\nexport default async () => {};\n',
    );
    await writeFile(
      execution,
      'interface Ignored { value: number }\nexport default async function(): Promise<void> {\n  await Promise.resolve();\n  throw new Error("execution failed");\n}\n',
    );
    await writeFile(
      inline,
      `import { defineContentMigration } from ${JSON.stringify(
        resolve(__dirname, '../src/migration.ts'),
      )};
interface Ignored { value: number }
export default defineContentMigration({ baseline: './fixture.content' }, async () => {
  await Promise.resolve();
  throw new Error('inline failed');
});`,
    );
    // Exercise native tsx source maps without the test runner's ts-node stack hook.
    const script = `
      const { loadMigrationModule, loadContentMigration } = require(${JSON.stringify(
        resolve(__dirname, '../src/engine/migration-loader.ts'),
      )});
      const { runMigrationPart } = require(${JSON.stringify(
        resolve(__dirname, '../src/migration.ts'),
      )});
      (async () => {
        for (const work of [
          () => loadMigrationModule(${JSON.stringify(initialization)}),
          () => runMigrationPart({}, ${JSON.stringify(execution)}),
          async () => (await loadContentMigration(${JSON.stringify(inline)}))({}),
        ]) { try { await work(); } catch (error) { console.log(error.stack); } }
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const result = await promisify(execFile)(process.execPath, [
      '--require',
      require.resolve('tsx/cjs'),
      '-e',
      script,
    ]);
    assert.match(result.stdout, /initialization\.ts:2:\d+/);
    assert.match(result.stdout, /execution\.ts:4:\d+/);
    assert.match(result.stdout, /inline\.ts:5:\d+/);
  }).timeout(120_000);

  it('loads TypeScript helpers through project path aliases in both module modes', async () => {
    for (const mode of ['commonjs', 'module']) {
      const root = join(directory, mode);
      await mkdir(join(root, 'helpers'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ type: mode }),
      );
      await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@helpers/*': ['./helpers/*'] },
          },
        }),
      );
      await writeFile(
        join(root, 'helpers/value.ts'),
        'export interface Value { label: string }; export const value: Value = { label: "typed helper" };',
      );
      const filename = join(root, 'migration.ts');
      await writeFile(
        filename,
        'import { value, type Value } from "@helpers/value"; export default async (client: { record(value: Value): void }) => { client.record(value); };',
      );
      // Like the native CLI, tsx resolves configuration from the project cwd.
      const script = `
        const assert = require('node:assert/strict');
        const { writeFile } = require('node:fs/promises');
        const { runMigrationPart } = require(${JSON.stringify(
          resolve(__dirname, '../src/migration.ts'),
        )});
        const filename = ${JSON.stringify(filename)};
        (async () => {
          const seen = [];
          await runMigrationPart({ record: (value) => seen.push(value) }, filename);
          assert.deepEqual(seen, [{ label: 'typed helper' }]);
          await writeFile(filename, 'import { value } from "@helpers/value"; export default async (client) => { await client.items.update("record", value); };');
          const calls = [];
          await runMigrationPart({ items: { update: async (...args) => { calls.push(args); } } }, filename);
          assert.deepEqual(calls, [['record', { label: 'typed helper' }]]);
          console.log('project aliases and fresh migration edits passed');
        })().catch(error => { console.error(error); process.exitCode = 1; });`;
      const result = await promisify(execFile)(
        process.execPath,
        ['--require', require.resolve('tsx/cjs'), '-e', script],
        { cwd: root },
      );
      assert.match(
        result.stdout,
        /project aliases and fresh migration edits passed/,
      );
    }
  }).timeout(120_000);

  it('requires callable metadata before accepting a content migration', async () => {
    const filename = join(directory, 'migration.ts');
    const callable = (metadata: string) =>
      `Object.assign(async () => {}, ${metadata})`;
    for (const declaration of [
      'async () => {}',
      '{}',
      '{ format: "datocms-content-migration", version: 1, options: { baseline: "baseline" } }',
      callable(
        '{ format: "other", version: 1, options: { baseline: "baseline" } }',
      ),
      callable(
        '{ format: "datocms-content-migration", options: { baseline: "baseline" } }',
      ),
      callable(
        '{ format: "datocms-content-migration", version: 2, options: { baseline: "baseline" } }',
      ),
      callable(
        '{ format: "datocms-content-migration", version: 1, options: { baseline: "" } }',
      ),
      callable('{ format: "datocms-content-migration", version: 1 }'),
    ]) {
      await writeFile(filename, `export default ${declaration};`);
      await assert.rejects(
        loadContentMigration(filename),
        /content:apply expects a default callable/,
      );
    }
    await writeFile(
      filename,
      `export default ${callable(
        '{ format: "datocms-content-migration", version: 1, options: { baseline: "baseline" } }',
      )};`,
    );
    assert.deepEqual((await loadContentMigration(filename)).options, {
      baseline: 'baseline',
    });
  });

  it('rejects non-callable parts and directories', async () => {
    const filename = join(directory, 'part.ts');
    await writeFile(filename, 'export default { value: 1 };');
    await assert.rejects(
      runMigrationPart(fakeClient({}), filename),
      /default function/,
    );
    await assert.rejects(loadMigrationModule(directory), /regular file/);
  });

  it('checks cooperative cancellation before loading', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      loadMigrationModule(join(directory, 'missing.ts'), controller.signal),
      /interrupted/,
    );
  });
});
