import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  credentialValues,
  findCredentialMatches,
  repositoryFiles,
} from './package-contents.mjs';
import {
  PACKAGE_ROOT,
  commandRoutingChecks,
  installationChecks,
  preparePackagedHost,
  readPackageJson,
  runChecks,
  runHostCli,
  supportedHostVersion,
} from './packaged-host.mjs';

const LABEL = 'package-check';
const MOCK_SITE_ID = 'package-check-site';
/** Same ID and name prefix as src/utils/migrations-run-lock.ts. */
const RUN_LOCK_RECORD_ID = 'pV2V96fXSDyPgWYeu6p3jw';
const RUN_LOCK_NAME_PREFIX = 'datocms-migrations-run-lock ';

function parseArguments(argv) {
  const options = { help: false, keep: false, tarball: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '--keep') {
      options[argument.slice(2)] = true;
      continue;
    }
    const match = /^--tarball(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`Unknown option: ${argument}`);
    const value = match[1] ?? argv[++index];
    if (!value) throw new Error('--tarball requires a path');
    options.tarball = resolve(value);
  }
  return options;
}

function usage() {
  const hostVersion = supportedHostVersion(readPackageJson());
  return `Usage: npm run package:check -- [--tarball <file.tgz>] [--keep]

Packs the checkout (or uses a frozen --tarball), installs it into a fresh
engine-strict consumer with exact datocms@${hostVersion} through
"datocms plugins:add", and checks, in order:

  - the tarball holds exactly the expected release files and a current manifest
  - the consumer resolved the exact host release with engine-strict installation
  - every installed plugin file is byte-identical to the tarball
  - the plugin's @datocms client stack resolves on the major versions the
    workspace package-lock.json tests
  - the host routes content:diff and migrations:run help to the plugin
  - migrations:new and migrations:run dispatch to the plugin implementations
  - JavaScript and TypeScript (tsconfig path alias) migrations run in a fork
    with the execution context and are tracked in migration history
  - a second run replays nothing, and the primary and project-binding guards
    refuse before any CMA mutation
  - the packaged launcher preserves oclif exit codes
  - no DatoCMS API token from this environment appears in any packaged file
    or in any tracked or untracked (not ignored) repository file (only when
    such a token is set)

CMA calls are served by an in-process mock; no DatoCMS project is contacted.
All oclif state stays in a temporary host removed afterwards unless --keep.
Run it once per supported Node.js runtime.`;
}

/**
 * Mocked CMA for the packaged runner. It replaces the plugin's own
 * CmaClientCommand.buildClient, persists state between CLI processes, and
 * logs every mutation so guards can prove that nothing was written. The
 * migrations:run signal tests load it into bin/dev as well.
 */
