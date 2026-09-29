import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';

export const RESERVED_CONTENT_DIFF_MODEL_API_KEY =
  'datocms_content_diff' as const;

export interface RawCmaSelection {
  modelId: string;
  recordIds: string[];
}

export interface RawCmaRecord {
  id: string;
  itemTypeId: string;
  title: string | null;
  body: string | null;
  related: string | null;
}

export interface RawCmaState {
  current: RawCmaRecord[];
  published: RawCmaRecord[];
  sliceIds: {
    current: string[];
    published: string[];
  };
}

/**
 * Golden-path oracle for the first real-CMA lane. This deliberately consumes
 * raw JSON:API responses and does not import content-diff snapshot,
 * canonicalization, planning, or runtime code.
 */
export async function captureRawCmaState(
  client: CmaClient.Client,
  selection: RawCmaSelection,
): Promise<RawCmaState> {
  return captureRawCmaStateFromPort(
    {
      rawListItems: async (query) =>
        client.items.rawList(query as never) as Promise<unknown>,
    },
    selection,
  );
}

export interface RawCmaReadPort {
  rawListItems(query: RawItemListQuery): Promise<unknown>;
}

export interface RawItemListQuery {
  filter: { type: string };
  nested: true;
  order_by: 'id_ASC';
  page: { offset: number; limit: 30 };
  version: 'current' | 'published';
}

export async function captureRawCmaStateFromPort(
  port: RawCmaReadPort,
  selection: RawCmaSelection,
): Promise<RawCmaState> {
  assertNonEmptyString(selection.modelId, 'selection.modelId');
  const selectedIds = new Set(selection.recordIds);
  if (selectedIds.size !== selection.recordIds.length) {
    throw new RawCmaOracleError('Selection contains duplicate record IDs.');
  }
  selection.recordIds.forEach((id, index) =>
    assertNonEmptyString(id, `selection.recordIds[${index}]`),
  );

  const [currentResources, publishedResources] = await Promise.all([
    readAllItemPages(port, selection.modelId, 'current'),
    readAllItemPages(port, selection.modelId, 'published'),
  ]);
  const select = (resources: RawResource[]) =>
    resources
      .filter(({ id }) => selectedIds.has(id))
      .map((resource) => parseGoldenRecord(resource, selection.modelId))
      .sort(compareRecords);
  const current = select(currentResources);
  const published = select(publishedResources);

  return {
    current,
    published,
    sliceIds: {
      current: current.map(({ id }) => id),
      published: published.map(({ id }) => id),
    },
  };
}

export function mergeRawCmaStates(...states: RawCmaState[]): RawCmaState {
  const mergeSlice = (slice: 'current' | 'published'): RawCmaRecord[] => {
    const byId = new Map<string, RawCmaRecord>();
    for (const state of states) {
      for (const record of state[slice]) {
        const previous = byId.get(record.id);
        if (previous && stableJson(previous) !== stableJson(record)) {
          throw new RawCmaOracleError(
            `Cannot merge conflicting ${slice} records with ID ${record.id}.`,
          );
        }
        byId.set(record.id, record);
      }
    }
    return [...byId.values()].sort(compareRecords);
  };
  const current = mergeSlice('current');
  const published = mergeSlice('published');

  return {
    current,
    published,
    sliceIds: {
      current: current.map(({ id }) => id),
      published: published.map(({ id }) => id),
    },
  };
}

export function remapRawCmaState(
  state: RawCmaState,
  aliases: Readonly<Record<string, string>>,
): RawCmaState {
  const remapSlice = (records: RawCmaRecord[]) =>
    records
      .map((record) => ({
        ...record,
        id: aliases[record.id] ?? record.id,
        related: record.related
          ? aliases[record.related] ?? record.related
          : null,
      }))
      .sort(compareRecords);
  const current = remapSlice(state.current);
  const published = remapSlice(state.published);

  return {
    current,
    published,
    sliceIds: {
      current: current.map(({ id }) => id),
      published: published.map(({ id }) => id),
    },
  };
}

