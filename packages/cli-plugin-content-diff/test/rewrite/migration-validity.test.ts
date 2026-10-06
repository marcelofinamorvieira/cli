import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { canonicalFields, hashJson, recordHash } from '../../src/engine/codec';
import {
  type IntentRecorder,
  createIntentRecorder,
} from '../../src/engine/migration-intent';
import { resolveIntentValidity } from '../../src/engine/migration-validity';
import { SnapshotStore } from '../../src/engine/store';
import type {
  Client,
  FieldSchema,
  JsonObject,
  ModelSchema,
  RecordState,
  SchemaState,
} from '../../src/engine/types';
import { fixtureId } from './fixture-id';

const id = fixtureId;
const MODEL = id('validation-model');
const BLOCK = id('validation-block');
const A = id('validation-a');
const B = id('validation-b');
const WHEN = '2020-01-01T00:00:00.000Z';

function field(apiKey: string, type = 'string'): FieldSchema {
  return {
    id: id(apiKey),
    apiKey,
    type,
    localized: false,
    validators: {},
    defaultValue: null,
  };
}
function model(modelId = MODEL, block = false): ModelSchema {
  return {
    id: modelId,
    apiKey: block ? 'block' : 'page',
    name: 'Page',
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
      : [field('title'), field('link', 'link'), field('body', 'rich_text')],
  };
}
function schema(): SchemaState {
  return {
    siteId: 'site',
    environmentId: 'main',
    locales: ['en'],
    semantics: {},
    models: [model(), model(BLOCK, true)],
    workflows: [],
    hash: '',
  };
}
function record(state: SchemaState, recordId = A): RecordState {
  const result: RecordState = {
    id: recordId,
    modelId: MODEL,
    current: canonicalFields(
      { title: 'Original', link: null, body: [] },
      MODEL,
      state,
    ),
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: WHEN,
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
  };
  result.hash = recordHash(result);
  return result;
}
function apiError(
  status: number,
  code = 'INVALID_FIELD',
  detail = 'VALIDATION_REQUIRED',
) {
  return new CmaClient.ApiError({
    request: {
      method: 'POST',
      url: '/items/validate',
      headers: {},
      body: undefined,
    },
    response: {
      status,
      statusText: 'Validation response',
      headers: {},
      body: {
        data: [
          {
            id: 'error',
            type: 'api_error',
            attributes: {
              code,
              details: {
                code: detail,
                field: 'title',
                field_id: id('title'),
                field_type: 'string',
              },
            },
          },
        ],
      },
    },
  });
}

