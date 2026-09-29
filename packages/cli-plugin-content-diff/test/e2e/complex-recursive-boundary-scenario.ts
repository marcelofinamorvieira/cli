import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

const TARGET_BLOCK_COUNT = 500;
const LARGE_TEXT_BYTES = 190_000;

type Seed = RealCmaScenarioSeed &
  Readonly<{
    runId: string;
    modelId: string;
    blockModelId: string;
    anchorRecordId: string;
    blockCount: number;
    blockDepth: number;
  }>;

type CanonicalRecord = Readonly<{
  id: string;
  itemTypeId: string;
  status: string;
  currentValid: boolean | null;
  publishedValid: boolean | null;
  fields: unknown;
}>;

type Expected = Readonly<{
  stressRecordId: string;
  source: Readonly<{
    current: CanonicalRecord;
    published: CanonicalRecord;
    anchorCurrent: CanonicalRecord;
    anchorPublished: CanonicalRecord;
  }>;
  destinationAnchor: Readonly<{
    current: CanonicalRecord;
    published: CanonicalRecord;
  }>;
}>;

type StressBuildInput = Readonly<{
  runId: string;
  blockModelId: string;
  anchorRecordId: string;
  blockCount: number;
  blockDepth: number;
  variant: 'published' | 'current';
}>;

export function complexRecursiveApiKeys(runId: string): Readonly<{
  model: string;
  block: string;
}> {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return {
    model: `cde2e_crm_r${suffix}`,
    block: `cde2e_crb_r${suffix}`,
  };
}

export function buildComplexStressFields(input: StressBuildInput): Readonly<{
  title: string;
  payload: string;
  modules: readonly unknown[];
  body: unknown;
}> {
  assert.ok(Number.isInteger(input.blockDepth) && input.blockDepth >= 1);
  assert.ok(
    Number.isInteger(input.blockCount) &&
      input.blockCount >= input.blockDepth + 2,
  );
  const richTextBlockCount = input.blockCount - 2;
  const chain = buildBlockChain(input, 1);
  const flatBlocks = Array.from(
    { length: richTextBlockCount - input.blockDepth },
    (_, index) =>
      buildBlock(input, `modules.flat.${index}`, [], `flat ${index}`),
  );

  return {
    title: `complex ${input.variant}`,
    payload: (input.variant === 'published' ? 'P' : 'C').repeat(
      LARGE_TEXT_BYTES,
    ),
    modules: [chain, ...flatBlocks],
    body: buildDastGrammar(input),
  };
}

export function analyzeComplexFields(fields: unknown): Readonly<{
  blockCount: number;
  blockDepth: number;
  blockIds: readonly string[];
  dastNodeTypes: readonly string[];
  serializedBytes: number;
}> {
  const normalizedFields = canonicalizeValue(fields);
  const blockIds: string[] = [];
  let blockDepth = 0;
  const dastNodeTypes = new Set<string>();

  const visit = (value: unknown, depth: number): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth));
      return;
    }
    if (!isObject(value)) return;
    if (isCanonicalBlock(value)) {
      blockIds.push(value.id);
      blockDepth = Math.max(blockDepth, depth + 1);
      visit(value.attributes, depth + 1);
      return;
    }
    if (typeof value.type === 'string') dastNodeTypes.add(value.type);
    Object.values(value).forEach((child) => visit(child, depth));
  };
  visit(normalizedFields, 0);

  return {
    blockCount: blockIds.length,
    blockDepth,
    blockIds: [...blockIds].sort(compareDatoIds),
    dastNodeTypes: [...dastNodeTypes].sort(),
    serializedBytes: Buffer.byteLength(JSON.stringify(normalizedFields)),
  };
}

export const complexRecursiveBoundaryScenario =
  buildComplexRecursiveBoundaryScenario(TARGET_BLOCK_COUNT);

export const advertisedBlockLimitScenario =
  buildComplexRecursiveBoundaryScenario(2000);

export function selectComplexBoundaryLimits(
  extras: Readonly<{ blocks_depth: number; blocks_per_item: number }>,
  requestedBlockCount: number,
): Readonly<{ blockCount: number; blockDepth: number }> {
  assert.ok(Number.isInteger(requestedBlockCount) && requestedBlockCount >= 7);
  assert.ok(
    Number.isInteger(extras.blocks_depth) && extras.blocks_depth >= 4,
    'project block-depth limit is below four or unavailable',
  );
  assert.ok(
    Number.isInteger(extras.blocks_per_item) &&
      extras.blocks_per_item >= requestedBlockCount,
    `project advertises ${extras.blocks_per_item} blocks per item; this case requires ${requestedBlockCount}`,
  );
  return {
    blockCount: requestedBlockCount,
    blockDepth: Math.min(extras.blocks_depth, 5),
  };
}

