import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { expect } from 'chai';
import { lockedDependencyInputs } from '../locked-dependencies';
import {
  CROSS_PROJECT_EXECUTABLE_E2E_COVERAGE,
  CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE,
} from './executable-coverage';

const walkFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });

const portableRelativePath = (from: string, path: string): string =>
  relative(from, path).split(sep).join('/');

const suiteSourceSha256 = (
  readSource: (path: string) => Buffer = readFileSync,
): string => {
  const pluginRoot = resolve(__dirname, '../..');
  const sourceFiles = [
    ...walkFiles(resolve(pluginRoot, 'src')).filter((path) =>
      path.endsWith('.ts'),
    ),
    ...walkFiles(__dirname).filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('/executable-coverage.ts'),
    ),
    // The cross-project harness imports these execution/fingerprint helpers.
    resolve(pluginRoot, 'test/e2e/real-cma-harness.ts'),
    resolve(pluginRoot, 'test/e2e/scenario-cancellation.ts'),
    resolve(pluginRoot, 'bin/dev'),
    resolve(pluginRoot, 'package.json'),
  ].sort();
  const hash = createHash('sha256');

  for (const path of sourceFiles) {
    hash.update(portableRelativePath(pluginRoot, path));
    hash.update('\0');
    hash.update(readSource(path));
    hash.update('\0');
  }

  for (const [label, content] of lockedDependencyInputs(pluginRoot)) {
    hash.update(label);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
};

describe('aligned cross-project executable coverage inventory', () => {
  it('matches every cross-project E2E spec and declared case exactly', () => {
    const actualSpecs = walkFiles(__dirname)
      .filter((path) => path.endsWith('.e2e.ts'))
      .map((path) => portableRelativePath(__dirname, path))
      .sort();
    const registeredSpecs = CROSS_PROJECT_EXECUTABLE_E2E_COVERAGE.map(
      ({ spec }) => spec,
    ).sort();

    expect(registeredSpecs).to.deep.equal(actualSpecs);
    for (const entry of CROSS_PROJECT_EXECUTABLE_E2E_COVERAGE) {
      const source = readFileSync(resolve(__dirname, entry.spec), 'utf8');
      expect(source.match(/\bit(?:\.skip)?\s*\(/g) ?? []).to.have.length(
        entry.cases,
      );
      expect(source).not.to.match(/\bit\.skip\s*\(/);
    }
  });

  it('invalidates proof when a shared execution helper or the recursive fixture changes', () => {
    const baseline = suiteSourceSha256();
    for (const name of [
      '../e2e/real-cma-harness.ts',
      '../e2e/scenario-cancellation.ts',
      'recursive-fixture.ts',
    ]) {
      const sharedPath = resolve(__dirname, name);
      const changed = suiteSourceSha256((path) => {
        const bytes = readFileSync(path);
        return path === sharedPath
          ? Buffer.concat([
              bytes,
              Buffer.from('\n// changed execution helper\n'),
            ])
          : bytes;
      });
      expect(changed, name).not.to.equal(baseline);
    }
  });

  it('keeps live evidence tied to the exact release sources', () => {
    for (const entry of CROSS_PROJECT_EXECUTABLE_E2E_COVERAGE) {
      expect(entry.evidence).to.equal(CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE);
    }

    if (CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE.status === 'live-proven') {
      expect(CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE.verifiedAt).to.match(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE.passingCases).to.equal(1);
      expect(CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE.failedCases).to.equal(0);
      expect(CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE.keepEnvironments).to.equal(
        false,
      );
      expect(
        CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE.bothPrimariesVerifiedBeforeAndAfter,
      ).to.equal(true);
      expect(CROSS_PROJECT_EXECUTABLE_LIVE_EVIDENCE.suiteSourceSha256).to.equal(
        suiteSourceSha256(),
      );
    }
  });
});
