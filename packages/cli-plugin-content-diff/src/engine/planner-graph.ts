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

/** A binary min-heap. */
export class Heap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const { items } = this;
    let index = items.push(item) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[parent]!, items[index]!) <= 0) break;
      [items[parent], items[index]] = [items[index]!, items[parent]!];
      index = parent;
    }
  }

  pop(): T | undefined {
    const { items } = this;
    const first = items[0];
    const last = items.pop();
    if (!items.length || last === undefined) return first;
    items[0] = last;
    for (let index = 0; ; ) {
      const left = index * 2 + 1;
      let smallest = index;
      for (const child of [left, left + 1])
        if (
          child < items.length &&
          this.compare(items[child]!, items[smallest]!) < 0
        )
          smallest = child;
      if (smallest === index) break;
      [items[smallest], items[index]] = [items[index]!, items[smallest]!];
      index = smallest;
    }
    return first;
  }
}

interface Vertex {
  kind: Kind;
  id: string;
  /** Edges to dependencies not ranked yet. */
  degree: number;
  done: boolean;
  rank: number;
}

/** An edge is identified by its field and reason, as several can join a pair. */
type Labels = Set<string>;
const label = (reason: string, fieldId: string) => `${reason}\0${fieldId}`;
const key = (kind: string, id: string) => `${kind}\0${id}`;
const byKindAndId = (left: Vertex, right: Vertex) =>
  compareIds(left.kind, right.kind) || compareIds(left.id, right.id);

interface Phase {
  vertices: Map<string, Vertex>;
  /** Owner key, then dependency key, then the labels of their edges. */
  edges: Map<string, Map<string, Labels>>;
}

/** Kahn ordering of each planning phase, in memory. */
export class PlannerGraph {
  private readonly phases = new Map<string, Phase>();

  private phase(name: string): Phase {
    let phase = this.phases.get(name);
    if (!phase) {
      phase = { vertices: new Map(), edges: new Map() };
      this.phases.set(name, phase);
    }
    return phase;
  }

  clear(phase: string): void {
    this.phases.delete(phase);
  }

  node(phase: string, kind: Kind, id: string): void {
    const vertices = this.phase(phase).vertices;
    if (!vertices.has(key(kind, id)))
      vertices.set(key(kind, id), {
        kind,
        id,
        degree: 0,
        done: false,
        rank: 0,
      });
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
    const edges = this.phase(phase).edges;
    const owner = key(ownerKind, ownerId);
    let dependencies = edges.get(owner);
    if (!dependencies) {
      dependencies = new Map();
      edges.set(owner, dependencies);
    }
    const dependency = key(dependencyKind, dependencyId);
    let labels = dependencies.get(dependency);
    if (!labels) {
      labels = new Set();
      dependencies.set(dependency, labels);
    }
    labels.add(label(reason, fieldId));
  }

  /** Removes the edges between two records that `matches` selects. */
  removeEdges(
    phase: string,
    ownerId: string,
    dependencyId: string,
    matches: (reason: string, fieldId: string) => boolean,
  ): void {
    const labels = this.phases
      .get(phase)
      ?.edges.get(key('record', ownerId))
      ?.get(key('record', dependencyId));
    if (!labels) return;
    for (const entry of [...labels]) {
      const [reason, fieldId] = entry.split('\0') as [string, string];
      if (matches(reason, fieldId)) labels.delete(entry);
    }
  }

  /** Whether a vertex was ranked by the last `order`; undefined if absent. */
  done(phase: string, kind: Kind, id: string): boolean | undefined {
    return this.phases.get(phase)?.vertices.get(key(kind, id))?.done;
  }

