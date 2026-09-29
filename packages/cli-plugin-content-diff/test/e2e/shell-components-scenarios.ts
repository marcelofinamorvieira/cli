import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CmaClient } from '@datocms/cli-utils';
import { RUNTIME_VERSION } from '../../src/content-diff/runtime-template';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    baselineId: string;
    peerFieldId: string;
    upstreamFieldId: string;
  }>;

type Expected = Readonly<{
  components: readonly [readonly [string, string], readonly [string, string]];
  source: Awaited<ReturnType<typeof captureState>>;
  destination: Awaited<ReturnType<typeof captureState>>;
  validators: Awaited<ReturnType<typeof captureValidators>>;
}>;

type NodeFields = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    peer: { type: 'link'; localized: false };
    upstream: { type: 'link'; localized: false };
  };
};

const API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;

export function buildShellComponentsApiKey(runId: string): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const apiKey = `cde2e_sc_r${suffix}`;
  assert.match(apiKey, API_KEY_PATTERN);
  assert.ok(apiKey.length <= 30);
  return apiKey;
}

export const independentRequiredShellComponentsScenario: RealCmaScenario<
  Seed,
  Expected
> = {
  name: 'independent published required shell SCCs with a one-way required dependency',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    const apiKey = buildShellComponentsApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Shell components ${runId}`,
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
    await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const peer = await client.fields.create(model.id, {
      label: 'Cycle peer',
      api_key: 'peer',
      field_type: 'link',
      localized: false,
      validators: linkValidators(model.id),
    });
    const upstream = await client.fields.create(model.id, {
      label: 'Required upstream',
      api_key: 'upstream',
      field_type: 'link',
      localized: false,
      validators: linkValidators(model.id),
    });
    const baseline = await client.items.create<NodeFields>({
      item_type: { id: model.id, type: 'item_type' },
      title: 'shared baseline',
      peer: null,
      upstream: null,
    });
    await client.items.update<NodeFields>(baseline.id, {
      title: 'shared baseline',
      peer: baseline.id,
      upstream: baseline.id,
    });
    await client.items.publish<NodeFields>(baseline.id);

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      baselineId: baseline.id,
      peerFieldId: peer.id,
      upstreamFieldId: upstream.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    const records = await Promise.all(
      ['first a', 'first b', 'second a', 'second b'].map((title) =>
        sourceClient.items.create<NodeFields>({
          item_type: { id: seed.modelId, type: 'item_type' },
          title,
          peer: null,
          upstream: seed.baselineId,
        }),
      ),
    );
    await Promise.all(
      records.map((record) =>
        sourceClient.items.publish<NodeFields>(record.id),
      ),
    );

    const firstComponent = [records[0].id, records[1].id].sort() as [
      string,
      string,
    ];
    const secondComponent = [records[2].id, records[3].id].sort() as [
      string,
      string,
    ];
    const updates = [
      [records[0], records[1].id, seed.baselineId],
      [records[1], records[0].id, seed.baselineId],
      [records[2], records[3].id, records[0].id],
      [records[3], records[2].id, records[1].id],
    ] as const;
    for (const [record, peerId, upstreamId] of updates) {
      await sourceClient.items.update<NodeFields>(record.id, {
        title: String(record.title),
        peer: peerId,
        upstream: upstreamId,
      });
      await sourceClient.items.publish<NodeFields>(record.id);
    }

    const strictPeer = { ...linkValidators(seed.modelId), required: {} };
    const strictUpstream = { ...linkValidators(seed.modelId), required: {} };
    for (const client of [sourceClient, destinationClient]) {
      await Promise.all([
        client.fields.update(seed.peerFieldId, { validators: strictPeer }),
        client.fields.update(seed.upstreamFieldId, {
          validators: strictUpstream,
        }),
      ]);
    }
    const allIds = [seed.baselineId, ...records.map(({ id }) => id)].sort();
    await Promise.all([
      waitForValidity(sourceClient, allIds),
      waitForValidity(destinationClient, [seed.baselineId]),
    ]);

    const source = await captureState(sourceClient, seed.modelId);
    const sourceById = new Map(source.map((record) => [record.id, record]));
    assert.equal(
      sourceById.get(records[2].id)?.current.fields.upstream,
      records[0].id,
    );
    assert.equal(
      sourceById.get(records[3].id)?.current.fields.upstream,
      records[1].id,
    );

    return {
      components: [firstComponent, secondComponent],
      source,
      destination: await captureState(destinationClient, seed.modelId),
      validators: await captureValidators(sourceClient, seed.modelId),
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const envelope = object(JSON.parse(await readFile(planFilePath, 'utf8')));
    assert.equal(envelope.formatVersion, 10);
    assert.equal(envelope.runtimeVersion, RUNTIME_VERSION);
    const plan = object(envelope.plan);
    assert.equal(plan.formatVersion, 10);
    const execution = object(plan.execution);
    const expectedComponents = canonicalComponentMemberships(
      expected.components,
    );
    assert.deepEqual(
      canonicalComponentMemberships(execution.shellComponents),
      expectedComponents,
      'the generated shell components must preserve the expected partition',
    );
    assert.deepEqual(
      array(execution.shellRecordIds).map(String).sort(),
      expectedComponents.flat().sort(),
    );
    const order = array(execution.createOrder).map(String);
    assert.ok(
      Math.max(...expected.components[0].map((id) => order.indexOf(id))) <
        Math.min(...expected.components[1].map((id) => order.indexOf(id))),
      'the upstream shell component must be created before its consumers',
    );

    const invalid = object(plan.invalidContent);
    assert.deepEqual(array(invalid.skippedRecords), []);
    assert.deepEqual(
      array(invalid.migratedRecordIds).map(String).sort(),
      expectedComponents.flat().sort(),
    );
    const relaxations = array(invalid.validatorRelaxations).map(object);
    assert.deepEqual(
      relaxations.map(({ fieldId }) => String(fieldId)),
      [seed.peerFieldId],
      'the cross-component upstream field must remain required throughout',
    );
    const relaxation = relaxations[0];
    assert.deepEqual(array(relaxation.relaxedValidatorKeys), ['required']);
    const sourcePeerField = expected.validators.find(
      ({ id }: { id: string }) => id === seed.peerFieldId,
    );
    assert.ok(sourcePeerField);
    assert.deepEqual(relaxation.originalValidators, sourcePeerField.validators);
    const { required: _required, ...expectedRelaxed } =
      sourcePeerField.validators;
    assert.deepEqual(relaxation.relaxedValidators, expectedRelaxed);
    assert.deepEqual(relaxation.originalValidators, {
      ...linkValidators(seed.modelId),
      required: {},
    });
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
      'source changed during shell-component E2E',
    );
    assert.deepEqual(
      await captureState(destinationClient, seed.modelId),
      expected.destination,
      'destination changed during shell-component E2E',
    );
    assert.deepEqual(
      await captureState(appliedClient, seed.modelId),
      expected.source,
      'applied current/published records do not match the source',
    );
    assert.deepEqual(
      await captureValidators(appliedClient, seed.modelId),
      expected.validators,
      'validators were not restored byte-for-byte',
    );
  },
};

function linkValidators(modelId: string) {
  return {
    item_item_type: {
      item_types: [modelId],
      on_publish_with_unpublished_references_strategy: 'fail' as const,
      on_reference_unpublish_strategy: 'delete_references' as const,
      on_reference_delete_strategy: 'delete_references' as const,
    },
  };
}

async function captureState(client: CmaClient.Client, modelId: string) {
  const ids: string[] = [];
  for await (const record of client.items.listPagedIterator(
    { filter: { type: modelId }, version: 'current', order_by: 'id_ASC' },
    { perPage: 500, concurrency: 5 },
  )) {
    ids.push(record.id);
  }
  return Promise.all(
    ids.sort().map(async (id) => {
      const [current, published] = await Promise.all([
        client.items.find<NodeFields>(id, { version: 'current' }),
        client.items.find<NodeFields>(id, { version: 'published' }),
      ]);
      const slice = (record: typeof current) => ({
        fields: {
          title: record.title,
          peer: record.peer,
          upstream: record.upstream,
        },
        status: record.meta.status,
        currentValid: record.meta.is_current_version_valid,
        publishedValid: record.meta.is_published_version_valid,
      });
      return JSON.parse(
        JSON.stringify({
          id,
          current: slice(current),
          published: slice(published),
        }),
      );
    }),
  );
}

async function captureValidators(client: CmaClient.Client, modelId: string) {
  return JSON.parse(
    JSON.stringify(
      (await client.fields.list(modelId))
        .map((field) => ({
          id: field.id,
          apiKey: field.api_key,
          validators: field.validators,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );
}

async function waitForValidity(client: CmaClient.Client, ids: string[]) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const records = await Promise.all(
      ids.map((id) => client.items.find(id, { version: 'current' })),
    );
    if (
      records.every(
        ({ meta }) =>
          meta.is_current_version_valid === true &&
          meta.is_published_version_valid === true,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('shell-component fixture validity did not converge');
}

function canonicalComponentMemberships(value: unknown): string[][] {
  return array(value)
    .map((component) =>
      array(component)
        .map((id) => {
          assert.equal(typeof id, 'string');
          return id as string;
        })
        .sort(),
    )
    .sort((left, right) => {
      const leftKey = left.join(',');
      const rightKey = right.join(',');
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, any>;
}

function array(value: unknown): any[] {
  assert.ok(Array.isArray(value));
  return value;
}
