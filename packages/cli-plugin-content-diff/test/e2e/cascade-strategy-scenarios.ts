import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type ManagedDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    label: { type: 'string'; localized: false };
    publish_ref: { type: 'link'; localized: false };
    unpublish_ref: { type: 'link'; localized: false };
    delete_ref: { type: 'link'; localized: false };
  };
};

type BoundaryTargetDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    label: { type: 'string'; localized: false };
  };
};

type BoundaryReferrerDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    label: { type: 'string'; localized: false };
    target: { type: 'link'; localized: false };
  };
};

type ReferenceStrategy = Readonly<{
  on_publish_with_unpublished_references_strategy:
    | 'fail'
    | 'publish_references';
  on_reference_unpublish_strategy: 'fail' | 'unpublish' | 'delete_references';
  on_reference_delete_strategy: 'fail' | 'delete_references';
}>;

type ManagedSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    publishDependencyId: string;
    publishConsumerId: string;
    unpublishDependencyId: string;
    unpublishConsumerId: string;
    deleteDependencyId: string;
    deleteConsumerId: string;
  }>;

type BoundarySeed = RealCmaScenarioSeed &
  Readonly<{
    targetModelId: string;
    referrerModelId: string;
    targetId: string;
    referrerId: string;
  }>;

type RawRecordSlice = Readonly<{
  id: string;
  itemTypeId: string;
  fields: Readonly<{
    label: string;
    publishRef: string | null;
    unpublishRef: string | null;
    deleteRef: string | null;
  }>;
  lifecycle: Readonly<{
    createdAt: string;
    firstPublishedAt: string | null;
    status: string;
  }>;
  validity: Readonly<{
    slice: boolean;
    current: boolean | null;
    published: boolean | null;
  }>;
}>;

type RawVersionedRecord = Readonly<{
  id: string;
  current: RawRecordSlice | null;
  published: RawRecordSlice | null;
}>;

type RawManagedState = readonly RawVersionedRecord[];

type ManagedExpected = Readonly<{
  source: RawManagedState;
  destination: RawManagedState;
}>;

export const CASCADE_REFERENCE_STRATEGIES = {
  publishReferences: {
    on_publish_with_unpublished_references_strategy: 'publish_references',
    on_reference_unpublish_strategy: 'fail',
    on_reference_delete_strategy: 'fail',
  },
  unpublish: {
    on_publish_with_unpublished_references_strategy: 'fail',
    on_reference_unpublish_strategy: 'unpublish',
    on_reference_delete_strategy: 'fail',
  },
  deleteReferences: {
    on_publish_with_unpublished_references_strategy: 'fail',
    on_reference_unpublish_strategy: 'fail',
    on_reference_delete_strategy: 'delete_references',
  },
  fail: {
    on_publish_with_unpublished_references_strategy: 'fail',
    on_reference_unpublish_strategy: 'fail',
    on_reference_delete_strategy: 'fail',
  },
} as const satisfies Readonly<Record<string, ReferenceStrategy>>;

export const EXTERNAL_UNPUBLISH_REFERRER_FAILURE_PATTERN =
  /Record \S+ cannot be unpublished safely because published referrer \S+ is outside the selected reconciliation order or retains the reference\./;

export function cascadeStrategyApiKey(
  lane: 'managed' | 'target' | 'referrer',
  runId: string,
): string {
  const suffix = createHash('sha256')
    .update(`${lane}:${runId}`)
    .digest('hex')
    .slice(0, 12);
  return `cde2e_cs_${lane[0]}${suffix}`;
}

export const managedCascadeStrategiesScenario: RealCmaScenario<
  ManagedSeed,
  ManagedExpected
