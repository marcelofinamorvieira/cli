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

export const EXIF_FIXTURE_AUTHOR = 'Content diff EXIF author';

const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAoHBwgHBgoIExIVFRYXDiEYFQ0NDB4VEBERIxoZGh4mFhUdHyslHR0oHRUmJEElKC0vMjIyLio4STcwPCsxPi8BCgsLDg0OHBAQHS8lIigvOzUvLzUvLy8vNS81OzsvLy8vLy8vLy8vLy8vLzUvLzU1Ly8vLy8vNS8vLy8vLy8vL//AABEIABQAGAMBIgACEQEDEQH/xAAYAAADAQEAAAAAAAAAAAAAAAAABAYHAf/EACAQAAEEAQQDAAAAAAAAAAAAAAABAgMFBBITYXERJTH/xAAXAQEBAQEAAAAAAAAAAAAAAAADBAIB/8QAGhEAAgIDAAAAAAAAAAAAAAAAAAERMgIDIf/aAAwDAQACEQMRAD8AYy5kRojDmM3PApaZmiFV4JPEvVksdvn6S465QyfTTInpI1DghWZWqJFAODrZN3blTFf0RFavsIuwAowow1c0qtcu0gAAJtn/2Q==',
  'base64',
);

export const ASSET_FIXTURE_EXIF_JPEG = jpegWithExifArtist(
  BASE_JPEG,
  EXIF_FIXTURE_AUTHOR,
);

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
}>;

type Expected = Readonly<{
  source: UploadState;
  destination: UploadState;
}>;

export const exifClearedBinaryReplacementScenario: RealCmaScenario<
  Seed,
  Expected
> = {
  name: 'EXIF-backed binary replacement with cleared manual metadata',
  contentDiffArgs: ['--uploads=all', '--bundle-assets'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating isolated EXIF upload fixture');
    const modelApiKey = exifModelApiKey(runId);
    await client.itemTypes.create({
      name: `Upload EXIF fixture ${runId}`,
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
    const upload = await withFixture(
      ASSET_FIXTURE_PNG,
      'baseline.png',
      (localPath) =>
        client.uploads.createFromLocalFile({
          localPath,
          filename: 'exif-replacement.png',
          skipCreationIfAlreadyExists: false,
        }),
    );
    await waitForUpload(client, upload.id);
    const baseline = await captureUpload(client, upload.id);
    assert.equal(baseline.author, null);
    assert.equal(baseline.copyright, null);
    assert.equal(baseline.notes, null);
    return { itemTypeApiKeys: [modelApiKey], uploadId: upload.id };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Replacing upload bytes with deterministic EXIF metadata',
    );
    const destination = await captureUpload(destinationClient, seed.uploadId);
    await withFixture(ASSET_FIXTURE_EXIF_JPEG, 'replacement.jpg', (localPath) =>
      sourceClient.uploads.updateFromLocalFile(seed.uploadId, {
        localPath,
        filename: 'exif-replacement.jpg',
      }),
    );
    await waitForUpload(sourceClient, seed.uploadId);
    const extracted = await captureUpload(sourceClient, seed.uploadId);
    assert.equal(
      extracted.author,
      EXIF_FIXTURE_AUTHOR,
      'the deterministic JPEG did not exercise CMA EXIF author extraction',
    );
    await sourceClient.uploads.update(seed.uploadId, {
      author: null,
      copyright: null,
      notes: null,
    });
    const source = await captureUpload(sourceClient, seed.uploadId);
    assert.equal(source.md5, md5(ASSET_FIXTURE_EXIF_JPEG));
    assert.equal(source.filename, 'exif-replacement.jpg');
    assert.equal(source.basename, 'exif-replacement');
    assert.equal(source.author, null);
    assert.equal(source.copyright, null);
    assert.equal(source.notes, null);
    return { source, destination };
  },

  async verifyGeneratedPlan({ seed, planFilePath }) {
    const envelope = JSON.parse(await readFile(planFilePath, 'utf8')) as {
      plan: ContentDiffPlan;
    };
    const upload = envelope.plan.uploads.find(({ id }) => id === seed.uploadId);
    assert.ok(upload, 'isolated EXIF replacement upload is absent from plan');
    assert.equal(upload.action, 'update');
    assert.deepEqual(upload.changes, {
      binary: true,
      metadata: true,
      collection: false,
    });
    for (const field of ['author', 'copyright', 'notes'] as const) {
      assert.equal(upload.baseline?.manual[field], null);
      assert.equal(upload.desired?.manual[field], null);
    }
    assert.deepEqual(envelope.plan.requiredPermissions.uploadActions, [
      'read',
      'update',
      'replace_asset',
    ]);
  },

  async verify({ seed, expected, appliedClient }) {
    console.log('[content-diff e2e] Verifying cleared EXIF manual metadata');
    const applied = await captureUpload(appliedClient, seed.uploadId);
    assert.deepEqual(applied, expected.source);
    assert.equal(applied.md5, md5(ASSET_FIXTURE_EXIF_JPEG));
    assert.equal(applied.author, null);
    assert.equal(applied.copyright, null);
    assert.equal(applied.notes, null);
  },
};

export function exifModelApiKey(runId: string): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return `cde2e_exif_r${suffix}`;
}

function jpegWithExifArtist(jpeg: Buffer, artist: string): Buffer {
  assert.equal(jpeg.readUInt16BE(0), 0xffd8, 'fixture must be a JPEG');
  assert.match(artist, /^[\x20-\x7e]+$/u);
  const artistBytes = Buffer.from(`${artist}\0`, 'ascii');
  const tiff = Buffer.alloc(26 + artistBytes.byteLength);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x013b, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(artistBytes.byteLength, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  artistBytes.copy(tiff, 26);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.byteLength + 2, 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    header,
    payload,
    jpeg.subarray(2),
  ]);
}

async function withFixture<T>(
  bytes: Buffer,
  filename: string,
  callback: (localPath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-exif-'));
  const localPath = join(directory, filename);
  try {
    await writeFile(localPath, bytes);
    return await callback(localPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForUpload(client: CmaClient.Client, uploadId: string) {
  await waitForUploadAntivirusClean(
    { rawFindUpload: (id) => client.uploads.rawFind(id) },
    uploadId,
  );
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
  };
}
