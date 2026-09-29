import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Definition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    label: { type: 'string'; localized: false };
    peers: { type: 'links'; localized: false };
  };
};
type Seed = RealCmaScenarioSeed &
  Readonly<{ modelId: string; peersFieldId: string }>;
type RawRecord = Readonly<{
  id: string;
  itemTypeId: string;
  label: string;
  peers: readonly string[];
  status: string;
  valid: boolean;
  currentValid: boolean;
  publishedValid: boolean | null;
}>;
type State = Readonly<{
  current: readonly RawRecord[];
  published: readonly RawRecord[];
}>;
type Expected = Readonly<{
  aId: string;
  bId: string;
  source: State;
  validators: unknown;
}>;

export const optionalSelfCycleScenario: RealCmaScenario<Seed, Expected> = {
  name: 'source-only optional two-record cycle containing a self-reference',

  async seedSource({ client, runId }) {
    const suffix = createHash('sha256')
      .update(runId)
      .digest('hex')
      .slice(0, 12);
    const model = await client.itemTypes.create({
      name: `Optional self cycle ${runId}`,
      api_key: `cde2e_os_r${suffix}`,
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
    await client.fields.create(model.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const peers = await client.fields.create(model.id, {
      label: 'Peers',
      api_key: 'peers',
      field_type: 'links',
      localized: false,
      validators: { items_item_type: { item_types: [model.id] } },
    });
    // The baseline has the aligned schema and no records. Create both IDs
    // before wiring the source graph; the generated migration must do so too.
    assert.deepEqual(await captureState(client, model.id), {
      current: [],
      published: [],
    });
    return {
      modelId: model.id,
      peersFieldId: peers.id,
      itemTypeApiKeys: [model.api_key],
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    const first = await sourceClient.items.create<Definition>({
      item_type: { type: 'item_type', id: seed.modelId },
      label: 'A',
      peers: [],
    });
    const second = await sourceClient.items.create<Definition>({
      item_type: { type: 'item_type', id: seed.modelId },
      label: 'B',
      peers: [],
    });
    await sourceClient.items.update<Definition>(first.id, {
      peers: [first.id, second.id],
    });
    await sourceClient.items.update<Definition>(second.id, {
      peers: [first.id],
    });
    const source = await captureState(sourceClient, seed.modelId);
    assert.equal(source.current.length, 2);
    assert.deepEqual(source.published, []);
    assert.deepEqual(source.current.find(({ id }) => id === first.id)?.peers, [
      first.id,
      second.id,
    ]);
    assert.deepEqual(source.current.find(({ id }) => id === second.id)?.peers, [
      first.id,
    ]);
    assert.ok(
      source.current.every(
        (record) =>
          record.valid &&
          record.currentValid &&
          record.publishedValid === null &&
          record.status === 'draft',
      ),
    );
    assert.deepEqual(await captureState(destinationClient, seed.modelId), {
      current: [],
      published: [],
    });
    const validators = (await sourceClient.fields.find(seed.peersFieldId))
      .validators;
    assert.deepEqual(
      (await destinationClient.fields.find(seed.peersFieldId)).validators,
      validators,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(validators, 'required'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(validators, 'size'),
      false,
    );
    return { aId: first.id, bId: second.id, source, validators };
  },

  async verifyGeneratedPlan({ expected, planFilePath }) {
    const plan = object(
      object(JSON.parse(await readFile(planFilePath, 'utf8'))).plan,
    );
    const invalid = object(plan.invalidContent);
    assert.equal(invalid.migrateInvalidContent, false);
    assert.deepEqual(invalid.skippedRecords, []);
    assert.deepEqual(invalid.validatorRelaxations, []);
    const execution = object(plan.execution);
    assert.deepEqual(execution.shellRecordIds, []);
    assert.deepEqual(execution.shellComponents, []);
    assert.deepEqual(execution.publicationSeedOrder, []);
    assert.ok(Array.isArray(plan.records));
    assert.deepEqual(
      plan.records.map((record) => object(record).id).sort(),
      [expected.aId, expected.bId].sort(),
    );
    assert.ok(
      plan.records.every((record) => object(record).action === 'create'),
    );
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    assert.deepEqual(
      await captureState(sourceClient, seed.modelId),
      expected.source,
    );
    assert.deepEqual(
      await captureState(appliedClient, seed.modelId),
      expected.source,
    );
    assert.deepEqual(await captureState(destinationClient, seed.modelId), {
      current: [],
      published: [],
    });
    for (const client of [sourceClient, destinationClient, appliedClient]) {
      assert.deepEqual(
        (await client.fields.find(seed.peersFieldId)).validators,
        expected.validators,
      );
    }
  },
};

async function captureState(
  client: CmaClient.Client,
  modelId: string,
): Promise<State> {
  const capture = async (
    version: 'current' | 'published',
  ): Promise<RawRecord[]> => {
    const response = await client.items.rawList({
      filter: { type: modelId },
      version,
      nested: false,
      order_by: 'id_ASC',
      page: { offset: 0, limit: 30 },
    });
    assert.equal(response.meta.total_count, response.data.length);
    assert.ok(
      response.data.length <= 2,
      'self-cycle fixture contains unexpected records',
    );
    return response.data.map((row) => {
      const attrs = object(row.attributes);
      assert.equal(typeof attrs.label, 'string');
      assert.ok(
        Array.isArray(attrs.peers) &&
          attrs.peers.every((id) => typeof id === 'string'),
      );
      assert.equal(row.relationships.item_type.data.id, modelId);
      assert.ok(row.meta.status !== null);
      assert.ok(typeof row.meta.is_current_version_valid === 'boolean');
      return {
        id: row.id,
        itemTypeId: row.relationships.item_type.data.id,
        label: attrs.label as string,
        peers: attrs.peers as string[],
        status: row.meta.status,
        valid: row.meta.is_valid,
        currentValid: row.meta.is_current_version_valid,
        publishedValid: row.meta.is_published_version_valid,
      };
    });
  };
  return {
    current: await capture('current'),
    published: await capture('published'),
  };
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
