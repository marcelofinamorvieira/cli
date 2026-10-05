import assert from 'node:assert/strict';
import {
  CmaClient,
  CmaClientCommand,
  DatoConfigCommand,
  DatoProfileConfigCommand,
} from '@datocms/cli-utils';
import { describe, it } from 'mocha';
import ContentDiffCommand from '../../src/commands/content/diff';
import {
  CredentialRedactor,
  REDACTED_CREDENTIAL,
} from '../../src/utils/credential-redaction';
import {
  profileApiTokenEnvironmentName,
  resolveProfileApiToken,
} from '../../src/utils/profile-auth';

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

describe('credential redaction', () => {
  it('redacts raw, JSON-escaped and URL-encoded tokens and leaves other text unchanged', () => {
    const redactor = new CredentialRedactor();
    const token = 'tok"en/with+chars\\end';
    redactor.register(token, undefined, null, '');
    assert.equal(
      redactor.redact(
        [
          `raw ${token}`,
          `json ${JSON.stringify({ token })}`,
          `url https://site-api.datocms.com/items?api_token=${encodeURIComponent(
            token,
          )}&page=1`,
        ].join('\n'),
      ),
      [
        `raw ${REDACTED_CREDENTIAL}`,
        `json {"token":"${REDACTED_CREDENTIAL}"}`,
        `url https://site-api.datocms.com/items?api_token=${REDACTED_CREDENTIAL}&page=1`,
      ].join('\n'),
    );
    const plain =
      '[1] GET https://site-api.datocms.com/items?page=1\n"title": "Bearer of good news"';
    assert.equal(redactor.redact(plain), plain);
  });

  it('replaces a token that contains another registered token as a whole', () => {
    const redactor = new CredentialRedactor();
    redactor.register('shared-prefix');
    redactor.register('shared-prefix-and-suffix');
    assert.equal(
      redactor.redact('shared-prefix-and-suffix shared-prefix'),
      `${REDACTED_CREDENTIAL} ${REDACTED_CREDENTIAL}`,
    );
  });

  it('hides Authorization header values, keeping the scheme, even for unregistered tokens', () => {
    const redactor = new CredentialRedactor();
    assert.equal(
      redactor.redact(
        '[12] authorization: Bearer unknown-token\n[12] Authorization: unknown-token\n[12] authorization: [REDACTED, ending in oken]',
      ),
      [
        `[12] authorization: Bearer ${REDACTED_CREDENTIAL}`,
        `[12] Authorization: ${REDACTED_CREDENTIAL}`,
        `[12] authorization: ${REDACTED_CREDENTIAL}`,
      ].join('\n'),
    );
    const error = {
      request: {
        headers: {
          Authorization: 'Bearer unknown-token',
          authorization: '[REDACTED, ending in oken]',
          'X-Environment': 'main',
        },
      },
    };
    redactor.redactError(error);
    assert.deepEqual(error.request.headers, {
      Authorization: `Bearer ${REDACTED_CREDENTIAL}`,
      authorization: REDACTED_CREDENTIAL,
      'X-Environment': 'main',
    });
  });

  it('registers client tokens and wraps every log function, including the console default', () => {
    const redactor = new CredentialRedactor();
    const logged: string[] = [];
    const withLogFunction = redactor.protectClientOptions({
      apiToken: 'first-client-token',
      logFn: (message: string) => logged.push(message),
    });
    const withoutLogFunction = redactor.protectClientOptions({
      apiToken: 'second-client-token',
    });
    const previousConsoleLog = console.log;
    try {
      console.log = (message: string) => logged.push(`console ${message}`);
      withLogFunction.logFn('[1] body echoes second-client-token');
      withoutLogFunction.logFn('[2] body echoes first-client-token');
    } finally {
      console.log = previousConsoleLog;
    }
    assert.equal(withLogFunction.apiToken, 'first-client-token');
    assert.deepEqual(logged, [
      `[1] body echoes ${REDACTED_CREDENTIAL}`,
      `console [2] body echoes ${REDACTED_CREDENTIAL}`,
    ]);
  });

  it('redacts nested error bodies, messages and causes in place', () => {
    const redactor = new CredentialRedactor();
    const token = 'error-token-Zq9X';
    redactor.register(token);
    const error = new CmaClient.ApiError({
      request: {
        url: `https://site-api.datocms.com/items?api_token=${token}`,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { data: { attributes: { echoed: [`value ${token}`] } } },
      },
      response: {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {},
        body: {
          data: [
            {
              id: 'error',
              type: 'api_error',
              attributes: {
                code: 'INVALID_FIELD',
                details: { value: JSON.stringify({ token }) },
              },
            },
          ],
        },
      },
    });
    const cyclic: Record<string, unknown> = { note: `cyclic ${token}` };
    cyclic.self = cyclic;
    Reflect.set(error, 'context', cyclic);
    const wrapper = new Error(`Apply failed with ${token}`, {
      cause: new Error(`Inner ${encodeURIComponent(token)} failure`, {
        cause: error,
      }),
    });
    redactor.redactError(wrapper);
    const cause = wrapper.cause as Error;
    assert.equal(wrapper.message, `Apply failed with ${REDACTED_CREDENTIAL}`);
    assert.equal(cause.message, `Inner ${REDACTED_CREDENTIAL} failure`);
    for (const text of [
      wrapper.stack,
      cause.stack,
      error.message,
      error.stack,
      JSON.stringify({
        request: error.request,
        response: error.response,
        note: cyclic.note,
      }),
    ])
      assert.doesNotMatch(String(text), /error-token|Zq9X/);
    assert.equal(
      error.request.headers.Authorization,
      `Bearer ${REDACTED_CREDENTIAL}`,
    );
    assert.equal(error.request.method, 'POST');
    assert.equal(error.response.status, 422);
    assert.ok(error.findError('INVALID_FIELD'));
    assert.doesNotThrow(() =>
      redactor.redactError(Object.freeze({ note: `frozen ${token}` })),
    );
  });

  it('keeps real CMA client logs and API errors free of the token', async () => {
    const redactor = new CredentialRedactor();
    const token = 'client-token-Zq9X';
    const logged: string[] = [];
    const client = CmaClient.buildClient(
      redactor.protectClientOptions({
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
                  attributes: {
                    code: 'INVALID_FIELD',
                    details: { echoed: token },
                  },
                },
              ],
            }),
            {
              status: 422,
              headers: { 'content-type': 'application/json' },
            },
          )) as unknown as typeof fetch,
      }),
    );
    const error = await client.site.find().then(
      () => assert.fail('the request should fail'),
      (failure: Error) => failure,
    );
    redactor.redactError(error);
    // The client masks the header itself, keeping the last characters.
    assert.match(logged.join('\n'), /^\[\d+\] authorization: \[REDACTED\]$/m);
    assert.match(logged.join('\n'), /INVALID_FIELD/);
    for (const text of [
      logged.join('\n'),
      error.message,
      error.stack,
      JSON.stringify({
        request: Reflect.get(error, 'request'),
        response: Reflect.get(error, 'response'),
      }),
    ])
      assert.doesNotMatch(String(text), /client-token|Zq9X/);
  });
});

