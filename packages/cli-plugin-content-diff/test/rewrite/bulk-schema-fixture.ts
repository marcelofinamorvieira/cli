import assert from 'node:assert/strict';
import type { Client } from '../../src/engine/types';

/** Adapt existing mutable SDK fixtures to the JSON:API bulk schema endpoint. */
export function withBulkSchema(client: Client): Client {
  client.site.rawFind = async (query) => {
    assert.deepEqual(query, { include: 'item_types,item_types.fields' });
    const site = await client.site.find();
    const models = await client.itemTypes.list();
    const included: unknown[] = [];
    for (const model of models) {
      const fields = await client.fields.list(model.id);
      const { id, type: _type, meta: _meta, workflow, ...attributes } = model;
      included.push({
        id,
        type: 'item_type',
        attributes,
        relationships: {
          workflow: { data: workflow ?? null },
          fields: { data: fields.map(({ id }) => ({ id, type: 'field' })) },
        },
      });
      for (const field of fields) {
        const { id, type: _type, ...attributes } = field;
        included.push({
          id,
          type: 'field',
          attributes,
          relationships: {
            item_type: { data: { id: model.id, type: 'item_type' } },
          },
        });
      }
    }
    const { id, type: _type, meta, ...attributes } = site;
    return {
      data: {
        id,
        type: 'site',
        attributes,
        meta,
        relationships: {
          item_types: {
            data: models.map(({ id }) => ({ id, type: 'item_type' })),
          },
        },
      },
      included,
    } as unknown as Awaited<ReturnType<Client['site']['rawFind']>>;
  };
  return client;
}