export function buildComplexRecursiveBoundaryScenario(
  requestedBlockCount: number,
): RealCmaScenario<Seed, Expected> {
  return {
    name: `maximum-depth ${requestedBlockCount}-block record with complete DAST grammar`,

    async seedSource({ client, runId }) {
      console.log(
        '[content-diff e2e] Creating complex recursive boundary schema',
      );
      const apiKeys = complexRecursiveApiKeys(runId);
      const publicInfo = await client.publicInfo.find();
      assert.ok(
        publicInfo.extras,
        'authenticated public info must expose limits',
      );
      const { blockDepth, blockCount } = selectComplexBoundaryLimits(
        publicInfo.extras,
        requestedBlockCount,
      );

      const blockModel = await client.itemTypes.create({
        name: `Complex recursive block ${runId}`,
        api_key: apiKeys.block,
        modular_block: true,
      });
      const model = await client.itemTypes.create({
        name: `Complex recursive record ${runId}`,
        api_key: apiKeys.model,
        singleton: false,
        all_locales_required: false,
        sortable: false,
        modular_block: false,
        draft_mode_active: true,
        draft_saving_active: false,
        tree: false,
        collection_appearance: 'compact',
        inverse_relationships_enabled: false,
      });
      await client.fields.create(blockModel.id, {
        label: 'Label',
        api_key: 'label',
        field_type: 'string',
        localized: false,
        validators: { required: {} },
      });
      await client.fields.create(blockModel.id, {
        label: 'Nested modules',
        api_key: 'nested_modules',
        field_type: 'rich_text',
        localized: false,
        validators: {
          rich_text_blocks: { item_types: [blockModel.id] },
        },
      });
      await client.fields.create(model.id, {
        label: 'Title',
        api_key: 'title',
        field_type: 'string',
        localized: false,
        validators: { required: {} },
      });
      await client.fields.create(model.id, {
        label: 'Large payload',
        api_key: 'payload',
        field_type: 'text',
        localized: false,
        validators: {},
      });
      await client.fields.create(model.id, {
        label: 'Modules',
        api_key: 'modules',
        field_type: 'rich_text',
        localized: false,
        validators: {
          rich_text_blocks: { item_types: [blockModel.id] },
        },
      });
      await client.fields.create(model.id, {
        label: 'Body',
        api_key: 'body',
        field_type: 'structured_text',
        localized: false,
        validators: {
          structured_text_blocks: { item_types: [blockModel.id] },
          structured_text_inline_blocks: { item_types: [blockModel.id] },
          structured_text_links: { item_types: [model.id] },
        },
      });

      const anchor = await client.items.create({
        item_type: { id: model.id, type: 'item_type' },
        title: 'stable anchor',
        payload: 'anchor',
        modules: [],
        body: emptyDast(),
      });
      await client.items.publish(anchor.id);

      return {
        itemTypeApiKeys: [apiKeys.model],
        runId,
        modelId: model.id,
        blockModelId: blockModel.id,
        anchorRecordId: anchor.id,
        blockCount,
        blockDepth,
      };
    },

    async introduceDrift({ seed, sourceClient, destinationClient }) {
      console.log(
        '[content-diff e2e] Creating source-only maximum recursive record',
      );
      const publishedFields = buildComplexStressFields({
        ...seed,
        variant: 'published',
      });
      const currentFields = buildComplexStressFields({
        ...seed,
        variant: 'current',
      });
      const record = await timedBoundaryPhase('source record create', () =>
        sourceClient.items.create({
          item_type: { id: seed.modelId, type: 'item_type' },
          ...publishedFields,
        }),
      );
      await timedBoundaryPhase('source record publish', () =>
        sourceClient.items.publish(record.id),
      );
      await timedBoundaryPhase('source record current update', () =>
        sourceClient.items.update(record.id, currentFields),
      );

      const [current, published, anchorCurrent, anchorPublished] =
        await Promise.all([
          timedBoundaryPhase('source CURRENT oracle capture', () =>
            captureRecord(sourceClient, seed.modelId, record.id, 'current'),
          ),
          timedBoundaryPhase('source PUBLISHED oracle capture', () =>
            captureRecord(sourceClient, seed.modelId, record.id, 'published'),
          ),
          timedBoundaryPhase('source anchor CURRENT oracle capture', () =>
            captureRecord(
              sourceClient,
              seed.modelId,
              seed.anchorRecordId,
              'current',
            ),
          ),
          timedBoundaryPhase('source anchor PUBLISHED oracle capture', () =>
            captureRecord(
              sourceClient,
              seed.modelId,
              seed.anchorRecordId,
              'published',
            ),
          ),
        ]);
      const [destinationAnchorCurrent, destinationAnchorPublished] =
        await Promise.all([
          timedBoundaryPhase('destination anchor CURRENT oracle capture', () =>
            captureRecord(
              destinationClient,
              seed.modelId,
              seed.anchorRecordId,
              'current',
            ),
          ),
          timedBoundaryPhase(
            'destination anchor PUBLISHED oracle capture',
            () =>
              captureRecord(
                destinationClient,
                seed.modelId,
                seed.anchorRecordId,
                'published',
              ),
          ),
        ]);

      assertComplexCoverage(current.fields, seed);
      assertComplexCoverage(published.fields, seed);
      assert.notDeepEqual(current.fields, published.fields);
      await timedBoundaryPhase('destination record absence check', () =>
        assertRecordAbsent(destinationClient, record.id),
      );

      return {
        stressRecordId: record.id,
        source: { current, published, anchorCurrent, anchorPublished },
        destinationAnchor: {
          current: destinationAnchorCurrent,
          published: destinationAnchorPublished,
        },
      };
    },

    async verify({
      seed,
      expected,
      sourceClient,
      destinationClient,
      appliedClient,
    }) {
      console.log(
        '[content-diff e2e] Verifying recursive limits and complete DAST grammar',
      );
      const [sourceCurrent, sourcePublished, appliedCurrent, appliedPublished] =
        await Promise.all([
          captureRecord(
            sourceClient,
            seed.modelId,
            expected.stressRecordId,
            'current',
          ),
          captureRecord(
            sourceClient,
            seed.modelId,
            expected.stressRecordId,
            'published',
          ),
          captureRecord(
            appliedClient,
            seed.modelId,
            expected.stressRecordId,
            'current',
          ),
          captureRecord(
            appliedClient,
            seed.modelId,
            expected.stressRecordId,
            'published',
          ),
        ]);
      assert.deepEqual(sourceCurrent, expected.source.current);
      assert.deepEqual(sourcePublished, expected.source.published);
      assert.deepEqual(appliedCurrent, expected.source.current);
      assert.deepEqual(appliedPublished, expected.source.published);
      assertComplexCoverage(appliedCurrent.fields, seed);
      assertComplexCoverage(appliedPublished.fields, seed);

      const [destinationAnchorCurrent, destinationAnchorPublished] =
        await Promise.all([
          captureRecord(
            destinationClient,
            seed.modelId,
            seed.anchorRecordId,
            'current',
          ),
          captureRecord(
            destinationClient,
            seed.modelId,
            seed.anchorRecordId,
            'published',
          ),
        ]);
      assert.deepEqual(
        destinationAnchorCurrent,
        expected.destinationAnchor.current,
      );
      assert.deepEqual(
        destinationAnchorPublished,
        expected.destinationAnchor.published,
      );
      assert.deepEqual(
        await captureRecord(
          appliedClient,
          seed.modelId,
          seed.anchorRecordId,
          'current',
        ),
        expected.source.anchorCurrent,
      );
      assert.deepEqual(
        await captureRecord(
          appliedClient,
          seed.modelId,
          seed.anchorRecordId,
          'published',
        ),
        expected.source.anchorPublished,
      );
    },
  };
}

