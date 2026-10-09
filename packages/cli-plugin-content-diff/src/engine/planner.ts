import { hashJson } from './codec';
import { compareIds } from './compare-ids';
import { ContentError } from './errors';
import { Heap, PlannerGraph, stronglyConnected } from './planner-graph';
import type { SideIndex } from './side';
import type {
  Action,
  CollectionPlan,
  CollectionState,
  Diagnostic,
  JsonValue,
  Kind,
  ModelSchema,
  PlanCounts,
  PlanEntry,
  PlanMetadata,
  PlanOptions,
  RecordFacts,
  RecordPlan,
  SchemaState,
  UploadPlan,
} from './types';

const MUTATIONS = new Set<Action>(['create', 'update', 'delete']);
const WRITES = new Set<Action>(['create', 'update']);
const RECORD_PHASES = ['create', 'publish', 'delete'] as const;
/** The graph phase that ranks folder creates and updates by final depth. */
export const COLLECTION_WRITE_PHASE = 'collection-write';
const CREATION_PHASE = 'creation-discovery';

/** Native collection fields use arrays; nullable singular fields use null. */
export function creationEmptyValue(type: string): JsonValue {
  return type === 'rich_text' || type === 'links' ? [] : null;
}

/**
 * The action that brings an entry in scope to its source state: created when
 * only the source has it, deleted (when deletions are on) when only the
 * destination has it, updated when their hashes differ.
 */
function plannedAction(
  inScope: boolean,
  source: { hash: string } | undefined,
  target: { hash: string } | undefined,
  includeDeletions: boolean,
): Action {
  if (!inScope) return 'noop';
  if (!target) return 'create';
  if (!source) return includeDeletions ? 'delete' : 'noop';
  return source.hash === target.hash ? 'noop' : 'update';
}

function blankCounts(): PlanCounts {
  const actions = () => ({ create: 0, update: 0, delete: 0, noop: 0, skip: 0 });
  return { record: actions(), upload: actions(), collection: actions() };
}

/** Whether an entry exists in the destination once the plan has run. */
function remains(entry: PlanEntry | undefined): boolean {
  return (
    !!entry &&
    entry.action !== 'delete' &&
    (entry.action !== 'skip' || entry.inDestination)
  );
}

/** Whether a field is a top-level link or links field of a model. */
function linkField(model: ModelSchema, fieldId: string): boolean {
  return model.fields.some(
    (field) =>
      field.id === fieldId && (field.type === 'link' || field.type === 'links'),
  );
}

/** The kind of the references a create writes: its published or current fields. */
const creationKind = (facts: RecordFacts) =>
  facts.published ? 'published' : 'current';

/** Strongly connected components of an owner -> dependencies map, in ID order. */
function components(edges: Map<string, Map<string, boolean>>): string[][] {
  const nodes = new Set<string>();
  for (const [owner, dependencies] of edges) {
    nodes.add(owner);
    for (const dependency of dependencies.keys()) nodes.add(dependency);
  }
  return [
    ...stronglyConnected([...nodes].sort(compareIds), (node) =>
      [...(edges.get(node)?.keys() ?? [])].sort(compareIds),
    ),
  ].map((component) => component.sort(compareIds));
}

/**
 * The edges to drop to break a cycle: a depth-first order breaks each simple
 * cycle at a single edge; if that would drop a fixed edge, the cycle is
 * ordered by its fixed edges alone. Returns null when neither order works.
 */
function cycleDrops(
  component: string[],
  edges: Map<string, Map<string, boolean>>,
): Map<string, Set<string>> | null {
  const members = new Set(component);
  return (
    droppedEdges(
      component,
      members,
      edges,
      cycleOrder(component, members, edges, false),
    ) ??
    droppedEdges(
      component,
      members,
      edges,
      cycleOrder(component, members, edges, true),
    )
  );
}

/**
 * Orders the records of a publication cycle so dependencies come first where
 * possible. A depth-first postorder misplaces only one edge per simple cycle;
 * with `fixedOnly`, only unbreakable edges are honoured, which succeeds
 * whenever they are acyclic and otherwise returns null.
 */
