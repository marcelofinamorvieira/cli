import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import {
  CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
  RUNTIME_VERSION,
  renderRuntime,
} from '../../src/content-diff/runtime-template';
import { CONTENT_DIFF_MANIFEST_VERSION } from '../../src/content-diff/shared/contract';
import { SHARED_FAILURE_CODES } from '../../src/content-diff/shared/failure-kinds';
import { sha256, stableStringify } from '../../src/content-diff/shared/json';
import {
  legacyIdMappingChunkName,
  legacyIdMappingKey,
  legacyIdMappingSortKey,
  validateLegacyIdMappingEntry,
} from '../../src/content-diff/shared/legacy-id-mapping';
import {
  assertContentDiffEnvelope,
  constantTimeEqualHex,
  validateContentDiffPlan,
} from '../../src/content-diff/shared/plan-validation';
import { ContentDiffError } from '../../src/content-diff/types';

type Failure = Error & { code?: string; details?: unknown };
type AnyFunction = (...args: any[]) => any;

const RUNTIME_EXPORTS = [
  'constantTimeEqualHex',
  'legacyIdMappingChunkName',
  'legacyIdMappingKey',
  'legacyIdMappingSortKey',
  'validateLegacyIdMappingEntry',
] as const;

type RuntimePlanValidation = Record<
  `__${(typeof RUNTIME_EXPORTS)[number]}`,
  AnyFunction
> & {
  runContentDiffMigration(
    client: unknown,
    envelope: unknown,
    options: unknown,
  ): Promise<void>;
};

const PLAN = { formatVersion: 9, marker: 'not validated before integrity' };

function envelopeFor(plan: unknown): Record<string, any> {
  return {
    formatVersion: CONTENT_DIFF_MANIFEST_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    integrity: {
      algorithm: 'sha256',
      planSha256: sha256(stableStringify(plan)),
    },
    plan,
  };
}

function capture(task: () => unknown): Failure {
  try {
    task();
  } catch (error) {
    return error as Failure;
  }
  throw new Error('Expected a failure.');
}