function assertComplexCoverage(
  fields: unknown,
  limits: Pick<Seed, 'blockCount' | 'blockDepth'>,
): void {
  const analysis = analyzeComplexFields(fields);
  assert.equal(analysis.blockCount, limits.blockCount);
  assert.equal(new Set(analysis.blockIds).size, limits.blockCount);
  assert.equal(analysis.blockDepth, limits.blockDepth);
  assert.ok(
    analysis.serializedBytes >= 250_000,
    `complex record is only ${analysis.serializedBytes} bytes`,
  );
  for (const nodeType of [
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
    assert.ok(
      analysis.dastNodeTypes.includes(nodeType),
      `DAST grammar is missing ${nodeType}`,
    );
  }
}

function buildBlockChain(input: StressBuildInput, level: number): unknown {
  const children =
    level < input.blockDepth ? [buildBlockChain(input, level + 1)] : [];
  return buildBlock(
    input,
    `modules.chain.${level}`,
    children,
    `depth ${level}`,
  );
}

function buildBlock(
  input: StressBuildInput,
  path: string,
  nestedModules: readonly unknown[],
  label: string,
): unknown {
  return CmaClient.buildBlockRecord({
    id: deterministicBlockId(input.runId, path),
    item_type: { id: input.blockModelId, type: 'item_type' },
    label: `${input.variant} ${label}`,
    nested_modules: nestedModules,
  });
}

function buildDastGrammar(input: StressBuildInput): unknown {
  const block = buildBlock(input, 'body.block', [], 'body block');
  const inlineBlock = buildBlock(
    input,
    'body.inline_block',
    [],
    'body inline block',
  );
  return {
    schema: 'dast',
    document: {
      type: 'root',
      children: [
        {
          type: 'heading',
          level: 2,
          children: [
            {
              type: 'span',
              marks: ['strong', 'emphasis'],
              value: `${input.variant} heading`,
            },
          ],
        },
        {
          type: 'paragraph',
          children: [
            {
              type: 'span',
              marks: ['underline', 'strikethrough', 'highlight', 'code'],
              value: 'marked line one\nline two ',
            },
            {
              type: 'link',
              url: 'https://www.datocms.com/complex?lane=e2e',
              meta: [
                { id: 'rel', value: 'nofollow' },
                { id: 'target', value: '_blank' },
              ],
              children: [{ type: 'span', value: 'external link' }],
            },
            { type: 'inlineItem', item: input.anchorRecordId },
            {
              type: 'itemLink',
              item: input.anchorRecordId,
              meta: [{ id: 'rel', value: 'author' }],
              children: [{ type: 'span', value: 'record link' }],
            },
            { type: 'inlineBlock', item: inlineBlock },
          ],
        },
        {
          type: 'list',
          style: 'numbered',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'span', value: 'outer item' }],
                },
                {
                  type: 'list',
                  style: 'bulleted',
                  children: [
                    {
                      type: 'listItem',
                      children: [
                        {
                          type: 'paragraph',
                          children: [{ type: 'span', value: 'nested item' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'code',
          language: 'typescript',
          highlight: [0, 2],
          code: 'const one = 1;\nconst two = 2;\nreturn one + two;',
        },
        {
          type: 'blockquote',
          attribution: 'Content diff boundary fixture',
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'span', value: 'Exact recursive state.' }],
            },
          ],
        },
        { type: 'thematicBreak' },
        { type: 'block', item: block },
      ],
    },
  };
}

function emptyDast(): unknown {
  return {
    schema: 'dast',
    document: {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'span', value: 'anchor' }] },
      ],
    },
  };
}

