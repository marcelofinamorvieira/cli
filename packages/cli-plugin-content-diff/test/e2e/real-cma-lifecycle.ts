import assert from 'node:assert/strict';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type LifecycleDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    note: { type: 'text'; localized: false };
  };
};

type LifecycleSeed = RealCmaScenarioSeed &
  Readonly<{
    draftModelId: string;
    noDraftModelId: string;
    publishId: string;
    updateId: string;
    unpublishId: string;
    noDraftId: string;
  }>;

type RawLifecycleRecord = Readonly<{
  id: string;
  itemTypeId: string;
  title: string | null;
  note: string | null;
}>;

type RawLifecycleState = Readonly<{
  current: Readonly<Record<string, RawLifecycleRecord>>;
  published: Readonly<Record<string, RawLifecycleRecord>>;
}>;

type LifecycleExpected = Readonly<{
  sourceOnlyDraftId: string;
  destinationOnlyDraftId: string;
  source: RawLifecycleState;
  destination: RawLifecycleState;
}>;

export const lifecycleStateScenario: RealCmaScenario<
  LifecycleSeed,
  LifecycleExpected
> = {
  name: 'draft, published, updated, unpublished, and no-draft lifecycle states',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating lifecycle fixture schema');
    const suffix = runId.replace(/-/g, '');
    const draftApiKey = `cde2e_lifecycle_draft_${suffix}`;
    const noDraftApiKey = `cde2e_lifecycle_live_${suffix}`;
    const draftModel = await createLifecycleModel(client, draftApiKey, true);
    const noDraftModel = await createLifecycleModel(
      client,
      noDraftApiKey,
      false,
    );

    const publishRecord = await createRecord(
      client,
      draftModel.id,
      'publish me',
      'baseline draft',
    );
    const updateRecord = await createRecord(
      client,
      draftModel.id,
      'updated current',
      'shared published baseline',
    );
    await client.items.publish<LifecycleDefinition>(updateRecord.id);
    const unpublishRecord = await createRecord(
      client,
      draftModel.id,
      'become draft',
      'shared published record',
    );
    await client.items.publish<LifecycleDefinition>(unpublishRecord.id);
    const noDraftRecord = await createRecord(
      client,
      noDraftModel.id,
      'always live',
      'shared no-draft baseline',
    );

    return {
      itemTypeApiKeys: [draftApiKey, noDraftApiKey],
      draftModelId: draftModel.id,
      noDraftModelId: noDraftModel.id,
      publishId: publishRecord.id,
      updateId: updateRecord.id,
      unpublishId: unpublishRecord.id,
      noDraftId: noDraftRecord.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log('[content-diff e2e] Creating lifecycle-state drift');

    await sourceClient.items.update<LifecycleDefinition>(seed.publishId, {
      title: 'published source',
      note: 'source publishes the baseline draft',
    });
    await sourceClient.items.publish<LifecycleDefinition>(seed.publishId);

    await sourceClient.items.update<LifecycleDefinition>(seed.updateId, {
      title: 'updated source current',
      note: 'published slice must stay at the shared baseline',
    });
    await sourceClient.items.unpublish<LifecycleDefinition>(seed.unpublishId);
    await sourceClient.items.update<LifecycleDefinition>(seed.unpublishId, {
      title: 'source draft after unpublish',
      note: 'destination must lose its published slice',
    });
    await sourceClient.items.update<LifecycleDefinition>(seed.noDraftId, {
      title: 'source live value',
      note: 'no-draft updates publish immediately',
    });
    const sourceOnlyDraft = await createRecord(
      sourceClient,
      seed.draftModelId,
      'source-only draft',
      'must remain unpublished',
    );

    await destinationClient.items.update<LifecycleDefinition>(seed.publishId, {
      title: 'destination draft value',
      note: 'must be replaced and published',
    });
    await destinationClient.items.update<LifecycleDefinition>(seed.updateId, {
      title: 'destination published drift',
      note: 'wrong current and published state',
    });
    await destinationClient.items.publish<LifecycleDefinition>(seed.updateId);
    await destinationClient.items.update<LifecycleDefinition>(seed.noDraftId, {
      title: 'destination live drift',
      note: 'must converge to source',
    });
    const destinationOnlyDraft = await createRecord(
      destinationClient,
      seed.draftModelId,
      'destination-only draft',
      'must remain untouched',
    );

    return {
      sourceOnlyDraftId: sourceOnlyDraft.id,
      destinationOnlyDraftId: destinationOnlyDraft.id,
      source: await captureLifecycleState(sourceClient, [
        seed.draftModelId,
        seed.noDraftModelId,
      ]),
      destination: await captureLifecycleState(destinationClient, [
        seed.draftModelId,
        seed.noDraftModelId,
      ]),
    };
  },

  async verify({ seed, expected, appliedClient }) {
    console.log('[content-diff e2e] Verifying lifecycle-state matrix');
    const actual = await captureLifecycleState(appliedClient, [
      seed.draftModelId,
      seed.noDraftModelId,
    ]);
    const managedIds = [
      seed.publishId,
      seed.updateId,
      seed.unpublishId,
      seed.noDraftId,
      expected.sourceOnlyDraftId,
    ];

    for (const id of managedIds) {
      assert.deepEqual(
        actual.current[id],
        expected.source.current[id],
        `current lifecycle state differs for ${id}`,
      );
      assert.deepEqual(
        actual.published[id],
        expected.source.published[id],
        `published lifecycle state differs for ${id}`,
      );
    }

    assert.deepEqual(
      actual.current[expected.destinationOnlyDraftId],
      expected.destination.current[expected.destinationOnlyDraftId],
      'destination-only lifecycle record was not retained',
    );
    assert.equal(
      actual.published[expected.destinationOnlyDraftId],
      undefined,
      'destination-only draft became published',
    );
    assert.equal(
      actual.published[seed.unpublishId],
      undefined,
      'record that is draft-only in source remained published',
    );
    assert.equal(
      actual.published[expected.sourceOnlyDraftId],
      undefined,
      'source-only draft was unexpectedly published',
    );
    assert.deepEqual(
      actual.published[seed.updateId],
      expected.source.published[seed.updateId],
      'updated record lost its older published slice',
    );
  },
};