function cycleOrder(
  component: string[],
  members: Set<string>,
  edges: Map<string, Map<string, boolean>>,
  fixedOnly: boolean,
): Map<string, number> | null {
  const position = new Map<string, number>();
  const dependencies = (node: string) =>
    [...(edges.get(node) ?? [])]
      .filter(
        ([dependency, breakable]) =>
          members.has(dependency) && !(fixedOnly && breakable),
      )
      .map(([dependency]) => dependency)
      .sort(compareIds);
  if (!fixedOnly) {
    for (const root of component) {
      if (position.has(root)) continue;
      const visited = new Set([root]);
      const frames = [{ node: root, pending: dependencies(root).reverse() }];
      while (frames.length) {
        const frame = frames[frames.length - 1];
        const dependency = frame.pending.pop();
        if (dependency !== undefined) {
          if (!visited.has(dependency) && !position.has(dependency)) {
            visited.add(dependency);
            frames.push({
              node: dependency,
              pending: dependencies(dependency).reverse(),
            });
          }
          continue;
        }
        frames.pop();
        position.set(frame.node, position.size);
      }
    }
    return position;
  }
  const waiting = new Map<string, number>();
  const dependants = new Map<string, string[]>();
  for (const owner of component)
    for (const dependency of dependencies(owner)) {
      waiting.set(owner, (waiting.get(owner) ?? 0) + 1);
      dependants.set(dependency, [
        ...(dependants.get(dependency) ?? []),
        owner,
      ]);
    }
  const ready = component.filter((member) => !waiting.get(member));
  while (ready.length) {
    ready.sort(compareIds);
    const member = ready.shift()!;
    position.set(member, position.size);
    for (const owner of dependants.get(member) ?? []) {
      const count = waiting.get(owner)! - 1;
      waiting.set(owner, count);
      if (!count) ready.push(owner);
    }
  }
  return position.size === component.length ? position : null;
}

/**
 * The links an order requires dropping: each edge whose dependency comes after
 * its owner. Returns null when one of them cannot be dropped.
 */
function droppedEdges(
  component: string[],
  members: Set<string>,
  edges: Map<string, Map<string, boolean>>,
  position: Map<string, number> | null,
): Map<string, Set<string>> | null {
  if (!position) return null;
  const drops = new Map<string, Set<string>>();
  for (const owner of component)
    for (const [dependency, breakable] of edges.get(owner) ?? [])
      if (
        members.has(dependency) &&
        position.get(dependency)! > position.get(owner)!
      ) {
        if (!breakable) return null;
        drops.set(owner, new Set([...(drops.get(owner) ?? []), dependency]));
      }
  return drops;
}

/**
 * The structure content transfer relies on: the same locales, environment
 * semantics and workflow stages, and for every managed and block model the
 * same identity, behavior and field set. Names, validators, default values
 * and presentation are left to the CMA, which validates every write.
 */
export function assertSchemaCompatible(
  source: SchemaState,
  target: SchemaState,
  selected: Set<string>,
): void {
  const workflows = (schema: SchemaState) =>
    schema.workflows
      .map((workflow) => ({
        id: workflow.id,
        stages: workflow.stages.map((stage) => stage.id).sort(),
      }))
      .sort((a, b) => compareIds(a.id, b.id));
  if (
    hashJson(source.locales) !== hashJson(target.locales) ||
    hashJson(source.semantics) !== hashJson(target.semantics) ||
    hashJson(workflows(source)) !== hashJson(workflows(target))
  ) {
    throw new ContentError(
      'SCHEMA_INCOMPATIBLE',
      'Locales, site semantics, and workflows must match before content can be transferred.',
    );
  }
  const shape = (model: ModelSchema) => ({
    apiKey: model.apiKey,
    block: model.block,
    singleton: model.singleton,
    sortable: model.sortable,
    tree: model.tree,
    draftMode: model.draftMode,
    workflowId: model.workflowId,
    fields: model.fields
      .map(({ id, apiKey, type, localized }) => ({
        id,
        apiKey,
        type,
        localized,
      }))
      .sort((a, b) => compareIds(a.id, b.id)),
  });
  const targetModels = new Map(target.models.map((model) => [model.id, model]));
  for (const model of source.models) {
    if (!selected.has(model.id) && !model.block) continue;
    const destination = targetModels.get(model.id);
    if (!destination || hashJson(shape(model)) !== hashJson(shape(destination)))
      throw new ContentError(
        'SCHEMA_INCOMPATIBLE',
        `Managed model ${model.apiKey} (${model.id}) must have the same structure in source and destination.`,
        { modelId: model.id },
      );
  }
}

interface Refusal {
  kind: Kind;
  id: string;
  code: string;
  message: string;
  dependencyId?: string;
}
/** Refusals are processed in this order, whenever they were queued. */
const refusalOrder = (a: Refusal, b: Refusal) =>
  compareIds(a.kind, b.kind) ||
  compareIds(a.id, b.id) ||
  compareIds(a.code, b.code) ||
  compareIds(a.message, b.message);

/** The entries of one kind in plan order: by model, then ID. */
function ordered<T extends PlanEntry>(entries: Iterable<T>): T[] {
  return [...entries].sort(
    (a, b) =>
      compareIds(
        a.kind === 'record' ? a.modelId : '',
        b.kind === 'record' ? b.modelId : '',
      ) || compareIds(a.id, b.id),
  );
}

