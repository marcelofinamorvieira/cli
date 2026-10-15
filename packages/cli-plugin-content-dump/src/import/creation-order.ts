import type { RecordNode } from './record-index';

/*
 * One rule orders the import: a record is created only once every record it
 * depends on is completely written, that is created and, when the dump has
 * it published, published. A record depends on the records it links to, on
 * its tree parent and on the sibling before it. That one rule meets every
 * constraint of the CMA:
 *
 * - a link is accepted only to a record that exists;
 * - publishing needs the records it links to, and its tree parent, published,
 *   and models without draft mode publish their records on create;
 * - a record created without a position goes after its siblings, so
 *   creating siblings in order rebuilds the order of sortable and tree models.
 *
 * Records that depend on each other in a cycle cannot all be created after
 * the others. Each cycle is put in an order that keeps every tree parent and
 * previous sibling first and, where it can, every required link; the fields
 * of a record that link to records later in that order are created empty,
 * and written once every record exists.
 */

export interface CreationPlan {
  /** For every record, the records to completely write before creating it. */
  dependencies: number[][];
  /** For every record in a cycle, the top-level fields it is created without. */
  deferred: Map<number, Set<string>>;
}

export function planCreation(nodes: readonly RecordNode[]): CreationPlan {
  const present = (index: number) =>
    index >= 0 && nodes[index]!.stored !== null;
  const dependenciesOf = (node: RecordNode, skipped?: ReadonlySet<string>) =>
    unique(
      [
        ...node.references
          .filter((reference) => !skipped?.has(reference.field))
          .map((reference) => reference.target),
        node.parent,
        node.previous,
      ].filter(present),
    );
  const edges = nodes.map((node) => dependenciesOf(node));
  const isCycle = (component: number[]) =>
    component.length > 1 || edges[component[0]!]!.includes(component[0]!);
  const deferred = new Map<number, Set<string>>();
  for (const component of stronglyConnectedComponents(edges))
    if (isCycle(component))
      for (const [index, fields] of forwardFields(nodes, component))
        deferred.set(index, fields);
  return {
    dependencies: nodes.map((node, index) =>
      dependenciesOf(node, deferred.get(index)),
    ),
    deferred,
  };
}

/**
 * Orders the records of a cycle along their fixed dependencies, starting
 * from the oldest ones (records mostly link to records older than
 * themselves), and returns the fields of each that link to a record at or
 * after it in that order: itself included, so a self link is always among
 * them.
 */
function forwardFields(
  nodes: readonly RecordNode[],
  component: number[],
): Map<number, Set<string>> {
  const members = new Set(component);
  const oldestFirst = [...component].sort(
    (a, b) => nodes[a]!.createdAt - nodes[b]!.createdAt || a - b,
  );
  const fixed = (index: number, withRequired: boolean) => {
    const node = nodes[index]!;
    const required = withRequired
      ? node.references
          .filter(
            (reference) => reference.required && reference.target !== index,
          )
          .map((reference) => reference.target)
      : [];
    return [node.parent, node.previous, ...required].filter((target) =>
      members.has(target),
    );
  };
  // Tree parents and previous siblings never form a cycle, so the second
  // order always exists. Required links that do form one are deferred too:
  // the CMA then refuses the create, or, for a model that saves invalid
  // drafts, the publication of a record the dump has published.
  const order =
    kahn(oldestFirst, (index) => fixed(index, true)) ??
    kahn(oldestFirst, (index) => fixed(index, false));
  if (!order)
    throw new Error('Tree parents or siblings of the dump form a cycle.');
  const rank = new Map(order.map((index, position) => [index, position]));
  const fields = new Map<number, Set<string>>();
  for (const index of component)
    for (const reference of nodes[index]!.references)
      if (
        members.has(reference.target) &&
        rank.get(reference.target)! >= rank.get(index)!
      ) {
        const set = fields.get(index) ?? new Set<string>();
        set.add(reference.field);
        fields.set(index, set);
      }
  return fields;
}

/**
 * Kahn's topological order of `nodes` under `dependencies`: the nodes ready
 * at the start, in the order given, then each node as it becomes ready;
 * undefined when they form a cycle.
 */
function kahn(
  nodes: number[],
  dependencies: (node: number) => number[],
): number[] | undefined {
  const remaining = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const node of nodes) {
    const list = unique(dependencies(node));
    remaining.set(node, list.length);
    for (const dependency of list) {
      const waiting = dependents.get(dependency);
      if (waiting) waiting.push(node);
      else dependents.set(dependency, [node]);
    }
  }
  const order = nodes.filter((node) => remaining.get(node) === 0);
  for (let next = 0; next < order.length; next++)
    for (const dependent of dependents.get(order[next]!) ?? []) {
      const left = remaining.get(dependent)! - 1;
      remaining.set(dependent, left);
      if (left === 0) order.push(dependent);
    }
  return order.length === nodes.length ? order : undefined;
}

/**
 * Tarjan's strongly connected components of a graph given as adjacency
 * lists. Iterative, so long chains of records cannot overflow the stack.
 */
function stronglyConnectedComponents(edges: readonly number[][]): number[][] {
  const discovered = new Int32Array(edges.length).fill(-1);
  const low = new Int32Array(edges.length);
  const onStack = new Uint8Array(edges.length);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;
  const visit = (node: number) => {
    discovered[node] = low[node] = counter++;
    stack.push(node);
    onStack[node] = 1;
  };
  for (let root = 0; root < edges.length; root++) {
    if (discovered[root] !== -1) continue;
    visit(root);
    const path: Array<{ node: number; next: number }> = [
      { node: root, next: 0 },
    ];
    while (path.length) {
      const frame = path[path.length - 1]!;
      const { node } = frame;
      if (frame.next < edges[node]!.length) {
        const target = edges[node]![frame.next++]!;
        if (discovered[target] === -1) {
          visit(target);
          path.push({ node: target, next: 0 });
        } else if (onStack[target])
          low[node] = Math.min(low[node]!, discovered[target]!);
        continue;
      }
      path.pop();
      const parent = path[path.length - 1];
      if (parent) low[parent.node] = Math.min(low[parent.node]!, low[node]!);
      if (low[node] === discovered[node]) {
        const component: number[] = [];
        let member: number;
        do {
          member = stack.pop()!;
          onStack[member] = 0;
          component.push(member);
        } while (member !== node);
        components.push(component);
      }
    }
  }
  return components;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}