export function assertRawCmaState(
  actual: RawCmaState,
  expected: RawCmaState,
): void {
  const actualJson = stableJson(actual);
  const expectedJson = stableJson(expected);
  if (actualJson !== expectedJson) {
    throw new RawCmaOracleError(
      `Raw CMA state mismatch.\nExpected: ${expectedJson}\nActual:   ${actualJson}`,
    );
  }
}

export type LegacyEntityType =
  | 'record'
  | 'block'
  | 'upload'
  | 'upload_collection';

export interface LegacyAlias {
  entityType: LegacyEntityType;
  sourceId: string;
  targetId: string;
}

export interface RawLedgerBatch {
  batchId: string;
  chunkCount: number;
  recordIds: string[];
  wholeHash: string;
  entries: LegacyAlias[];
}

export interface RawLedgerState {
  present: boolean;
  projectId: string;
  modelId: string | null;
  recordHashes: Record<string, string>;
  batches: RawLedgerBatch[];
  entries: LegacyAlias[];
}

export interface RawLedgerPayload {
  projectId: string;
  includedSchemaResources: unknown[];
  menuItems: unknown[];
  schemaMenuItems: unknown[];
  itemTypeFilters: unknown[];
  currentRecords: unknown[];
  publishedRecords: unknown[];
}

/**
 * Pure ledger inspector used by both offline tests and a live capture adapter.
 * It validates the exact reserved schema and the append-only batch format.
 */
export function inspectRawLedgerPayload(
  payload: RawLedgerPayload,
): RawLedgerState {
  assertNonEmptyString(payload.projectId, 'ledger project ID');
  const resources = payload.includedSchemaResources.map((value, index) =>
    parseResource(value, `includedSchemaResources[${index}]`),
  );
  const models = resources.filter(
    (resource) =>
      resource.type === 'item_type' &&
      resource.attributes.api_key === RESERVED_CONTENT_DIFF_MODEL_API_KEY,
  );

  if (models.length === 0) {
    if (
      payload.currentRecords.length > 0 ||
      payload.publishedRecords.length > 0
    ) {
      throw new RawCmaOracleError(
        'Ledger records are visible while the reserved model is absent.',
      );
    }
    return {
      present: false,
      projectId: payload.projectId,
      modelId: null,
      recordHashes: {},
      batches: [],
      entries: [],
    };
  }
  if (models.length !== 1) {
    throw new RawCmaOracleError(
      'The reserved ledger API key resolves to more than one model.',
    );
  }

  const model = models[0];
  assertReservedLedgerSchema(
    model,
    resources,
    payload.menuItems,
    payload.schemaMenuItems,
    payload.itemTypeFilters,
  );
  if (payload.publishedRecords.length > 0) {
    throw new RawCmaOracleError(
      'Ledger records must never have a published slice.',
    );
  }

  const parsedRecords = payload.currentRecords.map((value, index) =>
    parseLedgerRecord(value, index, model.id, payload.projectId),
  );
  const recordIds = new Set<string>();
  const recordNames = new Set<string>();
  for (const record of parsedRecords) {
    if (recordIds.has(record.id) || recordNames.has(record.name)) {
      throw new RawCmaOracleError(
        'Ledger records contain duplicate IDs or deterministic names.',
      );
    }
    recordIds.add(record.id);
    recordNames.add(record.name);
  }

  const byBatch = new Map<string, ParsedLedgerRecord[]>();
  for (const record of parsedRecords) {
    byBatch.set(record.document.batchId, [
      ...(byBatch.get(record.document.batchId) ?? []),
      record,
    ]);
  }

  const batches: RawLedgerBatch[] = [];
  const sourceClaims = new Map<string, LegacyAlias>();
  const targetClaims = new Map<string, LegacyAlias>();
  for (const [batchId, records] of [...byBatch].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    records.sort(
      (left, right) => left.document.chunkIndex - right.document.chunkIndex,
    );
    const chunkCount = records[0].document.chunkCount;
    const wholeHash = records[0].document.wholeHash;
    if (
      records.length !== chunkCount ||
      records.some(
        ({ document }, index) =>
          document.batchId !== batchId ||
          document.chunkIndex !== index ||
          document.chunkCount !== chunkCount ||
          document.wholeHash !== wholeHash,
      )
    ) {
      throw new RawCmaOracleError(
        `Ledger batch ${batchId} is incomplete, duplicated, or inconsistent.`,
      );
    }

    const entries = records.flatMap(({ document }) => document.entries);
    assertStrictlySortedAliases(entries, `ledger batch ${batchId}`);
    if (sha256(stableJson(entries)) !== wholeHash) {
      throw new RawCmaOracleError(
        `Ledger batch ${batchId} failed its whole-batch checksum.`,
      );
    }

    for (const entry of entries) {
      const sourceKey = aliasClaimKey(entry.entityType, entry.sourceId);
      const targetKey = aliasClaimKey(entry.entityType, entry.targetId);
      if (sourceClaims.has(sourceKey) || targetClaims.has(targetKey)) {
        throw new RawCmaOracleError(
          `Ledger contains a duplicate source or target claim for ${entry.entityType}:${entry.sourceId}.`,
        );
      }
      if (
        (entry.entityType === 'record' || entry.entityType === 'block') &&
        recordIds.has(entry.targetId)
      ) {
        throw new RawCmaOracleError(
          `Ledger target ${entry.targetId} collides with a ledger record ID.`,
        );
      }
      sourceClaims.set(sourceKey, entry);
      targetClaims.set(targetKey, entry);
    }

    batches.push({
      batchId,
      chunkCount,
      recordIds: records.map(({ id }) => id),
      wholeHash,
      entries,
    });
  }

  const entries = batches.flatMap((batch) => batch.entries);
  return {
    present: true,
    projectId: payload.projectId,
    modelId: model.id,
    recordHashes: Object.fromEntries(
      parsedRecords
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, serializedDocument }) => [id, sha256(serializedDocument)]),
    ),
    batches,
    entries,
  };
}