> = {
  name: 'managed publish, unpublish, and delete-reference cascade strategies',
  contentDiffArgs: ['--include-deletions'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating managed cascade-strategy graph');
    const modelApiKey = cascadeStrategyApiKey('managed', runId);
    const model = await createModel(client, modelApiKey, runId);
    await createManagedFields(client, model.id);

    const publishDependency = await createManagedRecord(
      client,
      model.id,
      'publish dependency',
    );
    const publishConsumer = await createManagedRecord(
      client,
      model.id,
      'publish consumer',
      { publish_ref: publishDependency.id },
    );

    const unpublishDependency = await createManagedRecord(
      client,
      model.id,
      'unpublish dependency',
    );
    await publishWithoutTreeRecursion(client, unpublishDependency.id);
    const unpublishConsumer = await createManagedRecord(
      client,
      model.id,
      'unpublish consumer',
      { unpublish_ref: unpublishDependency.id },
    );
    await publishWithoutTreeRecursion(client, unpublishConsumer.id);

    const deleteDependency = await createManagedRecord(
      client,
      model.id,
      'delete dependency',
    );
    await publishWithoutTreeRecursion(client, deleteDependency.id);
    const deleteConsumer = await createManagedRecord(
      client,
      model.id,
      'delete consumer',
      { delete_ref: deleteDependency.id },
    );
    await publishWithoutTreeRecursion(client, deleteConsumer.id);

    return {
      itemTypeApiKeys: [modelApiKey],
      modelId: model.id,
      publishDependencyId: publishDependency.id,
      publishConsumerId: publishConsumer.id,
      unpublishDependencyId: unpublishDependency.id,
      unpublishConsumerId: unpublishConsumer.id,
      deleteDependencyId: deleteDependency.id,
      deleteConsumerId: deleteConsumer.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Exercising native publish/unpublish/delete cascades in source',
    );
    const recordIds = managedRecordIds(seed);
    const destination = await captureManagedState(
      destinationClient,
      seed.modelId,
      recordIds,
    );
    assertDestinationCascadeFixture(destination, seed);

    // Each operation starts at the dependency side of a distinct graph. The
    // resulting source state proves that the configured CMA strategy, rather
    // than a manual cleanup in this fixture, performed the secondary mutation.
    await publishWithoutTreeRecursion(sourceClient, seed.publishConsumerId);
    await unpublishWithoutTreeRecursion(
      sourceClient,
      seed.unpublishDependencyId,
    );
    await sourceClient.items.destroy(seed.deleteDependencyId);

    const source = await captureManagedState(
      sourceClient,
      seed.modelId,
      recordIds,
    );
    assertSourceCascadeFixture(source, seed);
    assert.notDeepEqual(source, destination);
    return { source, destination };
  },

  async verifyGeneratedPlan({ seed, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying explicit cascade-safe plan order and preflight',
    );
    const plan = await readGeneratedPlan(planFilePath);
    const records = requiredArray(plan.records, 'plan.records').map(
      (entry, index) => requiredObject(entry, `plan.records[${index}]`),
    );
    const recordById = new Map(
      records.map((entry) => [
        requiredString(entry.id, 'record plan ID'),
        entry,
      ]),
    );
    const expectedActions = new Map<string, string>([
      [seed.publishDependencyId, 'update'],
      [seed.publishConsumerId, 'update'],
      [seed.unpublishDependencyId, 'update'],
      [seed.unpublishConsumerId, 'update'],
      [seed.deleteDependencyId, 'delete'],
      [seed.deleteConsumerId, 'update'],
    ]);
    assert.deepEqual(
      [...recordById.keys()].sort(compareIds),
      [...expectedActions.keys()].sort(compareIds),
      'plan did not contain exactly the six managed cascade records',
    );
    for (const [recordId, action] of expectedActions) {
      assert.equal(recordById.get(recordId)?.action, action);
    }

    const execution = requiredObject(plan.execution, 'plan.execution');
    const publishOrder = requiredStringArray(
      execution.publishOrder,
      'plan.execution.publishOrder',
    );
    assert.deepEqual(
      [...publishOrder].sort(compareIds),
      managedRecordIds(seed).filter((id) => id !== seed.deleteDependencyId),
      'publishOrder does not explicitly cover every surviving managed record',
    );
    assertRunsBefore(
      publishOrder,
      seed.publishDependencyId,
      seed.publishConsumerId,
      'publish dependency before consumer',
    );
    assertRunsBefore(
      publishOrder,
      seed.unpublishConsumerId,
      seed.unpublishDependencyId,
      'published referrer before referenced record unpublish',
    );
    assert.ok(
      publishOrder.includes(seed.deleteConsumerId),
      'reference-removing published reconciliation is absent from publishOrder',
    );
    assert.equal(
      publishOrder.includes(seed.deleteDependencyId),
      false,
      'deleted dependency unexpectedly entered the publication phase',
    );
    assert.deepEqual(
      requiredStringArray(execution.deleteOrder, 'plan.execution.deleteOrder'),
      [seed.deleteDependencyId],
      'delete phase does not target exactly the managed dependency',
    );
    assert.deepEqual(
      requiredStringArray(
        execution.updateOrder,
        'plan.execution.updateOrder',
      ).sort(compareIds),
      managedRecordIds(seed).filter((id) => id !== seed.deleteDependencyId),
      'updateOrder does not explicitly cover every surviving changed record',
    );
    assert.deepEqual(execution.createOrder, []);
    assert.deepEqual(execution.publicationSeedOrder, []);
    assert.deepEqual(execution.deleteReleases, []);

    const publishConsumer = requiredObject(
      recordById.get(seed.publishConsumerId),
      'publish consumer plan',
    );
    assert.deepEqual(
      requiredStringArray(
        publishConsumer.publishedDependencies,
        'publish consumer publishedDependencies',
      ),
      [seed.publishDependencyId],
    );
    const deleteConsumer = requiredObject(
      recordById.get(seed.deleteConsumerId),
      'delete consumer plan',
    );
    assert.equal(
      requiredStringArray(
        deleteConsumer.publishedDependencies,
        'delete consumer publishedDependencies',
      ).includes(seed.deleteDependencyId),
      false,
      'desired published consumer retained the dependency scheduled for deletion',
    );
    assert.equal(
      snapshotField(deleteConsumer, 'baseline', 'published', 'delete_ref'),
      seed.deleteDependencyId,
    );
    assert.equal(
      snapshotField(deleteConsumer, 'desired', 'current', 'delete_ref'),
      null,
    );
    assert.equal(
      snapshotField(deleteConsumer, 'desired', 'published', 'delete_ref'),
      null,
    );

    const preconditions = requiredObject(
      plan.targetPreconditions,
      'plan.targetPreconditions',
    );
    assert.deepEqual(
      requiredStringArray(
        preconditions.itemTypeIds,
        'targetPreconditions.itemTypeIds',
      ),
      [seed.modelId],
    );
    assert.deepEqual(
      requiredStringArray(
        preconditions.selectedRecordIds,
        'targetPreconditions.selectedRecordIds',
      ).sort(compareIds),
      managedRecordIds(seed),
    );
    assert.deepEqual(
      requiredStringArray(
        preconditions.desiredRecordIds,
        'targetPreconditions.desiredRecordIds',
      ).sort(compareIds),
      managedRecordIds(seed).filter((id) => id !== seed.deleteDependencyId),
    );
    assert.deepEqual(preconditions.selectedUploadIds, []);
    assert.deepEqual(preconditions.desiredUploadIds, []);

    assert.equal(
      requiredObject(plan.options, 'plan.options').includeDeletions,
      true,
    );
    assert.deepEqual(
      requiredObject(
        requiredObject(plan.summary, 'plan.summary').records,
        'summary.records',
      ),
      { create: 0, update: 5, delete: 1 },
    );
    assert.deepEqual(plan.warnings, []);

    const permissions = requiredObject(
      plan.requiredPermissions,
      'plan.requiredPermissions',
    );
    const itemTypePermission = requiredArray(
      permissions.itemTypes,
      'requiredPermissions.itemTypes',
    )
      .map((entry, index) =>
        requiredObject(entry, `requiredPermissions.itemTypes[${index}]`),
      )
      .find(({ id }) => id === seed.modelId);
    assert.ok(itemTypePermission, 'managed model permissions are absent');
    assert.deepEqual(itemTypePermission.actions, [
      'read',
      'update',
      'publish',
      'delete',
    ]);
    assert.equal(permissions.editSchema, false);

    assertPlanReferenceStrategies(plan, seed.modelId);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying exact raw versioned cascade state after apply',
    );
    const recordIds = managedRecordIds(seed);
    const [source, destination, applied] = await Promise.all([
      captureManagedState(sourceClient, seed.modelId, recordIds),
      captureManagedState(destinationClient, seed.modelId, recordIds),
      captureManagedState(appliedClient, seed.modelId, recordIds),
    ]);
    assert.deepEqual(source, expected.source, 'source raw state changed');
    assert.deepEqual(
      destination,
      expected.destination,
      'destination raw state changed',
    );
    assert.deepEqual(
      applied,
      expected.source,
      'applied raw current/published state did not exactly match source',
    );
    assertSourceCascadeFixture(applied, seed);
  },
};

