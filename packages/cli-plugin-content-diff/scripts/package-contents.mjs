import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Every release tarball contains exactly these files plus one JavaScript file
 * and one declaration file per TypeScript source under src/. npm always packs
 * package.json and README.md; oclif.manifest.json comes from the package.json
 * "files" allowlist, like every other package in this repository.
 *
 * Deliberately excluded: src/, test/, scripts/, bin/ (the development
 * launchers; installed plugins run inside the datocms host), docs/, generated
 * .datocms-content state, *.tsbuildinfo, tarballs, and local environment
 * files.
 */
export const FIXED_PACKAGE_FILES = Object.freeze(
  ['README.md', 'oclif.manifest.json', 'package.json'].sort(compareCodeUnits),
);

/** Locale-independent ordering, so reports are identical on every machine. */
export function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Recursively lists regular files as sorted, slash-separated relative paths.
 * `skip` prunes a relative path (file or whole directory) before it is read,
 * so skipped trees may contain links or special files.
 */
export function listFiles(directory, prefix = '', { skip } = {}) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip?.(relativePath)) return [];
      if (entry.isDirectory()) {
        return listFiles(join(directory, entry.name), relativePath, { skip });
      }
      if (!entry.isFile()) {
        throw new Error(
          `${relativePath} is not a regular file; packaged inputs must not contain links or special files`,
        );
      }
      return [relativePath];
    })
    .sort(compareCodeUnits);
}

export function expectedPackageFiles(packageRoot) {
  const sources = listFiles(join(packageRoot, 'src')).filter(
    (path) => path.endsWith('.ts') && !path.endsWith('.d.ts'),
  );
  if (sources.length === 0) {
    throw new Error('no TypeScript sources were found under src/');
  }

  const compiled = sources.flatMap((path) => {
    const stem = path.slice(0, -'.ts'.length);
    return [`lib/${stem}.d.ts`, `lib/${stem}.js`];
  });
  return [...FIXED_PACKAGE_FILES, ...compiled].sort(compareCodeUnits);
}

export function diffPackageFiles(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((path) => !actualSet.has(path)),
    unexpected: [...actualSet]
      .filter((path) => !expectedSet.has(path))
      .sort(compareCodeUnits),
    duplicates: [
      ...new Set(
        actual.filter((path, index) => actual.indexOf(path) !== index),
      ),
    ].sort(compareCodeUnits),
  };
}

export function formatPackageFileDiff({ missing, unexpected, duplicates }) {
  return [
    ...missing.map((path) => `- missing    ${path}`),
    ...unexpected.map((path) => `+ unexpected ${path}`),
    ...duplicates.map((path) => `! duplicate  ${path}`),
  ].join('\n');
}

/** Throws with a line-oriented diff unless the file set matches exactly. */
export function assertExpectedPackageFiles(actual, expected, label) {
  const diff = diffPackageFiles(actual, expected);
  if (
    diff.missing.length === 0 &&
    diff.unexpected.length === 0 &&
    diff.duplicates.length === 0
  ) {
    return;
  }

  throw new Error(
    `${label} does not contain exactly the expected ${
      expected.length
    } release files (${diff.missing.length} missing, ${
      diff.unexpected.length
    } unexpected, ${
      diff.duplicates.length
    } duplicated):\n${formatPackageFileDiff(diff)}`,
  );
}

/** Validates `npm pack --json` output for this package and returns its entry. */
export function parsePackJson(stdout, packageJson) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('npm pack --json did not print valid JSON on stdout');
  }

  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('npm pack --json must describe exactly one package');
  }
  const [entry] = parsed;
  if (
    entry === null ||
    typeof entry !== 'object' ||
    entry.name !== packageJson.name ||
    entry.version !== packageJson.version
  ) {
    throw new Error(
      `npm pack --json described ${JSON.stringify(
        entry?.name,
      )}@${JSON.stringify(entry?.version)} instead of ${packageJson.name}@${
        packageJson.version
      }`,
    );
  }
  if (
    !Array.isArray(entry.files) ||
    entry.files.some(
      (file) =>
        file === null ||
        typeof file !== 'object' ||
        typeof file.path !== 'string' ||
        file.path.length === 0,
    )
  ) {
    throw new Error('npm pack --json output has an invalid file list');
  }
  if (Array.isArray(entry.bundled) && entry.bundled.length > 0) {
    throw new Error(
      `the package unexpectedly bundles dependencies: ${entry.bundled.join(
        ', ',
      )}`,
    );
  }
  if (
    typeof entry.entryCount === 'number' &&
    entry.entryCount !== entry.files.length
  ) {
    throw new Error(
      `npm pack --json reported ${entry.entryCount} entries but listed ${entry.files.length} files`,
    );
  }

  return {
    filename: typeof entry.filename === 'string' ? entry.filename : undefined,
    files: entry.files
      .map(({ path }) => path.replace(/\\/g, '/'))
      .sort(compareCodeUnits),
  };
}

const TAR_BLOCK = 512;

