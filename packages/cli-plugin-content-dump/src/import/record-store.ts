import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { RecordLine } from '../dump/format';

/** Where a record's line sits in the store. */
export interface StoredLine {
  offset: number;
  length: number;
}

/**
 * The dump's record lines in one compressed temporary file, so the import
 * can read any record back in whatever order it writes them, while memory
 * holds only where each one is.
 */
export class RecordStore {
  private size = 0;

  private constructor(private readonly descriptor: number) {}

  static create(directory: string): RecordStore {
    return new RecordStore(openSync(join(directory, 'records'), 'w+'));
  }

  append(text: string): StoredLine {
    const compressed = deflateRawSync(text);
    writeSync(this.descriptor, compressed, 0, compressed.length, this.size);
    const stored = { offset: this.size, length: compressed.length };
    this.size += compressed.length;
    return stored;
  }

  read({ offset, length }: StoredLine): RecordLine {
    const compressed = Buffer.alloc(length);
    readSync(this.descriptor, compressed, 0, length, offset);
    return JSON.parse(inflateRawSync(compressed).toString('utf8'));
  }

  close(): void {
    closeSync(this.descriptor);
  }
}
