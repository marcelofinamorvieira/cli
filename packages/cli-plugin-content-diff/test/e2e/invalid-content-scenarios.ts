import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

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
  validity: Readonly<{
    current: boolean | null;
    published: boolean | null;
  }>;
}>;

type RawState = Readonly<{
  current: Readonly<Record<string, CanonicalRecord>>;
  published: Readonly<Record<string, CanonicalRecord>>;
}>;

type ValidatorState = readonly Readonly<{
  itemTypeId: string;
  fieldId: string;
  apiKey: string;
  validators: CanonicalValue;
}>[];

type StrictDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
    related: { type: 'link'; localized: false };
  };
};

type NativeDraftDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    title: { type: 'string'; localized: false };
  };
};

type RelaxationSeed = RealCmaScenarioSeed &
  Readonly<{
    relaxableModelId: string;
    blockModelId: string;
    titleFieldId: string;
    scoreFieldId: string;
    codeFieldId: string;
    modulesFieldId: string;
    blockLabelFieldId: string;
    schemaItemTypeIds: readonly string[];
  }>;

type RelaxationExpected = Readonly<{
  relaxableRecordIds: readonly string[];
  recordIds: Readonly<{
    requiredLength: string;
    enum: string;
    numberRange: string;
    nestedBlock: string;
    unique: readonly [string, string];
  }>;
  structuralSkipRecordId: string;
  collidingBlockId: string;
  destinationOwnerId: string;
  source: RawState;
  destination: RawState;
  validators: ValidatorState;
}>;

type DefaultSeed = RealCmaScenarioSeed &
  Readonly<{
    strictModelId: string;
    nativeDraftModelId: string;
    strictTitleFieldId: string;
    strictRelatedFieldId: string;
    nativeTitleFieldId: string;
    identicalInvalidId: string;
    schemaItemTypeIds: readonly string[];
  }>;

type DefaultExpected = Readonly<{
  strictInvalidId: string;
  propagatedConsumerId: string;
  nativeInvalidDraftId: string;
  source: RawState;
  destination: RawState;
  validators: ValidatorState;
}>;

