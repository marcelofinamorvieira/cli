import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { waitForUploadAntivirusClean } from './assets-deletions-scenario';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

type RawRecord = Readonly<{
  id: string;
  itemTypeId: string;
  fields: Readonly<Record<string, CanonicalValue>>;
  lifecycle: Readonly<{
    status: string;
    currentValid: boolean | null;
    publishedValid: boolean | null;
  }>;
}>;

type RawRecordState = Readonly<{
  current: Readonly<Record<string, RawRecord>>;
  published: Readonly<Record<string, RawRecord>>;
}>;

type RawUpload = Readonly<{
  id: string;
  filename: string;
  md5: string;
  size: number;
  tags: readonly string[];
}>;

type Seed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    titleFieldId: string;
    protectedUploadId: string;
    recordIds: Readonly<{
      unsafeA: string;
      currentConsumerC: string;
      migratableD: string;
    }>;
  }>;

type Expected = Readonly<{
  recordIds: Readonly<{
    unsafeA: string;
    publishedConsumerB: string;
    currentConsumerC: string;
    migratableD: string;
  }>;
  migratableUploadId: string;
  source: RawRecordState;
  destination: RawRecordState;
  protectedUpload: RawUpload;
  migratableUpload: RawUpload;
}>;

type RecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    body: { type: 'structured_text'; localized: false };
    asset: { type: 'file'; localized: false };
  };
};

type SkipIds = Expected['recordIds'];

export const MIXED_STATE_STRICT_TITLE_VALIDATORS = { required: {} };

