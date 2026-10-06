import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  canonicalFields,
  canonicalUpload,
  collectionHash,
  hashJson,
  inspectRecord,
  recordHash,
} from '../../src/engine/codec';
import {
  type IntentBinary,
  type IntentRecorder,
  createIntentRecorder,
} from '../../src/engine/migration-intent';
import { createPlan } from '../../src/engine/planner';
import { schemaHash } from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  CollectionState,
  FieldSchema,
  JsonObject,
  ModelSchema,
  RecordState,
  SchemaState,
} from '../../src/engine/types';
import type { ContentMigrationClient } from '../../src/migration';

const id = (name: string) =>
  createHash('sha256').update(name).digest('base64url').slice(0, 22);
const MODEL = id('intent-model');
const BLOCK = id('intent-block');
const A = id('intent-a');
const B = id('intent-b');
const C = id('intent-c');
const WHEN = '2020-01-01T00:00:00.000Z';
const FUTURE = '2090-01-01T00:00:00.000Z';

function field(
  apiKey: string,
  type = 'string',
  localized = false,
): FieldSchema {
  return {
    id: id(apiKey),
    apiKey,
    type,
    localized,
    validators: {},
    defaultValue: null,
  };
}
function model(modelId = MODEL, block = false): ModelSchema {
  return {
    id: modelId,
    apiKey: block ? 'text_block' : 'faq',
    name: 'FAQ',
    block,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: true,
    saveInvalidDrafts: true,
    allLocalesRequired: false,
    workflowId: null,
    fields: block
      ? [field('text')]
      : [
          field('title'),
          field('summary', 'text', true),
          field('related', 'link'),
          field('amount', 'integer'),
          field('body', 'rich_text'),
          field('image', 'file'),
        ],
  };
}
function schema(): SchemaState {
  const result: SchemaState = {
    siteId: 'site',
    environmentId: 'main',
    locales: ['en', 'it'],
    semantics: {},
    models: [model(), model(BLOCK, true)],
    workflows: [],
    hash: '',
  };
  result.hash = schemaHash(result);
  return result;
}
function record(
  state: SchemaState,
  recordId = A,
  values: JsonObject = {},
  overrides: Partial<RecordState> = {},
): RecordState {
  const result: RecordState = {
    id: recordId,
    modelId: MODEL,
    current: canonicalFields(
      {
        title: 'FAQ',
        summary: { en: 'English', it: 'Italian' },
        related: null,
        amount: 3,
        body: [],
        image: null,
        ...values,
      },
      MODEL,
      state,
    ),
    published: null,
    currentVersion: 'version-1',
    publishedUpdatedAt: null,
    createdAt: WHEN,
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
    ...overrides,
  };
  result.hash = recordHash(result);
  return result;
}
function createBody(recordId: string, values: JsonObject = {}) {
  return {
    id: recordId,
    item_type: { id: MODEL, type: 'item_type' },
    meta: { created_at: WHEN, first_published_at: WHEN },
    summary: { en: 'New', it: 'Nuovo' },
    ...values,
  } as Parameters<ContentMigrationClient['items']['create']>[0];
}
function validate(recorder: IntentRecorder): void {
  for (const needed of [...recorder.needsValidation()])
    recorder.resolveValidity({ ...needed, valid: true });
  recorder.assertReady();
}