export const MOCK_CMA_PRELOAD = `'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const pluginRequire = createRequire(join(process.env.PACKAGE_CHECK_PLUGIN_ROOT, 'package.json'));
const { CmaClient, CmaClientCommand } = pluginRequire('@datocms/cli-utils');
const statePath = process.env.PACKAGE_CHECK_CMA_STATE;
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const notFound = (url) => new CmaClient.ApiError({
  request: { url, method: 'GET', headers: {} },
  response: { status: 404, statusText: 'Not Found', headers: {} },
});
const idTaken = (url) => new CmaClient.ApiError({
  request: { url, method: 'POST', headers: {} },
  response: { status: 422, statusText: 'Unprocessable Entity', headers: {} },
});
// The CMA returns relationships as { type, id }; state keeps plain IDs.
const itemResource = (item) => ({ ...item, item_type: { type: 'item_type', id: item.item_type } });
const mutate = (event, change) => {
  const state = load();
  state.mutations.push(event);
  const result = change(state);
  save(state);
  return result;
};
function contents(state, environmentId) {
  const environmentContents = state.contents[environmentId];
  if (!environmentContents) throw notFound('/environments/' + environmentId);
  return environmentContents;
}
function client(environmentId) {
  return {
    packageCheckEnvironment: environmentId,
    site: { find: async () => ({ id: load().siteId }) },
    environments: {
      list: async () => load().environments,
      find: async (id) => {
        const environment = load().environments.find((candidate) => candidate.id === id);
        if (!environment) throw notFound('/environments/' + id);
        return environment;
      },
      fork: async (sourceId, body) => mutate({ type: 'fork', sourceId, destinationId: body.id }, (state) => {
        const environment = { id: body.id, type: 'environment', meta: { primary: false, status: 'ready', forked_from: sourceId } };
        state.environments.push(environment);
        state.contents[body.id] = JSON.parse(JSON.stringify(contents(state, sourceId)));
        return environment;
      }),
    },
    itemTypes: {
      find: async (idOrApiKey) => {
        const model = contents(load(), environmentId).itemTypes.find(({ id, api_key }) => id === idOrApiKey || api_key === idOrApiKey);
        if (!model) throw notFound('/item-types/' + idOrApiKey);
        return model;
      },
      create: async (body) => mutate({ type: 'createModel', environmentId, apiKey: body.api_key }, (state) => {
        const target = contents(state, environmentId);
        const model = {
          id: 'model-' + (target.itemTypes.length + 1),
          type: 'item_type',
          name: body.name,
          api_key: body.api_key,
          modular_block: false,
          singleton: false,
          sortable: false,
          tree: false,
          draft_mode_active: Boolean(body.draft_mode_active),
          draft_saving_active: false,
          all_locales_required: false,
          workflow: null,
        };
        target.itemTypes.push(model);
        return model;
      }),
    },
    fields: {
      list: async (modelId) => contents(load(), environmentId).fields.filter((field) => field.item_type === modelId),
      create: async (modelId, body) => mutate({ type: 'createField', environmentId, modelId, apiKey: body.api_key }, (state) => {
        const target = contents(state, environmentId);
        const field = {
          id: 'field-' + (target.fields.length + 1),
          type: 'field',
          item_type: modelId,
          label: body.label,
          api_key: body.api_key,
          field_type: body.field_type,
          localized: false,
          default_value: null,
          validators: body.validators || {},
        };
        target.fields.push(field);
        return field;
      }),
    },
    items: {
      listPagedIterator: async function* ({ filter }) {
        for (const item of contents(load(), environmentId).items) {
          if (item.item_type === filter.type) yield itemResource(item);
        }
      },
      find: async (id) => {
        const item = contents(load(), environmentId).items.find((candidate) => candidate.id === id);
        if (!item) throw notFound('/items/' + id);
        return itemResource(item);
      },
      create: async (body) => {
        const target = contents(load(), environmentId);
        if (body.id !== undefined && target.items.some((item) => item.id === body.id)) {
          throw idTaken('/items');
        }
        return mutate({ type: 'createRecord', environmentId, name: body.name }, (state) => {
          const items = contents(state, environmentId).items;
          const item = { id: body.id ?? 'record-' + (items.length + 1), type: 'item', item_type: body.item_type.id, name: body.name };
          items.push(item);
          return itemResource(item);
        });
      },
      destroy: async (id) => {
        if (!contents(load(), environmentId).items.some((item) => item.id === id)) {
          throw notFound('/items/' + id);
        }
        return mutate({ type: 'destroyRecord', environmentId, id }, (state) => {
          const target = contents(state, environmentId);
          const item = target.items.find((candidate) => candidate.id === id);
          target.items = target.items.filter((candidate) => candidate.id !== id);
          return itemResource(item);
        });
      },
    },
  };
}
CmaClientCommand.prototype.buildClient = async function (config = {}) {
  const state = load();
  return client(config.environment || state.environments.find(({ meta }) => meta.primary).id);
};
`;

const JS_MIGRATION = `'use strict';
const { appendFileSync } = require('node:fs');

module.exports = async function packagedJavaScriptMigration(client, context) {
  appendFileSync(
    process.env.PACKAGE_CHECK_MARKERS,
    JSON.stringify({
      script: 'js',
      environment: client.packageCheckEnvironment,
      context: { ...context, abortSignal: context.abortSignal instanceof AbortSignal },
    }) + '\\n',
  );
};
`;

