import { createHash } from 'node:crypto';
import * as assetDownload from '../../src/engine/asset-download';
import { hashJson, recordHash } from '../../src/engine/codec';
import {
  loadBaseline,
  writeMigration,
} from '../../src/engine/migration-artifact';
import { PlannerGraph } from '../../src/engine/planner-graph';
import type { SnapshotStore } from '../../src/engine/store';
import type {
  BinaryFile,
  PlanCounts,
  PlanEntry,
  PlanMetadata,
  RecordPlan,
  RecordState,
  UploadState,
} from '../../src/engine/types';
export const digest = (bytes: string | Buffer, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');

export function record(id: string, modelId = 'model-a'): RecordState {
  const state: RecordState = {
    id,
    modelId,
    current: { title: id },
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
  };
  state.hash = recordHash(state);
  return state;
}

export function recordPlan(
  id: string,
  action: 'noop' | 'update' | 'create' = 'noop',
  modelId = 'model-a',
): RecordPlan {
  const baseline = record(id, modelId);
  const desired =
    action === 'update'
      ? {
          ...baseline,
          current: { title: `${id} changed` },
          hash: '',
        }
      : baseline;
  desired.hash = recordHash(desired);
  return {
    kind: 'record',
    id,
    modelId,
    action,
    guard:
      action === 'create'
        ? null
        : {
            hash: baseline.hash,
            modelId,
            currentVersion: baseline.currentVersion,
            publishedUpdatedAt: baseline.publishedUpdatedAt,
            parentId: null,
            position: null,
            schedules: baseline.schedules,
            validity: baseline.validity,
          },
    baseline: action === 'create' ? null : baseline,
    desired,
    safety: {
      currentReferences: [],
      publishedReferences: [],
      uploadReferences: [],
      blockIds: [],
      desiredParentId: null,
      desiredPosition: null,
    },
    diagnostics: [],
  };
}

export function upload(id: string, bytes: Buffer): UploadState {
  return withUploadHash({
    id,
    hash: '',
    md5: digest(bytes, 'md5'),
    size: bytes.length,
    url: `https://assets.example/${id}`,
    filename: `${id}.bin`,
    collectionId: null,
    attributes: {},
  });
}

export function withUploadHash(state: UploadState): UploadState {
  return {
    ...state,
    hash: hashJson({
      id: state.id,
      md5: state.md5,
      size: state.size,
      filename: state.filename,
      collectionId: state.collectionId,
      attributes: state.attributes,
    }),
  };
}

export function uploadCreate(id: string, bytes: Buffer): PlanEntry {
  return {
    kind: 'upload',
    id,
    action: 'create',
    guard: null,
    baseline: null,
    desired: upload(id, bytes),
    diagnostics: [],
  };
}

export function metadata(entries: PlanEntry[]): PlanMetadata {
  const counts = Object.fromEntries(
    ['record', 'upload', 'collection'].map((kind) => [
      kind,
      Object.fromEntries(
        ['create', 'update', 'delete', 'noop', 'skip'].map((action) => [
          action,
          0,
        ]),
      ),
    ]),
  ) as PlanCounts;
  for (const entry of entries) counts[entry.kind][entry.action]++;
  const models = [
    ...new Set(
      entries
        .filter((entry) => entry.kind === 'record')
        .map((entry) => (entry as RecordPlan).modelId),
    ),
  ].map((id) => ({
    id,
    apiKey: 'article',
    name: 'Article',
    block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draftMode: true,
    saveInvalidDrafts: true,
    allLocalesRequired: false,
    workflowId: null,
    fields: ['title', 'large'].map((apiKey) => ({
      id: `${id}-${apiKey}`,
      apiKey,
      type: 'string',
      localized: false,
      validators: {},
      defaultValue: null,
    })),
  }));
  return {
    source: { siteId: 'site', environmentId: 'source' },
    destination: { siteId: 'site', environmentId: 'target' },
    schema: {
      siteId: 'site',
      environmentId: 'target',
      locales: ['en'],
      semantics: {},
      models,
      workflows: [],
      hash: hashJson({
        locales: ['en'],
        semantics: {},
        models,
        workflows: [],
      }),
    },
    options: {
      modelIds: ['model-a'],
      uploads: 'referenced',
      includeDeletions: false,
      allowPartial: false,
      allowTemporarySchemaChanges: false,
    },
    counts,
    temporarySchemaChanges: [],
  };
}

const tracking = { apiKey: 'schema_migration', model: null };
/** Exercise the production TS writer; only its download clock is substituted. */
export async function writeFixture(
  args: Omit<
    Parameters<typeof writeMigration>[0],
    'sourceTracking' | 'destinationTracking'
  > & {
    retryWait?: Parameters<typeof assetDownload.fetchBinary>[3];
    idleTimeout?: number;
  },
): Promise<string> {
  // Artifact fixtures insert plans directly, including the folder ordering
  // normally supplied by the generation planner.
  const graph = new PlannerGraph(args.store.database);
  graph.clear('collection-final-parent-proof');
  for (const entry of args.store.planEntries()) {
    if (entry.baseline) {
      if (entry.kind === 'record')
        args.store.putRecord('target', entry.baseline);
      else if (entry.kind === 'upload')
        args.store.putUpload('target', entry.baseline);
      else args.store.putCollection('target', entry.baseline);
    }
    if (entry.kind === 'record' && entry.desired)
      args.store.putRecord('source', entry.desired);
    if (entry.kind === 'collection' && entry.desired) {
      graph.node('collection-final-parent-proof', 'collection', entry.id);
      if (entry.desired.parentId)
        graph.edge(
          'collection-final-parent-proof',
          'collection',
          entry.id,
          'collection',
          entry.desired.parentId,
          'parent',
        );
    }
  }
  graph.order('collection-final-parent-proof');
  const original = assetDownload.fetchBinary;
  Reflect.set(
    assetDownload,
    'fetchBinary',
    (...values: Parameters<typeof original>) => {
      if (args.retryWait) values[3] = args.retryWait;
      if (args.idleTimeout !== undefined) values[4] = args.idleTimeout;
      return original(...values);
    },
  );
  try {
    const script = await writeMigration({
      ...args,
      outputPath: `${args.outputPath}.ts`,
      sourceTracking: tracking,
      destinationTracking: tracking,
    });
    return `${script.slice(0, -3)}.content`;
  } finally {
    Reflect.set(assetDownload, 'fetchBinary', original);
  }
}
export const binaryFor = (
  store: SnapshotStore,
  id: string,
): { binary: BinaryFile; url: string } | undefined => {
  const row = store.database
    .prepare('SELECT data FROM migration_baseline_binaries WHERE upload_id=?')
    .get(id);
  return row ? JSON.parse(String(row.data)) : undefined;
};
export async function readFixture(args: {
  directory: string;
  store: SnapshotStore;
  signal?: AbortSignal;
}) {
  return loadBaseline(args.directory, args.store, args.signal);
}
