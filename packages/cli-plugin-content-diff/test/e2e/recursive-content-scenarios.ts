import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type ScenarioMode = 'relax' | 'skip';

type RecursiveSeed = RealCmaScenarioSeed &
  Readonly<{
    nodeModelId: string;
    nodeModelApiKey: string;
    containerBlockModelId: string;
    leafBlockModelId: string;
    bodyFieldId: string;
    safeBodyFieldId: string;
    containerBodyFieldId: string;
    schemaItemTypeIds: readonly string[];
  }>;

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

type CanonicalRecord = Readonly<{
  id: string;
  itemTypeId: string;
  fields: Readonly<Record<string, CanonicalValue>>;
  lifecycle: Readonly<{
    status: string | null;
    currentValid: boolean | null;
    publishedValid: boolean | null;
  }>;
}>;

type RecursiveRawState = Readonly<{
  current: readonly CanonicalRecord[];
  published: readonly CanonicalRecord[];
}>;

type ValidatorState = readonly Readonly<{
  itemTypeId: string;
  fieldId: string;
  apiKey: string;
  validators: CanonicalValue;
}>[];

type RecursiveExpected = Readonly<{
  recordIds: readonly [string, string];
  source: RecursiveRawState;
  destination: RecursiveRawState;
  validators: ValidatorState;
}>;

type BlockPayload = ReturnType<typeof CmaClient.buildBlockRecord>;

type MigrationRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    name: { type: 'string'; localized: false };
  };
};

const REQUIRED_PEER_API_KEY = 'required_peer';
const RESERVED_LEDGER_API_KEY = 'datocms_content_diff';
const LIVE_MODEL_API_KEY_MAX_LENGTH = 30;
const LIVE_MODEL_API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;

export function buildRecursiveModelApiKeys(runId: string): Readonly<{
  node: string;
  containerBlock: string;
  leafBlock: string;
}> {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const result = {
    node: `cde2e_rn_r${suffix}`,
    containerBlock: `cde2e_rc_r${suffix}`,
    leafBlock: `cde2e_rl_r${suffix}`,
  };

  for (const apiKey of Object.values(result)) {
    assert.match(apiKey, LIVE_MODEL_API_KEY_PATTERN);
    assert.ok(
      apiKey.length <= LIVE_MODEL_API_KEY_MAX_LENGTH,
      `recursive E2E model API key exceeds ${LIVE_MODEL_API_KEY_MAX_LENGTH} characters: ${apiKey}`,
    );
  }

  return result;
}

export function compareDatoIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const recursiveRequiredCycleRelaxationScenario =
  buildRecursiveScenario('relax');

export const recursiveRequiredCycleSkipScenario =
  buildRecursiveScenario('skip');

