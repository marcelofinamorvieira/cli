import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  link as fsLink,
  rename as fsRename,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect } from 'chai';
import {
  semanticHash,
  stableStringify,
} from '../../src/content-diff/canonicalize';
import {
  CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
  RUNTIME_VERSION,
  renderRuntime,
} from '../../src/content-diff/runtime-template';
import {
  computeSchemaDigest,
  inspectionItemTypesDigest,
  schemaWithValidatorRelaxations,
} from '../../src/content-diff/shared/schema-state';
import { compareUploadChanges } from '../../src/content-diff/shared/upload-contract';
import type {
  ContentDiffPlan,
  JsonValue,
  RecordSnapshot,
  UploadCollectionSnapshot,
  UploadSnapshot,
} from '../../src/content-diff/types';
import {
  CONTENT_DIFF_GENERATOR_VERSION,
  CONTENT_PLAN_FORMAT_VERSION,
  ContentDiffError,
  INVALID_CONTENT_FORMAT_VERSION,
  LEGACY_ID_MAPPING_FORMAT_VERSION,
} from '../../src/content-diff/types';
import {
  type ArtifactFileOperations,
  type ContentPlanEnvelope,
  buildEnvelope,
  writeContentDiffArtifacts,
} from '../../src/content-diff/write-artifacts';

const temporaryDirectories: string[] = [];

