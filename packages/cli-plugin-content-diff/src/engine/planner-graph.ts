import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Kind } from './types';

/** Disk-backed Kahn ordering. No recursion, graph-sized queue, or global scan per vertex. */
export class PlannerGraph {
  private readonly insertNode: StatementSync;
  private readonly insertEdge: StatementSync;

  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TEMP TABLE IF NOT EXISTS planner_graph (
        phase TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
        dependency_kind TEXT NOT NULL, dependency_id TEXT NOT NULL,
        field_id TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY(phase, owner_kind, owner_id, dependency_kind, dependency_id, field_id, reason)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_graph_reverse ON planner_graph
        (phase, dependency_kind, dependency_id, owner_kind, owner_id);
      CREATE TEMP TABLE IF NOT EXISTS planner_nodes (
        phase TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        degree INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
        rank INTEGER, PRIMARY KEY(phase,kind,id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_nodes_ready ON planner_nodes(phase,done,degree,kind,id);
    `);
    // The same bounded pair of statements serves every vertex/edge. Preparing
    // one per insertion can retain substantial native SQLite memory until GC.
    this.insertNode = database.prepare(
      'INSERT OR IGNORE INTO planner_nodes(phase,kind,id) VALUES(?,?,?)',
    );
    this.insertEdge = database.prepare(`INSERT OR IGNORE INTO planner_graph
      (phase,owner_kind,owner_id,dependency_kind,dependency_id,field_id,reason) VALUES(?,?,?,?,?,?,?)`);
  }

  clear(phase: string): void {
    this.database.prepare('DELETE FROM planner_graph WHERE phase=?').run(phase);
    this.database.prepare('DELETE FROM planner_nodes WHERE phase=?').run(phase);
  }

  node(phase: string, kind: Kind, id: string): void {
    this.insertNode.run(phase, kind, id);
  }

  edge(
    phase: string,
    ownerKind: Kind,
    ownerId: string,
    dependencyKind: Kind,
    dependencyId: string,
    reason: string,
    fieldId = '',
  ): void {
    this.insertEdge.run(
      phase,
      ownerKind,
      ownerId,
      dependencyKind,
      dependencyId,
      fieldId,
      reason,
    );
  }

  order(phase: string): number {
    this.database
      .prepare(`UPDATE planner_nodes SET done=0,rank=0,degree=(
      SELECT COUNT(*) FROM planner_graph g JOIN planner_nodes d
        ON d.phase=g.phase AND d.kind=g.dependency_kind AND d.id=g.dependency_id
      WHERE g.phase=planner_nodes.phase AND g.owner_kind=planner_nodes.kind AND g.owner_id=planner_nodes.id
    ) WHERE phase=?`)
      .run(phase);
    // Without an explicit index, SQLite may prefer the primary key's kind/id
    // order and scan a whole phase for each ready vertex on long chains.
    const ready = this.database.prepare(`SELECT kind,id,rank FROM planner_nodes INDEXED BY planner_nodes_ready
      WHERE phase=? AND done=0 AND degree=0 ORDER BY kind,id LIMIT 1`);
    const dependants = this.database.prepare(`SELECT g.owner_kind AS kind,g.owner_id AS id,COUNT(*) AS edges
      FROM planner_graph g JOIN planner_nodes n ON n.phase=g.phase AND n.kind=g.owner_kind AND n.id=g.owner_id
      WHERE g.phase=? AND g.dependency_kind=? AND g.dependency_id=? AND n.done=0
      GROUP BY g.owner_kind,g.owner_id`);
    const complete = this.database.prepare(
      'UPDATE planner_nodes SET done=1,rank=? WHERE phase=? AND kind=? AND id=?',
    );
    const decrement = this.database.prepare(
      'UPDATE planner_nodes SET degree=degree-?,rank=MAX(rank,?) WHERE phase=? AND kind=? AND id=? AND done=0',
    );
    let rank = 0;
    for (;;) {
      const next = ready.get(phase);
      if (!next) break;
      // Execution ranks are levels, permitting parallel work only after every
      // predecessor's level has completed. Discovery retains an ordinal for
      // deterministic seed projection. The indexed queue need not collect or
      // sort a whole ready wave to propagate maximum predecessor levels.
      const level = phase === 'creation-discovery' ? rank++ : Number(next.rank);
      complete.run(level, phase, next.kind, next.id);
      for (const dependant of dependants.iterate(phase, next.kind, next.id)) {
        decrement.run(
          dependant.edges,
          level + 1,
          phase,
          dependant.kind,
          dependant.id,
        );
      }
    }
    return Number(
      this.database
        .prepare(
          'SELECT COUNT(*) AS count FROM planner_nodes WHERE phase=? AND done=0',
        )
        .get(phase)?.count ?? 0,
    );
  }

  *ranks(phase: string): Generator<{ kind: Kind; id: string; rank: number }> {
    for (const row of this.database
      .prepare(
        'SELECT kind,id,rank FROM planner_nodes WHERE phase=? AND done=1 ORDER BY rank,kind,id',
      )
      .iterate(phase)) {
      yield {
        kind: row.kind as Kind,
        id: String(row.id),
        rank: Number(row.rank),
      };
    }
  }

  *cycles(phase: string): Generator<{ kind: Kind; id: string }> {
    for (const row of this.database
      .prepare(
        'SELECT kind,id FROM planner_nodes WHERE phase=? AND done=0 ORDER BY kind,id',
      )
      .iterate(phase)) {
      yield { kind: row.kind as Kind, id: String(row.id) };
    }
  }
}
