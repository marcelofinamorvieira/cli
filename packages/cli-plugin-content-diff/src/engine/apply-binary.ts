import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ContentError } from './errors';
import type { BinaryFile } from './types';

/** Upload an owned verified copy, rather than trusting a mutable export path. */
export async function stageBinary(
  bundlePath: string,
  stagingDirectory: string,
  binary: BinaryFile,
): Promise<string> {
  const parts = binary.file.split('/');
  if (
    isAbsolute(binary.file) ||
    binary.file.includes('\\') ||
    parts.some((p) => !p || p === '.' || p === '..')
  ) {
    throw new ContentError(
      'INVALID_BINARY',
      'Binary path must remain inside the bundle.',
    );
  }
  let source = bundlePath;
  for (let index = 0; index < parts.length; index++) {
    source = join(source, parts[index]);
    const state = await lstat(source);
    if (
      state.isSymbolicLink() ||
      (index === parts.length - 1 ? !state.isFile() : !state.isDirectory())
    ) {
      throw new ContentError(
        'INVALID_BINARY',
        'Binary path contains a symlink or special file.',
      );
    }
  }
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const destination = join(stagingDirectory, `binary-${randomUUID()}`);
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  try {
    await pipeline(
      input.createReadStream({ autoClose: false }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          sha.update(chunk);
          md5.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
    if (
      bytes !== binary.bytes ||
      sha.digest('hex') !== binary.sha256 ||
      md5.digest('hex') !== binary.md5
    ) {
      throw new ContentError(
        'BINARY_CHECKSUM_MISMATCH',
        'Bundled binary changed before staging.',
      );
    }
    return destination;
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    await input.close();
  }
}