export const externalFailUnpublishBoundaryScenario: RealCmaScenario<
  BoundarySeed,
  void
> = {
  name: 'external fail-strategy published referrer rejects managed unpublish',
  expectedGenerationFailure: {
    messagePattern: EXTERNAL_UNPUBLISH_REFERRER_FAILURE_PATTERN,
  },

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating external fail-strategy boundary');
    const targetApiKey = cascadeStrategyApiKey('target', runId);
    const referrerApiKey = cascadeStrategyApiKey('referrer', runId);
    const targetModel = await createModel(client, targetApiKey, runId);
    await client.fields.create(targetModel.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const referrerModel = await createModel(client, referrerApiKey, runId);
    await client.fields.create(referrerModel.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(referrerModel.id, {
      label: 'Target',
      api_key: 'target',
      field_type: 'link',
      localized: false,
      validators: referenceValidators(
        targetModel.id,
        CASCADE_REFERENCE_STRATEGIES.fail,
      ),
    });

    const target = await client.items.create<BoundaryTargetDefinition>({
      item_type: { id: targetModel.id, type: 'item_type' },
      label: 'managed unpublish target',
    });
    await client.items.publish<BoundaryTargetDefinition>(target.id, undefined, {
      recursive: false,
    });
    const referrer = await client.items.create<BoundaryReferrerDefinition>({
      item_type: { id: referrerModel.id, type: 'item_type' },
      label: 'out-of-scope published referrer',
      target: target.id,
    });
    await client.items.publish<BoundaryReferrerDefinition>(
      referrer.id,
      undefined,
      { recursive: false },
    );

    return {
      itemTypeApiKeys: [targetApiKey],
      targetModelId: targetModel.id,
      referrerModelId: referrerModel.id,
      targetId: target.id,
      referrerId: referrer.id,
    };
  },

  async introduceDrift({ seed, sourceClient }) {
    console.log(
      '[content-diff e2e] Removing only the source external link before unpublishing',
    );
    await sourceClient.items.update<BoundaryReferrerDefinition>(
      seed.referrerId,
      { target: null },
    );
    await sourceClient.items.publish<BoundaryReferrerDefinition>(
      seed.referrerId,
      undefined,
      { recursive: false },
    );
    await sourceClient.items.unpublish<BoundaryTargetDefinition>(
      seed.targetId,
      undefined,
      { recursive: false },
    );
  },
};

async function createModel(
  client: CmaClient.Client,
  apiKey: string,
  runId: string,
): Promise<CmaClient.ApiTypes.ItemType> {
  return client.itemTypes.create({
    name: `Cascade strategies ${runId} ${apiKey}`,
    api_key: apiKey,
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
}

async function createManagedFields(
  client: CmaClient.Client,
  modelId: string,
): Promise<void> {
  await client.fields.create(modelId, {
    label: 'Label',
    api_key: 'label',
    field_type: 'string',
    localized: false,
    validators: { required: {} },
  });
  await client.fields.create(modelId, {
    label: 'Publish reference',
    api_key: 'publish_ref',
    field_type: 'link',
    localized: false,
    validators: referenceValidators(
      modelId,
      CASCADE_REFERENCE_STRATEGIES.publishReferences,
    ),
  });
  await client.fields.create(modelId, {
    label: 'Unpublish reference',
    api_key: 'unpublish_ref',
    field_type: 'link',
    localized: false,
    validators: referenceValidators(
      modelId,
      CASCADE_REFERENCE_STRATEGIES.unpublish,
    ),
  });
  await client.fields.create(modelId, {
    label: 'Delete reference',
    api_key: 'delete_ref',
    field_type: 'link',
    localized: false,
    validators: referenceValidators(
      modelId,
      CASCADE_REFERENCE_STRATEGIES.deleteReferences,
    ),
  });
}

function referenceValidators(modelId: string, strategy: ReferenceStrategy) {
  return {
    item_item_type: {
      item_types: [modelId],
      ...strategy,
    },
  };
}

async function createManagedRecord(
  client: CmaClient.Client,
  modelId: string,
  label: string,
  references: Readonly<
    Partial<
      Pick<
        CmaClient.ApiTypes.ItemCreateSchema<ManagedDefinition>,
        'publish_ref' | 'unpublish_ref' | 'delete_ref'
      >
    >
  > = {},
): Promise<CmaClient.ApiTypes.Item<ManagedDefinition>> {
  return client.items.create<ManagedDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    label,
    publish_ref: null,
    unpublish_ref: null,
    delete_ref: null,
    ...references,
  });
}

async function publishWithoutTreeRecursion(
  client: CmaClient.Client,
  recordId: string,
): Promise<void> {
  await client.items.publish<ManagedDefinition>(recordId, undefined, {
    recursive: false,
  });
}

async function unpublishWithoutTreeRecursion(
  client: CmaClient.Client,
  recordId: string,
): Promise<void> {
  await client.items.unpublish<ManagedDefinition>(recordId, undefined, {
    recursive: false,
  });
}

function managedRecordIds(seed: ManagedSeed): string[] {
  return [
    seed.publishDependencyId,
    seed.publishConsumerId,
    seed.unpublishDependencyId,
    seed.unpublishConsumerId,
    seed.deleteDependencyId,
    seed.deleteConsumerId,
  ].sort(compareIds);
}

async function captureManagedState(
  client: CmaClient.Client,
  modelId: string,
  recordIds: readonly string[],
): Promise<RawManagedState> {
  return Promise.all(
    [...recordIds].sort(compareIds).map(async (recordId) => {
      const [current, published] = await Promise.all([
        captureManagedSlice(client, modelId, recordId, 'current'),
        captureManagedSlice(client, modelId, recordId, 'published'),
      ]);
      return { id: recordId, current, published };
    }),
  );
}

async function captureManagedSlice(
  client: CmaClient.Client,
  modelId: string,
  recordId: string,
  version: 'current' | 'published',
): Promise<RawRecordSlice | null> {
  let response: unknown;
  try {
    response = await client.items.rawFind(recordId, { version });
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return null;
    }
    throw error;
  }
  const resource = requiredObject(
    requiredObject(response, `${version} ${recordId} response`).data,
    `${version} ${recordId} resource`,
  );
  assert.equal(requiredString(resource.id, `${recordId}.id`), recordId);
  const relationships = requiredObject(
    resource.relationships,
    `${recordId}.relationships`,
  );
  const itemTypeId = requiredString(
    requiredObject(
      requiredObject(relationships.item_type, `${recordId}.item_type`).data,
      `${recordId}.item_type.data`,
    ).id,
    `${recordId}.item_type.data.id`,
  );
  assert.equal(itemTypeId, modelId);
  const attributes = requiredObject(
    resource.attributes,
    `${recordId}.attributes`,
  );
  const meta = requiredObject(resource.meta, `${recordId}.meta`);

  return {
    id: recordId,
    itemTypeId,
    fields: {
      label: requiredString(attributes.label, `${recordId}.label`),
      publishRef: nullableString(
        attributes.publish_ref,
        `${recordId}.publish_ref`,
      ),
      unpublishRef: nullableString(
        attributes.unpublish_ref,
        `${recordId}.unpublish_ref`,
      ),
      deleteRef: nullableString(
        attributes.delete_ref,
        `${recordId}.delete_ref`,
      ),
    },
    lifecycle: {
      createdAt: requiredString(meta.created_at, `${recordId}.created_at`),
      firstPublishedAt: nullableString(
        meta.first_published_at,
        `${recordId}.first_published_at`,
      ),
      status: requiredString(meta.status, `${recordId}.status`),
    },
    validity: {
      slice: requiredBoolean(meta.is_valid, `${recordId}.is_valid`),
      current: nullableBoolean(
        meta.is_current_version_valid,
        `${recordId}.is_current_version_valid`,
      ),
      published: nullableBoolean(
        meta.is_published_version_valid,
        `${recordId}.is_published_version_valid`,
      ),
    },
  };
}

