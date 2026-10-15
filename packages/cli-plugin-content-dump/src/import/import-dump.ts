import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CmaClient } from '@datocms/cli-utils';
import { assetEntryName, downloadAsset } from '../dump/assets';
import type { Dump, Upload, UploadCollection } from '../dump/format';
import { type SchemaView, contentModelSettings } from '../schema';
import {
  forEachConcurrently,
  runInDependencyOrder,
} from '../utils/concurrency';
import { describeFailure, userError } from '../utils/errors';
import { type CreationPlan, planCreation } from './creation-order';
import { writableAttributes } from './fields';
import { importedId } from './ids';
import { type RecordNode, indexRecords, stageToSet } from './record-index';
import { RecordStore } from './record-store';

export interface ImportResult {
  environment: string;
  counts: {
    uploadCollections: number;
    uploads: number;
    records: number;
    published: number;
  };
  /** Records of the migration tracking model, which are left out. */
  skippedRecords: number;
  /** Schedules whose time had already passed, which are not recreated. */
  skippedSchedules: number;
}

interface Context {
  dump: Dump;
  client: CmaClient.Client;
  environment: string;
  schema: SchemaView;
  /** A temporary directory, emptied and removed by the caller. */
  directory: string;
  progress: (message: string) => void;
}

/**
 * Writes the dump's content into an environment that has the dump's schema
 * and no content: its upload folders, its uploads, then its records in an
 * order the CMA accepts (see creation-order.ts), and finally what needs
 * every record to exist: fields left out of cycles, newer drafts, workflow
 * stages and schedules. The first failure stops the import.
 */
export async function importDump(context: Context): Promise<ImportResult> {
  const store = RecordStore.create(context.directory);
  try {
    context.progress('Reading the dump');
    const { nodes, records, skipped } = await indexRecords(
      context.dump.zip,
      context.schema,
      store,
    );
    const plan = planCreation(nodes);
    const uploadCollections = await createFolders(context);
    const uploads = await createUploads(context);
    await createRecords(context, store, nodes, records, plan);
    const skippedSchedules = await finishRecords(
      context,
      store,
      nodes,
      records,
      plan,
    );
    return {
      environment: context.environment,
      counts: {
        uploadCollections,
        uploads,
        records: records.length,
        published: records.filter((index) => nodes[index]!.status !== 'draft')
          .length,
      },
      skippedRecords: skipped,
      skippedSchedules,
    };
  } finally {
    store.close();
  }
}

/** Runs one CMA call, and names it when it fails. */
async function step<T>(
  context: Context,
  description: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw userError(
      'IMPORT_FAILED',
      `The import stopped while ${description}: ${describeFailure(error)}.`,
      [
        `Environment "${context.environment}" may hold part of the dump. Fix the cause, destroy the environment with "datocms environments:destroy ${context.environment}", and import into a new empty sandbox environment with the dump's schema.`,
      ],
    );
  }
}

/** Folders, parents first, each sibling group in ascending position. */
async function createFolders(context: Context): Promise<number> {
  const folders: UploadCollection[] = [];
  for await (const { value } of context.dump.zip.lines('upload-collections'))
    folders.push(value as UploadCollection);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const depth = (folder: UploadCollection) => {
    let levels = 0;
    for (
      let parent = folder.parent;
      parent;
      parent = byId.get(parent.id)!.parent
    )
      levels++;
    return levels;
  };
  const ordered = [...folders].sort(
    (a, b) => depth(a) - depth(b) || a.position - b.position,
  );
  for (const folder of ordered)
    await step(context, `creating folder ${folder.id} "${folder.label}"`, () =>
      context.client.uploadCollections.create({
        id: importedId(folder.id),
        label: folder.label,
        parent: folder.parent && {
          type: 'upload_collection',
          id: importedId(folder.parent.id),
        },
        position: folder.position,
      }),
    );
  return folders.length;
}

async function createUploads(context: Context): Promise<number> {
  const total = context.dump.manifest.counts.uploads;
  if (total) context.progress(`Creating ${total} uploads`);
  let created = 0;
  await forEachConcurrently(context.dump.zip.lines('uploads'), async (line) => {
    const upload = line.value as Upload;
    await step(
      context,
      `creating upload ${upload.id} "${upload.filename}"`,
      () => createUpload(context, upload),
    );
    if (++created % 100 === 0)
      context.progress(`Created ${created} of ${total} uploads`);
  });
  return created;
}

/**
 * Creates an upload with its metadata, from the dump's copy of its file
 * when the dump has one, otherwise from the original file at its URL. The
 * file is first written to the temporary directory under the upload's
 * extension, from which the SDK takes its content type.
 */
async function createUpload(context: Context, upload: Upload): Promise<void> {
  const { dump } = context;
  const localPath = join(
    context.directory,
    `${upload.id}${extname(upload.filename)}`,
  );
  try {
    await pipeline(
      dump.manifest.includesAssets
        ? await dump.zip.stream(assetEntryName(upload.id, upload.filename))
        : await downloadAsset(upload, 'To import it from its URL'),
      createWriteStream(localPath),
    );
    // The CMA derives the basename from the filename.
    await context.client.uploads.createFromLocalFile({
      id: importedId(upload.id),
      localPath,
      filename: upload.filename,
      author: upload.author,
      copyright: upload.copyright,
      notes: upload.notes,
      tags: upload.tags,
      default_field_metadata: upload.default_field_metadata,
      upload_collection: upload.upload_collection && {
        type: 'upload_collection',
        id: importedId(upload.upload_collection.id),
      },
    });
  } finally {
    await rm(localPath, { force: true });
  }
}

