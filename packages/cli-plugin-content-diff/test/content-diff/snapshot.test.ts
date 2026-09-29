import type { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import {
  computeSchemaDigest,
  fetchSchemaSnapshot,
} from '../../src/content-diff/schema';
import {
  captureContentSnapshot,
  readScheduleDetails,
} from '../../src/content-diff/snapshot';
import type {
  RecordScheduleSnapshot,
  ScheduleAdapter,
  SchemaSnapshot,
} from '../../src/content-diff/types';
import { ContentDiffError } from '../../src/content-diff/types';

const MODEL_ID = 'model-id';

describe('content snapshot capture', () => {
  it('captures identical schemas, snapshots, and plans under English and Turkish collation', async () => {
    const schema = makeSchema('source');
    const upperId = 'IhEa5SbeSl6KwIFizzkzig';
    const lowerId = 'ihEa5SbeSl6KwIFizzkzig';
    schema.itemTypes = [
      { ...schema.itemTypes[0], id: upperId, apiKey: 'upper_article' },
      { ...schema.itemTypes[0], id: lowerId, apiKey: 'lower_article' },
    ];
    const client = makeSnapshotClient({
      records: [],
      uploads: [],
      schema,
      calls: [],
      itemTypesForCall: () => [
        makeRawItemType(upperId, 'upper_article'),
        makeRawItemType(lowerId, 'lower_article'),
      ],
    });
    const compare = String.prototype.localeCompare;
    const snapshots = [];
    const plans = [];
    try {
      for (const locale of ['en', 'tr']) {
        String.prototype.localeCompare = function (other: string) {
          return compare.call(this, other, locale);
        };
        const fetchedSchema = await fetchSchemaSnapshot(client, 'source');
        const snapshot = await captureContentSnapshot({
          client,
          environmentId: 'source',
          schema: fetchedSchema,
          scope: { itemTypes: 'all', uploads: 'referenced' },
          fullAccessVerified: true,
        });
        snapshot.capturedAt = '2026-01-01T00:00:00.000Z';
        snapshots.push(snapshot);
        const target = {
          ...snapshot,
          environmentId: 'target',
          schema: { ...snapshot.schema, environmentId: 'target' },
        };
        const plan = buildContentDiffPlan(snapshot, target, {
          includeDeletions: false,
          uploads: 'referenced',
        });
        plans.push(plan);
      }
    } finally {
      String.prototype.localeCompare = compare;
    }

    expect(snapshots[0]).to.deep.equal(snapshots[1]);
    expect(plans[0]).to.deep.equal(plans[1]);
  });

  it('uses nested record pages of 30, upload pages of 500, and five concurrent schedule reads', async () => {
    const records = Array.from({ length: 31 }, (_, index) =>
      makeRecord(`record-${String(index).padStart(3, '0')}`, 'stable'),
    );
    const uploads = Array.from({ length: 501 }, (_, index) =>
      makeUpload(`upload-${String(index).padStart(3, '0')}`),
    );
    const schema = makeSchema('source');
    const calls: IteratorCall[] = [];
    let activeScheduleReads = 0;
    let maximumScheduleReads = 0;
    let scheduleReadCount = 0;
    const scheduleReadArguments: unknown[][] = [];
    const scheduleAdapter: ScheduleAdapter = {
      read: async (
        ...args: Parameters<ScheduleAdapter['read']>
      ): Promise<RecordScheduleSnapshot> => {
        scheduleReadArguments.push(args);
        scheduleReadCount += 1;
        activeScheduleReads += 1;
        maximumScheduleReads = Math.max(
          maximumScheduleReads,
          activeScheduleReads,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeScheduleReads -= 1;

        return {
          publication: {
            at: '2035-01-01T01:00:00+01:00',
            selective: {
              locales: ['it', 'en', 'it'],
              nonLocalized: true,
            },
          },
          unpublishing: null,
        };
      },
    };
    const client = makeSnapshotClient({ records, uploads, schema, calls });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'source',
      schema,
      scope: { itemTypes: 'all', uploads: 'all' },
      fullAccessVerified: true,
      scheduleAdapter,
    });

    expect(Object.keys(snapshot.records)).to.have.length(31);
    expect(Object.keys(snapshot.uploads)).to.have.length(501);
    expect(scheduleReadCount).to.equal(62);
    expect(maximumScheduleReads).to.equal(5);
    for (const args of scheduleReadArguments) {
      expect(args).to.have.length(2);
      expect(args[0]).to.equal(client);
    }
    expect(
      [
        ...new Set(scheduleReadArguments.map(([, recordId]) => recordId)),
      ].sort(),
    ).to.deep.equal(Object.keys(snapshot.records).sort());
    expect(snapshot.records['record-000'].schedules.publication).to.deep.equal({
      at: '2035-01-01T00:00:00.000Z',
      selective: { locales: ['en', 'it'], nonLocalized: true },
    });

    const nestedRecordCalls = calls.filter(
      ({ resource, query }) => resource === 'items' && query.nested === true,
    );
    expect(nestedRecordCalls).to.have.length(2);
    for (const call of nestedRecordCalls) {
      expect(call.page).to.deep.equal({ perPage: 30, concurrency: 5 });
      expect(call.query.order_by).to.equal('id_ASC');
    }

    const uploadCalls = calls.filter(({ resource }) => resource === 'uploads');
    expect(uploadCalls).to.have.length(2);
    for (const call of uploadCalls) {
      expect(call.page).to.deep.equal({ perPage: 500, concurrency: 5 });
      expect(call.query.order_by).to.equal('id_ASC');
    }
  });

  it('retries a full snapshot when its lightweight verification observes a mutation', async () => {
    const schema = makeSchema('source');
    let nestedCurrentReads = 0;
    const calls: IteratorCall[] = [];
    const client = makeSnapshotClient({
      records: [],
      uploads: [],
      schema,
      calls,
      recordsForCall(query) {
        if (query.version === 'published') return [];
        if (query.nested === true) {
          nestedCurrentReads += 1;
          return [
            makeRecord(
              'record-retried',
              nestedCurrentReads === 1 ? 'old' : 'new',
              false,
            ),
          ];
        }

        return [makeRecord('record-retried', 'new', false)];
      },
    });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'source',
      schema,
      scope: { itemTypes: 'all', uploads: 'referenced' },
      fullAccessVerified: true,
      maxAttempts: 3,
    });

    expect(nestedCurrentReads).to.equal(2);
    expect(
      snapshot.records['record-retried'].consistency.currentVersion,
    ).to.equal('version-new');
    expect(snapshot.records['record-retried'].current.fields.title).to.equal(
      'title-new',
    );
  });

  it('fails closed when the model scope changes after full access was proven', async () => {
    const schema = makeSchema('source');
    let schemaReads = 0;
    const client = makeSnapshotClient({
      records: [],
      uploads: [],
      schema,
      calls: [],
      itemTypesForCall() {
        schemaReads += 1;

        return [
          makeRawItemType(MODEL_ID, 'article'),
          makeRawItemType('new-out-of-scope-model', 'new_out_of_scope_model'),
        ];
      },
    });

    const error = await expectRejects(
      captureContentSnapshot({
        client,
        environmentId: 'source',
        schema,
        scope: { itemTypes: ['article'], uploads: 'referenced' },
        fullAccessVerified: true,
        maxAttempts: 3,
      }),
    );

    expect(schemaReads).to.equal(3);
    expect(error).to.be.instanceOf(ContentDiffError);
    expect((error as ContentDiffError).code).to.equal(
      'CONCURRENT_SNAPSHOT_CHANGE',
    );
  });

  it('fails without returning a mixed snapshot after every retry changes', async () => {
    const schema = makeSchema('source');
    let nestedCurrentReads = 0;
    const client = makeSnapshotClient({
      records: [],
      uploads: [],
      schema,
      calls: [],
      recordsForCall(query) {
        if (query.version === 'published') return [];
        if (query.nested === true) {
          nestedCurrentReads += 1;
          return [
            makeRecord(
              'record-changing',
              `capture-${nestedCurrentReads}`,
              false,
            ),
          ];
        }

        return [makeRecord('record-changing', 'verification', false)];
      },
    });

    const error = await expectRejects(
      captureContentSnapshot({
        client,
        environmentId: 'source',
        schema,
        scope: { itemTypes: 'all', uploads: 'referenced' },
        fullAccessVerified: true,
        maxAttempts: 2,
      }),
    );

    expect(error).to.be.instanceOf(ContentDiffError);
    expect((error as ContentDiffError).code).to.equal(
      'CONCURRENT_SNAPSHOT_CHANGE',
    );
    expect((error as ContentDiffError).details).to.deep.equal({
      environmentId: 'source',
      attempts: 2,
    });
    expect(nestedCurrentReads).to.equal(2);
  });

  it('includes requested baseline uploads and collections even when they are unreferenced', async () => {
    const schema = makeSchema('target');
    const collection = makeUploadCollection('collection-existing');
    const upload = makeUpload('upload-existing', collection.id);
    const client = makeSnapshotClient({
      records: [],
      uploads: [upload],
      collections: [collection],
      schema,
      calls: [],
    });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'target',
      schema,
      scope: {
        itemTypes: 'all',
        uploads: 'referenced',
        baselineUploadIds: ['upload-existing', 'upload-missing'],
        baselineUploadCollectionIds: [
          'collection-existing',
          'collection-missing',
        ],
      },
      fullAccessVerified: true,
    });

    expect(Object.keys(snapshot.uploads)).to.deep.equal(['upload-existing']);
    expect(Object.keys(snapshot.uploadCollections)).to.deep.equal([
      'collection-existing',
    ]);
  });

  it('retries when a requested baseline asset appears between the two passes', async () => {
    const schema = makeSchema('target');
    const collection = makeUploadCollection('collection-late');
    const upload = makeUpload('upload-late', collection.id);
    let uploadReads = 0;
    let collectionReads = 0;
    const client = makeSnapshotClient({
      records: [],
      uploads: [],
      collections: [],
      schema,
      calls: [],
      uploadsForCall() {
        uploadReads += 1;
        return uploadReads === 1 ? [] : [upload];
      },
      collectionsForCall() {
        collectionReads += 1;
        return collectionReads === 1 ? [] : [collection];
      },
    });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'target',
      schema,
      scope: {
        itemTypes: 'all',
        uploads: 'referenced',
        baselineUploadIds: [upload.id],
        baselineUploadCollectionIds: [collection.id],
      },
      fullAccessVerified: true,
    });

    expect(uploadReads).to.equal(4);
    expect(collectionReads).to.equal(4);
    expect(Object.keys(snapshot.uploads)).to.deep.equal([upload.id]);
    expect(Object.keys(snapshot.uploadCollections)).to.deep.equal([
      collection.id,
    ]);
  });

  it('retries when a collection is added while capturing full destination occupancy', async () => {
    const schema = makeSchema('target');
    const existing = makeUploadCollection('collection-existing');
    const added = makeUploadCollection('collection-added');
    let collectionReads = 0;
    const client = makeSnapshotClient({
      records: [],
      uploads: [],
      schema,
      calls: [],
      collectionsForCall() {
        collectionReads += 1;
        return collectionReads === 1 ? [existing] : [existing, added];
      },
    });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'target',
      schema,
      scope: {
        itemTypes: 'all',
        uploads: 'referenced',
        allUploadCollections: true,
      },
      fullAccessVerified: true,
    });

    expect(collectionReads).to.equal(4);
    expect(Object.keys(snapshot.uploadCollections)).to.have.members([
      existing.id,
      added.id,
    ]);
  });

  it('retries when a missing referenced upload appears between the two passes', async () => {
    const schema = makeSchema('source');
    schema.itemTypes[0].fields.push({
      id: 'image-field',
      apiKey: 'image',
      fieldType: 'file',
      localized: false,
      position: 2,
      validators: {},
    });
    schema.digest = computeSchemaDigest(schema);
    const upload = makeUpload('upload-late');
    const record = {
      ...makeRecord('record-references-upload', 'stable', false),
      image: { upload_id: upload.id, alt: null, title: null, custom_data: {} },
    };
    let uploadReads = 0;
    const client = makeSnapshotClient({
      records: [record],
      uploads: [],
      schema,
      calls: [],
      uploadsForCall() {
        uploadReads += 1;
        return uploadReads === 1 ? [] : [upload];
      },
    });

    const snapshot = await captureContentSnapshot({
      client,
      environmentId: 'source',
      schema,
      scope: { itemTypes: 'all', uploads: 'referenced' },
      fullAccessVerified: true,
    });

    expect(uploadReads).to.equal(4);
    expect(Object.keys(snapshot.uploads)).to.deep.equal([upload.id]);
    expect(snapshot.missingUploadReferences).to.deep.equal({});
  });
});

