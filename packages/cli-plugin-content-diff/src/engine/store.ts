import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { ContentError } from './errors';
import type {
  Action,
  CollectionState,
  Kind,
  PlanEntry,
  RecordState,
  Reference,
  Side,
  UploadState,
} from './types';

type Sqlite = typeof import('node:sqlite');

function supportedNode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  if (major === 22) return minor > 23 || (minor === 23 && patch >= 1);
  if (major === 24) return minor >= 18;
  return major > 24;
}

/**
 * The host CLI also runs on Node versions without node:sqlite, or whose
 * node:sqlite is older than the supported floor. Checking on first use lets
 * command modules load and report the runtime requirement.
 */
export function loadSqlite(
  load: (id: string) => unknown = require,
  version: string = process.versions.node,
): Sqlite {
  const unsupported = () =>
    new ContentError(
      'UNSUPPORTED_NODE_VERSION',
      `content:diff and content:apply require Node.js 22.23.1+ on the 22.x line, or Node.js 24.18+, for the built-in node:sqlite module. Current Node.js: v${version}.`,
    );
  if (!supportedNode(version)) throw unsupported();
  try {
    return load('node:sqlite') as Sqlite;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_UNKNOWN_BUILTIN_MODULE')
      throw error;
    throw unsupported();
  }
}

