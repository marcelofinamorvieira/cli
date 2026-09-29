import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

type UniqueRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    code: { type: 'string'; localized: false };
  };
};

type LocalizedUniqueRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    code: { type: 'string'; localized: true };
  };
};

type InvalidUniquePeerDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    code: { type: 'string'; localized: false };
    gate: { type: 'string'; localized: false };
  };
};

type UniqueAssetRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    code: { type: 'string'; localized: false };
    asset: { type: 'file'; localized: false };
  };
};

type LinkRecordDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    label: { type: 'string'; localized: false };
    peer: { type: 'link'; localized: false };
  };
};

type BoundaryTargetDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
  };
};

type BoundaryReferrerDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    label: { type: 'string'; localized: false };
    target: { type: 'link'; localized: false };
  };
};

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

type RawUniqueRecord = Readonly<{
  id: string;
  itemTypeId: string;
  code: string;
}>;

type RawUniqueState = Readonly<{
  current: readonly RawUniqueRecord[];
  published: readonly RawUniqueRecord[];
}>;

type RawLocalizedUniqueRecord = Readonly<{
  id: string;
  itemTypeId: string;
  code: CanonicalValue;
}>;

type RawLocalizedUniqueState = Readonly<{
  current: readonly RawLocalizedUniqueRecord[];
  published: readonly RawLocalizedUniqueRecord[];
}>;

type RawLinkRecord = Readonly<{
  id: string;
  itemTypeId: string;
  label: string;
  peerId: string | null;
}>;

type RawLinkState = Readonly<{
  current: readonly RawLinkRecord[];
  published: readonly RawLinkRecord[];
}>;

type RawUniqueAssetRecord = Readonly<{
  id: string;
  itemTypeId: string;
  code: string;
  asset: CanonicalValue;
}>;

type RawUniqueAssetState = Readonly<{
  current: readonly RawUniqueAssetRecord[];
  published: readonly RawUniqueAssetRecord[];
}>;

type RawUpload = Readonly<{
  id: string;
  filename: string;
  md5: string;
  size: number;
  tags: readonly string[];
}>;

type UniqueHandoffSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    uniqueFieldId: string;
    currentOwnerId: string;
    publishedOwnerId: string;
  }>;

type UniqueHandoffExpected = Readonly<{
  currentClaimantId: string;
  publishedClaimantId: string;
  recordIds: readonly string[];
  source: RawUniqueState;
  destination: RawUniqueState;
  validators: CanonicalValue;
}>;

type UniqueSwapSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    uniqueFieldId: string;
    currentPair: readonly [string, string];
    publishedPair: readonly [string, string];
  }>;

type UniqueSwapExpected = Readonly<{
  recordIds: readonly string[];
  source: RawUniqueState;
  destination: RawUniqueState;
  validators: CanonicalValue;
}>;

type DefaultUniquePeerSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    uniqueFieldId: string;
    gateFieldId: string;
  }>;

type DefaultUniquePeerExpected = Readonly<{
  publishedPeerId: string;
  nativeDraftId: string;
  recordIds: readonly string[];
  source: RawUniqueState;
  destination: RawUniqueState;
  validators: CanonicalValue;
}>;

type PublishedStageUniqueSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    uniqueFieldId: string;
    ownerId: string;
    consumerId: string;
    locale: string;
  }>;

type PublishedStageUniqueExpected = Readonly<{
  recordIds: readonly string[];
  source: RawLocalizedUniqueState;
  destination: RawLocalizedUniqueState;
  validators: CanonicalValue;
}>;

type SkippedOwnerCreateSeedSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    uniqueFieldId: string;
    gateFieldId: string;
    ownerId: string;
  }>;

type SkippedOwnerCreateSeedExpected = Readonly<{
  claimantId: string;
  recordIds: readonly string[];
  source: RawUniqueState;
  destination: RawUniqueState;
  uniqueValidators: CanonicalValue;
  gateValidators: CanonicalValue;
  publicationScheduledAt: string;
}>;

type DeleteCycleSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    currentPair: readonly [string, string];
    publishedPair: readonly [string, string];
  }>;

type DeleteCycleExpected = Readonly<{
  recordIds: readonly string[];
  source: RawLinkState;
  destination: RawLinkState;
}>;

type BoundarySeed = RealCmaScenarioSeed &
  Readonly<{
    targetModelId: string;
    referrerModelId: string;
    targetId: string;
    referrerId: string;
  }>;

type UploadProtectionSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
  }>;

type UploadProtectionExpected = Readonly<{
  recordIds: readonly string[];
  claimantId: string;
  blockingOwnerId: string;
  uploadId: string;
  source: RawUniqueAssetState;
  destination: RawUniqueAssetState;
  upload: RawUpload;
}>;

type RawResource = Readonly<{
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
}>;

const MODEL_API_KEY_MAX_LENGTH = 30;
const MODEL_API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;
const UNIQUE_VALIDATORS = { required: {}, unique: {} };

export const CROSS_BOUNDARY_REFERRER_FAILURE_PATTERN =
  /cannot be deleted safely because published referrer [^\s]+ is outside the selected reconciliation or deletion island, or retains the reference/;

export function uniqueDeletionApiKey(lane: string, runId: string): string {
  const compactLane = lane
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 5);
  assert.ok(compactLane, 'scenario API-key lane must contain a letter');
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 10);
  const apiKey = `cde2e_${compactLane}_r${suffix}`;
  assert.match(apiKey, MODEL_API_KEY_PATTERN);
  assert.ok(
    apiKey.length <= MODEL_API_KEY_MAX_LENGTH,
    `scenario model API key exceeds ${MODEL_API_KEY_MAX_LENGTH} characters: ${apiKey}`,
  );
  return apiKey;
}

export const uniqueAcyclicHandoffScenario: RealCmaScenario<
  UniqueHandoffSeed,
  UniqueHandoffExpected
