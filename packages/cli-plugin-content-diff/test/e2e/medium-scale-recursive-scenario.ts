import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CmaClient } from '@datocms/cli-utils';
import {
  type CanonicalGraphRecord,
  type CanonicalGraphValue,
  type MediumScaleRawState,
  captureMediumScaleRawState,
  collectMediumScaleCoverage,
} from './medium-scale-recursive-oracle';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

export const MEDIUM_SCALE_RECORD_COUNT = 65;
export const MEDIUM_SCALE_BASELINE_COUNT = 33;
export const MEDIUM_SCALE_COMPLEX_INTERVAL = 8;

const RESERVED_LEDGER_API_KEY = 'datocms_content_diff';
const LIVE_MODEL_API_KEY_MAX_LENGTH = 30;
const LIVE_MODEL_API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;

type BlockPayload = ReturnType<typeof CmaClient.buildBlockRecord>;
type ExpectedLifecycle = 'draft' | 'published' | 'updated';

export type MediumScalePlanEntry = Readonly<{
  index: number;
  origin: 'baseline' | 'source-only';
  lifecycle: ExpectedLifecycle;
  publishShellBeforeUpdate: boolean;
  publishFinal: boolean;
  unpublishAfterUpdate: boolean;
  nextIndex: number;
  previousIndex: number;
  position: number;
  complex: boolean;
  recursionDepth: 1 | 2;
}>;

type MediumScaleSeed = RealCmaScenarioSeed &
  Readonly<{
    runId: string;
    nodeModelId: string;
    nodeModelApiKey: string;
    containerBlockModelId: string;
    leafBlockModelId: string;
    baselineRecordIds: readonly string[];
  }>;

type MediumScaleNestedSeed = Readonly<
  Pick<MediumScaleSeed, 'runId' | 'containerBlockModelId' | 'leafBlockModelId'>
>;

type MediumScaleExpected = Readonly<{
  recordIds: readonly string[];
  plan: readonly MediumScalePlanEntry[];
  source: MediumScaleRawState;
  destination: MediumScaleRawState;
}>;

type MigrationRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    name: { type: 'string'; localized: false };
  };
};

export function buildMediumScaleModelApiKeys(runId: string): Readonly<{
  node: string;
  containerBlock: string;
  leafBlock: string;
}> {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const result = {
    node: `cde2e_sn_r${suffix}`,
    containerBlock: `cde2e_sc_r${suffix}`,
    leafBlock: `cde2e_sl_r${suffix}`,
  };

  for (const apiKey of Object.values(result)) {
    assert.match(apiKey, LIVE_MODEL_API_KEY_PATTERN);
    assert.ok(
      apiKey.length <= LIVE_MODEL_API_KEY_MAX_LENGTH,
      `medium-scale E2E API key exceeds ${LIVE_MODEL_API_KEY_MAX_LENGTH} characters: ${apiKey}`,
    );
  }

  return result;
}

export function buildMediumScalePlan(
  recordCount: number,
  baselineCount: number,
): readonly MediumScalePlanEntry[] {
  if (!Number.isInteger(recordCount) || recordCount < 2) {
    throw new Error('recordCount must be an integer greater than one');
  }
  if (
    !Number.isInteger(baselineCount) ||
    baselineCount < 1 ||
    baselineCount >= recordCount
  ) {
    throw new Error(
      'baselineCount must be a positive integer smaller than recordCount',
    );
  }

  const indices = Array.from({ length: recordCount }, (_, index) => index);
  const publishedFinalIndices = indices.filter((index) =>
    index < baselineCount ? index % 3 === 0 : index % 3 === 1,
  );
  // Moving the last source-only record to the front exercises sortable
  // topology across the pagination boundary without adding 65 ordering calls
  // to an already deliberately broad live scenario.
  const sourceOrder = [recordCount - 1, ...indices.slice(0, -1)];
  const positionByIndex = new Map(
    sourceOrder.map((index, position) => [index, position]),
  );

  return indices.map((index) => {
    const baseline = index < baselineCount;
    const lifecycle: ExpectedLifecycle = baseline
      ? (['published', 'updated', 'draft'] as const)[index % 3]
      : (['updated', 'published', 'draft'] as const)[index % 3];
    const peerPool =
      lifecycle === 'published' ? publishedFinalIndices : indices;
    const peerPoolPosition = peerPool.indexOf(index);
    if (peerPoolPosition === -1) {
      throw new Error(`record ${index} is absent from its dependency pool`);
    }
    const position = positionByIndex.get(index);
    if (position === undefined) {
      throw new Error(`record ${index} is absent from the source ordering`);
    }

    return {
      index,
      origin: baseline ? 'baseline' : 'source-only',
      lifecycle,
      publishShellBeforeUpdate: !baseline && lifecycle !== 'draft',
      publishFinal: lifecycle === 'published',
      unpublishAfterUpdate: baseline && lifecycle === 'draft',
      nextIndex: peerPool[(peerPoolPosition + 1) % peerPool.length],
      previousIndex:
        peerPool[(peerPoolPosition - 1 + peerPool.length) % peerPool.length],
      position,
      complex: index % MEDIUM_SCALE_COMPLEX_INTERVAL === 0,
      recursionDepth: index % (MEDIUM_SCALE_COMPLEX_INTERVAL * 2) === 0 ? 2 : 1,
    };
  });
}

