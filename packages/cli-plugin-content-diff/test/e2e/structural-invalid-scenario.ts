import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type OwnerDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    related: { type: 'link'; localized: false };
    body: { type: 'structured_text'; localized: false };
  };
};

type StructuralSeed = RealCmaScenarioSeed &
  Readonly<{
    ownerModelId: string;
    allowedContainerModelId: string;
    allowedLeafModelId: string;
    retiredContainerModelId: string;
    retiredLeafModelId: string;
    bodyFieldId: string;
    retiredChildFieldId: string;
    identicalInvalidId: string;
  }>;

type StructuralExpected = Readonly<{
  sourceInvalidId: string;
  propagatedConsumerId: string;
  destinationInvalidId: string;
  identicalBody: unknown;
  bodyValidators: unknown;
  childValidators: unknown;
}>;

export function buildStructuralInvalidApiKeys(runId: string): Readonly<{
  owner: string;
  allowedContainer: string;
  allowedLeaf: string;
  retiredContainer: string;
  retiredLeaf: string;
}> {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 10);
  return {
    owner: `cde2e_sio_r${suffix}`,
    allowedContainer: `cde2e_siac_r${suffix}`,
    allowedLeaf: `cde2e_sial_r${suffix}`,
    retiredContainer: `cde2e_sirc_r${suffix}`,
    retiredLeaf: `cde2e_sirl_r${suffix}`,
  };
}

export function buildStructuralInvalidValidators(
  input: Readonly<{
    ownerModelId: string;
    allowedContainerModelId: string;
    allowedLeafModelId: string;
  }>,
) {
  return {
    body: {
      structured_text_blocks: {
        item_types: [input.allowedContainerModelId],
      },
      structured_text_inline_blocks: {
        item_types: [input.allowedContainerModelId],
      },
      structured_text_links: { item_types: [input.ownerModelId] },
    },
    child: {
      single_block_blocks: { item_types: [input.allowedLeafModelId] },
    },
    related: {
      item_item_type: { item_types: [input.ownerModelId] },
    },
  };
}

export const structuralInvalidScenario: RealCmaScenario<
  StructuralSeed,
  StructuralExpected
