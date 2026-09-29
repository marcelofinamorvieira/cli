import assert from 'node:assert/strict';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type OrderedItemDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    position: { type: 'integer'; localized: false };
    parent_id: { type: 'string'; localized: false };
  };
};

type TopologySeed = RealCmaScenarioSeed &
  Readonly<{
    treeModelId: string;
    sortableModelId: string;
    rootId: string;
    leftId: string;
    rightId: string;
    grandchildId: string;
    firstId: string;
    secondId: string;
    thirdId: string;
  }>;

type RawOrderedRecord = Readonly<{
  id: string;
  itemTypeId: string;
  title: string | null;
  parentId: string | null;
  position: number;
  stage: string | null;
}>;

type RawTopologyState = Readonly<{
  tree: readonly RawOrderedRecord[];
  sortable: readonly RawOrderedRecord[];
}>;

type TopologyExpected = Readonly<{
  sourceOnlyTreeId: string;
  sourceOnlySortableId: string;
  destinationOnlyTreeId: string;
  destinationOnlySortableId: string;
  source: RawTopologyState;
  destination: RawTopologyState;
}>;

const REVIEW_STAGE = 'review';
const READY_STAGE = 'ready';

export const topologyWorkflowScenario: RealCmaScenario<
  TopologySeed,
  TopologyExpected
