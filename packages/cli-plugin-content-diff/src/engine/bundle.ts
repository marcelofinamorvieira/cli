import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { boundedWork } from './apply-work';
import { assertNotAborted } from './cancellation';
import {
  assertMetadataIntegerPrecision,
  hashJson,
  recordGuard,
  recordHash,
} from './codec';
import { ContentError } from './errors';
import { suppressedDefaultValue } from './planner-validity';
import { schemaHash } from './schema';
import type { SnapshotStore } from './store';
import type {
  BinaryFile,
  BundleChunk,
  BundleChunkIndex,
  BundleManifest,
  Kind,
  PlanCounts,
  PlanEntry,
  PlanMetadata,
  RecordState,
  SchemaState,
  UploadPlan,
} from './types';

const FORMAT = 'datocms-content-bundle/1';
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_INDEX_FILE = 'chunks.jsonl';
const MAX_INDEX_LINE_BYTES = 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 4;
// A download that receives nothing for this long is retried as transient.
const DOWNLOAD_IDLE_MS = 60_000;
const DOWNLOAD_RETRY_MS = 1000;
const MAX_DOWNLOAD_RETRY_MS = 30_000;
const KINDS = ['collection', 'record', 'upload'] as const;
const ACTIONS = ['create', 'update', 'delete', 'noop', 'skip'] as const;
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

function invalid(message: string): never {
  throw new ContentError('INVALID_BUNDLE', message);
}

/** Object keys are stable, while array order remains part of the content. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return item;
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function nullableText(value: unknown): boolean {
  return value === null || text(value);
}
function timestamp(value: unknown): boolean {
  return text(value) && Number.isFinite(Date.parse(value));
}
function nullableTimestamp(value: unknown): boolean {
  return value === null || timestamp(value);
}
function digest(value: unknown, length: number): value is string {
  return (
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  );
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}
function counts(): PlanCounts {
  return Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      Object.fromEntries(ACTIONS.map((action) => [action, 0])),
    ]),
  ) as PlanCounts;
}

function safeRelative(file: unknown): asserts file is string {
  if (
    !text(file) ||
    isAbsolute(file) ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    invalid('Bundle file paths must be safe relative paths.');
  }
}

/** Reject every traversed symlink, including parent directories inside a bundle. */
export async function safeFile(
  directory: string,
  file: string,
): Promise<FileHandle> {
  safeRelative(file);
  let current = directory;
  const parts = file.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
    ) {
      invalid(`Bundle file is not a regular file: ${file}`);
    }
  }
  // O_NOFOLLOW also closes the final-component check/open race.
  return open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
}

export async function readSmallFile(
  directory: string,
  file: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  assertNotAborted(signal);
  const handle = await safeFile(directory, file);
  try {
    if ((await handle.stat()).size > maximum)
      invalid(`Bundle metadata is too large: ${file}`);
    const bytes = await handle.readFile();
    assertNotAborted(signal);
    return bytes;
  } finally {
    await handle.close();
  }
}

