import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffFile, writeDiff } from '../src/engine/diff-file';
import { planOperations } from '../src/engine/emit';
import { assertExpectations, runOperations } from '../src/engine/execution';
import type { Operation } from '../src/engine/operations';
import { type Plan, createPlan } from '../src/engine/planner';
import { SideIndex, type SideOptions } from '../src/engine/side';
import type {
  Client,
  CollectionState,
  PlanOptions,
  RecordState,
  SchemaState,
  UploadState,
} from '../src/engine/types';
import { cmaFixture } from './cma-fixture';

/** One side of a diff, as tests write it. */
export interface Content {
  records: RecordState[];
  uploads: UploadState[];
  collections: CollectionState[];
}

export function content(parts: Partial<Content> = {}): Content {
  return {
    records: parts.records ?? [],
    uploads: parts.uploads ?? [],
    collections: parts.collections ?? [],
  };
}

/** A side index holding `side`, in a fresh temporary directory. */
export async function sideIndex(
  directory: string,
  schema: SchemaState,
  side: Content,
  options?: SideOptions,
  buckets = 4,
): Promise<SideIndex> {
  const index = new SideIndex(directory, schema, buckets, options);
  for (const record of side.records)
    await index.record(structuredClone(record));
  for (const upload of side.uploads)
    await index.upload(structuredClone(upload));
  for (const folder of side.collections) await index.collection(folder);
  await index.flush();
  return index;
}

export interface DiffArgs {
  source: Content;
  target: Content;
  sourceSchema: SchemaState;
  /** Defaults to the source schema in a `target` environment. */
  targetSchema?: SchemaState;
  options: PlanOptions;
  /** Upload new files from the diff's own entries instead of URLs. */
  assetFiles?: boolean;
}

/** Plans two sides and returns the plan and its operations in run order. */
export async function diff(
  args: DiffArgs,
): Promise<{ plan: Plan; operations: Operation[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-test-'));
  try {
    const targetSchema = args.targetSchema ?? {
      ...args.sourceSchema,
      environmentId: 'target',
    };
    const source = await sideIndex(
      join(directory, 'source'),
      args.sourceSchema,
      args.source,
      { models: new Set(args.options.modelIds), payloadSchema: targetSchema },
    );
    const target = await sideIndex(
      join(directory, 'target'),
      targetSchema,
      args.target,
      { models: new Set(args.options.modelIds) },
    );
    const plan = await createPlan(source, target, args.options);
    const operations: Operation[] = [];
    for await (const operation of planOperations({
      plan,
      source,
      target,
      directory,
      assetFiles: !!args.assetFiles,
    }))
      operations.push(operation);
    return { plan, operations };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Writes operations as a diff zip for `plan` in `directory`. */
export async function writeTestDiff(
  directory: string,
  plan: Plan,
  operations: Operation[],
  name = 'test.diff-records.zip',
): Promise<string> {
  const path = join(directory, name);
  const tracking = { apiKey: 'schema_migration', model: null };
  await writeDiff({
    path,
    manifest: {
      includesAssets: false,
      source: { kind: 'environment', ...plan.metadata.source },
      destination: plan.metadata.destination,
      schemaHash: plan.metadata.schema.hash,
      sourceTracking: tracking,
      destinationTracking: tracking,
      options: plan.metadata.options,
      counts: plan.metadata.counts,
    },
    operations: (async function* () {
      yield* operations;
    })(),
  });
  return path;
}

/** Runs a diff's checks and operations against a client. */
export async function run(client: Client, path: string): Promise<void> {
  const file = await DiffFile.open(path);
  try {
    await assertExpectations(client, file, { concurrency: 2 });
    await runOperations(client, file, {});
  } finally {
    file.close();
  }
}

/**
 * Plans `source` against `target`, runs the diff against an in-memory CMA
 * holding `target`, and checks that planning again finds nothing to do.
 */
export async function replay(args: DiffArgs) {
  const { plan, operations } = await diff(args);
  const targetSchema = args.targetSchema ?? {
    ...args.sourceSchema,
    environmentId: 'target',
  };
  const fixture = cmaFixture(args.target, targetSchema, args.source);
  const directory = await mkdtemp(join(tmpdir(), 'content-diff-test-'));
  try {
    await run(fixture.client, await writeTestDiff(directory, plan, operations));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const again = await diff({ ...args, target: fixture.snapshot() });
  for (const kind of ['record', 'upload', 'collection'] as const)
    for (const action of ['create', 'update', 'delete'] as const)
      assert.equal(
        again.plan.metadata.counts[kind][action],
        0,
        `${kind} ${action} after replay: ${JSON.stringify(
          again.operations.map((operation) => operation.label),
        )}`,
      );
  return { plan, operations, fixture };
}