> = {
  name: 'inspection-only retired block models and structural-invalid aggregates',
  contentDiffArgs: ['--migrate-invalid-content', '--include-deletions'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating structural-invalid schema');
    const apiKeys = buildStructuralInvalidApiKeys(runId);
    for (const apiKey of Object.values(apiKeys)) {
      assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      assert.ok(apiKey.length <= 30);
    }

    const owner = await client.itemTypes.create({
      name: `Structural owner ${runId}`,
      api_key: apiKeys.owner,
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
    const allowedContainer = await createBlockModel(
      client,
      `Allowed container ${runId}`,
      apiKeys.allowedContainer,
    );
    const allowedLeaf = await createBlockModel(
      client,
      `Allowed leaf ${runId}`,
      apiKeys.allowedLeaf,
    );
    const retiredContainer = await createBlockModel(
      client,
      `Retired container ${runId}`,
      apiKeys.retiredContainer,
    );
    const retiredLeaf = await createBlockModel(
      client,
      `Retired leaf ${runId}`,
      apiKeys.retiredLeaf,
    );
    const validators = buildStructuralInvalidValidators({
      ownerModelId: owner.id,
      allowedContainerModelId: allowedContainer.id,
      allowedLeafModelId: allowedLeaf.id,
    });

    await client.fields.create(owner.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: {},
    });
    await client.fields.create(owner.id, {
      label: 'Related',
      api_key: 'related',
      field_type: 'link',
      localized: false,
      validators: validators.related,
    });
    const bodyField = await client.fields.create(owner.id, {
      label: 'Body',
      api_key: 'body',
      field_type: 'structured_text',
      localized: false,
      validators: {
        ...validators.body,
        structured_text_blocks: {
          item_types: [allowedContainer.id, retiredContainer.id],
        },
        structured_text_inline_blocks: {
          item_types: [allowedContainer.id, retiredContainer.id],
        },
      },
    });
    const retiredChildField = await client.fields.create(retiredContainer.id, {
      label: 'Child',
      api_key: 'child',
      field_type: 'single_block',
      localized: false,
      // The recursive payload must first be persisted in an API-valid state.
      // Both forked environments narrow this validator only after every
      // fixture record exists, reproducing a historical structural-invalid
      // record without asking CMA create to accept an impossible structure.
      validators: {
        single_block_blocks: {
          item_types: [allowedLeaf.id, retiredLeaf.id],
        },
      },
    });
    await client.fields.create(retiredLeaf.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: {},
    });

    const identicalInvalid = await createInvalidOwnerRecord(client, {
      ownerModelId: owner.id,
      retiredContainerModelId: retiredContainer.id,
      retiredLeafModelId: retiredLeaf.id,
      title: 'identical invalid baseline',
    });
    assert.equal(identicalInvalid.meta.is_current_version_valid, true);

    return {
      itemTypeApiKeys: [apiKeys.owner],
      ownerModelId: owner.id,
      allowedContainerModelId: allowedContainer.id,
      allowedLeafModelId: allowedLeaf.id,
      retiredContainerModelId: retiredContainer.id,
      retiredLeafModelId: retiredLeaf.id,
      bodyFieldId: bodyField.id,
      retiredChildFieldId: retiredChildField.id,
      identicalInvalidId: identicalInvalid.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating invalid source and destination aggregates',
    );
    const sourceInvalid = await createInvalidOwnerRecord(sourceClient, {
      ownerModelId: seed.ownerModelId,
      retiredContainerModelId: seed.retiredContainerModelId,
      retiredLeafModelId: seed.retiredLeafModelId,
      title: 'source-only structural invalid',
    });
    const consumer = await sourceClient.items.create<OwnerDefinition>({
      item_type: { id: seed.ownerModelId, type: 'item_type' },
      title: 'consumer of skipped source record',
      related: sourceInvalid.id,
      body: emptyDast() as never,
    });
    const destinationInvalid = await createInvalidOwnerRecord(
      destinationClient,
      {
        ownerModelId: seed.ownerModelId,
        retiredContainerModelId: seed.retiredContainerModelId,
        retiredLeafModelId: seed.retiredLeafModelId,
        title: 'destination-only structural invalid',
      },
    );

    const narrowedChildValidators = buildStructuralInvalidValidators({
      ownerModelId: seed.ownerModelId,
      allowedContainerModelId: seed.allowedContainerModelId,
      allowedLeafModelId: seed.allowedLeafModelId,
    }).child;
    const [sourceBodyField, destinationBodyField, sourceChildField] =
      await Promise.all([
        sourceClient.fields.update(seed.bodyFieldId, {
          validators: buildStructuralInvalidValidators({
            ownerModelId: seed.ownerModelId,
            allowedContainerModelId: seed.allowedContainerModelId,
            allowedLeafModelId: seed.allowedLeafModelId,
          }).body,
        }),
        destinationClient.fields.update(seed.bodyFieldId, {
          validators: buildStructuralInvalidValidators({
            ownerModelId: seed.ownerModelId,
            allowedContainerModelId: seed.allowedContainerModelId,
            allowedLeafModelId: seed.allowedLeafModelId,
          }).body,
        }),
        sourceClient.fields.update(seed.retiredChildFieldId, {
          validators: narrowedChildValidators,
        }),
        destinationClient.fields.update(seed.retiredChildFieldId, {
          validators: narrowedChildValidators,
        }),
      ]);

    const destinationChildField = await destinationClient.fields.find(
      seed.retiredChildFieldId,
    );
    assert.deepEqual(
      destinationBodyField.validators,
      sourceBodyField.validators,
    );
    assert.deepEqual(
      destinationChildField.validators,
      sourceChildField.validators,
    );

    return {
      sourceInvalidId: sourceInvalid.id,
      propagatedConsumerId: consumer.id,
      destinationInvalidId: destinationInvalid.id,
      identicalBody: canonicalBody(
        await destinationClient.items.find(seed.identicalInvalidId, {
          nested: true,
        }),
      ),
      bodyValidators: sourceBodyField.validators,
      childValidators: sourceChildField.validators,
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const envelope = JSON.parse(await readFile(planFilePath, 'utf8')) as {
      plan: Record<string, any>;
    };
    const plan = envelope.plan;
    const managedIds = requiredArray(plan.schema?.itemTypes).map(
      (entry) => requiredObject(entry).id,
    );
    assert.ok(managedIds.includes(seed.ownerModelId));
    assert.ok(managedIds.includes(seed.allowedContainerModelId));
    assert.equal(managedIds.includes(seed.allowedLeafModelId), false);
    assert.equal(managedIds.includes(seed.retiredContainerModelId), false);
    assert.equal(managedIds.includes(seed.retiredLeafModelId), false);

    const inspectionIds = requiredArray(plan.targetInspection?.itemTypes)
      .map((entry) => String(requiredObject(entry).id))
      .sort();
    assert.deepEqual(
      inspectionIds,
      [seed.retiredContainerModelId, seed.retiredLeafModelId].sort(),
    );
    assert.equal(typeof plan.targetInspection?.digest, 'string');

    const records = new Map(
      requiredArray(plan.records).map((entry) => {
        const record = requiredObject(entry);
        return [String(record.id), record] as const;
      }),
    );
    assert.equal(records.get(seed.identicalInvalidId)?.action, 'noop');
    assert.equal(records.get(expected.destinationInvalidId)?.action, 'delete');
    assert.equal(records.has(expected.sourceInvalidId), false);
    assert.equal(records.has(expected.propagatedConsumerId), false);

    const invalidContent = requiredObject(plan.invalidContent);
    const skipped = new Map(
      requiredArray(invalidContent.skippedRecords).map((entry) => {
        const record = requiredObject(entry);
        return [String(record.id), record] as const;
      }),
    );
    const sourceReasons = requiredArray(
      skipped.get(expected.sourceInvalidId)?.reasons,
    ).map(requiredObject);
    assert.ok(sourceReasons.length >= 4);
    assert.ok(
      sourceReasons.every(({ code }) => code === 'STRUCTURAL_VALIDATION'),
    );
    const validatorKeys = new Set(
      sourceReasons.map(({ validatorKey }) => String(validatorKey)),
    );
    assert.deepEqual([...validatorKeys].sort(), [
      'single_block_blocks',
      'structured_text_blocks',
      'structured_text_inline_blocks',
    ]);
    const consumerReasons = requiredArray(
      skipped.get(expected.propagatedConsumerId)?.reasons,
    ).map(requiredObject);
    assert.ok(
      consumerReasons.some(
        ({ code, dependencyId }) =>
          code === 'DEPENDENCY_ON_SKIPPED_RECORD' &&
          dependencyId === expected.sourceInvalidId,
      ),
    );
    assert.deepEqual(invalidContent.validatorRelaxations, []);
    assert.equal(plan.requiredPermissions?.editSchema, false);
    assert.equal(plan.options?.migrateInvalidContent, true);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    const [
      appliedIdentical,
      appliedSourceInvalid,
      appliedConsumer,
      appliedDeleted,
    ] = await Promise.all([
      appliedClient.items.find(seed.identicalInvalidId, { nested: true }),
      findMaybe(appliedClient, expected.sourceInvalidId),
      findMaybe(appliedClient, expected.propagatedConsumerId),
      findMaybe(appliedClient, expected.destinationInvalidId),
    ]);
    assert.deepEqual(canonicalBody(appliedIdentical), expected.identicalBody);
    assert.equal(appliedSourceInvalid, null);
    assert.equal(appliedConsumer, null);
    assert.equal(appliedDeleted, null);

    assert.ok(await findMaybe(sourceClient, expected.sourceInvalidId));
    assert.ok(await findMaybe(sourceClient, expected.propagatedConsumerId));
    assert.ok(
      await findMaybe(destinationClient, expected.destinationInvalidId),
    );

    for (const client of [sourceClient, destinationClient, appliedClient]) {
      const field = await client.fields.find(seed.bodyFieldId);
      assert.deepEqual(field.validators, expected.bodyValidators);
      const childField = await client.fields.find(seed.retiredChildFieldId);
      assert.deepEqual(childField.validators, expected.childValidators);
    }
  },
};

async function createBlockModel(
  client: CmaClient.Client,
  name: string,
  apiKey: string,
) {
  return client.itemTypes.create({
    name,
    api_key: apiKey,
    modular_block: true,
  });
}

async function createInvalidOwnerRecord(
  client: CmaClient.Client,
  input: Readonly<{
    ownerModelId: string;
    retiredContainerModelId: string;
    retiredLeafModelId: string;
    title: string;
  }>,
) {
  return client.items.create<OwnerDefinition>({
    item_type: { id: input.ownerModelId, type: 'item_type' },
    title: input.title,
    related: null,
    body: invalidDast(
      input.retiredContainerModelId,
      input.retiredLeafModelId,
    ) as never,
  });
}

function invalidDast(
  retiredContainerModelId: string,
  retiredLeafModelId: string,
): Record<string, unknown> {
  const container = (label: string) =>
    CmaClient.buildBlockRecord({
      item_type: { id: retiredContainerModelId, type: 'item_type' },
      child: CmaClient.buildBlockRecord({
        item_type: { id: retiredLeafModelId, type: 'item_type' },
        label: `${label} leaf`,
      }),
    });
  return {
    schema: 'dast',
    document: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'before ' },
            { type: 'inlineBlock', item: container('inline') },
          ],
        },
        { type: 'block', item: container('block') },
      ],
    },
  };
}

function emptyDast(): Record<string, unknown> {
  return {
    schema: 'dast',
    document: { type: 'root', children: [] },
  };
}

function canonicalBody(record: unknown): unknown {
  return JSON.parse(
    JSON.stringify(requiredObject(record).body, (_key, value) =>
      value === undefined ? null : value,
    ),
  );
}

async function findMaybe(
  client: CmaClient.Client,
  id: string,
): Promise<unknown | null> {
  try {
    return await client.items.find(id, { nested: true });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'status' in error.response &&
      error.response.status === 404
    ) {
      return null;
    }
    throw error;
  }
}

function requiredObject(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, any>;
}

function requiredArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