function validateManifest(value: unknown): asserts value is BundleManifest {
  if (
    !object(value) ||
    value.format !== FORMAT ||
    !text(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    invalid('Unsupported bundle format or creation time.');
  for (const name of ['source', 'destination']) {
    const binding = value[name];
    if (
      !object(binding) ||
      !text(binding.siteId) ||
      !text(binding.environmentId)
    )
      invalid(`Invalid ${name} binding.`);
  }
  if (
    !object(value.schema) ||
    !text(value.schema.hash) ||
    !text(value.schema.siteId) ||
    !text(value.schema.environmentId) ||
    !texts(value.schema.locales) ||
    !Array.isArray(value.schema.models) ||
    !Array.isArray(value.schema.workflows) ||
    !object(value.schema.semantics)
  )
    invalid('Invalid bundle schema.');
  if (
    !object(value.options) ||
    !texts(value.options.modelIds) ||
    !['all', 'referenced'].includes(value.options.uploads as string) ||
    ['includeDeletions', 'allowPartial', 'allowTemporarySchemaChanges'].some(
      (key) =>
        typeof (value.options as Record<string, unknown>)[key] !== 'boolean',
    )
  )
    invalid('Invalid bundle options.');
  if (
    !object(value.counts) ||
    KINDS.some(
      (kind) =>
        !object((value.counts as Record<string, unknown>)[kind]) ||
        ACTIONS.some(
          (action) =>
            !count(
              (value.counts as Record<string, Record<string, unknown>>)[kind][
                action
              ],
            ),
        ),
    )
  )
    invalid('Invalid bundle counts.');
  if (
    !Array.isArray(value.temporarySchemaChanges) ||
    !object(value.chunks) ||
    value.chunks.file !== CHUNK_INDEX_FILE ||
    !digest(value.chunks.sha256, 64) ||
    !count(value.chunks.bytes) ||
    !count(value.chunks.count) ||
    (value.chunks.count === 0
      ? value.chunks.bytes !== 0
      : value.chunks.bytes === 0)
  )
    invalid('Invalid bundle metadata.');
  if (schemaHash(value.schema as unknown as SchemaState) !== value.schema.hash)
    invalid('Bundle schema hash differs from its schema state.');
  const changedFields = new Set<string>();
  for (const change of value.temporarySchemaChanges) {
    if (
      !object(change) ||
      !text(change.fieldId) ||
      !text(change.modelId) ||
      !object(change.original) ||
      !object(change.temporary) ||
      !object(change.original.validators) ||
      !object(change.temporary.validators) ||
      !texts(change.reasons) ||
      change.reasons.length === 0 ||
      changedFields.has(change.fieldId)
    )
      invalid('Invalid or duplicate temporary schema change.');
    assertMetadataIntegerPrecision(
      change.original.validators,
      `field ${change.fieldId} original validators`,
    );
    assertMetadataIntegerPrecision(
      change.temporary.validators,
      `field ${change.fieldId} temporary validators`,
    );
    changedFields.add(change.fieldId);
    const model = (value.schema.models as SchemaState['models']).find(
      (model) => model.id === change.modelId,
    );
    const field = model?.fields.find((field) => field.id === change.fieldId);
    if (
      !field ||
      hashJson(change.original.validators) !== hashJson(field.validators) ||
      hashJson(change.original.defaultValue) !== hashJson(field.defaultValue)
    )
      invalid(
        `Temporary schema change has no matching original field: ${change.fieldId}`,
      );
    for (const [key, validator] of Object.entries(
      change.temporary.validators,
    )) {
      if (
        !Object.hasOwn(change.original.validators, key) ||
        hashJson(validator) !== hashJson(change.original.validators[key])
      )
        invalid(
          `Temporary schema change may only remove existing validators: ${change.fieldId}`,
        );
    }
    if (
      hashJson(change.temporary.defaultValue) !==
        hashJson(
          suppressedDefaultValue(field, value.schema.locales as string[]),
        ) &&
      hashJson(change.temporary.defaultValue) !==
        hashJson(change.original.defaultValue)
    )
      invalid(
        `Temporary schema change may only suppress an existing default: ${change.fieldId}`,
      );
  }
  if (changedFields.size && !value.options.allowTemporarySchemaChanges)
    invalid(
      'Temporary schema changes are not authorized by the bundle options.',
    );
}

function chunkPath(position: number): string {
  return `plan/${String(position).padStart(6, '0')}.jsonl`;
}

function validateChunk(
  value: unknown,
  position: number,
): asserts value is BundleChunk {
  if (
    !object(value) ||
    !digest(value.sha256, 64) ||
    !count(value.bytes) ||
    !count(value.entries) ||
    value.entries === 0 ||
    value.bytes === 0
  )
    invalid('Invalid bundle chunk descriptor.');
  safeRelative(value.file);
  // Sequence positions prove uniqueness and deterministic order without a
  // project-sized set of paths in memory.
  if (value.file !== chunkPath(position))
    invalid('Duplicate, unordered, or unsupported bundle chunk path.');
}

export function validateSchedules(value: unknown): boolean {
  if (!object(value)) return false;
  const publication = value.publication;
  if (
    publication !== null &&
    (!object(publication) ||
      !timestamp(publication.at) ||
      (publication.selective !== null &&
        (!object(publication.selective) ||
          !texts(publication.selective.locales) ||
          typeof publication.selective.nonLocalized !== 'boolean')))
  )
    return false;
  const unpublishing = value.unpublishing;
  return (
    unpublishing === null ||
    (object(unpublishing) &&
      timestamp(unpublishing.at) &&
      (unpublishing.locales === null || texts(unpublishing.locales)))
  );
}

export function validateState(value: unknown, entry: PlanEntry): boolean {
  if (!object(value) || value.id !== entry.id || !text(value.hash))
    return false;
  if (entry.kind === 'collection')
    return (
      text(value.label) &&
      nullableText(value.parentId) &&
      typeof value.position === 'number' &&
      Number.isSafeInteger(value.position) &&
      value.hash ===
        hashJson({
          id: value.id,
          label: value.label,
          parentId: value.parentId,
          position: value.position,
        })
    );
  if (entry.kind === 'upload')
    return (
      digest(value.md5, 32) &&
      count(value.size) &&
      text(value.url) &&
      text(value.filename) &&
      nullableText(value.collectionId) &&
      object(value.attributes) &&
      value.hash ===
        hashJson({
          id: value.id,
          md5: value.md5,
          size: value.size,
          filename: value.filename,
          collectionId: value.collectionId,
          attributes: value.attributes,
        })
    );
  return (
    value.modelId === entry.modelId &&
    object(value.current) &&
    (value.published === null || object(value.published)) &&
    nullableText(value.currentVersion) &&
    nullableTimestamp(value.publishedUpdatedAt) &&
    timestamp(value.createdAt) &&
    nullableTimestamp(value.firstPublishedAt) &&
    nullableText(value.parentId) &&
    (value.position === null || count(value.position)) &&
    nullableText(value.stage) &&
    validateSchedules(value.schedules) &&
    object(value.validity) &&
    typeof value.validity.current === 'boolean' &&
    (value.published === null
      ? value.validity.published === null
      : typeof value.validity.published === 'boolean') &&
    value.hash === recordHash(value as unknown as RecordState)
  );
}

export function requiresBinary(entry: UploadPlan): boolean {
  return (
    (entry.action === 'create' || entry.action === 'update') &&
    Boolean(entry.desired) &&
    (!entry.baseline ||
      entry.baseline.md5 !== entry.desired!.md5 ||
      entry.baseline.size !== entry.desired!.size)
  );
}

function validateEntry(
  value: unknown,
  withBinary: boolean,
): asserts value is PlanEntry {
  if (
    !object(value) ||
    !KINDS.includes(value.kind as Kind) ||
    !text(value.id) ||
    !ACTIONS.includes(value.action as (typeof ACTIONS)[number]) ||
    !Array.isArray(value.diagnostics)
  )
    invalid('Invalid plan entry.');
  const entry = value as unknown as PlanEntry;
  if (
    entry.diagnostics.some(
      (item) =>
        !object(item) ||
        !text(item.code) ||
        !text(item.message) ||
        (item.dependencyId !== undefined && !text(item.dependencyId)),
    )
  )
    invalid(`Invalid diagnostics for ${entry.id}.`);
  if (
    entry.guard !== null &&
    (!object(entry.guard) || !digest(entry.guard.hash, 64))
  )
    invalid(`Invalid guard for ${entry.id}.`);
  if (entry.kind === 'record') {
    const safety = entry.safety;
    if (
      !text(entry.modelId) ||
      !object(safety) ||
      !texts(safety.currentReferences) ||
      !texts(safety.publishedReferences) ||
      !texts(safety.uploadReferences) ||
      !texts(safety.blockIds) ||
      !nullableText(safety.desiredParentId) ||
      !(safety.desiredPosition === null || count(safety.desiredPosition))
    )
      invalid(`Invalid record preservation metadata for ${entry.id}.`);
    if (
      entry.guard &&
      (entry.guard.modelId !== entry.modelId ||
        !nullableText(entry.guard.currentVersion) ||
        !nullableTimestamp(entry.guard.publishedUpdatedAt) ||
        !nullableText(entry.guard.parentId) ||
        !(entry.guard.position === null || count(entry.guard.position)) ||
        !validateSchedules(entry.guard.schedules) ||
        !object(entry.guard.validity) ||
        typeof entry.guard.validity.current !== 'boolean' ||
        (entry.guard.validity.published !== null &&
          typeof entry.guard.validity.published !== 'boolean'))
    )
      invalid(`Invalid record guard for ${entry.id}.`);
  }
  if (entry.action === 'noop') {
    if (
      !entry.guard ||
      entry.baseline !== undefined ||
      entry.desired !== undefined
    )
      invalid(
        `Unchanged entry must contain only its guard and preservation metadata: ${entry.id}.`,
      );
  } else if (entry.action !== 'skip') {
    if (
      entry.action === 'create'
        ? entry.baseline !== null || entry.guard !== null
        : !validateState(entry.baseline, entry) || !entry.guard
    )
      invalid(`Invalid baseline for ${entry.id}.`);
    if (
      entry.action === 'delete'
        ? entry.desired !== null
        : !validateState(entry.desired, entry)
    )
      invalid(`Invalid desired state for ${entry.id}.`);
    if (entry.baseline && entry.guard?.hash !== entry.baseline.hash)
      invalid(`Baseline guard differs from the baseline for ${entry.id}.`);
  }
  if (entry.action === 'skip') {
    for (const state of [entry.baseline, entry.desired])
      if (state !== null && state !== undefined && !validateState(state, entry))
        invalid(`Invalid skipped state for ${entry.id}.`);
  }
  if (
    entry.kind === 'record' &&
    entry.baseline &&
    hashJson(recordGuard(entry.baseline)) !== hashJson(entry.guard)
  )
    invalid(
      `Record baseline guard differs from its complete baseline: ${entry.id}`,
    );
  if (entry.kind === 'upload') {
    const required = requiresBinary(entry);
    if (withBinary && required && !entry.binary)
      invalid(`Missing required binary for ${entry.id}.`);
    if (entry.binary) {
      const binary = entry.binary;
      safeRelative(binary.file);
      if (
        !required ||
        !/^binaries\/[a-f0-9]{64}\.bin$/.test(binary.file) ||
        !digest(binary.sha256, 64) ||
        binary.file !== `binaries/${binary.sha256}.bin` ||
        !digest(binary.md5, 32) ||
        !count(binary.bytes) ||
        binary.md5 !== entry.desired?.md5 ||
        binary.bytes !== entry.desired?.size
      )
        invalid(`Invalid binary descriptor for ${entry.id}.`);
    }
  }
}

function compactEntry(entry: PlanEntry): PlanEntry {
  const result = { ...entry };
  if (result.action === 'noop') {
    result.baseline = undefined;
    result.desired = undefined;
  }
  if (result.kind === 'upload') result.binary = undefined;
  return result;
}

async function writeBytes(
  handle: FileHandle,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    assertNotAborted(signal);
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (bytesWritten === 0)
      throw new ContentError(
        'BUNDLE_WRITE_FAILED',
        'The bundle output could not be written.',
      );
    offset += bytesWritten;
  }
  assertNotAborted(signal);
}

type RetryWait = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<unknown>;

/** A network or server failure that a fresh request may not repeat. */
class TransientDownloadError extends Error {
  constructor(
    readonly failure: unknown,
    readonly retryAfter?: number,
  ) {
    super('Asset download failed transiently.');
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After holds either delay seconds or an HTTP date. */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay)
    ? Math.min(Math.max(delay, 0), MAX_DOWNLOAD_RETRY_MS)
    : undefined;
}

/** Body stream failures, such as a reset or terminated connection, are transient. */
async function* transferred(
  body: NonNullable<Response['body']>,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body) yield chunk;
  } catch (error) {
    throw new TransientDownloadError(error);
  }
}

