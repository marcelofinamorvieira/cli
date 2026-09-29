import type { CmaClient } from '@datocms/cli-utils';
import {
  canonicalizeJson,
  canonicalizeRecord,
  canonicalizeSchedules,
  canonicalizeUpload,
  canonicalizeUploadCollection,
  semanticHash,
  stableStringify,
} from './canonicalize';
import {
  buildBlockOwnershipIndex,
  collectUploadReferences,
} from './dependencies';
import {
  buildContentInspectionSnapshot,
  inspectionSubsetMatches,
  schemaWithInspectionItemTypes,
} from './inspection-schema';
import {
  fetchSchemaSnapshot,
  migrationsTrackingModelId,
  resolveItemTypeSelection,
  schemaForScope,
} from './schema';
import { mapWithConcurrency } from './shared/concurrency';
import { isObject } from './shared/json';
import { compareStrings } from './shared/ordering';
import { parseScheduleDetails } from './shared/schedules';
import { inspectRecordStructuralContent } from './structural-content';
import type {
  CaptureContentSnapshotInput,
  ContentSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  RecordScheduleSnapshot,
  ScheduleAdapter,
  SchemaSnapshot,
  StructuralContentIssue,
  UploadCollectionSnapshot,
  UploadSnapshot,
} from './types';
import { CONTENT_SNAPSHOT_FORMAT_VERSION, ContentDiffError } from './types';
import { DEFAULT_CONTENT_DIFF_MODEL_API_KEY } from './types';

const READ_CONCURRENCY = 5;
const RECORD_PAGE_SIZE_WITH_NESTED_BLOCKS = 30;
const COLLECTION_PAGE_SIZE = 500;

export const defaultScheduleAdapter: ScheduleAdapter = {
  read: readScheduleDetails,
};

export async function captureContentSnapshot({
  client,
  environmentId,
  schema: providedSchema,
  scope,
  maxAttempts = 3,
  scheduleAdapter = defaultScheduleAdapter,
  fullAccessVerified,
}: CaptureContentSnapshotInput): Promise<ContentSnapshot> {
  const contentDiffModelApiKey =
    scope.contentDiffModelApiKey ?? DEFAULT_CONTENT_DIFF_MODEL_API_KEY;
  if (fullAccessVerified !== true) {
    throw new ContentDiffError(
      'UNPROVEN_FULL_ACCESS',
      'Exact content diff requires credentials with provably unrestricted record and upload reads.',
    );
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ContentDiffError(
      'INVALID_SCOPE',
      'maxAttempts must be a positive integer.',
    );
  }

  let fullSchema =
    providedSchema ?? (await fetchSchemaSnapshot(client, environmentId));
  const verifiedReadScope = stableStringify(
    readItemTypesForPermissionProof(
      fullSchema,
      scope.migrationsModelApiKey,
      contentDiffModelApiKey,
    ),
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const selectedItemTypes = resolveItemTypeSelection(
      fullSchema,
      scope.itemTypes,
      scope.migrationsModelApiKey,
      scope.contentDiffModelApiKey,
    );
    const scopedSchema = schemaForScope(
      fullSchema,
      scope.itemTypes,
      scope.migrationsModelApiKey,
      scope.contentDiffModelApiKey,
    );
    const captured = await captureOnce(
      client,
      environmentId,
      fullSchema,
      scopedSchema,
      selectedItemTypes,
      scope.uploads,
      new Set(scope.baselineUploadIds ?? []),
      new Set(scope.baselineUploadCollectionIds ?? []),
      scope.allUploadCollections === true,
      scheduleAdapter,
      scope.migrationsModelApiKey,
      contentDiffModelApiKey,
    );
    const [verificationMarker, refreshedFullSchema] = await Promise.all([
      captureConsistencyMarker(
        client,
        fullSchema,
        selectedItemTypes,
        scope.uploads,
        new Set([
          ...Object.keys(captured.snapshot.uploads),
          ...Object.values(
            captured.snapshot.missingUploadReferences ?? {},
          ).flat(),
          ...(scope.baselineUploadIds ?? []),
        ]),
        new Set([
          ...Object.keys(captured.snapshot.uploadCollections),
          ...(scope.baselineUploadCollectionIds ?? []),
        ]),
        scope.allUploadCollections === true,
        scheduleAdapter,
        scopedSchema.locales,
        scope.migrationsModelApiKey,
        contentDiffModelApiKey,
      ),
      fetchSchemaSnapshot(client, environmentId),
    ]);
    const refreshedScopedSchema = schemaForScope(
      refreshedFullSchema,
      scope.itemTypes,
      scope.migrationsModelApiKey,
      scope.contentDiffModelApiKey,
    );
    const capturedReadScope = stableStringify(
      readItemTypesForPermissionProof(
        fullSchema,
        scope.migrationsModelApiKey,
        contentDiffModelApiKey,
      ),
    );
    const refreshedReadScope = stableStringify(
      readItemTypesForPermissionProof(
        refreshedFullSchema,
        scope.migrationsModelApiKey,
        contentDiffModelApiKey,
      ),
    );

    if (
      captured.marker === verificationMarker &&
      scopedSchema.digest === refreshedScopedSchema.digest &&
      inspectionSubsetMatches(
        captured.snapshot.inspection,
        refreshedFullSchema,
      ) &&
      capturedReadScope === refreshedReadScope &&
      refreshedReadScope === verifiedReadScope
    ) {
      return captured.snapshot;
    }

    fullSchema = refreshedFullSchema;
  }

  throw new ContentDiffError(
    'CONCURRENT_SNAPSHOT_CHANGE',
    `The ${environmentId} environment changed while it was being read. Stop concurrent edits and retry.`,
    { environmentId, attempts: maxAttempts },
  );
}