describe('TypeScript migration recorded intent', () => {
  let store: SnapshotStore;
  let state: SchemaState;
  beforeEach(() => {
    store = new SnapshotStore();
    state = schema();
  });
  afterEach(() => {
    store.dispose();
  });

  it('replans one FAQ edit and preserves every unmentioned baseline identity', async () => {
    store.putRecord('target', record(state));
    store.putRecord('target', record(state, B));
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.update(A, { title: 'New question' });
    assert.equal(store.getRecord('source', A)!.current.title, 'New question');
    assert.deepEqual(
      store.getRecord('source', B),
      store.getRecord('target', B),
    );
    assert.throws(() => recorder.assertReady(), /requires native validation/);
    validate(recorder);
    const plan = await createPlan(store, state, state, {
      modelIds: [MODEL],
      uploads: 'referenced',
      includeDeletions: true,
      allowPartial: false,
      allowTemporarySchemaChanges: false,
    });
    assert.equal(plan.counts.record.update, 1);
    assert.equal(plan.counts.record.noop, 1);
    assert.equal(plan.counts.record.delete, 0);
  });

  it('uses only exact source validity evidence and retains unknown state across repeated metadata updates', async () => {
    store.putRecord('target', record(state));
    const desired = {
      ...store.getRecord('target', A)!.current,
      title: 'Known',
    };
    const recorder = createIntentRecorder({
      store,
      schema: state,
      validityEvidence: [
        {
          recordId: A,
          slice: 'current',
          fieldHash: hashJson(desired),
          valid: false,
        },
      ],
    });
    await recorder.client.items.update(A, { title: 'Known' });
    recorder.assertReady();
    assert.equal(store.getRecord('source', A)!.validity.current, false);
    await recorder.client.items.update(A, { title: 'Edited' });
    await recorder.client.items.update(A, {
      meta: { first_published_at: WHEN },
    });
    await recorder.client.items.publish(A, undefined, { recursive: false });
    assert.equal([...recorder.needsValidation()].length, 2);
    assert.throws(() => recorder.assertReady(), /requires native validation/);
    validate(recorder);
  });

  it('creates an interlinked pair before replanning safe creation order', async () => {
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.create(
      createBody(A, { title: 'A', related: B }),
    );
    await recorder.client.items.create(
      createBody(B, { title: 'B', related: A }),
    );
    validate(recorder);
    const metadata = await createPlan(store, state, state, {
      modelIds: [MODEL],
      uploads: 'referenced',
      includeDeletions: false,
      allowPartial: false,
      allowTemporarySchemaChanges: false,
    });
    assert.equal(metadata.counts.record.create, 2);
    assert.equal(store.getRecord('source', A)!.current.related, B);
    assert.equal(store.getRecord('source', B)!.current.related, A);
    assert.ok(
      [...store.references('source', A)].some(
        (reference) => reference.targetId === B,
      ),
    );
  });

  it('keeps distinct published and subsequent current content', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.update(A, {
      title: 'Published',
      meta: { first_published_at: WHEN },
    });
    await recorder.client.items.publish(A, undefined, { recursive: false });
    await recorder.client.items.update(A, { title: 'Draft' });
    const desired = store.getRecord('source', A)!;
    assert.equal(desired.published!.title, 'Published');
    assert.equal(desired.current.title, 'Draft');
    validate(recorder);
    await recorder.client.items.unpublish(A, undefined, { recursive: false });
    recorder.assertReady();
    assert.equal(store.getRecord('source', A)!.published, null);
  });

  it('replaces a provided locale map, preserves omitted fields and indexes nested blocks', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    const blockId = id('nested');
    await recorder.client.items.update(A, {
      summary: { en: 'Only English' },
      body: [
        {
          id: blockId,
          type: 'item',
          attributes: { text: 'Nested edit' },
          relationships: {
            item_type: { data: { id: BLOCK, type: 'item_type' } },
          },
        },
      ],
    });
    assert.deepEqual(store.getRecord('source', A)!.current.summary, {
      en: 'Only English',
    });
    assert.equal(store.getRecord('source', A)!.current.title, 'FAQ');
    assert.deepEqual(
      [...store.blockOwners('source', A)].map((owner) => owner.blockId),
      [blockId],
    );
    validate(recorder);
    await recorder.client.items.destroy(A);
    assert.equal(store.getRecord('source', A), undefined);
    assert.equal([...store.blockOwners('source', A)].length, 0);
    assert.equal([...store.references('source', A)].length, 0);
  });

  it('uses defaults only for omitted create fields and preserves explicit null intent', async () => {
    state.models[0].fields.find(
      (field) => field.apiKey === 'amount',
    )!.defaultValue = 7;
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.create(createBody(A));
    await recorder.client.items.create(createBody(B, { amount: null }));
    assert.equal(store.getRecord('source', A)!.current.amount, 7);
    assert.equal(store.getRecord('source', B)!.current.amount, null);
  });

  it('rejects changing record identity, even if the script catches the method rejection', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    await assert.rejects(
      recorder.client.items.update(A, { id: B }),
      /cannot change the record ID/,
    );
    assert.throws(() => recorder.assertReady(), /cannot change the record ID/);
    assert.equal(store.getRecord('source', A)!.current.title, 'FAQ');
  });

  it('rejects unsupported methods without exposing a remote client', async () => {
    const recorder = createIntentRecorder({ store, schema: state });
    // @ts-expect-error The runtime must also reject unsupported methods from untyped scripts.
    assert.throws(() => recorder.client.roles.list(), /Unsupported CMA method/);
    assert.throws(() => recorder.assertReady(), /Unsupported CMA method/);
  });

  it('rejects uncontrolled models', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({
      store,
      schema: state,
      allowedModelIds: [],
    });
    await assert.rejects(
      recorder.client.items.update(A, { title: 'Edit' }),
      /outside the migration scope/,
    );
  });

  it('rejects unsafe native integers before changing the simulated record', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    await assert.rejects(
      recorder.client.items.update(A, { amount: Number.MAX_SAFE_INTEGER + 1 }),
      /safe integer|safe.*range/i,
    );
    assert.equal(store.getRecord('source', A)!.current.amount, 3);
  });

  it('rejects SDK-unsafe file metadata before changing the simulated record', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    const custom = JSON.parse('{"__proto__":{"poison":true}}');
    await assert.rejects(
      recorder.client.items.update(A, {
        image: {
          upload_id: id('upload'),
          alt: null,
          title: null,
          custom_data: custom,
        },
      }),
      /unsupported SDK metadata __proto__/,
    );
    assert.equal(store.getRecord('source', A)!.current.image, null);
  });

  it('accepts plain literal payloads from the script VM realm', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.update(
      A,
      runInNewContext('({ title: "From the VM" })'),
    );
    assert.equal(store.getRecord('source', A)!.current.title, 'From the VM');
  });

  it('records both selective publication and unpublishing schedules exactly', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.scheduledPublication.create(A, {
      publication_scheduled_at: FUTURE,
      selective_publication: {
        content_in_locales: ['en'],
        non_localized_content: false,
      },
    });
    await recorder.client.scheduledUnpublishing.create(A, {
      unpublishing_scheduled_at: FUTURE,
      content_in_locales: ['it'],
    });
    recorder.assertReady();
    assert.deepEqual(store.getRecord('source', A)!.schedules, {
      publication: {
        at: FUTURE,
        selective: { locales: ['en'], nonLocalized: false },
      },
      unpublishing: { at: FUTURE, locales: ['it'] },
    });
    await recorder.client.scheduledPublication.destroy(A);
    assert.equal(store.getRecord('source', A)!.schedules.publication, null);
  });

  it('simulates native record sibling renumbering, appending and cross-parent moves', async () => {
    state.models[0].tree = true;
    store.putRecord('target', record(state, A, {}, { position: 1 }));
    store.putRecord('target', record(state, B, {}, { position: 2 }));
    store.putRecord('target', record(state, C, {}, { position: 3 }));
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.update(C, { position: 1 });
    assert.deepEqual(
      [C, A, B].map(
        (recordId) => store.getRecord('source', recordId)!.position,
      ),
      [1, 2, 3],
    );
    await recorder.client.items.update(B, { parent_id: A });
    assert.equal(store.getRecord('source', B)!.position, 1);
    const newId = id('appended');
    await recorder.client.items.create(createBody(newId));
    assert.equal(store.getRecord('source', newId)!.position, 3);
    await recorder.client.items.destroy(C);
    assert.equal(store.getRecord('source', A)!.position, 1);
    assert.equal(store.getRecord('source', newId)!.position, 2);
  });

  it('simulates collection inclusive shifts and appends newly created folders', async () => {
    for (const [collectionId, value] of [
      [A, 1],
      [B, 2],
      [C, 3],
    ] as const) {
      const folder: CollectionState = {
        id: collectionId,
        label: collectionId,
        parentId: null,
        position: value,
        hash: '',
      };
      folder.hash = collectionHash(folder);
      store.putCollection('target', folder);
    }
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.uploadCollections.update(C, { position: 1 });
    assert.deepEqual(
      [C, A, B].map(
        (folderId) => store.getCollection('source', folderId)!.position,
      ),
      [1, 2, 3],
    );
    const folderId = id('appended-folder');
    await recorder.client.uploadCollections.create({
      id: folderId,
      label: 'Append',
      position: 999,
    });
    assert.equal(store.getCollection('source', folderId)!.position, 4);
  });

  it('binds upload bytes only to verified files and merges locale metadata patches', async () => {
    const uploadId = id('upload');
    const asset: IntentBinary = {
      localPath: './assets/image.svg',
      filename: 'image.svg',
      binary: {
        file: 'assets/image.svg',
        sha256: 'a'.repeat(64),
        md5: 'b'.repeat(32),
        bytes: 5,
      },
    };
    const recorder = createIntentRecorder({
      store,
      schema: state,
      binaries: [asset],
    });
    await recorder.client.uploads.createFromLocalFile({
      id: uploadId,
      localPath: asset.localPath,
      default_field_metadata: { alt: { en: 'Image' } },
    });
    await recorder.client.uploads.update(uploadId, {
      default_field_metadata: { alt: { it: 'Immagine' } },
    });
    const desired = store.getUpload('source', uploadId)!;
    assert.deepEqual(
      (desired.attributes.default_field_metadata as JsonObject).alt,
      { en: 'Image', it: 'Immagine' },
    );
    assert.equal(desired.md5, asset.binary.md5);
    assert.deepEqual([...recorder.binaryBindings()], [{ uploadId, asset }]);
    await assert.rejects(
      recorder.client.uploads.update(
        uploadId,
        { path: '../outside.svg' },
        { replace_strategy: 'create_new_url' },
      ),
      /not in the verified/,
    );
  });

  it('protects baseline uploads and accepts only isolated binary replacement', async () => {
    const uploadId = id('existing-upload');
    store.putUpload(
      'target',
      canonicalUpload({
        id: uploadId,
        basename: 'old',
        filename: 'old.svg',
        format: 'svg',
        md5: 'c'.repeat(32),
        size: 9,
        url: 'https://example.invalid/old.svg',
        upload_collection: null,
        author: 'Original',
        tags: [],
      }),
    );
    const asset: IntentBinary = {
      localPath: './assets/new.svg',
      filename: 'new.svg',
      binary: {
        file: 'assets/new.svg',
        sha256: 'a'.repeat(64),
        md5: 'b'.repeat(32),
        bytes: 5,
      },
    };
    const recorder = createIntentRecorder({
      store,
      schema: state,
      binaryLookup: (path) => (path === asset.localPath ? asset : undefined),
    });
    await recorder.client.uploads.update(
      uploadId,
      { path: asset.localPath },
      { replace_strategy: 'create_new_url' },
    );
    assert.equal(store.getUpload('source', uploadId)!.filename, 'new.svg');
    assert.equal(
      store.getUpload('source', uploadId)!.attributes.author,
      'Original',
    );
    assert.equal(store.getUpload('target', uploadId)!.filename, 'old.svg');
    recorder.assertReady();
  });

  it('drains unawaited local calls before planning and seals against post-disposal writes', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    for (let index = 0; index < 64; index++)
      void recorder.client.items.update(A, { meta: { created_at: WHEN } });
    assert.throws(() => recorder.assertReady(), /Pending CMA intent/);
    await recorder.drain();
    recorder.assertReady();
    store.dispose();
    await assert.rejects(
      recorder.client.items.update(A, { title: 'Too late' }),
      /after the migration callback has finished/,
    );
  });

  it('does not hide rejected intent when the script catches its promise', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.update(A, { id: B }).catch(() => undefined);
    await assert.rejects(recorder.drain(), /cannot change the record ID/);
    assert.equal(store.getRecord('source', A)!.current.title, 'FAQ');
  });

  it('rejects a detached continuation before it can add intent after sealing', async () => {
    store.putRecord('target', record(state));
    const recorder = createIntentRecorder({ store, schema: state });
    const original = recorder.client.items.update(A, {});
    const detached = original.then(() =>
      recorder.client.items.update(A, { title: 'Late continuation' }),
    );
    const refusal = assert.rejects(
      detached,
      /after the migration callback has finished/,
    );
    await assert.rejects(
      recorder.drain(),
      /after the migration callback has finished/,
    );
    await refusal;
    assert.equal(store.getRecord('source', A)!.current.title, 'FAQ');
  });
});