export function buildMediumScaleTopLevelFieldDefinitions({
  nodeModelId,
  containerBlockModelId,
  leafBlockModelId,
}: Readonly<{
  nodeModelId: string;
  containerBlockModelId: string;
  leafBlockModelId: string;
}>) {
  return [
    fieldDefinition('Title', 'title', 'string', true, { required: {} }),
    fieldDefinition('Summary', 'summary', 'text', true, { required: {} }),
    fieldDefinition('Slug', 'slug_value', 'slug', false, {}),
    fieldDefinition('Featured', 'featured', 'boolean', false, {}),
    fieldDefinition('Score', 'score', 'integer', false, {}),
    fieldDefinition('Weight', 'weight', 'float', false, {}),
    fieldDefinition('Calendar date', 'calendar_date', 'date', false, {}),
    fieldDefinition('Timestamp', 'timestamp', 'date_time', false, {}),
    fieldDefinition('Settings JSON', 'settings_json', 'json', false, {}),
    fieldDefinition('Accent', 'accent', 'color', false, {}),
    fieldDefinition('Coordinates', 'coordinates', 'lat_lon', false, {}),
    fieldDefinition('Peer', 'peer', 'link', true, linkValidators(nodeModelId)),
    fieldDefinition(
      'Peers',
      'peers',
      'links',
      true,
      linksValidators(nodeModelId),
    ),
    fieldDefinition('Modules', 'modules', 'rich_text', true, {
      rich_text_blocks: {
        item_types: [containerBlockModelId, leafBlockModelId],
      },
    }),
    fieldDefinition('Hero', 'hero', 'single_block', true, {
      single_block_blocks: { item_types: [containerBlockModelId] },
    }),
    fieldDefinition(
      'Body',
      'body',
      'structured_text',
      true,
      structuredTextValidators({
        blockModelIds: [containerBlockModelId, leafBlockModelId],
        linkModelId: nodeModelId,
      }),
    ),
  ];
}

export function buildMediumScaleBlockFieldDefinitions({
  nodeModelId,
  containerBlockModelId,
  leafBlockModelId,
}: Readonly<{
  nodeModelId: string;
  containerBlockModelId: string;
  leafBlockModelId: string;
}>) {
  return [
    ...[containerBlockModelId, leafBlockModelId].flatMap((itemTypeId) => [
      {
        itemTypeId,
        definition: fieldDefinition('Label', 'label', 'string', false, {}),
      },
      {
        itemTypeId,
        definition: fieldDefinition(
          'Related node',
          'related_node',
          'link',
          false,
          linkValidators(nodeModelId),
        ),
      },
    ]),
    {
      itemTypeId: containerBlockModelId,
      definition: fieldDefinition(
        'Single leaf',
        'single_leaf',
        'single_block',
        false,
        { single_block_blocks: { item_types: [leafBlockModelId] } },
      ),
    },
    {
      itemTypeId: containerBlockModelId,
      definition: fieldDefinition(
        'Leaf modules',
        'leaf_modules',
        'rich_text',
        false,
        { rich_text_blocks: { item_types: [leafBlockModelId] } },
      ),
    },
    {
      itemTypeId: containerBlockModelId,
      definition: fieldDefinition(
        'Container body',
        'container_body',
        'structured_text',
        false,
        structuredTextValidators({
          blockModelIds: [leafBlockModelId],
          linkModelId: nodeModelId,
        }),
      ),
    },
    {
      itemTypeId: leafBlockModelId,
      definition: fieldDefinition(
        'Container modules',
        'container_modules',
        'rich_text',
        false,
        { rich_text_blocks: { item_types: [containerBlockModelId] } },
      ),
    },
    {
      itemTypeId: leafBlockModelId,
      definition: fieldDefinition(
        'Leaf body',
        'leaf_body',
        'structured_text',
        false,
        structuredTextValidators({
          blockModelIds: [containerBlockModelId],
          linkModelId: nodeModelId,
        }),
      ),
    },
  ];
}

export const mediumScaleRecursiveScenario: RealCmaScenario<
  MediumScaleSeed,
  MediumScaleExpected