const TS_MIGRATION = `import { appendFileSync } from 'node:fs';
import { aliasMarker } from '@package-check/alias-target';

type ExecutionContext = Readonly<{
  environmentId: string;
  inPlace: boolean;
  allowPrimary: boolean;
  contentDiffProtocolVersion: number;
  abortSignal?: AbortSignal;
}>;

export default async function packagedTypeScriptMigration(
  client: { packageCheckEnvironment: string },
  context: ExecutionContext,
): Promise<void> {
  appendFileSync(
    process.env.PACKAGE_CHECK_MARKERS as string,
    \`\${JSON.stringify({
      script: 'ts',
      environment: client.packageCheckEnvironment,
      context: {
        ...context,
        abortSignal: context.abortSignal instanceof AbortSignal,
      },
      aliasMarker,
    })}\\n\`,
  );
}
`;

const ALIAS_MARKER = 'resolved through tsconfig paths';

function initialCmaState() {
  return {
    siteId: MOCK_SITE_ID,
    mutations: [],
    environments: [
      {
        id: 'main',
        type: 'environment',
        meta: { primary: true, status: 'ready', forked_from: null },
      },
    ],
    contents: { main: { itemTypes: [], fields: [], items: [] } },
  };
}

function writeWorkspace(directory) {
  mkdirSync(join(directory, 'migrations'), { recursive: true });
  mkdirSync(join(directory, 'support'), { recursive: true });
  writeFileSync(
    join(directory, 'datocms.config.json'),
    `${JSON.stringify(
      {
        profiles: {
          default: {
            migrations: {
              directory: 'migrations',
              modelApiKey: 'schema_migration',
              tsconfig: 'tsconfig.json',
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@package-check/*': ['support/*'] },
          module: 'commonjs',
          target: 'es2022',
          strict: true,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(directory, 'support', 'alias-target.ts'),
    `export const aliasMarker: string = ${JSON.stringify(ALIAS_MARKER)};\n`,
  );
  writeFileSync(
    join(directory, 'migrations', '1700000001_packaged_js.js'),
    JS_MIGRATION,
  );
  writeFileSync(
    join(directory, 'migrations', '1700000002_packaged_ts.ts'),
    TS_MIGRATION,
  );
}

function writeBoundWorkspace(directory) {
  const bundle = JSON.parse(
    gunzipSync(
      readFileSync(
        join(
          PACKAGE_ROOT,
          'test/fixtures/content-diff-v16/no-op-bundle.json.gz',
        ),
      ),
    ).toString('utf8'),
  );
  const contentDirectory = join(directory, 'migrations', '.datocms-content');
  mkdirSync(contentDirectory, { recursive: true });
  writeFileSync(
    join(directory, 'datocms.config.json'),
    `${JSON.stringify({
      profiles: { default: { migrations: { directory: 'migrations' } } },
    })}\n`,
  );
  writeFileSync(
    join(directory, 'migrations', `${bundle.migrationBasename}.js`),
    bundle.entrypoint,
  );
  writeFileSync(
    join(contentDirectory, `${bundle.migrationBasename}.plan.json`),
    bundle.manifest,
  );
  writeFileSync(join(contentDirectory, 'runtime-v16.js'), bundle.runtime);
  return JSON.parse(bundle.manifest).plan.target.siteId;
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ');
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function findInstalledPackage(fromDirectory, name, stopDirectory) {
  let directory = fromDirectory;
  for (;;) {
    const candidate = join(directory, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) {
      return JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
    }
    if (directory === stopDirectory || dirname(directory) === directory) {
      return undefined;
    }
    directory = dirname(directory);
  }
}

/**
 * Behavior checks run through the packaged host with the mocked CMA. Only
 * pluginRoot, hostBinPath, hostDirectory and environment of the host are used
 * by the migrations checks, so tests can run them against the checkout.
 */
export function behaviorChecks(packagedHost, scratch) {
  const pluginRoot = packagedHost.pluginRoot;
  const workspace = join(scratch, 'workspace');
  const boundWorkspace = join(scratch, 'bound-workspace');
  const statePath = join(scratch, 'cma-state.json');
  const markersPath = join(scratch, 'markers.jsonl');
  const preloadPath = join(scratch, 'mock-cma.cjs');
  writeFileSync(preloadPath, MOCK_CMA_PRELOAD);
  writeFileSync(statePath, JSON.stringify(initialCmaState(), null, 2));
  writeWorkspace(workspace);
  const boundTargetSiteId = writeBoundWorkspace(boundWorkspace);

  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const run = (args, cwd = workspace) =>
    runHostCli(packagedHost, args, {
      cwd,
      preload: preloadPath,
      env: {
        OCLIF_COLUMNS: '1000',
        PACKAGE_CHECK_PLUGIN_ROOT: pluginRoot,
        PACKAGE_CHECK_CMA_STATE: statePath,
        PACKAGE_CHECK_MARKERS: markersPath,
      },
    });
  const configFile = (cwd = workspace) =>
    `--config-file=${join(cwd, 'datocms.config.json')}`;
  const failure = (result) =>
    oneLine(`${result.stdout}\n${result.stderr}${result.error ?? ''}`);
  // The runner passes an AbortSignal to real runs; the migrations record
  // whether they received one.
  const expectedContext = {
    environmentId: 'main-packaged',
    inPlace: false,
    allowPrimary: false,
    contentDiffProtocolVersion: 1,
    abortSignal: true,
  };
  let firstRun;

  const firstRunResult = () => {
    if (!firstRun) {
      firstRun = run([
        'migrations:run',
        '--source=main',
        '--destination=main-packaged',
        configFile(),
      ]);
    }
    expect(
      firstRun.status === 0,
      `migrations:run failed: ${failure(firstRun)}`,
    );
    return firstRun;
  };

  return [
    {
      title:
        "the plugin's @datocms client stack resolves on the major versions the workspace lockfile tests",
      run() {
        const dataDirectory = packagedHost.environment.DATOCMS_DATA_DIR;
        // A consumer install ignores the workspace lockfile, so the client
        // stack the plugin reads CMA responses through resolves to the newest
        // versions its ranges allow. They must stay on the majors the
        // checkout was tested with.
        const locked = Object.entries(
          JSON.parse(
            readFileSync(
              join(PACKAGE_ROOT, '..', '..', 'package-lock.json'),
              'utf8',
            ),
          ).packages ?? {},
        ).filter(
          ([path, entry]) =>
            /^node_modules\/@datocms\/[^/]+$/.test(path) &&
            entry.dev !== true &&
            entry.link !== true,
        );
        const major = (version) => version?.split('.')[0];
        const resolved = locked.flatMap(([path, entry]) => {
          const name = path.slice('node_modules/'.length);
          const installed = findInstalledPackage(
            pluginRoot,
            name,
            dataDirectory,
          );
          return installed ? [[name, installed.version, entry.version]] : [];
        });
        expect(
          resolved.some(([name]) => name === '@datocms/cma-client'),
          'the plugin did not resolve @datocms/cma-client',
        );
        const drifted = resolved.filter(
          ([, installed, lockedVersion]) =>
            major(installed) !== major(lockedVersion),
        );
        expect(
          drifted.length === 0,
          `fresh install resolved untested @datocms majors: ${drifted
            .map(
              ([name, installed, lockedVersion]) =>
                `${name} ${installed} (locked ${lockedVersion})`,
            )
            .join(', ')}`,
        );
        const hostCore = findInstalledPackage(
          join(packagedHost.hostDirectory, 'node_modules', 'datocms'),
          '@oclif/core',
          packagedHost.hostDirectory,
        );
        const cliUtils = findInstalledPackage(
          pluginRoot,
          '@datocms/cli-utils',
          dataDirectory,
        );
        console.error(
          `[${LABEL}] resolved ${resolved
            .map(([name, installed]) => `${name}@${installed}`)
            .join(', ')}; host @oclif/core ${
            hostCore?.version
          }; plugin @datocms/cli-utils ${cliUtils?.version}`,
        );
      },
    },
    {
      title: 'migrations:new dispatches to the plugin command',
      run() {
        const result = run([
          'migrations:new',
          'sync schema',
          '--autogenerate=:destination',
          configFile(),
        ]);
        expect(result.status !== 0, 'migrations:new unexpectedly succeeded');
        expect(
          failure(result).includes(
            '--autogenerate must use the format SOURCE or SOURCE:DESTINATION',
          ),
          `migrations:new was not handled by the plugin: ${failure(result)}`,
        );
      },
    },
    {
      title:
        'migrations:run dispatches to the plugin runner (reserved ledger model)',
      run() {
        const result = run([
          'migrations:run',
          '--migrations-model=datocms_content_diff',
          configFile(),
        ]);
        expect(result.status !== 0, 'migrations:run unexpectedly succeeded');
        expect(
          failure(result).includes('content-diff legacy-ID mapping ledger'),
          `migrations:run was not handled by the plugin: ${failure(result)}`,
        );
        expect(
          state().mutations.length === 0,
          'the rejected run mutated the mocked CMA',
        );
      },
    },
    {
      title: 'the primary-environment guard refuses an in-place primary run',
      run() {
        const result = run([
          'migrations:run',
          '--source=main',
          '--in-place',
          configFile(),
        ]);
        expect(result.status !== 0, 'the primary run unexpectedly succeeded');
        expect(
          failure(result).includes(
            'Running migrations on primary environment is not allowed',
          ),
          `the primary guard did not refuse: ${failure(result)}`,
        );
        expect(
          state().mutations.length === 0 && readLines(markersPath).length === 0,
          'the refused primary run mutated the mocked CMA or ran a migration',
        );
      },
    },
    {
      title:
        'the destination binding refuses a migration bound to another project before forking',
      run() {
        const result = run(
          [
            'migrations:run',
            '--source=main',
            '--destination=bound-wrong',
            configFile(boundWorkspace),
          ],
          boundWorkspace,
        );
        const output = failure(result);
        expect(result.status !== 0, 'the bound run unexpectedly succeeded');
        expect(
          output.includes(`targets DatoCMS project "${boundTargetSiteId}"`) &&
            output.includes(`active profile targets "${MOCK_SITE_ID}"`) &&
            output.includes('No migration was executed'),
          `the binding guard did not refuse: ${output}`,
        );
        expect(
          state().mutations.length === 0,
          'the refused bound run mutated the mocked CMA',
        );
      },
    },
    {
      title:
        'a JavaScript migration runs in a new fork with the execution context and is tracked',
      run() {
        firstRunResult();
        const current = state();
        // The run lock record's name carries a random run ID and a start
        // time, so only its prefix is compared.
        const mutations = current.mutations.map((mutation) =>
          mutation.type === 'createRecord' &&
          mutation.name.startsWith(RUN_LOCK_NAME_PREFIX)
            ? { ...mutation, name: `${RUN_LOCK_NAME_PREFIX}...` }
            : mutation,
        );
        expect(
          JSON.stringify(mutations) ===
            JSON.stringify([
              {
                type: 'fork',
                sourceId: 'main',
                destinationId: 'main-packaged',
              },
              {
                type: 'createModel',
                environmentId: 'main-packaged',
                apiKey: 'schema_migration',
              },
              {
                type: 'createField',
                environmentId: 'main-packaged',
                modelId: 'model-1',
                apiKey: 'name',
              },
              {
                type: 'createRecord',
                environmentId: 'main-packaged',
                name: `${RUN_LOCK_NAME_PREFIX}...`,
              },
              {
                type: 'createRecord',
                environmentId: 'main-packaged',
                name: '1700000001_packaged_js.js',
              },
              {
                type: 'createRecord',
                environmentId: 'main-packaged',
                name: '1700000002_packaged_ts.ts',
              },
              {
                type: 'destroyRecord',
                environmentId: 'main-packaged',
                id: RUN_LOCK_RECORD_ID,
              },
            ]),
          `unexpected CMA mutations: ${JSON.stringify(current.mutations)}`,
        );
        expect(
          !current.contents['main-packaged'].items.some(
            ({ id }) => id === RUN_LOCK_RECORD_ID,
          ),
          'the run lock record was not released',
        );
        const javascript = readLines(markersPath).filter(
          ({ script }) => script === 'js',
        );
        expect(
          javascript.length === 1 &&
            javascript[0].environment === 'main-packaged' &&
            JSON.stringify(javascript[0].context) ===
              JSON.stringify(expectedContext),
          `unexpected JavaScript migration invocation: ${JSON.stringify(
            javascript,
          )}`,
        );
      },
    },
    {
      title:
        'a TypeScript migration resolves a tsconfig path alias through the packaged loader',
      run() {
        firstRunResult();
        const typescript = readLines(markersPath).filter(
          ({ script }) => script === 'ts',
        );
        expect(
          typescript.length === 1 &&
            typescript[0].environment === 'main-packaged' &&
            typescript[0].aliasMarker === ALIAS_MARKER &&
            JSON.stringify(typescript[0].context) ===
              JSON.stringify(expectedContext),
          `unexpected TypeScript migration invocation: ${JSON.stringify(
            typescript,
          )}`,
        );
      },
    },
    {
      title:
        'migration history makes a second run replay nothing and create no fork',
      run() {
        firstRunResult();
        const before = state().mutations.length;
        const markersBefore = readLines(markersPath).length;
        const result = run([
          'migrations:run',
          '--source=main-packaged',
          '--destination=main-packaged-again',
          configFile(),
        ]);
        expect(
          result.status === 0,
          `the history run failed: ${failure(result)}`,
        );
        expect(
          failure(result).includes('No new migration scripts to run'),
          `the history run did not skip completed migrations: ${failure(
            result,
          )}`,
        );
        expect(
          state().mutations.length === before &&
            readLines(markersPath).length === markersBefore,
          'the history run mutated the mocked CMA or re-ran a migration',
        );
      },
    },
    {
      title:
        'the packaged launcher preserves oclif exit codes without an unhandled rejection',
      run() {
        const result = spawnSync(
          process.execPath,
          [join(pluginRoot, 'bin', 'run'), 'not-a-real-command'],
          {
            cwd: scratch,
            encoding: 'utf8',
            timeout: 120_000,
            env: packagedHost.environment,
          },
        );
        expect(
          result.status === 2 &&
            /command not-a-real-command not found/.test(result.stderr) &&
            !/CLIError:|Node\.js v|at Config\.runCommand/.test(result.stderr),
          `unexpected launcher result ${result.status}: ${oneLine(
            result.stderr,
          )}`,
        );
      },
    },
  ];
}

function credentialScanChecks(tarballFiles) {
  const secrets = credentialValues();
  if (secrets.length === 0) return [];
  const failOnMatches = (matches) =>
    expect(matches.length === 0, matches.join('\n'));
  return [
    {
      title: `none of ${secrets.length} DatoCMS API token value(s) from this environment appears in the ${tarballFiles.size} packaged files`,
      run() {
        failOnMatches(findCredentialMatches(tarballFiles, secrets));
      },
    },
    {
      title: `none of ${secrets.length} DatoCMS API token value(s) from this environment appears in a tracked or untracked (not ignored) repository file`,
      run() {
        const paths = repositoryFiles(PACKAGE_ROOT);
        expect(paths.length > 0, 'git ls-files listed no repository files');
        failOnMatches(
          findCredentialMatches(
            paths.map((path) => [
              path,
              readFileSync(join(PACKAGE_ROOT, ...path.split('/'))),
            ]),
            secrets,
          ),
        );
        console.error(`[${LABEL}] scanned ${paths.length} repository files`);
      },
    },
  ];
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'datocms-content-diff-package-'));
  let passed = 0;
  let succeeded = false;
  try {
    const packagedHost = preparePackagedHost({
      hostDirectory: join(scratch, 'host'),
      tarballPath: options.tarball,
      log: (message) => console.error(`[${LABEL}] ${message}`),
    });
    const checks = [
      ...installationChecks(packagedHost),
      ...commandRoutingChecks(packagedHost),
      ...behaviorChecks(packagedHost, scratch),
      ...credentialScanChecks(packagedHost.tarballFiles),
    ];
    passed = runChecks(checks, { label: LABEL });
    console.error(
      `[${LABEL}] All ${passed} checks passed for ${packagedHost.manifest.plugin.name}@${packagedHost.manifest.plugin.version} (tarball sha256 ${packagedHost.manifest.plugin.tarballSha256}) on Node.js ${process.version}.`,
    );
    succeeded = true;
  } catch (error) {
    console.error(
      `[${LABEL}] ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    if (options.keep) {
      console.error(`[${LABEL}] Kept ${scratch}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (!succeeded) process.exit(1);
}

// Runs as a script; tests import behaviorChecks without packing anything.
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
