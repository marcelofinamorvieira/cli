import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  canonicalizeJson,
  canonicalizeRecord,
  canonicalizeUpload,
  canonicalizeUploadCollection,
} from '../../src/content-diff/canonicalize';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import {
  ContentDiffError,
  type FieldSchemaSnapshot,
  type ItemTypeSchemaSnapshot,
  type JsonObject,
  type RecordScheduleSnapshot,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

type RuntimeError = Error & { code: string; details: unknown };

interface RuntimeCanonicalize {
  __canonicalizeRecord(
    current: unknown,
    published: unknown,
    itemType: unknown,
    schema: unknown,
    schedules: unknown,
  ): Record<string, any>;
  __canonicalizeUploadState(
    upload: unknown,
    locales: readonly string[],
  ): Record<string, any>;
  __canonicalizeUploadCollection(collection: unknown): Record<string, any>;
  __declaresCanonicalizeUpload: boolean;
  __recordValidityFromCurrentResource(current: unknown): unknown;
}

const RECORD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const OWNER_MODEL = '4QI3BfBvQs-hcv_YEkk1wg';
const BLOCK_MODEL = 'LkT6QfLoRXmEO7nLt6x0uA';
const BLOCK_ID = 'X4h0kJ7xQy2oO3UscO9V6Q';
const INNER_BLOCK_ID = 'LQQiCYCfSU6DTmCQ63-JRw';
const UPLOAD_ID = 'upload-1';
const NO_SCHEDULES: RecordScheduleSnapshot = {
  publication: null,
  unpublishing: null,
};

function field(
  apiKey: string,
  fieldType: FieldSchemaSnapshot['fieldType'],
  localized = false,
  position = 1,
  id = `field-${apiKey}`,
): FieldSchemaSnapshot {
  return { id, apiKey, fieldType, localized, position, validators: {} };
}

function itemType(
  id: string,
  modularBlock: boolean,
  fields: FieldSchemaSnapshot[],
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey: `model_${id}`,
    name: id,
    modularBlock,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: false,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}

/** An owner with localized text and blocks, and a block that nests again. */
function makeSchema(
  ownerFields: FieldSchemaSnapshot[] = [
    field('title', 'string', true, 1),
    field('content', 'rich_text', true, 2),
  ],
): SchemaSnapshot {
  return {
    siteId: 'site',
    environmentId: 'main',
    locales: ['en', 'it'],
    itemTypes: [
      itemType(OWNER_MODEL, false, ownerFields),
      itemType(BLOCK_MODEL, true, [
        field('caption', 'string'),
        field('children', 'rich_text', false, 2),
      ]),
    ],
    workflows: [],
    digest: 'schema-digest',
  } as unknown as SchemaSnapshot;
}

function owner(schema: SchemaSnapshot): ItemTypeSchemaSnapshot {
  return schema.itemTypes.find(({ id }) => id === OWNER_MODEL)!;
}

function block(id: string, attributes: JsonObject): JsonObject {
  return {
    id,
    type: 'item',
    attributes,
    relationships: {
      item_type: { data: { id: BLOCK_MODEL, type: 'item_type' } },
    },
  };
}

/** A flat CMA record resource, as `items.find(..., { nested: true })` returns. */
function cmaRecord(
  fields: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Record<string, any> {
  return {
    id: RECORD_ID,
    type: 'item',
    item_type: { id: OWNER_MODEL, type: 'item_type' },
    ...fields,
    meta: {
      created_at: '2025-01-01T01:00:00+01:00',
      updated_at: '2025-01-01T00:00:00.000Z',
      published_at: null,
      first_published_at: null,
      current_version: 'version-1',
      stage: null,
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: null,
      ...meta,
    },
  };
}

function cmaUpload(
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  return {
    id: UPLOAD_ID,
    type: 'upload',
    md5: 'd41d8cd98f00b204e9800998ecf8427e',
    basename: 'asset',
    filename: 'asset.png',
    size: 1,
    mime_type: 'image/png',
    author: null,
    copyright: null,
    notes: null,
    default_field_metadata: {
      alt: { it: 'alt it', en: 'alt en' },
      title: { en: null },
      custom_data: {},
      focal_point: { y: 0.5, x: 0.25 },
    },
    tags: ['b', 'a', 'b'],
    upload_collection: null,
    url: 'https://assets.example/asset.png',
    updated_at: null,
    meta: { antivirus: { status: 'clean' } },
    ...overrides,
  };
}

function captureError(task: () => unknown): Error {
  try {
    task();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to throw.');
}

function expectPlannerFailure(
  task: () => unknown,
  code: string,
  message: string,
  details?: unknown,
): void {
  const error = captureError(task) as ContentDiffError;
  expect(error).to.be.instanceOf(ContentDiffError);
  expect(error.code).to.equal(code);
  expect(error.message).to.equal(message);
  expect(error.details).to.deep.equal(details);
}

function expectRuntimeFailure(
  task: () => unknown,
  code: string,
  message: string,
  details: unknown = null,
): void {
  const error = captureError(task) as RuntimeError;
  expect(error.name).to.equal('ContentDiffRuntimeError');
  expect(error.code).to.equal(code);
  expect(error.message).to.equal(message);
  expect(error.details).to.deep.equal(details);
}

describe('shared record, upload, collection and schedule canonicalization', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimeCanonicalize;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-shared-canon-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        'module.exports.__canonicalizeRecord = canonicalizeRecord;',
        'module.exports.__canonicalizeUploadState = canonicalizeUploadState;',
        'module.exports.__canonicalizeUploadCollection = canonicalizeUploadCollection;',
        "module.exports.__declaresCanonicalizeUpload = typeof canonicalizeUpload !== 'undefined';",
        'module.exports.__recordValidityFromCurrentResource = recordValidityFromCurrentResource;',
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimeCanonicalize;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  /** Canonicalizes on both sides and requires one identical snapshot. */
  function bothSides(
    current: unknown,
    published: unknown,
    schema: SchemaSnapshot,
    model = owner(schema),
  ): Record<string, any> {
    const planner = canonicalizeRecord(
      structuredClone(current),
      structuredClone(published) as unknown,
      model,
      schema,
      NO_SCHEDULES,
    );
    const executed = runtime.__canonicalizeRecord(
      structuredClone(current),
      structuredClone(published),
      model,
      schema,
      NO_SCHEDULES,
    );
    expect(JSON.stringify(executed)).to.equal(JSON.stringify(planner));
    return planner;
  }

  it('is the canonicalization code the generated runtime runs', () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include(
      'src/content-diff/shared/canonicalize.ts',
    );
    expect(runtime.__declaresCanonicalizeUpload).to.equal(false);

    const schema = makeSchema();
    const snapshot = bothSides(
      cmaRecord({
        title: { it: 'Ciao', en: 'Hello' },
        content: {
          en: [block(BLOCK_ID, { caption: 'caption', children: [] })],
        },
      }),
      null,
      schema,
    );
    expect(Object.keys(snapshot.current.fields.title)).to.deep.equal([
      'en',
      'it',
    ]);
    expect(snapshot.lifecycle.createdAt).to.equal('2025-01-01T00:00:00.000Z');
    expect(snapshot.current.fields.content.en[0]).to.deep.equal(
      block(BLOCK_ID, { caption: 'caption', children: [] }),
    );
  });

  it('hashes localized fields holding a non-object value the same way on both sides (D14)', () => {
    const schema = makeSchema();
    const bare = [block(BLOCK_ID, { caption: 'caption', children: [] })];

    for (const value of [bare, 'text', null]) {
      const snapshot = bothSides(
        cmaRecord({ title: { en: 'Hello' }, content: value }),
        null,
        schema,
      );
      // The value is canonical JSON, not a block tree: it is not a locale map.
      expect(snapshot.current.fields.content).to.deep.equal(
        canonicalizeJson(value),
      );
    }
  });

  it('reads fields from an attributes container only when the model has no attributes field (D16)', () => {
    const schema = makeSchema();
    const fields = {
      title: { en: 'Hello' },
      content: { en: [block(BLOCK_ID, { caption: 'c', children: [] })] },
    };
    const flat = bothSides(cmaRecord(fields), null, schema);
    const { meta, ...identity } = cmaRecord({});
    const container = bothSides(
      { ...identity, attributes: structuredClone(fields), meta },
      null,
      schema,
    );
    expect(container.current).to.deep.equal(flat.current);
    expect(container.hash).to.equal(flat.hash);

    const withAttributesField = makeSchema([
      field('title', 'string', true, 1),
      field('attributes', 'json', false, 2),
    ]);
    const jsonField = bothSides(
      cmaRecord({ title: { en: 'Hello' }, attributes: { b: 1, a: 2 } }),
      null,
      withAttributesField,
    );
    expect(jsonField.current.fields).to.deep.equal({
      title: { en: 'Hello' },
      attributes: { a: 2, b: 1 },
    });
  });

  it('reads only own model fields and keeps unknown attributes named like prototype members (D6)', () => {
    const schema = makeSchema([
      field('title', 'string', true, 1),
      field('toString', 'string', false, 2),
    ]);
    const snapshot = bothSides(
      cmaRecord({ title: { en: 'Hello' }, constructor: 'kept' }),
      null,
      schema,
    );
    expect(snapshot.current.fields).to.deep.equal({
      title: { en: 'Hello' },
      constructor: 'kept',
    });
  });

  it('breaks field position ties by field ID (D35)', () => {
    const schema = makeSchema([
      field('alpha', 'string', false, 1, 'field-z'),
      field('beta', 'string', false, 1, 'field-a'),
    ]);
    const snapshot = bothSides(
      cmaRecord({ alpha: 'a', beta: 'b' }),
      null,
      schema,
    );
    expect(Object.keys(snapshot.current.fields)).to.deep.equal([
      'beta',
      'alpha',
    ]);
  });

  it('reports inconsistent validity flags with the runtime wording on both sides (D26)', () => {
    const schema = makeSchema();
    const current = cmaRecord({}, { is_valid: false });
    const currentMessage = `Record ${RECORD_ID} reports inconsistent current validity flags.`;
    expectPlannerFailure(
      () =>
        canonicalizeRecord(current, null, owner(schema), schema, NO_SCHEDULES),
      'UNSUPPORTED_CONTENT_STATE',
      currentMessage,
      { recordId: RECORD_ID },
    );
    expectRuntimeFailure(
      () =>
        runtime.__canonicalizeRecord(
          current,
          null,
          owner(schema),
          schema,
          NO_SCHEDULES,
        ),
      'INVALID_CMA_RESPONSE',
      currentMessage,
      { recordId: RECORD_ID },
    );
    // The runtime's validity polling reads the same flags outside
    // canonicalization and reports the same failure.
    expectRuntimeFailure(
      () => runtime.__recordValidityFromCurrentResource(current),
      'INVALID_CMA_RESPONSE',
      currentMessage,
      { recordId: RECORD_ID },
    );

    const withPublished = cmaRecord({}, { is_published_version_valid: true });
    const published = cmaRecord({}, { is_valid: false });
    const publishedMessage = `Record ${RECORD_ID} reports inconsistent published validity flags.`;
    expectPlannerFailure(
      () =>
        canonicalizeRecord(
          withPublished,
          published,
          owner(schema),
          schema,
          NO_SCHEDULES,
        ),
      'UNSUPPORTED_CONTENT_STATE',
      publishedMessage,
      { recordId: RECORD_ID },
    );
    expectRuntimeFailure(
      () =>
        runtime.__canonicalizeRecord(
          withPublished,
          published,
          owner(schema),
          schema,
          NO_SCHEDULES,
        ),
      'INVALID_CMA_RESPONSE',
      publishedMessage,
      { recordId: RECORD_ID },
    );
  });

  it('rejects a published version that is not a record resource on both sides (D42)', () => {
    const schema = makeSchema();
    for (const published of [undefined, false, 'x']) {
      expectPlannerFailure(
        () =>
          canonicalizeRecord(
            cmaRecord({}),
            published,
            owner(schema),
            schema,
            NO_SCHEDULES,
          ),
        'UNSUPPORTED_CONTENT_STATE',
        'The CMA returned an invalid record resource.',
      );
      expectRuntimeFailure(
        () =>
          runtime.__canonicalizeRecord(
            cmaRecord({}),
            published,
            owner(schema),
            schema,
            NO_SCHEDULES,
          ),
        'INVALID_CMA_RESPONSE',
        'The CMA returned an invalid record resource.',
      );
    }
  });

  it('names the field path of malformed nested content on both sides (D2)', () => {
    const schema = makeSchema();
    const cases: Array<[Record<string, unknown>, string, JsonObject]> = [
      [
        { content: { en: [{ type: 'item', id: BLOCK_ID }] } },
        'Nested content at content has no authoritative block model identity.',
        { path: 'content' },
      ],
      [
        {
          content: {
            en: [
              block(BLOCK_ID, {
                caption: 'c',
                children: [{ type: 'item', id: INNER_BLOCK_ID }],
              }),
            ],
          },
        },
        `Nested content at content.block:${BLOCK_ID}.children has no authoritative block model identity.`,
        { path: `content.block:${BLOCK_ID}.children` },
      ],
      [
        {
          content: {
            en: [{ ...block(BLOCK_ID, {}), attributes: null }],
          },
        },
        'Nested content at content has malformed block attributes.',
        { path: 'content' },
      ],
      [
        {
          content: {
            en: [
              {
                ...block(BLOCK_ID, {}),
                relationships: {
                  item_type: { data: { id: OWNER_MODEL, type: 'item_type' } },
                },
              },
            ],
          },
        },
        `Nested item ${BLOCK_ID} refers to unknown block model ${OWNER_MODEL}.`,
        { blockId: BLOCK_ID, itemTypeId: OWNER_MODEL, fieldPath: 'content' },
      ],
    ];

    for (const [fields, message, details] of cases) {
      expectPlannerFailure(
        () =>
          canonicalizeRecord(
            cmaRecord(fields),
            null,
            owner(schema),
            schema,
            NO_SCHEDULES,
          ),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        details,
      );
      expectRuntimeFailure(
        () =>
          runtime.__canonicalizeRecord(
            cmaRecord(fields),
            null,
            owner(schema),
            schema,
            NO_SCHEDULES,
          ),
        'INVALID_CMA_RESPONSE',
        message,
        details,
      );
    }
  });

  it('reports malformed CMA records with one message and each side keeping its code', () => {
    const schema = makeSchema();
    const cases: Array<
      [unknown, RecordScheduleSnapshot, string, JsonObject | undefined]
    > = [
      [
        cmaRecord({}, { created_at: 'not-a-date' }),
        NO_SCHEDULES,
        'The CMA response contains an invalid timestamp at meta.created_at.',
        { path: 'meta.created_at' },
      ],
      [
        cmaRecord({}, { current_version: 7 }),
        NO_SCHEDULES,
        'The CMA response is missing meta.current_version.',
        { path: 'meta.current_version' },
      ],
      [
        cmaRecord({}, { is_current_version_valid: null }),
        NO_SCHEDULES,
        `The CMA response is missing boolean record ${RECORD_ID} meta.is_current_version_valid.`,
        { path: `record ${RECORD_ID} meta.is_current_version_valid` },
      ],
      [
        cmaRecord({}),
        { publication: { at: 'soon', selective: null }, unpublishing: null },
        'The CMA response contains an invalid timestamp at schedule.publication.at.',
        { path: 'schedule.publication.at' },
      ],
      [
        { ...cmaRecord({}), id: 7 },
        NO_SCHEDULES,
        'The CMA returned an invalid record resource.',
        undefined,
      ],
    ];

    for (const [current, schedules, message, details] of cases) {
      expectPlannerFailure(
        () =>
          canonicalizeRecord(current, null, owner(schema), schema, schedules),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        details,
      );
      expectRuntimeFailure(
        () =>
          runtime.__canonicalizeRecord(
            current,
            null,
            owner(schema),
            schema,
            schedules,
          ),
        'INVALID_CMA_RESPONSE',
        message,
        details ?? null,
      );
    }

    const scheduled = bothSides(cmaRecord({}), null, schema);
    expect(scheduled.schedules).to.deep.equal(NO_SCHEDULES);
    const withSchedules = canonicalizeRecord(
      cmaRecord({}),
      null,
      owner(schema),
      schema,
      {
        publication: {
          at: '2030-01-01T01:00:00+01:00',
          selective: { locales: ['zz', 'it', 'en', 'it'], nonLocalized: true },
        },
        unpublishing: { at: '2030-01-02T00:00:00Z', locales: ['it', 'en'] },
      },
    );
    expect(
      runtime.__canonicalizeRecord(cmaRecord({}), null, owner(schema), schema, {
        publication: {
          at: '2030-01-01T01:00:00+01:00',
          selective: { locales: ['zz', 'it', 'en', 'it'], nonLocalized: true },
        },
        unpublishing: { at: '2030-01-02T00:00:00Z', locales: ['it', 'en'] },
      }),
    ).to.deep.equal(withSchedules);
    expect(withSchedules.schedules).to.deep.equal({
      publication: {
        at: '2030-01-01T00:00:00.000Z',
        selective: { locales: ['en', 'it', 'zz'], nonLocalized: true },
      },
      unpublishing: { at: '2030-01-02T00:00:00.000Z', locales: ['en', 'it'] },
    });
  });

  it('keeps the planner upload transport on top of the shared upload state (D17)', () => {
    const planner = canonicalizeUpload(cmaUpload(), ['en', 'it']);
    const executed = runtime.__canonicalizeUploadState(cmaUpload(), [
      'en',
      'it',
    ]);

    expect(Object.keys(planner)).to.deep.equal([
      'id',
      'md5',
      'basename',
      'filename',
      'manual',
      'size',
      'mimeType',
      'transport',
      'hash',
      'consistency',
    ]);
    expect(planner.transport).to.deep.equal({
      sourceUrl: 'https://assets.example/asset.png',
      bundledPath: null,
      sha256: null,
    });
    const { transport: _transport, ...state } = planner;
    expect(JSON.stringify(executed)).to.equal(JSON.stringify(state));
    expect(planner.manual.tags).to.deep.equal(['a', 'b']);
    expect(planner.manual.defaultFieldMetadata).to.deep.equal({
      alt: { en: 'alt en', it: 'alt it' },
      title: { en: null },
      custom_data: {},
      focal_point: { x: 0.25, y: 0.5 },
    });

    // Only the planner needs a source URL to bundle from.
    expectPlannerFailure(
      () => canonicalizeUpload(cmaUpload({ url: undefined }), ['en']),
      'UNSUPPORTED_CONTENT_STATE',
      'The CMA response is missing upload.url.',
      { path: 'upload.url' },
    );
    expect(
      runtime.__canonicalizeUploadState(cmaUpload({ url: undefined }), ['en'])
        .hash,
    ).to.equal(canonicalizeUpload(cmaUpload(), ['en']).hash);
  });

  it('rejects field-keyed upload metadata that is not a locale object (D15)', () => {
    for (const metadata of [
      { alt: null },
      { title: 'title' },
      { custom_data: [] },
      { alt: { en: 'a' }, focal_point: null, title: null },
    ]) {
      const upload = cmaUpload({ default_field_metadata: metadata });
      const message =
        'A localized field contains a value that is not an object.';
      expectPlannerFailure(
        () => canonicalizeUpload(upload, ['en']),
        'UNSUPPORTED_CONTENT_STATE',
        message,
      );
      expectRuntimeFailure(
        () => runtime.__canonicalizeUploadState(upload, ['en']),
        'INVALID_CMA_RESPONSE',
        message,
      );
    }

    // The legacy locale-keyed shape and a null focal point stay valid.
    for (const metadata of [
      { it: { alt: 'a' }, en: { title: null } },
      { alt: { en: 'a' }, focal_point: null },
    ]) {
      const upload = cmaUpload({ default_field_metadata: metadata });
      expect(
        runtime.__canonicalizeUploadState(upload, ['en', 'it']).hash,
      ).to.equal(canonicalizeUpload(upload, ['en', 'it']).hash);
    }
  });

  it('reports malformed uploads and collections with one message and each side keeping its code', () => {
    const uploadCases: Array<[unknown, string, JsonObject | undefined]> = [
      [null, 'The CMA returned an invalid upload resource.', undefined],
      [
        cmaUpload({ meta: { antivirus: { status: 'unknown' } } }),
        `Upload ${UPLOAD_ID} has an unknown antivirus status.`,
        undefined,
      ],
      [
        cmaUpload({ size: '1' }),
        'The CMA response is missing upload.size.',
        { path: 'upload.size' },
      ],
    ];
    for (const [upload, message, details] of uploadCases) {
      expectPlannerFailure(
        () => canonicalizeUpload(upload, ['en']),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        details,
      );
      expectRuntimeFailure(
        () => runtime.__canonicalizeUploadState(upload, ['en']),
        'INVALID_CMA_RESPONSE',
        message,
        details ?? null,
      );
    }

    const pending = cmaUpload({ meta: { antivirus: { status: 'pending' } } });
    const unhealthy = `Upload ${UPLOAD_ID} cannot be migrated while antivirus status is pending.`;
    const unhealthyDetails = {
      uploadId: UPLOAD_ID,
      antivirusStatus: 'pending',
    };
    expectPlannerFailure(
      () => canonicalizeUpload(pending, ['en']),
      'UNHEALTHY_UPLOAD',
      unhealthy,
      unhealthyDetails,
    );
    expectRuntimeFailure(
      () => runtime.__canonicalizeUploadState(pending, ['en']),
      'UNHEALTHY_UPLOAD',
      unhealthy,
      unhealthyDetails,
    );

    const collectionCases: Array<[unknown, string, JsonObject | undefined]> = [
      [
        'collection',
        'The CMA returned an invalid upload collection resource.',
        undefined,
      ],
      [
        { id: 'c1', label: 'C', parent: {}, position: 1 },
        'The CMA response is missing uploadCollection.parent.id.',
        { path: 'uploadCollection.parent.id' },
      ],
      [
        { id: 'c1', label: 'C', parent: null, position: Number.NaN },
        'The CMA response is missing uploadCollection.position.',
        { path: 'uploadCollection.position' },
      ],
    ];
    for (const [collection, message, details] of collectionCases) {
      expectPlannerFailure(
        () => canonicalizeUploadCollection(collection),
        'UNSUPPORTED_CONTENT_STATE',
        message,
        details,
      );
      expectRuntimeFailure(
        () => runtime.__canonicalizeUploadCollection(collection),
        'INVALID_CMA_RESPONSE',
        message,
        details ?? null,
      );
    }

    const collection = {
      id: 'c1',
      label: 'C',
      parent: { id: 'c0' },
      position: 2,
    };
    expect(runtime.__canonicalizeUploadCollection(collection)).to.deep.equal(
      canonicalizeUploadCollection(collection),
    );
  });
});