type ValidatorContract = Readonly<{
  original: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  removed: readonly string[];
  relaxed: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

const API_KEY_PATTERN = /^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/;
const API_KEY_MAX_LENGTH = 30;

export function buildInvalidContentModelApiKeys(runId: string): Readonly<{
  relaxable: string;
  block: string;
  locales: string;
  strict: string;
  nativeDraft: string;
}> {
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const result = {
    relaxable: `cde2e_ir_r${suffix}`,
    block: `cde2e_ib_r${suffix}`,
    locales: `cde2e_il_r${suffix}`,
    strict: `cde2e_is_r${suffix}`,
    nativeDraft: `cde2e_in_r${suffix}`,
  };

  for (const apiKey of Object.values(result)) {
    assert.match(apiKey, API_KEY_PATTERN);
    assert.ok(
      apiKey.length <= API_KEY_MAX_LENGTH,
      `invalid-content E2E model API key exceeds ${API_KEY_MAX_LENGTH} characters: ${apiKey}`,
    );
  }

  return result;
}

export function buildRelaxableValidatorContracts(): Readonly<{
  title: ValidatorContract;
  score: ValidatorContract;
  code: ValidatorContract;
  blockLabel: ValidatorContract;
}> {
  return {
    title: {
      original: {
        required: {},
        length: { min: 8 },
        enum: { values: ['approved'] },
      },
      removed: ['enum', 'length', 'required'],
      relaxed: {},
    },
    score: {
      original: { required: {}, number_range: { min: 10, max: 20 } },
      removed: ['number_range'],
      relaxed: { required: {} },
    },
    code: {
      original: { required: {}, unique: {} },
      removed: ['unique'],
      relaxed: { required: {} },
    },
    blockLabel: {
      original: {
        required: {},
        length: { min: 6 },
        enum: { values: ['approved block'] },
      },
      removed: ['enum', 'length', 'required'],
      relaxed: {},
    },
  };
}

export function buildNestedBlockInvalidLabels(): Readonly<{
  en: string;
  it: string;
}> {
  return {
    // Enum validation deliberately ignores blank values. Keep one blank label
    // for the required + length diagnostics and one non-blank, long-enough
    // label for the independent enum diagnostic.
    en: '',
    it: 'denied block',
  };
}

export const invalidContentRelaxationScenario: RealCmaScenario<
  RelaxationSeed,
  RelaxationExpected
> = {
  name: 'invalid current and published validator matrix with nested localized roll-up',
  contentDiffArgs: ['--migrate-invalid-content'],

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating invalid-content relaxation schema',
    );
    await client.site.update({ locales: ['en', 'it'] });
    const apiKeys = buildInvalidContentModelApiKeys(runId);
    const relaxableModel = await createModel(client, {
      name: `Invalid content ${runId}`,
      apiKey: apiKeys.relaxable,
      allLocalesRequired: false,
      draftSavingActive: false,
    });
    const blockModel = await client.itemTypes.create({
      name: `Invalid nested block ${runId}`,
      api_key: apiKeys.block,
      modular_block: true,
    });
    const titleField = await client.fields.create(relaxableModel.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: true,
      validators: {},
    });
    const scoreField = await client.fields.create(relaxableModel.id, {
      label: 'Score',
      api_key: 'score',
      field_type: 'integer',
      localized: false,
      validators: {},
    });
    const codeField = await client.fields.create(relaxableModel.id, {
      label: 'Code',
      api_key: 'code',
      field_type: 'string',
      localized: false,
      validators: {},
    });
    const modulesField = await client.fields.create(relaxableModel.id, {
      label: 'Modules',
      api_key: 'modules',
      field_type: 'rich_text',
      localized: true,
      validators: {
        rich_text_blocks: { item_types: [blockModel.id] },
        size: { min: 1 },
      },
    });
    const blockLabelField = await client.fields.create(blockModel.id, {
      label: 'Label',
      api_key: 'label',
      field_type: 'string',
      localized: false,
      validators: {},
    });
    return {
      itemTypeApiKeys: [apiKeys.relaxable],
      relaxableModelId: relaxableModel.id,
      blockModelId: blockModel.id,
      titleFieldId: titleField.id,
      scoreFieldId: scoreField.id,
      codeFieldId: codeField.id,
      modulesFieldId: modulesField.id,
      blockLabelFieldId: blockLabelField.id,
      schemaItemTypeIds: [relaxableModel.id, blockModel.id],
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating genuinely invalid current and published content',
    );
    const requiredLength = await sourceClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: '', it: ' ' },
      score: 15,
      code: 'required-length-code',
      modules: validLocalizedModules(seed.blockModelId),
    });
    await sourceClient.items.publish(requiredLength.id);
    await sourceClient.items.update(requiredLength.id, {
      title: { en: ' ', it: '' },
      score: 15,
      code: 'required-length-code',
    });

    const enumInvalid = await sourceClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: 'published denial', it: 'published refusal' },
      score: 15,
      code: 'enum-code',
      modules: validLocalizedModules(seed.blockModelId),
    });
    await sourceClient.items.publish(enumInvalid.id);
    await sourceClient.items.update(enumInvalid.id, {
      title: { en: 'current denial', it: 'current refusal' },
      score: 15,
      code: 'enum-code',
    });

    const numberRange = await sourceClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: 'approved', it: 'approved' },
      score: 1,
      code: 'number-range-code',
      modules: validLocalizedModules(seed.blockModelId),
    });
    await sourceClient.items.publish(numberRange.id);
    await sourceClient.items.update(numberRange.id, {
      title: { en: 'approved', it: 'approved' },
      score: 2,
      code: 'number-range-code',
    });

    const nestedBlockInvalidLabels = buildNestedBlockInvalidLabels();
    const nestedBlockInvalid = await sourceClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: 'approved', it: 'approved' },
      score: 15,
      code: 'nested-block-code',
      modules: {
        en: [nestedBlock(seed.blockModelId, nestedBlockInvalidLabels.en)],
        it: [nestedBlock(seed.blockModelId, nestedBlockInvalidLabels.it)],
      },
    });
    await sourceClient.items.publish(nestedBlockInvalid.id);
    await sourceClient.items.update(nestedBlockInvalid.id, {
      title: { en: 'approved', it: 'approved' },
      score: 16,
      code: 'nested-block-code',
    });

    const uniqueFirst = await sourceClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: 'approved', it: 'approved' },
      score: 15,
      code: 'duplicate-code',
      modules: validLocalizedModules(seed.blockModelId),
    });
    await sourceClient.items.publish(uniqueFirst.id);
    await sourceClient.items.update(uniqueFirst.id, {
      title: { en: 'approved', it: 'approved' },
      score: 16,
      code: 'duplicate-code',
    });

    const uniqueSecond = await sourceClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: 'approved', it: 'approved' },
      score: 17,
      code: 'duplicate-code',
      modules: validLocalizedModules(seed.blockModelId),
    });
    await sourceClient.items.publish(uniqueSecond.id);
    await sourceClient.items.update(uniqueSecond.id, {
      title: { en: 'approved', it: 'approved' },
      score: 18,
      code: 'duplicate-code',
    });

    const structuralSkip = await sourceClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: 'approved', it: 'approved' },
      score: 19,
      code: 'structural-source-code',
      modules: validLocalizedModules(seed.blockModelId),
    });
    await sourceClient.items.publish(structuralSkip.id);
    const collidingBlockId = await localizedNestedBlockId(
      sourceClient,
      structuralSkip.id,
      'en',
    );
    const destinationOwner = await destinationClient.items.create({
      item_type: { id: seed.relaxableModelId, type: 'item_type' },
      title: { en: 'approved', it: 'approved' },
      score: 20,
      code: 'structural-target-code',
      modules: {
        en: [
          nestedBlockWithId(
            seed.blockModelId,
            collidingBlockId,
            'approved block',
          ),
        ],
        it: [nestedBlock(seed.blockModelId, 'approved block')],
      },
    });
    await destinationClient.items.publish(destinationOwner.id);

    const contracts = buildRelaxableValidatorContracts();
    await updateValidatorsInBothEnvironments({
      sourceClient,
      destinationClient,
      updates: [
        [seed.titleFieldId, contracts.title.original],
        [seed.scoreFieldId, contracts.score.original],
        [seed.codeFieldId, contracts.code.original],
        [seed.blockLabelFieldId, contracts.blockLabel.original],
      ],
    });

    const relaxableRecordIds = [
      requiredLength.id,
      enumInvalid.id,
      numberRange.id,
      nestedBlockInvalid.id,
      uniqueFirst.id,
      uniqueSecond.id,
    ].sort(compareIds);
    const selectedRecordIds = [
      ...relaxableRecordIds,
      structuralSkip.id,
      destinationOwner.id,
    ];
    await waitForValidity(
      sourceClient,
      relaxableRecordIds.map((id) => ({
        id,
        current: false,
        published: false,
      })),
    );
    await waitForValidity(sourceClient, [
      { id: structuralSkip.id, current: true, published: true },
    ]);
    await waitForValidity(destinationClient, [
      { id: destinationOwner.id, current: true, published: true },
    ]);

    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureRawState(sourceClient, seed.itemTypeApiKeys, selectedRecordIds),
        captureRawState(
          destinationClient,
          seed.itemTypeApiKeys,
          selectedRecordIds,
        ),
        captureValidatorState(sourceClient, seed.schemaItemTypeIds),
        captureValidatorState(destinationClient, seed.schemaItemTypeIds),
      ]);

    assert.deepEqual(Object.keys(destination.current), [destinationOwner.id]);
    assert.deepEqual(Object.keys(destination.published), [destinationOwner.id]);
    assert.deepEqual(destinationValidators, sourceValidators);
    assertRelaxationFixtureValidators(sourceValidators, seed);
    assertInvalidPublishedSlices(source, relaxableRecordIds);
    assertSameNestedBlockIdsAcrossSlices(source, relaxableRecordIds);
    assertValidPublishedSlices(source, [structuralSkip.id]);
    assertValidPublishedSlices(destination, [destinationOwner.id]);

    return {
      relaxableRecordIds,
      recordIds: {
        requiredLength: requiredLength.id,
        enum: enumInvalid.id,
        numberRange: numberRange.id,
        nestedBlock: nestedBlockInvalid.id,
        unique: [uniqueFirst.id, uniqueSecond.id].sort(compareIds) as [
          string,
          string,
        ],
      },
      structuralSkipRecordId: structuralSkip.id,
      collidingBlockId,
      destinationOwnerId: destinationOwner.id,
      source,
      destination,
      validators: sourceValidators,
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    await assertRelaxationManifest(planFilePath, seed, expected);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log(
      '[content-diff e2e] Verifying invalid-content relaxation and restoration',
    );
    const selectedRecordIds = [
      ...expected.relaxableRecordIds,
      expected.structuralSkipRecordId,
      expected.destinationOwnerId,
    ];
    const [source, destination, applied] = await Promise.all([
      captureRawState(sourceClient, seed.itemTypeApiKeys, selectedRecordIds),
      captureRawState(
        destinationClient,
        seed.itemTypeApiKeys,
        selectedRecordIds,
      ),
      captureRawState(appliedClient, seed.itemTypeApiKeys, selectedRecordIds),
    ]);

    assert.deepEqual(source, expected.source, 'source content changed');
    assert.deepEqual(
      destination,
      expected.destination,
      'destination content changed',
    );
    for (const recordId of expected.relaxableRecordIds) {
      assert.deepEqual(
        applied.current[recordId],
        expected.source.current[recordId],
        `invalid current slice was not reproduced for ${recordId}`,
      );
      assert.deepEqual(
        applied.published[recordId],
        expected.source.published[recordId],
        `invalid published slice was not reproduced for ${recordId}`,
      );
    }
    assert.equal(
      applied.current[expected.structuralSkipRecordId],
      undefined,
      'structurally colliding aggregate was not skipped',
    );
    assert.equal(
      applied.published[expected.structuralSkipRecordId],
      undefined,
      'structurally colliding published aggregate unexpectedly appeared',
    );
    assert.deepEqual(
      applied.current[expected.destinationOwnerId],
      expected.destination.current[expected.destinationOwnerId],
      'destination owner of the colliding nested block was not preserved',
    );
    assert.deepEqual(
      applied.published[expected.destinationOwnerId],
      expected.destination.published[expected.destinationOwnerId],
      'published destination owner of the colliding nested block was not preserved',
    );

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
      'validators were not restored byte-equivalently',
    );
  },
};