describe('current-vs-published schedule adapter contract', () => {
  it('accepts explicitly absent schedules but rejects missing or malformed relationships', async () => {
    const read = (relationships: unknown) =>
      readScheduleDetails(
        {
          items: {
            rawCurrentVsPublishedState: async () => ({
              data: { id: 'record-with-schedules', relationships },
              included: [],
            }),
          },
        } as unknown as CmaClient.Client,
        'record-with-schedules',
      );

    expect(
      await read({
        scheduled_publication: { data: null },
        scheduled_unpublishing: { data: null },
      }),
    ).to.deep.equal({ publication: null, unpublishing: null });

    for (const key of ['scheduled_publication', 'scheduled_unpublishing']) {
      for (const relationship of [
        undefined,
        null,
        {},
        { data: undefined },
        { data: [] },
        { data: 'missing-resource' },
        { data: { id: '', type: key } },
        { data: { id: 'schedule-id', type: 'unexpected-resource' } },
      ]) {
        const error = await expectRejects(
          read({
            scheduled_publication: { data: null },
            scheduled_unpublishing: { data: null },
            [key]: relationship,
          }),
        );
        expect(error).to.be.instanceOf(ContentDiffError);
        expect((error as ContentDiffError).code).to.equal(
          'SCHEDULE_CONTRACT_CHANGED',
        );
      }
    }
  });

  it('reads publication and unpublishing scopes from included resources', async () => {
    const client = {
      items: {
        rawCurrentVsPublishedState: async () => ({
          data: {
            id: 'record-with-schedules',
            relationships: {
              scheduled_publication: {
                data: { id: 'publication-1', type: 'scheduled_publication' },
              },
              scheduled_unpublishing: {
                data: {
                  id: 'unpublishing-1',
                  type: 'scheduled_unpublishing',
                },
              },
            },
          },
          included: [
            {
              id: 'publication-1',
              type: 'scheduled_publication',
              attributes: {
                publication_scheduled_at: '2035-01-01T12:00:00Z',
                selective_publication: {
                  content_in_locales: ['it'],
                  non_localized_content: true,
                },
              },
            },
            {
              id: 'unpublishing-1',
              type: 'scheduled_unpublishing',
              attributes: {
                unpublishing_scheduled_at: '2035-01-02T12:00:00Z',
                content_in_locales: ['en', 'it'],
              },
            },
          ],
        }),
      },
    } as unknown as CmaClient.Client;

    expect(
      await readScheduleDetails(client, 'record-with-schedules'),
    ).to.deep.equal({
      publication: {
        at: '2035-01-01T12:00:00Z',
        selective: { locales: ['it'], nonLocalized: true },
      },
      unpublishing: {
        at: '2035-01-02T12:00:00Z',
        locales: ['en', 'it'],
      },
    });
  });

  it('fails closed when a related schedule body is absent or malformed', async () => {
    const client = {
      items: {
        rawCurrentVsPublishedState: async () => ({
          data: {
            id: 'record-with-schedule',
            relationships: {
              scheduled_publication: {
                data: { id: 'publication-1', type: 'scheduled_publication' },
              },
            },
          },
          included: [],
        }),
      },
    } as unknown as CmaClient.Client;

    const error = await expectRejects(
      readScheduleDetails(client, 'record-with-schedule'),
    );

    expect(error).to.be.instanceOf(ContentDiffError);
    expect((error as ContentDiffError).code).to.equal(
      'SCHEDULE_CONTRACT_CHANGED',
    );
    expect(error.message).to.contain('private current-vs-published response');
  });
});