export async function readScheduleDetails(
  client: CmaClient.Client,
  recordId: string,
): Promise<RecordScheduleSnapshot> {
  return parseScheduleDetails(
    await client.items.rawCurrentVsPublishedState(recordId),
    recordId,
  );
}

export function snapshotSemanticState(snapshot: ContentSnapshot): JsonObject {
  return {
    siteId: snapshot.siteId,
    schemaDigest: snapshot.schema.digest,
    scope: snapshot.scope,
    readItemTypes: snapshot.readItemTypes,
    records: Object.fromEntries(
      Object.values(snapshot.records)
        .sort((left, right) => compareStrings(left.id, right.id))
        .map((record) => [
          record.id,
          {
            hash: record.hash,
            position: record.topology.position,
            validity: {
              current: record.validity.current,
              published: record.validity.published,
            },
          },
        ]),
    ),
    uploads: Object.fromEntries(
      Object.values(snapshot.uploads)
        .sort((left, right) => compareStrings(left.id, right.id))
        .map((upload) => [upload.id, upload.hash]),
    ),
    uploadCollections: Object.fromEntries(
      Object.values(snapshot.uploadCollections)
        .sort((left, right) => compareStrings(left.id, right.id))
        .map((collection) => [collection.id, collection.hash]),
    ),
    missingUploadReferences: snapshot.missingUploadReferences ?? {},
    inspection: canonicalizeJson(snapshot.inspection),
  };
}

