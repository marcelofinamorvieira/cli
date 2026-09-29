import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from '@oclif/core';

/**
 * The datocms releases this plugin runs in: 4.x from 4.2.0 on. Its
 * migrations:new and migrations:run replace the host's own, so they must
 * mirror them; test/compat/host-sources.test.ts fails whenever the host's
 * copies change, until the plugin has been brought in line with them.
 */
export const MINIMUM_DATOCMS_CLI_VERSION = '4.2.0' as const;
export const SUPPORTED_DATOCMS_CLI_RANGE =
  `^${MINIMUM_DATOCMS_CLI_VERSION}` as const;
export const CONTENT_DIFF_PLUGIN_NAME =
  '@datocms/cli-plugin-content-diff' as const;

/**
 * Exact recovery commands shared by every compatibility message: install a
 * supported host, or remove the plugin so the stock migrations commands are
 * back in charge.
 */
export const INSTALL_SUPPORTED_DATOCMS_CLI_HINT = `install a supported CLI with \`npm install --save-dev datocms@${SUPPORTED_DATOCMS_CLI_RANGE}\` (or \`npm install --global datocms@${SUPPORTED_DATOCMS_CLI_RANGE}\` for a global install)`;
export const REMOVE_CONTENT_DIFF_PLUGIN_HINT = `run \`datocms plugins:remove ${CONTENT_DIFF_PLUGIN_NAME}\` to go back to the stock datocms migrations commands`;

/** The supported range, in words. */
export const SUPPORTED_DATOCMS_CLI_DESCRIPTION = `datocms CLI 4.x from ${MINIMUM_DATOCMS_CLI_VERSION} on`;

/**
 * Whether `version` is in SUPPORTED_DATOCMS_CLI_RANGE. A prerelease counts
 * as the release it leads to, so `next` builds of a supported line load too.
 */
export function isSupportedDatocmsCliVersion(version: string): boolean {
  const parse = (value: string) =>
    /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value)?.slice(1).map(Number);
  const installed = parse(version);
  const minimum = parse(MINIMUM_DATOCMS_CLI_VERSION)!;
  if (installed === undefined || installed[0] !== minimum[0]) return false;
  for (const [index, part] of installed.entries()) {
    if (part !== minimum[index]) return part > minimum[index];
  }
  return true;
}

type HostConfig = Readonly<{
  bin: string;
  name: string;
  pjson?: Readonly<{ version?: string }>;
  root: string;
  version: string;
}>;

function detectedDatocmsVersion(config: HostConfig): string | undefined {
  const roots = new Set([config.root, resolve(config.root, '..')]);

  if (process.argv[1]) {
    try {
      const executableDirectory = dirname(realpathSync(process.argv[1]));
      roots.add(executableDirectory);
      roots.add(resolve(executableDirectory, '..'));
      roots.add(resolve(executableDirectory, '../..'));
    } catch {
      // The loaded oclif metadata remains available below.
    }
  }

  for (const root of roots) {
    try {
      const packageJson = JSON.parse(
        readFileSync(resolve(root, 'package.json'), 'utf8'),
      ) as { name?: unknown; version?: unknown };

      if (
        (packageJson.name === 'datocms' ||
          packageJson.name === '@datocms/cli') &&
        typeof packageJson.version === 'string'
      ) {
        return packageJson.version;
      }
    } catch {
      // Fall back to oclif's loaded metadata below.
    }
  }

  return undefined;
}

/**
 * Returns the running datocms CLI version when it is not the supported one,
 * or undefined for the supported host and for non-datocms hosts.
 */
export function unsupportedDatocmsCliVersion(
  config: HostConfig,
): string | undefined {
  const { bin, name } = config;
  const detectedVersion = detectedDatocmsVersion(config);
  const isDatocmsHost =
    detectedVersion !== undefined ||
    bin === 'datocms' ||
    name === 'datocms' ||
    name === '@datocms/cli';

  if (!isDatocmsHost) return undefined;

  const installedVersion =
    detectedVersion ?? config.pjson?.version ?? config.version;
  return isSupportedDatocmsCliVersion(installedVersion)
    ? undefined
    : installedVersion;
}

export function unsupportedDatocmsCliMessage(installedVersion: string): string {
  return `This content-diff plugin supports ${SUPPORTED_DATOCMS_CLI_DESCRIPTION}, but ${installedVersion} is running. To fix it, ${INSTALL_SUPPORTED_DATOCMS_CLI_HINT}, or ${REMOVE_CONTENT_DIFF_PLUGIN_HINT}.`;
}

export function assertSupportedDatocmsCliConfig(
  config: HostConfig,
  reportError: (message: string) => void,
): void {
  const installedVersion = unsupportedDatocmsCliVersion(config);
  if (installedVersion === undefined) return;

  reportError(unsupportedDatocmsCliMessage(installedVersion));
}

/**
 * User-installed oclif plugins share the host CLI configuration. Keep the
 * copied migrations compatibility layer to the CLI releases it mirrors, and
 * fail before profile resolution or CMA access when any other version loads
 * it.
 *
 * The package's own development binary is intentionally exempt: in that mode
 * this plugin is the root oclif application rather than a datocms user plugin.
 */
export function assertSupportedDatocmsCli(command: Command): void {
  assertSupportedDatocmsCliConfig(command.config, (message) =>
    command.error(message, { exit: 1 }),
  );
}
