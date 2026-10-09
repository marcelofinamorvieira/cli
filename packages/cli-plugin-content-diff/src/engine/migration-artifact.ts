import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { format, resolveConfig } from 'prettier';
import { assertNotAborted } from './cancellation';
import { hashJson, object, recordGuard } from './codec';
import { ContentError, destinationChanged } from './errors';
import { emitMigrationCalls } from './migration-emit';
import type { MigrationTrackingBinding } from './migration-schema';
import type { SnapshotStore } from './store';
import type {
  ArtifactChunk,
  ArtifactChunkIndex,
  JsonObject,
  Kind,
  PlanMetadata,
  RecordGuard,
  RecordState,
  Side,
} from './types';

/** The size cap of every companion file read when applying. */
const MAX_MIGRATION_FILE_BYTES = 16 * 1024 * 1024;
/** The largest chunk target, so every baseline chunk stays within the cap. */
export const MAX_MIGRATION_CHUNK_BYTES = MAX_MIGRATION_FILE_BYTES - 1024;
export const DEFAULT_MIGRATION_CHUNK_BYTES = 1024 * 1024;

const FORMAT = 'datocms-content-migration-baseline/1';
const MAX_METADATA = MAX_MIGRATION_FILE_BYTES;
const kinds = ['record', 'upload', 'collection'] as const;
const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

export interface BaselineManifest extends PlanMetadata {
  format: typeof FORMAT;
  createdAt: string;
  sourceTracking: MigrationTrackingBinding;
  destinationTracking: MigrationTrackingBinding;
  chunks: ArtifactChunkIndex;
}

/** One destination record, upload or folder as generation observed it. */
interface BaselineRow {
  kind: Kind;
  id: string;
  guard: RecordGuard | { hash: string };
}

function invalid(message: string): never {
  throw new ContentError('INVALID_MIGRATION_BASELINE', message);
}
/** Generation cannot write a migration for this content. */
function unwritable(message: string): never {
  throw new ContentError('INVALID_MIGRATION_OUTPUT', message);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function digest(value: unknown, length = 64): value is string {
  return (
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  );
}

/**
 * Keys that lead an object when present, so a reader sees what a value is
 * before its contents: block IDs and types, Structured Text node types and
 * formats, and the upload a file value points to. Other keys keep their
 * stored order; key order has no meaning to the CMA.
 */
const LEADING_KEYS = ['id', 'type', 'schema', 'upload_id'];
const leadingRank = (key: string) => {
  const rank = LEADING_KEYS.indexOf(key);
  return rank < 0 ? LEADING_KEYS.length : rank;
};

/**
 * A compact JS literal that Prettier lays out. `__proto__` must remain an own
 * data key, never object syntax.
 */
export function migrationLiteral(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      unwritable('Migration payload contains a non-JSON value.');
    return encoded;
  }
  if (Array.isArray(value))
    return `[${value.map(migrationLiteral).join(', ')}]`;
  const entries = Object.entries(value).sort(
    ([a], [b]) => leadingRank(a) - leadingRank(b),
  );
  return entries.length
    ? `{ ${entries
        .map(
          ([key, item]) =>
            `${
              key === '__proto__' ? '["__proto__"]' : JSON.stringify(key)
            }: ${migrationLiteral(item)}`,
        )
        .join(', ')} }`
    : '{}';
}

