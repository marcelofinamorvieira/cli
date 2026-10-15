import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { type CreationPlan, planCreation } from '../src/import/creation-order';
import type { RecordNode, Reference } from '../src/import/record-index';

/** A record of the dump; `createdAt` ranks it, oldest first. */
function record(
  createdAt: number,
  links: Reference[] = [],
  tree: { parent?: number; previous?: number } = {},
): RecordNode {
  return {
    id: `record-${createdAt}`,
    modelId: 'model',
    stored: { offset: 0, length: 0 },
    status: 'published',
    createdAt,
    references: links,
    parent: tree.parent ?? -1,
    previous: tree.previous ?? -1,
    finish: false,
  };
}

/** A record something links to but the dump does not hold. */
function absent(): RecordNode {
  return { ...record(0), stored: null };
}

function link(field: string, target: number, required = false): Reference {
  return { field, target, required };
}

/** The plan with every list sorted, so it compares as sets. */
function sorted({ dependencies, deferred }: CreationPlan) {
  return {
    dependencies: dependencies.map((list) => [...list].sort((a, b) => a - b)),
    deferred: Object.fromEntries(
      [...deferred].map(([index, fields]) => [index, [...fields].sort()]),
    ),
  };
}

describe('planCreation', () => {
  it('defers nothing without cycles, making each record depend on its links, tree parent and previous sibling', () => {
    const plan = planCreation([
      /* 0 */ record(1),
      /* 1 */ record(2),
      /* 2 */ record(3, [
        link('author', 1),
        link('category', 0),
        link('related', 1),
      ]),
      /* 3 */ record(4),
      /* 4 */ record(5, [link('featured', 2)], { parent: 3 }),
      /* 5 */ record(6, [], { parent: 3, previous: 4 }),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[], [], [0, 1], [], [2, 3], [3, 4]],
      deferred: {},
    });
  });

  it('gives no dependency on links and parents to records the dump does not hold', () => {
    const plan = planCreation([
      /* 0 */ absent(),
      /* 1 */ record(1, [link('author', 0)], { parent: 0, previous: 0 }),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[], []],
      deferred: {},
    });
  });

  it('defers only the forward link of the older of two records linking to each other', () => {
    const plan = planCreation([
      /* 0 */ record(20, [link('related', 1)]),
      /* 1 */ record(10, [link('related', 0)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[1], []],
      deferred: { 1: ['related'] },
    });
  });

  it('ranks records created at the same time in dump order', () => {
    const plan = planCreation([
      /* 0 */ record(10, [link('related', 1)]),
      /* 1 */ record(10, [link('related', 0)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[], [0]],
      deferred: { 0: ['related'] },
    });
  });

  it('always defers a self link, required or not', () => {
    const plan = planCreation([
      /* 0 */ record(1),
      /* 1 */ record(2, [link('author', 0), link('related', 1)]),
      /* 2 */ record(3, [link('itself', 2, true)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[], [0], []],
      deferred: { 1: ['related'], 2: ['itself'] },
    });
  });

  it('keeps a required link to a newer record and defers the optional back link of that record instead', () => {
    const plan = planCreation([
      /* 0: article */ record(10, [link('author', 1, true)]),
      /* 1: author */ record(20, [link('featured_article', 0)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[1], []],
      deferred: { 1: ['featured_article'] },
    });
  });

  it("defers a tree parent's link to its own child, however old the child", () => {
    const plan = planCreation([
      /* 0: child */ record(10, [], { parent: 1 }),
      /* 1: parent */ record(20, [link('featured', 0)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[1], []],
      deferred: { 1: ['featured'] },
    });
  });

  it("defers a sortable record's link to a later sibling, since siblings are created in order", () => {
    const plan = planCreation([
      /* 0: second */ record(10, [], { previous: 1 }),
      /* 1: first */ record(20, [link('next', 0)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[1], []],
      deferred: { 1: ['next'] },
    });
  });

  it('orders records whose required links loop by parent and previous only, deferring the required fields', () => {
    const plan = planCreation([
      // The older one comes second, after its previous sibling.
      /* 0 */ record(10, [link('partner', 1, true)], { previous: 1 }),
      /* 1 */ record(20, [link('partner', 0, true)]),
      // Without siblings, oldest first.
      /* 2 */ record(30, [link('partner', 3, true)]),
      /* 3 */ record(40, [link('partner', 2, true)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[1], [], [], [2]],
      deferred: { 1: ['partner'], 2: ['partner'] },
    });
  });

  it('handles a cycle reachable only through other cycles', () => {
    const plan = planCreation([
      /* 0 */ record(1, [link('next', 1)]),
      /* 1 */ record(2, [link('back', 0), link('onward', 2)]),
      /* 2 */ record(3, [link('next', 3)]),
      /* 3 */ record(4, [link('back', 2), link('onward', 4)]),
      /* 4 */ record(5, [link('next', 5)]),
      /* 5 */ record(6, [link('back', 4)]),
    ]);
    assert.deepStrictEqual(sorted(plan), {
      dependencies: [[], [0, 2], [], [2, 4], [], [4]],
      deferred: { 0: ['next'], 2: ['next'], 4: ['next'] },
    });
  });

  it('plans a random dump of 20,000 records with cycles, trees and sortable models without dependency cycles, deferring only links within a cycle', () => {
    const nodes = randomDump(20_000, 42);
    const plan = planCreation(nodes);
    const present = (index: number) =>
      index >= 0 && nodes[index]!.stored !== null;

    // Each present record depends on exactly its present tree parent,
    // previous sibling and the links of the fields it is created with.
    nodes.forEach((node, index) => {
      const deferred = plan.deferred.get(index);
      const expected = node.stored
        ? new Set(
            [
              ...node.references
                .filter(
                  ({ field, target }) =>
                    target !== index && !deferred?.has(field),
                )
                .map(({ target }) => target),
              node.parent,
              node.previous,
            ].filter(present),
          )
        : new Set();
      assert.deepStrictEqual(new Set(plan.dependencies[index]), expected);
      assert.equal(plan.dependencies[index]!.length, expected.size);
    });
    const order = topologicalOrder(
      nodes.flatMap((node, index) => (node.stored ? [index] : [])),
      (index) => plan.dependencies[index]!,
    );
    assert.ok(order, 'The dependencies form a cycle.');

    // A field is deferred only when it links to a record of the same
    // strongly connected component, and a self link always is.
    const component = components(nodes, present);
    for (const [index, fields] of plan.deferred)
      for (const field of fields)
        assert.ok(
          nodes[index]!.references.some(
            (reference) =>
              reference.field === field &&
              present(reference.target) &&
              component[reference.target] === component[index],
          ),
          `Record ${index} is created without ${field}, which links outside its cycle.`,
        );
    nodes.forEach((node, index) => {
      for (const reference of node.references)
        if (node.stored && reference.target === index)
          assert.ok(plan.deferred.get(index)?.has(reference.field));
    });

    // Where the required links of a cycle leave an order, every required
    // link is kept, except self links.
    const cycles = new Map<number, number[]>();
    nodes.forEach((node, index) => {
      if (!node.stored) return;
      const members = cycles.get(component[index]!) ?? [];
      members.push(index);
      cycles.set(component[index]!, members);
    });
    const seen = { cycles: 0, parents: 0, siblings: 0, loops: 0, kept: 0 };
    for (const members of cycles.values()) {
      if (members.length < 2) continue;
      seen.cycles++;
      const inside = new Set(members);
      if (members.some((index) => inside.has(nodes[index]!.parent)))
        seen.parents++;
      if (members.some((index) => inside.has(nodes[index]!.previous)))
        seen.siblings++;
      const fixed = (index: number) => {
        const node = nodes[index]!;
        return [
          node.parent,
          node.previous,
          ...node.references
            .filter(({ required, target }) => required && target !== index)
            .map(({ target }) => target),
        ].filter((target) => inside.has(target));
      };
      if (!topologicalOrder(members, fixed)) {
        seen.loops++;
        continue;
      }
      for (const index of members)
        for (const { field, required, target } of nodes[index]!.references)
          if (required && target !== index && inside.has(target)) {
            assert.ok(!plan.deferred.get(index)?.has(field));
            seen.kept++;
          }
    }

    // The dump exercises every rule.
    assert.ok(seen.cycles > 100, 'Too few cycles.');
    assert.ok(seen.parents > 0, 'No cycle through a tree parent.');
    assert.ok(seen.siblings > 0, 'No cycle through a previous sibling.');
    assert.ok(seen.loops > 0, 'No required links in a loop.');
    assert.ok(seen.kept > 0, 'No required link kept in a cycle.');
  });

  it('plans a chain of 200,000 records quickly and without overflowing the stack', () => {
    const count = 200_000;
    const nodes = Array.from({ length: count }, (_, index) =>
      record(index, index + 1 < count ? [link('next', index + 1)] : []),
    );
    const started = performance.now();
    const plan = planCreation(nodes);
    assert.ok(performance.now() - started < 2000);
    assert.equal(plan.deferred.size, 0);
    assert.deepStrictEqual(plan.dependencies[0], [1]);
    assert.deepStrictEqual(plan.dependencies[count - 1], []);
  });

  it('plans a cycle of 200,000 records quickly and without overflowing the stack', () => {
    const count = 200_000;
    const nodes = Array.from({ length: count }, (_, index) =>
      record(index, [link('next', (index + 1) % count)]),
    );
    const started = performance.now();
    const plan = planCreation(nodes);
    assert.ok(performance.now() - started < 2000);
    // Only the newest record's link, back to the oldest, is kept.
    assert.equal(plan.deferred.size, count - 1);
    assert.equal(plan.deferred.has(count - 1), false);
    assert.deepStrictEqual(plan.dependencies[count - 1], [0]);
  });
});

/** A deterministic pseudo-random generator (mulberry32) in [0, 1). */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ['author', 'related', 'featured', 'required'];

/**
 * A dump whose records mostly link to records created shortly before them,
 * sometimes to newer ones or to themselves, with tree models, sortable
 * models whose order mostly follows creation, and a few absent records.
 */
function randomDump(count: number, seed: number): RecordNode[] {
  const random = generator(seed);
  const below = (limit: number) => Math.floor(random() * limit);
  const nodes: RecordNode[] = [];
  const treeRecords: number[] = [];
  const siblings = new Map<string, number[]>();
  for (let index = 0; index < count; index++) {
    if (random() < 0.02) {
      nodes.push(absent());
      continue;
    }
    const references: Reference[] = [];
    for (let left = below(3); left > 0; left--) {
      const field = FIELDS[below(FIELDS.length)]!;
      const kind = random();
      const target =
        kind < 0.01
          ? index
          : kind < 0.8
            ? Math.max(0, index - 1 - below(10))
            : kind < 0.85
              ? below(index + 1)
              : Math.min(count - 1, index + 1 + below(4));
      references.push(link(field, target, field === 'required'));
    }
    const kind = random();
    let group: string | undefined;
    let parent = -1;
    if (kind < 0.2) {
      if (treeRecords.length && random() < 0.9)
        parent = treeRecords[treeRecords.length - 1 - below(50)] ?? -1;
      treeRecords.push(index);
      group = `tree/${parent}`;
    } else if (kind < 0.35) group = `sortable/${below(20)}`;
    nodes.push(record(below(count), references, { parent }));
    if (group) {
      const members = siblings.get(group);
      if (members) members.push(index);
      else siblings.set(group, [index]);
    }
  }
  for (const group of siblings.values()) {
    // A few records swapped with the sibling after them.
    for (let swaps = Math.floor(group.length / 10); swaps > 0; swaps--) {
      const at = below(group.length - 1);
      [group[at], group[at + 1]] = [group[at + 1]!, group[at]!];
    }
    group.forEach((index, position) => {
      nodes[index]!.previous = position ? group[position - 1]! : -1;
    });
  }
  return nodes;
}

/** Kahn's order of `nodes`, or undefined when their dependencies loop. */
function topologicalOrder(
  nodes: number[],
  dependencies: (node: number) => number[],
): number[] | undefined {
  const waiting = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const node of nodes) {
    const list = [...new Set(dependencies(node))];
    waiting.set(node, list.length);
    for (const dependency of list) {
      const waitingOn = dependents.get(dependency);
      if (waitingOn) waitingOn.push(node);
      else dependents.set(dependency, [node]);
    }
  }
  const order = nodes.filter((node) => waiting.get(node) === 0);
  for (let next = 0; next < order.length; next++)
    for (const dependent of dependents.get(order[next]!) ?? []) {
      const left = waiting.get(dependent)! - 1;
      waiting.set(dependent, left);
      if (left === 0) order.push(dependent);
    }
  return order.length === nodes.length ? order : undefined;
}

/**
 * The strongly connected component of every record (Kosaraju), over links,
 * tree parents and previous siblings between present records.
 */
function components(
  nodes: RecordNode[],
  present: (index: number) => boolean,
): Int32Array {
  const edges = nodes.map((node) =>
    node.stored
      ? [
          ...node.references.map(({ target }) => target),
          node.parent,
          node.previous,
        ].filter(present)
      : [],
  );
  const finished: number[] = [];
  const seen = new Uint8Array(nodes.length);
  for (let root = 0; root < nodes.length; root++) {
    if (seen[root]) continue;
    seen[root] = 1;
    const path: Array<[node: number, next: number]> = [[root, 0]];
    while (path.length) {
      const top = path[path.length - 1]!;
      const target = edges[top[0]]![top[1]++];
      if (target === undefined) {
        path.pop();
        finished.push(top[0]);
      } else if (!seen[target]) {
        seen[target] = 1;
        path.push([target, 0]);
      }
    }
  }
  const reversed: number[][] = nodes.map(() => []);
  edges.forEach((targets, node) => {
    for (const target of targets) reversed[target]!.push(node);
  });
  const component = new Int32Array(nodes.length).fill(-1);
  for (let at = finished.length - 1; at >= 0; at--) {
    const root = finished[at]!;
    if (component[root] !== -1) continue;
    component[root] = root;
    const pending = [root];
    while (pending.length)
      for (const source of reversed[pending.pop()!]!)
        if (component[source] === -1) {
          component[source] = root;
          pending.push(source);
        }
  }
  return component;
}