export const invalidContentDefaultScenario: RealCmaScenario<
  DefaultSeed,
  DefaultExpected
> = {
  name: 'default invalid-content skip propagation, native draft saving, and invalid no-op',

  async seedSource({ client, runId }) {
    console.log('[content-diff e2e] Creating default invalid-content schema');
    const apiKeys = buildInvalidContentModelApiKeys(runId);
    const strictModel = await createModel(client, {
      name: `Strict invalid ${runId}`,
      apiKey: apiKeys.strict,
      allLocalesRequired: false,
      draftSavingActive: false,
    });
    const nativeDraftModel = await createModel(client, {
      name: `Native invalid draft ${runId}`,
      apiKey: apiKeys.nativeDraft,
      allLocalesRequired: false,
      draftSavingActive: true,
    });
    const strictTitleField = await client.fields.create(strictModel.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: {},
    });
    const strictRelatedField = await client.fields.create(strictModel.id, {
      label: 'Related',
      api_key: 'related',
      field_type: 'link',
      localized: false,
      validators: {
        item_item_type: { item_types: [strictModel.id] },
      },
    });
    const nativeTitleField = await client.fields.create(nativeDraftModel.id, {
      label: 'Title',
      api_key: 'title',
      field_type: 'string',
      localized: false,
      validators: { length: { min: 5 } },
    });

    const identicalInvalid = await client.items.create<StrictDefinition>({
      item_type: { id: strictModel.id, type: 'item_type' },
      title: '',
      related: null,
    });
    await client.fields.update(strictTitleField.id, {
      validators: { length: { min: 5 } },
    });
    await waitForValidity(client, [
      { id: identicalInvalid.id, current: false, published: null },
    ]);

    return {
      itemTypeApiKeys: [apiKeys.strict, apiKeys.nativeDraft],
      strictModelId: strictModel.id,
      nativeDraftModelId: nativeDraftModel.id,
      strictTitleFieldId: strictTitleField.id,
      strictRelatedFieldId: strictRelatedField.id,
      nativeTitleFieldId: nativeTitleField.id,
      identicalInvalidId: identicalInvalid.id,
      schemaItemTypeIds: [strictModel.id, nativeDraftModel.id],
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Creating strict invalid writes and a native invalid draft',
    );
    await sourceClient.fields.update(seed.strictTitleFieldId, {
      validators: {},
    });
    const strictInvalid = await sourceClient.items.create<StrictDefinition>({
      item_type: { id: seed.strictModelId, type: 'item_type' },
      title: '',
      related: null,
    });
    await sourceClient.items.publish<StrictDefinition>(strictInvalid.id);
    await sourceClient.items.update<StrictDefinition>(strictInvalid.id, {
      title: 'x',
      related: null,
    });
    const consumer = await sourceClient.items.create<StrictDefinition>({
      item_type: { id: seed.strictModelId, type: 'item_type' },
      title: 'consumer',
      related: strictInvalid.id,
    });
    await sourceClient.items.publish<StrictDefinition>(consumer.id);
    await sourceClient.fields.update(seed.strictTitleFieldId, {
      validators: { length: { min: 5 } },
    });

    const nativeInvalidDraft =
      await sourceClient.items.create<NativeDraftDefinition>({
        item_type: { id: seed.nativeDraftModelId, type: 'item_type' },
        title: '',
      });

    await waitForValidity(sourceClient, [
      {
        id: seed.identicalInvalidId,
        current: false,
        published: null,
      },
      { id: strictInvalid.id, current: false, published: false },
      { id: consumer.id, current: true, published: true },
      { id: nativeInvalidDraft.id, current: false, published: null },
    ]);
    await waitForValidity(destinationClient, [
      {
        id: seed.identicalInvalidId,
        current: false,
        published: null,
      },
    ]);

    const selectedRecordIds = [
      seed.identicalInvalidId,
      strictInvalid.id,
      consumer.id,
      nativeInvalidDraft.id,
    ];
    const [source, destination, sourceValidators, destinationValidators] =
      await Promise.all([
        captureRawState(sourceClient, seed.itemTypeApiKeys, selectedRecordIds),
        captureRawState(
          destinationClient,
          seed.itemTypeApiKeys,
          selectedRecordIds,
        ),
        captureValidatorState(sourceClient, seed.schemaItemTypeIds),
        captureValidatorState(destinationClient, seed.schemaItemTypeIds),
      ]);
    assert.deepEqual(destinationValidators, sourceValidators);
    assert.deepEqual(
      destination.current[seed.identicalInvalidId],
      source.current[seed.identicalInvalidId],
      'identical invalid target baseline differs before generation',
    );
    assert.equal(destination.published[seed.identicalInvalidId], undefined);
    assert.equal(destination.current[strictInvalid.id], undefined);
    assert.equal(destination.current[consumer.id], undefined);
    assert.equal(destination.current[nativeInvalidDraft.id], undefined);

    return {
      strictInvalidId: strictInvalid.id,
      propagatedConsumerId: consumer.id,
      nativeInvalidDraftId: nativeInvalidDraft.id,
      source,
      destination,
      validators: sourceValidators,
    };
  },

  async verifyGeneratedPlan({ seed, expected, planFilePath }) {
    await assertDefaultManifest(planFilePath, seed, expected);
  },

  async verify({
    seed,
    expected,
    sourceClient,
    destinationClient,
    appliedClient,
  }) {
    console.log('[content-diff e2e] Verifying conservative invalid handling');
    const selectedRecordIds = [
      seed.identicalInvalidId,
      expected.strictInvalidId,
      expected.propagatedConsumerId,
      expected.nativeInvalidDraftId,
    ];
    const [source, destination, applied] = await Promise.all([
      captureRawState(sourceClient, seed.itemTypeApiKeys, selectedRecordIds),
      captureRawState(
        destinationClient,
        seed.itemTypeApiKeys,
        selectedRecordIds,
      ),
      captureRawState(appliedClient, seed.itemTypeApiKeys, selectedRecordIds),
    ]);

    assert.deepEqual(source, expected.source, 'source content changed');
    assert.deepEqual(destination, expected.destination, 'destination changed');
    assert.deepEqual(
      applied.current[seed.identicalInvalidId],
      expected.destination.current[seed.identicalInvalidId],
      'identical invalid destination state was not left as a no-op',
    );
    assert.equal(applied.published[seed.identicalInvalidId], undefined);
    assert.equal(
      applied.current[expected.strictInvalidId],
      undefined,
      'strict invalid aggregate was not skipped',
    );
    assert.equal(
      applied.current[expected.propagatedConsumerId],
      undefined,
      'consumer of an absent skipped dependency was not propagated into the skip set',
    );
    assert.deepEqual(
      applied.current[expected.nativeInvalidDraftId],
      expected.source.current[expected.nativeInvalidDraftId],
      'native invalid draft was not reproduced',
    );
    assert.equal(
      applied.published[expected.nativeInvalidDraftId],
      undefined,
      'native invalid draft was unexpectedly published',
    );

    const [sourceValidators, destinationValidators, appliedValidators] =
      await Promise.all([
        captureValidatorState(sourceClient, seed.schemaItemTypeIds),
        captureValidatorState(destinationClient, seed.schemaItemTypeIds),
        captureValidatorState(appliedClient, seed.schemaItemTypeIds),
      ]);
    assert.deepEqual(sourceValidators, expected.validators);
    assert.deepEqual(destinationValidators, expected.validators);
    assert.deepEqual(appliedValidators, expected.validators);
  },
};

