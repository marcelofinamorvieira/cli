import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CmaClient } from '@datocms/cli-utils';
import { deterministicPortableDatoId } from '../../src/content-diff/legacy-ids';
import type { ScenarioCancellation } from '../e2e/scenario-cancellation';

export const CROSS_PROJECT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type LeafDefinition = CmaClient.ItemTypeDefinition<
  { locales: string },
  string,
  {
    caption: { type: 'string'; localized: false };
    image: { type: 'file'; localized: false };
    peer: { type: 'link'; localized: false };
    opaque: { type: 'json'; localized: false };
  }
>;
type InlineDefinition = CmaClient.ItemTypeDefinition<
  { locales: string },
  string,
  {
    label: { type: 'string'; localized: false };
    inline_body: {
      type: 'structured_text';
      localized: false;
      inline_blocks: LeafDefinition;
    };
  }
>;
type BodyDefinition = CmaClient.ItemTypeDefinition<
  { locales: string },
  string,
  {
    label: { type: 'string'; localized: false };
    body: {
      type: 'structured_text';
      localized: false;
      blocks: InlineDefinition;
    };
  }
>;
type ModuleDefinition = CmaClient.ItemTypeDefinition<
  { locales: string },
  string,
  {
    label: { type: 'string'; localized: false };
    hero: { type: 'single_block'; localized: false; blocks: BodyDefinition };
  }
>;
export type CrossProjectRecordDefinition = CmaClient.ItemTypeDefinition<
  { locales: string },
  string,
  {
    title: { type: 'string'; localized: false };
    related: { type: 'link'; localized: false };
    modules: { type: 'rich_text'; localized: false; blocks: ModuleDefinition };
  }
>;

const ID_KEYS = [
  'model',
  'moduleModel',
  'bodyModel',
  'inlineModel',
  'leafModel',
  'titleField',
  'relatedField',
  'modulesField',
  'moduleLabelField',
  'heroField',
  'bodyLabelField',
  'bodyField',
  'inlineLabelField',
  'inlineBodyField',
  'captionField',
  'imageField',
  'peerField',
  'opaqueField',
  'baselineRecord',
  'sourceOnlyRecord',
  'destinationOnlyRecord',
] as const;
type FixtureIds = Readonly<Record<(typeof ID_KEYS)[number], string>>;
export type CrossProjectFixture = Readonly<{
  ids: FixtureIds;
  modelApiKey: string;
  runId: string;
}>;
export type FixtureLane = 'baseline' | 'source' | 'destination';
type CapturedRecord = Readonly<{
  id: string;
  itemTypeId: string;
  fields: Record<string, unknown>;
  status: string;
  currentValid: boolean;
  publishedValid: boolean | null;
}>;
export type CrossProjectCapturedState = Readonly<{
  current: Readonly<Record<string, CapturedRecord>>;
  published: Readonly<Record<string, CapturedRecord>>;
}>;

export function alignedFixtureIds(seed: string): FixtureIds {
  return Object.fromEntries(
    ID_KEYS.map((key) => [key, deterministicPortableDatoId(`${seed}:${key}`)]),
  ) as FixtureIds;
}

export function crossProjectFixture(runId: string): CrossProjectFixture {
  return {
    runId,
    ids: alignedFixtureIds(runId),
    modelApiKey: `cpx_r${createHash('sha256')
      .update(runId)
      .digest('hex')
      .slice(0, 12)}`,
  };
}

export function fixtureBlockIds(
  fixture: CrossProjectFixture,
  lane: FixtureLane,
): string[] {
  return ['module', 'body', 'inline', 'leaf'].map((kind) =>
    deterministicPortableDatoId(`${fixture.runId}:${lane}:block:${kind}`),
  );
}

