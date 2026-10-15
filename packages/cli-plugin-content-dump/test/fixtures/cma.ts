import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { fixtureId } from '../fixture-id';

/*
 * An in-memory DatoCMS project for the offline tests: environments holding
 * raw JSON:API records (current and published versions), uploads with their
 * bytes, upload folders and a schema, behind exactly the SDK calls the
 * plugin makes. It is written from the CMA's behaviour, not from the
 * plugin's code, and it enforces the rules the import's ordering depends on,
 * each failing with the CMA's error. "Live" marks behaviour verified against
 * the real CMA on 2026-10-15.
 */

type Json = any;
type Attributes = Record<string, Json>;

/** A schema as `GET /site?include=item_types,item_types.fields` and `GET /workflows` return it. */
export interface SchemaDocument {
  site: { data: Json; included: Json[] };
  workflows: Json[];
}

/** One SDK call an environment received, with a copy of its arguments. */
export interface Call {
  method: string;
  args: Json[];
}

interface Field {
  apiKey: string;
  type: string;
  localized: boolean;
  required: boolean;
}

interface Model {
  id: string;
  apiKey: string;
  draftMode: boolean;
  sortable: boolean;
  tree: boolean;
  fields: Field[];
}

interface Block {
  type: 'item';
  id: string;
  attributes: Attributes;
  relationships: { item_type: { data: { type: 'item_type'; id: string } } };
}

interface StoredRecord {
  id: string;
  model: Model;
  current: Attributes;
  published: Attributes | null;
  status: 'draft' | 'published' | 'updated';
  parentId: string | null;
  position: number | null;
  meta: Attributes;
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

/** A CMA error as the SDK raises it. */
export function apiError(
  method: string,
  path: string,
  status: number,
  code: string,
  details: Attributes = {},
): Error {
  return new CmaClient.ApiError({
    request: {
      url: `https://site-api.datocms.com${path}`,
      method,
      headers: {},
    },
    response: {
      status,
      statusText: status === 404 ? 'Not Found' : 'Unprocessable Entity',
      headers: {},
      body: {
        data: [{ id: code, type: 'api_error', attributes: { code, details } }],
      },
    },
  });
}

const taken = (path: string) =>
  apiError('POST', path, 422, 'INVALID_FIELD', {
    field: 'public_id',
    code: 'VALIDATION_UNIQUENESS',
  });

/**
 * Live: a client-supplied ID must be a version 4 UUID in URL-safe base64;
 * legacy numeric IDs are refused with INVALID_ENTITY_ID.
 */
function assertEntityId(id: string, path: string): void {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id))
    throw apiError('POST', path, 422, 'INVALID_ENTITY_ID', {
      reason:
        'Entity IDs must be Version 4 (random) UUIDs, expressed in URL-safe base64 format (see RFC 4122 and 4648)',
    });
}

const clone = <T>(value: T): T =>
  value === undefined ? value : structuredClone(value);

const isEmpty = (value: Json) =>
  value === null || value === '' || (Array.isArray(value) && !value.length);

/** The value of every locale of a field. */
const localeValues = (field: Field, value: Json): Json[] =>
  field.localized && value !== null && typeof value === 'object'
    ? Object.values(value)
    : [value];

/** A field value with `map` applied to the value of every locale. */
const mapLocales = (field: Field, value: Json, map: (entry: Json) => Json) =>
  field.localized && value !== null && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value).map(([locale, entry]) => [locale, map(entry)]),
      )
    : map(value);

/** A value of one locale with every block in it replaced by `map(block)`. */
function mapBlocks(type: string, value: Json, map: (block: Json) => Json) {
  if (value === null || value === undefined) return null;
  if (type === 'rich_text') return value.map(map);
  if (type === 'single_block') return map(value);
  if (type !== 'structured_text') return value;
  const node = (entry: Json): Json => ({
    ...entry,
    ...((entry.type === 'block' || entry.type === 'inlineBlock') && {
      item: map(entry.item),
    }),
    ...(entry.children && { children: entry.children.map(node) }),
  });
  return { ...value, document: node(value.document) };
}

