import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hook } from '@oclif/core';
import { CONTENT_DIFF_PLUGIN_NAME } from '../../src/compat/datocms-version';
import hook from '../../src/hooks/init/check-datocms-version';

type FakeCommand = {
  aliases: string[];
  hidden: boolean;
  hiddenAliases: string[];
  id: string;
  load: () => Promise<unknown>;
  source: 'content-diff' | 'stock';
};

type HostOptions = Readonly<{
  extraPluginRoots?: string[];
  /** Ids whose `findCommand` lookup throws, as a host with another shape might. */
  failingLookups?: string[];
  /** Makes reading the plugin's command list throw. */
  failingPluginCommands?: boolean;
  /** Replacement whose descriptor throws while it is copied over the stock one. */
  failingReplacement?: string;
  pluginRoot?: string;
  replacements?: string[];
  stockHiddenAliases?: Record<string, string[]>;
}>;

const repositoryRoot = resolve('.');
const unsupportedHostRoot = resolve('test/fixtures/datocms-5.0.0');

function fakeCommand(
  id: string,
  source: FakeCommand['source'],
  hiddenAliases: string[] = [],
): FakeCommand {
  return {
    aliases: [],
    hidden: false,
    hiddenAliases,
    id,
    load: async () => ({ source }),
    source,
  };
}

function fakeHost(hostRoot: string, options: HostOptions = {}) {
  const commands = new Map<string, FakeCommand>();
  const register = (command: FakeCommand) => {
    commands.set(command.id, command);
    // Mirrors Config.loadCommands, which stores a copy per alias id.
    for (const alias of command.hiddenAliases) {
      commands.set(alias, { ...command, hidden: true, id: alias });
    }
  };
  for (const id of ['environments:list', 'migrations:new', 'migrations:run']) {
    register(fakeCommand(id, 'stock', options.stockHiddenAliases?.[id]));
  }

  const plugin = {
    commands: (
      options.replacements ?? [
        'content:diff',
        'migrations:new',
        'migrations:run',
      ]
    ).map((id) => fakeCommand(id, 'content-diff')),
    name: CONTENT_DIFF_PLUGIN_NAME,
    root: options.pluginRoot ?? repositoryRoot,
  };
  const contentDiff = plugin.commands.find(
    (command) => command.id === 'content:diff',
  );
  if (contentDiff) register(contentDiff);

  const failingReplacement = plugin.commands.find(
    (command) => command.id === options.failingReplacement,
  );
  if (failingReplacement) {
    Object.defineProperty(failingReplacement, 'flags', {
      enumerable: true,
      get() {
        throw new Error('flags are unreadable');
      },
    });
  }
  if (options.failingPluginCommands) {
    Object.defineProperty(plugin, 'commands', {
      get() {
        throw new Error('commands are unreadable');
      },
    });
  }

  const config = {
    bin: 'datocms',
    findCommand: (id: string) => {
      if (options.failingLookups?.includes(id)) {
        throw new Error(`cannot look up ${id}`);
      }
      // Flexible taxonomy resolves permutations to the canonical descriptor.
      return commands.get(id === 'run:migrations' ? 'migrations:run' : id);
    },
    name: 'datocms',
    pjson: { oclif: {}, version: '4.2.0' },
    plugins: new Map([
      ...(options.extraPluginRoots ?? []).map(
        (root, index) =>
          [`other-plugin-${index}`, { commands: [], name: 'other', root }] as [
            string,
            unknown,
          ],
      ),
      [plugin.name, plugin],
    ]),
    root: hostRoot,
    version: '4.2.0',
  };

  return { commands, config };
}

