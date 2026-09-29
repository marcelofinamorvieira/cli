import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

type PackageContents = {
  FIXED_PACKAGE_FILES: readonly string[];
  expectedPackageFiles(root: string): string[];
  diffPackageFiles(
    actual: readonly string[],
    expected: readonly string[],
  ): { missing: string[]; unexpected: string[]; duplicates: string[] };
  assertExpectedPackageFiles(
    actual: readonly string[],
    expected: readonly string[],
    label: string,
  ): void;
  parsePackJson(
    stdout: string,
    pkg: { name: string; version: string },
  ): { filename?: string; files: string[] };
  readTarball(bytes: Buffer): Map<string, Buffer>;
  compareInstalledFiles(files: Map<string, Buffer>, root: string): string[];
  credentialValues(
    environment: NodeJS.ProcessEnv,
  ): Array<{ name: string; bytes: Buffer }>;
  findCredentialMatches(
    files: Iterable<[string, Buffer]>,
    secrets: Array<{ name: string; bytes: Buffer }>,
  ): string[];
  repositoryFiles(root: string): string[];
};

type PackagedHost = {
  executableInputsSha256(root: string): string;
  isolatedChildEnvironment(
    extra?: Record<string, string>,
    environment?: NodeJS.ProcessEnv,
  ): Record<string, string>;
  resolveNpmCli(environment: NodeJS.ProcessEnv): string;
  resolveInside(root: string, path: string): string;
  supportedHostVersion(
    pkg: Record<string, unknown>,
    hostPkg?: Record<string, unknown>,
  ): string;
  normalizeHelpText(text: string): string;
  migrationRunRoutingMarkers(host: {
    pluginRoot: string;
    hostDirectory: string;
  }): { pluginText: string; coreText: string };
  assertPluginMigrationRunHelp(
    output: string,
    markers: { pluginText: string; coreText: string },
    label: string,
  ): void;
  runChecks(
    checks: Array<{ title: string; run(): void }>,
    options: { label: string; log(message: string): void },
  ): number;
};

async function importScript<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(resolve('scripts', name)).href)) as T;
}

/** Minimal independent ustar writer for tarball-reader tests. */
function tarEntry(path: string, contents: string | Buffer, type = '0'): Buffer {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return tarEntry('PaxHeader', `${length}${body}`, 'x');
}

