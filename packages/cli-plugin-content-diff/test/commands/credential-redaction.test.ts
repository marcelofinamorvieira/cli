import { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import {
  CredentialRedactor,
  REDACTED_CREDENTIAL,
} from '../../src/utils/credential-redaction';

describe('credential redaction', () => {
  it('redacts raw, JSON-escaped, and URL-encoded forms of every registered token', () => {
    const redactor = new CredentialRedactor();
    const credential = 'tok"en/with+chars';
    redactor.register(credential, undefined, null, '');

    const output = redactor.redact(
      [
        `raw ${credential}`,
        `json ${JSON.stringify({ token: credential })}`,
        `url ?token=${encodeURIComponent(credential)}`,
      ].join('\n'),
    );

    expect(output).to.equal(
      [
        `raw ${REDACTED_CREDENTIAL}`,
        `json {"token":"${REDACTED_CREDENTIAL}"}`,
        `url ?token=${REDACTED_CREDENTIAL}`,
      ].join('\n'),
    );
  });

  it('replaces a token that contains another registered token as a whole', () => {
    const redactor = new CredentialRedactor();
    redactor.register('shared-prefix');
    redactor.register('shared-prefix-and-suffix');

    expect(redactor.redact('shared-prefix-and-suffix shared-prefix')).to.equal(
      `${REDACTED_CREDENTIAL} ${REDACTED_CREDENTIAL}`,
    );
  });

  it('hides Authorization header log lines even for an unregistered token', () => {
    const redactor = new CredentialRedactor();

    expect(
      redactor.redact('[12] authorization: Bearer unknown-token'),
    ).to.equal(`[12] authorization: Bearer ${REDACTED_CREDENTIAL}`);
    expect(redactor.redact('[12] Authorization: unknown-token')).to.equal(
      `[12] Authorization: ${REDACTED_CREDENTIAL}`,
    );
    expect(redactor.redact('"title": "Bearer of good news"')).to.equal(
      '"title": "Bearer of good news"',
    );
  });

  it('drops the last characters the CMA client keeps in its own masked header', () => {
    const redactor = new CredentialRedactor();
    const error = {
      request: {
        headers: { authorization: '[REDACTED, ending in oken]' },
      },
    };

    expect(
      redactor.redact('[12] authorization: [REDACTED, ending in oken]'),
    ).to.equal(`[12] authorization: ${REDACTED_CREDENTIAL}`);
    redactor.redactError(error);
    expect(error.request.headers.authorization).to.equal(REDACTED_CREDENTIAL);
  });

  it('registers client tokens and wraps every log function, including the console default', () => {
    const redactor = new CredentialRedactor();
    const logged: string[] = [];
    const withLogFunction = redactor.protectClientOptions({
      apiToken: 'client-credential',
      logFn: (message: string) => logged.push(message),
    });
    const withoutLogFunction = redactor.protectClientOptions({
      apiToken: 'second-client-credential',
    });
    const previousConsoleLog = console.log;

    try {
      console.log = (message: string) => logged.push(`console ${message}`);
      withLogFunction.logFn('[1] body echoes second-client-credential');
      withoutLogFunction.logFn('[2] body echoes client-credential');
    } finally {
      console.log = previousConsoleLog;
    }

    expect(withLogFunction.apiToken).to.equal('client-credential');
    expect(logged).to.deep.equal([
      `[1] body echoes ${REDACTED_CREDENTIAL}`,
      `console [2] body echoes ${REDACTED_CREDENTIAL}`,
    ]);
  });

  it('redacts API errors in place before they are reported', () => {
    const redactor = new CredentialRedactor();
    redactor.register('error-credential');
    const error = new CmaClient.ApiError({
      request: {
        url: 'https://site-api.datocms.com/items?token=error-credential',
        method: 'POST',
        headers: { authorization: 'Bearer error-credential' },
        body: { nested: ['echo error-credential'] },
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
                details: { value: 'error-credential' },
              },
            },
          ],
        },
      },
    });
    const cyclic: Record<string, unknown> = { note: 'error-credential' };
    cyclic.self = cyclic;
    Reflect.set(error, 'context', cyclic);
    Reflect.set(error, 'frozen', Object.freeze({ note: 'error-credential' }));

    redactor.redactError(error);

    expect(error.request.headers.authorization).to.equal(
      `Bearer ${REDACTED_CREDENTIAL}`,
    );
    expect(error.request.url).to.equal(
      `https://site-api.datocms.com/items?token=${REDACTED_CREDENTIAL}`,
    );
    expect(error.message).not.to.contain('error-credential');
    expect(String(error.stack)).not.to.contain('error-credential');
    expect(
      JSON.stringify({
        request: error.request,
        response: error.response,
        context: { note: cyclic.note },
      }),
    ).not.to.contain('error-credential');
    expect(error.findError('INVALID_FIELD')).not.to.equal(undefined);
  });

  it('hides Authorization headers of errors raised by unregistered clients', () => {
    const redactor = new CredentialRedactor();
    const error = new CmaClient.TimeoutError({
      request: {
        url: 'https://site-api.datocms.com/site',
        method: 'GET',
        headers: { Authorization: 'Bearer unregistered-credential' },
      },
    });

    redactor.redactError(error);

    expect(error.request.headers.Authorization).to.equal(
      `Bearer ${REDACTED_CREDENTIAL}`,
    );
  });
});