async function createModel(
  client: CmaClient.Client,
  options: Readonly<{
    name: string;
    apiKey: string;
    allLocalesRequired: boolean;
    draftSavingActive: boolean;
  }>,
) {
  return client.itemTypes.create({
    name: options.name,
    api_key: options.apiKey,
    singleton: false,
    all_locales_required: options.allLocalesRequired,
    sortable: false,
    modular_block: false,
    draft_mode_active: true,
    draft_saving_active: options.draftSavingActive,
    tree: false,
    collection_appearance: 'compact',
    inverse_relationships_enabled: false,
  });
}

function nestedBlock(blockModelId: string, label: string) {
  return CmaClient.buildBlockRecord({
    item_type: { id: blockModelId, type: 'item_type' },
    label,
  });
}

function nestedBlockWithId(blockModelId: string, id: string, label: string) {
  return CmaClient.buildBlockRecord({
    id,
    item_type: { id: blockModelId, type: 'item_type' },
    label,
  });
}

function validLocalizedModules(blockModelId: string) {
  return {
    en: [nestedBlock(blockModelId, 'approved block')],
    it: [nestedBlock(blockModelId, 'approved block')],
  };
}

async function localizedNestedBlockId(
  client: CmaClient.Client,
  recordId: string,
  locale: string,
): Promise<string> {
  const record = requiredObject(
    await client.items.find(recordId, { nested: true }),
    `nested record ${recordId}`,
  );
  const modules = requiredObject(record.modules, `${recordId}.modules`);
  const localizedBlocks = requiredArray(
    modules[locale],
    `${recordId}.modules.${locale}`,
  );
  const block = requiredObject(
    localizedBlocks[0],
    `${recordId}.modules.${locale}[0]`,
  );
  return requiredString(block.id, `${recordId}.modules.${locale}[0].id`);
}

