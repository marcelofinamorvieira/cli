import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { format, resolveConfig } from 'prettier';
import { boundedWork } from './apply-work';
import {
  jsonlValues,
  readSmallFile,
  validateSchedules,
  validateState,
  verifyBinary,
} from './artifact-integrity';
import { fetchBinary, requiresBinary } from './asset-download';
import { assertNotAborted } from './cancellation';
import {
  assertMetadataIntegerPrecision,
  hashJson,
  object,
  recordGuard,
} from './codec';
import { ContentError } from './errors';
import { emitMigrationCalls, restoreFieldSource } from './migration-emit';
import {
  DEFAULT_MIGRATION_CHUNK_BYTES,
  MAX_MIGRATION_CHUNK_BYTES,
  MAX_MIGRATION_FILE_BYTES,
} from './migration-limits';
import type { MigrationTrackingBinding } from './migration-schema';
import { suppressedDefaultValue } from './planner-validity';
import { schemaHash } from './schema';
import type { SnapshotStore } from './store';
import type {
  ArtifactChunk,
  ArtifactChunkIndex,
  BinaryFile,
  CollectionPlan,
  CollectionState,
  JsonObject,
  Kind,
  PlanEntry,
  PlanMetadata,
  RecordGuard,
  RecordPlan,
  RecordState,
  Side,
  UploadPlan,
  UploadState,
} from './types';

const FORMAT = 'datocms-content-migration-baseline/2';
const MAX_METADATA = 16 * 1024 * 1024;
const kinds = ['record', 'upload', 'collection'] as const;
const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

export interface BaselineManifest extends PlanMetadata {
  format: typeof FORMAT;
  createdAt: string;
  sourceTracking: MigrationTrackingBinding;
  destinationTracking: MigrationTrackingBinding;
  targetCounts: Record<Kind, number>;
  chunks: ArtifactChunkIndex;
}

export interface MigrationBinary {
  localPath: string;
  binary: BinaryFile;
  filename: string;
  url: string;
}
interface BaselineEntry {
  type: 'baseline';
  kind: Kind;
  id: string;
  guard: RecordGuard | { hash: string };
  original?: RecordState | UploadState | CollectionState;
}
interface BinaryEntry {
  type: 'binary';
  uploadId: string;
  binary: BinaryFile;
  filename: string;
  url: string;
}
type Row = BaselineEntry | BinaryEntry;

function invalid(message: string): never {
  throw new ContentError('INVALID_MIGRATION_BASELINE', message);
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

/** Real JS literals: __proto__ must remain an own data key, never object syntax. */
export function migrationLiteral(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      invalid('Migration payload contains a non-JSON value.');
    return encoded;
  }
  const indent = '  '.repeat(depth);
  const child = `${indent}  `;
  if (Array.isArray(value))
    return value.length
      ? `[\n${value
          .map((item) => `${child}${migrationLiteral(item, depth + 1)}`)
          .join(',\n')}\n${indent}]`
      : '[]';
  const entries = Object.entries(value);
  return entries.length
    ? `{\n${entries
        .map(
          ([key, item]) =>
            `${child}${
              key === '__proto__' ? '["__proto__"]' : JSON.stringify(key)
            }: ${migrationLiteral(item, depth + 1)}`,
        )
        .join(',\n')}\n${indent}}`
    : '{}';
}

