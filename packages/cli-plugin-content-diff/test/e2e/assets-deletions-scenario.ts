import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CmaClient } from '@datocms/cli-utils';
import type { ContentDiffPlan } from '../../src/content-diff/types';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

export const ASSET_FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export const ASSET_FIXTURE_TEXT = Buffer.from(
  'DatoCMS content-diff E2E deterministic text fixture\n',
  'utf8',
);

type AssetRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    hero: { type: 'file'; localized: false };
    gallery: { type: 'gallery'; localized: false };
    seo: { type: 'seo'; localized: false };
  };
};

type AssetSeed = RealCmaScenarioSeed &
  Readonly<{
    locale: string;
    modelId: string;
    recordId: string;
    rootCollectionId: string;
    retainedUploadId: string;
  }>;

type AssetExpected = Readonly<{
  sourceOnlyUploadId: string;
  deletedUploadId: string;
  childCollectionId: string;
  leafCollectionId: string;
  source: RawAssetState;
}>;

export interface RawAssetSelection {
  modelId: string;
  recordId: string;
  uploadIds: string[];
  collectionIds: string[];
}

export interface RawAssetUpload {
  id: string;
  size: number;
  md5: string;
  filename: string;
  basename: string;
  mimeType: string | null;
  author: string | null;
  copyright: string | null;
  notes: string | null;
  tags: string[];
  defaultFieldMetadata: unknown;
  collectionId: string | null;
}

export interface RawAssetCollection {
  id: string;
  label: string;
  position: number;
  parentId: string | null;
  childIds: string[];
}

export interface RawAssetRecord {
  id: string;
  itemTypeId: string;
  title: string;
  hero: RawFileFieldValue | null;
  gallery: RawFileFieldValue[];
  seo: RawSeoFieldValue | null;
}

export interface RawFileFieldValue {
  uploadId: string;
  alt: string | null;
  title: string | null;
  customData: unknown;
  focalPoint: { x: number; y: number } | null;
  posterTime: number | null;
}

export interface RawSeoFieldValue {
  title: string | null;
  description: string | null;
  image: string | null;
  twitterCard: string | null;
  noIndex: boolean | null;
}

export interface RawAssetState {
  allUploadIds: string[];
  uploads: Record<string, RawAssetUpload>;
  collections: Record<string, RawAssetCollection>;
  record: {
    current: RawAssetRecord;
    published: RawAssetRecord;
  };
}

export interface RawAssetReadPort {
  rawListUploads(page: { offset: number; limit: 500 }): Promise<unknown>;
  rawListCollections(): Promise<unknown>;
  rawFindRecord(
    recordId: string,
    version: 'current' | 'published',
  ): Promise<unknown>;
}

export interface UploadAntivirusReadPort {
  rawFindUpload(uploadId: string): Promise<unknown>;
}

export interface WaitForUploadAntivirusCleanOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

const UPLOAD_ANTIVIRUS_TIMEOUT_MS = 120_000;
const UPLOAD_ANTIVIRUS_POLL_INTERVAL_MS = 500;

export const assetsAndDeletionsScenario: RealCmaScenario<
  AssetSeed,
  AssetExpected