> = {
  name: 'current and published unique handoffs release before source-only creates',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating acyclic uniqueness fixture');
    const apiKey = uniqueDeletionApiKey('uhand', runId);
    const model = await createModel(client, apiKey, 'Unique handoff');
    const uniqueField = await createUniqueField(client, model.id);
    const currentOwner = await createUniqueRecord(
      client,
      model.id,
      'held-current',
    );
    const publishedOwner = await createUniqueRecord(
      client,
      model.id,
      'held-published',
    );
    await client.items.publish<UniqueRecordDefinition>(publishedOwner.id);

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      uniqueFieldId: uniqueField.id,
      currentOwnerId: currentOwner.id,
      publishedOwnerId: publishedOwner.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating current and published unique-value handoffs',
    );
    await updateUniqueRecord(
      sourceClient,
      seed.currentOwnerId,
      'released-current',
    );
    const currentClaimant = await createUniqueRecord(
      sourceClient,
      seed.modelId,
      'held-current',
    );

    await updateAndPublishUniqueRecord(
      sourceClient,
      seed.publishedOwnerId,
      'released-published',
    );
    const publishedClaimant = await createUniqueRecord(
      sourceClient,
      seed.modelId,
      'held-published',
    );
    await sourceClient.items.publish<UniqueRecordDefinition>(
      publishedClaimant.id,
    );

    const recordIds = [
      seed.currentOwnerId,
      currentClaimant.id,
      seed.publishedOwnerId,
      publishedClaimant.id,
    ].sort(compareIds);
    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureUniqueState(sourceClient, seed.modelId, recordIds),
        captureUniqueState(destinationClient, seed.modelId, recordIds),
        captureFieldValidators(sourceClient, seed.modelId, seed.uniqueFieldId),
        captureFieldValidators(
          destinationClient,
          seed.modelId,
          seed.uniqueFieldId,
        ),
      ]);
    assert.deepEqual(sourceValidators, canonicalJson(UNIQUE_VALIDATORS));
    assert.deepEqual(destinationValidators, sourceValidators);
    assert.notDeepEqual(destination, source);

    return {
      currentClaimantId: currentClaimant.id,
      publishedClaimantId: publishedClaimant.id,
      recordIds,
      source,
      destination,
      validators: sourceValidators,
    };
  },

  async verify({ seed, expected, appliedClient, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying acyclic unique releases through raw CMA',
    );
    const [actual, validators] = await Promise.all([
      captureUniqueState(appliedClient, seed.modelId, expected.recordIds),
      captureFieldValidators(appliedClient, seed.modelId, seed.uniqueFieldId),
    ]);
    assert.deepEqual(actual, expected.source);
    assert.deepEqual(validators, expected.validators);

    const plan = await readGeneratedPlan(planFilePath);
    assert.equal(
      object(plan.requiredPermissions, 'plan.requiredPermissions').editSchema,
      false,
      'acyclic releases unexpectedly requested schema-edit permission',
    );
    assert.deepEqual(
      array(
        object(plan.invalidContent, 'plan.invalidContent').validatorRelaxations,
        'plan.invalidContent.validatorRelaxations',
      ),
      [],
      'acyclic releases unexpectedly relaxed validators',
    );
    const releases = array(
      object(plan.execution, 'plan.execution').uniqueReleases,
      'plan.execution.uniqueReleases',
    ).map((value, index) =>
      object(value, `plan.execution.uniqueReleases[${index}]`),
    );
    assertReleaseConsumer(
      releases,
      seed.currentOwnerId,
      expected.currentClaimantId,
    );
    assertReleaseConsumer(
      releases,
      seed.publishedOwnerId,
      expected.publishedClaimantId,
    );
  },
};

export const uniqueCyclicSwapRelaxationScenario: RealCmaScenario<
  UniqueSwapSeed,
  UniqueSwapExpected
> = {
  name: 'current and published unique swaps use minimal temporary relaxation',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating cyclic uniqueness fixture');
    const apiKey = uniqueDeletionApiKey('uswap', runId);
    const model = await createModel(client, apiKey, 'Unique swap');
    const uniqueField = await createUniqueField(client, model.id);
    const currentFirst = await createUniqueRecord(
      client,
      model.id,
      'current-first',
    );
    const currentSecond = await createUniqueRecord(
      client,
      model.id,
      'current-second',
    );
    const publishedFirst = await createUniqueRecord(
      client,
      model.id,
      'published-first',
    );
    const publishedSecond = await createUniqueRecord(
      client,
      model.id,
      'published-second',
    );
    await client.items.publish<UniqueRecordDefinition>(publishedFirst.id);
    await client.items.publish<UniqueRecordDefinition>(publishedSecond.id);

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      uniqueFieldId: uniqueField.id,
      currentPair: [currentFirst.id, currentSecond.id],
      publishedPair: [publishedFirst.id, publishedSecond.id],
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating current and published cyclic unique swaps',
    );
    await swapCurrentUniqueValues(sourceClient, seed.currentPair, {
      first: 'current-first',
      second: 'current-second',
      temporary: 'current-temporary-release',
    });
    await swapPublishedUniqueValues(sourceClient, seed.publishedPair, {
      first: 'published-first',
      second: 'published-second',
      temporary: 'published-temporary-release',
    });

    const recordIds = [...seed.currentPair, ...seed.publishedPair].sort(
      compareIds,
    );
    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureUniqueState(sourceClient, seed.modelId, recordIds),
        captureUniqueState(destinationClient, seed.modelId, recordIds),
        captureFieldValidators(sourceClient, seed.modelId, seed.uniqueFieldId),
        captureFieldValidators(
          destinationClient,
          seed.modelId,
          seed.uniqueFieldId,
        ),
      ]);
    assert.deepEqual(sourceValidators, canonicalJson(UNIQUE_VALIDATORS));
    assert.deepEqual(destinationValidators, sourceValidators);
    assert.notDeepEqual(destination, source);

    return {
      recordIds,
      source,
      destination,
      validators: sourceValidators,
    };
  },

  async verify({ seed, expected, appliedClient, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying unique-cycle relaxation and restoration',
    );
    const [actual, validators] = await Promise.all([
      captureUniqueState(appliedClient, seed.modelId, expected.recordIds),
      captureFieldValidators(appliedClient, seed.modelId, seed.uniqueFieldId),
    ]);
    assert.deepEqual(actual, expected.source);
    assert.deepEqual(
      validators,
      expected.validators,
      'unique validators were not restored byte-equivalently',
    );

    const plan = await readGeneratedPlan(planFilePath);
    assert.equal(
      object(plan.options, 'plan.options').migrateInvalidContent,
      true,
    );
    assert.equal(
      object(plan.requiredPermissions, 'plan.requiredPermissions').editSchema,
      true,
      'unique swap did not require schema-edit permission',
    );
    const relaxations = array(
      object(plan.invalidContent, 'plan.invalidContent').validatorRelaxations,
      'plan.invalidContent.validatorRelaxations',
    );
    assert.equal(relaxations.length, 1);
    const relaxation = object(relaxations[0], 'unique relaxation');
    assert.equal(relaxation.fieldId, seed.uniqueFieldId);
    assert.equal(relaxation.itemTypeId, seed.modelId);
    assert.deepEqual(relaxation.relaxedValidatorKeys, ['unique']);
    assert.deepEqual(
      canonicalJson(relaxation.originalValidators),
      canonicalJson(UNIQUE_VALIDATORS),
    );
    assert.deepEqual(
      canonicalJson(relaxation.relaxedValidators),
      canonicalJson({ required: {} }),
      'required validator was removed together with unique',
    );
    assert.deepEqual(
      stringArray(relaxation.affectedRecordIds, 'affectedRecordIds').sort(
        compareIds,
      ),
      [...expected.recordIds].sort(compareIds),
    );
  },
};

export const defaultInvalidUniquePeerScenario: RealCmaScenario<
  DefaultUniquePeerSeed,
  DefaultUniquePeerExpected