const exists = (path: string) =>
  new ContentError(
    'MIGRATION_EXISTS',
    `Migration output already exists: ${path}`,
  );
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw exists(path);
}
function initTables(store: SnapshotStore): void {
  store.database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS migration_baseline (
      kind TEXT NOT NULL,id TEXT NOT NULL,guard_json TEXT NOT NULL,PRIMARY KEY(kind,id)
    ) WITHOUT ROWID;
  `);
}

/**
 * Baseline rows in chunks of at most `maximum` bytes. A chunk is held in
 * memory and written whole once its descriptor is final.
 */
class RowWriter {
  readonly index: ArtifactChunkIndex = {
    file: 'chunks.jsonl',
    sha256: '',
    bytes: 0,
    count: 0,
  };
  private readonly indexLines: Buffer[] = [];
  private readonly indexHash = createHash('sha256');
  private current?: {
    lines: Buffer[];
    descriptor: ArtifactChunk;
    hash: ReturnType<typeof createHash>;
  };
  constructor(
    private directory: string,
    private maximum: number,
    private signal?: AbortSignal,
  ) {}
  async begin() {
    await mkdir(join(this.directory, 'baseline'));
  }
  async add(row: BaselineRow) {
    const line = Buffer.from(`${JSON.stringify(row)}\n`);
    if (line.length > MAX_METADATA)
      unwritable('One migration baseline entry exceeds 16 MiB.');
    if (
      this.current &&
      this.current.descriptor.bytes + line.length > this.maximum
    )
      await this.finishChunk();
    if (!this.current) {
      const file = `baseline/${String(this.index.count + 1).padStart(
        6,
        '0',
      )}.jsonl`;
      this.current = {
        lines: [],
        descriptor: { file, bytes: 0, entries: 0, sha256: '' },
        hash: createHash('sha256'),
      };
    }
    this.current.lines.push(line);
    this.current.hash.update(line);
    this.current.descriptor.bytes += line.length;
    this.current.descriptor.entries++;
  }
  private async finishChunk() {
    if (!this.current) return;
    const { lines, descriptor, hash } = this.current;
    this.current = undefined;
    await writeFile(
      join(this.directory, descriptor.file),
      Buffer.concat(lines),
      {
        flag: 'wx',
        signal: this.signal,
      },
    );
    descriptor.sha256 = hash.digest('hex');
    const line = Buffer.from(`${JSON.stringify(descriptor)}\n`);
    this.indexLines.push(line);
    this.indexHash.update(line);
    this.index.bytes += line.length;
    this.index.count++;
  }
  async finish() {
    await this.finishChunk();
    await writeFile(
      join(this.directory, this.index.file),
      Buffer.concat(this.indexLines),
      { flag: 'wx', signal: this.signal },
    );
    this.index.sha256 = this.indexHash.digest('hex');
    return this.index;
  }
}

/** Match schema generation: project configuration, then Prettier defaults. */
async function formatScript(source: string, filepath: string): Promise<string> {
  try {
    const options = await resolveConfig(filepath);
    return await format(source, { ...options, filepath, parser: 'typescript' });
  } catch {
    // User configuration can require incompatible plugins/options. Keep the
    // generated migration usable with the bundled TypeScript formatter.
    return format(source, { filepath, parser: 'typescript' });
  }
}

const partName = (index: number) => `${String(index + 1).padStart(6, '0')}.ts`;
const RUNTIME = '@datocms/cli-plugin-content-diff/migration';
function runtimeImport(values: Iterable<string>): string {
  const names = [...new Set(values)].sort();
  return names.length
    ? `import { type ContentMigrationClient, ${names.join(
        ', ',
      )} } from '${RUNTIME}';`
    : `import type { ContentMigrationClient } from '${RUNTIME}';`;
}

interface ScriptStatement {
  code: string;
  /** Runtime helpers the statement calls, imported only where used. */
  runtime: string[];
}

/** Bound code generation and formatting by one part, never the whole project. */
class ScriptWriter {
  private statements: ScriptStatement[] = [];
  private bodyBytes = 0;
  private parts = 0;
  private calls = 0;
  constructor(
    private directory: string,
    private companionName: string,
    private outputPath: string,
    private maximum: number,
    private signal?: AbortSignal,
  ) {}
  async add(code: string, runtime: string[] = []) {
    assertNotAborted(this.signal);
    const length = Buffer.byteLength(code);
    if (this.statements.length && this.bodyBytes + length > this.maximum)
      await this.flushPart();
    this.statements.push({ code, runtime });
    this.bodyBytes += length;
    if (++this.calls % 30 === 0) await setImmediate();
  }
  private async writePart(statements: ScriptStatement[]): Promise<void> {
    assertNotAborted(this.signal);
    const name = partName(this.parts);
    const source = `${runtimeImport(
      statements.flatMap((statement) => statement.runtime),
    )}

export default async function(client: ContentMigrationClient): Promise<void> {
${statements.map((statement) => statement.code).join('')}
}
`;
    const formatted = await formatScript(
      source,
      join(dirname(this.outputPath), this.companionName, 'parts', name),
    );
    await mkdir(join(this.directory, 'parts'), { recursive: true });
    await writeFile(join(this.directory, 'parts', name), formatted, {
      flag: 'wx',
      signal: this.signal,
    });
    this.parts++;
  }
  private async flushPart() {
    if (!this.statements.length) return;
    await this.writePart(this.statements);
    this.statements = [];
    this.bodyBytes = 0;
  }
  private mainSource(): string {
    const parts = Array.from({ length: this.parts }, (_, index) =>
      partName(index),
    );
    const body = parts.length
      ? `  for (const part of ${JSON.stringify(parts)})
    await runMigrationPart(client, join(__dirname, ${JSON.stringify(
      this.companionName,
    )}, 'parts', part));
`
      : this.statements.map((statement) => statement.code).join('');
    const runtime = ['defineContentMigration'];
    if (parts.length) runtime.push('runMigrationPart');
    else
      for (const statement of this.statements)
        runtime.push(...statement.runtime);
    return `import { join } from 'node:path';
${runtimeImport(runtime)}

export default defineContentMigration(
  { baseline: join(__dirname, ${JSON.stringify(this.companionName)}) },
  async (client: ContentMigrationClient): Promise<void> => {
${body || '    // No content changes.\n'}  },
);
`;
  }
  async finish(): Promise<string> {
    if (this.parts) await this.flushPart();
    return formatScript(this.mainSource(), this.outputPath);
  }
}

export async function writeMigration(args: {
  store: SnapshotStore;
  metadata: PlanMetadata;
  outputPath: string;
  sourceTracking: MigrationTrackingBinding;
  destinationTracking: MigrationTrackingBinding;
  chunkBytes?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { store, metadata, signal } = args;
  assertNotAborted(signal);
  const maximum = args.chunkBytes ?? DEFAULT_MIGRATION_CHUNK_BYTES;
  const output = resolve(args.outputPath);
  const companionName = `${basename(output, '.ts')}.content`;
  const companion = join(dirname(output), companionName);
  await mkdir(dirname(output), { recursive: true });
  await absent(output);
  await absent(companion);
  assertNotAborted(signal);
  const temporary = await mkdtemp(join(dirname(output), '.content-migration-'));
  const staging = join(temporary, companionName);
  await mkdir(staging);
  const writer = new RowWriter(staging, maximum, signal);
  let ownsCompanion = false;
  let complete = false;
  try {
    await writer.begin();
    for (const kind of kinds) {
      const states =
        kind === 'record'
          ? store.records('target')
          : kind === 'upload'
            ? store.uploads('target')
            : store.collections('target');
      for (const state of states) {
        assertNotAborted(signal);
        await writer.add({
          kind,
          id: state.id,
          guard:
            kind === 'record'
              ? recordGuard(state as RecordState)
              : { hash: state.hash },
        });
      }
    }
    const chunks = await writer.finish();
    const manifest: BaselineManifest = {
      ...metadata,
      format: FORMAT,
      createdAt: new Date().toISOString(),
      sourceTracking: args.sourceTracking,
      destinationTracking: args.destinationTracking,
      chunks,
    };
    const raw = Buffer.from(`${JSON.stringify(manifest)}\n`);
    if (raw.length > MAX_METADATA)
      unwritable('Migration metadata exceeds 16 MiB.');
    await writeFile(join(staging, 'manifest.json'), raw, {
      flag: 'wx',
      signal,
    });
    await writeFile(join(staging, 'manifest.sha256'), `${sha256(raw)}\n`, {
      flag: 'wx',
      signal,
    });
    const scriptWriter = new ScriptWriter(
      staging,
      companionName,
      output,
      maximum,
      signal,
    );
    await emitMigrationCalls(store, metadata, scriptWriter, migrationLiteral);
    const script = await scriptWriter.finish();
    await writeFile(join(temporary, 'migration.ts'), script, {
      flag: 'wx',
      signal,
    });
    await absent(output);
    // Creating the directory claims the companion name exclusively; the staged
    // files then move into it under names nothing else can hold, which needs
    // no directory replacement and works the same on every platform.
    try {
      await mkdir(companion);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw exists(companion);
      throw error;
    }
    ownsCompanion = true;
    assertNotAborted(signal);
    for (const entry of await readdir(staging))
      await rename(join(staging, entry), join(companion, entry));
    // The script is published last and never replaces an existing file.
    try {
      await copyFile(
        join(temporary, 'migration.ts'),
        output,
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw exists(output);
      await rm(output, { force: true });
      throw error;
    }
    complete = true;
    return output;
  } finally {
    if (!complete && ownsCompanion)
      await rm(companion, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

function validateTracking(value: unknown): value is MigrationTrackingBinding {
  return (
    object(value) &&
    text(value.apiKey) &&
    (value.model === null || (object(value.model) && text(value.model.id)))
  );
}
/**
 * The checksums already detect corruption, so only the fields apply reads are
 * checked for shape. The rest of the manifest is information for readers.
 */
function validateManifest(value: unknown): asserts value is BaselineManifest {
  if (!object(value) || value.format !== FORMAT)
    invalid('Unsupported content migration baseline.');
  if (
    !object(value.destination) ||
    !text(value.destination.siteId) ||
    !text(value.destination.environmentId)
  )
    invalid('Invalid destination binding.');
  if (!validateTracking(value.destinationTracking))
    invalid('Invalid migration tracking identity.');
  if (!object(value.schema) || !digest(value.schema.hash))
    invalid('Invalid baseline schema.');
  if (
    !object(value.counts) ||
    kinds.some(
      (kind) =>
        !object((value.counts as JsonObject)[kind]) ||
        ['create', 'update', 'delete', 'noop', 'skip'].some(
          (action) =>
            !count(((value.counts as JsonObject)[kind] as JsonObject)[action]),
        ),
    )
  )
    invalid('Invalid generation summary.');
  if (
    !object(value.chunks) ||
    value.chunks.file !== 'chunks.jsonl' ||
    !digest(value.chunks.sha256) ||
    !count(value.chunks.bytes) ||
    !count(value.chunks.count)
  )
    invalid('Invalid baseline chunk index.');
}
/** A guard is compared as a whole, so only the row's identity is checked. */
function validateRow(value: unknown): asserts value is BaselineRow {
  if (
    !object(value) ||
    !kinds.includes(value.kind as Kind) ||
    !text(value.id) ||
    !object(value.guard)
  )
    invalid('Invalid baseline guard.');
}

async function readSmallFile(
  directory: string,
  file: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  assertNotAborted(signal);
  const handle = await open(join(directory, file));
  try {
    if ((await handle.stat()).size > maximum)
      invalid(`Migration companion file is too large: ${file}`);
    const bytes = await handle.readFile();
    assertNotAborted(signal);
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * The JSON lines of a companion file whose size, checksum and line count the
 * manifest or the chunk index records. Every such file is capped, so it is
 * read whole and checked before any line is parsed.
 */
async function jsonLines(
  directory: string,
  descriptor: Pick<ArtifactChunk, 'file' | 'bytes' | 'sha256'>,
  lines: number,
  label: string,
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (descriptor.bytes > MAX_METADATA)
    invalid(`Migration companion file is too large: ${descriptor.file}`);
  const bytes = await readSmallFile(
    directory,
    descriptor.file,
    descriptor.bytes,
    signal,
  );
  if (bytes.length !== descriptor.bytes)
    invalid(`${label} size differs: ${descriptor.file}`);
  if (sha256(bytes) !== descriptor.sha256)
    invalid(`${label} checksum differs: ${descriptor.file}`);
  const values = bytes.length
    ? new TextDecoder('utf-8', { fatal: true })
        .decode(bytes)
        .replace(/\n$/, '')
        .split('\n')
    : [];
  if (values.length !== lines)
    invalid(`${label} entry count differs: ${descriptor.file}`);
  return values.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      invalid(`Invalid JSON ${label.toLowerCase()} entry: ${descriptor.file}`);
    }
  });
}

export async function loadBaseline(
  directory: string,
  store: SnapshotStore,
  signal?: AbortSignal,
): Promise<BaselineManifest> {
  const root = resolve(directory);
  if (!(await stat(root)).isDirectory())
    invalid('Baseline must be a directory.');
  const raw = await readSmallFile(root, 'manifest.json', MAX_METADATA, signal);
  const checksum = await readSmallFile(root, 'manifest.sha256', 65, signal);
  if (checksum.toString('utf8') !== `${sha256(raw)}\n`)
    invalid('Baseline manifest checksum differs.');
  const manifest: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(raw),
  );
  validateManifest(manifest);
  // The store is new and is disposed by the caller after a failure.
  initTables(store);
  const insert = store.database.prepare(
    'INSERT INTO migration_baseline VALUES(?,?,?)',
  );
  const descriptors = await jsonLines(
    root,
    manifest.chunks,
    manifest.chunks.count,
    'Baseline chunk index',
    signal,
  );
  for (const [index, candidate] of descriptors.entries()) {
    if (
      !object(candidate) ||
      candidate.file !==
        `baseline/${String(index + 1).padStart(6, '0')}.jsonl` ||
      !count(candidate.bytes) ||
      candidate.bytes === 0 ||
      !count(candidate.entries) ||
      candidate.entries === 0 ||
      !digest(candidate.sha256)
    )
      invalid('Invalid or unordered baseline chunk descriptor.');
    const chunk = candidate as unknown as ArtifactChunk;
    const rows = await jsonLines(
      root,
      chunk,
      chunk.entries,
      'Baseline',
      signal,
    );
    store.transaction(() => {
      for (const row of rows) {
        validateRow(row);
        insert.run(row.kind, row.id, JSON.stringify(row.guard));
      }
    });
  }
  assertNotAborted(signal);
  return manifest;
}

/** Compare every recorded identity and detect new identities before any writes. */
export function compareBaseline(
  store: SnapshotStore,
  side: Side = 'target',
): void {
  for (const [kind, table] of [
    ['record', 'records'],
    ['upload', 'uploads'],
    ['collection', 'collections'],
  ] as const) {
    const unexpected = store.database
      .prepare(
        `SELECT s.id FROM ${table} s LEFT JOIN migration_baseline b ON b.kind=? AND b.id=s.id WHERE s.side=? AND b.id IS NULL ORDER BY s.id LIMIT 1`,
      )
      .get(kind, side);
    if (unexpected)
      throw destinationChanged({
        kind,
        id: String(unexpected.id),
        reason: 'added',
      });
    const missing = store.database
      .prepare(
        `SELECT b.id FROM migration_baseline b LEFT JOIN ${table} s ON s.side=? AND s.id=b.id WHERE b.kind=? AND s.id IS NULL ORDER BY b.id LIMIT 1`,
      )
      .get(side, kind);
    if (missing)
      throw destinationChanged({
        kind,
        id: String(missing.id),
        reason: 'removed',
      });
    for (const row of store.database
      .prepare(
        `SELECT b.id,b.guard_json,s.state_json,s.hash FROM migration_baseline b JOIN ${table} s ON s.side=? AND s.id=b.id WHERE b.kind=? ORDER BY b.id`,
      )
      .iterate(side, kind)) {
      const expected = JSON.parse(String(row.guard_json)) as RecordGuard;
      const equal =
        kind === 'record'
          ? hashJson(expected) ===
            hashJson(
              recordGuard(JSON.parse(String(row.state_json)) as RecordState),
            )
          : expected.hash === row.hash;
      if (!equal)
        throw destinationChanged({
          kind,
          id: String(row.id),
          reason: 'changed',
        });
    }
  }
}