function assertDestinationCascadeFixture(
  state: RawManagedState,
  seed: ManagedSeed,
): void {
  assert.deepEqual(
    idsWithSlice(state, 'current'),
    managedRecordIds(seed),
    'destination baseline does not contain every current record',
  );
  assert.deepEqual(
    idsWithSlice(state, 'published'),
    [
      seed.unpublishDependencyId,
      seed.unpublishConsumerId,
      seed.deleteDependencyId,
      seed.deleteConsumerId,
    ].sort(compareIds),
    'destination published baseline is not the intended cascade graph',
  );
  assert.equal(record(state, seed.publishDependencyId).published, null);
  assert.equal(record(state, seed.publishConsumerId).published, null);
  assert.equal(
    record(state, seed.publishConsumerId).current?.fields.publishRef,
    seed.publishDependencyId,
  );
  assert.equal(
    record(state, seed.unpublishConsumerId).published?.fields.unpublishRef,
    seed.unpublishDependencyId,
  );
  assert.equal(
    record(state, seed.deleteConsumerId).current?.fields.deleteRef,
    seed.deleteDependencyId,
  );
  assert.equal(
    record(state, seed.deleteConsumerId).published?.fields.deleteRef,
    seed.deleteDependencyId,
  );
  assertAllPresentSlicesValid(state);
}

