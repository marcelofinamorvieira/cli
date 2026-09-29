import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import { RUNTIME_VERSION } from '../../src/content-diff/runtime-template';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type RecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    peers: { type: 'links'; localized: false };
  };
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    peersFieldId: string;
    anchorId: string;
  }>;

type CapturedRecord = Readonly<{
  id: string;
  peers: readonly string[];
  createdAt: string;
  firstPublishedAt: string;
  status: string;
  currentValid: boolean;
  publishedValid: boolean;
}>;

type CapturedState = Readonly<{
  current: readonly CapturedRecord[];
  publishedPeers: Readonly<Record<string, readonly string[]>>;
}>;

type Expected = Readonly<{
  componentRecordIds: readonly [string, string, string];
  relaxedSeedRecordIds: readonly [string, string];
  source: CapturedState;
  destination: CapturedState;
  validators: unknown;
}>;

const API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;

export const optionalCreateValidationScenario: RealCmaScenario<Seed, Expected> =
  {
    name: 'strict optional create SCC uses exact order-dependent size relaxation',
    contentDiffArgs: ['--migrate-invalid-content'],

    async seedSource({ client, runId }) {
      await client.site.update({ locales: ['en'] });
      const apiKey = buildOptionalCreateApiKey(runId);
      const model = await client.itemTypes.create({
        name: `Optional create node ${runId}`,
        api_key: apiKey,
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
      const peers = await client.fields.create(model.id, {
        label: 'Peers',
        api_key: 'peers',
        field_type: 'links',
        localized: false,
        validators: {
          items_item_type: relationshipValidator(model.id),
        },
      });
      const anchor = await client.items.create<RecordDefinition>({
        item_type: { id: model.id, type: 'item_type' },
        peers: [],
      });
      await client.items.publish<RecordDefinition>(anchor.id);

      return {
        itemTypeApiKeys: [apiKey],
        modelId: model.id,
        peersFieldId: peers.id,
        anchorId: anchor.id,
      };
    },

    async introduceDrift({ seed, sourceClient, destinationClient }) {
      const records = await Promise.all(
        Array.from({ length: 3 }, () =>
          sourceClient.items.create<RecordDefinition>({
            item_type: { id: seed.modelId, type: 'item_type' },
            peers: [seed.anchorId],
          }),
        ),
      );
      await Promise.all(
        records.map(({ id }) =>
          sourceClient.items.publish<RecordDefinition>(id),
        ),
      );

      const componentRecordIds = records.map(({ id }) => id).sort() as [
        string,
        string,
        string,
      ];
      for (let index = 0; index < componentRecordIds.length; index += 1) {
        const recordId = componentRecordIds[index];
        const nextId =
          componentRecordIds[(index + 1) % componentRecordIds.length];
        await sourceClient.items.update<RecordDefinition>(recordId, {
          peers: [seed.anchorId, nextId],
        });
        await sourceClient.items.publish<RecordDefinition>(recordId);
      }

      const validators = buildOptionalCreateValidators(seed.modelId);
      await Promise.all([
        sourceClient.fields.update(seed.peersFieldId, { validators }),
        destinationClient.fields.update(seed.peersFieldId, { validators }),
      ]);
      await Promise.all([
        ...[seed.anchorId, ...componentRecordIds].map((recordId) =>
          waitForValidity(sourceClient, recordId, true, true),
        ),
        waitForValidity(destinationClient, seed.anchorId, true, true),
      ]);

      const [source, destination, sourceValidators, destinationValidators] =
        await Promise.all([
          captureState(sourceClient, seed.modelId),
          captureState(destinationClient, seed.modelId),
          captureValidators(sourceClient, seed.modelId, seed.peersFieldId),
          captureValidators(destinationClient, seed.modelId, seed.peersFieldId),
        ]);
      assert.deepEqual(sourceValidators, validators);
      assert.deepEqual(destinationValidators, validators);
      assert.deepEqual(
        destination.current.map(({ id }) => id),
        [seed.anchorId],
      );
      for (let index = 0; index < componentRecordIds.length; index += 1) {
        const record = source.current.find(
          ({ id }) => id === componentRecordIds[index],
        );
        assert.ok(record);
        assert.deepEqual(record.peers, [
          seed.anchorId,
          componentRecordIds[(index + 1) % componentRecordIds.length],
        ]);
      }

      return {
        componentRecordIds,
        relaxedSeedRecordIds: componentRecordIds.slice(0, 2) as [
          string,
          string,
        ],
        source,
        destination,
        validators,
      };
    },

    async verifyGeneratedPlan({ seed, expected, planFilePath }) {
      const envelope = object(JSON.parse(await readFile(planFilePath, 'utf8')));
      assert.equal(envelope.formatVersion, 10);
      assert.equal(envelope.runtimeVersion, RUNTIME_VERSION);
      const plan = object(envelope.plan);
      assert.equal(plan.formatVersion, 10);
      const invalidContent = object(plan.invalidContent);
      const execution = object(plan.execution);
      const relaxations = array(invalidContent.validatorRelaxations).map(
        object,
      );

      assert.deepEqual(array(invalidContent.skippedRecords), []);
      assert.deepEqual(
        array(invalidContent.detectedRecordIds).map(String).sort(),
        [...expected.componentRecordIds],
      );
      assert.deepEqual(
        array(invalidContent.migratedRecordIds).map(String).sort(),
        [...expected.componentRecordIds],
      );
      assert.equal(relaxations.length, 1);
      assert.equal(relaxations[0].fieldId, seed.peersFieldId);
      assert.equal(relaxations[0].itemTypeId, seed.modelId);
      assert.deepEqual(array(relaxations[0].relaxedValidatorKeys), ['size']);
      assert.deepEqual(
        array(relaxations[0].affectedRecordIds).map(String).sort(),
        [...expected.relaxedSeedRecordIds],
      );
      assert.deepEqual(
        canonicalJson(relaxations[0].originalValidators),
        canonicalJson(expected.validators),
      );
      assert.deepEqual(
        canonicalJson(relaxations[0].relaxedValidators),
        canonicalJson({
          items_item_type: relationshipValidator(seed.modelId),
        }),
      );
      assert.deepEqual(array(execution.shellRecordIds), []);
      assert.deepEqual(array(execution.shellComponents), []);
      assert.deepEqual(array(execution.createOrder).map(String), [
        ...expected.componentRecordIds,
      ]);
      assert.deepEqual(array(execution.publicationSeedOrder).map(String), [
        ...expected.componentRecordIds,
      ]);
      assert.deepEqual(
        array(execution.revalidateBeforePublishIds).map(String).sort(),
        [...expected.relaxedSeedRecordIds],
      );

      const records = array(plan.records).map(object);
      for (
        let index = 0;
        index < expected.componentRecordIds.length;
        index += 1
      ) {
        const recordId = expected.componentRecordIds[index];
        const recordPlan = records.find(({ id }) => id === recordId);
        assert.ok(recordPlan);
        assert.equal(recordPlan.action, 'create');
        const desired = object(recordPlan.desired);
        const published = object(desired.published);
        const fields = object(published.fields);
        assert.deepEqual(fields.peers, [
          seed.anchorId,
          expected.componentRecordIds[(index + 1) % 3],
        ]);
        const later = new Set(expected.componentRecordIds.slice(index + 1));
        assert.deepEqual(
          array(fields.peers).filter((id) => !later.has(String(id))),
          index < 2
            ? [seed.anchorId]
            : [seed.anchorId, expected.componentRecordIds[0]],
        );
      }

      const permissions = array(object(plan.requiredPermissions).itemTypes)
        .map(object)
        .find(({ id }) => id === seed.modelId);
      assert.ok(permissions);
      assert.deepEqual(array(permissions.actions), [
        'read',
        'create',
        'update',
        'publish',
      ]);
      assert.equal(object(plan.requiredPermissions).editSchema, true);
    },

    async verify({
      seed,
      expected,
      sourceClient,
      destinationClient,
      appliedClient,
    }) {
      const [source, destination, applied, validators] = await Promise.all([
        captureState(sourceClient, seed.modelId),
        captureState(destinationClient, seed.modelId),
        captureState(appliedClient, seed.modelId),
        captureValidators(appliedClient, seed.modelId, seed.peersFieldId),
      ]);
      assert.deepEqual(source, expected.source, 'source changed during E2E');
      assert.deepEqual(
        destination,
        expected.destination,
        'destination changed during E2E',
      );
      assert.deepEqual(
        applied,
        expected.source,
        'applied current/published/lifecycle state differs from source',
      );
      assert.deepEqual(validators, expected.validators);
    },
  };

export function buildOptionalCreateApiKey(runId: string): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const apiKey = `cde2e_oc_r${suffix}`;
  assert.match(apiKey, API_KEY_PATTERN);
  assert.ok(apiKey.length <= 30);
  return apiKey;
}

export function buildOptionalCreateValidators(modelId: string) {
  return {
    items_item_type: relationshipValidator(modelId),
    size: { min: 0, multiple_of: 2 },
  };
}

function relationshipValidator(modelId: string) {
  return {
    item_types: [modelId],
    on_publish_with_unpublished_references_strategy: 'fail' as const,
    on_reference_unpublish_strategy: 'fail' as const,
    on_reference_delete_strategy: 'fail' as const,
  };
}

async function captureState(
  client: CmaClient.Client,
  modelId: string,
): Promise<CapturedState> {
  const current: CapturedRecord[] = [];
  for await (const record of client.items.listPagedIterator<RecordDefinition>(
    {
      filter: { type: modelId },
      version: 'current',
      order_by: 'id_ASC',
    },
    { perPage: 500, concurrency: 5 },
  )) {
    current.push({
      id: record.id,
      peers: Array.isArray(record.peers) ? record.peers.map(String) : [],
      createdAt: requiredString(record.meta.created_at, 'created_at'),
      firstPublishedAt: requiredString(
        record.meta.first_published_at,
        'first_published_at',
      ),
      status: requiredString(record.meta.status, 'status'),
      currentValid: requiredBoolean(
        record.meta.is_current_version_valid,
        'current validity',
      ),
      publishedValid: requiredBoolean(
        record.meta.is_published_version_valid,
        'published validity',
      ),
    });
  }
  const publishedPeers: Record<string, readonly string[]> = {};
  for await (const record of client.items.listPagedIterator<RecordDefinition>(
    {
      filter: { type: modelId },
      version: 'published',
      order_by: 'id_ASC',
    },
    { perPage: 500, concurrency: 5 },
  )) {
    publishedPeers[record.id] = Array.isArray(record.peers)
      ? record.peers.map(String)
      : [];
  }
  return {
    current: current.sort((left, right) => left.id.localeCompare(right.id)),
    publishedPeers: Object.fromEntries(
      Object.entries(publishedPeers).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

async function captureValidators(
  client: CmaClient.Client,
  modelId: string,
  fieldId: string,
) {
  const fields = await client.fields.list(modelId);
  const field = fields.find(({ id }) => id === fieldId);
  assert.ok(field, `field ${fieldId} disappeared`);
  return canonicalJson(field.validators);
}

async function waitForValidity(
  client: CmaClient.Client,
  recordId: string,
  current: boolean,
  published: boolean,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const record = await client.items.find(recordId);
    if (
      record.meta.is_current_version_valid === current &&
      record.meta.is_published_version_valid === published
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  const record = await client.items.find(recordId);
  throw new Error(
    `record validity did not converge: ${JSON.stringify({
      recordId,
      expected: { current, published },
      actual: {
        current: record.meta.is_current_version_valid,
        published: record.meta.is_published_version_valid,
      },
    })}`,
  );
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

function requiredString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value as string;
}

function requiredBoolean(value: unknown, label: string): boolean {
  assert.equal(typeof value, 'boolean', `${label} must be a boolean`);
  return value as boolean;
}

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, any>;
}

function array(value: unknown): any[] {
  assert.ok(Array.isArray(value));
  return value;
}