export async function fetchBinary(
  entry: UploadPlan,
  staging: string,
  fetchFn: typeof fetch,
  retryWait: RetryWait,
  idleTimeout: number,
  signal?: AbortSignal,
): Promise<BinaryFile> {
  assertNotAborted(signal);
  const desired = entry.desired!;
  const url = new URL(desired.url);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ContentError(
      'INVALID_ASSET_URL',
      `Upload ${entry.id} has an unsupported asset URL.`,
    );
  // The ordinary CMA URL can serve optimized images or a sanitized SVG whose
  // bytes differ from the stored upload. Match the dashboard's original-file
  // download controls on this request only; retain the captured URL and other
  // query values, and still require the exact captured byte count and MD5.
  url.searchParams.set('dl', desired.filename);
  url.searchParams.set('skip-default-optimizations', 'true');
  url.searchParams.set('svg-sanitize', 'false');
  // Downloads run concurrently, so each writes its own temporary file.
  const temporary = join(staging, 'binaries', `.download-${randomUUID()}`);
  let download: Omit<BinaryFile, 'file'> | undefined;
  // Asset GETs bypass the CMA client's retries. Integrity failures and other
  // client errors are final; a retry restarts with an empty file and hashes.
  for (let attempt = 1; !download; attempt++) {
    try {
      download = await transferBinary(
        entry,
        url,
        temporary,
        fetchFn,
        idleTimeout,
        signal,
      );
    } catch (error) {
      if (!(error instanceof TransientDownloadError)) throw error;
      await rm(temporary, { force: true });
      if (attempt === DOWNLOAD_ATTEMPTS) throw error.failure;
      try {
        await retryWait(
          error.retryAfter ?? DOWNLOAD_RETRY_MS * 2 ** (attempt - 1),
          signal,
        );
      } finally {
        assertNotAborted(signal);
      }
    }
  }
  const { bytes, md5: actualMd5, sha256: actualSha256 } = download;
  if (bytes !== desired.size || actualMd5 !== desired.md5)
    throw new ContentError(
      'ASSET_INTEGRITY_FAILED',
      `Upload ${entry.id} differs from the captured binary.`,
    );
  const file = `binaries/${actualSha256}.bin`;
  assertNotAborted(signal);
  const destination = join(staging, file);
  try {
    await lstat(destination);
    await rm(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await rename(temporary, destination);
  }
  return { file, sha256: actualSha256, md5: actualMd5, bytes };
}

/** Stream one request into the temporary file, hashing what was written. */
async function transferBinary(
  entry: UploadPlan,
  url: URL,
  temporary: string,
  fetchFn: typeof fetch,
  idleTimeout: number,
  signal?: AbortSignal,
): Promise<Omit<BinaryFile, 'file'>> {
  assertNotAborted(signal);
  const desired = entry.desired!;
  // A stalled connection is abandoned after idleTimeout without any bytes and
  // retried like a dropped one; the caller's own signal still cancels.
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = globalThis.setTimeout(() => idle.abort(), idleTimeout);
  };
  const requestSignal = signal
    ? AbortSignal.any([signal, idle.signal])
    : idle.signal;
  touch();
  let response: Response;
  try {
    response = await fetchFn(url, { signal: requestSignal });
  } catch (error) {
    clearTimeout(timer);
    assertNotAborted(signal);
    throw new TransientDownloadError(error);
  }
  let handle: FileHandle | undefined;
  const md5 = createHash('md5');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    assertNotAborted(signal);
    if (!response.ok || !response.body) {
      const failure = new ContentError(
        'ASSET_DOWNLOAD_FAILED',
        `Upload ${entry.id} could not be downloaded (${response.status}).`,
      );
      throw transientStatus(response.status)
        ? new TransientDownloadError(failure, retryAfter(response))
        : failure;
    }
    handle = await open(temporary, 'wx', 0o600);
    for await (const chunk of transferred(response.body)) {
      touch();
      assertNotAborted(signal);
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > desired.size)
        throw new ContentError(
          'ASSET_INTEGRITY_FAILED',
          `Upload ${entry.id} exceeds its captured size.`,
        );
      md5.update(buffer);
      hash.update(buffer);
      await writeBytes(handle, buffer, signal);
    }
    assertNotAborted(signal);
  } catch (error) {
    // Release unread error responses and interrupted downloads alike. Native
    // fetch receives the signal too, so an idle network stream can be aborted.
    await response.body?.cancel().catch(() => undefined);
    assertNotAborted(signal);
    throw error;
  } finally {
    clearTimeout(timer);
    await handle?.close();
  }
  return { sha256: hash.digest('hex'), md5: md5.digest('hex'), bytes };
}

