import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import {
  fetchSchema,
  readRawSchema,
  schemaFromRaw,
} from '../src/engine/schema';
import type { Client } from '../src/engine/types';

function bulk(count = 3) {
  const models = Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`,
    type: 'item_type',
    attributes: {
      api_key: `model_${index}`,
      name: `Model ${index}`,
      modular_block: index === 1,
      singleton: false,
      sortable: false,
      tree: false,
      draft_mode_active: true,
      draft_saving_active: true,
      all_locales_required: false,
    },
    relationships: {
      fields: { data: [{ id: `field-${index}`, type: 'field' }] },
      workflow: { data: null },
    },
  }));
  const fields = models.map((model, index) => ({
    id: `field-${index}`,
    type: 'field',
    attributes: {
      api_key: 'title',
      field_type: 'string',
      localized: true,
      validators: { required: {} },
      default_value: { en: 'Before' },
    },
    relationships: { item_type: { data: { id: model.id, type: 'item_type' } } },
  }));
  return {
    data: {
      id: 'site',
      type: 'site',
      attributes: { timezone: 'Europe/Rome', locales: ['en', 'it'] },
      meta: {
        improved_timezone_management: true,
        improved_boolean_fields: true,
        improved_validation_at_publishing: true,
        milliseconds_in_datetime: true,
        non_localized_focal_points: true,
        improved_hex_management: true,
      },
      relationships: {
        item_types: {
          data: models.map(({ id }) => ({ id, type: 'item_type' })),
        },
      },
    },
    included: [...models, ...fields],
  };
}

describe('fresh bulk schema hydration', () => {
  it('uses two requests for a large schema and refreshes fields on each consistency read', async () => {
    const response = bulk(500);
    let requests = 0;
    const forbidden = async () =>
      assert.fail('per-model schema requests are forbidden');
    const client = {
      site: {
        rawFind: async (query: unknown) => {
          requests++;
          assert.deepEqual(query, { include: 'item_types,item_types.fields' });
          return response;
        },
        find: forbidden,
      },
      itemTypes: { list: forbidden },
      fields: { list: forbidden },
      workflows: {
        list: async () => {
          requests++;
          return [
            {
              id: 'workflow',
              api_key: 'editorial',
              stages: [{ id: 'review', name: 'Review', initial: true }],
            },
          ];
        },
      },
    } as unknown as Client;
    const first = await fetchSchema(client, 'sandbox');
    assert.equal(requests, 2);
    assert.equal(first.models.length, 500);
    assert.equal(first.models.find((m) => m.id === 'model-1')?.block, true);
    assert.deepEqual(first.models[0].fields[0].defaultValue, { en: 'Before' });
    assert.deepEqual(first.workflows, [
      {
        id: 'workflow',
        apiKey: 'editorial',
        stages: [{ id: 'review', name: 'Review', initial: true }],
      },
    ]);
    const raw = response.included.find((r) => r.id === 'field-0')!;
    Object.assign(raw.attributes, { default_value: { en: 'After' } });
    const second = await fetchSchema(client, 'sandbox');
    assert.equal(requests, 4);
    assert.notEqual(first.hash, second.hash);
    assert.deepEqual(first.models[0].fields[0].defaultValue, { en: 'Before' });
    assert.deepEqual(second.models[0].fields[0].defaultValue, { en: 'After' });
  });

  it('reads an environment flag the API does not report as off', async () => {
    const response = bulk();
    const { improved_hex_management: _omitted, ...reported } =
      response.data.meta;
    Object.assign(response.data, {
      meta: { ...reported, non_localized_focal_points: 'yes' },
    });
    const client = {
      site: { rawFind: async () => response },
      workflows: { list: async () => [] },
    } as unknown as Client;
    const { semantics } = await fetchSchema(client, 'sandbox');
    assert.equal(semantics.improved_hex_management, false);
    assert.equal(semantics.non_localized_focal_points, false);
    assert.equal(semantics.improved_boolean_fields, true);
  });

  it('accepts a genuinely empty schema without field requests', async () => {
    const client = {
      site: { rawFind: async () => bulk(0) },
      workflows: { list: async () => [] },
    } as unknown as Client;
    assert.deepEqual((await fetchSchema(client, 'sandbox')).models, []);
  });

  it('drains the independent workflow read when the schema request fails', async () => {
    let drained = false;
    const client = {
      site: {
        rawFind: async () => {
          throw new Error('failed bulk');
        },
      },
      workflows: {
        list: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          drained = true;
          return [];
        },
      },
    } as unknown as Client;
    await assert.rejects(fetchSchema(client, 'sandbox'), /failed bulk/);
    assert.equal(drained, true);
  });

  it('reads the same schema from a raw read, stored as a dump stores it, as from a fresh read', async () => {
    const client = {
      site: { rawFind: async () => bulk() },
      workflows: {
        list: async () => [
          {
            id: 'workflow',
            api_key: 'editorial',
            stages: [{ id: 'review', name: 'Review', initial: true }],
          },
        ],
      },
    } as unknown as Client;
    const raw = await readRawSchema(client);
    const expected = await fetchSchema(client, 'sandbox');
    assert.deepEqual(schemaFromRaw(raw, 'sandbox'), expected);
    assert.deepEqual(
      schemaFromRaw(JSON.parse(JSON.stringify(raw)), 'sandbox'),
      expected,
    );
  });
});
