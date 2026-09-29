import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';
import type { RealCmaScenario, RealCmaScenarioSeed } from './real-cma-harness';

const EXISTING_HTML = '<p>Existing <br /> &copy; bytes</p>';
const SOURCE_ONLY_HTML = '<p>Source-only <br /> &copy; bytes</p>';

export const SANITIZED_HTML_WRITE_GUARD_FAILURE_PATTERN =
  /CMA may rewrite 2 projected text value\(s\) during attribute-bearing CREATE\/UPDATE stages[\s\S]*No migration artifacts were created/;

export const PROVEN_FEATURES = [
  'active-sanitized-html-source-only-create-fails-before-artifacts',
  'active-sanitized-html-full-rehydrate-current-restore-fails-before-artifacts',
  'non-sanitizer-validator-relaxation-does-not-disable-sanitized-html',
  'noncanonical-current-and-published-html-bytes-remain-exact',
  'expected-generation-failure-preserves-source-and-target-fingerprints',
  'expected-generation-failure-leaves-zero-migration-artifacts',
] as const;

type SanitizedHtmlDefinition = {
  settings: { locales: string };
  itemTypeId: string;
  fields: {
    body: { type: 'text'; localized: false };
    marker: { type: 'string'; localized: false };
  };
};

type SanitizedHtmlSeed = RealCmaScenarioSeed &
  Readonly<{
    modelId: string;
    bodyFieldId: string;
    markerFieldId: string;
    existingRecordId: string;
  }>;

export type SanitizedHtmlRawRecord = Readonly<{
  id: string;
  body: string;
  marker: string;
  currentValid: boolean;
  publishedValid: boolean | null;
}>;

export type SanitizedHtmlRawState = Readonly<{
  current: SanitizedHtmlRawRecord;
  published: SanitizedHtmlRawRecord;
}>;

type SanitizedHtmlExpected = Readonly<{
  sourceOnlyRecordId: string;
  sourceExisting: SanitizedHtmlRawState;
  sourceOnly: SanitizedHtmlRawState;
  destinationExisting: SanitizedHtmlRawState;
}>;

export const sanitizedHtmlWriteGuardScenario: RealCmaScenario<
  SanitizedHtmlSeed,
  SanitizedHtmlExpected
