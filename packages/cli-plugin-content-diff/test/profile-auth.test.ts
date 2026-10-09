import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CmaClient,
  CmaClientCommand,
  DatoConfigCommand,
} from '@datocms/cli-utils';
import * as DashboardClient from '@datocms/dashboard-client';
import { describe, it } from 'mocha';
import ContentApplyCommand from '../src/commands/content/apply';
import ContentDiffCommand from '../src/commands/content/diff';
import ContentExportCommand from '../src/commands/content/export';
import { ContentError, contentErrorReport } from '../src/engine/errors';
import * as profileAuth from '../src/utils/profile-auth';
import {
  profileApiTokenEnvironmentName,
  resolveLinkedSiteToken,
  resolveProfileApiToken,
} from '../src/utils/profile-auth';

const root = resolve(__dirname, '..');

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
              requests.push({
                url: String(url),
                headers: Object.fromEntries(new Headers(init?.headers)),
              });
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

  it('reports missing credentials, revoked OAuth, unavailable projects and missing access tokens without exposing SDK request data', async () => {
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
        (error) => {
          assert.ok(error instanceof ContentError);
          assert.equal(error.code, scenario.code);
          const report = contentErrorReport(error);
          assert.ok(report.suggestions?.length);
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

  it('initializes single and paired profiles through the public command lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-profile-init-'));
    const configFile = join(directory, 'datocms.config.json');
    const preload = join(directory, 'inspect-endpoints.cjs');
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
          const source = await this.endpoint(flags['source-profile'], flags['source-api-token']);
          const destination = flags['destination-profile'] && await this.endpoint(flags['destination-profile'], flags['destination-api-token']);
          return {
            source: source.rootClient.config.baseUrl,
            destination: destination ? destination.rootClient.config.baseUrl : null,
            explicit: source.rootClient.config.apiToken === 'override-fixture',
            sourceTokenMatched: ['source-fixture', 'override-fixture'].includes(source.rootClient.config.apiToken),
            destinationTokenMatched: !destination || destination.rootClient.config.apiToken === 'destination-fixture',
          };
        };
      `,
      );
      const cases = [
        { args: ['--profile=source'], status: 0 },
        { args: [], envProfile: 'source', status: 0 },
        {
          args: ['--profile=source', '--api-token=override-fixture'],
          status: 0,
          explicit: true,
        },
        {
          args: [
            '--source-profile=source',
            '--destination-profile=destination',
          ],
          status: 0,
          paired: true,
        },
        {
          args: [
            '--source-profile=source',
            '--destination-profile=destination',
          ],
          envProfile: 'missing',
          status: 0,
          paired: true,
        },
        { args: [], status: 2, failure: /Multiple profiles/ },
        {
          args: ['--profile=missing'],
          status: 2,
          failure: /not defined in config file/,
        },
        {
          args: [
            '--source-profile=source',
            '--destination-profile=destination',
            '--profile=source',
          ],
          status: 2,
          failure: /paired source\/destination profiles/,
        },
        {
          args: ['--source-profile=source'],
          status: 2,
          failure: /must be provided|Both source/,
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
        if (scenario.failure) {
          assert.notEqual(result.status, 0, label);
          assert.match(
            parsed.error.message,
            scenario.failure,
            `${label}: ${parsed.error.message}`,
          );
        } else {
          assert.equal(
            result.status,
            0,
            `${label}\n${result.stderr}\n${result.stdout}`,
          );
          assert.deepEqual(
            parsed,
            {
              source: 'http://source.invalid',
              destination: scenario.paired
                ? 'http://destination.invalid'
                : null,
              explicit: scenario.explicit ?? false,
              sourceTokenMatched: true,
              destinationTokenMatched: true,
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
  }).timeout(120_000);
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

  it('builds content:apply and content:export on the native client command and content:diff on the configuration command', () => {
    assert.equal(Object.getPrototypeOf(ContentApplyCommand), CmaClientCommand);
    assert.equal(Object.getPrototypeOf(ContentExportCommand), CmaClientCommand);
    assert.equal(
      Object.getPrototypeOf(Object.getPrototypeOf(ContentDiffCommand)),
      DatoConfigCommand,
    );
  });

  it('builds paired-profile endpoints with their own tokens and log settings', async () => {
    await withEnvironment(
      { CONTENT_DIFF_SOURCE_TOKEN: 'source-environment-token' },
      async () => {
        const logged: string[] = [];
        const linked: unknown[] = [];
        let json = false;
        const command = Object.assign(
          Object.create(ContentDiffCommand.prototype),
          {
            datoConfig: {
              profiles: {
                source: {
                  apiTokenEnvName: 'CONTENT_DIFF_SOURCE_TOKEN',
                  baseUrl: 'http://127.0.0.1:9',
                },
                destination: {
                  siteId: 'destination-site',
                  organizationId: 'destination-organization',
                  logLevel: 'BASIC',
                },
                empty: { apiTokenEnvName: 'CONTENT_DIFF_MISSING_TOKEN' },
              },
            },
            datoConfigRelativePath: 'datocms.config.json',
            parse: async () => ({
              flags: { 'log-level': json ? undefined : 'BODY', json },
            }),
            log: (message: string) => logged.push(message),
          },
        );
        const linkedToken = await withLinkedSiteToken(
          async (siteId, organizationId) => {
            linked.push([siteId, organizationId]);
            return 'destination-linked-token';
          },
          async () => {
            const source = await command.endpoint('source');
            const destination = await command.endpoint('destination');
            const overridden = await command.endpoint(
              'destination',
              'destination-flag-token',
            );
            const sandbox = source.buildEnvironmentClient('sandbox');
            assert.deepEqual(
              [
                source.rootClient,
                destination.rootClient,
                overridden.rootClient,
              ].map(({ config }) => [
                config.apiToken,
                config.logLevel,
                config.baseUrl,
              ]),
              [
                [
                  'source-environment-token',
                  CmaClient.LogLevel.BODY,
                  'http://127.0.0.1:9',
                ],
                [
                  'destination-linked-token',
                  CmaClient.LogLevel.BODY,
                  undefined,
                ],
                ['destination-flag-token', CmaClient.LogLevel.BODY, undefined],
              ],
            );
            assert.deepEqual(
              [sandbox.config.apiToken, sandbox.config.environment],
              ['source-environment-token', 'sandbox'],
            );
            source.rootClient.config.logFn?.('[1] GET /site');
            assert.deepEqual(logged, ['[1] GET /site']);
            json = true;
            assert.equal(
              (await command.endpoint('destination')).rootClient.config
                .logLevel,
              CmaClient.LogLevel.NONE,
            );
            json = false;
            return (await command.endpoint('destination')).rootClient.config
              .apiToken;
          },
        );
        assert.equal(linkedToken, 'destination-linked-token');
        assert.deepEqual(linked, [
          ['destination-site', 'destination-organization'],
          ['destination-site', 'destination-organization'],
          ['destination-site', 'destination-organization'],
        ]);
        await assert.rejects(
          command.endpoint('missing'),
          /Profile "missing" is not defined in "datocms.config.json"/,
        );
        await assert.rejects(
          command.endpoint('empty'),
          /No API token is available for profile "empty".*CONTENT_DIFF_MISSING_TOKEN/,
        );
        command.datoProfileConfig = {
          apiTokenEnvName: 'CONTENT_DIFF_MISSING_TOKEN',
        };
        await assert.rejects(command.endpoint(), (error: Error) => {
          assert.equal(
            error.message,
            'Cannot find an API token to use to call DatoCMS!',
          );
          assert.match(
            String(Reflect.get(error, 'suggestions')),
            /--api-token flag[\s\S]*CONTENT_DIFF_MISSING_TOKEN environment variable[\s\S]*datocms link/,
          );
          return true;
        });
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