interface IteratorCall {
  resource: 'items' | 'uploads';
  query: Record<string, any>;
  page: Record<string, any>;
}

interface SnapshotClientOptions {
  records: unknown[];
  uploads: unknown[];
  collections?: unknown[];
  schema: SchemaSnapshot;
  calls: IteratorCall[];
  recordsForCall?: (query: Record<string, any>) => unknown[];
  uploadsForCall?: () => unknown[];
  collectionsForCall?: () => unknown[];
  itemTypesForCall?: () => unknown[];
}

function makeSnapshotClient({
  records,
  uploads,
  collections = [],
  schema,
  calls,
  recordsForCall,
  uploadsForCall,
  collectionsForCall,
  itemTypesForCall,
}: SnapshotClientOptions): CmaClient.Client {
  return {
    site: {
      find: async () => ({
        id: schema.siteId,
        locales: ['en', 'it'],
        timezone: 'UTC',
        meta: {
          improved_timezone_management: true,
          improved_boolean_fields: true,
          improved_validation_at_publishing: true,
          milliseconds_in_datetime: true,
          non_localized_focal_points: true,
          improved_hex_management: true,
        },
      }),
    },
    itemTypes: {
      list: async () =>
        itemTypesForCall
          ? itemTypesForCall()
          : [makeRawItemType(MODEL_ID, 'article')],
    },
    fields: {
      list: async (itemTypeId: string) =>
        (
          schema.itemTypes.find(({ id }) => id === itemTypeId)?.fields ?? []
        ).map((field) => ({
          id: field.id,
          api_key: field.apiKey,
          field_type: field.fieldType,
          localized: field.localized,
          position: field.position,
          validators: field.validators,
          default_value: field.defaultValue,
        })),
    },
    workflows: { list: async () => [] },
    items: {
      listPagedIterator(query: Record<string, any>, page: Record<string, any>) {
        calls.push({ resource: 'items', query, page });
        const values = recordsForCall
          ? recordsForCall(query)
          : query.version === 'published'
            ? []
            : records;
        return iterate(values);
      },
    },
    uploads: {
      listPagedIterator(query: Record<string, any>, page: Record<string, any>) {
        calls.push({ resource: 'uploads', query, page });
        return iterate(uploadsForCall ? uploadsForCall() : uploads);
      },
    },
    uploadCollections: {
      list: async () =>
        collectionsForCall ? collectionsForCall() : collections,
    },
  } as unknown as CmaClient.Client;
}