/** The record IDs a value of one locale links to, not inside its blocks. */
function directLinks(type: string, value: Json): string[] {
  if (value === null || value === undefined) return [];
  if (type === 'link') return [value];
  if (type === 'links') return value;
  if (type !== 'structured_text') return [];
  const ids: string[] = [];
  const visit = (node: Json) => {
    if (node.type === 'itemLink' || node.type === 'inlineItem')
      ids.push(node.item);
    node.children?.forEach(visit);
  };
  visit(value.document);
  return ids;
}

/**
 * Moves `item` among its `siblings` (in position order, `item` among them or
 * not) to `position`, by default the end, and numbers them 1, 2, 3, …
 */
function reorder<T extends { position: number | null }>(
  siblings: T[],
  item: T,
  position?: number,
) {
  const others = siblings.filter((other) => other !== item);
  const at = Math.min(
    Math.max(position ?? Number.POSITIVE_INFINITY, 1),
    others.length + 1,
  );
  others.splice(at - 1, 0, item);
  others.forEach((other, index) => {
    other.position = index + 1;
  });
}

export class FakeCma {
  readonly siteId = fixtureId('fake site');
  readonly environments = new Map<string, FakeEnvironment>();
  /** Every URL the asset CDN was asked for, query string included. */
  readonly fetched: string[] = [];
  /** Added to the real time, to write content as if it were earlier. */
  timeShift = 0;
  private readonly files = new Map<string, { bytes: Buffer; mime: string }>();
  private generated = 0;
  private lastTime = 0;

  addEnvironment(id: string, schema: SchemaDocument, primary = false) {
    const environment = new FakeEnvironment(this, id, primary, clone(schema));
    this.environments.set(id, environment);
    return environment;
  }

  environment(id: string): FakeEnvironment {
    const environment = this.environments.get(id);
    if (!environment) throw new Error(`No environment ${id}.`);
    return environment;
  }

  newId(): string {
    return fixtureId(`generated ${++this.generated}`);
  }

  now(): number {
    return Date.now() + this.timeShift;
  }

  /** A time after every earlier one, so creation order is never a tie. */
  timestamp(): string {
    this.lastTime = Math.max(this.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }

  /** Puts a file on the asset CDN, and returns its path and URL. */
  host(filename: string, bytes: Buffer, mime: string) {
    const path = `/${this.siteId}/${++this.generated}-${filename}`;
    const url = `https://www.datocms-assets.com${path}`;
    this.files.set(url, { bytes, mime });
    return { path, url };
  }

  /** The asset CDN, also the `fetch` stub. */
  readonly fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    this.fetched.push(url);
    const parsed = new URL(url);
    const file = this.files.get(parsed.origin + parsed.pathname);
    if (!file) return new Response(null, { status: 404 });
    // Raw videos are refused while the asset settings block them, the default.
    if (file.mime.startsWith('video/'))
      return new Response(null, {
        status: 422,
        statusText: 'Unprocessable Entity',
      });
    // Without both parameters images come optimized and SVG files sanitized.
    const original =
      parsed.searchParams.get('skip-default-optimizations') === 'true' &&
      parsed.searchParams.get('svg-sanitize') === 'false';
    const body = original
      ? file.bytes
      : Buffer.concat([Buffer.from('optimized '), file.bytes]);
    return new Response(new Uint8Array(body));
  };
}

/** Replaces the global fetch with the project's asset CDN; returns the restore. */
export function stubFetch(cma: FakeCma): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = cma.fetch as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

export class FakeEnvironment {
  readonly calls: Call[] = [];
  readonly records = new Map<string, StoredRecord>();
  readonly uploads = new Map<string, Json>();
  readonly folders = new Map<string, Json>();
  /** Every record and block ID in use: they share one namespace. */
  private readonly itemIds = new Set<string>();
  private readonly models = new Map<string, Model>();
  private readonly failures: Array<[(call: Call) => boolean, Error]> = [];

  constructor(
    private readonly cma: FakeCma,
    readonly id: string,
    readonly primary: boolean,
    readonly schema: SchemaDocument,
  ) {
    const { included } = schema.site;
    for (const model of included.filter((entry) => entry.type === 'item_type'))
      this.models.set(model.id, {
        id: model.id,
        apiKey: model.attributes.api_key,
        draftMode: model.attributes.draft_mode_active,
        sortable: model.attributes.sortable,
        tree: model.attributes.tree,
        fields: included
          .filter(
            (entry) => entry.relationships.item_type?.data.id === model.id,
          )
          .map(({ attributes }) => ({
            apiKey: attributes.api_key,
            type: attributes.field_type,
            localized: attributes.localized,
            required: Boolean(attributes.validators.required),
          })),
      });
  }

