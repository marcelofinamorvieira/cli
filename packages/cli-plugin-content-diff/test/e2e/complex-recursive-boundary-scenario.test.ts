import assert from 'node:assert/strict';
import {
  analyzeComplexFields,
  buildComplexStressFields,
  complexRecursiveApiKeys,
  selectComplexBoundaryLimits,
} from './complex-recursive-boundary-scenario';

describe('complex recursive boundary real-CMA fixture contract', () => {
  it('preserves the 500-block case and refuses to weaken an unsupported 2000-block case', () => {
    const extras = { blocks_depth: 5, blocks_per_item: 2000 };
    assert.deepEqual(selectComplexBoundaryLimits(extras, 500), {
      blockDepth: 5,
      blockCount: 500,
    });
    assert.deepEqual(selectComplexBoundaryLimits(extras, 2000), {
      blockDepth: 5,
      blockCount: 2000,
    });
    assert.throws(
      () =>
        selectComplexBoundaryLimits({ ...extras, blocks_per_item: 1999 }, 2000),
      /this case requires 2000/,
    );
    assert.throws(
      () =>
        selectComplexBoundaryLimits(
          { ...extras, blocks_per_item: Number.NaN },
          2000,
        ),
      /this case requires 2000/,
    );
    assert.throws(
      () => selectComplexBoundaryLimits({ ...extras, blocks_depth: 3 }, 2000),
      /block-depth limit/,
    );
  });

  it('independently counts 1999 and 2000 retained block IDs across current and published payloads at depth five', () => {
    for (const blockCount of [1999, 2000]) {
      const input = {
        runId: 'advertised-boundary',
        blockModelId: '4QI3BfBvQs-hcv_YEkk1wg',
        anchorRecordId: 'YhEa5SbeSl6KwIFizzkzig',
        blockCount,
        blockDepth: 5,
      };
      const current = buildComplexStressFields({
        ...input,
        variant: 'current',
      });
      const published = buildComplexStressFields({
        ...input,
        variant: 'published',
      });
      const currentShape = inspectRawStressFields(current, input.blockModelId);
      const publishedShape = inspectRawStressFields(
        published,
        input.blockModelId,
      );
      assert.equal(currentShape.ids.length, blockCount);
      assert.equal(new Set(currentShape.ids).size, blockCount);
      assert.equal(currentShape.depth, 5);
      assert.deepEqual(currentShape, publishedShape);
      assert.notDeepEqual(current, published);
      assert.deepEqual(
        current,
        buildComplexStressFields({ ...input, variant: 'current' }),
      );
      // Keep the same large text instead of shrinking the boundary fixture.
      const serializedBytes = Buffer.byteLength(JSON.stringify(current));
      assert.ok(
        serializedBytes >= 250_000,
        `${blockCount} blocks produced ${serializedBytes} field-payload bytes`,
      );
    }
  });
  it('builds 500 unique blocks at depth five with the complete DAST grammar', () => {
    const fields = buildComplexStressFields({
      runId: 'offline-boundary',
      blockModelId: 'abcdefghij',
      anchorRecordId: 'klmnopqrst',
      blockCount: 500,
      blockDepth: 5,
      variant: 'current',
    });
    const analysis = analyzeComplexFields(fields);
    assert.equal(analysis.blockCount, 500);
    assert.equal(new Set(analysis.blockIds).size, 500);
    assert.equal(analysis.blockDepth, 5);
    assert.ok(analysis.serializedBytes >= 250_000);
    for (const type of [
      'root',
      'paragraph',
      'heading',
      'span',
      'link',
      'inlineItem',
      'itemLink',
      'inlineBlock',
      'list',
      'listItem',
      'code',
      'blockquote',
      'thematicBreak',
      'block',
    ]) {
      assert.ok(analysis.dastNodeTypes.includes(type), `missing ${type}`);
    }
  });

  it('uses deterministic compact model API keys', () => {
    const first = complexRecursiveApiKeys('very-long-run-id-123');
    const second = complexRecursiveApiKeys('very-long-run-id-123');
    assert.deepEqual(first, second);
    assert.notEqual(first.model, first.block);
    for (const apiKey of Object.values(first)) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30);
    }
  });
});

// Deliberately separate from analyzeComplexFields: traverse the fixture's
// explicit raw block slots, check every model relationship, and retain paths.
function inspectRawStressFields(
  fields: unknown,
  expectedModelId: string,
): { ids: string[]; depth: number } {
  const ids: string[] = [];
  let depth = 0;
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(
      value !== null && typeof value === 'object' && !Array.isArray(value),
    );
    return value as Record<string, unknown>;
  };
  const block = (value: unknown, level: number): void => {
    const item = record(value);
    assert.equal(item.type, 'item');
    assert.equal(typeof item.id, 'string');
    const model = record(record(record(item.relationships).item_type).data);
    assert.deepEqual(model, { id: expectedModelId, type: 'item_type' });
    ids.push(item.id as string);
    depth = Math.max(depth, level);
    const children = record(item.attributes).nested_modules;
    assert.ok(Array.isArray(children));
    children.forEach((child) => block(child, level + 1));
  };
  const node = (value: unknown): void => {
    const item = record(value);
    if (item.type === 'block' || item.type === 'inlineBlock')
      block(item.item, 1);
    if (Array.isArray(item.children)) item.children.forEach(node);
  };
  const input = record(fields);
  assert.ok(Array.isArray(input.modules));
  input.modules.forEach((value) => block(value, 1));
  node(record(input.body).document);
  return { ids, depth };
}