async function captureOnce(
  client: CmaClient.Client,
  environmentId: string,
  fullSchema: SchemaSnapshot,
  scopedSchema: SchemaSnapshot,
  selectedItemTypes: ItemTypeSchemaSnapshot[],
  uploadsMode: 'referenced' | 'all',
  baselineUploadIds: ReadonlySet<string>,
  baselineCollectionIds: ReadonlySet<string>,
  allUploadCollections: boolean,
  scheduleAdapter: ScheduleAdapter,
  migrationsModelApiKey: string | undefined,
  contentDiffModelApiKey: string,
): Promise<{ snapshot: ContentSnapshot; marker: string }> {
  const currentItems = await listItems(
    client,
    selectedItemTypes,
    'current',
    true,
  );
  const publishedItems = await listItems(
    client,
    selectedItemTypes,
    'published',
    true,
  );
  const currentById = indexItems(currentItems);
  const publishedById = indexItems(publishedItems);
  const schedules = new Map<string, RecordScheduleSnapshot>();
  const scheduledItems = currentItems.filter(hasScheduleMarker);
  const scheduleValues = await mapWithConcurrency(
    scheduledItems,
    READ_CONCURRENCY,
    async (item) => scheduleAdapter.read(client, requiredItemId(item)),
  );

  scheduledItems.forEach((item, index) => {
    schedules.set(requiredItemId(item), scheduleValues[index]);
  });

  const encounteredItemTypeIds = new Set<string>();
  const structuralIssues: StructuralContentIssue[] = [];

  for (const [recordId, currentItem] of Object.entries(currentById).sort(
    ([left], [right]) => compareStrings(left, right),
  )) {
    const itemTypeId = itemTypeIdOf(currentItem);
    const itemType = selectedItemTypes.find(({ id }) => id === itemTypeId);

    if (!itemType) {
      throw new ContentDiffError(
        'INCOMPATIBLE_SCHEMA',
        `Record ${recordId} refers to an item type outside the selected scope.`,
      );
    }

    for (const [slice, item] of [
      ['current', currentItem] as const,
      ['published', publishedById[recordId]] as const,
    ]) {
      if (!item) continue;
      const inspection = inspectRecordStructuralContent(
        item,
        itemType,
        fullSchema,
        recordId,
        slice,
      );
      inspection.encounteredItemTypeIds.forEach((id) =>
        encounteredItemTypeIds.add(id),
      );
      structuralIssues.push(...inspection.issues);
    }
  }

  const inspection = buildContentInspectionSnapshot(
    fullSchema,
    scopedSchema,
    encounteredItemTypeIds,
    structuralIssues,
  );
  const traversalSchema = schemaWithInspectionItemTypes(
    scopedSchema,
    inspection.itemTypes,
  );

  const records = Object.fromEntries(
    Object.entries(currentById)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([recordId, currentItem]) => {
        const itemTypeId = itemTypeIdOf(currentItem);
        const itemType = selectedItemTypes.find(({ id }) => id === itemTypeId);

        if (!itemType) {
          throw new ContentDiffError(
            'INCOMPATIBLE_SCHEMA',
            `Record ${recordId} refers to an item type outside the selected scope.`,
          );
        }

        const publishedItem = publishedById[recordId] ?? null;
        if (publishedItem && itemTypeIdOf(publishedItem) !== itemTypeId) {
          throw new ContentDiffError(
            'UNSUPPORTED_CONTENT_STATE',
            `Record ${recordId} resolves to different models in current and published versions.`,
          );
        }

        return [
          recordId,
          canonicalizeRecord(
            currentItem,
            publishedItem,
            itemType,
            traversalSchema,
            schedules.get(recordId) ?? {
              publication: null,
              unpublishing: null,
            },
          ),
        ];
      }),
  );

  for (const publishedId of Object.keys(publishedById)) {
    if (!(publishedId in currentById)) {
      throw new ContentDiffError(
        'UNSUPPORTED_CONTENT_STATE',
        `Published record ${publishedId} has no current version.`,
      );
    }
  }

  const blockOwnership = buildBlockOwnershipIndex(records, traversalSchema);
  const uploadReferencesByRecord = Object.fromEntries(
    Object.values(records).map((record) => [
      record.id,
      collectUploadReferences(record, traversalSchema),
    ]),
  );
  const referencedUploadIds = new Set(
    Object.values(uploadReferencesByRecord).flat(),
  );
  const allUploads = await listUploads(client);
  const selectedUploads = allUploads.filter(
    (upload) =>
      uploadsMode === 'all' ||
      referencedUploadIds.has(requiredItemId(upload)) ||
      baselineUploadIds.has(requiredItemId(upload)),
  );
  const foundUploadIds = new Set(selectedUploads.map(requiredItemId));

  const missingUploadReferences = Object.fromEntries(
    Object.entries(uploadReferencesByRecord)
      .map(
        ([recordId, uploadIds]) =>
          [
            recordId,
            uploadIds
              .filter((uploadId) => !foundUploadIds.has(uploadId))
              .sort(),
          ] as const,
      )
      .filter(([, uploadIds]) => uploadIds.length > 0),
  );

  const uploads: Record<string, UploadSnapshot> = Object.fromEntries(
    selectedUploads
      .map((upload) => canonicalizeUpload(upload, scopedSchema.locales))
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((upload) => [upload.id, upload]),
  );
  const allCollections = (await client.uploadCollections.list()).map(
    canonicalizeUploadCollection,
  );
  const visibleBaselineCollectionIds = new Set(
    [...baselineCollectionIds].filter((id) =>
      allCollections.some((collection) => collection.id === id),
    ),
  );
  const uploadCollections = allUploadCollections
    ? Object.fromEntries(
        allCollections
          .sort((left, right) => compareStrings(left.id, right.id))
          .map((collection) => [collection.id, collection]),
      )
    : selectCollectionClosure(
        allCollections,
        uploads,
        visibleBaselineCollectionIds,
      );
  const visibleRecordIds = await listVisibleRecordIds(
    client,
    fullSchema,
    migrationsModelApiKey,
    contentDiffModelApiKey,
  );
  const capturedAt = new Date().toISOString();
  const snapshot: ContentSnapshot = {
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    siteId: scopedSchema.siteId,
    environmentId,
    capturedAt,
    schema: scopedSchema,
    scope: {
      itemTypeIds: selectedItemTypes.map(({ id }) => id).sort(),
      uploads: uploadsMode,
    },
    readItemTypes: readItemTypesForPermissionProof(
      fullSchema,
      migrationsModelApiKey,
      contentDiffModelApiKey,
    ),
    records,
    uploads,
    uploadCollections,
    visibleRecordIds,
    blockOwnership,
    inspection,
    missingUploadReferences,
    digest: '',
  };

  snapshot.digest = semanticHash(snapshotSemanticState(snapshot));

  return {
    snapshot,
    marker: consistencyMarker(
      currentItems,
      publishedItems,
      visibleRecordIds,
      selectedUploads,
      Object.values(uploadCollections),
      schedules,
      scopedSchema.locales,
    ),
  };
}