> = {
  name: '65-record paginated scalar and recursive localized graph',

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating medium-scale recursive schema and 33-record baseline',
    );
    await client.site.update({ locales: ['en', 'it'] });

    const apiKeys = buildMediumScaleModelApiKeys(runId);
    const nodeModel = await client.itemTypes.create({
      name: `Scale node ${runId}`,
      api_key: apiKeys.node,
      singleton: false,
      all_locales_required: true,
      sortable: true,
      modular_block: false,
      draft_mode_active: true,
      draft_saving_active: false,
      tree: false,
      collection_appearance: 'compact',
      inverse_relationships_enabled: false,
    });
    const containerBlock = await client.itemTypes.create({
      name: `Scale container ${runId}`,
      api_key: apiKeys.containerBlock,
      modular_block: true,
    });
    const leafBlock = await client.itemTypes.create({
      name: `Scale leaf ${runId}`,
      api_key: apiKeys.leafBlock,
      modular_block: true,
    });

    for (const definition of buildMediumScaleTopLevelFieldDefinitions({
      nodeModelId: nodeModel.id,
      containerBlockModelId: containerBlock.id,
      leafBlockModelId: leafBlock.id,
    })) {
      await client.fields.create(nodeModel.id, definition);
    }
    for (const {
      itemTypeId,
      definition,
    } of buildMediumScaleBlockFieldDefinitions({
      nodeModelId: nodeModel.id,
      containerBlockModelId: containerBlock.id,
      leafBlockModelId: leafBlock.id,
    })) {
      await client.fields.create(itemTypeId, definition);
    }

    const baselineIndices = Array.from(
      { length: MEDIUM_SCALE_BASELINE_COUNT },
      (_, index) => index,
    );
    const baselineRecords = await mapWithConcurrency(
      baselineIndices,
      1,
      (index) => {
        const sourceComplex = index % MEDIUM_SCALE_COMPLEX_INTERVAL === 0;
        return client.items.create({
          item_type: { id: nodeModel.id, type: 'item_type' },
          ...seededShellFields({
            seed: {
              runId,
              containerBlockModelId: containerBlock.id,
              leafBlockModelId: leafBlock.id,
            },
            index,
            variant: 'baseline',
            // Destination drift also uses recursive content every tenth
            // baseline record. Seed the union during CREATE so neither fork
            // ever has to introduce a fresh nested ID on UPDATE.
            complex: sourceComplex || index % 10 === 0,
            recursionDepth:
              sourceComplex && index % (MEDIUM_SCALE_COMPLEX_INTERVAL * 2) === 0
                ? 2
                : 1,
          }),
          position: index,
        });
      },
    );
    await bulkPublish(
      client,
      baselineRecords.map(({ id }) => id),
    );

    return {
      itemTypeApiKeys: [apiKeys.node],
      runId,
      nodeModelId: nodeModel.id,
      nodeModelApiKey: apiKeys.node,
      containerBlockModelId: containerBlock.id,
      leafBlockModelId: leafBlock.id,
      baselineRecordIds: baselineRecords.map(({ id }) => id),
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Expanding source to 65 records and creating paginated graph drift',
    );
    const sourceOnlyIndices = Array.from(
      { length: MEDIUM_SCALE_RECORD_COUNT - MEDIUM_SCALE_BASELINE_COUNT },
      (_, offset) => MEDIUM_SCALE_BASELINE_COUNT + offset,
    );
    const plan = buildMediumScalePlan(
      MEDIUM_SCALE_RECORD_COUNT,
      MEDIUM_SCALE_BASELINE_COUNT,
    );
    const sourceOnlyRecords = await mapWithConcurrency(
      sourceOnlyIndices,
      1,
      (index) => {
        const entry = plan[index];
        return sourceClient.items.create({
          item_type: { id: seed.nodeModelId, type: 'item_type' },
          ...seededShellFields({
            seed,
            index,
            variant: 'source-shell',
            complex: entry.complex,
            recursionDepth: entry.recursionDepth,
          }),
          position: index,
        });
      },
    );
    const recordIds = [
      ...seed.baselineRecordIds,
      ...sourceOnlyRecords.map(({ id }) => id),
    ];
    assert.equal(recordIds.length, MEDIUM_SCALE_RECORD_COUNT);

    await bulkPublish(
      sourceClient,
      plan
        .filter(({ publishShellBeforeUpdate }) => publishShellBeforeUpdate)
        .map(({ index }) => recordIds[index]),
    );

    await mapWithConcurrency(plan, 6, async (entry) => {
      const nextId = recordIds[entry.nextIndex];
      const previousId = recordIds[entry.previousIndex];
      await sourceClient.items.update(recordIds[entry.index], {
        ...finalFields({
          seed,
          index: entry.index,
          nextId,
          previousId,
          variant: 'source',
          complex: entry.complex,
          recursionDepth: entry.recursionDepth,
        }),
      });
    });
    await sourceClient.items.update(recordIds[recordIds.length - 1], {
      position: 0,
    });
    await bulkPublish(
      sourceClient,
      plan
        .filter(({ publishFinal }) => publishFinal)
        .map(({ index }) => recordIds[index]),
    );
    await bulkUnpublish(
      sourceClient,
      plan
        .filter(({ unpublishAfterUpdate }) => unpublishAfterUpdate)
        .map(({ index }) => recordIds[index]),
    );

    const baselineCount = seed.baselineRecordIds.length;
    await mapWithConcurrency(
      seed.baselineRecordIds,
      6,
      async (recordId, index) => {
        const nextId = seed.baselineRecordIds[(index + 1) % baselineCount];
        const previousId =
          seed.baselineRecordIds[(index - 1 + baselineCount) % baselineCount];
        await destinationClient.items.update(recordId, {
          ...finalFields({
            seed,
            index,
            nextId,
            previousId,
            variant: 'destination',
            // Preserve every recursive source aggregate in the target's
            // CURRENT prestate. Destination-only recursive drift is added on
            // the tenth-record cadence without removing source-owned IDs.
            complex: plan[index].complex || index % 10 === 0,
            recursionDepth: plan[index].complex
              ? plan[index].recursionDepth
              : 1,
          }),
        });
      },
    );
    await bulkPublish(
      destinationClient,
      seed.baselineRecordIds.filter((_, index) => index % 4 === 0),
    );

    const [source, destination] = await Promise.all([
      captureMediumScaleRawState(sourceClient, seed.nodeModelId),
      captureMediumScaleRawState(destinationClient, seed.nodeModelId),
    ]);
    assertMediumScaleCoverage(source, plan, recordIds);
    assert.equal(destination.current.totalCount, MEDIUM_SCALE_BASELINE_COUNT);
    assert.equal(destination.current.pageCount, 2);
    assert.equal(destination.published.totalCount, MEDIUM_SCALE_BASELINE_COUNT);
    assert.equal(destination.published.pageCount, 2);
    assertMediumScaleNestedUpdateStagesReuseIds({
      source,
      destination,
      plan,
      recordIds,
      baselineCount,
    });
    assert.notDeepEqual(
      destination,
      source,
      'medium-scale fixture failed to create source/destination drift',
    );

    return { recordIds, plan, source, destination };
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
    console.log(
      '[content-diff e2e] Verifying all paginated scalar, lifecycle, ordering, link, and recursive slices through raw CMA',
    );
    const [source, destination, applied] = await Promise.all([
      captureMediumScaleRawState(sourceClient, seed.nodeModelId),
      captureMediumScaleRawState(destinationClient, seed.nodeModelId),
      captureMediumScaleRawState(appliedClient, seed.nodeModelId),
    ]);

    assert.deepEqual(source, expected.source, 'source changed during E2E run');
    assert.deepEqual(
      destination,
      expected.destination,
      'destination changed during E2E run',
    );
    assert.deepEqual(
      applied,
      expected.source,
      'applied medium-scale state differs from the independent raw source projection',
    );
    assertMediumScaleCoverage(applied, expected.plan, expected.recordIds);

    await assertMigrationTracked({
      client: appliedClient,
      migrationFilename,
      migrationModelApiKey,
    });
    const models = await appliedClient.itemTypes.list();
    assert.equal(
      models.some(({ api_key }) => api_key === RESERVED_LEDGER_API_KEY),
      false,
      'portable medium-scale IDs unexpectedly created the legacy-ID ledger',
    );
  },
};

