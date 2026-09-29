import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

describe('linked plugin in the supported DatoCMS host', () => {
  const root = resolve('.');
  const localRequire = createRequire(join(root, 'package.json'));
  let directory: string;
  let configPath: string;
  let preloadPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'datocms-plugin-host-'));
    const dataDirectory = join(directory, 'data');
    await mkdir(dataDirectory);
    await writeFile(
      join(dataDirectory, 'package.json'),
      JSON.stringify({
        name: 'datocms',
        oclif: {
          schema: 1,
          plugins: [
            {
              name: '@datocms/cli-plugin-content-diff',
              root,
              type: 'link',
            },
          ],
        },
      }),
    );
    configPath = join(directory, 'datocms.config.json');
    await writeFile(configPath, JSON.stringify({ profiles: { default: {} } }));
    preloadPath = join(directory, 'mock-cma.cjs');
    await writeFile(
      preloadPath,
      `
const { appendFileSync } = require('node:fs');
const { CmaClient, CmaClientCommand } = require(${JSON.stringify(
        localRequire.resolve('@datocms/cli-utils'),
      )});
const environments = [{ id: 'primary', meta: { primary: true } }, { id: 'sandbox', meta: { primary: false } }];
CmaClientCommand.prototype.buildClient = async () => ({
  site: { find: async () => ({ id: 'wrong-site' }) },
  environments: {
    list: async () => environments,
    find: async (id) => environments.find((environment) => environment.id === id),
    fork: async () => {
      appendFileSync(${JSON.stringify(join(directory, 'mutations.log'))}, 'fork\\n');
      throw new Error('Unexpected CMA mutation');
    },
  },
  itemTypes: { find: async () => { throw new CmaClient.ApiError({
    request: { url: '/item-types/schema_migration', method: 'GET', headers: {} },
    response: { status: 404, statusText: 'Not Found', headers: {} },
  }); } },
});
`,
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function run(args: string[], extraPreloads: string[] = []) {
    return spawnSync(
      process.execPath,
      [
        '--require',
        localRequire.resolve('ts-node/register'),
        ...[preloadPath, ...extraPreloads].flatMap((path) => [
          '--require',
          path,
        ]),
        join(dirname(localRequire.resolve('datocms/package.json')), 'bin/run'),
        ...args,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATOCMS_DATA_DIR: join(directory, 'data'),
          DATOCMS_CONFIG_DIR: join(directory, 'config'),
          DATOCMS_CACHE_DIR: join(directory, 'cache'),
          DATOCMS_SKIP_NEW_VERSION_CHECK: 'true',
          // Keep oclif warnings and errors on one line for the assertions.
          OCLIF_COLUMNS: '1000',
          TS_NODE_PROJECT: join(root, 'tsconfig.json'),
        },
      },
    );
  }

  /**
   * Writes a preload that runs `body` (with `this` bound to the loaded host
   * Config) right before the host runs its init hooks.
   */
  async function beforeInitHooks(name: string, body: string) {
    const path = join(directory, name);
    await writeFile(
      path,
      `
const { Config } = require(${JSON.stringify(
        localRequire.resolve('@oclif/core'),
      )});
const runHook = Config.prototype.runHook;
Config.prototype.runHook = function (event, ...rest) {
  if (event === 'init') {
${body}
  }
  return runHook.call(this, event, ...rest);
};
`,
    );
    return path;
  }

  // A stale or partial install whose manifest no longer lists migrations:run.
  const breakTakeover = () =>
    beforeInitHooks(
      'break-takeover.cjs',
      `const plugin = this.plugins.get('@datocms/cli-plugin-content-diff');
    plugin.commands = plugin.commands.filter((command) => command.id !== 'migrations:run');`,
    );

  const contentDiffWarning =
    /Warning: content-diff's content:diff, migrations:new and migrations:run commands are unavailable: the installed plugin does not provide migrations:run\. To fix it, reinstall the plugin with `datocms plugins:install @datocms\/cli-plugin-content-diff@[^`]+` \(or the tarball you installed it from\), or run `datocms plugins:remove @datocms\/cli-plugin-content-diff` to go back to the stock datocms migrations commands\./g;

  const takeoverFatal =
    /Error: Cannot activate content-diff's migrations:new and migrations:run commands: the installed plugin does not provide migrations:run\. The stock datocms migrations commands are never used in their place, because they skip content-diff's migration safeguards\. To fix it, reinstall the plugin with `datocms plugins:install [^`]+` \(or the tarball you installed it from\), or run `datocms plugins:remove @datocms\/cli-plugin-content-diff` to go back to the stock datocms migrations commands\./;

  for (const args of [
    ['migrations:run', '--help'],
    ['help', 'migrations:run'],
  ]) {
    it(`shows plugin migration flags through host ${args.join(' ')}`, () => {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Allow running reviewed migrations/);
      assert.doesNotMatch(result.stdout, /strictly additive/);
      assert.doesNotMatch(result.stderr, /commands are unavailable/);
    });
  }

  it('runs unrelated host commands with one warning when the takeover is broken', async () => {
    const result = run(
      ['environments:list', '--profile=default', `--config-file=${configPath}`],
      [await breakTakeover()],
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sandbox/);
    assert.equal(result.stderr.match(contentDiffWarning)?.length, 1);
  });

  for (const args of [['help'], ['environments:list', '--help']]) {
    it(`renders host ${args.join(
      ' ',
    )} with one warning when the takeover is broken`, async () => {
      const result = run(args, [await breakTakeover()]);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /USAGE/);
      assert.equal(result.stderr.match(contentDiffWarning)?.length, 1);
    });
  }

  it('refuses migrations:run instead of falling back to the stock runner when the takeover is broken', async () => {
    await mkdir(join(directory, 'migrations'));
    const result = run(
      [
        'migrations:run',
        '--source=sandbox',
        '--destination=generated',
        '--profile=default',
        `--config-file=${configPath}`,
      ],
      [await breakTakeover()],
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, takeoverFatal);
    assert.doesNotMatch(result.stderr, /Warning: content-diff/);
    await assert.rejects(
      readFile(join(directory, 'mutations.log')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  for (const args of [
    ['migrations:run', '--help'],
    ['help', 'migrations:run'],
    ['--help', 'migrations:new'],
    ['help', 'content:diff'],
  ]) {
    it(`refuses host ${args.join(
      ' ',
    )} when the takeover is broken`, async () => {
      const result = run(args, [await breakTakeover()]);

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, takeoverFatal);
      assert.equal(result.stdout, '');
    });
  }

  // A replacement descriptor the host cannot copy, so the takeover throws
  // after replacing migrations:new and before migrations:run's loader.
  const throwDuringTakeover = () =>
    beforeInitHooks(
      'unreadable-descriptor.cjs',
      `const plugin = this.plugins.get('@datocms/cli-plugin-content-diff');
    const command = plugin.commands.find((command) => command.id === 'migrations:run');
    Object.defineProperty(command, 'description', {
      enumerable: true,
      get() { throw new Error('description is unreadable'); },
    });`,
    );

  it('refuses migrations:run instead of falling back to the stock runner when the takeover throws', async () => {
    await mkdir(join(directory, 'migrations'));
    const result = run(
      [
        'migrations:run',
        '--source=sandbox',
        '--destination=generated',
        '--profile=default',
        `--config-file=${configPath}`,
      ],
      [await throwDuringTakeover()],
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /Error: Cannot activate content-diff's migrations:new and migrations:run commands: an unexpected error occurred \(description is unreadable\)\. The stock datocms migrations commands are never used in their place/,
    );
    await assert.rejects(
      readFile(join(directory, 'mutations.log')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  it('runs unrelated host commands with one warning when the takeover throws', async () => {
    const result = run(
      ['environments:list', '--profile=default', `--config-file=${configPath}`],
      [await throwDuringTakeover()],
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sandbox/);
    assert.equal(
      result.stderr.match(
        /Warning: content-diff's content:diff, migrations:new and migrations:run commands are unavailable: an unexpected error occurred \(description is unreadable\)\. To fix it, reinstall the plugin/g,
      )?.length,
      1,
    );
  });

  it('tolerates a dangling root of another installed plugin', async () => {
    const otherPluginTarget = join(directory, 'other-plugin-checkout');
    const otherPluginRoot = join(directory, 'other-plugin');
    await mkdir(otherPluginTarget);
    await writeFile(
      join(otherPluginTarget, 'package.json'),
      JSON.stringify({ name: 'other-plugin', version: '1.0.0', oclif: {} }),
    );
    await symlink(otherPluginTarget, otherPluginRoot);
    const userPackagePath = join(directory, 'data', 'package.json');
    const userPackage = JSON.parse(await readFile(userPackagePath, 'utf8'));
    userPackage.oclif.plugins.unshift({
      name: 'other-plugin',
      root: otherPluginRoot,
      type: 'link',
    });
    await writeFile(userPackagePath, JSON.stringify(userPackage));
    // The link target disappears after oclif loaded the plugin, leaving its
    // root as a dangling symlink when the init hooks run.
    const removeTarget = await beforeInitHooks(
      'remove-link-target.cjs',
      `require('node:fs').rmSync(${JSON.stringify(
        otherPluginTarget,
      )}, { recursive: true, force: true });`,
    );

    const result = run(['migrations:run', '--help'], [removeTarget]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Allow running reviewed migrations/);
    assert.doesNotMatch(result.stderr, /commands are unavailable/);
  });

  it('dispatches migrations:new to the compatibility command instead of the core command', () => {
    const result = run([
      'migrations:new',
      'sync schema',
      '--autogenerate=:destination',
      '--profile=default',
      `--config-file=${configPath}`,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /--autogenerate must use the format SOURCE or SOURCE:DESTINATION/,
    );
  });

  it('dispatches migrations:run to the destination-bound runner instead of the core command', () => {
    const result = run([
      'migrations:run',
      '--migrations-model=datocms_content_diff',
      '--profile=default',
      `--config-file=${configPath}`,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /content-diff legacy-ID mapping ledger/);
  });

  it('rejects a bound migration for another project through the host before creating a fork', async () => {
    const bundle = JSON.parse(
      gunzipSync(
        await readFile(
          join(root, 'test/fixtures/content-diff-v16/no-op-bundle.json.gz'),
        ),
      ).toString('utf8'),
    );
    const migrationsDirectory = join(directory, 'migrations');
    const contentDirectory = join(migrationsDirectory, '.datocms-content');
    await mkdir(contentDirectory, { recursive: true });
    await writeFile(
      join(migrationsDirectory, `${bundle.migrationBasename}.js`),
      bundle.entrypoint,
    );
    await writeFile(
      join(contentDirectory, `${bundle.migrationBasename}.plan.json`),
      bundle.manifest,
    );
    await writeFile(join(contentDirectory, 'runtime-v16.js'), bundle.runtime);

    const result = run([
      'migrations:run',
      '--source=sandbox',
      '--destination=generated',
      '--profile=default',
      `--config-file=${configPath}`,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /project "site-id"/);
    assert.match(result.stderr, /active profile targets "wrong-site"/);
    await assert.rejects(
      readFile(join(directory, 'mutations.log')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  it('retains the primary-environment guard when dispatched by the host', async () => {
    await mkdir(join(directory, 'migrations'));
    const result = run([
      'migrations:run',
      '--source=primary',
      '--in-place',
      '--profile=default',
      `--config-file=${configPath}`,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Running migrations on primary environment is not allowed/,
    );
    await assert.rejects(
      readFile(join(directory, 'mutations.log')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });
});
