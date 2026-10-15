import type { CmaClient } from '@datocms/cli-utils';
import { type AssetFile, assetEntryName, downloadAsset } from '../dump/assets';
import {
  DUMP_FORMAT,
  DUMP_VERSION,
  type DumpManifest,
  type ItemResource,
  PLUGIN_VERSION,
  type RecordLine,
  type Upload,
} from '../dump/format';
import { ZipWriter } from '../dump/zip';
import { type RawSchema, rawModels, readRawSchema } from '../schema';
import { inOrder } from '../utils/concurrency';
import type { EnvironmentChoice } from '../utils/environments';

type Client = CmaClient.Client;

/** Field types whose values hold blocks, which records are read with nested. */
const BLOCK_FIELD_TYPES = ['rich_text', 'single_block', 'structured_text'];
/** The most records a page holds when read nested, and otherwise. */
const NESTED_PAGE_SIZE = 30;
const PAGE_SIZE = 500;
/** The IDs of a filter travel in the URL, so long lists are split. */
const IDS_PER_REQUEST = 100;
const UPLOADS_PAGE_SIZE = 500;

interface ModelToRead {
  id: string;
  apiKey: string;
  /**
   * Whether records are read with their blocks nested. Nested reads return
   * fewer records per page, so only models with block fields use them.
   */
  nested: boolean;
}

function pageSize(model: ModelToRead): number {
  return model.nested ? NESTED_PAGE_SIZE : PAGE_SIZE;
}

/**
 * Writes an environment's schema, records, uploads and upload folders to a
 * dump at `path`, and with `includeAssets` the file of every asset. The
 * environment is read without a lock: keep it unchanged while it runs.
 */
export async function exportEnvironment(args: {
  client: Client;
  environment: EnvironmentChoice;
  path: string;
  includeAssets: boolean;
  progress: (message: string) => void;
}): Promise<DumpManifest> {
  const { client, progress } = args;
  const zip = new ZipWriter(args.path);
  try {
    const schema = await readRawSchema(client);
    zip.addJson('schema.json', schema);
    const records = await zip.addLines(
      'records',
      readRecords(client, modelsToRead(schema), progress),
    );
    progress('Reading uploads');
    const assets: AssetFile[] = [];
    const uploads = await zip.addLines(
      'uploads',
      readUploads(client, ({ id, filename, url }) => {
        if (args.includeAssets) assets.push({ id, filename, url });
      }),
    );
    const uploadCollections = await zip.addLines(
      'upload-collections',
      await client.uploadCollections.list(),
    );
    if (assets.length) progress(`Downloading ${assets.length} asset files`);
    let downloaded = 0;
    for (const asset of assets) {
      await zip.addFile(
        assetEntryName(asset.id, asset.filename),
        await downloadAsset(asset, 'To export assets with videos'),
      );
      if (++downloaded % 100 === 0)
        progress(`Downloaded ${downloaded} of ${assets.length} asset files`);
    }
    const manifest: DumpManifest = {
      format: DUMP_FORMAT,
      version: DUMP_VERSION,
      createdAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      site: {
        id: schema.site.data.id,
        environment: args.environment.id,
        primary: args.environment.primary,
      },
      locales: schema.site.data.attributes.locales,
      includesAssets: args.includeAssets,
      counts: { records, uploads, uploadCollections },
    };
    zip.addJson('manifest.json', manifest, { pretty: true });
    await zip.close();
    return manifest;
  } catch (error) {
    await zip.discard();
    throw error;
  }
}

/** The content models (block models have no records of their own), by ID. */
function modelsToRead(schema: RawSchema): ModelToRead[] {
  return rawModels(schema)
    .filter(({ model }) => !model.attributes.modular_block)
    .map(({ model, fields }) => ({
      id: model.id,
      apiKey: model.attributes.api_key,
      nested: fields.some((field) =>
        BLOCK_FIELD_TYPES.includes(field.attributes.field_type),
      ),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function* readRecords(
  client: Client,
  models: ModelToRead[],
  progress: (message: string) => void,
): AsyncGenerator<RecordLine> {
  let count = 0;
  for (const model of models) {
    progress(`Reading ${model.apiKey}`);
    for await (const page of readRecordPages(client, model))
      for (const line of page.lines) {
        yield line;
        if (++count % 1000 === 0) progress(`Exported ${count} records`);
      }
  }
}

/**
 * Every page of a model's records, in order. The first page gives the
 * total; the others are read several at a time.
 */
async function* readRecordPages(client: Client, model: ModelToRead) {
  const limit = pageSize(model);
  const first = await readRecordPage(client, model, 0, limit);
  yield first;
  yield* inOrder(Math.ceil(first.total / limit) - 1, (page) =>
    readRecordPage(client, model, (page + 1) * limit, limit),
  );
}

interface RecordsPage {
  data: ItemResource[];
  meta: { total_count: number };
}

/**
 * Records are read through `client.request`, so they are stored exactly as
 * the CMA sends them, without the SDK's deserialization.
 */
function listRecords(
  client: Client,
  queryParams: Record<string, unknown>,
): Promise<RecordsPage> {
  return client.request<RecordsPage>({
    method: 'GET',
    url: '/items',
    queryParams,
  });
}

/**
 * One page of a model's records in creation order, which edits do not
 * change (the ID order can time out on large models), with the published
 * version of every record that has unpublished changes.
 */
async function readRecordPage(
  client: Client,
  model: ModelToRead,
  offset: number,
  limit: number,
): Promise<{ lines: RecordLine[]; total: number }> {
  const page = await listRecords(client, {
    filter: { type: model.id },
    nested: model.nested,
    version: 'current',
    order_by: '_created_at_ASC',
    page: { offset, limit },
  });
  const updated = page.data
    .filter((record) => record.meta.status === 'updated')
    .map((record) => record.id);
  const published = new Map<string, ItemResource>();
  const chunk = Math.min(IDS_PER_REQUEST, pageSize(model));
  for (let start = 0; start < updated.length; start += chunk) {
    const ids = updated.slice(start, start + chunk);
    const versions = await listRecords(client, {
      filter: { ids: ids.join(',') },
      nested: model.nested,
      version: 'published',
      page: { limit: ids.length },
    });
    for (const record of versions.data) published.set(record.id, record);
  }
  return {
    lines: page.data.map((current) => ({
      id: current.id,
      current,
      published: published.get(current.id) ?? null,
    })),
    total: page.meta.total_count,
  };
}

async function* readUploads(
  client: Client,
  onUpload: (upload: Upload) => void,
): AsyncGenerator<Upload> {
  for (let offset = 0; ; offset += UPLOADS_PAGE_SIZE) {
    const page = await client.uploads.list({
      order_by: 'id_ASC',
      page: { offset, limit: UPLOADS_PAGE_SIZE },
    });
    for (const upload of page) {
      onUpload(upload);
      yield upload;
    }
    if (page.length < UPLOADS_PAGE_SIZE) return;
  }
}
