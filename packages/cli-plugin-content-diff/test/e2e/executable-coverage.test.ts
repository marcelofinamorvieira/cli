import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { expect } from 'chai';
import { lockedDependencyInputs } from '../locked-dependencies';
import {
  CURRENT_EXECUTABLE_LIVE_EVIDENCE,
  EXECUTABLE_E2E_COVERAGE,
  REQUIRED_HIGH_RISK_CLAIMS,
  executableCoverageByClaim,
} from './executable-coverage';

const walkFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });

const portableRelativePath = (from: string, path: string): string =>
  relative(from, path).split(sep).join('/');

const actualSpecPaths = (): string[] =>
  walkFiles(__dirname)
    .filter((path) => path.endsWith('.e2e.ts'))
    .map((path) => portableRelativePath(__dirname, path))
    .sort();

const liveSuiteSourceSha256 = (): string => {
  const pluginRoot = resolve(__dirname, '../..');
  const e2eSources = walkFiles(__dirname).filter(
    (path) =>
      path.endsWith('.ts') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('/executable-coverage.ts') &&
      !path.endsWith('/fixture-matrix.ts'),
  );
  const sourceFiles = [
    ...walkFiles(resolve(pluginRoot, 'src')).filter((path) =>
      path.endsWith('.ts'),
    ),
    ...e2eSources,
    resolve(pluginRoot, 'bin/dev'),
    resolve(pluginRoot, 'package.json'),
  ].sort();
  const hash = createHash('sha256');
  for (const path of sourceFiles) {
    hash.update(portableRelativePath(pluginRoot, path));
    hash.update('\0');
    hash.update(readFileSync(path));
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

describe('executable real-CMA coverage inventory', () => {
  it('is an exact, duplicate-free inventory of the discovered E2E specs', () => {
    const registered = EXECUTABLE_E2E_COVERAGE.map(({ spec }) => spec);

    expect(new Set(registered).size).to.equal(registered.length);
    expect([...registered].sort()).to.deep.equal(actualSpecPaths());
  });

  it('keeps each declared case count tied to its checked-in Mocha spec', () => {
    for (const entry of EXECUTABLE_E2E_COVERAGE) {
      const source = readFileSync(resolve(__dirname, entry.spec), 'utf8');
      const declaredCases = source.match(/\bit(?:\.skip)?\s*\(/g) ?? [];

      expect(declaredCases.length, entry.spec).to.equal(entry.cases);
    }
  });

  it('maps every reviewed high-risk claim to an exact executable or explicit pending lane', () => {
    const coverage = executableCoverageByClaim();

    expect([...coverage.keys()].sort()).to.deep.equal(
      [...REQUIRED_HIGH_RISK_CLAIMS].sort(),
    );
    for (const claim of REQUIRED_HIGH_RISK_CLAIMS) {
      expect(coverage.get(claim), claim).not.to.be.empty;
    }
  });

  it('keeps live proof centralized and labels the historical structural gap exactly', () => {
    const structural = EXECUTABLE_E2E_COVERAGE.filter(
      ({ evidence }) => evidence.status === 'historical-unconstructible',
    );
    const executable = EXECUTABLE_E2E_COVERAGE.filter(
      ({ spec }) => spec !== 'structural-invalid.e2e.ts',
    );

    expect(structural.map(({ spec }) => spec)).to.deep.equal([
      'structural-invalid.e2e.ts',
    ]);
    for (const entry of executable) {
      expect(entry.evidence).to.equal(CURRENT_EXECUTABLE_LIVE_EVIDENCE);
      const source = readFileSync(resolve(__dirname, entry.spec), 'utf8');
      expect(source, `${entry.spec} must remain executable`).not.to.match(
        /\bit\.skip\s*\(/,
      );
    }

    const structuralSource = readFileSync(
      resolve(__dirname, structural[0].spec),
      'utf8',
    );
    expect(structuralSource).to.match(/\bit\.skip\s*\(/);

    if (CURRENT_EXECUTABLE_LIVE_EVIDENCE.status === 'live-proven') {
      expect(CURRENT_EXECUTABLE_LIVE_EVIDENCE.verifiedAt).to.match(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(CURRENT_EXECUTABLE_LIVE_EVIDENCE.passingCases).to.equal(
        executable.reduce((sum, { cases }) => sum + cases, 0),
      );
      expect(CURRENT_EXECUTABLE_LIVE_EVIDENCE.pendingCases).to.equal(
        structural.reduce((sum, { cases }) => sum + cases, 0),
      );
      expect(CURRENT_EXECUTABLE_LIVE_EVIDENCE.failedCases).to.equal(0);
      expect(CURRENT_EXECUTABLE_LIVE_EVIDENCE.keepEnvironments).to.equal(false);
      expect(
        CURRENT_EXECUTABLE_LIVE_EVIDENCE.primaryVerifiedBeforeAndAfter,
      ).to.equal(true);
      expect(CURRENT_EXECUTABLE_LIVE_EVIDENCE.suiteSourceSha256).to.equal(
        liveSuiteSourceSha256(),
      );
    }
  });

  it('contains no identity-conversion claims or specs', () => {
    const executableScope = EXECUTABLE_E2E_COVERAGE.map(
      ({ spec, claims, summary }) => ({ spec, claims, summary }),
    );

    expect(JSON.stringify(executableScope)).not.to.match(
      /(?:legacy|update[-_]ids)/i,
    );
  });

  it('keeps the README lane table mechanically synchronized', () => {
    const readme = readFileSync(resolve(__dirname, 'README.md'), 'utf8');
    const startMarker = '<!-- executable-e2e-inventory:start -->';
    const endMarker = '<!-- executable-e2e-inventory:end -->';
    const start = readme.indexOf(startMarker);
    const end = readme.indexOf(endMarker);

    expect(start).to.be.greaterThan(-1);
    expect(end).to.be.greaterThan(start);

    const inventory = readme.slice(start + startMarker.length, end);
    const documented = [...inventory.matchAll(/`([^`]+\.e2e\.ts)`/g)]
      .map((match) => match[1])
      .sort();
    const totalCases = EXECUTABLE_E2E_COVERAGE.reduce(
      (sum, { cases }) => sum + cases,
      0,
    );

    expect(documented).to.deep.equal(actualSpecPaths());
    expect(readme).to.contain(
      `contains ${documented.length} spec files and ${totalCases} Mocha cases`,
    );
  });
});