export function buildCrossProjectFields(
  fixture: CrossProjectFixture,
  lane: FixtureLane,
  variant: string,
  uploadId: string | null,
): CmaClient.ToItemAttributesInRequest<CrossProjectRecordDefinition> {
  const [moduleId, bodyId, inlineId, leafId] = fixtureBlockIds(fixture, lane);
  const peer = lane === 'baseline' ? null : fixture.ids.baselineRecord;
  const leaf = wireBlock<LeafDefinition>(leafId, fixture.ids.leafModel, {
    caption: `${lane} ${variant} leaf`,
    image:
      uploadId === null
        ? null
        : {
            upload_id: uploadId,
            alt: `${variant} alt`,
            title: `${variant} image`,
            custom_data: { lane, variant },
            focal_point: { x: 0.25, y: 0.75 },
            poster_time: null,
          },
    peer,
    opaque: JSON.stringify({
      variant,
      type: 'item',
      id: '123456',
      attributes: {
        image: { upload_id: 'opaque-upload' },
        peer: 'opaque-record',
      },
      relationships: {
        item_type: { data: { id: fixture.ids.leafModel, type: 'item_type' } },
      },
      document: {
        type: 'root',
        children: [{ type: 'inlineItem', item: 'opaque-reference' }],
      },
    }),
  });
  const inline = wireBlock<InlineDefinition>(
    inlineId,
    fixture.ids.inlineModel,
    {
      label: `${lane} ${variant} inline container`,
      inline_body: {
        schema: 'dast',
        document: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'span', value: `${variant} before ` },
                { type: 'inlineBlock', item: leaf },
                { type: 'span', value: ' after' },
              ],
            },
          ],
        },
      },
    },
  );
  const body = wireBlock<BodyDefinition>(bodyId, fixture.ids.bodyModel, {
    label: `${lane} ${variant} block container`,
    body: {
      schema: 'dast',
      document: { type: 'root', children: [{ type: 'block', item: inline }] },
    },
  });
  const module = wireBlock<ModuleDefinition>(
    moduleId,
    fixture.ids.moduleModel,
    {
      label: `${lane} ${variant} module`,
      hero: body,
    },
  );
  return { title: `${lane} ${variant}`, related: peer, modules: [module] };
}

function wireBlock<D extends CmaClient.ItemTypeDefinition>(
  id: string,
  modelId: CmaClient.RawApiTypes.ItemTypeData<D>['id'],
  attributes: CmaClient.ToItemAttributesInRequest<D>,
): CmaClient.UpdatedBlockInRequest<D> {
  return {
    id,
    type: 'item',
    attributes,
    relationships: { item_type: { data: { id: modelId, type: 'item_type' } } },
  };
}

export async function seedAlignedFixture(
  source: CmaClient.Client,
  destination: CmaClient.Client,
  runId: string,
): Promise<CrossProjectFixture> {
  const fixture = crossProjectFixture(runId);
  const { ids } = fixture;
  for (const client of [source, destination]) {
    for (const [id, suffix] of [
      [ids.model, ''],
      [ids.moduleModel, '_module'],
      [ids.bodyModel, '_body'],
      [ids.inlineModel, '_inline'],
      [ids.leafModel, '_leaf'],
    ]) {
      const model = await client.itemTypes.create({
        id,
        name: `Cross-project ${runId}${suffix}`,
        api_key: `${fixture.modelApiKey}${suffix}`,
        modular_block: id !== ids.model,
        ...(id === ids.model
          ? {
              singleton: false,
              all_locales_required: false,
              sortable: false,
              draft_mode_active: true,
              draft_saving_active: true,
              tree: false,
              collection_appearance: 'compact' as const,
              inverse_relationships_enabled: false,
            }
          : {}),
      });
      assert.equal(model.id, id);
    }
    const createField = (
      model: string,
      definition: CmaClient.ApiTypes.FieldCreateSchema,
    ) => client.fields.create(model, definition);
    for (const [model, id, apiKey] of [
      [ids.model, ids.titleField, 'title'],
      [ids.moduleModel, ids.moduleLabelField, 'label'],
      [ids.bodyModel, ids.bodyLabelField, 'label'],
      [ids.inlineModel, ids.inlineLabelField, 'label'],
      [ids.leafModel, ids.captionField, 'caption'],
    ])
      await createField(model, {
        id,
        label: apiKey,
        api_key: apiKey,
        field_type: 'string',
        localized: false,
        validators: { required: {} },
      });
    for (const [model, id, apiKey] of [
      [ids.model, ids.relatedField, 'related'],
      [ids.leafModel, ids.peerField, 'peer'],
    ])
      await createField(model, {
        id,
        label: apiKey,
        api_key: apiKey,
        field_type: 'link',
        localized: false,
        validators: { item_item_type: { item_types: [ids.model] } },
      });
    await createField(ids.model, {
      id: ids.modulesField,
      label: 'Modules',
      api_key: 'modules',
      field_type: 'rich_text',
      localized: false,
      validators: { rich_text_blocks: { item_types: [ids.moduleModel] } },
    });
    await createField(ids.moduleModel, {
      id: ids.heroField,
      label: 'Hero',
      api_key: 'hero',
      field_type: 'single_block',
      localized: false,
      validators: { single_block_blocks: { item_types: [ids.bodyModel] } },
    });
    await createField(ids.bodyModel, {
      id: ids.bodyField,
      label: 'Body',
      api_key: 'body',
      field_type: 'structured_text',
      localized: false,
      validators: {
        structured_text_blocks: { item_types: [ids.inlineModel] },
        structured_text_inline_blocks: { item_types: [] },
        structured_text_links: { item_types: [] },
      },
    });
    await createField(ids.inlineModel, {
      id: ids.inlineBodyField,
      label: 'Inline body',
      api_key: 'inline_body',
      field_type: 'structured_text',
      localized: false,
      validators: {
        structured_text_blocks: { item_types: [] },
        structured_text_inline_blocks: { item_types: [ids.leafModel] },
        structured_text_links: { item_types: [] },
      },
    });
    await createField(ids.leafModel, {
      id: ids.imageField,
      label: 'Image',
      api_key: 'image',
      field_type: 'file',
      localized: false,
      validators: {},
    });
    await createField(ids.leafModel, {
      id: ids.opaqueField,
      label: 'Opaque JSON',
      api_key: 'opaque',
      field_type: 'json',
      localized: false,
      validators: {},
    });
    const baseline = await client.items.create<CrossProjectRecordDefinition>({
      id: ids.baselineRecord,
      item_type: { id: ids.model, type: 'item_type' },
      ...buildCrossProjectFields(fixture, 'baseline', 'shared', null),
    });
    assert.equal(baseline.id, ids.baselineRecord);
    await client.items.publish(baseline.id);
  }
  return fixture;
}

