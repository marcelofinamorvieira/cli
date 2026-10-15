import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClientCommand } from '@datocms/cli-utils';
import { Exit, handle } from '@oclif/core/handle';
import { captureOutput, runCommand } from '@oclif/test';
import {
  DUMP_FORMAT,
  DUMP_VERSION,
  PLUGIN_VERSION,
  openDump,
} from '../src/dump/format';

/*
 * content:export and content:import run in-process as the CLI runs them,
 * against hand-written stub clients: every client a command builds comes
 * from the stubbed CmaClientCommand.prototype.buildClient, and records each
 * call made on it.
 */

const PACKAGE_ROOT = resolve(__dirname, '..');

type StubClient = Record<string, unknown>;
type BuildClient = (config?: { environment?: string }) => Promise<unknown>;
const commandPrototype = CmaClientCommand.prototype as unknown as {
  buildClient: BuildClient;
};
const originalBuildClient = commandPrototype.buildClient;

const ENVIRONMENTS = [
  { id: 'main', type: 'environment', meta: { primary: true } },
  { id: 'sandbox', type: 'environment', meta: { primary: false } },
];

/** The clients each command built ('project' for the one without environment). */
let builds: string[];
/** Every call made on a stub client, as `<environment> <resource>.<method>`. */
let calls: string[];

function answer(name: string, value: unknown) {
  return async () => {
    calls.push(name);
    return value;
  };
}

/** `GET /site?include=item_types,item_types.fields` of an environment without models. */
function rawSite(locales: string[]) {
  return {
    data: { id: 'site-1', type: 'site', attributes: { locales } },
    included: [],
  };
}

/** A client of an environment with no models, records, uploads or folders. */
function emptyEnvironment(environment: string, locales = ['en']): StubClient {
  const call = (name: string, value: unknown) =>
    answer(`${environment} ${name}`, value);
  return {
    site: { rawFind: call('site.rawFind', rawSite(locales)) },
    workflows: { list: call('workflows.list', []) },
    uploads: { list: call('uploads.list', []) },
    uploadCollections: { list: call('uploadCollections.list', []) },
  };
}

/** Makes every command build these clients, the project's one listing ENVIRONMENTS. */
function useClients(environments: Record<string, StubClient>) {
  const project = {
    environments: { list: answer('environments.list', ENVIRONMENTS) },
  };
  commandPrototype.buildClient = async (config = {}) => {
    builds.push(config.environment ?? 'project');
    if (!config.environment) return project;
    const client = environments[config.environment];
    if (!client)
      throw new Error(`No stub client for environment ${config.environment}.`);
    return client;
  };
}

function run(...args: string[]) {
  return runCommand([...args, '--api-token=test'], { root: PACKAGE_ROOT });
}

function codeOf(error: Error | undefined): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