function deterministicBlockId(runId: string, path: string): string {
  const bytes = createHash('sha256')
    .update(`content-diff-complex-recursive:${runId}:${path}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('base64url');
}

async function captureRecord(
  client: CmaClient.Client,
  itemTypeId: string,
  recordId: string,
  version: 'current' | 'published',
): Promise<CanonicalRecord> {
  const response = await client.items.rawFind(recordId, {
    nested: true,
    version,
  });
  const resource = response.data;
  assert.equal(resource.relationships.item_type.data.id, itemTypeId);
  return {
    id: resource.id,
    itemTypeId,
    status: String(resource.meta.status),
    currentValid:
      typeof resource.meta.is_current_version_valid === 'boolean'
        ? resource.meta.is_current_version_valid
        : null,
    publishedValid:
      typeof resource.meta.is_published_version_valid === 'boolean'
        ? resource.meta.is_published_version_valid
        : null,
    fields: canonicalizeValue(resource.attributes),
  };
}

async function timedBoundaryPhase<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  console.log(`[content-diff e2e] Starting ${label}`);
  try {
    const value = await operation();
    console.log(
      `[content-diff e2e] Finished ${label} in ${Date.now() - startedAt}ms`,
    );
    return value;
  } catch (error) {
    console.log(
      `[content-diff e2e] Failed ${label} after ${Date.now() - startedAt}ms`,
    );
    throw error;
  }
}

async function assertRecordAbsent(
  client: CmaClient.Client,
  recordId: string,
): Promise<void> {
  try {
    await client.items.find(recordId);
    assert.fail(`record ${recordId} unexpectedly exists`);
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return;
    }
    throw error;
  }
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (!isObject(value)) return value;
  if (isRawNestedBlock(value)) {
    const relationships = object(
      value.relationships,
      `${value.id}.relationships`,
    );
    const itemType = object(
      relationships.item_type,
      `${value.id}.relationships.item_type`,
    );
    const data = object(
      itemType.data,
      `${value.id}.relationships.item_type.data`,
    );
    return {
      id: value.id,
      itemTypeId: string(data.id, `${value.id}.itemTypeId`),
      attributes: canonicalizeValue(value.attributes),
    };
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareDatoIds(left, right))
      .map(([key, child]) => [key, canonicalizeValue(child)]),
  );
}

function isRawNestedBlock(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
} {
  return (
    value.type === 'item' &&
    typeof value.id === 'string' &&
    isObject(value.attributes) &&
    isObject(value.relationships)
  );
}

function isCanonicalBlock(value: Record<string, unknown>): value is {
  id: string;
  itemTypeId: string;
  attributes: Record<string, unknown>;
} {
  return (
    typeof value.id === 'string' &&
    typeof value.itemTypeId === 'string' &&
    isObject(value.attributes)
  );
}

function object(value: unknown, path: string): Record<string, unknown> {
  assert.ok(isObject(value), `${path} must be an object`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareDatoIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