export async function introduceCrossProjectDrift(input: {
  source: CmaClient.Client;
  destination: CmaClient.Client;
  fixture: CrossProjectFixture;
  workspace: string;
  cancellation: ScenarioCancellation;
}): Promise<string> {
  const { source, destination, fixture, cancellation } = input;
  cancellation.throwIfAborted();
  const localPath = join(input.workspace, 'cross-project-fixture.png');
  await writeFile(localPath, CROSS_PROJECT_PNG);
  const upload = await source.uploads.createFromLocalFile({
    localPath,
    filename: 'cross-project-fixture.png',
    skipCreationIfAlreadyExists: false,
    author: 'Cross-project fixture',
    notes: 'Source-only bundled PNG',
  });
  await waitForFixtureUpload(source, upload.id, cancellation);
  for (const variant of ['published', 'current']) {
    cancellation.throwIfAborted();
    await source.items.update<CrossProjectRecordDefinition>(
      fixture.ids.baselineRecord,
      buildCrossProjectFields(fixture, 'baseline', variant, upload.id),
    );
    if (variant === 'published')
      await source.items.publish(fixture.ids.baselineRecord);
  }
  const created = await source.items.create<CrossProjectRecordDefinition>({
    id: fixture.ids.sourceOnlyRecord,
    item_type: { id: fixture.ids.model, type: 'item_type' },
    ...buildCrossProjectFields(fixture, 'source', 'published', upload.id),
  });
  assert.equal(created.id, fixture.ids.sourceOnlyRecord);
  await source.items.publish(created.id);
  await source.items.update<CrossProjectRecordDefinition>(
    created.id,
    buildCrossProjectFields(fixture, 'source', 'current', upload.id),
  );
  cancellation.throwIfAborted();
  await destination.items.update<CrossProjectRecordDefinition>(
    fixture.ids.baselineRecord,
    buildCrossProjectFields(fixture, 'baseline', 'destination drift', null),
  );
  await destination.items.publish(fixture.ids.baselineRecord);
  const retained = await destination.items.create<CrossProjectRecordDefinition>(
    {
      id: fixture.ids.destinationOnlyRecord,
      item_type: { id: fixture.ids.model, type: 'item_type' },
      ...buildCrossProjectFields(
        fixture,
        'destination',
        'retained published',
        null,
      ),
    },
  );
  assert.equal(retained.id, fixture.ids.destinationOnlyRecord);
  await destination.items.publish(retained.id);
  await destination.items.update<CrossProjectRecordDefinition>(
    retained.id,
    buildCrossProjectFields(fixture, 'destination', 'retained current', null),
  );
  return upload.id;
}

