import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { batches, boundedWork } from './bounded-work';
import { assertNotAborted } from './cancellation';
import {
  canonicalCollection,
  canonicalRecord,
  canonicalUpload,
  listingFingerprint,
  object,
  recordGuard,
  recordModelId,
  stableStringify,
  stateFingerprint,
  string,
  timestamp,
} from './codec';
import { compareIds } from './compare-ids';
import { ContentError } from './errors';
import { assertFullReadAccess, fetchSchema } from './schema';
import { SnapshotStore } from './store';
import type {
  CaptureOptions,
  Client,
  ModelSchema,
  RecordState,
  Schedules,
  SchemaState,
  Side,
} from './types';

type RecordPageQuery = Parameters<Client['items']['rawList']>[0];

/**
 * The nested flag only expands block fields, so a model without them reads
 * the same payload unexpanded, 500 records per request instead of 30.
 */
function readsBlocks(model: ModelSchema): boolean {
  return model.fields.some((field) =>
    ['rich_text', 'single_block', 'structured_text'].includes(field.type),
  );
}
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
): Promise<number> {
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
  return total;
}

function locales(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new ContentError(
      'INVALID_RESPONSE',
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
      'INVALID_RESPONSE',
      'Exact schedule relationships are unavailable.',
    );
  const relation = body.data.relationships[key];
  if (!object(relation) || !Object.hasOwn(relation, 'data'))
    throw new ContentError('INVALID_RESPONSE', `Missing ${key} relationship.`);
  if (relation.data === null) return null;
  if (
    !object(relation.data) ||
    relation.data.type !== key ||
    typeof relation.data.id !== 'string'
  )
    throw new ContentError(
      'INVALID_RESPONSE',
      `Malformed ${key} relationship.`,
    );
  const id = relation.data.id;
  const included = body.included.find(
    (entry) => object(entry) && entry.id === id && entry.type === key,
  );
  if (!object(included) || !object(included.attributes))
    throw new ContentError('INVALID_RESPONSE', `Incomplete ${key} details.`);
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
  const id = string(current.id, 'record ID');
  let raw: unknown;
  try {
    raw = await client.items.rawCurrentVsPublishedState(id);
  } catch (error) {
    // The record was listed a moment ago, so it was deleted meanwhile.
    if (error instanceof CmaClient.ApiError && error.response.status === 404)
      throw new ContentError(
        'CAPTURE_DRIFT',
        `Record ${id} was deleted during capture.`,
      );
    throw error;
  }
  if (!object(raw))
    throw new ContentError(
      'INVALID_RESPONSE',
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
        'INVALID_RESPONSE',
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
  return result.sort((a, b) => compareIds(a.id, b.id));
}

interface CaptureInput {
  client: Client;
  environmentId: string;
  schema: SchemaState;
  store: SnapshotStore;
  side: Side;
  options: CaptureOptions;
  /**
   * 'full' rereads everything and compares; 'versions' lists record versions
   * instead, assuming every edit creates a new version; 'none' skips the
   * check.
   */
  verify: 'none' | 'versions' | 'full';
}

/** Uploads and collections. Their listings are cheap, so they are always reread. */
async function captureAssets(input: {
  client: Client;
  store: SnapshotStore;
  side: Side;
  options: CaptureOptions;
}): Promise<void> {
  const { client, store, side, options } = input;
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
  if ((await count()) !== total)
    throw new ContentError(
      'CAPTURE_DRIFT',
      'The collection changed while it was being paginated.',
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
}

/**
 * Lists every regular record's version metadata into a temporary table, 500
 * records per request instead of nested 30-record pages, and yields each
 * record's fingerprint. A record moving between pages fails the pagination
 * checks, so the listing is complete.
 */
async function scanFingerprints(input: {
  client: Client;
  schema: SchemaState;
  store: SnapshotStore;
  scan: string;
  options: CaptureOptions;
}): Promise<void> {
  const { client, schema, store, scan, options } = input;
  const signal = options.signal;
  const db = store.database;
  clearScan(store, scan);
  const insert = db.prepare('INSERT OR IGNORE INTO scan_rows VALUES(?,?,?,?)');
  for (const model of schema.models) {
    if (model.block) continue;
    for (const version of ['current', 'published'] as const) {
      options.progress?.(`Listing ${model.apiKey} versions (${version})`);
      await pages(
        (offset) =>
          readNativeRecordPage(client, {
            filter: { type: model.id },
            nested: false,
            version,
            order_by: 'id_ASC',
            page: { offset, limit: 500 },
          }),
        500,
        options.concurrency,
        (rows) => {
          store.transaction(() => {
            for (const row of rows) {
              assertNotAborted(signal);
              if (
                !object(row) ||
                !object(row.attributes) ||
                recordModelId(row) !== model.id
              )
                throw new ContentError(
                  'INVALID_RESPONSE',
                  'A model listing contains a foreign record.',
                );
              // Only what the fingerprint needs is kept, not the content.
              const kept = {
                id: row.id,
                meta: row.meta,
                relationships: row.relationships,
                attributes: {
                  parent_id: row.attributes.parent_id,
                  position: row.attributes.position,
                },
              };
              if (
                !insert.run(
                  scan,
                  version,
                  string(row.id, 'record ID'),
                  JSON.stringify(kept),
                ).changes
              )
                throw new ContentError(
                  'CAPTURE_DRIFT',
                  'Duplicate record identity during a version listing.',
                );
            }
          });
        },
        signal,
      );
    }
  }
}

/** Each listed record's fingerprint, in ID order. */
function* scannedFingerprints(
  store: SnapshotStore,
  scan: string,
): Generator<{ id: string; fingerprint: string }> {
  const db = store.database;
  const orphan = db
    .prepare(
      "SELECT p.id FROM scan_rows p WHERE p.scan=? AND p.slice='published' AND NOT EXISTS(SELECT 1 FROM scan_rows c WHERE c.scan=p.scan AND c.slice='current' AND c.id=p.id) LIMIT 1",
    )
    .get(scan);
  if (orphan)
    throw new ContentError(
      'CAPTURE_DRIFT',
      `Published record ${orphan.id} disappeared during a version listing.`,
    );
  const published = db.prepare(
    "SELECT data FROM scan_rows WHERE scan=? AND slice='published' AND id=?",
  );
  for (const row of db
    .prepare(
      "SELECT id,data FROM scan_rows WHERE scan=? AND slice='current' ORDER BY id",
    )
    .iterate(scan)) {
    const pub = published.get(scan, String(row.id));
    yield {
      id: String(row.id),
      fingerprint: listingFingerprint(
        JSON.parse(String(row.data)),
        pub ? JSON.parse(String(pub.data)) : null,
      ),
    };
  }
}

/** Creates the version listing table when needed and empties one listing. */
function clearScan(store: SnapshotStore, scan: string): void {
  store.database.exec(
    'CREATE TEMP TABLE IF NOT EXISTS scan_rows(scan TEXT NOT NULL,slice TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scan,slice,id)) WITHOUT ROWID',
  );
  store.database.prepare('DELETE FROM scan_rows WHERE scan=?').run(scan);
}

/**
 * Compares a version listing with a side's captured states. Records whose
 * version changed are returned for a full read: a new version does not always
 * mean new content (renumbering siblings, for example). A record present on
 * only one side is reported as missing or extra.
 */
function fingerprintDifferences(
  store: SnapshotStore,
  side: Side,
  scan: string,
): { changed: string[]; missing: string | null; extra: string | null } {
  const changed: string[] = [];
  let matched = 0;
  let extra: string | null = null;
  for (const { id, fingerprint } of scannedFingerprints(store, scan)) {
    const state = store.getRecord(side, id);
    if (!state) {
      extra ??= id;
      continue;
    }
    matched++;
    if (stateFingerprint(state) !== fingerprint) changed.push(id);
  }
  const captured = Number(
    store.database
      .prepare('SELECT COUNT(*) AS count FROM records WHERE side=?')
      .get(side)?.count ?? 0,
  );
  const missing =
    captured === matched
      ? null
      : String(
          store.database
            .prepare(
              "SELECT r.id FROM records r WHERE r.side=? AND NOT EXISTS(SELECT 1 FROM scan_rows s WHERE s.scan=? AND s.slice='current' AND s.id=r.id) LIMIT 1",
            )
            .get(side, scan)?.id,
        );
  return { changed, missing, extra };
}

/**
 * Reads records in full and returns the first whose content, schedules or
 * position differ from the stored state of `side` (or that is missing).
 */
async function contentDifferences(
  { client, schema, store, side, options }: CaptureInput,
  ids: Iterable<string>,
): Promise<string | null> {
  for (const batch of batches(ids)) {
    assertNotAborted(options.signal);
    const states = await readRecordBatch(client, batch, schema);
    for (const id of batch) {
      const state = states.find((candidate) => candidate.id === id);
      const wanted = store.getRecord(side, id);
      if (
        !state ||
        !wanted ||
        state.hash !== wanted.hash ||
        state.position !== wanted.position
      )
        return id;
    }
  }
  return null;
}

async function captureOnce(input: CaptureInput): Promise<void> {
  const { client, schema, store, side, options } = input;
  const signal = options.signal;
  assertNotAborted(signal);
  const concurrency = options.concurrency;
  store.clearSide(side);
  const db = store.database;
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS capture_raw(side TEXT NOT NULL,slice TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(side,slice,id)) WITHOUT ROWID',
  );
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS capture_schedules(side TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(side,id)) WITHOUT ROWID',
  );
  db.prepare('DELETE FROM capture_raw WHERE side=?').run(side);
  db.prepare('DELETE FROM capture_schedules WHERE side=?').run(side);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO capture_raw VALUES(?,?,?,?)',
  );
  try {
    // Capture every regular model. Outside the selected mutation scope these
    // rows provide the retained destination state and incoming links.
    for (const model of schema.models) {
      assertNotAborted(signal);
      if (model.block) continue;
      const nested = readsBlocks(model);
      const limit = nested ? 30 : 500;
      for (const version of ['current', 'published'] as const) {
        options.progress?.(`Reading ${model.apiKey} (${version})`);
        await pages(
          (offset) =>
            readNativeRecordPage(client, {
              filter: { type: model.id },
              nested,
              version,
              order_by: 'id_ASC',
              page: { offset, limit },
            }),
          limit,
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
                // Records are canonicalized once, below, with both versions.
                if (recordModelId(row) !== model.id)
                  throw new ContentError(
                    'INVALID_RESPONSE',
                    'A model page contains a foreign record.',
                  );
                // Only a repeated identity is ignored. Other SQLite or I/O
                // failures, such as a full temporary disk, keep their error.
                const inserted = insert.run(
                  side,
                  version,
                  string(row.id, 'record ID'),
                  JSON.stringify(row),
                );
                if (!inserted.changes)
                  throw new ContentError(
                    'CAPTURE_DRIFT',
                    'Duplicate record identity during capture.',
                  );
              }
            });
          },
          signal,
        );
      }
    }
    // Schedule details cost one request per scheduled record. Few records are
    // scheduled, so inside the 30-row batches below they would run almost one
    // at a time; read them all up front with the full concurrency instead.
    const scheduledIds = db
      .prepare(
        "SELECT id FROM capture_raw WHERE side=? AND slice='current' AND (json_extract(data,'$.meta.publication_scheduled_at') IS NOT NULL OR json_extract(data,'$.meta.unpublishing_scheduled_at') IS NOT NULL) ORDER BY id",
      )
      .all(side)
      .map((row) => String(row.id));
    const scheduledRow = db.prepare(
      "SELECT data FROM capture_raw WHERE side=? AND slice='current' AND id=?",
    );
    const saveSchedules = db.prepare(
      'INSERT INTO capture_schedules VALUES(?,?,?)',
    );
    await boundedWork(
      scheduledIds,
      concurrency,
      async (id) => {
        assertNotAborted(signal);
        const current: unknown = JSON.parse(
          String(scheduledRow.get(side, id)!.data),
        );
        const schedules = await readSchedules(client, current);
        saveSchedules.run(side, id, JSON.stringify(schedules));
      },
      signal,
    );
    const cachedSchedules = db.prepare(
      'SELECT data FROM capture_schedules WHERE side=? AND id=?',
    );
    const published = db.prepare(
      "SELECT data FROM capture_raw WHERE side=? AND slice='published' AND id=?",
    );
    const rows = db.prepare(
      "SELECT id,data FROM capture_raw WHERE side=? AND slice='current' ORDER BY id",
    );
    for (const batch of batches(rows.iterate(side))) {
      // Yield between batches so process signal handlers can interrupt this
      // otherwise synchronous SQLite/codec phase.
      await setImmediate();
      assertNotAborted(signal);
      const states: RecordState[] = [];
      for (const row of batch) {
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
        // Every record with a schedule was read above.
        const cached = cachedSchedules.get(side, String(row.id));
        const schedules: Schedules = cached
          ? JSON.parse(String(cached.data))
          : { publication: null, unpublishing: null };
        states.push(canonicalRecord(current, pub, schema, schedules));
      }
      // Bound memory to one batch and commit it in one transaction. Dependency
      // indexes are not built here: the planner rebuilds them from these
      // records, and apply never reads them.
      store.transaction(() => {
        for (const state of states) {
          assertNotAborted(signal);
          store.putRecord(side, state);
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
    await captureAssets({ ...input, store });
  } finally {
    db.prepare('DELETE FROM capture_raw WHERE side=?').run(side);
    db.prepare('DELETE FROM capture_schedules WHERE side=?').run(side);
  }
}

/**
 * The consistency check without a second full read. A record edited while the
 * first pass read it has a new version afterwards, so one listing after the
 * pass proves every record was unchanged at the moment the pass ended.
 * Uploads and collections are cheap to list and are reread in full.
 */
async function verifyByVersions(input: CaptureInput): Promise<void> {
  const signal = input.options.signal;
  const scan = `verify-${input.side}`;
  const assets = new SnapshotStore();
  try {
    input.options.progress?.('Checking capture consistency by version');
    const schema = await fetchSchema(
      input.client,
      input.environmentId,
      input.options.schemaProjection,
    );
    assertNotAborted(signal);
    if (
      schema.hash !== input.schema.hash ||
      schema.siteId !== input.schema.siteId
    )
      throw new ContentError(
        'CAPTURE_DRIFT',
        'The schema changed during capture.',
      );
    await scanFingerprints({ ...input, schema, scan });
    const {
      changed: newer,
      missing,
      extra,
    } = fingerprintDifferences(input.store, input.side, scan);
    const changed =
      missing ??
      extra ??
      (await contentDifferences({ ...input, schema }, newer));
    if (changed)
      throw new ContentError(
        'CAPTURE_DRIFT',
        `Record ${changed} changed during capture. Start a new generation after editing stops.`,
      );
    await captureAssets({ ...input, store: assets });
    const after = await fetchSchema(
      input.client,
      input.environmentId,
      input.options.schemaProjection,
    );
    assertNotAborted(signal);
    if (
      after.hash !== schema.hash ||
      (await snapshotDigest(input.store, input.side, signal, false)) !==
        (await snapshotDigest(assets, input.side, signal, false))
    )
      throw new ContentError(
        'CAPTURE_DRIFT',
        'Assets or schema changed during capture. Start a new generation after editing stops.',
      );
  } finally {
    clearScan(input.store, scan);
    assets.dispose();
  }
}

async function snapshotDigest(
  store: SnapshotStore,
  side: Side,
  signal?: AbortSignal,
  records = true,
): Promise<string> {
  const digest = createHash('sha256');
  let count = 0;
  const checkpoint = async () => {
    if (++count % 30 === 0) await setImmediate();
    assertNotAborted(signal);
  };
  for (const record of records ? store.records(side) : []) {
    await checkpoint();
    digest
      .update(stableStringify(['record', record.id, recordGuard(record)]))
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
  if (input.verify === 'none') return;
  if (input.verify === 'versions') {
    await verifyByVersions(input);
    return;
  }
  // These checks are necessary because DatoCMS maintenance mode applies only
  // to primary and does not make it an immutable snapshot or transaction. No
  // public persistent sandbox freeze exists; rereads reject observed drift.
  const verification = new SnapshotStore();
  try {
    input.options.progress?.('Checking capture consistency');
    assertNotAborted(signal);
    const schema = await fetchSchema(
      input.client,
      input.environmentId,
      input.options.schemaProjection,
    );
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
    const after = await fetchSchema(
      input.client,
      input.environmentId,
      input.options.schemaProjection,
    );
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
