import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import { RUNTIME_VERSION } from '../../src/content-diff/runtime-template';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Mode = 'preserve' | 'relax';

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    blockModelId: string;
    leafBlockModelId: string;
    peerFieldId: string;
    peersFieldId: string;
    bodyFieldId: string;
    blockBodyFieldId: string;
  }>;

type Expected = Readonly<{
  recordIds: readonly [string, string];
  destination: Awaited<ReturnType<typeof captureRecords>>;
  validators: Awaited<ReturnType<typeof captureValidators>>;
}>;

const API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;

export const requiredDeletionPreserveScenario = buildScenario('preserve');
export const requiredDeletionRelaxationScenario = buildScenario('relax');

export function buildRequiredDeletionApiKeys(runId: string) {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const result = {
    model: `cde2e_dn_r${suffix}`,
    block: `cde2e_db_r${suffix}`,
    leafBlock: `cde2e_dl_r${suffix}`,
  };
  Object.values(result).forEach((apiKey) => {
    assert.match(apiKey, API_KEY_PATTERN);
    assert.ok(apiKey.length <= 30);
  });
  return result;
}

function buildScenario(mode: Mode): RealCmaScenario<Seed, Expected> {
  return {
    name:
      mode === 'relax'
        ? 'opt-in preservation of an unsupported published nested-block required deletion SCC'
        : 'default preservation of a destination-only required deletion SCC',
    contentDiffArgs:
      mode === 'relax'
        ? ['--include-deletions', '--migrate-invalid-content']
        : ['--include-deletions'],

    async seedSource({ client, runId }) {
      await client.site.update({ locales: ['en', 'it'] });
      const apiKeys = buildRequiredDeletionApiKeys(runId);
      const model = await client.itemTypes.create({
        name: `Deletion node ${runId}`,
        api_key: apiKeys.model,
        modular_block: false,
        singleton: false,
        sortable: false,
        tree: false,
        draft_mode_active: true,
        draft_saving_active: false,
        all_locales_required: false,
        collection_appearance: 'compact',
        inverse_relationships_enabled: false,
      });
      const block = await client.itemTypes.create({
        name: `Deletion block ${runId}`,
        api_key: apiKeys.block,
        modular_block: true,
      });
      const leafBlock = await client.itemTypes.create({
        name: `Deletion leaf block ${runId}`,
        api_key: apiKeys.leafBlock,
        modular_block: true,
      });
      await client.fields.create(model.id, {
        label: 'Title',
        api_key: 'title',
        field_type: 'string',
        localized: true,
        validators: { required: {} },
      });
      const peer = await client.fields.create(model.id, {
        label: 'Localized peer',
        api_key: 'peer',
        field_type: 'link',
        localized: true,
        validators: linkValidators(model.id),
      });
      const peers = await client.fields.create(model.id, {
        label: 'Localized peers',
        api_key: 'peers',
        field_type: 'links',
        localized: true,
        validators: linksValidators(model.id),
      });
      const body = await client.fields.create(model.id, {
        label: 'Localized body',
        api_key: 'body',
        field_type: 'structured_text',
        localized: true,
        validators: buildRequiredDeletionStructuredTextValidators(model.id, [
          block.id,
        ]) as any,
      });
      await client.fields.create(block.id, {
        label: 'Label',
        api_key: 'label',
        field_type: 'string',
        localized: false,
        validators: {},
      });
      const blockBody = await client.fields.create(block.id, {
        label: 'Body',
        api_key: 'body',
        field_type: 'structured_text',
        localized: false,
        validators: buildRequiredDeletionStructuredTextValidators(model.id, [
          leafBlock.id,
        ]) as any,
      });
      await client.fields.create(leafBlock.id, {
        label: 'Label',
        api_key: 'label',
        field_type: 'string',
        localized: false,
        validators: {},
      });

      return {
        itemTypeApiKeys: [apiKeys.model],
        modelId: model.id,
        blockModelId: block.id,
        leafBlockModelId: leafBlock.id,
        peerFieldId: peer.id,
        peersFieldId: peers.id,
        bodyFieldId: body.id,
        blockBodyFieldId: blockBody.id,
      };
    },

    async introduceDrift({ seed, sourceClient, destinationClient }) {
      const first = await destinationClient.items.create({
        item_type: { id: seed.modelId, type: 'item_type' },
        ...shellFields('first'),
      });
      const second = await destinationClient.items.create({
        item_type: { id: seed.modelId, type: 'item_type' },
        ...shellFields('second'),
      });
      await destinationClient.items.publish(first.id);
      await destinationClient.items.publish(second.id);

      for (const [record, label, peerId] of [
        [first, 'first', second.id],
        [second, 'second', first.id],
      ] as const) {
        const current = await destinationClient.items.find(record.id);
        await destinationClient.items.update(record.id, {
          ...completeFields(seed, label, peerId),
          meta: { current_version: current.meta.current_version },
        });
        await destinationClient.items.publish(record.id);
      }
      for (const [record, label, peerId] of [
        [first, 'first draft', second.id],
        [second, 'second draft', first.id],
      ] as const) {
        const current = await destinationClient.items.find(record.id);
        await destinationClient.items.update(record.id, {
          ...completeFields(seed, label, peerId),
          meta: { current_version: current.meta.current_version },
        });
      }

      const strictValidators = [
        [seed.peerFieldId, { ...linkValidators(seed.modelId), required: {} }],
        [
          seed.peersFieldId,
          { ...linksValidators(seed.modelId), size: { min: 1 } },
        ],
        [
          seed.bodyFieldId,
          {
            ...buildRequiredDeletionStructuredTextValidators(seed.modelId, [
              seed.blockModelId,
            ]),
            required: {},
            length: { min: 1 },
          },
        ],
        [
          seed.blockBodyFieldId,
          {
            ...buildRequiredDeletionStructuredTextValidators(seed.modelId, [
              seed.leafBlockModelId,
            ]),
            required: {},
            length: { min: 1 },
          },
        ],
      ] as const;
      for (const client of [sourceClient, destinationClient]) {
        await Promise.all(
          strictValidators.map(([fieldId, validators]) =>
            client.fields.update(fieldId, { validators: validators as any }),
          ),
        );
      }

      const recordIds = [first.id, second.id].sort() as [string, string];
      await waitForValidity(destinationClient, recordIds, false);
      assert.deepEqual(await listRecordIds(sourceClient, seed.modelId), []);

      return {
        recordIds,
        destination: await captureRecords(destinationClient, recordIds),
        validators: await captureValidators(destinationClient, [
          seed.modelId,
          seed.blockModelId,
          seed.leafBlockModelId,
        ]),
      };
    },

    async verifyGeneratedPlan({ expected, planFilePath }) {
      const envelope = object(JSON.parse(await readFile(planFilePath, 'utf8')));
      const plan = object(envelope.plan);
      const invalid = object(plan.invalidContent);
      const execution = object(plan.execution);
      const skipped = array(invalid.skippedRecords).map(object);
      const relaxations = array(invalid.validatorRelaxations).map(object);

      assert.equal(envelope.formatVersion, 10);
      assert.equal(envelope.runtimeVersion, RUNTIME_VERSION);
      assert.equal(plan.formatVersion, 10);

      assert.deepEqual(array(invalid.detectedRecordIds).map(String).sort(), [
        ...expected.recordIds,
      ]);

      assert.deepEqual(array(plan.records), []);
      assert.deepEqual(array(execution.deleteReleases), []);
      assert.deepEqual(relaxations, []);
      assert.deepEqual(array(invalid.migratedRecordIds), []);
      assert.deepEqual(skipped.map(({ id }) => String(id)).sort(), [
        ...expected.recordIds,
      ]);
      const expectedReason =
        mode === 'preserve'
          ? 'REQUIRED_REFERENCE_CYCLE'
          : 'UNSUPPORTED_PUBLISHED_BLOCK_RELEASE';
      skipped.forEach((entry) => {
        assert.equal(entry.disposition, 'preserve_target');
        assert.equal(
          array(entry.reasons)
            .map(object)
            .some(({ code }) => code === expectedReason),
          true,
        );
      });
      assert.deepEqual(
        array(object(plan.targetPreconditions).desiredRecordIds)
          .map(String)
          .sort(),
        [...expected.recordIds],
      );
      assert.equal(object(plan.requiredPermissions).editSchema, false);
      assert.equal(
        object(object(plan.summary).invalidContent).status,
        'partial',
      );
    },

    async verify({
      seed,
      expected,
      sourceClient,
      destinationClient,
      appliedClient,
      migrationFilename,
      migrationModelApiKey,
    }) {
      assert.deepEqual(await listRecordIds(sourceClient, seed.modelId), []);
      assert.deepEqual(
        await captureRecords(destinationClient, expected.recordIds),
        expected.destination,
      );
      const appliedIds = await listRecordIds(appliedClient, seed.modelId);
      assert.deepEqual(appliedIds, [...expected.recordIds]);
      assert.deepEqual(
        await captureRecords(appliedClient, expected.recordIds),
        expected.destination,
      );
      assert.deepEqual(
        await captureValidators(appliedClient, [
          seed.modelId,
          seed.blockModelId,
          seed.leafBlockModelId,
        ]),
        expected.validators,
      );
      const models = await appliedClient.itemTypes.list();
      const migrationModel = models.find(
        ({ api_key }) => api_key === migrationModelApiKey,
      );
      assert.ok(migrationModel);
      const tracked = await appliedClient.items.rawList({
        filter: { type: migrationModel.id },
        page: { limit: 500 },
      });
      assert.ok(
        tracked.data.some(
          ({ attributes }) => attributes.name === migrationFilename,
        ),
      );
    },
  };
}

