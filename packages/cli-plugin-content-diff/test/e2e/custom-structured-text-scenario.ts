import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    blockModelId: string;
    decoyId: string;
  }>;

type BodyProjection = Readonly<{
  schema: string;
  documentType: string;
  decoy: Readonly<{ type: string; item: string }>;
  inlineItemId: string;
  itemLinkId: string;
  itemLinkText: string;
  block: Readonly<{
    id: string;
    itemTypeId: string;
    label: string;
    relatedId: string;
  }>;
}>;

type RecordProjection = Readonly<{
  id: string;
  title: string;
  body: BodyProjection | null;
  status: string;
  currentValid: boolean | null;
  publishedValid: boolean | null;
}>;

type EnvironmentProjection = Readonly<{
  current: readonly RecordProjection[];
  published: readonly RecordProjection[];
}>;

type Expected = Readonly<{
  ownerId: string;
  peerId: string;
  source: EnvironmentProjection;
  destination: EnvironmentProjection;
}>;

export function customStructuredTextApiKeys(runId: string): {
  model: string;
  block: string;
} {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return {
    model: `cde2e_cs_r${suffix}`,
    block: `cde2e_cb_r${suffix}`,
  };
}

export function buildCustomStructuredTextBody(
  peerId: string,
  decoyId: string,
  block: unknown,
) {
  return {
    schema: 'custom-content-v1',
    document: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'inlineItem', item: peerId },
            {
              type: 'itemLink',
              item: peerId,
              children: [{ type: 'span', value: 'real linked label' }],
            },
          ],
        },
        { type: 'block', item: block },
      ],
      sidecar: { type: 'inlineItem', item: decoyId },
    },
  };
}

export const customStructuredTextScenario: RealCmaScenario<Seed, Expected> = {
  name: 'custom Structured Text follows children only',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating custom Structured Text schema');
    const apiKeys = customStructuredTextApiKeys(runId);
    const blockModel = await client.itemTypes.create({
      name: `Custom Structured Text block ${runId}`,
      api_key: apiKeys.block,
      modular_block: true,
    });
    await client.fields.create(blockModel.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const model = await client.itemTypes.create({
      name: `Custom Structured Text owner ${runId}`,
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
      label: 'Related',
      api_key: 'related',
      field_type: 'link',
      localized: false,
      validators: { item_item_type: relationshipValidator(model.id) },
    });
    await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(model.id, {
      label: 'Body',
      api_key: 'body',
      field_type: 'structured_text',
      localized: false,
      validators: {
        structured_text_links: relationshipValidator(model.id),
        structured_text_blocks: { item_types: [blockModel.id] },
      },
    });

    return {
      itemTypeApiKeys: [apiKeys.model],
      modelId: model.id,
      blockModelId: blockModel.id,
      decoyId: portableId(`${runId}:decoy`),
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating real children references and an inert sidecar decoy',
    );
    const peer = await sourceClient.items.create({
      item_type: { id: seed.modelId, type: 'item_type' },
      title: 'real peer',
      body: null,
    });
    await sourceClient.items.publish(peer.id);
    const nestedBlock = CmaClient.buildBlockRecord({
      item_type: { id: seed.blockModelId, type: 'item_type' },
      label: 'real nested block',
      related: peer.id,
    });
    const owner = await sourceClient.items.create({
      item_type: { id: seed.modelId, type: 'item_type' },
      title: 'custom body owner',
      body: buildCustomStructuredTextBody(peer.id, seed.decoyId, nestedBlock),
    } as never);
    await sourceClient.items.publish(owner.id);

    const [source, destination] = await Promise.all([
      captureCustomStructuredTextEnvironment(sourceClient, seed.modelId),
      captureCustomStructuredTextEnvironment(destinationClient, seed.modelId),
    ]);
    assert.deepEqual(destination, { current: [], published: [] });
    assertFixture(source, {
      ownerId: owner.id,
      peerId: peer.id,
      decoyId: seed.decoyId,
      blockModelId: seed.blockModelId,
    });
    return { ownerId: owner.id, peerId: peer.id, source, destination };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const envelope = object(JSON.parse(await readFile(planFilePath, 'utf8')));
    const plan = object(envelope.plan);
    const records = array(plan.records).map((entry) => object(entry));
    assert.deepEqual(
      records.map(({ id }) => String(id)).sort(),
      [expected.ownerId, expected.peerId].sort(),
    );
    const owner = records.find(({ id }) => id === expected.ownerId);
    assert.ok(owner, 'generated plan omitted the custom Structured Text owner');
    assert.deepEqual(array(owner.dependencies).map(String), [expected.peerId]);
    assert.equal(array(owner.dependencies).includes(seed.decoyId), false);
    const desired = object(owner.desired);
    const current = object(desired.current);
    const fields = object(current.fields);
    const body = object(fields.body);
    const document = object(body.document);
    assert.deepEqual(object(document.sidecar), {
      type: 'inlineItem',
      item: seed.decoyId,
    });
    const children = array(document.children);
    const paragraph = object(children[0]);
    const paragraphChildren = array(paragraph.children).map((entry) =>
      object(entry),
    );
    assert.equal(paragraphChildren[0].item, expected.peerId);
    assert.equal(paragraphChildren[1].item, expected.peerId);
    assert.equal(object(children[1]).type, 'block');
    assert.deepEqual(array(object(plan.invalidContent).skippedRecords), []);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    const [source, destination, applied] = await Promise.all([
      captureCustomStructuredTextEnvironment(sourceClient, seed.modelId),
      captureCustomStructuredTextEnvironment(destinationClient, seed.modelId),
      captureCustomStructuredTextEnvironment(appliedClient, seed.modelId),
    ]);
    assert.deepEqual(source, expected.source, 'source fixture changed');
    assert.deepEqual(destination, expected.destination, 'destination changed');
    assert.deepEqual(
      applied,
      expected.source,
      'applied custom content differs',
    );
    assertFixture(applied, {
      ownerId: expected.ownerId,
      peerId: expected.peerId,
      decoyId: seed.decoyId,
      blockModelId: seed.blockModelId,
    });
  },
};