function fieldDefinition<
  const FieldType extends
    | 'boolean'
    | 'color'
    | 'date'
    | 'date_time'
    | 'float'
    | 'integer'
    | 'json'
    | 'lat_lon'
    | 'link'
    | 'links'
    | 'rich_text'
    | 'single_block'
    | 'slug'
    | 'string'
    | 'structured_text'
    | 'text',
  const Localized extends boolean,
  Validators extends Readonly<Record<string, unknown>>,
>(
  label: string,
  apiKey: string,
  fieldType: FieldType,
  localized: Localized,
  validators: Validators,
) {
  return {
    label,
    api_key: apiKey,
    field_type: fieldType,
    localized,
    validators,
  };
}

function linkValidators(itemTypeId: string) {
  return { item_item_type: { item_types: [itemTypeId] } };
}

function linksValidators(itemTypeId: string) {
  return { items_item_type: { item_types: [itemTypeId] } };
}

function structuredTextValidators({
  blockModelIds,
  linkModelId,
}: Readonly<{
  blockModelIds: readonly string[];
  linkModelId: string;
}>) {
  return {
    structured_text_blocks: { item_types: [...blockModelIds] },
    structured_text_inline_blocks: { item_types: [...blockModelIds] },
    structured_text_links: { item_types: [linkModelId] },
  };
}

function shellFields(
  index: number,
  variant: 'baseline' | 'source-shell',
): Record<string, unknown> {
  const label = `${variant} ${padded(index)}`;
  return {
    title: { en: `${label} title`, it: `${label} titolo` },
    summary: { en: `${label} summary`, it: `${label} sommario` },
    ...scalarFields(index, variant),
    peer: { en: null, it: null },
    peers: { en: [], it: [] },
    modules: { en: [], it: [] },
    hero: { en: null, it: null },
    body: {
      en: dast([
        { type: 'paragraph', children: [{ type: 'span', value: label }] },
      ]),
      it: dast([
        {
          type: 'paragraph',
          children: [{ type: 'span', value: `${label} it` }],
        },
      ]),
    },
  };
}

