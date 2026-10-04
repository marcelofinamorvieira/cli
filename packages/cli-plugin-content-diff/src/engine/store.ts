import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  Action,
  BlockOwner,
  CollectionState,
  Kind,
  PlanEntry,
  RecordState,
  Reference,
  Side,
  UniqueValue,
  UploadState,
} from './types';

export interface PlanEdge {
  fromKind: Kind;
  fromId: string;
  toKind: Kind;
  toId: string;
  reason: string;
  phase?: string;
  ordering?: number;
}

/** Native iterators on Node 22.13 do not keep their statement alive through GC. */
class WorkingDatabase extends DatabaseSync {
  override prepare(sql: string): StatementSync {
    const statement = super.prepare(sql);
    const nativeIterate = statement.iterate;
    Object.defineProperty(statement, 'iterate', {
      value: (...parameters: Parameters<StatementSync['iterate']>) => {
        const cursor = Reflect.apply(
          nativeIterate,
          statement,
          parameters,
        ) as ReturnType<StatementSync['iterate']>;
        // The iterator itself owns the statement, rather than retaining every
        // prepared query in a database-wide set. Concurrent prepare calls also
        // retain independent native cursors and parameter bindings.
        const iterator = Object.create(
          Object.getPrototypeOf(cursor),
        ) as ReturnType<StatementSync['iterate']>;
        Object.defineProperties(iterator, {
          owner: { value: statement },
          next: { value: cursor.next.bind(cursor) },
          [Symbol.iterator]: {
            value() {
              return this;
            },
          },
          ...(cursor.return
            ? { return: { value: cursor.return.bind(cursor) } }
            : {}),
          ...(cursor.throw
            ? { throw: { value: cursor.throw.bind(cursor) } }
            : {}),
        });
        return iterator;
      },
    });
    return statement;
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
    const parent = directory ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    this.directory = mkdtempSync(join(parent, 'content-diff-'));
    this.filename = join(this.directory, 'working.sqlite');
    let database: DatabaseSync | undefined;
    try {
      database = new WorkingDatabase(this.filename);
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
          required INTEGER NOT NULL,
          PRIMARY KEY(side, owner_id, target_id, kind, path, field_id)
        ) WITHOUT ROWID;
        CREATE INDEX refs_target ON refs(side, target_id, kind, owner_id);
        CREATE TABLE block_owners (
          side TEXT NOT NULL, block_id TEXT NOT NULL, record_id TEXT NOT NULL,
          model_id TEXT NOT NULL, path TEXT NOT NULL, slice TEXT NOT NULL,
          PRIMARY KEY(side, block_id, record_id, path, slice)
        ) WITHOUT ROWID;
        CREATE INDEX block_owners_record ON block_owners(side, record_id, slice, block_id);
        CREATE TABLE unique_values (
          side TEXT NOT NULL, model_id TEXT NOT NULL, field_id TEXT NOT NULL,
          locale TEXT NOT NULL, slice TEXT NOT NULL, value TEXT NOT NULL, record_id TEXT NOT NULL,
          PRIMARY KEY(side, model_id, field_id, locale, slice, value, record_id)
        ) WITHOUT ROWID;
        CREATE INDEX unique_values_record ON unique_values(side, record_id, field_id, slice);
        CREATE TABLE plan (
          kind TEXT NOT NULL, id TEXT NOT NULL, model_id TEXT NOT NULL,
          action TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, id)
        ) WITHOUT ROWID;
        CREATE INDEX plan_order ON plan(kind, model_id, id);
        CREATE INDEX plan_action ON plan(action, kind, model_id, id);
        CREATE TABLE edges (
          phase TEXT NOT NULL DEFAULT 'content', from_kind TEXT NOT NULL,
          from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL,
          reason TEXT NOT NULL, ordering INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(phase, from_kind, from_id, to_kind, to_id, reason)
        ) WITHOUT ROWID;
        CREATE INDEX edges_target ON edges(phase, to_kind, to_id, from_kind, from_id);
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

  private statement(sql: string): StatementSync {
    let result = this.statements.get(sql);
    if (!result) {
      result = this.database.prepare(sql);
      this.statements.set(sql, result);
    }
    return result;
  }

