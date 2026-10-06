import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { describe, it } from 'mocha';
import ContentApplyCommand from '../../src/commands/content/apply';
import { contentErrorReport } from '../../src/engine/errors';
import { CredentialRedactor } from '../../src/utils/credential-redaction';

const root = resolve(__dirname, '../..');

describe('content error reporting contract', () => {
  it('copies and sanitizes frozen report data without exposing parsed flags or invoking getters', () => {
    const token = 'secret-report-token';
    const details: Record<string, unknown> = {
      note: token,
      nested: Object.freeze({ Authorization: 'Bearer unregistered-token' }),
      toJSON: () => assert.fail('Custom serialization must not run'),
      get unsafe() {
        return assert.fail('Error report getters must not run');
      },
    };
    details.self = details;
    Object.freeze(details);
    const failure = Object.freeze(
      Object.assign(new Error(`Request with ${token} failed`), {
        details,
        suggestions: [`Rotate ${token}`, 3],
        unconfirmedForkEnvironmentId: 'review-unknown',
        parse: { input: { argv: ['--api-token=unregistered-token'] } },
        request: { headers: { Authorization: 'Bearer unregistered-token' } },
      }),
    );
    const redactor = new CredentialRedactor();
    redactor.register(token);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(redactor.redactJsonValue(contentErrorReport(failure))),
      ),
      {
        name: 'Error',
        message: 'Request with [REDACTED] failed',
        details: {
          note: '[REDACTED]',
          nested: { Authorization: 'Bearer [REDACTED]' },
          self: '[Circular]',
        },
        suggestions: ['Rotate [REDACTED]'],
        unconfirmedForkEnvironmentId: 'review-unknown',
      },
    );
    assert.equal(details.note, token);
  });

  it('preserves existing signal exit codes with sanitized frozen errors', async () => {
    const reported: unknown[] = [];
    const command = Object.assign(
      Object.create(ContentApplyCommand.prototype),
      {
        jsonEnabled: () => true,
        logJson: (value: unknown) => reported.push(value),
      },
    );
    command.credentialRedactor.register('frozen-token');
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 143;
      await command.catch(
        Object.freeze(
          Object.assign(new Error('frozen-token'), {
            exitCode: 1,
            unconfirmedForkEnvironmentId: 'uncertain-fork',
          }),
        ),
      );
      assert.equal(process.exitCode, 143);
      assert.deepEqual(JSON.parse(JSON.stringify(reported)), [
        {
          error: {
            name: 'Error',
            message: '[REDACTED]',
            unconfirmedForkEnvironmentId: 'uncertain-fork',
          },
        },
      ]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('keeps CMA authorization suggestions and fork context without request credentials', async () => {
    for (const code of [
      'INVALID_AUTHORIZATION_HEADER',
      'INSUFFICIENT_PERMISSIONS',
    ]) {
      const reported: unknown[] = [];
      const command = Object.assign(
        Object.create(ContentApplyCommand.prototype),
        {
          jsonEnabled: () => true,
          logJson: (value: unknown) => reported.push(value),
        },
      );
      command.credentialRedactor.register('cma-error-token');
      const failure = new CmaClient.ApiError({
        request: {
          url: 'https://site-api.datocms.com/environments',
          method: 'POST',
          headers: { Authorization: 'Bearer cma-error-token' },
        },
        response: {
          status: 403,
          statusText: 'Forbidden',
          headers: {},
          body: {
            data: [
              {
                id: 'error',
                type: 'api_error',
                attributes: { code, details: { token: 'cma-error-token' } },
              },
            ],
          },
        },
      });
      Object.assign(failure, { keptForkEnvironmentId: 'retained-review' });
      const previousExitCode = process.exitCode;
      try {
        process.exitCode = undefined;
        await command.catch(failure);
        assert.equal(process.exitCode, 1);
      } finally {
        process.exitCode = previousExitCode;
      }
      const output = JSON.stringify(reported);
      const [{ error }] = JSON.parse(output);
      assert.equal(error.code, code);
      assert.equal(error.keptForkEnvironmentId, 'retained-review');
      assert.ok(error.suggestions.length);
      assert.doesNotMatch(output, /cma-error-token|Authorization|request/);
    }
  });

  it('reports uncertain fork ownership from the actual JSON command without credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-error-command-'));
    const preload = join(directory, 'inject-fork-failure.cjs');
    try {
      await writeFile(
        preload,
        `
        const { ContentCommand } = require(${JSON.stringify(
          join(root, 'src/utils/content-command.ts'),
        )});
        const migration = require(${JSON.stringify(
          join(root, 'src/migration.ts'),
        )});
        ContentCommand.prototype.endpoint = async function () {
          this.credentialRedactor.register('fixture-api-token');
          return { rootClient: {}, buildEnvironmentClient: () => ({}) };
        };
        migration.applyContentMigration = async () => {
          throw Object.assign(new Error('Fork request failed for fixture-api-token'), {
            unconfirmedForkEnvironmentId: 'unconfirmed-review',
            request: { headers: { authorization: 'Bearer fixture-api-token' } },
            parse: { input: { argv: ['--api-token=fixture-api-token'] } },
          });
        };
      `,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--require',
          require.resolve('ts-node/register'),
          '--require',
          preload,
          join(root, 'bin/dev'),
          'content:apply',
          './migration.ts',
          '--json',
          '--api-token=fixture-api-token',
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            ...process.env,
            TS_NODE_PROJECT: join(root, 'tsconfig.json'),
            DATOCMS_CONFIG_FILE: join(directory, 'missing.json'),
          },
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        error: {
          name: 'Error',
          message: 'Fork request failed for [REDACTED]',
          unconfirmedForkEnvironmentId: 'unconfirmed-review',
        },
      });
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /fixture-api-token|authorization|argv|headers/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