function buildRecursiveScenario(
  mode: ScenarioMode,
): RealCmaScenario<RecursiveSeed, RecursiveExpected> {
  return {
    name:
      mode === 'relax'
        ? 'recursive localized published Structured Text-only cycle with validator relaxation'
        : 'recursive localized Structured Text-only cycle skipped without validator relaxation',
    ...(mode === 'relax'
      ? { contentDiffArgs: ['--migrate-invalid-content'] }
      : {}),

    async seedSource({ client, runId }) {
      console.log(
        '[content-diff e2e] Creating recursive localized schema in source sandbox',
      );

      await client.site.update({ locales: ['en', 'it'] });
      const modelApiKeys = buildRecursiveModelApiKeys(runId);
      const nodeModelApiKey = modelApiKeys.node;
      const nodeModel = await client.itemTypes.create({
        name: `Recursive node ${runId}`,
        api_key: nodeModelApiKey,
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
      const containerBlock = await client.itemTypes.create({
        name: `Recursive container ${runId}`,
        api_key: modelApiKeys.containerBlock,
        modular_block: true,
      });
      const leafBlock = await client.itemTypes.create({
        name: `Recursive leaf ${runId}`,
        api_key: modelApiKeys.leafBlock,
        modular_block: true,
      });

      await client.fields.create(nodeModel.id, {
        label: 'Title',
        api_key: 'title',
        field_type: 'string',
        localized: true,
        validators: { required: {} },
      });
      await client.fields.create(nodeModel.id, {
        label: 'Required peer',
        api_key: REQUIRED_PEER_API_KEY,
        field_type: 'link',
        localized: false,
        validators: linkValidators(nodeModel.id),
      });
      await client.fields.create(nodeModel.id, {
        label: 'Localized peer',
        api_key: 'localized_peer',
        field_type: 'link',
        localized: true,
        validators: linkValidators(nodeModel.id),
      });
      await client.fields.create(nodeModel.id, {
        label: 'Localized peers',
        api_key: 'localized_peers',
        field_type: 'links',
        localized: true,
        validators: linksValidators(nodeModel.id),
      });
      await client.fields.create(nodeModel.id, {
        label: 'Modules',
        api_key: 'modules',
        field_type: 'rich_text',
        localized: true,
        validators: {
          rich_text_blocks: {
            item_types: [containerBlock.id, leafBlock.id],
          },
        },
      });
      await client.fields.create(nodeModel.id, {
        label: 'Hero',
        api_key: 'hero',
        field_type: 'single_block',
        localized: true,
        validators: {
          single_block_blocks: { item_types: [containerBlock.id] },
        },
      });
      const bodyField = await client.fields.create(nodeModel.id, {
        label: 'Body',
        api_key: 'body',
        field_type: 'structured_text',
        localized: true,
        validators: structuredTextValidators({
          blockModelIds: [containerBlock.id, leafBlock.id],
          linkModelId: nodeModel.id,
        }),
      });
      const safeBodyField = await client.fields.create(nodeModel.id, {
        label: 'Safe body',
        api_key: 'safe_body',
        field_type: 'structured_text',
        localized: true,
        validators: structuredTextValidators({
          blockModelIds: [containerBlock.id, leafBlock.id],
          linkModelId: nodeModel.id,
        }),
      });

      let containerBodyFieldId: string | null = null;
      for (const {
        itemTypeId,
        definition,
      } of buildRecursiveBlockFieldDefinitions({
        nodeModelId: nodeModel.id,
        containerBlockModelId: containerBlock.id,
        leafBlockModelId: leafBlock.id,
      })) {
        const field = await client.fields.create(itemTypeId, definition);
        if (itemTypeId === containerBlock.id && definition.api_key === 'body') {
          containerBodyFieldId = field.id;
        }
      }
      assert.ok(containerBodyFieldId, 'container body field was not created');

      return {
        itemTypeApiKeys: [nodeModelApiKey],
        nodeModelId: nodeModel.id,
        nodeModelApiKey,
        containerBlockModelId: containerBlock.id,
        leafBlockModelId: leafBlock.id,
        bodyFieldId: bodyField.id,
        safeBodyFieldId: safeBodyField.id,
        containerBodyFieldId,
        schemaItemTypeIds: [nodeModel.id, containerBlock.id, leafBlock.id],
      };
    },

    async introduceDrift({ seed, sourceClient, destinationClient }) {
      console.log(
        '[content-diff e2e] Creating a source-only published Structured Text-only required-reference cycle',
      );

      const first = await sourceClient.items.create({
        item_type: { id: seed.nodeModelId, type: 'item_type' },
        ...shellFields('first'),
      });
      const second = await sourceClient.items.create({
        item_type: { id: seed.nodeModelId, type: 'item_type' },
        ...shellFields('second'),
      });
      await sourceClient.items.publish(first.id);
      await sourceClient.items.publish(second.id);

      const [publishedFirst, publishedSecond] = await Promise.all([
        sourceClient.items.find(first.id),
        sourceClient.items.find(second.id),
      ]);

      await sourceClient.items.update(first.id, {
        ...completeFields(seed, 'first', first.id, second.id),
        meta: { current_version: publishedFirst.meta.current_version },
      });
      await sourceClient.items.update(second.id, {
        ...completeFields(seed, 'second', second.id, first.id),
        meta: { current_version: publishedSecond.meta.current_version },
      });
      await sourceClient.items.publish(first.id);
      await sourceClient.items.publish(second.id);

      const topLevelStructuredTextValidators =
        buildRequiredStructuredTextValidators({
          blockModelIds: [seed.containerBlockModelId, seed.leafBlockModelId],
          linkModelId: seed.nodeModelId,
        });
      const nestedStructuredTextValidators =
        buildRequiredStructuredTextValidators({
          blockModelIds: [seed.leafBlockModelId],
          linkModelId: seed.nodeModelId,
        });
      await Promise.all([
        sourceClient.fields.update(seed.bodyFieldId, {
          validators: topLevelStructuredTextValidators,
        }),
        destinationClient.fields.update(seed.bodyFieldId, {
          validators: topLevelStructuredTextValidators,
        }),
        sourceClient.fields.update(seed.safeBodyFieldId, {
          validators: topLevelStructuredTextValidators,
        }),
        destinationClient.fields.update(seed.safeBodyFieldId, {
          validators: topLevelStructuredTextValidators,
        }),
        sourceClient.fields.update(seed.containerBodyFieldId, {
          validators: nestedStructuredTextValidators,
        }),
        destinationClient.fields.update(seed.containerBodyFieldId, {
          validators: nestedStructuredTextValidators,
        }),
      ]);
      // Validator revalidation is queued with a delay by the API. The
      // reference-only DAST values satisfy `required`, but contain no span/code
      // text and therefore fail `length: { min: 1 }`. Wait for those semantic
      // validity flags to settle before content:diff takes its read-only
      // snapshots; otherwise the background worker can finish during
      // generation and make the harness fingerprint look mutated.
      await waitForRecordValidity(sourceClient, [first.id, second.id], {
        current: false,
        published: false,
      });

      const recordIds = [first.id, second.id].sort(compareDatoIds) as [
        string,
        string,
      ];
      const [source, destination, sourceValidators, destinationValidators] =
        await Promise.all([
          captureRecursiveRawState(sourceClient, seed.nodeModelId, recordIds),
          captureRecursiveRawState(
            destinationClient,
            seed.nodeModelId,
            recordIds,
          ),
          captureValidatorState(sourceClient, seed.schemaItemTypeIds),
          captureValidatorState(destinationClient, seed.schemaItemTypeIds),
        ]);

      assertRecursiveCoverage(source, recordIds, seed);
      assert.deepEqual(destination.current, []);
      assert.deepEqual(destination.published, []);
      assert.deepEqual(
        destinationValidators,
        sourceValidators,
        'source and destination validators differ before generation',
      );
      assertStructuredTextValidator(
        sourceValidators,
        seed.bodyFieldId,
        topLevelStructuredTextValidators,
      );
      assertStructuredTextValidator(
        sourceValidators,
        seed.safeBodyFieldId,
        topLevelStructuredTextValidators,
      );
      assertStructuredTextValidator(
        sourceValidators,
        seed.containerBodyFieldId,
        nestedStructuredTextValidators,
      );

      return {
        recordIds,
        source,
        destination,
        validators: sourceValidators,
      };
    },

    async verifyGeneratedPlan({ seed, expected, planFilePath }) {
      await assertRecursiveManifest(planFilePath, seed, expected, mode);
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
        `[content-diff e2e] Verifying recursive ${mode} scenario through raw CMA`,
      );

      await waitForRecordValidity(sourceClient, expected.recordIds, {
        current: false,
        published: false,
      });
      if (mode === 'relax') {
        // Restoring the source validators queues the same delayed API
        // revalidation in the applied environment. Settle it before exact
        // state comparison and the subsequent replay fingerprint.
        await waitForRecordValidity(appliedClient, expected.recordIds, {
          current: false,
          published: false,
        });
      }

      const [source, destination, applied] = await Promise.all([
        captureRecursiveRawState(
          sourceClient,
          seed.nodeModelId,
          expected.recordIds,
        ),
        captureRecursiveRawState(
          destinationClient,
          seed.nodeModelId,
          expected.recordIds,
        ),
        captureRecursiveRawState(
          appliedClient,
          seed.nodeModelId,
          expected.recordIds,
        ),
      ]);
      assert.deepEqual(
        source,
        expected.source,
        'source changed during E2E run',
      );
      assert.deepEqual(
        destination,
        expected.destination,
        'destination changed during E2E run',
      );

      if (mode === 'relax') {
        assert.deepEqual(
          applied,
          expected.source,
          'applied recursive content does not exactly match source current/published slices',
        );
        assertRecursiveCoverage(applied, expected.recordIds, seed);
      } else {
        assert.deepEqual(
          applied,
          expected.destination,
          'unsafe required cycle was not skipped as a whole aggregate set',
        );
      }

      const [sourceValidators, destinationValidators, appliedValidators] =
        await Promise.all([
          captureValidatorState(sourceClient, seed.schemaItemTypeIds),
          captureValidatorState(destinationClient, seed.schemaItemTypeIds),
          captureValidatorState(appliedClient, seed.schemaItemTypeIds),
        ]);
      assert.deepEqual(sourceValidators, expected.validators);
      assert.deepEqual(destinationValidators, expected.validators);
      assert.deepEqual(
        appliedValidators,
        expected.validators,
        'temporary validator relaxation was not restored byte-equivalently',
      );
      for (const fieldId of [
        seed.bodyFieldId,
        seed.safeBodyFieldId,
        seed.containerBodyFieldId,
      ]) {
        const field = expected.validators.find(
          ({ fieldId: candidateId }) => candidateId === fieldId,
        );
        assert.ok(field, `expected validators are missing field ${fieldId}`);
        assertStructuredTextValidator(
          appliedValidators,
          fieldId,
          requiredObject(field.validators, `${fieldId} validators`),
        );
      }

      await assertMigrationTracked({
        client: appliedClient,
        migrationFilename,
        migrationModelApiKey,
      });
      const models = await appliedClient.itemTypes.list();
      assert.equal(
        models.some(({ api_key }) => api_key === RESERVED_LEDGER_API_KEY),
        false,
        'portable-ID cycle unexpectedly created the legacy-ID ledger',
      );
    },
  };
}

function linkValidators(itemTypeId: string) {
  return { item_item_type: relationshipValidator([itemTypeId]) };
}

function linksValidators(itemTypeId: string) {
  return { items_item_type: relationshipValidator([itemTypeId]) };
}

function relationshipValidator(itemTypeIds: readonly string[]) {
  return {
    item_types: [...itemTypeIds],
    on_publish_with_unpublished_references_strategy: 'fail' as const,
    on_reference_unpublish_strategy: 'delete_references' as const,
    on_reference_delete_strategy: 'delete_references' as const,
  };
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
    structured_text_links: relationshipValidator([linkModelId]),
  };
}

