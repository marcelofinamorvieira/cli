import { join } from 'node:path';
import {
  recordReferences,
  recordTitle,
  unsupportedRecordPayloadKey,
} from './codec';
import { SpillFiles, bucketOf, byBucket } from './spill';
import type {
  CollectionState,
  RecordFacts,
  RecordState,
  ReferenceFact,
  SchemaState,
  UploadFacts,
  UploadState,
} from './types';

/** Where captured content goes, one entry at a time. */
export interface SideSink {
  record(state: RecordState): Promise<void>;
  upload(state: UploadState): Promise<void>;
  collection(state: CollectionState): Promise<void>;
}

/** The top-level field a captured reference path belongs to. */
function rootField(path: string): string {
  return /^[^.[\]]+/.exec(path)?.[0] ?? '';
}

/** The ID of a stored state line without parsing it whole. */
function lineId(line: string): string {
  // States are written with their ID first.
  return line.startsWith('{"id":"')
    ? JSON.parse(line.slice(6, line.indexOf('"', 7) + 1))
    : (JSON.parse(line) as { id: string }).id;
}

export interface SideOptions {
  /** Models whose records the diff may change. */
  models?: Set<string>;
  /** The schema writes are checked against for values the SDK would corrupt. */
  payloadSchema?: SchemaState;
}

/**
 * One side of a diff: the facts planning needs in memory, and the full
 * records and uploads in bucket files on disk, read back one bucket at a time.
 * A record's references are read only for the records the plan changes
 * (`loadDetails`); every record contributes the uploads it references.
 */
export class SideIndex implements SideSink {
  readonly records = new Map<string, RecordFacts>();
  readonly uploads = new Map<string, UploadFacts>();
  readonly collections = new Map<string, CollectionState>();
  /** Uploads referenced by records of the selected models. */
  readonly referencedUploads = new Set<string>();
  private readonly recordFiles: SpillFiles;
  private readonly uploadFiles: SpillFiles;
  private readonly roots = new Map<string, string>();

  constructor(
    directory: string,
    readonly schema: SchemaState,
    readonly buckets: number,
    private readonly options: SideOptions = {},
  ) {
    this.recordFiles = new SpillFiles(join(directory, 'records'));
    this.uploadFiles = new SpillFiles(join(directory, 'uploads'));
  }

  /** One string per field, however many references sit in it. */
  private root(path: string): string {
    const root = rootField(path);
    const known = this.roots.get(root);
    if (known) return known;
    this.roots.set(root, root);
    return root;
  }

  async record(state: RecordState): Promise<void> {
    const line = JSON.stringify(state);
    const facts: RecordFacts = {
      id: state.id,
      modelId: state.modelId,
      hash: state.hash,
      published: state.published !== null,
      parentId: state.parentId,
      position: state.position,
      references: [],
      bytes: line.length,
    };
    if (state.invalid) facts.invalid = state.invalid;
    const title = recordTitle(state.modelId, this.schema, state.current);
    if (title) facts.title = title;
    if (this.options.models?.has(state.modelId))
      for (const reference of recordReferences(state, this.schema))
        if (reference.kind === 'upload')
          this.referencedUploads.add(reference.targetId);
    this.records.set(state.id, facts);
    await this.recordFiles.append(bucketOf(state.id, this.buckets), line);
  }

  async upload(state: UploadState): Promise<void> {
    const { id, hash, md5, size, collectionId, filename } = state;
    this.uploads.set(id, { id, hash, md5, size, collectionId, filename });
    await this.uploadFiles.append(
      bucketOf(id, this.buckets),
      JSON.stringify(state),
    );
  }

  async collection(state: CollectionState): Promise<void> {
    this.collections.set(state.id, state);
  }

  async flush(): Promise<void> {
    await this.recordFiles.flush();
    await this.uploadFiles.flush();
  }

  /**
   * Reads the references of `ids`, and the values the SDK would corrupt in
   * the selected models, into their facts.
   */
  async loadDetails(ids: Iterable<string>): Promise<void> {
    const { models, payloadSchema } = this.options;
    for (const [bucket, wanted] of byBucket(ids, this.buckets))
      for (const state of (await this.recordBucket(bucket, wanted)).values()) {
        const facts = this.records.get(state.id)!;
        const references = new Map<string, ReferenceFact>();
        for (const { targetId, kind, path, fieldId } of recordReferences(
          state,
          this.schema,
        )) {
          const root = this.root(path);
          references.set(`${targetId}\0${kind}\0${root}\0${fieldId}`, {
            targetId,
            kind,
            root,
            fieldId,
          });
        }
        facts.references = [...references.values()];
        const unsupported =
          payloadSchema && models?.has(state.modelId)
            ? [state.current, state.published].flatMap((slice) => {
                const key =
                  slice &&
                  unsupportedRecordPayloadKey(
                    slice,
                    state.modelId,
                    payloadSchema,
                  );
                return key ? [key] : [];
              })
            : [];
        if (unsupported.length) facts.unsupportedKeys = unsupported;
      }
  }

  /** The records of one bucket by ID, or only the `wanted` ones. */
  async recordBucket(
    bucket: number,
    wanted?: ReadonlySet<string>,
  ): Promise<Map<string, RecordState>> {
    const result = new Map<string, RecordState>();
    for await (const line of this.recordFiles.lines(bucket)) {
      if (wanted && !wanted.has(lineId(line))) continue;
      const state = JSON.parse(line) as RecordState;
      result.set(state.id, state);
    }
    return result;
  }

  /** The uploads of one bucket by ID, or only the `wanted` ones. */
  async uploadBucket(
    bucket: number,
    wanted?: ReadonlySet<string>,
  ): Promise<Map<string, UploadState>> {
    const result = new Map<string, UploadState>();
    for await (const line of this.uploadFiles.lines(bucket)) {
      if (wanted && !wanted.has(lineId(line))) continue;
      const state = JSON.parse(line) as UploadState;
      result.set(state.id, state);
    }
    return result;
  }
}
