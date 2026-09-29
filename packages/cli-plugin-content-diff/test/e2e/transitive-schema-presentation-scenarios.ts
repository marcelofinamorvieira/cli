import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';
import { SCHEMA_GATE_FAILURE_PATTERN } from './schema-gating-scenarios';

type TransitiveSeed = RealCmaScenarioSeed &
  Readonly<{
    leafFieldId: string;
  }>;

type PresentationSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    titleFieldId: string;
    bodyFieldId: string;
    fieldsetId: string;
    recordId: string;
  }>;

type PresentationDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    body: { type: 'text'; localized: false };
  };
};

type PresentationState = Readonly<{
  model: Readonly<{
    id: string;
    name: string;
    hint: string | null;
    collectionAppearance: string;
    titleFieldId: string | null;
    excerptFieldId: string | null;
  }>;
  bodyField: Readonly<{
    id: string;
    label: string;
    hint: string | null;
    appearance: unknown;
    fieldsetId: string | null;
  }>;
  fieldset: Readonly<{
    id: string;
    title: string;
    hint: string | null;
    collapsible: boolean;
    startCollapsed: boolean;
  }>;
}>;

type RecordState = Readonly<{
  current: Readonly<{ id: string; title: string; body: string }>;
  published: Readonly<{ id: string; title: string; body: string }>;
}>;

type PresentationExpected = Readonly<{
  sourceContent: RecordState;
  destinationPresentation: PresentationState;
}>;

export function transitiveSchemaApiKeys(runId: string): Readonly<{
  top: string;
  outer: string;
  inner: string;
  leaf: string;
  presentation: string;
}> {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 10);
  return {
    top: `cde2e_tst_r${suffix}`,
    outer: `cde2e_tso_r${suffix}`,
    inner: `cde2e_tsi_r${suffix}`,
    leaf: `cde2e_tsl_r${suffix}`,
    presentation: `cde2e_tsp_r${suffix}`,
  };
}

export const transitiveSchemaMismatchScenario: RealCmaScenario<
  TransitiveSeed,
  void
> = {
  name: 'four-hop managed schema closure rejects deep semantic drift',
  expectedGenerationFailure: { messagePattern: SCHEMA_GATE_FAILURE_PATTERN },

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating transitive schema closure');
    const keys = transitiveSchemaApiKeys(runId);
    const leaf = await createRegularModel(client, keys.leaf, 'Leaf');
    const leafField = await client.fields.create(leaf.id, {
      label: 'Code',
      api_key: 'code',
      field_type: 'string',
      localized: false,
      default_value: null,
      validators: { required: {} },
    });
    const inner = await createBlockModel(client, keys.inner, 'Inner');
    await client.fields.create(inner.id, {
      label: 'Target',
      api_key: 'target',
      field_type: 'link',
      localized: false,
      validators: { item_item_type: { item_types: [leaf.id] } },
    });
    const outer = await createBlockModel(client, keys.outer, 'Outer');
    await client.fields.create(outer.id, {
      label: 'Inner',
      api_key: 'inner',
      field_type: 'single_block',
      localized: false,
      validators: { single_block_blocks: { item_types: [inner.id] } },
    });
    const top = await createRegularModel(client, keys.top, 'Top');
    await client.fields.create(top.id, {
      label: 'Modules',
      api_key: 'modules',
      field_type: 'rich_text',
      localized: false,
      validators: { rich_text_blocks: { item_types: [outer.id] } },
    });

    return {
      itemTypeApiKeys: [keys.top],
      leafFieldId: leafField.id,
    };
  },

  async introduceDrift({ seed, sourceClient }) {
    console.log('[content-diff e2e] Drifting the fourth schema hop');
    await sourceClient.fields.update(seed.leafFieldId, {
      default_value: 'deep default',
      validators: { required: {}, length: { min: 5, max: 40 } },
    });
  },
};

export const presentationOnlyDriftScenario: RealCmaScenario<
  PresentationSeed,
  PresentationExpected
