import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { batches, boundedWork } from './apply-work';
import { assertNotAborted } from './cancellation';
import {
  canonicalCollection,
  canonicalFields,
  canonicalRecord,
  canonicalUpload,
  hashJson,
  inspectRecord,
  nullableString,
  object,
  recordGuard,
  recordHash,
  stableStringify,
  string,
  timestamp,
} from './codec';
import { ContentError } from './errors';
import { assertFullReadAccess, fetchSchema } from './schema';
import { SnapshotStore } from './store';
import type {
  CaptureOptions,
  Client,
  RecordState,
  Schedules,
  SchemaState,
  Side,
} from './types';

type RecordPageQuery = Parameters<Client['items']['rawList']>[0];
type RecordPage = Awaited<ReturnType<Client['items']['rawList']>>;

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
  if (
    !object(body) ||
    !Array.isArray(body.data) ||
    !object(body.meta) ||
    !Number.isSafeInteger(body.meta.total_count) ||
    Number(body.meta.total_count) < 0
  )
    throw new ContentError(
      'INVALID_RESPONSE',
      'A paginated CMA response has no authoritative total count.',
    );
  return { data: body.data, total: Number(body.meta.total_count) };
}

async function pages(
  read: (offset: number) => Promise<unknown>,
  limit: number,
  concurrency: number,
  consume: (rows: unknown[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  const first = pageBody(await read(0));
  const total = first.total;
  const accept = (body: unknown, offset: number) => {
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
    consume(page.data);
  };
  accept({ data: first.data, meta: { total_count: total } }, 0);
  function* offsets() {
    for (let offset = limit; offset < total; offset += limit) yield offset;
  }
  // The SDK owns authentication, retries and async jobs. Manual bounded page
  // pulling prevents its eager paginated iterator from queuing every page.
  await boundedWork(offsets(), concurrency, async (offset) => {
    assertNotAborted(signal);
    accept(await read(offset), offset);
  });
}

function locales(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new ContentError(
      'SCHEDULE_CONTRACT',
      'Exact schedule locales are unavailable.',
    );
  return [...value].sort();
}

function scheduleResource(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  if (
    !object(body.data) ||
    !object(body.data.relationships) ||
    !Array.isArray(body.included)
  )
    throw new ContentError(
      'SCHEDULE_CONTRACT',
      'Exact schedule relationships are unavailable.',
    );
  const relation = body.data.relationships[key];
  if (!object(relation) || !Object.hasOwn(relation, 'data'))
    throw new ContentError('SCHEDULE_CONTRACT', `Missing ${key} relationship.`);
  if (relation.data === null) return null;
  if (
    !object(relation.data) ||
    relation.data.type !== key ||
    typeof relation.data.id !== 'string'
  )
    throw new ContentError(
      'SCHEDULE_CONTRACT',
      `Malformed ${key} relationship.`,
    );
  const id = relation.data.id;
  const included = body.included.find(
    (entry) => object(entry) && entry.id === id && entry.type === key,
  );
  if (!object(included) || !object(included.attributes))
    throw new ContentError('SCHEDULE_CONTRACT', `Incomplete ${key} details.`);
  return included.attributes;
}

export async function readSchedules(
  client: Client,
  current: unknown,
): Promise<Schedules> {
  if (!object(current) || !object(current.meta))
    throw new ContentError(
      'INVALID_RESPONSE',
      'Record schedule metadata is unavailable.',
    );
  const pubAt = current.meta.publication_scheduled_at;
  const unpubAt = current.meta.unpublishing_scheduled_at;
  if (!pubAt && !unpubAt) return { publication: null, unpublishing: null };
  const raw: unknown = await client.items.rawCurrentVsPublishedState(
    string(current.id, 'record ID'),
  );
  if (!object(raw))
    throw new ContentError(
      'SCHEDULE_CONTRACT',
      'Exact schedule state is unavailable.',
    );
  const publication = scheduleResource(raw, 'scheduled_publication');
  const unpublishing = scheduleResource(raw, 'scheduled_unpublishing');
  if (
    Boolean(pubAt) !== Boolean(publication) ||
    Boolean(unpubAt) !== Boolean(unpublishing)
  )
    throw new ContentError(
      'CAPTURE_DRIFT',
      'A record schedule changed during capture.',
    );
  let selective: { locales: string[]; nonLocalized: boolean } | null = null;
  if (publication && publication.selective_publication !== null) {
    const scope = publication.selective_publication;
    if (!object(scope) || typeof scope.non_localized_content !== 'boolean')
      throw new ContentError(
        'SCHEDULE_CONTRACT',
        'Exact publication scope is unavailable.',
      );
    selective = {
      locales: locales(scope.content_in_locales),
      nonLocalized: scope.non_localized_content,
    };
  }
  const schedules: Schedules = {
    publication: publication
      ? {
          at: timestamp(
            publication.publication_scheduled_at,
            'publication schedule',
          ),
          selective,
        }
      : null,
    unpublishing: unpublishing
      ? {
          at: timestamp(
            unpublishing.unpublishing_scheduled_at,
            'unpublishing schedule',
          ),
          locales:
            unpublishing.content_in_locales === null
              ? null
              : locales(unpublishing.content_in_locales),
        }
      : null,
  };
  if (
    (schedules.publication &&
      schedules.publication.at !== timestamp(pubAt, 'publication marker')) ||
    (schedules.unpublishing &&
      schedules.unpublishing.at !== timestamp(unpubAt, 'unpublishing marker'))
  )
    throw new ContentError(
      'CAPTURE_DRIFT',
      'Schedule markers and details disagree.',
    );
  return schedules;
}

/** Fully expanded aggregate reads; callers must partition larger ID sets. */
export async function readRecordBatch(
  client: Client,
  ids: string[],
  schema: SchemaState,
): Promise<RecordState[]> {
  if (ids.length > 30)
    throw new ContentError(
      'INVALID_BATCH',
      'Nested record reads accept at most 30 IDs.',
    );
  if (!ids.length) return [];
  const [currentBody, publishedBody] = await Promise.all([
    readNativeRecordPage(client, {
      filter: { ids: ids.join(',') },
      nested: true,
      version: 'current',
      page: { limit: 30 },
    }),
    readNativeRecordPage(client, {
      filter: { ids: ids.join(',') },
      nested: true,
      version: 'published',
      page: { limit: 30 },
    }),
  ]);
  const current = pageBody(currentBody);
  const published = pageBody(publishedBody);
  if (
    current.total !== current.data.length ||
    published.total !== published.data.length
  )
    throw new ContentError('INVALID_RESPONSE', 'An ID batch was truncated.');
  const wanted = new Set(ids);
  const byId = new Map<string, unknown>();
  for (const resource of published.data) {
    if (!object(resource))
      throw new ContentError(
        'INVALID_RESPONSE',
        'Published record is malformed.',
      );
    const id = string(resource.id, 'record ID');
    if (!wanted.has(id) || byId.has(id))
      throw new ContentError(
        'INVALID_RESPONSE',
        'An ID batch contains an unexpected or duplicate record.',
      );
    byId.set(id, resource);
  }
  const result: RecordState[] = [];
  const seen = new Set<string>();
  await boundedWork(current.data, 4, async (resource) => {
    if (!object(resource))
      throw new ContentError(
        'INVALID_RESPONSE',
        'Current record is malformed.',
      );
    const id = string(resource.id, 'record ID');
    if (!wanted.has(id) || seen.has(id))
      throw new ContentError(
        'INVALID_RESPONSE',
        'An ID batch contains an unexpected or duplicate record.',
      );
    seen.add(id);
    const pub = byId.get(id) ?? null;
    if (
      object(resource.meta) &&
      Boolean(resource.meta.published_at) !== Boolean(pub)
    )
      throw new ContentError(
        'CAPTURE_DRIFT',
        `Publication state changed while reading record ${id}.`,
      );
    result.push(
      canonicalRecord(
        resource,
        pub,
        schema,
        await readSchedules(client, resource),
      ),
    );
  });
  for (const id of byId.keys())
    if (!seen.has(id))
      throw new ContentError(
        'CAPTURE_DRIFT',
        `Published record ${id} disappeared from the current batch.`,
      );
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

interface CaptureInput {
  client: Client;
  environmentId: string;
  schema: SchemaState;
  store: SnapshotStore;
  side: Side;
  options: CaptureOptions;
  verify?: boolean;
}

async function captureOnce(input: CaptureInput): Promise<void> {
  const { client, schema, store, side, options } = input;
  const signal = options.signal;
  assertNotAborted(signal);
  const concurrency = options.concurrency ?? 4;
  store.clearSide(side);
  const db = store.database;
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS capture_raw(side TEXT NOT NULL,slice TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(side,slice,id)) WITHOUT ROWID',
  );
  db.prepare('DELETE FROM capture_raw WHERE side=?').run(side);
  const insert = db.prepare('INSERT INTO capture_raw VALUES(?,?,?,?)');
  try {
    // Capture every regular model. Outside the selected mutation scope these
    // rows prove reference safety and preservation, including incoming links.
    for (const model of schema.models) {
      assertNotAborted(signal);
      if (model.block) continue;
      for (const version of ['current', 'published'] as const) {
        options.progress?.(`Reading ${model.apiKey} (${version})`);
        await pages(
          (offset) =>
            readNativeRecordPage(client, {
              filter: { type: model.id },
              nested: true,
              version,
              order_by: 'id_ASC',
              page: { offset, limit: 30 },
            }),
          30,
          concurrency,
          (rows) => {
            store.transaction(() => {
              for (const row of rows) {
                assertNotAborted(signal);
                if (!object(row))
                  throw new ContentError(
                    'INVALID_RESPONSE',
                    'Record is malformed.',
                  );
                const record = canonicalRecord(row, null, schema);
                if (record.modelId !== model.id)
                  throw new ContentError(
                    'INVALID_RESPONSE',
                    'A model page contains a foreign record.',
                  );
                try {
                  insert.run(side, version, record.id, JSON.stringify(row));
                } catch (error) {
                  throw new ContentError(
                    'CAPTURE_DRIFT',
                    'Duplicate record identity during capture.',
                    {
                      cause: error instanceof Error ? error.message : 'unknown',
                    },
                  );
                }
              }
            });
          },
          signal,
        );
      }
    }
    const published = db.prepare(
      "SELECT data FROM capture_raw WHERE side=? AND slice='published' AND id=?",
    );
    const rows = db.prepare(
      "SELECT id,data FROM capture_raw WHERE side=? AND slice='current' ORDER BY id",
    );
    for (const batch of batches(rows.iterate(side))) {
      // Most records have no schedules, so their promises resolve immediately.
      // Yield between batches so process signal handlers can interrupt this
      // otherwise synchronous SQLite/codec phase.
      await setImmediate();
      assertNotAborted(signal);
      const states: RecordState[] = [];
      await boundedWork(batch, concurrency, async (row) => {
        assertNotAborted(signal);
        const current: unknown = JSON.parse(String(row.data));
        const pubRow = published.get(side, String(row.id));
        const pub: unknown = pubRow ? JSON.parse(String(pubRow.data)) : null;
        if (
          !object(current) ||
          !object(current.meta) ||
          Boolean(current.meta.published_at) !== Boolean(pub)
        )
          throw new ContentError(
            'CAPTURE_DRIFT',
            `Publication state changed for record ${row.id}.`,
          );
        const schedules = await readSchedules(client, current);
        assertNotAborted(signal);
        states.push(canonicalRecord(current, pub, schema, schedules));
      });
      // Bound memory to one nested-read batch and commit all dependency indexes
      // together. Autocommitting each block/reference makes large captures pay
      // millions of disk transactions and can leave a partially indexed record.
      store.transaction(() => {
        for (const state of states) {
          assertNotAborted(signal);
          store.putRecord(side, state);
          const inspected = inspectRecord(state, schema);
          for (const reference of inspected.references)
            store.putReference(side, reference);
          for (const owner of inspected.blockOwners)
            store.putBlockOwner(side, owner);
          for (const value of inspected.uniqueValues)
            store.putUniqueValue(side, value);
        }
      });
    }
    const orphan = db
      .prepare(
        "SELECT p.id FROM capture_raw p WHERE p.side=? AND p.slice='published' AND NOT EXISTS(SELECT 1 FROM capture_raw c WHERE c.side=p.side AND c.slice='current' AND c.id=p.id) LIMIT 1",
      )
      .get(side);
    if (orphan)
      throw new ContentError(
        'CAPTURE_DRIFT',
        `Published record ${orphan.id} disappeared during capture.`,
      );
    options.progress?.('Reading asset metadata');
    await pages(
      (offset) =>
        client.uploads.rawList({
          order_by: 'id_ASC',
          page: { offset, limit: 500 },
        }),
      500,
      concurrency,
      (uploads) => {
        store.transaction(() => {
          for (const raw of uploads) {
            assertNotAborted(signal);
            const upload = canonicalUpload(raw);
            if (store.getUpload(side, upload.id))
              throw new ContentError(
                'CAPTURE_DRIFT',
                `Duplicate upload ${upload.id}.`,
              );
            store.putUpload(side, upload);
          }
        });
      },
      signal,
    );
    assertNotAborted(signal);
    for (const raw of await client.uploadCollections.list()) {
      assertNotAborted(signal);
      const collection = canonicalCollection(raw);
      if (store.getCollection(side, collection.id))
        throw new ContentError(
          'CAPTURE_DRIFT',
          `Duplicate collection ${collection.id}.`,
        );
      store.putCollection(side, collection);
    }
    assertNotAborted(signal);
  } finally {
    db.prepare('DELETE FROM capture_raw WHERE side=?').run(side);
  }
}

async function snapshotDigest(
  store: SnapshotStore,
  side: Side,
  signal?: AbortSignal,
): Promise<string> {
  const digest = createHash('sha256');
  let count = 0;
  const checkpoint = async () => {
    if (++count % 30 === 0) await setImmediate();
    assertNotAborted(signal);
  };
  for (const record of store.records(side)) {
    await checkpoint();
    digest
      .update(
        stableStringify([
          'record',
          record.id,
          // Validity is recalculated by asynchronous schema workers. Compare
          // the expanded content, versions and writable lifecycle instead.
          { ...recordGuard(record), validity: undefined },
        ]),
      )
      .update('\n');
  }
  for (const upload of store.uploads(side)) {
    await checkpoint();
    digest
      .update(stableStringify(['upload', upload.id, upload.hash]))
      .update('\n');
  }
  for (const collection of store.collections(side)) {
    await checkpoint();
    digest
      .update(stableStringify(['collection', collection.id, collection.hash]))
      .update('\n');
  }
  assertNotAborted(signal);
  return digest.digest('hex');
}

export async function captureSnapshot(input: CaptureInput): Promise<void> {
  const signal = input.options.signal;
  assertNotAborted(signal);
  await assertFullReadAccess(input.client, input.schema);
  assertNotAborted(signal);
  await captureOnce(input);
  if (input.verify === false) return;
  // These checks are necessary because DatoCMS maintenance mode applies only
  // to primary and does not make it an immutable snapshot or transaction. No
  // public persistent sandbox freeze exists; rereads reject observed drift.
  const verification = new SnapshotStore();
  try {
    input.options.progress?.('Checking capture consistency');
    assertNotAborted(signal);
    const schema = await fetchSchema(input.client, input.environmentId);
    assertNotAborted(signal);
    if (
      schema.hash !== input.schema.hash ||
      schema.siteId !== input.schema.siteId
    )
      throw new ContentError(
        'CAPTURE_DRIFT',
        'The schema changed during capture.',
      );
    await assertFullReadAccess(input.client, schema);
    assertNotAborted(signal);
    await captureOnce({ ...input, schema, store: verification });
    assertNotAborted(signal);
    const after = await fetchSchema(input.client, input.environmentId);
    assertNotAborted(signal);
    if (
      after.hash !== schema.hash ||
      (await snapshotDigest(input.store, input.side, signal)) !==
        (await snapshotDigest(verification, input.side, signal))
    )
      throw new ContentError(
        'CAPTURE_DRIFT',
        'Content or schema changed during capture. Start a new generation after editing stops.',
      );
  } finally {
    verification.dispose();
  }
}
