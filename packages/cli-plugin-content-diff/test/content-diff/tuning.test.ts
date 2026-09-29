import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import {
  CONTENT_DIFF_TUNING_DEFINITIONS,
  type ContentDiffTuningError,
  type ContentDiffTuningKey,
  formatContentDiffTuningOverride,
  isContentDiffTuningError,
  listContentDiffTuningOverrides,
  readContentDiffTuningValue,
  resolveAssetDownloadTimeouts,
  resolveContentDiffTuning,
} from '../../src/content-diff/shared/tuning';

const DEFAULTS = {
  assetHeadersTimeoutMs: 120_000,
  assetIdleTimeoutMs: 300_000,
  uploadProcessingTimeoutMs: 600_000,
  validityTimeoutMs: 600_000,
  scheduleSafetyWindowMs: 300_000,
};

describe('content diff tuning', () => {
  it('uses the documented defaults when no variable is set', () => {
    expect(resolveContentDiffTuning({})).to.deep.equal(DEFAULTS);
    expect(resolveAssetDownloadTimeouts({})).to.deep.equal({
      headersTimeoutMs: 120_000,
      idleTimeoutMs: 300_000,
    });
    expect(
      CONTENT_DIFF_TUNING_DEFINITIONS.map(({ variable }) => variable),
    ).to.deep.equal([
      'DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS',
      'DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS',
      'DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS',
      'DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS',
      'DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS',
    ]);
  });

  it('resolves every variable from the passed record at its range bounds', () => {
    const env = {
      DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS: '1000',
      DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS: '86400000',
      DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS: '0900000',
      DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS: '1200000',
      DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS: '300000',
      DATOCMS_CONTENT_DIFF_UNRELATED: 'not a number',
    };

    expect(resolveContentDiffTuning(env)).to.deep.equal({
      assetHeadersTimeoutMs: 1_000,
      assetIdleTimeoutMs: 86_400_000,
      uploadProcessingTimeoutMs: 900_000,
      validityTimeoutMs: 1_200_000,
      scheduleSafetyWindowMs: 300_000,
    });
    expect(resolveAssetDownloadTimeouts(env)).to.deep.equal({
      headersTimeoutMs: 1_000,
      idleTimeoutMs: 86_400_000,
    });
    expect(readContentDiffTuningValue(env, 'validityTimeoutMs')).to.equal(
      1_200_000,
    );
  });

  it('fails closed on anything but an in-range decimal integer', () => {
    const variable = 'DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS';

    for (const value of [
      '',
      ' 5000',
      '5000 ',
      '5000.0',
      '5000.5',
      '5e3',
      '+5000',
      '-5000',
      '0x1388',
      '5_000',
      '５０００',
      'Infinity',
      'NaN',
      '0',
      '999',
      '86400001',
      '9'.repeat(400),
    ]) {
      const error = captureTuningError(() =>
        resolveAssetDownloadTimeouts({ [variable]: value }),
      );

      expect(error.code, value).to.equal('INVALID_TUNING');
      expect(error.name).to.equal('ContentDiffTuningError');
      expect(error.message).to.contain(variable);
      expect(error.message).to.contain(
        'expected a decimal integer number of milliseconds from 1000 to 86400000 (default 300000)',
      );
      expect(error.details).to.deep.equal({
        variable,
        value: value.length > 64 ? `${value.slice(0, 64)}...` : value,
        minimumMs: 1_000,
        maximumMs: 86_400_000,
        defaultMs: 300_000,
      });
    }
  });

  it('reports the first invalid variable while resolving everything', () => {
    const error = captureTuningError(() =>
      resolveContentDiffTuning({
        DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS: '10m',
        DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS: 'also invalid',
      }),
    );

    expect(error.details.variable).to.equal(
      'DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS',
    );
    expect(error.message).to.equal(
      'Invalid DATOCMS_CONTENT_DIFF_UPLOAD_PROCESSING_TIMEOUT_MS value "10m": expected a decimal integer number of milliseconds from 1000 to 86400000 (default 600000). Unset the variable to use the default.',
    );
  });

  it('only lets the schedule safety window be raised', () => {
    const variable = 'DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS';

    expect(
      readContentDiffTuningValue(
        { [variable]: '900000' },
        'scheduleSafetyWindowMs',
      ),
    ).to.equal(900_000);

    for (const value of ['299999', '1000']) {
      const error = captureTuningError(() =>
        readContentDiffTuningValue(
          { [variable]: value },
          'scheduleSafetyWindowMs',
        ),
      );

      expect(error.details.minimumMs).to.equal(300_000);
      expect(error.message).to.contain(
        'from 300000 to 86400000 (default 300000); this value can only be raised above its default',
      );
    }
  });

  it('lists only values that differ from their defaults, in definition order', () => {
    expect(listContentDiffTuningOverrides(DEFAULTS)).to.deep.equal([]);
    expect(
      listContentDiffTuningOverrides({
        scheduleSafetyWindowMs: 600_000,
        assetHeadersTimeoutMs: 120_000,
        assetIdleTimeoutMs: 900_000,
      }),
    ).to.deep.equal([
      {
        key: 'assetIdleTimeoutMs',
        variable: 'DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS',
        valueMs: 900_000,
        defaultMs: 300_000,
      },
      {
        key: 'scheduleSafetyWindowMs',
        variable: 'DATOCMS_CONTENT_DIFF_SCHEDULE_SAFETY_WINDOW_MS',
        valueMs: 600_000,
        defaultMs: 300_000,
      },
    ]);
  });

  it('describes overrides with their variable, value, and default', () => {
    expect(
      listContentDiffTuningOverrides({
        assetHeadersTimeoutMs: 45_000,
        assetIdleTimeoutMs: 300_000,
      }).map(formatContentDiffTuningOverride),
    ).to.deep.equal([
      'DATOCMS_CONTENT_DIFF_ASSET_HEADERS_TIMEOUT_MS=45000 ms (default 120000 ms)',
    ]);
  });

  it('recognizes only tuning errors', () => {
    const error = captureTuningError(() =>
      readContentDiffTuningValue(
        { DATOCMS_CONTENT_DIFF_VALIDITY_TIMEOUT_MS: 'x' },
        'validityTimeoutMs',
      ),
    );

    expect(isContentDiffTuningError(error)).to.equal(true);
    expect(isContentDiffTuningError(new Error('other'))).to.equal(false);
    expect(isContentDiffTuningError({ code: 'INVALID_TUNING' })).to.equal(
      false,
    );
  });

  it('is the tuning code the generated runtime runs', async () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include(
      'src/content-diff/shared/tuning.ts',
    );
    const directory = await mkdtemp(join(tmpdir(), 'datocms-tuning-runtime-'));
    try {
      const path = join(directory, 'runtime.cjs');
      await writeFile(
        path,
        `${renderRuntime(
          'js',
        )}\nmodule.exports.__readContentDiffTuningValue = readContentDiffTuningValue;\n`,
      );
      const runtimeRead = createRequire(path)(path)
        .__readContentDiffTuningValue as typeof readContentDiffTuningValue;
      const outcome = (
        read: typeof readContentDiffTuningValue,
        key: ContentDiffTuningKey,
        value: string | undefined,
      ) => {
        const variable = CONTENT_DIFF_TUNING_DEFINITIONS.find(
          (definition) => definition.key === key,
        )!.variable;
        try {
          return { value: read({ [variable]: value }, key) };
        } catch (error) {
          const { name, code, message, details } =
            error as ContentDiffTuningError;
          return { name, code, message, details };
        }
      };
      const cases: Array<[ContentDiffTuningKey, string | undefined]> = [
        ...[
          undefined,
          '1000',
          '86400000',
          '999',
          '86400001',
          'abc',
          '1.5',
          '1e4',
          '-1000',
          ' 1000',
          '',
          '0x3e8',
        ].map((value): [ContentDiffTuningKey, string | undefined] => [
          'assetIdleTimeoutMs',
          value,
        ]),
        ['scheduleSafetyWindowMs', '299999'],
        ['scheduleSafetyWindowMs', '600000'],
      ];

      for (const [key, value] of cases) {
        expect(outcome(runtimeRead, key, value), String(value)).to.deep.equal(
          outcome(readContentDiffTuningValue, key, value),
        );
      }
      expect(outcome(runtimeRead, 'assetIdleTimeoutMs', '').code).to.equal(
        'INVALID_TUNING',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function captureTuningError(action: () => unknown): ContentDiffTuningError {
  try {
    action();
  } catch (error) {
    expect(isContentDiffTuningError(error)).to.equal(true);
    return error as ContentDiffTuningError;
  }

  throw new Error('Expected tuning resolution to fail');
}