> = {
  name: 'presentation-only schema drift stays destination-local',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating presentation-only schema lane');
    const key = transitiveSchemaApiKeys(runId).presentation;
    const model = await createRegularModel(client, key, 'Presentation');
    const titleField = await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const fieldset = await client.fieldsets.create(model.id, {
      title: 'Editorial group',
      hint: null,
      collapsible: false,
      start_collapsed: false,
    });
    const bodyField = await client.fields.create(model.id, {
      label: 'Body',
      api_key: 'body',
      field_type: 'text',
      localized: false,
      validators: {},
      fieldset,
    });
    await client.itemTypes.update(model.id, {
      title_field: titleField,
      excerpt_field: bodyField,
    });
    const record = await client.items.create<PresentationDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      title: 'shared presentation baseline',
      body: 'shared body',
    });
    await client.items.publish(record.id);
    return {
      itemTypeApiKeys: [key],
      modelId: model.id,
      titleFieldId: titleField.id,
      bodyFieldId: bodyField.id,
      fieldsetId: fieldset.id,
      recordId: record.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log('[content-diff e2e] Creating content and presentation drift');
    await sourceClient.items.update<PresentationDefinition>(seed.recordId, {
      title: 'source presentation content',
      body: 'source body content',
    });
    await sourceClient.items.publish(seed.recordId);

    const [destinationTitle, destinationBody] = await Promise.all([
      destinationClient.fields.find(seed.titleFieldId),
      destinationClient.fields.find(seed.bodyFieldId),
    ]);
    await destinationClient.fieldsets.update(seed.fieldsetId, {
      title: 'Destination editorial group',
      hint: 'Destination-only field grouping',
      collapsible: true,
      start_collapsed: true,
    });
    await destinationClient.fields.update(seed.bodyFieldId, {
      label: 'Destination body label',
      hint: 'Destination-only field hint',
      appearance: {
        editor: 'textarea',
        parameters: { placeholder: 'Destination placeholder' },
        addons: [],
      },
    });
    await destinationClient.itemTypes.update(seed.modelId, {
      name: 'Destination presentation model',
      hint: 'Destination-only model hint',
      collection_appearance: 'table',
      title_field: destinationTitle,
      excerpt_field: destinationBody,
    });

    const [sourceContent, destinationPresentation] = await Promise.all([
      capturePresentationRecord(sourceClient, seed),
      capturePresentationState(destinationClient, seed, seed.fieldsetId),
    ]);
    return {
      sourceContent,
      destinationPresentation,
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
      '[content-diff e2e] Verifying destination presentation isolation',
    );
    const [
      sourceContent,
      appliedContent,
      destinationPresentation,
      appliedPresentation,
    ] = await Promise.all([
      capturePresentationRecord(sourceClient, seed),
      capturePresentationRecord(appliedClient, seed),
      capturePresentationState(destinationClient, seed, seed.fieldsetId),
      capturePresentationState(appliedClient, seed, seed.fieldsetId),
    ]);
    assert.deepEqual(sourceContent, expected.sourceContent);
    assert.deepEqual(appliedContent, expected.sourceContent);
    assert.deepEqual(destinationPresentation, expected.destinationPresentation);
    assert.deepEqual(appliedPresentation, expected.destinationPresentation);
  },
};

async function createRegularModel(
  client: CmaClient.Client,
  apiKey: string,
  name: string,
): Promise<CmaClient.ApiTypes.ItemType> {
  return client.itemTypes.create({
    name: `${name} schema scope`,
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

async function createBlockModel(
  client: CmaClient.Client,
  apiKey: string,
  name: string,
): Promise<CmaClient.ApiTypes.ItemType> {
  return client.itemTypes.create({
    name: `${name} schema scope`,
    api_key: apiKey,
    modular_block: true,
  });
}

async function capturePresentationRecord(
  client: CmaClient.Client,
  seed: PresentationSeed,
): Promise<RecordState> {
  const [current, published] = await Promise.all([
    client.items.find<PresentationDefinition>(seed.recordId, {
      version: 'current',
    }),
    client.items.find<PresentationDefinition>(seed.recordId, {
      version: 'published',
    }),
  ]);
  return {
    current: {
      id: current.id,
      title: requiredString(current.title, 'current title'),
      body: requiredString(current.body, 'current body'),
    },
    published: {
      id: published.id,
      title: requiredString(published.title, 'published title'),
      body: requiredString(published.body, 'published body'),
    },
  };
}

async function capturePresentationState(
  client: CmaClient.Client,
  seed: PresentationSeed,
  fieldsetId: string,
): Promise<PresentationState> {
  const [model, bodyField, fieldset] = await Promise.all([
    client.itemTypes.find(seed.modelId),
    client.fields.find(seed.bodyFieldId),
    client.fieldsets.find(fieldsetId),
  ]);
  return {
    model: {
      id: model.id,
      name: model.name,
      hint: model.hint,
      collectionAppearance: model.collection_appearance,
      titleFieldId: model.title_field?.id ?? null,
      excerptFieldId: model.excerpt_field?.id ?? null,
    },
    bodyField: {
      id: bodyField.id,
      label: bodyField.label,
      hint: bodyField.hint,
      appearance: canonicalJson(bodyField.appearance),
      fieldsetId: bodyField.fieldset?.id ?? null,
    },
    fieldset: {
      id: fieldset.id,
      title: fieldset.title,
      hint: fieldset.hint,
      collapsible: fieldset.collapsible,
      startCollapsed: fieldset.start_collapsed,
    },
  };
}

function requiredString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value as string;
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}
