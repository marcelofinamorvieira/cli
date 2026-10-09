import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'oclif.manifest.json');
const previousManifest = existsSync(manifestPath)
  ? readFileSync(manifestPath)
  : undefined;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${
        result.error?.message ?? result.stderr ?? result.stdout
      }`,
    );
  return result.stdout;
}

function sourceFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      return sourceFiles(join(directory, entry.name), path);
    assert.ok(entry.isFile(), `source path is not a regular file: ${path}`);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

try {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.engines.node, '^22.23.1 || >=24.18.0');
  // Without it, oclif describes the topic with the first command's summary.
  assert.ok(
    metadata.oclif.topics?.content?.description,
    'the content topic has no description',
  );
  run('npm', ['run', 'build']);
  run('npm', ['exec', '--', 'oclif', 'manifest']);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest.commands).sort(), [
    'content:apply',
    'content:diff',
  ]);
  const packed = JSON.parse(
    run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']),
  );
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, metadata.name);
  assert.equal(packed[0].version, metadata.version);
  assert.deepEqual(packed[0].bundled, []);
  const files = packed[0].files.map((file) => file.path).sort();
  const expected = [
    'README.md',
    'package.json',
    'oclif.manifest.json',
    ...sourceFiles(join(root, 'src')).flatMap((path) => {
      const stem = path.slice(0, -3);
      return [`lib/${stem}.js`, `lib/${stem}.d.ts`];
    }),
  ];
  for (const path of ['npm-shrinkwrap.json', 'LICENSE'])
    if (existsSync(join(root, path))) expected.push(path);
  assert.deepEqual(
    files,
    expected.sort(),
    'package dry-run contains unexpected or missing files',
  );
  for (const command of ['content:diff', 'content:apply']) {
    const help = run(process.execPath, [
      join(root, 'bin/run'),
      command,
      '--help',
    ]);
    assert.ok(help.includes(command), `compiled help is missing ${command}`);
  }
  console.log(
    `Verified ${files.length} package files and both content commands without publishing.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (previousManifest) writeFileSync(manifestPath, previousManifest);
  else rmSync(manifestPath, { force: true });
}