export async function writeBundle({
  store,
  metadata,
  outputPath,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  fetchFn = fetch,
  retryWait = (milliseconds, signal) =>
    setTimeout(milliseconds, undefined, { signal }),
  concurrency = 4,
  idleTimeout = DOWNLOAD_IDLE_MS,
  signal,
}: {
  store: SnapshotStore;
  metadata: PlanMetadata;
  outputPath: string;
  chunkBytes?: number;
  fetchFn?: typeof fetch;
  retryWait?: RetryWait;
  concurrency?: number;
  idleTimeout?: number;
  signal?: AbortSignal;
}): Promise<string> {
  assertNotAborted(signal);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1)
    throw new ContentError(
      'INVALID_CHUNK_SIZE',
      'Chunk size must be a positive safe integer.',
    );
  const output = resolve(outputPath);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const ensureAbsent = async () => {
    try {
      await lstat(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new ContentError(
      'BUNDLE_EXISTS',
      `Bundle output already exists: ${output}`,
    );
  };
  await ensureAbsent();
  assertNotAborted(signal);
  const staging = await mkdtemp(join(parent, '.content-bundle-'));
  let current:
    | {
        handle: FileHandle;
        descriptor: BundleChunk;
        hash: ReturnType<typeof createHash>;
      }
    | undefined;
  let indexHandle: FileHandle | undefined;
  try {
    assertNotAborted(signal);
    await mkdir(join(staging, 'plan'));
    await mkdir(join(staging, 'binaries'));
    const chunks: BundleChunkIndex = {
      file: CHUNK_INDEX_FILE,
      sha256: '',
      bytes: 0,
      count: 0,
    };
    const indexHash = createHash('sha256');
    indexHandle = await open(join(staging, chunks.file), 'wx', 0o600);
    const actualCounts = counts();
    const finishChunk = async () => {
      assertNotAborted(signal);
      if (!current) return;
      await current.handle.close();
      current.descriptor.sha256 = current.hash.digest('hex');
      const descriptor = Buffer.from(`${stableJson(current.descriptor)}\n`);
      if (descriptor.length > MAX_INDEX_LINE_BYTES)
        throw new ContentError(
          'INVALID_CHUNK_INDEX',
          'Chunk descriptor exceeds the supported metadata line size.',
        );
      await writeBytes(indexHandle!, descriptor, signal);
      indexHash.update(descriptor);
      chunks.bytes += descriptor.length;
      chunks.count++;
      current = undefined;
    };
    // Asset files are independent downloads. Fetch them concurrently first;
    // the plan is then written in its deterministic order.
    const pending: UploadPlan[] = [];
    for (const original of store.planEntries('upload')) {
      const entry = compactEntry(original);
      if (entry.kind === 'upload' && requiresBinary(entry)) pending.push(entry);
    }
    const binaries = new Map<string, BinaryFile>();
    await boundedWork(
      pending,
      concurrency,
      async (entry) => {
        validateEntry(entry, false);
        binaries.set(
          entry.id,
          await fetchBinary(
            entry,
            staging,
            fetchFn,
            retryWait,
            idleTimeout,
            signal,
          ),
        );
      },
      undefined,
      signal,
    );
    for (const original of store.planEntries()) {
      assertNotAborted(signal);
      const entry = compactEntry(original);
      validateEntry(entry, false);
      if (entry.kind === 'upload' && requiresBinary(entry))
        entry.binary = binaries.get(entry.id);
      validateEntry(entry, true);
      const line = Buffer.from(`${stableJson(entry)}\n`);
      if (current && current.descriptor.bytes + line.length > chunkBytes)
        await finishChunk();
      if (!current) {
        const file = chunkPath(chunks.count + 1);
        current = {
          handle: await open(join(staging, file), 'wx', 0o600),
          descriptor: { file, sha256: '', bytes: 0, entries: 0 },
          hash: createHash('sha256'),
        };
      }
      // An oversized entry occupies its own chunk; an entry is never split.
      await writeBytes(current.handle, line, signal);
      current.hash.update(line);
      current.descriptor.bytes += line.length;
      current.descriptor.entries++;
      actualCounts[entry.kind][entry.action]++;
    }
    await finishChunk();
    await indexHandle.close();
    indexHandle = undefined;
    chunks.sha256 = indexHash.digest('hex');
    if (stableJson(actualCounts) !== stableJson(metadata.counts))
      throw new ContentError(
        'PLAN_COUNTS_MISMATCH',
        'Plan metadata counts differ from its stored entries.',
      );
    const manifest: BundleManifest = {
      source: metadata.source,
      destination: metadata.destination,
      schema: metadata.schema,
      options: metadata.options,
      counts: metadata.counts,
      temporarySchemaChanges: metadata.temporarySchemaChanges,
      format: FORMAT,
      createdAt: new Date().toISOString(),
      chunks,
    };
    validateManifest(manifest);
    const bytes = Buffer.from(`${stableJson(manifest)}\n`);
    if (bytes.length > MAX_MANIFEST_BYTES)
      throw new ContentError(
        'MANIFEST_TOO_LARGE',
        'Bundle metadata exceeds the supported manifest size.',
      );
    await writeFile(join(staging, 'manifest.json'), bytes, {
      flag: 'wx',
      mode: 0o600,
      signal,
    });
    await writeFile(join(staging, 'manifest.sha256'), `${sha256(bytes)}\n`, {
      flag: 'wx',
      mode: 0o600,
      signal,
    });
    await ensureAbsent();
    assertNotAborted(signal);
    await rename(staging, output);
    return output;
  } catch (error) {
    await current?.handle.close().catch(() => undefined);
    await indexHandle?.close().catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    assertNotAborted(signal);
    throw error;
  }
}

export async function verifyBinary(
  directory: string,
  binary: BinaryFile,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  const handle = await safeFile(directory, binary.file);
  try {
    if ((await handle.stat()).size !== binary.bytes)
      invalid(`Binary size differs: ${binary.file}`);
    const hash = createHash('sha256');
    const md5 = createHash('md5');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      assertNotAborted(signal);
      bytes += chunk.length;
      hash.update(chunk);
      md5.update(chunk);
    }
    assertNotAborted(signal);
    if (
      bytes !== binary.bytes ||
      hash.digest('hex') !== binary.sha256 ||
      md5.digest('hex') !== binary.md5
    )
      invalid(`Binary checksum differs: ${binary.file}`);
  } finally {
    await handle.close();
  }
}