export function mixedStateSkipClosureApiKey(runId: string): string {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const apiKey = `cde2e_mc_r${suffix}`;
  assert.match(apiKey, /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
  assert.ok(apiKey.length <= 30);
  return apiKey;
}

export function buildPublishedItemLinkBody(recordId: string) {
  return dast([
    {
      type: 'paragraph',
      children: [
        { type: 'span', value: 'published dependency: ' },
        {
          type: 'itemLink',
          item: recordId,
          children: [{ type: 'span', value: 'unsafe A' }],
        },
      ],
    },
  ]);
}

export function buildCurrentInlineItemBody(recordId: string) {
  return dast([
    {
      type: 'paragraph',
      children: [
        { type: 'span', value: 'current dependency: ' },
        { type: 'inlineItem', item: recordId },
      ],
    },
  ]);
}

export function buildExpectedSkipContract(ids: SkipIds) {
  return {
    [ids.unsafeA]: {
      disposition: 'preserve_target',
      reasons: [
        {
          code: 'INVALID_CURRENT',
          slice: 'current',
          message: `Record ${ids.unsafeA} has an invalid desired current version that must be written by this migration.`,
          dependencyChain: [ids.unsafeA],
        },
        {
          code: 'INVALID_PUBLISHED',
          slice: 'published',
          message: `Record ${ids.unsafeA} has an invalid desired published version that must be written by this migration.`,
          dependencyChain: [ids.unsafeA],
        },
      ],
    },
    [ids.publishedConsumerB]: {
      disposition: 'must_remain_absent',
      reasons: [
        {
          code: 'DEPENDENCY_ON_SKIPPED_RECORD',
          slice: 'published',
          message: `Record ${ids.publishedConsumerB} cannot reach its desired state because dependency ${ids.unsafeA} was skipped and the destination does not provide the required version.`,
          dependencyId: ids.unsafeA,
          dependencyChain: [ids.publishedConsumerB, ids.unsafeA],
        },
      ],
    },
    [ids.currentConsumerC]: {
      disposition: 'preserve_target',
      reasons: [
        {
          code: 'DEPENDENCY_ON_SKIPPED_RECORD',
          slice: 'current',
          message: `Record ${ids.currentConsumerC} cannot reach its desired state because dependency ${ids.publishedConsumerB} was skipped and the destination does not provide the required version.`,
          dependencyId: ids.publishedConsumerB,
          dependencyChain: [
            ids.currentConsumerC,
            ids.publishedConsumerB,
            ids.unsafeA,
          ],
        },
      ],
    },
  };
}

export const mixedStateSkipClosureScenario: RealCmaScenario<Seed, Expected> = {
  name: 'multi-hop mixed-state skip closure with protected upload',
  contentDiffArgs: ['--uploads=all', '--include-deletions', '--bundle-assets'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating mixed-state closure baseline');
    const apiKey = mixedStateSkipClosureApiKey(runId);
    const model = await client.itemTypes.create({
      name: `Mixed-state closure ${runId}`,
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
    const titleField = await client.fields.create(model.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: MIXED_STATE_STRICT_TITLE_VALIDATORS,
    });
    await client.fields.create(model.id, {
      label: 'Body',
      api_key: 'body',
      field_type: 'structured_text',
      localized: false,
      validators: {
        structured_text_blocks: { item_types: [] },
        structured_text_links: relationshipValidator(model.id),
      },
    });
    await client.fields.create(model.id, {
      label: 'Asset',
      api_key: 'asset',
      field_type: 'file',
      localized: false,
      validators: {},
    });

    const protectedUploadId = await createTextUpload(client, {
      filename: 'protected-skipped-a.txt',
      contents: 'Destination upload protected by skipped record A.\n',
      note: 'Must remain because destination A is preserved',
      tag: 'protected',
    });
    const unsafeA = await client.items.create<RecordDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      title: 'A valid destination draft',
      body: null,
      asset: { upload_id: protectedUploadId },
    });
    const currentConsumerC = await client.items.create<RecordDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      title: 'C destination draft baseline',
      body: null,
      asset: null,
    });
    const migratableD = await client.items.create<RecordDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      title: 'D destination published baseline',
      body: paragraphBody('D destination body'),
      asset: null,
    } as never);
    await client.items.publish<RecordDefinition>(migratableD.id);

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      titleFieldId: titleField.id,
      protectedUploadId,
      recordIds: {
        unsafeA: unsafeA.id,
        currentConsumerC: currentConsumerC.id,
        migratableD: migratableD.id,
      },
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Building published and current skip dependencies',
    );
    await sourceClient.fields.update(seed.titleFieldId, { validators: {} });
    await sourceClient.items.update<RecordDefinition>(seed.recordIds.unsafeA, {
      title: '',
      body: null,
      asset: null,
    });
    await sourceClient.items.publish<RecordDefinition>(seed.recordIds.unsafeA);

    const publishedConsumerB =
      await sourceClient.items.create<RecordDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        title: 'B published consumer of A',
        body: buildPublishedItemLinkBody(seed.recordIds.unsafeA),
        asset: null,
      } as never);
    await sourceClient.items.publish<RecordDefinition>(publishedConsumerB.id);
    await sourceClient.items.update<RecordDefinition>(publishedConsumerB.id, {
      title: 'B current version has no dependency',
      body: null,
      asset: null,
    });

    await sourceClient.items.update<RecordDefinition>(
      seed.recordIds.currentConsumerC,
      {
        title: 'C current-only consumer of B',
        body: buildCurrentInlineItemBody(publishedConsumerB.id),
        asset: null,
      } as never,
    );

    const migratableUploadId = await createTextUpload(sourceClient, {
      filename: 'unrelated-migratable-d.txt',
      contents: 'Unrelated record D and this upload must migrate.\n',
      note: 'Independent migration sentinel',
      tag: 'migratable',
    });
    await sourceClient.items.update<RecordDefinition>(
      seed.recordIds.migratableD,
      {
        title: 'D source published convergence',
        body: paragraphBody('D unrelated source body'),
        asset: { upload_id: migratableUploadId },
      } as never,
    );
    await sourceClient.items.publish<RecordDefinition>(
      seed.recordIds.migratableD,
    );

    await sourceClient.fields.update(seed.titleFieldId, {
      validators: MIXED_STATE_STRICT_TITLE_VALIDATORS,
    });
    await sourceClient.uploads.destroy(seed.protectedUploadId);

    const recordIds = {
      unsafeA: seed.recordIds.unsafeA,
      publishedConsumerB: publishedConsumerB.id,
      currentConsumerC: seed.recordIds.currentConsumerC,
      migratableD: seed.recordIds.migratableD,
    };
    await waitForValidity(sourceClient, [
      { id: recordIds.unsafeA, current: false, published: false },
      { id: recordIds.publishedConsumerB, current: true, published: true },
      { id: recordIds.currentConsumerC, current: true, published: null },
      { id: recordIds.migratableD, current: true, published: true },
    ]);

    const selectedIds = Object.values(recordIds);
    const [source, destination, protectedUpload, migratableUpload] =
      await Promise.all([
        captureRawRecordState(sourceClient, seed.modelId, selectedIds),
        captureRawRecordState(destinationClient, seed.modelId, selectedIds),
        captureRawUpload(destinationClient, seed.protectedUploadId),
        captureRawUpload(sourceClient, migratableUploadId),
      ]);

    assertFixtureGraph({
      source,
      destination,
      recordIds,
      protectedUploadId: seed.protectedUploadId,
      migratableUploadId,
    });
    assert.equal(
      await findRawUpload(sourceClient, seed.protectedUploadId),
      null,
      'source still contains the upload that only preserved A needs',
    );
    assert.equal(
      await findRawUpload(destinationClient, migratableUploadId),
      null,
      "destination already contains D's source-only upload",
    );

    return {
      recordIds,
      migratableUploadId,
      source,
      destination,
      protectedUpload,
      migratableUpload,
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    const plan = await readPlan(planFilePath);
    const invalidContent = object(plan.invalidContent, 'plan.invalidContent');
    assert.equal(invalidContent.propagatedSkipCount, 2);
    assert.deepEqual(
      array(invalidContent.detectedRecordIds, 'detectedRecordIds')
        .map(String)
        .sort(compareIds),
      [
        expected.recordIds.unsafeA,
        expected.recordIds.publishedConsumerB,
        expected.recordIds.currentConsumerC,
      ].sort(compareIds),
    );
    assert.deepEqual(invalidContent.migratedRecordIds, []);
    assert.deepEqual(invalidContent.validatorRelaxations, []);

    const skipped = array(invalidContent.skippedRecords, 'skippedRecords').map(
      (entry, index) => object(entry, `skippedRecords[${index}]`),
    );
    const skippedById = new Map(
      skipped.map((entry) => [string(entry.id, 'skipped record ID'), entry]),
    );
    assert.deepEqual(
      [...skippedById.keys()].sort(compareIds),
      [
        expected.recordIds.unsafeA,
        expected.recordIds.publishedConsumerB,
        expected.recordIds.currentConsumerC,
      ].sort(compareIds),
    );
    const skipContract = buildExpectedSkipContract(expected.recordIds);
    for (const [recordId, contract] of Object.entries(skipContract)) {
      const actual = skippedById.get(recordId);
      assert.ok(actual, `missing skipped aggregate ${recordId}`);
      assert.equal(actual.disposition, contract.disposition);
      assert.deepEqual(actual.reasons, contract.reasons);
      assert.match(
        string(actual.sourceHash, `${recordId}.sourceHash`),
        /^[0-9a-f]{64}$/,
      );
      if (contract.disposition === 'must_remain_absent') {
        assert.equal(actual.expectedTargetHash, null);
      } else {
        assert.match(
          string(actual.expectedTargetHash, `${recordId}.expectedTargetHash`),
          /^[0-9a-f]{64}$/,
        );
      }
    }

    const records = array(plan.records, 'plan.records').map((entry, index) =>
      object(entry, `plan.records[${index}]`),
    );
    assert.deepEqual(
      records.map(({ id }) => String(id)),
      [expected.recordIds.migratableD],
    );
    assert.equal(records[0].action, 'update');
    assert.deepEqual(records[0].dependencies, []);

    const uploads = array(plan.uploads, 'plan.uploads').map((entry, index) =>
      object(entry, `plan.uploads[${index}]`),
    );
    const uploadActions = new Map(
      uploads.map((entry) => [
        string(entry.id, 'upload plan ID'),
        entry.action,
      ]),
    );
    assert.deepEqual(
      [...uploadActions].sort(([left], [right]) => compareIds(left, right)),
      [
        [seed.protectedUploadId, 'noop'],
        [expected.migratableUploadId, 'create'],
      ].sort(([left], [right]) => compareIds(String(left), String(right))),
    );

    const execution = object(plan.execution, 'plan.execution');
    assert.deepEqual(execution.uniqueReleases, []);
    assert.deepEqual(execution.deleteReleases, []);
    assert.deepEqual(execution.createOrder, []);
    assert.deepEqual(execution.publicationSeedOrder, []);
    assert.deepEqual(execution.updateOrder, [expected.recordIds.migratableD]);
    assert.deepEqual(execution.publishOrder, [expected.recordIds.migratableD]);
    assert.deepEqual(execution.deleteOrder, []);
    assert.deepEqual(execution.shellRecordIds, []);
    assert.deepEqual(execution.shellComponents, []);
    assert.deepEqual(execution.revalidateBeforePublishIds, []);
    assert.deepEqual(execution.uploadOrder, [expected.migratableUploadId]);
    assertNoExecutionReferenceToSkippedRecord(
      execution,
      new Set(Object.keys(skipContract)),
    );

    assert.equal(object(plan.options, 'plan.options').includeDeletions, true);
    assert.equal(object(plan.options, 'plan.options').uploads, 'all');
    assert.equal(
      object(plan.requiredPermissions, 'plan.requiredPermissions').editSchema,
      false,
    );
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying preserved closure and independent convergence',
    );
    const selectedIds = Object.values(expected.recordIds);
    const [source, destination, applied] = await Promise.all([
      captureRawRecordState(sourceClient, seed.modelId, selectedIds),
      captureRawRecordState(destinationClient, seed.modelId, selectedIds),
      captureRawRecordState(appliedClient, seed.modelId, selectedIds),
    ]);
    assert.deepEqual(
      source,
      expected.source,
      'source raw record state changed',
    );
    assert.deepEqual(
      destination,
      expected.destination,
      'destination raw record state changed',
    );

    assertPreservedRecord(
      applied,
      expected.destination,
      expected.recordIds.unsafeA,
    );
    assertRecordAbsentEverywhere(
      applied,
      expected.recordIds.publishedConsumerB,
    );
    assertPreservedRecord(
      applied,
      expected.destination,
      expected.recordIds.currentConsumerC,
    );
    assertConvergedRecord(
      applied,
      expected.source,
      expected.recordIds.migratableD,
    );
    assert.deepEqual(
      Object.keys(applied.current).sort(compareIds),
      [
        expected.recordIds.unsafeA,
        expected.recordIds.currentConsumerC,
        expected.recordIds.migratableD,
      ].sort(compareIds),
    );
    assert.deepEqual(Object.keys(applied.published).sort(compareIds), [
      expected.recordIds.migratableD,
    ]);

    const [
      protectedUpload,
      migratableUpload,
      protectedCurrentRefs,
      protectedPublishedRefs,
    ] = await Promise.all([
      captureRawUpload(appliedClient, seed.protectedUploadId),
      captureRawUpload(appliedClient, expected.migratableUploadId),
      appliedClient.uploads.references(seed.protectedUploadId, {
        version: 'current',
        nested: false,
      }),
      appliedClient.uploads.references(seed.protectedUploadId, {
        version: 'published',
        nested: false,
      }),
    ]);
    assert.deepEqual(
      protectedUpload,
      expected.protectedUpload,
      'upload required by preserved A was mutated or deleted',
    );
    assert.deepEqual(
      migratableUpload,
      expected.migratableUpload,
      'unrelated D upload did not converge byte-for-byte',
    );
    assert.deepEqual(
      protectedCurrentRefs.map(({ id }) => id).sort(compareIds),
      [expected.recordIds.unsafeA],
    );
    assert.deepEqual(protectedPublishedRefs, []);
    assert.equal(
      await findRawUpload(sourceClient, seed.protectedUploadId),
      null,
    );
    assert.equal(
      await findRawUpload(destinationClient, expected.migratableUploadId),
      null,
    );

    const [sourceTitle, destinationTitle, appliedTitle] = await Promise.all([
      sourceClient.fields.find(seed.titleFieldId),
      destinationClient.fields.find(seed.titleFieldId),
      appliedClient.fields.find(seed.titleFieldId),
    ]);
    assert.deepEqual(
      sourceTitle.validators,
      MIXED_STATE_STRICT_TITLE_VALIDATORS,
    );
    assert.deepEqual(destinationTitle.validators, sourceTitle.validators);
    assert.deepEqual(appliedTitle.validators, sourceTitle.validators);
  },
};

