import { CmaClient } from '@datocms/cli-utils';
import { boundedWork } from './bounded-work';
import { assertNotAborted } from './cancellation';
import {
  type RecordLine,
  type ScheduleResource,
  canonicalSchedules,
  timestamp,
} from './codec';
import { ContentError } from './errors';
import { assertFullReadAccess } from './schema';
import type { CaptureOptions, Client, ModelSchema, SchemaState } from './types';

type RecordPageQuery = Parameters<Client['items']['rawList']>[0];
type RecordPage = Awaited<ReturnType<Client['items']['rawList']>>;
/** The parts of a listed record resource capture reads directly. */
type NativeRow = {
  id: string;
  meta: Record<string, string | null | undefined>;
};

/** Where a capture puts what it reads, one entry at a time. */
export interface CaptureSink {
  record(line: RecordLine): Promise<void>;
  /** An upload as the SDK's `uploads.list` returns it. */
  upload(upload: unknown): Promise<void>;
  /** A folder as the SDK's `uploadCollections.list` returns it. */
  collection(collection: unknown): Promise<void>;
}

/**
 * The nested flag only expands block fields, so a model without them reads
 * the same payload unexpanded, 500 records per request instead of 30.
 */
function readsBlocks(model: ModelSchema): boolean {
  return model.fields.some((field) =>
    ['rich_text', 'single_block', 'structured_text'].includes(field.type),
  );
}

function readNativeRecordPage(
  client: Client,
  queryParams: RecordPageQuery,
): Promise<RecordPage> {
  // rawList still runs the SDK's recursive item deserializer, which loses own
  // __proto__ keys inside file/gallery custom_data. Use the same typed SDK
  // request route so authentication, query encoding, retries and environment
  // binding remain intact while our codec receives the exact native JSON.
  return client.request<RecordPage>({
    method: 'GET',
    url: '/items',
    queryParams,
  });
}

function pageBody(body: unknown): { data: unknown[]; total: number } {
  const page = body as { data: unknown[]; meta: { total_count: number } };
  return { data: page.data, total: page.meta.total_count };
}

async function pages(
  read: (offset: number) => Promise<unknown>,
  limit: number,
  concurrency: number,
  consume: (rows: unknown[]) => Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  assertNotAborted(signal);
  const first = pageBody(await read(0));
  const total = first.total;
  const accept = async (body: unknown, offset: number) => {
    assertNotAborted(signal);
    const page = pageBody(body);
    if (
      page.total !== total ||
      page.data.length !== Math.min(limit, total - offset)
    )
      throw new ContentError(
        'CAPTURE_DRIFT',
        'The collection changed while it was being paginated.',
      );
    await consume(page.data);
  };
  await accept({ data: first.data, meta: { total_count: total } }, 0);
  function* offsets() {
    for (let offset = limit; offset < total; offset += limit) yield offset;
  }
  // The SDK owns authentication, retries and async jobs. Manual bounded page
  // pulling prevents its eager paginated iterator from queuing every page.
  await boundedWork(offsets(), concurrency, async (offset) => {
    assertNotAborted(signal);
    await accept(await read(offset), offset);
  });
  return total;
}

type ScheduleBody = {
  data: { relationships: Record<string, { data: { id: string } | null }> };
  included?: ScheduleResource[];
};

/** A record's scheduled publication and unpublishing, as the CMA returns them. */
async function readSchedules(
  client: Client,
  record: NativeRow,
): Promise<[ScheduleResource | null, ScheduleResource | null]> {
  const pubAt = record.meta.publication_scheduled_at;
  const unpubAt = record.meta.unpublishing_scheduled_at;
  if (!pubAt && !unpubAt) return [null, null];
  let body: ScheduleBody;
  try {
    body = (await client.items.rawCurrentVsPublishedState(
      record.id,
    )) as unknown as ScheduleBody;
  } catch (error) {
    // The record was listed a moment ago, so it was deleted meanwhile.
    if (error instanceof CmaClient.ApiError && error.response.status === 404)
      throw new ContentError(
        'CAPTURE_DRIFT',
        `Record ${record.id} was deleted during capture.`,
      );
    throw error;
  }
  const resource = (key: string) => {
    const id = body.data.relationships[key]?.data?.id;
    return (
      (id &&
        body.included?.find(
          (entry) => entry.id === id && entry.type === key,
        )) ||
      null
    );
  };
  const publication = resource('scheduled_publication');
  const unpublishing = resource('scheduled_unpublishing');
  const schedules = canonicalSchedules(publication, unpublishing);
  // The listing and this read are two requests: a schedule that changed
  // between them makes the marker and the details disagree.
  if (
    Boolean(pubAt) !== Boolean(schedules.publication) ||
    Boolean(unpubAt) !== Boolean(schedules.unpublishing) ||
    (pubAt && schedules.publication?.at !== timestamp(pubAt)) ||
    (unpubAt && schedules.unpublishing?.at !== timestamp(unpubAt))
  )
    throw new ContentError(
      'CAPTURE_DRIFT',
      'A record schedule changed during capture.',
    );
  return [publication, unpublishing];
}