  /** The calls that change something. */
  get writes(): Call[] {
    return this.calls.filter(
      ({ method }) => !/\.(list|rawFind)$|^request$/.test(method),
    );
  }

  /** Makes the first call that `matches` fail with `error`. */
  failWhen(matches: (call: Call) => boolean, error: Error): void {
    this.failures.push([matches, error]);
  }

  /** A client of this environment with the SDK calls the plugin makes. */
  client(): CmaClient.Client {
    const client: Json = {};
    for (const [name, run] of Object.entries(this.methods())) {
      const [resource, method] = name.split('.') as [string, string?];
      const call = (...args: Json[]) => this.call(name, args, run);
      if (!method) client[resource] = call;
      else {
        client[resource] ??= {};
        client[resource][method] = call;
      }
    }
    return client;
  }

  private methods(): Record<string, (...args: Json[]) => Json> {
    return {
      'environments.list': () =>
        [...this.cma.environments.values()].map(({ id, primary }) => ({
          id,
          type: 'environment',
          meta: { status: 'ready', primary },
        })),
      'site.rawFind': () => this.schema.site,
      'workflows.list': () => this.schema.workflows,
      request: (options) => this.listItems(options),
      'uploads.list': ({ order_by, page: { offset = 0, limit = 30 } = {} }) => {
        if (order_by !== 'id_ASC') throw new Error('Not emulated: order.');
        return [...this.uploads.values()]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(offset, offset + limit);
      },
      'uploads.createFromLocalFile': async ({ localPath, ...attributes }) =>
        this.createUpload(
          { filename: basename(localPath), ...attributes },
          await readFile(localPath),
        ),
      'uploads.createFromUrl': async ({ url, ...attributes }) => {
        const response = await this.cma.fetch(url);
        // The SDK downloads the URL itself, and fails with this message.
        if (!response.ok)
          throw new Error(
            `Failed to download ${url}: ${response.status} ${response.statusText}`,
          );
        return this.createUpload(
          { filename: basename(new URL(url).pathname), ...attributes },
          Buffer.from(await response.arrayBuffer()),
        );
      },
      'uploadCollections.list': () =>
        [...this.folders.values()].map((folder) => ({
          ...folder,
          children: [...this.folders.values()]
            .filter((child) => child.parent?.id === folder.id)
            .map(({ id }) => ({ type: 'upload_collection', id })),
        })),
      'uploadCollections.create': (body) => this.createFolder(body),
      'uploadCollections.update': (id, { position }) => {
        const folder = this.folders.get(id)!;
        const siblings = [...this.folders.values()]
          .filter((other) => other.parent?.id === folder.parent?.id)
          .sort((a, b) => a.position - b.position);
        reorder(siblings, folder, position);
        return folder;
      },
      'items.rawCreate': ({ data }) => this.createRecord(data),
      'items.rawUpdate': (id, { data }) =>
        this.updateRecord(this.record(id), data.attributes),
      'items.publish': (id) => {
        const record = this.record(id);
        this.assertPublishable(record, record.current);
        this.publish(record);
      },
      'items.unpublish': (id) => {
        const record = this.record(id);
        record.published = null;
        record.status = 'draft';
      },
      'items.update': (id, { meta }) => {
        this.record(id).meta.stage = meta.stage;
      },
      'scheduledPublication.create': (id, body) =>
        this.schedule(id, 'publication', body.publication_scheduled_at),
      'scheduledUnpublishing.create': (id, body) =>
        this.schedule(id, 'unpublishing', body.unpublishing_scheduled_at),
    };
  }

  private async call(
    method: string,
    args: Json[],
    run: (...a: Json[]) => Json,
  ) {
    const call = { method, args: clone(args) };
    this.calls.push(call);
    // Answers arrive on a later turn of the event loop, as over the network.
    await new Promise((resolve) => setImmediate(resolve));
    const failure = this.failures.findIndex(([matches]) => matches(call));
    if (failure !== -1) throw this.failures.splice(failure, 1)[0]![1];
    return clone(await run(...clone(args)));
  }