describe('content:export and content:import', () => {
  let directory: string;
  let exitCode: typeof process.exitCode;
  const savedVariables: Record<string, string | undefined> = {};

  before(() => {
    for (const name of Object.keys(process.env))
      if (/^DATOCMS_.*API_TOKEN$/.test(name) || name === 'DATOCMS_PROFILE') {
        savedVariables[name] = process.env[name];
        delete process.env[name];
      }
    savedVariables.DATOCMS_CONFIG_FILE = process.env.DATOCMS_CONFIG_FILE;
  });

  after(() => {
    for (const [name, value] of Object.entries(savedVariables))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-dump-commands-'));
    // No configuration file of the machine running the test applies.
    process.env.DATOCMS_CONFIG_FILE = join(directory, 'missing.json');
    exitCode = process.exitCode;
    builds = [];
    calls = [];
  });

  afterEach(async () => {
    commandPrototype.buildClient = originalBuildClient;
    process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  });

  describe('content:export', () => {
    it('refuses an --out that already exists before reading any content', async () => {
      useClients({ main: emptyEnvironment('main') });
      const out = join(directory, 'taken.dump.zip');
      await writeFile(out, 'Someone else’s file.');

      const { error } = await run('content:export', `--out=${out}`);
      assert.equal(codeOf(error), 'OUTPUT_EXISTS');
      assert.match(error!.message, /taken\.dump\.zip already exists/);
      assert.deepEqual(builds, ['project']);
      assert.deepEqual(calls, ['environments.list']);
      assert.equal(await readFile(out, 'utf8'), 'Someone else’s file.');
    });

    it('exports an empty environment and returns the manifest and path under --json', async () => {
      useClients({ main: emptyEnvironment('main') });
      const out = join(directory, 'main.dump.zip');

      const { error, result, stdout } = await run(
        'content:export',
        `--out=${out}`,
        '--json',
      );
      assert.ifError(error);
      const { createdAt, ...rest } = result as { createdAt: string };
      assert.ok(!Number.isNaN(Date.parse(createdAt)));
      assert.deepEqual(rest, {
        path: out,
        format: DUMP_FORMAT,
        version: DUMP_VERSION,
        pluginVersion: PLUGIN_VERSION,
        site: { id: 'site-1', environment: 'main', primary: true },
        locales: ['en'],
        includesAssets: false,
        counts: { records: 0, uploads: 0, uploadCollections: 0 },
      });
      assert.deepEqual(JSON.parse(stdout), result);
      assert.deepEqual(builds, ['project', 'main']);
      assert.deepEqual(calls, [
        'environments.list',
        'main site.rawFind',
        'main workflows.list',
        'main uploads.list',
        'main uploadCollections.list',
      ]);

      assert.equal(existsSync(`${out}.partial`), false);
      const dump = await openDump(out);
      dump.zip.close();
      const { path: _path, ...manifest } = result as { path: string };
      assert.deepEqual(dump.manifest, manifest);
    });

    it('prints the counts and the path of the dump', async () => {
      useClients({ sandbox: emptyEnvironment('sandbox') });
      const out = join(directory, 'sandbox.dump.zip');

      const { error, stdout } = await run(
        'content:export',
        '--environment=sandbox',
        `--out=${out}`,
      );
      assert.ifError(error);
      assert.equal(
        stdout,
        `Exported 0 records, 0 uploads and 0 upload folders of environment "sandbox" to ${out}\n`,
      );
      assert.equal(existsSync(out), true);
    });

    it('names the dump after the environment and the time without --out', async () => {
      useClients({ main: emptyEnvironment('main') });
      const cwd = process.cwd();
      process.chdir(directory);
      try {
        const { error } = await run('content:export');
        assert.ifError(error);
      } finally {
        process.chdir(cwd);
      }
      const [file, ...others] = await readdir(directory);
      assert.deepEqual(others, []);
      assert.match(file!, /^main-\d{8}T\d{6}Z\.dump\.zip$/);
    });
  });

  describe('content:import', () => {
    let dumpPath: string;

    /** The dump content:export writes of an empty `main` with locale en. */
    beforeEach(async () => {
      useClients({ main: emptyEnvironment('main') });
      dumpPath = join(directory, 'main.dump.zip');
      assert.ifError((await run('content:export', `--out=${dumpPath}`)).error);
      builds = [];
      calls = [];
    });

    it('requires the DUMP argument and --environment, as oclif parse errors', async () => {
      const withoutDump = await run('content:import', '--environment=sandbox');
      assert.equal(withoutDump.error?.constructor.name, 'RequiredArgsError');
      assert.match(withoutDump.error!.message, /Missing 1 required arg/);
      assert.match(withoutDump.error!.message, /DUMP/);

      const withoutEnvironment = await run('content:import', dumpPath);
      assert.equal(
        withoutEnvironment.error?.constructor.name,
        'FailedFlagValidationError',
      );
      assert.match(
        withoutEnvironment.error!.message,
        /Missing required flag environment/,
      );
      assert.deepEqual(builds, []);
    });

    it('refuses a file that is not a dump before any client call', async () => {
      const path = join(directory, 'notes.txt');
      await writeFile(path, 'Not a dump.');

      const { error } = await run(
        'content:import',
        path,
        '--environment=sandbox',
      );
      assert.equal(codeOf(error), 'INVALID_DUMP');
      assert.deepEqual(calls, []);
    });

    it('refuses an environment that does not exist before any write', async () => {
      const { error } = await run(
        'content:import',
        dumpPath,
        '--environment=staging',
      );
      assert.equal(codeOf(error), 'ENVIRONMENT_NOT_FOUND');
      assert.match(error!.message, /Environment "staging" does not exist/);
      assert.deepEqual(builds, ['project']);
      assert.deepEqual(calls, ['environments.list']);
    });

    it('refuses the primary environment before any write', async () => {
      for (const environment of ['main', 'primary']) {
        builds = [];
        calls = [];
        const { error } = await run(
          'content:import',
          dumpPath,
          `--environment=${environment}`,
        );
        assert.equal(codeOf(error), 'PRIMARY_ENVIRONMENT');
        assert.deepEqual(builds, ['project']);
        assert.deepEqual(calls, ['environments.list']);
      }
    });

    it('imports an empty dump into an empty sandbox with its schema, returning the counts under --json', async () => {
      useClients({ sandbox: emptyEnvironment('sandbox') });

      const { error, result, stdout } = await run(
        'content:import',
        dumpPath,
        '--environment=sandbox',
        '--json',
      );
      assert.ifError(error);
      assert.deepEqual(result, {
        environment: 'sandbox',
        counts: { uploadCollections: 0, uploads: 0, records: 0, published: 0 },
        skippedRecords: 0,
        skippedSchedules: 0,
      });
      assert.deepEqual(JSON.parse(stdout), result);
      assert.deepEqual(builds, ['project', 'sandbox']);
      assert.deepEqual(calls, [
        'environments.list',
        'sandbox site.rawFind',
        'sandbox workflows.list',
      ]);
    });

    it('prints what it imported', async () => {
      useClients({ sandbox: emptyEnvironment('sandbox') });

      const { error, stdout } = await run(
        'content:import',
        dumpPath,
        '--environment=sandbox',
      );
      assert.ifError(error);
      assert.equal(
        stdout,
        'Imported 0 records (0 published), 0 uploads and 0 upload folders into environment "sandbox".\n',
      );
    });

    it('fails with SCHEMA_MISMATCH, which oclif renders with its code and suggestions', async () => {
      useClients({
        main: emptyEnvironment('main'),
        sandbox: emptyEnvironment('sandbox', ['en', 'it']),
      });

      const { error } = await run(
        'content:import',
        dumpPath,
        '--environment=sandbox',
      );
      assert.equal(codeOf(error), 'SCHEMA_MISMATCH');
      // The environment the dump came from is read for the advice.
      assert.deepEqual(builds, ['project', 'sandbox', 'main']);
      assert.deepEqual(calls, [
        'environments.list',
        'sandbox site.rawFind',
        'sandbox workflows.list',
        'main site.rawFind',
        'main workflows.list',
      ]);

      // What bin/run prints when a command fails.
      const exit = Exit.exit;
      let exitedWith: number | undefined;
      Exit.exit = ((code: number) => {
        exitedWith = code;
      }) as typeof Exit.exit;
      let rendered: string;
      try {
        ({ stderr: rendered } = await captureOutput(() => handle(error!)));
      } finally {
        Exit.exit = exit;
      }
      const text = rendered.replace(/›/g, '').replace(/\s+/g, ' ');
      assert.match(text, /Code: SCHEMA_MISMATCH/);
      assert.match(text, /- locales: en in the dump, en, it in "sandbox"/);
      assert.match(text, /"main" still has the dump's schema/);
      assert.match(
        text,
        /Try this: \* datocms migrations:new copyDumpSchema --autogenerate=main:sandbox/,
      );
      assert.ok(exitedWith, 'oclif did not exit with a failure status.');
    });
  });
});
