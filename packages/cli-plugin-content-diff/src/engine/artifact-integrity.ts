import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { assertNotAborted } from './cancellation';
import { hashJson, recordHash } from './codec';
import { ContentError } from './errors';
import type {
  ArtifactChunk,
  BinaryFile,
  PlanEntry,
  RecordState,
} from './types';
function invalid(message: string): never {
  throw new ContentError('INVALID_MIGRATION_BASELINE', message);
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
function safeRelative(file: unknown): asserts file is string {
  if (
    !text(file) ||
    isAbsolute(file) ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    invalid('Artifact file paths must be safe relative paths.');
  }
}

/** Reject every traversed symlink, including parent directories inside an artifact. */
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
  descriptor: Pick<ArtifactChunk, 'file' | 'bytes' | 'sha256'>,
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
