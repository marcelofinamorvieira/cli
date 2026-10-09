import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, gzipSync } from 'node:zlib';

const FLUSH_CHARACTERS = 8 * 1024 * 1024;

/**
 * JSON lines spread over numbered gzip files in a temporary directory, so a
 * pass can hold the lines of one file at a time. Lines are buffered and
 * appended as gzip members, which gunzip reads back as one stream.
 */
export class SpillFiles {
  private readonly buffers = new Map<number, string[]>();
  private buffered = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  private path(file: number): string {
    return join(this.directory, `${file}.jsonl.gz`);
  }

  /** Buffers a line; resolves once any flush it causes is on disk. */
  async append(file: number, line: string): Promise<void> {
    let lines = this.buffers.get(file);
    if (!lines) {
      lines = [];
      this.buffers.set(file, lines);
    }
    lines.push(line);
    this.buffered += line.length;
    if (this.buffered >= FLUSH_CHARACTERS) await this.flush();
  }

  /** Writes every buffered line; flushes run one after another. */
  flush(): Promise<void> {
    const buffers = [...this.buffers];
    this.buffers.clear();
    this.buffered = 0;
    this.writing = this.writing.then(async () => {
      for (const [file, lines] of buffers)
        await appendFile(this.path(file), gzipSync(`${lines.join('\n')}\n`));
    });
    return this.writing;
  }

  /** The lines of one file; call `flush` first. */
  async *lines(file: number): AsyncGenerator<string> {
    if (!existsSync(this.path(file))) return;
    const input = createReadStream(this.path(file));
    const gunzip = createGunzip();
    input.on('error', (error) => gunzip.destroy(error));
    for await (const line of textLines(input.pipe(gunzip)))
      if (line) yield line;
  }
}

/** A stable bucket for an ID (32-bit FNV-1a). */
export function bucketOf(id: string, buckets: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % buckets;
}

/**
 * The lines of a UTF-8 stream, split at line feeds only: JSON strings may
 * hold U+2028 and U+2029, which node:readline also treats as line ends.
 */
export async function* textLines(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of stream) {
    const lines = (rest + decoder.write(chunk as Buffer)).split('\n');
    rest = lines.pop()!;
    yield* lines;
  }
  rest += decoder.end();
  if (rest) yield rest;
}

/** IDs grouped by the bucket that holds them. */
export function byBucket(
  ids: Iterable<string>,
  buckets: number,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  for (const id of ids) {
    const bucket = bucketOf(id, buckets);
    const wanted = result.get(bucket);
    if (wanted) wanted.add(id);
    else result.set(bucket, new Set([id]));
  }
  return result;
}
