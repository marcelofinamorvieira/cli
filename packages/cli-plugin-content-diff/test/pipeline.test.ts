import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalUpload,
  collectionHash,
  recordHash,
} from '../src/engine/codec';
import { schemaHash } from '../src/engine/schema';
import type {
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { fixtureId as id } from './fixture-id';
import { content, diff, replay } from './pipeline';

const MODEL = id('pipeline-model');
const options = {
  modelIds: [MODEL],
  uploads: 'all' as const,
  includeDeletions: true,
  allowPartial: false,
};

function schema(
  shape: { sortable?: boolean; tree?: boolean; draftMode?: boolean } = {},
): SchemaState {
  const result: SchemaState = {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en'],
    semantics: {},
    workflows: [],
    models: [
      {
        id: MODEL,
        apiKey: 'article',
        name: 'Article',
        block: false,
        singleton: false,
        sortable: shape.sortable ?? false,
        tree: shape.tree ?? false,
        draftMode: shape.draftMode ?? true,
        saveInvalidDrafts: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: id('pipeline-title'),
            apiKey: 'title',
            type: 'string',
            localized: false,
            validators: {},
            defaultValue: null,
          },
          {
            id: id('pipeline-related'),
            apiKey: 'related',
            type: 'links',
            localized: false,
            validators: {},
            defaultValue: null,
          },
          {
            id: id('pipeline-image'),
            apiKey: 'image',
            type: 'file',
            localized: false,
            validators: {},
            defaultValue: null,
          },
        ],
      },
    ],
    hash: '',
  };
  result.hash = schemaHash(result);
  return result;
}

function record(
  name: string,
  fields: JsonObject = {},
  overrides: Partial<RecordState> = {},
): RecordState {
  const result: RecordState = {
    id: id(name),
    modelId: MODEL,
    current: { title: name, related: [], image: null, ...fields },
    published: null,
    currentVersion: `v-${name}`,
    publishedUpdatedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: '',
    ...overrides,
  };
  result.hash = recordHash(result);
  return result;
}

const published = (name: string, fields: JsonObject = {}) =>
  record(name, fields, {
    published: { title: name, related: [], image: null, ...fields },
    firstPublishedAt: '2025-02-01T00:00:00.000Z',
    publishedUpdatedAt: '2025-02-01T00:00:00.000Z',
  });

function upload(name: string, bytes: string, folder?: string): UploadState {
  return canonicalUpload({
    id: id(name),
    basename: name,
    filename: `${name}.svg`,
    md5: createHash('md5').update(bytes).digest('hex'),
    size: bytes.length,
    url: `https://assets.example.test/${name}.svg`,
    upload_collection: folder ? { id: id(folder) } : null,
    author: null,
    copyright: null,
    notes: null,
    tags: [],
  });
}

function folder(
  name: string,
  position: number,
  parent: string | null = null,
): CollectionState {
  const state = {
    id: id(name),
    label: name,
    parentId: parent ? id(parent) : null,
    position,
    hash: '',
  };
  state.hash = collectionHash(state);
  return state;
}

describe('content diff pipeline', () => {
  it('creates, updates, publishes and deletes records, and converges', async () => {
    const before = [published('kept', { title: 'Old' }), record('gone')];
    const after = [
      published('kept', { title: 'New' }),
      published('fresh', { related: [id('kept')] }),
    ];
    const { operations, fixture } = await replay({
      source: content({ records: after }),
      target: content({ records: before }),
      sourceSchema: schema(),
      options,
    });
    assert.deepEqual(
      operations.map((operation) => operation.op),
      [
        'record.create',
        'record.publish',
        'record.update',
        'record.publish',
        'record.delete',
      ],
    );
    const update = operations.find(
      (operation) =>
        operation.op === 'record.update' && operation.id === id('kept'),
    )!;
    assert.deepEqual(update.expect, {
      currentVersion: 'v-kept',
      publishedUpdatedAt: '2025-02-01T00:00:00.000Z',
    });
    assert.deepEqual(update.data, {
      title: 'New',
      meta: { current_version: 'v-kept' },
    });
    assert.deepEqual(fixture.updates, [{ id: id('kept'), locked: true }]);
  });

  it('publishes a new publication cycle provisionally, then restores its links', async () => {
    const after = [
      published('left', { related: [id('right')] }),
      published('right', { related: [id('left')] }),
    ];
    const { operations } = await replay({
      source: content({ records: after }),
      target: content(),
      sourceSchema: schema(),
      options,
    });
    assert.ok(
      operations.some((operation) =>
        operation.label.startsWith('Restore the links left out'),
      ),
    );
  });

  it('moves tree records and reorders sortable groups', async () => {
    const definition = schema({ tree: true });
    const before = [
      record('root', {}, { position: 1 }),
      record('child', {}, { parentId: id('root'), position: 1 }),
      record('other', {}, { position: 2 }),
    ];
    const after = [
      record('root', {}, { position: 2 }),
      record('child', {}, { parentId: null, position: 1 }),
      record('other', {}, { parentId: id('root'), position: 1 }),
    ];
    const { operations } = await replay({
      source: content({ records: after }),
      target: content({ records: before }),
      sourceSchema: definition,
      options,
    });
    assert.ok(
      operations.some((operation) => operation.op === 'records.reorder'),
    );
  });

  it('creates, replaces and deletes uploads and folders', async () => {
    const before = content({
      uploads: [upload('replaced', 'old'), upload('removed', 'x', 'archive')],
      collections: [folder('archive', 1)],
    });
    const after = content({
      records: [record('pictured', { image: { upload_id: id('added') } })],
      uploads: [upload('replaced', 'new'), upload('added', 'fresh', 'media')],
      collections: [folder('media', 1)],
    });
    const { operations } = await replay({
      source: after,
      target: before,
      sourceSchema: schema(),
      options,
    });
    assert.deepEqual(
      operations
        .filter((operation) => !operation.op.startsWith('record'))
        .map((operation) => operation.op),
      [
        'folder.create',
        'upload.create',
        'upload.replace',
        'upload.delete',
        'folder.delete',
        'folders.reorder',
      ],
    );
  });

  it('plans nothing when both sides match', async () => {
    const side = content({ records: [published('same')] });
    const { operations } = await diff({
      source: side,
      target: side,
      sourceSchema: schema(),
      options,
    });
    assert.deepEqual(operations, []);
  });
});