> = {
  name: 'default mode keeps a native invalid draft with its skipped uniqueness peer',

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating default invalid uniqueness-peer fixture',
    );
    const apiKey = uniqueDeletionApiKey('udef', runId);
    const model = await createModel(client, apiKey, 'Default unique peer', {
      draftSavingActive: true,
    });
    const field = await client.fields.create(model.id, {
      label: 'Code',
      api_key: 'code',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const gateField = await client.fields.create(model.id, {
      label: 'Independent validity gate',
      api_key: 'gate',
      field_type: 'string',
      localized: false,
      validators: {},
    });

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      uniqueFieldId: field.id,
      gateFieldId: gateField.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating an invalid published peer and native invalid draft',
    );
    const publishedPeer =
      await sourceClient.items.create<InvalidUniquePeerDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        code: 'duplicate-default-peer',
        gate: 'x',
      });
    await sourceClient.items.publish<InvalidUniquePeerDefinition>(
      publishedPeer.id,
    );
    const nativeDraft =
      await sourceClient.items.create<InvalidUniquePeerDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        code: 'duplicate-default-peer',
        gate: 'valid native draft',
      });

    await sourceClient.fields.update(seed.uniqueFieldId, {
      validators: UNIQUE_VALIDATORS,
    });
    await sourceClient.fields.update(seed.gateFieldId, {
      validators: { length: { min: 5 } },
    });
    await destinationClient.fields.update(seed.uniqueFieldId, {
      validators: UNIQUE_VALIDATORS,
    });
    await destinationClient.fields.update(seed.gateFieldId, {
      validators: { length: { min: 5 } },
    });
    await waitForRecordValidity(sourceClient, [
      { id: publishedPeer.id, current: false, published: false },
      { id: nativeDraft.id, current: false, published: null },
    ]);

    const recordIds = [publishedPeer.id, nativeDraft.id].sort(compareIds);
    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureUniqueState(sourceClient, seed.modelId, recordIds),
        captureUniqueState(destinationClient, seed.modelId, recordIds),
        captureFieldValidators(sourceClient, seed.modelId, seed.uniqueFieldId),
        captureFieldValidators(
          destinationClient,
          seed.modelId,
          seed.uniqueFieldId,
        ),
      ]);
    assert.deepEqual(sourceValidators, canonicalJson(UNIQUE_VALIDATORS));
    assert.deepEqual(destinationValidators, sourceValidators);
    assert.deepEqual(destination, { current: [], published: [] });

    return {
      publishedPeerId: publishedPeer.id,
      nativeDraftId: nativeDraft.id,
      recordIds,
      source,
      destination,
      validators: sourceValidators,
    };
  },

  async verify({ seed, expected, appliedClient, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying default uniqueness-peer closure through raw CMA',
    );
    const [actual, validators] = await Promise.all([
      captureUniqueState(appliedClient, seed.modelId, expected.recordIds),
      captureFieldValidators(appliedClient, seed.modelId, seed.uniqueFieldId),
    ]);
    assert.deepEqual(actual, expected.destination);
    assert.deepEqual(validators, expected.validators);

    const plan = await readGeneratedPlan(planFilePath);
    assert.equal(
      object(plan.options, 'plan.options').migrateInvalidContent,
      false,
    );
    assert.equal(
      object(plan.requiredPermissions, 'plan.requiredPermissions').editSchema,
      false,
    );
    const invalidContent = object(plan.invalidContent, 'plan.invalidContent');
    assert.deepEqual(
      array(
        invalidContent.validatorRelaxations,
        'plan.invalidContent.validatorRelaxations',
      ),
      [],
    );
    const skipped = array(
      invalidContent.skippedRecords,
      'plan.invalidContent.skippedRecords',
    ).map((value, index) =>
      object(value, `plan.invalidContent.skippedRecords[${index}]`),
    );
    assert.deepEqual(
      skipped.map(({ id }) => string(id, 'skipped record ID')).sort(compareIds),
      [...expected.recordIds].sort(compareIds),
    );
    const publishedSkip = skipped.find(
      ({ id }) => id === expected.publishedPeerId,
    );
    const nativeDraftSkip = skipped.find(
      ({ id }) => id === expected.nativeDraftId,
    );
    assert.ok(publishedSkip, 'published invalid peer was not skipped');
    assert.ok(nativeDraftSkip, 'native invalid draft was not skipped');
    assert.ok(
      array(publishedSkip.reasons, 'published peer reasons').some(
        (value) =>
          object(value, 'published peer reason').code === 'INVALID_PUBLISHED',
      ),
      'published peer lacks its direct invalid-published reason',
    );
    assert.ok(
      array(nativeDraftSkip.reasons, 'native draft reasons').some((value) => {
        const reason = object(value, 'native draft reason');
        return (
          reason.code === 'DEPENDENCY_ON_SKIPPED_RECORD' &&
          reason.validatorKey === 'unique' &&
          reason.dependencyId === expected.publishedPeerId
        );
      }),
      'native invalid draft was not propagated from its skipped uniqueness peer',
    );
    assert.equal(invalidContent.propagatedSkipCount, 1);
  },
};

export const localizedPublishedStageUniqueScenario: RealCmaScenario<
  PublishedStageUniqueSeed,
  PublishedStageUniqueExpected
