import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command, Hook, Interfaces } from '@oclif/core';
import {
  CONTENT_DIFF_PLUGIN_NAME,
  INSTALL_SUPPORTED_DATOCMS_CLI_HINT,
  REMOVE_CONTENT_DIFF_PLUGIN_HINT,
  SUPPORTED_DATOCMS_CLI_DESCRIPTION,
  unsupportedDatocmsCliMessage,
  unsupportedDatocmsCliVersion,
} from '../../compat/datocms-version';

const REPLACED_COMMANDS = ['migrations:new', 'migrations:run'] as const;
const GUARDED_COMMANDS = ['content:diff', ...REPLACED_COMMANDS] as const;
const PLUGIN_ROOT = resolve(__dirname, '../../..');

type Context = Hook.Context;
type Loadable = Command.Loadable;

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // Any installed plugin root can dangle (a removed link target or
    // checkout). It cannot be this plugin, and it must not break other
    // commands.
    return undefined;
  }
}

function locatePlugin(config: Interfaces.Config) {
  const pluginRoot = canonicalPath(PLUGIN_ROOT);
  if (pluginRoot === undefined) return undefined;
  return [...config.plugins.values()].find(
    (candidate) => canonicalPath(candidate.root) === pluginRoot,
  );
}

function commandIds(command: Loadable | undefined): string[] {
  return command
    ? [command.id, ...(command.aliases ?? []), ...(command.hiddenAliases ?? [])]
    : [];
}

/**
 * The entries oclif dispatches for a command: its canonical descriptor plus
 * the per-alias copies `Config.loadCommands` registers under each alias id.
 */
function dispatchedEntries(config: Interfaces.Config, commandId: string) {
  const entries = new Set<Loadable>();
  for (const id of commandIds(config.findCommand(commandId))) {
    const entry = config.findCommand(id);
    if (entry) entries.add(entry);
  }
  return [...entries];
}

/**
 * Mirrors how `main.run` picks what to dispatch. Both datocms and this
 * package's development binary use the `:` topic separator, so ids arrive in
 * canonical form. A version flag in first position prints the version; a
 * help flag before `--`, or the `help` command, renders help for the first
 * positional that is not `help` itself instead of running `id`.
 */
function requestedCommandId(
  config: Interfaces.Config,
  id: string | undefined,
  argv: string[],
): string | undefined {
  if (id === undefined) return undefined;
  const { additionalHelpFlags = [], additionalVersionFlags = [] } =
    config.pjson.oclif;
  if (['--version', ...additionalVersionFlags].includes(id)) return undefined;

  const words = [id, ...argv];
  const helpFlags = ['--help', ...additionalHelpFlags];
  const flagsEnd = words.indexOf('--');
  const helpRequested =
    id === 'help' ||
    words
      .slice(0, flagsEnd === -1 ? undefined : flagsEnd)
      .some((word) => helpFlags.includes(word));
  if (!helpRequested) return id;

  return words.find((word) => word !== 'help' && !word.startsWith('-'));
}

/**
 * Matches canonical ids, aliases and hidden aliases of both the stock and the
 * replacement descriptors, and flexible-taxonomy permutations (which
 * `findCommand` resolves to the canonical descriptor).
 */
function isGuardedRequest(
  config: Interfaces.Config,
  plugin: Interfaces.Plugin | undefined,
  requested: string | undefined,
): boolean {
  if (requested === undefined) return false;
  const resolved = config.findCommand(requested);

  return GUARDED_COMMANDS.some((commandId) => {
    const descriptors = [
      config.findCommand(commandId),
      plugin?.commands.find((command) => command.id === commandId),
    ];
    return (
      commandId === requested ||
      (resolved !== undefined && descriptors.includes(resolved)) ||
      descriptors.some((descriptor) =>
        commandIds(descriptor).includes(requested),
      )
    );
  });
}

/**
 * Fallback for when the host cannot resolve the request: any word that names
 * a guarded command, in any topic order, counts as a guarded request.
 */
function namesGuardedCommand(words: (string | undefined)[]): boolean {
  const topicKey = (commandId: string) => commandId.split(':').sort().join(':');
  const guardedKeys = new Set(GUARDED_COMMANDS.map(topicKey));
  return words.some(
    (word) => word !== undefined && guardedKeys.has(topicKey(word)),
  );
}

/**
 * oclif prioritizes core commands over user/link plugins. Replace the
 * selected loadable descriptors (and their alias copies) before main dispatch
 * and help rendering, so both use the compatibility implementations shipped
 * with this beta. Returns why the takeover failed, leaving every descriptor
 * untouched, or undefined on success.
 */