function relationshipValidator(modelId: string) {
  return {
    item_types: [modelId],
    on_publish_with_unpublished_references_strategy: 'fail' as const,
    on_reference_unpublish_strategy: 'fail' as const,
    on_reference_delete_strategy: 'fail' as const,
  };
}

function dast(children: readonly Record<string, unknown>[]) {
  return {
    schema: 'dast',
    document: { type: 'root', children },
  };
}

function paragraphBody(value: string) {
  return dast([
    {
      type: 'paragraph',
      children: [{ type: 'span', value }],
    },
  ]);
}

async function createTextUpload(
  client: CmaClient.Client,
  input: Readonly<{
    filename: string;
    contents: string;
    note: string;
    tag: string;
  }>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-mixed-state-'));
  const localPath = join(directory, input.filename);
  try {
    await writeFile(localPath, input.contents, 'utf8');
    const upload = await client.uploads.createFromLocalFile({
      localPath,
      filename: input.filename,
      skipCreationIfAlreadyExists: false,
      tags: ['content-diff-e2e', input.tag],
      notes: input.note,
    });
    await waitForUploadAntivirusClean(
      { rawFindUpload: (uploadId) => client.uploads.rawFind(uploadId) },
      upload.id,
    );
    return upload.id;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForValidity(
  client: CmaClient.Client,
  expectations: readonly Readonly<{
    id: string;
    current: boolean;
    published: boolean | null;
  }>[],
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const records = await Promise.all(
      expectations.map(({ id }) => client.items.find(id)),
    );
    if (
      records.every(({ meta }, index) => {
        const expected = expectations[index];
        return (
          meta.is_current_version_valid === expected.current &&
          meta.is_published_version_valid === expected.published
        );
      })
    ) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 500);
    });
  }

  const actual = await Promise.all(
    expectations.map(async (expected) => {
      const record = await client.items.find(expected.id);
      return {
        expected,
        actual: {
          current: record.meta.is_current_version_valid,
          published: record.meta.is_published_version_valid,
        },
      };
    }),
  );
  throw new Error(
    `record validity did not converge: ${JSON.stringify(actual)}`,
  );
}

