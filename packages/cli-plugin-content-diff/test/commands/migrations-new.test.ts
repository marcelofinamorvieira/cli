import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClientCommand } from '@datocms/cli-utils';
import { runCommand } from '@oclif/test';
import { expect } from 'chai';
import {
  type FakeCmaRequest,
  type FakeCmaResponse,
  apiErrorResponse,
  environmentsResponse,
  expectAuthenticatedWith,
  expectRedactedCmaOutput,
  requestedEnvironments,
  siteResponse,
  startFakeCmaServer,
} from './fake-cma-server';

const commandPrototype = CmaClientCommand.prototype as unknown as {
  buildClient: (options?: { environment?: string }) => Promise<unknown>;
};

describe('migrations:new', () => {
  let temporaryDirectory: string;
  let configPath: string;
  let migrationsDirectory: string;
  let originalBuildClient: typeof commandPrototype.buildClient;
  let originalNow: typeof Date.now;
  let environments: Array<{ id: string; meta: { primary: boolean } }>;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'datocms-migrations-new-'),
    );
    configPath = join(temporaryDirectory, 'datocms.config.json');
    migrationsDirectory = join(temporaryDirectory, 'migrations');
    await writeFile(
      configPath,
      JSON.stringify({
        profiles: { default: { migrations: { directory: 'migrations' } } },
      }),
    );
    await mkdir(migrationsDirectory);
    environments = [
      { id: 'primary', meta: { primary: true } },
      { id: 'source', meta: { primary: false } },
      { id: 'destination', meta: { primary: false } },
    ];
    originalBuildClient = commandPrototype.buildClient;
    originalNow = Date.now;
    commandPrototype.buildClient = async () => ({
      environments: { list: async () => environments },
    });
  });

  afterEach(async () => {
    commandPrototype.buildClient = originalBuildClient;
    Date.now = originalNow;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('preserves an existing migration when a generated filename collides', async () => {
    Date.now = () => 1700000000000;
    const migrationPath = join(migrationsDirectory, '1700000000_addArticle.js');
    const originalContents = '// Reviewed migration with manual changes\n';
    await writeFile(migrationPath, originalContents);

    const { error } = await runCommand(
      `migrations:new "add article" --js --config-file=${configPath}`,
    );

    expect(error?.message).to.contain('EEXIST');
    expect(await readFile(migrationPath, 'utf8')).to.equal(originalContents);
  });

  for (const autogenerate of [
    'source:destination:extra',
    'source:',
    ':destination',
  ]) {
    it(`rejects malformed environment selection ${autogenerate}`, async () => {
      const { error } = await runCommand(
        `migrations:new "sync schema" --js --autogenerate=${autogenerate} --config-file=${configPath}`,
      );

      expect(error?.message).to.contain(
        '--autogenerate must use the format SOURCE or SOURCE:DESTINATION',
      );
      expect(await readdir(migrationsDirectory)).to.deep.equal([]);
    });
  }

  for (const autogenerate of ['missing:destination', 'source:missing']) {
    it(`names the missing environment in ${autogenerate}`, async () => {
      const { error } = await runCommand(
        `migrations:new "sync schema" --js --autogenerate=${autogenerate} --config-file=${configPath}`,
      );

      expect(error?.message).to.contain('Environment "missing" does not exist');
      expect(await readdir(migrationsDirectory)).to.deep.equal([]);
    });
  }

  it('explains when the implicit primary destination cannot be resolved', async () => {
    environments = environments.filter(
      (environment) => !environment.meta.primary,
    );

    const { error } = await runCommand(
      `migrations:new "sync schema" --js --autogenerate=source --config-file=${configPath}`,
    );

    expect(error?.message).to.contain(
      'Cannot determine the primary environment',
    );
    expect(await readdir(migrationsDirectory)).to.deep.equal([]);
  });

  it('redacts the API token from every CMA client log while autogenerating', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'migrations-new-verbose-credential';
    const server = await startFakeCmaServer(schemaRoute);

    try {
      const { stdout, stderr, error } = await runCommand(
        `migrations:new "sync schema" --js --autogenerate=source:destination --api-token=${credential} --base-url=${server.baseUrl} --log-level=BODY_AND_HEADERS --log-mode=stdout --config-file=${configPath}`,
      );

      expect(error).to.equal(undefined);
      expect(await readdir(migrationsDirectory)).to.have.length(1);
      expectAuthenticatedWith(server.requests, [credential]);
      expect([...requestedEnvironments(server.requests)]).to.have.members([
        undefined,
        'source',
        'destination',
      ]);
      expectRedactedCmaOutput(`${stdout}${stderr}`, [credential]);
    } finally {
      await server.close();
    }
  });

  it('redacts the API token from uncaught CMA errors', async () => {
    commandPrototype.buildClient = originalBuildClient;
    const credential = 'migrations-new-error-credential';
    const previousCredential = process.env.DATOCMS_API_TOKEN;
    process.env.DATOCMS_API_TOKEN = credential;
    const server = await startFakeCmaServer(() =>
      apiErrorResponse(422, 'INVALID_FIELD'),
    );

    try {
      const { stdout, stderr, error } = await runCommand(
        `migrations:new "sync schema" --js --autogenerate=source:destination --base-url=${server.baseUrl} --config-file=${configPath}`,
      );

      expect(error?.message).to.contain('422');
      expectAuthenticatedWith(server.requests, [credential]);
      expect(stdout).to.contain("name: 'ApiError'");
      expect(`${stdout}${stderr}${error?.stack}`).not.to.contain(credential);
      expect(await readdir(migrationsDirectory)).to.deep.equal([]);
    } finally {
      if (previousCredential === undefined) {
        Reflect.deleteProperty(process.env, 'DATOCMS_API_TOKEN');
      } else {
        process.env.DATOCMS_API_TOKEN = previousCredential;
      }
      await server.close();
    }
  });
});

function schemaRoute(request: FakeCmaRequest): FakeCmaResponse | undefined {
  if (request.method !== 'GET') return undefined;

  if (request.path === '/environments') {
    return environmentsResponse([
      { id: 'primary', primary: true },
      { id: 'source', primary: false },
      { id: 'destination', primary: false },
    ]);
  }

  if (request.path === '/site') {
    return siteResponse('fake-site');
  }

  if (
    [
      '/menu-items',
      '/schema-menu-items',
      '/plugins',
      '/workflows',
      '/item-type-filters',
      '/upload-filters',
      '/roles',
    ].includes(request.path)
  ) {
    return { status: 200, body: { data: [] } };
  }

  return undefined;
}
