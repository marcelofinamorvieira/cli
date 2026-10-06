import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  inspectRecord,
  recordHash,
} from '../../src/engine/codec';
import { fieldFailures } from '../../src/engine/planner-validity';
import type { SnapshotStore } from '../../src/engine/store';
import type {
  CollectionState,
  JsonObject,
  RecordState,
  SchemaState,
  UploadState,
} from '../../src/engine/types';
import type { ContentMigrationClient } from '../../src/migration';

/** Stateful remote contract: writes execute immediately and enforce live dependencies. */
export function directClientFixture(store: SnapshotStore, schema: SchemaState) {
  const definition = structuredClone(schema);
  const records = new Map(
    [...store.iterateRecords('target')].map((record) => [
      record.id,
      structuredClone(record),
    ]),
  );
  const uploads = new Map(
    [...store.iterateUploads('target')].map((upload) => [
      upload.id,
      structuredClone(upload),
    ]),
  );
  const folders = new Map(
    [...store.iterateCollections('target')].map((folder) => [
      folder.id,
      structuredClone(folder),
    ]),
  );
  const files = new Map<string, { filename: string; bytes: Buffer }>();
  const events: string[] = [];
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
      is_current_version_valid: record.validity.current,
      is_published_version_valid: record.validity.published,
      stage: record.stage,
    },
  });
  const valid = (record: RecordState) =>
    model(record.modelId).fields.every(
      (field) =>
        fieldFailures(field, record.current[field.apiKey]).length === 0,
    );
  const links = (record: RecordState, published = false) => {
    for (const ref of inspectRecord({ ...record, published: null }, definition)
      .references) {
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
  const order = (record: RecordState, old?: RecordState) => {
    const definition = model(record.modelId);
    if (!definition.sortable && !definition.tree) return;
    if (
      old &&
      record.parentId === old.parentId &&
      record.position === old.position
    )
      return;
    for (const peer of records.values()) {
      if (peer.id === record.id || peer.modelId !== record.modelId) continue;
      if (
        old &&
        peer.parentId === old.parentId &&
        peer.position! > old.position!
      )
        peer.position!--;
      if (
        peer.parentId === record.parentId &&
        peer.position! >= record.position!
      )
        peer.position!++;
      peer.hash = recordHash(peer);
    }
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
  const fromFile = (id: string, path: string): UploadState => {
    const file = files.get(path);
    assert(file, `expected uploaded remote path, got ${path}`);
    return canonicalUpload({
      id,
      type: 'upload',
      md5: createHash('md5').update(file.bytes).digest('hex'),
      size: file.bytes.length,
      url: `https://assets.example.test/${file.filename}`,
      filename: file.filename,
      basename: basename(file.filename, extname(file.filename)),
      format: extname(file.filename).slice(1) || null,
      upload_collection: null,
    });
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

        const initial = definition.workflows.find(
          (workflow) => workflow.id === type.workflowId,
        )?.stages;
        const stage = Array.isArray(initial)
          ? initial.find(
              (stage) =>
                typeof stage === 'object' &&
                stage !== null &&
                !Array.isArray(stage) &&
                stage.initial === true,
            )
          : null;
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
          position: typeof body.position === 'number' ? body.position : null,
          stage:
            stage && typeof stage === 'object' && !Array.isArray(stage)
              ? String(stage.id)
              : null,
          schedules: { publication: null, unpublishing: null },
          validity: { current: true, published: null },
          hash: '',
        };
        links(record, !type.draftMode);
        record.validity.current = valid(record);
        assert(
          type.saveInvalidDrafts || record.validity.current,
          'invalid record creation',
        );
        if (!type.draftMode) {
          record.published = structuredClone(fields);
          record.validity.published = record.validity.current;
        }
        order(record);
        events.push(`create:${id}`);
        return save(record);
      },
      async update(id: string, body: JsonObject) {
        const old = structuredClone(get(id));
        const record = structuredClone(old);
        const type = model(record.modelId);
        const meta = (body.meta ?? {}) as JsonObject;
        assert.equal(
          meta.current_version,
          old.currentVersion,
          'optimistic version missing/stale',
        );
        record.current = canonicalFields(
          { ...record.current, ...body },
          record.modelId,
          definition,
        );
        if ('parent_id' in body)
          record.parentId = body.parent_id as string | null;
        if ('position' in body) record.position = Number(body.position);
        if ('created_at' in meta) record.createdAt = String(meta.created_at);
        if ('first_published_at' in meta)
          record.firstPublishedAt = meta.first_published_at as string | null;
        if ('stage' in meta) record.stage = meta.stage as string | null;
        links(record, !type.draftMode);
        record.validity.current = valid(record);
        assert(
          type.saveInvalidDrafts || record.validity.current,
          'invalid record update',
        );
        if (!type.draftMode) {
          record.published = structuredClone(record.current);
          record.validity.published = record.validity.current;
        }
        record.currentVersion = String(++revision);
        order(record, old);
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
        assert(record.validity.current, 'publish persisted invalid record');
        links(record, true);
        record.published = structuredClone(record.current);
        record.validity.published = true;
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
        record.validity.published = null;
        events.push(`unpublish:${id}`);
        return save(record);
      },
      async destroy(id: string) {
        const old = get(id);
        for (const peer of records.values())
          if (peer.id !== id)
            for (const ref of inspectRecord(peer, definition).references)
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
              peer.hash = recordHash(peer);
            }
        events.push(`destroy:${id}`);
        return response(old);
      },
    },
    fields: {
      async find(id: string) {
        const field = definition.models
          .flatMap((model) => model.fields)
          .find((field) => field.id === id);
        assert(field);
        return {
          id,
          validators: structuredClone(field.validators),
          default_value: structuredClone(field.defaultValue),
        };
      },
      async update(
        id: string,
        body: { validators: JsonObject; default_value: unknown },
      ) {
        const field = definition.models
          .flatMap((model) => model.fields)
          .find((field) => field.id === id);
        assert(field);
        field.validators = structuredClone(body.validators);
        field.defaultValue = body.default_value as typeof field.defaultValue;
        events.push(`field:${id}`);
        return this.find(id);
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
          assert(record.validity.current, 'scheduling invalid content');
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
      async create(body: { id: string; path: string }) {
        assert(!uploads.has(body.id));
        const upload = fromFile(body.id, body.path);
        uploads.set(body.id, upload);
        events.push(`create-upload:${body.id}`);
        return uploadResponse(upload);
      },
      async update(
        id: string,
        body: JsonObject,
        options?: { replace_strategy: string },
      ) {
        let current = uploads.get(id);
        assert(current);
        if (typeof body.path === 'string') {
          assert.equal(options?.replace_strategy, 'create_new_url');
          current = {
            ...fromFile(id, body.path),
            collectionId: current.collectionId,
            attributes: current.attributes,
          };
        }
        const { path: _path, upload_collection, ...attributes } = body;
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
        const saved = canonicalUpload({
          ...uploadResponse(current),
          ...merged,
          filename,
          upload_collection: collectionId
            ? { id: collectionId, type: 'upload_collection' }
            : null,
        });
        uploads.set(id, saved);
        events.push(`update-upload:${id}`);
        return uploadResponse(saved);
      },
      async destroy(id: string) {
        const upload = uploads.get(id);
        assert(upload);
        for (const record of records.values())
          for (const ref of inspectRecord(record, definition).references)
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
    records,
    folders,
    definition,
    async uploadFile(
      _client: ContentMigrationClient,
      path: string,
      filename: string,
    ) {
      const key = `remote-upload-${files.size}`;
      files.set(key, { filename, bytes: await readFile(path) });
      events.push(`upload-file:${filename}`);
      return key;
    },
    snapshot(destination: SnapshotStore) {
      for (const record of records.values()) {
        record.hash = recordHash(record);
        destination.putRecord('source', record);
        const inspected = inspectRecord(record, schema);
        for (const ref of inspected.references)
          destination.putReference('source', ref);
        for (const block of inspected.blockOwners)
          destination.putBlockOwner('source', block);
        for (const value of inspected.uniqueValues)
          destination.putUniqueValue('source', value);
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
  uploadFile: (
    client: ContentMigrationClient,
    path: string,
    filename: string,
  ) => Promise<string>,
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
      executeGeneratedScript(path, client, uploadFile),
    checkMigration: () => undefined,
    uploadMigrationFile: uploadFile,
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
