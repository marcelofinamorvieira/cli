import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient, CmaClientCommand, oclif } from '@datocms/cli-utils';
import * as DashboardClient from '@datocms/dashboard-client';
import { describe, it } from 'mocha';
import ContentApplyCommand from '../src/commands/content/apply';
import ContentDiffCommand from '../src/commands/content/diff';
import ContentExportCommand from '../src/commands/content/export';
import { contentErrorReport } from '../src/engine/errors';
import * as profileAuth from '../src/utils/profile-auth';
import {
  profileApiTokenEnvironmentName,
  resolveLinkedSiteToken,
  resolveProfileApiToken,
} from '../src/utils/profile-auth';

const root = resolve(__dirname, '..');

type NativeError = Error & {
  code?: string;
  suggestions?: string[];
  oclif?: { exit?: number };
};

describe('public profile authentication adapter', () => {
  it('uses saved Dashboard credentials and organization scope', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    let options: DashboardClient.ClientConfigOptions | undefined;
    const token = await resolveLinkedSiteToken(
      { siteId: '123', organizationId: '456' },
      {
        readCredentials: async () => ({
          apiToken: 'oauth-fixture',
          dashboardBaseUrl: 'https://dashboard-fixture.invalid',
        }),
        buildClient: (config) => {
          options = config;
          return DashboardClient.buildClient({
            ...config,
            fetchFn: async (url, init) => {
              const headers: Record<string, string> = {};
              new Headers(init?.headers).forEach((value, key) => {
                headers[key] = value;
              });
              requests.push({ url: String(url), headers });
              return new Response(
                JSON.stringify({
                  data: {
                    id: '123',
                    type: 'site',
                    attributes: {
                      name: 'Fixture project',
                      access_token: 'cma-fixture',
                    },
                  },
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              );
            },
          });
        },
      },
    );
    assert.equal(token, 'cma-fixture');
    assert.equal(options?.organization, '456');
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      'https://dashboard-fixture.invalid/sites/123',
    );
    assert.equal(requests[0].headers.authorization, 'Bearer oauth-fixture');
  });

  it('reports missing credentials, revoked OAuth, unavailable projects and missing access tokens as native CLI errors without exposing SDK request data', async () => {
    for (const scenario of [
      { kind: 'missing', code: 'OAUTH_CREDENTIALS_MISSING' },
      { kind: 'revoked', code: 'OAUTH_CREDENTIALS_INVALID' },
      { kind: 'forbidden', code: 'LINKED_PROJECT_UNAVAILABLE' },
      { kind: 'no-token', code: 'LINKED_PROJECT_TOKEN_MISSING' },
    ]) {
      let requests = 0;
      await assert.rejects(
        resolveLinkedSiteToken(
          { siteId: '123' },
          {
            readCredentials: async () =>
              scenario.kind === 'missing'
                ? undefined
                : { apiToken: 'oauth-fixture' },
            buildClient: (config) =>
              DashboardClient.buildClient({
                ...config,
                fetchFn: async () => {
                  requests++;
                  if (scenario.kind === 'no-token')
                    return new Response(
                      JSON.stringify({
                        data: {
                          id: '123',
                          type: 'site',
                          attributes: {
                            name: 'Fixture project',
                            access_token: null,
                          },
                        },
                      }),
                      {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                      },
                    );
                  return new Response(
                    JSON.stringify({
                      data: [
                        {
                          id: 'error',
                          type: 'api_error',
                          attributes: {
                            code:
                              scenario.kind === 'revoked'
                                ? 'INVALID_AUTHORIZATION_HEADER'
                                : 'INSUFFICIENT_PERMISSIONS',
                            details: { echoed: 'oauth-fixture' },
                          },
                        },
                      ],
                    }),
                    {
                      status: scenario.kind === 'revoked' ? 401 : 403,
                      headers: { 'content-type': 'application/json' },
                    },
                  );
                },
              }),
          },
        ),
        (error: NativeError) => {
          assert.ok(error instanceof oclif.Errors.CLIError, String(error));
          assert.equal(error.code, scenario.code);
          assert.equal(error.oclif?.exit, 2);
          const report = contentErrorReport(error);
          assert.equal(report.code, scenario.code);
          assert.ok(report.suggestions?.length);
          assert.match(
            report.suggestions.join('\n'),
            /--source-api-token for the source project/,
          );
          assert.doesNotMatch(
            JSON.stringify(report),
            /oauth-fixture|headers|echoed/,
          );
          return true;
        },
      );
      assert.equal(requests, scenario.kind === 'missing' ? 0 : 1);
    }
  });

  it('selects the destination natively and the source project through --source-profile in the public command lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-profile-init-'));
    const configFile = join(directory, 'datocms.config.json');
    const preload = join(directory, 'inspect-projects.cjs');
    try {
      await writeFile(
        configFile,
        JSON.stringify({
          profiles: {
            source: {
              apiTokenEnvName: 'FIXTURE_SOURCE_TOKEN',
              baseUrl: 'http://source.invalid',
            },
            destination: {
              apiTokenEnvName: 'FIXTURE_DESTINATION_TOKEN',
              baseUrl: 'http://destination.invalid',
            },
            empty: {
              apiTokenEnvName: 'FIXTURE_EMPTY_TOKEN',
              baseUrl: 'http://empty.invalid',
            },
          },
        }),
      );
      await writeFile(
        preload,
        `
        const Command = require(${JSON.stringify(
          join(root, 'src/commands/content/diff.ts'),
        )}).default;
        Command.prototype.run = async function () {
          const { flags } = await this.parse(this.ctor);
          const source = flags['source-profile']
            ? (await this.sourceProject(flags['source-profile'], flags['source-api-token'])).endpoint.rootClient
            : null;
          const token = (client) => client.config.apiToken;
          return {
            destination: this.client.config.baseUrl,
            source: source ? source.config.baseUrl : null,
            destinationExplicit: token(this.client) === 'override-fixture',
            destinationTokenMatched: ['destination-fixture', 'override-fixture'].includes(token(this.client)),
            sourceExplicit: !!source && token(source) === 'override-fixture',
            sourceTokenMatched: !source || ['source-fixture', 'override-fixture'].includes(token(source)),
          };
        };
      `,
      );
      const cases = [
        { args: ['--profile=destination'], status: 0 },
        { args: [], envProfile: 'destination', status: 0 },
        {
          args: ['--profile=destination', '--api-token=override-fixture'],
          status: 0,
          destinationExplicit: true,
        },
        {
          args: ['--profile=destination', '--source-profile=source'],
          status: 0,
          paired: true,
        },
        {
          args: ['--source-profile=source'],
          envProfile: 'destination',
          status: 0,
          paired: true,
        },
        {
          args: [
            '--profile=destination',
            '--source-profile=source',
            '--source-api-token=override-fixture',
          ],
          status: 0,
          paired: true,
          sourceExplicit: true,
        },
        { args: [], status: 2, failure: /Multiple profiles detected/ },
        {
          args: ['--profile=missing'],
          status: 2,
          failure: /Requested profile "missing" is not defined in config file/,
        },
        {
          args: ['--profile=destination', '--source-profile=missing'],
          status: 2,
          failure: /Requested profile "missing" is not defined in config file/,
        },
        {
          args: ['--profile=destination', '--source-profile=empty'],
          status: 2,
          failure: /Cannot find an API token for the source profile "empty"!/,
        },
      ];
      for (const scenario of cases) {
        const env = {
          ...process.env,
          DATOCMS_CONFIG_FILE: configFile,
          TS_NODE_PROJECT: join(root, 'tsconfig.json'),
          FIXTURE_SOURCE_TOKEN: 'source-fixture',
          FIXTURE_DESTINATION_TOKEN: 'destination-fixture',
        };
        Reflect.deleteProperty(env, 'DATOCMS_PROFILE');
        Reflect.deleteProperty(env, 'FIXTURE_EMPTY_TOKEN');
        if (scenario.envProfile)
          Reflect.set(env, 'DATOCMS_PROFILE', scenario.envProfile);
        const result = spawnSync(
          process.execPath,
          [
            '--require',
            require.resolve('ts-node/register'),
            '--require',
            preload,
            join(root, 'bin/dev'),
            'content:diff',
            '--source=source',
            '--json',
            ...scenario.args,
          ],
          { cwd: directory, env, encoding: 'utf8', timeout: 20_000 },
        );
        const label = JSON.stringify(scenario);
        assert.equal(result.error, undefined, label);
        const parsed = JSON.parse(result.stdout);
        assert.equal(
          result.status,
          scenario.status,
          `${label}\n${result.stderr}\n${result.stdout}`,
        );
        if (scenario.failure) {
          assert.match(
            parsed.error.message,
            scenario.failure,
            `${label}: ${parsed.error.message}`,
          );
          assert.ok(parsed.error.suggestions?.length, label);
        } else {
          assert.deepEqual(
            parsed,
            {
              destination: 'http://destination.invalid',
              source: scenario.paired ? 'http://source.invalid' : null,
              destinationExplicit: scenario.destinationExplicit ?? false,
              destinationTokenMatched: true,
              sourceExplicit: scenario.sourceExplicit ?? false,
              sourceTokenMatched: true,
            },
            label,
          );
        }
        assert.doesNotMatch(
          `${result.stdout}${result.stderr}`,
          /source-fixture|destination-fixture|override-fixture/,
          label,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }).timeout(180_000);
});