/** A complete plan: entries by kind and ID, with the graph that ordered them. */
export interface Plan {
  metadata: PlanMetadata;
  records: Map<string, RecordPlan>;
  uploads: Map<string, UploadPlan>;
  collections: Map<string, CollectionPlan>;
  graph: PlannerGraph;
}

/**
 * Compares the captured source and destination and turns the difference into
 * ordered work. The CMA validates every write when the diff runs, so planning
 * predicts no acceptance: it refuses only content its own serialization
 * cannot reproduce, and otherwise decides the order of writes and the shape
 * of their payloads. It works on the facts of each record (identity, hash,
 * publication, position and references); field values stay on disk.
 */
class Planning {
  readonly graph = new PlannerGraph();
  readonly models: Map<string, ModelSchema>;
  readonly selected: Set<string>;
  readonly records = new Map<string, RecordPlan>();
  readonly uploads = new Map<string, UploadPlan>();
  readonly collections = new Map<string, CollectionPlan>();
  /** Every refusal ever queued, so none is queued twice. */
  private readonly refusals = new Set<string>();
  private readonly pending = new Heap<Refusal>(refusalOrder);
  private readonly assetScope = {
    upload: new Set<string>(),
    collection: new Set<string>(),
  };
  /** Top-level fields of new records left out to break creation cycles. */
  private readonly deferred = new Map<string, Set<string>>();

  constructor(
    readonly source: SideIndex,
    readonly target: SideIndex,
    readonly options: PlanOptions,
  ) {
    this.selected = new Set(options.modelIds);
    this.models = new Map(
      target.schema.models.map((model) => [model.id, model]),
    );
  }

  entry(kind: Kind, id: string): PlanEntry | undefined {
    return kind === 'record'
      ? this.records.get(id)
      : kind === 'upload'
        ? this.uploads.get(id)
        : this.collections.get(id);
  }

  recordEntries(...actions: Action[]): RecordPlan[] {
    return ordered(
      [...this.records.values()].filter(
        (entry) => !actions.length || actions.includes(entry.action),
      ),
    );
  }

  /** Queues a structural refusal of a requested mutation. */
  refuse(
    kind: Kind,
    id: string,
    code: string,
    message: string,
    dependencyId?: string,
  ): void {
    const plan = this.entry(kind, id);
    if (!plan || !MUTATIONS.has(plan.action)) return;
    const key = [kind, id, code, message].join('\0');
    if (this.refusals.has(key)) return;
    this.refusals.add(key);
    this.pending.push({ kind, id, code, message, dependencyId });
  }

  planRecords(): void {
    const ids = new Set([
      ...this.source.records.keys(),
      ...this.target.records.keys(),
    ]);
    for (const id of ids) {
      const source = this.source.records.get(id);
      const target = this.target.records.get(id);
      const managed = this.selected.has((source ?? target)!.modelId);
      if (!managed && !target) continue;
      // The hash leaves out the position: each changed sibling group is
      // ordered with one reorder operation, so a record that only shifted
      // within its group needs no entry of its own.
      const action = plannedAction(
        managed,
        source,
        target,
        this.options.includeDeletions,
      );
      const plan: RecordPlan = {
        kind: 'record',
        id,
        modelId: (managed && source ? source : target)!.modelId,
        action,
        inDestination: !!target,
        diagnostics: [],
      };
      if (action !== 'noop') {
        plan.baseline = target ?? null;
        plan.desired = source ?? null;
      }
      this.records.set(id, plan);
    }
  }

  /**
   * Uploads referenced by managed records on either side, or every upload,
   * plus the folders containing them and their ancestors.
   */
  planAssetScope(): void {
    const { upload, collection } = this.assetScope;
    if (this.options.uploads === 'all') {
      for (const side of [this.source, this.target]) {
        for (const id of side.uploads.keys()) upload.add(id);
        for (const id of side.collections.keys()) collection.add(id);
      }
      return;
    }
    for (const side of [this.source, this.target])
      for (const id of side.referencedUploads) upload.add(id);
    for (const id of upload)
      for (const side of [this.source, this.target]) {
        let folder = side.uploads.get(id)?.collectionId ?? null;
        while (folder && !collection.has(folder)) {
          collection.add(folder);
          folder =
            (
              this.source.collections.get(folder) ??
              this.target.collections.get(folder)
            )?.parentId ?? null;
        }
      }
  }

  /**
   * Reads the references of the records the plan changes, on both sides,
   * and the values the SDK would corrupt in the records it writes. No other
   * record's references take part in planning.
   */
  async loadDetails(): Promise<void> {
    const changed = [...this.records.values()].filter((entry) =>
      MUTATIONS.has(entry.action),
    );
    await this.source.loadDetails(
      changed.filter((entry) => entry.desired).map((entry) => entry.id),
    );
    await this.target.loadDetails(
      changed.filter((entry) => entry.baseline).map((entry) => entry.id),
    );
  }

