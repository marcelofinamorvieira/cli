import assert from 'node:assert/strict';
import {
  buildCustomStructuredTextBody,
  captureCustomStructuredTextEnvironment,
  customStructuredTextApiKeys,
} from './custom-structured-text-scenario';

type RawListQuery = Readonly<{
  filter: Readonly<{ type: string }>;
  version: 'current' | 'published';
  nested: boolean;
  order_by: string;
  page: Readonly<{ offset: number; limit: number }>;
}>;

describe('custom Structured Text real-CMA fixture contract', () => {
  it('uses deterministic live-valid API keys', () => {
    const first = customStructuredTextApiKeys('long-run-id-123');
    const second = customStructuredTextApiKeys('long-run-id-123');
    assert.deepEqual(first, second);
    for (const key of Object.values(first)) {
      assert.match(key, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(key.length <= 30);
    }
    assert.notEqual(first.model, first.block);
  });

  it('places only real references and nested blocks under document children', () => {
    const body = buildCustomStructuredTextBody('real-peer', 'inert-decoy', {
      type: 'item',
      id: 'real-block',
    });
    assert.equal(body.schema, 'custom-content-v1');
    assert.deepEqual(body.document.sidecar, {
      type: 'inlineItem',
      item: 'inert-decoy',
    });
    const paragraph = body.document.children[0] as {
      children: Array<{ item: string }>;
    };
    assert.equal(paragraph.children[0].item, 'real-peer');
    assert.equal(paragraph.children[1].item, 'real-peer');
    assert.deepEqual(body.document.children[1], {
      type: 'block',
      item: { type: 'item', id: 'real-block' },
    });
  });

  it('paginates every nested raw slice at 30 with stable totals and no duplicates', async () => {
    const current = Array.from({ length: 31 }, (_, index) =>
      rawRecord(`record-${String(index).padStart(2, '0')}`),
    );
    const calls: RawListQuery[] = [];
    const client = rawListClient((query) => {
      calls.push(query);
      const records = query.version === 'current' ? current : [];
      return {
        data: records.slice(
          query.page.offset,
          query.page.offset + query.page.limit,
        ),
        meta: { total_count: records.length },
      };
    });

    const result = await captureCustomStructuredTextEnvironment(
      client,
      'model-id',
    );

    assert.equal(result.current.length, 31);
    assert.deepEqual(result.published, []);
    assert.deepEqual(
      calls
        .filter(({ version }) => version === 'current')
        .map(({ page }) => page),
      [
        { offset: 0, limit: 30 },
        { offset: 30, limit: 30 },
      ],
    );
    assert.deepEqual(
      calls
        .filter(({ version }) => version === 'published')
        .map(({ page }) => page),
      [{ offset: 0, limit: 30 }],
    );
    for (const call of calls) {
      assert.deepEqual(call.filter, { type: 'model-id' });
      assert.equal(call.nested, true);
      assert.equal(call.order_by, 'id_ASC');
      assert.equal(call.page.limit, 30);
    }
  });

  it('fails closed when nested raw pagination duplicates IDs or changes totals', async () => {
    await assert.rejects(
      captureCustomStructuredTextEnvironment(
        rawListClient(({ version, page }) => {
          if (version === 'published')
            return { data: [], meta: { total_count: 0 } };
          return page.offset === 0
            ? {
                data: Array.from({ length: 30 }, (_, index) =>
                  rawRecord(`record-${index}`),
                ),
                meta: { total_count: 31 },
              }
            : {
                data: [rawRecord('record-0')],
                meta: { total_count: 31 },
              };
        }),
        'model-id',
      ),
      /duplicate ID record-0/,
    );

    await assert.rejects(
      captureCustomStructuredTextEnvironment(
        rawListClient(({ version, page }) => {
          if (version === 'published')
            return { data: [], meta: { total_count: 0 } };
          return page.offset === 0
            ? {
                data: Array.from({ length: 30 }, (_, index) =>
                  rawRecord(`record-${index}`),
                ),
                meta: { total_count: 31 },
              }
            : {
                data: [rawRecord('record-30')],
                meta: { total_count: 32 },
              };
        }),
        'model-id',
      ),
      /total_count changed during capture/,
    );
  });
});

function rawRecord(id: string) {
  return {
    type: 'item',
    id,
    attributes: { title: `title-${id}`, body: null },
    relationships: {},
    meta: {
      status: 'draft',
      is_current_version_valid: true,
      is_published_version_valid: null,
    },
  };
}

function rawListClient(
  rawList: (query: RawListQuery) => Promise<unknown> | unknown,
) {
  return { items: { rawList } } as never;
}