> = {
  name: 'reject active sanitizer rewrites across create and full-rehydrate update',
  contentDiffArgs: ['--migrate-invalid-content'],
  expectedGenerationFailure: {
    messagePattern: SANITIZED_HTML_WRITE_GUARD_FAILURE_PATTERN,
  },

  async seedSource({ client, runId }) {
    console.log(
      '[content-diff e2e] Creating historical sanitized_html byte fixture',
    );
    const suffix = createHash('sha256')
      .update(runId)
      .digest('hex')
      .slice(0, 12);
    const modelApiKey = `cde2e_sh_r${suffix}`;
    const model = await client.itemTypes.create({
      name: `Sanitized HTML guard ${runId}`,
      api_key: modelApiKey,
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
    const bodyField = await client.fields.create(model.id, {
      label: 'Body',
      api_key: 'body',
      field_type: 'text',
      localized: false,
      default_value: null,
      validators: {
        sanitized_html: { sanitize_before_validation: false },
      },
    });
    const markerField = await client.fields.create(model.id, {
      label: 'Marker',
      api_key: 'marker',
      field_type: 'string',
      localized: false,
      default_value: null,
      validators: {},
    });
    const existing = await client.items.create<SanitizedHtmlDefinition>({
      item_type: { id: model.id, type: 'item_type' },
      body: EXISTING_HTML,
      marker: '',
    });
    await client.items.publish<SanitizedHtmlDefinition>(existing.id);

    const seeded = await captureSanitizedHtmlRawState(client, existing.id);
    assert.equal(seeded.current.body, EXISTING_HTML);
    assert.equal(seeded.published.body, EXISTING_HTML);

    return {
      itemTypeApiKeys: [modelApiKey],
      modelId: model.id,
      bodyFieldId: bodyField.id,
      markerFieldId: markerField.id,
      existingRecordId: existing.id,
    };
  },

  async introduceDrift({ seed, sourceClient, destinationClient }) {
    console.log(
      '[content-diff e2e] Persisting source drift before enabling sanitizer preprocessing',
    );
    const sourceExisting = await sourceClient.items.find(
      seed.existingRecordId,
      { version: 'current', nested: false },
    );
    await sourceClient.items.update<SanitizedHtmlDefinition>(
      seed.existingRecordId,
      {
        marker: 'source current marker',
        meta: { current_version: sourceExisting.meta.current_version },
      },
    );
    const sourceOnly = await sourceClient.items.create<SanitizedHtmlDefinition>(
      {
        item_type: { id: seed.modelId, type: 'item_type' },
        body: SOURCE_ONLY_HTML,
        marker: 'source-only marker',
      },
    );
    await sourceClient.items.publish<SanitizedHtmlDefinition>(sourceOnly.id);

    const beforeActivation = await Promise.all([
      captureSanitizedHtmlRawState(sourceClient, seed.existingRecordId),
      captureSanitizedHtmlRawState(sourceClient, sourceOnly.id),
      captureSanitizedHtmlRawState(destinationClient, seed.existingRecordId),
    ]);
    assertHistoricalBytes(beforeActivation[0], EXISTING_HTML);
    assertHistoricalBytes(beforeActivation[1], SOURCE_ONLY_HTML);
    assertHistoricalBytes(beforeActivation[2], EXISTING_HTML);

    console.log(
      '[content-diff e2e] Enabling sanitizer and a separate required validator without rewriting records',
    );
    await Promise.all([
      sourceClient.fields.update(seed.bodyFieldId, {
        validators: {
          sanitized_html: { sanitize_before_validation: true },
        },
      }),
      destinationClient.fields.update(seed.bodyFieldId, {
        validators: {
          sanitized_html: { sanitize_before_validation: true },
        },
      }),
    ]);
    await Promise.all([
      sourceClient.fields.update(seed.markerFieldId, {
        validators: { required: {} },
      }),
      destinationClient.fields.update(seed.markerFieldId, {
        validators: { required: {} },
      }),
    ]);

    await Promise.all([
      waitForValidity(sourceClient, seed.existingRecordId, true, false),
      waitForValidity(sourceClient, sourceOnly.id, true, true),
      waitForValidity(destinationClient, seed.existingRecordId, false, false),
    ]);

    const [sourceExistingState, sourceOnlyState, destinationExistingState] =
      await Promise.all([
        captureSanitizedHtmlRawState(sourceClient, seed.existingRecordId),
        captureSanitizedHtmlRawState(sourceClient, sourceOnly.id),
        captureSanitizedHtmlRawState(destinationClient, seed.existingRecordId),
      ]);
    assertHistoricalBytes(sourceExistingState, EXISTING_HTML);
    assertHistoricalBytes(sourceOnlyState, SOURCE_ONLY_HTML);
    assertHistoricalBytes(destinationExistingState, EXISTING_HTML);
    assert.equal(sourceExistingState.current.marker, 'source current marker');
    assert.equal(sourceExistingState.published.marker, '');
    assert.equal(destinationExistingState.current.marker, '');
    assert.equal(destinationExistingState.published.marker, '');

    const [sourceBody, targetBody, sourceMarker, targetMarker] =
      await Promise.all([
        sourceClient.fields.find(seed.bodyFieldId),
        destinationClient.fields.find(seed.bodyFieldId),
        sourceClient.fields.find(seed.markerFieldId),
        destinationClient.fields.find(seed.markerFieldId),
      ]);
    for (const field of [sourceBody, targetBody]) {
      assert.deepEqual(field.validators, {
        sanitized_html: { sanitize_before_validation: true },
      });
    }
    for (const field of [sourceMarker, targetMarker]) {
      assert.deepEqual(field.validators, { required: {} });
    }

    return {
      sourceOnlyRecordId: sourceOnly.id,
      sourceExisting: sourceExistingState,
      sourceOnly: sourceOnlyState,
      destinationExisting: destinationExistingState,
    };
  },
};

export async function captureSanitizedHtmlRawState(
  client: CmaClient.Client,
  recordId: string,
): Promise<SanitizedHtmlRawState> {
  const [current, published] = await Promise.all([
    client.items.rawFind<SanitizedHtmlDefinition>(recordId, {
      version: 'current',
      nested: false,
    }),
    client.items.rawFind<SanitizedHtmlDefinition>(recordId, {
      version: 'published',
      nested: false,
    }),
  ]);
  return {
    current: projectSanitizedHtmlRawRecord(current, recordId, 'current'),
    published: projectSanitizedHtmlRawRecord(published, recordId, 'published'),
  };
}

export function projectSanitizedHtmlRawRecord(
  response: unknown,
  recordId: string,
  version: 'current' | 'published',
): SanitizedHtmlRawRecord {
  const envelope = object(response, `${recordId}.${version}.response`);
  const data = object(envelope.data, `${recordId}.${version}.data`);
  assert.equal(data.type, 'item');
  assert.equal(data.id, recordId);
  const attributes = object(
    data.attributes,
    `${recordId}.${version}.attributes`,
  );
  const meta = object(data.meta, `${recordId}.${version}.meta`);
  return {
    id: recordId,
    body: stringValue(attributes.body, `${recordId}.${version}.body`),
    marker: stringValue(attributes.marker, `${recordId}.${version}.marker`),
    currentValid: booleanValue(
      meta.is_current_version_valid,
      `${recordId}.${version}.is_current_version_valid`,
    ),
    publishedValid:
      meta.is_published_version_valid === null
        ? null
        : booleanValue(
            meta.is_published_version_valid,
            `${recordId}.${version}.is_published_version_valid`,
          ),
  };
}

function assertHistoricalBytes(
  state: SanitizedHtmlRawState,
  expected: string,
): void {
  assert.equal(state.current.body, expected);
  assert.equal(state.published.body, expected);
}

async function waitForValidity(
  client: CmaClient.Client,
  recordId: string,
  currentValid: boolean,
  publishedValid: boolean,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const record = await client.items.find(recordId, {
      version: 'current',
      nested: false,
    });
    if (
      record.meta.is_current_version_valid === currentValid &&
      record.meta.is_published_version_valid === publishedValid
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `record ${recordId} did not reach validity current=${String(
      currentValid,
    )} published=${String(publishedValid)}`,
  );
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} is not a string`);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} is not a boolean`);
  return value;
}
