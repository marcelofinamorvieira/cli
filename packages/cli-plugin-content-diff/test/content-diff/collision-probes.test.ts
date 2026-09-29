import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import {
  assertNoLegacyDestinationIdCollisions,
  findDestinationIdCollisions,
  generateContentDiffMigration,
} from '../../src/content-diff';
import { deterministicPortableDatoId } from '../../src/content-diff/legacy-ids';
import type { ContentSnapshot } from '../../src/content-diff/types';

describe('content diff collision probe selection', () => {
  it('probes each portable ID once across actual generation for a 2000-block create', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'content-diff-collision-count-'),
    );
    const blockIds = Array.from({ length: 2000 }, (_, index) =>
      deterministicPortableDatoId(`collision-block-${index}`),
    );
    const recordId = deterministicPortableDatoId('collision-root');
    const record = {
      id: recordId,
      type: 'item',
      item_type: { id: 'article-model', type: 'item_type' },
      title: 'Large create',
      modules: blockIds.map((id) =>
        CmaClient.buildBlockRecord({
          id,
          item_type: { id: 'block-model', type: 'item_type' },
          label: 'Nested block',
        }),
      ),
      meta: {
        created_at: '2025-01-01T00:00:00Z',
        first_published_at: null,
        current_version: 'initial-version',
        updated_at: '2025-01-01T00:00:00Z',
        is_valid: true,
        is_current_version_valid: true,
        is_published_version_valid: null,
        published_at: null,
        publication_scheduled_at: null,
        unpublishing_scheduled_at: null,
        stage: null,
      },
    };
    const destinationLookups: string[] = [];
    const source = generationClient([record], []);
    const destination = generationClient([], destinationLookups);
    try {
      const result = await generateContentDiffMigration({
        source: {
          rootClient: source,
          environmentClient: source,
          environmentId: 'source',
        },
        destination: {
          rootClient: destination,
          environmentClient: destination,
          environmentId: 'destination',
        },
        migrationFilePath: join(directory, 'migration.js'),
        format: 'js',
        options: {
          itemTypes: 'all',
          uploads: 'referenced',
          includeDeletions: false,
          bundleAssets: false,
          migrateInvalidContent: false,
        },
      });
      assert.deepEqual(result.summary.records, [
        { id: recordId, itemTypeId: 'article-model', action: 'create' },
      ]);
      assert.equal(destinationLookups.length, 2001);
      assert.deepEqual(
        destinationLookups.sort(),
        [...blockIds, recordId].sort(),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the default helper exhaustive and excludes only entities already captured in destination', async () => {
    const portable = deterministicPortableDatoId('portable-block');
    const source = collisionSnapshot(
      ['123', 'shared'],
      ['456', portable, 'shared-block'],
    );
    const destination = collisionSnapshot(['shared'], ['shared-block']);
    const calls: string[] = [];
    const collisions = await findDestinationIdCollisions(
      source,
      destination,
      lookupClient(async (id) => {
        calls.push(id);
        return { id };
      }),
    );
    assert.deepEqual(calls.sort(), ['123', '456', portable].sort());
    assert.deepEqual(collisions.map(({ id }) => id).sort(), calls);
  });

  it('checks both raw legacy record and block occupancy before remapping while skipping portable IDs', async () => {
    const portable = deterministicPortableDatoId('ordinary-portable');
    const source = collisionSnapshot(['123', portable], ['456']);
    const calls: string[] = [];
    const collisions = await findDestinationIdCollisions(
      source,
      collisionSnapshot(),
      lookupClient(async (id) => {
        calls.push(id);
        return { id };
      }),
      { legacyIdsOnly: true },
    );
    assert.deepEqual(calls.sort(), ['123', '456']);
    assert.deepEqual(
      collisions.map(({ id, kind }) => ({ id, kind })),
      [
        { id: '123', kind: 'record' },
        { id: '456', kind: 'block' },
      ],
    );
    assert.throws(
      () => assertNoLegacyDestinationIdCollisions(collisions),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'DUPLICATE_ENTITY_ID',
    );
  });

  it('performs a fresh complete check of mapped and ordinary portable IDs after absent legacy IDs', async () => {
    const ordinary = deterministicPortableDatoId('ordinary-portable');
    const mappedRoot = deterministicPortableDatoId('mapped-root');
    const mappedBlock = deterministicPortableDatoId('mapped-block');
    const calls: string[] = [];
    let afterMapping = false;
    const client = lookupClient(async (id) => {
      calls.push(id);
      if (!afterMapping) throw { response: { status: 404 } };
      return { id };
    });
    const initial = await findDestinationIdCollisions(
      collisionSnapshot(['123', ordinary], ['456']),
      collisionSnapshot(),
      client,
      { legacyIdsOnly: true },
    );
    assert.deepEqual(initial, []);
    assertNoLegacyDestinationIdCollisions(initial);
    assert.deepEqual(calls.sort(), ['123', '456']);
    calls.length = 0;
    afterMapping = true;
    const final = await findDestinationIdCollisions(
      collisionSnapshot([mappedRoot, ordinary], [mappedBlock]),
      collisionSnapshot(),
      client,
    );
    assert.deepEqual(calls.sort(), [mappedRoot, mappedBlock, ordinary].sort());
    assert.deepEqual(final.map(({ id }) => id).sort(), calls);
  });

  it('treats only not-found responses as absence and propagates other failures in both modes', async () => {
    for (const options of [{}, { legacyIdsOnly: true }]) {
      const source = collisionSnapshot(['123']);
      assert.deepEqual(
        await findDestinationIdCollisions(
          source,
          collisionSnapshot(),
          lookupClient(async () => {
            throw { response: { status: 404 } };
          }),
          options,
        ),
        [],
      );
      for (const error of [
        { response: { status: 403 } },
        { response: { status: 429 } },
        { response: { status: 500 } },
        new Error('network failure'),
      ]) {
        await assert.rejects(
          findDestinationIdCollisions(
            source,
            collisionSnapshot(),
            lookupClient(async () => {
              throw error;
            }),
            options,
          ),
          (actual: unknown) => actual === error,
        );
      }
    }
  });
});