describe('shared plan and manifest validation', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimePlanValidation;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-plan-validation-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        ...RUNTIME_EXPORTS.map((name) => `module.exports.__${name} = ${name};`),
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimePlanValidation;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function runtimeFailure(envelope: unknown): Promise<Failure> {
    let clientReads = 0;
    const client = new Proxy(
      {},
      {
        get() {
          clientReads += 1;
          throw new Error('CMA client was accessed');
        },
      },
    );
    try {
      await runtime.runContentDiffMigration(client, envelope, {
        executionContext: {
          contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
        },
        tuningEnv: {},
        log: () => undefined,
      });
    } catch (error) {
      expect(clientReads).to.equal(0);
      return error as Failure;
    }
    throw new Error('Expected the runtime to reject the manifest.');
  }

  it('is the validation code the generated runtime runs', () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include.members([
      'src/content-diff/shared/legacy-id-mapping.ts',
      'src/content-diff/shared/plan-validation.ts',
    ]);
    const source = renderRuntime('js');
    expect(source).to.contain('assertContentDiffEnvelope(envelope);');
    expect(source).to.contain('validateContentDiffPlan(plan);');
  });

  it('reports each plan and manifest failure kind under its own code on each side', () => {
    expect({
      unsupportedPlan: SHARED_FAILURE_CODES.unsupportedPlan,
      planSchemaMismatch: SHARED_FAILURE_CODES.planSchemaMismatch,
      unsupportedContentState: SHARED_FAILURE_CODES.unsupportedContentState,
      invalidManifest: SHARED_FAILURE_CODES.invalidManifest,
      unsupportedManifest: SHARED_FAILURE_CODES.unsupportedManifest,
      unsupportedRuntime: SHARED_FAILURE_CODES.unsupportedRuntime,
      planIntegrityFailure: SHARED_FAILURE_CODES.planIntegrityFailure,
    }).to.deep.equal({
      unsupportedPlan: {
        planner: 'UNSUPPORTED_CONTENT_STATE',
        runtime: 'UNSUPPORTED_PLAN',
      },
      planSchemaMismatch: {
        planner: 'UNSUPPORTED_CONTENT_STATE',
        runtime: 'SCHEMA_MISMATCH',
      },
      unsupportedContentState: {
        planner: 'UNSUPPORTED_CONTENT_STATE',
        runtime: 'UNSUPPORTED_CONTENT_STATE',
      },
      invalidManifest: {
        planner: 'UNSUPPORTED_CONTENT_STATE',
        runtime: 'INVALID_MANIFEST',
      },
      unsupportedManifest: {
        planner: 'UNSUPPORTED_CONTENT_STATE',
        runtime: 'UNSUPPORTED_MANIFEST',
      },
      unsupportedRuntime: {
        planner: 'UNSUPPORTED_CONTENT_STATE',
        runtime: 'UNSUPPORTED_RUNTIME',
      },
      planIntegrityFailure: {
        planner: 'UNSUPPORTED_CONTENT_STATE',
        runtime: 'PLAN_INTEGRITY_FAILURE',
      },
    });
  });

  it('rejects malformed manifests with one message and each side keeping its code (D23)', async () => {
    const cases: Array<{
      name: string;
      envelope: unknown;
      message: string;
      runtimeCode: string;
    }> = [
      {
        name: 'not an object',
        envelope: [],
        message: 'Content migration manifest is not an object.',
        runtimeCode: 'INVALID_MANIFEST',
      },
      {
        name: 'manifest version',
        envelope: { ...envelopeFor(PLAN), formatVersion: 9 },
        message: 'Unsupported content migration manifest version: 9',
        runtimeCode: 'UNSUPPORTED_MANIFEST',
      },
      {
        name: 'runtime version',
        envelope: { ...envelopeFor(PLAN), runtimeVersion: '16' },
        message: `Content migration requires runtime 16, but this file is runtime ${RUNTIME_VERSION}.`,
        runtimeCode: 'UNSUPPORTED_RUNTIME',
      },
      {
        name: 'integrity algorithm',
        envelope: {
          ...envelopeFor(PLAN),
          integrity: { algorithm: 'md5', planSha256: 'abc' },
        },
        message: 'Content migration manifest has invalid integrity metadata.',
        runtimeCode: 'INVALID_MANIFEST',
      },
      {
        name: 'missing plan',
        envelope: { ...envelopeFor(PLAN), plan: null },
        message: 'Content migration manifest has no plan.',
        runtimeCode: 'INVALID_MANIFEST',
      },
      {
        // Integrity is proved before any plan check: this plan is invalid too.
        name: 'plan hash',
        envelope: { ...envelopeFor(PLAN), plan: { ...PLAN, marker: 'x' } },
        message: 'Content migration plan integrity validation failed.',
        runtimeCode: 'PLAN_INTEGRITY_FAILURE',
      },
    ];

    for (const testCase of cases) {
      const planner = capture(() =>
        assertContentDiffEnvelope(testCase.envelope),
      );
      expect(planner, testCase.name).to.be.instanceOf(ContentDiffError);
      expect(planner, testCase.name).to.include({
        code: 'UNSUPPORTED_CONTENT_STATE',
        message: testCase.message,
      });
      expect(planner.details, testCase.name).to.equal(undefined);

      const executed = await runtimeFailure(testCase.envelope);
      expect(executed, testCase.name).to.include({
        name: 'ContentDiffRuntimeError',
        code: testCase.runtimeCode,
        message: testCase.message,
      });
      expect(executed.details, testCase.name).to.equal(null);
    }

    const executedPlan = await runtimeFailure(envelopeFor(PLAN));
    expect(executedPlan).to.include({
      code: 'UNSUPPORTED_PLAN',
      message: 'Unsupported content diff plan version: 9',
    });
    const plannedPlan = capture(() =>
      validateContentDiffPlan(assertContentDiffEnvelope(envelopeFor(PLAN))),
    );
    expect(plannedPlan).to.include({
      code: 'UNSUPPORTED_CONTENT_STATE',
      message: 'Unsupported content diff plan version: 9',
    });
  });

  it('compares plan digests case-insensitively in the planner and the runtime', () => {
    const envelope = envelopeFor(PLAN);
    envelope.integrity.planSha256 = envelope.integrity.planSha256.toUpperCase();
    expect(assertContentDiffEnvelope(envelope)).to.equal(envelope.plan);

    const table: Array<[unknown, unknown, boolean]> = [
      ['abc123', 'ABC123', true],
      ['abc123', 'abc124', false],
      ['abc', 'abcd', false],
      ['', '', false],
      ['xyz', 'xyz', false],
      [null, 'null', false],
    ];
    for (const [left, right, expected] of table) {
      expect(constantTimeEqualHex(left, right), `${left}/${right}`).to.equal(
        expected,
      );
      expect(
        runtime.__constantTimeEqualHex(left, right),
        `${left}/${right}`,
      ).to.equal(expected);
    }
  });

  it('keys, sorts and names legacy-ID mappings the same way on both sides', () => {
    const table: Array<[string, string]> = [
      ['record', '123'],
      ['block', '123'],
      ['upload', '123'],
      ['upload_collection', '123'],
    ];
    for (const [entityType, id] of table) {
      expect(runtime.__legacyIdMappingKey(entityType, id)).to.equal(
        legacyIdMappingKey(entityType, id),
      );
      expect(runtime.__legacyIdMappingSortKey(entityType, id)).to.equal(
        legacyIdMappingSortKey(entityType, id),
      );
    }
    expect(legacyIdMappingKey('record', '1')).to.equal(
      legacyIdMappingKey('block', '1'),
    );
    expect(legacyIdMappingKey('upload', '1')).to.equal('upload\u00001');
    expect(legacyIdMappingSortKey('block', '1')).to.equal('block\u00001');
    expect(legacyIdMappingChunkName('batch', 0, 3)).to.equal(
      'legacy-id-map:batch:1/3',
    );
    expect(runtime.__legacyIdMappingChunkName('batch', 2, 3)).to.equal(
      legacyIdMappingChunkName('batch', 2, 3),
    );
  });

  it('rejects malformed legacy-ID mapping entries with each side keeping its code', () => {
    const entry = {
      entityType: 'record',
      sourceId: '123',
      targetId: 'YhEa5SbeSl6KwIFizzkzig',
    };
    expect(() =>
      validateLegacyIdMappingEntry(entry, false, 'mapping document entry'),
    ).not.to.throw();
    expect(() =>
      runtime.__validateLegacyIdMappingEntry(
        entry,
        false,
        'mapping document entry',
      ),
    ).not.to.throw();

    for (const invalid of [
      null,
      { ...entry, sourceId: '0123' },
      { ...entry, targetId: 'not-portable' },
      { ...entry, status: 'new' },
    ]) {
      const planner = capture(() =>
        validateLegacyIdMappingEntry(invalid, false, 'mapping document entry'),
      );
      expect(planner).to.be.instanceOf(ContentDiffError);
      expect(planner).to.include({
        code: 'UNSUPPORTED_CONTENT_STATE',
        message: 'Invalid legacy-ID mapping document entry.',
      });
      const executed = capture(() =>
        runtime.__validateLegacyIdMappingEntry(
          invalid,
          false,
          'mapping document entry',
        ),
      );
      expect(executed).to.include({
        name: 'ContentDiffRuntimeError',
        code: 'INVALID_PLAN',
        message: 'Invalid legacy-ID mapping document entry.',
      });
    }
  });
});