function withEnvironment<T>(
  values: Record<string, string>,
  work: () => Promise<T>,
): Promise<T> {
  const previous = Object.keys(values).map(
    (name) => [name, process.env[name]] as const,
  );
  Object.assign(process.env, values);
  return work().finally(() => {
    for (const [name, value] of previous)
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
  });
}

async function withLinkedSiteToken<T>(
  resolve: (siteId: string, organizationId?: string) => Promise<string>,
  work: () => Promise<T>,
): Promise<T> {
  const original = profileAuth.resolveLinkedSiteToken;
  Reflect.set(
    profileAuth,
    'resolveLinkedSiteToken',
    ({ siteId, organizationId }: { siteId: string; organizationId?: string }) =>
      resolve(siteId, organizationId),
  );
  try {
    return await work();
  } finally {
    Reflect.set(profileAuth, 'resolveLinkedSiteToken', original);
  }
}

/** The native options a client was built with. */
function clientOptions({ config }: CmaClient.Client) {
  return [config.apiToken, config.baseUrl, config.logLevel, config.environment];
}

describe('command authentication', () => {
  it('uses the DatoCMS CLI token environment-variable names', () => {
    assert.equal(
      profileApiTokenEnvironmentName('default', {}),
      'DATOCMS_API_TOKEN',
    );
    assert.equal(
      profileApiTokenEnvironmentName('client_a', {}),
      'DATOCMS_CLIENT_A_PROFILE_API_TOKEN',
    );
    assert.equal(
      profileApiTokenEnvironmentName('client_a', {
        apiTokenEnvName: 'CUSTOM_CLIENT_TOKEN',
      }),
      'CUSTOM_CLIENT_TOKEN',
    );
  });

  it('prefers explicit tokens, then linked projects, then the profile environment variable', async () => {
    await withEnvironment(
      { CONTENT_DIFF_TEST_TOKEN: 'environment-token' },
      async () => {
        const linked: unknown[] = [];
        const resolveLinkedSiteToken = async (
          siteId: string,
          organizationId?: string,
        ) => {
          linked.push([siteId, organizationId]);
          if (siteId !== 'linked-site')
            throw new Error('Linked project unavailable');
          return 'linked-token';
        };
        const profileConfig = {
          siteId: 'linked-site',
          organizationId: 'linked-organization',
          apiTokenEnvName: 'CONTENT_DIFF_TEST_TOKEN',
        };
        assert.deepEqual(
          await resolveProfileApiToken({
            explicitApiToken: 'explicit-token',
            profileConfig,
            profileId: 'source',
            resolveLinkedSiteToken,
          }),
          {
            apiToken: 'explicit-token',
            environmentName: 'CONTENT_DIFF_TEST_TOKEN',
          },
        );
        assert.deepEqual(linked, []);
        assert.equal(
          (
            await resolveProfileApiToken({
              profileConfig,
              profileId: 'source',
              resolveLinkedSiteToken,
            })
          ).apiToken,
          'linked-token',
        );
        assert.equal(
          (
            await resolveProfileApiToken({
              profileConfig: { apiTokenEnvName: 'CONTENT_DIFF_TEST_TOKEN' },
              profileId: 'source',
              resolveLinkedSiteToken,
            })
          ).apiToken,
          'environment-token',
        );
        await assert.rejects(
          resolveProfileApiToken({
            profileConfig: { ...profileConfig, siteId: 'unlinked-site' },
            profileId: 'source',
            resolveLinkedSiteToken,
          }),
          /Linked project unavailable/,
        );
        assert.deepEqual(linked, [
          ['linked-site', 'linked-organization'],
          ['unlinked-site', 'linked-organization'],
        ]);
      },
    );
  });

  it('builds every command on the native client command', () => {
    for (const Command of [
      ContentApplyCommand,
      ContentDiffCommand,
      ContentExportCommand,
    ])
      assert.equal(Object.getPrototypeOf(Command), CmaClientCommand);
  });

  it('builds the source project clients from its profile with its own token and the native log settings', async () => {
    await withEnvironment(
      { CONTENT_DIFF_SOURCE_TOKEN: 'source-environment-token' },
      async () => {
        const logged: string[] = [];
        const linked: unknown[] = [];
        const command = Object.assign(
          Object.create(ContentDiffCommand.prototype),
          {
            config: { bin: 'datocms' },
            datoConfig: {
              profiles: {
                source: {
                  apiTokenEnvName: 'CONTENT_DIFF_SOURCE_TOKEN',
                  baseUrl: 'http://127.0.0.1:9',
                },
                linked: {
                  siteId: 'linked-site',
                  organizationId: 'linked-organization',
                  logLevel: 'BASIC',
                },
                empty: { apiTokenEnvName: 'CONTENT_DIFF_MISSING_TOKEN' },
              },
            },
            datoConfigRelativePath: 'datocms.config.json',
            // The destination, as the native init selects it.
            profileId: 'default',
            datoProfileConfig: { baseUrl: 'http://destination.invalid' },
            parse: async () => ({
              flags: { 'api-token': 'destination-token', 'log-level': 'BODY' },
            }),
            log: (message: string) => logged.push(message),
          },
        );
        await withLinkedSiteToken(
          async (siteId, organizationId) => {
            linked.push([siteId, organizationId]);
            return 'linked-token';
          },
          async () => {
            const source = await command.sourceProject('source');
            const linkedProject = await command.sourceProject('linked');
            const overridden = await command.sourceProject(
              'linked',
              'linked-flag-token',
            );
            assert.equal(source.profile, command.datoConfig.profiles.source);
            // A source profile without a base URL uses the API's default,
            // never the destination's; log settings stay native.
            assert.deepEqual(
              [
                source.endpoint.rootClient,
                await source.endpoint.buildEnvironmentClient('sandbox'),
                linkedProject.endpoint.rootClient,
                overridden.endpoint.rootClient,
              ].map(clientOptions),
              [
                [
                  'source-environment-token',
                  'http://127.0.0.1:9',
                  CmaClient.LogLevel.BODY,
                  undefined,
                ],
                [
                  'source-environment-token',
                  'http://127.0.0.1:9',
                  CmaClient.LogLevel.BODY,
                  'sandbox',
                ],
                ['linked-token', undefined, CmaClient.LogLevel.BODY, undefined],
                [
                  'linked-flag-token',
                  undefined,
                  CmaClient.LogLevel.BODY,
                  undefined,
                ],
              ],
            );
            source.endpoint.rootClient.config.logFn?.('[1] GET /site');
            assert.deepEqual(logged, ['[1] GET /site']);
          },
        );
        // An explicit token never consults the linked project.
        assert.deepEqual(linked, [['linked-site', 'linked-organization']]);
        await assert.rejects(
          command.sourceProject('missing'),
          (error: NativeError) => {
            assert.ok(error instanceof oclif.Errors.CLIError, String(error));
            assert.equal(
              error.message,
              'Requested profile "missing" is not defined in config file "datocms.config.json"',
            );
            assert.deepEqual(error.suggestions, [
              'Configure it with "datocms profile:set missing"',
            ]);
            assert.equal(error.oclif?.exit, 2);
            return true;
          },
        );
        await assert.rejects(
          command.sourceProject('empty'),
          (error: NativeError) => {
            assert.ok(error instanceof oclif.Errors.CLIError, String(error));
            assert.equal(
              error.message,
              'Cannot find an API token for the source profile "empty"!',
            );
            assert.match(
              String(error.suggestions),
              /--source-api-token flag[\s\S]*CONTENT_DIFF_MISSING_TOKEN environment variable[\s\S]*datocms link/,
            );
            assert.equal(error.oclif?.exit, 2);
            return true;
          },
        );
        command.datoConfig = undefined;
        await assert.rejects(
          command.sourceProject('source'),
          /No config file found in "datocms.config.json"/,
        );
      },
    );
  });

  // Request logs and API errors rely on the SDK keeping the token out, which
  // `@datocms/rest-client-utils` does from 6.1.1 (the declared floor).
  it('gets request logs and API errors without the token from the SDK', async () => {
    const token = 'client-token-Zq9X';
    const logged: string[] = [];
    const client = CmaClient.buildClient({
      apiToken: token,
      baseUrl: 'http://127.0.0.1:9',
      logLevel: CmaClient.LogLevel.BODY_AND_HEADERS,
      logFn: (message: string) => logged.push(message),
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'error',
                type: 'api_error',
                attributes: { code: 'INVALID_FIELD', details: {} },
              },
            ],
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });
    const error = await client.site.find().then(
      () => assert.fail('the request should fail'),
      (failure: Error) => failure,
    );
    assert.match(logged.join('\n'), /^\[\d+\] authorization: \[REDACTED/m);
    for (const text of [
      logged.join('\n'),
      error.message,
      error.stack,
      JSON.stringify(Reflect.get(error, 'request')),
    ])
      assert.doesNotMatch(String(text), /client-token/);
  });
});