/** Read one JSON value at a time, with backpressure and a rolling checksum. */
export async function* jsonlValues(
  directory: string,
  descriptor: Pick<BundleChunk, 'file' | 'bytes' | 'sha256'>,
  expectedRows: number,
  label: string,
  maximumLineBytes?: number,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  assertNotAborted(signal);
  const handle = await safeFile(directory, descriptor.file);
  try {
    if ((await handle.stat()).size !== descriptor.bytes)
      invalid(`${label} size differs: ${descriptor.file}`);
    const hash = createHash('sha256');
    let bytes = 0;
    let rows = 0;
    const stream = handle.createReadStream({ autoClose: false });
    let partial: Buffer[] = [];
    let partialBytes = 0;
    const parseLine = (line: Buffer): unknown => {
      if (!line.length)
        invalid(`Empty ${label.toLowerCase()} entry: ${descriptor.file}`);
      if (maximumLineBytes !== undefined && line.length > maximumLineBytes)
        invalid(`${label} entry exceeds the metadata line limit.`);
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(line),
        );
      } catch {
        invalid(
          `Invalid JSON ${label.toLowerCase()} entry: ${descriptor.file}`,
        );
      }
      rows++;
      if (rows > expectedRows)
        invalid(`${label} entry count differs: ${descriptor.file}`);
      return value;
    };
    try {
      // Raw async iteration bounds buffering while a consumer awaits a binary
      // checksum. Even a large chunk index never becomes an in-memory array.
      for await (const raw of stream) {
        assertNotAborted(signal);
        const buffer = raw as Buffer;
        hash.update(buffer);
        bytes += buffer.length;
        if (bytes > descriptor.bytes)
          invalid(`${label} size differs: ${descriptor.file}`);
        let offset = 0;
        let newline = buffer.indexOf(10, offset);
        while (newline !== -1) {
          // Buffered lines can otherwise keep resolving in the microtask
          // queue without giving process signal handlers a chance to run.
          if (rows % 30 === 0) await setImmediate();
          assertNotAborted(signal);
          const tail = buffer.subarray(offset, newline);
          if (
            maximumLineBytes !== undefined &&
            partialBytes + tail.length > maximumLineBytes
          )
            invalid(`${label} entry exceeds the metadata line limit.`);
          const line = partialBytes
            ? Buffer.concat([...partial, tail], partialBytes + tail.length)
            : tail;
          partial = [];
          partialBytes = 0;
          yield parseLine(line);
          offset = newline + 1;
          newline = buffer.indexOf(10, offset);
        }
        if (offset < buffer.length) {
          const tail = buffer.subarray(offset);
          partialBytes += tail.length;
          if (maximumLineBytes !== undefined && partialBytes > maximumLineBytes)
            invalid(`${label} entry exceeds the metadata line limit.`);
          partial.push(tail);
        }
      }
      assertNotAborted(signal);
      if (partialBytes) yield parseLine(Buffer.concat(partial, partialBytes));
      assertNotAborted(signal);
      if (
        bytes !== descriptor.bytes ||
        rows !== expectedRows ||
        hash.digest('hex') !== descriptor.sha256
      )
        invalid(`${label} checksum or entry count differs: ${descriptor.file}`);
    } finally {
      stream.destroy();
    }
  } finally {
    await handle.close();
  }
}

