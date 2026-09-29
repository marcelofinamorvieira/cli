import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Definition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    parent_id: { type: 'string'; localized: false };
    position: { type: 'integer'; localized: false };
  };
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    rootId: string;
    movingId: string;
  }>;

type RawTreeRecord = Readonly<{
  id: string;
  title: string;
  parentId: string | null;
  position: number;
  status: string;
  currentValid: boolean | null;
  publishedValid: boolean | null;
}>;

type RawTreeState = Readonly<{
  current: readonly RawTreeRecord[];
  published: readonly RawTreeRecord[];
}>;

type Expected = Readonly<{
  sourceParentId: string;
  sourceChildId: string;
  destinationParentId: string;
  destinationChildId: string;
  source: RawTreeState;
  destination: RawTreeState;
}>;

export function publishedTreeApiKey(runId: string): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return `cde2e_ptr_r${suffix}`;
}

export const publishedTreeScenario: RealCmaScenario<Seed, Expected> = {
  name: 'published tree create, reparent, unpublish, and subtree deletion order',
  contentDiffArgs: ['--include-deletions'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating published tree baseline');
    const apiKey = publishedTreeApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Published tree ${runId}`,
      api_key: apiKey,
      singleton: false,
      all_locales_required: false,
      sortable: false,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: false,
      tree: true,
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
    const root = await createTreeRecord(client, model.id, {
      title: 'shared root',
      parentId: null,
      position: 0,
    });
    const moving = await createTreeRecord(client, model.id, {
      title: 'shared moving child',
      parentId: root.id,
      position: 0,
    });
    await client.items.publish<Definition>(root.id, undefined, {
      recursive: false,
    });
    await client.items.publish<Definition>(moving.id, undefined, {
      recursive: false,
    });

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      rootId: root.id,
      movingId: moving.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log('[content-diff e2e] Creating published subtree drift');
    const sourceParent = await createTreeRecord(sourceClient, seed.modelId, {
      title: 'source-only published parent',
      parentId: seed.rootId,
      position: 1,
    });
    const sourceChild = await createTreeRecord(sourceClient, seed.modelId, {
      title: 'source-only published child',
      parentId: sourceParent.id,
      position: 0,
    });
    await sourceClient.items.publish<Definition>(sourceParent.id, undefined, {
      recursive: false,
    });
    await sourceClient.items.publish<Definition>(sourceChild.id, undefined, {
      recursive: false,
    });

    const destinationParent = await createTreeRecord(
      destinationClient,
      seed.modelId,
      {
        title: 'destination-only published parent',
        parentId: seed.rootId,
        position: 0,
      },
    );
    await destinationClient.items.publish<Definition>(
      destinationParent.id,
      undefined,
      { recursive: false },
    );
    await destinationClient.items.update<Definition>(seed.movingId, {
      parent_id: destinationParent.id,
      position: 0,
    });
    const destinationChild = await createTreeRecord(
      destinationClient,
      seed.modelId,
      {
        title: 'destination-only published child',
        parentId: destinationParent.id,
        position: 1,
      },
    );
    await destinationClient.items.publish<Definition>(
      destinationChild.id,
      undefined,
      { recursive: false },
    );

    const [source, destination] = await Promise.all([
      captureTreeState(sourceClient, seed.modelId),
      captureTreeState(destinationClient, seed.modelId),
    ]);
    assert.notDeepEqual(source, destination);
    assert.deepEqual(childrenOf(source.current, seed.rootId), [
      seed.movingId,
      sourceParent.id,
    ]);
    assert.deepEqual(childrenOf(destination.current, destinationParent.id), [
      seed.movingId,
      destinationChild.id,
    ]);

    return {
      sourceParentId: sourceParent.id,
      sourceChildId: sourceChild.id,
      destinationParentId: destinationParent.id,
      destinationChildId: destinationChild.id,
      source,
      destination,
    };
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying published parent-first and child-first ordering',
    );
    const [source, destination, applied] = await Promise.all([
      captureTreeState(sourceClient, seed.modelId),
      captureTreeState(destinationClient, seed.modelId),
      captureTreeState(appliedClient, seed.modelId),
    ]);
    assert.deepEqual(source, expected.source);
    assert.deepEqual(destination, expected.destination);
    assert.deepEqual(applied, expected.source);
    assert.deepEqual(childrenOf(applied.current, seed.rootId), [
      seed.movingId,
      expected.sourceParentId,
    ]);
    assert.deepEqual(childrenOf(applied.current, expected.sourceParentId), [
      expected.sourceChildId,
    ]);
    for (const id of [
      expected.destinationParentId,
      expected.destinationChildId,
    ]) {
      assert.equal(
        applied.current.some((record) => record.id === id),
        false,
      );
      assert.equal(
        applied.published.some((record) => record.id === id),
        false,
      );
    }
    for (const id of [
      seed.rootId,
      seed.movingId,
      expected.sourceParentId,
      expected.sourceChildId,
    ]) {
      assert.ok(applied.published.some((record) => record.id === id));
    }
  },
};

async function createTreeRecord(
  client: CmaClient.Client,
  modelId: string,
  input: Readonly<{
    title: string;
    parentId: string | null;
    position: number;
  }>,
): Promise<CmaClient.ApiTypes.Item<Definition>> {
  return client.items.create<Definition>({
    item_type: { id: modelId, type: 'item_type' },
    title: input.title,
    parent_id: input.parentId,
    position: input.position,
  });
}

async function captureTreeState(
  client: CmaClient.Client,
  modelId: string,
): Promise<RawTreeState> {
  const [current, published] = await Promise.all(
    (['current', 'published'] as const).map(async (version) => {
      const response = await client.items.rawList<Definition>({
        filter: { type: modelId },
        version,
        order_by: 'id_ASC',
        page: { limit: 500 },
      });
      return response.data
        .map((record) => {
          const position = record.attributes.position;
          const title = record.attributes.title;
          if (typeof position !== 'number') {
            throw new Error(`record ${record.id} has no numeric position`);
          }
          if (typeof title !== 'string') {
            throw new Error(`record ${record.id} has no string title`);
          }
          return {
            id: record.id,
            title,
            parentId: record.attributes.parent_id ?? null,
            position,
            status: String(record.meta.status),
            currentValid:
              typeof record.meta.is_current_version_valid === 'boolean'
                ? record.meta.is_current_version_valid
                : null,
            publishedValid:
              typeof record.meta.is_published_version_valid === 'boolean'
                ? record.meta.is_published_version_valid
                : null,
          } satisfies RawTreeRecord;
        })
        .sort((left, right) => compareDatoIds(left.id, right.id));
    }),
  );
  return { current, published };
}

function childrenOf(
  records: readonly RawTreeRecord[],
  parentId: string,
): string[] {
  return records
    .filter((record) => record.parentId === parentId)
    .sort(
      (left, right) =>
        left.position - right.position || compareDatoIds(left.id, right.id),
    )
    .map(({ id }) => id);
}

function compareDatoIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
