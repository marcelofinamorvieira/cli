import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('packaged CLI entrypoint', () => {
  const binDirectory = resolve('bin');
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-diff-entrypoint-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function run(
    args: string[],
    preload?: string,
    binary: 'run' | 'dev' = 'run',
  ) {
    return spawnSync(
      process.execPath,
      [
        ...(preload ? ['--require', preload] : []),
        join(binDirectory, binary),
        ...args,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          CI: '1',
          DATOCMS_DATA_DIR: join(directory, 'data'),
          DATOCMS_CONFIG_DIR: join(directory, 'config'),
          DATOCMS_CACHE_DIR: join(directory, 'cache'),
          OCLIF_SKIP_NEW_VERSION_CHECK: 'true',
        },
      },
    );
  }

  it('preserves oclif error exit codes without an unhandled rejection', () => {
    const result = run(['not-a-real-command']);

    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /command not-a-real-command not found/);
    assert.doesNotMatch(
      result.stderr,
      /CLIError:|Node\.js v|at Config\.runCommand/,
    );
  });

  it('renders command help successfully', () => {
    const result = run(['migrations:run', '--help']);

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Run migration scripts that have not run yet/);
  });

  for (const binary of ['run', 'dev'] as const) {
    it(`drains ${binary} output without treating a command result as the flush deadline`, async () => {
      const preload = join(directory, 'backpressure.cjs');
      await writeFile(
        preload,
        `
const Module = require('node:module');
const load = Module._load;
Module._load = function (id, parent, isMain) {
  if (id === '@oclif/core') return { ...load.call(this, id, parent, isMain), run: async () => ({ completed: true }) };
  return load.call(this, id, parent, isMain);
};
process.stdout.write = function () {
  setTimeout(() => process.stdout.emit('drain'), 30);
  return false;
};
`,
      );

      const result = run([], preload, binary);

      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
    });
  }
});