async function captureRawRecordState(
  client: CmaClient.Client,
  modelId: string,
  selectedRecordIds: readonly string[],
): Promise<RawRecordState> {
  const selectedIds = new Set(selectedRecordIds);
  const captureSlice = async (version: 'current' | 'published') => {
    const response = await client.items.rawList({
      filter: { type: modelId },
      nested: true,
      order_by: 'id_ASC',
      version,
      page: { offset: 0, limit: 30 },
    });
    assert.ok(
      response.meta.total_count <= 30,
      'mixed-state fixture unexpectedly exceeded one nested page',
    );
    const records = response.data
      .filter(({ id }) => selectedIds.has(id))
      .map((resource) => parseRawRecord(resource, modelId))
      .sort((left, right) => compareIds(left.id, right.id));
    return Object.fromEntries(records.map((record) => [record.id, record]));
  };

  const [current, published] = await Promise.all([
    captureSlice('current'),
    captureSlice('published'),
  ]);
  return { current, published };
}

function parseRawRecord(value: unknown, expectedModelId: string): RawRecord {
  const resource = object(value, 'raw record');
  const id = string(resource.id, 'raw record ID');
  assert.equal(relationshipId(resource, 'item_type'), expectedModelId);
  const attributes = object(resource.attributes, `${id}.attributes`);
  const meta = object(resource.meta, `${id}.meta`);
  return {
    id,
    itemTypeId: expectedModelId,
    fields: Object.fromEntries(
      Object.keys(attributes)
        .sort()
        .map((key) => [key, canonicalize(attributes[key])]),
    ),
    lifecycle: {
      status: string(meta.status, `${id}.meta.status`),
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

async function captureRawUpload(
  client: CmaClient.Client,
  uploadId: string,
): Promise<RawUpload> {
  const response = await client.uploads.rawFind(uploadId);
  return parseRawUpload(response, uploadId);
}

async function findRawUpload(
  client: CmaClient.Client,
  uploadId: string,
): Promise<RawUpload | null> {
  try {
    return await captureRawUpload(client, uploadId);
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return null;
    }
    throw error;
  }
}

function parseRawUpload(value: unknown, uploadId: string): RawUpload {
  const response = object(value, `upload ${uploadId} response`);
  const resource = object(response.data, `upload ${uploadId}`);
  assert.equal(resource.type, 'upload');
  assert.equal(resource.id, uploadId);
  const attributes = object(resource.attributes, `${uploadId}.attributes`);
  return {
    id: uploadId,
    filename: string(attributes.filename, `${uploadId}.filename`),
    md5: string(attributes.md5, `${uploadId}.md5`),
    size: integer(attributes.size, `${uploadId}.size`),
    tags: stringArray(attributes.tags, `${uploadId}.tags`).sort(),
  };
}

async function readPlan(
  planFilePath: string,
): Promise<Record<string, unknown>> {
  const envelope = object(
    JSON.parse(await readFile(planFilePath, 'utf8')),
    'plan envelope',
  );
  return object(envelope.plan, 'content plan');
}

function assertFixtureGraph(
  input: Readonly<{
    source: RawRecordState;
    destination: RawRecordState;
    recordIds: SkipIds;
    protectedUploadId: string;
    migratableUploadId: string;
  }>,
): void {
  const { source, destination, recordIds } = input;
  assert.deepEqual(source.current[recordIds.unsafeA]?.lifecycle, {
    status: 'published',
    currentValid: false,
    publishedValid: false,
  });
  assert.deepEqual(source.published[recordIds.unsafeA]?.lifecycle, {
    status: 'published',
    currentValid: false,
    publishedValid: false,
  });
  assert.deepEqual(
    source.published[recordIds.publishedConsumerB]?.fields.body,
    canonicalize(buildPublishedItemLinkBody(recordIds.unsafeA)),
  );
  assert.equal(source.current[recordIds.publishedConsumerB]?.fields.body, null);
  assert.equal(
    source.current[recordIds.publishedConsumerB]?.lifecycle.status,
    'updated',
  );
  assert.deepEqual(
    source.current[recordIds.currentConsumerC]?.fields.body,
    canonicalize(buildCurrentInlineItemBody(recordIds.publishedConsumerB)),
  );
  assert.equal(source.published[recordIds.currentConsumerC], undefined);
  assert.equal(destination.published[recordIds.unsafeA], undefined);
  assert.equal(destination.current[recordIds.publishedConsumerB], undefined);
  assert.equal(destination.published[recordIds.publishedConsumerB], undefined);
  assert.equal(
    uploadIdFromField(
      destination.current[recordIds.unsafeA]?.fields.asset ?? null,
    ),
    input.protectedUploadId,
  );
  assert.equal(
    uploadIdFromField(
      source.current[recordIds.migratableD]?.fields.asset ?? null,
    ),
    input.migratableUploadId,
  );
  assert.deepEqual(source.current[recordIds.migratableD]?.lifecycle, {
    status: 'published',
    currentValid: true,
    publishedValid: true,
  });
}

function assertPreservedRecord(
  actual: RawRecordState,
  destination: RawRecordState,
  recordId: string,
): void {
  assert.deepEqual(
    actual.current[recordId],
    destination.current[recordId],
    `current destination bytes were not preserved for ${recordId}`,
  );
  assert.deepEqual(
    actual.published[recordId],
    destination.published[recordId],
    `published destination bytes were not preserved for ${recordId}`,
  );
}

function assertConvergedRecord(
  actual: RawRecordState,
  source: RawRecordState,
  recordId: string,
): void {
  assert.deepEqual(
    actual.current[recordId],
    source.current[recordId],
    `current source bytes did not converge for ${recordId}`,
  );
  assert.deepEqual(
    actual.published[recordId],
    source.published[recordId],
    `published source bytes did not converge for ${recordId}`,
  );
}

function assertRecordAbsentEverywhere(
  state: RawRecordState,
  recordId: string,
): void {
  assert.equal(state.current[recordId], undefined);
  assert.equal(state.published[recordId], undefined);
}

function assertNoExecutionReferenceToSkippedRecord(
  execution: Readonly<Record<string, unknown>>,
  skippedIds: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(execution)) {
    if (key === 'uniqueReleases' || key === 'deleteReleases') continue;
    for (const recordId of collectStrings(value)) {
      assert.equal(
        skippedIds.has(recordId),
        false,
        `execution.${key} references skipped record ${recordId}`,
      );
    }
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!isObject(value)) return [];
  return Object.values(value).flatMap(collectStrings);
}

function uploadIdFromField(value: CanonicalValue): string | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  return typeof value.upload_id === 'string' ? value.upload_id : null;
}

function canonicalize(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const candidate = object(value, 'canonical value');
  if (
    candidate.type === 'item' &&
    typeof candidate.id === 'string' &&
    isObject(candidate.attributes) &&
    isObject(candidate.relationships)
  ) {
    return {
      kind: 'nestedItem',
      id: candidate.id,
      itemTypeId: relationshipId(candidate, 'item_type'),
      fields: canonicalize(candidate.attributes),
    };
  }
  return Object.fromEntries(
    Object.keys(candidate)
      .sort()
      .map((key) => [key, canonicalize(candidate[key])]),
  );
}

function relationshipId(
  resource: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const relationships = object(resource.relationships, 'relationships');
  const relationship = object(relationships[name], `relationship ${name}`);
  const data = object(relationship.data, `relationship ${name}.data`);
  return string(data.id, `relationship ${name}.data.id`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  const values = array(value, label);
  if (!values.every((entry) => typeof entry === 'string')) {
    throw new Error(`${label} must contain only strings`);
  }
  return values as string[];
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error(`${label} must be a boolean or null`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
