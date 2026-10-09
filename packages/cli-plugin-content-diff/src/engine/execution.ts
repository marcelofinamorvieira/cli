import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CmaClient } from '@datocms/cli-utils';
import { boundedWork } from './bounded-work';
import { assertNotAborted } from './cancellation';
import { canonicalCollection, canonicalUpload } from './codec';
import type { DiffFile } from './diff-file';
import { ContentError, destinationChanged } from './errors';
import {
  CREATES,
  type Expectation,
  type Operation,
  operationKind,
} from './operations';
import { type RecordOrder, reorderRecords } from './reorder-records';
import type { Client, Kind } from './types';

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0]!;
  }
}

const REFERENCE_CODE = /LINK|REFERENC|UNPUBLISHED|^VALIDATION_ITEMS?_/;

/** Turns a CMA rejection into a reportable error. */
export function cmaFailure(error: unknown): unknown {
  if (error instanceof CmaClient.TimeoutError) {
    const { method, url } = error.request;
    const path = requestPath(url);
    return new ContentError(
      'CMA_REQUEST_FAILED',
      `The CMA request ${method} ${path} timed out; it may still have been applied.`,
      { method, url, status: null, errors: [] },
    );
  }
  if (!(error instanceof CmaClient.ApiError)) return error;
  const { method } = error.request;
  const path = requestPath(error.request.url);
  const errors = error.errors.map((entry) => ({
    code: entry.attributes.code,
    details: entry.attributes.details ?? {},
  }));
  const details = {
    method,
    url: error.request.url,
    status: error.response.status,
    errors,
  };
  if (error.findError('STALE_ITEM_VERSION')) {
    const id = /\/items\/([^/]+)/.exec(path)?.[1] ?? 'unknown';
    return new ContentError(
      'RECORD_CHANGED_DURING_APPLY',
      `Record ${id} was modified by someone else while the diff was running.`,
      details,
    );
  }
  const codes = errors.flatMap(({ code, details }) =>
    typeof details.code === 'string' ? [code, details.code] : [code],
  );
  const summary =
    errors
      .map(({ code, details }) =>
        typeof details.field === 'string' && typeof details.code === 'string'
          ? `${code} (${details.field}: ${details.code})`
          : code,
      )
      .join('; ') || `HTTP ${error.response.status}`;
  if (error.response.status !== 422)
    return new ContentError(
      'CMA_REQUEST_FAILED',
      `The CMA request ${method} ${path} failed: ${summary}.`,
      details,
    );
  const hints: string[] = [];
  if (codes.includes('VALIDATION_UNIQUE'))
    hints.push(
      'A unique value may still be held by another record; reorder or edit the diff so that record releases it first.',
    );
  if (codes.some((code) => REFERENCE_CODE.test(code)))
    hints.push(
      'A referenced record or asset may be missing or unpublished; make sure the diff creates or publishes it first.',
    );
  return new ContentError(
    'CMA_VALIDATION_FAILED',
    [`The CMA rejected ${method} ${path}: ${summary}.`, ...hints].join(' '),
    details,
  );
}

/** What one record, upload or folder must be before the diff runs. */
interface Check {
  kind: Kind;
  id: string;
  /** Null: the ID must be free, because the diff creates it. */
  expect: Expectation | null;
}

const BATCH = 100;

/** Compares what the destination holds now with what each check expects. */
async function compareBatch(client: Client, kind: Kind, checks: Check[]) {
  const ids = checks.map((check) => check.id).join(',');
  const found = new Map<string, Expectation>();
  if (kind === 'record') {
    const listing = (version: 'current' | 'published') =>
      client.items.rawList({
        filter: { ids },
        version,
        page: { limit: checks.length },
      });
    const [current, published] = await Promise.all([
      listing('current'),
      listing('published'),
    ]);
    const updated = new Map(
      published.data.map((record) => [
        record.id,
        typeof record.meta.updated_at === 'string'
          ? record.meta.updated_at
          : null,
      ]),
    );
    for (const record of current.data)
      found.set(record.id, {
        currentVersion: record.meta.current_version ?? null,
        publishedUpdatedAt: updated.get(record.id) ?? null,
      });
  } else {
    for (const upload of await client.uploads.list({
      filter: { ids },
      page: { limit: checks.length },
    }))
      found.set(upload.id, { hash: canonicalUpload(upload).hash });
  }
  return found;
}

/**
 * Checks, before any write, that every line of the diff is a known
 * operation, that every ID it creates is free, and that every record,
 * upload and folder it touches is still as it was when the diff was
 * generated. Nothing else in the destination is compared.
 */