function makeRawItemType(id: string, apiKey: string): Record<string, any> {
  return {
    id,
    api_key: apiKey,
    name: apiKey,
    modular_block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draft_mode_active: true,
    draft_saving_active: true,
    all_locales_required: false,
    workflow: null,
  };
}

function makeSchema(environmentId: string): SchemaSnapshot {
  const schema: SchemaSnapshot = {
    siteId: 'site-id',
    environmentId,
    locales: ['en', 'it'],
    environmentSemantics: {
      timezone: 'UTC',
      improvedTimezoneManagement: true,
      improvedBooleanFields: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    },
    itemTypes: [
      {
        id: MODEL_ID,
        apiKey: 'article',
        name: 'Article',
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
            id: 'title-field',
            apiKey: 'title',
            fieldType: 'string',
            localized: false,
            position: 1,
            validators: {},
          },
        ],
      },
    ],
    workflows: [],
    digest: '',
  };
  schema.digest = computeSchemaDigest(schema);
  return schema;
}

function makeRecord(
  id: string,
  marker: string,
  scheduled = true,
): Record<string, any> {
  return {
    id,
    type: 'item',
    item_type: { id: MODEL_ID, type: 'item_type' },
    title: `title-${marker}`,
    meta: {
      created_at: '2025-01-01T00:00:00Z',
      first_published_at: null,
      current_version: `version-${marker}`,
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: true,
      updated_at: `2025-01-01T00:00:${marker === 'stable' ? '00' : '01'}Z`,
      published_at: null,
      publication_scheduled_at: scheduled ? '2035-01-01T00:00:00Z' : null,
      unpublishing_scheduled_at: null,
      stage: null,
    },
  };
}

function makeUpload(
  id: string,
  collectionId: string | null = null,
): Record<string, any> {
  return {
    id,
    md5: '900150983cd24fb0d6963f7d28e17f72',
    basename: `${id}.txt`,
    filename: `${id}.txt`,
    url: `https://example.test/${id}.txt`,
    size: 3,
    mime_type: 'text/plain',
    tags: [],
    upload_collection: collectionId
      ? { id: collectionId, type: 'upload_collection' }
      : null,
    updated_at: '2025-01-01T00:00:00Z',
    meta: { antivirus: { status: 'clean' } },
  };
}

function makeUploadCollection(id: string): Record<string, any> {
  return {
    id,
    label: id,
    parent: null,
    position: 1,
  };
}

async function* iterate(values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
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