> = {
  name: 'bundled uploads, metadata, nested collections, and safe asset deletion',
  contentDiffArgs: ['--uploads=all', '--include-deletions', '--bundle-assets'],

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating asset fixture schema and baseline',
    );
    const modelApiKey = assetModelApiKey(runId);
    const site = await client.site.find();
    const locale = site.locales[0];
    assert.ok(locale, 'the disposable project must expose at least one locale');

    const model = await client.itemTypes.create({
      name: `Asset fixture ${runId}`,
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
    await createAssetFields(client, model.id);

    const rootCollection = await client.uploadCollections.create({
      label: `Asset root ${runId}`,
      position: 0,
      parent: null,
    });
    const retainedUpload = await withLocalAssetFiles(async ({ pngPath }) =>
      client.uploads.createFromLocalFile({
        localPath: pngPath,
        filename: 'retained-baseline.png',
        skipCreationIfAlreadyExists: false,
        author: 'Baseline author',
        copyright: 'Baseline copyright',
        notes: 'Baseline notes',
        tags: ['baseline'],
        default_field_metadata: uploadMetadata(locale, 'baseline', 0.5, 0.5),
        upload_collection: uploadCollectionData(rootCollection.id),
      }),
    );
    await waitForClientUploadAntivirusClean(client, retainedUpload.id);
    const record = await client.items.create<AssetRecordDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      title: 'Asset fixture baseline',
      hero: fileFieldValue(retainedUpload.id, 'baseline hero', 0.5, 0.5),
      gallery: [
        fileFieldValue(retainedUpload.id, 'baseline gallery', 0.5, 0.5),
      ],
      seo: {
        title: 'Baseline SEO',
        description: 'Baseline shared image',
        image: retainedUpload.id,
        twitter_card: 'summary_large_image',
        no_index: false,
      },
    });
    await client.items.publish<AssetRecordDefinition>(record.id);

    return {
      itemTypeApiKeys: [modelApiKey],
      locale,
      modelId: model.id,
      recordId: record.id,
      rootCollectionId: rootCollection.id,
      retainedUploadId: retainedUpload.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating source and destination asset drift',
    );
    const childCollection = await sourceClient.uploadCollections.create({
      label: 'Source child collection',
      position: 0,
      parent: uploadCollectionData(seed.rootCollectionId),
    });
    const leafCollection = await sourceClient.uploadCollections.create({
      label: 'Source leaf collection',
      position: 0,
      parent: uploadCollectionData(childCollection.id),
    });
    await sourceClient.uploadCollections.update(seed.rootCollectionId, {
      label: 'Source asset root',
    });

    const sourceOnlyUpload = await withLocalAssetFiles(async ({ pngPath }) =>
      sourceClient.uploads.createFromLocalFile({
        localPath: pngPath,
        filename: 'source-only-bundled.png',
        skipCreationIfAlreadyExists: false,
        author: 'Source-only author',
        copyright: 'Source-only copyright',
        notes: 'This binary must be bundled into the migration',
        tags: ['bundled', 'source-only'],
        default_field_metadata: uploadMetadata(
          seed.locale,
          'source-only',
          0.2,
          0.8,
        ),
        upload_collection: uploadCollectionData(leafCollection.id),
      }),
    );
    await waitForClientUploadAntivirusClean(sourceClient, sourceOnlyUpload.id);
    await withLocalAssetFiles(async ({ textPath }) => {
      await sourceClient.uploads.updateFromLocalFile(seed.retainedUploadId, {
        localPath: textPath,
        filename: 'retained-source-binary.txt',
      });
    });
    await waitForClientUploadAntivirusClean(
      sourceClient,
      seed.retainedUploadId,
    );
    await sourceClient.uploads.update(seed.retainedUploadId, {
      basename: 'retained-source-metadata',
      author: 'Source metadata author',
      copyright: 'Source metadata copyright',
      notes: 'Writable metadata and same-ID replacement bytes must converge',
      tags: ['retained', 'source-metadata'],
      default_field_metadata: uploadMetadataWithoutFocalPoint(
        seed.locale,
        'retained-source',
      ),
      upload_collection: uploadCollectionData(leafCollection.id),
    });
    await sourceClient.items.update<AssetRecordDefinition>(seed.recordId, {
      title: 'Source asset fixture',
      hero: fileFieldValue(
        sourceOnlyUpload.id,
        'source-only hero override',
        0.2,
        0.8,
      ),
      gallery: [
        fileFieldValue(
          sourceOnlyUpload.id,
          'source-only gallery override',
          0.2,
          0.8,
        ),
        fileFieldValueWithoutFocalPoint(
          seed.retainedUploadId,
          'retained gallery override',
        ),
      ],
      seo: {
        title: 'Source SEO',
        description: 'The source-only bundled image is the SEO image',
        image: sourceOnlyUpload.id,
        twitter_card: 'summary_large_image',
        no_index: false,
      },
    });
    await sourceClient.items.publish<AssetRecordDefinition>(seed.recordId);

    const deletedUpload = await withLocalAssetFiles(async ({ textPath }) =>
      destinationClient.uploads.createFromLocalFile({
        localPath: textPath,
        filename: 'destination-only-delete.txt',
        skipCreationIfAlreadyExists: false,
        author: 'Destination-only author',
        notes: 'This unreferenced upload must be deleted',
        tags: ['destination-only', 'delete'],
      }),
    );
    await waitForClientUploadAntivirusClean(
      destinationClient,
      deletedUpload.id,
    );

    const selection: RawAssetSelection = {
      modelId: seed.modelId,
      recordId: seed.recordId,
      uploadIds: [seed.retainedUploadId, sourceOnlyUpload.id],
      collectionIds: [
        seed.rootCollectionId,
        childCollection.id,
        leafCollection.id,
      ],
    };
    const source = await captureRawAssetState(sourceClient, selection);
    const sourceOnly = source.uploads[sourceOnlyUpload.id];
    const retained = source.uploads[seed.retainedUploadId];
    assert.equal(sourceOnly.md5, md5(ASSET_FIXTURE_PNG));
    assert.equal(sourceOnly.size, ASSET_FIXTURE_PNG.byteLength);
    assert.equal(sourceOnly.mimeType, 'image/png');
    assert.equal(sourceOnly.basename, 'source-only-bundled');
    assert.equal(retained.md5, md5(ASSET_FIXTURE_TEXT));
    assert.equal(retained.size, ASSET_FIXTURE_TEXT.byteLength);
    assert.equal(retained.mimeType, 'text/plain');
    assert.equal(retained.author, 'Source metadata author');

    const destinationUpload = await destinationClient.uploads.rawFind(
      deletedUpload.id,
    );
    assert.equal(
      destinationUpload.data.attributes.md5,
      md5(ASSET_FIXTURE_TEXT),
    );
    assert.equal(
      destinationUpload.data.attributes.size,
      ASSET_FIXTURE_TEXT.byteLength,
    );

    return {
      sourceOnlyUploadId: sourceOnlyUpload.id,
      deletedUploadId: deletedUpload.id,
      childCollectionId: childCollection.id,
      leafCollectionId: leafCollection.id,
      source,
    };
  },

  async verifyGeneratedPlan({ expected, planFilePath }) {
    const envelope = JSON.parse(await readFile(planFilePath, 'utf8')) as {
      plan: ContentDiffPlan;
    };
    const upload = envelope.plan.uploads.find(
      ({ id }) => id === expected.sourceOnlyUploadId,
    );
    assert.ok(upload, 'source-only upload is absent from the generated plan');
    assert.equal(upload.action, 'create');
    assert.equal(upload.desired?.basename, 'source-only-bundled');
    assert.equal(upload.desired?.filename, 'source-only-bundled.png');
  },

  async verify({ seed, expected, appliedClient }) {
    console.log('[content-diff e2e] Verifying assets through raw CMA');
    const selection: RawAssetSelection = {
      modelId: seed.modelId,
      recordId: seed.recordId,
      uploadIds: [seed.retainedUploadId, expected.sourceOnlyUploadId],
      collectionIds: [
        seed.rootCollectionId,
        expected.childCollectionId,
        expected.leafCollectionId,
      ],
    };
    const actual = await captureRawAssetState(appliedClient, selection);

    assert.deepEqual(
      actual.record,
      expected.source.record,
      'file, gallery, or SEO raw field values differ from source',
    );
    assert.deepEqual(
      actual.uploads,
      expected.source.uploads,
      'raw selected upload bytes, metadata, tags, or collection differ',
    );
    assert.deepEqual(
      actual.collections,
      expected.source.collections,
      'raw nested upload collection topology differs',
    );
    assert.deepEqual(
      actual.allUploadIds,
      expected.source.allUploadIds,
      '--uploads=all did not reproduce the exact source upload ID set',
    );
    assert.equal(
      actual.allUploadIds.includes(expected.deletedUploadId),
      false,
      'destination-only unreferenced text upload was retained',
    );
    assert.equal(
      actual.uploads[expected.sourceOnlyUploadId].md5,
      md5(ASSET_FIXTURE_PNG),
      'bundled source-only PNG bytes changed',
    );
    assert.equal(
      actual.uploads[expected.sourceOnlyUploadId].basename,
      'source-only-bundled',
      'source-only canonical basename did not converge after binary creation',
    );
    assert.equal(
      actual.uploads[seed.retainedUploadId].author,
      'Source metadata author',
      'writable metadata update did not converge',
    );
    assert.equal(
      actual.uploads[seed.retainedUploadId].md5,
      md5(ASSET_FIXTURE_TEXT),
      'same-ID upload binary replacement did not converge',
    );

    const referencedIds = recordUploadIds(actual.record);
    assert.ok(
      referencedIds.has(seed.retainedUploadId),
      'shared retained upload lost its current/published reference boundary',
    );
    assert.ok(
      referencedIds.has(expected.sourceOnlyUploadId),
      'source-only bundled upload is not referenced after migration',
    );
  },
};