function tarball(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

describe('release package contents helpers', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-diff-package-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeTree(root: string, files: Record<string, string>) {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
  }

  it('derives one JavaScript and one declaration file per source plus the fixed release files', async () => {
    const contents = await importScript<PackageContents>(
      'package-contents.mjs',
    );
    await writeTree(directory, {
      'src/index.ts': '',
      'src/commands/content/diff.ts': '',
      'src/types.d.ts': '',
    });

    assert.deepEqual(contents.expectedPackageFiles(directory), [
      'README.md',
      'lib/commands/content/diff.d.ts',
      'lib/commands/content/diff.js',
      'lib/index.d.ts',
      'lib/index.js',
      'oclif.manifest.json',
      'package.json',
    ]);
    await rm(join(directory, 'src'), { recursive: true });
    await mkdir(join(directory, 'src'));
    assert.throws(
      () => contents.expectedPackageFiles(directory),
      /no TypeScript sources/,
    );
  });

  it("matches npm's own packing rules for this package.json on a representative checkout", async () => {
    const contents = await importScript<PackageContents>(
      'package-contents.mjs',
    );
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    await writeTree(directory, {
      'package.json': JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        files: pkg.files,
        main: pkg.main,
      }),
      'README.md': '',
      'docs/media/walkthrough.gif': '',
      '.env': 'DATOCMS_API_TOKEN=local-only',
      '.env.local': '',
      'oclif.manifest.json': '{}',
      'tsconfig.json': '{}',
      'tsconfig.tsbuildinfo': '',
      'bin/dev': '',
      'bin/dev.cmd': '',
      'bin/run': '',
      'bin/run.cmd': '',
      'src/index.ts': '',
      'src/utils/nested.ts': '',
      'lib/index.js': '',
      'lib/index.d.ts': '',
      'lib/utils/nested.js': '',
      'lib/utils/nested.d.ts': '',
      'scripts/package-check.mjs': '',
      'test/package-scripts.test.ts': '',
      'migrations/.datocms-content/1700000000_x.plan.json': '{}',
      'package-lock.json': '{}',
    });
    const npmRequire = createRequire(require.resolve('npm/package.json'));
    const Arborist = npmRequire('@npmcli/arborist');
    const packlist = npmRequire('npm-packlist');
    const tree = await new Arborist({ path: directory }).loadActual();
    const packed: string[] = await packlist(tree);

    contents.assertExpectedPackageFiles(
      packed,
      contents.expectedPackageFiles(directory),
      'npm-packlist',
    );
  });

  it('reports missing, unexpected, and duplicated files', async () => {
    const contents = await importScript<PackageContents>(
      'package-contents.mjs',
    );
    assert.deepEqual(
      contents.diffPackageFiles(['a', 'c', 'c', 'd'], ['a', 'b', 'c']),
      { missing: ['b'], unexpected: ['d'], duplicates: ['c'] },
    );
    assert.throws(
      () => contents.assertExpectedPackageFiles(['a', 'c'], ['a', 'b'], 'X'),
      /X does not contain exactly the expected 2 release files \(1 missing, 1 unexpected, 0 duplicated\):\n- missing {4}b\n\+ unexpected c/,
    );
  });

  it('reads npm tarballs, including pax paths, and rejects unsafe or corrupt archives', async () => {
    const contents = await importScript<PackageContents>(
      'package-contents.mjs',
    );
    const longPath = `package/lib/${'nested/'.repeat(20)}file.js`;
    const files = contents.readTarball(
      tarball(
        tarEntry('package/', '', '5'),
        tarEntry('package/package.json', '{}'),
        paxPath(longPath),
        tarEntry('ignored-short-name', 'long'),
        tarEntry('package/bin/run', Buffer.alloc(700, 1)),
      ),
    );
    assert.deepEqual(
      [...files.keys()],
      ['bin/run', longPath.slice('package/'.length), 'package.json'],
    );
    assert.equal(files.get('bin/run')?.length, 700);

    const corrupt = tarEntry('package/a', 'x');
    corrupt[0] ^= 1;
    for (const [archive, message] of [
      [tarball(tarEntry('other/a', 'x')), /outside the package\/ root/],
      [tarball(tarEntry('package/../escape', 'x')), /unsafe path/],
      [tarball(tarEntry('package/link', '', '2')), /unsupported type "2"/],
      [
        tarball(tarEntry('package/a', 'x'), tarEntry('package/a', 'y')),
        /appears more than once/,
      ],
      [tarball(corrupt), /invalid checksum/],
      [
        gzipSync(tarEntry('package/a', 'truncated').subarray(0, 520)),
        /truncated/,
      ],
    ] as const) {
      assert.throws(() => contents.readTarball(archive), message);
    }
  });

  it('compares installed files with tarball entries byte for byte, ignoring dependency folders', async () => {
    const contents = await importScript<PackageContents>(
      'package-contents.mjs',
    );
    const files = new Map([
      ['package.json', Buffer.from('{}')],
      ['lib/index.js', Buffer.from('exports.x = 1;')],
    ]);
    await writeTree(directory, {
      'package.json': '{}',
      'lib/index.js': 'exports.x = 1;',
      'node_modules/dependency/index.js': '',
      'node_modules/dependency/node_modules/nested/index.js': '',
    });
    // npm links nested dependency binaries; the walk must not enter them.
    await mkdir(join(directory, 'node_modules', '.bin'));
    await symlink(
      '../dependency/index.js',
      join(directory, 'node_modules', '.bin', 'dependency'),
    );
    assert.deepEqual(contents.compareInstalledFiles(files, directory), []);

    // A link inside the package itself still fails closed.
    await symlink('index.js', join(directory, 'lib', 'linked.js'));
    assert.throws(
      () => contents.compareInstalledFiles(files, directory),
      /lib\/linked\.js is not a regular file/,
    );
    await rm(join(directory, 'lib', 'linked.js'));

    await writeTree(directory, {
      'lib/index.js': 'exports.x = 2;',
      'lib/extra.js': '',
    });
    await rm(join(directory, 'package.json'));
    assert.deepEqual(contents.compareInstalledFiles(files, directory), [
      'missing from installation: package.json',
      'not in tarball: lib/extra.js',
      'content differs: lib/index.js',
    ]);
  });
});