function relationshipValidator(modelId: string) {
  return {
    item_types: [modelId],
    on_publish_with_unpublished_references_strategy: 'fail' as const,
    on_reference_unpublish_strategy: 'delete_references' as const,
    on_reference_delete_strategy: 'delete_references' as const,
  };
}

function portableId(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('base64url');
}

export async function captureCustomStructuredTextEnvironment(
  client: CmaClient.Client,
  modelId: string,
): Promise<EnvironmentProjection> {
  const [current, published] = await Promise.all(
    (['current', 'published'] as const).map((version) =>
      captureVersion(client, modelId, version),
    ),
  );
  return { current, published };
}

async function captureVersion(
  client: CmaClient.Client,
  modelId: string,
  version: 'current' | 'published',
): Promise<RecordProjection[]> {
  const records: RecordProjection[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;

  while (expectedTotal === null || records.length < expectedTotal) {
    const response = object(
      await client.items.rawList({
        filter: { type: modelId },
        version,
        nested: true,
        order_by: 'id_ASC',
        page: { offset: records.length, limit: 30 },
      }),
      `${version} custom Structured Text response`,
    );
    const page = array(
      response.data,
      `${version} custom Structured Text response.data`,
    );
    const totalCount = object(
      response.meta,
      `${version} custom Structured Text response.meta`,
    ).total_count;
    assert.ok(
      Number.isInteger(totalCount) && Number(totalCount) >= 0,
      `${version} custom Structured Text response has invalid total_count`,
    );
    if (expectedTotal === null) expectedTotal = Number(totalCount);
    assert.equal(
      Number(totalCount),
      expectedTotal,
      `${version} custom Structured Text total_count changed during capture`,
    );
    assert.ok(
      page.length > 0 || records.length >= expectedTotal,
      `${version} custom Structured Text pagination ended before total_count`,
    );

    for (const entry of page) {
      const projected = projectRecord(entry);
      assert.equal(
        seen.has(projected.id),
        false,
        `${version} custom Structured Text returned duplicate ID ${projected.id}`,
      );
      seen.add(projected.id);
      records.push(projected);
    }
    assert.ok(
      records.length <= expectedTotal,
      `${version} custom Structured Text returned more records than total_count`,
    );
  }

  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function projectRecord(input: unknown): RecordProjection {
  const record = object(input, 'record');
  const attributes = object(
    record.attributes,
    `${String(record.id)}.attributes`,
  );
  const meta = object(record.meta, `${String(record.id)}.meta`);
  return {
    id: string(record.id, 'record.id'),
    title: string(attributes.title, `${String(record.id)}.title`),
    body: attributes.body === null ? null : projectBody(attributes.body),
    status: string(meta.status, `${String(record.id)}.meta.status`),
    currentValid: nullableBoolean(meta.is_current_version_valid),
    publishedValid: nullableBoolean(meta.is_published_version_valid),
  };
}

function projectBody(input: unknown): BodyProjection {
  const body = object(input, 'body');
  const document = object(body.document, 'body.document');
  const children = array(document.children, 'body.document.children');
  assert.equal(children.length, 2);
  const paragraph = object(children[0], 'body.document.children[0]');
  const paragraphChildren = array(
    paragraph.children,
    'body.document.children[0].children',
  ).map((entry) => object(entry));
  assert.equal(paragraphChildren.length, 2);
  const itemLinkChildren = array(paragraphChildren[1].children).map((entry) =>
    object(entry),
  );
  const blockNode = object(children[1], 'body.document.children[1]');
  const block = object(blockNode.item, 'body.document.children[1].item');
  const attributes = Object.prototype.hasOwnProperty.call(block, 'attributes')
    ? object(block.attributes, 'block.attributes')
    : block;
  return {
    schema: string(body.schema, 'body.schema'),
    documentType: string(document.type, 'body.document.type'),
    decoy: {
      type: string(object(document.sidecar).type, 'body.document.sidecar.type'),
      item: string(object(document.sidecar).item, 'body.document.sidecar.item'),
    },
    inlineItemId: string(paragraphChildren[0].item, 'inlineItem.item'),
    itemLinkId: string(paragraphChildren[1].item, 'itemLink.item'),
    itemLinkText: string(
      itemLinkChildren[0].value,
      'itemLink.children[0].value',
    ),
    block: {
      id: string(block.id, 'block.id'),
      itemTypeId: nestedItemTypeId(block),
      label: string(attributes.label, 'block.label'),
      relatedId: referenceId(attributes.related, 'block.related'),
    },
  };
}

function assertFixture(
  state: EnvironmentProjection,
  seed: Readonly<{
    ownerId: string;
    peerId: string;
    decoyId: string;
    blockModelId: string;
  }>,
): void {
  for (const slice of [state.current, state.published]) {
    assert.deepEqual(
      slice.map(({ id }) => id).sort(),
      [seed.ownerId, seed.peerId].sort(),
    );
    const owner = slice.find(({ id }) => id === seed.ownerId);
    assert.ok(owner?.body, 'owner custom body is missing');
    assert.equal(owner.body.schema, 'custom-content-v1');
    assert.equal(owner.body.documentType, 'root');
    assert.deepEqual(owner.body.decoy, {
      type: 'inlineItem',
      item: seed.decoyId,
    });
    assert.equal(owner.body.inlineItemId, seed.peerId);
    assert.equal(owner.body.itemLinkId, seed.peerId);
    assert.equal(owner.body.itemLinkText, 'real linked label');
    assert.equal(owner.body.block.itemTypeId, seed.blockModelId);
    assert.equal(owner.body.block.label, 'real nested block');
    assert.equal(owner.body.block.relatedId, seed.peerId);
  }
}

function nestedItemTypeId(block: Record<string, unknown>): string {
  const relationships = object(block.relationships, 'block.relationships');
  const itemType = object(relationships.item_type, 'block.item_type');
  return string(
    object(itemType.data, 'block.item_type.data').id,
    'block item type',
  );
}

function referenceId(value: unknown, path: string): string {
  if (typeof value === 'string') return value;
  return string(object(value, path).id, `${path}.id`);
}

function nullableBoolean(value: unknown): boolean | null {
  assert.ok(value === null || typeof value === 'boolean');
  return value;
}

function object(value: unknown, path = 'value'): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), path);
  return value as Record<string, unknown>;
}

function array(value: unknown, path = 'value'): unknown[] {
  assert.ok(Array.isArray(value), path);
  return value;
}

function string(value: unknown, path: string): string {
  assert.equal(typeof value, 'string', path);
  return value as string;
}