export async function captureRawAssetState(
  client: CmaClient.Client,
  selection: RawAssetSelection,
): Promise<RawAssetState> {
  return captureRawAssetStateFromPort(
    {
      rawListUploads: (page) =>
        client.uploads.rawList({ page, order_by: 'id_ASC' }),
      rawListCollections: () => client.uploadCollections.rawList(),
      rawFindRecord: (recordId, version) =>
        client.items.rawFind<AssetRecordDefinition>(recordId, {
          nested: true,
          version,
        }),
    },
    selection,
  );
}

export async function waitForUploadAntivirusClean(
  port: UploadAntivirusReadPort,
  uploadId: string,
  options: WaitForUploadAntivirusCleanOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? UPLOAD_ANTIVIRUS_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? UPLOAD_ANTIVIRUS_POLL_INTERVAL_MS;
  assertNonNegativeFiniteNumber(timeoutMs, 'timeoutMs');
  assertPositiveFiniteNumber(pollIntervalMs, 'pollIntervalMs');

  const deadline = Date.now() + timeoutMs;
  while (true) {
    let response: unknown;
    try {
      response = await port.rawFindUpload(uploadId);
    } catch {
      throw new Error(
        `Unable to read antivirus status for upload ${JSON.stringify(
          uploadId,
        )}.`,
      );
    }

    const status = uploadAntivirusStatus(response);
    if (status === 'clean') return;

    if (status !== 'pending') {
      const safeStatus =
        status === 'infected' || status === 'failed' || status === 'skipped'
          ? status
          : 'unknown';
      throw new Error(
        `Upload ${JSON.stringify(
          uploadId,
        )} antivirus status is ${JSON.stringify(safeStatus)}.`,
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Upload ${JSON.stringify(
          uploadId,
        )} antivirus status remained "pending" until the ${timeoutMs}ms timeout.`,
      );
    }

    await (options.wait ?? wait)(Math.min(pollIntervalMs, remainingMs));
  }
}

async function waitForClientUploadAntivirusClean(
  client: CmaClient.Client,
  uploadId: string,
): Promise<void> {
  await waitForUploadAntivirusClean(
    {
      rawFindUpload: (id) => client.uploads.rawFind(id),
    },
    uploadId,
  );
}

function uploadAntivirusStatus(response: unknown): string | null {
  if (!isRecord(response)) return null;
  const resource = response.data;
  if (!isRecord(resource)) return null;
  const meta = resource.meta;
  if (!isRecord(meta)) return null;
  const antivirus = meta.antivirus;
  if (!isRecord(antivirus)) return null;
  return typeof antivirus.status === 'string' ? antivirus.status : null;
}

function assertNonNegativeFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

function assertPositiveFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function captureRawAssetStateFromPort(
  port: RawAssetReadPort,
  selection: RawAssetSelection,
): Promise<RawAssetState> {
  assertSelection(selection);
  const [uploadResources, collectionResponse, current, published] =
    await Promise.all([
      readAllUploads(port),
      port.rawListCollections(),
      port.rawFindRecord(selection.recordId, 'current'),
      port.rawFindRecord(selection.recordId, 'published'),
    ]);
  const uploadById = new Map(
    uploadResources.map((resource, index) => {
      const parsed = rawResource(resource, `uploads[${index}]`);
      if (parsed.type !== 'upload') {
        throw new Error(`uploads[${index}] is not an upload resource`);
      }
      return [parsed.id, parsed] as const;
    }),
  );
  if (uploadById.size !== uploadResources.length) {
    throw new Error('upload list contains duplicate IDs');
  }
  const uploads = Object.fromEntries(
    [...selection.uploadIds].sort().map((id) => {
      const resource = uploadById.get(id);
      if (!resource) throw new Error(`selected upload ${id} is absent`);
      return [id, normalizeRawUpload(resource)] as const;
    }),
  );

  const collectionData = rawDataArray(
    collectionResponse,
    'upload collection list',
  );
  const collectionById = new Map(
    collectionData.map((resource, index) => {
      const parsed = rawResource(resource, `uploadCollections[${index}]`);
      if (parsed.type !== 'upload_collection') {
        throw new Error(
          `uploadCollections[${index}] is not an upload_collection resource`,
        );
      }
      return [parsed.id, parsed] as const;
    }),
  );
  if (collectionById.size !== collectionData.length) {
    throw new Error('upload collection list contains duplicate IDs');
  }
  const collections = Object.fromEntries(
    [...selection.collectionIds].sort().map((id) => {
      const resource = collectionById.get(id);
      if (!resource)
        throw new Error(`selected upload collection ${id} is absent`);
      return [id, normalizeRawCollection(resource)] as const;
    }),
  );

  return {
    allUploadIds: [...uploadById.keys()].sort(),
    uploads,
    collections,
    record: {
      current: normalizeRawRecord(current, selection),
      published: normalizeRawRecord(published, selection),
    },
  };
}

async function createAssetFields(
  client: CmaClient.Client,
  modelId: string,
): Promise<void> {
  await client.fields.create(modelId, {
    label: 'Title',
    api_key: 'title',
    field_type: 'string',
    localized: false,
    validators: { required: {} },
  });
  await client.fields.create(modelId, {
    label: 'Hero',
    api_key: 'hero',
    field_type: 'file',
    localized: false,
    validators: {},
  });
  await client.fields.create(modelId, {
    label: 'Gallery',
    api_key: 'gallery',
    field_type: 'gallery',
    localized: false,
    validators: {},
  });
  await client.fields.create(modelId, {
    label: 'SEO',
    api_key: 'seo',
    field_type: 'seo',
    localized: false,
    validators: {},
  });
}

async function withLocalAssetFiles<T>(
  callback: (paths: { pngPath: string; textPath: string }) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-assets-'));
  const pngPath = join(directory, 'fixture.png');
  const textPath = join(directory, 'fixture.txt');
  try {
    await Promise.all([
      writeFile(pngPath, ASSET_FIXTURE_PNG),
      writeFile(textPath, ASSET_FIXTURE_TEXT),
    ]);
    return await callback({ pngPath, textPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function uploadMetadata(locale: string, label: string, x: number, y: number) {
  return {
    alt: { [locale]: `${label} default alt` },
    title: { [locale]: `${label} default title` },
    custom_data: { [locale]: { fixture: label, deterministic: true } },
    focal_point: { x, y },
    poster_time: null,
  };
}

function uploadMetadataWithoutFocalPoint(locale: string, label: string) {
  return {
    alt: { [locale]: `${label} default alt` },
    title: { [locale]: `${label} default title` },
    custom_data: { [locale]: { fixture: label, deterministic: true } },
    focal_point: null,
    poster_time: null,
  };
}

function fileFieldValue(uploadId: string, label: string, x: number, y: number) {
  return {
    upload_id: uploadId,
    alt: `${label} alt`,
    title: `${label} title`,
    custom_data: { fixture: label, deterministic: true },
    focal_point: { x, y },
    poster_time: null,
  };
}

function fileFieldValueWithoutFocalPoint(uploadId: string, label: string) {
  return {
    upload_id: uploadId,
    alt: `${label} alt`,
    title: `${label} title`,
    custom_data: { fixture: label, deterministic: true },
    focal_point: null,
    poster_time: null,
  };
}

function uploadCollectionData(id: string) {
  return { id, type: 'upload_collection' as const };
}

async function readAllUploads(port: RawAssetReadPort): Promise<unknown[]> {
  const resources: unknown[] = [];
  let total: number | null = null;
  while (total === null || resources.length < total) {
    const resolved = object(
      await port.rawListUploads({ offset: resources.length, limit: 500 }),
      'upload list',
    );
    const data = array(resolved.data, 'upload list data');
    const count = object(resolved.meta, 'upload list meta').total_count;
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new Error('upload list has an invalid total_count');
    }
    if (total === null) total = count as number;
    if (total !== count)
      throw new Error('upload total_count changed during capture');
    if (data.length === 0 && resources.length < total) {
      throw new Error('upload pagination ended before total_count');
    }
    resources.push(...data);
  }
  if (resources.length !== total) {
    throw new Error('upload list count differs from total_count');
  }
  return resources;
}

function normalizeRawUpload(resource: RawResource): RawAssetUpload {
  const attributes = resource.attributes;
  return {
    id: resource.id,
    size: integer(attributes.size, `${resource.id}.size`),
    md5: string(attributes.md5, `${resource.id}.md5`),
    filename: string(attributes.filename, `${resource.id}.filename`),
    basename: string(attributes.basename, `${resource.id}.basename`),
    mimeType: nullableString(attributes.mime_type, `${resource.id}.mime_type`),
    author: nullableString(attributes.author, `${resource.id}.author`),
    copyright: nullableString(attributes.copyright, `${resource.id}.copyright`),
    notes: nullableString(attributes.notes, `${resource.id}.notes`),
    tags: array(attributes.tags, `${resource.id}.tags`)
      .map((value, index) => string(value, `${resource.id}.tags[${index}]`))
      .sort(),
    defaultFieldMetadata: canonicalJson(attributes.default_field_metadata),
    collectionId: relationshipId(resource, 'upload_collection', true),
  };
}

function normalizeRawCollection(resource: RawResource): RawAssetCollection {
  return {
    id: resource.id,
    label: string(resource.attributes.label, `${resource.id}.label`),
    position: integer(resource.attributes.position, `${resource.id}.position`),
    parentId: relationshipId(resource, 'parent', true),
    childIds: relationshipIds(resource, 'children'),
  };
}

function normalizeRawRecord(
  response: unknown,
  selection: RawAssetSelection,
): RawAssetRecord {
  const resource = rawResource(
    object(response, 'record response').data,
    'record response data',
  );
  if (resource.type !== 'item' || resource.id !== selection.recordId) {
    throw new Error('record response contains the wrong resource');
  }
  const itemTypeId = relationshipId(resource, 'item_type', false);
  if (itemTypeId !== selection.modelId) {
    throw new Error(`record ${resource.id} belongs to the wrong model`);
  }
  return {
    id: resource.id,
    itemTypeId,
    title: string(resource.attributes.title, `${resource.id}.title`),
    hero: normalizeFileField(resource.attributes.hero, `${resource.id}.hero`),
    gallery: array(resource.attributes.gallery, `${resource.id}.gallery`).map(
      (value, index) => {
        const normalized = normalizeFileField(
          value,
          `${resource.id}.gallery[${index}]`,
        );
        if (!normalized) throw new Error('gallery entries cannot be null');
        return normalized;
      },
    ),
    seo: normalizeSeo(resource.attributes.seo, `${resource.id}.seo`),
  };
}

function normalizeFileField(
  value: unknown,
  path: string,
): RawFileFieldValue | null {
  if (value === null) return null;
  const field = object(value, path);
  const focalPoint =
    field.focal_point === null
      ? null
      : {
          x: number(
            object(field.focal_point, `${path}.focal_point`).x,
            `${path}.focal_point.x`,
          ),
          y: number(
            object(field.focal_point, `${path}.focal_point`).y,
            `${path}.focal_point.y`,
          ),
        };
  return {
    uploadId: string(field.upload_id, `${path}.upload_id`),
    alt: nullableString(field.alt, `${path}.alt`),
    title: nullableString(field.title, `${path}.title`),
    customData: canonicalJson(field.custom_data),
    focalPoint,
    posterTime: nullableNumber(field.poster_time, `${path}.poster_time`),
  };
}

function normalizeSeo(value: unknown, path: string): RawSeoFieldValue | null {
  if (value === null) return null;
  const seo = object(value, path);
  if (seo.no_index !== undefined && typeof seo.no_index !== 'boolean') {
    throw new Error(`${path}.no_index must be a boolean`);
  }
  return {
    title: nullableString(seo.title, `${path}.title`),
    description: nullableString(seo.description, `${path}.description`),
    image: nullableString(seo.image, `${path}.image`),
    twitterCard: nullableString(seo.twitter_card, `${path}.twitter_card`),
    noIndex: seo.no_index === undefined ? null : seo.no_index,
  };
}

function recordUploadIds(record: RawAssetState['record']): Set<string> {
  const result = new Set<string>();
  for (const version of [record.current, record.published]) {
    if (version.hero) result.add(version.hero.uploadId);
    for (const entry of version.gallery) result.add(entry.uploadId);
    if (version.seo?.image) result.add(version.seo.image);
  }
  return result;
}

function assertSelection(selection: RawAssetSelection): void {
  for (const [path, value] of [
    ['modelId', selection.modelId],
    ['recordId', selection.recordId],
  ] as const) {
    string(value, `selection.${path}`);
  }
  if (new Set(selection.uploadIds).size !== selection.uploadIds.length) {
    throw new Error('asset selection contains duplicate upload IDs');
  }
  selection.uploadIds.forEach((id, index) =>
    string(id, `selection.uploadIds[${index}]`),
  );
  if (
    new Set(selection.collectionIds).size !== selection.collectionIds.length
  ) {
    throw new Error('asset selection contains duplicate collection IDs');
  }
  selection.collectionIds.forEach((id, index) =>
    string(id, `selection.collectionIds[${index}]`),
  );
}

type RawResource = {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
};

function rawResource(value: unknown, path: string): RawResource {
  const resource = object(value, path);
  return {
    type: string(resource.type, `${path}.type`),
    id: string(resource.id, `${path}.id`),
    attributes: object(resource.attributes ?? {}, `${path}.attributes`),
    relationships: object(
      resource.relationships ?? {},
      `${path}.relationships`,
    ),
  };
}

function rawDataArray(value: unknown, path: string): unknown[] {
  return array(object(value, path).data, `${path}.data`);
}

function relationshipId(
  resource: RawResource,
  key: string,
  nullable: boolean,
): string | null {
  const relationship = object(
    resource.relationships[key],
    `${resource.id}.${key}`,
  );
  if (relationship.data === null) {
    if (!nullable) throw new Error(`${resource.id}.${key} cannot be null`);
    return null;
  }
  return string(
    object(relationship.data, `${resource.id}.${key}.data`).id,
    `${resource.id}.${key}.data.id`,
  );
}

function relationshipIds(resource: RawResource, key: string): string[] {
  const relationship = object(
    resource.relationships[key],
    `${resource.id}.${key}`,
  );
  return array(relationship.data, `${resource.id}.${key}.data`).map(
    (value, index) =>
      string(
        object(value, `${resource.id}.${key}[${index}]`).id,
        `${resource.id}.${key}[${index}].id`,
      ),
  );
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : number(value, path);
}

function integer(value: unknown, path: string): number {
  const result = number(value, path);
  if (!Number.isInteger(result)) throw new Error(`${path} must be an integer`);
  return result;
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

export function md5(value: Uint8Array): string {
  return createHash('md5').update(value).digest('hex');
}

export function assetModelApiKey(runId: string): string {
  const compactRunId = runId.replace(/-/g, '');
  if (!/^[a-z0-9]+$/.test(compactRunId)) {
    throw new Error(
      'asset fixture run ID must contain only lowercase alphanumerics and hyphens',
    );
  }
  return `cde2e_asset_r${compactRunId.slice(-12)}`;
}