export function buildRequiredStructuredTextValidators(
  options: Readonly<{
    blockModelIds: readonly string[];
    linkModelId: string;
  }>,
) {
  return {
    ...structuredTextValidators(options),
    required: {},
    length: { min: 1 },
  };
}

export function buildRecursiveBlockFieldDefinitions({
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
        definition: {
          label: 'Label',
          api_key: 'label',
          field_type: 'string' as const,
          localized: false as const,
          validators: {},
        },
      },
      {
        itemTypeId,
        definition: {
          label: 'Related',
          api_key: 'related',
          field_type: 'link' as const,
          localized: false as const,
          validators: linkValidators(nodeModelId),
        },
      },
    ]),
    {
      itemTypeId: containerBlockModelId,
      definition: {
        label: 'Single',
        api_key: 'single',
        field_type: 'single_block' as const,
        localized: false as const,
        validators: {
          single_block_blocks: { item_types: [leafBlockModelId] },
        },
      },
    },
    {
      itemTypeId: containerBlockModelId,
      definition: {
        label: 'Modules',
        api_key: 'modules',
        field_type: 'rich_text' as const,
        localized: false as const,
        validators: {
          rich_text_blocks: { item_types: [leafBlockModelId] },
        },
      },
    },
    {
      itemTypeId: containerBlockModelId,
      definition: {
        label: 'Body',
        api_key: 'body',
        field_type: 'structured_text' as const,
        localized: false as const,
        validators: structuredTextValidators({
          blockModelIds: [leafBlockModelId],
          linkModelId: nodeModelId,
        }),
      },
    },
    {
      itemTypeId: leafBlockModelId,
      definition: {
        label: 'Nested modules',
        api_key: 'nested_modules',
        field_type: 'rich_text' as const,
        localized: false as const,
        validators: {
          rich_text_blocks: { item_types: [containerBlockModelId] },
        },
      },
    },
    {
      itemTypeId: leafBlockModelId,
      definition: {
        label: 'Body',
        api_key: 'body',
        field_type: 'structured_text' as const,
        localized: false as const,
        validators: structuredTextValidators({
          blockModelIds: [containerBlockModelId],
          linkModelId: nodeModelId,
        }),
      },
    },
  ];
}

