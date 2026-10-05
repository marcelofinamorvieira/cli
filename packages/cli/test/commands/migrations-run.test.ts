import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import Command from '../../src/commands/migrations/run';

type Options = {
  inPlace?: boolean;
  allowPrimary?: boolean;
  dryRun?: boolean;
  missingTrackingModel?: boolean;
  failReceipt?: boolean;
  failCleanup?: boolean;
  realOutput?: boolean;
  json?: boolean;
  waitForScript?: () => Promise<void>;
};

async function fixture(scripts: Record<string, string>, options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-migrations-'));
  for (const [name, source] of Object.entries(scripts))
    await writeFile(join(directory, name), source);
  const events: string[] = [];
  const messages: string[] = [];
  const main = { id: 'main', meta: { primary: true } };
  const model = { id: 'tracking-model-id', api_key: 'custom_migration' };
  const rootClient = {
    config: { apiToken: null, baseUrl: 'https://example.invalid' },
    environments: {
      list: async () => [main],
      fork: async (source: string, destination: { id: string }) => {
        events.push(`fork:${source}:${destination.id}`);
        return { id: destination.id };
      },
      destroy: async (id: string) => {
        events.push(`destroy:${id}`);
        if (options.failCleanup) throw new Error('cleanup failed');
      },
    },
  };
  const envClient = {
    config: {
      ...rootClient.config,
      environment: options.inPlace ? 'main' : 'main-post-migrations',
    },
    events,
    waitForScript: options.waitForScript,
    itemTypes: {
      find: async () => {
        if (options.missingTrackingModel)
          throw new CmaClient.ApiError({
            request: { method: 'GET', url: '/item-types', headers: {} },
            response: { status: 404, statusText: 'Not found', headers: {} },
          });
        return model;
      },
      create: async () => {
        events.push('tracking-model:create');
        return model;
      },
    },
    fields: {
      create: async () => {
        events.push('tracking-field:create');
      },
    },
    items: {
      async *listPagedIterator() {},
      create: async (value: { name: string }) => {
        events.push(`receipt:${value.name}`);
        if (options.failReceipt) throw new Error('receipt failed');
      },
    },
  };
  const command: Command = Object.assign(Object.create(Command.prototype), {
    client: rootClient,
    datoProfileConfig: {
      migrations: { directory, modelApiKey: model.api_key },
    },
    datoConfigPath: join(directory, 'datocms.config.json'),
    requireDatoProfileConfig() {},
    parse: async () => ({
      flags: {
        'in-place': options.inPlace,
        'allow-primary': options.allowPrimary,
        'dry-run': options.dryRun,
      },
    }),
    buildClient: async () => envClient,
    startSpinner() {},
    stopSpinner() {},
    stopSpinnerWithFailure() {},
    log(message: string) {
      messages.push(message);
    },
    warn() {},
    error(message: string): never {
      throw new Error(message);
    },
  });
  if (options.realOutput) {
    const overrides = command as unknown as Record<string, unknown>;
    for (const name of [
      'log',
      'startSpinner',
      'stopSpinner',
      'stopSpinnerWithFailure',
    ])
      delete overrides[name];
    overrides.jsonEnabled = () => options.json === true;
  }
  return {
    directory,
    events,
    messages,
    run: () => command.run(),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

const managed = `
export default async function(client, context) {
  context.activate({ discardOwnedForkOnFailure: true });
  client.events.push('managed:write');
}
`;

async function captureOutput(work: (read: () => string) => Promise<void>) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let output = '';
  const write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = write;
  process.stderr.write = write;
  try {
    await work(() => output);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe('native migration execution context', () => {
  for (const json of [false, true]) {
    it(
      json
        ? 'suppresses managed progress in JSON mode'
        : 'prints managed progress before the migration resolves',
      async () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const running = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const marker = 'Managed progress while still running';
        const test = await fixture(
          {
            '1_progress.ts': `export default async function(client, context) {
            context.activate();
            context.log(${JSON.stringify(marker)});
            await client.waitForScript();
          }`,
          },
          {
            realOutput: true,
            json,
            waitForScript: () => {
              entered();
              return gate;
            },
          },
        );
        try {
          await captureOutput(async (read) => {
            let finished = false;
            const operation = test.run().then(() => {
              finished = true;
            });
            try {
              await running;
              assert.equal(finished, false);
              if (json) assert.equal(read(), '');
              else
                assert.ok(
                  read().includes(marker),
                  'progress must bypass spinner buffering',
                );
            } finally {
              release();
              await operation;
            }
            if (json) assert.equal(read(), '');
          });
        } finally {
          release();
          await test.dispose();
        }
      },
    );
  }

  it('keeps ordinary migration console output buffered by the spinner', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const marker = 'Ordinary schema migration output';
    const test = await fixture(
      {
        '1_ordinary.ts': `export default async function(client) {
        console.log(${JSON.stringify(marker)});
        await client.waitForScript();
      }`,
      },
      {
        realOutput: true,
        waitForScript: () => {
          entered();
          return gate;
        },
      },
    );
    try {
      await captureOutput(async (read) => {
        const operation = test.run();
        try {
          await running;
          assert.equal(read().includes(marker), false);
        } finally {
          release();
          await operation;
        }
        assert.ok(read().includes(marker));
      });
    } finally {
      release();
      await test.dispose();
    }
  });

  it('keeps ordinary default and CommonJS migrations compatible', async () => {
    const test = await fixture({
      '1_first.ts':
        'export default async function(client) { client.events.push("first"); }',
      '2_second.js':
        'module.exports = async function(client) { client.events.push("second"); };',
    });
    try {
      const result = await test.run();
      assert.equal(result.environmentId, 'main-post-migrations');
      assert.deepEqual(test.events, [
        'fork:main:main-post-migrations',
        'first',
        'receipt:1_first.ts',
        'second',
        'receipt:2_second.js',
      ]);
    } finally {
      await test.dispose();
    }
  });

  it('preserves ordinary failure behavior and leaves its fork', async () => {
    const test = await fixture({
      '1_fail.ts':
        'export default async function() { throw new Error("original"); }',
    });
    try {
      await assert.rejects(test.run(), /Migration "1_fail.ts" failed/);
      assert.deepEqual(test.events, ['fork:main:main-post-migrations']);
    } finally {
      await test.dispose();
    }
  });

  it('binds the exact environment, absolute script path, and tracking identity', async () => {
    for (const missingTrackingModel of [false, true]) {
      const test = await fixture(
        {
          '1_managed.ts': `
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
export default async function(client, context) {
  context.activate({ discardOwnedForkOnFailure: true });
  assert.equal(context.version, 1);
  assert(isAbsolute(context.migrationPath));
  assert.equal(context.environmentId, client.config.environment);
  assert.equal(context.sourceEnvironmentId, 'main');
  assert.equal(context.primaryEnvironmentId, 'main');
  assert.equal(context.inPlace, false);
  assert.equal(context.allowPrimary, false);
  assert.deepEqual(context.trackingModel, {
    id: 'tracking-model-id', apiKey: 'custom_migration', createdByThisRun: ${missingTrackingModel}
  });
  const other = context.buildEnvironmentClient('another-sandbox');
  assert.equal(other.config.environment, 'another-sandbox');
  assert.equal(other.config.baseUrl, client.config.baseUrl);
  assert.equal(context.rootClient.config.environment, undefined);
  client.events.push('managed:write');
}`,
        },
        { missingTrackingModel },
      );
      try {
        await test.run();
        assert.equal(
          test.events.filter((event) => event.startsWith('fork:')).length,
          1,
        );
        assert.equal(test.events.at(-1), 'receipt:1_managed.ts');
        assert(!test.events.some((event) => event.startsWith('destroy:')));
      } finally {
        await test.dispose();
      }
    }
  });

  it('preserves a managed failure and removes only the owned fork', async () => {
    const test = await fixture({
      '1_fail.ts': managed.replace(
        "client.events.push('managed:write');",
        "throw Object.assign(new Error('original'), { code: 'CONTENT_FAILURE', oclif: { exit: 7 } });",
      ),
    });
    try {
      await assert.rejects(test.run(), (error: unknown) => {
        assert.equal((error as Error).message, 'original');
        assert.equal((error as { code: string }).code, 'CONTENT_FAILURE');
        assert.equal((error as { oclif: { exit: number } }).oclif.exit, 7);
        return true;
      });
      assert.deepEqual(test.events, [
        'fork:main:main-post-migrations',
        'destroy:main-post-migrations',
      ]);
    } finally {
      await test.dispose();
    }
  });

  it('keeps a managed fork unless cleanup was explicitly activated', async () => {
    const before = process.listenerCount('SIGINT');
    const test = await fixture({
      '1_fail.ts': managed
        .replace(
          'context.activate({ discardOwnedForkOnFailure: true });',
          'context.activate();',
        )
        .replace(
          "client.events.push('managed:write');",
          "throw new Error('managed failure');",
        ),
    });
    try {
      await assert.rejects(test.run(), /managed failure/);
      assert.deepEqual(test.events, ['fork:main:main-post-migrations']);
      assert.equal(process.listenerCount('SIGINT'), before);
    } finally {
      await test.dispose();
    }
  });

  it('cleans the owned fork if saving the completion receipt fails', async () => {
    const test = await fixture(
      { '1_managed.ts': managed },
      { failReceipt: true },
    );
    try {
      await assert.rejects(test.run(), /receipt failed/);
      assert.deepEqual(test.events, [
        'fork:main:main-post-migrations',
        'managed:write',
        'receipt:1_managed.ts',
        'destroy:main-post-migrations',
      ]);
    } finally {
      await test.dispose();
    }
  });

  it('never deletes an in-place environment even when cleanup is requested', async () => {
    const test = await fixture(
      { '1_managed.ts': managed },
      {
        inPlace: true,
        allowPrimary: true,
        failReceipt: true,
      },
    );
    try {
      await assert.rejects(test.run(), /receipt failed/);
      assert.deepEqual(test.events, ['managed:write', 'receipt:1_managed.ts']);
    } finally {
      await test.dispose();
    }
  });

  it('reports cleanup failure without replacing the original failure', async () => {
    const test = await fixture(
      { '1_managed.ts': managed },
      {
        failReceipt: true,
        failCleanup: true,
      },
    );
    try {
      await assert.rejects(test.run(), (error: unknown) => {
        assert.equal((error as Error).message, 'receipt failed');
        assert.equal(
          (error as { keptForkEnvironmentId: string }).keptForkEnvironmentId,
          'main-post-migrations',
        );
        assert.equal(
          (error as { cleanupError: string }).cleanupError,
          'cleanup failed',
        );
        return true;
      });
    } finally {
      await test.dispose();
    }
  });

  it('does not evaluate or activate scripts during a dry run', async () => {
    const test = await fixture(
      {
        '1_managed.ts': 'throw new Error("must not evaluate");',
      },
      { dryRun: true, missingTrackingModel: true },
    );
    try {
      await test.run();
      assert.deepEqual(test.events, []);
    } finally {
      await test.dispose();
    }
  });

  for (const [signal, exit] of [
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    it(`drains managed work before cleanup and preserves ${signal} exit status`, async () => {
      const before = process.listenerCount(signal);
      const outputListeners = [process.stdout, process.stderr].map(
        (stream) => ({
          stream,
          listeners: stream.listeners('error'),
        }),
      );
      const test = await fixture({
        '1_managed.ts': managed.replace(
          "client.events.push('managed:write');",
          `process.emit('${signal}');
           await new Promise((resolve) => setImmediate(resolve));
           client.events.push('drained');`,
        ),
      });
      try {
        await assert.rejects(test.run(), (error: unknown) => {
          assert.equal((error as { exitCode: number }).exitCode, exit);
          assert.equal((error as { oclif: { exit: number } }).oclif.exit, exit);
          return true;
        });
        assert.deepEqual(test.events, [
          'fork:main:main-post-migrations',
          'drained',
          'destroy:main-post-migrations',
        ]);
        assert.equal(process.listenerCount(signal), before);
      } finally {
        for (const { stream, listeners } of outputListeners) {
          stream.removeAllListeners('error');
          for (const listener of listeners)
            stream.on('error', listener as (error: Error) => void);
        }
        await test.dispose();
      }
    });
  }
});