  private model(id: string): Model {
    const model = this.models.get(id);
    if (!model) throw new Error(`No model ${id}.`);
    return model;
  }

  private record(id: string): StoredRecord {
    const record = this.records.get(id);
    if (!record) throw apiError('PUT', `/items/${id}`, 404, 'NOT_FOUND');
    return record;
  }

  /**
   * The attributes a write leaves on a record or block: the fields sent,
   * the others as they were (or empty), every block sent stored in full.
   * New block IDs go to `created`.
   */
  private written(
    model: Model,
    sent: Attributes,
    before: Attributes | null,
    existing: Map<string, Block>,
    created: Set<string>,
  ): Attributes {
    const locales: string[] = this.schema.site.data.attributes.locales;
    const attributes: Attributes = {};
    for (const field of model.fields) {
      const empty = ['links', 'rich_text', 'gallery'].includes(field.type)
        ? []
        : null;
      attributes[field.apiKey] = !(field.apiKey in sent)
        ? before
          ? before[field.apiKey]
          : field.localized
            ? Object.fromEntries(locales.map((locale) => [locale, empty]))
            : empty
        : mapLocales(field, sent[field.apiKey], (entry) =>
            mapBlocks(field.type, entry, (block) =>
              this.writtenBlock(block, existing, created),
            ),
          );
    }
    return attributes;
  }

  /**
   * Live: blocks are created under client-supplied IDs, an ID already taken
   * fails with VALIDATION_UNIQUENESS, and an update accepts every block in
   * full, for blocks already in the record (merged) and for new ones.
   */
  private writtenBlock(
    sent: Json,
    existing: Map<string, Block>,
    created: Set<string>,
  ): Block {
    const old = sent.id ? existing.get(sent.id) : undefined;
    const modelId: string = (old ?? sent).relationships.item_type.data.id;
    const id: string = sent.id ?? this.cma.newId();
    if (!old) {
      assertEntityId(id, '/items');
      if (this.itemIds.has(id) || created.has(id)) throw taken('/items');
      created.add(id);
    }
    return {
      type: 'item',
      id,
      attributes: this.written(
        this.model(modelId),
        sent.attributes ?? {},
        old?.attributes ?? null,
        existing,
        created,
      ),
      relationships: {
        item_type: { data: { type: 'item_type', id: modelId } },
      },
    };
  }

  /**
   * Visits every block of some attributes, at every depth, and every record
   * they link to, with the top-level field that holds the link.
   */
  private walk(
    model: Model,
    attributes: Attributes,
    visit: {
      block?: (block: Block) => void;
      link?: (field: string, id: string) => void;
    },
  ) {
    const visitField = (top: string, field: Field, value: Json) => {
      for (const entry of localeValues(field, value)) {
        for (const id of directLinks(field.type, entry)) visit.link?.(top, id);
        mapBlocks(field.type, entry, (block: Block) => {
          visit.block?.(block);
          const { fields } = this.model(block.relationships.item_type.data.id);
          for (const inner of fields)
            visitField(top, inner, block.attributes[inner.apiKey]);
        });
      }
    };
    for (const field of model.fields)
      visitField(field.apiKey, field, attributes[field.apiKey]);
  }

  private assertValid(model: Model, attributes: Attributes, path: string) {
    const method = path === '/items' ? 'POST' : 'PUT';
    // Live: a link to a record that does not exist fails with INVALID_FORMAT.
    this.walk(model, attributes, {
      link: (field, id) => {
        if (!this.records.has(id))
          throw apiError(method, path, 422, 'INVALID_FIELD', {
            field,
            code: 'INVALID_FORMAT',
          });
      },
    });
    // Live: a required field left empty fails with VALIDATION_REQUIRED.
    for (const field of model.fields)
      if (
        field.required &&
        localeValues(field, attributes[field.apiKey]).every(isEmpty)
      )
        throw apiError(method, path, 422, 'INVALID_FIELD', {
          field: field.apiKey,
          code: 'VALIDATION_REQUIRED',
        });
  }

