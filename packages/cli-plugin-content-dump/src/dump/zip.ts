import { once } from 'node:events';
import { createWriteStream, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { userError } from '../utils/errors';

/** JSON Lines entries are split at this size, so any one opens in an editor. */
const ENTRY_BYTES = 64 * 1024 * 1024;

/** Where a zip is written until it is complete. */
export function partialPath(path: string): string {
  return `${path}.partial`;
}

/**
 * A zip written as a stream (ZIP64 where needed) to `<path>.partial`, and
 * renamed to `path` once complete. Entries are added one after another.
 */
export class ZipWriter {
  private readonly zip = new yazl.ZipFile();
  private readonly written: Promise<void>;
  /** Rejects with the first error of the output; never resolves. */
  private readonly failed: Promise<never>;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const output = this.zip.outputStream as Readable;
    this.zip.on('error', (error: Error) => output.destroy(error));
    this.written = pipeline(output, createWriteStream(partialPath(path)));
    this.failed = new Promise<never>((_, reject) => {
      this.written.catch(reject);
    });
    this.failed.catch(() => {});
  }

  addJson(name: string, value: unknown, options: { pretty?: boolean } = {}) {
    const json = options.pretty
      ? `${JSON.stringify(value, null, 2)}\n`
      : JSON.stringify(value);
    this.zip.addBuffer(Buffer.from(json), name);
  }

  /**
   * Writes `values` as JSON Lines under `prefix/000001.jsonl`, … and returns
   * how many lines it wrote.
   */
  async addLines(
    prefix: string,
    values: AsyncIterable<unknown> | Iterable<unknown>,
  ): Promise<number> {
    let entry: PassThrough | undefined;
    let entries = 0;
    let bytes = 0;
    let count = 0;
    try {
      for await (const value of values) {
        const line = `${JSON.stringify(value)}\n`;
        const size = Buffer.byteLength(line);
        if (!entry || bytes + size > ENTRY_BYTES) {
          entry?.end();
          entry = new PassThrough();
          this.zip.addReadStream(
            entry,
            `${prefix}/${String(++entries).padStart(6, '0')}.jsonl`,
          );
          bytes = 0;
        }
        bytes += size;
        count++;
        if (!entry.write(line))
          await Promise.race([once(entry, 'drain'), this.failed]);
      }
    } finally {
      entry?.end();
    }
    return count;
  }

  /** Stores `contents` uncompressed, and resolves once it is read. */
  async addFile(name: string, contents: Readable): Promise<void> {
    this.zip.addReadStream(contents, name, { compress: false });
    await Promise.race([finished(contents), this.failed]);
  }

  /** Finishes the zip and moves it to its final path. */
  async close(): Promise<void> {
    this.zip.end();
    await this.written;
    await rename(partialPath(this.path), this.path);
  }

  /** Abandons the zip and removes the partial file. */
  async discard(): Promise<void> {
    (this.zip.outputStream as Readable).destroy();
    await this.written.catch(() => {});
    await rm(partialPath(this.path), { force: true });
  }
}

/** A zip read through its central directory. */
export class ZipReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly entries: Map<string, yauzl.Entry>,
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const zip = await yauzl.openPromise(path, {
      lazyEntries: true,
      autoClose: false,
    });
    const entries = new Map<string, yauzl.Entry>();
    try {
      for await (const entry of zip.eachEntry())
        entries.set(entry.fileName, entry);
    } catch (error) {
      zip.close();
      throw error;
    }
    return new ZipReader(zip, entries);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  stream(name: string): Promise<Readable> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`The zip has no entry ${name}.`);
    return this.zip.openReadStreamPromise(entry);
  }

  async json(name: string): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.stream(name))
      chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  /** Every line of the JSON Lines entries under `prefix`, in order. */
  async *lines(
    prefix: string,
  ): AsyncGenerator<{ text: string; value: unknown }> {
    const names = [...this.entries.keys()]
      .filter((name) => name.startsWith(`${prefix}/`))
      .sort();
    for (const name of names) {
      let line = 0;
      for await (const text of textLines(await this.stream(name))) {
        line++;
        if (!text) continue;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw userError(
            'INVALID_DUMP',
            `Line ${line} of ${name} is not valid JSON: the dump is damaged.`,
          );
        }
        yield { text, value };
      }
    }
  }

  close(): void {
    this.zip.close();
  }
}

/**
 * The lines of a UTF-8 stream, split at line feeds only: JSON strings may
 * hold U+2028 and U+2029, which node:readline also treats as line ends.
 */
async function* textLines(
  stream: AsyncIterable<Buffer>,
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of stream) {
    const lines = (rest + decoder.write(chunk)).split('\n');
    rest = lines.pop()!;
    yield* lines;
  }
  rest += decoder.end();
  if (rest) yield rest;
}