describe('content diff artifact writer', () => {
  afterEach(async () => {
    (
      globalThis as Record<string, unknown>
    ).__contentDiffGeneratedWrapperInvocation = undefined;
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('writes a checksummed manifest, immutable runtime, and migration wrapper', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000000_syncContent.js');
    const plan = makePlan();
    const result = await writeContentDiffArtifacts({
      plan,
      migrationFilePath: migrationPath,
      format: 'js',
      bundleAssets: false,
    });

    const manifestBytes = await readFile(result.planPath);
    const manifest = JSON.parse(
      manifestBytes.toString('utf8'),
    ) as ContentPlanEnvelope;
    const wrapper = await readFile(result.migrationPath, 'utf8');
    const runtime = await readFile(result.runtimePath, 'utf8');

    expect(result.manifestSha256).to.equal(sha256(manifestBytes));
    expect(manifest.formatVersion).to.equal(10);
    expect(manifest.runtimeVersion).to.equal(RUNTIME_VERSION);
    expect(manifest.integrity.planSha256).to.equal(
      sha256(stableStringify(manifest.plan)),
    );
    expect(manifest.plan).to.deep.equal(plan);
    expect(wrapper).to.contain(
      `./.datocms-content/runtime-v${RUNTIME_VERSION}`,
    );
    expect(wrapper).to.contain(result.manifestSha256);
    expect(wrapper).to.contain('// datocms-content-diff-binding ');
    expect(wrapper).to.contain('"bindingVersion":1');
    expect(wrapper).to.contain('"targetSiteId":"site-id"');
    expect(wrapper).to.contain(
      `"manifestBasename":"1700000000_syncContent.plan.json"`,
    );
    expect(wrapper).to.contain(
      'module.exports = async function contentDiffMigration(client, executionContext)',
    );
    expect(wrapper).to.contain(
      `executionContext.contentDiffProtocolVersion !== ${CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION}`,
    );
    expect(wrapper).to.contain('executionContext,');
    expect(wrapper).not.to.contain('migrationFilePath');
    expect(runtime).to.equal(`${renderRuntime('js').trimEnd()}\n`);
    expect(result.assetsPath).to.equal(undefined);
    await expectNoStagingDirectories(directory);
  });

  it('writes an equivalent TypeScript migration wrapper', async () => {
    const directory = await makeTemporaryDirectory();
    const result = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000001_syncContent.ts'),
      format: 'ts',
      bundleAssets: false,
    });
    const wrapper = await readFile(result.migrationPath, 'utf8');

    expect(wrapper).to.contain(
      "import type { Client } from 'datocms/lib/cma-client-node'",
    );
    expect(wrapper).to.contain(
      `import { runContentDiffMigration } from "./.datocms-content/runtime-v${RUNTIME_VERSION}"`,
    );
    expect(wrapper).to.contain('type MigrationExecutionContext =');
    expect(wrapper).to.contain('executionContext?: MigrationExecutionContext');
    expect(wrapper).to.contain(
      `readonly contentDiffProtocolVersion: ${CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION}`,
    );
    expect(wrapper).to.contain('readonly abortSignal?: AbortSignal;');
    expect(wrapper).not.to.contain('migrationFilePath');
    expect(wrapper).to.contain('export default async function');
    expect(wrapper).to.contain(result.manifestSha256);
    expect(result.runtimePath).to.match(
      new RegExp(`runtime-v${RUNTIME_VERSION}\\.ts$`),
    );
  });

  it('generated wrappers reject old runners before dispatch and accept the current protocol', async () => {
    const directory = await makeTemporaryDirectory();
    const result = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000002_protocol.js'),
      format: 'js',
      bundleAssets: false,
    });
    await writeFile(
      result.runtimePath,
      `'use strict';\nmodule.exports.runContentDiffMigration = async function (_client, _envelope, options) {\n  globalThis.__contentDiffGeneratedWrapperInvocation = options;\n};\n`,
    );
    const localRequire = createRequire(join(directory, 'loader.cjs'));
    const migration = localRequire(result.migrationPath) as (
      client: unknown,
      context?: {
        contentDiffProtocolVersion?: number;
        abortSignal?: AbortSignal;
      },
    ) => Promise<void>;
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

    for (const context of [undefined, {}, { contentDiffProtocolVersion: 0 }]) {
      const error = await expectRejects(migration(client, context));
      expect(error.message).to.contain(
        `expected ${CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION}`,
      );
      expect(error.message).to.contain('Upgrade the datocms CLI');
      expect(
        (globalThis as Record<string, unknown>)
          .__contentDiffGeneratedWrapperInvocation,
      ).to.equal(undefined);
    }

    const executionContext = {
      contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
      abortSignal: new AbortController().signal,
    };
    await migration(client, executionContext);
    const invocation = (globalThis as Record<string, unknown>)
      .__contentDiffGeneratedWrapperInvocation as {
      manifestPath: string;
      executionContext: typeof executionContext;
    };
    expect(Object.keys(invocation).sort()).to.deep.equal([
      'executionContext',
      'manifestPath',
    ]);
    // The runner's context, abort signal included, is forwarded unchanged.
    expect(invocation.executionContext).to.equal(executionContext);
    expect(await realpath(invocation.manifestPath)).to.equal(
      await realpath(result.planPath),
    );
    expect(clientReads).to.equal(0);
  });

  it('rejects unauthorized validator relaxations before installing artifacts', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000002_invalidPlan.js');
    const plan = makePlan();
    plan.schema.itemTypes = makeWriterCreatePlanWithBlock().schema.itemTypes;
    plan.schema.itemTypes[0].fields[0].validators = { required: {} };
    // An exact, reversible relaxation that only lacks its authorization.
    plan.invalidContent.validatorRelaxations.push({
      fieldId: 'content-field-id',
      itemTypeId: 'model-id',
      originalValidators: { required: {} },
      relaxedValidators: {},
      originalHash: semanticHash({ required: {} }),
      relaxedHash: semanticHash({}),
      allowedValidatorHashes: [
        semanticHash({ required: {} }),
        semanticHash({}),
      ],
      relaxedValidatorKeys: ['required'],
      affectedRecordIds: ['record-id'],
      reasons: [
        {
          code: 'INVALID_CURRENT',
          slice: 'current',
          message: 'The source record is invalid.',
          fieldId: 'content-field-id',
          validatorKey: 'required',
          dependencyChain: ['record-id'],
        },
      ],
    });
    sealPlanDigests(plan);

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
      }),
    );

    expect(error).to.include({
      code: 'UNSUPPORTED_CONTENT_STATE',
      message:
        'Validator relaxations require migrateInvalidContent=true in the generated plan.',
    });
    expect(await pathExists(migrationPath)).to.equal(false);
    expect(
      await pathExists(
        join(directory, '.datocms-content', '1700000002_invalidPlan.plan.json'),
      ),
    ).to.equal(false);
    await expectNoStagingDirectories(directory);
  });

  it('serializes valid fresh nested UPDATE IDs and rejects invalid target predecessors', async () => {
    for (const targetValid of [false, true]) {
      const directory = await makeTemporaryDirectory();
      const migrationPath = join(directory, '1700000003_freshBlockUpdate.js');
      const plan = makePlan();
      plan.schema.itemTypes = makeWriterCreatePlanWithBlock().schema.itemTypes;
      sealPlanDigests(plan);
      plan.execution.publishOrder = ['record-id'];
      plan.execution.updateOrder = ['record-id'];
      const baseline = makeRecordSnapshotWithBlock(
        'record-id',
        'YhEa5SbeSl6KwIFizzkzig',
        'baseline',
      );
      baseline.validity.current = targetValid;
      baseline.consistency.currentValid = targetValid;
      const desired = makeRecordSnapshotWithBlock(
        'record-id',
        'XSPMXvayT-yMUrVxP-YoSw',
        'desired',
      );
      plan.records.push({
        id: 'record-id',
        itemTypeId: 'model-id',
        action: 'update',
        expectedTargetHash: baseline.hash,
        baseline,
        desired,
        changes: {
          current: true,
          published: false,
          topology: false,
          lifecycle: false,
          stage: false,
          schedules: false,
        },
        dependencies: [],
        publishedDependencies: [],
        allowedIntermediateHashes: [],
      });

      const operation = writeContentDiffArtifacts({
        plan,
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
      });
      if (targetValid) {
        const result = await operation;
        const stored = JSON.parse(await readFile(result.planPath, 'utf8'));
        expect(stored.plan.records[0].desired.current.fields).to.deep.equal(
          desired.current.fields,
        );
        expect(await pathExists(migrationPath)).to.equal(true);
      } else {
        const error = await expectRejects(operation);
        expect(error.message).to.contain(
          'fresh nested block XSPMXvayT-yMUrVxP-YoSw during current-restore',
        );
        expect(error.message).to.contain(
          'This write requires an invalid or revalidating predecessor',
        );
        expect(await pathExists(migrationPath)).to.equal(false);
      }
      await expectNoStagingDirectories(directory);
    }
  });

  it('refuses to serialize a unique release targeting an embedded field', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000003_embeddedRelease.js');
    const plan = makePlan();
    plan.schema.itemTypes.push({
      id: 'model-id',
      apiKey: 'model',
      name: 'Model',
      modularBlock: false,
      singleton: false,
      sortable: false,
      tree: false,
      draftModeActive: true,
      draftSavingActive: true,
      allLocalesRequired: false,
      workflowId: null,
      fields: [
        {
          id: 'content-field-id',
          apiKey: 'content',
          fieldType: 'single_block',
          localized: false,
          position: 1,
          validators: { unique: {} },
        },
      ],
    });
    plan.schema.itemTypes.push(
      makeWriterCreatePlanWithBlock().schema.itemTypes[1],
    );
    sealPlanDigests(plan);
    plan.execution.publishOrder = ['record-id'];
    plan.execution.updateOrder = ['record-id'];
    const snapshot = makeRecordSnapshotWithBlock(
      'record-id',
      'YhEa5SbeSl6KwIFizzkzig',
      'baseline',
    );
    const intermediateCurrentHash = semanticHash(snapshot.current.fields);
    plan.records.push({
      id: 'record-id',
      itemTypeId: 'model-id',
      action: 'update',
      expectedTargetHash: snapshot.hash,
      baseline: snapshot,
      desired: structuredClone(snapshot),
      changes: {
        current: false,
        published: false,
        topology: false,
        lifecycle: false,
        stage: false,
        schedules: false,
      },
      dependencies: [],
      publishedDependencies: [],
      allowedIntermediateHashes: [intermediateCurrentHash],
    });
    plan.execution.uniqueReleases.push({
      recordId: 'record-id',
      fields: snapshot.current.fields,
      consumerRecordIds: [],
      intermediateCurrentHash,
    });

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
      }),
    );

    expect(error.message).to.contain(
      'does not resolve to a string, slug, or link field carrying a unique validator',
    );
    expect(await pathExists(migrationPath)).to.equal(false);
    await expectNoStagingDirectories(directory);
  });

  it('refuses to serialize a published-derived deletion release with transient nested block IDs', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000003_transientRelease.js');
    const plan = makePlan();
    plan.schema.itemTypes = makeWriterCreatePlanWithBlock().schema.itemTypes;
    sealPlanDigests(plan);
    const baseline = makeRecordSnapshotWithBlock(
      'record-id',
      'YhEa5SbeSl6KwIFizzkzig',
      'baseline',
    );
    plan.records.push({
      id: 'record-id',
      itemTypeId: 'model-id',
      action: 'delete',
      expectedTargetHash: baseline.hash,
      baseline,
      desired: null,
      changes: {
        current: false,
        published: false,
        topology: false,
        lifecycle: false,
        stage: false,
        schedules: false,
      },
      dependencies: [],
      publishedDependencies: [],
      allowedIntermediateHashes: [semanticHash({})],
    });
    plan.execution.deleteReleases.push({
      recordId: 'record-id',
      fields: {},
      intermediateCurrentHash: semanticHash({}),
      publish: true,
      transientNestedBlockIds: ['YhEa5SbeSl6KwIFizzkzig'],
    });

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
      }),
    );

    expect(error.message).to.contain(
      'Delete-reference release record-id requires fresh published-derived nested block IDs',
    );
    expect(await pathExists(migrationPath)).to.equal(false);
    expect(
      await pathExists(
        join(
          directory,
          '.datocms-content',
          '1700000003_transientRelease.plan.json',
        ),
      ),
    ).to.equal(false);
    await expectNoStagingDirectories(directory);
  });

  it('refuses to overwrite an existing migration or content plan', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000001_existing.js');
    const first = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: migrationPath,
      format: 'js',
      bundleAssets: false,
    });
    const originalMigration = await readFile(first.migrationPath);
    const originalPlan = await readFile(first.planPath);

    const migrationError = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
      }),
    );
    expect(migrationError.message).to.contain(
      'Refusing to overwrite existing migration',
    );
    expect(await readFile(first.migrationPath)).to.deep.equal(
      originalMigration,
    );
    expect(await readFile(first.planPath)).to.deep.equal(originalPlan);

    const secondMigration = join(directory, '1700000002_existingPlan.js');
    const secondPlan = join(
      directory,
      '.datocms-content',
      '1700000002_existingPlan.plan.json',
    );
    await mkdir(join(directory, '.datocms-content'), { recursive: true });
    await writeFile(secondPlan, 'keep me\n');

    const planError = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: secondMigration,
        format: 'js',
        bundleAssets: false,
      }),
    );
    expect(planError.message).to.contain(
      'Refusing to overwrite existing content plan',
    );
    expect(await readFile(secondPlan, 'utf8')).to.equal('keep me\n');
    expect(await pathExists(secondMigration)).to.equal(false);
    await expectNoStagingDirectories(directory);
  });

  it('reuses byte-identical runtimes and rejects a mismatched runtime', async () => {
    const directory = await makeTemporaryDirectory();
    const first = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000003_first.js'),
      format: 'js',
      bundleAssets: false,
    });
    const originalRuntime = await readFile(first.runtimePath);
    const second = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000004_second.js'),
      format: 'js',
      bundleAssets: false,
    });

    expect(second.runtimePath).to.equal(first.runtimePath);
    expect(await readFile(second.runtimePath)).to.deep.equal(originalRuntime);

    await writeFile(first.runtimePath, 'mismatched runtime\n');
    const thirdMigration = join(directory, '1700000005_third.js');
    const mismatchError = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: thirdMigration,
        format: 'js',
        bundleAssets: false,
      }),
    );

    expect(mismatchError.message).to.contain(
      'Refusing to overwrite mismatched immutable runtime',
    );
    expect(await pathExists(thirdMigration)).to.equal(false);
    expect(
      await pathExists(
        join(directory, '.datocms-content', '1700000005_third.plan.json'),
      ),
    ).to.equal(false);
    expect(await readFile(first.runtimePath, 'utf8')).to.equal(
      'mismatched runtime\n',
    );
    await expectNoStagingDirectories(directory);
  });

  it('installs runtime v17 beside an immutable legacy runtime v16', async () => {
    const directory = await makeTemporaryDirectory();
    const contentDirectory = join(directory, '.datocms-content');
    const legacyRuntimePath = join(contentDirectory, 'runtime-v16.js');
    const legacyBytes = 'immutable runtime v16 bytes\n';
    await mkdir(contentDirectory, { recursive: true });
    await writeFile(legacyRuntimePath, legacyBytes);

    const result = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000005_runtimeV17.js'),
      format: 'js',
      bundleAssets: false,
    });

    expect(RUNTIME_VERSION).to.equal('17');
    expect(result.runtimePath).to.equal(
      join(contentDirectory, 'runtime-v17.js'),
    );
    expect(await readFile(legacyRuntimePath, 'utf8')).to.equal(legacyBytes);
    expect(await readFile(result.runtimePath, 'utf8')).to.equal(
      `${renderRuntime('js').trimEnd()}\n`,
    );
  });

  it('removes staged output when a bundled asset fails its MD5 check', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000006_badAsset.js');
    const plan = makePlanWithUpload('00000000000000000000000000000000');
    const fetchFn = (async () =>
      new Response('different asset bytes')) as typeof fetch;
    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: true,
        fetchFn,
      }),
    );

    expect(error.message).to.contain('changed while bundling');
    expect(await pathExists(migrationPath)).to.equal(false);
    expect(
      await pathExists(
        join(directory, '.datocms-content', '1700000006_badAsset.plan.json'),
      ),
    ).to.equal(false);
    expect(
      await pathExists(
        join(directory, '.datocms-content', `runtime-v${RUNTIME_VERSION}.js`),
      ),
    ).to.equal(false);
    expect(
      await pathExists(
        join(directory, '.datocms-content', '1700000006_badAsset.assets'),
      ),
    ).to.equal(false);
    expect(plan.uploads[0].desired?.transport.bundledPath).to.equal(null);
    expect(plan.uploads[0].desired?.transport.sha256).to.equal(null);
    await expectNoStagingDirectories(directory);
  });

  it('drains active asset downloads and stops queued downloads before cleaning up a failed bundle', async () => {
    const directory = await makeTemporaryDirectory();
    const bytes = Buffer.from('asset download bytes');
    const plan = makePlanWithUpload(
      createHash('md5').update(bytes).digest('hex'),
    );
    const firstUpload = plan.uploads[0];
    plan.uploads = [
      firstUpload.id,
      'T8x4VhMPT_KxTHtz9r7mCA',
      'N_x2F8mBRZivlvO0fD1q6A',
    ].map((id) => {
      const upload = structuredClone(firstUpload);
      upload.id = id;
      upload.desired!.id = id;
      upload.desired!.size = bytes.length;
      upload.desired!.transport.sourceUrl = `https://example.test/${id}`;
      refreshUploadHash(upload.desired!);
      return upload;
    });
    plan.execution.uploadOrder = plan.uploads.map(({ id }) => id);
    plan.summary.uploads.create = plan.uploads.length;
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    let secondDownloadStarted!: () => void;
    const secondDownload = new Promise<void>((resolve) => {
      secondDownloadStarted = resolve;
    });
    const fetchedUrls: string[] = [];
    const originalError = new Error('asset download failed');
    let settled = false;
    const generation = expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: join(directory, '1700000010_downloadFailure.js'),
        format: 'js',
        bundleAssets: true,
        fetchFn: (async (url) => {
          fetchedUrls.push(String(url));
          if (fetchedUrls.length === 1) throw originalError;
          if (fetchedUrls.length === 2) {
            secondDownloadStarted();
            await downloadGate;
          }
          return new Response(bytes);
        }) as typeof fetch,
      }),
    ).then((error) => {
      settled = true;
      return error;
    });

    let settledBeforeDownloadFinished: boolean;
    try {
      await secondDownload;
      await new Promise((resolve) => setTimeout(resolve, 30));
      settledBeforeDownloadFinished = settled;
    } finally {
      releaseDownload();
    }
    expect(await generation).to.equal(originalError);
    expect(settledBeforeDownloadFinished).to.equal(false);
    expect(fetchedUrls).to.have.length(2);
    await expectNoStagingDirectories(directory);
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('times out stalled concurrent bundling before cleanup and preserves the first download error', async () => {
    const directory = await makeTemporaryDirectory();
    const bytes = Buffer.from('asset download bytes');
    const plan = makePlanWithUpload(
      createHash('md5').update(bytes).digest('hex'),
    );
    const firstUpload = plan.uploads[0];
    plan.uploads = [
      firstUpload.id,
      'T8x4VhMPT_KxTHtz9r7mCA',
      'N_x2F8mBRZivlvO0fD1q6A',
    ].map((id) => {
      const upload = structuredClone(firstUpload);
      upload.id = id;
      upload.desired!.id = id;
      upload.desired!.size = bytes.length;
      upload.desired!.transport.sourceUrl = `https://example.test/${id}`;
      refreshUploadHash(upload.desired!);
      return upload;
    });
    plan.execution.uploadOrder = plan.uploads.map(({ id }) => id);
    plan.summary.uploads.create = plan.uploads.length;
    let requests = 0;
    let stalledBodyCancelled = false;
    const primaryError = new Error('first asset request failed');
    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: join(directory, '1700000011_stalledBundle.js'),
        format: 'js',
        bundleAssets: true,
        assetDownloadTimeouts: { headersTimeoutMs: 100, idleTimeoutMs: 10 },
        fetchFn: (async () => {
          requests += 1;
          if (requests === 1) throw primaryError;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 1));
              },
              cancel() {
                stalledBodyCancelled = true;
              },
            }),
          );
        }) as typeof fetch,
      }),
    );
    expect(error).to.equal(primaryError);
    expect(stalledBodyCancelled).to.equal(true);
    expect(requests).to.equal(2);
    await expectNoStagingDirectories(directory);
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('names the variable that raises an expired bundling download deadline', async () => {
    const directory = await makeTemporaryDirectory();
    const bytes = Buffer.from('asset download bytes');
    const plan = makePlanWithUpload(
      createHash('md5').update(bytes).digest('hex'),
    );
    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: join(directory, '1700000012_idleBundle.js'),
        format: 'js',
        bundleAssets: true,
        assetDownloadTimeouts: { headersTimeoutMs: 1_000, idleTimeoutMs: 10 },
        fetchFn: (async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 1));
              },
            }),
          )) as typeof fetch,
      }),
    );

    expect(error).to.be.instanceOf(ContentDiffError);
    expect((error as ContentDiffError).code).to.equal(
      'UPLOAD_DOWNLOAD_TIMEOUT',
    );
    expect(error.message).to.equal(
      'Upload download received no data for 10ms. Set DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS to wait longer.',
    );
    expect((error as ContentDiffError).details).to.deep.equal({
      phase: 'body',
      timeoutMilliseconds: 10,
      variable: 'DATOCMS_CONTENT_DIFF_ASSET_IDLE_TIMEOUT_MS',
    });
    await expectNoStagingDirectories(directory);
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('rejects upload action, delta, permission, and filename tampering before artifact exposure', async () => {
    const directory = await makeTemporaryDirectory();
    const cases: Array<{
      name: string;
      mutate(plan: ContentDiffPlan): void;
    }> = [
      {
        name: 'manual metadata array',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual = [] as unknown as UploadSnapshot['manual'];
          refreshUploadHash(desired);
        },
      },
      {
        name: 'manual metadata missing key',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          Reflect.deleteProperty(desired.manual, 'notes');
          refreshUploadHash(desired);
        },
      },
      {
        name: 'blank manual text',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual.notes = ' \t ';
          refreshUploadHash(desired);
        },
      },
      {
        name: 'Unicode-blank manual text',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual.notes = '\u0085';
          refreshUploadHash(desired);
        },
      },
      {
        name: 'NUL manual text',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual.notes = 'note\u0000suffix';
          refreshUploadHash(desired);
        },
      },
      {
        name: 'incomplete writable default metadata',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual.defaultFieldMetadata = {};
          refreshUploadHash(desired);
        },
      },
      {
        name: 'undeclared legacy transport fields',
        mutate(plan) {
          Object.assign(plan.uploads[0].desired!, {
            bundledPath: 'migration.assets/injected.bin',
            bundledSha256: 'a'.repeat(64),
          });
        },
      },
      {
        name: 'noncanonical tags',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual.tags = [' Foo ', 'foo'];
          refreshUploadHash(desired);
        },
      },
      {
        name: 'Unicode-space tag',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual.tags = ['blue\u0085tag'];
          refreshUploadHash(desired);
        },
      },
      {
        name: 'noncanonical MD5',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.md5 = desired.md5.toUpperCase();
          refreshUploadHash(desired);
        },
      },
      {
        name: 'negative size',
        mutate(plan) {
          plan.uploads[0].desired!.size = -1;
        },
      },
      {
        name: 'empty collection ID',
        mutate(plan) {
          const desired = plan.uploads[0].desired!;
          desired.manual.collectionId = '';
          refreshUploadHash(desired);
        },
      },
      {
        name: 'unusable binary transport',
        mutate(plan) {
          plan.uploads[0].desired!.transport.sourceUrl =
            'ftp://example.test/asset.txt';
        },
      },
      {
        name: 'HTTP shorthand binary transport',
        mutate(plan) {
          plan.uploads[0].desired!.transport.sourceUrl = 'http:asset.txt';
        },
      },
      ...[
        'C:/migration.assets/upload.bin',
        'migration.assets/./upload.bin',
        'migration.assets/\u0000upload.bin',
      ].map((bundledPath) => ({
        name: `unsafe bundled path ${bundledPath}`,
        mutate(plan: ContentDiffPlan) {
          plan.uploads[0].desired!.transport.bundledPath = bundledPath;
          plan.uploads[0].desired!.transport.sha256 = 'a'.repeat(64);
        },
      })),
      {
        name: 'semantic hash binding',
        mutate(plan) {
          plan.uploads[0].desired!.hash = 'stale-upload-hash';
        },
      },
      {
        name: 'binary changes tuple',
        mutate(plan) {
          const upload = convertCreateUploadToUpdate(plan);
          upload.baseline!.md5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
          refreshUploadHash(upload.baseline!);
          upload.expectedTargetHash = upload.baseline!.hash;
          upload.changes.binary = false;
          plan.requiredPermissions.uploadActions = ['read'];
        },
      },
      {
        name: 'binary EXIF correction permission',
        mutate(plan) {
          const upload = convertCreateUploadToUpdate(plan);
          upload.desired!.md5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
          refreshUploadHash(upload.desired!);
          upload.changes = compareUploadChanges(
            upload.desired!,
            upload.baseline!,
          );
          plan.requiredPermissions.uploadActions = ['read', 'replace_asset'];
        },
      },
      {
        name: 'collection changes tuple',
        mutate(plan) {
          const upload = convertCreateUploadToUpdate(plan);
          upload.desired!.manual.collectionId = 'collection-id';
          refreshUploadHash(upload.desired!);
          upload.changes.collection = false;
          plan.requiredPermissions.uploadActions = ['read'];
        },
      },
      {
        name: 'manual update permission',
        mutate(plan) {
          const upload = convertCreateUploadToUpdate(plan);
          upload.desired!.manual.notes = 'changed notes';
          refreshUploadHash(upload.desired!);
          upload.changes = compareUploadChanges(
            upload.desired!,
            upload.baseline!,
          );
          plan.requiredPermissions.uploadActions = ['read'];
        },
      },
      {
        name: 'rename permission',
        mutate(plan) {
          const upload = convertCreateUploadToUpdate(plan);
          upload.desired!.basename = 'renamed-asset';
          upload.desired!.filename = 'renamed-asset.txt';
          refreshUploadHash(upload.desired!);
          upload.changes = compareUploadChanges(
            upload.desired!,
            upload.baseline!,
          );
          plan.requiredPermissions.uploadActions = ['read'];
        },
      },
      {
        name: 'action baseline binding',
        mutate(plan) {
          plan.uploads[0].baseline = structuredClone(plan.uploads[0].desired);
        },
      },
      {
        name: 'non-portable upload create ID',
        mutate(plan) {
          const upload = plan.uploads[0];
          upload.id = 'bad/upload';
          upload.desired!.id = upload.id;
          refreshUploadHash(upload.desired!);
        },
      },
      ...[
        'Asset.txt',
        'asset name.txt',
        'fôô.txt',
        'asset--name.txt',
        'folder/asset.txt',
        'asset\\name.txt',
        'asset\u0000name.txt',
        '',
      ].map((filename) => ({
        name: `filename ${JSON.stringify(filename)}`,
        mutate(plan: ContentDiffPlan) {
          const desired = plan.uploads[0].desired!;
          desired.filename = filename;
          desired.basename = uploadStem(filename);
          refreshUploadHash(desired);
        },
      })),
    ];

    for (const [index, testCase] of cases.entries()) {
      const plan = makePlanWithUpload(
        createHash('md5').update('portable asset bytes').digest('hex'),
      );
      testCase.mutate(plan);
      const untouchedParent = join(directory, `case-${index}`);
      const error = await expectRejects(
        writeContentDiffArtifacts({
          plan,
          migrationFilePath: join(untouchedParent, 'migration.js'),
          format: 'js',
          bundleAssets: false,
        }),
      );
      expect(error.message, testCase.name).to.match(
        /upload|filename|baseline|permission|contract|portable|create/i,
      );
      expect(await pathExists(untouchedParent), testCase.name).to.equal(false);
    }
  });

  it('accepts sparse captured media defaults when a rename does not write them', async () => {
    const directory = await makeTemporaryDirectory();
    const plan = makePlanWithUpload(
      createHash('md5').update('portable asset bytes').digest('hex'),
    );
    const upload = convertCreateUploadToUpdate(plan);
    const sparseMetadata = {
      alt: {},
      title: {},
      custom_data: {},
      focal_point: null,
      poster_time: null,
    };
    upload.baseline!.manual.defaultFieldMetadata =
      structuredClone(sparseMetadata);
    upload.desired!.manual.defaultFieldMetadata =
      structuredClone(sparseMetadata);
    upload.desired!.basename = 'renamed-asset';
    upload.desired!.filename = 'renamed-asset.txt';
    refreshUploadHash(upload.baseline!);
    refreshUploadHash(upload.desired!);
    upload.expectedTargetHash = upload.baseline!.hash;
    upload.changes = compareUploadChanges(upload.desired!, upload.baseline!);
    plan.requiredPermissions.uploadActions = ['read', 'replace_asset'];

    const result = await writeContentDiffArtifacts({
      plan,
      migrationFilePath: join(directory, 'sparse-media-rename.js'),
      format: 'js',
      bundleAssets: false,
    });
    expect(await pathExists(result.migrationPath)).to.equal(true);
  });

  it('rejects re-signed record create identities before artifact filesystem writes', async () => {
    const directory = await makeTemporaryDirectory();
    const cases: Array<{
      name: string;
      mutate(plan: ContentDiffPlan): void;
    }> = [
      {
        name: 'desired record ID mismatch',
        mutate(plan) {
          plan.records[0].desired!.id = 'bad/record';
        },
      },
      {
        name: 'desired record item type mismatch',
        mutate(plan) {
          plan.records[0].desired!.itemTypeId = 'block-model-id';
        },
      },
      {
        name: 'non-portable nested block ID',
        mutate(plan) {
          const block = plan.records[0].desired!.current.fields.content as {
            id: string;
          };
          block.id = 'bad/block';
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const plan = makeWriterCreatePlanWithBlock();
      testCase.mutate(plan);
      const untouchedParent = join(directory, `record-case-${index}`);
      const error = await expectRejects(
        writeContentDiffArtifacts({
          plan,
          migrationFilePath: join(untouchedParent, 'migration.js'),
          format: 'js',
          bundleAssets: false,
        }),
      );
      expect(error.message, testCase.name).to.match(/identit|portable|create/i);
      expect(await pathExists(untouchedParent), testCase.name).to.equal(false);
    }
  });

  it('rejects every executable-plan violation the runtime rejects, with its message, before files (D23)', async () => {
    const directory = await makeTemporaryDirectory();
    const runtimePath = join(directory, 'runtime.cjs');
    await writeFile(runtimePath, renderRuntime('js'));
    const runtime = createRequire(join(directory, 'loader.cjs'))(
      runtimePath,
    ) as {
      runContentDiffMigration(
        client: unknown,
        envelope: unknown,
        options: unknown,
      ): Promise<void>;
    };
    const recordId = 'YhEa5SbeSl6KwIFizzkzig';
    const invalidPlan = (message: string) => ({
      message,
      runtimeCode: 'INVALID_PLAN',
      plannerCode: 'UNSUPPORTED_CONTENT_STATE',
    });
    const cases: Array<{
      name: string;
      mutate(plan: ContentDiffPlan): void;
      expected: { message: string; runtimeCode: string; plannerCode: string };
    }> = [
      {
        name: 'unsupported plan version',
        mutate(plan) {
          (plan as { formatVersion: number }).formatVersion = 9;
        },
        expected: {
          message: 'Unsupported content diff plan version: 9',
          runtimeCode: 'UNSUPPORTED_PLAN',
          plannerCode: 'UNSUPPORTED_CONTENT_STATE',
        },
      },
      {
        name: 'aligned projects on one project',
        mutate(plan) {
          plan.options.projectMode = 'aligned_projects';
        },
        expected: invalidPlan(
          'An aligned-projects content diff plan must use two different DatoCMS projects.',
        ),
      },
      {
        name: 'identical endpoints',
        mutate(plan) {
          plan.target.environmentId = plan.source.environmentId;
        },
        expected: invalidPlan(
          'Source and destination endpoints must be different.',
        ),
      },
      {
        name: 'incompatible schema digests',
        mutate(plan) {
          plan.target.schemaDigest = 'tampered';
        },
        expected: {
          message: 'The plan was generated from incompatible schemas.',
          runtimeCode: 'SCHEMA_MISMATCH',
          plannerCode: 'UNSUPPORTED_CONTENT_STATE',
        },
      },
      {
        name: 'incomplete environment semantics',
        mutate(plan) {
          Reflect.deleteProperty(plan.schema.environmentSemantics, 'timezone');
        },
        expected: invalidPlan(
          'Content diff plan is missing exact environment content-semantics metadata.',
        ),
      },
      {
        name: 'tampered inspection digest',
        mutate(plan) {
          plan.targetInspection.digest = 'tampered';
        },
        expected: invalidPlan(
          'Destination inspection-schema digest does not match its item types.',
        ),
      },
      {
        name: 'tracking model on the ledger API key',
        mutate(plan) {
          plan.options.migrationsModelApiKey = 'datocms_content_diff';
        },
        expected: invalidPlan(
          'The migrations tracking model cannot share the reserved content-diff ledger API key.',
        ),
      },
      {
        name: 'warnings that are not an array',
        mutate(plan) {
          (plan as { warnings: unknown }).warnings = null;
        },
        expected: invalidPlan(
          'Content diff plan property warnings must be an array.',
        ),
      },
      {
        name: 'missing execution order',
        mutate(plan) {
          Reflect.deleteProperty(plan.execution, 'updateOrder');
        },
        expected: invalidPlan(
          'Content diff execution property updateOrder must be an array.',
        ),
      },
      {
        name: 'duplicate record plan',
        mutate(plan) {
          plan.records.push(structuredClone(plan.records[0]));
        },
        expected: invalidPlan(`Plan contains duplicate record ID ${recordId}.`),
      },
      {
        name: 'invalid-content contract version',
        mutate(plan) {
          (plan.invalidContent as { formatVersion: number }).formatVersion = 2;
        },
        expected: invalidPlan(
          'Content diff plan has an invalid invalid-content contract.',
        ),
      },
      {
        name: 'tampered fully-relaxed digest',
        mutate(plan) {
          plan.invalidContent.schemaStates.fullyRelaxedDigest = 'tampered';
        },
        expected: invalidPlan(
          'The declared fully-relaxed schema digest does not match the validator relaxation plan.',
        ),
      },
      {
        name: 'undeclared schema-edit permission',
        mutate(plan) {
          Reflect.deleteProperty(plan.requiredPermissions, 'editSchema');
        },
        expected: invalidPlan(
          'Plan does not declare the schema-edit permission required by its temporary schema changes.',
        ),
      },
      {
        name: 'overdeclared upload actions',
        mutate(plan) {
          plan.requiredPermissions.uploadActions = ['read', 'create'];
        },
        expected: invalidPlan(
          'The plan upload permission declaration does not match its exact create, update, replace_asset, move, and delete operations. Regenerate the plan with the current plugin.',
        ),
      },
      {
        name: 'absent upload actions',
        mutate(plan) {
          Reflect.deleteProperty(plan.requiredPermissions, 'uploadActions');
        },
        expected: invalidPlan(
          'The plan upload permission declaration does not match its exact create, update, replace_asset, move, and delete operations. Regenerate the plan with the current plugin.',
        ),
      },
      {
        name: 'create missing from the create order',
        mutate(plan) {
          plan.execution.createOrder = [];
        },
        // The create-seed projection behind the sanitizer check needs the
        // order first, so its own contract error surfaces.
        expected: {
          message: `Execution createOrder is missing record ${recordId}.`,
          runtimeCode: 'INVALID_CREATE_ORDER',
          plannerCode: 'UNSUPPORTED_CONTENT_STATE',
        },
      },
      {
        name: 'record missing from the publication order',
        mutate(plan) {
          plan.execution.publishOrder = [];
        },
        expected: invalidPlan(
          `Execution order for record publication is missing: ${recordId}.`,
        ),
      },
      {
        name: 'empty shell component',
        mutate(plan) {
          plan.execution.shellComponents = [[]];
        },
        expected: invalidPlan(
          'Execution shellComponents must contain non-empty, sorted, unique shell-record ID arrays.',
        ),
      },
      {
        name: 'legacy-ID mapping contract version',
        mutate(plan) {
          (plan.legacyIdMappings as { formatVersion: number }).formatVersion =
            2;
        },
        expected: invalidPlan(
          'Content diff plan has an invalid legacy-ID mapping contract.',
        ),
      },
      {
        name: 'unique release without an update owner',
        mutate(plan) {
          plan.execution.uniqueReleases.push({
            recordId,
            fields: {},
            consumerRecordIds: [],
            intermediateCurrentHash: semanticHash({}),
          });
        },
        expected: invalidPlan(
          'Unique-value release contains an invalid owner, field payload, or intermediate hash.',
        ),
      },
      {
        name: 'no-draft model with a differing published state',
        mutate(plan) {
          plan.schema.itemTypes[0].draftModeActive = false;
          sealPlanDigests(plan);
        },
        expected: {
          message:
            'No-draft item type model-id cannot represent different current and published states.',
          runtimeCode: 'UNSUPPORTED_CONTENT_STATE',
          plannerCode: 'UNSUPPORTED_CONTENT_STATE',
        },
      },
    ];

    await writeContentDiffArtifacts({
      plan: makeWriterCreatePlanWithBlock(),
      migrationFilePath: join(directory, 'valid', 'migration.js'),
      format: 'js',
      bundleAssets: false,
    });

    for (const [index, testCase] of cases.entries()) {
      const plan = makeWriterCreatePlanWithBlock();
      testCase.mutate(plan);

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
      const runtimeError = await expectRejects(
        runtime.runContentDiffMigration(client, buildEnvelope(plan), {
          executionContext: {
            contentDiffProtocolVersion: CONTENT_DIFF_MIGRATION_PROTOCOL_VERSION,
          },
          tuningEnv: {},
          log: () => undefined,
        }),
      );
      expect(runtimeError, testCase.name).to.include({
        name: 'ContentDiffRuntimeError',
        code: testCase.expected.runtimeCode,
        message: testCase.expected.message,
      });
      expect(clientReads, testCase.name).to.equal(0);

      const untouchedParent = join(directory, `plan-case-${index}`);
      const generationError = await expectRejects(
        writeContentDiffArtifacts({
          plan,
          migrationFilePath: join(untouchedParent, 'migration.js'),
          format: 'js',
          bundleAssets: false,
        }),
      );
      expect(generationError, testCase.name).to.be.instanceOf(ContentDiffError);
      expect(generationError, testCase.name).to.include({
        code: testCase.expected.plannerCode,
        message: testCase.expected.message,
      });
      expect(await pathExists(untouchedParent), testCase.name).to.equal(false);
    }
  });

  it('rejects upload-collection contract, order, and permission tampering before files', async () => {
    const directory = await makeTemporaryDirectory();
    const collectionId = 'YhEa5SbeSl6KwIFizzkzig';
    const cases: Array<{
      name: string;
      mutate(plan: ContentDiffPlan): void;
    }> = [
      {
        name: 'desired ID mismatch',
        mutate(plan) {
          const desired = plan.uploadCollections[0].desired;
          desired.id = 'bad/collection';
          refreshCollectionHash(desired);
        },
      },
      {
        name: 'stale semantic hash',
        mutate(plan) {
          plan.uploadCollections[0].desired.hash = 'stale-hash';
        },
      },
      {
        name: 'update without delta',
        mutate(plan) {
          const collection = plan.uploadCollections[0];
          collection.desired = structuredClone(collection.baseline!);
        },
      },
      {
        name: 'missing execution order',
        mutate(plan) {
          plan.execution.collectionOrder = [];
        },
      },
      {
        name: 'missing manage permission',
        mutate(plan) {
          plan.requiredPermissions.manageUploadCollections = false;
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const plan = makePlan();
      const baseline = makeWriterCollectionSnapshot(
        collectionId,
        'baseline-label',
        1,
      );
      const desired = makeWriterCollectionSnapshot(
        collectionId,
        'desired-label',
        2,
      );
      plan.uploadCollections = [
        {
          id: collectionId,
          action: 'update',
          expectedTargetHash: baseline.hash,
          baseline,
          desired,
        },
      ];
      plan.execution.collectionOrder = [collectionId];
      plan.requiredPermissions.manageUploadCollections = true;
      testCase.mutate(plan);

      const untouchedParent = join(directory, `collection-case-${index}`);
      const error = await expectRejects(
        writeContentDiffArtifacts({
          plan,
          migrationFilePath: join(untouchedParent, 'migration.js'),
          format: 'js',
          bundleAssets: false,
        }),
      );
      expect(error.message, testCase.name).to.match(
        /collection|permission|order|contract/i,
      );
      expect(await pathExists(untouchedParent), testCase.name).to.equal(false);
    }
  });

  it('never removes an exposed runtime when a concurrent writer wins a later artifact path', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000007_raced.js');
    const contentDirectory = join(directory, '.datocms-content');
    const planPath = join(contentDirectory, '1700000007_raced.plan.json');
    const assetBytes = 'portable asset bytes';
    const plan = makePlanWithUpload(
      createHash('md5').update(assetBytes).digest('hex'),
    );
    const fetchFn = (async () => {
      await mkdir(contentDirectory, { recursive: true });
      await writeFile(planPath, 'concurrent writer\n');
      return new Response(assetBytes);
    }) as typeof fetch;

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: true,
        fetchFn,
      }),
    );
    const runtimePath = join(
      contentDirectory,
      `runtime-v${RUNTIME_VERSION}.js`,
    );

    expect((error as NodeJS.ErrnoException).code).to.equal('EEXIST');
    expect(await readFile(planPath, 'utf8')).to.equal('concurrent writer\n');
    expect(await readFile(runtimePath, 'utf8')).to.equal(
      `${renderRuntime('js').trimEnd()}\n`,
    );
    expect(await pathExists(migrationPath)).to.equal(false);
    expect(
      await pathExists(join(contentDirectory, '1700000007_raced.assets')),
    ).to.equal(false);
    await expectNoStagingDirectories(directory);
  });

  it('rejects a tampered CREATE sanitizer risk before any artifact filesystem write', async () => {
    const directory = await makeTemporaryDirectory();
    const untouchedParent = join(directory, 'must-not-exist');
    const plan = makePlan();
    const recordId = 'YhEa5SbeSl6KwIFizzkzig';
    const fields = { body: '<p>This <br /> text</p>' };
    const current = { fields, hash: semanticHash(fields) };
    const desired: RecordSnapshot = {
      id: recordId,
      itemTypeId: 'sanitize-model-id',
      current,
      published: null,
      topology: { parentId: null, position: null },
      lifecycle: {
        createdAt: '2026-01-01T00:00:00.000Z',
        firstPublishedAt: null,
      },
      validity: { current: true, published: null },
      stage: null,
      schedules: { publication: null, unpublishing: null },
      hash: semanticHash({ recordId, current }),
      consistency: {
        currentVersion: 'version-1',
        updatedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: null,
        currentValid: true,
        publishedValid: null,
      },
    };
    plan.schema.itemTypes = [
      {
        id: 'sanitize-model-id',
        apiKey: 'sanitize_model',
        name: 'Sanitize model',
        modularBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: true,
        draftSavingActive: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: 'body-field',
            apiKey: 'body',
            fieldType: 'text',
            localized: false,
            position: 1,
            defaultValue: null,
            validators: {
              sanitized_html: { sanitize_before_validation: true },
            },
          },
        ],
      },
    ];
    plan.records = [
      {
        id: recordId,
        itemTypeId: 'sanitize-model-id',
        action: 'create',
        expectedTargetHash: null,
        baseline: null,
        desired,
        changes: {
          current: true,
          published: false,
          topology: false,
          lifecycle: false,
          stage: false,
          schedules: false,
        },
        dependencies: [],
        publishedDependencies: [],
        allowedIntermediateHashes: [],
      },
    ];
    plan.execution.createOrder = [recordId];
    plan.execution.publishOrder = [recordId];
    sealPlanDigests(plan);

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: join(
          untouchedParent,
          'migrations',
          '1700000008_sanitizer.js',
        ),
        format: 'js',
        bundleAssets: false,
      }),
    );

    expect(error.message).to.contain(
      'may be rewritten by active sanitized_html preprocessing',
    );
    expect(error)
      .to.have.nested.property('details.stages')
      .that.deep.equals(['create']);
    expect(await pathExists(untouchedParent)).to.equal(false);
  });

  it('rejects a tampered full-rehydrate UPDATE risk before filesystem writes', async () => {
    const directory = await makeTemporaryDirectory();
    const untouchedParent = join(directory, 'must-not-exist-update');
    const plan = makePlan();
    const recordId = 'SanitizeUpdate1234567';
    const baseline = simpleRecordSnapshot(recordId, {
      body: '<p>Historical <br /> text</p>',
      marker: 'before',
    });
    const desired = simpleRecordSnapshot(recordId, {
      body: '<p>Historical <br /> text</p>',
      marker: 'after',
    });
    plan.schema.itemTypes = [
      {
        id: 'sanitize-model-id',
        apiKey: 'sanitize_model',
        name: 'Sanitize model',
        modularBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: true,
        draftSavingActive: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: 'body-field',
            apiKey: 'body',
            fieldType: 'text',
            localized: false,
            position: 1,
            defaultValue: null,
            validators: {
              sanitized_html: { sanitize_before_validation: true },
            },
          },
          {
            id: 'marker-field',
            apiKey: 'marker',
            fieldType: 'string',
            localized: false,
            position: 2,
            defaultValue: null,
            validators: {},
          },
        ],
      },
    ];
    plan.records = [
      {
        id: recordId,
        itemTypeId: 'sanitize-model-id',
        action: 'update',
        expectedTargetHash: baseline.hash,
        baseline,
        desired,
        changes: {
          current: true,
          published: false,
          topology: false,
          lifecycle: false,
          stage: false,
          schedules: false,
        },
        dependencies: [],
        publishedDependencies: [],
        allowedIntermediateHashes: [],
      },
    ];
    plan.execution.publishOrder = [recordId];
    plan.execution.updateOrder = [recordId];
    sealPlanDigests(plan);

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: join(
          untouchedParent,
          'migrations',
          '1700000009_update-sanitizer.js',
        ),
        format: 'js',
        bundleAssets: false,
      }),
    );

    expect(error.message).to.contain(
      'may be rewritten by active sanitized_html preprocessing',
    );
    expect(error)
      .to.have.nested.property('details.stages')
      .that.includes('current-restore');
    expect(await pathExists(untouchedParent)).to.equal(false);
  });

  it('includes target-inspection block validators in delete-release safety', async () => {
    const directory = await makeTemporaryDirectory();
    const untouchedParent = join(directory, 'must-not-exist-inspection');
    const plan = makePlan();
    const recordId = 'SanitizeDelete1234567';
    const blockId = 'SanitizeRetired123456';
    const baseline = simpleRecordSnapshot(recordId, {
      feature: {
        id: blockId,
        type: 'item',
        attributes: { body: '<p>Retired <br /> block</p>' },
        relationships: {
          item_type: {
            data: { id: 'retired-block-model', type: 'item_type' },
          },
        },
      },
      marker: 'before',
    });
    plan.schema.itemTypes = [
      {
        id: 'sanitize-model-id',
        apiKey: 'sanitize_model',
        name: 'Sanitize model',
        modularBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: true,
        draftSavingActive: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: 'feature-field',
            apiKey: 'feature',
            fieldType: 'single_block',
            localized: false,
            position: 1,
            defaultValue: null,
            validators: {},
          },
          {
            id: 'marker-field',
            apiKey: 'marker',
            fieldType: 'string',
            localized: false,
            position: 2,
            defaultValue: null,
            validators: {},
          },
        ],
      },
    ];
    plan.targetInspection.itemTypes = [
      {
        id: 'retired-block-model',
        apiKey: 'retired_block',
        name: 'Retired block',
        modularBlock: true,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: false,
        draftSavingActive: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: 'retired-body-field',
            apiKey: 'body',
            fieldType: 'text',
            localized: false,
            position: 1,
            defaultValue: null,
            validators: {
              sanitized_html: { sanitize_before_validation: true },
            },
          },
        ],
      },
    ];
    plan.records = [
      {
        id: recordId,
        itemTypeId: 'sanitize-model-id',
        action: 'delete',
        expectedTargetHash: baseline.hash,
        baseline,
        desired: null,
        changes: {
          current: false,
          published: false,
          topology: false,
          lifecycle: false,
          stage: false,
          schedules: false,
        },
        dependencies: [],
        publishedDependencies: [],
        allowedIntermediateHashes: ['release-hash'],
      },
    ];
    plan.execution.deleteReleases = [
      {
        recordId,
        fields: { marker: 'released' },
        intermediateCurrentHash: 'release-hash',
        publish: false,
        transientNestedBlockIds: [],
      },
    ];
    plan.execution.deleteOrder = [recordId];
    sealPlanDigests(plan);

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan,
        migrationFilePath: join(
          untouchedParent,
          'migrations',
          '1700000010_inspection-sanitizer.js',
        ),
        format: 'js',
        bundleAssets: false,
      }),
    );

    expect(error.message).to.contain(
      'may be rewritten by active sanitized_html preprocessing',
    );
    expect(error)
      .to.have.nested.property('details')
      .that.deep.include({
        fieldIds: ['retired-body-field'],
        stages: ['delete-release'],
      });
    expect(await pathExists(untouchedParent)).to.equal(false);
  });

  it('installs byte-identical artifacts through exclusive copies when hard links are unsupported', async () => {
    const assetBytes = 'portable asset bytes';
    const md5 = createHash('md5').update(assetBytes).digest('hex');
    const fetchFn = (async () => new Response(assetBytes)) as typeof fetch;
    const referenceDirectory = await makeTemporaryDirectory();
    const reference = await writeContentDiffArtifacts({
      plan: makePlanWithUpload(md5),
      migrationFilePath: join(referenceDirectory, '1700000020_noLinks.js'),
      format: 'js',
      bundleAssets: true,
      fetchFn,
    });
    const referenceAsset = join(
      reference.assetsPath!,
      'QtiP3aRYQhK9jRVGDL6kPg.bin',
    );

    for (const code of UNSUPPORTED_LINK_CODES) {
      const directory = await makeTemporaryDirectory();
      const { fileOperations, linkAttempts } = withoutHardLinks(code);
      const result = await writeContentDiffArtifacts({
        plan: makePlanWithUpload(md5),
        migrationFilePath: join(directory, '1700000020_noLinks.js'),
        format: 'js',
        bundleAssets: true,
        fetchFn,
        fileOperations,
      });
      const contentDirectory = join(directory, '.datocms-content');

      for (const [actual, expected] of [
        [result.migrationPath, reference.migrationPath],
        [result.planPath, reference.planPath],
        [result.runtimePath, reference.runtimePath],
        [join(result.assetsPath!, basename(referenceAsset)), referenceAsset],
      ]) {
        expect(await readFile(actual), `${code} ${actual}`).to.deep.equal(
          await readFile(expected),
        );
      }
      expect(result.manifestSha256).to.equal(reference.manifestSha256);
      expect(linkAttempts, code).to.deep.equal([
        result.runtimePath,
        join(result.assetsPath!, basename(referenceAsset)),
        result.planPath,
        result.migrationPath,
      ]);
      expect((await readdir(contentDirectory)).sort(), code).to.deep.equal(
        [
          '1700000020_noLinks.assets',
          '1700000020_noLinks.plan.json',
          `runtime-v${RUNTIME_VERSION}.js`,
        ].sort(),
      );
      await expectNoStagingDirectories(directory);
      await expectNoStagingDirectories(contentDirectory);
    }
  });

  it('only falls back from hard links for unsupported-link errors', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000021_linkDenied.js');
    let renames = 0;
    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
        fileOperations: {
          async link() {
            throw Object.assign(new Error('EACCES: simulated, link'), {
              code: 'EACCES',
            });
          },
          async rename(oldPath, newPath) {
            renames += 1;
            await fsRename(oldPath, newPath);
          },
        },
      }),
    );

    expect((error as NodeJS.ErrnoException).code).to.equal('EACCES');
    expect(renames).to.equal(0);
    expect(await pathExists(migrationPath)).to.equal(false);
    expect(await readdir(join(directory, '.datocms-content'))).to.deep.equal(
      [],
    );
    await expectNoStagingDirectories(directory);
  });

  it('never exposes an empty or partial entrypoint when hard links are unsupported', async () => {
    const referenceDirectory = await makeTemporaryDirectory();
    const reference = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(referenceDirectory, '1700000022_atomic.js'),
      format: 'js',
      bundleAssets: false,
    });
    const expectedEntrypoint = await readFile(reference.migrationPath, 'utf8');
    const expectedPlan = await readFile(reference.planPath, 'utf8');
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000022_atomic.js');
    const contentDirectory = join(directory, '.datocms-content');
    const planPath = join(contentDirectory, '1700000022_atomic.plan.json');
    const runtimePath = join(
      contentDirectory,
      `runtime-v${RUNTIME_VERSION}.js`,
    );
    const renamed: string[] = [];
    const { fileOperations } = withoutHardLinks('ENOTSUP', async (from, to) => {
      // Every candidate is a complete copy in a stage directory beside its
      // destination, so the rename never crosses a filesystem.
      expect(basename(dirname(from))).to.match(/^\.datocms-content-stage-/);
      expect(dirname(dirname(from))).to.equal(dirname(to));
      expect(await pathExists(migrationPath)).to.equal(false);

      if (to === migrationPath) {
        expect(await readFile(planPath, 'utf8')).to.equal(expectedPlan);
        expect(await readFile(runtimePath, 'utf8')).to.equal(
          `${renderRuntime('js').trimEnd()}\n`,
        );
      } else {
        // Non-discoverable names are claimed by an exclusive reservation
        // that only this writer's rename may replace.
        const reservation = await lstat(to);
        expect(reservation.isFile() && reservation.size === 0).to.equal(true);
      }

      await fsRename(from, to);
      renamed.push(to);
    });
    let generationFinished = false;
    const observedEntrypoints: string[] = [];
    const watcher = (async () => {
      while (!generationFinished) {
        try {
          observedEntrypoints.push(await readFile(migrationPath, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    try {
      await writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
        fileOperations,
      });
    } finally {
      generationFinished = true;
      await watcher;
    }

    expect(renamed).to.deep.equal([runtimePath, planPath, migrationPath]);
    expect(await readFile(migrationPath, 'utf8')).to.equal(expectedEntrypoint);
    expect(
      observedEntrypoints.filter((contents) => contents !== expectedEntrypoint),
    ).to.deep.equal([]);
    await expectNoStagingDirectories(directory);
    await expectNoStagingDirectories(contentDirectory);
  });

  it('refuses an entrypoint created concurrently without hard links and keeps the runtime', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000023_raced.js');
    const contentDirectory = join(directory, '.datocms-content');
    const planPath = join(contentDirectory, '1700000023_raced.plan.json');
    const runtimePath = join(
      contentDirectory,
      `runtime-v${RUNTIME_VERSION}.js`,
    );
    const assetBytes = 'portable asset bytes';
    const { fileOperations } = withoutHardLinks('EPERM', async (from, to) => {
      if (to === planPath) {
        await writeFile(migrationPath, 'concurrent migration\n', {
          flag: 'wx',
        });
      }
      await fsRename(from, to);
    });

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlanWithUpload(
          createHash('md5').update(assetBytes).digest('hex'),
        ),
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: true,
        fetchFn: (async () => new Response(assetBytes)) as typeof fetch,
        fileOperations,
      }),
    );

    expect((error as NodeJS.ErrnoException).code).to.equal('EEXIST');
    expect(error.message).to.contain(
      'Refusing to overwrite existing migration',
    );
    expect(await readFile(migrationPath, 'utf8')).to.equal(
      'concurrent migration\n',
    );
    expect(await pathExists(planPath)).to.equal(false);
    expect(
      await pathExists(join(contentDirectory, '1700000023_raced.assets')),
    ).to.equal(false);
    expect(await readFile(runtimePath, 'utf8')).to.equal(
      `${renderRuntime('js').trimEnd()}\n`,
    );
    await expectNoStagingDirectories(directory);
    await expectNoStagingDirectories(contentDirectory);
  });

  it('refuses a content plan claimed concurrently without hard links', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000024_planRaced.js');
    const contentDirectory = join(directory, '.datocms-content');
    const planPath = join(contentDirectory, '1700000024_planRaced.plan.json');
    const assetBytes = 'portable asset bytes';
    const { fileOperations } = withoutHardLinks('EXDEV');

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlanWithUpload(
          createHash('md5').update(assetBytes).digest('hex'),
        ),
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: true,
        fetchFn: (async () => {
          await mkdir(contentDirectory, { recursive: true });
          await writeFile(planPath, 'concurrent writer\n');
          return new Response(assetBytes);
        }) as typeof fetch,
        fileOperations,
      }),
    );

    expect((error as NodeJS.ErrnoException).code).to.equal('EEXIST');
    expect(await readFile(planPath, 'utf8')).to.equal('concurrent writer\n');
    expect(await pathExists(migrationPath)).to.equal(false);
    expect(
      await pathExists(join(contentDirectory, '1700000024_planRaced.assets')),
    ).to.equal(false);
    expect(
      await readFile(
        join(contentDirectory, `runtime-v${RUNTIME_VERSION}.js`),
        'utf8',
      ),
    ).to.equal(`${renderRuntime('js').trimEnd()}\n`);
    await expectNoStagingDirectories(directory);
    await expectNoStagingDirectories(contentDirectory);
  });

  it('withdraws only its own empty reservation when a rename fails without hard links', async () => {
    for (const failing of ['runtime', 'plan'] as const) {
      const directory = await makeTemporaryDirectory();
      const migrationPath = join(directory, '1700000025_renameFails.js');
      const contentDirectory = join(directory, '.datocms-content');
      const planPath = join(
        contentDirectory,
        '1700000025_renameFails.plan.json',
      );
      const runtimePath = join(
        contentDirectory,
        `runtime-v${RUNTIME_VERSION}.js`,
      );
      const renameError = Object.assign(new Error('simulated rename failure'), {
        code: 'EIO',
      });
      const { fileOperations } = withoutHardLinks(
        'ENOSYS',
        async (from, to) => {
          if (to === (failing === 'runtime' ? runtimePath : planPath)) {
            throw renameError;
          }
          await fsRename(from, to);
        },
      );

      const error = await expectRejects(
        writeContentDiffArtifacts({
          plan: makePlan(),
          migrationFilePath: migrationPath,
          format: 'js',
          bundleAssets: false,
          fileOperations,
        }),
      );

      expect(error, failing).to.equal(renameError);
      expect(await pathExists(migrationPath), failing).to.equal(false);
      expect(await pathExists(planPath), failing).to.equal(false);
      if (failing === 'runtime') {
        expect(await pathExists(runtimePath)).to.equal(false);
      } else {
        expect(await readFile(runtimePath, 'utf8')).to.equal(
          `${renderRuntime('js').trimEnd()}\n`,
        );
      }
      await expectNoStagingDirectories(directory);
      await expectNoStagingDirectories(contentDirectory);
    }
  });

  it('reuses or refuses existing runtimes without hard links and never replaces them', async () => {
    const directory = await makeTemporaryDirectory();
    const contentDirectory = join(directory, '.datocms-content');
    const runtimePath = join(
      contentDirectory,
      `runtime-v${RUNTIME_VERSION}.js`,
    );
    const expectedRuntime = `${renderRuntime('js').trimEnd()}\n`;
    await mkdir(contentDirectory);
    await writeFile(runtimePath, expectedRuntime);
    const originalInode = (await stat(runtimePath)).ino;

    await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000026_reuse.js'),
      format: 'js',
      bundleAssets: false,
      fileOperations: withoutHardLinks('EXDEV').fileOperations,
    });
    expect((await stat(runtimePath)).ino).to.equal(originalInode);
    expect(await readFile(runtimePath, 'utf8')).to.equal(expectedRuntime);

    await writeFile(runtimePath, 'mismatched runtime\n');
    const mismatchError = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: join(directory, '1700000027_mismatch.js'),
        format: 'js',
        bundleAssets: false,
        fileOperations: withoutHardLinks('EXDEV').fileOperations,
      }),
    );
    expect(mismatchError.message).to.contain(
      'Refusing to overwrite mismatched immutable runtime',
    );
    expect(await readFile(runtimePath, 'utf8')).to.equal(
      'mismatched runtime\n',
    );
    expect(
      await pathExists(join(directory, '1700000027_mismatch.js')),
    ).to.equal(false);
    await expectNoStagingDirectories(directory);
    await expectNoStagingDirectories(contentDirectory);
  });

  it('waits for a concurrent empty runtime reservation and refuses one that stays empty', async () => {
    const directory = await makeTemporaryDirectory();
    const contentDirectory = join(directory, '.datocms-content');
    const runtimePath = join(
      contentDirectory,
      `runtime-v${RUNTIME_VERSION}.js`,
    );
    const expectedRuntime = `${renderRuntime('js').trimEnd()}\n`;
    await mkdir(contentDirectory);

    // A concurrent writer without hard links holds an empty reservation and
    // then renames its complete copy over it.
    await writeFile(runtimePath, '');
    const concurrentCopy = join(contentDirectory, 'concurrent-runtime.tmp');
    await writeFile(concurrentCopy, expectedRuntime);
    const concurrentInstall = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        fsRename(concurrentCopy, runtimePath).then(resolve, reject);
      }, 250);
    });
    const reused = await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000028_waits.js'),
      format: 'js',
      bundleAssets: false,
      fileOperations: withoutHardLinks('EXDEV').fileOperations,
    });
    await concurrentInstall;
    expect(await readFile(reused.runtimePath, 'utf8')).to.equal(
      expectedRuntime,
    );
    expect(await pathExists(reused.migrationPath)).to.equal(true);

    // An empty runtime that never completes is not reused, replaced, or
    // removed: nothing proves who owns it.
    await writeFile(runtimePath, '');
    const migrationPath = join(directory, '1700000029_staysEmpty.js');
    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: false,
      }),
    );
    expect(error.message).to.contain(
      'Refusing to reuse incomplete immutable runtime',
    );
    expect(await readFile(runtimePath, 'utf8')).to.equal('');
    expect(await pathExists(migrationPath)).to.equal(false);
    await expectNoStagingDirectories(directory);
  });

  it('reclaims only provably abandoned stage directories before staging', async () => {
    const directory = await makeTemporaryDirectory();
    const contentDirectory = join(directory, '.datocms-content');
    await mkdir(contentDirectory);
    const now = Date.now();
    const hours = (count: number) => new Date(now - count * 60 * 60 * 1000);
    const deadPid = await exitedProcessId();
    const stage = async (
      parent: string,
      name: string,
      marker: unknown,
      modifiedAt?: Date,
    ) => {
      const path = join(parent, `.datocms-content-stage-${name}`);
      await mkdir(join(path, 'nested'), { recursive: true });
      await writeFile(join(path, 'nested', 'staged.bin'), 'staged bytes');
      if (marker !== undefined) {
        await writeFile(
          join(path, '.owner.json'),
          typeof marker === 'string' ? marker : JSON.stringify(marker),
        );
      }
      if (modifiedAt) await utimes(path, modifiedAt, modifiedAt);
      return path;
    };
    const owner = (pid: number, host: string, createdAt: Date) => ({
      pid,
      hostname: host,
      createdAt: createdAt.toISOString(),
    });
    const removed = [
      await stage(directory, 'deadOwner', owner(deadPid, hostname(), hours(0))),
      await stage(
        directory,
        'oldRemote',
        owner(process.pid, 'other-host.invalid', hours(25)),
      ),
      await stage(directory, 'oldUnmarked', undefined, hours(25)),
      await stage(
        contentDirectory,
        'deadOwner',
        owner(deadPid, hostname(), hours(0)),
      ),
    ];
    const kept = [
      await stage(
        directory,
        'liveOwner',
        owner(process.pid, hostname(), hours(48)),
      ),
      await stage(
        directory,
        'freshRemote',
        owner(deadPid, 'other-host.invalid', hours(1)),
      ),
      await stage(directory, 'freshUnmarked', undefined),
      await stage(directory, 'partialMarker', '{"pid":', hours(1)),
      await stage(
        contentDirectory,
        'freshRemote',
        owner(deadPid, 'other-host.invalid', hours(1)),
      ),
    ];
    const unrelatedFile = join(directory, '.datocms-content-stage-file');
    await writeFile(unrelatedFile, 'not a stage directory');
    await utimes(unrelatedFile, hours(48), hours(48));
    const unrelatedDirectory = join(directory, '.other-stage');
    await mkdir(unrelatedDirectory);
    await utimes(unrelatedDirectory, hours(48), hours(48));

    await writeContentDiffArtifacts({
      plan: makePlan(),
      migrationFilePath: join(directory, '1700000030_sweep.js'),
      format: 'js',
      bundleAssets: false,
    });

    for (const path of removed) {
      expect(await pathExists(path), path).to.equal(false);
    }
    for (const path of kept) {
      expect(
        await pathExists(join(path, 'nested', 'staged.bin')),
        path,
      ).to.equal(true);
    }
    expect(await readFile(unrelatedFile, 'utf8')).to.equal(
      'not a stage directory',
    );
    expect(await pathExists(unrelatedDirectory)).to.equal(true);
  });

  it('marks its stage directory with its owner and never reclaims a live concurrent generation', async () => {
    const directory = await makeTemporaryDirectory();
    const assetBytes = 'portable asset bytes';
    const md5 = createHash('md5').update(assetBytes).digest('hex');
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    let downloadStarted!: () => void;
    const downloading = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const first = writeContentDiffArtifacts({
      plan: makePlanWithUpload(md5),
      migrationFilePath: join(directory, '1700000031_first.js'),
      format: 'js',
      bundleAssets: true,
      fetchFn: (async () => {
        downloadStarted();
        await downloadGate;
        return new Response(assetBytes);
      }) as typeof fetch,
    });

    try {
      await downloading;
      const [stageName] = (await readdir(directory)).filter((entry) =>
        entry.startsWith('.datocms-content-stage-'),
      );
      const stagePath = join(directory, stageName);
      const marker = JSON.parse(
        await readFile(join(stagePath, '.owner.json'), 'utf8'),
      );
      expect(marker.pid).to.equal(process.pid);
      expect(marker.hostname).to.equal(hostname());
      expect(Date.parse(marker.createdAt)).to.be.closeTo(Date.now(), 60_000);

      // Backdating proves liveness, not age, protects a same-host owner.
      await writeFile(
        join(stagePath, '.owner.json'),
        JSON.stringify({
          ...marker,
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        }),
      );
      await writeContentDiffArtifacts({
        plan: makePlan(),
        migrationFilePath: join(directory, '1700000032_second.js'),
        format: 'js',
        bundleAssets: false,
      });
      expect(await pathExists(stagePath)).to.equal(true);
    } finally {
      releaseDownload();
    }

    const result = await first;
    expect(
      await readFile(
        join(result.assetsPath!, 'QtiP3aRYQhK9jRVGDL6kPg.bin'),
        'utf8',
      ),
    ).to.equal(assetBytes);
    await expectNoStagingDirectories(directory);
  });

  it('leaves no bundled asset directory behind when its stage vanishes before install', async () => {
    const directory = await makeTemporaryDirectory();
    const migrationPath = join(directory, '1700000033_stageGone.js');
    const contentDirectory = join(directory, '.datocms-content');
    const assetBytes = 'portable asset bytes';
    const runtimePath = join(
      contentDirectory,
      `runtime-v${RUNTIME_VERSION}.js`,
    );

    const error = await expectRejects(
      writeContentDiffArtifacts({
        plan: makePlanWithUpload(
          createHash('md5').update(assetBytes).digest('hex'),
        ),
        migrationFilePath: migrationPath,
        format: 'js',
        bundleAssets: true,
        fetchFn: (async () => new Response(assetBytes)) as typeof fetch,
        fileOperations: {
          async link(existingPath, newPath) {
            // The runtime is installed first; losing the staged assets right
            // after it mirrors a sweep that misjudged this stage as abandoned.
            if (newPath === runtimePath) {
              await rm(
                join(dirname(existingPath), '1700000033_stageGone.assets'),
                { recursive: true, force: true },
              );
            }

            await fsLink(existingPath, newPath);
          },
        },
      }),
    );

    expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
    expect((await readdir(contentDirectory)).sort()).to.deep.equal([
      `runtime-v${RUNTIME_VERSION}.js`,
    ]);
    expect(await pathExists(migrationPath)).to.equal(false);
    await expectNoStagingDirectories(directory);
    await expectNoStagingDirectories(contentDirectory);
  });
});

