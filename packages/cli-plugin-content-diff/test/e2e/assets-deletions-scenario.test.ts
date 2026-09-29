import assert from 'node:assert/strict';
import { expect } from 'chai';
import {
  ASSET_FIXTURE_PNG,
  ASSET_FIXTURE_TEXT,
  type RawAssetReadPort,
  assetModelApiKey,
  captureRawAssetStateFromPort,
  md5,
  waitForUploadAntivirusClean,
} from './assets-deletions-scenario';
import {
  ASSET_FIXTURE_EXIF_JPEG,
  EXIF_FIXTURE_AUTHOR,
  exifModelApiKey,
} from './upload-exif-replacement-scenario';

const MODEL_ID = 'asset-model';
const RECORD_ID = 'asset-record';
const UPLOAD_A = 'upload-a';
const UPLOAD_B = 'upload-b';
const ROOT_COLLECTION = 'collection-root';
const LEAF_COLLECTION = 'collection-leaf';

describe('asset/deletion real-CMA scenario oracle', () => {
  it('uses deterministic local byte fixtures', () => {
    expect(ASSET_FIXTURE_PNG.byteLength).to.equal(68);
    expect(ASSET_FIXTURE_PNG.subarray(1, 4).toString('ascii')).to.equal('PNG');
    expect(md5(ASSET_FIXTURE_PNG)).to.equal('e44e7ecfec99356632c13cd3eaa3e250');
    expect(md5(ASSET_FIXTURE_TEXT)).to.equal(
      '2af47b817f2f3efe3bcf89b4027f8dba',
    );
    expect(md5(ASSET_FIXTURE_EXIF_JPEG)).to.equal(
      'ee3de695dd09060dad8d0af81180dcab',
    );
    expect(exifArtist(ASSET_FIXTURE_EXIF_JPEG)).to.equal(EXIF_FIXTURE_AUTHOR);
  });

  it('builds a compact API key without underscore-before-digit segments', () => {
    const apiKey = assetModelApiKey('mepgph3k-0f12ab');

    expect(apiKey).to.equal('cde2e_asset_rpgph3k0f12ab');
    expect(apiKey).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(apiKey.length).to.be.lessThan(30);

    const exifApiKey = exifModelApiKey('mt1ljjsa-7fdeb4');
    expect(exifApiKey).to.equal('cde2e_exif_r6b506f4f2363');
    expect(exifApiKey).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    expect(exifApiKey.length).to.be.lessThan(30);
  });

  it('waits through pending antivirus scans until an upload is clean', async () => {
    const statuses = ['pending', 'pending', 'clean'];
    const waits: number[] = [];
    let readCount = 0;

    await waitForUploadAntivirusClean(
      {
        rawFindUpload: async () =>
          rawUploadAntivirusStatus(statuses[readCount++] ?? 'clean'),
      },
      UPLOAD_A,
      {
        timeoutMs: 1_000,
        pollIntervalMs: 25,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    );

    expect(readCount).to.equal(3);
    expect(waits).to.deep.equal([25, 25]);
  });

  it('fails a pending antivirus scan at its bounded timeout', async () => {
    await assert.rejects(
      waitForUploadAntivirusClean(
        {
          rawFindUpload: async () => rawUploadAntivirusStatus('pending'),
        },
        UPLOAD_A,
        { timeoutMs: 0, pollIntervalMs: 25 },
      ),
      {
        message:
          'Upload "upload-a" antivirus status remained "pending" until the 0ms timeout.',
      },
    );
  });

  it('reports only the upload ID and safe terminal antivirus status', async () => {
    await assert.rejects(
      waitForUploadAntivirusClean(
        {
          rawFindUpload: async () => ({
            ...rawUploadAntivirusStatus('infected'),
            privateFieldValue: 'must-not-leak',
          }),
        },
        UPLOAD_A,
      ),
      (error: Error) => {
        expect(error.message).to.equal(
          'Upload "upload-a" antivirus status is "infected".',
        );
        expect(error.message).not.to.contain('must-not-leak');
        return true;
      },
    );
  });

  it('normalizes raw uploads, collection topology, and file/gallery/SEO fields', async () => {
    const versions: string[] = [];
    const pages: Array<{ offset: number; limit: 500 }> = [];
    const port: RawAssetReadPort = {
      rawListUploads: async (page) => {
        pages.push(page);
        const uploads = [
          rawUpload(UPLOAD_B, null),
          rawUpload(UPLOAD_A, LEAF_COLLECTION),
        ];
        return {
          data: uploads.slice(page.offset, page.offset + page.limit),
          meta: { total_count: uploads.length },
        };
      },
      rawListCollections: async () => ({
        data: [
          rawCollection(ROOT_COLLECTION, null, [LEAF_COLLECTION], 0),
          rawCollection(LEAF_COLLECTION, ROOT_COLLECTION, [], 0),
        ],
      }),
      rawFindRecord: async (_recordId, version) => {
        versions.push(version);
        return { data: rawRecord(version) };
      },
    };

    const state = await captureRawAssetStateFromPort(port, {
      modelId: MODEL_ID,
      recordId: RECORD_ID,
      uploadIds: [UPLOAD_A],
      collectionIds: [LEAF_COLLECTION, ROOT_COLLECTION],
    });

    expect(pages).to.deep.equal([{ offset: 0, limit: 500 }]);
    expect(versions.sort()).to.deep.equal(['current', 'published']);
    expect(state.allUploadIds).to.deep.equal([UPLOAD_A, UPLOAD_B]);
    expect(state.uploads[UPLOAD_A]).to.deep.equal({
      id: UPLOAD_A,
      size: ASSET_FIXTURE_PNG.byteLength,
      md5: md5(ASSET_FIXTURE_PNG),
      filename: 'fixture.png',
      basename: 'fixture',
      mimeType: 'image/png',
      author: 'Fixture author',
      copyright: null,
      notes: 'Fixture notes',
      tags: ['a', 'z'],
      defaultFieldMetadata: {
        alt: { en: 'Default alt' },
        custom_data: { en: { deterministic: true } },
        focal_point: { x: 0.25, y: 0.75 },
        poster_time: null,
        title: { en: 'Default title' },
      },
      collectionId: LEAF_COLLECTION,
    });
    expect(state.collections[ROOT_COLLECTION]).to.deep.equal({
      id: ROOT_COLLECTION,
      label: 'collection-root',
      position: 0,
      parentId: null,
      childIds: [LEAF_COLLECTION],
    });
    expect(state.record.current.hero?.uploadId).to.equal(UPLOAD_A);
    expect(
      state.record.current.gallery.map(({ uploadId }) => uploadId),
    ).to.deep.equal([UPLOAD_A, UPLOAD_B]);
    expect(state.record.current.seo?.image).to.equal(UPLOAD_A);
    expect(state.record.published.title).to.equal('published title');
  });
});

function exifArtist(jpeg: Buffer): string {
  const signature = Buffer.from('Exif\0\0', 'ascii');
  const exifStart = jpeg.indexOf(signature);
  assert.ok(exifStart > 0, 'fixture is missing its EXIF APP1 payload');
  const tiffStart = exifStart + signature.byteLength;
  assert.equal(jpeg.subarray(tiffStart, tiffStart + 2).toString('ascii'), 'II');
  const ifdStart = tiffStart + jpeg.readUInt32LE(tiffStart + 4);
  assert.equal(jpeg.readUInt16LE(ifdStart), 1);
  const entry = ifdStart + 2;
  assert.equal(jpeg.readUInt16LE(entry), 0x013b);
  assert.equal(jpeg.readUInt16LE(entry + 2), 2);
  const length = jpeg.readUInt32LE(entry + 4);
  const value = tiffStart + jpeg.readUInt32LE(entry + 8);
  return jpeg.subarray(value, value + length - 1).toString('ascii');
}

function rawUpload(id: string, collectionId: string | null) {
  return {
    type: 'upload',
    id,
    attributes: {
      size: ASSET_FIXTURE_PNG.byteLength,
      md5: md5(ASSET_FIXTURE_PNG),
      filename: 'fixture.png',
      basename: 'fixture',
      mime_type: 'image/png',
      author: 'Fixture author',
      copyright: null,
      notes: 'Fixture notes',
      tags: ['z', 'a'],
      default_field_metadata: {
        title: { en: 'Default title' },
        alt: { en: 'Default alt' },
        custom_data: { en: { deterministic: true } },
        focal_point: { x: 0.25, y: 0.75 },
        poster_time: null,
      },
    },
    relationships: {
      upload_collection: relationship(collectionId, 'upload_collection'),
    },
  };
}

function rawUploadAntivirusStatus(status: string) {
  return {
    data: {
      meta: {
        antivirus: { status },
      },
    },
  };
}

function rawCollection(
  id: string,
  parentId: string | null,
  childIds: string[],
  position: number,
) {
  return {
    type: 'upload_collection',
    id,
    attributes: { label: id, position },
    relationships: {
      parent: relationship(parentId, 'upload_collection'),
      children: {
        data: childIds.map((childId) => ({
          type: 'upload_collection',
          id: childId,
        })),
      },
    },
  };
}

function rawRecord(version: 'current' | 'published') {
  return {
    type: 'item',
    id: RECORD_ID,
    attributes: {
      title: `${version} title`,
      hero: fileValue(UPLOAD_A, 'hero'),
      gallery: [fileValue(UPLOAD_A, 'first'), fileValue(UPLOAD_B, 'second')],
      seo: {
        title: 'SEO title',
        description: 'SEO description',
        image: UPLOAD_A,
        twitter_card: 'summary_large_image',
        no_index: false,
      },
    },
    relationships: { item_type: relationship(MODEL_ID, 'item_type') },
  };
}

function fileValue(uploadId: string, label: string) {
  return {
    upload_id: uploadId,
    alt: `${label} alt`,
    title: `${label} title`,
    custom_data: { label },
    focal_point: { x: 0.25, y: 0.75 },
    poster_time: null,
  };
}

function relationship(id: string | null, type: string) {
  return { data: id === null ? null : { id, type } };
}