> = {
  name: 'localized published staging uses exact temporary unique relaxation',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating localized published-staging uniqueness fixture',
    );
    const apiKey = uniqueDeletionApiKey('ustag', runId);
    const model = await createModel(client, apiKey, 'Published-stage unique');
    const uniqueField = await client.fields.create(model.id, {
      label: 'Code',
      api_key: 'code',
      field_type: 'string',
      localized: true,
      validators: UNIQUE_VALIDATORS,
    });
    const site = await client.site.find();
    const locale = site.locales[0];
    assert.ok(locale, 'fixture project has no locale');
    const owner = await createLocalizedUniqueRecord(
      client,
      model.id,
      locale,
      'owner-published',
    );
    await client.items.publish<LocalizedUniqueRecordDefinition>(owner.id);
    await updateLocalizedUniqueRecord(
      client,
      owner.id,
      locale,
      'phase-seven-shared',
    );
    const consumer = await createLocalizedUniqueRecord(
      client,
      model.id,
      locale,
      'consumer-published',
    );
    await client.items.publish<LocalizedUniqueRecordDefinition>(consumer.id);
    await updateLocalizedUniqueRecord(
      client,
      consumer.id,
      locale,
      'consumer-current',
    );

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      uniqueFieldId: uniqueField.id,
      ownerId: owner.id,
      consumerId: consumer.id,
      locale,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating a source-valid localized cross-slice uniqueness claim',
    );
    await sourceClient.fields.update(seed.uniqueFieldId, {
      validators: { required: {} },
    });
    await updateLocalizedUniqueRecord(
      sourceClient,
      seed.consumerId,
      seed.locale,
      'phase-seven-shared',
    );
    await sourceClient.items.publish<LocalizedUniqueRecordDefinition>(
      seed.consumerId,
    );
    await updateLocalizedUniqueRecord(
      sourceClient,
      seed.consumerId,
      seed.locale,
      'consumer-current',
    );
    await sourceClient.fields.update(seed.uniqueFieldId, {
      validators: UNIQUE_VALIDATORS,
    });
    await waitForRecordValidity(sourceClient, [
      { id: seed.ownerId, current: true, published: true },
      { id: seed.consumerId, current: true, published: true },
    ]);

    const recordIds = [seed.ownerId, seed.consumerId].sort(compareIds);
    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureLocalizedUniqueState(sourceClient, seed.modelId, recordIds),
        captureLocalizedUniqueState(destinationClient, seed.modelId, recordIds),
        captureFieldValidators(sourceClient, seed.modelId, seed.uniqueFieldId),
        captureFieldValidators(
          destinationClient,
          seed.modelId,
          seed.uniqueFieldId,
        ),
      ]);
    assert.deepEqual(sourceValidators, canonicalJson(UNIQUE_VALIDATORS));
    assert.deepEqual(destinationValidators, sourceValidators);
    assert.notDeepEqual(destination, source);

    return {
      recordIds,
      source,
      destination,
      validators: sourceValidators,
    };
  },

  async verify({ seed, expected, appliedClient, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying localized phase-7 uniqueness relaxation through raw CMA',
    );
    const [actual, validators] = await Promise.all([
      captureLocalizedUniqueState(
        appliedClient,
        seed.modelId,
        expected.recordIds,
      ),
      captureFieldValidators(appliedClient, seed.modelId, seed.uniqueFieldId),
    ]);
    assert.deepEqual(actual, expected.source);
    assert.deepEqual(
      validators,
      expected.validators,
      'localized unique validators were not restored byte-equivalently',
    );

    const plan = await readGeneratedPlan(planFilePath);
    assert.equal(
      object(plan.options, 'plan.options').migrateInvalidContent,
      true,
    );
    assert.equal(
      object(plan.requiredPermissions, 'plan.requiredPermissions').editSchema,
      true,
    );
    const invalidContent = object(plan.invalidContent, 'plan.invalidContent');
    assert.deepEqual(
      array(
        invalidContent.skippedRecords,
        'plan.invalidContent.skippedRecords',
      ),
      [],
    );
    const relaxations = array(
      invalidContent.validatorRelaxations,
      'plan.invalidContent.validatorRelaxations',
    );
    assert.equal(relaxations.length, 1);
    const relaxation = object(relaxations[0], 'published-stage relaxation');
    assert.equal(relaxation.fieldId, seed.uniqueFieldId);
    assert.equal(relaxation.itemTypeId, seed.modelId);
    assert.deepEqual(relaxation.relaxedValidatorKeys, ['unique']);
    assert.deepEqual(
      canonicalJson(relaxation.originalValidators),
      canonicalJson(UNIQUE_VALIDATORS),
    );
    assert.deepEqual(
      canonicalJson(relaxation.relaxedValidators),
      canonicalJson({ required: {} }),
    );
    assert.deepEqual(
      stringArray(relaxation.affectedRecordIds, 'affectedRecordIds'),
      [seed.consumerId],
    );
    assert.deepEqual(
      stringArray(
        object(plan.execution, 'plan.execution').revalidateBeforePublishIds,
        'plan.execution.revalidateBeforePublishIds',
      ),
      [seed.consumerId],
    );
  },
};

export const skippedOwnerUnpublishedCreateSeedScenario: RealCmaScenario<
  SkippedOwnerCreateSeedSeed,
  SkippedOwnerCreateSeedExpected
> = {
  name: 'unpublished create seed is skipped when its unique owner is preserved',

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating skipped-owner unpublished-seed fixture',
    );
    const apiKey = uniqueDeletionApiKey('useed', runId);
    const model = await createModel(client, apiKey, 'Skipped unique owner', {
      draftSavingActive: true,
    });
    const uniqueField = await createUniqueField(client, model.id);
    const gateField = await client.fields.create(model.id, {
      label: 'Required publication gate',
      api_key: 'gate',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const owner = await client.items.create<InvalidUniquePeerDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      code: 'unpublished-seed-held',
      gate: 'valid scheduled owner',
    });
    await client.scheduledPublication.create(owner.id, {
      publication_scheduled_at: new Date(
        Date.now() + 72 * 60 * 60 * 1000,
      ).toISOString(),
      selective_publication: null,
    });

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      uniqueFieldId: uniqueField.id,
      gateFieldId: gateField.id,
      ownerId: owner.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Preserving an invalid owner across an unpublished unique create seed',
    );
    await sourceClient.items.update<InvalidUniquePeerDefinition>(seed.ownerId, {
      code: 'unpublished-seed-released',
      gate: null,
    });
    const claimant =
      await sourceClient.items.create<InvalidUniquePeerDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        code: 'unpublished-seed-held',
        gate: 'valid unpublished claimant',
      });
    await Promise.all([
      waitForRecordValidity(sourceClient, [
        { id: seed.ownerId, current: false, published: null },
        { id: claimant.id, current: true, published: null },
      ]),
      waitForRecordValidity(destinationClient, [
        { id: seed.ownerId, current: true, published: null },
      ]),
    ]);

    const [sourceSchedule, destinationSchedule] = await Promise.all([
      capturePublicationSchedule(sourceClient, seed.ownerId),
      capturePublicationSchedule(destinationClient, seed.ownerId),
    ]);
    assert.ok(
      sourceSchedule,
      'source owner lost its future publication schedule',
    );
    assert.equal(
      sourceSchedule,
      destinationSchedule,
      'source and destination publication schedules diverged after the fork',
    );
    assert.ok(
      Date.parse(sourceSchedule) > Date.now(),
      'owner publication schedule is not in the future',
    );

    const recordIds = [seed.ownerId, claimant.id].sort(compareIds);
    const [
      source,
      destination,
      sourceUniqueValidators,
      destinationUniqueValidators,
      sourceGateValidators,
      destinationGateValidators,
    ] = await Promise.all([
      captureUniqueState(sourceClient, seed.modelId, recordIds),
      captureUniqueState(destinationClient, seed.modelId, recordIds),
      captureFieldValidators(sourceClient, seed.modelId, seed.uniqueFieldId),
      captureFieldValidators(
        destinationClient,
        seed.modelId,
        seed.uniqueFieldId,
      ),
      captureFieldValidators(sourceClient, seed.modelId, seed.gateFieldId),
      captureFieldValidators(destinationClient, seed.modelId, seed.gateFieldId),
    ]);
    assert.deepEqual(sourceUniqueValidators, canonicalJson(UNIQUE_VALIDATORS));
    assert.deepEqual(destinationUniqueValidators, sourceUniqueValidators);
    assert.deepEqual(sourceGateValidators, canonicalJson({ required: {} }));
    assert.deepEqual(destinationGateValidators, sourceGateValidators);
    assert.notDeepEqual(destination, source);

    return {
      claimantId: claimant.id,
      recordIds,
      source,
      destination,
      uniqueValidators: sourceUniqueValidators,
      gateValidators: sourceGateValidators,
      publicationScheduledAt: sourceSchedule,
    };
  },

  async verify({ seed, expected, appliedClient, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying skipped unpublished seed and preserved owner through raw CMA',
    );
    const [actual, uniqueValidators, gateValidators, publicationSchedule] =
      await Promise.all([
        captureUniqueState(appliedClient, seed.modelId, expected.recordIds),
        captureFieldValidators(appliedClient, seed.modelId, seed.uniqueFieldId),
        captureFieldValidators(appliedClient, seed.modelId, seed.gateFieldId),
        capturePublicationSchedule(appliedClient, seed.ownerId),
      ]);
    assert.deepEqual(
      actual,
      expected.destination,
      'the target owner changed or the skipped unpublished claimant was created',
    );
    assert.deepEqual(uniqueValidators, expected.uniqueValidators);
    assert.deepEqual(gateValidators, expected.gateValidators);
    assert.equal(
      publicationSchedule,
      expected.publicationScheduledAt,
      'the preserved owner publication schedule changed',
    );

    const plan = await readGeneratedPlan(planFilePath);
    assert.equal(
      object(plan.options, 'plan.options').migrateInvalidContent,
      false,
    );
    assert.equal(
      object(plan.requiredPermissions, 'plan.requiredPermissions').editSchema,
      false,
    );
    const invalidContent = object(plan.invalidContent, 'plan.invalidContent');
    assert.equal(
      object(
        object(plan.summary, 'plan.summary').invalidContent,
        'summary invalidContent',
      ).status,
      'partial',
    );
    assert.deepEqual(
      array(
        invalidContent.validatorRelaxations,
        'plan.invalidContent.validatorRelaxations',
      ),
      [],
    );
    const skipped = array(
      invalidContent.skippedRecords,
      'plan.invalidContent.skippedRecords',
    ).map((value, index) =>
      object(value, `plan.invalidContent.skippedRecords[${index}]`),
    );
    assert.deepEqual(
      skipped.map(({ id }) => string(id, 'skipped record ID')).sort(compareIds),
      [...expected.recordIds].sort(compareIds),
    );
    const ownerSkip = skipped.find(({ id }) => id === seed.ownerId);
    const claimantSkip = skipped.find(({ id }) => id === expected.claimantId);
    assert.ok(ownerSkip, 'the scheduled invalid owner was not skipped');
    assert.ok(claimantSkip, 'the unpublished create seed was not skipped');
    assert.equal(ownerSkip.disposition, 'preserve_target');
    assert.equal(claimantSkip.disposition, 'must_remain_absent');
    assert.ok(
      array(ownerSkip.reasons, 'owner skip reasons').some((value) => {
        const reason = object(value, 'owner skip reason');
        return (
          reason.code === 'UNSAFE_SCHEDULED_PUBLICATION' &&
          reason.slice === 'schedule'
        );
      }),
      'owner does not carry its independent unsafe-schedule skip reason',
    );
    assert.ok(
      array(claimantSkip.reasons, 'claimant skip reasons').some((value) => {
        const reason = object(value, 'claimant skip reason');
        return (
          reason.code === 'INVALID_INTERMEDIATE' &&
          reason.fieldId === seed.uniqueFieldId &&
          reason.validatorKey === 'unique' &&
          reason.dependencyId === seed.ownerId
        );
      }),
      'unpublished create seed was not blocked by the preserved unique owner',
    );
  },
};

