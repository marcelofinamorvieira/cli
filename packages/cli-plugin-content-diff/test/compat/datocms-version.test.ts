import { resolve } from 'node:path';
import type { Command } from '@oclif/core';
import { expect } from 'chai';
import {
  MINIMUM_DATOCMS_CLI_VERSION,
  assertSupportedDatocmsCli,
  isSupportedDatocmsCliVersion,
} from '../../src/compat/datocms-version';

function fakeCommand({
  bin,
  name,
  packageVersion,
  root,
  version,
}: Readonly<{
  bin: string;
  name: string;
  packageVersion?: string;
  root?: string;
  version: string;
}>): Command {
  return {
    config: {
      bin,
      name,
      root: root ?? process.cwd(),
      version,
      ...(packageVersion ? { pjson: { version: packageVersion } } : {}),
    },
    error(message: string): never {
      throw new Error(message);
    },
  } as unknown as Command;
}

describe('DatoCMS CLI compatibility', () => {
  it('accepts every datocms 4.x host from the minimum version on', () => {
    for (const version of [
      MINIMUM_DATOCMS_CLI_VERSION,
      '4.2.1',
      '4.3.0-next.0',
      '4.10.0',
    ]) {
      expect(
        () =>
          assertSupportedDatocmsCli(
            fakeCommand({ bin: 'datocms', name: 'datocms', version }),
          ),
        version,
      ).not.to.throw();
    }
  });

  it('rejects datocms hosts older than the minimum or from another major', () => {
    for (const version of ['4.0.29', '4.1.9', '5.0.0', '3.9.0', 'not-semver']) {
      expect(isSupportedDatocmsCliVersion(version), version).to.equal(false);
      expect(() =>
        assertSupportedDatocmsCli(
          fakeCommand({ bin: 'datocms', name: 'datocms', version }),
        ),
      ).to.throw(
        `This content-diff plugin supports datocms CLI 4.x from 4.2.0 on, but ${version} is running.`,
      );
    }
  });

  it('explains exactly how to recover from another datocms host version', () => {
    expect(() =>
      assertSupportedDatocmsCli(
        fakeCommand({
          bin: 'datocms',
          name: 'datocms',
          version: '5.0.0',
        }),
      ),
    ).to.throw(
      'To fix it, install a supported CLI with `npm install --save-dev datocms@^4.2.0` (or `npm install --global datocms@^4.2.0` for a global install), or run `datocms plugins:remove @datocms/cli-plugin-content-diff` to go back to the stock datocms migrations commands.',
    );
  });

  it('uses the installed host package version when the oclif manifest is stale', () => {
    expect(() =>
      assertSupportedDatocmsCli(
        fakeCommand({
          bin: 'datocms',
          name: 'datocms',
          packageVersion: MINIMUM_DATOCMS_CLI_VERSION,
          root: resolve(process.cwd(), 'test/fixtures/datocms-5.0.0'),
          version: MINIMUM_DATOCMS_CLI_VERSION,
        }),
      ),
    ).to.throw(
      'This content-diff plugin supports datocms CLI 4.x from 4.2.0 on, but 5.0.0 is running.',
    );
  });

  it('allows the plugin development binary to load independently', () => {
    expect(() =>
      assertSupportedDatocmsCli(
        fakeCommand({
          bin: 'content-diff',
          name: '@datocms/cli-plugin-content-diff',
          version: '4.2.1',
        }),
      ),
    ).not.to.throw();
  });
});