  planAssets(): void {
    for (const kind of ['upload', 'collection'] as const) {
      const key = kind === 'upload' ? 'uploads' : 'collections';
      const entries = this[key] as Map<string, PlanEntry>;
      for (const id of new Set([
        ...this.source[key].keys(),
        ...this.target[key].keys(),
      ])) {
        const source = this.source[key].get(id);
        const target = this.target[key].get(id);
        const scoped = this.assetScope[kind].has(id);
        if (!scoped && !target) continue;
        const action = plannedAction(
          scoped,
          source,
          target,
          this.options.includeDeletions,
        );
        const plan = {
          kind,
          id,
          action,
          inDestination: !!target,
          diagnostics: [],
        } as PlanEntry;
        if (action !== 'noop')
          Object.assign(plan, {
            baseline: target ?? null,
            desired: source ?? null,
          });
        entries.set(id, plan);
      }
    }
  }

  /** Content the SDK would silently corrupt through a write and its response. */
  payloadRefusals(): void {
    for (const plan of this.recordEntries('create', 'update'))
      for (const key of plan.desired?.unsupportedKeys ?? [])
        this.refuse(
          'record',
          plan.id,
          'UNSUPPORTED_PAYLOAD_KEY',
          `Record ${plan.id} contains native field metadata at ${key} that the CMA client cannot safely preserve through writes and responses.`,
        );
  }

  private defer(owner: string, root: string): void {
    let roots = this.deferred.get(owner);
    if (!roots) {
      roots = new Set();
      this.deferred.set(owner, roots);
    }
    roots.add(root);
  }

  /**
   * The fields each new record is created without. References to records
   * that do not exist yet when it is created are emptied; the full fields
   * follow in the publication and update phases.
   */
  creationFields(): void {
    const creates = this.recordEntries('create').filter(
      (entry) => entry.desired,
    );
    for (const entry of creates)
      this.graph.node(CREATION_PHASE, 'record', entry.id);
    for (const entry of creates)
      for (const reference of entry.desired!.references)
        if (
          reference.kind === creationKind(entry.desired!) &&
          this.records.get(reference.targetId)?.action === 'create'
        )
          this.graph.edge(
            CREATION_PHASE,
            'record',
            entry.id,
            'record',
            reference.targetId,
            'seed-reference',
            reference.fieldId,
          );
    if (this.graph.order(CREATION_PHASE)) {
      // A creation cycle is broken like a publication cycle: its members are
      // ordered so that as few references as possible point to a member
      // created later, and only the fields holding those references are
      // emptied. A tree parent and a reference whose field cannot be
      // identified cannot be left out. Records that merely depend on a cycle
      // wait for it and keep their fields.
      const edges = new Map<string, Map<string, boolean>>();
      const roots = new Map<string, Set<string>>();
      for (const entry of creates) {
        if (this.graph.done(CREATION_PHASE, 'record', entry.id)) continue;
        const model = this.models.get(entry.modelId)!;
        for (const reference of entry.desired!.references) {
          if (
            reference.kind !== creationKind(entry.desired!) ||
            this.graph.done(CREATION_PHASE, 'record', reference.targetId) !==
              false
          )
            continue;
          const owner = entry.id;
          const target = reference.targetId;
          const root = reference.fieldId ? reference.root : undefined;
          const breakable =
            !!root && model.fields.some((field) => field.apiKey === root);
          const dependencies = edges.get(owner) ?? new Map<string, boolean>();
          edges.set(owner, dependencies);
          dependencies.set(
            target,
            (dependencies.get(target) ?? true) && breakable,
          );
          if (breakable)
            roots.set(
              `${owner}\0${target}`,
              (roots.get(`${owner}\0${target}`) ?? new Set()).add(root!),
            );
        }
      }
      for (const component of components(edges)) {
        const members = new Set(component);
        const drops = cycleDrops(component, edges);
        // Without such an order every identifiable reference in the cycle is
        // left out, and a reference that still closes a cycle is refused
        // below.
        for (const owner of component)
          for (const target of edges.get(owner)?.keys() ?? [])
            if (
              members.has(target) &&
              (!drops || target === owner || drops.get(owner)?.has(target))
            )
              for (const root of roots.get(`${owner}\0${target}`) ?? [])
                this.defer(owner, root);
      }
    }
    for (const [owner, keys] of this.deferred)
      for (const reference of this.source.records.get(owner)?.references ?? [])
        if (keys.has(reference.root))
          this.graph.removeEdges(
            CREATION_PHASE,
            owner,
            reference.targetId,
            (_, fieldId) => fieldId === reference.fieldId,
          );
    this.graph.order(CREATION_PHASE);
    for (const entry of creates) {
      const model = this.models.get(entry.modelId)!;
      const deferred = new Set(this.deferred.get(entry.id));
      for (const reference of entry.desired!.references) {
        if (
          reference.kind !== creationKind(entry.desired!) ||
          !reference.fieldId
        )
          continue;
        const dependency = this.records.get(reference.targetId);
        if (!dependency || !WRITES.has(dependency.action)) continue;
        // Models without draft mode publish during create. An existing draft
        // is therefore unavailable to their seed until the publication phase,
        // just like a newly created draft. Keeping the reference could fail or
        // invoke the field's cascading publication strategy prematurely.
        if (
          dependency.action === 'update' &&
          (model.draftMode ||
            this.target.records.get(reference.targetId)?.published)
        )
          continue;
        if (
          this.graph.done(CREATION_PHASE, 'record', reference.targetId) &&
          (model.draftMode || !this.models.get(dependency.modelId)?.draftMode)
        )
          continue;
        const root = reference.root;
        if (!root || !model.fields.some((field) => field.apiKey === root)) {
          this.refuse(
            'record',
            entry.id,
            'UNSUPPORTED_CREATION_REFERENCE',
            `Record ${entry.id} has a creation reference whose containing field cannot be identified.`,
          );
          continue;
        }
        deferred.add(root);
      }
      entry.execution = {
        ...entry.execution,
        deferredFields: [...deferred].sort(compareIds),
      };
    }
    // The creation order is settled; executionOrders ranks creates again.
    this.graph.clear(CREATION_PHASE);
  }