describe('package credential scan helpers', () => {
  it('scans packaged or repository bytes for every supplied DatoCMS API token without echoing it', async () => {
    const contents = await importScript<PackageContents>(
      'package-contents.mjs',
    );
    const secrets = contents.credentialValues({
      DATOCMS_API_TOKEN: 'primary-token-value',
      DATOCMS_CONTENT_DIFF_E2E_SOURCE_API_TOKEN: 'source-token-value',
      DATOCMS_CONTENT_DIFF_E2E_DESTINATION_API_TOKEN: 'short',
      DATOCMS_PROFILE: 'profile-name-value',
      OTHER_API_TOKEN: 'unrelated-token-value',
    });
    assert.deepEqual(
      secrets.map(({ name }) => name),
      ['DATOCMS_API_TOKEN', 'DATOCMS_CONTENT_DIFF_E2E_SOURCE_API_TOKEN'],
    );

    const matches = contents.findCredentialMatches(
      [
        ['lib/clean.js', Buffer.from('exports.clean = true;')],
        ['README.md', Buffer.from('token: source-token-value')],
        ['test/fixture.json', Buffer.from('"primary-token-value"')],
      ],
      secrets,
    );
    assert.deepEqual(matches, [
      'README.md contains the value of DATOCMS_CONTENT_DIFF_E2E_SOURCE_API_TOKEN',
      'test/fixture.json contains the value of DATOCMS_API_TOKEN',
    ]);
    assert.doesNotMatch(matches.join('\n'), /token-value/);
  });

  it('lists tracked and untracked repository files but never ignored dependencies', async () => {
    const contents = await importScript<PackageContents>(
      'package-contents.mjs',
    );
    const files = contents.repositoryFiles(resolve('.'));
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('scripts/package-check.mjs'));
    assert.ok(files.every((path) => !path.startsWith('node_modules/')));
    assert.deepEqual(files, [...files].sort());
    assert.throws(
      () => contents.repositoryFiles(join(tmpdir(), 'missing-checkout')),
      /git ls-files could not list the repository files/,
    );
  });
});

