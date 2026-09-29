import assert from 'node:assert/strict';
import {
  type CanonicalGraphValue,
  type MediumScaleRawListQuery,
  captureMediumScaleRawStateFromPort,
  collectMediumScaleCoverage,
} from './medium-scale-recursive-oracle';
import {
  MEDIUM_SCALE_BASELINE_COUNT,
  MEDIUM_SCALE_RECORD_COUNT,
  buildMediumScaleBlockFieldDefinitions,
  buildMediumScaleModelApiKeys,
  buildMediumScaleNestedBlockId,
  buildMediumScalePlan,
  buildMediumScaleTopLevelFieldDefinitions,
} from './medium-scale-recursive-scenario';

describe('medium-scale recursive real-CMA fixture', () => {
  it('builds deterministic, unique model API keys accepted by the live API', () => {
    const runId =
      'medium-scale-regression-run-id-that-is-intentionally-much-too-long';
    const first = buildMediumScaleModelApiKeys(runId);
    const second = buildMediumScaleModelApiKeys(runId);

    assert.deepEqual(first, second);
    assert.equal(new Set(Object.values(first)).size, 3);
    for (const apiKey of Object.values(first)) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30, apiKey);
    }
  });

  it('builds deterministic portable nested IDs scoped by record and field path', () => {
    const ids = [
      buildMediumScaleNestedBlockId('run', 8, 'modules.en.0'),
      buildMediumScaleNestedBlockId('run', 8, 'hero.en'),
      buildMediumScaleNestedBlockId('run', 16, 'modules.en.0'),
    ];
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(
      buildMediumScaleNestedBlockId('run', 8, 'modules.en.0'),
      ids[0],
    );
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9_-]{22}$/);
      const bytes = Buffer.from(id, 'base64url');
      assert.equal(bytes.length, 16);
      assert.equal(bytes[6] >> 4, 4, `${id} is not a v4 UUID`);
      assert.equal(bytes[8] >> 6, 2, `${id} has an invalid UUID variant`);
    }
  });

  it('builds a deterministic 65-record lifecycle, dependency, recursion, and ordering plan', () => {
    const plan = buildMediumScalePlan(
      MEDIUM_SCALE_RECORD_COUNT,
      MEDIUM_SCALE_BASELINE_COUNT,
    );
    assert.equal(plan.length, 65);
    assert.equal(
      plan.filter(({ lifecycle }) => lifecycle === 'published').length,
      22,
    );
    assert.equal(
      plan.filter(({ lifecycle }) => lifecycle === 'updated').length,
      22,
    );
    assert.equal(
      plan.filter(({ lifecycle }) => lifecycle === 'draft').length,
      21,
    );
    assert.equal(
      plan.filter(({ publishShellBeforeUpdate }) => publishShellBeforeUpdate)
        .length,
      22,
    );
    assert.equal(plan.filter(({ publishFinal }) => publishFinal).length, 22);
    assert.equal(
      plan.filter(({ unpublishAfterUpdate }) => unpublishAfterUpdate).length,
      11,
    );
    assert.equal(plan.filter(({ complex }) => complex).length, 9);
    assert.equal(
      plan.filter(
        ({ complex, recursionDepth }) => complex && recursionDepth === 2,
      ).length,
      5,
    );
    assert.equal(new Set(plan.map(({ position }) => position)).size, 65);

    for (const entry of plan) {
      assert.notEqual(entry.nextIndex, entry.index);
      assert.notEqual(entry.previousIndex, entry.index);
      if (entry.lifecycle === 'published') {
        assert.equal(plan[entry.nextIndex].lifecycle, 'published');
        assert.equal(plan[entry.previousIndex].lifecycle, 'published');
      }
    }
  });

  it('covers the scalar cross-section and keeps every block-model field nonlocalized', () => {
    const topLevel = buildMediumScaleTopLevelFieldDefinitions({
      nodeModelId: 'node-model',
      containerBlockModelId: 'container-block',
      leafBlockModelId: 'leaf-block',
    });
    const byApiKey = new Map(
      topLevel.map((definition) => [definition.api_key, definition]),
    );
    assert.deepEqual(
      Object.fromEntries(
        [
          'featured',
          'score',
          'weight',
          'calendar_date',
          'timestamp',
          'settings_json',
          'accent',
          'coordinates',
          'slug_value',
        ].map((apiKey) => [apiKey, byApiKey.get(apiKey)?.field_type]),
      ),
      {
        featured: 'boolean',
        score: 'integer',
        weight: 'float',
        calendar_date: 'date',
        timestamp: 'date_time',
        settings_json: 'json',
        accent: 'color',
        coordinates: 'lat_lon',
        slug_value: 'slug',
      },
    );
    assert.deepEqual(
      [byApiKey.get('title'), byApiKey.get('summary')].map((field) => ({
        fieldType: field?.field_type,
        localized: field?.localized,
      })),
      [
        { fieldType: 'string', localized: true },
        { fieldType: 'text', localized: true },
      ],
    );

    const blockFields = buildMediumScaleBlockFieldDefinitions({
      nodeModelId: 'node-model',
      containerBlockModelId: 'container-block',
      leafBlockModelId: 'leaf-block',
    });
    assert.equal(blockFields.length, 9);
    for (const { definition } of blockFields) {
      assert.equal(definition.localized, false, definition.api_key);
    }
  });

  it('uses no field API key reserved by the current CMA', () => {
    // Mirrors api/app/models/field.rb::INVALID_API_KEYS so a fixture naming
    // error is caught before a disposable environment is created.
    const reserved = new Set([
      'position',
      'is_valid',
      'id',
      'type',
      'updated_at',
      'attributes',
      'fields',
      'item_type',
      'is_singleton',
      'seo_meta_tags',
      'parent_id',
      'parent',
      'children',
      'status',
      'created_at',
      'meta',
      'eq',
      'neq',
      'all_in',
      'any_in',
      'creator',
      'exists',
      'is_current_version_valid',
      'is_published_version_valid',
      'item_type_id',
      'item_id',
    ]);
    const topLevel = buildMediumScaleTopLevelFieldDefinitions({
      nodeModelId: 'node-model',
      containerBlockModelId: 'container-block',
      leafBlockModelId: 'leaf-block',
    });
    const blocks = buildMediumScaleBlockFieldDefinitions({
      nodeModelId: 'node-model',
      containerBlockModelId: 'container-block',
      leafBlockModelId: 'leaf-block',
    });

    for (const apiKey of [
      ...topLevel.map(({ api_key }) => api_key),
      ...blocks.map(({ definition }) => definition.api_key),
    ]) {
      assert.equal(reserved.has(apiKey), false, apiKey);
      assert.ok(apiKey.length <= 30, apiKey);
    }
  });

  it('uses three nested current pages and two nested published pages', async () => {
    const current = Array.from({ length: 65 }, (_, index) =>
      fakeRawRecord(index),
    );
    const published = current.slice(0, 44);
    const calls: MediumScaleRawListQuery[] = [];

    const state = await captureMediumScaleRawStateFromPort(
      {
        async rawListItems(query) {
          calls.push(query);
          const source = query.version === 'current' ? current : published;
          return {
            data: source.slice(
              query.page.offset,
              query.page.offset + query.page.limit,
            ),
            meta: { total_count: source.length },
          };
        },
      },
      'node-model',
    );

    assert.equal(state.current.totalCount, 65);
    assert.equal(state.current.pageCount, 3);
    assert.equal(state.published.totalCount, 44);
    assert.equal(state.published.pageCount, 2);
    assert.deepEqual(
      calls
        .filter(({ version }) => version === 'current')
        .map(({ page }) => page.offset),
      [0, 30, 60],
    );
    assert.deepEqual(
      calls
        .filter(({ version }) => version === 'published')
        .map(({ page }) => page.offset),
      [0, 30],
    );
    for (const call of calls) {
      assert.equal(call.nested, true);
      assert.equal(call.page.limit, 30);
      assert.equal(call.order_by, 'id_ASC');
      assert.deepEqual(call.filter, { type: 'node-model' });
    }
  });

  it('fails closed if a raw slice changes total_count between pages', async () => {
    await assert.rejects(
      captureMediumScaleRawStateFromPort(
        {
          async rawListItems(query) {
            const totalCount =
              query.version === 'current' && query.page.offset > 0 ? 64 : 65;
            return {
              data: Array.from({ length: 30 }, (_, index) =>
                fakeRawRecord(query.page.offset + index),
              ),
              meta: { total_count: totalCount },
            };
          },
        },
        'node-model',
      ),
      /total_count changed/,
    );
  });

  it('measures recursive Structured Text and nested-block coverage independently', () => {
    const value: CanonicalGraphValue = {
      type: 'block',
      item: {
        kind: 'nestedItem',
        id: 'outer-block',
        itemTypeId: 'container-block',
        fields: {
          body: {
            type: 'inlineBlock',
            item: {
              kind: 'nestedItem',
              id: 'inner-block',
              itemTypeId: 'leaf-block',
              fields: {
                reference: { type: 'inlineItem', item: 'record-a' },
                link: { type: 'itemLink', item: 'record-b' },
              },
            },
          },
        },
      },
    };

    const coverage = collectMediumScaleCoverage(value);
    assert.equal(coverage.blockNodes, 1);
    assert.equal(coverage.inlineBlockNodes, 1);
    assert.equal(coverage.inlineItemNodes, 1);
    assert.equal(coverage.itemLinkNodes, 1);
    assert.equal(coverage.nestedItems, 2);
    assert.equal(coverage.maximumNestedItemDepth, 2);
    assert.deepEqual([...coverage.recordReferences].sort(), [
      'record-a',
      'record-b',
    ]);
  });
});

function fakeRawRecord(index: number) {
  return {
    id: `record-${index.toString().padStart(3, '0')}`,
    type: 'item',
    attributes: {
      position: index,
      title: { en: `Title ${index}`, it: `Titolo ${index}` },
      score: index,
    },
    relationships: {
      item_type: { data: { id: 'node-model', type: 'item_type' } },
    },
    meta: {
      status: 'published',
      is_current_version_valid: true,
      is_published_version_valid: true,
    },
  };
}