/** A one-run working database. Its directory is never a supported run input. */
export class SnapshotStore {
  readonly database: DatabaseSync;
  readonly directory: string;
  readonly filename: string;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(directory?: string) {
    const sqlite = loadSqlite();
    const parent = directory ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    this.directory = mkdtempSync(join(parent, 'content-diff-'));
    this.filename = join(this.directory, 'working.sqlite');
    let database: DatabaseSync | undefined;
    try {
      database = new sqlite.DatabaseSync(this.filename);
      this.database = database;
      // Bound SQLite's own page cache and put sorting/spill state on disk.
      this.database.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = FILE;
        PRAGMA cache_size = -8192;
        CREATE TABLE records (
          side TEXT NOT NULL, id TEXT NOT NULL, model_id TEXT NOT NULL,
          parent_id TEXT, position REAL, hash TEXT NOT NULL, state_json TEXT NOT NULL,
          PRIMARY KEY(side, id)
        ) WITHOUT ROWID;
        CREATE INDEX records_model ON records(side, model_id, id);
        CREATE INDEX records_siblings ON records(side, model_id, parent_id, position, id);
        CREATE TABLE uploads (
          side TEXT NOT NULL, id TEXT NOT NULL, collection_id TEXT,
          hash TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(side, id)
        ) WITHOUT ROWID;
        CREATE INDEX uploads_collection ON uploads(side, collection_id, id);
        CREATE TABLE collections (
          side TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT,
          position INTEGER NOT NULL, hash TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(side, id)
        ) WITHOUT ROWID;
        CREATE INDEX collections_parent ON collections(side, parent_id, id);
        CREATE INDEX collections_siblings ON collections(side, parent_id, position, id);
        CREATE TABLE refs (
          side TEXT NOT NULL, owner_id TEXT NOT NULL, target_id TEXT NOT NULL,
          kind TEXT NOT NULL, path TEXT NOT NULL, field_id TEXT NOT NULL,
          PRIMARY KEY(side, owner_id, target_id, kind, path, field_id)
        ) WITHOUT ROWID;
        CREATE INDEX refs_target ON refs(side, target_id, kind, owner_id);
        CREATE TABLE plan (
          kind TEXT NOT NULL, id TEXT NOT NULL, model_id TEXT NOT NULL,
          action TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, id)
        ) WITHOUT ROWID;
        CREATE INDEX plan_order ON plan(kind, model_id, id);
        CREATE INDEX plan_action ON plan(action, kind, model_id, id);
      `);
    } catch (error) {
      try {
        database?.close();
      } catch {
        /* Preserve the original constructor error. */
      }
      rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * A statement prepared once per store for SQL that runs per entry or per
   * row: preparing one per call can retain substantial native SQLite memory
   * until GC. Streaming cursors need their own statement instead.
   */
  prepared(sql: string): StatementSync {
    let result = this.statements.get(sql);
    if (!result) {
      result = this.database.prepare(sql);
      this.statements.set(sql, result);
    }
    return result;
  }

  private read<T>(sql: string, ...parameters: string[]): T | undefined {
    const row = this.prepared(sql).get(...parameters);
    return row
      ? (JSON.parse((row.state_json ?? row.data) as string) as T)
      : undefined;
  }

  private *iterate<T>(sql: string, ...parameters: string[]): Generator<T> {
    // Streaming cursors receive their own statement; cached CRUD statements
    // must not have their bindings reset by a second active iterator.
    for (const row of this.database.prepare(sql).iterate(...parameters)) {
      yield JSON.parse((row.state_json ?? row.data) as string) as T;
    }
  }

  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        /* SQLite may already have rolled back, e.g. after SQLITE_FULL. */
      }
      throw error;
    }
  }

  putRecord(side: Side, state: RecordState): void {
    this.prepared(
      'INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      side,
      state.id,
      state.modelId,
      state.parentId,
      state.position,
      state.hash,
      JSON.stringify(state),
    );
  }

  getRecord(side: Side, id: string): RecordState | undefined {
    return this.read(
      'SELECT state_json FROM records WHERE side = ? AND id = ?',
      side,
      id,
    );
  }

  records(side: Side): Generator<RecordState> {
    return this.iterate(
      'SELECT state_json FROM records WHERE side = ? ORDER BY model_id, id',
      side,
    );
  }

  putUpload(side: Side, state: UploadState): void {
    this.prepared('INSERT OR REPLACE INTO uploads VALUES (?, ?, ?, ?, ?)').run(
      side,
      state.id,
      state.collectionId,
      state.hash,
      JSON.stringify(state),
    );
  }

  getUpload(side: Side, id: string): UploadState | undefined {
    return this.read(
      'SELECT state_json FROM uploads WHERE side = ? AND id = ?',
      side,
      id,
    );
  }

  uploads(side: Side): Generator<UploadState> {
    return this.iterate(
      'SELECT state_json FROM uploads WHERE side = ? ORDER BY id',
      side,
    );
  }

  putCollection(side: Side, state: CollectionState): void {
    this.prepared(
      'INSERT OR REPLACE INTO collections VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      side,
      state.id,
      state.parentId,
      state.position,
      state.hash,
      JSON.stringify(state),
    );
  }

  getCollection(side: Side, id: string): CollectionState | undefined {
    return this.read(
      'SELECT state_json FROM collections WHERE side = ? AND id = ?',
      side,
      id,
    );
  }

  collections(side: Side): Generator<CollectionState> {
    return this.iterate(
      'SELECT state_json FROM collections WHERE side = ? ORDER BY id',
      side,
    );
  }

  putReference(side: Side, reference: Reference): void {
    this.prepared('INSERT OR REPLACE INTO refs VALUES (?, ?, ?, ?, ?, ?)').run(
      side,
      reference.ownerId,
      reference.targetId,
      reference.kind,
      reference.path,
      reference.fieldId,
    );
  }

  putPlan(entry: PlanEntry): void {
    this.prepared('INSERT OR REPLACE INTO plan VALUES (?, ?, ?, ?, ?)').run(
      entry.kind,
      entry.id,
      entry.kind === 'record' ? entry.modelId : '',
      entry.action,
      JSON.stringify(entry),
    );
  }

  getPlan(kind: Kind, id: string): PlanEntry | undefined {
    return this.read(
      'SELECT data FROM plan WHERE kind = ? AND id = ?',
      kind,
      id,
    );
  }

  planEntries(kind?: Kind, action?: Action): Generator<PlanEntry> {
    const filters: string[] = [];
    const values: string[] = [];
    if (kind) {
      filters.push('kind = ?');
      values.push(kind);
    }
    if (action) {
      filters.push('action = ?');
      values.push(action);
    }
    return this.iterate(
      `SELECT data FROM plan${
        filters.length ? ` WHERE ${filters.join(' AND ')}` : ''
      } ORDER BY kind, model_id, id`,
      ...values,
    );
  }

  /** Captures fill these tables; the planner indexes references afterwards. */
  clearSide(side: Side): void {
    this.transaction(() => {
      for (const table of ['records', 'uploads', 'collections']) {
        this.prepared(`DELETE FROM ${table} WHERE side = ?`).run(side);
      }
    });
  }

  /**
   * Copies one captured side from another store, so captures of different
   * projects can run in parallel without sharing tables while they write.
   * The other store is closed first and is left for its owner to dispose.
   */
  importSide(other: SnapshotStore, side: Side): void {
    other.close();
    this.database.prepare('ATTACH DATABASE ? AS imported').run(other.filename);
    try {
      this.transaction(() => {
        for (const table of ['records', 'uploads', 'collections'])
          this.database
            .prepare(
              `INSERT INTO main.${table} SELECT * FROM imported.${table} WHERE side=?`,
            )
            .run(side);
      });
    } finally {
      this.database.exec('DETACH DATABASE imported');
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.statements.clear();
    this.closed = true;
  }

  dispose(): void {
    try {
      this.close();
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