  /** The final state of a record that remains in the destination. */
  finalRecord(entry: RecordPlan): RecordFacts | undefined {
    return WRITES.has(entry.action)
      ? entry.desired ?? undefined
      : this.target.records.get(entry.id);
  }

  /**
   * Ranks every record write within its phase and every folder write by its
   * final depth. Ordering constraints come from the intended content: new
   * parents and referenced records first, links released before unpublishing,
   * referrers deleted before their targets. Draft updates need no rank: they
   * run once every record exists with its final publication state.
   */
  executionOrders(): void {
    for (const phase of [...RECORD_PHASES, COLLECTION_WRITE_PHASE])
      this.graph.clear(phase);
    const entries = this.recordEntries();
    for (const entry of entries) {
      if (!MUTATIONS.has(entry.action)) continue;
      if (entry.action === 'delete') {
        this.graph.node('delete', 'record', entry.id);
        continue;
      }
      if (entry.action === 'create')
        this.graph.node('create', 'record', entry.id);
      this.graph.node('publish', 'record', entry.id);
      const desired = entry.desired!;
      if (!desired.parentId) continue;
      const parent = this.records.get(desired.parentId);
      if (entry.action === 'create' && parent?.action === 'create')
        this.graph.edge(
          'create',
          'record',
          entry.id,
          'record',
          parent.id,
          'parent',
        );
      // An unpublished child is unpublished before its parent through the
      // release edge below, so only a published child waits for its parent's
      // publication, and only when this plan publishes the parent for the
      // first time, as with the publication edges below.
      if (
        parent &&
        WRITES.has(parent.action) &&
        desired.published &&
        parent.desired?.published &&
        !parent.baseline?.published &&
        (parent.action !== 'create' ||
          this.models.get(parent.modelId)!.draftMode)
      )
        this.graph.edge(
          'publish',
          'record',
          entry.id,
          'record',
          parent.id,
          'parent',
        );
      // Existing tree records move in publication order: before they are
      // published under their new parent, and before a parent they leave is
      // unpublished (the release edges below). A move waits for every moved
      // record on its desired ancestor path, not only a changed direct
      // parent, or the new parent can still be a live descendant. The nearest
      // moved ancestor waits for the next, so one edge suffices.
      if (
        entry.action === 'update' &&
        entry.baseline?.parentId !== desired.parentId
      ) {
        const visited = new Set([entry.id]);
        let ancestor = parent;
        while (remains(ancestor) && !visited.has(ancestor!.id)) {
          visited.add(ancestor!.id);
          const state = this.finalRecord(ancestor!);
          if (
            ancestor!.action === 'update' &&
            ancestor!.baseline?.parentId !== state?.parentId
          ) {
            this.graph.edge(
              'publish',
              'record',
              entry.id,
              'record',
              ancestor!.id,
              'ancestor',
            );
            break;
          }
          ancestor = state?.parentId
            ? this.records.get(state.parentId)
            : undefined;
        }
      }
    }
    // A create waits for the records it references once created, except in
    // the fields it leaves empty.
    for (const entry of entries) {
      if (entry.action !== 'create' || !entry.desired) continue;
      const deferred = new Set(entry.execution?.deferredFields);
      for (const reference of entry.desired.references)
        if (
          reference.kind === creationKind(entry.desired) &&
          !deferred.has(reference.root) &&
          this.records.get(reference.targetId)?.action === 'create'
        )
          this.graph.edge(
            'create',
            'record',
            entry.id,
            'record',
            reference.targetId,
            'seed-reference',
            reference.fieldId,
          );
    }
    // A published reference to a record that this plan publishes for the
    // first time waits for that publication. Creating a record in a model
    // without draft mode also publishes it, and every create precedes every
    // publication. Tree parents are ordered by the parent edges above.
    for (const entry of entries) {
      if (!WRITES.has(entry.action) || !entry.desired) continue;
      for (const reference of entry.desired.references) {
        if (
          reference.kind !== 'published' ||
          reference.targetId === entry.id ||
          reference.root === 'parentId'
        )
          continue;
        const dependency = this.records.get(reference.targetId);
        if (
          dependency &&
          WRITES.has(dependency.action) &&
          dependency.desired?.published &&
          !dependency.baseline?.published &&
          (dependency.action !== 'create' ||
            this.models.get(dependency.modelId)!.draftMode)
        )
          this.graph.edge(
            'publish',
            'record',
            entry.id,
            'record',
            dependency.id,
            'publication',
          );
      }
    }
    // Records referenced by a destination publication (tree parents
    // included) are unpublished only after the referrers' own publication
    // changes and moves release those references.
    for (const owner of entries) {
      if (owner.action !== 'update') continue;
      for (const reference of owner.baseline?.references ?? []) {
        if (reference.kind !== 'published' || reference.targetId === owner.id)
          continue;
        const dependency = this.records.get(reference.targetId);
        if (dependency?.action === 'update' && !dependency.desired?.published)
          this.graph.edge(
            'publish',
            'record',
            dependency.id,
            'record',
            owner.id,
            'publication-release',
          );
      }
    }
    // Deleted referrers and children go before the records they point to.
    for (const owner of entries) {
      if (owner.action !== 'delete') continue;
      for (const reference of owner.baseline?.references ?? []) {
        if (reference.kind === 'upload' || reference.targetId === owner.id)
          continue;
        if (this.records.get(reference.targetId)?.action === 'delete')
          this.graph.edge(
            'delete',
            'record',
            reference.targetId,
            'record',
            owner.id,
            'reference',
          );
      }
    }
    // Folder writes follow the depth of the complete final folder tree, so a
    // folder moves only after its new ancestors are in place, even through
    // folders that do not change.
    for (const entry of ordered(this.collections.values())) {
      if (!remains(entry)) continue;
      const state = WRITES.has(entry.action)
        ? entry.desired
        : this.target.collections.get(entry.id);
      if (!state) continue;
      this.graph.node(COLLECTION_WRITE_PHASE, 'collection', entry.id);
      if (state.parentId)
        this.graph.edge(
          COLLECTION_WRITE_PHASE,
          'collection',
          entry.id,
          'collection',
          state.parentId,
          'parent',
        );
    }
    for (const id of this.breakPublicationCycles())
      this.refuse(
        'record',
        id,
        'PUBLICATION_CYCLE',
        `Record ${id} is in a publication cycle that omitting top-level links cannot break, so no publication order exists.`,
      );
    // Refused publication cycles are planned again without their members.
    // Any other cycle comes from content the CMA judges when the diff runs,
    // so its members still get a deterministic order.
    for (const phase of RECORD_PHASES) {
      this.graph.order(phase, true);
      for (const rank of this.graph.ranks(phase)) {
        const entry = this.records.get(rank.id)!;
        entry.execution = { ...entry.execution, [`${phase}Order`]: rank.rank };
      }
    }
    this.graph.order(COLLECTION_WRITE_PHASE, true);
  }