function shellFields(label: string) {
  return {
    title: { en: `${label} shell`, it: `${label} bozza` },
    required_peer: null,
    localized_peer: { en: null, it: null },
    localized_peers: { en: [], it: [] },
    modules: { en: [], it: [] },
    hero: { en: null, it: null },
    body: {
      en: dast([
        { type: 'paragraph', children: [{ type: 'span', value: '' }] },
      ]),
      it: dast([
        { type: 'paragraph', children: [{ type: 'span', value: '' }] },
      ]),
    },
    safe_body: {
      en: dast([
        { type: 'paragraph', children: [{ type: 'span', value: '' }] },
      ]),
      it: dast([
        { type: 'paragraph', children: [{ type: 'span', value: '' }] },
      ]),
    },
  };
}

function completeFields(
  seed: RecursiveSeed,
  label: string,
  ownId: string,
  peerId: string,
) {
  return {
    title: { en: `${label} final`, it: `${label} finale` },
    required_peer: peerId,
    localized_peer: { en: peerId, it: peerId },
    localized_peers: {
      en: [peerId, ownId],
      it: [ownId, peerId],
    },
    modules: {
      en: [buildContainerBlock(seed, `${label} modules en`, peerId, true)],
      it: [buildContainerBlock(seed, `${label} modules it`, peerId, false)],
    },
    hero: {
      en: buildContainerBlock(seed, `${label} hero en`, peerId, true),
      it: buildContainerBlock(seed, `${label} hero it`, peerId, false),
    },
    body: {
      en: buildNormalizedEmptyShellReferenceDast(peerId),
      it: buildNormalizedEmptyShellReferenceDast(peerId),
    },
    safe_body: {
      en: dastWithReferences({
        label: `${label} body en`,
        peerId,
        block: buildContainerBlock(
          seed,
          `${label} body block en`,
          peerId,
          true,
        ),
        inlineBlock: buildLeafBlock(
          seed,
          `${label} body inline en`,
          peerId,
          false,
        ),
      }),
      it: dastWithReferences({
        label: `${label} body it`,
        peerId,
        block: buildContainerBlock(
          seed,
          `${label} body block it`,
          peerId,
          false,
        ),
        inlineBlock: buildLeafBlock(
          seed,
          `${label} body inline it`,
          peerId,
          false,
        ),
      }),
    },
  };
}

function buildContainerBlock(
  seed: RecursiveSeed,
  label: string,
  peerId: string,
  recursive: boolean,
): BlockPayload {
  return CmaClient.buildBlockRecord({
    item_type: { id: seed.containerBlockModelId, type: 'item_type' },
    label,
    related: peerId,
    single: buildLeafBlock(seed, `${label} single`, peerId, recursive),
    modules: [buildLeafBlock(seed, `${label} module`, peerId, false)],
    body: buildNormalizedEmptyShellReferenceDast(peerId),
  });
}

function buildLeafBlock(
  seed: RecursiveSeed,
  label: string,
  peerId: string,
  recursive: boolean,
): BlockPayload {
  return CmaClient.buildBlockRecord({
    item_type: { id: seed.leafBlockModelId, type: 'item_type' },
    label,
    related: peerId,
    nested_modules: recursive
      ? [
          buildContainerBlock(
            seed,
            `${label} recursive container`,
            peerId,
            false,
          ),
        ]
      : [],
    body: dastWithReferences({ label: `${label} leaf body`, peerId }),
  });
}

function dast(children: readonly unknown[]): Record<string, unknown> {
  return {
    schema: 'dast',
    document: { type: 'root', children },
  };
}

