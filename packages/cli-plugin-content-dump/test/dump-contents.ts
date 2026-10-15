import assert from 'node:assert/strict';
import type {
  ItemResource,
  RecordLine,
  Upload,
  UploadCollection,
} from '../src/dump/format';
import { openDump } from '../src/dump/format';
import { rawModels } from '../src/schema';

/** What an import gives an upload: its file and its metadata. */
const UPLOAD_ATTRIBUTES = [
  'id',
  'filename',
  'basename',
  'md5',
  'size',
  'width',
  'height',
  'format',
  'mime_type',
  'author',
  'copyright',
  'notes',
  'tags',
  'default_field_metadata',
  'upload_collection',
] as const;

/**
 * A dump's content in a form two dumps can be compared with: what an import
 * reproduces, keyed by ID. Server-side bookkeeping (version IDs, update and
 * publication times, URLs, creators) and the records of `leaveOut` models
 * are left out.
 */
export async function comparableContents(
  path: string,
  leaveOut: string[] = [],
): Promise<{
  records: Record<string, unknown>;
  uploads: Record<string, unknown>;
  folders: Record<string, unknown>;
}> {
  const dump = await openDump(path);
  try {
    const skipped = new Set(
      rawModels(dump.schema)
        .filter(({ model }) => leaveOut.includes(model.attributes.api_key))
        .map(({ model }) => model.id),
    );
    const records: Record<string, unknown> = {};
    for await (const { value } of dump.zip.lines('records')) {
      const { id, current, published } = value as RecordLine;
      if (skipped.has(current.relationships.item_type.data.id)) continue;
      records[id] = {
        current: comparableItem(current),
        published: published && comparableItem(published),
      };
    }
    const uploads: Record<string, unknown> = {};
    for await (const { value } of dump.zip.lines('uploads')) {
      const upload = value as Upload;
      uploads[upload.id] = Object.fromEntries(
        UPLOAD_ATTRIBUTES.map((key) => [key, upload[key]]),
      );
    }
    const folders: Record<string, unknown> = {};
    for await (const { value } of dump.zip.lines('upload-collections')) {
      const { children: _children, ...folder } = value as UploadCollection;
      folders[folder.id] = folder;
    }
    return { records, uploads, folders };
  } finally {
    dump.zip.close();
  }
}

/** A record or block without what the CMA sets on every write. */
function comparableItem(item: ItemResource): unknown {
  const {
    updated_at: _updatedAt,
    published_at: _publishedAt,
    current_version: _currentVersion,
    ...meta
  } = item.meta ?? {};
  return {
    id: item.id,
    model: item.relationships.item_type.data.id,
    attributes: withoutBlockMeta(item.attributes),
    ...(item.meta && { meta }),
  };
}

function withoutBlockMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBlockMeta);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.type === 'item' && record.relationships)
    return {
      id: record.id,
      model: (record as unknown as ItemResource).relationships.item_type.data
        .id,
      attributes: withoutBlockMeta(record.attributes),
    };
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      withoutBlockMeta(entry),
    ]),
  );
}

type Contents = Awaited<ReturnType<typeof comparableContents>>;

/** Asserts two dumps hold the same content, naming the first entry that differs. */
export function assertSameContents(actual: Contents, expected: Contents) {
  for (const section of ['folders', 'uploads', 'records'] as const) {
    assert.deepEqual(
      Object.keys(actual[section]).sort(),
      Object.keys(expected[section]).sort(),
      `The dumps hold different ${section}.`,
    );
    for (const [id, entry] of Object.entries(expected[section]))
      assert.deepEqual(actual[section][id], entry, `${section} ${id} differs.`);
  }
}