  /**
   * Whether a first publication can leave `targets` out: only references
   * held directly in top-level link or links fields can be left out, so a
   * target also referenced from blocks, Structured Text or the tree parent
   * cannot.
   */
  canOmit(entry: RecordPlan, targets: ReadonlySet<string>): boolean {
    const model = this.models.get(entry.modelId)!;
    return entry.desired!.references.every(
      (reference) =>
        reference.kind !== 'published' ||
        !targets.has(reference.targetId) ||
        (reference.root !== 'parentId' && linkField(model, reference.fieldId)),
    );
  }

  // DatoCMS refuses to publish a record that links to an unpublished record, so
  // records that are new or unpublished in the destination and link to each
  // other cannot be published one after another as they are. Each such cycle
  // is broken by publishing some of its records first without their links to
  // the rest of the cycle, publishing the rest, and then publishing the first
  // ones again with those links restored. Only references held directly in
  // top-level link/links fields can be dropped; links inside blocks or
  // structured text are fixed. A child waiting for its tree parent's first
  // publication is only an ordering preference: in a cycle that cannot be
  // broken otherwise, that wait is dropped and the CMA judges the writes.
  // Returns the members of the cycles that cannot be broken.
  breakPublicationCycles(): string[] {
    // Planning reruns after each round of skips, so earlier breaks start over.
    for (const entry of this.records.values())
      if (entry.execution?.provisionalTargets) {
        const { provisionalTargets: _, ...execution } = entry.execution;
        entry.execution = execution;
      }
    if (!this.graph.order('publish')) return [];
    // Only the unresolved part of the graph is analysed: records in a cycle
    // and records waiting on one. An owner/dependency pair is breakable only
    // when every edge between them comes from a published reference held
    // directly in a top-level link or links field of the owner.
    const edges = new Map<string, Map<string, boolean>>();
    const publications = new Set<string>();
    const parents = new Map<string, boolean>();
    const linkFieldsOnly = (owner: string, dependency: string): boolean => {
      const entry = this.records.get(owner)!;
      const model = this.models.get(entry.modelId)!;
      return (this.source.records.get(owner)?.references ?? []).every(
        (reference) =>
          reference.kind !== 'published' ||
          reference.targetId !== dependency ||
          linkField(model, reference.fieldId),
      );
    };
    for (const { ownerId, dependencyId, reason } of this.graph.unresolvedEdges(
      'publish',
    )) {
      const dependencies = edges.get(ownerId) ?? new Map<string, boolean>();
      edges.set(ownerId, dependencies);
      dependencies.set(
        dependencyId,
        (dependencies.get(dependencyId) ?? true) &&
          reason === 'publication' &&
          linkFieldsOnly(ownerId, dependencyId),
      );
      const pair = `${ownerId}\0${dependencyId}`;
      if (reason === 'publication') publications.add(pair);
      parents.set(pair, (parents.get(pair) ?? true) && reason === 'parent');
    }
    // Pairs joined only by release or parent edges.
    const others = new Map<string, Map<string, boolean>>();
    for (const [owner, dependencies] of edges)
      for (const dependency of dependencies.keys())
        if (!publications.has(`${owner}\0${dependency}`)) {
          const pairs = others.get(owner) ?? new Map<string, boolean>();
          others.set(owner, pairs);
          pairs.set(dependency, false);
        }
    // A cycle without any publication dependency is no publication cycle:
    // the forced order ranks it and the CMA judges the writes. Its edges stay
    // in the graph but are left out of the analysis, so every cycle analysed
    // below involves a publication.
    for (const component of components(others)) {
      if (component.length < 2) continue;
      const members = new Set(component);
      for (const owner of component)
        for (const dependency of others.get(owner)?.keys() ?? [])
          if (members.has(dependency)) edges.get(owner)!.delete(dependency);
    }
    const unbreakable: string[] = [];
    const pending = components(edges).reverse();
    for (let component = pending.pop(); component; component = pending.pop()) {
      if (component.length < 2) continue;
      const members = new Set(component);
      const drops = cycleDrops(component, edges);
      // Commit only if every dropped link can be omitted, so a cycle is either
      // fully broken or refused as a whole.
      const omittable =
        !!drops &&
        [...drops].every(([owner, targets]) =>
          this.canOmit(this.records.get(owner)!, targets),
        );
      if (!omittable) {
        const remaining = new Map<string, Map<string, boolean>>();
        let dropped = false;
        for (const owner of component) {
          const pairs = new Map<string, boolean>();
          remaining.set(owner, pairs);
          for (const [dependency, breakable] of edges.get(owner) ?? []) {
            if (!members.has(dependency)) continue;
            if (!parents.get(`${owner}\0${dependency}`)) {
              pairs.set(dependency, breakable);
              continue;
            }
            dropped = true;
            edges.get(owner)!.delete(dependency);
            this.graph.removeEdges(
              'publish',
              owner,
              dependency,
              (reason) => reason === 'parent',
            );
          }
        }
        if (dropped) pending.push(...components(remaining).reverse());
        else unbreakable.push(...component);
        continue;
      }
      for (const [owner, targets] of drops!) {
        const entry = this.records.get(owner)!;
        entry.execution = {
          ...entry.execution,
          provisionalTargets: [...targets].sort(compareIds),
        };
        for (const target of targets)
          this.graph.removeEdges(
            'publish',
            owner,
            target,
            (reason) => reason === 'publication',
          );
      }
    }
    return unbreakable;
  }