function tarString(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function tarNumber(block, start, length, label) {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    throw new Error(`tar entry ${label} uses an unsupported base-256 field`);
  }
  const text = tarString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new Error(`tar entry ${label} has a malformed numeric field`);
  }
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function parsePaxRecords(bytes) {
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(
      bytes.subarray(offset, space).toString(),
      10,
    );
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error('tar pax header has a malformed record length');
    }
    const record = bytes
      .subarray(space + 1, offset + length - 1)
      .toString('utf8');
    const separator = record.indexOf('=');
    if (separator > 0) {
      records[record.slice(0, separator)] = record.slice(separator + 1);
    }
    offset += length;
  }
  return records;
}

/**
 * Reads an npm tarball into a map of package-relative paths to file bytes.
 * npm writes every entry below `package/`; anything else, a link, or a path
 * escaping the package root is rejected rather than silently ignored.
 */
export function readTarball(tarballBytes) {
  const archive = gunzipSync(tarballBytes);
  const files = new Map();
  let offset = 0;
  let pendingPath;

  while (offset + TAR_BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const storedChecksum = tarNumber(header, 148, 8, 'checksum');
    let checksum = 0;
    for (let index = 0; index < TAR_BLOCK; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== storedChecksum) {
      throw new Error(`tar header at byte ${offset} has an invalid checksum`);
    }

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const type = String.fromCharCode(header[156] || 0x30);
    const size = tarNumber(header, 124, 12, name);
    const dataStart = offset + TAR_BLOCK;
    const data = archive.subarray(dataStart, dataStart + size);
    if (data.length !== size) {
      throw new Error(`tar entry ${name} is truncated`);
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (type === 'x') {
      pendingPath = parsePaxRecords(data).path ?? pendingPath;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      pendingPath = tarString(data, 0, data.length);
      continue;
    }

    const path = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;
    if (type === '5') continue;
    if (type !== '0') {
      throw new Error(
        `tar entry ${path} has unsupported type ${JSON.stringify(type)}`,
      );
    }
    if (!path.startsWith('package/')) {
      throw new Error(`tar entry ${path} is outside the package/ root`);
    }
    const packagePath = path.slice('package/'.length);
    const segments = packagePath.split('/');
    if (
      packagePath.length === 0 ||
      segments.some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      ) ||
      packagePath.includes('\\')
    ) {
      throw new Error(`tar entry ${path} has an unsafe path`);
    }
    if (files.has(packagePath)) {
      throw new Error(`tar entry ${path} appears more than once`);
    }
    files.set(packagePath, Buffer.from(data));
  }

  return new Map(
    [...files.entries()].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    ),
  );
}

/**
 * Compares installed package files against tarball entries byte for byte.
 * Returns human-readable differences; an empty array means identical. The
 * plugin's own node_modules (dependencies npm nested under it, including
 * .bin links) is not part of the package and is never walked.
 */
export function compareInstalledFiles(tarballFiles, installedRoot) {
  const installed = listFiles(installedRoot, '', {
    skip: (path) => path === 'node_modules',
  });
  const differences = [];
  const expected = [...tarballFiles.keys()];
  const diff = diffPackageFiles(installed, expected);
  differences.push(
    ...diff.missing.map((path) => `missing from installation: ${path}`),
    ...diff.unexpected.map((path) => `not in tarball: ${path}`),
  );
  for (const [path, bytes] of tarballFiles) {
    if (diff.missing.includes(path)) continue;
    const installedBytes = readFileSync(
      join(installedRoot, ...path.split('/')),
    );
    if (!installedBytes.equals(bytes)) {
      differences.push(`content differs: ${path}`);
    }
  }
  return differences;
}

const CREDENTIAL_ENVIRONMENT = /^DATOCMS_(?:.*_)?API_TOKEN$/;

/**
 * DatoCMS API token values supplied through the environment, which credential
 * scans must not find. Values shorter than eight characters are ignored
 * because they would match unrelated text.
 */
export function credentialValues(environment = process.env) {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        CREDENTIAL_ENVIRONMENT.test(name) &&
        typeof value === 'string' &&
        value.length >= 8,
    )
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, value]) => ({ name, bytes: Buffer.from(value, 'utf8') }));
}

/**
 * Scans `[path, bytes]` entries for every credential value. Returns one line
 * per match naming the variable, never the value; empty means clean.
 */
export function findCredentialMatches(files, secrets) {
  const matches = [];
  for (const [path, bytes] of files) {
    for (const secret of secrets) {
      if (bytes.includes(secret.bytes)) {
        matches.push(`${path} contains the value of ${secret.name}`);
      }
    }
  }
  return matches;
}

/**
 * Tracked plus untracked, non-ignored regular files of the Git checkout at
 * `root`, read-only through `git ls-files`. Ignored local files such as
 * .env files are deliberately excluded; index entries missing from the
 * working tree and links are skipped.
 */
export function repositoryFiles(root) {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ls-files could not list the repository files in ${root}: ${
        result.error?.message ??
        (result.stderr?.toString('utf8').trim() || `exit ${result.status}`)
      }`,
    );
  }
  return [
    ...new Set(result.stdout.toString('utf8').split('\0').filter(Boolean)),
  ]
    .filter((path) => {
      try {
        return lstatSync(join(root, ...path.split('/'))).isFile();
      } catch {
        return false;
      }
    })
    .sort(compareCodeUnits);
}