export const optionalDeletionCyclesScenario: RealCmaScenario<
  DeleteCycleSeed,
  DeleteCycleExpected
> = {
  name: 'optional published and current deletion SCCs release before destroy',
  contentDiffArgs: ['--include-deletions'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating deletion-cycle fixture');
    const apiKey = uniqueDeletionApiKey('dcycle', runId);
    const model = await createModel(client, apiKey, 'Deletion cycle');
    await client.fields.create(model.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(model.id, {
      label: 'Peer',
      api_key: 'peer',
      field_type: 'link',
      localized: false,
      validators: {
        item_item_type: {
          item_types: [model.id],
          on_publish_with_unpublished_references_strategy: 'fail',
          on_reference_unpublish_strategy: 'fail',
          on_reference_delete_strategy: 'fail',
        },
      },
    });

    const currentPair = await createLinkCycle(client, model.id, 'current');
    const publishedPair = await createPublishedLinkCycle(
      client,
      model.id,
      'published',
    );

    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
      currentPair,
      publishedPair,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Removing source cycles while retaining destination SCCs',
    );
    const recordIds = [...seed.currentPair, ...seed.publishedPair].sort(
      compareIds,
    );
    const destination = await captureLinkState(
      destinationClient,
      seed.modelId,
      recordIds,
    );
    assertDeletionFixture(destination, seed);

    await unlinkLinkRecord(sourceClient, seed.currentPair[0]);
    await unlinkLinkRecord(sourceClient, seed.currentPair[1]);
    await sourceClient.items.destroy(seed.currentPair[0]);
    await sourceClient.items.destroy(seed.currentPair[1]);

    await unlinkAndPublishLinkRecord(sourceClient, seed.publishedPair[0]);
    await unlinkAndPublishLinkRecord(sourceClient, seed.publishedPair[1]);
    await sourceClient.items.destroy(seed.publishedPair[0]);
    await sourceClient.items.destroy(seed.publishedPair[1]);

    const source = await captureLinkState(
      sourceClient,
      seed.modelId,
      recordIds,
    );
    assert.deepEqual(source, { current: [], published: [] });

    return { recordIds, source, destination };
  },

  async verify({ seed, expected, appliedClient, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying deterministic deletion releases through raw CMA',
    );
    const actual = await captureLinkState(
      appliedClient,
      seed.modelId,
      expected.recordIds,
    );
    assert.deepEqual(actual, expected.source);

    const plan = await readGeneratedPlan(planFilePath);
    const execution = object(plan.execution, 'plan.execution');
    assert.deepEqual(
      stringArray(execution.deleteOrder, 'plan.execution.deleteOrder').sort(
        compareIds,
      ),
      [...expected.recordIds].sort(compareIds),
    );
    const releaseById = new Map(
      array(execution.deleteReleases, 'plan.execution.deleteReleases').map(
        (value, index) => {
          const release = object(
            value,
            `plan.execution.deleteReleases[${index}]`,
          );
          return [string(release.recordId, 'delete release recordId'), release];
        },
      ),
    );
    assert.deepEqual([...releaseById.keys()].sort(compareIds), [
      ...expected.recordIds,
    ]);
    for (const recordId of seed.currentPair) {
      assert.equal(releaseById.get(recordId)?.publish, false);
    }
    for (const recordId of seed.publishedPair) {
      assert.equal(releaseById.get(recordId)?.publish, true);
    }
  },
};

export const crossBoundaryDeletionReferrerScenario: RealCmaScenario<
  BoundarySeed,
  void