  /**
   * Skips refused entries under --allow-partial, or fails on the first one.
   * A skip spreads only where it is structurally needed: to writes that
   * reference a skipped create, and to deletes of entries that the skipped
   * entry's retained destination state still references.
   */
  processRefusals(): boolean {
    const first = this.pending.peek();
    if (!first) return false;
    if (!this.options.allowPartial)
      throw new ContentError('UNSAFE_REQUESTED_CHANGE', first.message, {
        kind: first.kind,
        id: first.id,
        reason: first.code,
        dependencyId: first.dependencyId ?? null,
      });
    for (let row = this.pending.pop(); row; row = this.pending.pop()) {
      const entry = this.entry(row.kind, row.id);
      if (!entry) continue;
      const diagnostic: Diagnostic = { code: row.code, message: row.message };
      if (
        !entry.diagnostics.some(
          (existing) =>
            existing.code === diagnostic.code &&
            existing.message === diagnostic.message,
        )
      )
        entry.diagnostics.push(diagnostic);
      const created = entry.action === 'create';
      const alreadySkipped = entry.action === 'skip';
      entry.action = 'skip';
      if (entry.kind === 'record') entry.execution = undefined;
      if (alreadySkipped) continue;
      if (created && entry.kind === 'record')
        for (const owner of this.referrers(entry.id))
          this.refuse(
            'record',
            owner,
            'SKIPPED_DEPENDENCY',
            `Record ${owner} references skipped new record ${entry.id}.`,
            entry.id,
          );
      if (entry.inDestination)
        for (const dependency of this.retainedDependencies(entry))
          if (this.entry(dependency.kind, dependency.id)?.action === 'delete')
            this.refuse(
              dependency.kind,
              dependency.id,
              'PRESERVED_SKIP_DEPENDENCY',
              `${dependency.kind} ${dependency.id} must remain for skipped ${entry.kind} ${entry.id}.`,
              entry.id,
            );
    }
    return true;
  }