describe('packaged host helpers', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-diff-packaged-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('isolates consumer installs from npm run state, oclif locations, and DatoCMS credentials', async () => {
    const host = await importScript<PackagedHost>('packaged-host.mjs');
    const child = host.isolatedChildEnvironment(
      { DATOCMS_DATA_DIR: '/host/oclif/data' },
      {
        PATH: '/usr/bin',
        HOME: '/home/user',
        npm_config_registry: 'https://registry.example/',
        npm_config_prefix: '/global/prefix',
        npm_config_local_prefix: '/repository',
        npm_package_name: 'plugin',
        npm_lifecycle_event: 'package:check',
        INIT_CWD: '/repository',
        DATOCMS_API_TOKEN: 'secret',
        DATOCMS_CONTENT_DIFF_E2E_SOURCE_API_TOKEN: 'secret',
        DATOCMS_PROFILE: 'production',
        DATOCMS_DATA_DIR: '/home/user/.local/share/datocms',
        XDG_CONFIG_HOME: '/home/user/.config',
      },
    );

    assert.deepEqual(child, {
      PATH: '/usr/bin',
      HOME: '/home/user',
      npm_config_registry: 'https://registry.example/',
      npm_config_engine_strict: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      DATOCMS_DATA_DIR: '/host/oclif/data',
    });
  });

  it("spawns npm's JavaScript entrypoint and installs the workspace host version", async () => {
    const host = await importScript<PackagedHost>('packaged-host.mjs');
    const npmCli = join(directory, 'npm dist', 'bin', 'npm-cli.js');
    assert.equal(host.resolveNpmCli({ npm_execpath: npmCli }), npmCli);
    for (const environment of [{}, { npm_execpath: '/usr/lib/yarn.js' }]) {
      assert.match(
        host.resolveNpmCli(environment),
        /[/\\]npm[/\\]bin[/\\]npm-cli\.js$/,
      );
    }
    const plugin = { devDependencies: { datocms: '^4.2.0' } };
    assert.equal(
      host.supportedHostVersion(plugin, { name: 'datocms', version: '4.2.0' }),
      '4.2.0',
    );
    assert.equal(
      host.supportedHostVersion(plugin),
      JSON.parse(readFileSync(resolve('../cli/package.json'), 'utf8')).version,
    );
    for (const hostPackage of [
      { name: 'datocms', version: '4.3.0-next.0' },
      { name: 'datocms' },
      { name: 'other', version: '4.2.0' },
    ]) {
      assert.throws(
        () => host.supportedHostVersion(plugin, hostPackage),
        /released x\.y\.z version/,
      );
    }
    assert.throws(
      () =>
        host.supportedHostVersion(
          { devDependencies: {} },
          { name: 'datocms', version: '4.2.0' },
        ),
      /devDependencies\.datocms is missing/,
    );
    assert.equal(
      host.resolveInside(directory, 'oclif/data'),
      join(directory, 'oclif', 'data'),
    );
    for (const path of ['../x', '/abs', 'a//b', 'a\\b', '']) {
      assert.throws(() => host.resolveInside(directory, path), /inside/);
    }
  });

  it('proves migrations:run routing from manifest texts and rejects indistinguishable ones', async () => {
    const host = await importScript<PackagedHost>('packaged-host.mjs');
    const pluginRoot = join(directory, 'plugin');
    const hostDirectory = join(directory, 'host');
    const manifest = (description: string) =>
      JSON.stringify({
        commands: {
          'migrations:run': {
            flags: { 'allow-primary': { description } },
          },
        },
      });
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(join(hostDirectory, 'node_modules', 'datocms'), {
      recursive: true,
    });
    await writeFile(
      join(pluginRoot, 'oclif.manifest.json'),
      manifest('Allow running reviewed migrations in place'),
    );
    await writeFile(
      join(hostDirectory, 'node_modules', 'datocms', 'oclif.manifest.json'),
      manifest('Only use for strictly additive migrations'),
    );
    const markers = host.migrationRunRoutingMarkers({
      pluginRoot,
      hostDirectory,
    });

    host.assertPluginMigrationRunHelp(
      '\u001b[1mFLAGS\u001b[22m\n  --allow-primary  Allow running reviewed\n                   migrations in place',
      markers,
      'help',
    );
    assert.throws(
      () =>
        host.assertPluginMigrationRunHelp(
          '--allow-primary Only use for strictly additive migrations',
          markers,
          'core help',
        ),
      /does not show the plugin migrations:run flags/,
    );
    assert.throws(
      () =>
        host.assertPluginMigrationRunHelp(
          'Allow running reviewed migrations in place / Only use for strictly additive migrations',
          markers,
          'mixed help',
        ),
      /still shows the core/,
    );

    await writeFile(
      join(pluginRoot, 'oclif.manifest.json'),
      manifest('Only use for strictly additive migrations'),
    );
    assert.throws(
      () => host.migrationRunRoutingMarkers({ pluginRoot, hostDirectory }),
      /cannot prove command routing/,
    );
  });

  it('numbers checks and stops at the first failure', async () => {
    const host = await importScript<PackagedHost>('packaged-host.mjs');
    const log: string[] = [];
    const ran: string[] = [];
    assert.throws(
      () =>
        host.runChecks(
          [
            { title: 'first', run: () => ran.push('first') },
            {
              title: 'second',
              run() {
                throw new Error('second failed');
              },
            },
            { title: 'third', run: () => ran.push('third') },
          ],
          { label: 'probe', log: (message) => log.push(message) },
        ),
      /second failed/,
    );
    assert.deepEqual(ran, ['first']);
    assert.deepEqual(log, [
      '[probe] ok 1 - first',
      '[probe] not ok 2 - second',
    ]);
  });

  for (const script of ['prepare-packaged-host.mjs', 'package-check.mjs']) {
    it(`${script} documents itself and rejects invalid options without installing anything`, () => {
      const run = (args: string[]) =>
        spawnSync(process.execPath, [resolve('scripts', script), ...args], {
          cwd: directory,
          encoding: 'utf8',
        });
      const help = run(['--help']);
      assert.equal(help.status, 0, help.stderr);
      const hostVersion = JSON.parse(
        readFileSync(resolve('../cli/package.json'), 'utf8'),
      ).version as string;
      assert.ok(help.stdout.includes(`datocms@${hostVersion}`), help.stdout);
      assert.match(help.stdout, /plugins:add/);
      assert.equal(help.stderr, '');

      for (const args of [['--unknown'], ['--tarball']]) {
        const invalid = run(args);
        assert.equal(invalid.status, 2, invalid.stderr);
        assert.match(invalid.stderr, /Unknown option|requires a path/);
      }
    });
  }
});

