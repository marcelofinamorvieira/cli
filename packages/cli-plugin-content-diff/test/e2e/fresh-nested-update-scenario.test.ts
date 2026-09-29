import assert from 'node:assert/strict';
import { projectFreshNestedRecordState } from './fresh-nested-update-scenario';

describe('fresh nested UPDATE real-CMA fixture oracle', () => {
  it('projects labels from raw nested attributes and preserves block identity', () => {
    const current = rawRecord({
      title: 'source current',
      blockId: 'current-block-id',
      blockLabel: 'source current block',
      status: 'updated',
    });
    const published = rawRecord({
      title: 'source published',
      blockId: 'published-block-id',
      blockLabel: 'source published block',
      status: 'updated',
    });

    assert.deepEqual(
      projectFreshNestedRecordState(current, published, 'record-id'),
      {
        status: 'updated',
        currentValid: true,
        publishedValid: true,
        currentTitle: 'source current',
        currentBlockId: 'current-block-id',
        currentBlockItemTypeId: 'block-model-id',
        currentBlockLabel: 'source current block',
        publishedTitle: 'source published',
        publishedBlockId: 'published-block-id',
        publishedBlockItemTypeId: 'block-model-id',
        publishedBlockLabel: 'source published block',
      },
    );
  });

  it('rejects missing nested attributes and unknown validity instead of inventing oracle values', () => {
    const valid = rawRecord({
      title: 'current',
      blockId: 'current-block-id',
      blockLabel: 'current label',
      status: 'updated',
    });
    const flatBlock = structuredClone(valid);
    const flatHero = flatBlock.hero as Record<string, unknown>;
    flatHero.attributes = undefined;
    flatHero.label = 'a misleading flattened label';
    assert.throws(
      () => projectFreshNestedRecordState(flatBlock, valid, 'record-id'),
      /attributes/,
    );
    const unknownValidity = structuredClone(valid);
    (unknownValidity.meta as Record<string, unknown>).is_current_version_valid =
      null;
    assert.throws(
      () => projectFreshNestedRecordState(unknownValidity, valid, 'record-id'),
      /is_current_version_valid/,
    );
    const missingPublishedLabel = structuredClone(valid);
    (
      (missingPublishedLabel.hero as Record<string, unknown>)
        .attributes as Record<string, unknown>
    ).label = undefined;
    assert.throws(
      () =>
        projectFreshNestedRecordState(
          valid,
          missingPublishedLabel,
          'record-id',
        ),
      /published.hero.attributes.label/,
    );
  });
});

function rawRecord({
  title,
  blockId,
  blockLabel,
  status,
}: Readonly<{
  title: string;
  blockId: string;
  blockLabel: string;
  status: string;
}>): Record<string, unknown> {
  return {
    title,
    hero: {
      id: blockId,
      type: 'item',
      attributes: { label: blockLabel },
      relationships: {
        item_type: {
          data: { id: 'block-model-id', type: 'item_type' },
        },
      },
    },
    meta: {
      status,
      is_current_version_valid: true,
      is_published_version_valid: true,
    },
  };
}
