import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type Definition = {
  settings: { locales: 'en' | 'it' | 'fr' };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: true };
    note: { type: 'text'; localized: false };
  };
};

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    recordId: string;
  }>;

type RawRecord = Readonly<{
  id: string;
  title: Readonly<Record<string, string>>;
  note: string;
}>;

type SelectiveState = Readonly<{
  current: RawRecord;
  published: RawRecord;
  currentVersionLocales: readonly string[];
  publishedVersionLocales: readonly string[];
  changedLocales: readonly string[];
  addedLocales: readonly string[];
  removedLocales: readonly string[];
  nonLocalizedFieldsChanged: boolean;
}>;

export function selectivePublicationModelApiKey(runId: string): string {
  return `cde2e_sp_r${createHash('sha256')
    .update(runId)
    .digest('hex')
    .slice(0, 12)}`;
}

export const selectivePublicationScenario: RealCmaScenario<
  Seed,
  SelectiveState
> = {
  name: 'selective locale publication with divergent current state',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating selective publication fixture');
    await client.site.update({ locales: ['en', 'it', 'fr'] });
    const apiKey = selectivePublicationModelApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Selective publication ${runId}`,
      api_key: apiKey,
      singleton: false,
      all_locales_required: false,
      sortable: false,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: true,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });
    await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: true,
      validators: { required: {} },
    });
    await client.fields.create(model.id, {
      label: 'Note',
      api_key: 'note',
      field_type: 'text',
      localized: false,
      validators: { required: {} },
    });
    const record = await client.items.create<Definition>({
      item_type: { id: model.id, type: 'item_type' },
      title: {
        en: 'baseline en',
        it: 'baseline it',
        fr: 'baseline fr',
      },
      note: 'baseline nonlocalized',
    });
    await client.items.publish<Definition>(record.id, {
      content_in_locales: ['en'],
      non_localized_content: true,
    });
    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      recordId: record.id,
    };
  },

  async introduceDrift({ seed, sourceClient }) {
    console.log(
      '[content-diff e2e] Creating selective published/current drift',
    );
    await sourceClient.items.update<Definition>(seed.recordId, {
      title: {
        en: 'candidate en must stay unpublished',
        it: 'published it',
        fr: 'candidate fr must stay unpublished',
      },
      note: 'candidate nonlocalized must stay unpublished',
    });
    await sourceClient.items.publish<Definition>(seed.recordId, {
      content_in_locales: ['it'],
      non_localized_content: false,
    });
    await sourceClient.items.update<Definition>(seed.recordId, {
      title: {
        en: 'final current en',
        it: 'final current it',
        fr: 'final current fr',
      },
      note: 'final current nonlocalized',
    });
    const expected = await captureSelectiveState(sourceClient, seed.recordId);
    assert.deepEqual(expected.published.title, {
      en: 'baseline en',
      it: 'published it',
    });
    assert.equal(expected.published.note, 'baseline nonlocalized');
    assert.deepEqual(expected.publishedVersionLocales, ['en', 'it']);
    assert.deepEqual(expected.currentVersionLocales, ['en', 'fr', 'it']);
    assert.ok(expected.changedLocales.length > 0);
    assert.equal(expected.nonLocalizedFieldsChanged, true);
    return expected;
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log('[content-diff e2e] Verifying selective publication state');
    const [source, destination, applied] = await Promise.all([
      captureSelectiveState(sourceClient, seed.recordId),
      captureSelectiveState(destinationClient, seed.recordId),
      captureSelectiveState(appliedClient, seed.recordId),
    ]);
    assert.deepEqual(source, expected);
    assert.deepEqual(applied, expected);
    assert.notDeepEqual(destination, expected);
  },
};

async function captureSelectiveState(
  client: CmaClient.Client,
  recordId: string,
): Promise<SelectiveState> {
  const [currentResponse, publishedResponse, stateResponse] = await Promise.all(
    [
      client.items.rawFind<Definition>(recordId, {
        version: 'current',
      }),
      client.items.rawFind<Definition>(recordId, {
        version: 'published',
      }),
      client.items.rawCurrentVsPublishedState(recordId),
    ],
  );
  const current = rawRecord(currentResponse, recordId, 'current');
  const published = rawRecord(publishedResponse, recordId, 'published');
  const state = object(stateResponse.data, 'current-vs-published state');
  const attributes = object(
    state.attributes,
    'current-vs-published state attributes',
  );
  return {
    current,
    published,
    currentVersionLocales: sortedStrings(
      attributes.current_version_locales,
      'current_version_locales',
    ),
    publishedVersionLocales: sortedStrings(
      attributes.published_version_locales,
      'published_version_locales',
    ),
    changedLocales: sortedStrings(
      attributes.changed_locales,
      'changed_locales',
    ),
    addedLocales: sortedStrings(attributes.added_locales, 'added_locales'),
    removedLocales: sortedStrings(
      attributes.removed_locales,
      'removed_locales',
    ),
    nonLocalizedFieldsChanged: requiredBoolean(
      attributes.non_localized_fields_changed,
      'non_localized_fields_changed',
    ),
  };
}

function rawRecord(
  response: unknown,
  recordId: string,
  slice: string,
): RawRecord {
  const resource = object(object(response, `${slice} response`).data, slice);
  assert.equal(resource.id, recordId);
  assert.equal(resource.type, 'item');
  const attributes = object(resource.attributes, `${slice} attributes`);
  const title = object(attributes.title, `${slice}.title`);
  return {
    id: recordId,
    title: Object.fromEntries(
      Object.entries(title)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([locale, value]) => [
          locale,
          requiredString(value, `${slice}.title.${locale}`),
        ]),
    ),
    note: requiredString(attributes.note, `${slice}.note`),
  };
}

function sortedStrings(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((entry) => requiredString(entry, label)).sort();
}

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value as string;
}

function requiredBoolean(value: unknown, label: string): boolean {
  assert.equal(typeof value, 'boolean', `${label} must be a boolean`);
  return value as boolean;
}
