import assert from 'node:assert/strict';
import {
  MIXED_STATE_STRICT_TITLE_VALIDATORS,
  buildCurrentInlineItemBody,
  buildExpectedSkipContract,
  buildPublishedItemLinkBody,
  mixedStateSkipClosureApiKey,
} from './mixed-state-skip-closure-scenario';

describe('mixed-state skip-closure real-CMA fixture contract', () => {
  it('builds one deterministic live-compatible model API key', () => {
    const first = mixedStateSkipClosureApiKey('very-long-run-id-123');
    const second = mixedStateSkipClosureApiKey('very-long-run-id-123');
    assert.equal(first, second);
    assert.match(first, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
    assert.ok(first.length <= 30);
    assert.deepEqual(MIXED_STATE_STRICT_TITLE_VALIDATORS, { required: {} });
  });

  it('encodes the published hop as itemLink and the current-only hop as inlineItem', () => {
    assert.deepEqual(buildPublishedItemLinkBody('record-a'), {
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'span', value: 'published dependency: ' },
              {
                type: 'itemLink',
                item: 'record-a',
                children: [{ type: 'span', value: 'unsafe A' }],
              },
            ],
          },
        ],
      },
    });
    assert.deepEqual(buildCurrentInlineItemBody('record-b'), {
      schema: 'dast',
      document: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'span', value: 'current dependency: ' },
              { type: 'inlineItem', item: 'record-b' },
            ],
          },
        ],
      },
    });
  });

  it('pins the exact dispositions and root-to-leaf propagation chain', () => {
    const contract = buildExpectedSkipContract({
      unsafeA: 'record-a',
      publishedConsumerB: 'record-b',
      currentConsumerC: 'record-c',
      migratableD: 'record-d',
    });
    assert.equal(contract['record-a'].disposition, 'preserve_target');
    assert.equal(contract['record-b'].disposition, 'must_remain_absent');
    assert.equal(contract['record-c'].disposition, 'preserve_target');
    assert.deepEqual(contract['record-b'].reasons[0].dependencyChain, [
      'record-b',
      'record-a',
    ]);
    assert.deepEqual(contract['record-c'].reasons[0].dependencyChain, [
      'record-c',
      'record-b',
      'record-a',
    ]);
  });
});