> = {
  name: 'out-of-scope published referrer rejects a managed deletion',
  contentDiffArgs: ['--include-deletions'],
  expectedGenerationFailure: {
    messagePattern: CROSS_BOUNDARY_REFERRER_FAILURE_PATTERN,
  },

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating cross-boundary referrer fixture');
    const targetApiKey = uniqueDeletionApiKey('bound', runId);
    const referrerApiKey = uniqueDeletionApiKey('refer', runId);
    const targetModel = await createModel(
      client,
      targetApiKey,
      'Boundary target',
    );
    await client.fields.create(targetModel.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    const referrerModel = await createModel(
      client,
      referrerApiKey,
      'Boundary referrer',
    );
    await client.fields.create(referrerModel.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: { required: {} },
    });
    await client.fields.create(referrerModel.id, {
      label: 'Target',
      api_key: 'target',
      field_type: 'link',
      localized: false,
      validators: {
        item_item_type: {
          item_types: [targetModel.id],
          on_publish_with_unpublished_references_strategy: 'fail',
          on_reference_unpublish_strategy: 'fail',
          on_reference_delete_strategy: 'fail',
        },
      },
    });
    const target = await client.items.create<BoundaryTargetDefinition>({
      item_type: { id: targetModel.id, type: 'item_type' },
      title: 'managed deletion target',
    });
    await client.items.publish<BoundaryTargetDefinition>(target.id);
    const referrer = await client.items.create<BoundaryReferrerDefinition>({
      item_type: { id: referrerModel.id, type: 'item_type' },
      label: 'out-of-scope published referrer',
      target: target.id,
    });
    await client.items.publish<BoundaryReferrerDefinition>(referrer.id);

    return {
      itemTypeApiKeys: [targetApiKey],
      targetModelId: targetModel.id,
      referrerModelId: referrerModel.id,
      targetId: target.id,
      referrerId: referrer.id,
    };
  },

  async introduceDrift({ seed, sourceClient }) {
    console.log(
      '[content-diff e2e] Removing the source-side external reference and target',
    );
    await sourceClient.items.update<BoundaryReferrerDefinition>(
      seed.referrerId,
      { target: null },
    );
    await sourceClient.items.publish<BoundaryReferrerDefinition>(
      seed.referrerId,
    );
    await sourceClient.items.destroy(seed.targetId);
  },
};

export const skippedRecordUploadProtectionScenario: RealCmaScenario<
  UploadProtectionSeed,
  UploadProtectionExpected
> = {
  name: 'target-only unique owner skips claimant and protects its upload',
  contentDiffArgs: ['--uploads=all', '--include-deletions'],

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating skipped-upload fixture');
    const apiKey = uniqueDeletionApiKey('uprot', runId);
    const model = await createModel(client, apiKey, 'Upload protection');
    await createUniqueField(client, model.id);
    await client.fields.create(model.id, {
      label: 'Asset',
      api_key: 'asset',
      field_type: 'file',
      localized: false,
      validators: {},
    });
    return {
      itemTypeApiKeys: [apiKey],
      modelId: model.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating a source-only claimant blocked by a target-only owner and upload',
    );
    const claimant = await createUniqueAssetRecord(
      sourceClient,
      seed.modelId,
      'target-only-held-value',
    );
    const upload = await createProtectedTextUpload(destinationClient);
    const blockingOwner =
      await destinationClient.items.create<UniqueAssetRecordDefinition>({
        item_type: { id: seed.modelId, type: 'item_type' },
        code: 'target-only-held-value',
        asset: { upload_id: upload.id },
      });

    const recordIds = [claimant.id, blockingOwner.id].sort(compareIds);
    const [source, destination, rawUpload] = await Promise.all([
      captureUniqueAssetState(sourceClient, seed.modelId, recordIds),
      captureUniqueAssetState(destinationClient, seed.modelId, recordIds),
      captureUpload(destinationClient, upload.id),
    ]);
    assert.notDeepEqual(source, destination);
    assert.equal(
      uploadIdFromAsset(
        destination.current.find(({ id }) => id === blockingOwner.id)?.asset ??
          null,
      ),
      upload.id,
    );

    return {
      recordIds,
      claimantId: claimant.id,
      blockingOwnerId: blockingOwner.id,
      uploadId: upload.id,
      source,
      destination,
      upload: rawUpload,
    };
  },

  async verify({ seed, expected, appliedClient, planFilePath }) {
    console.log(
      '[content-diff e2e] Verifying skipped-record upload protection through raw CMA',
    );
    const [actual, upload, currentReferences, publishedReferences] =
      await Promise.all([
        captureUniqueAssetState(
          appliedClient,
          seed.modelId,
          expected.recordIds,
        ),
        captureUpload(appliedClient, expected.uploadId),
        appliedClient.uploads.references(expected.uploadId, {
          version: 'current',
          nested: false,
        }),
        appliedClient.uploads.references(expected.uploadId, {
          version: 'published',
          nested: false,
        }),
      ]);
    assert.deepEqual(
      actual,
      expected.destination,
      'skipped destination records were not preserved exactly',
    );
    assert.deepEqual(upload, expected.upload);
    assert.ok(
      currentReferences.some(({ id }) => id === expected.blockingOwnerId),
      'protected upload lost its current destination referrer',
    );
    assert.equal(publishedReferences.length, 0);

    const plan = await readGeneratedPlan(planFilePath);
    const invalidContent = object(plan.invalidContent, 'plan.invalidContent');
    assert.deepEqual(
      array(invalidContent.skippedRecords, 'skippedRecords')
        .map((value, index) =>
          string(
            object(value, `skippedRecords[${index}]`).id,
            `skippedRecords[${index}].id`,
          ),
        )
        .sort(compareIds),
      [expected.claimantId],
      'the source-only claimant was not the sole directly skipped record',
    );
    const skipped = object(
      array(invalidContent.skippedRecords, 'skippedRecords')[0],
      'skippedRecords[0]',
    );
    const reasons = array(skipped.reasons, 'skippedRecords[0].reasons').map(
      (value, index) => object(value, `skippedRecords[0].reasons[${index}]`),
    );
    assert.ok(
      reasons.some(
        ({ code, dependencyId }) =>
          code === 'UNRELAXABLE_VALIDATOR' &&
          dependencyId === expected.blockingOwnerId,
      ),
      'target-only unique owner was not recorded as the blocking dependency',
    );
    const uploadPlan = array(plan.uploads, 'plan.uploads')
      .map((value, index) => object(value, `plan.uploads[${index}]`))
      .find(({ id }) => id === expected.uploadId);
    assert.ok(uploadPlan, 'protected destination upload is absent from plan');
    assert.equal(
      uploadPlan.action,
      'noop',
      'protected destination upload was scheduled for mutation or deletion',
    );
  },
};

async function createModel(
  client: CmaClient.Client,
  apiKey: string,
  name: string,
  options: Readonly<{ draftSavingActive?: boolean }> = {},
): Promise<CmaClient.ApiTypes.ItemType> {
  return client.itemTypes.create({
    name,
    api_key: apiKey,
    singleton: false,
    all_locales_required: false,
    sortable: false,
    modular_block: false,
    draft_mode_active: true,
    draft_saving_active: options.draftSavingActive ?? false,
    tree: false,
    collection_appearance: 'compact',
    inverse_relationships_enabled: false,
  });
}

function createUniqueField(
  client: CmaClient.Client,
  modelId: string,
): Promise<CmaClient.ApiTypes.Field> {
  return client.fields.create(modelId, {
    label: 'Code',
    api_key: 'code',
    field_type: 'string',
    localized: false,
    validators: UNIQUE_VALIDATORS,
  });
}