function dastWithReferences({
  label,
  peerId,
  block,
  inlineBlock,
}: Readonly<{
  label: string;
  peerId: string;
  block?: BlockPayload;
  inlineBlock?: BlockPayload;
}>): Record<string, unknown> {
  return dast([
    {
      type: 'paragraph',
      children: [
        { type: 'span', value: `${label} ` },
        { type: 'inlineItem', item: peerId },
        { type: 'span', value: ' then ' },
        {
          type: 'itemLink',
          item: peerId,
          children: [{ type: 'span', value: 'peer' }],
        },
        ...(inlineBlock ? [{ type: 'inlineBlock', item: inlineBlock }] : []),
      ],
    },
    ...(block ? [{ type: 'block', item: block }] : []),
  ]);
}

export function buildNormalizedEmptyShellReferenceDast(
  peerId: string,
): Record<string, unknown> {
  return dast([
    {
      type: 'paragraph',
      children: [{ type: 'inlineItem', item: peerId }],
    },
  ]);
}

async function assertRecursiveManifest(
  planFilePath: string,
  seed: RecursiveSeed,
  expected: RecursiveExpected,
  mode: ScenarioMode,
): Promise<void> {
  const envelope = requiredObject(
    JSON.parse(await readFile(planFilePath, 'utf8')),
    'plan envelope',
  );
  const plan = requiredObject(envelope.plan, 'plan');
  const invalidContent = requiredObject(
    plan.invalidContent,
    'plan.invalidContent',
  );
  const execution = requiredObject(plan.execution, 'plan.execution');
  const permissions = requiredObject(
    plan.requiredPermissions,
    'plan.requiredPermissions',
  );
  const invalidContentSummary = requiredObject(
    requiredObject(plan.summary, 'plan.summary').invalidContent,
    'plan.summary.invalidContent',
  );
  const relaxations = requiredArray(
    invalidContent.validatorRelaxations,
    'validator relaxations',
  ).map((entry) => requiredObject(entry, 'validator relaxation'));
  const skipped = requiredArray(
    invalidContent.skippedRecords,
    'skipped records',
  ).map((entry) => requiredObject(entry, 'skipped record'));
  const sortedIds = (value: unknown, label: string) =>
    requiredArray(value, label).map(String).sort(compareDatoIds);

  assert.deepEqual(
    sortedIds(invalidContent.detectedRecordIds, 'detected record IDs'),
    [...expected.recordIds],
  );
  assert.equal(
    requiredObject(plan.options, 'plan.options').migrateInvalidContent,
    mode === 'relax',
  );

  if (mode === 'skip') {
    assert.equal(invalidContentSummary.status, 'partial');
    assert.deepEqual(relaxations, []);
    assert.equal(permissions.editSchema, false);
    assert.deepEqual(skipped.map(({ id }) => String(id)).sort(compareDatoIds), [
      ...expected.recordIds,
    ]);
    for (const entry of skipped) {
      assert.equal(entry.disposition, 'must_remain_absent');
      const reasons = requiredArray(entry.reasons, 'skip reasons').map(
        (reason) => requiredObject(reason, 'skip reason'),
      );
      assert.ok(
        reasons.some(
          ({ code, slice, dependencyChain }) =>
            code === 'REQUIRED_REFERENCE_CYCLE' &&
            slice === 'intermediate' &&
            JSON.stringify(
              requiredArray(dependencyChain, 'dependency chain')
                .map(String)
                .sort(compareDatoIds),
            ) === JSON.stringify(expected.recordIds),
        ),
        `skipped record ${String(entry.id)} lacks its complete cycle reason`,
      );
    }
    assert.deepEqual(
      sortedIds(execution.shellRecordIds, 'shell record IDs'),
      [],
    );
    assert.deepEqual(
      requiredArray(execution.shellComponents, 'shell components'),
      [],
    );
    assert.deepEqual(
      sortedIds(execution.publicationSeedOrder, 'publication seed order'),
      [],
    );
    return;
  }

  assert.equal(invalidContentSummary.status, 'complete');
  assert.deepEqual(skipped, []);
  assert.equal(permissions.editSchema, true);
  assert.deepEqual(
    sortedIds(invalidContent.migratedRecordIds, 'migrated record IDs'),
    [...expected.recordIds],
  );
  for (const key of [
    'shellRecordIds',
    'publicationSeedOrder',
    'revalidateBeforePublishIds',
  ]) {
    assert.deepEqual(
      sortedIds(execution[key], `execution.${key}`),
      [...expected.recordIds],
      `execution.${key} does not cover both published cycle records`,
    );
  }
  assert.deepEqual(
    requiredArray(execution.shellComponents, 'shell components').map(
      (component) =>
        requiredArray(component, 'shell component')
          .map(String)
          .sort(compareDatoIds),
    ),
    [[...expected.recordIds]],
  );

  const relaxationsByFieldId = new Map(
    relaxations.map((entry) => [String(entry.fieldId), entry]),
  );
  assert.deepEqual(
    [...relaxationsByFieldId.keys()].sort(compareDatoIds),
    [seed.bodyFieldId, seed.containerBodyFieldId].sort(compareDatoIds),
    'only the exact empty-shell Structured Text fields may be relaxed',
  );
  assert.equal(
    relaxationsByFieldId.has(seed.safeBodyFieldId),
    false,
    'safe_body retained prose and must not be relaxed',
  );

  for (const fieldId of [seed.bodyFieldId, seed.containerBodyFieldId]) {
    const relaxation = relaxationsByFieldId.get(fieldId);
    assert.ok(relaxation, `missing Structured Text relaxation ${fieldId}`);
    const liveField = expected.validators.find(
      ({ fieldId: candidateId }) => candidateId === fieldId,
    );
    assert.ok(liveField, `missing source validator snapshot ${fieldId}`);
    const original = requiredObject(
      liveField.validators,
      `${fieldId} original validators`,
    );
    const relaxed = Object.fromEntries(
      Object.entries(original).filter(
        ([validatorKey]) =>
          validatorKey !== 'required' && validatorKey !== 'length',
      ),
    );

    assert.deepEqual(relaxation.originalValidators, original);
    assert.deepEqual(relaxation.relaxedValidators, relaxed);
    assert.deepEqual(
      sortedIds(
        relaxation.relaxedValidatorKeys,
        `${fieldId} relaxed validator keys`,
      ),
      ['length', 'required'],
    );
    assert.deepEqual(
      sortedIds(relaxation.affectedRecordIds, `${fieldId} affected record IDs`),
      [...expected.recordIds],
    );
    requiredString(relaxation.originalHash, `${fieldId} original hash`);
    requiredString(relaxation.relaxedHash, `${fieldId} relaxed hash`);
  }
}