function takeOverMigrationCommands(
  config: Interfaces.Config,
  plugin: Interfaces.Plugin | undefined,
): string | undefined {
  if (!plugin) {
    return `the plugin files at ${PLUGIN_ROOT} are not among the plugins datocms loaded`;
  }

  const replacements: [Loadable, Loadable[]][] = [];
  for (const commandId of REPLACED_COMMANDS) {
    const replacement = plugin.commands.find(
      (command) => command.id === commandId,
    );
    if (!replacement) {
      return `the installed plugin does not provide ${commandId}`;
    }
    const entries = dispatchedEntries(config, commandId);
    if (entries.length === 0) return `datocms does not provide ${commandId}`;
    replacements.push([replacement, entries]);
  }

  for (const [replacement, entries] of replacements) {
    for (const entry of entries) {
      if (entry === replacement) continue;
      Object.assign(
        entry,
        replacement,
        entry.id === replacement.id
          ? {}
          : { hidden: entry.hidden, id: entry.id },
      );
    }
  }
  return undefined;
}

function reinstallHint(): string {
  let version: unknown;
  try {
    ({ version } = JSON.parse(
      readFileSync(resolve(PLUGIN_ROOT, 'package.json'), 'utf8'),
    ) as { version?: unknown });
  } catch {
    // A broken install may have lost its package.json too.
  }
  const source =
    typeof version === 'string'
      ? `${CONTENT_DIFF_PLUGIN_NAME}@${version}`
      : CONTENT_DIFF_PLUGIN_NAME;
  return `reinstall the plugin with \`datocms plugins:install ${source}\` (or the tarball you installed it from)`;
}

function takeoverFailureMessage(reason: string): string {
  return `Cannot activate content-diff's migrations:new and migrations:run commands: ${reason}. The stock datocms migrations commands are never used in their place, because they skip content-diff's migration safeguards. To fix it, ${reinstallHint()}, or ${REMOVE_CONTENT_DIFF_PLUGIN_HINT}.`;
}

function fail(context: Context, message: string): never {
  // runHook swallows init hook errors unless they carry a non-zero exit code,
  // so this stops dispatch before any stock command runs.
  context.error(message, { exit: 1 });
  // Unreachable: hook contexts always throw from error().
  throw new Error(message);
}

/** Whether runHook rethrows `error` instead of swallowing it. */
function stopsDispatch(error: unknown): boolean {
  const exit = (error as { oclif?: { exit?: unknown } } | undefined)?.oclif
    ?.exit;
  return exit !== undefined && exit !== 0;
}

/**
 * Any later dispatch of the stock runners (for example a plugin-not-found
 * suggestion) must stop with `message` instead of running them.
 */
function refuseMigrationCommands(
  context: Context,
  config: Interfaces.Config,
  message: string,
) {
  for (const commandId of REPLACED_COMMANDS) {
    for (const entry of dispatchedEntries(config, commandId)) {
      entry.load = async () => fail(context, message);
    }
  }
}

const hook: Hook<'init'> = async function ({ config, id, argv }) {
  let guarded: boolean | undefined;
  const problems: { fix: string; reason: string }[] = [];

  try {
    const plugin = locatePlugin(config);
    guarded = isGuardedRequest(
      config,
      plugin,
      requestedCommandId(config, id, argv),
    );

    const unsupportedVersion = unsupportedDatocmsCliVersion(config);
    if (unsupportedVersion !== undefined) {
      if (guarded) fail(this, unsupportedDatocmsCliMessage(unsupportedVersion));
      problems.push({
        fix: INSTALL_SUPPORTED_DATOCMS_CLI_HINT,
        reason: `datocms ${unsupportedVersion} is running, but this plugin supports ${SUPPORTED_DATOCMS_CLI_DESCRIPTION}`,
      });
    }

    const takeoverFailure = takeOverMigrationCommands(config, plugin);
    if (takeoverFailure !== undefined) {
      const message = takeoverFailureMessage(takeoverFailure);
      if (guarded) fail(this, message);
      refuseMigrationCommands(this, config, message);
      problems.push({ fix: reinstallHint(), reason: takeoverFailure });
    }
  } catch (error) {
    if (stopsDispatch(error)) throw error;

    // runHook swallows anything else, and dispatch would then reach whatever
    // the stock or half-replaced descriptors do.
    const reason = `an unexpected error occurred (${
      error instanceof Error ? error.message : String(error)
    })`;
    const message = takeoverFailureMessage(reason);
    if (guarded ?? namesGuardedCommand([id, ...argv])) fail(this, message);
    try {
      refuseMigrationCommands(this, config, message);
    } catch {
      // Without a way to disable the stock runners, no command is safe.
      fail(this, message);
    }
    problems.push({ fix: reinstallHint(), reason });
  }

  if (problems.length === 0) return;

  // Unrelated commands keep working; one warning explains what is off.
  const reasons = problems.map(({ reason }) => reason).join('; ');
  const fixes = problems.map(({ fix }) => fix).join(' and ');
  this.warn(
    `content-diff's content:diff, migrations:new and migrations:run commands are unavailable: ${reasons}. To fix it, ${fixes}, or ${REMOVE_CONTENT_DIFF_PLUGIN_HINT}.`,
  );
};

export default hook;