function seededShellFields({
  seed,
  index,
  variant,
  complex,
  recursionDepth,
}: Readonly<{
  seed: MediumScaleNestedSeed;
  index: number;
  variant: 'baseline' | 'source-shell';
  complex: boolean;
  recursionDepth: 1 | 2;
}>): Record<string, unknown> {
  const fields = shellFields(index, variant);
  if (!complex) return fields;

  return {
    ...fields,
    ...nestedFields({
      seed,
      index,
      label: `${variant} ${padded(index)}`,
      nextId: null,
      previousId: null,
      complex: true,
      recursionDepth,
    }),
  };
}

function finalFields({
  seed,
  index,
  nextId,
  previousId,
  variant,
  complex,
  recursionDepth,
}: Readonly<{
  seed: MediumScaleSeed;
  index: number;
  nextId: string;
  previousId: string;
  variant: 'destination' | 'source';
  complex: boolean;
  recursionDepth: 1 | 2;
}>): Record<string, unknown> {
  const label = `${variant} ${padded(index)}`;

  return {
    title: { en: `${label} title`, it: `${label} titolo` },
    summary: {
      en: `${label} localized text summary`,
      it: `${label} testo localizzato`,
    },
    ...scalarFields(index, variant),
    peer: { en: nextId, it: previousId },
    peers: { en: [nextId, previousId], it: [previousId, nextId] },
    ...nestedFields({
      seed,
      index,
      label,
      nextId,
      previousId,
      complex,
      recursionDepth,
    }),
  };
}

function nestedFields({
  seed,
  index,
  label,
  nextId,
  previousId,
  complex,
  recursionDepth,
}: Readonly<{
  seed: MediumScaleNestedSeed;
  index: number;
  label: string;
  nextId: string | null;
  previousId: string | null;
  complex: boolean;
  recursionDepth: 1 | 2;
}>): Record<string, unknown> {
  const modules = complex
    ? {
        en: [
          buildContainerBlock(
            seed,
            index,
            'modules.en.0',
            `${label} modules en`,
            nextId,
            previousId,
            recursionDepth,
          ),
        ],
        it: [
          buildLeafBlock(
            seed,
            index,
            'modules.it.0',
            `${label} modules it`,
            previousId,
            nextId,
            0,
          ),
        ],
      }
    : { en: [], it: [] };
  const hero = complex
    ? {
        en: buildContainerBlock(
          seed,
          index,
          'hero.en',
          `${label} hero en`,
          nextId,
          previousId,
          0,
        ),
        it: buildContainerBlock(
          seed,
          index,
          'hero.it',
          `${label} hero it`,
          previousId,
          nextId,
          0,
        ),
      }
    : { en: null, it: null };

  return {
    modules,
    hero,
    body: {
      en: dastWithReferences({
        label: `${label} body en`,
        inlineItemId: nextId,
        itemLinkId: previousId,
        ...(complex
          ? {
              block: buildLeafBlock(
                seed,
                index,
                'body.en.block',
                `${label} body block en`,
                nextId,
                previousId,
                recursionDepth,
              ),
              inlineBlock: buildContainerBlock(
                seed,
                index,
                'body.en.inline_block',
                `${label} body inline en`,
                previousId,
                nextId,
                0,
              ),
            }
          : {}),
      }),
      it: dastWithReferences({
        label: `${label} body it`,
        inlineItemId: previousId,
        itemLinkId: nextId,
        ...(complex
          ? {
              block: buildContainerBlock(
                seed,
                index,
                'body.it.block',
                `${label} body block it`,
                previousId,
                nextId,
                0,
              ),
              inlineBlock: buildLeafBlock(
                seed,
                index,
                'body.it.inline_block',
                `${label} body inline it`,
                nextId,
                previousId,
                0,
              ),
            }
          : {}),
      }),
    },
  };
}

function scalarFields(
  index: number,
  variant: 'baseline' | 'destination' | 'source' | 'source-shell',
): Record<string, unknown> {
  const variantOffset = {
    baseline: 0,
    'source-shell': 17,
    source: 53,
    destination: 101,
  }[variant];
  const month = ((index + variantOffset) % 12) + 1;
  const day = ((index * 3 + variantOffset) % 28) + 1;
  const minute = (index * 7 + variantOffset) % 60;
  const year = 2025 + (variantOffset % 3);

  return {
    slug_value: `${variant}-${padded(index)}`,
    featured: (index + variantOffset) % 2 === 0,
    score: variantOffset * 100 + index,
    weight: Number((variantOffset / 10 + index * 0.125).toFixed(3)),
    calendar_date: `${year}-${padded(month)}-${padded(day)}`,
    timestamp: `${year}-${padded(month)}-${padded(day)}T12:${padded(
      minute,
    )}:00.000Z`,
    settings_json: JSON.stringify({
      index,
      variant,
      flags: [index % 2 === 0, index % 5 === 0],
      nested: { bucket: index % 7 },
    }),
    accent: {
      red: (index * 37 + variantOffset) % 256,
      green: (index * 59 + variantOffset * 2) % 256,
      blue: (index * 83 + variantOffset * 3) % 256,
      alpha: 255 - ((index + variantOffset) % 64),
    },
    coordinates: {
      latitude: Number((-70 + ((index * 11 + variantOffset) % 140)).toFixed(6)),
      longitude: Number(
        (-170 + ((index * 17 + variantOffset) % 340)).toFixed(6),
      ),
    },
  };
}