describe('TypeScript migration native validation', () => {
  let store: SnapshotStore;
  let state: SchemaState;
  let recorder: IntentRecorder;
  beforeEach(() => {
    store = new SnapshotStore();
    state = schema();
    store.putRecord('target', record(state));
    recorder = createIntentRecorder({ store, schema: state });
  });
  afterEach(() => {
    store.dispose();
  });

  it('validates existing edits read-only and strips all nested block IDs', async () => {
    await recorder.client.items.update(A, {
      title: 'Edited',
      body: [
        {
          id: id('block-id'),
          type: 'item',
          attributes: { text: 'Nested' },
          relationships: {
            item_type: { data: { id: BLOCK, type: 'item_type' } },
          },
        },
      ],
    });
    let calls = 0;
    const client = {
      items: {
        async validateExisting(recordId: string, payload: JsonObject) {
          calls++;
          assert.equal(recordId, A);
          assert.equal(payload.title, 'Edited');
          const block = (payload.body as JsonObject[])[0];
          assert.equal(block.id, undefined);
          assert.equal(
            ((block.relationships as JsonObject).item_type as JsonObject)
              .data &&
              (
                ((block.relationships as JsonObject).item_type as JsonObject)
                  .data as JsonObject
              ).id,
            BLOCK,
          );
        },
      },
    } as unknown as Client;
    await resolveIntentValidity({ recorder, store, schema: state, client });
    assert.equal(calls, 1);
    assert.equal(store.getRecord('source', A)!.validity.current, true);
    recorder.assertReady();
  });

  it('uses validateNew for a new independent record', async () => {
    await recorder.client.items.create({
      id: B,
      item_type: { id: MODEL, type: 'item_type' },
      title: 'New',
      meta: { created_at: WHEN },
    });
    let calls = 0;
    const client = {
      items: {
        async validateNew(payload: JsonObject) {
          calls++;
          assert.equal((payload.item_type as JsonObject).id, MODEL);
          assert.equal(payload.id, undefined);
        },
      },
    } as unknown as Client;
    await resolveIntentValidity({ recorder, store, schema: state, client });
    assert.equal(calls, 1);
  });

  it('does not revalidate a payload with exact captured validity evidence', async () => {
    const fields = { ...store.getRecord('target', A)!.current, title: '' };
    recorder = createIntentRecorder({
      store,
      schema: state,
      validityEvidence: [
        {
          recordId: A,
          slice: 'current',
          fieldHash: hashJson(fields),
          valid: false,
        },
      ],
    });
    await recorder.client.items.update(A, { title: '' });
    await resolveIntentValidity({
      recorder,
      store,
      schema: state,
      client: {} as Client,
    });
    assert.equal(store.getRecord('source', A)!.validity.current, false);
  });

  it('classifies only an ordinary field validator failure as invalid content', async () => {
    await recorder.client.items.update(A, { title: '' });
    const client = {
      items: {
        async validateExisting() {
          throw apiError(422);
        },
      },
    } as unknown as Client;
    await resolveIntentValidity({ recorder, store, schema: state, client });
    assert.equal(store.getRecord('source', A)!.validity.current, false);
    recorder.assertReady();
  });

  it('refuses structural and block-ownership errors without inventing validity', async () => {
    await recorder.client.items.update(A, { title: 'Edited' });
    const client = {
      items: {
        async validateExisting() {
          throw apiError(422, 'INVALID_FIELD', 'INVALID_FORMAT');
        },
      },
    } as unknown as Client;
    await assert.rejects(
      resolveIntentValidity({ recorder, store, schema: state, client }),
      /structural or inconclusive/,
    );
    assert.equal([...recorder.needsValidation()].length, 1);
  });

  it('preserves access, transient and unknown failures unchanged', async () => {
    await recorder.client.items.update(A, { title: 'Edited' });
    for (const error of [
      apiError(403, 'INSUFFICIENT_PERMISSIONS'),
      apiError(429, 'RATE_LIMIT_EXCEEDED'),
      new Error('Connection reset'),
    ]) {
      const client = {
        items: {
          async validateExisting() {
            throw error;
          },
        },
      } as unknown as Client;
      await assert.rejects(
        resolveIntentValidity({ recorder, store, schema: state, client }),
        (observed) => observed === error,
      );
      assert.equal([...recorder.needsValidation()].length, 1);
    }
  });

  it('refuses edited links to records not yet in the destination before any request', async () => {
    await recorder.client.items.create({
      id: B,
      item_type: { id: MODEL, type: 'item_type' },
      title: 'New',
      meta: { created_at: WHEN },
    });
    await recorder.client.items.update(A, { link: B });
    let calls = 0;
    const client = {
      items: {
        async validateExisting() {
          calls++;
        },
        async validateNew() {
          calls++;
        },
      },
    } as unknown as Client;
    await assert.rejects(
      resolveIntentValidity({
        recorder,
        store,
        schema: state,
        client,
        concurrency: 1,
      }),
      /unavailable in the current destination/,
    );
    // Other independent validation may precede the refusal in sorted order.
    assert.ok(calls <= 1);
    assert.ok(
      [...recorder.needsValidation()].some((entry) => entry.recordId === A),
    );
  });

  it('refuses defaults that would validate different values from explicit null intent', async () => {
    state.models[0].fields[0].defaultValue = 'Default';
    recorder = createIntentRecorder({ store, schema: state });
    await recorder.client.items.create({
      id: B,
      item_type: { id: MODEL, type: 'item_type' },
      title: null,
      meta: { created_at: WHEN },
    });
    await assert.rejects(
      resolveIntentValidity({
        recorder,
        store,
        schema: state,
        client: {} as Client,
      }),
      /replace null with the default/,
    );
  });

  it('drains submitted requests and stops queuing validation after interruption', async () => {
    store.putRecord('target', record(state, B));
    store.putRecord('target', record(state, id('validation-c')));
    recorder = createIntentRecorder({ store, schema: state });
    for (const before of store.records('target'))
      await recorder.client.items.update(before.id, { title: 'Edited' });
    const pending: (() => void)[] = [];
    let calls = 0;
    const client = {
      items: {
        async validateExisting() {
          calls++;
          await new Promise<void>((resolve) => pending.push(resolve));
        },
      },
    } as unknown as Client;
    const controller = new AbortController();
    let done = false;
    const operation = resolveIntentValidity({
      recorder,
      store,
      schema: state,
      client,
      concurrency: 2,
      signal: controller.signal,
    });
    const rejected = assert.rejects(operation, /interrupted/).then(() => {
      done = true;
    });
    await setImmediate();
    assert.equal(calls, 2);
    controller.abort();
    pending[0]();
    await setImmediate();
    assert.equal(done, false);
    assert.equal(calls, 2);
    pending[1]();
    await rejected;
    assert.equal([...recorder.needsValidation()].length, 3);
  });
});