function linkValidators(modelId: string) {
  return { item_item_type: relationshipValidator([modelId]) };
}

function linksValidators(modelId: string) {
  return { items_item_type: relationshipValidator([modelId]) };
}

function relationshipValidator(itemTypeIds: readonly string[]) {
  return {
    item_types: [...itemTypeIds],
    on_publish_with_unpublished_references_strategy: 'fail' as const,
    on_reference_unpublish_strategy: 'delete_references' as const,
    on_reference_delete_strategy: 'delete_references' as const,
  };
}

export function buildRequiredDeletionStructuredTextValidators(
  modelId: string,
  blockIds: readonly [string, ...string[]],
) {
  return {
    structured_text_links: relationshipValidator([modelId]),
    structured_text_blocks: { item_types: [...blockIds] },
    structured_text_inline_blocks: { item_types: [...blockIds] },
  };
}

function shellFields(label: string) {
  return {
    title: { en: `${label} shell`, it: `${label} bozza` },
    peer: { en: null, it: null },
    peers: { en: [], it: [] },
    body: { en: emptyDast(), it: emptyDast() },
  };
}

function completeFields(seed: Seed, label: string, peerId: string) {
  const block = CmaClient.buildBlockRecord({
    item_type: { id: seed.blockModelId, type: 'item_type' },
    label: `${label} nested`,
    body: referenceDast(peerId),
  });
  return {
    title: { en: `${label} final`, it: `${label} finale` },
    peer: { en: peerId, it: peerId },
    peers: { en: [peerId], it: [peerId] },
    body: {
      en: referenceDast(peerId, block),
      it: referenceDast(peerId),
    },
  };
}

