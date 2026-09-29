import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
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
    retainedPeerId: string;
  }>;

type CapturedRecord = Readonly<{
  id: string;
  peers: readonly string[];
}>;

type CapturedState = Readonly<{
  current: readonly CapturedRecord[];
  published: readonly CapturedRecord[];
}>;

type Expected = Readonly<{
  deletedRecordIds: readonly [string, string];
  source: CapturedState;
  destination: CapturedState;
  validators: unknown;
}>;

const API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;

export const optionalDeletionValidationScenario: RealCmaScenario<
  Seed,
  Expected
> = {
  name: 'strict optional deletion SCC uses exact temporary size relaxation',
  contentDiffArgs: ['--include-deletions', '--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    await client.site.update({ locales: ['en'] });
    const apiKey = buildOptionalDeletionApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Optional deletion node ${runId}`,
      api_key: apiKey,
      modular_block: false,
      singleton: false,
      sortable: false,
      tree: false,
      draft_mode_active: false,
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
      validators: buildOptionalDeletionValidators(model.id),
    });
    const retainedPeer = await client.items.create<RecordDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      peers: [],
    });

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      peersFieldId: peers.id,
      retainedPeerId: retainedPeer.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    const first = await destinationClient.items.create<RecordDefinition>({
      item_type: { id: seed.modelId, type: 'item_type' },
      peers: [],
    });
    const second = await destinationClient.items.create<RecordDefinition>({
      item_type: { id: seed.modelId, type: 'item_type' },
      peers: [],
    });

    for (const [recordId, cyclicPeerId] of [
      [first.id, second.id],
      [second.id, first.id],
    ] as const) {
      const current =
        await destinationClient.items.find<RecordDefinition>(recordId);
      await destinationClient.items.update<RecordDefinition>(recordId, {
        peers: [cyclicPeerId, seed.retainedPeerId],
        meta: { current_version: current.meta.current_version },
      });
    }

    const deletedRecordIds = [first.id, second.id].sort() as [string, string];
    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureState(sourceClient, seed.modelId),
        captureState(destinationClient, seed.modelId),
        captureValidators(sourceClient, seed.modelId, seed.peersFieldId),
        captureValidators(destinationClient, seed.modelId, seed.peersFieldId),
      ]);

    assert.deepEqual(sourceValidators, destinationValidators);
    assert.deepEqual(
      source.current.map(({ id }) => id),
      [seed.retainedPeerId],
    );
    assert.deepEqual(
      destination.current.map(({ id }) => id).sort(),
      [seed.retainedPeerId, ...deletedRecordIds].sort(),
    );
    for (const recordId of deletedRecordIds) {
      const record = destination.current.find(({ id }) => id === recordId);
      assert.ok(record);
      assert.deepEqual(
        [...record.peers].sort(),
        [
          seed.retainedPeerId,
          deletedRecordIds.find((candidate) => candidate !== recordId)!,
        ].sort(),
      );
    }

    return {
      deletedRecordIds,
      source,
      destination,
      validators: sourceValidators,
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const envelope = object(JSON.parse(await readFile(planFilePath, 'utf8')));
    const plan = object(envelope.plan);
    const invalidContent = object(plan.invalidContent);
    const execution = object(plan.execution);
    const relaxations = array(invalidContent.validatorRelaxations).map(object);
    const releases = array(execution.deleteReleases).map(object);

    assert.deepEqual(array(invalidContent.skippedRecords), []);
    assert.deepEqual(
      array(invalidContent.detectedRecordIds).map(String).sort(),
      [...expected.deletedRecordIds],
    );
    assert.deepEqual(
      array(invalidContent.migratedRecordIds).map(String).sort(),
      [...expected.deletedRecordIds],
    );
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].fieldId, seed.peersFieldId);
    assert.equal(relaxations[0].itemTypeId, seed.modelId);
    assert.deepEqual(array(relaxations[0].relaxedValidatorKeys), ['size']);
    assert.deepEqual(
      array(relaxations[0].affectedRecordIds).map(String).sort(),
      [...expected.deletedRecordIds],
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

    assert.deepEqual(releases.map(({ recordId }) => String(recordId)).sort(), [
      ...expected.deletedRecordIds,
    ]);
    for (const release of releases) {
      assert.equal(release.publish, false);
      assert.deepEqual(release.transientNestedBlockIds, []);
      assert.deepEqual(object(release.fields).peers, [seed.retainedPeerId]);
      assert.match(String(release.intermediateCurrentHash), /^[0-9a-f]{64}$/);
      const owner = array(plan.records)
        .map(object)
        .find(({ id }) => id === release.recordId);
      assert.ok(owner);
      assert.ok(
        array(owner.allowedIntermediateHashes).includes(
          release.intermediateCurrentHash,
        ),
      );
    }
    assert.deepEqual(
      array(plan.records)
        .map(object)
        .filter(({ action }) => action === 'delete')
        .map(({ id }) => String(id))
        .sort(),
      [...expected.deletedRecordIds],
    );
    assert.equal(object(plan.requiredPermissions).editSchema, true);
    const permissions = array(object(plan.requiredPermissions).itemTypes)
      .map(object)
      .find(({ id }) => id === seed.modelId);
    assert.ok(permissions);
    assert.ok(array(permissions.actions).includes('update'));
    assert.ok(array(permissions.actions).includes('delete'));
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
    const [source, destination, applied, validators] = await Promise.all([
      captureState(sourceClient, seed.modelId),
      captureState(destinationClient, seed.modelId),
      captureState(appliedClient, seed.modelId),
      captureValidators(appliedClient, seed.modelId, seed.peersFieldId),
    ]);

    assert.deepEqual(source, expected.source);
    assert.deepEqual(destination, expected.destination);
    assert.deepEqual(applied, expected.source);
    assert.deepEqual(validators, expected.validators);
    assert.deepEqual(applied.current, [{ id: seed.retainedPeerId, peers: [] }]);
    assert.deepEqual(applied.published, applied.current);
    for (const recordId of expected.deletedRecordIds) {
      assert.equal(
        applied.current.some(({ id }) => id === recordId),
        false,
      );
    }

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

export function buildOptionalDeletionApiKey(runId: string): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const apiKey = `cde2e_od_r${suffix}`;
  assert.match(apiKey, API_KEY_PATTERN);
  assert.ok(apiKey.length <= 30);
  return apiKey;
}

export function buildOptionalDeletionValidators(modelId: string) {
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
  const capture = async (version: 'current' | 'published') => {
    const result: CapturedRecord[] = [];
    for await (const record of client.items.listPagedIterator<RecordDefinition>(
      {
        filter: { type: modelId },
        version,
        order_by: 'id_ASC',
      },
      { perPage: 500, concurrency: 5 },
    )) {
      result.push({
        id: record.id,
        peers: Array.isArray(record.peers)
          ? record.peers.map(String).sort()
          : [],
      });
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  };

  const [current, published] = await Promise.all([
    capture('current'),
    capture('published'),
  ]);
  return { current, published };
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

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
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