async function bytes(
  handle: FileHandle,
  value: string | Buffer,
  signal?: AbortSignal,
): Promise<void> {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    assertNotAborted(signal);
    const written = await handle.write(buffer, offset, buffer.length - offset);
    if (!written.bytesWritten)
      invalid('Migration output could not be written.');
    offset += written.bytesWritten;
  }
}
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ContentError(
    'MIGRATION_EXISTS',
    `Migration output already exists: ${path}`,
  );
}
function initTables(store: SnapshotStore): void {
  store.database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS migration_baseline (
      kind TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,model_id TEXT,parent_id TEXT,
      position REAL,guard_json TEXT NOT NULL,original_json TEXT,PRIMARY KEY(kind,id)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS migration_baseline_binaries (
      upload_id TEXT PRIMARY KEY,file TEXT NOT NULL UNIQUE,data TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

class RowWriter {
  readonly index: ArtifactChunkIndex = {
    file: 'chunks.jsonl',
    sha256: '',
    bytes: 0,
    count: 0,
  };
  private indexHandle?: FileHandle;
  private readonly indexHash = createHash('sha256');
  private current?: {
    handle: FileHandle;
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
    this.indexHandle = await open(
      join(this.directory, this.index.file),
      'wx',
      0o600,
    );
  }
  async add(row: Row) {
    const line = Buffer.from(`${JSON.stringify(row)}\n`);
    if (line.length > MAX_METADATA)
      invalid('One migration baseline entry exceeds 16 MiB.');
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
        handle: await open(join(this.directory, file), 'wx', 0o600),
        descriptor: { file, bytes: 0, entries: 0, sha256: '' },
        hash: createHash('sha256'),
      };
    }
    await bytes(this.current.handle, line, this.signal);
    this.current.hash.update(line);
    this.current.descriptor.bytes += line.length;
    this.current.descriptor.entries++;
  }
  private async finishChunk() {
    if (!this.current) return;
    await this.current.handle.close();
    this.current.descriptor.sha256 = this.current.hash.digest('hex');
    const line = Buffer.from(`${JSON.stringify(this.current.descriptor)}\n`);
    await bytes(this.indexHandle!, line, this.signal);
    this.indexHash.update(line);
    this.index.bytes += line.length;
    this.index.count++;
    this.current = undefined;
  }
  async finish() {
    await this.finishChunk();
    await this.indexHandle!.close();
    this.indexHandle = undefined;
    this.index.sha256 = this.indexHash.digest('hex');
    return this.index;
  }
  async close() {
    await this.current?.handle.close().catch(() => undefined);
    await this.indexHandle?.close().catch(() => undefined);
  }
}

function checkedScript(source: string): string {
  if (Buffer.byteLength(source) > MAX_MIGRATION_FILE_BYTES)
    throw new ContentError(
      'MIGRATION_FILE_TOO_LARGE',
      `Generated TypeScript exceeds ${MAX_MIGRATION_FILE_BYTES} bytes (16 MiB), including headers. Use a smaller chunk target, shorter output filename, or smaller operation.`,
    );
  return source;
}

/** Match schema generation: project configuration, then Prettier defaults. */
async function formatScript(source: string, filepath: string): Promise<string> {
  checkedScript(source);
  try {
    const options = await resolveConfig(filepath);
    return await format(source, { ...options, filepath, parser: 'typescript' });
  } catch {
    // User configuration can require incompatible plugins/options. Keep the
    // generated migration usable with the bundled TypeScript formatter.
    return format(source, { filepath, parser: 'typescript' });
  }
}

interface ScriptStatement {
  main: string;
  part: string;
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
    private temporaryChanges: PlanMetadata['temporarySchemaChanges'] = [],
  ) {}
  async add(statement: string, partStatement = statement) {
    assertNotAborted(this.signal);
    const length = Math.max(
      Buffer.byteLength(statement),
      Buffer.byteLength(partStatement),
    );
    if (length > MAX_MIGRATION_CHUNK_BYTES)
      throw new ContentError(
        'MIGRATION_FILE_TOO_LARGE',
        `One generated operation exceeds ${MAX_MIGRATION_CHUNK_BYTES} bytes. A TypeScript file must fit within 16 MiB including headers.`,
      );
    if (this.statements.length && this.bodyBytes + length > this.maximum)
      await this.flushPart();
    this.statements.push({ main: statement, part: partStatement });
    this.bodyBytes += length;
    if (++this.calls % 30 === 0) await setImmediate();
  }
  private async writePart(statements: ScriptStatement[]): Promise<void> {
    assertNotAborted(this.signal);
    const name = `${String(this.parts + 1).padStart(6, '0')}.ts`;
    const source = `import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { checkMigration, uploadMigrationFile } from '@datocms/cli-plugin-content-diff/migration';
import type { ContentMigrationClient } from '@datocms/cli-plugin-content-diff/migration';

export default async function(client: ContentMigrationClient): Promise<void> {
${statements.map((statement) => statement.part).join('')}
}
`;
    const formatted = await formatScript(
      source,
      join(dirname(this.outputPath), this.companionName, 'parts', name),
    );
    // Formatting can expand indentation/line breaks. Split between operations
    // again after formatting, allowing one indivisible operation per part.
    if (
      statements.length > 1 &&
      Buffer.byteLength(formatted) > this.maximum + 1024
    ) {
      const middle = Math.ceil(statements.length / 2);
      await this.writePart(statements.slice(0, middle));
      await this.writePart(statements.slice(middle));
      return;
    }
    checkedScript(formatted);
    await mkdir(join(this.directory, 'parts'), { recursive: true });
    await writeFile(join(this.directory, 'parts', name), formatted, {
      flag: 'wx',
      mode: 0o600,
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
  private mainSource(allowTemporarySchemaChanges: boolean): string {
    const body = this.parts
      ? `  // Parts execute sequentially and are released before loading the next.
  for (let part = 1; part <= ${this.parts}; part++) {
    await runMigrationPart(client, join(__dirname, ${JSON.stringify(
      this.companionName,
    )}, 'parts', String(part).padStart(6, '0') + '.ts'));
  }
`
      : this.statements.map((statement) => statement.main).join('');
    return `import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ContentMigrationClient } from '@datocms/cli-plugin-content-diff/migration';
import { defineContentMigration, checkMigration, uploadMigrationFile${
      this.parts ? ', runMigrationPart' : ''
    } } from '@datocms/cli-plugin-content-diff/migration';

// Run this file with datocms content:apply.
// Review and edit these ready-to-execute CMA operations.
export default defineContentMigration(
  { baseline: join(__dirname, ${JSON.stringify(
    this.companionName,
  )}), allowTemporarySchemaChanges: ${allowTemporarySchemaChanges} },
  async (client: ContentMigrationClient): Promise<void> => {
${
  this.temporaryChanges.length
    ? `    let migrationError: unknown;\n    try {\n${body}    } catch (error) {\n      migrationError = error;\n      throw error;\n    } finally {\n      const failures: unknown[] = [];\n${this.temporaryChanges
        .map(
          (change) =>
            `      try {\n${restoreFieldSource(
              change,
              migrationLiteral,
            )}      } catch (error) { failures.push(error); }\n`,
        )
        .join(
          '',
        )}      if (failures.length) throw new AggregateError(migrationError === undefined ? failures : [migrationError, ...failures], 'Some original field settings could not be restored.', { cause: migrationError });\n    }\n`
    : body || '  // No content changes.\n'
}  },
);
`;
  }
  async finish(allowTemporarySchemaChanges: boolean): Promise<string> {
    if (this.parts) await this.flushPart();
    let source = await formatScript(
      this.mainSource(allowTemporarySchemaChanges),
      this.outputPath,
    );
    if (
      !this.parts &&
      this.statements.length > 1 &&
      Buffer.byteLength(source) > this.maximum + 1024
    ) {
      await this.flushPart();
      source = await formatScript(
        this.mainSource(allowTemporarySchemaChanges),
        this.outputPath,
      );
    }
    return checkedScript(source);
  }
  async asset(statement: (path: string) => string, file: string) {
    await this.add(
      statement(
        `join(__dirname, ${JSON.stringify(
          this.companionName,
        )}, ${JSON.stringify(file)})`,
      ),
      statement(`join(__dirname, '..', ${JSON.stringify(file)})`),
    );
  }
}

export async function writeMigration(args: {
  store: SnapshotStore;
  metadata: PlanMetadata;
  outputPath: string;
  sourceTracking: MigrationTrackingBinding;
  destinationTracking: MigrationTrackingBinding;
  chunkBytes?: number;
  concurrency?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const { store, metadata, signal } = args;
  assertNotAborted(signal);
  const maximum = args.chunkBytes ?? DEFAULT_MIGRATION_CHUNK_BYTES;
  if (!count(maximum) || maximum < 1 || maximum > MAX_MIGRATION_CHUNK_BYTES)
    invalid(
      'Migration chunk size must be between 1 byte and 16 MiB minus 1 KiB.',
    );
  const output = resolve(args.outputPath);
  if (extname(output) !== '.ts')
    invalid('Content migration output must end in .ts.');
  const companionName = `${basename(output, '.ts')}.content`;
  const companion = join(dirname(output), companionName);
  await mkdir(dirname(output), { recursive: true });
  await absent(output);
  await absent(companion);
  assertNotAborted(signal);
  const temporary = await mkdtemp(join(dirname(output), '.content-migration-'));
  const staging = join(temporary, companionName);
  await mkdir(staging);
  await mkdir(join(staging, 'binaries'));
  const writer = new RowWriter(staging, maximum, signal);
  let ownsCompanion = false;
  let complete = false;
  initTables(store);
  store.database.exec('DELETE FROM migration_baseline_binaries');
  try {
    await boundedWork(
      (function* () {
        for (const entry of store.iteratePlan('upload'))
          if (requiresBinary(entry as UploadPlan)) yield entry as UploadPlan;
      })(),
      Math.max(1, Math.min(16, args.concurrency ?? 4)),
      async (entry) => {
        const original = await fetchBinary(
          entry,
          staging,
          args.fetchFn ?? fetch,
          (ms, signal) => setTimeout(ms, undefined, { signal }),
          60_000,
          signal,
        );
        const file = `binaries/${sha256(entry.id)}-${original.sha256}.bin`;
        await link(join(staging, original.file), join(staging, file));
        const binary = { ...original, file };
        const row: BinaryEntry = {
          type: 'binary',
          uploadId: entry.id,
          binary,
          filename: entry.desired!.filename,
          url: entry.desired!.url,
        };
        store.database
          .prepare('INSERT INTO migration_baseline_binaries VALUES(?,?,?)')
          .run(entry.id, file, JSON.stringify(row));
      },
      undefined,
      signal,
    );
    // Every upload has its own verified path/filename binding. The shared
    // download names are staging details, not additional companion assets.
    for (const row of store.database
      .prepare(
        'SELECT data FROM migration_baseline_binaries ORDER BY upload_id',
      )
      .iterate()) {
      const asset = JSON.parse(String(row.data)) as BinaryEntry;
      await rm(join(staging, 'binaries', `${asset.binary.sha256}.bin`), {
        force: true,
      });
    }
    await writer.begin();
    const targetCounts: Record<Kind, number> = {
      record: 0,
      upload: 0,
      collection: 0,
    };
    for (const kind of kinds) {
      const states =
        kind === 'record'
          ? store.iterateRecords('target')
          : kind === 'upload'
            ? store.iterateUploads('target')
            : store.iterateCollections('target');
      for (const state of states) {
        assertNotAborted(signal);
        const plan = store.getPlan(kind, state.id);
        const row: BaselineEntry = {
          type: 'baseline',
          kind,
          id: state.id,
          guard:
            kind === 'record'
              ? recordGuard(state as RecordState)
              : { hash: state.hash },
        };
        if (plan && ['update', 'delete'].includes(plan.action))
          row.original = state;
        await writer.add(row);
        targetCounts[kind]++;
      }
    }
    for (const row of store.database
      .prepare(
        'SELECT data FROM migration_baseline_binaries ORDER BY upload_id',
      )
      .iterate())
      await writer.add(JSON.parse(String(row.data)) as BinaryEntry);
    const chunks = await writer.finish();
    const manifest: BaselineManifest = {
      ...metadata,
      format: FORMAT,
      createdAt: new Date().toISOString(),
      sourceTracking: args.sourceTracking,
      destinationTracking: args.destinationTracking,
      targetCounts,
      chunks,
    };
    validateManifest(manifest);
    const raw = Buffer.from(`${JSON.stringify(manifest)}\n`);
    if (raw.length > MAX_METADATA)
      invalid('Migration metadata exceeds 16 MiB.');
    await writeFile(join(staging, 'manifest.json'), raw, {
      flag: 'wx',
      mode: 0o600,
      signal,
    });
    await writeFile(join(staging, 'manifest.sha256'), `${sha256(raw)}\n`, {
      flag: 'wx',
      mode: 0o600,
      signal,
    });
    const scriptWriter = new ScriptWriter(
      staging,
      companionName,
      output,
      maximum,
      signal,
      metadata.temporarySchemaChanges,
    );
    await emitMigrationCalls(store, metadata, scriptWriter, migrationLiteral);
    const script = await scriptWriter.finish(
      metadata.options.allowTemporarySchemaChanges,
    );
    await writeFile(join(temporary, 'migration.ts'), script, {
      flag: 'wx',
      mode: 0o600,
      signal,
    });
    await absent(output);
    await mkdir(companion);
    ownsCompanion = true;
    assertNotAborted(signal);
    await rename(staging, companion);
    await link(join(temporary, 'migration.ts'), output);
    complete = true;
    return output;
  } finally {
    await writer.close();
    if (!complete && ownsCompanion)
      await rm(companion, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

function validateTracking(value: unknown): value is MigrationTrackingBinding {
  return (
    object(value) &&
    text(value.apiKey) &&
    (value.model === null ||
      (object(value.model) &&
        text(value.model.id) &&
        text(value.model.nameFieldId)))
  );
}
function validateManifest(value: unknown): asserts value is BaselineManifest {
  if (
    !object(value) ||
    value.format !== FORMAT ||
    !text(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    invalid('Unsupported content migration baseline.');
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
    !validateTracking(value.sourceTracking) ||
    !validateTracking(value.destinationTracking)
  )
    invalid('Invalid migration tracking identity.');
  if (
    !object(value.schema) ||
    !Array.isArray(value.schema.models) ||
    !Array.isArray(value.schema.locales) ||
    !Array.isArray(value.schema.workflows) ||
    !object(value.schema.semantics) ||
    !digest(value.schema.hash)
  )
    invalid('Invalid baseline schema.');
  if (
    schemaHash(value.schema as unknown as BaselineManifest['schema']) !==
    value.schema.hash
  )
    invalid('Baseline schema hash differs.');
  if (
    !object(value.options) ||
    !Array.isArray(value.options.modelIds) ||
    !value.options.modelIds.every(text) ||
    !['all', 'referenced'].includes(String(value.options.uploads)) ||
    ['includeDeletions', 'allowPartial', 'allowTemporarySchemaChanges'].some(
      (key) => typeof (value.options as JsonObject)[key] !== 'boolean',
    )
  )
    invalid('Invalid generation options.');
  if (!Array.isArray(value.temporarySchemaChanges))
    invalid('Missing temporary field settings.');
  const changed = new Set<string>();
  const schema = value.schema as unknown as PlanMetadata['schema'];
  for (const change of value.temporarySchemaChanges) {
    if (
      !object(change) ||
      !text(change.fieldId) ||
      !text(change.modelId) ||
      changed.has(change.fieldId) ||
      !object(change.original) ||
      !object(change.temporary) ||
      !object(change.original.validators) ||
      !object(change.temporary.validators) ||
      !Array.isArray(change.reasons) ||
      !change.reasons.every(text)
    )
      invalid('Invalid temporary field settings.');
    changed.add(change.fieldId);
    const field = schema.models
      .find((model) => model.id === change.modelId)
      ?.fields.find((field) => field.id === change.fieldId);
    if (
      !field ||
      hashJson(field.validators) !== hashJson(change.original.validators) ||
      hashJson(field.defaultValue) !== hashJson(change.original.defaultValue)
    )
      invalid(
        'Temporary field original settings differ from the captured schema.',
      );
    assertMetadataIntegerPrecision(
      change.temporary.validators,
      `Temporary validators for ${change.fieldId}`,
    );
    for (const [key, validator] of Object.entries(change.temporary.validators))
      if (
        !Object.hasOwn(change.original.validators, key) ||
        hashJson(validator) !== hashJson(change.original.validators[key])
      )
        invalid('Temporary settings may only remove existing validators.');
    if (
      hashJson(change.temporary.defaultValue) !==
        hashJson(change.original.defaultValue) &&
      hashJson(change.temporary.defaultValue) !==
        hashJson(suppressedDefaultValue(field, schema.locales))
    )
      invalid('Temporary settings may only suppress defaults.');
  }
  if (
    changed.size &&
    !(value.options as JsonObject).allowTemporarySchemaChanges
  )
    invalid('Temporary schema changes were not authorized at generation.');
  if (
    !object(value.targetCounts) ||
    kinds.some((kind) => !count((value.targetCounts as JsonObject)[kind]))
  )
    invalid('Invalid baseline namespace counts.');
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
function validateRow(value: unknown): asserts value is Row {
  if (!object(value)) invalid('Invalid baseline entry.');
  if (value.type === 'binary') {
    if (
      !text(value.uploadId) ||
      !text(value.filename) ||
      basename(value.filename) !== value.filename ||
      !text(value.url) ||
      !object(value.binary) ||
      !text(value.binary.file) ||
      !/^binaries\/[a-f0-9]{64}-[a-f0-9]{64}\.bin$/.test(value.binary.file) ||
      !digest(value.binary.sha256) ||
      !digest(value.binary.md5, 32) ||
      !count(value.binary.bytes)
    )
      invalid('Invalid migration binary.');
    return;
  }
  if (
    value.type !== 'baseline' ||
    !kinds.includes(value.kind as Kind) ||
    !text(value.id) ||
    !object(value.guard) ||
    !digest(value.guard.hash)
  )
    invalid('Invalid baseline guard.');
  if (value.kind === 'record') {
    const guard = value.guard;
    if (
      !text(guard.modelId) ||
      !(guard.currentVersion === null || text(guard.currentVersion)) ||
      !(
        guard.publishedUpdatedAt === null ||
        (text(guard.publishedUpdatedAt) &&
          Number.isFinite(Date.parse(guard.publishedUpdatedAt)))
      ) ||
      !(guard.parentId === null || text(guard.parentId)) ||
      !(guard.position === null || count(guard.position)) ||
      !validateSchedules(guard.schedules) ||
      !object(guard.validity) ||
      typeof guard.validity.current !== 'boolean' ||
      !(
        guard.validity.published === null ||
        typeof guard.validity.published === 'boolean'
      )
    )
      invalid('Invalid record baseline guard.');
  }
  if (value.original !== undefined) {
    if (
      !validateState(value.original, {
        kind: value.kind,
        id: value.id,
        modelId: value.guard.modelId,
      } as PlanEntry) ||
      (value.original as { hash: string }).hash !== value.guard.hash
    )
      invalid('Invalid original record state.');
    if (
      value.kind === 'record' &&
      hashJson(recordGuard(value.original as RecordState)) !==
        hashJson(value.guard)
    )
      invalid('Original record state differs from its guard.');
  }
}

export async function loadBaseline(
  directory: string,
  store: SnapshotStore,
  signal?: AbortSignal,
): Promise<BaselineManifest> {
  const root = resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    invalid('Baseline must be a real directory.');
  const raw = await readSmallFile(root, 'manifest.json', MAX_METADATA, signal);
  const checksum = await readSmallFile(root, 'manifest.sha256', 65, signal);
  if (checksum.toString('utf8') !== `${sha256(raw)}\n`)
    invalid('Baseline manifest checksum differs.');
  const manifest: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(raw),
  );
  validateManifest(manifest);
  initTables(store);
  for (const table of ['migration_baseline', 'migration_baseline_binaries'])
    if (store.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
      invalid('Baseline loading requires empty baseline tables.');
  const insert = store.database.prepare(
    'INSERT INTO migration_baseline VALUES(?,?,?,?,?,?,?,?)',
  );
  const binary = store.database.prepare(
    'INSERT INTO migration_baseline_binaries VALUES(?,?,?)',
  );
  const counts: Record<Kind, number> = { record: 0, upload: 0, collection: 0 };
  store.database.exec('SAVEPOINT migration_baseline_load');
  try {
    let chunkNumber = 0;
    for await (const candidate of jsonlValues(
      root,
      manifest.chunks,
      manifest.chunks.count,
      'Baseline chunk index',
      1024,
      signal,
    )) {
      chunkNumber++;
      if (
        !object(candidate) ||
        candidate.file !==
          `baseline/${String(chunkNumber).padStart(6, '0')}.jsonl` ||
        !count(candidate.bytes) ||
        candidate.bytes === 0 ||
        !count(candidate.entries) ||
        candidate.entries === 0 ||
        !digest(candidate.sha256)
      )
        invalid('Invalid or unordered baseline chunk descriptor.');
      const chunk = candidate as unknown as ArtifactChunk;
      for await (const row of jsonlValues(
        root,
        chunk,
        chunk.entries,
        'Baseline',
        MAX_METADATA,
        signal,
      )) {
        validateRow(row);
        if (row.type === 'baseline') {
          const guard = row.guard as RecordGuard;
          insert.run(
            row.kind,
            row.id,
            guard.hash,
            row.kind === 'record' ? guard.modelId : null,
            row.kind === 'record' ? guard.parentId : null,
            row.kind === 'record' ? guard.position : null,
            JSON.stringify(row.guard),
            row.original ? JSON.stringify(row.original) : null,
          );
          counts[row.kind]++;
        } else {
          await verifyBinary(root, row.binary, signal);
          binary.run(row.uploadId, row.binary.file, JSON.stringify(row));
        }
      }
    }
    if (hashJson(counts) !== hashJson(manifest.targetCounts))
      invalid('Baseline namespace counts differ from the manifest.');
    assertNotAborted(signal);
    store.database.exec('RELEASE migration_baseline_load');
  } catch (error) {
    // SQLite can roll back the entire transaction on SQLITE_FULL. Keep that
    // original error rather than replacing it with a missing-savepoint error.
    try {
      store.database.exec(
        'ROLLBACK TO migration_baseline_load; RELEASE migration_baseline_load',
      );
    } catch {
      // The owning snapshot is disposed by the caller after this failure.
    }
    throw error;
  }
  return manifest;
}

export function* baselineBinaries(
  store: SnapshotStore,
  directory: string,
): Generator<MigrationBinary> {
  for (const row of store.database
    .prepare('SELECT data FROM migration_baseline_binaries ORDER BY upload_id')
    .iterate()) {
    const entry = JSON.parse(String(row.data)) as BinaryEntry;
    yield {
      localPath: resolve(directory, entry.binary.file),
      binary: entry.binary,
      filename: entry.filename,
      url: entry.url,
    };
  }
}
export function baselineBinaryLookup(
  store: SnapshotStore,
  directory: string,
  localPath: string,
): MigrationBinary | undefined {
  if (resolve(localPath) !== localPath) return undefined;
  const file = relative(resolve(directory), localPath).split('\\').join('/');
  const row = store.database
    .prepare('SELECT data FROM migration_baseline_binaries WHERE file=?')
    .get(file);
  if (!row) return undefined;
  const entry = JSON.parse(String(row.data)) as BinaryEntry;
  return {
    localPath,
    binary: entry.binary,
    filename: entry.filename,
    url: entry.url,
  };
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
        `SELECT s.id FROM ${table} s LEFT JOIN migration_baseline b ON b.kind=? AND b.id=s.id WHERE s.side=? AND b.id IS NULL LIMIT 1`,
      )
      .get(kind, side);
    if (unexpected)
      throw new ContentError(
        'APPLY_CONFLICT',
        `Destination gained ${kind} ${unexpected.id} after migration generation.`,
      );
    const missing = store.database
      .prepare(
        `SELECT b.id FROM migration_baseline b LEFT JOIN ${table} s ON s.side=? AND s.id=b.id WHERE b.kind=? AND s.id IS NULL LIMIT 1`,
      )
      .get(side, kind);
    if (missing)
      throw new ContentError(
        'APPLY_CONFLICT',
        `Destination lost ${kind} ${missing.id} after migration generation.`,
      );
    for (const row of store.database
      .prepare(
        `SELECT b.id,b.guard_json,s.state_json,s.hash FROM migration_baseline b JOIN ${table} s ON s.side=? AND s.id=b.id WHERE b.kind=? ORDER BY b.id`,
      )
      .iterate(side, kind)) {
      const expected = JSON.parse(String(row.guard_json)) as RecordGuard;
      let equal = expected.hash === row.hash;
      if (kind === 'record') {
        const actual = recordGuard(
          JSON.parse(String(row.state_json)) as RecordState,
        );
        const { validity: _expectedValidity, ...left } = expected;
        const { validity: _actualValidity, ...right } = actual;
        equal = hashJson(left) === hashJson(right);
      }
      if (!equal)
        throw new ContentError(
          'APPLY_CONFLICT',
          `Destination ${kind} ${row.id} differs from the migration baseline.`,
        );
    }
  }
}
