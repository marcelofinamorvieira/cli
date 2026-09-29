import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExpectedPackageFiles,
  compareCodeUnits,
  compareInstalledFiles,
  expectedPackageFiles,
  listFiles,
  parsePackJson,
  readTarball,
  sha256,
} from './package-contents.mjs';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const PACKAGED_HOST_MANIFEST_FILENAME =
  'content-diff-packaged-host.json';
export const PACKAGED_HOST_KIND = 'datocms-content-diff-packaged-host';
export const PACKAGED_HOST_FORMAT_VERSION = 1;

/** Every path a packaged host uses, relative to the host directory. */
export const PACKAGED_HOST_LAYOUT = Object.freeze({
  tarballDirectory: 'tarball',
  oclif: Object.freeze({
    dataDir: 'oclif/data',
    configDir: 'oclif/config',
    cacheDir: 'oclif/cache',
  }),
  xdg: Object.freeze({
    dataHome: 'xdg/data',
    configHome: 'xdg/config',
    cacheHome: 'xdg/cache',
  }),
});

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The pack lifecycle packPlugin reproduces, as package.json declares it. */
const PACK_LIFECYCLE = Object.freeze({
  prepack: 'npm run build && oclif manifest && oclif readme',
  postpack: 'rm -f oclif.manifest.json',
});
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const CLI_TIMEOUT_MS = 2 * 60 * 1000;

export function readPackageJson(packageRoot = PACKAGE_ROOT) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

/**
 * The DatoCMS CLI release packaged checks install: the version of the datocms
 * package in this workspace, which is the host the plugin ships alongside.
 */
export function supportedHostVersion(
  packageJson,
  hostPackageJson = readPackageJson(join(PACKAGE_ROOT, '../cli')),
) {
  const version = hostPackageJson?.version;
  if (
    hostPackageJson?.name !== 'datocms' ||
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(version)
  ) {
    throw new Error(
      'the workspace datocms package (packages/cli) must have a released x.y.z version',
    );
  }
  if (typeof packageJson.devDependencies?.datocms !== 'string') {
    throw new Error('package.json devDependencies.datocms is missing');
  }
  return version;
}

/**
 * Digest of the checkout inputs that determine packaged behavior: compiled
 * sources, launchers, package metadata, and compiler settings. The E2E
 * harness recomputes it (test/e2e/real-cma-harness.ts) to refuse a packaged
 * host built from a different checkout. Documentation is deliberately omitted.
 */
export function executableInputsSha256(packageRoot = PACKAGE_ROOT) {
  const paths = [
    ...listFiles(join(packageRoot, 'src'))
      .filter((path) => path.endsWith('.ts'))
      .map((path) => `src/${path}`),
    ...listFiles(join(packageRoot, 'bin')).map((path) => `bin/${path}`),
    'package.json',
    'tsconfig.json',
  ].sort(compareCodeUnits);
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(packageRoot, ...path.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function resolveInside(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(
      `packaged host path ${JSON.stringify(
        relativePath,
      )} must be a relative path inside the host directory`,
    );
  }
  return join(root, ...relativePath.split('/'));
}

/**
 * Environment that points the host CLI at the host's own oclif locations.
 * DATOCMS_* are oclif's scoped overrides for the `datocms` binary; the XDG
 * variables cover every remaining lookup on Linux. Together they keep plugin
 * installation, caches, and configuration away from the user's global CLI.
 */
export function packagedHostEnvironment(hostDirectory, manifest) {
  return {
    DATOCMS_DATA_DIR: resolveInside(hostDirectory, manifest.oclif.dataDir),
    DATOCMS_CONFIG_DIR: resolveInside(hostDirectory, manifest.oclif.configDir),
    DATOCMS_CACHE_DIR: resolveInside(hostDirectory, manifest.oclif.cacheDir),
    XDG_DATA_HOME: resolveInside(hostDirectory, manifest.xdg.dataHome),
    XDG_CONFIG_HOME: resolveInside(hostDirectory, manifest.xdg.configHome),
    XDG_CACHE_HOME: resolveInside(hostDirectory, manifest.xdg.cacheHome),
    DATOCMS_SKIP_NEW_VERSION_CHECK: 'true',
  };
}

const INHERITED_NPM_STATE =
  /^(?:npm_(?:package|lifecycle)_.*|npm_config_(?:prefix|local_prefix|global_prefix|global|location|workspace|workspaces|include_workspace_root)|npm_command|npm_execpath|npm_node_execpath|init_cwd)$/i;
const REDIRECTED_LOCATIONS =
  /^(?:DATOCMS_(?:DATA|CONFIG|CACHE)_DIR|XDG_(?:DATA|CONFIG|CACHE)_HOME)$/;
const DATOCMS_CREDENTIALS = /^DATOCMS_(?:.*_)?(?:API_TOKEN|PROFILE)$/;

/**
 * Child environment for consumer installs and host CLI calls. It drops the
 * parent npm run's package/lifecycle state and prefixes (which could redirect
 * an install), inherited oclif/XDG locations, and DatoCMS credentials, then
 * forces engine-strict installation.
 */
export function isolatedChildEnvironment(
  extra = {},
  environment = process.env,
) {
  const child = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (
      INHERITED_NPM_STATE.test(key) ||
      REDIRECTED_LOCATIONS.test(key) ||
      DATOCMS_CREDENTIALS.test(key)
    ) {
      continue;
    }
    child[key] = value;
  }
  return {
    ...child,
    npm_config_engine_strict: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...extra,
  };
}