function assertSourceCascadeFixture(
  state: RawManagedState,
  seed: ManagedSeed,
): void {
  assert.deepEqual(
    idsWithSlice(state, 'current'),
    managedRecordIds(seed).filter((id) => id !== seed.deleteDependencyId),
  );
  assert.deepEqual(
    idsWithSlice(state, 'published'),
    [
      seed.publishDependencyId,
      seed.publishConsumerId,
      seed.deleteConsumerId,
    ].sort(compareIds),
  );
  assert.equal(
    record(state, seed.publishConsumerId).published?.fields.publishRef,
    seed.publishDependencyId,
    'publish_references did not publish the dependency and consumer graph',
  );
  assert.equal(record(state, seed.unpublishDependencyId).published, null);
  assert.equal(record(state, seed.unpublishConsumerId).published, null);
  assert.equal(
    record(state, seed.unpublishConsumerId).current?.fields.unpublishRef,
    seed.unpublishDependencyId,
    'unpublish strategy unexpectedly scrubbed the retained current reference',
  );
  assert.equal(record(state, seed.deleteDependencyId).current, null);
  assert.equal(record(state, seed.deleteDependencyId).published, null);
  assert.equal(
    record(state, seed.deleteConsumerId).current?.fields.deleteRef,
    null,
    'delete_references did not scrub the current consumer slice',
  );
  assert.equal(
    record(state, seed.deleteConsumerId).published?.fields.deleteRef,
    null,
    'delete_references did not scrub the published consumer slice',
  );
  assertAllPresentSlicesValid(state);
}

