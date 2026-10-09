import assert from 'node:assert/strict';
import { hashJson, recordHash } from '../src/engine/codec';
import { ContentError } from '../src/engine/errors';
import { createPlan } from '../src/engine/planner';
import {
  assertSourceRecordsValid,
  invalidSourceRecords,
} from '../src/engine/source-validity';
import { SnapshotStore } from '../src/engine/store';
import type {
  ModelSchema,
  RecordState,
  SchemaState,
} from '../src/engine/types';
import { fixtureId as id } from './fixture-id';

const STRICT = id('strict-model');
const LENIENT = id('lenient-model');
const PLAIN = id('plain-model');

function model(
  modelId: string,
  name: string,
  shape: Pick<ModelSchema, 'draftMode' | 'saveInvalidDrafts'>,
): ModelSchema {
  return {
    id: modelId,
    apiKey: name.toLowerCase(),
    name,
    block: false,
    singleton: false,
    sortable: false,
    tree: false,
    allLocalesRequired: false,
    workflowId: null,
    fields: [
      {
        id: id(`${name}-title`),
        apiKey: 'title',
        type: 'string',
        localized: false,
        validators: {},
        defaultValue: null,
      },
    ],
    ...shape,
  };
}

const definition: SchemaState = (() => {
  const result: SchemaState = {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en'],
    semantics: {},
    workflows: [],
    models: [
      // Draft mode without invalid draft saving.
      model(STRICT, 'Strict', { draftMode: true, saveInvalidDrafts: false }),
      // Draft mode with invalid draft saving.
      model(LENIENT, 'Lenient', { draftMode: true, saveInvalidDrafts: true }),
      // No draft mode: every save publishes.
      model(PLAIN, 'Plain', { draftMode: false, saveInvalidDrafts: false }),
    ],
    hash: '',
  };
  result.hash = hashJson(result);
  return result;
})();

function record(
  name: string,
  modelId: string,
  invalid?: RecordState['invalid'],
  published = false,
): RecordState {
  const fields = { title: name };
  const state: RecordState = {
    id: id(name),
    modelId,
    current: fields,
    published: published ? fields : null,
    currentVersion: '1',
    publishedUpdatedAt: published ? '2020-01-01T00:00:00.000Z' : null,
    createdAt: '2020-01-01T00:00:00.000Z',
    firstPublishedAt: published ? '2020-01-01T00:00:00.000Z' : null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    ...(invalid ? { invalid } : {}),
    hash: '',
  };
  state.hash = recordHash(state);
  return state;
}

async function planned(
  source: RecordState[],
  target: RecordState[],
  check: (store: SnapshotStore) => void,
) {
  const store = new SnapshotStore();
  try {
    for (const state of source) store.putRecord('source', state);
    for (const state of target) store.putRecord('target', state);
    await createPlan(
      store,
      definition,
      { ...definition, environmentId: 'target' },
      {
        modelIds: [STRICT, LENIENT, PLAIN],
        uploads: 'referenced',
        includeDeletions: false,
        allowPartial: false,
      },
    );
    check(store);
  } finally {
    store.dispose();
  }
}

describe('source record validity', () => {
  it('keeps the CMA verdict out of the content hash', () => {
    const valid = record('same', STRICT);
    const invalid = record('same', STRICT, { current: true, published: false });
    assert.equal(invalid.hash, valid.hash);
  });

  it('stops on invalid published versions and on invalid drafts the model does not accept', async () => {
    const both = { current: true, published: true };
    const draft = { current: true, published: false };
    await planned(
      [
        record('strict-draft', STRICT, draft),
        record('strict-published', STRICT, both, true),
        record('lenient-draft', LENIENT, draft),
        record('lenient-published', LENIENT, both, true),
        record('plain-current', PLAIN, draft, true),
        record('valid', STRICT),
      ],
      [],
      (store) => {
        assert.deepEqual(
          invalidSourceRecords(store, definition).map((entry) => [
            entry.id,
            entry.versions,
          ]),
          [
            [id('lenient-published'), ['published']],
            [id('plain-current'), ['current']],
            [id('strict-draft'), ['current']],
            [id('strict-published'), ['current', 'published']],
          ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
        assert.throws(
          () => assertSourceRecordsValid(store, definition, definition),
          (error: unknown) => {
            assert.ok(error instanceof ContentError);
            assert.equal(error.code, 'INVALID_SOURCE_RECORDS');
            assert.match(
              error.message,
              /^The diff cannot be generated: 4 source records are invalid, and invalid records cannot be diffed\./,
            );
            assert.match(
              error.message,
              new RegExp(
                `- Strict "strict-published" \\(${id(
                  'strict-published',
                )}\\): current version and published version invalid`,
              ),
            );
            assert.doesNotMatch(error.message, /lenient-draft/);
            assert.equal((error.details?.records as unknown[]).length, 4);
            return true;
          },
        );
      },
    );
  });

  it('accepts invalid drafts in models with draft mode and invalid draft saving', async () => {
    await planned(
      [record('lenient-draft', LENIENT, { current: true, published: false })],
      [],
      (store) => {
        assert.deepEqual(invalidSourceRecords(store, definition), []);
        assertSourceRecordsValid(store, definition, definition);
      },
    );
  });

  it('accepts invalid drafts by the destination model setting and names records as the source does', async () => {
    const draft = { current: true, published: false };
    // The CMA applies the destination's invalid draft saving when the script
    // writes the draft, whatever the source model allows.
    const destination: SchemaState = {
      ...definition,
      environmentId: 'target',
      models: definition.models.map((entry) =>
        entry.id === LENIENT
          ? { ...entry, name: 'Renamed', saveInvalidDrafts: false }
          : entry.id === STRICT
            ? { ...entry, saveInvalidDrafts: true }
            : entry,
      ),
    };
    await planned(
      [
        record('lenient-draft', LENIENT, draft),
        record('strict-draft', STRICT, draft),
      ],
      [],
      (store) => {
        assert.deepEqual(
          invalidSourceRecords(store, destination).map((entry) => entry.id),
          [id('lenient-draft')],
        );
        assert.throws(
          () => assertSourceRecordsValid(store, definition, destination),
          (error: unknown) => {
            assert.ok(error instanceof ContentError);
            assert.match(error.message, /- Lenient "lenient-draft" /);
            assert.doesNotMatch(error.message, /Renamed|strict-draft/);
            return true;
          },
        );
      },
    );
  });

  it('ignores invalid records the migration does not write', async () => {
    const unchanged = record('unchanged', STRICT, {
      current: true,
      published: false,
    });
    await planned([unchanged], [record('unchanged', STRICT)], (store) => {
      assert.equal(store.getPlan('record', unchanged.id)?.action, 'noop');
      assertSourceRecordsValid(store, definition, definition);
    });
  });

  it('lists at most twenty records in the message and all of them in the details', async () => {
    const many = Array.from({ length: 23 }, (_, index) =>
      record(`invalid-${String(index).padStart(2, '0')}`, STRICT, {
        current: true,
        published: false,
      }),
    );
    await planned(many, [], (store) => {
      assert.throws(
        () => assertSourceRecordsValid(store, definition, definition),
        (error: unknown) => {
          assert.ok(error instanceof ContentError);
          assert.equal(
            error.message.split('\n').filter((line) => line.startsWith('- '))
              .length,
            21,
          );
          assert.match(error.message, /- and 3 more$/);
          assert.equal((error.details?.records as unknown[]).length, 23);
          return true;
        },
      );
    });
  });
});
