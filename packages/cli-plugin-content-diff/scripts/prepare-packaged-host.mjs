import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PACKAGED_HOST_MANIFEST_FILENAME,
  commandRoutingChecks,
  installationChecks,
  preparePackagedHost,
  readPackageJson,
  runChecks,
  supportedHostVersion,
  writePackagedHostManifest,
} from './packaged-host.mjs';

function parseArguments(argv) {
  const options = { help: false, tarball: undefined, hostDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    const match = /^--(tarball|host-dir)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`Unknown option: ${argument}`);
    const value = match[2] ?? argv[++index];
    if (!value) throw new Error(`--${match[1]} requires a path`);
    options[match[1] === 'tarball' ? 'tarball' : 'hostDir'] = resolve(value);
  }
  return options;
}

function usage() {
  const hostVersion = supportedHostVersion(readPackageJson());
  return `Usage: node scripts/prepare-packaged-host.mjs [--tarball <file.tgz>] [--host-dir <empty directory>]

Packs this plugin (a clean build and oclif manifest, then npm pack), creates a
fresh consumer project with the workspace's datocms@${hostVersion}
installed engine-strict, adds the tarball with "datocms plugins:add", and
verifies that content:diff and migrations:run are routed to the plugin.

All oclif data, config, and cache locations live inside the host directory, so
the global datocms installation and its plugins are never touched.

--tarball   Use this frozen tarball instead of packing the checkout.
--host-dir  Create the host here (must be missing or empty) instead of a new
            temporary directory.

On success the host directory is the only line printed to stdout; use it as
DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST with DATOCMS_CONTENT_DIFF_E2E_CLI=packaged.
The host description is written to ${PACKAGED_HOST_MANIFEST_FILENAME} only
after every check passes; the E2E harness refuses a host without it. A failed
--host-dir is left for inspection without that manifest.`;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const createdTemporaryHost = !options.hostDir;
  const hostDirectory =
    options.hostDir ??
    mkdtempSync(join(tmpdir(), 'datocms-content-diff-packaged-host-'));
  let packagedHost;
  try {
    packagedHost = preparePackagedHost({
      hostDirectory,
      tarballPath: options.tarball,
    });
    const checks = [
      ...installationChecks(packagedHost),
      ...commandRoutingChecks(packagedHost),
    ];
    runChecks(checks, { label: 'packaged-host' });
    // Only a fully verified host gets the manifest the harness requires.
    writePackagedHostManifest(
      packagedHost,
      checks.map(({ title }) => title),
    );
  } catch (error) {
    console.error(
      `[packaged-host] ${error instanceof Error ? error.message : error}`,
    );
    if (createdTemporaryHost) {
      rmSync(hostDirectory, { recursive: true, force: true });
    } else {
      // The manifest is the last write, so a failed host never receives one.
      console.error(
        `[packaged-host] No ${PACKAGED_HOST_MANIFEST_FILENAME} was written to ${hostDirectory}`,
      );
    }
    process.exit(1);
  }

  console.error(
    `[packaged-host] Ready. Run a live suite against it with:\n  DATOCMS_CONTENT_DIFF_E2E_CLI=packaged DATOCMS_CONTENT_DIFF_E2E_PACKAGED_HOST=${packagedHost.hostDirectory}`,
  );
  console.log(packagedHost.hostDirectory);
}

await main();