async function updateValidatorsInBothEnvironments({
  sourceClient,
  destinationClient,
  updates,
}: Readonly<{
  sourceClient: CmaClient.Client;
  destinationClient: CmaClient.Client;
  updates: readonly (readonly [
    string,
    Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  ])[];
}>): Promise<void> {
  for (const [fieldId, validators] of updates) {
    await sourceClient.fields.update(fieldId, { validators });
    await destinationClient.fields.update(fieldId, { validators });
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
    const converged = records.every(({ meta }, index) => {
      const expectation = expectations[index];
      return (
        meta.is_current_version_valid === expectation.current &&
        meta.is_published_version_valid === expectation.published
      );
    });
    if (converged) return;

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

async function captureRawState(
  client: CmaClient.Client,
  modelApiKeys: readonly string[],
  selectedRecordIds: readonly string[],
): Promise<RawState> {
  const models = await client.itemTypes.list();
  const modelIds = modelApiKeys.map((apiKey) => {
    const model = models.find(({ api_key }) => api_key === apiKey);
    assert.ok(model, `model ${apiKey} not found while capturing raw state`);
    return model.id;
  });
  const selectedIds = new Set(selectedRecordIds);
  const captureSlice = async (version: 'current' | 'published') => {
    const records: CanonicalRecord[] = [];

    for (const modelId of modelIds) {
      const response = await client.items.rawList({
        filter: { type: modelId },
        nested: true,
        order_by: 'id_ASC',
        version,
        page: { offset: 0, limit: 30 },
      });
      assert.ok(
        response.meta.total_count <= 30,
        `invalid-content fixture unexpectedly exceeded one nested page for model ${modelId}`,
      );
      for (const resource of response.data) {
        if (selectedIds.has(resource.id)) {
          records.push(parseCanonicalRecord(resource, modelId));
        }
      }
    }

    return Object.fromEntries(
      records
        .sort((left, right) => compareIds(left.id, right.id))
        .map((record) => [record.id, record]),
    );
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
  assert.equal(itemTypeId, expectedItemTypeId);
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
    validity: {
      current: nullableBoolean(
        meta.is_current_version_valid,
        `${id}.meta.is_current_version_valid`,
      ),
      published: nullableBoolean(
        meta.is_published_version_valid,
        `${id}.meta.is_published_version_valid`,
      ),
    },
  };
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

async function assertRelaxationManifest(
  planFilePath: string,
  seed: RelaxationSeed,
  expected: RelaxationExpected,
): Promise<void> {
  const plan = await readPlan(planFilePath);
  const invalidContent = requiredObject(
    plan.invalidContent,
    'plan.invalidContent',
  );
  const relaxations = requiredArray(
    invalidContent.validatorRelaxations,
    'validator relaxations',
  ).map((entry) => requiredObject(entry, 'validator relaxation'));
  const skipped = requiredArray(
    invalidContent.skippedRecords,
    'skipped records',
  ).map((entry) => requiredObject(entry, 'skipped record'));
  const liveFieldMetadata = expected.validators.map((field) => ({
    fieldId: field.fieldId,
    itemTypeId: field.itemTypeId,
    apiKey: field.apiKey,
    validatorKeys: Object.keys(
      requiredObject(field.validators, `${field.apiKey} validators`),
    ).sort(),
  }));
  const plannedFieldMetadata = requiredArray(
    requiredObject(plan.schema, 'plan schema').itemTypes,
    'plan schema item types',
  )
    .flatMap((itemType, itemTypeIndex) => {
      const itemTypeObject = requiredObject(
        itemType,
        `plan item type ${itemTypeIndex}`,
      );
      return requiredArray(
        itemTypeObject.fields,
        `plan item type ${itemTypeIndex} fields`,
      ).map((field, fieldIndex) => {
        const fieldObject = requiredObject(
          field,
          `plan item type ${itemTypeIndex} field ${fieldIndex}`,
        );
        return {
          fieldId: fieldObject.id,
          itemTypeId: itemTypeObject.id,
          apiKey: fieldObject.apiKey,
          validatorKeys: Object.keys(
            requiredObject(
              fieldObject.validators,
              `plan field ${String(fieldObject.id)} validators`,
            ),
          ).sort(),
        };
      });
    })
    .sort((left, right) =>
      String(left.fieldId).localeCompare(String(right.fieldId)),
    );
  console.log(
    `[content-diff e2e] Generated invalid-content classification ${JSON.stringify(
      {
        recordRoles: {
          ...expected.recordIds,
          structuralSkip: expected.structuralSkipRecordId,
          collidingBlock: expected.collidingBlockId,
          destinationOwner: expected.destinationOwnerId,
        },
        detectedRecordIds: invalidContent.detectedRecordIds,
        migratedRecordIds: invalidContent.migratedRecordIds,
        liveFields: liveFieldMetadata,
        plannedFields: plannedFieldMetadata,
        relaxations: relaxations.map((entry) => ({
          fieldId: entry.fieldId,
          affectedRecordIds: entry.affectedRecordIds,
          relaxedValidatorKeys: entry.relaxedValidatorKeys,
        })),
        skipped: skipped.map((entry) => ({
          id: entry.id,
          disposition: entry.disposition,
          reasons: requiredArray(entry.reasons, 'skipped reasons').map(
            (reason) => {
              const object = requiredObject(reason, 'skipped reason');
              return {
                code: object.code,
                slice: object.slice,
                fieldId: object.fieldId,
                validatorKey: object.validatorKey,
              };
            },
          ),
        })),
      },
    )}`,
  );
  const byFieldId = new Map(
    relaxations.map((entry) => [
      requiredString(entry.fieldId, 'relaxation fieldId'),
      entry,
    ]),
  );
  const contracts = buildRelaxableValidatorContracts();
  const expectedByFieldId = new Map<string, ValidatorContract>([
    [seed.titleFieldId, contracts.title],
    [seed.scoreFieldId, contracts.score],
    [seed.codeFieldId, contracts.code],
    [seed.blockLabelFieldId, contracts.blockLabel],
  ]);

  assert.deepEqual(
    [...byFieldId.keys()].sort(compareIds),
    [...expectedByFieldId.keys()].sort(compareIds),
    'manifest did not contain exactly the expected validator relaxations',
  );
  for (const [fieldId, contract] of expectedByFieldId) {
    const relaxation = byFieldId.get(fieldId);
    assert.ok(relaxation, `missing relaxation for ${fieldId}`);
    assert.deepEqual(relaxation.originalValidators, contract.original);
    assert.deepEqual(relaxation.relaxedValidators, contract.relaxed);
    assert.deepEqual(relaxation.relaxedValidatorKeys, contract.removed);
  }
  const expectedAffectedRecordIds = new Map<string, readonly string[]>([
    [
      seed.titleFieldId,
      [expected.recordIds.requiredLength, expected.recordIds.enum],
    ],
    [seed.scoreFieldId, [expected.recordIds.numberRange]],
    [seed.codeFieldId, expected.recordIds.unique],
    [seed.blockLabelFieldId, [expected.recordIds.nestedBlock]],
  ]);
  for (const [fieldId, affectedRecordIds] of expectedAffectedRecordIds) {
    const relaxation = byFieldId.get(fieldId);
    assert.ok(relaxation, `missing relaxation for ${fieldId}`);
    assert.deepEqual(
      requiredArray(
        relaxation.affectedRecordIds,
        `${fieldId} affected record IDs`,
      )
        .map(String)
        .sort(compareIds),
      [...affectedRecordIds].sort(compareIds),
    );
  }
  assert.equal(byFieldId.has(seed.modulesFieldId), false);

  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, expected.structuralSkipRecordId);
  assert.equal(skipped[0].disposition, 'must_remain_absent');
  const structuralReasons = requiredArray(
    skipped[0].reasons,
    'structural skip reasons',
  ).map((entry) => requiredObject(entry, 'structural skip reason'));
  assert.ok(structuralReasons.length > 0);
  assert.ok(
    structuralReasons.every(
      ({ code, dependencyId }) =>
        code === 'ENTITY_ID_COLLISION' &&
        dependencyId === expected.collidingBlockId,
    ),
    'structural skip contained a non-collision reason',
  );
  assert.ok(
    requiredArray(
      skipped[0].sourceNestedBlockIds,
      'source nested block IDs',
    ).includes(expected.collidingBlockId),
  );
  assert.deepEqual(skipped[0].preservedExternalBlockIds, [
    expected.collidingBlockId,
  ]);

  assert.deepEqual(
    requiredArray(invalidContent.detectedRecordIds, 'detected record IDs')
      .map(String)
      .sort(compareIds),
    [...expected.relaxableRecordIds, expected.structuralSkipRecordId].sort(
      compareIds,
    ),
  );
  assert.deepEqual(
    requiredArray(invalidContent.migratedRecordIds, 'migrated record IDs')
      .map(String)
      .sort(compareIds),
    [...expected.relaxableRecordIds].sort(compareIds),
  );
  assert.equal(invalidContent.propagatedSkipCount, 0);
  assert.equal(
    requiredObject(plan.requiredPermissions, 'required permissions').editSchema,
    true,
  );
  assert.equal(
    requiredObject(plan.options, 'plan options').migrateInvalidContent,
    true,
  );
}

function assertRelaxationFixtureValidators(
  validators: ValidatorState,
  seed: RelaxationSeed,
): void {
  const contracts = buildRelaxableValidatorContracts();
  const byFieldId = new Map(validators.map((field) => [field.fieldId, field]));
  const expected = new Map<string, CanonicalValue>([
    [seed.titleFieldId, contracts.title.original as CanonicalValue],
    [seed.scoreFieldId, contracts.score.original as CanonicalValue],
    [seed.codeFieldId, contracts.code.original as CanonicalValue],
    [seed.blockLabelFieldId, contracts.blockLabel.original as CanonicalValue],
    [
      seed.modulesFieldId,
      {
        rich_text_blocks: { item_types: [seed.blockModelId] },
        size: { min: 1 },
      },
    ],
  ]);

  for (const [fieldId, expectedValidators] of expected) {
    const field = byFieldId.get(fieldId);
    assert.ok(field, `fixture field ${fieldId} was not captured`);
    assert.deepEqual(
      field.validators,
      expectedValidators,
      `fixture field ${field.apiKey} did not persist its exact validator contract`,
    );
  }
}

async function assertDefaultManifest(
  planFilePath: string,
  seed: DefaultSeed,
  expected: DefaultExpected,
): Promise<void> {
  const plan = await readPlan(planFilePath);
  const invalidContent = requiredObject(
    plan.invalidContent,
    'plan.invalidContent',
  );
  assert.deepEqual(
    requiredArray(invalidContent.validatorRelaxations, 'validator relaxations'),
    [],
  );
  const skipped = requiredArray(
    invalidContent.skippedRecords,
    'skipped records',
  ).map((entry) => requiredObject(entry, 'skipped record'));
  const skippedById = new Map(
    skipped.map((entry) => [requiredString(entry.id, 'skipped ID'), entry]),
  );
  assert.deepEqual(
    [...skippedById.keys()].sort(compareIds),
    [expected.strictInvalidId, expected.propagatedConsumerId].sort(compareIds),
  );
  assert.equal(
    skippedById.get(expected.strictInvalidId)?.disposition,
    'must_remain_absent',
  );
  assert.equal(
    skippedById.get(expected.propagatedConsumerId)?.disposition,
    'must_remain_absent',
  );
  const directCodes = requiredArray(
    skippedById.get(expected.strictInvalidId)?.reasons,
    'strict invalid reasons',
  )
    .map((entry) => requiredObject(entry, 'strict invalid reason').code)
    .sort();
  assert.deepEqual(directCodes, ['INVALID_CURRENT', 'INVALID_PUBLISHED']);
  const propagatedReasons = requiredArray(
    skippedById.get(expected.propagatedConsumerId)?.reasons,
    'propagated skip reasons',
  ).map((entry) => requiredObject(entry, 'propagated skip reason'));
  assert.deepEqual(
    propagatedReasons.map(({ code }) => code),
    ['DEPENDENCY_ON_SKIPPED_RECORD'],
  );
  assert.equal(propagatedReasons[0].dependencyId, expected.strictInvalidId);
  assert.deepEqual(propagatedReasons[0].dependencyChain, [
    expected.propagatedConsumerId,
    expected.strictInvalidId,
  ]);

  assert.equal(invalidContent.propagatedSkipCount, 1);
  const detectedRecordIds = requiredArray(
    invalidContent.detectedRecordIds,
    'detected record IDs',
  )
    .map(String)
    .sort(compareIds);
  const migratedRecordIds = requiredArray(
    invalidContent.migratedRecordIds,
    'migrated record IDs',
  )
    .map(String)
    .sort(compareIds);
  assert.deepEqual(
    detectedRecordIds,
    [
      seed.identicalInvalidId,
      expected.strictInvalidId,
      expected.propagatedConsumerId,
      expected.nativeInvalidDraftId,
    ].sort(compareIds),
  );
  assert.deepEqual(migratedRecordIds, [expected.nativeInvalidDraftId]);
  for (const skippedRecordId of skippedById.keys()) {
    assert.ok(
      detectedRecordIds.includes(skippedRecordId),
      `skipped record ${skippedRecordId} was not classified as detected`,
    );
    assert.equal(
      migratedRecordIds.includes(skippedRecordId),
      false,
      `skipped record ${skippedRecordId} was also classified as migrated`,
    );
  }
  assert.equal(
    requiredObject(plan.requiredPermissions, 'required permissions').editSchema,
    false,
  );
  assert.equal(
    requiredObject(plan.options, 'plan options').migrateInvalidContent,
    false,
  );
  const warnings = requiredArray(plan.warnings, 'plan warnings').map((entry) =>
    requiredObject(entry, 'plan warning'),
  );
  assert.ok(
    warnings.some(
      ({ code, entityIds }) =>
        code === 'INVALID_CONTENT_NOOP' &&
        Array.isArray(entityIds) &&
        entityIds.includes(seed.identicalInvalidId),
    ),
    'manifest did not report the identical invalid target state as a no-op',
  );
}

async function readPlan(
  planFilePath: string,
): Promise<Record<string, unknown>> {
  const envelope = requiredObject(
    JSON.parse(await readFile(planFilePath, 'utf8')),
    'plan envelope',
  );
  return requiredObject(envelope.plan, 'plan');
}

function assertInvalidPublishedSlices(
  source: RawState,
  recordIds: readonly string[],
): void {
  for (const recordId of recordIds) {
    assert.equal(source.current[recordId]?.validity.current, false);
    assert.equal(source.current[recordId]?.validity.published, false);
    assert.equal(source.published[recordId]?.validity.current, false);
    assert.equal(source.published[recordId]?.validity.published, false);
  }
}

function assertSameNestedBlockIdsAcrossSlices(
  source: RawState,
  recordIds: readonly string[],
): void {
  for (const recordId of recordIds) {
    const current = source.current[recordId];
    const published = source.published[recordId];
    assert.ok(current, `missing current invalid fixture ${recordId}`);
    assert.ok(published, `missing published invalid fixture ${recordId}`);
    const currentIds = nestedBlockIds(current.fields);
    const publishedIds = nestedBlockIds(published.fields);
    assert.deepEqual(
      currentIds,
      publishedIds,
      `invalid fixture ${recordId} introduced a fresh current nested block ID`,
    );
    assert.ok(
      currentIds.length > 0,
      `invalid fixture ${recordId} has no nested block coverage`,
    );
  }
}

function nestedBlockIds(value: CanonicalValue): string[] {
  const result = new Set<string>();
  const visit = (candidate: CanonicalValue): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (candidate.kind === 'nestedItem' && typeof candidate.id === 'string') {
      result.add(candidate.id);
    }
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...result].sort(compareIds);
}

function assertValidPublishedSlices(
  state: RawState,
  recordIds: readonly string[],
): void {
  for (const recordId of recordIds) {
    assert.equal(state.current[recordId]?.validity.current, true);
    assert.equal(state.current[recordId]?.validity.published, true);
    assert.equal(state.published[recordId]?.validity.current, true);
    assert.equal(state.published[recordId]?.validity.published, true);
  }
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
): Record<string, unknown> {
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
