import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as DashboardClient from '@datocms/dashboard-client';
import { describe, it } from 'mocha';
import { ContentError, contentErrorReport } from '../../src/engine/errors';
import { CredentialRedactor } from '../../src/utils/credential-redaction';
import { resolveLinkedSiteToken } from '../../src/utils/profile-auth';

const root = resolve(__dirname, '../..');

describe('public profile authentication adapter', () => {
  it('uses saved Dashboard credentials and organization scope, redacting both resolved tokens', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    const redactor = new CredentialRedactor();
    let options: DashboardClient.ClientConfigOptions | undefined;
    const token = await resolveLinkedSiteToken(
      {
        siteId: '123',
        organizationId: '456',
        redactor,
      },
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
    assert.equal(
      redactor.redact('oauth-fixture cma-fixture'),
      '[REDACTED] [REDACTED]',
    );
  });

  it('reports missing credentials, revoked OAuth, unavailable projects and missing access tokens without exposing SDK request data', async () => {
    for (const scenario of [
      { kind: 'missing', code: 'OAUTH_CREDENTIALS_MISSING' },
      { kind: 'revoked', code: 'OAUTH_CREDENTIALS_INVALID' },
      { kind: 'forbidden', code: 'LINKED_PROJECT_UNAVAILABLE' },
      { kind: 'no-token', code: 'LINKED_PROJECT_TOKEN_MISSING' },
    ]) {
      const redactor = new CredentialRedactor();
      let requests = 0;
      await assert.rejects(
        resolveLinkedSiteToken(
          { siteId: '123', redactor },
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
  });
});