function createUniqueRecord(
  client: CmaClient.Client,
  modelId: string,
  code: string,
): Promise<CmaClient.ApiTypes.Item<UniqueRecordDefinition>> {
  return client.items.create<UniqueRecordDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    code,
  });
}

function createLocalizedUniqueRecord(
  client: CmaClient.Client,
  modelId: string,
  locale: string,
  code: string,
): Promise<CmaClient.ApiTypes.Item<LocalizedUniqueRecordDefinition>> {
  return client.items.create<LocalizedUniqueRecordDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    code: { [locale]: code },
  });
}

function createUniqueAssetRecord(
  client: CmaClient.Client,
  modelId: string,
  code: string,
): Promise<CmaClient.ApiTypes.Item<UniqueAssetRecordDefinition>> {
  return client.items.create<UniqueAssetRecordDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    code,
    asset: null,
  });
}

function updateUniqueRecord(
  client: CmaClient.Client,
  recordId: string,
  code: string,
): Promise<CmaClient.ApiTypes.Item<UniqueRecordDefinition>> {
  return client.items.update<UniqueRecordDefinition>(recordId, { code });
}

function updateLocalizedUniqueRecord(
  client: CmaClient.Client,
  recordId: string,
  locale: string,
  code: string,
): Promise<CmaClient.ApiTypes.Item<LocalizedUniqueRecordDefinition>> {
  return client.items.update<LocalizedUniqueRecordDefinition>(recordId, {
    code: { [locale]: code },
  });
}

async function updateAndPublishUniqueRecord(
  client: CmaClient.Client,
  recordId: string,
  code: string,
): Promise<void> {
  await updateUniqueRecord(client, recordId, code);
  await client.items.publish<UniqueRecordDefinition>(recordId);
}

async function swapCurrentUniqueValues(
  client: CmaClient.Client,
  pair: readonly [string, string],
  values: Readonly<{ first: string; second: string; temporary: string }>,
): Promise<void> {
  await updateUniqueRecord(client, pair[0], values.temporary);
  await updateUniqueRecord(client, pair[1], values.first);
  await updateUniqueRecord(client, pair[0], values.second);
}

async function swapPublishedUniqueValues(
  client: CmaClient.Client,
  pair: readonly [string, string],
  values: Readonly<{ first: string; second: string; temporary: string }>,
): Promise<void> {
  await updateAndPublishUniqueRecord(client, pair[0], values.temporary);
  await updateAndPublishUniqueRecord(client, pair[1], values.first);
  await updateAndPublishUniqueRecord(client, pair[0], values.second);
}

async function createLinkCycle(
  client: CmaClient.Client,
  modelId: string,
  label: string,
): Promise<readonly [string, string]> {
  const first = await client.items.create<LinkRecordDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    label: `${label} first`,
    peer: null,
  });
  const second = await client.items.create<LinkRecordDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    label: `${label} second`,
    peer: first.id,
  });
  await client.items.update<LinkRecordDefinition>(first.id, {
    peer: second.id,
  });
  return [first.id, second.id];
}

async function createPublishedLinkCycle(
  client: CmaClient.Client,
  modelId: string,
  label: string,
): Promise<readonly [string, string]> {
  const first = await client.items.create<LinkRecordDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    label: `${label} first`,
    peer: null,
  });
  const second = await client.items.create<LinkRecordDefinition>({
    item_type: { id: modelId, type: 'item_type' },
    label: `${label} second`,
    peer: null,
  });
  await client.items.publish<LinkRecordDefinition>(first.id);
  await client.items.publish<LinkRecordDefinition>(second.id);
  await client.items.update<LinkRecordDefinition>(first.id, {
    peer: second.id,
  });
  await client.items.publish<LinkRecordDefinition>(first.id);
  await client.items.update<LinkRecordDefinition>(second.id, {
    peer: first.id,
  });
  await client.items.publish<LinkRecordDefinition>(second.id);
  return [first.id, second.id];
}

function unlinkLinkRecord(
  client: CmaClient.Client,
  recordId: string,
): Promise<CmaClient.ApiTypes.Item<LinkRecordDefinition>> {
  return client.items.update<LinkRecordDefinition>(recordId, { peer: null });
}

async function unlinkAndPublishLinkRecord(
  client: CmaClient.Client,
  recordId: string,
): Promise<void> {
  await unlinkLinkRecord(client, recordId);
  await client.items.publish<LinkRecordDefinition>(recordId);
}

