import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { compareIds } from './compare-ids';
import type { Kind } from './types';

/**
 * Iterative Tarjan search from `roots`, visiting dependencies in the order
 * given. Each strongly connected component is yielded as soon as it
 * completes, so the components a component depends on come first, and a
 * caller that needs only the first one stops the search there.
 */
export function* stronglyConnected(
  roots: Iterable<string>,
  dependencies: (node: string) => Iterable<string>,
): Generator<string[]> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  for (const root of roots) {
    if (index.has(root)) continue;
    const frames: Array<{ node: string; pending: string[] }> = [];
    const visit = (node: string) => {
      index.set(node, index.size);
      low.set(node, index.get(node)!);
      stack.push(node);
      onStack.add(node);
      frames.push({ node, pending: [...dependencies(node)].reverse() });
    };
    visit(root);
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const dependency = frame.pending.pop();
      if (dependency !== undefined) {
        if (!index.has(dependency)) visit(dependency);
        else if (onStack.has(dependency))
          low.set(
            frame.node,
            Math.min(low.get(frame.node)!, index.get(dependency)!),
          );
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent)
        low.set(
          parent.node,
          Math.min(low.get(parent.node)!, low.get(frame.node)!),
        );
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      yield component;
    }
  }
}

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

  /**
   * Ranks a phase into dependency levels and returns how many vertices a cycle
   * left unranked. With `force`, whenever cycles block progress one member of
   * a cycle is ranked before its pending dependencies (see `forced`), so every
   * vertex receives a deterministic level and vertices that only wait on a
   * cycle still follow all of its members.
   */
  order(phase: string, force = false): number {
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
    const blocked = this.database.prepare(
      'SELECT kind,id FROM planner_nodes WHERE phase=? AND done=0 ORDER BY degree,kind,id LIMIT 1',
    );
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
    for (;;) {
      let next = ready.get(phase);
      if (!next && force) {
        const start = blocked.get(phase);
        if (start)
          next = this.forced(phase, String(start.kind), String(start.id));
      }
      if (!next) break;
      // Ranks are levels: a vertex runs only after every predecessor's level.
      // The indexed queue need not collect or sort a whole ready wave to
      // propagate maximum predecessor levels.
      const level = Number(next.rank);
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

  /**
   * The vertex to rank when every unfinished vertex waits on another one: the
   * member with the fewest pending dependencies of a cycle whose members wait
   * on nothing outside it. Tarjan's search follows unfinished dependencies
   * from `kind`/`id`, and the first strongly connected component it completes
   * is such a cycle, so no vertex is ranked before a dependency outside its
   * own cycle. The search only holds the vertices it reaches.
   */
  private forced(phase: string, kind: string, id: string) {
    const dependencies = this.database.prepare(`SELECT DISTINCT g.dependency_kind AS kind,g.dependency_id AS id
      FROM planner_graph g JOIN planner_nodes d ON d.phase=g.phase AND d.kind=g.dependency_kind AND d.id=g.dependency_id
      WHERE g.phase=? AND g.owner_kind=? AND g.owner_id=? AND d.done=0 ORDER BY 1,2`);
    const vertex = this.database.prepare(
      'SELECT kind,id,rank,degree FROM planner_nodes WHERE phase=? AND kind=? AND id=?',
    );
    const [first] = stronglyConnected([`${kind}\0${id}`], (key) =>
      dependencies
        .all(phase, ...key.split('\0'))
        .map((row) => `${row.kind}\0${row.id}`),
    );
    const members = first!.map((key) => vertex.get(phase, ...key.split('\0'))!);
    members.sort(
      (left, right) =>
        Number(left.degree) - Number(right.degree) ||
        compareIds(String(left.kind), String(right.kind)) ||
        compareIds(String(left.id), String(right.id)),
    );
    return members[0]!;
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
}