export function assertLedgerAppendOnly(
  before: RawLedgerState,
  after: RawLedgerState,
): void {
  if (before.projectId !== after.projectId) {
    throw new RawCmaOracleError(
      'Cannot compare ledgers from different projects.',
    );
  }
  if (before.present && !after.present) {
    throw new RawCmaOracleError('The reserved ledger model was removed.');
  }
  if (before.modelId && before.modelId !== after.modelId) {
    throw new RawCmaOracleError('The reserved ledger model ID changed.');
  }
  for (const [recordId, hash] of Object.entries(before.recordHashes)) {
    if (after.recordHashes[recordId] !== hash) {
      throw new RawCmaOracleError(
        `Existing ledger record ${recordId} was removed or modified.`,
      );
    }
  }
}

export class RawCmaOracleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawCmaOracleError';
  }
}

interface RawResource {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
  meta: Record<string, unknown>;
}

interface ParsedLedgerDocument {
  formatVersion: 1;
  projectId: string;
  batchId: string;
  chunkIndex: number;
  chunkCount: number;
  wholeHash: string;
  entries: LegacyAlias[];
}

interface ParsedLedgerRecord {
  id: string;
  name: string;
  serializedDocument: string;
  document: ParsedLedgerDocument;
}

async function readAllItemPages(
  port: RawCmaReadPort,
  modelId: string,
  version: 'current' | 'published',
): Promise<RawResource[]> {
  const result: RawResource[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;

  while (expectedTotal === null || result.length < expectedTotal) {
    const response = objectAt(
      await port.rawListItems({
        filter: { type: modelId },
        nested: true,
        order_by: 'id_ASC',
        page: { offset: result.length, limit: 30 },
        version,
      }),
      `${version} item-list response`,
    );
    if (!Array.isArray(response.data)) {
      throw new RawCmaOracleError(
        `${version} item-list response has no data array.`,
      );
    }
    const meta = objectAt(response.meta, `${version} item-list meta`);
    const totalCount = meta.total_count;
    if (!Number.isInteger(totalCount) || (totalCount as number) < 0) {
      throw new RawCmaOracleError(
        `${version} item-list response has an invalid total_count.`,
      );
    }
    if (expectedTotal === null) expectedTotal = totalCount as number;
    if (expectedTotal !== totalCount) {
      throw new RawCmaOracleError(
        `${version} item-list total_count changed during oracle capture.`,
      );
    }
    if (response.data.length === 0 && result.length < expectedTotal) {
      throw new RawCmaOracleError(
        `${version} item-list pagination ended before total_count.`,
      );
    }
    for (const [index, value] of response.data.entries()) {
      const resource = parseResource(
        value,
        `${version} item-list data[${result.length + index}]`,
      );
      if (resource.type !== 'item') {
        throw new RawCmaOracleError(
          `${version} item-list returned resource type ${resource.type}.`,
        );
      }
      if (seen.has(resource.id)) {
        throw new RawCmaOracleError(
          `${version} item-list returned duplicate ID ${resource.id}.`,
        );
      }
      seen.add(resource.id);
      result.push(resource);
    }
  }

  if (result.length !== expectedTotal) {
    throw new RawCmaOracleError(
      `${version} item-list count disagrees with total_count.`,
    );
  }
  return result;
}

function parseGoldenRecord(
  resource: RawResource,
  expectedModelId: string,
): RawCmaRecord {
  const itemTypeId = relationshipId(resource, 'item_type', false);
  if (itemTypeId !== expectedModelId) {
    throw new RawCmaOracleError(
      `Record ${resource.id} belongs to model ${String(
        itemTypeId,
      )}, expected ${expectedModelId}.`,
    );
  }

  return {
    id: resource.id,
    itemTypeId,
    title: nullableString(resource.attributes.title, `${resource.id}.title`),
    body: nullableString(resource.attributes.body, `${resource.id}.body`),
    related: nullableString(
      resource.attributes.related,
      `${resource.id}.related`,
    ),
  };
}

function assertReservedLedgerSchema(
  model: RawResource,
  resources: RawResource[],
  menuInput: unknown[],
  schemaMenuInput: unknown[],
  filterInput: unknown[],
): void {
  const fields = resources.filter(
    (resource) =>
      resource.type === 'field' &&
      relationshipId(resource, 'item_type', false) === model.id,
  );
  const fieldsets = resources.filter(
    (resource) =>
      resource.type === 'fieldset' &&
      relationshipId(resource, 'item_type', false) === model.id,
  );
  const byApiKey = new Map(
    fields.map((field) => [String(field.attributes.api_key), field]),
  );
  const nameField = byApiKey.get('name');
  const mappingField = byApiKey.get('mapping');
  const expectedModelAttributes = {
    name: 'Content diff',
    api_key: RESERVED_CONTENT_DIFF_MODEL_API_KEY,
    singleton: false,
    modular_block: false,
    draft_mode_active: true,
    draft_saving_active: false,
    sortable: false,
    tree: false,
    all_locales_required: false,
    inverse_relationships_enabled: false,
    collection_appearance: 'compact',
    ordering_direction: null,
    ordering_meta: null,
    has_singleton_item: false,
    hint: null,
  };
  for (const [key, expected] of Object.entries(expectedModelAttributes)) {
    if (stableJson(model.attributes[key]) !== stableJson(expected)) {
      throw new RawCmaOracleError(
        `Reserved ledger model has unexpected ${key}.`,
      );
    }
  }
  if (
    fields.length !== 2 ||
    fieldsets.length !== 0 ||
    !nameField ||
    !mappingField
  ) {
    throw new RawCmaOracleError(
      'Reserved ledger model must contain exactly its two fields and no fieldsets.',
    );
  }
  assertLedgerField(nameField, {
    label: 'Name',
    fieldType: 'string',
    position: 1,
    validators: { required: {}, unique: {} },
    appearance: {
      addons: [],
      editor: 'single_line',
      parameters: { heading: false, placeholder: null },
    },
  });
  assertLedgerField(mappingField, {
    label: 'Mapping',
    fieldType: 'json',
    position: 2,
    validators: { required: {} },
    appearance: { addons: [], editor: 'json', parameters: {} },
  });

  const modelRelationships = objectAt(
    model.relationships,
    'reserved ledger relationships',
  );
  const exactNullRelationships = [
    'workflow',
    'singleton_item',
    'ordering_field',
    'presentation_image_field',
    'image_preview_field',
    'excerpt_field',
  ];
  for (const key of exactNullRelationships) {
    if (relationshipDataId(modelRelationships[key]) !== null) {
      throw new RawCmaOracleError(
        `Reserved ledger model relationship ${key} must be null.`,
      );
    }
  }
  for (const key of ['title_field', 'presentation_title_field']) {
    if (relationshipDataId(modelRelationships[key]) !== nameField.id) {
      throw new RawCmaOracleError(
        `Reserved ledger model relationship ${key} must target the name field.`,
      );
    }
  }

  const menus = menuInput.map((value, index) =>
    parseResource(value, `menuItems[${index}]`),
  );
  const schemaMenus = schemaMenuInput.map((value, index) =>
    parseResource(value, `schemaMenuItems[${index}]`),
  );
  const filters = filterInput.map((value, index) =>
    parseResource(value, `itemTypeFilters[${index}]`),
  );
  if (
    menus.some(
      (resource) => relationshipId(resource, 'item_type', true) === model.id,
    ) ||
    filters.some(
      (resource) => relationshipId(resource, 'item_type', false) === model.id,
    )
  ) {
    throw new RawCmaOracleError(
      'Reserved ledger model cannot have content navigation or saved filters.',
    );
  }
  const ledgerSchemaMenu = schemaMenus.filter(
    (resource) => relationshipId(resource, 'item_type', true) === model.id,
  );
  if (ledgerSchemaMenu.length !== 1) {
    throw new RawCmaOracleError(
      'Reserved ledger model must have exactly one schema-menu leaf.',
    );
  }
  if (
    relationshipId(ledgerSchemaMenu[0], 'parent', true) !== null ||
    relationshipIds(ledgerSchemaMenu[0], 'children').length !== 0
  ) {
    throw new RawCmaOracleError(
      'Reserved ledger schema-menu entry must be an isolated root leaf.',
    );
  }

  const referenceValidators = new Set([
    'item_item_type',
    'items_item_type',
    'rich_text_blocks',
    'single_block_blocks',
    'structured_text_blocks',
    'structured_text_inline_blocks',
    'structured_text_links',
  ]);
  for (const field of resources.filter(
    (resource) => resource.type === 'field' && !fields.includes(resource),
  )) {
    const validators = objectAt(
      field.attributes.validators,
      `field ${field.id} validators`,
    );
    for (const [key, configuration] of Object.entries(validators)) {
      if (!referenceValidators.has(key) || !isObject(configuration)) continue;
      if (
        Array.isArray(configuration.item_types) &&
        configuration.item_types.includes(model.id)
      ) {
        throw new RawCmaOracleError(
          `Field ${field.id} references the reserved ledger model.`,
        );
      }
    }
  }
}

function assertLedgerField(
  field: RawResource,
  expected: {
    label: string;
    fieldType: string;
    position: number;
    validators: Record<string, unknown>;
    appearance: Record<string, unknown>;
  },
): void {
  const checks: Record<string, unknown> = {
    label: expected.label,
    api_key: expected.label.toLowerCase(),
    field_type: expected.fieldType,
    localized: false,
    position: expected.position,
    validators: expected.validators,
    appearance: expected.appearance,
    default_value: null,
    hint: null,
    deep_filtering_enabled: false,
    content_link_enabled: true,
  };
  for (const [key, value] of Object.entries(checks)) {
    if (stableJson(field.attributes[key]) !== stableJson(value)) {
      throw new RawCmaOracleError(
        `Reserved ledger field ${field.id} has unexpected ${key}.`,
      );
    }
  }
  if (relationshipId(field, 'fieldset', true) !== null) {
    throw new RawCmaOracleError(
      `Reserved ledger field ${field.id} cannot belong to a fieldset.`,
    );
  }
}

function parseLedgerRecord(
  value: unknown,
  index: number,
  modelId: string,
  projectId: string,
): ParsedLedgerRecord {
  const resource = parseResource(value, `currentRecords[${index}]`);
  if (resource.type !== 'item' || !isPortableDatoId(resource.id)) {
    throw new RawCmaOracleError('Ledger record has an invalid resource or ID.');
  }
  if (relationshipId(resource, 'item_type', false) !== modelId) {
    throw new RawCmaOracleError(
      `Ledger record ${resource.id} belongs to another model.`,
    );
  }
  const requiredMeta: Record<string, unknown> = {
    status: 'draft',
    is_valid: true,
    is_current_version_valid: true,
    is_published_version_valid: null,
    stage: null,
    publication_scheduled_at: null,
    unpublishing_scheduled_at: null,
    published_at: null,
    first_published_at: null,
  };
  for (const [key, expected] of Object.entries(requiredMeta)) {
    if (resource.meta[key] !== expected) {
      throw new RawCmaOracleError(
        `Ledger record ${resource.id} has invalid lifecycle metadata ${key}.`,
      );
    }
  }
  const name = requiredString(
    resource.attributes.name,
    `ledger record ${resource.id} name`,
  );
  const serializedDocument = requiredString(
    resource.attributes.mapping,
    `ledger record ${resource.id} mapping`,
  );
  if (Buffer.byteLength(serializedDocument, 'utf8') > 128 * 1024) {
    throw new RawCmaOracleError(
      `Ledger record ${resource.id} exceeds 128 KiB.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedDocument);
  } catch {
    throw new RawCmaOracleError(
      `Ledger record ${resource.id} contains malformed JSON.`,
    );
  }
  const document = parseLedgerDocument(parsed, resource.id, projectId);
  if (prettyStableJson(document) !== serializedDocument) {
    throw new RawCmaOracleError(
      `Ledger record ${resource.id} is not canonical pretty JSON.`,
    );
  }
  const expectedName = `legacy-id-map:${document.batchId}:${
    document.chunkIndex + 1
  }/${document.chunkCount}`;
  if (name !== expectedName) {
    throw new RawCmaOracleError(
      `Ledger record ${resource.id} has an invalid deterministic name.`,
    );
  }
  return { id: resource.id, name, serializedDocument, document };
}

function parseLedgerDocument(
  value: unknown,
  recordId: string,
  projectId: string,
): ParsedLedgerDocument {
  const document = objectAt(value, `ledger record ${recordId} document`);
  assertExactKeys(document, [
    'batchId',
    'chunkCount',
    'chunkIndex',
    'entries',
    'formatVersion',
    'projectId',
    'wholeHash',
  ]);
  if (
    document.formatVersion !== 1 ||
    document.projectId !== projectId ||
    typeof document.batchId !== 'string' ||
    !isPortableDatoId(document.batchId) ||
    typeof document.wholeHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(document.wholeHash) ||
    !Number.isInteger(document.chunkIndex) ||
    (document.chunkIndex as number) < 0 ||
    !Number.isInteger(document.chunkCount) ||
    (document.chunkCount as number) < 1 ||
    (document.chunkIndex as number) >= (document.chunkCount as number) ||
    !Array.isArray(document.entries) ||
    document.entries.length === 0
  ) {
    throw new RawCmaOracleError(
      `Ledger record ${recordId} has invalid chunk metadata.`,
    );
  }
  const entries = document.entries.map((entry, index) =>
    parseAlias(entry, `${recordId}.entries[${index}]`),
  );
  assertStrictlySortedAliases(entries, `ledger record ${recordId}`);
  return {
    formatVersion: 1,
    projectId,
    batchId: document.batchId,
    chunkIndex: document.chunkIndex as number,
    chunkCount: document.chunkCount as number,
    wholeHash: document.wholeHash,
    entries,
  };
}

function parseAlias(value: unknown, path: string): LegacyAlias {
  const entry = objectAt(value, path);
  assertExactKeys(entry, ['entityType', 'sourceId', 'targetId']);
  if (
    entry.entityType !== 'record' &&
    entry.entityType !== 'block' &&
    entry.entityType !== 'upload' &&
    entry.entityType !== 'upload_collection'
  ) {
    throw new RawCmaOracleError(`${path} has an invalid entity type.`);
  }
  const sourceId = requiredString(entry.sourceId, `${path}.sourceId`);
  const targetId = requiredString(entry.targetId, `${path}.targetId`);
  if (!isLegacyDatoId(sourceId) || !isPortableDatoId(targetId)) {
    throw new RawCmaOracleError(`${path} has an invalid source or target ID.`);
  }
  return { entityType: entry.entityType, sourceId, targetId };
}

function assertStrictlySortedAliases(
  entries: LegacyAlias[],
  label: string,
): void {
  let previous: string | null = null;
  for (const entry of entries) {
    const key = `${entry.entityType}\0${entry.sourceId}`;
    if (previous !== null && key.localeCompare(previous) <= 0) {
      throw new RawCmaOracleError(
        `${label} entries are not strictly and uniquely sorted.`,
      );
    }
    previous = key;
  }
}

function aliasClaimKey(entityType: LegacyEntityType, id: string): string {
  const namespace =
    entityType === 'record' || entityType === 'block' ? 'item' : entityType;
  return `${namespace}\0${id}`;
}

function parseResource(value: unknown, path: string): RawResource {
  const resource = objectAt(value, path);
  const type = requiredString(resource.type, `${path}.type`);
  const id = requiredString(resource.id, `${path}.id`);
  return {
    type,
    id,
    attributes: objectAt(resource.attributes ?? {}, `${path}.attributes`),
    relationships: objectAt(
      resource.relationships ?? {},
      `${path}.relationships`,
    ),
    meta: objectAt(resource.meta ?? {}, `${path}.meta`),
  };
}

function relationshipId(
  resource: RawResource,
  key: string,
  nullable: boolean,
): string | null {
  const relationship = objectAt(
    resource.relationships[key],
    `${resource.type} ${resource.id} relationship ${key}`,
  );
  const id = relationshipDataId(relationship);
  if (!nullable && id === null) {
    throw new RawCmaOracleError(
      `${resource.type} ${resource.id} relationship ${key} is null.`,
    );
  }
  return id;
}

function relationshipIds(resource: RawResource, key: string): string[] {
  const relationship = objectAt(
    resource.relationships[key],
    `${resource.type} ${resource.id} relationship ${key}`,
  );
  if (!Array.isArray(relationship.data)) {
    throw new RawCmaOracleError(
      `${resource.type} ${resource.id} relationship ${key} is not an array.`,
    );
  }
  return relationship.data.map((value, index) =>
    requiredString(
      objectAt(value, `${resource.id}.${key}[${index}]`).id,
      `${resource.id}.${key}[${index}].id`,
    ),
  );
}

function relationshipDataId(value: unknown): string | null {
  const relationship = objectAt(value, 'relationship');
  if (relationship.data === null) return null;
  const data = objectAt(relationship.data, 'relationship.data');
  return requiredString(data.id, 'relationship.data.id');
}

function isPortableDatoId(id: string): boolean {
  try {
    const bytes = Buffer.from(id, 'base64url');
    return (
      bytes.length === 16 &&
      (bytes[6] & 0xf0) === 0x40 &&
      (bytes[8] & 0xc0) === 0x80 &&
      bytes.toString('base64url') === id
    );
  } catch {
    return false;
  }
}

function isLegacyDatoId(id: string): boolean {
  return (
    id.length <= 15 &&
    /^(0|[1-9]\d*)$/.test(id) &&
    BigInt(id) <= BigInt('281474976710655')
  );
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requiredString(value, path);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RawCmaOracleError(`${path} must be a non-empty string.`);
  }
  return value;
}

function assertNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  requiredString(value, path);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new RawCmaOracleError(`${path} must be an object.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  if (
    stableJson(Object.keys(value).sort()) !== stableJson([...expected].sort())
  ) {
    throw new RawCmaOracleError('Object contains an unexpected set of keys.');
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function prettyStableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value), null, 2);
}

function canonicalJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RawCmaOracleError('Cannot canonicalize a non-finite number.');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  throw new RawCmaOracleError(
    `Cannot canonicalize value of type ${typeof value}.`,
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareRecords(left: RawCmaRecord, right: RawCmaRecord): number {
  return left.id.localeCompare(right.id);
}