async function runInitHook(
  config: ReturnType<typeof fakeHost>['config'],
  id: string | undefined,
  argv: string[] = [],
) {
  const warnings: string[] = [];
  const context = {
    debug() {},
    error(message: Error | string, options?: { exit?: number }): never {
      throw Object.assign(new Error(String(message)), {
        oclif: { exit: options?.exit },
      });
    },
    exit() {},
    log() {},
    warn(message: string) {
      warnings.push(message);
    },
  };
  await hook.call(
    context as unknown as Hook.Context,
    {
      argv,
      config,
      context,
      id,
    } as unknown as Parameters<Hook<'init'>>[0],
  );
  return warnings;
}

function exitsWith(pattern: RegExp) {
  return (error: Error & { oclif?: { exit?: number } }) => {
    assert.equal(error.oclif?.exit, 1);
    assert.match(error.message, pattern);
    return true;
  };
}

const describeRequest = (id: string | undefined, argv: string[]) =>
  ['datocms', id, ...argv].filter(Boolean).join(' ');

const brokenTakeoverFatal =
  /^Cannot activate content-diff's migrations:new and migrations:run commands: the installed plugin does not provide migrations:run\. The stock datocms migrations commands are never used in their place, because they skip content-diff's migration safeguards\. To fix it, reinstall the plugin with `datocms plugins:install @datocms\/cli-plugin-content-diff@\d[^`]*` \(or the tarball you installed it from\), or run `datocms plugins:remove @datocms\/cli-plugin-content-diff` to go back to the stock datocms migrations commands\.$/;

const brokenTakeoverWarning =
  /^content-diff's content:diff, migrations:new and migrations:run commands are unavailable: the installed plugin does not provide migrations:run\. To fix it, reinstall the plugin with `datocms plugins:install @datocms\/cli-plugin-content-diff@\d[^`]*` \(or the tarball you installed it from\), or run `datocms plugins:remove @datocms\/cli-plugin-content-diff` to go back to the stock datocms migrations commands\.$/;

const unexpectedFatal = (detail: string) =>
  new RegExp(
    `^Cannot activate content-diff's migrations:new and migrations:run commands: an unexpected error occurred \\(${detail}\\)\\. The stock datocms migrations commands are never used in their place, because they skip content-diff's migration safeguards\\. To fix it, reinstall the plugin with \`datocms plugins:install [^\`]+\` \\(or the tarball you installed it from\\), or run \`datocms plugins:remove @datocms/cli-plugin-content-diff\` to go back to the stock datocms migrations commands\\.$`,
  );

const unexpectedWarning = (detail: string) =>
  new RegExp(
    `^content-diff's content:diff, migrations:new and migrations:run commands are unavailable: an unexpected error occurred \\(${detail}\\)\\. To fix it, reinstall the plugin with \`datocms plugins:install [^\`]+\` \\(or the tarball you installed it from\\), or run \`datocms plugins:remove @datocms/cli-plugin-content-diff\` to go back to the stock datocms migrations commands\\.$`,
  );

const pinHint =
  /install a supported CLI with `npm install --save-dev datocms@\^4\.2\.0` \(or `npm install --global datocms@\^4\.2\.0` for a global install\)/;

const guardedRequests: [string | undefined, string[]][] = [
  ['migrations:run', ['--source=sandbox']],
  ['migrations:new', ['sync content']],
  ['content:diff', ['sync content']],
  ['migrations:run', ['--help']],
  ['content:diff', ['--help']],
  ['help', ['migrations:run']],
  ['help', ['help', 'migrations:new']],
  ['help', ['--nested-commands', 'content:diff']],
  ['--help', ['migrations:run']],
  ['migrations:up', []],
  ['run:migrations', []],
];

const unrelatedRequests: [string | undefined, string[]][] = [
  ['environments:list', []],
  ['environments:list', ['--help']],
  ['environments:list', ['--', '--help', 'migrations:run']],
  ['help', []],
  ['help', ['environments:list']],
  ['migrations', []],
  ['--version', []],
  [undefined, []],
];

describe('content-diff init hook', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-diff-init-hook-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('replaces the stock migrations commands and their alias entries silently', async () => {
    const { commands, config } = fakeHost(directory, {
      stockHiddenAliases: { 'migrations:run': ['migrations:up'] },
    });

    assert.deepEqual(await runInitHook(config, 'environments:list'), []);

    for (const id of ['migrations:new', 'migrations:run']) {
      assert.equal(commands.get(id)?.source, 'content-diff');
      assert.deepEqual(await commands.get(id)?.load(), {
        source: 'content-diff',
      });
    }
    assert.equal(commands.get('migrations:up')?.source, 'content-diff');
    assert.equal(commands.get('migrations:up')?.id, 'migrations:up');
    assert.equal(commands.get('migrations:up')?.hidden, true);
  });

  it('tolerates dangling roots of other installed plugins', async () => {
    const danglingRoot = join(directory, 'dangling-plugin');
    await symlink(join(directory, 'removed-checkout'), danglingRoot);
    assert.throws(() => realpathSync(danglingRoot), { code: 'ENOENT' });
    const missingRoot = join(directory, 'missing-plugin');

    const { commands, config } = fakeHost(directory, {
      extraPluginRoots: [danglingRoot, missingRoot],
    });

    assert.deepEqual(await runInitHook(config, 'migrations:run'), []);
    assert.equal(commands.get('migrations:run')?.source, 'content-diff');
  });

  for (const [id, argv] of unrelatedRequests) {
    it(`warns once and continues for ${describeRequest(
      id,
      argv,
    )} when the takeover is broken`, async () => {
      const { commands, config } = fakeHost(directory, {
        replacements: ['content:diff', 'migrations:new'],
      });

      const warnings = await runInitHook(config, id, argv);

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], brokenTakeoverWarning);
      // The takeover is all-or-nothing, and the stock runners refuse to load.
      for (const commandId of ['migrations:new', 'migrations:run']) {
        assert.equal(commands.get(commandId)?.source, 'stock');
        await assert.rejects(
          commands.get(commandId)!.load(),
          exitsWith(brokenTakeoverFatal),
        );
      }
    });
  }

  for (const [id, argv] of guardedRequests) {
    it(`exits 1 for ${describeRequest(
      id,
      argv,
    )} when the takeover is broken`, async () => {
      const { commands, config } = fakeHost(directory, {
        replacements: ['content:diff', 'migrations:new'],
        stockHiddenAliases: { 'migrations:run': ['migrations:up'] },
      });

      await assert.rejects(
        runInitHook(config, id, argv),
        exitsWith(brokenTakeoverFatal),
      );
      assert.equal(commands.get('migrations:new')?.source, 'stock');
    });
  }

  it('names the plugin files when datocms did not load them', async () => {
    const { config } = fakeHost(directory, { pluginRoot: directory });

    const [warning] = await runInitHook(config, 'environments:list');
    assert.match(
      warning,
      /unavailable: the plugin files at .+ are not among the plugins datocms loaded\. To fix it, reinstall the plugin/,
    );
    await assert.rejects(
      runInitHook(config, 'content:diff'),
      exitsWith(/are not among the plugins datocms loaded/),
    );
  });

  it('rejects guarded commands on another datocms version with exact fixes', async () => {
    for (const [id, argv] of [
      ['migrations:run', []],
      ['help', ['migrations:new']],
    ] as const) {
      const { config } = fakeHost(unsupportedHostRoot);
      await assert.rejects(
        runInitHook(config, id, [...argv]),
        exitsWith(
          /^This content-diff plugin supports datocms CLI 4\.x from 4\.2\.0 on, but 5\.0\.0 is running\. To fix it, install a supported CLI with `npm install --save-dev datocms@\^4\.2\.0` \(or `npm install --global datocms@\^4\.2\.0` for a global install\), or run `datocms plugins:remove @datocms\/cli-plugin-content-diff` to go back to the stock datocms migrations commands\.$/,
        ),
      );
    }
  });

  it('warns once for unrelated commands on another datocms version', async () => {
    const { commands, config } = fakeHost(unsupportedHostRoot);

    const warnings = await runInitHook(config, 'environments:list');

    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /^content-diff's content:diff, migrations:new and migrations:run commands are unavailable: datocms 5\.0\.0 is running, but this plugin supports datocms CLI 4\.x from 4\.2\.0 on\. To fix it, install a supported CLI/,
    );
    assert.match(warnings[0], pinHint);
    assert.equal(commands.get('migrations:run')?.source, 'content-diff');
  });

  it('combines a version mismatch and a broken takeover into one warning', async () => {
    const { config } = fakeHost(unsupportedHostRoot, { replacements: [] });

    const warnings = await runInitHook(config, 'environments:list');

    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /unavailable: datocms 5\.0\.0 is running, but this plugin supports datocms CLI 4\.x from 4\.2\.0 on; the installed plugin does not provide migrations:new\. To fix it, install a supported CLI .+ and reinstall the plugin .+, or run `datocms plugins:remove /,
    );
  });

  for (const [id, argv] of guardedRequests) {
    it(`exits 1 for ${describeRequest(
      id,
      argv,
    )} when the takeover throws unexpectedly`, async () => {
      const { config } = fakeHost(directory, {
        failingReplacement: 'migrations:run',
        stockHiddenAliases: { 'migrations:run': ['migrations:up'] },
      });

      await assert.rejects(
        runInitHook(config, id, argv),
        exitsWith(unexpectedFatal('flags are unreadable')),
      );
    });
  }

  it('warns once and refuses half-replaced migrations commands when the takeover throws unexpectedly', async () => {
    const { commands, config } = fakeHost(directory, {
      failingReplacement: 'migrations:run',
    });

    const warnings = await runInitHook(config, 'environments:list');

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], unexpectedWarning('flags are unreadable'));
    // The copy stopped partway through migrations:run's descriptor.
    assert.equal(commands.get('migrations:run')?.source, 'content-diff');
    for (const commandId of ['migrations:new', 'migrations:run']) {
      await assert.rejects(
        commands.get(commandId)!.load(),
        exitsWith(unexpectedFatal('flags are unreadable')),
      );
    }
  });

  for (const [id, argv] of [
    ['migrations:run', ['--source=sandbox']],
    ['help', ['migrations:new']],
    ['--help', ['content:diff']],
    ['run:migrations', []],
  ] as [string, string[]][]) {
    it(`exits 1 for ${describeRequest(
      id,
      argv,
    )} when the request cannot be resolved`, async () => {
      const { commands, config } = fakeHost(directory, {
        failingPluginCommands: true,
      });

      await assert.rejects(
        runInitHook(config, id, argv),
        exitsWith(unexpectedFatal('commands are unreadable')),
      );
      assert.equal(commands.get('migrations:run')?.source, 'stock');
    });
  }

  it('warns once for unrelated commands when the request cannot be resolved', async () => {
    const { commands, config } = fakeHost(directory, {
      failingPluginCommands: true,
    });

    const warnings = await runInitHook(config, 'environments:list');

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], unexpectedWarning('commands are unreadable'));
    for (const commandId of ['migrations:new', 'migrations:run']) {
      assert.equal(commands.get(commandId)?.source, 'stock');
      await assert.rejects(
        commands.get(commandId)!.load(),
        exitsWith(unexpectedFatal('commands are unreadable')),
      );
    }
  });

  it('exits 1 for every command when the stock runners cannot be disabled', async () => {
    for (const id of ['migrations:run', 'environments:list']) {
      const { config } = fakeHost(directory, {
        failingLookups: ['migrations:run'],
      });

      await assert.rejects(
        runInitHook(config, id),
        exitsWith(unexpectedFatal('cannot look up migrations:run')),
      );
    }
  });
});
