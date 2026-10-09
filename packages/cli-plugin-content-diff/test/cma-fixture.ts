import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { basename, extname } from 'node:path';
import { compileFunction } from 'node:vm';
import * as ts from 'typescript';
import {
  canonicalFields,
  canonicalUpload,
  collectionHash,
  recordHash,
  recordPayloadFields,
  recordReferences,
} from '../src/engine/codec';
import type { SnapshotStore } from '../src/engine/store';
import type {
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { type ContentMigrationClient, reorderRecords } from '../src/migration';

/** Applies `map` to every block position of one locale's native field value. */
function mapNativeBlocks(
  value: unknown,
  type: string,
  map: (block: unknown) => unknown,
): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'rich_text') return (value as unknown[]).map(map);
  if (type === 'single_block') return map(value);
  if (type !== 'structured_text') return value;
  const node = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      return entry;
    const result: Record<string, unknown> = { ...entry };
    if (result.type === 'block' || result.type === 'inlineBlock')
      result.item = map(result.item);
    if ('document' in result) result.document = node(result.document);
    if (Array.isArray(result.children))
      result.children = result.children.map(node);
    return result;
  };
  return node(value);
}

/**
 * Resolves the existing blocks an update refers to, as the CMA does: a bare
 * ID keeps a block of the same field and locale unchanged, and a block sent
 * without its model updates only the attributes it carries.
 */
function resolveBlocks(
  body: JsonObject,
  previous: JsonObject,
  modelId: string,
  schema: SchemaState,
): JsonObject {
  const result: JsonObject = { ...body };
  const type = schema.models.find((model) => model.id === modelId)!;
  for (const field of type.fields) {
    if (!(field.apiKey in body)) continue;
    const resolve = (value: unknown, old: unknown) => {
      const existing = new Map<string, JsonObject>();
      mapNativeBlocks(old, field.type, (block) => {
        existing.set(String((block as JsonObject).id), block as JsonObject);
        return block;
      });
      return mapNativeBlocks(value, field.type, (block) => {
        if (typeof block === 'string') {
          assert(existing.has(block), `unknown block ${block}`);
          return existing.get(block);
        }
        const sent = block as JsonObject;
        if (sent.relationships) return sent;
        const base = existing.get(String(sent.id));
        assert(base, `unknown block ${String(sent.id)}`);
        const blockModel = String(
          (
            (base.relationships as JsonObject).item_type as {
              data: { id: string };
            }
          ).data.id,
        );
        return {
          ...base,
          attributes: {
            ...(base.attributes as JsonObject),
            ...resolveBlocks(
              sent.attributes as JsonObject,
              base.attributes as JsonObject,
              blockModel,
              schema,
            ),
          },
        };
      });
    };
    const value = body[field.apiKey];
    const old = previous[field.apiKey];
    result[field.apiKey] = (
      field.localized && value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([locale, entry]) => [
              locale,
              resolve(entry, (old as JsonObject | null)?.[locale]),
            ]),
          )
        : resolve(value, old)
    ) as JsonObject[string];
  }
  return result;
}

/**
 * Stateful remote contract: writes execute immediately and enforce live
 * dependencies. Asset URLs serve the source uploads of `sources`.
 */