function recordName(context: Context, node: RecordNode): string {
  return `record ${node.id} (${context.schema.models[node.modelId]!.apiKey})`;
}

/** Whether a record is published by its own call, not by its create. */
function publishesSeparately(context: Context, node: RecordNode): boolean {
  return (
    node.status !== 'draft' &&
    contentModelSettings(context.schema, node.modelId).draftMode
  );
}

/**
 * Creates every record, and publishes those the dump has published, in
 * dependency order. A record is created with the content it is published
 * with, its newer draft coming later.
 */
async function createRecords(
  context: Context,
  store: RecordStore,
  nodes: RecordNode[],
  records: number[],
  plan: CreationPlan,
): Promise<void> {
  context.progress(`Creating ${records.length} records`);
  let created = 0;
  await runInDependencyOrder(records, plan.dependencies, async (index) => {
    const node = nodes[index]!;
    const id = importedId(node.id);
    const deferred = plan.deferred.get(index);
    const { current, published } = store.read(node.stored!);
    const name = recordName(context, node);
    const parentId = current.attributes.parent_id as string | null;
    await step(
      context,
      deferred
        ? `creating ${name} without its fields ${[...deferred].join(
            ', ',
          )}, which link to records created after it`
        : `creating ${name}`,
      () =>
        context.client.items.rawCreate({
          data: {
            type: 'item',
            id,
            attributes: {
              ...writableAttributes(
                context.schema,
                node.modelId,
                (published ?? current).attributes,
                { emptied: deferred },
              ),
              ...(contentModelSettings(context.schema, node.modelId).tree && {
                parent_id: parentId && importedId(parentId),
              }),
            },
            relationships: {
              item_type: { data: { type: 'item_type', id: node.modelId } },
            },
            meta: {
              created_at: current.meta.created_at,
              first_published_at: current.meta.first_published_at,
            },
          },
        }),
    );
    if (publishesSeparately(context, node))
      await step(context, `publishing ${name}`, () =>
        context.client.items.publish(id, undefined, { recursive: false }),
      );
    if (++created % 1000 === 0)
      context.progress(`Created ${created} of ${records.length} records`);
  });
}

/**
 * Once every record exists: writes the fields left out of cycles (and
 * publishes them), newer drafts, workflow stages and schedules still to
 * come. Returns how many schedules had already passed.
 */
async function finishRecords(
  context: Context,
  store: RecordStore,
  nodes: RecordNode[],
  records: number[],
  plan: CreationPlan,
): Promise<number> {
  const pending = records.filter(
    (index) => nodes[index]!.finish || plan.deferred.has(index),
  );
  if (pending.length) context.progress(`Finishing ${pending.length} records`);
  let skippedSchedules = 0;
  await forEachConcurrently(pending, async (index) => {
    const node = nodes[index]!;
    const id = importedId(node.id);
    const deferred = plan.deferred.get(index);
    const { current, published } = store.read(node.stored!);
    const name = recordName(context, node);
    const update = (attributes: Record<string, unknown>) =>
      context.client.items.rawUpdate(id, {
        data: { type: 'item', id, attributes },
      });
    if (deferred) {
      await step(
        context,
        `writing the fields ${[...deferred].join(', ')} of ${name}`,
        () =>
          update(
            writableAttributes(
              context.schema,
              node.modelId,
              (published ?? current).attributes,
              { only: deferred },
            ),
          ),
      );
      if (publishesSeparately(context, node))
        await step(context, `publishing ${name}`, () =>
          context.client.items.publish(id, undefined, { recursive: false }),
        );
    }
    if (node.status === 'updated')
      await step(context, `writing the current version of ${name}`, () =>
        update(
          writableAttributes(context.schema, node.modelId, current.attributes),
        ),
      );
    const stage = stageToSet(context.schema, node.modelId, current);
    if (stage)
      await step(context, `moving ${name} to stage ${stage}`, () =>
        context.client.items.update(id, { meta: { stage } }),
      );
    // The CMA refuses a schedule whose time has passed, which, during a long
    // import, can happen to one that was still to come when it started.
    const schedule = async (
      kind: string,
      at: string | null,
      create: (at: string) => Promise<unknown>,
    ) => {
      if (!at) return;
      if (Date.parse(at) <= Date.now()) {
        skippedSchedules++;
        return;
      }
      await step(context, `scheduling the ${kind} of ${name}`, () =>
        create(at),
      );
    };
    await schedule('publication', current.meta.publication_scheduled_at, (at) =>
      context.client.scheduledPublication.create(id, {
        publication_scheduled_at: at,
      }),
    );
    await schedule(
      'unpublishing',
      current.meta.unpublishing_scheduled_at,
      (at) =>
        context.client.scheduledUnpublishing.create(id, {
          unpublishing_scheduled_at: at,
        }),
    );
  });
  return skippedSchedules;
}