function assertAllPresentSlicesValid(state: RawManagedState): void {
  for (const versioned of state) {
    for (const slice of [versioned.current, versioned.published]) {
      if (!slice) continue;
      assert.equal(slice.validity.slice, true, `${slice.id} slice is invalid`);
      assert.equal(
        slice.validity.current,
        true,
        `${slice.id} current version is invalid`,
      );
      if (versioned.published) {
        assert.equal(
          slice.validity.published,
          true,
          `${slice.id} published version is invalid`,
        );
      } else {
        assert.equal(slice.validity.published, null);
      }
    }
  }
}

function idsWithSlice(
  state: RawManagedState,
  version: 'current' | 'published',
): string[] {
  return state
    .filter((entry) => entry[version] !== null)
    .map(({ id }) => id)
    .sort(compareIds);
}

function record(state: RawManagedState, recordId: string): RawVersionedRecord {
  const match = state.find(({ id }) => id === recordId);
  assert.ok(match, `record ${recordId} is absent from raw oracle`);
  return match;
}

async function readGeneratedPlan(
  planFilePath: string,
): Promise<Record<string, unknown>> {
  const envelope = requiredObject(
    JSON.parse(await readFile(planFilePath, 'utf8')),
    'plan envelope',
  );
  return requiredObject(envelope.plan, 'plan envelope.plan');
}

