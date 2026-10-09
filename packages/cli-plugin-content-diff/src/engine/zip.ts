import { once } from 'node:events';
import { createWriteStream, mkdirSync } from 'node:fs';
import { link, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { object } from './codec';
import { ContentError } from './errors';
import { textLines } from './spill';

/** Entries of JSON lines are split at this size, so any one opens in an editor. */
export const ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * A zip written as a stream (ZIP64 where needed) to a temporary file that is
 * moved to its final name only once complete, never over an existing file.
 */
export class ZipWriter {
  private readonly zip = new yazl.ZipFile();
  private readonly temporary: string;
  private readonly written: Promise<void>;
  private readonly open = new Set<Readable>();
  private failure: unknown;

  constructor(readonly path: string) {
    this.temporary = `${path}.partial-${process.pid}-${Date.now()}`;
    mkdirSync(dirname(path), { recursive: true });
    const output = createWriteStream(this.temporary, { flags: 'wx' });
    this.written = pipeline(this.zip.outputStream, output);
    this.written.catch((error: unknown) => this.fail(error));
    this.zip.on('error', (error: unknown) => this.fail(error));
  }

  /**
   * Fails the whole zip on the first error of any entry or of yazl: the
   * entries being written and the output stop, so `close` rejects.
   */
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    for (const stream of this.open) stream.destroy(error as Error);
    (this.zip.outputStream as Readable).destroy(error as Error);
  }

  assertOpen(): void {
    if (this.failure) throw this.failure;
  }

  addBuffer(name: string, contents: Buffer | string): void {
    this.assertOpen();
    this.zip.addBuffer(Buffer.from(contents), name);
  }

  /** Adds an entry read from `stream` once the zip reaches it. */
  addStream(name: string, stream: () => Promise<Readable>): void {
    this.assertOpen();
    this.zip.addReadStreamLazy(name, (callback) => {
      Promise.resolve()
        .then(stream)
        .then(
          (readable) => callback(null, this.watch(readable)),
          (error: unknown) => this.fail(error),
        );
    });
  }

  /** yazl does not listen for the errors of the streams it reads. */
  private watch<T extends Readable>(stream: T): T {
    this.open.add(stream);
    stream.on('error', (error) => this.fail(error));
    stream.on('close', () => this.open.delete(stream));
    return stream;
  }

  /**
   * JSON lines under `prefix`, split into `prefix/000001.jsonl`, … entries.
   * Call `end` before adding anything else.
   */
  jsonLines(prefix: string, limit = ENTRY_BYTES): JsonLinesWriter {
    return new JsonLinesWriter(this, prefix, limit);
  }

  /** @internal An entry fed while it is written, with backpressure. */
  openEntry(name: string): PassThrough {
    this.assertOpen();
    const entry = this.watch(new PassThrough());
    this.zip.addReadStreamLazy(name, (callback) => callback(null, entry));
    return entry;
  }

  /** Finishes the zip and publishes it under its final name. */
  async close(): Promise<void> {
    this.zip.end();
    try {
      await this.written;
      this.assertOpen();
      await link(this.temporary, this.path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ContentError(
            'OUTPUT_EXISTS',
            `${this.path} already exists. Choose another name.`,
          );
        // A file system without hard links: the name was checked free
        // before any work started.
        return rename(this.temporary, this.path);
      });
    } finally {
      await rm(this.temporary, { force: true });
    }
  }

  /** Abandons the zip and removes its temporary file. */
  async discard(): Promise<void> {
    this.fail(new Error('The zip was discarded.'));
    await this.written.catch(() => {});
    await rm(this.temporary, { force: true });
  }
}

export class JsonLinesWriter {
  private entry?: PassThrough;
  private bytes = 0;
  private entries = 0;
  private queue: Promise<void> = Promise.resolve();
  count = 0;

  constructor(
    private readonly zip: ZipWriter,
    private readonly prefix: string,
    private readonly limit: number,
  ) {}

  /**
   * Writes run one after another, so a new entry never ends one that another
   * write is still waiting to drain.
   */
  write(value: unknown): Promise<void> {
    const next = this.queue.then(() => this.writeLine(value));
    this.queue = next.catch(() => {});
    return next;
  }

  private async writeLine(value: unknown): Promise<void> {
    this.zip.assertOpen();
    const line = `${JSON.stringify(value)}\n`;
    const size = Buffer.byteLength(line);
    if (!this.entry || this.bytes + size > this.limit) {
      this.entry?.end();
      this.entries++;
      this.entry = this.zip.openEntry(
        `${this.prefix}/${String(this.entries).padStart(6, '0')}.jsonl`,
      );
      this.bytes = 0;
    }
    this.bytes += size;
    this.count++;
    if (!this.entry.write(line)) await once(this.entry, 'drain');
  }

  end(): void {
    this.entry?.end();
    this.entry = undefined;
  }
}

/** A zip read through its central directory. */
export class ZipReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    readonly entries: Map<string, yauzl.Entry>,
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

  /**
   * Opens a dump or diff and reads its manifest.json, which must have the
   * given format and version; refuses it with `code` otherwise.
   */
  static async openWithManifest(
    path: string,
    expected: { code: string; format: string; version: number; name: string },
  ): Promise<{ zip: ZipReader; manifest: Record<string, unknown> }> {
    const zip = await ZipReader.open(path).catch((error: unknown) => {
      throw new ContentError(
        expected.code,
        `${path} is not a readable zip: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    try {
      const manifest = zip.has('manifest.json')
        ? await zip.json('manifest.json')
        : undefined;
      if (
        !object(manifest) ||
        manifest.format !== expected.format ||
        manifest.version !== expected.version
      )
        throw new ContentError(
          expected.code,
          `${path} is not a version ${expected.version} ${expected.name}.`,
        );
      return { zip, manifest };
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The names under `prefix/`, in order. */
  names(prefix: string): string[] {
    return [...this.entries.keys()]
      .filter((name) => name.startsWith(`${prefix}/`))
      .sort();
  }

  stream(name: string): Promise<Readable> {
    const entry = this.entries.get(name);
    if (!entry)
      throw new ContentError('INVALID_ZIP', `The zip has no entry ${name}.`);
    return this.zip.openReadStreamPromise(entry);
  }

  async json(name: string): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.stream(name))
      chunks.push(chunk as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ContentError('INVALID_ZIP', `${name} is not valid JSON.`);
    }
  }

  /** Every line of the JSON lines entries under `prefix`, with its place. */
  async *lines(
    prefix: string,
  ): AsyncGenerator<{ entry: string; line: number; value: unknown }> {
    for (const entry of this.names(prefix)) {
      let line = 0;
      for await (const text of textLines(await this.stream(entry))) {
        line++;
        if (!text.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new ContentError(
            'INVALID_ZIP',
            `Line ${line} of ${entry} is not valid JSON.`,
          );
        }
        yield { entry, line, value };
      }
    }
  }

  close(): void {
    this.zip.close();
  }
}