function readItemTypesForPermissionProof(
  schema: SchemaSnapshot,
  migrationsModelApiKey: string | undefined,
  contentDiffModelApiKey: string,
): ContentSnapshot['readItemTypes'] {
  const migrationsModelId = migrationsTrackingModelId(
    schema,
    migrationsModelApiKey,
  );
  return schema.itemTypes
    .filter(
      ({ id, modularBlock, apiKey }) =>
        !modularBlock &&
        id !== migrationsModelId &&
        apiKey !== contentDiffModelApiKey,
    )
    .map(({ id, workflowId }) => ({ id, workflowId }))
    .sort((left, right) => compareStrings(left.id, right.id));
}

async function captureConsistencyMarker(
  client: CmaClient.Client,
  fullSchema: SchemaSnapshot,
  selectedItemTypes: ItemTypeSchemaSnapshot[],
  uploadsMode: 'referenced' | 'all',
  selectedUploadIds: ReadonlySet<string>,
  selectedCollectionIds: ReadonlySet<string>,
  allUploadCollections: boolean,
  scheduleAdapter: ScheduleAdapter,
  localeOrder: readonly string[],
  migrationsModelApiKey: string | undefined,
  contentDiffModelApiKey: string,
): Promise<string> {
  const [
    currentItems,
    publishedItems,
    visibleRecordIds,
    allUploads,
    collections,
  ] = await Promise.all([
    listItems(client, selectedItemTypes, 'current', false),
    listItems(client, selectedItemTypes, 'published', false),
    listVisibleRecordIds(
      client,
      fullSchema,
      migrationsModelApiKey,
      contentDiffModelApiKey,
    ),
    listUploads(client),
    client.uploadCollections.list(),
  ]);
  const uploads = allUploads.filter(
    (upload) =>
      uploadsMode === 'all' || selectedUploadIds.has(requiredItemId(upload)),
  );
  const selectedCollections = collections
    .map(canonicalizeUploadCollection)
    .filter(({ id }) => allUploadCollections || selectedCollectionIds.has(id));
  const scheduledItems = currentItems.filter(hasScheduleMarker);
  const scheduleValues = await mapWithConcurrency(
    scheduledItems,
    READ_CONCURRENCY,
    async (item) => scheduleAdapter.read(client, requiredItemId(item)),
  );
  const schedules = new Map<string, RecordScheduleSnapshot>();
  scheduledItems.forEach((item, index) => {
    schedules.set(requiredItemId(item), scheduleValues[index]);
  });

  return consistencyMarker(
    currentItems,
    publishedItems,
    visibleRecordIds,
    uploads,
    selectedCollections,
    schedules,
    localeOrder,
  );
}

