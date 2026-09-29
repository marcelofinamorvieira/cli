import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalizeRecord,
  semanticHash,
  stableStringify,
} from '../../src/content-diff/canonicalize';
import {
  buildRecordDependencyGraph,
  collectCreateCycleIntermediateCandidates,
  projectCreateSeedFields,
} from '../../src/content-diff/dependencies';
import { buildContentDiffPlan } from '../../src/content-diff/plan';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import { snapshotSemanticState } from '../../src/content-diff/snapshot';
import {
  CONTENT_SNAPSHOT_FORMAT_VERSION,
  type ContentDiffPlan,
  type ContentSnapshot,
  type FieldSchemaSnapshot,
  type InvalidContentDiagnostic,
  type ItemTypeSchemaSnapshot,
  type RecordSnapshot,
  type ReferenceDependency,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

const NODES = [0, 1, 2] as const;
const RECORD_IDS = NODES.map((node) => portableId(`record-${node}`));
const MODEL_IDS = NODES.map((node) => portableId(`model-${node}`));
const MISSING_ID = portableId('unavailable-external-record');
const GRAPH_COUNT = 2 ** (NODES.length * NODES.length);
type Graph = readonly (readonly number[])[];

// These are all 512 labelled directed three-node graphs, including self loops.
// Exactly 64 have no self loops. This is a bounded model, not arbitrary graphs.
describe('exhaustive three-record dependency planning', function () {
  this.timeout(120_000);

  it('strips optional self edges inside a multi-record cycle while retaining its already-created dependency', () => {
    // A and B each reference themselves, each other, and acyclic C. Even the
    // last-created cycle member needs restoration of its removed self edge.
    const graph = graphFromMask(63);
    for (const draftSavingActive of [false, true]) {
      const { source, target } = fixture(graph, false, { draftSavingActive });
      const dependencies = buildRecordDependencyGraph(
        source.records,
        source.schema,
      );
      const candidates = collectCreateCycleIntermediateCandidates(
        source.records,
        source.schema,
        new Set(RECORD_IDS),
      );
      const plan = planFixture(source, target, false);
      assert.deepEqual(plan.invalidContent.skippedRecords, []);
      assert.deepEqual(plan.execution.shellComponents, []);
      assert.deepEqual(plan.execution.shellRecordIds, []);
      assert.deepEqual(
        [...dependencies.temporarySeedRecordIds].sort(),
        RECORD_IDS.slice(0, 2).sort(),
      );
      for (const candidate of candidates) {
        const node = RECORD_IDS.indexOf(candidate.recordId);
        assert.equal(
          candidate.fields[edgeKey(node)],
          null,
          `diagnostic keeps self edge for node ${node}`,
        );
        assert.equal(candidate.fields[edgeKey(2)], RECORD_IDS[2]);
        assert.deepEqual(
          candidate.fields,
          projectCreateSeedFields(
            source.records[candidate.recordId],
            source.schema,
            plan.execution.createOrder,
            new Set(RECORD_IDS),
            new Set(),
            [],
          ),
        );
      }
    }
  });

  it('preserves every edge, orders independent SCCs, and creates only references whose IDs already exist', () => {
    let cases = 0;
    let loopFreeGraphs = 0;
    for (let mask = 0; mask < GRAPH_COUNT; mask += 1) {
      const graph = graphFromMask(mask);
      const components = reachabilityComponents(graph);
      if (graph.every((edges, node) => !edges.includes(node)))
        loopFreeGraphs += 1;
      for (const required of [false, true]) {
        const label = `graph=${mask}, required=${required}`;
        const { source, target } = fixture(graph, required);
        const dependencyGraph = buildRecordDependencyGraph(
          source.records,
          source.schema,
        );
        assert.deepEqual(
          dependencyGraph.dependencies,
          Object.fromEntries(
            NODES.map((node) => [
              RECORD_IDS[node],
              graph[node].map((edge) => RECORD_IDS[edge]).sort(),
            ]),
          ),
          label,
        );
        const plan = planFixture(source, target, required);
        assert.deepEqual(plan.invalidContent.skippedRecords, [], label);
        assert.deepEqual(
          plan.records.map(({ id }) => id).sort(),
          [...RECORD_IDS].sort(),
          label,
        );
        assert.ok(
          plan.records.every(({ action }) => action === 'create'),
          label,
        );
        assertPermutation(plan.execution.createOrder, RECORD_IDS, label);
        assertPermutation(dependencyGraph.updateOrder, RECORD_IDS, label);
        assertComponentOrder(
          plan.execution.createOrder,
          graph,
          components,
          label,
        );
        assertComponentOrder(
          dependencyGraph.updateOrder,
          graph,
          components,
          label,
        );

        if (required) {
          const cyclic = components.filter(
            (component) =>
              component.length > 1 ||
              graph[component[0]].includes(component[0]),
          );
          assert.deepEqual(
            sortedComponents(plan.execution.shellComponents),
            sortedComponents(
              cyclic.map((component) =>
                component.map((node) => RECORD_IDS[node]),
              ),
            ),
            label,
          );
        }
        const created = new Set<string>();
        for (const id of plan.execution.createOrder) {
          const node = RECORD_IDS.indexOf(id);
          const fields = projectCreateSeedFields(
            source.records[id],
            source.schema,
            plan.execution.createOrder,
            new Set(RECORD_IDS),
            new Set(plan.execution.shellRecordIds),
            plan.execution.shellComponents,
          );
          for (const edge of graph[node]) {
            const value = fields[edgeKey(edge)];
            if (value !== null) {
              assert.equal(value, RECORD_IDS[edge], label);
              assert.ok(
                created.has(RECORD_IDS[edge]),
                `${label}: ${node} create seed still references unavailable ${edge}`,
              );
            }
            // Every cross-component dependency must survive shell projection.
            if (!sameComponent(components, node, edge))
              assert.equal(value, RECORD_IDS[edge], label);
          }
          created.add(id);
        }
        cases += 1;
      }
    }
    assert.equal(cases, 1024);
    assert.equal(loopFreeGraphs, 64);
  });

  it('keeps plans identical under reversed node and field insertion order', () => {
    let cases = 0;
    for (let mask = 0; mask < GRAPH_COUNT; mask += 1) {
      const graph = graphFromMask(mask);
      for (const required of [false, true]) {
        const first = fixture(graph, required);
        const reversed = fixture(graph, required, { reverse: true });
        const edges: ReferenceDependency[] = NODES.flatMap((node) =>
          graph[node].map((edge) => ({
            fromRecordId: RECORD_IDS[node],
            toRecordId: RECORD_IDS[edge],
            path: `generated:${node}:${edge}`,
            required,
          })),
        );
        assert.deepEqual(
          buildRecordDependencyGraph(
            first.source.records,
            first.source.schema,
            edges,
          ),
          buildRecordDependencyGraph(
            reversed.source.records,
            reversed.source.schema,
            [...edges].reverse(),
          ),
          `edge enumeration graph=${mask}, required=${required}`,
        );
        assert.equal(
          first.source.digest,
          reversed.source.digest,
          `snapshot graph=${mask}`,
        );
        assert.equal(
          stableStringify(planFixture(first.source, first.target, required)),
          stableStringify(
            planFixture(reversed.source, reversed.target, required),
          ),
          `plan graph=${mask}, required=${required}`,
        );
        cases += 1;
      }
    }
    assert.equal(cases, 1024);
  });

  it('unlinks optional deletion cycles before deleting any record still referenced by another survivor', () => {
    for (let mask = 0; mask < GRAPH_COUNT; mask += 1) {
      const graph = graphFromMask(mask);
      const components = reachabilityComponents(graph);
      const { source } = fixture(graph, false);
      const plan = buildContentDiffPlan(
        snapshot(source.schema, {}),
        snapshot({ ...source.schema, environmentId: 'target' }, source.records),
        { includeDeletions: true, uploads: 'referenced' },
      );
      const label = `delete graph=${mask}`;
      assert.deepEqual(plan.invalidContent.skippedRecords, [], label);
      assert.ok(
        plan.records.every(({ action }) => action === 'delete'),
        label,
      );
      assertPermutation(plan.execution.deleteOrder, RECORD_IDS, label);
      const live = new Map<number, Set<number>>(
        NODES.map((node) => [node, new Set<number>(graph[node])]),
      );
      for (const release of plan.execution.deleteReleases) {
        const node = RECORD_IDS.indexOf(release.recordId);
        assert.equal(release.publish, false, label);
        assert.deepEqual(release.transientNestedBlockIds, [], label);
        assert.equal(
          release.fields.label,
          source.records[release.recordId].current.fields.label,
          label,
        );
        for (const edge of graph[node]) {
          const value = release.fields[edgeKey(edge)];
          if (value === null) live.get(node)!.delete(edge);
          else assert.equal(value, RECORD_IDS[edge], label);
          if (!sameComponent(components, node, edge))
            assert.equal(value, RECORD_IDS[edge], label);
        }
      }
      for (const id of plan.execution.deleteOrder) {
        const node = RECORD_IDS.indexOf(id);
        for (const [consumer, edges] of live) {
          // A record's self-reference disappears atomically with its deletion.
          if (consumer !== node)
            assert.ok(
              !edges.has(node),
              `${label}: deleting ${node} while ${consumer} still references it`,
            );
        }
        live.delete(node);
      }
      assert.equal(live.size, 0, label);
    }
  });

  it('propagates missing-reference preservation exactly until an existing destination record satisfies the edge', () => {
    let cases = 0;
    // All seven nonempty initial skip sets and all eight destination-presence
    // masks expose propagation barriers and interactions between skip seeds.
    for (let mask = 0; mask < GRAPH_COUNT; mask += 1) {
      const graph = graphFromMask(mask);
      for (let poisonMask = 1; poisonMask < 8; poisonMask += 1) {
        const poison = new Set<number>(
          NODES.filter((node) => (poisonMask & (1 << node)) !== 0),
        );
        for (let presentMask = 0; presentMask < 8; presentMask += 1) {
          const present = new Set<number>(
            NODES.filter((node) => (presentMask & (1 << node)) !== 0),
          );
          const expectedSkipped = skipClosure(graph, poison, present);
          const { source, target } = fixture(graph, false, {
            poison,
            present,
          });
          const plan = planFixture(source, target, false, expectedSkipped);
          const label = `graph=${mask}, initial=${poisonMask}, present=${presentMask}`;
          assert.deepEqual(
            plan.invalidContent.skippedRecords.map(({ id }) => id).sort(),
            [...expectedSkipped].map((node) => RECORD_IDS[node]).sort(),
            label,
          );
          assert.deepEqual(
            plan.records.map(({ id }) => id).sort(),
            NODES.filter((node) => !expectedSkipped.has(node))
              .map((node) => RECORD_IDS[node])
              .sort(),
            label,
          );
          assert.equal(
            plan.invalidContent.propagatedSkipCount,
            expectedSkipped.size - poison.size,
            label,
          );
          for (const skipped of plan.invalidContent.skippedRecords) {
            assert.equal(
              skipped.disposition,
              present.has(RECORD_IDS.indexOf(skipped.id))
                ? 'preserve_target'
                : 'must_remain_absent',
              label,
            );
          }
          cases += 1;
        }
      }
    }
    assert.equal(cases, 28672);
  });
});

function graphFromMask(mask: number): Graph {
  return NODES.map((from) =>
    NODES.filter((to) => (mask & (1 << (from * NODES.length + to))) !== 0),
  );
}

function edgeKey(node: number): string {
  return `to_${String.fromCharCode(97 + node)}`;
}

// Independent oracle: breadth-first reachability, then mutual reachability.
// It does not call the planner's SCC or topological-sort implementations.
function reachable(graph: Graph, start: number): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const neighbor of graph[queue[cursor]]) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return seen;
}