const UNSUPPORTED_LINK_CODES = [
  'EXDEV',
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EMLINK',
  'EISDIR',
] as const;

function withoutHardLinks(
  code: string,
  rename?: ArtifactFileOperations['rename'],
): {
  fileOperations: Partial<ArtifactFileOperations>;
  linkAttempts: string[];
} {
  const linkAttempts: string[] = [];

  return {
    linkAttempts,
    fileOperations: {
      async link(_existingPath, newPath) {
        linkAttempts.push(newPath);
        throw Object.assign(
          new Error(`${code}: simulated missing hard-link support, link`),
          { code },
        );
      },
      ...(rename ? { rename } : {}),
    },
  };
}

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return child.pid!;
}

function simpleRecordSnapshot(
  recordId: string,
  fields: Record<string, JsonValue>,
): RecordSnapshot {
  const current = { fields, hash: semanticHash(fields) };
  const state = {
    id: recordId,
    itemTypeId: 'sanitize-model-id',
    current,
    published: null,
    topology: { parentId: null, position: null },
    lifecycle: {
      createdAt: '2026-01-01T00:00:00.000Z',
      firstPublishedAt: null,
    },
    validity: { current: true, published: null },
    stage: null,
    schedules: { publication: null, unpublishing: null },
  };
  return {
    ...state,
    hash: semanticHash(state),
    consistency: {
      currentVersion: 'version-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: null,
      currentValid: true,
      publishedValid: null,
    },
  };
}

