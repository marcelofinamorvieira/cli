import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import { RUNTIME_VERSION } from '../../src/content-diff/runtime-template';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type FreshNestedUpdateSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    modelApiKey: string;
    blockModelId: string;
    recordId: string;
    baseline: RecordBlockState | null;
  }>;

export type RecordBlockState = Readonly<{
  status: string;
  currentValid: boolean;
  publishedValid: boolean;
  currentTitle: string;
  currentBlockId: string;
  currentBlockItemTypeId: string;
  currentBlockLabel: string;
  publishedTitle: string;
  publishedBlockId: string;
  publishedBlockItemTypeId: string;
  publishedBlockLabel: string;
}>;

type FreshNestedUpdateExpected = Readonly<{
  source: RecordBlockState;
  destination: RecordBlockState | null;
}>;

type FreshNestedMode = 'update' | 'create' | 'published-only';

export const freshNestedUpdateScenario = buildFreshNestedScenario('update');
export const freshNestedSourceCreateScenario =
  buildFreshNestedScenario('create');
export const publishedOnlyNestedIdScenario =
  buildFreshNestedScenario('published-only');

function buildFreshNestedScenario(
  mode: FreshNestedMode,
): RealCmaScenario<FreshNestedUpdateSeed, FreshNestedUpdateExpected> {
  return {
    name:
      mode === 'published-only'
        ? 'preserve an aggregate whose desired current block is retained only in destination PUBLISHED'
        : mode === 'create'
          ? 'create an aggregate with distinct published and current nested IDs'
          : 'update a valid aggregate with new published and current nested IDs',

    async seedSource({ client, runId }) {
      console.log(
        '[content-diff e2e] Creating fresh nested UPDATE safety fixture',
      );
      const suffix = createHash('sha256')
        .update(runId)
        .digest('hex')
        .slice(0, 12);
      const modelApiKey = `cde2e_fu_r${suffix}`;
      const blockModelApiKey = `cde2e_fb_r${suffix}`;
      const blockModel = await client.itemTypes.create({
        name: `Fresh update block ${runId}`,
        api_key: blockModelApiKey,
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
        name: `Fresh update owner ${runId}`,
        api_key: modelApiKey,
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
      await client.fields.create(model.id, {
        label: 'Title',
        api_key: 'title',
        field_type: 'string',
        localized: false,
        validators: { required: {} },
      });
      await client.fields.create(model.id, {
        label: 'Hero',
        api_key: 'hero',
        field_type: 'single_block',
        localized: false,
        validators: {
          single_block_blocks: { item_types: [blockModel.id] },
        },
      });
      const recordId = CmaClient.generateId();
      if (mode === 'create') {
        await assertRecordAbsent(client, recordId);
        return {
          itemTypeApiKeys: [modelApiKey],
          modelId: model.id,
          modelApiKey,
          blockModelId: blockModel.id,
          recordId,
          baseline: null,
        };
      }
      const record = await client.items.create({
        id: recordId,
        item_type: { id: model.id, type: 'item_type' },
        title: 'baseline',
        hero: block(blockModel.id, 'baseline block'),
      });
      await client.items.publish(record.id);
      const initial = await captureRecordBlockState(client, record.id);
      assert.equal(
        initial.currentBlockId,
        initial.publishedBlockId,
        'seed publication did not retain one exact nested identity',
      );
      if (mode === 'published-only') {
        await client.items.update(record.id, {
          title: 'baseline current',
          hero: block(blockModel.id, 'baseline current block'),
        });
      }
      const baseline = await captureRecordBlockState(client, record.id);

      return {
        itemTypeApiKeys: [modelApiKey],
        modelId: model.id,
        modelApiKey,
        blockModelId: blockModel.id,
        recordId: record.id,
        baseline,
      };
    },

    async introduceDrift({ seed, sourceClient, destinationClient }) {
      if (mode === 'published-only') {
        assert.ok(seed.baseline);
        assert.notEqual(
          seed.baseline.currentBlockId,
          seed.baseline.publishedBlockId,
        );
        // Recreate the isolated source aggregate after its destination fork.
        // Its formerly published ID is unused after destruction; asking UPDATE
        // to revive that still-published ID would make the setup itself invalid.
        await sourceClient.items.destroy(seed.recordId);
        await sourceClient.items.create({
          id: seed.recordId,
          item_type: { id: seed.modelId, type: 'item_type' },
          title: seed.baseline.publishedTitle,
          hero: block(
            seed.blockModelId,
            seed.baseline.publishedBlockLabel,
            seed.baseline.publishedBlockId,
          ),
        });
        await sourceClient.items.publish(seed.recordId);
        const [source, destination] = await Promise.all([
          captureRecordBlockState(sourceClient, seed.recordId),
          captureRecordBlockState(destinationClient, seed.recordId),
        ]);
        assert.equal(source.currentBlockId, seed.baseline.publishedBlockId);
        assert.equal(source.publishedBlockId, seed.baseline.publishedBlockId);
        assert.equal(source.currentTitle, seed.baseline.publishedTitle);
        assert.equal(source.publishedTitle, seed.baseline.publishedTitle);
        assert.equal(
          source.currentBlockLabel,
          seed.baseline.publishedBlockLabel,
        );
        assert.equal(
          source.publishedBlockLabel,
          seed.baseline.publishedBlockLabel,
        );
        assert.equal(source.currentValid, true);
        assert.equal(source.publishedValid, true);
        assert.deepEqual(destination, seed.baseline);
        return { source, destination };
      }
      if (mode === 'create') {
        await sourceClient.items.create({
          id: seed.recordId,
          item_type: { id: seed.modelId, type: 'item_type' },
          title: 'source published',
          hero: block(seed.blockModelId, 'source published block'),
        });
      } else {
        const beforePublishedUpdate = await sourceClient.items.find(
          seed.recordId,
        );
        await sourceClient.items.update(seed.recordId, {
          title: 'source published',
          hero: block(seed.blockModelId, 'source published block'),
          meta: { current_version: beforePublishedUpdate.meta.current_version },
        });
      }
      await sourceClient.items.publish(seed.recordId);

      const beforeCurrentUpdate = await sourceClient.items.find(seed.recordId);
      await sourceClient.items.update(seed.recordId, {
        title: 'source current',
        hero: block(seed.blockModelId, 'source current block'),
        meta: { current_version: beforeCurrentUpdate.meta.current_version },
      });

      const [source, destination] = await Promise.all([
        captureRecordBlockState(sourceClient, seed.recordId),
        mode === 'create'
          ? assertRecordAbsent(destinationClient, seed.recordId).then(
              () => null,
            )
          : captureRecordBlockState(destinationClient, seed.recordId),
      ]);
      if (seed.baseline) {
        assert.notEqual(source.publishedBlockId, seed.baseline.currentBlockId);
        assert.notEqual(source.currentBlockId, seed.baseline.currentBlockId);
      }
      assert.notEqual(source.currentBlockId, source.publishedBlockId);
      assert.equal(source.status, 'updated');
      assert.equal(source.currentValid, true);
      assert.equal(source.publishedValid, true);
      assert.equal(source.currentTitle, 'source current');
      assert.equal(source.currentBlockItemTypeId, seed.blockModelId);
      assert.equal(source.currentBlockLabel, 'source current block');
      assert.equal(source.publishedTitle, 'source published');
      assert.equal(source.publishedBlockItemTypeId, seed.blockModelId);
      assert.equal(source.publishedBlockLabel, 'source published block');
      assert.deepEqual(destination, seed.baseline);

      return { source, destination };
    },

    async verifyGeneratedPlan({ seed, expected, planFilePath }) {
      const envelope = object(JSON.parse(await readFile(planFilePath, 'utf8')));
      const plan = object(envelope.plan);
      const invalidContent = object(plan.invalidContent);
      const skipped = array(invalidContent.skippedRecords).map((value) =>
        object(value),
      );

      assert.equal(envelope.formatVersion, 10);
      assert.equal(envelope.runtimeVersion, RUNTIME_VERSION);
      assert.equal(plan.formatVersion, 10);
      assert.deepEqual(array(invalidContent.validatorRelaxations), []);
      assert.deepEqual(
        array(object(plan.execution).revalidateBeforePublishIds),
        [],
      );
      if (mode !== 'published-only') {
        assert.deepEqual(skipped, []);
        const records = array(plan.records).map((value) => object(value));
        assert.equal(records.length, 1);
        assert.equal(records[0].id, seed.recordId);
        assert.equal(
          records[0].action,
          mode === 'create' ? 'create' : 'update',
        );
        assert.deepEqual(array(object(plan.execution).shellRecordIds), []);
        const desired = object(records[0].desired);
        const current = object(object(desired.current).fields);
        const published = object(object(desired.published).fields);
        assert.equal(object(current.hero).id, expected.source.currentBlockId);
        assert.equal(
          object(published.hero).id,
          expected.source.publishedBlockId,
        );
        return;
      }
      assert.ok(seed.baseline);
      assert.deepEqual(array(plan.records), []);
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0].id, seed.recordId);
      assert.equal(skipped[0].disposition, 'preserve_target');
      assert.deepEqual(
        array(skipped[0].targetNestedBlockIds).map(String).sort(),
        [seed.baseline.currentBlockId, seed.baseline.publishedBlockId].sort(),
      );
      assert.deepEqual(
        array(skipped[0].sourceNestedBlockIds).map(String).sort(),
        [expected.source.currentBlockId],
      );

      const reasons = array(skipped[0].reasons).map((value) => object(value));
      const current = reasons.find(({ slice }) => slice === 'current');
      const published = reasons.find(({ slice }) => slice === 'published');
      assert.ok(current, 'missing current fresh nested UPDATE reason');
      assert.equal(
        published,
        undefined,
        'matching published slice must not be staged',
      );
      for (const reason of [current]) {
        assert.equal(reason.code, 'UNSUPPORTED_FRESH_NESTED_BLOCK_UPDATE');
        assert.deepEqual(array(reason.dependencyChain), [
          seed.recordId,
          reason.dependencyId,
        ]);
      }
      assert.equal(current.dependencyId, expected.source.currentBlockId);
      assert.deepEqual(array(invalidContent.validatorRelaxations), []);
      assert.deepEqual(
        array(object(plan.execution).revalidateBeforePublishIds),
        [],
      );
    },

    async verify({
      seed,
      expected,
      sourceClient,
      destinationClient,
      appliedClient,
    }) {
      const [source, destination, applied] = await Promise.all([
        captureRecordBlockState(sourceClient, seed.recordId),
        mode === 'create'
          ? assertRecordAbsent(destinationClient, seed.recordId).then(
              () => null,
            )
          : captureRecordBlockState(destinationClient, seed.recordId),
        captureRecordBlockState(appliedClient, seed.recordId),
      ]);
      assert.deepEqual(source, expected.source, 'source fixture changed');
      assert.deepEqual(
        destination,
        expected.destination,
        'destination fixture changed',
      );
      assert.deepEqual(
        applied,
        mode === 'published-only' ? expected.destination : expected.source,
        mode === 'published-only'
          ? 'published-only aggregate was not preserved exactly in applied'
          : 'fresh nested IDs or exact content did not converge in applied',
      );
    },
  };
}