export function cmaFixture(
  store: SnapshotStore,
  schema: SchemaState,
  sources: SnapshotStore = store,
) {
  const definition = structuredClone(schema);
  const records = new Map(
    [...store.records('target')].map((record) => [
      record.id,
      structuredClone(record),
    ]),
  );
  const uploads = new Map(
    [...store.uploads('target')].map((upload) => [
      upload.id,
      structuredClone(upload),
    ]),
  );
  const folders = new Map(
    [...store.collections('target')].map((folder) => [
      folder.id,
      structuredClone(folder),
    ]),
  );
  // What each source asset URL serves; tests change entries to stand for a
  // source asset edited after generation.
  const remoteFiles = new Map(
    [...sources.uploads('source')].map((upload) => [
      upload.url,
      { md5: upload.md5, size: upload.size },
    ]),
  );
  const events: string[] = [];
  const updates: Array<{ id: string; locked: boolean }> = [];
  const lists: string[] = [];
  let revision = 1000;
  const model = (id: string) => {
    const model = definition.models.find((model) => model.id === id);
    assert(model, `unknown model ${id}`);
    return model;
  };
  const get = (id: string) => {
    const record = records.get(id);
    assert(record, `missing record ${id}`);
    return record;
  };
  const response = (record: RecordState) => ({
    id: record.id,
    type: 'item',
    item_type: { id: record.modelId, type: 'item_type' },
    ...record.current,
    parent_id: record.parentId,
    position: record.position,
    meta: {
      created_at: record.createdAt,
      first_published_at: record.firstPublishedAt,
      current_version: record.currentVersion,
      stage: record.stage,
    },
  });
  // The in-memory CMA enforces only `required`, on publication and on writes
  // to models without draft mode, enough to observe rejected writes; the
  // plugin itself never predicts validation.
  const blank = (value: unknown) =>
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  const valid = (record: RecordState) =>
    model(record.modelId).fields.every((field) => {
      if (!Object.hasOwn(field.validators, 'required')) return true;
      const value = record.current[field.apiKey];
      return field.localized && value && typeof value === 'object'
        ? !Object.values(value).some(blank)
        : !blank(value);
    });
  const links = (record: RecordState, published = false) => {
    for (const ref of recordReferences(
      { ...record, published: null },
      definition,
    )) {
      if (ref.kind === 'upload')
        assert(uploads.has(ref.targetId), `missing asset ${ref.targetId}`);
      else {
        assert(
          records.has(ref.targetId),
          `missing referenced record ${ref.targetId}`,
        );
        if (published)
          assert(
            records.get(ref.targetId)!.published,
            `unpublished reference ${ref.targetId}`,
          );
      }
    }
  };
  const save = (record: RecordState) => {
    record.hash = recordHash(record);
    records.set(record.id, record);
    return response(record);
  };
  // Native ordering: a record leaving a sibling group closes its gap; one
  // entering a group at a position shifts the siblings at or after it, and
  // one entering without a position is appended. Every renumbered sibling
  // gets a new version.
  const place = (record: RecordState, old?: RecordState, position?: number) => {
    const definition = model(record.modelId);
    if (!definition.sortable && !definition.tree) return;
    const peers = [...records.values()].filter(
      (peer) => peer.id !== record.id && peer.modelId === record.modelId,
    );
    const shift = (peer: RecordState, by: number) => {
      peer.position! += by;
      peer.currentVersion = String(++revision);
    };
    for (const peer of peers) {
      if (
        old &&
        peer.parentId === old.parentId &&
        peer.position! > old.position!
      )
        shift(peer, -1);
    }
    const siblings = peers.filter((peer) => peer.parentId === record.parentId);
    if (position === undefined)
      record.position = siblings.length
        ? Math.max(...siblings.map((peer) => peer.position!)) + 1
        : 1;
    else {
      for (const peer of siblings)
        if (peer.position! >= position) shift(peer, 1);
      record.position = position;
    }
    for (const peer of peers) peer.hash = recordHash(peer);
  };
  const folderResponse = (folder: CollectionState) => ({
    id: folder.id,
    type: 'upload_collection',
    label: folder.label,
    position: folder.position,
    parent: folder.parentId
      ? { id: folder.parentId, type: 'upload_collection' }
      : null,
    children: [...folders.values()]
      .filter((peer) => peer.parentId === folder.id)
      .map((peer) => ({ id: peer.id, type: 'upload_collection' })),
  });
  const folderGet = (id: string) => {
    const folder = folders.get(id);
    assert(folder, `missing folder ${id}`);
    return folder;
  };
  const uploadResponse = (upload: UploadState) => ({
    id: upload.id,
    type: 'upload',
    ...upload.attributes,
    md5: upload.md5,
    size: upload.size,
    url: upload.url,
    filename: upload.filename,
    basename: basename(upload.filename, extname(upload.filename)),
    format: extname(upload.filename).slice(1) || null,
    upload_collection: upload.collectionId
      ? { id: upload.collectionId, type: 'upload_collection' }
      : null,
  });
  const fetched = (url: string) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('skip-default-optimizations'), 'true');
    assert.equal(parsed.searchParams.get('svg-sanitize'), 'false');
    parsed.searchParams.delete('skip-default-optimizations');
    parsed.searchParams.delete('svg-sanitize');
    const file = remoteFiles.get(parsed.toString());
    assert(file, `unknown asset URL ${url}`);
    return file;
  };
  const updated = (current: UploadState, body: JsonObject): UploadState => {
    const { upload_collection, ...attributes } = body;
    const collectionId =
      upload_collection === undefined
        ? current.collectionId
        : upload_collection
          ? ((upload_collection as JsonObject).id as string)
          : null;
    if (collectionId) folderGet(collectionId);
    const merged = { ...current.attributes, ...attributes };
    const extension = extname(current.filename);
    const filename =
      typeof merged.basename === 'string'
        ? `${merged.basename}${extension}`
        : current.filename;
    return canonicalUpload({
      ...uploadResponse(current),
      ...merged,
      filename,
      upload_collection: collectionId
        ? { id: collectionId, type: 'upload_collection' }
        : null,
    });
  };
  const uploaded = (
    current: UploadState,
    { url, filename, ...body }: JsonObject,
  ): UploadState => {
    const file = fetched(String(url));
    const name = String(filename);
    return updated(
      {
        ...current,
        ...file,
        url: String(url),
        filename: name,
        attributes: {
          ...current.attributes,
          basename: basename(name, extname(name)),
        },
      },
      body,
    );
  };
  const client = {
    items: {
      async find(id: string) {
        return response(get(id));
      },
      async create(body: JsonObject) {
        const id = String(body.id);
        assert(!records.has(id), `duplicate record ${id}`);
        const modelId = String((body.item_type as JsonObject).id);
        const type = model(modelId);
        const meta = (body.meta ?? {}) as JsonObject;
        const fields = canonicalFields(body, modelId, definition);
        // CMA applies configured defaults on creation, including explicit null.
        for (const field of type.fields) {
          if (fields[field.apiKey] === null && field.defaultValue !== null)
            fields[field.apiKey] = structuredClone(field.defaultValue);
        }

        const initial = definition.workflows
          .find((workflow) => workflow.id === type.workflowId)
          ?.stages.find((stage) => stage.initial);
        const record: RecordState = {
          id,
          modelId,
          current: fields,
          published: null,
          currentVersion: String(++revision),
          publishedUpdatedAt: null,
          createdAt: String(meta.created_at),
          firstPublishedAt: meta.first_published_at as string | null,
          parentId: (body.parent_id as string | null) ?? null,
          position: null,
          stage: initial?.id ?? null,
          schedules: { publication: null, unpublishing: null },
          hash: '',
        };
        links(record, !type.draftMode);
        if (!type.draftMode) {
          assert(valid(record), 'invalid record creation');
          record.published = structuredClone(fields);
        }
        assert.equal(body.position, undefined, 'creation appends');
        place(record);
        events.push(`create:${id}`);
        return save(record);
      },
      async update(id: string, body: JsonObject) {
        const old = structuredClone(get(id));
        const record = structuredClone(old);
        const type = model(record.modelId);
        const meta = (body.meta ?? {}) as JsonObject;
        if ('current_version' in meta)
          assert.equal(
            meta.current_version,
            old.currentVersion,
            'STALE_ITEM_VERSION',
          );
        updates.push({ id, locked: 'current_version' in meta });
        const previous = recordPayloadFields(
          record.current,
          record.modelId,
          definition,
        );
        record.current = canonicalFields(
          {
            ...previous,
            ...resolveBlocks(body, previous, record.modelId, definition),
          },
          record.modelId,
          definition,
        );
        if ('parent_id' in body)
          record.parentId = body.parent_id as string | null;
        if ('created_at' in meta) record.createdAt = String(meta.created_at);
        if ('first_published_at' in meta)
          record.firstPublishedAt = meta.first_published_at as string | null;
        if ('stage' in meta) record.stage = meta.stage as string | null;
        links(record, !type.draftMode);
        if (!type.draftMode) {
          assert(valid(record), 'invalid record update');
          record.published = structuredClone(record.current);
        }
        record.currentVersion = String(++revision);
        if ('position' in body) place(record, old, Number(body.position));
        else if (record.parentId !== old.parentId) place(record, old);
        events.push(`update:${id}`);
        return save(record);
      },
      async publish(
        id: string,
        _selection: unknown,
        options: { recursive: boolean },
      ) {
        assert.equal(options.recursive, false);
        const record = get(id);
        assert(valid(record), 'publish persisted invalid record');
        links(record, true);
        record.published = structuredClone(record.current);
        record.firstPublishedAt ??= new Date().toISOString();
        events.push(`publish:${id}`);
        return save(record);
      },
      async unpublish(
        id: string,
        _selection: unknown,
        options: { recursive: boolean },
      ) {
        assert.equal(options.recursive, false);
        const record = get(id);
        record.published = null;
        events.push(`unpublish:${id}`);
        return save(record);
      },
      async *listPagedIterator(
        query: { filter: { type: string }; version: string },
        options: { perPage: number },
      ) {
        assert.equal(query.version, 'current');
        assert.equal(options.perPage, 500);
        lists.push(query.filter.type);
        for (const record of [...records.values()])
          if (record.modelId === query.filter.type) yield response(record);
      },
      async destroy(id: string) {
        const old = get(id);
        for (const peer of records.values())
          if (peer.id !== id)
            for (const ref of recordReferences(peer, definition))
              assert(ref.targetId !== id, `destroy referenced record ${id}`);
        records.delete(id);
        const type = model(old.modelId);
        if (type.sortable || type.tree)
          for (const peer of records.values())
            if (
              peer.modelId === old.modelId &&
              peer.parentId === old.parentId &&
              peer.position! > old.position!
            ) {
              peer.position!--;
              peer.currentVersion = String(++revision);
              peer.hash = recordHash(peer);
            }
        events.push(`destroy:${id}`);
        return response(old);
      },
    },
    scheduledPublication: {
      async destroy(id: string) {
        get(id).schedules.publication = null;
        events.push(`unschedule-publication:${id}`);
        return { id };
      },
      async create(
        id: string,
        body: {
          publication_scheduled_at: string;
          selective_publication: {
            content_in_locales: string[];
            non_localized_content: boolean;
          } | null;
        },
      ) {
        const record = get(id);
        if (!body.selective_publication)
          assert(valid(record), 'scheduling invalid content');
        record.schedules.publication = {
          at: body.publication_scheduled_at,
          selective: body.selective_publication
            ? {
                locales: body.selective_publication.content_in_locales,
                nonLocalized: body.selective_publication.non_localized_content,
              }
            : null,
        };
        events.push(`schedule-publication:${id}`);
        return { id, ...body };
      },
    },
    scheduledUnpublishing: {
      async destroy(id: string) {
        get(id).schedules.unpublishing = null;
        events.push(`unschedule-unpublishing:${id}`);
        return { id };
      },
      async create(
        id: string,
        body: {
          unpublishing_scheduled_at: string;
          content_in_locales: string[] | null;
        },
      ) {
        get(id).schedules.unpublishing = {
          at: body.unpublishing_scheduled_at,
          locales: body.content_in_locales,
        };
        events.push(`schedule-unpublishing:${id}`);
        return { id, ...body };
      },
    },
    uploadCollections: {
      async find(id: string) {
        return folderResponse(folderGet(id));
      },
      async create(body: {
        id: string;
        label: string;
        parent: { id: string } | null;
        position?: number;
      }) {
        assert.equal(
          body.position,
          undefined,
          'native folder creation appends',
        );
        assert(!folders.has(body.id));
        const parentId = body.parent?.id ?? null;
        if (parentId) folderGet(parentId);
        const peers = [...folders.values()].filter(
          (folder) => folder.parentId === parentId,
        );
        const state = {
          id: body.id,
          label: body.label,
          parentId,
          position:
            (peers.length
              ? Math.max(...peers.map((folder) => folder.position))
              : 0) + 1,
          hash: '',
        };
        state.hash = collectionHash(state);
        folders.set(state.id, state);
        events.push(`create-folder:${state.id}`);
        return folderResponse(state);
      },
      async update(
        id: string,
        body: {
          label?: string;
          parent?: { id: string } | null;
          position?: number;
        },
      ) {
        const old = structuredClone(folderGet(id));
        const parentId =
          body.parent === undefined ? old.parentId : body.parent?.id ?? null;
        let ancestor = parentId;
        while (ancestor) {
          assert.notEqual(ancestor, id, 'folder parent cycle');
          ancestor = folderGet(ancestor).parentId;
        }
        const position = body.position ?? old.position;
        for (const sibling of folders.values()) {
          if (sibling.id === id) continue;
          if (old.parentId === parentId) {
            if (
              sibling.parentId === parentId &&
              sibling.position >= Math.min(old.position, position) &&
              sibling.position <= Math.max(old.position, position)
            )
              sibling.position += position < old.position ? 1 : -1;
          } else {
            if (
              sibling.parentId === old.parentId &&
              sibling.position >= old.position
            )
              sibling.position--;
            if (sibling.parentId === parentId && sibling.position >= position)
              sibling.position++;
          }
          sibling.hash = collectionHash(sibling);
        }
        const state = {
          ...old,
          label: body.label ?? old.label,
          parentId,
          position,
        };
        state.hash = collectionHash(state);
        folders.set(id, state);
        events.push(`update-folder:${id}`);
        return folderResponse(state);
      },
      async reorder(
        list: Array<{
          id: string;
          type: string;
          position: number;
          parent: { id: string } | null;
        }>,
      ) {
        for (const entry of list) {
          assert.equal(entry.type, 'upload_collection');
          const folder = folderGet(entry.id);
          folder.parentId = entry.parent?.id ?? null;
          folder.position = entry.position;
          folder.hash = collectionHash(folder);
        }
        for (const folder of folders.values()) {
          let ancestor = folder.parentId;
          while (ancestor) {
            assert.notEqual(ancestor, folder.id, 'folder parent cycle');
            ancestor = folderGet(ancestor).parentId;
          }
        }
        events.push('reorder-folders');
        return list.map((entry) => folderResponse(folderGet(entry.id)));
      },
      async destroy(id: string) {
        const old = folderGet(id);
        assert(
          ![...folders.values()].some((folder) => folder.parentId === id),
          'folder still has children',
        );
        assert(
          ![...uploads.values()].some((upload) => upload.collectionId === id),
          'folder still has assets',
        );
        folders.delete(id);
        events.push(`destroy-folder:${id}`);
        return folderResponse(old);
      },
    },
    uploads: {
      async find(id: string) {
        const upload = uploads.get(id);
        assert(upload);
        return uploadResponse(upload);
      },
      async createFromUrl(body: JsonObject) {
        const id = String(body.id);
        assert(!uploads.has(id));
        const { id: _id, ...rest } = body;
        const upload = uploaded(
          {
            id,
            hash: '',
            md5: '',
            size: 0,
            url: '',
            filename: '',
            collectionId: null,
            attributes: {},
          },
          rest,
        );
        uploads.set(id, {
          ...upload,
          url: `https://assets.example.test/${id}`,
        });
        events.push(`create-upload:${id}`);
        return uploadResponse(uploads.get(id)!);
      },
      async updateFromUrl(id: string, body: JsonObject) {
        const current = uploads.get(id);
        assert(current);
        uploads.set(id, uploaded(current, body));
        events.push(`replace-upload:${id}`);
        return uploadResponse(uploads.get(id)!);
      },
      async update(id: string, body: JsonObject) {
        const current = uploads.get(id);
        assert(current);
        assert.equal(body.path, undefined);
        uploads.set(id, updated(current, body));
        events.push(`update-upload:${id}`);
        return uploadResponse(uploads.get(id)!);
      },
      async destroy(id: string) {
        const upload = uploads.get(id);
        assert(upload);
        for (const record of records.values())
          for (const ref of recordReferences(record, definition))
            assert(
              !(ref.kind === 'upload' && ref.targetId === id),
              'asset still referenced',
            );
        uploads.delete(id);
        events.push(`destroy-upload:${id}`);
        return uploadResponse(upload);
      },
    },
  };
  return {
    client: client as unknown as ContentMigrationClient,
    events,
    /** Every record update, and whether it was locked to a version. */
    updates,
    /** Models whose records were listed, once per listing. */
    lists,
    records,
    uploads,
    folders,
    remoteFiles,
    definition,
    snapshot(destination: SnapshotStore) {
      for (const record of records.values()) {
        record.hash = recordHash(record);
        destination.putRecord('source', record);
        for (const ref of recordReferences(record, schema))
          destination.putReference('source', ref);
      }
      for (const upload of uploads.values())
        destination.putUpload('source', upload);
      for (const folder of folders.values())
        destination.putCollection('source', folder);
    },
  };
}

export async function executeGeneratedScript(
  file: string,
  client: ContentMigrationClient,
): Promise<void> {
  const source = await readFile(file, 'utf8');
  const transformed = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  assert.deepEqual(
    transformed.diagnostics?.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  const localRequire = createRequire(file);
  const module = {
    exports: {} as {
      default: (client: ContentMigrationClient) => Promise<void>;
    },
  };
  const runtime = {
    defineContentMigration: (
      _options: unknown,
      callback: (client: ContentMigrationClient) => Promise<void>,
    ) => callback,
    runMigrationPart: (client: ContentMigrationClient, path: string) =>
      executeGeneratedScript(path, client),
    reorderRecords,
  };
  compileFunction(
    transformed.outputText,
    ['require', 'module', 'exports', '__dirname', '__filename'],
    { filename: file },
  )(
    (specifier: string) =>
      specifier === '@datocms/cli-plugin-content-diff/migration'
        ? runtime
        : localRequire(specifier),
    module,
    module.exports,
    dirname(file),
    file,
  );
  await module.exports.default(client);
}