function buildContainerBlock(
  seed: MediumScaleNestedSeed,
  index: number,
  path: string,
  label: string,
  nextId: string | null,
  previousId: string | null,
  depth: number,
): BlockPayload {
  return CmaClient.buildBlockRecord({
    id: buildMediumScaleNestedBlockId(seed.runId, index, path),
    item_type: { id: seed.containerBlockModelId, type: 'item_type' },
    label,
    related_node: nextId,
    single_leaf:
      depth > 0
        ? buildLeafBlock(
            seed,
            index,
            `${path}.single_leaf`,
            `${label} single`,
            previousId,
            nextId,
            depth - 1,
          )
        : null,
    leaf_modules:
      depth > 0
        ? [
            buildLeafBlock(
              seed,
              index,
              `${path}.leaf_modules.0`,
              `${label} module`,
              nextId,
              previousId,
              depth - 1,
            ),
          ]
        : [],
    container_body: dastWithReferences({
      label: `${label} structured text`,
      inlineItemId: nextId,
      itemLinkId: previousId,
      ...(depth > 0
        ? {
            block: buildLeafBlock(
              seed,
              index,
              `${path}.container_body.block`,
              `${label} structured block`,
              previousId,
              nextId,
              depth - 1,
            ),
          }
        : {}),
    }),
  });
}

function buildLeafBlock(
  seed: MediumScaleNestedSeed,
  index: number,
  path: string,
  label: string,
  nextId: string | null,
  previousId: string | null,
  depth: number,
): BlockPayload {
  return CmaClient.buildBlockRecord({
    id: buildMediumScaleNestedBlockId(seed.runId, index, path),
    item_type: { id: seed.leafBlockModelId, type: 'item_type' },
    label,
    related_node: nextId,
    container_modules:
      depth > 0
        ? [
            buildContainerBlock(
              seed,
              index,
              `${path}.container_modules.0`,
              `${label} module`,
              previousId,
              nextId,
              depth - 1,
            ),
          ]
        : [],
    leaf_body: dastWithReferences({
      label: `${label} structured text`,
      inlineItemId: previousId,
      itemLinkId: nextId,
      ...(depth > 0
        ? {
            block: buildContainerBlock(
              seed,
              index,
              `${path}.leaf_body.block`,
              `${label} structured block`,
              nextId,
              previousId,
              depth - 1,
            ),
          }
        : {}),
    }),
  });
}