type RecordValidityState = Readonly<{
  current: boolean | null;
  published: boolean | null;
}>;

type RecordWithValidityMeta = Readonly<{
  meta: Readonly<{
    is_current_version_valid?: boolean | null;
    is_published_version_valid?: boolean | null;
  }>;
}>;

export async function waitForRecordValidityStateFromPort(
  loadRecords: () => Promise<readonly RecordWithValidityMeta[]>,
  expected: RecordValidityState,
  options: Readonly<{
    attempts?: number;
    label?: string;
    sleep?: () => Promise<void>;
  }> = {},
): Promise<void> {
  const attempts = options.attempts ?? 120;
  assert.ok(attempts > 0, 'validity polling requires at least one attempt');
  let observed: readonly RecordWithValidityMeta[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    observed = await loadRecords();
    if (
      observed.every(
        ({ meta }) =>
          meta.is_current_version_valid === expected.current &&
          meta.is_published_version_valid === expected.published,
      )
    ) {
      return;
    }

    if (attempt + 1 < attempts) {
      await (options.sleep ?? defaultValidityPollSleep)();
    }
  }

  throw new Error(
    `${options.label ?? 'records'} did not reach validity ${JSON.stringify(
      expected,
    )}; last observed ${JSON.stringify(
      observed.map(({ meta }) => ({
        current: meta.is_current_version_valid ?? null,
        published: meta.is_published_version_valid ?? null,
      })),
    )}`,
  );
}

async function waitForRecordValidity(
  client: CmaClient.Client,
  recordIds: readonly string[],
  expected: RecordValidityState,
): Promise<void> {
  await waitForRecordValidityStateFromPort(
    () => Promise.all(recordIds.map((recordId) => client.items.find(recordId))),
    expected,
    { label: `records ${recordIds.join(', ')}` },
  );
}

async function defaultValidityPollSleep(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, 500);
  });
}

async function captureRecursiveRawState(
  client: CmaClient.Client,
  modelId: string,
  selectedRecordIds: readonly string[],
): Promise<RecursiveRawState> {
  const selectedIds = new Set(selectedRecordIds);
  const captureSlice = async (
    version: 'current' | 'published',
  ): Promise<CanonicalRecord[]> => {
    const records: CanonicalRecord[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;

    while (offset < total) {
      const response = await client.items.rawList({
        filter: { type: modelId },
        nested: true,
        order_by: 'id_ASC',
        version,
        page: { offset, limit: 30 },
      });
      total = response.meta.total_count;
      for (const resource of response.data) {
        if (selectedIds.has(resource.id)) {
          records.push(parseCanonicalRecord(resource, modelId));
        }
      }
      if (response.data.length === 0) break;
      offset += response.data.length;
    }

    return records.sort((left, right) => compareDatoIds(left.id, right.id));
  };

  const [current, published] = await Promise.all([
    captureSlice('current'),
    captureSlice('published'),
  ]);
  return { current, published };
}

function parseCanonicalRecord(
  value: unknown,
  expectedItemTypeId: string,
): CanonicalRecord {
  const resource = requiredObject(value, 'raw item resource');
  const id = requiredString(resource.id, 'raw item ID');
  const itemTypeId = relationshipId(resource, 'item_type');
  assert.equal(
    itemTypeId,
    expectedItemTypeId,
    `record ${id} belongs to an unexpected model`,
  );
  const attributes = requiredObject(resource.attributes, `${id}.attributes`);
  const meta = requiredObject(resource.meta, `${id}.meta`);

  return {
    id,
    itemTypeId,
    fields: Object.fromEntries(
      Object.keys(attributes)
        .sort()
        .map((key) => [key, canonicalizeRawValue(attributes[key])]),
    ),
    lifecycle: {
      status: nullableString(meta.status, `${id}.meta.status`),
      currentValid: nullableBoolean(
        meta.is_current_version_valid,
        `${id}.meta.is_current_version_valid`,
      ),
      publishedValid: nullableBoolean(
        meta.is_published_version_valid,
        `${id}.meta.is_published_version_valid`,
      ),
    },
  };
}

function canonicalizeRawValue(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalizeRawValue);

  const object = requiredObject(value, 'field value');
  if (
    object.type === 'item' &&
    typeof object.id === 'string' &&
    isObject(object.attributes) &&
    isObject(object.relationships)
  ) {
    return {
      kind: 'nestedItem',
      id: object.id,
      itemTypeId: relationshipId(object, 'item_type'),
      fields: canonicalizeRawValue(object.attributes),
    };
  }

  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalizeRawValue(object[key])]),
  );
}