function reachabilityComponents(graph: Graph): number[][] {
  const closure = NODES.map((node) => reachable(graph, node));
  const remaining = new Set<number>(NODES);
  const components: number[][] = [];
  for (const node of NODES) {
    if (!remaining.has(node)) continue;
    const component = NODES.filter(
      (other) => closure[node].has(other) && closure[other].has(node),
    );
    component.forEach((other) => remaining.delete(other));
    components.push(component);
  }
  return components;
}

function skipClosure(
  graph: Graph,
  initial: ReadonlySet<number>,
  present: ReadonlySet<number>,
): Set<number> {
  const skipped = new Set(initial);
  const queue = [...initial];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const unavailable = queue[cursor];
    if (present.has(unavailable)) continue;
    for (const consumer of NODES) {
      if (graph[consumer].includes(unavailable) && !skipped.has(consumer)) {
        skipped.add(consumer);
        queue.push(consumer);
      }
    }
  }
  return skipped;
}

function sameComponent(
  components: readonly (readonly number[])[],
  left: number,
  right: number,
): boolean {
  return components.some(
    (component) => component.includes(left) && component.includes(right),
  );
}

function sortedComponents(
  components: readonly (readonly string[])[],
): string[][] {
  return components
    .map((component) => [...component].sort())
    .sort((left, right) =>
      left.join(',') < right.join(',')
        ? -1
        : left.join(',') > right.join(',')
          ? 1
          : 0,
    );
}