  private assertPublishable(record: StoredRecord, attributes: Attributes) {
    const path = `/items/${record.id}/publish`;
    // Live: publishing a record that links to an unpublished one fails.
    this.walk(record.model, attributes, {
      link: (field, id) => {
        if (id !== record.id && this.records.get(id)!.status === 'draft')
          throw apiError('PUT', path, 422, 'UNPUBLISHED_LINK', { field, id });
      },
    });
    // Live: publishing a tree child of an unpublished parent fails.
    const parent = record.parentId && this.records.get(record.parentId);
    if (record.parentId && (!parent || parent.status === 'draft'))
      throw apiError('PUT', path, 422, 'UNPUBLISHED_PARENT');
  }

  private publish(record: StoredRecord) {
    record.published = clone(record.current);
    record.status = 'published';
    record.meta.first_published_at ??= this.cma.timestamp();
    record.meta.published_at = this.cma.timestamp();
  }

  /** Same-model records under the same tree parent, in position order. */
  private siblings(record: StoredRecord): StoredRecord[] {
    return [...this.records.values()]
      .filter(
        ({ model, parentId }) =>
          model === record.model && parentId === record.parentId,
      )
      .sort((a, b) => a.position! - b.position!);
  }

  private createRecord(data: Json) {
    const id: string = data.id ?? this.cma.newId();
    // Live: records are created under client-supplied IDs, which must be free.
    assertEntityId(id, '/items');
    if (this.itemIds.has(id)) throw taken('/items');
    const model = this.model(data.relationships.item_type.data.id);
    const { position, parent_id, ...fields } = data.attributes;
    const created = new Set([id]);
    const current = this.written(model, fields, null, new Map(), created);
    this.assertValid(model, current, '/items');
    const now = this.cma.timestamp();
    const record: StoredRecord = {
      id,
      model,
      current,
      published: null,
      status: 'draft',
      parentId: model.tree ? parent_id ?? null : null,
      position: null,
      // Live: created_at and first_published_at sent on create are kept.
      meta: {
        created_at: data.meta?.created_at ?? now,
        updated_at: now,
        published_at: null,
        first_published_at: data.meta?.first_published_at ?? null,
        publication_scheduled_at: null,
        unpublishing_scheduled_at: null,
        stage: null,
        current_version: this.cma.newId(),
      },
    };
    // Live: models without draft mode publish their records on create.
    if (!model.draftMode) this.assertPublishable(record, current);
    for (const createdId of created) this.itemIds.add(createdId);
    this.records.set(id, record);
    // Live: a create without position appends to the siblings; with one it
    // inserts there and shifts the others.
    if (model.sortable || model.tree)
      reorder(this.siblings(record), record, position);
    if (!model.draftMode) this.publish(record);
    return { data: this.resource(record, 'current', true) };
  }

  private updateRecord(record: StoredRecord, sent: Attributes) {
    const { position, parent_id, ...fields } = sent;
    if (parent_id !== undefined && parent_id !== record.parentId)
      throw new Error('Not emulated: moving a record to another parent.');
    if (Object.keys(fields).length) {
      const existing = new Map<string, Block>();
      this.walk(record.model, record.current, {
        block: (block) => existing.set(block.id, block),
      });
      const created = new Set<string>();
      const current = this.written(
        record.model,
        fields,
        record.current,
        existing,
        created,
      );
      this.assertValid(record.model, current, `/items/${record.id}`);
      if (!record.model.draftMode) this.assertPublishable(record, current);
      for (const id of created) this.itemIds.add(id);
      record.current = current;
      record.meta.updated_at = this.cma.timestamp();
      record.meta.current_version = this.cma.newId();
      if (!record.model.draftMode) this.publish(record);
      else if (record.status === 'published') record.status = 'updated';
    }
    if (position !== undefined)
      reorder(this.siblings(record), record, position);
    return { data: this.resource(record, 'current', true) };
  }

  /** Live: a schedule in the past fails with VALIDATION_INVALID. */
  private schedule(id: string, kind: string, at: string) {
    const attribute = `${kind}_scheduled_at`;
    if (Date.parse(at) <= this.cma.now())
      throw apiError(
        'POST',
        `/items/${id}/scheduled-${kind}`,
        422,
        'INVALID_FIELD',
        {
          field: attribute,
          code: 'VALIDATION_INVALID',
        },
      );
    this.record(id).meta[attribute] = at;
  }