function consistencyMarker(
  currentItems: unknown[],
  publishedItems: unknown[],
  visibleRecordIds: string[],
  uploads: unknown[],
  collections: UploadCollectionSnapshot[],
  schedules: ReadonlyMap<string, RecordScheduleSnapshot>,
  localeOrder: readonly string[],
): string {
  return semanticHash({
    current: currentItems.map(itemConsistency).sort(compareById),
    published: publishedItems.map(itemConsistency).sort(compareById),
    visibleRecordIds,
    uploads: uploads.map(uploadConsistency).sort(compareById),
    collections: collections
      .map(({ id, hash }) => ({ id, hash }))
      .sort(compareById),
    schedules: [...schedules]
      .map(([id, value]) => ({
        id,
        value: canonicalizeSchedules(value, localeOrder),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
  });
}

async function listItems(
  client: CmaClient.Client,
  itemTypes: ItemTypeSchemaSnapshot[],
  version: 'current' | 'published',
  nested: boolean,
): Promise<unknown[]> {
  const result: unknown[] = [];

  for (const itemType of itemTypes) {
    const iterator = client.items.listPagedIterator(
      {
        filter: { type: itemType.id },
        nested,
        order_by: 'id_ASC' as never,
        version,
      } as never,
      {
        perPage: nested
          ? RECORD_PAGE_SIZE_WITH_NESTED_BLOCKS
          : COLLECTION_PAGE_SIZE,
        concurrency: READ_CONCURRENCY,
      },
    );

    for await (const item of iterator) {
      result.push(item);
    }
  }

  return result.sort((left, right) =>
    compareStrings(requiredItemId(left), requiredItemId(right)),
  );
}

async function listUploads(client: CmaClient.Client): Promise<unknown[]> {
  const result: unknown[] = [];
  const iterator = client.uploads.listPagedIterator(
    { order_by: 'id_ASC' },
    { perPage: COLLECTION_PAGE_SIZE, concurrency: READ_CONCURRENCY },
  );

  for await (const upload of iterator) {
    result.push(upload);
  }

  return result.sort((left, right) =>
    compareStrings(requiredItemId(left), requiredItemId(right)),
  );
}

async function listVisibleRecordIds(
  client: CmaClient.Client,
  schema: SchemaSnapshot,
  migrationsModelApiKey: string | undefined,
  contentDiffModelApiKey: string,
): Promise<string[]> {
  const migrationsModelId = migrationsTrackingModelId(
    schema,
    migrationsModelApiKey,
  );
  const regularItemTypes = schema.itemTypes.filter(
    ({ id, modularBlock, apiKey }) =>
      !modularBlock &&
      id !== migrationsModelId &&
      apiKey !== contentDiffModelApiKey,
  );
  const items = await listItems(client, regularItemTypes, 'current', false);

  return items.map(requiredItemId).sort();
}

function selectCollectionClosure(
  collections: UploadCollectionSnapshot[],
  uploads: Record<string, UploadSnapshot>,
  additionalCollectionIds: ReadonlySet<string> = new Set(),
): Record<string, UploadCollectionSnapshot> {
  const byId = new Map(
    collections.map((collection) => [collection.id, collection]),
  );
  const selected = new Set([
    ...Object.values(uploads)
      .map(({ manual }) => manual.collectionId)
      .filter((id): id is string => Boolean(id)),
    ...additionalCollectionIds,
  ]);

  for (const id of [...selected]) {
    let current = byId.get(id);

    if (!current) {
      throw new ContentDiffError(
        'UNSUPPORTED_CONTENT_STATE',
        `Upload collection ${id} is referenced but not visible.`,
      );
    }

    while (current.parentId) {
      selected.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent) {
        throw new ContentDiffError(
          'UNSUPPORTED_CONTENT_STATE',
          `Upload collection ${current.id} has missing parent ${current.parentId}.`,
        );
      }
      current = parent;
    }
  }

  return Object.fromEntries(
    collections
      .filter(({ id }) => selected.has(id))
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((collection) => [collection.id, collection]),
  );
}

function itemConsistency(input: unknown): JsonObject {
  const item = assertObject(input);
  const meta = isObject(item.meta) ? item.meta : {};

  return {
    id: requiredItemId(input),
    itemTypeId: itemTypeIdOf(input),
    currentVersion: stringOrNull(meta.current_version),
    updatedAt: stringOrNull(meta.updated_at),
    publishedAt: stringOrNull(meta.published_at),
    publicationScheduledAt: stringOrNull(meta.publication_scheduled_at),
    unpublishingScheduledAt: stringOrNull(meta.unpublishing_scheduled_at),
    stage: stringOrNull(meta.stage),
    parentId: stringOrNull(item.parent_id),
    position: typeof item.position === 'number' ? item.position : null,
    isValid: booleanOrNull(meta.is_valid),
    isCurrentVersionValid: booleanOrNull(meta.is_current_version_valid),
    isPublishedVersionValid: booleanOrNull(meta.is_published_version_valid),
  };
}

function uploadConsistency(input: unknown): JsonObject {
  const upload = assertObject(input);

  return {
    id: requiredItemId(input),
    md5: stringOrNull(upload.md5),
    updatedAt: stringOrNull(upload.updated_at),
  };
}

function indexItems(items: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const item of items) {
    const id = requiredItemId(item);
    if (id in result) {
      throw new ContentDiffError(
        'DUPLICATE_ENTITY_ID',
        `The CMA returned duplicate record ID ${id}.`,
        { recordId: id },
      );
    }
    result[id] = item;
  }

  return result;
}

function hasScheduleMarker(input: unknown): boolean {
  const item = assertObject(input);
  const meta = isObject(item.meta) ? item.meta : {};

  return Boolean(
    meta.publication_scheduled_at || meta.unpublishing_scheduled_at,
  );
}

function itemTypeIdOf(input: unknown): string {
  const item = assertObject(input);

  if (typeof item.__itemTypeId === 'string') return item.__itemTypeId;
  if (isObject(item.item_type) && typeof item.item_type.id === 'string') {
    return item.item_type.id;
  }

  throw new ContentDiffError(
    'UNSUPPORTED_CONTENT_STATE',
    `Record ${requiredItemId(input)} has no item type relationship.`,
  );
}

function requiredItemId(value: unknown): string {
  const resource = assertObject(value);
  if (typeof resource.id !== 'string') {
    throw new ContentDiffError(
      'UNSUPPORTED_CONTENT_STATE',
      'The CMA returned a resource without an ID.',
    );
  }
  return resource.id;
}

function assertObject(value: unknown): JsonObjectLike {
  if (!isObject(value)) {
    throw new ContentDiffError(
      'UNSUPPORTED_CONTENT_STATE',
      'The CMA returned a malformed resource.',
    );
  }
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function compareById(left: JsonObject, right: JsonObject): number {
  return compareStrings(String(left.id), String(right.id));
}

type JsonObjectLike = Record<string, any>;