async function* chunkIndex(
  directory: string,
  descriptor: BundleChunkIndex,
  signal?: AbortSignal,
): AsyncGenerator<BundleChunk> {
  let position = 0;
  for await (const value of jsonlValues(
    directory,
    descriptor,
    descriptor.count,
    'Chunk index',
    MAX_INDEX_LINE_BYTES,
    signal,
  )) {
    // Canonical sequence paths prove uniqueness/order without a chunk-sized Set.
    validateChunk(value, ++position);
    yield value;
  }
}

async function* chunkEntries(
  directory: string,
  descriptor: BundleChunk,
  signal?: AbortSignal,
): AsyncGenerator<PlanEntry> {
  for await (const value of jsonlValues(
    directory,
    descriptor,
    descriptor.entries,
    'Chunk',
    undefined,
    signal,
  )) {
    validateEntry(value, true);
    yield value;
  }
}

function compareEntries(left: PlanEntry, right: PlanEntry): number {
  const leftParts = [
    left.kind,
    left.kind === 'record' ? left.modelId : '',
    left.id,
  ];
  const rightParts = [
    right.kind,
    right.kind === 'record' ? right.modelId : '',
    right.id,
  ];
  for (let index = 0; index < leftParts.length; index++) {
    const order = Buffer.compare(
      Buffer.from(leftParts[index]),
      Buffer.from(rightParts[index]),
    );
    if (order) return order;
  }
  return 0;
}

