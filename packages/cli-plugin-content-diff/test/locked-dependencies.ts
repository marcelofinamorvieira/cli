import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type Lockfile = { packages: Record<string, LockEntry> };

const portablePath = (path: string): string => path.split(sep).join('/');

function findWorkspaceLockfile(pluginRoot: string): {
  root: string;
  lockfile: Lockfile;
} {
  for (let directory = pluginRoot; ; directory = dirname(directory)) {
    const path = join(directory, 'package-lock.json');
    if (existsSync(path)) {
      const lockfile = JSON.parse(readFileSync(path, 'utf8')) as Lockfile;
      const key = portablePath(relative(directory, pluginRoot));
      if (lockfile.packages?.[key]) return { root: directory, lockfile };
    }
    if (dirname(directory) === directory) {
      throw new Error(`No package-lock.json lists ${pluginRoot}`);
    }
  }
}

/** Where npm would load `name` from, for a package installed at `from`. */
function resolveLocked(
  packages: Lockfile['packages'],
  from: string,
  name: string,
): string | undefined {
  for (let directory = from; ; ) {
    const candidate = `${directory ? `${directory}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (directory === '') return undefined;
    const nested = directory.lastIndexOf('/node_modules/');
    directory = nested === -1 ? '' : directory.slice(0, nested);
  }
}

const walkFiles = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walkFiles(path) : [path];
      })
    : [];

/**
 * The inputs that pin the plugin's dependencies, for live-evidence digests:
 * every package reachable from the plugin in the workspace lockfile, with the
 * exact version and integrity npm installs, plus the sources of the workspace
 * packages among them, which are built from this checkout instead.
 *
 * Unlike the whole lockfile, this changes only when something the plugin
 * actually loads changes, not whenever another workspace package moves.
 */
export function lockedDependencyInputs(
  pluginRoot: string,
): Array<[label: string, content: Buffer]> {
  const { root, lockfile } = findWorkspaceLockfile(pluginRoot);
  const { packages } = lockfile;
  const pluginKey = portablePath(relative(root, pluginRoot));
  const locked = new Set<string>();
  const workspaces = new Set<string>();
  const queued = new Set([pluginKey]);
  const queue = [pluginKey];

  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    const entry = packages[key]!;
    const names = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
      // The plugin's own dev dependencies run the live suites too.
      ...(key === pluginKey ? Object.keys(entry.devDependencies ?? {}) : []),
    ]);
    for (const name of [...names].sort()) {
      let target = resolveLocked(packages, key, name);
      if (target === undefined) continue;
      const linked = packages[target]!;
      if (linked.link && linked.resolved) {
        locked.add(`${target} -> ${linked.resolved}`);
        target = linked.resolved;
        if (!packages[target]) continue;
        if (target !== pluginKey) workspaces.add(target);
      } else {
        const { version, integrity, resolved } = packages[target]!;
        locked.add(`${target}@${version} ${integrity ?? resolved ?? ''}`);
      }
      if (!queued.has(target)) {
        queued.add(target);
        queue.push(target);
      }
    }
  }

  const inputs: Array<[string, Buffer]> = [
    ['<locked dependencies>', Buffer.from([...locked].sort().join('\n'))],
  ];
  for (const workspace of [...workspaces].sort()) {
    const workspaceRoot = resolve(root, workspace);
    for (const path of [
      join(workspaceRoot, 'package.json'),
      ...walkFiles(join(workspaceRoot, 'src')).filter((file) =>
        file.endsWith('.ts'),
      ),
    ].sort()) {
      inputs.push([
        portablePath(relative(pluginRoot, path)),
        readFileSync(path),
      ]);
    }
  }
  return inputs;
}