async function createProtectedTextUpload(
  client: CmaClient.Client,
): Promise<CmaClient.ApiTypes.Upload> {
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-protected-'));
  const localPath = join(directory, 'protected.txt');
  try {
    await writeFile(
      localPath,
      'DatoCMS content-diff protected destination upload fixture\n',
      'utf8',
    );
    return await client.uploads.createFromLocalFile({
      localPath,
      filename: 'protected-destination-only.txt',
      skipCreationIfAlreadyExists: false,
      tags: ['content-diff-e2e', 'protected'],
      notes: 'Must survive because a skipped destination record references it',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function captureUniqueState(
  client: CmaClient.Client,
  modelId: string,
  recordIds: readonly string[],
): Promise<RawUniqueState> {
  return {
    current: await captureVersion(
      client,
      modelId,
      recordIds,
      'current',
      normalizeUniqueRecord,
    ),
    published: await captureVersion(
      client,
      modelId,
      recordIds,
      'published',
      normalizeUniqueRecord,
    ),
  };
}

async function captureLocalizedUniqueState(
  client: CmaClient.Client,
  modelId: string,
  recordIds: readonly string[],
): Promise<RawLocalizedUniqueState> {
  return {
    current: await captureVersion(
      client,
      modelId,
      recordIds,
      'current',
      normalizeLocalizedUniqueRecord,
    ),
    published: await captureVersion(
      client,
      modelId,
      recordIds,
      'published',
      normalizeLocalizedUniqueRecord,
    ),
  };
}

async function captureLinkState(
  client: CmaClient.Client,
  modelId: string,
  recordIds: readonly string[],
): Promise<RawLinkState> {
  return {
    current: await captureVersion(
      client,
      modelId,
      recordIds,
      'current',
      normalizeLinkRecord,
    ),
    published: await captureVersion(
      client,
      modelId,
      recordIds,
      'published',
      normalizeLinkRecord,
    ),
  };
}

async function captureUniqueAssetState(
  client: CmaClient.Client,
  modelId: string,
  recordIds: readonly string[],
): Promise<RawUniqueAssetState> {
  return {
    current: await captureVersion(
      client,
      modelId,
      recordIds,
      'current',
      normalizeUniqueAssetRecord,
    ),
    published: await captureVersion(
      client,
      modelId,
      recordIds,
      'published',
      normalizeUniqueAssetRecord,
    ),
  };
}

async function capturePublicationSchedule(
  client: CmaClient.Client,
  recordId: string,
): Promise<string | null> {
  const response = await client.items.rawCurrentVsPublishedState(recordId);
  const publicationId =
    response.data.relationships.scheduled_publication.data?.id ?? null;
  if (!publicationId) return null;

  const publication = response.included.find(
    ({ id, type }) => id === publicationId && type === 'scheduled_publication',
  );
  assert.ok(
    publication?.type === 'scheduled_publication',
    `scheduled publication ${publicationId} is missing from raw includes`,
  );
  return new Date(
    publication.attributes.publication_scheduled_at,
  ).toISOString();
}

async function captureVersion<T>(
  client: CmaClient.Client,
  modelId: string,
  recordIds: readonly string[],
  version: 'current' | 'published',
  normalize: (resource: RawResource, modelId: string) => T,
): Promise<T[]> {
  const values: T[] = [];
  for (const recordId of [...recordIds].sort(compareIds)) {
    const resource = await rawItemOrNull(client, recordId, version);
    if (resource) values.push(normalize(resource, modelId));
  }
  return values;
}

async function rawItemOrNull(
  client: CmaClient.Client,
  recordId: string,
  version: 'current' | 'published',
): Promise<RawResource | null> {
  try {
    const response = await client.items.rawFind(recordId, { version });
    return rawResource(
      object(response, `${recordId} ${version} response`).data,
      `${recordId} ${version}`,
    );
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.findError('NOT_FOUND')) {
      return null;
    }
    throw error;
  }
}

function normalizeUniqueRecord(
  resource: RawResource,
  modelId: string,
): RawUniqueRecord {
  assertItemModel(resource, modelId);
  return {
    id: resource.id,
    itemTypeId: modelId,
    code: string(resource.attributes.code, `${resource.id}.code`),
  };
}

function normalizeLocalizedUniqueRecord(
  resource: RawResource,
  modelId: string,
): RawLocalizedUniqueRecord {
  assertItemModel(resource, modelId);
  return {
    id: resource.id,
    itemTypeId: modelId,
    code: canonicalJson(resource.attributes.code),
  };
}

function normalizeLinkRecord(
  resource: RawResource,
  modelId: string,
): RawLinkRecord {
  assertItemModel(resource, modelId);
  return {
    id: resource.id,
    itemTypeId: modelId,
    label: string(resource.attributes.label, `${resource.id}.label`),
    peerId: nullableString(resource.attributes.peer, `${resource.id}.peer`),
  };
}

function normalizeUniqueAssetRecord(
  resource: RawResource,
  modelId: string,
): RawUniqueAssetRecord {
  assertItemModel(resource, modelId);
  return {
    id: resource.id,
    itemTypeId: modelId,
    code: string(resource.attributes.code, `${resource.id}.code`),
    asset: canonicalJson(resource.attributes.asset),
  };
}

function assertItemModel(resource: RawResource, modelId: string): void {
  assert.equal(resource.type, 'item');
  assert.equal(relationshipId(resource, 'item_type'), modelId);
}

async function captureFieldValidators(
  client: CmaClient.Client,
  modelId: string,
  fieldId: string,
): Promise<CanonicalValue> {
  const response = await client.fields.rawList(modelId);
  const fields = array(
    object(response, `fields for ${modelId}`).data,
    `fields for ${modelId}.data`,
  ).map((value, index) => rawResource(value, `fields[${index}]`));
  const field = fields.find(({ id }) => id === fieldId);
  assert.ok(field, `field ${fieldId} is absent from model ${modelId}`);
  return canonicalJson(field.attributes.validators);
}

async function waitForRecordValidity(
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

  const details = await Promise.all(
    expectations.map(async ({ id, current, published }) => {
      const record = await client.items.find(id);
      return {
        id,
        expected: { current, published },
        actual: {
          current: record.meta.is_current_version_valid,
          published: record.meta.is_published_version_valid,
        },
      };
    }),
  );
  throw new Error(
    `record validity did not converge: ${JSON.stringify(details)}`,
  );
}

async function captureUpload(
  client: CmaClient.Client,
  uploadId: string,
): Promise<RawUpload> {
  const response = await client.uploads.rawFind(uploadId);
  const resource = rawResource(
    object(response, `upload ${uploadId} response`).data,
    `upload ${uploadId}`,
  );
  assert.equal(resource.type, 'upload');
  assert.equal(resource.id, uploadId);
  return {
    id: uploadId,
    filename: string(resource.attributes.filename, `${uploadId}.filename`),
    md5: string(resource.attributes.md5, `${uploadId}.md5`),
    size: integer(resource.attributes.size, `${uploadId}.size`),
    tags: stringArray(resource.attributes.tags, `${uploadId}.tags`).sort(),
  };
}

function assertDeletionFixture(
  state: RawLinkState,
  seed: DeleteCycleSeed,
): void {
  const currentById = new Map(
    state.current.map((record) => [record.id, record]),
  );
  const publishedById = new Map(
    state.published.map((record) => [record.id, record]),
  );
  assert.equal(
    currentById.get(seed.currentPair[0])?.peerId,
    seed.currentPair[1],
  );
  assert.equal(
    currentById.get(seed.currentPair[1])?.peerId,
    seed.currentPair[0],
  );
  assert.equal(
    publishedById.get(seed.publishedPair[0])?.peerId,
    seed.publishedPair[1],
  );
  assert.equal(
    publishedById.get(seed.publishedPair[1])?.peerId,
    seed.publishedPair[0],
  );
  assert.equal(publishedById.has(seed.currentPair[0]), false);
  assert.equal(publishedById.has(seed.currentPair[1]), false);
}

function assertReleaseConsumer(
  releases: readonly Record<string, unknown>[],
  ownerId: string,
  consumerId: string,
): void {
  const release = releases.find(({ recordId }) => recordId === ownerId);
  assert.ok(release, `missing unique release for owner ${ownerId}`);
  assert.ok(
    stringArray(
      release.consumerRecordIds,
      `${ownerId}.consumerRecordIds`,
    ).includes(consumerId),
    `unique release for ${ownerId} does not precede claimant ${consumerId}`,
  );
}

async function readGeneratedPlan(
  planFilePath: string,
): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(planFilePath, 'utf8'));
  return object(object(parsed, 'plan envelope').plan, 'plan envelope.plan');
}

function uploadIdFromAsset(value: CanonicalValue): string | null {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return null;
  }
  return typeof value.upload_id === 'string' ? value.upload_id : null;
}

function rawResource(value: unknown, path: string): RawResource {
  const resource = object(value, path);
  return {
    type: string(resource.type, `${path}.type`),
    id: string(resource.id, `${path}.id`),
    attributes: object(resource.attributes ?? {}, `${path}.attributes`),
    relationships: object(
      resource.relationships ?? {},
      `${path}.relationships`,
    ),
  };
}

function relationshipId(resource: RawResource, key: string): string {
  const relationship = object(
    resource.relationships[key],
    `${resource.id}.${key}`,
  );
  const data = object(relationship.data, `${resource.id}.${key}.data`);
  return string(data.id, `${resource.id}.${key}.data.id`);
}

function canonicalJson(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  throw new Error('value is not canonical JSON');
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
  return value as number;
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((entry, index) =>
    string(entry, `${path}[${index}]`),
  );
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