  /** Source records that reference a record (uploads aside), in ID order. */
  private referrers(id: string): string[] {
    if (!this.referrersById) {
      this.referrersById = new Map();
      for (const record of this.source.records.values())
        for (const reference of record.references) {
          if (reference.kind === 'upload') continue;
          const owners =
            this.referrersById.get(reference.targetId) ?? new Set();
          owners.add(record.id);
          this.referrersById.set(reference.targetId, owners);
        }
    }
    return [...(this.referrersById.get(id) ?? [])].sort(compareIds);
  }
  private referrersById?: Map<string, Set<string>>;

  /** What an entry's destination state references: records, uploads, folders. */
  *retainedDependencies(
    entry: PlanEntry,
  ): Generator<{ kind: Kind; id: string }> {
    if (entry.kind === 'record') {
      const seen = new Set<string>();
      for (const reference of [
        ...(this.target.records.get(entry.id)?.references ?? []),
      ].sort((a, b) => compareIds(a.targetId, b.targetId))) {
        const kind = reference.kind === 'upload' ? 'upload' : 'record';
        if (seen.has(`${kind}\0${reference.targetId}`)) continue;
        seen.add(`${kind}\0${reference.targetId}`);
        yield { kind, id: reference.targetId };
      }
      return;
    }
    const parent =
      entry.kind === 'upload'
        ? this.target.uploads.get(entry.id)?.collectionId
        : this.target.collections.get(entry.id)?.parentId;
    if (parent) yield { kind: 'collection', id: parent };
  }

  finish(): Plan {
    const counts = blankCounts();
    for (const entries of [this.records, this.uploads, this.collections])
      for (const entry of entries.values()) counts[entry.kind][entry.action]++;
    const { source, target } = this;
    // The diff carries the destination schema: it includes retained models,
    // and every managed and block model matches the source structure.
    return {
      metadata: {
        source: {
          siteId: source.schema.siteId,
          environmentId: source.schema.environmentId,
        },
        destination: {
          siteId: target.schema.siteId,
          environmentId: target.schema.environmentId,
        },
        schema: target.schema,
        options: {
          ...this.options,
          modelIds: [...new Set(this.options.modelIds)].sort(),
        },
        counts,
      },
      records: this.records,
      uploads: this.uploads,
      collections: this.collections,
      graph: this.graph,
    };
  }
}

/** Folder creates and updates, parents before children in the final tree. */
export function orderedCollectionWrites(plan: Plan): CollectionPlan[] {
  return plan.graph
    .ranks(COLLECTION_WRITE_PHASE)
    .map((rank) => plan.collections.get(rank.id)!)
    .filter((entry) => WRITES.has(entry.action));
}

export async function createPlan(
  source: SideIndex,
  target: SideIndex,
  options: PlanOptions,
): Promise<Plan> {
  const planning = new Planning(source, target, options);
  planning.planRecords();
  planning.planAssetScope();
  planning.planAssets();
  await planning.loadDetails();
  planning.payloadRefusals();
  planning.creationFields();
  // Each pass skips at least one refused mutation, and the orders are
  // recomputed without it.
  do planning.executionOrders();
  while (planning.processRefusals());
  return planning.finish();
}