async function waitForFixtureUpload(
  client: CmaClient.Client,
  id: string,
  cancellation: ScenarioCancellation,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (true) {
    cancellation.throwIfAborted();
    const { data } = await client.uploads.rawFind(id);
    const status = data.meta.antivirus?.status;
    if (status === 'clean') return;
    assert.equal(
      status,
      'pending',
      'fixture upload antivirus did not report a usable status',
    );
    assert.ok(
      Date.now() < deadline,
      'fixture upload antivirus remained pending for two minutes',
    );
    await delay(500, undefined, { signal: cancellation.signal });
  }
}

/** Follows only the four declared embedding fields; all other attributes stay opaque. */
export function inspectCrossProjectFields(
  value: unknown,
  fixture: CrossProjectFixture,
) {
  const ids: string[] = [];
  const normalizeBlock = (
    value: unknown,
    modelId: string,
    level: number,
  ): Record<string, unknown> => {
    const raw = object(value);
    assert.equal(raw.type, 'item');
    assert.equal(typeof raw.id, 'string');
    ids.push(raw.id as string);
    assert.equal(
      object(object(object(raw.relationships).item_type).data).id,
      modelId,
    );
    const attributes = { ...object(raw.attributes) };
    if (level === 0)
      attributes.hero = normalizeBlock(
        attributes.hero,
        fixture.ids.bodyModel,
        1,
      );
    else if (level === 1)
      attributes.body = normalizeDocument(
        attributes.body,
        'block',
        fixture.ids.inlineModel,
        2,
      );
    else if (level === 2)
      attributes.inline_body = normalizeDocument(
        attributes.inline_body,
        'inlineBlock',
        fixture.ids.leafModel,
        3,
      );
    else {
      assert.equal(typeof attributes.caption, 'string');
      assert.equal(typeof attributes.opaque, 'string');
      assert.ok(
        attributes.peer === null || typeof attributes.peer === 'string',
      );
      if (attributes.image !== null)
        assert.equal(typeof object(attributes.image).upload_id, 'string');
    }
    const { meta: _ignoredBlockMeta, ...record } = raw;
    return { ...record, attributes };
  };
  const normalizeDocument = (
    value: unknown,
    kind: 'block' | 'inlineBlock',
    modelId: string,
    level: number,
  ): Record<string, unknown> => {
    const dast = object(value);
    let embedded = 0;
    const walk = (value: unknown): Record<string, unknown> => {
      const node = object(value);
      if (node.type === 'block' || node.type === 'inlineBlock') {
        assert.equal(node.type, kind);
        embedded += 1;
        return { ...node, item: normalizeBlock(node.item, modelId, level) };
      }
      return Array.isArray(node.children)
        ? { ...node, children: node.children.map(walk) }
        : node;
    };
    const result = { ...dast, document: walk(dast.document) };
    assert.equal(embedded, 1);
    return result;
  };
  const fields = { ...object(value) };
  assert.equal(typeof fields.title, 'string');
  assert.ok(fields.related === null || typeof fields.related === 'string');
  assert.ok(Array.isArray(fields.modules));
  assert.equal(fields.modules.length, 1);
  fields.modules = fields.modules.map((entry) =>
    normalizeBlock(entry, fixture.ids.moduleModel, 0),
  );
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
  return { fields, ids };
}