describe('profile authentication', () => {
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
          return siteId === 'linked-site' ? 'linked-token' : undefined;
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
              profileConfig: { ...profileConfig, siteId: 'unlinked-site' },
              profileId: 'source',
              resolveLinkedSiteToken,
            })
          ).apiToken,
          'environment-token',
        );
        assert.deepEqual(linked, [
          ['linked-site', 'linked-organization'],
          ['unlinked-site', 'linked-organization'],
        ]);
      },
    );
  });

  it('relies only on cli-utils internals that exist', () => {
    for (const member of [
      Reflect.get(CmaClientCommand.prototype, 'resolveTokenFromSiteId'),
      Reflect.get(DatoConfigCommand.prototype, 'init'),
      Reflect.get(DatoProfileConfigCommand.prototype, 'init'),
    ])
      assert.equal(typeof member, 'function');
  });

  it('builds paired-profile endpoints with their own tokens and shared redaction', async () => {
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
            resolveTokenFromSiteId: async (
              siteId: string,
              organizationId?: string,
            ) => {
              linked.push([siteId, organizationId]);
              return 'destination-linked-token';
            },
            log: (message: string) => logged.push(message),
          },
        );
        const source = await command.endpoint('source');
        const destination = await command.endpoint('destination');
        const overridden = await command.endpoint(
          'destination',
          'destination-flag-token',
        );
        const sandbox = source.buildEnvironmentClient('sandbox');
        assert.deepEqual(linked, [
          ['destination-site', 'destination-organization'],
        ]);
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
            ['destination-linked-token', CmaClient.LogLevel.BODY, undefined],
            ['destination-flag-token', CmaClient.LogLevel.BODY, undefined],
          ],
        );
        assert.deepEqual(
          [sandbox.config.apiToken, sandbox.config.environment],
          ['source-environment-token', 'sandbox'],
        );
        source.rootClient.config.logFn?.(
          '[1] echoes destination-linked-token and destination-flag-token',
        );
        destination.rootClient.config.logFn?.(
          '[2] authorization: Bearer source-environment-token',
        );
        assert.deepEqual(logged, [
          `[1] echoes ${REDACTED_CREDENTIAL} and ${REDACTED_CREDENTIAL}`,
          `[2] authorization: Bearer ${REDACTED_CREDENTIAL}`,
        ]);
        json = true;
        assert.equal(
          (await command.endpoint('destination')).rootClient.config.logLevel,
          CmaClient.LogLevel.NONE,
        );
        json = false;
        assert.equal(
          (await command.endpoint('destination')).rootClient.config.logLevel,
          CmaClient.LogLevel.BODY,
        );
        await assert.rejects(
          command.endpoint('missing'),
          /Profile "missing" is not defined in "datocms.config.json"/,
        );
        await assert.rejects(
          command.endpoint('empty'),
          /No API token is available for profile "empty".*CONTENT_DIFF_MISSING_TOKEN/,
        );
      },
    );
  });

  it('redacts the single-project client token from request logs', async () => {
    const logged: string[] = [];
    const command = Object.assign(Object.create(ContentDiffCommand.prototype), {
      parse: async () => ({
        flags: {
          output: './bundle',
          'api-token': 'single-project-token',
          'log-level': 'BODY_AND_HEADERS',
        },
      }),
      profileId: 'default',
      log: (message: string) => logged.push(message),
    });
    const { rootClient, buildEnvironmentClient } = await command.endpoint();
    rootClient.config.logFn?.('[1] authorization: Bearer single-project-token');
    buildEnvironmentClient('sandbox').config.logFn?.(
      '[2] body echoes single-project-token',
    );
    assert.equal(rootClient.config.apiToken, 'single-project-token');
    assert.equal(logged.length, 2);
    assert.match(logged[0], /\[1\] authorization: Bearer \[REDACTED\]/);
    assert.match(logged[1], /\[2\] body echoes \[REDACTED\]/);
    assert.doesNotMatch(logged.join('\n'), /single-project-token/);
  });
});
