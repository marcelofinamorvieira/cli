import type { CmaClient } from '@datocms/cli-utils';

export type CanonicalGraphValue =
  | null
  | boolean
  | number
  | string
  | CanonicalGraphValue[]
  | { [key: string]: CanonicalGraphValue };

export type CanonicalGraphRecord = Readonly<{
  id: string;
  itemTypeId: string;
  position: number;
  fields: Readonly<Record<string, CanonicalGraphValue>>;
  lifecycle: Readonly<{
    status: string | null;
    currentValid: boolean | null;
    publishedValid: boolean | null;
  }>;
}>;

export type MediumScaleRawSlice = Readonly<{
  records: readonly CanonicalGraphRecord[];
  pageCount: number;
  totalCount: number;
}>;

export type MediumScaleRawState = Readonly<{
  current: MediumScaleRawSlice;
  published: MediumScaleRawSlice;
}>;

export type MediumScaleCoverage = Readonly<{
  blockNodes: number;
  inlineBlockNodes: number;
  inlineItemNodes: number;
  itemLinkNodes: number;
  nestedItems: number;
  maximumNestedItemDepth: number;
  recordReferences: ReadonlySet<string>;
}>;

export interface MediumScaleRawListQuery {
  filter: { type: string };
  nested: true;
  order_by: 'id_ASC';
  page: { offset: number; limit: 30 };
  version: 'current' | 'published';
}

export interface MediumScaleRawReadPort {
  rawListItems(query: MediumScaleRawListQuery): Promise<unknown>;
}

/**
 * Independent raw-CMA oracle for the medium-scale lane. It intentionally does
 * not import snapshot, canonicalization, planning, or generated-runtime code.
 */
export async function captureMediumScaleRawState(
  client: CmaClient.Client,
  modelId: string,
): Promise<MediumScaleRawState> {
  return captureMediumScaleRawStateFromPort(
    {
      rawListItems: async (query) =>
        client.items.rawList(query as never) as Promise<unknown>,
    },
    modelId,
  );
}

export async function captureMediumScaleRawStateFromPort(
  port: MediumScaleRawReadPort,
  modelId: string,
): Promise<MediumScaleRawState> {
  assertNonEmptyString(modelId, 'model ID');
  const [current, published] = await Promise.all([
    captureSlice(port, modelId, 'current'),
    captureSlice(port, modelId, 'published'),
  ]);
  return { current, published };
}

async function captureSlice(
  port: MediumScaleRawReadPort,
  modelId: string,
  version: 'current' | 'published',
): Promise<MediumScaleRawSlice> {
  const records: CanonicalGraphRecord[] = [];
  const ids = new Set<string>();
  let pageCount = 0;
  let expectedTotal: number | null = null;

  while (expectedTotal === null || records.length < expectedTotal) {
    const response = requiredObject(
      await port.rawListItems({
        filter: { type: modelId },
        nested: true,
        order_by: 'id_ASC',
        page: { offset: records.length, limit: 30 },
        version,
      }),
      `${version} raw list response`,
    );
    const data = requiredArray(response.data, `${version} response.data`);
    const meta = requiredObject(response.meta, `${version} response.meta`);
    const totalCount = requiredNonNegativeInteger(
      meta.total_count,
      `${version} response.meta.total_count`,
    );

    if (expectedTotal === null) expectedTotal = totalCount;
    if (totalCount !== expectedTotal) {
      throw new Error(
        `${version} total_count changed from ${expectedTotal} to ${totalCount} during pagination`,
      );
    }
    if (data.length > 30) {
      throw new Error(`${version} nested CMA page exceeded the 30-record cap`);
    }
    if (data.length === 0) {
      if (records.length !== expectedTotal) {
        throw new Error(
          `${version} pagination ended at ${records.length} of ${expectedTotal} records`,
        );
      }
      break;
    }

    pageCount += 1;
    for (const resource of data) {
      const record = parseCanonicalRecord(resource, modelId);
      if (ids.has(record.id)) {
        throw new Error(
          `${version} pagination returned duplicate record ${record.id}`,
        );
      }
      ids.add(record.id);
      records.push(record);
    }
  }

  if (expectedTotal === null) {
    throw new Error(`${version} pagination did not return a total_count`);
  }
  if (records.length !== expectedTotal) {
    throw new Error(
      `${version} pagination captured ${records.length} of ${expectedTotal} records`,
    );
  }

  return {
    records: records.sort(compareRecords),
    pageCount,
    totalCount: expectedTotal,
  };
}

export function collectMediumScaleCoverage(
  value: CanonicalGraphValue,
): MediumScaleCoverage {
  const result = {
    blockNodes: 0,
    inlineBlockNodes: 0,
    inlineItemNodes: 0,
    itemLinkNodes: 0,
    nestedItems: 0,
    maximumNestedItemDepth: 0,
    recordReferences: new Set<string>(),
  };

  const visit = (entry: CanonicalGraphValue, nestedItemDepth: number): void => {
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
      visit(entry.fields, nextDepth);
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

    Object.values(entry).forEach((child) => visit(child, nestedItemDepth));
  };

  visit(value, 0);
  return result;
}

function parseCanonicalRecord(
  value: unknown,
  expectedItemTypeId: string,
): CanonicalGraphRecord {
  const resource = requiredObject(value, 'raw item resource');
  const id = requiredNonEmptyString(resource.id, 'raw item ID');
  const itemTypeId = relationshipId(resource, 'item_type');
  if (itemTypeId !== expectedItemTypeId) {
    throw new Error(
      `record ${id} belongs to ${itemTypeId}, expected ${expectedItemTypeId}`,
    );
  }
  const attributes = requiredObject(resource.attributes, `${id}.attributes`);
  const meta = requiredObject(resource.meta, `${id}.meta`);
  const position = requiredNonNegativeInteger(
    attributes.position,
    `${id}.attributes.position`,
  );

  return {
    id,
    itemTypeId,
    position,
    fields: Object.fromEntries(
      Object.keys(attributes)
        .filter((key) => key !== 'position')
        .sort(compareCodeUnits)
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

function canonicalizeRawValue(value: unknown): CanonicalGraphValue {
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
      .sort(compareCodeUnits)
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
  return requiredNonEmptyString(
    data.id,
    `relationship ${relationshipName}.data.id`,
  );
}

function compareRecords(
  left: CanonicalGraphRecord,
  right: CanonicalGraphRecord,
): number {
  return compareCodeUnits(left.id, right.id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertNonEmptyString(value: string, label: string): void {
  requiredNonEmptyString(value, label);
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
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