async function createLifecycleModel(
  client: CmaClient.Client,
  apiKey: string,
  draftModeActive: boolean,
): Promise<CmaClient.ApiTypes.ItemType> {
  const model = await client.itemTypes.create({
    name: `Lifecycle ${apiKey}`,
    api_key: apiKey,
    singleton: false,
    all_locales_required: false,
    sortable: false,
    modular_block: false,
    draft_mode_active: draftModeActive,
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
    label: 'Note',
    api_key: 'note',
    field_type: 'text',
    localized: false,
    validators: {},
  });
  return model;
}

async function createRecord(
  client: CmaClient.Client,
  itemTypeId: string,
  title: string,
  note: string,
): Promise<CmaClient.ApiTypes.Item> {
  return client.items.create<LifecycleDefinition>({
    item_type: { id: itemTypeId, type: 'item_type' },
    title,
    note,
  });
}

async function captureLifecycleState(
  client: CmaClient.Client,
  itemTypeIds: readonly string[],
): Promise<RawLifecycleState> {
  const slices = await Promise.all(
    itemTypeIds.flatMap((itemTypeId) =>
      (['current', 'published'] as const).map(async (version) => ({
        version,
        response: await client.items.rawList<LifecycleDefinition>({
          filter: { type: itemTypeId },
          version,
          page: { limit: 500 },
        }),
      })),
    ),
  );
  const current: Record<string, RawLifecycleRecord> = {};
  const published: Record<string, RawLifecycleRecord> = {};

  for (const { version, response } of slices) {
    const destination = version === 'current' ? current : published;
    for (const record of response.data) {
      destination[record.id] = {
        id: record.id,
        itemTypeId: record.relationships.item_type.data.id,
        title: record.attributes.title,
        note: record.attributes.note,
      };
    }
  }

  return { current, published };
}
