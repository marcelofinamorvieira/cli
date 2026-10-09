import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { describe, it } from 'mocha';
import ContentApplyCommand from '../src/commands/content/apply';
import ContentDiffCommand from '../src/commands/content/diff';
import ContentExportCommand from '../src/commands/content/export';
import {
  ContentError,
  DESTINATION_CHANGED_MESSAGE,
  contentErrorReport,
  destinationChanged,
} from '../src/engine/errors';

const root = resolve(__dirname, '..');
const commands = [
  ContentApplyCommand,
  ContentDiffCommand,
  ContentExportCommand,
];

type NativeError = { suggestions?: string[]; oclif?: { exit?: number } };

describe('content error reporting contract', () => {
  it('reports only the documented error fields', () => {
    const failure = Object.assign(new Error('Request failed'), {
      code: 'APPLY_FAILED',
      details: { step: 'records' },
      suggestions: ['Retry', 3],
      keptForkEnvironmentId: 'review-kept',
      outcome: 'The fork "review-kept" was kept.',
      parse: { input: { argv: ['--api-token=flag-token'] } },
      request: { headers: { Authorization: 'Bearer header-token' } },
    });
    // The JSON message also says what the failure left behind.
    assert.deepEqual(contentErrorReport(failure), {
      name: 'Error',
      message: 'Request failed The fork "review-kept" was kept.',
      code: 'APPLY_FAILED',
      details: { step: 'records' },
      suggestions: ['Retry'],
      keptForkEnvironmentId: 'review-kept',
    });
  });

  it('preserves existing signal exit codes with frozen errors', async () => {
    const reported: unknown[] = [];
    const command = Object.assign(
      Object.create(ContentApplyCommand.prototype),
      {
        jsonEnabled: () => true,
        logJson: (value: unknown) => reported.push(value),
      },
    );
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 143;
      await command.catch(
        Object.freeze(
          Object.assign(new Error('Frozen failure.'), {
            exitCode: 1,
            keptForkEnvironmentId: 'kept-fork',
          }),
        ),
      );
      assert.equal(process.exitCode, 143);
      assert.deepEqual(JSON.parse(JSON.stringify(reported)), [
        {
          error: {
            name: 'Error',
            message: 'Frozen failure.',
            keptForkEnvironmentId: 'kept-fork',
          },
        },
      ]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('reports CMA authorization failures natively, and as JSON without the request', async () => {
    const native = {
      INVALID_AUTHORIZATION_HEADER: /^Invalid API token$/,
      INSUFFICIENT_PERMISSIONS: /does not have the necessary permission/,
    };
    for (const [code, message] of Object.entries(native)) {
      const failure = (context = {}) =>
        Object.assign(
          new CmaClient.ApiError({
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
                    attributes: { code, details: {} },
                  },
                ],
              },
            },
          }),
          context,
        );
      for (const Command of commands) {
        const reported: unknown[] = [];
        const json = Object.assign(Object.create(Command.prototype), {
          jsonEnabled: () => true,
          logJson: (value: unknown) => reported.push(value),
        });
        const previousExitCode = process.exitCode;
        try {
          process.exitCode = undefined;
          await json.catch(
            failure({ keptForkEnvironmentId: 'retained-review' }),
          );
          assert.equal(process.exitCode, 1);
        } finally {
          process.exitCode = previousExitCode;
        }
        const output = JSON.stringify(reported);
        const [{ error }] = JSON.parse(output);
        assert.equal(error.code, code);
        assert.equal(error.keptForkEnvironmentId, 'retained-review');
        assert.doesNotMatch(output, /cma-error-token|Authorization|request/);
      }
      // Human output goes through CmaClientCommand's handler, which dumps the
      // error before replacing it with its own message and suggestions.
      const { log, dir } = console;
      console.log = () => undefined;
      console.dir = () => undefined;
      try {
        for (const Command of commands) {
          const human = Object.assign(Object.create(Command.prototype), {
            jsonEnabled: () => false,
          });
          await assert.rejects(
            human.catch(failure()),
            (error: Error & NativeError) => {
              assert.match(error.message, message);
              assert.ok(error.suggestions?.length);
              assert.equal(error.oclif?.exit, 2);
              return true;
            },
          );
        }
        // What the failure left behind follows the native message.
        const human = Object.assign(
          Object.create(ContentApplyCommand.prototype),
          { jsonEnabled: () => false },
        );
        await assert.rejects(
          human.catch(
            failure({
              keptForkEnvironmentId: 'review',
              outcome: 'The fork "review" was kept.',
            }),
          ),
          (error: Error & NativeError) => {
            const [first, ...rest] = error.message.split('\n');
            assert.match(first!, message);
            assert.deepEqual(rest, ['The fork "review" was kept.']);
            assert.ok(error.suggestions?.length);
            assert.equal(error.oclif?.exit, 2);
            return true;
          },
        );
      } finally {
        Object.assign(console, { log, dir });
      }
    }
  });

  it('prints the failure details before the message and what the failure left behind', async () => {
    const human = Object.assign(Object.create(ContentApplyCommand.prototype), {
      jsonEnabled: () => false,
    });
    const failure = Object.assign(new Error('Operation failed'), {
      outcome: 'The fork "review" was deleted; "main" was not changed.',
    });
    const dumped: unknown[] = [];
    const { log, dir } = console;
    console.log = () => undefined;
    console.dir = (value: unknown) => dumped.push(value);
    try {
      await assert.rejects(human.catch(failure), (error: Error) => {
        assert.equal(
          error.message,
          'Operation failed\nThe fork "review" was deleted; "main" was not changed.',
        );
        return true;
      });
    } finally {
      Object.assign(console, { log, dir });
    }
    // The stack of the failure stays visible for debugging.
    assert.equal(dumped.length, 1);
    assert.equal((dumped[0] as { stack?: string }).stack, failure.stack);
  });

  it('prints the destination-changed message, its first difference and a kept fork', async () => {
    const human = Object.assign(Object.create(ContentApplyCommand.prototype), {
      jsonEnabled: () => false,
      logJson: () => assert.fail(),
    });
    const failure = destinationChanged({
      kind: 'record',
      id: 'abc',
      reason: 'changed',
    });
    await assert.rejects(human.catch(failure), (error: Error) => {
      assert.equal(
        error.message,
        `${DESTINATION_CHANGED_MESSAGE}\nFirst difference: record abc was changed.`,
      );
      return true;
    });
    // The first difference comes before what the failure left behind.
    const kept = Object.assign(
      destinationChanged({ kind: 'upload', id: 'u1', reason: 'added' }),
      {
        keptForkEnvironmentId: 'review',
        outcome: 'The fork "review" was kept.',
      },
    );
    await assert.rejects(human.catch(kept), (error: Error) => {
      assert.equal(
        error.message,
        `${DESTINATION_CHANGED_MESSAGE}\nFirst difference: upload u1 was added.\nThe fork "review" was kept.`,
      );
      return true;
    });
    const interrupted = Object.assign(
      new ContentError('INTERRUPTED', 'Content operation was interrupted.'),
      {
        keptForkEnvironmentId: 'review',
        outcome: 'The fork "review" was kept.',
        exitCode: 130,
      },
    );
    await assert.rejects(
      human.catch(interrupted),
      (error: Error & { oclif?: { exit?: number } }) => {
        assert.equal(
          error.message,
          'Content operation was interrupted.\nThe fork "review" was kept.',
        );
        assert.equal(error.oclif?.exit, 130);
        return true;
      },
    );
    const failedFork = Object.assign(
      new ContentError('FORK_FAILED', 'Fork "review" ended in status failed.'),
      {
        keptForkEnvironmentId: 'review',
        outcome: 'The fork "review" was kept.',
      },
    );
    await assert.rejects(human.catch(failedFork), (error: Error) => {
      assert.equal(
        error.message,
        'Fork "review" ended in status failed.\nThe fork "review" was kept.',
      );
      return true;
    });
    const cleanup = Object.assign(
      new ContentError(
        'APPLY_FAILED_CLEANUP_INCOMPLETE',
        `${DESTINATION_CHANGED_MESSAGE} The failed fork "review" could not be removed: Error: offline`,
        {
          forkId: 'review',
          cause: { code: 'DESTINATION_CHANGED', details: { reason: 'schema' } },
        },
      ),
      { keptForkEnvironmentId: 'review' },
    );
    await assert.rejects(human.catch(cleanup), (error: Error) => {
      assert.equal(
        error.message,
        `${cleanup.message}\nFirst difference: the schema changed.`,
      );
      return true;
    });
    const reported: unknown[] = [];
    const json = Object.assign(Object.create(ContentApplyCommand.prototype), {
      jsonEnabled: () => true,
      logJson: (value: unknown) => reported.push(value),
    });
    const previousExitCode = process.exitCode;
    try {
      await json.catch(destinationChanged({ reason: 'schema' }));
    } finally {
      process.exitCode = previousExitCode;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(reported)), [
      {
        error: {
          name: 'ContentError',
          message: DESTINATION_CHANGED_MESSAGE,
          code: 'DESTINATION_CHANGED',
          details: { reason: 'schema' },
        },
      },
    ]);
  });

  it('reports a kept fork from the actual JSON command without credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-error-command-'));
    const preload = join(directory, 'inject-fork-failure.cjs');
    try {
      await writeFile(
        preload,
        `
        const apply = require(${JSON.stringify(
          join(root, 'src/engine/apply.ts'),
        )});
        apply.applyContentDiff = async () => {
          throw Object.assign(new Error('Fork request failed.'), {
            keptForkEnvironmentId: 'kept-review',
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
          './diff.zip',
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
          message: 'Fork request failed.',
          keptForkEnvironmentId: 'kept-review',
        },
      });
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /fixture-api-token|authorization|argv|headers/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }).timeout(120_000);
});