  /**
   * Ranks a phase into dependency levels and returns how many vertices a cycle
   * left unranked. With `force`, whenever cycles block progress one member of
   * a cycle is ranked before its pending dependencies (see `forced`), so every
   * vertex receives a deterministic level and vertices that only wait on a
   * cycle still follow all of its members.
   */
  order(name: string, force = false): number {
    const { vertices, edges } = this.phase(name);
    // Dependants of each vertex, with how many edges join them.
    const dependants = new Map<string, Map<string, number>>();
    for (const vertex of vertices.values()) {
      vertex.done = false;
      vertex.rank = 0;
      vertex.degree = 0;
    }
    for (const [owner, dependencies] of edges) {
      const vertex = vertices.get(owner);
      if (!vertex) continue;
      for (const [dependency, labels] of dependencies) {
        if (!labels.size || !vertices.has(dependency)) continue;
        vertex.degree += labels.size;
        let waiting = dependants.get(dependency);
        if (!waiting) {
          waiting = new Map();
          dependants.set(dependency, waiting);
        }
        waiting.set(owner, labels.size);
      }
    }
    const ready = [...vertices.values()].filter((vertex) => !vertex.degree);
    // Unfinished vertices by pending dependencies, for `forced`. An entry is
    // stale once its vertex is done or its degree has changed since.
    const blocked = new Heap<[number, Vertex]>(
      ([leftDegree, left], [rightDegree, right]) =>
        leftDegree - rightDegree || byKindAndId(left, right),
    );
    if (force)
      for (const vertex of vertices.values())
        if (vertex.degree) blocked.push([vertex.degree, vertex]);
    let remaining = vertices.size;
    for (;;) {
      let next = ready.pop();
      if (!next && force && remaining) {
        for (
          let [degree, start] = blocked.peek()!;
          start.done || degree !== start.degree;
          [degree, start] = blocked.peek()!
        )
          blocked.pop();
        next = this.forced(name, blocked.peek()![1]);
      }
      if (!next) break;
      // Ranks are levels: a vertex runs only after every predecessor's level,
      // so the order in which ready vertices are taken does not matter.
      next.done = true;
      remaining--;
      for (const [owner, count] of dependants.get(key(next.kind, next.id)) ??
        []) {
        const vertex = vertices.get(owner)!;
        if (vertex.done) continue;
        vertex.degree -= count;
        vertex.rank = Math.max(vertex.rank, next.rank + 1);
        if (!vertex.degree) ready.push(vertex);
        else if (force) blocked.push([vertex.degree, vertex]);
      }
    }
    return remaining;
  }

  private pending(phase: Phase, vertex: string): string[] {
    return [...(phase.edges.get(vertex) ?? [])]
      .filter(
        ([dependency, labels]) =>
          labels.size && phase.vertices.get(dependency)?.done === false,
      )
      .map(([dependency]) => dependency)
      .sort(compareIds);
  }

  /**
   * The vertex to rank when every unfinished vertex waits on another one: the
   * member with the fewest pending dependencies of a cycle whose members wait
   * on nothing outside it. Tarjan's search follows unfinished dependencies
   * from `start`, the unfinished vertex with the fewest pending dependencies,
   * and the first strongly connected component it completes is such a cycle,
   * so no vertex is ranked before a dependency outside its own cycle.
   */
  private forced(name: string, start: Vertex): Vertex {
    const phase = this.phase(name);
    const [first] = stronglyConnected([key(start.kind, start.id)], (vertex) =>
      this.pending(phase, vertex),
    );
    return first!
      .map((member) => phase.vertices.get(member)!)
      .sort(
        (left, right) => left.degree - right.degree || byKindAndId(left, right),
      )[0]!;
  }

  /** Ranked vertices by rank, kind and ID. */
  ranks(phase: string): Array<{ kind: Kind; id: string; rank: number }> {
    return [...(this.phases.get(phase)?.vertices.values() ?? [])]
      .filter((vertex) => vertex.done)
      .sort((left, right) => left.rank - right.rank || byKindAndId(left, right))
      .map(({ kind, id, rank }) => ({ kind, id, rank }));
  }

  /** Edges between vertices the last `order` left unranked, by owner and dependency. */
  *unresolvedEdges(
    phase: string,
  ): Generator<{ ownerId: string; dependencyId: string; reason: string }> {
    const { vertices, edges } = this.phase(phase);
    const rows: Array<{
      ownerId: string;
      dependencyId: string;
      reason: string;
    }> = [];
    for (const [owner, dependencies] of edges) {
      const ownerVertex = vertices.get(owner);
      if (!ownerVertex || ownerVertex.done || ownerVertex.kind !== 'record')
        continue;
      for (const [dependency, labels] of dependencies) {
        const dependencyVertex = vertices.get(dependency);
        if (
          !dependencyVertex ||
          dependencyVertex.done ||
          dependencyVertex.kind !== 'record' ||
          dependency === owner
        )
          continue;
        for (const entry of labels)
          rows.push({
            ownerId: ownerVertex.id,
            dependencyId: dependencyVertex.id,
            reason: entry.split('\0')[0]!,
          });
      }
    }
    rows.sort(
      (left, right) =>
        compareIds(left.ownerId, right.ownerId) ||
        compareIds(left.dependencyId, right.dependencyId),
    );
    yield* rows;
  }
}