/** npm's JavaScript entrypoint, spawned through Node on every platform. */
export function resolveNpmCli(environment = process.env) {
  const execPath = environment.npm_execpath;
  if (execPath && basename(execPath) === 'npm-cli.js') return execPath;
  return resolve(
    dirname(createRequire(import.meta.url).resolve('npm/package.json')),
    'bin/npm-cli.js',
  );
}

function describeFailure(label, result) {
  const output = [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join('\n');
  return `${label} ${
    result.error
      ? `could not start: ${result.error.message}`
      : `exited with ${result.status ?? `signal ${result.signal}`}`
  }${output ? `\n${output}` : ''}`;
}

/** Runs npm; progress goes to stderr so stdout stays machine-readable. */
export function runNpm(
  args,
  { cwd, env = process.env, captureStdout = false },
) {
  const result = spawnSync(process.execPath, [resolveNpmCli(), ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: INSTALL_TIMEOUT_MS,
    stdio: ['ignore', captureStdout ? 'pipe' : 2, 2],
  });
  if (result.error || result.status !== 0) {
    throw new Error(describeFailure(`npm ${args.join(' ')}`, result));
  }
  return result.stdout ?? '';
}

/**
 * Packs the checkout the way `npm pack` does for this package: prepack's
 * clean build and oclif manifest, the tarball written into `destination`,
 * then postpack's cleanup. Prepack's README regeneration is left out, since it
 * only rewrites documentation. The lifecycle steps run on their own so their
 * output cannot corrupt the JSON that `npm pack --json` prints.
 */
export function packPlugin({ packageRoot = PACKAGE_ROOT, destination, log }) {
  const packageJson = readPackageJson(packageRoot);
  for (const [script, command] of Object.entries(PACK_LIFECYCLE)) {
    if (packageJson.scripts?.[script] !== command) {
      throw new Error(
        `package.json's ${script} script is not \`${command}\`; update scripts/packaged-host.mjs so packing mirrors it`,
      );
    }
  }

  const inputsBefore = executableInputsSha256(packageRoot);
  log('Running the prepack steps (clean build and oclif manifest)');
  runNpm(['run', 'build'], { cwd: packageRoot });
  runNpm(['exec', '--', 'oclif', 'manifest'], { cwd: packageRoot });
  log(`Packing ${packageJson.name}@${packageJson.version}`);
  let packed;
  try {
    packed = parsePackJson(
      runNpm(
        [
          'pack',
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          destination,
        ],
        { cwd: packageRoot, captureStdout: true },
      ),
      packageJson,
    );
  } finally {
    rmSync(join(packageRoot, 'oclif.manifest.json'), { force: true });
  }
  if (executableInputsSha256(packageRoot) !== inputsBefore) {
    throw new Error(
      'executable inputs changed while packing; pack again from a quiescent checkout',
    );
  }
  if (!packed.filename) {
    throw new Error('npm pack --json did not report the tarball filename');
  }
  const tarballPath = join(destination, basename(packed.filename));
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack did not write ${tarballPath}`);
  }
  return { tarballPath, executableInputsSha256: inputsBefore };
}

function hostBinRelativePath(hostDirectory) {
  const hostPackage = JSON.parse(
    readFileSync(
      join(hostDirectory, 'node_modules', 'datocms', 'package.json'),
      'utf8',
    ),
  );
  const bin =
    typeof hostPackage.bin === 'string'
      ? hostPackage.bin
      : hostPackage.bin?.datocms;
  if (typeof bin !== 'string' || hostPackage.oclif?.bin !== 'datocms') {
    throw new Error('the installed datocms package does not declare its bin');
  }
  return `node_modules/datocms/${bin.replace(/^\.\//, '')}`;
}

function assertEmptyOrMissingDirectory(directory) {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`${directory} must be missing or empty`);
  }
  mkdirSync(directory, { recursive: true });
}

/**
 * Creates a fresh consumer project with the exact supported DatoCMS CLI and
 * installs the plugin tarball through `datocms plugins:add`, exactly as a
 * user would, with all oclif state inside the host directory. The host
 * manifest is not written here: writePackagedHostManifest() records it only
 * after the caller's installation and routing checks have passed.
 */
export function preparePackagedHost({
  packageRoot = PACKAGE_ROOT,
  hostDirectory,
  tarballPath,
  log = (message) => console.error(`[packaged-host] ${message}`),
}) {
  const packageJson = readPackageJson(packageRoot);
  const hostVersion = supportedHostVersion(packageJson);
  const host =
    hostDirectory ??
    mkdtempSync(join(tmpdir(), 'datocms-content-diff-packaged-host-'));
  assertEmptyOrMissingDirectory(host);
  const tarballDirectory = join(host, PACKAGED_HOST_LAYOUT.tarballDirectory);
  mkdirSync(tarballDirectory);

  const frozenTarball = Boolean(tarballPath);
  let hostTarball;
  let inputsSha256 = null;
  if (frozenTarball) {
    hostTarball = join(tarballDirectory, basename(tarballPath));
    copyFileSync(tarballPath, hostTarball);
    log(`Using frozen tarball ${tarballPath}`);
  } else {
    const packed = packPlugin({
      packageRoot,
      destination: tarballDirectory,
      log,
    });
    hostTarball = packed.tarballPath;
    inputsSha256 = packed.executableInputsSha256;
  }

  const tarballBytes = readFileSync(hostTarball);
  const tarballFiles = readTarball(tarballBytes);
  const packedPackageJson = JSON.parse(
    tarballFiles.get('package.json')?.toString('utf8') ?? 'null',
  );
  if (packedPackageJson?.name !== packageJson.name) {
    throw new Error(
      `the tarball contains ${JSON.stringify(
        packedPackageJson?.name,
      )} instead of ${packageJson.name}`,
    );
  }

  const manifest = {
    kind: PACKAGED_HOST_KIND,
    formatVersion: PACKAGED_HOST_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    node: process.version,
    host: { package: 'datocms', version: hostVersion, bin: '' },
    plugin: {
      name: packedPackageJson.name,
      version: packedPackageJson.version,
      root: `${PACKAGED_HOST_LAYOUT.oclif.dataDir}/node_modules/${packedPackageJson.name}`,
      tarball: `${PACKAGED_HOST_LAYOUT.tarballDirectory}/${basename(
        hostTarball,
      )}`,
      tarballSha256: sha256(tarballBytes),
      fileCount: tarballFiles.size,
      frozenTarball,
      executableInputsSha256: inputsSha256,
    },
    oclif: { ...PACKAGED_HOST_LAYOUT.oclif },
    xdg: { ...PACKAGED_HOST_LAYOUT.xdg },
  };
  for (const relativePath of [
    ...Object.values(manifest.oclif),
    ...Object.values(manifest.xdg),
  ]) {
    mkdirSync(resolveInside(host, relativePath), { recursive: true });
  }

  writeFileSync(
    join(host, 'package.json'),
    `${JSON.stringify(
      {
        name: 'datocms-content-diff-packaged-host',
        version: '0.0.0',
        private: true,
        description:
          'Disposable consumer project for packaged content-diff plugin checks',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(host, '.npmrc'), 'engine-strict=true\n');
  const childEnvironment = isolatedChildEnvironment(
    packagedHostEnvironment(host, manifest),
  );

  log(`Installing datocms@${hostVersion} into ${host} (engine-strict)`);
  runNpm(
    [
      'install',
      '--save-exact',
      '--engine-strict',
      '--no-audit',
      '--no-fund',
      `datocms@${hostVersion}`,
    ],
    { cwd: host, env: childEnvironment },
  );
  manifest.host.bin = hostBinRelativePath(host);

  const packagedHost = {
    hostDirectory: host,
    manifest,
    tarballPath: hostTarball,
    tarballFiles,
    pluginRoot: resolveInside(host, manifest.plugin.root),
    hostBinPath: resolveInside(host, manifest.host.bin),
    environment: childEnvironment,
  };

  log('Adding the plugin tarball with datocms plugins:add');
  // plugins:add runs npm install inside the isolated data directory.
  const added = runHostCli(
    packagedHost,
    ['plugins:add', `file:${resolve(hostTarball)}`],
    { timeout: INSTALL_TIMEOUT_MS },
  );
  if (added.status !== 0) {
    throw new Error(describeFailure('datocms plugins:add', added));
  }

  return packagedHost;
}

/**
 * Records a verified host. The E2E harness accepts a packaged host only
 * through this manifest and requires its non-empty `verifiedChecks`, so call
 * it after every installation and routing check has passed. The manifest is
 * renamed into place, so a failed write never leaves a partial manifest.
 */
export function writePackagedHostManifest(packagedHost, verifiedChecks) {
  if (
    !Array.isArray(verifiedChecks) ||
    verifiedChecks.length === 0 ||
    verifiedChecks.some((title) => typeof title !== 'string' || !title)
  ) {
    throw new Error(
      'a packaged host manifest requires the titles of the checks that passed',
    );
  }
  const manifestPath = join(
    packagedHost.hostDirectory,
    PACKAGED_HOST_MANIFEST_FILENAME,
  );
  const temporaryPath = `${manifestPath}.partial`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        { ...packagedHost.manifest, verifiedChecks: [...verifiedChecks] },
        null,
        2,
      )}\n`,
    );
    renameSync(temporaryPath, manifestPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return manifestPath;
}

/** Runs the host's `datocms` binary with the host's isolated environment. */
export function runHostCli(
  packagedHost,
  args,
  {
    cwd = packagedHost.hostDirectory,
    env = {},
    preload,
    timeout = CLI_TIMEOUT_MS,
  } = {},
) {
  return spawnSync(
    process.execPath,
    [
      ...(preload ? ['--require', preload] : []),
      packagedHost.hostBinPath,
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout,
      env: { ...packagedHost.environment, ...env },
    },
  );
}

// Built from a character code: biome rejects control characters in literals.
const ANSI_STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function normalizeHelpText(text) {
  return text.replace(ANSI_STYLE, '').replace(/\s+/g, ' ').trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function commandFlag(manifestPath, commandId, flagName) {
  const manifest = readJson(manifestPath);
  const description =
    manifest.commands?.[commandId]?.flags?.[flagName]?.description;
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(
      `${manifestPath} does not describe ${commandId} --${flagName}`,
    );
  }
  return normalizeHelpText(description);
}

/**
 * Text that appears in `migrations:run` help only when the host routes the
 * command to this plugin: the plugin's --allow-primary description, which
 * must differ from the core runner's. Returns both texts for assertions.
 */
export function migrationRunRoutingMarkers(packagedHost) {
  const pluginText = commandFlag(
    join(packagedHost.pluginRoot, 'oclif.manifest.json'),
    'migrations:run',
    'allow-primary',
  );
  const coreText = commandFlag(
    join(
      packagedHost.hostDirectory,
      'node_modules',
      'datocms',
      'oclif.manifest.json',
    ),
    'migrations:run',
    'allow-primary',
  );
  if (pluginText === coreText) {
    throw new Error(
      'the plugin and core migrations:run --allow-primary descriptions are identical, so help output cannot prove command routing',
    );
  }
  return { pluginText, coreText };
}

export function assertPluginMigrationRunHelp(output, markers, label) {
  const help = normalizeHelpText(output);
  if (!help.includes(markers.pluginText)) {
    throw new Error(`${label} does not show the plugin migrations:run flags`);
  }
  if (help.includes(markers.coreText)) {
    throw new Error(`${label} still shows the core migrations:run flags`);
  }
}

function assertCliSucceeded(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(describeFailure(label, result));
  }
}

/**
 * Proves the installed host dispatches to the packaged plugin. Each entry is
 * one named check so callers can report exactly what was verified.
 */
export function commandRoutingChecks(packagedHost) {
  return [
    {
      title: `datocms plugins lists ${packagedHost.manifest.plugin.name}@${packagedHost.manifest.plugin.version} as a user plugin`,
      run() {
        const result = runHostCli(packagedHost, ['plugins', '--json']);
        assertCliSucceeded(result, 'datocms plugins --json');
        const plugins = JSON.parse(result.stdout);
        const plugin = Array.isArray(plugins)
          ? plugins.find(
              ({ name }) => name === packagedHost.manifest.plugin.name,
            )
          : undefined;
        if (
          plugin?.type !== 'user' ||
          plugin.version !== packagedHost.manifest.plugin.version
        ) {
          throw new Error(
            `datocms plugins does not list the packaged plugin as a user plugin: ${JSON.stringify(
              plugin ?? null,
            )}`,
          );
        }
      },
    },
    {
      title: 'content:diff --help is served by the plugin with every flag',
      run() {
        const result = runHostCli(packagedHost, ['content:diff', '--help']);
        assertCliSucceeded(result, 'datocms content:diff --help');
        const help = normalizeHelpText(result.stdout);
        const flags = Object.values(
          readJson(join(packagedHost.pluginRoot, 'oclif.manifest.json'))
            .commands?.['content:diff']?.flags ?? {},
        ).filter(({ hidden }) => !hidden);
        if (flags.length === 0) {
          throw new Error('the packaged manifest has no content:diff flags');
        }
        const absent = flags
          .map(({ name }) => `--${name}`)
          .filter((flag) => !help.includes(flag));
        if (absent.length > 0) {
          throw new Error(
            `content:diff --help is missing ${absent.join(', ')}`,
          );
        }
      },
    },
    ...[
      ['migrations:run', '--help'],
      ['help', 'migrations:run'],
    ].map((args) => ({
      title: `datocms ${args.join(
        ' ',
      )} shows the plugin runner (--allow-primary) instead of core`,
      run() {
        const markers = migrationRunRoutingMarkers(packagedHost);
        const result = runHostCli(packagedHost, args);
        assertCliSucceeded(result, `datocms ${args.join(' ')}`);
        assertPluginMigrationRunHelp(
          result.stdout,
          markers,
          `datocms ${args.join(' ')}`,
        );
      },
    })),
  ];
}

/** Checks that the plugin installation itself matches the tarball. */
export function installationChecks(
  packagedHost,
  { packageRoot = PACKAGE_ROOT } = {},
) {
  const { manifest, tarballFiles } = packagedHost;
  return [
    {
      title: 'the tarball contains exactly the expected release files',
      run() {
        assertExpectedPackageFiles(
          [...tarballFiles.keys()],
          expectedPackageFiles(packageRoot),
          'The tarball',
        );
      },
    },
    {
      title:
        'the packaged oclif manifest declares exactly the plugin commands at the packaged version',
      run() {
        const packedManifest = JSON.parse(
          tarballFiles.get('oclif.manifest.json')?.toString('utf8') ?? 'null',
        );
        const commands = Object.keys(packedManifest?.commands ?? {}).sort(
          compareCodeUnits,
        );
        const expected = ['content:diff', 'migrations:new', 'migrations:run'];
        if (
          packedManifest?.version !== manifest.plugin.version ||
          JSON.stringify(commands) !== JSON.stringify(expected)
        ) {
          throw new Error(
            `the packaged oclif manifest is stale: version ${JSON.stringify(
              packedManifest?.version,
            )}, commands ${commands.join(', ')}`,
          );
        }
      },
    },
    {
      title: `the fresh consumer resolved exactly datocms@${manifest.host.version} with engine-strict installation`,
      run() {
        const consumer = readJson(
          join(packagedHost.hostDirectory, 'package.json'),
        );
        const installed = readJson(
          join(
            packagedHost.hostDirectory,
            'node_modules',
            'datocms',
            'package.json',
          ),
        );
        if (
          consumer.dependencies?.datocms !== manifest.host.version ||
          installed.version !== manifest.host.version
        ) {
          throw new Error(
            `the consumer depends on ${JSON.stringify(
              consumer.dependencies?.datocms,
            )} and installed ${JSON.stringify(installed.version)}`,
          );
        }
        if (
          packagedHost.environment.npm_config_engine_strict !== 'true' ||
          !readFileSync(join(packagedHost.hostDirectory, '.npmrc'), 'utf8')
            .split(/\r?\n/)
            .includes('engine-strict=true')
        ) {
          throw new Error('the consumer is not configured for engine-strict');
        }
      },
    },
    {
      title: `all ${tarballFiles.size} installed plugin files are byte-identical to the tarball`,
      run() {
        const differences = compareInstalledFiles(
          tarballFiles,
          packagedHost.pluginRoot,
        );
        if (differences.length > 0) {
          throw new Error(
            `the installed plugin differs from its tarball:\n${differences.join(
              '\n',
            )}`,
          );
        }
      },
    },
  ];
}

/**
 * Runs checks in order and stops at the first failure. Returns the number of
 * checks that passed.
 */
export function runChecks(checks, { label, offset = 0, log = console.error }) {
  let index = offset;
  for (const check of checks) {
    index += 1;
    try {
      check.run();
    } catch (error) {
      log(`[${label}] not ok ${index} - ${check.title}`);
      throw error;
    }
    log(`[${label}] ok ${index} - ${check.title}`);
  }
  return index;
}
