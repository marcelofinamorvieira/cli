import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CmaClient } from '@datocms/cli-utils';
import type { ContentDiffPlan } from '../../src/content-diff/types';
import {
  ASSET_FIXTURE_PNG,
  md5,
  waitForUploadAntivirusClean,
} from './assets-deletions-scenario';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Seed = RealCmaScenarioSeed &
  Readonly<{
    uploadId: string;
  }>;

type UploadState = Readonly<{
  id: string;
  md5: string;
  filename: string;
  basename: string;
  author: string | null;
  copyright: string | null;
  notes: string | null;
  tags: readonly string[];
  collectionId: string | null;
}>;

type Expected = Readonly<{
  source: UploadState;
  destination: UploadState;
}>;

export const sameByteUploadRenameScenario: RealCmaScenario<Seed, Expected> = {
  name: 'same-byte upload stem rename permission boundary',
  contentDiffArgs: ['--uploads=all'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating isolated upload rename fixture');
    const suffix = createHash('sha256')
      .update(runId)
      .digest('hex')
      .slice(0, 12);
    const modelApiKey = `cde2e_urn_r${suffix}`;
    await client.itemTypes.create({
      name: `Upload rename fixture ${runId}`,
      api_key: modelApiKey,
      singleton: false,
      all_locales_required: false,
      sortable: false,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: false,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });
    const upload = await withFixture(async (localPath) =>
      client.uploads.createFromLocalFile({
        localPath,
        filename: 'same-byte-baseline.png',
        skipCreationIfAlreadyExists: false,
        tags: ['zeta', 'alpha'],
      }),
    );
    await waitForUploadAntivirusClean(
      { rawFindUpload: (id) => client.uploads.rawFind(id) },
      upload.id,
    );
    return { itemTypeApiKeys: [modelApiKey], uploadId: upload.id };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log('[content-diff e2e] Renaming upload without changing bytes');
    const destination = await captureUpload(destinationClient, seed.uploadId);
    assert.deepEqual(destination.tags, ['zeta', 'alpha']);
    await sourceClient.uploads.update(seed.uploadId, {
      basename: 'same-byte-renamed',
    });
    const source = await captureUpload(sourceClient, seed.uploadId);

    assert.equal(source.md5, destination.md5);
    assert.equal(source.md5, md5(ASSET_FIXTURE_PNG));
    assert.equal(source.filename, 'same-byte-renamed.png');
    assert.equal(source.basename, 'same-byte-renamed');
    assert.deepEqual(source.tags, ['zeta', 'alpha']);
    assert.deepEqual(
      uploadManualState(source),
      uploadManualState(destination),
      'the isolated rename fixture unexpectedly changed manual metadata',
    );

    return { source, destination };
  },

  async verifyGeneratedPlan({ seed, planFilePath }) {
    const envelope = JSON.parse(await readFile(planFilePath, 'utf8')) as {
      plan: ContentDiffPlan;
    };
    const upload = envelope.plan.uploads.find(({ id }) => id === seed.uploadId);
    assert.ok(upload, 'isolated renamed upload is absent from the plan');
    assert.equal(upload.action, 'update');
    assert.deepEqual(upload.changes, {
      binary: false,
      metadata: true,
      collection: false,
    });
    assert.equal(upload.baseline?.md5, upload.desired?.md5);
    assert.equal(upload.baseline?.filename, 'same-byte-baseline.png');
    assert.equal(upload.desired?.filename, 'same-byte-renamed.png');
    assert.deepEqual(upload.baseline?.manual, upload.desired?.manual);
    assert.deepEqual(envelope.plan.requiredPermissions.uploadActions, [
      'read',
      'replace_asset',
    ]);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log('[content-diff e2e] Verifying isolated upload rename');
    const [source, destination, applied] = await Promise.all([
      captureUpload(sourceClient, seed.uploadId),
      captureUpload(destinationClient, seed.uploadId),
      captureUpload(appliedClient, seed.uploadId),
    ]);
    assert.deepEqual(source, expected.source);
    assert.deepEqual(destination, expected.destination);
    assert.deepEqual(applied, expected.source);
  },
};

async function withFixture<T>(
  callback: (localPath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-rename-'));
  const localPath = join(directory, 'fixture.png');
  try {
    await writeFile(localPath, ASSET_FIXTURE_PNG);
    return await callback(localPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function captureUpload(
  client: CmaClient.Client,
  uploadId: string,
): Promise<UploadState> {
  const upload = await client.uploads.find(uploadId);
  return {
    id: upload.id,
    md5: upload.md5,
    filename: upload.filename,
    basename: upload.basename,
    author: upload.author ?? null,
    copyright: upload.copyright ?? null,
    notes: upload.notes ?? null,
    tags: [...upload.tags],
    collectionId: upload.upload_collection?.id ?? null,
  };
}

function uploadManualState(
  upload: UploadState,
): Omit<UploadState, 'id' | 'md5' | 'filename' | 'basename'> {
  return {
    author: upload.author,
    copyright: upload.copyright,
    notes: upload.notes,
    tags: upload.tags,
    collectionId: upload.collectionId,
  };
}