function makePlan(): ContentDiffPlan {
  return sealPlanDigests({
    formatVersion: CONTENT_PLAN_FORMAT_VERSION,
    generatorVersion: CONTENT_DIFF_GENERATOR_VERSION,
    source: {
      siteId: 'site-id',
      environmentId: 'source',
      schemaDigest: 'schema-digest',
      snapshotDigest: 'source-snapshot',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
    target: {
      siteId: 'site-id',
      environmentId: 'destination',
      schemaDigest: 'schema-digest',
      snapshotDigest: 'destination-snapshot',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
    options: {
      projectMode: 'same_project',
      includeDeletions: false,
      uploads: 'referenced',
      migrateInvalidContent: false,
      migrationsModelApiKey: 'schema_migration',
    },
    schema: {
      siteId: 'site-id',
      environmentId: 'source',
      locales: ['en'],
      environmentSemantics: {
        timezone: 'UTC',
        improvedTimezoneManagement: true,
        improvedBooleanFields: true,
        improvedValidationAtPublishing: true,
        millisecondsInDatetime: true,
        nonLocalizedFocalPoints: true,
        improvedHexManagement: true,
      },
      itemTypes: [],
      workflows: [],
      digest: 'schema-digest',
    },
    targetInspection: {
      itemTypes: [],
      digest: semanticHash({ itemTypes: [] }),
    },
    records: [],
    uploads: [],
    uploadCollections: [],
    legacyIdMappings: {
      formatVersion: LEGACY_ID_MAPPING_FORMAT_VERSION,
      schema: {
        model: {
          id: 'YhEa5SbeSl6KwIFizzkzig',
          apiKey: 'datocms_content_diff',
          name: 'Content diff',
          modularBlock: false,
          singleton: false,
          sortable: false,
          tree: false,
          draftModeActive: true,
          draftSavingActive: false,
          allLocalesRequired: false,
          inverseRelationshipsEnabled: false,
          workflowId: null,
          status: 'new',
        },
        nameField: {
          id: 'XSPMXvayT-yMUrVxP-YoSw',
          apiKey: 'name',
          label: 'Name',
          fieldType: 'string',
          localized: false,
          position: 1,
          validators: { required: {}, unique: {} },
          status: 'new',
        },
        mappingField: {
          id: '-40RNzgBSJaJsXiLSYhtVA',
          apiKey: 'mapping',
          label: 'Mapping',
          fieldType: 'json',
          localized: false,
          position: 2,
          validators: { required: {} },
          status: 'new',
        },
      },
      existingMappingRecords: [],
      entries: [],
      skippedEntries: [],
      newMappingBatch: null,
    },
    invalidContent: {
      formatVersion: INVALID_CONTENT_FORMAT_VERSION,
      migrateInvalidContent: false,
      schemaStates: {
        originalDigest: 'schema-digest',
        fullyRelaxedDigest: 'schema-digest',
        partialRelaxationContract: 'per_field_original_or_relaxed',
      },
      detectedRecordIds: [],
      migratedRecordIds: [],
      propagatedSkipCount: 0,
      validatorRelaxations: [],
      skippedRecords: [],
    },
    execution: {
      collectionOrder: [],
      uploadOrder: [],
      uniqueReleases: [],
      deleteReleases: [],
      shellRecordIds: [],
      shellComponents: [],
      revalidateBeforePublishIds: [],
      createOrder: [],
      publicationSeedOrder: [],
      publishOrder: [],
      updateOrder: [],
      deleteOrder: [],
    },
    targetPreconditions: null,
    requiredPermissions: {
      readItemTypes: [],
      itemTypes: [],
      uploadActions: ['read'],
      manageUploadCollections: false,
      manageSchedules: false,
      editSchema: false,
    },
    warnings: [],
    summary: {
      records: { create: 0, update: 0, delete: 0 },
      uploads: { create: 0, update: 0, delete: 0 },
      uploadCollections: { create: 0, update: 0 },
      invalidContent: {
        status: 'complete',
        detectedRecords: 0,
        migratedRecords: 0,
        skippedRecords: 0,
        propagatedSkipCount: 0,
        validatorRelaxations: 0,
        relaxedFieldCount: 0,
        relaxedValidatorCount: 0,
        requiresTemporaryValidatorRelaxation: false,
      },
      legacyIdMappings: {
        detected: 0,
        existing: 0,
        created: 0,
        skipped: 0,
        records: 0,
      },
      warnings: 0,
    },
  });
}

/**
 * Recomputes the schema, fully-relaxed and inspection digests a plan derives
 * from its schema, as the planner does. Fixtures call it again after changing
 * the schema, the inspection models or the validator relaxations, so that
 * validation reaches the contract each test exercises.
 */
function sealPlanDigests(plan: ContentDiffPlan): ContentDiffPlan {
  const digest = computeSchemaDigest(plan.schema);
  plan.schema.digest = digest;
  plan.source.schemaDigest = digest;
  plan.target.schemaDigest = digest;
  plan.invalidContent.schemaStates.originalDigest = digest;
  plan.invalidContent.schemaStates.fullyRelaxedDigest = computeSchemaDigest(
    schemaWithValidatorRelaxations(
      plan.schema,
      plan.invalidContent.validatorRelaxations,
    ),
  );
  plan.targetInspection.digest = inspectionItemTypesDigest(
    plan.targetInspection.itemTypes,
  );
  return plan;
}

function makePlanWithUpload(md5: string): ContentDiffPlan {
  const plan = makePlan();
  const desired: UploadSnapshot = {
    id: 'QtiP3aRYQhK9jRVGDL6kPg',
    md5,
    basename: 'asset',
    filename: 'asset.txt',
    transport: {
      sourceUrl: 'https://example.test/asset.txt',
      bundledPath: null,
      sha256: null,
    },
    size: 21,
    mimeType: 'text/plain',
    manual: {
      author: null,
      copyright: null,
      notes: null,
      defaultFieldMetadata: {
        alt: { en: null },
        title: { en: null },
        custom_data: { en: {} },
        focal_point: null,
        poster_time: null,
      },
      tags: [],
      collectionId: null,
    },
    hash: '',
    consistency: { updatedAt: null, antivirusStatus: 'clean' },
  };
  refreshUploadHash(desired);

  plan.uploads = [
    {
      id: desired.id,
      action: 'create',
      expectedTargetHash: null,
      baseline: null,
      desired,
      changes: { binary: true, metadata: true, collection: true },
    },
  ];
  plan.execution.uploadOrder = [desired.id];
  plan.requiredPermissions.uploadActions = ['read', 'create'];
  plan.summary.uploads.create = 1;

  return plan;
}

function convertCreateUploadToUpdate(plan: ContentDiffPlan) {
  const upload = plan.uploads[0];
  upload.action = 'update';
  upload.baseline = structuredClone(upload.desired);
  upload.expectedTargetHash = upload.baseline!.hash;
  upload.changes = compareUploadChanges(upload.desired!, upload.baseline!);
  plan.requiredPermissions.uploadActions = ['read'];
  return upload;
}

function refreshUploadHash(upload: UploadSnapshot): void {
  upload.hash = semanticHash({
    id: upload.id,
    md5: upload.md5,
    basename: upload.basename,
    filename: upload.filename,
    manual: upload.manual,
  });
}

function uploadStem(filename: string): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const dot = filename.lastIndexOf('.');
  return filename.slice(slash + 1, dot > slash + 1 ? dot : filename.length);
}

function makeRecordSnapshotWithBlock(
  recordId: string,
  blockId: string,
  text: string,
): RecordSnapshot {
  const fields = {
    content: {
      id: blockId,
      type: 'item',
      relationships: {
        item_type: { data: { id: 'block-model-id', type: 'item_type' } },
      },
      attributes: { text },
    },
  };
  const version = { fields, hash: semanticHash(fields) };
  return {
    id: recordId,
    itemTypeId: 'model-id',
    current: version,
    published: null,
    topology: { parentId: null, position: null },
    lifecycle: {
      createdAt: '2026-01-01T00:00:00.000Z',
      firstPublishedAt: null,
    },
    validity: { current: true, published: null },
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: semanticHash({ fields, text }),
    consistency: {
      currentVersion: `version-${text}`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: null,
      currentValid: true,
      publishedValid: null,
    },
  };
}

function makeWriterCreatePlanWithBlock(): ContentDiffPlan {
  const plan = makePlan();
  const recordId = 'YhEa5SbeSl6KwIFizzkzig';
  const blockId = 'X4h0kJ7xQy2oO3UscO9V6Q';
  const desired = makeRecordSnapshotWithBlock(recordId, blockId, 'created');
  plan.schema.itemTypes = [
    {
      id: 'model-id',
      apiKey: 'model',
      name: 'Model',
      modularBlock: false,
      singleton: false,
      sortable: false,
      tree: false,
      draftModeActive: true,
      draftSavingActive: true,
      allLocalesRequired: false,
      workflowId: null,
      fields: [
        {
          id: 'content-field-id',
          apiKey: 'content',
          fieldType: 'single_block',
          localized: false,
          position: 1,
          validators: {
            single_block_blocks: { item_types: ['block-model-id'] },
          },
          defaultValue: null,
        },
      ],
    },
    {
      id: 'block-model-id',
      apiKey: 'block_model',
      name: 'Block Model',
      modularBlock: true,
      singleton: false,
      sortable: false,
      tree: false,
      draftModeActive: false,
      draftSavingActive: false,
      allLocalesRequired: false,
      workflowId: null,
      fields: [
        {
          id: 'text-field-id',
          apiKey: 'text',
          fieldType: 'string',
          localized: false,
          position: 1,
          validators: {},
          defaultValue: null,
        },
      ],
    },
  ];
  plan.records = [
    {
      id: recordId,
      itemTypeId: 'model-id',
      action: 'create',
      expectedTargetHash: null,
      baseline: null,
      desired,
      changes: {
        current: true,
        published: false,
        topology: false,
        lifecycle: false,
        stage: false,
        schedules: false,
      },
      dependencies: [],
      publishedDependencies: [],
      allowedIntermediateHashes: [],
    },
  ];
  plan.execution.createOrder = [recordId];
  plan.execution.publishOrder = [recordId];
  return sealPlanDigests(plan);
}

function makeWriterCollectionSnapshot(
  id: string,
  label: string,
  position: number,
): UploadCollectionSnapshot {
  const snapshot: UploadCollectionSnapshot = {
    id,
    label,
    parentId: null,
    position,
    hash: '',
  };
  refreshCollectionHash(snapshot);
  return snapshot;
}

function refreshCollectionHash(snapshot: UploadCollectionSnapshot): void {
  snapshot.hash = semanticHash({
    id: snapshot.id,
    label: snapshot.label,
    parentId: snapshot.parentId,
    position: snapshot.position,
  });
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'datocms-content-writer-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectRejects(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    return error as Error;
  }

  throw new Error('Expected promise to reject');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectNoStagingDirectories(directory: string): Promise<void> {
  const entries = await readdir(directory);
  expect(
    entries.filter((entry) => entry.startsWith('.datocms-content-stage-')),
  ).to.deep.equal([]);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