async function captureValidatorState(
  client: CmaClient.Client,
  itemTypeIds: readonly string[],
): Promise<ValidatorState> {
  const groups = await Promise.all(
    itemTypeIds.map(async (itemTypeId) => {
      const fields = await client.fields.list(itemTypeId);
      return fields.map((field) => ({
        itemTypeId,
        fieldId: field.id,
        apiKey: field.api_key,
        validators: canonicalizeRawValue(field.validators),
      }));
    }),
  );

  return groups
    .flat()
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

function assertStructuredTextValidator(
  validators: ValidatorState,
  fieldId: string,
  expectedValidators: Readonly<Record<string, unknown>>,
): void {
  const field = validators.find(
    ({ fieldId: candidateId }) => candidateId === fieldId,
  );
  assert.ok(
    field,
    `Structured Text field ${fieldId} is absent from validator state`,
  );
  assert.deepEqual(
    normalizeRelationshipValidatorForAssertion(field.validators),
    normalizeRelationshipValidatorForAssertion(expectedValidators),
    `Structured Text validators for ${fieldId} were not restored exactly`,
  );
}

function normalizeRelationshipValidatorForAssertion(
  value: unknown,
): CanonicalValue {
  const canonical = canonicalizeRawValue(value);
  if (!isObject(canonical)) return canonical;

  return Object.fromEntries(
    Object.entries(canonical).map(([key, validator]) => {
      if (!isObject(validator) || !Array.isArray(validator.item_types)) {
        return [key, validator];
      }
      return [
        key,
        {
          ...validator,
          item_types: [...validator.item_types].sort((left, right) =>
            compareDatoIds(String(left), String(right)),
          ),
        },
      ];
    }),
  );
}

function assertRecursiveCoverage(
  state: RecursiveRawState,
  recordIds: readonly [string, string],
  seed: RecursiveSeed,
): void {
  assert.deepEqual(
    state.current.map(({ id }) => id),
    [...recordIds],
  );
  assert.deepEqual(
    state.published.map(({ id }) => id),
    [...recordIds],
  );

  for (const slice of [state.current, state.published]) {
    for (const record of slice) {
      const peerId = recordIds.find((id) => id !== record.id);
      assert.ok(peerId, `record ${record.id} has no peer`);
      assert.equal(record.lifecycle.status, 'published');
      assert.equal(record.lifecycle.currentValid, false);
      assert.equal(record.lifecycle.publishedValid, false);
      assert.equal(record.fields.required_peer, peerId);
      assert.deepEqual(record.fields.localized_peer, {
        en: peerId,
        it: peerId,
      });
      assert.deepEqual(record.fields.localized_peers, {
        en: [peerId, record.id],
        it: [record.id, peerId],
      });

      for (const apiKey of [
        'title',
        'localized_peer',
        'localized_peers',
        'modules',
        'hero',
        'body',
        'safe_body',
      ]) {
        assert.deepEqual(
          Object.keys(requiredObject(record.fields[apiKey], apiKey)).sort(),
          ['en', 'it'],
          `${record.id}.${apiKey} lost localized key presence`,
        );
      }
      for (const locale of ['en', 'it']) {
        assertEmptyShellReferenceDocument(
          requiredObject(record.fields.body, `${record.id}.body`)[locale],
          peerId,
          `${record.id}.body.${locale}`,
        );
        assertTextBearingReferenceDocument(
          requiredObject(record.fields.safe_body, `${record.id}.safe_body`)[
            locale
          ],
          peerId,
          `${record.id}.safe_body.${locale}`,
        );
      }
      const nestedContainerBodies = collectNestedItemFieldValues(
        record.fields,
        seed.containerBlockModelId,
        'body',
      );
      assert.ok(
        nestedContainerBodies.length > 0,
        `${record.id} has no nested container Structured Text body`,
      );
      for (const [index, body] of nestedContainerBodies.entries()) {
        assertEmptyShellReferenceDocument(
          body,
          peerId,
          `${record.id}.nestedContainerBody[${index}]`,
        );
      }

      const coverage = collectRecursiveCoverage(record.fields);
      assert.ok(coverage.blockNodes > 0, 'missing Structured Text block node');
      assert.ok(
        coverage.inlineBlockNodes > 0,
        'missing Structured Text inlineBlock node',
      );
      assert.ok(
        coverage.inlineItemNodes > 0,
        'missing Structured Text inlineItem node',
      );
      assert.ok(
        coverage.itemLinkNodes > 0,
        'missing Structured Text itemLink node',
      );
      assert.ok(coverage.nestedItems > 0, 'missing nested block records');
      assert.ok(
        coverage.maximumNestedItemDepth >= 4,
        `recursive block depth is only ${coverage.maximumNestedItemDepth}`,
      );
      assert.deepEqual(
        [...coverage.recordReferences].sort(),
        [peerId],
        `Structured Text references in ${record.id} do not point exclusively to its peer`,
      );
    }
  }
}

function assertEmptyShellReferenceDocument(
  value: unknown,
  peerId: string,
  label: string,
): void {
  const document = requiredObject(
    requiredObject(value, label).document,
    `${label}.document`,
  );
  const paragraph = requiredObject(
    requiredArray(document.children, `${label}.document.children`)[0],
    `${label}.paragraph`,
  );
  assert.deepEqual(paragraph.children, [{ item: peerId, type: 'inlineItem' }]);
}

function assertTextBearingReferenceDocument(
  value: unknown,
  peerId: string,
  label: string,
): void {
  const coverage = collectRecursiveCoverage(value as CanonicalValue);
  assert.ok(coverage.inlineItemNodes > 0, `${label} has no inlineItem`);
  assert.ok(coverage.itemLinkNodes > 0, `${label} has no itemLink`);
  assert.deepEqual([...coverage.recordReferences], [peerId]);
  assert.ok(
    collectSpanValues(value as CanonicalValue).some(
      (text) => text.trim().length > 0,
    ),
    `${label} has no prose that can survive reference stripping`,
  );
}

function collectNestedItemFieldValues(
  value: CanonicalValue,
  itemTypeId: string,
  apiKey: string,
): CanonicalValue[] {
  const result: CanonicalValue[] = [];
  const visit = (entry: CanonicalValue): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isObject(entry)) return;
    if (entry.kind === 'nestedItem' && entry.itemTypeId === itemTypeId) {
      const fields = requiredObject(entry.fields, 'nested item fields');
      if (apiKey in fields) result.push(fields[apiKey] as CanonicalValue);
    }
    Object.values(entry).forEach((child) => visit(child as CanonicalValue));
  };
  visit(value);
  return result;
}

