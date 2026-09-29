import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

const KINDS = ['modules', 'hero', 'body', 'inline_body'] as const;
type Kind = (typeof KINDS)[number];
const LOCALES = ['en', 'it'] as const;
const DEEP_PATH: readonly Kind[] = [
  'modules',
  'body',
  'inline_body',
  'hero',
  'modules',
];
type BuildInput = Readonly<{
  namespace: string;
  blockModelId: string;
  anchorId: string;
  variant: string;
}>;
type Seed = RealCmaScenarioSeed &
  Readonly<{
    runId: string;
    modelId: string;
    blockModelId: string;
    anchorId: string;
    updateId: string;
  }>;
type State = Readonly<{ current: unknown; published: unknown }>;
type Expected = Readonly<{
  createId: string;
  source: readonly State[];
  destination: readonly State[];
}>;

/** Two full levels cover every ordered pair; one branch continues to depth five. */
export function buildRecursiveCompositionFields(input: BuildInput) {
  const blockAt = (locale: string, path: readonly Kind[]): unknown => {
    const fields: Record<string, unknown> = {
      label: `${input.variant}:${locale}:${path.join('/')}`,
      peer: input.anchorId,
      opaque: JSON.stringify({
        type: 'item',
        id: 'json-is-not-a-block',
        attributes: { modules: ['json-is-not-a-reference'] },
        relationships: { item_type: { data: { id: input.blockModelId } } },
        document: {
          type: 'root',
          children: [{ type: 'inlineItem', item: 'opaque' }],
        },
      }),
    };
    for (const kind of KINDS) {
      const next = [...path, kind];
      const continues =
        path.length === 1 ||
        (next.length <= DEEP_PATH.length &&
          next.every((part, i) => part === DEEP_PATH[i]));
      fields[kind] = wrap(kind, continues ? blockAt(locale, next) : null);
    }
    const bytes = createHash('sha256')
      .update(`${input.namespace}:${locale}:${path.join('/')}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return CmaClient.buildBlockRecord({
      id: bytes.toString('base64url'),
      item_type: { type: 'item_type', id: input.blockModelId },
      ...fields,
    });
  };
  return Object.fromEntries([
    ['label', `${input.variant} owner`],
    ...KINDS.map((kind) => [
      kind,
      Object.fromEntries(
        LOCALES.map((locale) => [locale, wrap(kind, blockAt(locale, [kind]))]),
      ),
    ]),
  ]);
}

function wrap(kind: Kind, block: unknown): unknown {
  if (kind === 'modules') return block === null ? [] : [block];
  if (kind === 'hero') return block;
  const children =
    block === null
      ? [{ type: 'paragraph', children: [{ type: 'span', value: '' }] }]
      : kind === 'body'
        ? [{ type: 'block', item: block }]
        : [
            {
              type: 'paragraph',
              children: [
                { type: 'span', value: 'before ' },
                { type: 'inlineBlock', item: block },
                { type: 'span', value: ' after' },
              ],
            },
          ];
  return { schema: 'dast', document: { type: 'root', children } };
}

/** Independent typed-field oracle: never interprets arbitrary JSON as a block. */
export function inspectRecursiveComposition(fieldsValue: unknown) {
  const ids: string[] = [];
  const pairs = new Set<string>();
  let depth = 0;
  const normalizeBlock = (value: unknown, path: readonly Kind[]): unknown => {
    const block = object(value);
    assert.equal(block.type, 'item');
    assert.equal(typeof block.id, 'string');
    ids.push(String(block.id));
    depth = Math.max(depth, path.length);
    if (path.length > 1) pairs.add(path.slice(-2).join('>'));
    const attrs = object(block.attributes);
    const normalized = { ...attrs };
    for (const kind of KINDS)
      normalized[kind] = normalizeValue(kind, attrs[kind], path);
    return {
      id: block.id,
      itemTypeId: object(object(object(block.relationships).item_type).data).id,
      attributes: normalized,
    };
  };
  const normalizeValue = (
    kind: Kind,
    value: unknown,
    path: readonly Kind[],
  ): unknown => {
    if (kind === 'hero')
      return value === null ? null : normalizeBlock(value, [...path, kind]);
    if (kind === 'modules') {
      assert.ok(Array.isArray(value));
      return value.map((block) => normalizeBlock(block, [...path, kind]));
    }
    const walk = (nodeValue: unknown): unknown => {
      const node = object(nodeValue);
      if (node.type === 'block' || node.type === 'inlineBlock')
        return { ...node, item: normalizeBlock(node.item, [...path, kind]) };
      return Array.isArray(node.children)
        ? { ...node, children: node.children.map(walk) }
        : node;
    };
    const dast = object(value);
    return { ...dast, document: walk(dast.document) };
  };
  const fields = object(fieldsValue);
  const normalized = { ...fields };
  for (const kind of KINDS) {
    const localized = object(fields[kind]);
    assert.deepEqual(Object.keys(localized).sort(), [...LOCALES].sort());
    normalized[kind] = Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        normalizeValue(kind, localized[locale], []),
      ]),
    );
  }
  return { fields: normalized, ids, pairs: [...pairs].sort(), depth };
}

function assertCoverage(fields: unknown) {
  const result = inspectRecursiveComposition(fields);
  assert.equal(result.ids.length, 46);
  assert.equal(new Set(result.ids).size, 46);
  assert.equal(result.depth, 5);
  assert.deepEqual(
    result.pairs,
    KINDS.flatMap((parent) =>
      KINDS.map((child) => `${parent}>${child}`),
    ).sort(),
  );
  return result.fields;
}

function createRecursiveCompositionScenario(
  useFreshIds: boolean,
): RealCmaScenario<Seed, Expected> {
  return {
    name: useFreshIds
      ? 'all sixteen recursive container pairs with distinct baseline, published, and current block IDs'
      : 'all sixteen recursive container pairs with localized depth-five create and update',
    async seedSource({ client, runId }) {
      await client.site.update({ locales: [...LOCALES] });
      const suffix = createHash('sha256')
        .update(runId)
        .digest('hex')
        .slice(0, 12);
      const block = await client.itemTypes.create({
        name: `Composition block ${runId}`,
        api_key: `cde2e_cb_r${suffix}`,
        modular_block: true,
      });
      const model = await client.itemTypes.create({
        name: `Composition owner ${runId}`,
        api_key: `cde2e_co_r${suffix}`,
        draft_mode_active: true,
      });
      for (const itemTypeId of [model.id, block.id]) {
        await client.fields.create(itemTypeId, {
          label: 'Label',
          api_key: 'label',
          field_type: 'string',
          localized: false,
          validators: { required: {} },
        });
        for (const kind of KINDS) {
          const definition =
            kind === 'modules'
              ? {
                  field_type: 'rich_text' as const,
                  validators: { rich_text_blocks: { item_types: [block.id] } },
                }
              : kind === 'hero'
                ? {
                    field_type: 'single_block' as const,
                    validators: {
                      single_block_blocks: { item_types: [block.id] },
                    },
                  }
                : {
                    field_type: 'structured_text' as const,
                    validators: {
                      structured_text_blocks: { item_types: [block.id] },
                      structured_text_inline_blocks: { item_types: [block.id] },
                      structured_text_links: { item_types: [model.id] },
                    },
                  };
          await client.fields.create(itemTypeId, {
            label: kind,
            api_key: kind,
            ...definition,
            ...(itemTypeId === model.id
              ? { localized: true as const }
              : { localized: false as const }),
          });
        }
      }
      await client.fields.create(block.id, {
        label: 'Peer',
        api_key: 'peer',
        field_type: 'link',
        validators: { item_item_type: { item_types: [model.id] } },
      });
      await client.fields.create(block.id, {
        label: 'Opaque JSON',
        api_key: 'opaque',
        field_type: 'json',
        validators: {},
      });
      const anchor = await client.items.create({
        item_type: { type: 'item_type', id: model.id },
        label: 'stable anchor',
        ...Object.fromEntries(
          KINDS.map((kind) => [
            kind,
            Object.fromEntries(
              LOCALES.map((locale) => [locale, wrap(kind, null)]),
            ),
          ]),
        ),
      });
      await client.items.publish(anchor.id);
      const fields = buildRecursiveCompositionFields({
        namespace: `${runId}:update`,
        blockModelId: block.id,
        anchorId: anchor.id,
        variant: 'baseline',
      });
      assertCoverage(fields);
      const update = await client.items.create({
        item_type: { type: 'item_type', id: model.id },
        ...fields,
      });
      await client.items.publish(update.id);
      return {
        runId,
        modelId: model.id,
        blockModelId: block.id,
        anchorId: anchor.id,
        updateId: update.id,
        itemTypeApiKeys: [model.api_key],
      };
    },
    async introduceDrift({ seed, sourceClient, destinationClient }) {
      const build = (lane: string, variant: string) =>
        buildRecursiveCompositionFields({
          namespace: `${seed.runId}:${lane}${useFreshIds ? `:${variant}` : ''}`,
          blockModelId: seed.blockModelId,
          anchorId: seed.anchorId,
          variant,
        });
      if (useFreshIds) {
        const versions = [
          buildRecursiveCompositionFields({
            namespace: `${seed.runId}:update`,
            blockModelId: seed.blockModelId,
            anchorId: seed.anchorId,
            variant: 'baseline',
          }),
          ...['update', 'create'].flatMap((lane) =>
            ['published', 'current'].map((variant) => build(lane, variant)),
          ),
        ];
        const identities = versions.flatMap(
          (fields) => inspectRecursiveComposition(fields).ids,
        );
        assert.equal(identities.length, 230);
        assert.equal(new Set(identities).size, 230);
      }
      for (const variant of ['published', 'current']) {
        const before = await sourceClient.items.find(seed.updateId);
        await sourceClient.items.update(seed.updateId, {
          ...build('update', variant),
          meta: { current_version: before.meta.current_version },
        });
        if (variant === 'published')
          await sourceClient.items.publish(seed.updateId);
      }
      const created = await sourceClient.items.create({
        item_type: { type: 'item_type', id: seed.modelId },
        ...build('create', 'published'),
      });
      await sourceClient.items.publish(created.id);
      const before = await sourceClient.items.find(created.id);
      await sourceClient.items.update(created.id, {
        ...build('create', 'current'),
        meta: { current_version: before.meta.current_version },
      });
      const source = await captureAll(sourceClient, [
        seed.updateId,
        created.id,
        seed.anchorId,
      ]);
      const destination = await captureAll(destinationClient, [
        seed.updateId,
        seed.anchorId,
      ]);
      for (const state of source.slice(0, 2))
        assert.notDeepEqual(state.current, state.published);
      return { createId: created.id, source, destination };
    },
    async verifyGeneratedPlan({ seed, expected, planFilePath }) {
      const plan = object(
        object(JSON.parse(await readFile(planFilePath, 'utf8'))).plan,
      );
      assert.deepEqual(object(plan.invalidContent).skippedRecords, []);
      assert.ok(Array.isArray(plan.records));
      assert.deepEqual(
        plan.records
          .filter((value) => object(value).action !== 'noop')
          .map((value) => object(value).id)
          .sort(),
        [seed.updateId, expected.createId].sort(),
      );
    },
    async verify({
      seed,
      expected,
      sourceClient,
      destinationClient,
      appliedClient,
    }) {
      const ids = [seed.updateId, expected.createId, seed.anchorId];
      assert.deepEqual(await captureAll(sourceClient, ids), expected.source);
      assert.deepEqual(await captureAll(appliedClient, ids), expected.source);
      assert.deepEqual(
        await captureAll(destinationClient, [seed.updateId, seed.anchorId]),
        expected.destination,
      );
    },
  };
}

export const recursiveCompositionScenario =
  createRecursiveCompositionScenario(false);
export const freshRecursiveCompositionScenario =
  createRecursiveCompositionScenario(true);

async function captureAll(
  client: CmaClient.Client,
  ids: readonly string[],
): Promise<State[]> {
  const result: State[] = [];
  for (const [index, id] of ids.entries()) {
    const capture = async (version: 'current' | 'published') => {
      const { data } = await client.items.rawFind(id, {
        nested: true,
        version,
      });
      return {
        id: data.id,
        itemTypeId: data.relationships.item_type.data.id,
        status: data.meta.status,
        currentValid: data.meta.is_current_version_valid,
        publishedValid: data.meta.is_published_version_valid,
        fields:
          index < ids.length - 1
            ? assertCoverage(data.attributes)
            : data.attributes,
      };
    };
    result.push({
      current: await capture('current'),
      published: await capture('published'),
    });
  }
  return result;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