/**
 * One listed page of current records as complete record lines: their
 * published versions, read by ID, and their schedules.
 */
async function recordLines(
  client: Client,
  rows: NativeRow[],
  nested: boolean,
  concurrency: number,
): Promise<RecordLine[]> {
  const published = new Map<string, unknown>();
  const ids = rows.filter((row) => row.meta.published_at).map((row) => row.id);
  // A filter of IDs travels in the URL, so long lists are split.
  const size = nested ? 30 : 100;
  for (let start = 0; start < ids.length; start += size) {
    const chunk = ids.slice(start, start + size);
    const body = await readNativeRecordPage(client, {
      filter: { ids: chunk.join(',') },
      nested,
      version: 'published',
      page: { limit: chunk.length },
    });
    for (const resource of pageBody(body).data as NativeRow[])
      published.set(resource.id, resource);
  }
  const lines = rows.map((row): RecordLine => {
    const pub = published.get(row.id) ?? null;
    // The current and published versions are two requests.
    if (Boolean(row.meta.published_at) !== Boolean(pub))
      throw new ContentError(
        'CAPTURE_DRIFT',
        `Publication state changed while reading record ${row.id}.`,
      );
    return {
      id: row.id,
      current: row,
      published: pub,
      scheduledPublication: null,
      scheduledUnpublishing: null,
    };
  });
  // Schedule details cost one request per scheduled record. Few records are
  // scheduled, so they are read together rather than one after another.
  await boundedWork(
    lines.filter(
      ({ current }) =>
        (current as NativeRow).meta.publication_scheduled_at ||
        (current as NativeRow).meta.unpublishing_scheduled_at,
    ),
    concurrency,
    async (line) => {
      [line.scheduledPublication, line.scheduledUnpublishing] =
        await readSchedules(client, line.current as NativeRow);
    },
  );
  return lines;
}

/** Uploads and folders. */
async function captureAssets(
  client: Client,
  sink: CaptureSink,
  options: CaptureOptions,
): Promise<void> {
  const signal = options.signal;
  options.progress?.('Reading asset metadata');
  // The SDK's uploads.list returns default_field_metadata field-keyed in every
  // environment, but no total count. A single-row raw page read supplies the
  // live total: the first page's finishes before that page is listed, every
  // later page reads one alongside its listing, and one more follows the last
  // page. An upload added or removed after the first count changes a page's
  // total or length, or the final count. As with every offset pagination, an
  // add and a remove that both fall between two reads keep the total unchanged.
  const count = async () =>
    pageBody(await client.uploads.rawList({ page: { limit: 1 } })).total;
  const seen = new Set<string>();
  const total = await pages(
    async (offset) => {
      const first = offset === 0 ? await count() : undefined;
      const [data, live] = await Promise.all([
        client.uploads.list({
          order_by: 'id_ASC',
          page: { offset, limit: 500 },
        }),
        first ?? count(),
      ]);
      return { data, meta: { total_count: live } };
    },
    500,
    options.concurrency,
    async (uploads) => {
      for (const upload of uploads) {
        assertNotAborted(signal);
        const { id } = upload as { id: string };
        if (seen.has(id))
          throw new ContentError('CAPTURE_DRIFT', `Duplicate upload ${id}.`);
        seen.add(id);
        await sink.upload(upload);
      }
    },
    signal,
  );
  if ((await count()) !== total)
    throw new ContentError(
      'CAPTURE_DRIFT',
      'The collection changed while it was being paginated.',
    );
  assertNotAborted(signal);
  for (const folder of await client.uploadCollections.list())
    await sink.collection(folder);
  assertNotAborted(signal);
}

/**
 * Reads every record, upload and folder of an environment into a sink. It
 * takes no lock: content that changes while it reads is reported as drift
 * where two requests disagree, and otherwise relies on nobody editing.
 */
export async function captureEnvironment(args: {
  client: Client;
  schema: SchemaState;
  sink: CaptureSink;
  options: CaptureOptions;
}): Promise<void> {
  const { client, schema, sink, options } = args;
  const signal = options.signal;
  assertNotAborted(signal);
  await assertFullReadAccess(client, schema);
  const seen = new Set<string>();
  for (const model of schema.models) {
    assertNotAborted(signal);
    if (model.block) continue;
    const nested = readsBlocks(model);
    const limit = nested ? 30 : 500;
    options.progress?.(`Reading ${model.apiKey}`);
    await pages(
      (offset) =>
        readNativeRecordPage(client, {
          filter: { type: model.id },
          nested,
          version: 'current',
          order_by: 'id_ASC',
          page: { offset, limit },
        }),
      limit,
      options.concurrency,
      async (rows) => {
        for (const line of await recordLines(
          client,
          rows as NativeRow[],
          nested,
          options.concurrency,
        )) {
          assertNotAborted(signal);
          // A record listed twice moved between pages meanwhile.
          if (seen.has(line.id))
            throw new ContentError(
              'CAPTURE_DRIFT',
              'Duplicate record identity during capture.',
            );
          seen.add(line.id);
          await sink.record(line);
        }
      },
      signal,
    );
  }
  await captureAssets(client, sink, options);
}