function collectSpanValues(value: CanonicalValue): string[] {
  const result: string[] = [];
  const visit = (entry: CanonicalValue): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isObject(entry)) return;
    if (entry.type === 'span' && typeof entry.value === 'string') {
      result.push(entry.value);
    }
    Object.values(entry).forEach((child) => visit(child as CanonicalValue));
  };
  visit(value);
  return result;
}

function collectRecursiveCoverage(value: CanonicalValue) {
  const result = {
    blockNodes: 0,
    inlineBlockNodes: 0,
    inlineItemNodes: 0,
    itemLinkNodes: 0,
    nestedItems: 0,
    maximumNestedItemDepth: 0,
    recordReferences: new Set<string>(),
  };

  const visit = (entry: CanonicalValue, nestedItemDepth: number): void => {
    if (Array.isArray(entry)) {
      entry.forEach((child) => visit(child, nestedItemDepth));
      return;
    }
    if (!isObject(entry)) return;

    if (entry.kind === 'nestedItem') {
      result.nestedItems += 1;
      const nextDepth = nestedItemDepth + 1;
      result.maximumNestedItemDepth = Math.max(
        result.maximumNestedItemDepth,
        nextDepth,
      );
      visit(entry.fields as CanonicalValue, nextDepth);
      return;
    }
    if (entry.type === 'block') result.blockNodes += 1;
    if (entry.type === 'inlineBlock') result.inlineBlockNodes += 1;
    if (entry.type === 'inlineItem') {
      result.inlineItemNodes += 1;
      if (typeof entry.item === 'string') {
        result.recordReferences.add(entry.item);
      }
    }
    if (entry.type === 'itemLink') {
      result.itemLinkNodes += 1;
      if (typeof entry.item === 'string') {
        result.recordReferences.add(entry.item);
      }
    }
    Object.values(entry).forEach((child) =>
      visit(child as CanonicalValue, nestedItemDepth),
    );
  };

  visit(value, 0);
  return result;
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

function relationshipId(
  resource: Readonly<Record<string, unknown>>,
  relationshipName: string,
): string {
  const relationships = requiredObject(
    resource.relationships,
    'resource relationships',
  );
  const relationship = requiredObject(
    relationships[relationshipName],
    `relationship ${relationshipName}`,
  );
  const data = requiredObject(
    relationship.data,
    `relationship ${relationshipName}.data`,
  );
  return requiredString(data.id, `relationship ${relationshipName}.data.id`);
}

function requiredObject(
  value: unknown,
  label: string,
): Record<string, CanonicalValue | unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`${label} must be a string or null`);
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error(`${label} must be a boolean or null`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