export async function readBundle({
  directory,
  store,
  signal,
}: {
  directory: string;
  store: SnapshotStore;
  signal?: AbortSignal;
}): Promise<BundleManifest> {
  assertNotAborted(signal);
  const root = resolve(directory);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      invalid('Bundle directory must be a real directory.');
    const manifestBytes = await readSmallFile(
      root,
      'manifest.json',
      MAX_MANIFEST_BYTES,
      signal,
    );
    const checksum = (
      await readSmallFile(root, 'manifest.sha256', 65, signal)
    ).toString('utf8');
    if (checksum !== `${sha256(manifestBytes)}\n`)
      invalid('Manifest checksum differs.');
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      invalid('Invalid manifest JSON.');
    }
    validateManifest(manifest);
    if (
      (store.database.prepare('SELECT COUNT(*) AS total FROM plan').get()
        ?.total as number) !== 0
    )
      invalid('Bundle input requires an empty temporary plan store.');
    const actualCounts = counts();
    let previous: PlanEntry | undefined;
    // This index spills on disk and avoids retaining every identity in memory.
    store.database.exec(
      'CREATE TEMP TABLE bundle_keys(kind TEXT, id TEXT, PRIMARY KEY(kind,id)) WITHOUT ROWID',
    );
    const insertKey = store.database.prepare(
      'INSERT OR IGNORE INTO bundle_keys VALUES (?, ?)',
    );
    try {
      // Validate all chunks and binaries before any plan becomes executable.
      for await (const chunk of chunkIndex(root, manifest.chunks, signal)) {
        for await (const entry of chunkEntries(root, chunk, signal)) {
          assertNotAborted(signal);
          if (previous && compareEntries(previous, entry) >= 0)
            invalid('Bundle plan entries are not deterministically ordered.');
          // Only an ignored row is a duplicate; storage errors keep their cause.
          if (insertKey.run(entry.kind, entry.id).changes === 0)
            invalid(`Duplicate plan identity: ${entry.kind}/${entry.id}`);
          previous = entry;
          actualCounts[entry.kind][entry.action]++;
          if (entry.kind === 'upload' && entry.binary)
            await verifyBinary(root, entry.binary, signal);
        }
      }
      if (stableJson(actualCounts) !== stableJson(manifest.counts))
        invalid('Bundle entry counts differ from the manifest.');
    } finally {
      store.database.exec('DROP TABLE bundle_keys');
    }
    // A second streamed pass makes import all-or-nothing without keeping the plan
    // in memory. Rechecking the chunks also detects changes between passes.
    assertNotAborted(signal);
    store.database.exec('BEGIN');
    try {
      for await (const chunk of chunkIndex(root, manifest.chunks, signal)) {
        for await (const entry of chunkEntries(root, chunk, signal)) {
          assertNotAborted(signal);
          if (entry.kind === 'upload' && entry.binary)
            await verifyBinary(root, entry.binary, signal);
          store.putPlan(entry);
        }
      }
      assertNotAborted(signal);
      store.database.exec('COMMIT');
    } catch (error) {
      try {
        store.database.exec('ROLLBACK');
      } catch {
        /* SQLite may already have rolled back, e.g. after SQLITE_FULL. */
      }
      throw error;
    }
    return manifest;
  } catch (error) {
    assertNotAborted(signal);
    if (error instanceof ContentError) throw error;
    throw new ContentError(
      'INVALID_BUNDLE',
      `Bundle could not be read: ${(error as Error).message}`,
    );
  }
}