function collisionSnapshot(
  recordIds: string[] = [],
  blockIds: string[] = [],
): ContentSnapshot {
  return {
    records: Object.fromEntries(recordIds.map((id) => [id, {}])),
    blockOwnership: Object.fromEntries(
      blockIds.map((id) => [id, [{ topRecordId: recordIds[0] ?? 'owner' }]]),
    ),
  } as unknown as ContentSnapshot;
}

function lookupClient(
  find: (id: string) => Promise<unknown>,
): CmaClient.Client {
  return {
    items: {
      async find(id: string, query: unknown) {
        assert.deepEqual(query, { version: 'current', nested: false });
        return find(id);
      },
    },
  } as unknown as CmaClient.Client;
}

function generationClient(
  records: unknown[],
  lookups: string[],
): CmaClient.Client {
  const model = (id: string, apiKey: string, block: boolean) => ({
    id,
    name: apiKey,
    api_key: apiKey,
    modular_block: block,
    singleton: false,
    sortable: false,
    tree: false,
    draft_mode_active: !block,
    draft_saving_active: false,
    all_locales_required: false,
    workflow: null,
  });
  const field = (
    id: string,
    apiKey: string,
    type: string,
    validators = {},
  ) => ({
    id,
    api_key: apiKey,
    field_type: type,
    localized: false,
    position: 1,
    default_value: null,
    validators,
  });
  return {
    users: { findMe: async () => ({ type: 'account' }) },
    site: {
      find: async () => ({
        id: 'site',
        locales: ['en'],
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
      list: async () => [
        model('article-model', 'article', false),
        model('block-model', 'block', true),
      ],
    },
    fields: {
      list: async (id: string) =>
        id === 'block-model'
          ? [field('label-field', 'label', 'string')]
          : [
              field('title-field', 'title', 'string'),
              {
                ...field('modules-field', 'modules', 'rich_text', {
                  rich_text_blocks: { item_types: ['block-model'] },
                }),
                position: 2,
              },
            ],
    },
    workflows: { list: async () => [] },
    items: {
      async *listPagedIterator(query: { version: string }) {
        if (query.version !== 'published') yield* records;
      },
      async find(id: string, query: unknown) {
        assert.deepEqual(query, { version: 'current', nested: false });
        lookups.push(id);
        throw { response: { status: 404 } };
      },
    },
    uploads: { async *listPagedIterator() {} },
    uploadCollections: { list: async () => [] },
  } as unknown as CmaClient.Client;
}