describe('build-time shared runtime check', () => {
  type RuntimeSharedScripts = {
    renderGeneratedModule(root: string): string;
    isGeneratedModuleCurrent(root: string): boolean;
    validateAssembly(root: string): string[];
  };
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'datocms-runtime-crlf-'));
    for (const path of [
      'package.json',
      'src/content-diff/shared',
      'src/content-diff/generated',
      'src/content-diff/runtime-template.ts',
    ]) {
      await cp(resolve(path), join(directory, path), { recursive: true });
    }
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts shared modules checked out with CRLF line endings and renders identical bytes', async () => {
    const scripts =
      await importScript<RuntimeSharedScripts>('runtime-shared.mjs');
    const sharedDirectory = join(directory, 'src/content-diff/shared');
    const modules = readdirSync(sharedDirectory).filter((name) =>
      name.endsWith('.ts'),
    );
    assert.ok(modules.length > 0);
    for (const name of modules) {
      const path = join(sharedDirectory, name);
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace(/\n/g, '\r\n'),
      );
    }

    assert.deepEqual(scripts.validateAssembly(directory), []);
    assert.equal(scripts.isGeneratedModuleCurrent(directory), true);
    assert.equal(
      scripts.renderGeneratedModule(directory),
      scripts.renderGeneratedModule(resolve('.')),
    );
  });

  it('still rejects a bare carriage return in a shared module', async () => {
    const scripts =
      await importScript<RuntimeSharedScripts>('runtime-shared.mjs');
    const path = join(directory, 'src/content-diff/shared/canonicalize.ts');
    await writeFile(path, `${await readFile(path, 'utf8')}// a\rb\n`);

    assert.ok(
      scripts
        .validateAssembly(directory)
        .some((diagnostic) =>
          diagnostic.includes(
            'contains a carriage return that is not part of a CRLF line ending',
          ),
        ),
    );
  });
});

describe('package check behavior checks', () => {
  type BehaviorCheck = { title: string; run(): void };
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'datocms-package-behavior-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // package:check runs these against the packed plugin; running them against
  // the checkout through bin/dev keeps its mocked CMA and expectations in step
  // with the runner.
  it('pass against the checkout with the mocked CMA', async function () {
    this.timeout(600_000);
    const { behaviorChecks } = await importScript<{
      behaviorChecks(
        host: Record<string, unknown>,
        scratch: string,
      ): BehaviorCheck[];
    }>('package-check.mjs');
    const { isolatedChildEnvironment } = await importScript<{
      isolatedChildEnvironment(
        extra: Record<string, string>,
      ): Record<string, string>;
    }>('packaged-host.mjs');
    // Like bin/dev: an explicit root, because the mocked CMA preload loads
    // @oclif/core before any main module exists, so oclif cannot find the
    // root through require.main; and no manifest, so a generated
    // oclif.manifest.json cannot point the commands at a stale lib/ build.
    // Unlike bin/dev, oclif's debug output stays off, as in a packaged host.
    const hostBinPath = join(directory, 'dev-host.cjs');
    await writeFile(
      hostBinPath,
      [
        "'use strict';",
        "const { createRequire } = require('node:module');",
        "const { join } = require('node:path');",
        `const root = ${JSON.stringify(resolve('.'))};`,
        "const pluginRequire = createRequire(join(root, 'package.json'));",
        "const oclif = pluginRequire('@oclif/core');",
        "process.env.NODE_ENV = 'development';",
        "pluginRequire('ts-node').register({ project: join(root, 'tsconfig.json') });",
        'const plugin = new oclif.Plugin({ root, isRoot: true, ignoreManifest: true });',
        'plugin',
        '  .load()',
        '  .then(() => oclif.run(process.argv.slice(2), { root, plugins: new Map([[plugin.name, plugin]]) }))',
        '  .then(() => oclif.flush())',
        '  .catch(oclif.Errors.handle);',
        '',
      ].join('\n'),
    );
    const host = {
      pluginRoot: resolve('.'),
      hostBinPath,
      hostDirectory: directory,
      environment: isolatedChildEnvironment({
        DATOCMS_SKIP_NEW_VERSION_CHECK: 'true',
        TS_NODE_TRANSPILE_ONLY: 'true',
        XDG_CACHE_HOME: join(directory, 'xdg-cache'),
        XDG_CONFIG_HOME: join(directory, 'xdg-config'),
        XDG_DATA_HOME: join(directory, 'xdg-data'),
      }),
    };
    // The installed client stack and the packaged launcher only exist in a
    // packed install.
    const checks = behaviorChecks(host, directory).filter(
      ({ title }) => !/client stack|packaged launcher/.test(title),
    );

    assert.deepEqual(
      checks.map(({ title }) => title),
      [
        'migrations:new dispatches to the plugin command',
        'migrations:run dispatches to the plugin runner (reserved ledger model)',
        'the primary-environment guard refuses an in-place primary run',
        'the destination binding refuses a migration bound to another project before forking',
        'a JavaScript migration runs in a new fork with the execution context and is tracked',
        'a TypeScript migration resolves a tsconfig path alias through the packaged loader',
        'migration history makes a second run replay nothing and create no fork',
      ],
    );
    for (const check of checks) {
      try {
        check.run();
      } catch (error) {
        throw new Error(
          `${check.title}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  });
});
