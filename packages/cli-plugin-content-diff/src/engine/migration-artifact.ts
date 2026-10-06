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
  fetchBinary,
  jsonlValues,
  readSmallFile,
  requiresBinary,
  validateSchedules,
  validateState,
  verifyBinary,
} from './bundle';
import { assertNotAborted } from './cancellation';
import { hashJson, object, recordGuard, recordPayloadFields } from './codec';
import { ContentError } from './errors';
import type { IntentBinary, IntentValidityEvidence } from './migration-intent';
import {
  DEFAULT_MIGRATION_CHUNK_BYTES,
  MAX_MIGRATION_CHUNK_BYTES,
  MAX_MIGRATION_FILE_BYTES,
} from './migration-limits';
import type { MigrationTrackingBinding } from './migration-schema';
import { schemaHash } from './schema';
import type { SnapshotStore } from './store';
import type {
  BinaryFile,
  BundleChunk,
  BundleChunkIndex,
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

const FORMAT = 'datocms-content-migration-baseline/1';
const MAX_METADATA = 16 * 1024 * 1024;
const kinds = ['record', 'upload', 'collection'] as const;
const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

export interface BaselineManifest
  extends Omit<PlanMetadata, 'temporarySchemaChanges'> {
  format: typeof FORMAT;
  createdAt: string;
  sourceTracking: MigrationTrackingBinding;
  destinationTracking: MigrationTrackingBinding;
  targetCounts: Record<Kind, number>;
  chunks: BundleChunkIndex;
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
type Row =
  | BaselineEntry
  | ({ type: 'validity' } & IntentValidityEvidence)
  | BinaryEntry;

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
    CREATE TEMP TABLE IF NOT EXISTS migration_baseline_validity (
      id TEXT NOT NULL,slice TEXT NOT NULL,hash TEXT NOT NULL,valid INTEGER NOT NULL,
      PRIMARY KEY(id,slice,hash)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS migration_baseline_binaries (
      upload_id TEXT PRIMARY KEY,file TEXT NOT NULL UNIQUE,data TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

class RowWriter {
  readonly index: BundleChunkIndex = {
    file: 'chunks.jsonl',
    sha256: '',
    bytes: 0,
    count: 0,
  };
  private indexHandle?: FileHandle;
  private readonly indexHash = createHash('sha256');
  private current?: {
    handle: FileHandle;
    descriptor: BundleChunk;
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
import type { ContentMigrationClient } from '@datocms/cli-plugin-content-diff/migration';
import { defineContentMigration${this.parts ? ', runMigrationPart' : ''} } from '@datocms/cli-plugin-content-diff/migration';

// Run this file with datocms content:apply.
// Review and edit these CMA operations. The runtime rebuilds their safe execution plan.
export default defineContentMigration(
  { baseline: join(__dirname, ${JSON.stringify(
    this.companionName,
  )}), allowTemporarySchemaChanges: ${allowTemporarySchemaChanges} },
  async (client: ContentMigrationClient): Promise<void> => {
${body || '  // No content changes.\n'}  },
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

/** Display captured labels only, bounded and escaped so content cannot add code. */
function commentLabel(value: string): string {
  const shortened = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return JSON.stringify(shortened)
    .replace(/\*\//g, '*\\/')
    .replace(/[\u2028\u2029]/g, (character) =>
      character === '\u2028' ? '\\u2028' : '\\u2029',
    );
}
function comment(action: string, subject: string, statement: string): string {
  return `  // ${action}: ${subject}.\n${statement}`;
}
function recordLabel(
  id: string,
  modelId: string,
  schema: PlanMetadata['schema'],
  state?: RecordState | null,
): string {
  const model = schema.models.find((candidate) => candidate.id === modelId);
  let title: string | undefined;
  for (const key of ['title', 'name']) {
    const field = model?.fields.find(
      (candidate) => candidate.apiKey === key && candidate.type === 'string',
    );
    if (!field) continue;
    const value = state?.current[key];
    if (typeof value === 'string') title = value;
    else if (field.localized && object(value))
      for (const locale of schema.locales) {
        if (typeof value[locale] === 'string' && value[locale]) {
          title = value[locale];
          break;
        }
      }
    if (title) break;
  }
  return `${
    model
      ? `${commentLabel(model.name)} (${commentLabel(model.apiKey)})`
      : commentLabel(modelId)
  } record ${commentLabel(id)}${title ? `, ${commentLabel(title)}` : ''}`;
}

function changedFields(
  before: JsonObject | null,
  after: JsonObject,
): JsonObject {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) =>
        !before ||
        !Object.hasOwn(before, key) ||
        hashJson(before[key]) !== hashJson(value),
    ),
  );
}
function payloadPatch(
  fields: JsonObject,
  modelId: string,
  schema: PlanMetadata['schema'],
): JsonObject {
  const payload = recordPayloadFields(fields, modelId, schema);
  // The codec normalizes a full record and supplies null for omitted fields.
  // Preserve omission in a script patch while still transforming its blocks.
  return Object.fromEntries(
    Object.keys(fields).map((key) => [key, payload[key]]),
  );
}

function call(method: string, ...args: unknown[]): string {
  return `  await client.${method}(${args
    .map((arg) => migrationLiteral(arg, 1))
    .join(', ')});\n\n`;
}
function recordMeta(
  state: RecordState,
  before?: RecordState | null,
): JsonObject {
  const values: JsonObject = {};
  if (!before || state.createdAt !== before.createdAt)
    values.created_at = state.createdAt;
  if (!before || state.firstPublishedAt !== before.firstPublishedAt)
    values.first_published_at = state.firstPublishedAt;
  if (!before || state.stage !== before.stage) values.stage = state.stage;
  return values;
}

async function emitRecord(
  writer: ScriptWriter,
  entry: RecordPlan,
  schema: PlanMetadata['schema'],
) {
  const label = recordLabel(
    entry.id,
    entry.modelId,
    schema,
    entry.desired ?? entry.baseline,
  );
  const add = (action: string, statement: string) =>
    writer.add(comment(action, label, statement));
  if (entry.action === 'delete') {
    await add('Delete record', call('items.destroy', entry.id));
    return;
  }
  if (!entry.desired || !['create', 'update'].includes(entry.action)) return;
  const desired = entry.desired;
  const before = entry.baseline;
  const model = schema.models.find(
    (candidate) => candidate.id === desired.modelId,
  )!;
  let current = before?.current ?? null;
  const metadata = recordMeta(desired, before);
  const publish =
    model.draftMode &&
    desired.published !== null &&
    hashJson(before?.published ?? null) !== hashJson(desired.published);
  const initial = publish ? desired.published! : desired.current;
  if (entry.action === 'create') {
    const { stage: _stage, ...creationMetadata } = metadata;
    await add(
      'Create record',
      call('items.create', {
        id: entry.id,
        item_type: { id: desired.modelId, type: 'item_type' },
        ...recordPayloadFields(initial, desired.modelId, schema),
        meta: creationMetadata,
        ...(model.tree ? { parent_id: desired.parentId } : {}),
        ...(model.sortable || model.tree ? { position: desired.position } : {}),
      }),
    );
    const workflow = schema.workflows.find(
      (candidate) => candidate.id === model.workflowId,
    );
    const initialStage = Array.isArray(workflow?.stages)
      ? workflow.stages.find((stage) => object(stage) && stage.initial === true)
      : undefined;
    const createdStage =
      object(initialStage) && typeof initialStage.id === 'string'
        ? initialStage.id
        : null;
    if (desired.stage !== createdStage)
      await add(
        'Set workflow stage',
        call('items.update', entry.id, { meta: { stage: desired.stage } }),
      );
    current = initial;
  } else if (publish) {
    const fields = changedFields(current, desired.published!);
    if (Object.keys(fields).length || Object.keys(metadata).length)
      await add(
        'Update published fields',
        call('items.update', entry.id, {
          ...payloadPatch(fields, desired.modelId, schema),
          ...(Object.keys(metadata).length ? { meta: metadata } : {}),
        }),
      );
    current = desired.published;
  }
  if (publish)
    await add(
      'Publish record',
      `  await client.items.publish(${JSON.stringify(
        entry.id,
      )}, undefined, { recursive: false });\n\n`,
    );
  if (model.draftMode && before?.published && desired.published === null)
    await add(
      'Unpublish record',
      `  await client.items.unpublish(${JSON.stringify(
        entry.id,
      )}, undefined, { recursive: false });\n\n`,
    );
  const fields = changedFields(current, desired.current);
  if (
    Object.keys(fields).length ||
    (entry.action !== 'create' && !publish && Object.keys(metadata).length)
  )
    await add(
      publish
        ? 'Restore newer draft fields'
        : 'Update record fields and metadata',
      call('items.update', entry.id, {
        ...payloadPatch(fields, desired.modelId, schema),
        ...(entry.action !== 'create' &&
        !publish &&
        Object.keys(metadata).length
          ? { meta: metadata }
          : {}),
      }),
    );
  for (const [key, resource] of [
    ['publication', 'scheduledPublication'],
    ['unpublishing', 'scheduledUnpublishing'],
  ] as const) {
    const oldSchedule = before?.schedules[key] ?? null;
    const schedule = desired.schedules[key];
    if (hashJson(oldSchedule) === hashJson(schedule)) continue;
    if (oldSchedule)
      await add(
        `Remove ${key} schedule`,
        call(`${resource}.destroy`, entry.id),
      );
    if (schedule) {
      const payload =
        key === 'publication'
          ? {
              publication_scheduled_at: schedule.at,
              selective_publication: desired.schedules.publication!.selective
                ? {
                    content_in_locales:
                      desired.schedules.publication!.selective.locales,
                    non_localized_content:
                      desired.schedules.publication!.selective.nonLocalized,
                  }
                : null,
            }
          : {
              unpublishing_scheduled_at: schedule.at,
              content_in_locales: desired.schedules.unpublishing!.locales,
            };
      await add(
        `Set ${key} schedule`,
        call(`${resource}.create`, entry.id, payload),
      );
    }
  }
}

function binaryRow(store: SnapshotStore, id: string): BinaryEntry {
  const row = store.database
    .prepare('SELECT data FROM migration_baseline_binaries WHERE upload_id=?')
    .get(id);
  if (!row) invalid(`Missing verified binary for upload ${id}.`);
  return JSON.parse(String(row.data)) as BinaryEntry;
}

async function emitScript(
  store: SnapshotStore,
  metadata: PlanMetadata,
  writer: ScriptWriter,
): Promise<void> {
  for (const entry of store.iteratePlan('collection')) {
    const plan = entry as CollectionPlan;
    if (!plan.desired || !['create', 'update'].includes(plan.action)) continue;
    const desired = plan.desired;
    await writer.add(
      comment(
        plan.action === 'create'
          ? 'Create asset folder'
          : 'Update asset folder',
        `${commentLabel(desired.label)} (${commentLabel(plan.id)})`,
        call(
          `uploadCollections.${plan.action === 'create' ? 'create' : 'update'}`,
          ...(plan.action === 'create' ? [] : [plan.id]),
          {
            ...(plan.action === 'create' ? { id: plan.id } : {}),
            label: desired.label,
            parent: desired.parentId
              ? { id: desired.parentId, type: 'upload_collection' }
              : null,
            position: desired.position,
          },
        ),
      ),
    );
  }
  for (const entry of store.iteratePlan('upload')) {
    const plan = entry as UploadPlan;
    if (!plan.desired || !['create', 'update'].includes(plan.action)) continue;
    const label = `${commentLabel(plan.desired.filename)} (${commentLabel(
      plan.id,
    )})`;
    const body: JsonObject = {
      ...plan.desired.attributes,
      upload_collection: plan.desired.collectionId
        ? { id: plan.desired.collectionId, type: 'upload_collection' }
        : null,
    };
    if (requiresBinary(plan)) {
      const asset = binaryRow(store, plan.id);
      if (plan.action === 'create') {
        const { basename: _basename, ...creationAttributes } = body;
        const encoded = migrationLiteral(
          {
            id: plan.id,
            filename: plan.desired.filename,
            ...creationAttributes,
          },
          1,
        );
        await writer.asset(
          (local) =>
            comment(
              'Create asset',
              label,
              `  await client.uploads.createFromLocalFile({\n    localPath: ${local},\n${encoded.slice(
                2,
              )});\n\n`,
            ),
          asset.binary.file,
        );
      } else {
        const encoded = migrationLiteral(body, 1);
        await writer.asset(
          (local) =>
            comment(
              'Replace asset binary and metadata',
              label,
              `  // The runtime stages this verified local binary before the CMA replacement.\n  await client.uploads.update(${JSON.stringify(
                plan.id,
              )}, {\n    path: ${local},\n${encoded.slice(
                2,
              )}, { replace_strategy: 'create_new_url' });\n\n`,
            ),
          asset.binary.file,
        );
      }
    } else
      await writer.add(
        comment(
          'Update asset metadata',
          label,
          call('uploads.update', plan.id, body),
        ),
      );
  }
  for (const entry of store.iteratePlan('record'))
    await emitRecord(writer, entry as RecordPlan, metadata.schema);
  for (const entry of store.iteratePlan('upload', 'delete')) {
    const plan = entry as UploadPlan;
    await writer.add(
      comment(
        'Delete asset',
        `${commentLabel(plan.baseline?.filename ?? '')} (${commentLabel(
          plan.id,
        )})`,
        call('uploads.destroy', entry.id),
      ),
    );
  }
  for (const entry of store.iteratePlan('collection', 'delete')) {
    const plan = entry as CollectionPlan;
    await writer.add(
      comment(
        'Delete asset folder',
        `${commentLabel(plan.baseline?.label ?? '')} (${commentLabel(
          plan.id,
        )})`,
        call('uploadCollections.destroy', entry.id),
      ),
    );
  }

  // Reconcile complete affected groups, including unchanged siblings whose
  // positions can shift as explicit create/update/delete intent is recorded.
  const db = store.database;
  db.exec(`CREATE TEMP TABLE migration_emit_positions(kind TEXT,id TEXT,model_id TEXT,parent_id TEXT,position REAL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
    CREATE INDEX migration_emit_position_order ON migration_emit_positions(kind,model_id,parent_id,position,id);`);
  try {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO migration_emit_positions VALUES(?,?,?,?,?)',
    );
    const remove = db.prepare(
      'DELETE FROM migration_emit_positions WHERE kind=? AND id=?',
    );
    for (const model of metadata.schema.models) {
      if (
        (!model.sortable && !model.tree) ||
        !db
          .prepare(
            "SELECT 1 FROM plan WHERE kind='record' AND model_id=? AND action IN ('create','update','delete') LIMIT 1",
          )
          .get(model.id)
      )
        continue;
      for (const state of store.iterateRecords('target', model.id))
        insert.run(
          'record',
          state.id,
          model.id,
          state.parentId,
          state.position,
        );
      for (const row of db
        .prepare(
          "SELECT data FROM plan WHERE kind='record' AND model_id=? AND action IN ('create','update','delete') ORDER BY id",
        )
        .iterate(model.id)) {
        const plan = JSON.parse(String(row.data)) as RecordPlan;
        if (plan.action === 'delete') remove.run('record', plan.id);
        else
          insert.run(
            'record',
            plan.id,
            model.id,
            plan.desired!.parentId,
            plan.desired!.position,
          );
      }
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM plan WHERE kind='collection' AND action IN ('create','update','delete') LIMIT 1",
        )
        .get()
    ) {
      for (const state of store.iterateCollections('target'))
        insert.run('collection', state.id, '', state.parentId, state.position);
      for (const entry of store.iteratePlan('collection')) {
        const plan = entry as CollectionPlan;
        if (plan.action === 'delete') remove.run('collection', plan.id);
        else if (['create', 'update'].includes(plan.action))
          insert.run(
            'collection',
            plan.id,
            '',
            plan.desired!.parentId,
            plan.desired!.position,
          );
      }
    }
    for (let pass = 0; pass < 2; pass++)
      for (const row of db
        .prepare(
          'SELECT * FROM migration_emit_positions ORDER BY kind,model_id,parent_id,position,id',
        )
        .iterate()) {
        if (row.kind === 'collection')
          await writer.add(
            comment(
              `Restore asset folder order (pass ${pass + 1}/2)`,
              commentLabel(String(row.id)),
              call('uploadCollections.update', row.id, {
                parent: row.parent_id
                  ? { id: row.parent_id, type: 'upload_collection' }
                  : null,
                position: row.position,
              }),
            ),
          );
        else {
          const model = metadata.schema.models.find(
            (candidate) => candidate.id === row.model_id,
          )!;
          await writer.add(
            comment(
              `Restore record order (pass ${pass + 1}/2)`,
              recordLabel(String(row.id), model.id, metadata.schema),
              call('items.update', row.id, {
                ...(model.tree ? { parent_id: row.parent_id } : {}),
                position: row.position,
              }),
            ),
          );
        }
      }
  } finally {
    db.exec('DROP TABLE migration_emit_positions');
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
    for (const state of store.iterateRecords('source'))
      for (const slice of ['current', 'published'] as const) {
        if (state[slice] !== null)
          await writer.add({
            type: 'validity',
            recordId: state.id,
            slice,
            fieldHash: hashJson(state[slice]),
            valid: state.validity[slice] === true,
          });
      }
    for (const row of store.database
      .prepare(
        'SELECT data FROM migration_baseline_binaries ORDER BY upload_id',
      )
      .iterate())
      await writer.add(JSON.parse(String(row.data)) as BinaryEntry);
    const chunks = await writer.finish();
    const { temporarySchemaChanges: _changes, ...metadataWithoutExecution } =
      metadata;
    const manifest: BaselineManifest = {
      ...metadataWithoutExecution,
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
    );
    await emitScript(store, metadata, scriptWriter);
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
  if (value.type === 'validity') {
    if (
      !text(value.recordId) ||
      !['current', 'published'].includes(String(value.slice)) ||
      !digest(value.fieldHash) ||
      typeof value.valid !== 'boolean'
    )
      invalid('Invalid source validity evidence.');
    return;
  }
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
  for (const table of [
    'migration_baseline',
    'migration_baseline_validity',
    'migration_baseline_binaries',
  ])
    if (store.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
      invalid('Baseline loading requires empty baseline tables.');
  const insert = store.database.prepare(
    'INSERT INTO migration_baseline VALUES(?,?,?,?,?,?,?,?)',
  );
  const evidence = store.database.prepare(
    'INSERT INTO migration_baseline_validity VALUES(?,?,?,?)',
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
      const chunk = candidate as unknown as BundleChunk;
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
        } else if (row.type === 'validity')
          evidence.run(
            row.recordId,
            row.slice,
            row.fieldHash,
            Number(row.valid),
          );
        else {
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
    store.database.exec(
      'ROLLBACK TO migration_baseline_load; RELEASE migration_baseline_load',
    );
    throw error;
  }
  return manifest;
}

export function* baselineValidity(
  store: SnapshotStore,
): Generator<IntentValidityEvidence> {
  for (const row of store.database
    .prepare('SELECT * FROM migration_baseline_validity ORDER BY id,slice,hash')
    .iterate())
    yield {
      recordId: String(row.id),
      slice: row.slice as 'current' | 'published',
      fieldHash: String(row.hash),
      valid: Boolean(row.valid),
    };
}
export function* baselineBinaries(
  store: SnapshotStore,
  directory: string,
): Generator<IntentBinary> {
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
): IntentBinary | undefined {
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