function assertPermutation(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
  assert.equal(new Set(actual).size, expected.length, label);
}

function assertComponentOrder(
  order: readonly string[],
  graph: Graph,
  components: readonly (readonly number[])[],
  label: string,
): void {
  for (const node of NODES)
    for (const dependency of graph[node]) {
      if (!sameComponent(components, node, dependency)) {
        assert.ok(
          order.indexOf(RECORD_IDS[dependency]) <
            order.indexOf(RECORD_IDS[node]),
          label,
        );
      }
    }
}

function portableId(label: string): string {
  const bytes = createHash('sha256')
    .update(`generated-dependencies:${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('base64url');
}

function fixture(
  graph: Graph,
  required: boolean,
  options: Readonly<{
    reverse?: boolean;
    poison?: ReadonlySet<number>;
    present?: ReadonlySet<number>;
    draftSavingActive?: boolean;
  }> = {},
): { source: ContentSnapshot; target: ContentSnapshot } {
  const schema: SchemaSnapshot = {
    siteId: 'generated-graph-project',
    environmentId: 'source',
    locales: ['en'],
    environmentSemantics: {
      timezone: 'UTC',
      improvedTimezoneManagement: true,
      improvedBooleanFields: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    },
    itemTypes: NODES.map(
      (node): ItemTypeSchemaSnapshot => ({
        id: MODEL_IDS[node],
        apiKey: `node_${String.fromCharCode(97 + node)}`,
        name: `Node ${node}`,
        modularBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftModeActive: true,
        draftSavingActive: options.draftSavingActive ?? true,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: portableId(`label-${node}`),
            apiKey: 'label',
            fieldType: 'string',
            localized: false,
            position: 0,
            validators: {},
          },
          ...graph[node].map(
            (edge): FieldSchemaSnapshot => ({
              id: portableId(`edge-${node}-${edge}`),
              apiKey: edgeKey(edge),
              fieldType: 'link',
              localized: false,
              position: edge + 1,
              validators: {
                item_item_type: { item_types: [MODEL_IDS[edge]] },
                ...(required ? { required: {} } : {}),
              },
            }),
          ),
          ...(options.poison?.has(node)
            ? [
                {
                  id: portableId(`unavailable-field-${node}`),
                  apiKey: 'unavailable',
                  fieldType: 'link' as const,
                  localized: false,
                  position: 4,
                  validators: {},
                },
              ]
            : []),
        ],
      }),
    ).sort((left, right) => (left.id < right.id ? -1 : 1)),
    workflows: [],
    digest: '',
  };
  schema.digest = computeSchemaDigest(schema);
  const targetSchema = { ...schema, environmentId: 'target' };
  const nodeOrder = options.reverse ? [...NODES].reverse() : NODES;
  const records = (target: boolean): Record<string, RecordSnapshot> =>
    Object.fromEntries(
      nodeOrder
        .filter((node) => !target || options.present?.has(node))
        .map((node) => {
          const entries: Array<[string, string | null]> = [
            ['label', target ? 'baseline' : `desired-${node}`],
            ...graph[node].map((edge): [string, string | null] => [
              edgeKey(edge),
              target ? null : RECORD_IDS[edge],
            ]),
            ...(options.poison?.has(node)
              ? [
                  ['unavailable', target ? null : MISSING_ID] as [
                    string,
                    string | null,
                  ],
                ]
              : []),
          ];
          if (options.reverse) entries.reverse();
          const record = canonicalizeRecord(
            {
              id: RECORD_IDS[node],
              type: 'item',
              item_type: { type: 'item_type', id: MODEL_IDS[node] },
              ...Object.fromEntries(entries),
              meta: {
                current_version: 'fixture-version',
                status: 'draft',
                is_valid: true,
                is_current_version_valid: true,
                is_published_version_valid: null,
                stage: null,
                first_published_at: null,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                published_at: null,
              },
            },
            null,
            schema.itemTypes.find(({ id }) => id === MODEL_IDS[node])!,
            schema,
            { publication: null, unpublishing: null },
          );
          return [record.id, record];
        }),
    );
  return {
    source: snapshot(schema, records(false)),
    target: snapshot(targetSchema, records(true)),
  };
}

function snapshot(
  schema: SchemaSnapshot,
  records: Record<string, RecordSnapshot>,
): ContentSnapshot {
  const result: ContentSnapshot = {
    formatVersion: CONTENT_SNAPSHOT_FORMAT_VERSION,
    siteId: schema.siteId,
    environmentId: schema.environmentId,
    capturedAt: '2026-01-01T00:00:00Z',
    schema,
    inspection: {
      itemTypes: [],
      digest: semanticHash({ itemTypes: [] }),
      structuralIssues: [],
    },
    scope: { itemTypeIds: [...MODEL_IDS].sort(), uploads: 'referenced' },
    readItemTypes: schema.itemTypes.map(({ id, workflowId }) => ({
      id,
      workflowId,
    })),
    records,
    uploads: {},
    uploadCollections: {},
    visibleRecordIds: Object.keys(records).sort(),
    blockOwnership: {},
    digest: '',
  };
  result.digest = semanticHash(snapshotSemanticState(result));
  return result;
}

function planFixture(
  source: ContentSnapshot,
  target: ContentSnapshot,
  required: boolean,
  skipped: ReadonlySet<number> = new Set(),
): ContentDiffPlan {
  const active = Object.fromEntries(
    Object.entries(source.records).filter(
      ([id]) => !skipped.has(RECORD_IDS.indexOf(id)),
    ),
  );
  // All optional edges use separate nullable link fields with no other
  // validators. Removing them produces a valid diagnostic payload. The helper
  // supplies its content hash; independent assertions above check its edges.
  const diagnostics: InvalidContentDiagnostic[] = required
    ? []
    : collectCreateCycleIntermediateCandidates(
        active,
        source.schema,
        new Set(Object.keys(active).filter((id) => !target.records[id])),
      ).map(({ recordId, versionHash }) => ({
        recordId,
        slice: 'intermediate',
        versionHash,
        valid: true,
        issues: [],
      }));
  return buildContentDiffPlan(source, target, {
    includeDeletions: false,
    uploads: 'referenced',
    invalidContentDiagnostics: diagnostics,
  });
}