  private read<T>(sql: string, ...parameters: string[]): T | undefined {
    const row = this.statement(sql).get(...parameters);
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
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  putRecord(side: Side, state: RecordState): void {
    // A replacement capture must not retain references or uniqueness claims
    // from the previous state. Capture repopulates these indexes afterwards.
    this.statement('DELETE FROM refs WHERE side = ? AND owner_id = ?').run(
      side,
      state.id,
    );
    // Without statistics SQLite can choose the side-only primary-key prefix,
    // rescanning every accumulated block for every record in a large capture.
    this.statement(
      'DELETE FROM block_owners INDEXED BY block_owners_record WHERE side = ? AND record_id = ?',
    ).run(side, state.id);
    this.statement(
      'DELETE FROM unique_values WHERE side = ? AND record_id = ?',
    ).run(side, state.id);
    this.statement(
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

  records(side: Side, modelId?: string): Generator<RecordState> {
    return modelId === undefined
      ? this.iterate(
          'SELECT state_json FROM records WHERE side = ? ORDER BY model_id, id',
          side,
        )
      : this.iterate(
          'SELECT state_json FROM records WHERE side = ? AND model_id = ? ORDER BY id',
          side,
          modelId,
        );
  }

  iterateRecords(side: Side, modelId?: string): Generator<RecordState> {
    return this.records(side, modelId);
  }

  putUpload(side: Side, state: UploadState): void {
    this.statement('INSERT OR REPLACE INTO uploads VALUES (?, ?, ?, ?, ?)').run(
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
  iterateUploads(side: Side): Generator<UploadState> {
    return this.uploads(side);
  }

  putCollection(side: Side, state: CollectionState): void {
    this.statement(
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
  iterateCollections(side: Side): Generator<CollectionState> {
    return this.collections(side);
  }

  putReference(side: Side, reference: Reference): void {
    this.statement(
      'INSERT OR REPLACE INTO refs VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      side,
      reference.ownerId,
      reference.targetId,
      reference.kind,
      reference.path,
      reference.fieldId,
      Number(reference.required),
    );
  }

  *references(side: Side, ownerId?: string): Generator<Reference> {
    const sql =
      ownerId === undefined
        ? 'SELECT * FROM refs WHERE side = ? ORDER BY owner_id, target_id, kind, path, field_id'
        : 'SELECT * FROM refs WHERE side = ? AND owner_id = ? ORDER BY target_id, kind, path, field_id';
    for (const row of this.database
      .prepare(sql)
      .iterate(...(ownerId === undefined ? [side] : [side, ownerId]))) {
      yield {
        ownerId: row.owner_id as string,
        targetId: row.target_id as string,
        kind: row.kind as Reference['kind'],
        path: row.path as string,
        fieldId: row.field_id as string,
        required: Boolean(row.required),
      };
    }
  }

  putBlockOwner(side: Side, owner: BlockOwner): void {
    this.statement(
      'INSERT OR REPLACE INTO block_owners VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      side,
      owner.blockId,
      owner.recordId,
      owner.modelId,
      owner.path,
      owner.slice,
    );
  }

  *blockOwners(side: Side, recordId?: string): Generator<BlockOwner> {
    const sql =
      recordId === undefined
        ? 'SELECT * FROM block_owners WHERE side = ? ORDER BY block_id, record_id, slice, path'
        : 'SELECT * FROM block_owners INDEXED BY block_owners_record WHERE side = ? AND record_id = ? ORDER BY block_id, slice, path';
    for (const row of this.database
      .prepare(sql)
      .iterate(...(recordId === undefined ? [side] : [side, recordId]))) {
      yield {
        blockId: row.block_id as string,
        recordId: row.record_id as string,
        modelId: row.model_id as string,
        path: row.path as string,
        slice: row.slice as BlockOwner['slice'],
      };
    }
  }

  putUniqueValue(side: Side, value: UniqueValue): void {
    this.statement(
      'INSERT OR IGNORE INTO unique_values VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      side,
      value.modelId,
      value.fieldId,
      value.locale,
      value.slice,
      value.valueKey,
      value.recordId,
    );
  }

  *uniqueValues(side: Side, recordId?: string): Generator<UniqueValue> {
    // The primary key matches output order but not record_id. Restrict to the
    // requested record first, then sort only that record's uniqueness claims.
    const sql = `SELECT * FROM unique_values${
      recordId === undefined ? '' : ' INDEXED BY unique_values_record'
    } WHERE side = ?${
      recordId === undefined ? '' : ' AND record_id = ?'
    } ORDER BY model_id, field_id, locale, slice, value, record_id`;
    for (const row of this.database
      .prepare(sql)
      .iterate(...(recordId === undefined ? [side] : [side, recordId]))) {
      yield {
        modelId: row.model_id as string,
        fieldId: row.field_id as string,
        locale: row.locale as string,
        slice: row.slice as UniqueValue['slice'],
        valueKey: row.value as string,
        recordId: row.record_id as string,
      };
    }
  }

  putPlan(entry: PlanEntry): void {
    this.statement('INSERT OR REPLACE INTO plan VALUES (?, ?, ?, ?, ?)').run(
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

  iteratePlan(kind?: Kind, action?: Action): Generator<PlanEntry> {
    return this.planEntries(kind, action);
  }

  putEdge(edge: PlanEdge): void {
    this.statement(
      'INSERT OR REPLACE INTO edges VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      edge.phase ?? 'content',
      edge.fromKind,
      edge.fromId,
      edge.toKind,
      edge.toId,
      edge.reason,
      edge.ordering ?? 0,
    );
  }

  *edges(phase?: string): Generator<PlanEdge> {
    const sql = `SELECT * FROM edges${
      phase === undefined ? '' : ' WHERE phase = ?'
    } ORDER BY phase, ordering, from_kind, from_id, to_kind, to_id, reason`;
    for (const row of this.database
      .prepare(sql)
      .iterate(...(phase === undefined ? [] : [phase]))) {
      yield {
        phase: row.phase as string,
        fromKind: row.from_kind as Kind,
        fromId: row.from_id as string,
        toKind: row.to_kind as Kind,
        toId: row.to_id as string,
        reason: row.reason as string,
        ordering: row.ordering as number,
      };
    }
  }

  clearSide(side: Side): void {
    this.transaction(() => {
      for (const table of [
        'records',
        'uploads',
        'collections',
        'refs',
        'block_owners',
        'unique_values',
      ]) {
        this.statement(`DELETE FROM ${table} WHERE side = ?`).run(side);
      }
    });
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