function block(blockModelId: string, label: string, id?: string) {
  return CmaClient.buildBlockRecord({
    ...(id ? { id } : {}),
    item_type: { id: blockModelId, type: 'item_type' },
    label,
  });
}

async function captureRecordBlockState(
  client: CmaClient.Client,
  recordId: string,
): Promise<RecordBlockState> {
  const [current, published] = await Promise.all([
    client.items.rawFind(recordId, { version: 'current', nested: true }),
    client.items.rawFind(recordId, { version: 'published', nested: true }),
  ]);
  assert.equal(current.data.id, recordId);
  assert.equal(published.data.id, recordId);
  assert.equal(
    current.data.relationships.item_type.data.id,
    published.data.relationships.item_type.data.id,
  );
  return projectFreshNestedRecordState(
    { ...current.data.attributes, meta: current.data.meta },
    { ...published.data.attributes, meta: published.data.meta },
    recordId,
  );
}

async function assertRecordAbsent(
  client: CmaClient.Client,
  recordId: string,
): Promise<void> {
  try {
    await client.items.rawFind(recordId);
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.response.status === 404)
      return;
    throw error;
  }
  assert.fail(`record ${recordId} unexpectedly exists`);
}

export function projectFreshNestedRecordState(
  current: unknown,
  published: unknown,
  recordId: string,
): RecordBlockState {
  const currentRecord = object(current, `${recordId}.current`);
  const publishedRecord = object(published, `${recordId}.published`);
  const currentMeta = object(currentRecord.meta, `${recordId}.meta`);
  const currentBlock = nestedBlockProjection(
    currentRecord.hero,
    `${recordId}.current.hero`,
  );
  const publishedBlock = nestedBlockProjection(
    publishedRecord.hero,
    `${recordId}.published.hero`,
  );
  return {
    status: stringField(currentMeta, 'status', `${recordId}.meta.status`),
    currentValid: booleanField(
      currentMeta,
      'is_current_version_valid',
      `${recordId}.meta.is_current_version_valid`,
    ),
    publishedValid: booleanField(
      currentMeta,
      'is_published_version_valid',
      `${recordId}.meta.is_published_version_valid`,
    ),
    currentTitle: stringField(
      currentRecord,
      'title',
      `${recordId}.current.title`,
    ),
    currentBlockId: currentBlock.id,
    currentBlockItemTypeId: currentBlock.itemTypeId,
    currentBlockLabel: currentBlock.label,
    publishedTitle: stringField(
      publishedRecord,
      'title',
      `${recordId}.published.title`,
    ),
    publishedBlockId: publishedBlock.id,
    publishedBlockItemTypeId: publishedBlock.itemTypeId,
    publishedBlockLabel: publishedBlock.label,
  };
}

function nestedBlockProjection(
  value: unknown,
  path: string,
): { id: string; itemTypeId: string; label: string } {
  const nested = object(value, path);
  const attributes = object(nested.attributes, `${path}.attributes`);
  const relationships = object(nested.relationships, `${path}.relationships`);
  const itemTypeRelationship = object(
    relationships.item_type,
    `${path}.relationships.item_type`,
  );
  const itemType = object(
    itemTypeRelationship.data,
    `${path}.relationships.item_type.data`,
  );
  return {
    id: stringField(nested, 'id', `${path}.id`),
    itemTypeId: stringField(
      itemType,
      'id',
      `${path}.relationships.item_type.data.id`,
    ),
    label: stringField(attributes, 'label', `${path}.attributes.label`),
  };
}

function stringField(value: unknown, field: string, path: string): string {
  const record = object(value);
  assert.equal(typeof record[field], 'string', `${path} is not a string`);
  return record[field] as string;
}

function booleanField(value: unknown, field: string, path: string): boolean {
  const record = object(value);
  assert.equal(typeof record[field], 'boolean', `${path} is not a boolean`);
  return record[field] as boolean;
}

function object(value: unknown, path = 'value'): Record<string, unknown> {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${path} is not an object`,
  );
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
