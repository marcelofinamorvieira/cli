import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { require as tsxRequire } from 'tsx/cjs/api';
import {
  executeDirectMigrationPart,
  executeMigrationPart,
  loadMigrationModule,
} from '../../src/engine/migration-loader';
import { loadContentMigration } from '../../src/migration';

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
       export default async function(client: Client): Promise<string> {
         await client.save({ helper: helper.value, file: basename(__filename), directory: __dirname });
         return 'complete';
       }`,
    );
    const calls: unknown[] = [];
    const result = await executeMigrationPart(filename, [
      {
        async save(value: unknown) {
          await new Promise((resolve) => setImmediate(resolve));
          calls.push(value);
        },
      },
    ]);
    assert.equal(result, 'complete');
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
    await writeFile(filename, 'export default async () => 2;');
    assert.equal(await executeMigrationPart(filename, []), 2);
    assert.equal(require.cache[filename], undefined);
  });

  it('supports CommonJS exports and ESM TypeScript file extensions', async () => {
    const commonjs = join(directory, 'part.cts');
    await writeFile(
      commonjs,
      'module.exports = async (value: number) => value + 1;',
    );
    assert.equal(await executeMigrationPart(commonjs, [3]), 4);
    const esm = join(directory, 'part.mts');
    await writeFile(esm, 'export default async (value: number) => value + 2;');
    assert.equal(await executeMigrationPart(esm, [3]), 5);
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
        resolve(__dirname, '../../src/migration.ts'),
      )};
interface Ignored { value: number }
export default defineContentMigration({ baseline: './fixture.content' }, async () => {
  await Promise.resolve();
  throw new Error('inline failed');
});`,
    );
    // Exercise native tsx source maps without the test runner's ts-node stack hook.
    const script = `
      const { loadMigrationModule, executeMigrationPart } = require(${JSON.stringify(
        resolve(__dirname, '../../src/engine/migration-loader.ts'),
      )});
      const { loadContentMigration } = require(${JSON.stringify(
        resolve(__dirname, '../../src/migration.ts'),
      )});
      (async () => {
        for (const work of [
          () => loadMigrationModule(${JSON.stringify(initialization)}),
          () => executeMigrationPart(${JSON.stringify(execution)}, []),
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
  });

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
        'import { value, type Value } from "@helpers/value"; export default async (): Promise<Value> => value;',
      );
      // Like the native CLI, tsx resolves configuration from the project cwd.
      const script = `
        const assert = require('node:assert/strict');
        const { writeFile } = require('node:fs/promises');
        const { executeMigrationPart, executeDirectMigrationPart } = require(${JSON.stringify(
          resolve(__dirname, '../../src/engine/migration-loader.ts'),
        )});
        const filename = ${JSON.stringify(filename)};
        (async () => {
          assert.deepEqual(await executeMigrationPart(filename, []), { label: 'typed helper' });
          await writeFile(filename, 'import { value } from "@helpers/value"; export default async () => ({ ...value, edited: true });');
          assert.deepEqual(await executeMigrationPart(filename, []), { label: 'typed helper', edited: true });
          await writeFile(filename, 'import { value } from "@helpers/value"; export default async (client) => { await client.items.update("record", value); };');
          const calls = [];
          await executeDirectMigrationPart(filename, (call) => { calls.push(call); });
          assert.deepEqual(calls, [{ resource: 'items', method: 'update', args: ['record', { label: 'typed helper' }] }]);
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
  });

  it('requires callable v2 metadata before accepting a content migration', async () => {
    const filename = join(directory, 'migration.ts');
    for (const declaration of [
      'async () => {}',
      '{}',
      '{ format: "other", version: 1, options: { baseline: "baseline" }, run() {} }',
      '{ format: "datocms-content-migration", version: 2, options: { baseline: "baseline" }, run() {} }',
      '{ format: "datocms-content-migration", version: 1, options: { baseline: "" }, run() {} }',
    ]) {
      await writeFile(filename, `export default ${declaration};`);
      await assert.rejects(
        loadContentMigration(filename),
        /content:apply expects a default callable/,
      );
    }
  });

  it('rejects non-callable parts, invalid UTF-8, and invalid size limits', async () => {
    const filename = join(directory, 'part.ts');
    await writeFile(filename, 'export default { value: 1 };');
    await assert.rejects(
      executeMigrationPart(filename, []),
      /default function/,
    );
    await assert.rejects(
      loadMigrationModule(filename, { maxBytes: 0 }),
      /positive safe integer/,
    );
    await assert.rejects(
      loadMigrationModule(filename, { maxBytes: 1 }),
      /exceeds 1 byte/,
    );
    await writeFile(filename, Buffer.from([0xff]));
    await assert.rejects(loadMigrationModule(filename), /valid UTF-8/);
    await assert.rejects(loadMigrationModule(directory), /regular file/);
  });

  it('supports a larger explicitly permitted file without a per-record cap', async () => {
    const filename = join(directory, 'large.ts');
    const source = `export default async () => ${JSON.stringify(
      'x'.repeat(32_000),
    )};`;
    await writeFile(filename, source);
    await assert.rejects(
      loadMigrationModule(filename, { maxBytes: 1024 }),
      /exceeds/,
    );
    assert.equal(
      (
        await executeMigrationPart<[], string>(filename, [], {
          maxBytes: 64_000,
        })
      ).length,
      32_000,
    );
  });

  it('checks cooperative cancellation before loading and after awaited work', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      loadMigrationModule(join(directory, 'missing.ts'), {
        signal: controller.signal,
      }),
      /interrupted/,
    );
    const filename = join(directory, 'part.ts');
    await writeFile(
      filename,
      'export default async (work: () => Promise<void>) => { await work(); };',
    );
    const active = new AbortController();
    let completed = false;
    await assert.rejects(
      executeMigrationPart(
        filename,
        [
          async () => {
            active.abort();
            await new Promise((resolve) => setImmediate(resolve));
            completed = true;
          },
        ],
        { signal: active.signal },
      ),
      /interrupted/,
    );
    assert.equal(completed, true);
  });

  it('isolates direct parts and returns awaited client responses in order', async () => {
    const filename = join(directory, 'live.ts');
    await writeFile(
      filename,
      `export default async function(client) {
        const created = await client.items.create({ title: 'first' });
        await Promise.all([
          client.items.update(created.id, { title: 'second' }),
          client.items.publish(created.id),
        ]);
      }`,
    );
    const calls: unknown[] = [];
    let active = 0;
    await executeDirectMigrationPart(filename, async (call) => {
      assert.equal(++active, 1);
      await new Promise((resolve) => setImmediate(resolve));
      calls.push(call);
      active--;
      return { id: 'created-id' };
    });
    assert.deepEqual(calls, [
      { resource: 'items', method: 'create', args: [{ title: 'first' }] },
      {
        resource: 'items',
        method: 'update',
        args: ['created-id', { title: 'second' }],
      },
      { resource: 'items', method: 'publish', args: ['created-id'] },
    ]);
    assert.equal(require.cache[filename], undefined);
  });

  it('releases each part process and its compiler descendants before the next part', async function () {
    if (process.platform === 'win32') this.skip();
    const filename = join(directory, 'process-lifecycle.ts');
    await writeFile(
      filename,
      `import { execFileSync } from 'node:child_process';
export default async (client) => {
  const children = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\\n').map(line => line.trim().split(/\\s+/))
    .filter(row => Number(row[1]) === process.pid && row.slice(2).join(' ').includes('esbuild'))
    .map(row => Number(row[0]));
  await client.probe.observe({ pid: process.pid, children });
};`,
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    };
    for (let index = 0; index < 3; index++) {
      let observed: { pid: number; children: number[] } | undefined;
      await executeDirectMigrationPart(filename, (call) => {
        observed = call.args[0] as typeof observed;
      });
      assert(observed);
      assert.notEqual(observed.pid, process.pid);
      assert.equal(alive(observed.pid), false);
      assert(
        observed.children.length > 0,
        'the real compiler process must be observed',
      );
      const deadline = Date.now() + 3000;
      while (observed.children.some(alive) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(observed.children.some(alive), false);
    }
  });

  it('bounds cleanup of a completed part that leaves handles and ignores termination', async () => {
    const filename = join(directory, 'lingering.ts');
    await writeFile(
      filename,
      `export default async (client) => {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      await client.probe.observe(process.pid);
    };`,
    );
    let pid = 0;
    await executeDirectMigrationPart(filename, (call) => {
      pid = call.args[0] as number;
    });
    assert(pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
  });

  it('propagates worker source locations and CMA failures', async () => {
    const filename = join(directory, 'live.ts');
    await writeFile(
      filename,
      'interface Ignored {}\nexport default async function() {\n  throw new Error("worker failure");\n}\n',
    );
    await assert.rejects(
      executeDirectMigrationPart(filename, () => undefined),
      (error: Error) => {
        assert.match(error.stack!, /live\.ts:3:\d+/);
        return true;
      },
    );
    await writeFile(
      filename,
      'export default async (client) => { await client.items.destroy("missing"); };',
    );
    await assert.rejects(
      executeDirectMigrationPart(filename, async () => {
        throw new Error('CMA refused the operation');
      }),
      /CMA refused the operation/,
    );
  });

  it('stops queued live calls after failure and preserves the original parent SDK error', async () => {
    const filename = join(directory, 'failed-requests.ts');
    await writeFile(
      filename,
      `export default async client => {
      await Promise.all([
        client.items.update('first', {}),
        client.items.update('must-not-run', {}),
      ]);
    };`,
    );
    const original = Object.assign(new Error('CMA request failed'), {
      name: 'ApiError',
      request: { method: 'PUT' },
      response: { status: 422 },
    });
    const calls: string[] = [];
    await assert.rejects(
      executeDirectMigrationPart(filename, (call) => {
        calls.push(call.args[0] as string);
        throw original;
      }),
      (error) => error === original,
    );
    assert.deepEqual(calls, ['first']);
  });

  it('allows a handled CMA failure to recover with a newly submitted live call', async () => {
    const filename = join(directory, 'recover.ts');
    await writeFile(
      filename,
      `export default async client => {
      try { await client.items.find('missing'); }
      catch { await client.items.create({ title: 'Recovered' }); }
    };`,
    );
    const calls: string[] = [];
    await executeDirectMigrationPart(filename, (call) => {
      calls.push(call.method);
      if (call.method === 'find')
        throw Object.assign(new Error('Not found'), { name: 'ApiError' });
      return { id: 'created' };
    });
    assert.deepEqual(calls, ['find', 'create']);
  });

  it('drains a submitted CMA callback before cancelled worker teardown', async () => {
    const filename = join(directory, 'live.ts');
    await writeFile(
      filename,
      'export default async (client) => { await client.items.create({}); await client.items.create({}); };',
    );
    const controller = new AbortController();
    let completed = false;
    let calls = 0;
    await assert.rejects(
      executeDirectMigrationPart(
        filename,
        async () => {
          calls++;
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 30));
          completed = true;
        },
        { signal: controller.signal },
      ),
      /interrupted/,
    );
    assert.equal(calls, 1);
    assert.equal(completed, true);
  });

  it('reports abrupt worker exit and non-transferable CMA responses', async () => {
    const filename = join(directory, 'live.ts');
    await writeFile(filename, 'export default async () => process.exit(7);');
    await assert.rejects(
      executeDirectMigrationPart(filename, () => undefined),
      /exited before completing \(7\)/,
    );
    await writeFile(
      filename,
      'export default async (client) => { await client.items.create({}); };',
    );
    await assert.rejects(
      executeDirectMigrationPart(filename, () => () => undefined),
      /could not be cloned/,
    );
  });
});