function assertPlanReferenceStrategies(
  plan: Record<string, unknown>,
  modelId: string,
): void {
  const schema = requiredObject(plan.schema, 'plan.schema');
  const model = requiredArray(schema.itemTypes, 'plan.schema.itemTypes')
    .map((entry, index) =>
      requiredObject(entry, `plan.schema.itemTypes[${index}]`),
    )
    .find(({ id }) => id === modelId);
  assert.ok(model, `model ${modelId} is absent from plan schema`);
  const fields = new Map(
    requiredArray(model.fields, `model ${modelId} fields`).map(
      (entry, index) => {
        const field = requiredObject(entry, `model field ${index}`);
        return [
          requiredString(field.apiKey, `model field ${index} API key`),
          field,
        ];
      },
    ),
  );
  for (const [apiKey, strategy] of [
    ['publish_ref', CASCADE_REFERENCE_STRATEGIES.publishReferences],
    ['unpublish_ref', CASCADE_REFERENCE_STRATEGIES.unpublish],
    ['delete_ref', CASCADE_REFERENCE_STRATEGIES.deleteReferences],
  ] as const) {
    const field = fields.get(apiKey);
    assert.ok(field, `plan schema is missing ${apiKey}`);
    assert.deepEqual(
      requiredObject(field.validators, `${apiKey}.validators`),
      referenceValidators(modelId, strategy),
      `${apiKey} lost its explicit remote-normalized cascade contract`,
    );
  }
}

function snapshotField(
  recordPlan: Record<string, unknown>,
  snapshot: 'baseline' | 'desired',
  version: 'current' | 'published',
  fieldApiKey: string,
): unknown {
  const snapshotValue = requiredObject(
    recordPlan[snapshot],
    `record.${snapshot}`,
  );
  const versionValue = requiredObject(
    snapshotValue[version],
    `record.${snapshot}.${version}`,
  );
  return requiredObject(
    versionValue.fields,
    `record.${snapshot}.${version}.fields`,
  )[fieldApiKey];
}

function assertRunsBefore(
  order: readonly string[],
  first: string,
  second: string,
  label: string,
): void {
  const firstIndex = order.indexOf(first);
  const secondIndex = order.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label}: ${first} is absent`);
  assert.notEqual(secondIndex, -1, `${label}: ${second} is absent`);
  assert.ok(firstIndex < secondIndex, `${label}: generated order is reversed`);
}

function requiredObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requiredStringArray(value: unknown, path: string): string[] {
  return requiredArray(value, path).map((entry, index) =>
    requiredString(entry, `${path}[${index}]`),
  );
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requiredString(value, path);
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  return requiredBoolean(value, path);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