> = {
  name: 'tree topology, sortable ordering, and workflow stages',
  contentDiffArgs: ['--include-deletions'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating topology fixture schema');
    const suffix = runId.replace(/[^a-z0-9]/g, '');
    const treeApiKey = `cde2et${suffix}`;
    const sortableApiKey = `cde2es${suffix}`;
    const workflow = await client.workflows.create({
      name: `Editorial ${runId}`,
      api_key: `cde2ew${suffix}`,
      stages: [
        { id: 'draft', name: 'Draft', initial: true },
        { id: REVIEW_STAGE, name: 'Review' },
        { id: READY_STAGE, name: 'Ready' },
      ],
    });
    const treeModel = await createOrderedModel(client, {
      name: `Tree ${runId}`,
      apiKey: treeApiKey,
      tree: true,
      sortable: false,
    });
    const sortableModel = await createOrderedModel(client, {
      name: `Sortable ${runId}`,
      apiKey: sortableApiKey,
      tree: false,
      sortable: true,
    });
    await client.itemTypes.update(sortableModel.id, {
      workflow: { id: workflow.id, type: 'workflow' },
    });

    const root = await createOrderedRecord(
      client,
      treeModel.id,
      'root',
      0,
      null,
    );
    const left = await createOrderedRecord(
      client,
      treeModel.id,
      'left',
      0,
      root.id,
    );
    const right = await createOrderedRecord(
      client,
      treeModel.id,
      'right',
      1,
      root.id,
    );
    const grandchild = await createOrderedRecord(
      client,
      treeModel.id,
      'grandchild',
      0,
      left.id,
    );

    const first = await createOrderedRecord(
      client,
      sortableModel.id,
      'first',
      0,
    );
    const second = await createOrderedRecord(
      client,
      sortableModel.id,
      'second',
      1,
    );
    const third = await createOrderedRecord(
      client,
      sortableModel.id,
      'third',
      2,
    );

    return {
      itemTypeApiKeys: [treeApiKey, sortableApiKey],
      treeModelId: treeModel.id,
      sortableModelId: sortableModel.id,
      rootId: root.id,
      leftId: left.id,
      rightId: right.id,
      grandchildId: grandchild.id,
      firstId: first.id,
      secondId: second.id,
      thirdId: third.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log('[content-diff e2e] Creating topology and workflow drift');

    const sourceOnlyTree = await createOrderedRecord(
      sourceClient,
      seed.treeModelId,
      'source-only tree child',
      0,
      seed.leftId,
    );
    await placeTreeRecords(sourceClient, [
      {
        id: seed.rightId,
        parentId: seed.leftId,
        position: 1,
      },
      {
        id: seed.grandchildId,
        parentId: seed.rootId,
        position: 0,
      },
      { id: seed.leftId, parentId: seed.rootId, position: 1 },
    ]);

    const sourceOnlySortable = await createOrderedRecord(
      sourceClient,
      seed.sortableModelId,
      'source-only sortable',
      3,
    );
    await placeSortableRecords(sourceClient, [
      seed.thirdId,
      sourceOnlySortable.id,
      seed.firstId,
      seed.secondId,
    ]);
    await moveToStage(sourceClient, REVIEW_STAGE, [seed.firstId, seed.thirdId]);
    await moveToStage(sourceClient, READY_STAGE, [
      seed.secondId,
      sourceOnlySortable.id,
    ]);

    const destinationOnlyTree = await createOrderedRecord(
      destinationClient,
      seed.treeModelId,
      'destination-only tree child',
      0,
      seed.rootId,
    );
    await placeTreeRecords(destinationClient, [
      { id: seed.rightId, parentId: seed.rootId, position: 0 },
      {
        id: destinationOnlyTree.id,
        parentId: seed.rootId,
        position: 1,
      },
      { id: seed.leftId, parentId: seed.rootId, position: 2 },
    ]);

    const destinationOnlySortable = await createOrderedRecord(
      destinationClient,
      seed.sortableModelId,
      'destination-only sortable',
      3,
    );
    await placeSortableRecords(destinationClient, [
      seed.secondId,
      destinationOnlySortable.id,
      seed.firstId,
      seed.thirdId,
    ]);
    await moveToStage(destinationClient, REVIEW_STAGE, [
      seed.secondId,
      destinationOnlySortable.id,
    ]);
    await moveToStage(destinationClient, READY_STAGE, [
      seed.firstId,
      seed.thirdId,
    ]);

    const source = await captureRawTopologyState(sourceClient, seed);
    const destination = await captureRawTopologyState(destinationClient, seed);
    assert.notDeepEqual(
      destination,
      source,
      'topology fixture failed to create source/destination drift',
    );

    return {
      sourceOnlyTreeId: sourceOnlyTree.id,
      sourceOnlySortableId: sourceOnlySortable.id,
      destinationOnlyTreeId: destinationOnlyTree.id,
      destinationOnlySortableId: destinationOnlySortable.id,
      source,
      destination,
    };
  },

  async verify({ seed, expected, appliedClient }) {
    console.log(
      '[content-diff e2e] Verifying topology and workflow through raw CMA',
    );
    const actual = await captureRawTopologyState(appliedClient, seed);

    assert.deepEqual(
      actual,
      expected.source,
      'applied topology/workflow state differs from the raw source state',
    );
    assert.deepEqual(
      orderedChildren(actual.tree, seed.rootId),
      [seed.grandchildId, seed.leftId],
      'root sibling order did not converge',
    );
    assert.deepEqual(
      orderedChildren(actual.tree, seed.leftId),
      [expected.sourceOnlyTreeId, seed.rightId],
      'nested sibling order did not converge',
    );
    assert.deepEqual(
      actual.sortable
        .slice()
        .sort(compareByPosition)
        .map(({ id }) => id),
      [
        seed.thirdId,
        expected.sourceOnlySortableId,
        seed.firstId,
        seed.secondId,
      ],
      'sortable record order did not converge',
    );
    assert.equal(
      recordById(actual.sortable, seed.firstId).stage,
      REVIEW_STAGE,
      'first record did not reach the source workflow stage',
    );
    assert.equal(
      recordById(actual.sortable, seed.secondId).stage,
      READY_STAGE,
      'second record did not reach the source workflow stage',
    );
    assert.equal(
      actual.tree.some(({ id }) => id === expected.destinationOnlyTreeId),
      false,
      'destination-only tree record survived --include-deletions',
    );
    assert.equal(
      actual.sortable.some(
        ({ id }) => id === expected.destinationOnlySortableId,
      ),
      false,
      'destination-only sortable record survived --include-deletions',
    );
  },
};

async function createOrderedModel(
  client: CmaClient.Client,
  options: Readonly<{
    name: string;
    apiKey: string;
    tree: boolean;
    sortable: boolean;
  }>,
): Promise<CmaClient.ApiTypes.ItemType> {
  const model = await client.itemTypes.create({
    name: options.name,
    api_key: options.apiKey,
    singleton: false,
    all_locales_required: false,
    sortable: options.sortable,
    modular_block: false,
    draft_mode_active: true,
    draft_saving_active: false,
    tree: options.tree,
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
  return model;
}

async function createOrderedRecord(
  client: CmaClient.Client,
  itemTypeId: string,
  title: string,
  position: number,
  parentId?: string | null,
): Promise<CmaClient.ApiTypes.Item<OrderedItemDefinition>> {
  if (parentId === undefined) {
    return client.items.create<OrderedItemDefinition>({
      item_type: { id: itemTypeId, type: 'item_type' },
      title,
      position,
    });
  }

  return client.items.create<OrderedItemDefinition>({
    item_type: { id: itemTypeId, type: 'item_type' },
    title,
    position,
    parent_id: parentId,
  });
}

async function placeTreeRecords(
  client: CmaClient.Client,
  placements: readonly Readonly<{
    id: string;
    parentId: string | null;
    position: number;
  }>[],
): Promise<void> {
  for (const placement of placements) {
    await client.items.update<OrderedItemDefinition>(placement.id, {
      parent_id: placement.parentId,
      position: placement.position,
    });
  }
}

async function placeSortableRecords(
  client: CmaClient.Client,
  recordIds: readonly string[],
): Promise<void> {
  for (const [position, id] of recordIds.entries()) {
    await client.items.update<OrderedItemDefinition>(id, { position });
  }
}

async function moveToStage(
  client: CmaClient.Client,
  stage: string,
  recordIds: readonly string[],
): Promise<void> {
  await client.items.bulkMoveToStage({
    stage,
    items: recordIds.map<CmaClient.ApiTypes.ItemData>((id) => ({
      id,
      type: 'item',
    })),
  });
}

async function captureRawTopologyState(
  client: CmaClient.Client,
  seed: TopologySeed,
): Promise<RawTopologyState> {
  const [tree, sortable] = await Promise.all([
    captureRawOrderedRecords(client, seed.treeModelId),
    captureRawOrderedRecords(client, seed.sortableModelId),
  ]);
  return { tree, sortable };
}

async function captureRawOrderedRecords(
  client: CmaClient.Client,
  itemTypeId: string,
): Promise<readonly RawOrderedRecord[]> {
  const response = await client.items.rawList<OrderedItemDefinition>({
    filter: { type: itemTypeId },
    version: 'current',
    order_by: 'id_ASC',
    page: { limit: 500 },
  });

  return response.data
    .map((record) => {
      const position = record.attributes.position;
      if (typeof position !== 'number') {
        throw new Error(`record ${record.id} has no numeric CMA position`);
      }
      return {
        id: record.id,
        itemTypeId: record.relationships.item_type.data.id,
        title: record.attributes.title,
        parentId: record.attributes.parent_id ?? null,
        position,
        stage: record.meta.stage,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function orderedChildren(
  records: readonly RawOrderedRecord[],
  parentId: string,
): string[] {
  return records
    .filter((record) => record.parentId === parentId)
    .sort(compareByPosition)
    .map(({ id }) => id);
}

function compareByPosition(
  left: RawOrderedRecord,
  right: RawOrderedRecord,
): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function recordById(
  records: readonly RawOrderedRecord[],
  id: string,
): RawOrderedRecord {
  const record = records.find((candidate) => candidate.id === id);
  assert.ok(record, `raw CMA did not return record ${id}`);
  return record;
}