  /**
   * Raw `GET /items`, in creation order. Live: with nested=true blocks come
   * as full resources at every depth; without it, as IDs.
   */
  private listItems({ method, url, queryParams }: Json) {
    const {
      filter = {},
      nested,
      version,
      order_by,
      page = {},
      ...rest
    } = queryParams;
    const { type, ids, ...otherFilters } = filter;
    if (
      method !== 'GET' ||
      url !== '/items' ||
      Object.keys({ ...rest, ...otherFilters }).length ||
      ![undefined, '_created_at_ASC'].includes(order_by)
    )
      throw new Error(
        `Not emulated: ${method} ${url} ${JSON.stringify(queryParams)}`,
      );
    const records = [...this.records.values()].filter(
      (record) =>
        (!type || type.split(',').includes(record.model.id)) &&
        (!ids || ids.split(',').includes(record.id)) &&
        (version !== 'published' || record.published),
    );
    const { offset = 0, limit = 30 } = page;
    return {
      data: records
        .sort((a, b) => (a.meta.created_at < b.meta.created_at ? -1 : 1))
        .slice(offset, offset + limit)
        .map((record) => this.resource(record, version, nested === true)),
      meta: { total_count: records.length },
    };
  }

  private resource(record: StoredRecord, version: string, nested: boolean) {
    const { model } = record;
    const attributes = clone(
      version === 'published' ? record.published! : record.current,
    );
    if (!nested)
      for (const field of model.fields)
        attributes[field.apiKey] = mapLocales(
          field,
          attributes[field.apiKey],
          (entry) => mapBlocks(field.type, entry, (block: Block) => block.id),
        );
    if (model.sortable || model.tree) attributes.position = record.position;
    if (model.tree) attributes.parent_id = record.parentId;
    return {
      id: record.id,
      type: 'item',
      attributes,
      relationships: {
        item_type: { data: { type: 'item_type', id: model.id } },
      },
      meta: {
        ...record.meta,
        status: record.status,
        is_valid: true,
        is_current_version_valid: true,
        is_published_version_valid: true,
        has_children:
          model.tree &&
          [...this.records.values()].some(
            ({ parentId }) => parentId === record.id,
          ),
      },
    };
  }

  /** Live: uploads are created under client-supplied IDs, which must be free. */
  private createUpload(
    { id = this.cma.newId(), filename, ...rest }: Json,
    bytes: Buffer,
  ) {
    assertEntityId(id, '/uploads');
    if (this.uploads.has(id)) throw taken('/uploads');
    const extension = extname(filename);
    const mime = MIME_TYPES[extension] ?? 'application/octet-stream';
    const now = this.cma.timestamp();
    const upload = {
      id,
      type: 'upload',
      ...this.cma.host(filename, bytes, mime),
      filename,
      basename: basename(filename, extension),
      format: extension.slice(1),
      size: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'),
      mime_type: mime,
      is_image: mime.startsWith('image/'),
      width: null,
      height: null,
      author: rest.author ?? null,
      copyright: rest.copyright ?? null,
      notes: rest.notes ?? null,
      tags: rest.tags ?? [],
      default_field_metadata: rest.default_field_metadata ?? {},
      upload_collection: rest.upload_collection ?? null,
      created_at: now,
      updated_at: now,
    };
    this.uploads.set(id, upload);
    return upload;
  }

  /**
   * Live: folders are created under client-supplied IDs, which must be free,
   * and an explicit position is kept as given.
   */
  private createFolder({
    id = this.cma.newId(),
    label,
    parent,
    position,
  }: Json) {
    assertEntityId(id, '/upload-collections');
    if (this.folders.has(id)) throw taken('/upload-collections');
    const siblings = [...this.folders.values()].filter(
      (other) => other.parent?.id === parent?.id,
    );
    const folder = {
      id,
      type: 'upload_collection',
      label,
      position:
        position ?? Math.max(0, ...siblings.map((other) => other.position)) + 1,
      parent: parent ? { type: 'upload_collection', id: parent.id } : null,
    };
    this.folders.set(id, folder);
    return { ...folder, children: [] };
  }
}