function emptyDast() {
  return dast([{ type: 'paragraph', children: [{ type: 'span', value: '' }] }]);
}

function referenceDast(peerId: string, block?: unknown) {
  return dast([
    {
      type: 'paragraph',
      children: [
        { type: 'span', value: '' },
        { type: 'inlineItem', item: peerId },
      ],
    },
    ...(block ? [{ type: 'block', item: block }] : []),
  ]);
}

function dast(children: unknown[]) {
  return { schema: 'dast', document: { type: 'root', children } };
}

async function listRecordIds(client: CmaClient.Client, modelId: string) {
  const result: string[] = [];
  for await (const record of client.items.listPagedIterator(
    { filter: { type: modelId }, version: 'current', order_by: 'id_ASC' },
    { perPage: 500, concurrency: 5 },
  )) {
    result.push(record.id);
  }
  return result.sort();
}

async function captureRecords(
  client: CmaClient.Client,
  recordIds: readonly string[],
) {
  return Promise.all(
    [...recordIds].sort().map(async (id) => {
      const current = await client.items.find(id, {
        version: 'current',
        nested: true,
      });
      const published = await client.items.find(id, {
        version: 'published',
        nested: true,
      });
      const fields = (record: Record<string, unknown>) => ({
        title: record.title,
        peer: record.peer,
        peers: record.peers,
        body: record.body,
      });
      return JSON.parse(
        JSON.stringify({
          id,
          validity: {
            current: current.meta.is_current_version_valid,
            published: current.meta.is_published_version_valid,
          },
          current: fields(current),
          published: fields(published),
        }),
      );
    }),
  );
}

async function captureValidators(
  client: CmaClient.Client,
  itemTypeIds: readonly string[],
) {
  const values = await Promise.all(
    itemTypeIds.map(async (itemTypeId) =>
      (await client.fields.list(itemTypeId)).map((field) => ({
        itemTypeId,
        id: field.id,
        apiKey: field.api_key,
        validators: field.validators,
      })),
    ),
  );
  return JSON.parse(
    JSON.stringify(values.flat().sort((a, b) => a.id.localeCompare(b.id))),
  );
}

async function waitForValidity(
  client: CmaClient.Client,
  ids: string[],
  expected: boolean,
) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(
      ids.map((id) =>
        client.items.find(id, { version: 'current', nested: false }),
      ),
    );
    if (
      states.every(
        ({ meta }) =>
          meta.is_current_version_valid === expected &&
          meta.is_published_version_valid === expected,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(
    `required deletion fixture validity did not converge to ${String(
      expected,
    )}`,
  );
}

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, any>;
}

function array(value: unknown): any[] {
  assert.ok(Array.isArray(value));
  return value;
}