export function buildMediumScaleNestedBlockId(
  runId: string,
  index: number,
  path: string,
): string {
  const bytes = createHash('sha256')
    .update(`content-diff-medium-scale:${runId}:${index}:${path}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('base64url');
}

function dast(children: readonly unknown[]): Record<string, unknown> {
  return { schema: 'dast', document: { type: 'root', children } };
}

function dastWithReferences({
  label,
  inlineItemId,
  itemLinkId,
  block,
  inlineBlock,
}: Readonly<{
  label: string;
  inlineItemId: string | null;
  itemLinkId: string | null;
  block?: BlockPayload;
  inlineBlock?: BlockPayload;
}>): Record<string, unknown> {
  return dast([
    {
      type: 'paragraph',
      children: [
        { type: 'span', value: `${label} ` },
        ...(inlineItemId ? [{ type: 'inlineItem', item: inlineItemId }] : []),
        ...(itemLinkId
          ? [
              { type: 'span', value: ' then ' },
              {
                type: 'itemLink',
                item: itemLinkId,
                children: [{ type: 'span', value: 'linked record' }],
              },
            ]
          : []),
        ...(inlineBlock ? [{ type: 'inlineBlock', item: inlineBlock }] : []),
      ],
    },
    ...(block ? [{ type: 'block', item: block }] : []),
  ]);
}

function assertMediumScaleNestedUpdateStagesReuseIds({
  source,
  destination,
  plan,
  recordIds,
  baselineCount,
}: Readonly<{
  source: MediumScaleRawState;
  destination: MediumScaleRawState;
  plan: readonly MediumScalePlanEntry[];
  recordIds: readonly string[];
  baselineCount: number;
}>): void {
  const sourceCurrent = recordsById(source.current.records);
  const sourcePublished = recordsById(source.published.records);
  const destinationCurrent = recordsById(destination.current.records);

  for (const entry of plan) {
    const id = recordIds[entry.index];
    const desiredCurrent = requiredRecord(sourceCurrent, id, 'source current');
    const desiredPublished = sourcePublished.get(id);

    if (entry.index >= baselineCount) {
      const createSeed = desiredPublished ?? desiredCurrent;
      assertNestedIdsAvailable(
        desiredCurrent,
        createSeed,
        `${id} source-only current restore`,
      );
      continue;
    }

    let precedingCurrent = requiredRecord(
      destinationCurrent,
      id,
      'destination current',
    );
    if (desiredPublished) {
      assertNestedIdsAvailable(
        desiredPublished,
        precedingCurrent,
        `${id} published stage`,
      );
      precedingCurrent = desiredPublished;
    }
    assertNestedIdsAvailable(
      desiredCurrent,
      precedingCurrent,
      `${id} current restore`,
    );
  }
}

function assertNestedIdsAvailable(
  desired: CanonicalGraphRecord,
  precedingCurrent: CanonicalGraphRecord,
  label: string,
): void {
  const available = collectNestedItemIds(precedingCurrent.fields);
  const fresh = [...collectNestedItemIds(desired.fields)]
    .filter((id) => !available.has(id))
    .sort(compareCodeUnits);
  assert.deepEqual(
    fresh,
    [],
    `${label} introduces nested IDs absent from the preceding CURRENT`,
  );
}

function collectNestedItemIds(value: CanonicalGraphValue): Set<string> {
  const ids = new Set<string>();
  const visit = (entry: CanonicalGraphValue): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isObject(entry)) return;
    if (entry.kind === 'nestedItem' && typeof entry.id === 'string') {
      ids.add(entry.id);
    }
    Object.values(entry).forEach((child) =>
      visit(child as CanonicalGraphValue),
    );
  };
  visit(value);
  return ids;
}

function assertMediumScaleCoverage(
  state: MediumScaleRawState,
  plan: readonly MediumScalePlanEntry[],
  recordIds: readonly string[],
): void {
  assert.equal(state.current.totalCount, MEDIUM_SCALE_RECORD_COUNT);
  assert.equal(state.current.pageCount, 3);
  const expectedPublishedCount = plan.filter(
    ({ lifecycle }) => lifecycle !== 'draft',
  ).length;
  assert.ok(expectedPublishedCount > 30);
  assert.equal(state.published.totalCount, expectedPublishedCount);
  assert.equal(state.published.pageCount, 2);

  const currentById = recordsById(state.current.records);
  const publishedById = recordsById(state.published.records);
  for (const entry of plan) {
    const id = recordIds[entry.index];
    const current = requiredRecord(currentById, id, 'current');
    const nextId = recordIds[entry.nextIndex];
    const previousId = recordIds[entry.previousIndex];

    assert.equal(current.lifecycle.status, entry.lifecycle, `${id} status`);
    assert.equal(
      current.lifecycle.currentValid,
      true,
      `${id} current validity`,
    );
    assert.equal(current.position, entry.position, `${id} position`);
    assertLocalizedKeys(current, [
      'title',
      'summary',
      'peer',
      'peers',
      'modules',
      'hero',
      'body',
    ]);
    assert.deepEqual(current.fields.peer, { en: nextId, it: previousId });
    assert.deepEqual(current.fields.peers, {
      en: [nextId, previousId],
      it: [previousId, nextId],
    });
    assertScalarCoverage(current);

    const coverage = collectMediumScaleCoverage(current.fields);
    assert.ok(coverage.inlineItemNodes >= 2, `${id} lost inlineItem nodes`);
    assert.ok(coverage.itemLinkNodes >= 2, `${id} lost itemLink nodes`);
    assert.deepEqual(
      [...coverage.recordReferences].sort(compareCodeUnits),
      [nextId, previousId].sort(compareCodeUnits),
      `${id} Structured Text references drifted`,
    );
    if (entry.complex) {
      assert.ok(coverage.blockNodes > 0, `${id} lost block nodes`);
      assert.ok(coverage.inlineBlockNodes > 0, `${id} lost inlineBlock nodes`);
      assert.ok(coverage.nestedItems > 0, `${id} lost nested block records`);
      assert.ok(
        coverage.maximumNestedItemDepth >= (entry.recursionDepth === 2 ? 3 : 2),
        `${id} recursive depth is only ${coverage.maximumNestedItemDepth}`,
      );
    } else {
      assert.equal(coverage.blockNodes, 0, `${id} unexpectedly has blocks`);
      assert.equal(
        coverage.inlineBlockNodes,
        0,
        `${id} unexpectedly has inline blocks`,
      );
      assert.equal(
        coverage.nestedItems,
        0,
        `${id} unexpectedly has nested items`,
      );
    }

    const published = publishedById.get(id);
    if (entry.lifecycle === 'draft') {
      assert.equal(
        published,
        undefined,
        `${id} unexpectedly has a published slice`,
      );
      continue;
    }
    assert.ok(published, `${id} lost its published slice`);
    assert.equal(
      published.lifecycle.publishedValid,
      true,
      `${id} published validity`,
    );
    if (entry.lifecycle === 'published') {
      assert.deepEqual(
        published.fields,
        current.fields,
        `${id} published fields`,
      );
      assert.equal(
        published.position,
        current.position,
        `${id} published position`,
      );
    } else {
      assert.notDeepEqual(
        published.fields,
        current.fields,
        `${id} updated lifecycle lost its older published snapshot`,
      );
    }
  }
}

function assertScalarCoverage(record: CanonicalGraphRecord): void {
  assert.equal(
    typeof record.fields.featured,
    'boolean',
    `${record.id}.featured`,
  );
  assert.ok(Number.isInteger(record.fields.score), `${record.id}.score`);
  assert.equal(typeof record.fields.weight, 'number', `${record.id}.weight`);
  assert.match(
    requiredStringField(record, 'calendar_date'),
    /^\d{4}-\d{2}-\d{2}$/,
  );
  assert.match(requiredStringField(record, 'timestamp'), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(requiredStringField(record, 'slug_value'), /^[a-z]+-[0-9]{2}$/);

  const json: unknown = JSON.parse(
    requiredStringField(record, 'settings_json'),
  );
  assert.ok(isObject(json), `${record.id}.settings_json is not an object`);
  assert.equal(typeof json.index, 'number');
  assert.equal(typeof json.variant, 'string');

  const accent = requiredCanonicalObject(
    record.fields.accent,
    `${record.id}.accent`,
  );
  assert.deepEqual(Object.keys(accent).sort(), [
    'alpha',
    'blue',
    'green',
    'red',
  ]);
  for (const component of Object.values(accent)) {
    assert.ok(typeof component === 'number');
    assert.ok(component >= 0 && component <= 255);
  }

  const coordinates = requiredCanonicalObject(
    record.fields.coordinates,
    `${record.id}.coordinates`,
  );
  assert.deepEqual(Object.keys(coordinates).sort(), ['latitude', 'longitude']);
  assert.ok(typeof coordinates.latitude === 'number');
  assert.ok(typeof coordinates.longitude === 'number');
  assert.ok(coordinates.latitude >= -90);
  assert.ok(coordinates.latitude <= 90);
  assert.ok(coordinates.longitude >= -180);
  assert.ok(coordinates.longitude <= 180);
}

function assertLocalizedKeys(
  record: CanonicalGraphRecord,
  apiKeys: readonly string[],
): void {
  for (const apiKey of apiKeys) {
    const value = requiredCanonicalObject(
      record.fields[apiKey],
      `${record.id}.${apiKey}`,
    );
    assert.deepEqual(
      Object.keys(value).sort(compareCodeUnits),
      ['en', 'it'],
      `${record.id}.${apiKey} lost locale-key presence`,
    );
  }
}

function requiredStringField(
  record: CanonicalGraphRecord,
  apiKey: string,
): string {
  const value = record.fields[apiKey];
  if (typeof value !== 'string') {
    throw new Error(`${record.id}.${apiKey} must be a string`);
  }
  return value;
}

function requiredCanonicalObject(
  value: CanonicalGraphValue | undefined,
  label: string,
): Readonly<Record<string, CanonicalGraphValue>> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function recordsById(
  records: readonly CanonicalGraphRecord[],
): ReadonlyMap<string, CanonicalGraphRecord> {
  return new Map(records.map((record) => [record.id, record]));
}

function requiredRecord(
  records: ReadonlyMap<string, CanonicalGraphRecord>,
  id: string,
  slice: string,
): CanonicalGraphRecord {
  const record = records.get(id);
  assert.ok(record, `${slice} raw CMA slice is missing record ${id}`);
  return record;
}

async function bulkPublish(
  client: CmaClient.Client,
  recordIds: readonly string[],
): Promise<void> {
  if (recordIds.length === 0) return;
  await client.items.bulkPublish({
    items: recordIds.map<CmaClient.ApiTypes.ItemData>((id) => ({
      id,
      type: 'item',
    })),
  });
}

async function bulkUnpublish(
  client: CmaClient.Client,
  recordIds: readonly string[],
): Promise<void> {
  if (recordIds.length === 0) return;
  await client.items.bulkUnpublish({
    items: recordIds.map<CmaClient.ApiTypes.ItemData>((id) => ({
      id,
      type: 'item',
    })),
  });
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () =>
      worker(),
    ),
  );
  return results;
}

async function assertMigrationTracked({
  client,
  migrationFilename,
  migrationModelApiKey,
}: Readonly<{
  client: CmaClient.Client;
  migrationFilename: string;
  migrationModelApiKey: string;
}>): Promise<void> {
  const migrationModel = (await client.itemTypes.list()).find(
    ({ api_key }) => api_key === migrationModelApiKey,
  );
  assert.ok(migrationModel, 'migrations:run did not create its tracking model');
  const response = await client.items.rawList<MigrationRecordDefinition>({
    filter: { type: migrationModel.id },
    page: { limit: 500 },
  });
  assert.deepEqual(
    response.data.map(({ attributes }) => attributes.name).sort(),
    [migrationFilename],
    'migrations:run did not track exactly the generated migration',
  );
}

function padded(value: number): string {
  return value.toString().padStart(2, '0');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObject(
  value: unknown,
): value is Record<string, CanonicalGraphValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
