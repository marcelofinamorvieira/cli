import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type ParentDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
  };
};

type SingletonDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    dependency: { type: 'link'; localized: false };
  };
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    parentModelId: string;
    singletonModelId: string;
  }>;

type RawRecord = Readonly<{
  id: string;
  itemTypeId: string;
  title: string;
  dependencyId: string | null;
  status: string;
  currentValid: boolean | null;
  publishedValid: boolean | null;
}>;

type RawState = Readonly<{
  current: readonly RawRecord[];
  published: readonly RawRecord[];
  singletonItemId: string | null;
}>;

type Expected = Readonly<{
  parentRecordId: string;
  singletonRecordId: string;
  source: RawState;
  destination: RawState;
}>;

export const NO_DRAFT_SINGLETON_FIELD_API_KEYS = {
  title: 'title',
  dependency: 'dependency',
} as const;

export function noDraftSingletonApiKeys(runId: string): Readonly<{
  parent: string;
  singleton: string;
}> {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return {
    parent: `cde2e_ndp_r${suffix}`,
    singleton: `cde2e_nds_r${suffix}`,
  };
}

export const noDraftSingletonScenario: RealCmaScenario<Seed, Expected> = {
  name: 'source-only no-draft dependency and singleton creation',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating no-draft singleton schema');
    const apiKeys = noDraftSingletonApiKeys(runId);
    const parentModel = await createModel(client, {
      name: `No-draft parent ${runId}`,
      apiKey: apiKeys.parent,
      singleton: false,
    });
    const singletonModel = await createModel(client, {
      name: `No-draft singleton ${runId}`,
      apiKey: apiKeys.singleton,
      singleton: true,
    });
    await client.fields.create(parentModel.id, {
      label: 'Title',
      api_key: NO_DRAFT_SINGLETON_FIELD_API_KEYS.title,
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(singletonModel.id, {
      label: 'Title',
      api_key: NO_DRAFT_SINGLETON_FIELD_API_KEYS.title,
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(singletonModel.id, {
      label: 'Parent',
      api_key: NO_DRAFT_SINGLETON_FIELD_API_KEYS.dependency,
      field_type: 'link',
      localized: false,
      validators: {
        required: {},
        item_item_type: {
          item_types: [parentModel.id],
          on_publish_with_unpublished_references_strategy: 'fail',
          on_reference_unpublish_strategy: 'fail',
          on_reference_delete_strategy: 'fail',
        },
      },
    });

    return {
      itemTypeApiKeys: [apiKeys.parent, apiKeys.singleton],
      parentModelId: parentModel.id,
      singletonModelId: singletonModel.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating source-only no-draft dependency and singleton',
    );
    const parent = await sourceClient.items.create<ParentDefinition>({
      item_type: { id: seed.parentModelId, type: 'item_type' },
      title: 'published parent',
    });
    const singleton = await sourceClient.items.create<SingletonDefinition>({
      item_type: { id: seed.singletonModelId, type: 'item_type' },
      title: 'published singleton',
      dependency: parent.id,
    });
    const [source, destination] = await Promise.all([
      captureState(sourceClient, seed),
      captureState(destinationClient, seed),
    ]);

    assert.deepEqual(
      source.current.map(({ id }) => id),
      [parent.id, singleton.id].sort(compareDatoIds),
    );
    assert.deepEqual(
      source.published.map(({ id }) => id),
      [parent.id, singleton.id].sort(compareDatoIds),
      'no-draft creates were not immediately published',
    );
    assert.deepEqual(destination.current, []);
    assert.deepEqual(destination.published, []);
    assert.equal(source.singletonItemId, singleton.id);
    assert.equal(destination.singletonItemId, null);

    return {
      parentRecordId: parent.id,
      singletonRecordId: singleton.id,
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
      '[content-diff e2e] Verifying no-draft publication ordering and singleton identity',
    );
    const [source, destination, applied] = await Promise.all([
      captureState(sourceClient, seed),
      captureState(destinationClient, seed),
      captureState(appliedClient, seed),
    ]);
    assert.deepEqual(source, expected.source);
    assert.deepEqual(destination, expected.destination);
    assert.deepEqual(applied, expected.source);
    assert.equal(applied.singletonItemId, expected.singletonRecordId);

    const singleton = applied.current.find(
      ({ id }) => id === expected.singletonRecordId,
    );
    assert.equal(singleton?.dependencyId, expected.parentRecordId);
    assert.ok(
      applied.published.some(({ id }) => id === expected.parentRecordId),
      'parent dependency was not published before the singleton',
    );
    assert.ok(
      applied.published.some(({ id }) => id === expected.singletonRecordId),
      'singleton was not published',
    );
  },
};

async function createModel(
  client: CmaClient.Client,
  input: Readonly<{ name: string; apiKey: string; singleton: boolean }>,
): Promise<CmaClient.ApiTypes.ItemType> {
  return client.itemTypes.create({
    name: input.name,
    api_key: input.apiKey,
    singleton: input.singleton,
    all_locales_required: false,
    sortable: false,
    modular_block: false,
    draft_mode_active: false,
    draft_saving_active: false,
    tree: false,
    collection_appearance: 'compact',
    inverse_relationships_enabled: false,
  });
}

async function captureState(
  client: CmaClient.Client,
  seed: Pick<Seed, 'parentModelId' | 'singletonModelId'>,
): Promise<RawState> {
  const slices = await Promise.all(
    (['current', 'published'] as const).flatMap((version) =>
      [seed.parentModelId, seed.singletonModelId].map(async (modelId) => ({
        version,
        response: await client.items.rawList({
          filter: { type: modelId },
          version,
          order_by: 'id_ASC',
          page: { limit: 500 },
        }),
      })),
    ),
  );
  const result: { current: RawRecord[]; published: RawRecord[] } = {
    current: [],
    published: [],
  };
  for (const { version, response } of slices) {
    for (const record of response.data) {
      const dependency =
        record.attributes[NO_DRAFT_SINGLETON_FIELD_API_KEYS.dependency];
      result[version].push({
        id: record.id,
        itemTypeId: record.relationships.item_type.data.id,
        title: String(record.attributes.title),
        dependencyId: typeof dependency === 'string' ? dependency : null,
        status: String(record.meta.status),
        currentValid:
          typeof record.meta.is_current_version_valid === 'boolean'
            ? record.meta.is_current_version_valid
            : null,
        publishedValid:
          typeof record.meta.is_published_version_valid === 'boolean'
            ? record.meta.is_published_version_valid
            : null,
      });
    }
  }
  result.current.sort((left, right) => compareDatoIds(left.id, right.id));
  result.published.sort((left, right) => compareDatoIds(left.id, right.id));

  const singletonModel = await client.itemTypes.rawFind(seed.singletonModelId);
  return {
    ...result,
    singletonItemId:
      singletonModel.data.relationships.singleton_item.data?.id ?? null,
  };
}

function compareDatoIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