export async function assertExpectations(
  client: Client,
  diff: DiffFile,
  options: { concurrency: number; signal?: AbortSignal },
): Promise<number> {
  const checks: Record<Kind, Check[]> = {
    record: [],
    upload: [],
    collection: [],
  };
  let operations = 0;
  for await (const { operation } of diff.operations()) {
    operations++;
    const kind = operationKind(operation.op);
    if (!kind || !operation.id) continue;
    if (CREATES.has(operation.op))
      checks[kind].push({ kind, id: operation.id, expect: null });
    else if (operation.expect)
      checks[kind].push({ kind, id: operation.id, expect: operation.expect });
  }
  const differs = (check: Check, found: Expectation | undefined) => {
    const { kind, id } = check;
    if (!check.expect) {
      if (found) throw destinationChanged({ kind, id, reason: 'added' });
      return;
    }
    if (!found) throw destinationChanged({ kind, id, reason: 'removed' });
    const fields = (value: Expectation) =>
      'hash' in value
        ? [value.hash]
        : [value.currentVersion, value.publishedUpdatedAt];
    if (fields(found).join('\0') !== fields(check.expect).join('\0'))
      throw destinationChanged({ kind, id, reason: 'changed' });
  };
  for (const kind of ['record', 'upload'] as const) {
    const batches: Check[][] = [];
    for (let start = 0; start < checks[kind].length; start += BATCH)
      batches.push(checks[kind].slice(start, start + BATCH));
    await boundedWork(
      batches,
      options.concurrency,
      async (batch) => {
        const found = await compareBatch(client, kind, batch);
        for (const check of batch) differs(check, found.get(check.id));
      },
      options.signal,
    );
  }
  if (checks.collection.length) {
    const folders = new Map<string, Expectation>(
      (await client.uploadCollections.list()).map((folder) => [
        folder.id,
        { hash: canonicalCollection(folder).hash },
      ]),
    );
    for (const check of checks.collection)
      differs(check, folders.get(check.id));
  }
  return operations;
}

/** The body an operation passes to the SDK. */
const body = (operation: Operation) => operation.data as never;
/**
 * The fields of an operation's body, merged before what apply itself
 * controls (the ID it creates), so a line cannot override it.
 */
const fields = (operation: Operation) =>
  operation.data as Record<string, never>;

/** Runs one operation; `files` extracts the diff's asset files. */
async function runOperation(
  client: Client,
  operation: Operation,
  files: (name: string) => Promise<string>,
): Promise<void> {
  const id = operation.id!;
  switch (operation.op) {
    case 'folder.create':
      await client.uploadCollections.create({
        ...fields(operation),
        id,
      } as never);
      return;
    case 'folder.update':
      await client.uploadCollections.update(id, body(operation));
      return;
    case 'folder.delete':
      await client.uploadCollections.destroy(id);
      return;
    case 'folders.reorder':
      await client.uploadCollections.reorder(body(operation));
      return;
    case 'upload.create':
    case 'upload.replace': {
      const localPath = operation.file && (await files(operation.file));
      try {
        // Where the file comes from is the line's `file` or `url`, never a
        // path in its body: the SDK upload helpers read `localPath`.
        const { localPath: _path, url: _url, ...data } = fields(operation);
        const upload =
          operation.op === 'upload.create'
            ? localPath
              ? await client.uploads.createFromLocalFile({
                  ...data,
                  id,
                  localPath,
                })
              : await client.uploads.createFromUrl({
                  ...data,
                  id,
                  url: operation.url!,
                })
            : localPath
              ? await client.uploads.updateFromLocalFile(id, {
                  ...data,
                  localPath,
                })
              : await client.uploads.updateFromUrl(id, {
                  ...data,
                  url: operation.url!,
                });
        if (upload.md5.toLowerCase() !== operation.md5!.toLowerCase())
          throw new ContentError(
            'ASSET_CHANGED',
            `Asset ${id} was uploaded with a different file than the diff expects: it changed in the source since the diff generation. Please re-generate a diff to apply.`,
          );
      } finally {
        if (localPath) await rm(localPath, { force: true });
      }
      return;
    }
    case 'upload.update':
      await client.uploads.update(id, body(operation));
      return;
    case 'upload.delete':
      await client.uploads.destroy(id);
      return;
    case 'record.create':
      await client.items.create({ ...fields(operation), id } as never);
      return;
    case 'record.update':
      await client.items.update(id, body(operation));
      return;
    case 'record.publish':
      await client.items.publish(id, undefined, { recursive: false });
      return;
    case 'record.unpublish':
      await client.items.unpublish(id, undefined, { recursive: false });
      return;
    case 'record.delete':
      await client.items.destroy(id);
      return;
    case 'records.reorder':
      await reorderRecords(client, operation.data as unknown as RecordOrder);
      return;
    case 'schedule.publication.create':
      await client.scheduledPublication.create(id, body(operation));
      return;
    case 'schedule.publication.delete':
      await client.scheduledPublication.destroy(id);
      return;
    case 'schedule.unpublishing.create':
      await client.scheduledUnpublishing.create(id, body(operation));
      return;
    case 'schedule.unpublishing.delete':
      await client.scheduledUnpublishing.destroy(id);
      return;
  }
}

/**
 * Runs every operation of a diff in order, one at a time. An interrupt stops
 * the run between operations; a failure names the line that caused it.
 */
export async function runOperations(
  client: Client,
  diff: DiffFile,
  options: { signal?: AbortSignal; log?: (message: string) => void },
): Promise<number> {
  const total = diff.manifest.operations;
  const directory = await mkdtemp(join(tmpdir(), 'content-apply-'));
  let extracted = 0;
  const files = async (name: string) => {
    const path = join(directory, String(++extracted));
    await pipeline(await diff.zip.stream(name), createWriteStream(path));
    return path;
  };
  let count = 0;
  try {
    for await (const { operation, where } of diff.operations()) {
      assertNotAborted(options.signal);
      try {
        await runOperation(client, operation, files);
      } catch (error) {
        const failure = cmaFailure(error);
        if (!(failure instanceof ContentError)) throw failure;
        throw new ContentError(
          failure.code,
          `${where}, ${operation.label}: ${failure.message}`,
          { ...failure.details, operation: { where, label: operation.label } },
        );
      }
      if (++count % 500 === 0)
        options.log?.(`Ran ${count} of ${total} operations.`);
    }
    // An interrupt during the last operation still fails the run.
    assertNotAborted(options.signal);
    return count;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
