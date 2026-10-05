import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import {
  executeMigrationPart,
  executeRecordedMigrationPart,
  loadMigrationModule,
} from '../../src/engine/migration-loader';

describe('trusted TypeScript migration loader', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-migration-loader-'));
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
    const helperPath = await realpath(join(directory, 'helper.cjs'));
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

  it('maps synchronous initialization and awaited failures to source lines', async () => {
    const initialization = join(directory, 'initialization.ts');
    await writeFile(
      initialization,
      'interface Ignored { value: number }\nthrow new Error("initialization failed");\nexport default async () => {};\n',
    );
    await assert.rejects(
      loadMigrationModule(initialization),
      (error: Error) => {
        assert.match(error.stack!, /initialization\.ts:2:\d+/);
        return true;
      },
    );
    const execution = join(directory, 'execution.ts');
    await writeFile(
      execution,
      'interface Ignored { value: number }\nexport default async function(): Promise<void> {\n  await Promise.resolve();\n  throw new Error("execution failed");\n}\n',
    );
    await assert.rejects(
      executeMigrationPart(execution, []),
      (error: Error) => {
        assert.match(error.message, /execution failed/);
        assert.match(error.stack!, /execution\.ts:4:\d+/);
        return true;
      },
    );
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

  it('isolates recorded parts and returns awaited client responses in order', async () => {
    const filename = join(directory, 'recorded.ts');
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
    await executeRecordedMigrationPart(filename, async (call) => {
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

  it('propagates worker source locations and recorder failures', async () => {
    const filename = join(directory, 'recorded.ts');
    await writeFile(
      filename,
      'interface Ignored {}\nexport default async function() {\n  throw new Error("worker failure");\n}\n',
    );
    await assert.rejects(
      executeRecordedMigrationPart(filename, () => undefined),
      (error: Error) => {
        assert.match(error.stack!, /recorded\.ts:3:\d+/);
        return true;
      },
    );
    await writeFile(
      filename,
      'export default async (client) => { await client.items.destroy("missing"); };',
    );
    await assert.rejects(
      executeRecordedMigrationPart(filename, async () => {
        throw new Error('recorder refused the operation');
      }),
      /recorder refused the operation/,
    );
  });

  it('drains a submitted recording callback before cancelled worker teardown', async () => {
    const filename = join(directory, 'recorded.ts');
    await writeFile(
      filename,
      'export default async (client) => { await client.items.create({}); await client.items.create({}); };',
    );
    const controller = new AbortController();
    let completed = false;
    let calls = 0;
    await assert.rejects(
      executeRecordedMigrationPart(
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

  it('reports abrupt worker exit and non-transferable recorder responses', async () => {
    const filename = join(directory, 'recorded.ts');
    await writeFile(filename, 'export default async () => process.exit(7);');
    await assert.rejects(
      executeRecordedMigrationPart(filename, () => undefined),
      /exited before completing \(7\)/,
    );
    await writeFile(
      filename,
      'export default async (client) => { await client.items.create({}); };',
    );
    await assert.rejects(
      executeRecordedMigrationPart(filename, () => () => undefined),
      /could not be cloned/,
    );
  });
});