export async function captureFixtureState(
  client: CmaClient.Client,
  fixture: CrossProjectFixture,
): Promise<CrossProjectCapturedState> {
  const capture = async (version: 'current' | 'published') => {
    const response = await client.items.rawList<CrossProjectRecordDefinition>({
      filter: { type: fixture.ids.model },
      nested: true,
      version,
      page: { offset: 0, limit: 30 },
    });
    assert.equal(
      response.meta.total_count,
      response.data.length,
      'fixture snapshot was truncated',
    );
    assert.ok(
      response.data.length === 2 || response.data.length === 3,
      'unexpected fixture records',
    );
    const records = response.data.map((record): [string, CapturedRecord] => {
      assert.equal(record.relationships.item_type.data.id, fixture.ids.model);
      assert.equal(typeof record.meta.status, 'string');
      assert.equal(typeof record.meta.is_current_version_valid, 'boolean');
      assert.ok(
        record.meta.is_published_version_valid === null ||
          typeof record.meta.is_published_version_valid === 'boolean',
      );
      const lane =
        record.id === fixture.ids.baselineRecord
          ? 'baseline'
          : record.id === fixture.ids.sourceOnlyRecord
            ? 'source'
            : record.id === fixture.ids.destinationOnlyRecord
              ? 'destination'
              : null;
      assert.ok(lane, 'unexpected fixture record identity');
      const inspected = inspectCrossProjectFields(record.attributes, fixture);
      assert.deepEqual(
        inspected.ids,
        fixtureBlockIds(fixture, lane),
        'nested fixture identities changed',
      );
      assert.equal(
        record.meta.is_current_version_valid,
        true,
        'fixture CURRENT must be valid',
      );
      assert.equal(
        record.meta.is_published_version_valid,
        true,
        'fixture PUBLISHED must be valid',
      );
      return [
        record.id,
        {
          id: record.id,
          itemTypeId: record.relationships.item_type.data.id,
          fields: inspected.fields,
          status: record.meta.status!,
          currentValid: record.meta.is_current_version_valid!,
          publishedValid: record.meta.is_published_version_valid,
        },
      ];
    });
    assert.equal(
      new Set(records.map(([id]) => id)).size,
      records.length,
      'duplicate fixture record',
    );
    return Object.fromEntries(records);
  };
  return {
    current: await capture('current'),
    published: await capture('published'),
  };
}

export function assertAppliedState(input: {
  applied: CrossProjectCapturedState;
  source: CrossProjectCapturedState;
  destination: CrossProjectCapturedState;
  fixture: CrossProjectFixture;
}): void {
  const expectedIds = [
    input.fixture.ids.baselineRecord,
    input.fixture.ids.sourceOnlyRecord,
    input.fixture.ids.destinationOnlyRecord,
  ].sort();
  for (const version of ['current', 'published'] as const) {
    assert.deepEqual(
      Object.keys(input.applied[version]).sort(),
      expectedIds,
      `unexpected applied ${version} record set`,
    );
    for (const id of [
      input.fixture.ids.baselineRecord,
      input.fixture.ids.sourceOnlyRecord,
    ])
      assert.deepEqual(
        input.applied[version][id],
        input.source[version][id],
        `source ${version} content did not converge for ${id}`,
      );
    assert.deepEqual(
      input.applied[version][input.fixture.ids.destinationOnlyRecord],
      input.destination[version][input.fixture.ids.destinationOnlyRecord],
      `destination-only ${version} content changed`,
    );
  }
}

export function assertFixturePngBytes(bytes: Uint8Array, label: string): void {
  assert.deepEqual(
    Buffer.from(bytes),
    CROSS_PROJECT_PNG,
    `${label} differs from the known PNG bytes`,
  );
}

export async function readBundledFixturePng(
  plan: unknown,
  planFilePath: string,
  uploadId: string,
): Promise<Buffer> {
  const uploads = object(plan).uploads;
  assert.ok(Array.isArray(uploads));
  assert.equal(
    uploads.length,
    1,
    'fixture should reference exactly one upload',
  );
  const upload = object(uploads[0]);
  assert.equal(upload.id, uploadId);
  assert.equal(
    upload.action,
    'create',
    'source-only PNG must be created in the destination',
  );
  const transport = object(object(upload.desired).transport);
  assert.equal(typeof transport.bundledPath, 'string', 'PNG is not bundled');
  const assetPath = resolve(
    dirname(planFilePath),
    transport.bundledPath as string,
  );
  const localRelative = relative(dirname(planFilePath), assetPath);
  assert.ok(
    !isAbsolute(localRelative) &&
      localRelative !== '..' &&
      !localRelative.startsWith('../'),
  );
  const bytes = await readFile(assetPath);
  assertFixturePngBytes(bytes, 'bundled asset');
  assert.equal(
    transport.sha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  return bytes;
}

export async function assertUploadedFixturePng(
  client: CmaClient.Client,
  uploadId: string,
  cancellation: ScenarioCancellation,
  bundledBytes?: Uint8Array,
): Promise<void> {
  cancellation.throwIfAborted();
  const upload = await client.uploads.find(uploadId);
  assert.equal(upload.id, uploadId);
  const response = await cancellation.fetchFn(upload.url);
  assert.equal(
    response.ok,
    true,
    `fixture PNG download failed: ${response.status}`,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  assertFixturePngBytes(bytes, 'uploaded asset');
  if (bundledBytes)
    assert.deepEqual(
      bytes,
      Buffer.from(bundledBytes),
      'destination PNG differs from bundled bytes',
    );
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
