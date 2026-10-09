import {
  hashJson,
  object,
  recordReferences,
  referenceId,
  unsupportedRecordPayloadKey,
} from './codec';
import { compareIds } from './compare-ids';
import { ContentError } from './errors';
import { PlannerGraph, stronglyConnected } from './planner-graph';
import type { SnapshotStore } from './store';
import type {
  Action,
  CollectionPlan,
  CollectionState,
  Diagnostic,
  FieldSchema,
  JsonObject,
  JsonValue,
  Kind,
  ModelSchema,
  PlanCounts,
  PlanEntry,
  PlanMetadata,
  PlanOptions,
  RecordPlan,
  RecordState,
  SchemaState,
} from './types';

const MUTATIONS = new Set<Action>(['create', 'update', 'delete']);
const WRITES = new Set<Action>(['create', 'update']);
const RECORD_PHASES = ['create', 'publish', 'delete'] as const;
/** The graph phase that ranks folder creates and updates by final depth. */
export const COLLECTION_WRITE_PHASE = 'collection-write';

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

/** The top-level field a captured reference path belongs to. */
function rootField(path: string): string | undefined {
  return /^[^.[\]]+/.exec(path)?.[0];
}

/**
 * Removes references to `targets` from the top-level link and links fields of
 * a record's fields. Only those two field types can drop a reference without
 * editing nested content, so this returns null when a target is also
 * referenced anywhere else (inside blocks or structured text).
 */
function omitPublicationReferences(
  record: RecordState,
  fields: JsonObject,
  model: ModelSchema,
  schema: SchemaState,
  targets: ReadonlySet<string>,
): JsonObject | null {
  const omitted = structuredClone(fields);
  const omit = (field: FieldSchema, value: JsonValue): JsonValue => {
    if (field.type === 'link') {
      const target = referenceId(value);
      return target && targets.has(target) ? null : value;
    }
    return Array.isArray(value)
      ? value.filter((entry) => {
          const target = referenceId(entry);
          return !(target && targets.has(target));
        })
      : value;
  };
  for (const field of model.fields) {
    if (field.type !== 'link' && field.type !== 'links') continue;
    const value = omitted[field.apiKey];
    if (value === undefined) continue;
    omitted[field.apiKey] =
      field.localized && object(value)
        ? Object.fromEntries(
            Object.entries(value).map(([locale, entry]) => [
              locale,
              omit(field, entry),
            ]),
          )
        : omit(field, value);
  }
  const remaining = recordReferences(
    { ...record, current: omitted, published: null },
    schema,
  );
  return remaining.some(
    (reference) =>
      reference.kind === 'current' && targets.has(reference.targetId),
  )
    ? null
    : omitted;
}

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

/**
 * Compares the captured source and destination namespaces and turns the
 * difference into ordered work. The CMA validates every write when the
 * generated script runs, so planning predicts no acceptance: it refuses only
 * content its own serialization cannot reproduce, and otherwise decides the
 * order of writes and the shape of their payloads.
 */
class Planning {
  readonly graph: PlannerGraph;
  readonly models: Map<string, ModelSchema>;
  readonly selected: Set<string>;
  readonly sourceModels: Map<string, ModelSchema>;

  constructor(
    readonly store: SnapshotStore,
    readonly source: SchemaState,
    readonly target: SchemaState,
    readonly options: PlanOptions,
  ) {
    this.graph = new PlannerGraph(store.database);
    this.selected = new Set(options.modelIds);
    this.sourceModels = new Map(
      source.models.map((model) => [model.id, model]),
    );
    this.models = new Map(target.models.map((model) => [model.id, model]));
    store.database.exec(`
      CREATE TEMP TABLE IF NOT EXISTS planner_refusals(kind TEXT NOT NULL,id TEXT NOT NULL,code TEXT NOT NULL,message TEXT NOT NULL,dependency_id TEXT,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id,code,message)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_refusals_queue ON planner_refusals(done,kind,id);
      CREATE TEMP TABLE IF NOT EXISTS planner_asset_scope(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS planner_deferred_fields(owner_id TEXT NOT NULL,api_key TEXT NOT NULL,PRIMARY KEY(owner_id,api_key)) WITHOUT ROWID;
      DELETE FROM plan; DELETE FROM planner_refusals; DELETE FROM planner_asset_scope; DELETE FROM planner_deferred_fields;
      DELETE FROM planner_graph; DELETE FROM planner_nodes;
    `);
  }

  /** Queues a structural refusal of a requested mutation. */
  refuse(
    kind: Kind,
    id: string,
    code: string,
    message: string,
    dependencyId?: string,
  ): void {
    const plan = this.store.getPlan(kind, id);
    if (!plan || !MUTATIONS.has(plan.action)) return;
    this.store
      .prepared(
        'INSERT OR IGNORE INTO planner_refusals(kind,id,code,message,dependency_id) VALUES(?,?,?,?,?)',
      )
      .run(kind, id, code, message, dependencyId ?? null);
  }

  /** Rebuilds the reference index of both sides from the captured records. */
  indexReferences(): void {
    for (const side of ['source', 'target'] as const) {
      this.store.database.prepare('DELETE FROM refs WHERE side=?').run(side);
      const schema = side === 'source' ? this.source : this.target;
      for (const record of this.store.records(side))
        for (const reference of recordReferences(record, schema))
          this.store.putReference(side, reference);
    }
  }

  recordEntries(): void {
    for (const row of this.store.database
      .prepare(
        `SELECT id FROM records WHERE side IN ('source','target') GROUP BY id ORDER BY id`,
      )
      .iterate()) {
      const id = String(row.id);
      const source = this.store.getRecord('source', id);
      const target = this.store.getRecord('target', id);
      const managed = this.selected.has((source ?? target)!.modelId);
      if (!managed && !target) continue;
      // The hash leaves out the position: the emitter orders each changed
      // sibling group with one reorderRecords call, so a record that only
      // shifted within its group needs no entry of its own.
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
      this.store.putPlan(plan);
    }
  }

  /**
   * Uploads referenced by managed records on either side, or every upload,
   * plus the folders containing them and their ancestors.
   */
  assetScope(): void {
    if (this.options.uploads === 'all') {
      this.store.database.exec(`INSERT OR IGNORE INTO planner_asset_scope SELECT 'upload',id FROM uploads WHERE side IN ('source','target');
        INSERT OR IGNORE INTO planner_asset_scope SELECT 'collection',id FROM collections WHERE side IN ('source','target');`);
      return;
    }
    const add = this.store.database.prepare(
      'INSERT OR IGNORE INTO planner_asset_scope(kind,id) VALUES(?,?)',
    );
    for (const row of this.store.database
      .prepare(
        `SELECT DISTINCT r.target_id,p.model_id FROM refs r JOIN plan p ON p.kind='record' AND p.id=r.owner_id WHERE r.kind='upload'`,
      )
      .iterate())
      if (this.selected.has(String(row.model_id)))
        add.run('upload', row.target_id);
    for (const row of this.store.database
      .prepare(
        `SELECT DISTINCT u.collection_id FROM uploads u JOIN planner_asset_scope s ON s.kind='upload' AND s.id=u.id WHERE u.side IN ('source','target') AND u.collection_id IS NOT NULL`,
      )
      .iterate()) {
      let id: string | null = String(row.collection_id);
      while (id) {
        if (Number(add.run('collection', id).changes) === 0) break;
        const parent: CollectionState | undefined =
          this.store.getCollection('source', id) ??
          this.store.getCollection('target', id);
        id = parent?.parentId ?? null;
      }
    }
  }

  assetEntries(): void {
    const inScope = this.store.database.prepare(
      'SELECT 1 FROM planner_asset_scope WHERE kind=? AND id=?',
    );
    for (const kind of ['upload', 'collection'] as const) {
      const table = kind === 'upload' ? 'uploads' : 'collections';
      for (const row of this.store.database
        .prepare(
          `SELECT id FROM ${table} WHERE side IN ('source','target') GROUP BY id ORDER BY id`,
        )
        .iterate()) {
        const id = String(row.id);
        const [source, target] = (['source', 'target'] as const).map((side) =>
          kind === 'upload'
            ? this.store.getUpload(side, id)
            : this.store.getCollection(side, id),
        );
        const scoped = Boolean(inScope.get(kind, id));
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
        this.store.putPlan(plan);
      }
    }
  }

  /** Content the SDK would silently corrupt through a write and its response. */
  payloadRefusals(): void {
    for (const action of WRITES)
      for (const plan of this.store.planEntries('record', action)) {
        if (plan.kind !== 'record' || !plan.desired) continue;
        for (const slice of [plan.desired.current, plan.desired.published]) {
          if (!slice) continue;
          const key = unsupportedRecordPayloadKey(
            slice,
            plan.modelId,
            this.target,
          );
          if (key)
            this.refuse(
              'record',
              plan.id,
              'UNSUPPORTED_PAYLOAD_KEY',
              `Record ${plan.id} contains native field metadata at ${key} that the CMA client cannot safely preserve through writes and responses.`,
            );
        }
      }
  }

  /**
   * The fields each new record is created with. References to records that
   * do not exist yet when it is created are emptied; the full fields follow
   * in the publication and update phases.
   */
  creationFields(): void {
    this.graph.clear('creation-discovery');
    for (const entry of this.store.planEntries('record', 'create'))
      this.graph.node('creation-discovery', 'record', entry.id);
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id,r.field_id FROM refs r
      JOIN plan owner ON owner.kind='record' AND owner.id=r.owner_id AND owner.action='create'
      JOIN plan dependency ON dependency.kind='record' AND dependency.id=r.target_id AND dependency.action='create'
      WHERE r.side='source' AND r.kind=CASE WHEN json_extract(owner.data,'$.desired.published') IS NULL THEN 'current' ELSE 'published' END
      ORDER BY r.owner_id,r.target_id`)
      .iterate())
      this.graph.edge(
        'creation-discovery',
        'record',
        String(row.owner_id),
        'record',
        String(row.target_id),
        'seed-reference',
        String(row.field_id),
      );
    const defer = this.store.database.prepare(
      'INSERT OR IGNORE INTO planner_deferred_fields VALUES(?,?)',
    );
    if (this.graph.order('creation-discovery')) {
      // A creation cycle is broken like a publication cycle: its members are
      // ordered so that as few references as possible point to a member
      // created later, and only the fields holding those references are
      // emptied. A tree parent and a reference whose field cannot be
      // identified cannot be left out. Records that merely depend on a cycle
      // wait for it and keep their fields.
      const edges = new Map<string, Map<string, boolean>>();
      const roots = new Map<string, Set<string>>();
      for (const row of this.store.database
        .prepare(`SELECT r.owner_id,r.target_id,r.path,r.field_id,owner.model_id FROM refs r
        JOIN plan owner ON owner.kind='record' AND owner.id=r.owner_id
        JOIN planner_nodes o ON o.phase='creation-discovery' AND o.kind='record' AND o.id=r.owner_id AND o.done=0
        JOIN planner_nodes d ON d.phase='creation-discovery' AND d.kind='record' AND d.id=r.target_id AND d.done=0
        WHERE r.side='source' AND r.kind=CASE WHEN json_extract(owner.data,'$.desired.published') IS NULL THEN 'current' ELSE 'published' END
        ORDER BY r.owner_id,r.target_id`)
        .iterate()) {
        const owner = String(row.owner_id);
        const target = String(row.target_id);
        const root = row.field_id ? rootField(String(row.path)) : undefined;
        const breakable =
          !!root &&
          this.models
            .get(String(row.model_id))!
            .fields.some((candidate) => candidate.apiKey === root);
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
                defer.run(owner, root);
      }
    }
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id,r.field_id,r.path FROM refs r
      JOIN planner_deferred_fields d ON d.owner_id=r.owner_id
      WHERE r.side='source' AND (r.path=d.api_key OR substr(r.path,1,length(d.api_key)+1)=d.api_key||'.')`)
      .iterate())
      this.store
        .prepared(
          "DELETE FROM planner_graph WHERE phase='creation-discovery' AND owner_kind='record' AND owner_id=? AND dependency_kind='record' AND dependency_id=? AND field_id=?",
        )
        .run(row.owner_id, row.target_id, row.field_id);
    this.graph.order('creation-discovery');
    for (const entry of this.store.planEntries('record', 'create')) {
      if (entry.kind !== 'record' || !entry.desired) continue;
      const model = this.models.get(entry.modelId)!;
      const fields = structuredClone(
        entry.desired.published ?? entry.desired.current,
      );
      const slice = entry.desired.published ? 'published' : 'current';
      const deferred = new Set<string>();
      for (const row of this.store
        .prepared(
          'SELECT api_key FROM planner_deferred_fields WHERE owner_id=?',
        )
        .iterate(entry.id))
        deferred.add(String(row.api_key));
      for (const row of this.store
        .prepared(`SELECT r.path,r.target_id,p.model_id,p.action FROM refs r JOIN plan p ON p.kind='record' AND p.id=r.target_id
        WHERE r.side='source' AND r.owner_id=? AND r.kind=? AND r.field_id<>'' AND p.action IN ('create','update')`)
        .iterate(entry.id, slice)) {
        // Models without draft mode publish during create. An existing draft
        // is therefore unavailable to their seed until the publication phase,
        // just like a newly created draft. Keeping the reference could fail or
        // invoke the field's cascading publication strategy prematurely.
        if (
          row.action === 'update' &&
          (model.draftMode ||
            this.store.getRecord('target', String(row.target_id))?.published)
        )
          continue;
        const dependency = this.store
          .prepared(
            "SELECT done FROM planner_nodes WHERE phase='creation-discovery' AND kind='record' AND id=?",
          )
          .get(row.target_id);
        if (
          dependency?.done &&
          (model.draftMode || !this.models.get(String(row.model_id))?.draftMode)
        )
          continue;
        const root = rootField(String(row.path));
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
      for (const key of deferred) {
        const field = model.fields.find(
          (candidate) => candidate.apiKey === key,
        )!;
        const value = fields[key];
        if (field.localized && object(value)) {
          const locales: JsonObject = {};
          for (const locale of Object.keys(value))
            locales[locale] = creationEmptyValue(field.type);
          fields[key] = locales;
        } else fields[key] = creationEmptyValue(field.type);
      }
      entry.execution = { ...entry.execution, creationFields: fields };
      this.store.putPlan(entry);
    }
  }

  /** The final state of a record that remains in the destination. */
  finalRecord(entry: RecordPlan): RecordState | undefined {
    return WRITES.has(entry.action)
      ? entry.desired ?? undefined
      : this.store.getRecord('target', entry.id);
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
    for (const entry of this.store.planEntries('record')) {
      if (entry.kind !== 'record' || !MUTATIONS.has(entry.action)) continue;
      if (entry.action === 'delete') {
        this.graph.node('delete', 'record', entry.id);
        continue;
      }
      if (entry.action === 'create')
        this.graph.node('create', 'record', entry.id);
      this.graph.node('publish', 'record', entry.id);
      const desired = entry.desired!;
      if (!desired.parentId) continue;
      const parent = this.store.getPlan('record', desired.parentId) as
        | RecordPlan
        | undefined;
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
            ? (this.store.getPlan('record', state.parentId) as
                | RecordPlan
                | undefined)
            : undefined;
        }
      }
    }
    for (const entry of this.store.planEntries('record', 'create')) {
      if (entry.kind !== 'record' || !entry.desired) continue;
      const seed = {
        ...entry.desired,
        current:
          entry.execution?.creationFields ??
          entry.desired.published ??
          entry.desired.current,
        published: null,
      };
      for (const ref of recordReferences(seed, this.target))
        if (
          ref.kind === 'current' &&
          this.store.getPlan('record', ref.targetId)?.action === 'create'
        )
          this.graph.edge(
            'create',
            'record',
            entry.id,
            'record',
            ref.targetId,
            'seed-reference',
            ref.fieldId,
          );
    }
    // A published reference to a record that this plan publishes for the
    // first time waits for that publication. Creating a record in a model
    // without draft mode also publishes it, and every create precedes every
    // publication. Tree parents are ordered by the parent edges above.
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id FROM refs r
      JOIN planner_nodes a ON a.phase='publish' AND a.kind='record' AND a.id=r.owner_id
      JOIN plan dependency ON dependency.kind='record' AND dependency.id=r.target_id AND dependency.action IN ('create','update')
      WHERE r.side='source' AND r.kind='published' AND r.owner_id<>r.target_id AND r.path<>'parentId'
      AND json_extract(dependency.data,'$.desired.published') IS NOT NULL
      ORDER BY r.owner_id,r.target_id`)
      .iterate()) {
      const dependency = this.store.getPlan(
        'record',
        String(row.target_id),
      ) as RecordPlan;
      if (
        !dependency.baseline?.published &&
        (dependency.action !== 'create' ||
          this.models.get(dependency.modelId)!.draftMode)
      )
        this.graph.edge(
          'publish',
          'record',
          String(row.owner_id),
          'record',
          dependency.id,
          'publication',
        );
    }
    // Records referenced by a destination publication (tree parents
    // included) are unpublished only after the referrers' own publication
    // changes and moves release those references.
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id FROM refs r
      JOIN plan dependency ON dependency.kind='record' AND dependency.id=r.target_id AND dependency.action='update'
      JOIN plan owner ON owner.kind='record' AND owner.id=r.owner_id AND owner.action='update'
      WHERE r.side='target' AND r.kind='published' AND r.owner_id<>r.target_id AND json_extract(dependency.data,'$.desired.published') IS NULL
      ORDER BY r.target_id,r.owner_id`)
      .iterate())
      this.graph.edge(
        'publish',
        'record',
        String(row.target_id),
        'record',
        String(row.owner_id),
        'publication-release',
      );
    // Deleted referrers and children go before the records they point to.
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id FROM refs r JOIN plan a ON a.kind='record' AND a.id=r.owner_id AND a.action='delete'
      JOIN plan b ON b.kind='record' AND b.id=r.target_id AND b.action='delete' WHERE r.side='target' AND r.kind<>'upload' AND r.owner_id<>r.target_id ORDER BY r.target_id,r.owner_id`)
      .iterate())
      this.graph.edge(
        'delete',
        'record',
        String(row.target_id),
        'record',
        String(row.owner_id),
        'reference',
      );
    // Folder writes follow the depth of the complete final folder tree, so a
    // folder moves only after its new ancestors are in place, even through
    // folders that do not change.
    for (const entry of this.store.planEntries('collection')) {
      if (entry.kind !== 'collection' || !remains(entry)) continue;
      const state = WRITES.has(entry.action)
        ? entry.desired
        : this.store.getCollection('target', entry.id);
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
    // Any other cycle comes from content the CMA judges when the script runs,
    // so its members still get a deterministic order.
    for (const phase of RECORD_PHASES) {
      this.graph.order(phase, true);
      for (const rank of this.graph.ranks(phase)) {
        const entry = this.store.getPlan('record', rank.id) as RecordPlan;
        entry.execution = { ...entry.execution, [`${phase}Order`]: rank.rank };
        this.store.putPlan(entry);
      }
    }
    this.graph.order(COLLECTION_WRITE_PHASE, true);
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
    for (const row of this.store.database
      .prepare(
        "SELECT id FROM plan WHERE kind='record' AND json_extract(data,'$.execution.provisionalPublished') IS NOT NULL",
      )
      .all()) {
      const entry = this.store.getPlan('record', String(row.id)) as RecordPlan;
      const { provisionalPublished: _, ...execution } = entry.execution!;
      entry.execution = execution;
      this.store.putPlan(entry);
    }
    if (!this.graph.order('publish')) return [];
    // Only the unresolved part of the graph is loaded: records in a cycle and
    // records waiting on one. An owner/dependency pair is breakable only when
    // every edge between them comes from a published reference held directly
    // in a top-level link or links field of the owner.
    const edges = new Map<string, Map<string, boolean>>();
    const publications = new Set<string>();
    const parents = new Map<string, boolean>();
    const linkFieldsOnly = (owner: string, dependency: string): boolean =>
      this.store
        .prepared(`SELECT r.field_id,p.model_id FROM refs r JOIN plan p ON p.kind='record' AND p.id=r.owner_id
        WHERE r.side='source' AND r.kind='published' AND r.owner_id=? AND r.target_id=?`)
        .all(owner, dependency)
        .every((ref) =>
          this.models
            .get(String(ref.model_id))!
            .fields.some(
              (field) =>
                field.id === ref.field_id &&
                (field.type === 'link' || field.type === 'links'),
            ),
        );
    for (const row of this.store.database
      .prepare(`SELECT g.owner_id,g.dependency_id,g.reason FROM planner_graph g
      JOIN planner_nodes o ON o.phase=g.phase AND o.kind=g.owner_kind AND o.id=g.owner_id AND o.done=0
      JOIN planner_nodes d ON d.phase=g.phase AND d.kind=g.dependency_kind AND d.id=g.dependency_id AND d.done=0
      WHERE g.phase='publish' AND g.owner_kind='record' AND g.dependency_kind='record' AND g.owner_id<>g.dependency_id
      ORDER BY g.owner_id,g.dependency_id`)
      .iterate()) {
      const owner = String(row.owner_id);
      const dependency = String(row.dependency_id);
      const dependencies = edges.get(owner) ?? new Map<string, boolean>();
      edges.set(owner, dependencies);
      dependencies.set(
        dependency,
        (dependencies.get(dependency) ?? true) &&
          row.reason === 'publication' &&
          linkFieldsOnly(owner, dependency),
      );
      if (row.reason === 'publication')
        publications.add(`${owner}\0${dependency}`);
      parents.set(
        `${owner}\0${dependency}`,
        (parents.get(`${owner}\0${dependency}`) ?? true) &&
          row.reason === 'parent',
      );
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
      const provisional = new Map<string, JsonObject>();
      for (const [owner, targets] of drops ?? []) {
        const entry = this.store.getPlan('record', owner) as RecordPlan;
        const desired = entry.desired!;
        const fields = omitPublicationReferences(
          desired,
          desired.published!,
          this.models.get(entry.modelId)!,
          this.target,
          targets,
        );
        if (!fields) break;
        provisional.set(owner, fields);
      }
      if (!drops || provisional.size !== drops.size) {
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
            this.store
              .prepared(
                "DELETE FROM planner_graph WHERE phase='publish' AND owner_kind='record' AND owner_id=? AND dependency_kind='record' AND dependency_id=? AND reason='parent'",
              )
              .run(owner, dependency);
          }
        }
        if (dropped) pending.push(...components(remaining).reverse());
        else unbreakable.push(...component);
        continue;
      }
      for (const [owner, fields] of provisional) {
        const entry = this.store.getPlan('record', owner) as RecordPlan;
        entry.execution = { ...entry.execution, provisionalPublished: fields };
        this.store.putPlan(entry);
        for (const target of drops.get(owner)!)
          this.store
            .prepared(
              "DELETE FROM planner_graph WHERE phase='publish' AND owner_kind='record' AND owner_id=? AND dependency_kind='record' AND dependency_id=? AND reason='publication'",
            )
            .run(owner, target);
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
    const next = this.store.database.prepare(
      'SELECT * FROM planner_refusals WHERE done=0 ORDER BY kind,id,code LIMIT 1',
    );
    const first = next.get();
    if (!first) return false;
    if (!this.options.allowPartial)
      throw new ContentError('UNSAFE_REQUESTED_CHANGE', String(first.message), {
        kind: first.kind,
        id: first.id,
        reason: first.code,
        dependencyId: first.dependency_id,
      });
    const done = this.store.database.prepare(
      'UPDATE planner_refusals SET done=1 WHERE kind=? AND id=? AND code=? AND message=?',
    );
    for (let row: typeof first | undefined = first; row; row = next.get()) {
      done.run(row.kind, row.id, row.code, row.message);
      const entry = this.store.getPlan(row.kind as Kind, String(row.id));
      if (!entry) continue;
      const diagnostic: Diagnostic = {
        code: String(row.code),
        message: String(row.message),
      };
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
      this.store.putPlan(entry);
      if (alreadySkipped) continue;
      if (created && entry.kind === 'record')
        for (const owner of this.store
          .prepared(
            "SELECT DISTINCT owner_id FROM refs WHERE side='source' AND target_id=? AND kind<>'upload' ORDER BY owner_id",
          )
          .iterate(entry.id))
          this.refuse(
            'record',
            String(owner.owner_id),
            'SKIPPED_DEPENDENCY',
            `Record ${owner.owner_id} references skipped new record ${entry.id}.`,
            entry.id,
          );
      if (entry.inDestination)
        for (const dependency of this.retainedDependencies(entry))
          if (
            this.store.getPlan(dependency.kind, dependency.id)?.action ===
            'delete'
          )
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

  /** What an entry's destination state references: records, uploads, folders. */
  *retainedDependencies(
    entry: PlanEntry,
  ): Generator<{ kind: Kind; id: string }> {
    if (entry.kind === 'record') {
      for (const row of this.store
        .prepared(
          "SELECT DISTINCT target_id,kind FROM refs WHERE side='target' AND owner_id=? ORDER BY target_id",
        )
        .iterate(entry.id))
        yield {
          kind: row.kind === 'upload' ? 'upload' : 'record',
          id: String(row.target_id),
        };
      return;
    }
    const parent =
      entry.kind === 'upload'
        ? this.store.getUpload('target', entry.id)?.collectionId
        : this.store.getCollection('target', entry.id)?.parentId;
    if (parent) yield { kind: 'collection', id: parent };
  }

  finish(): PlanMetadata {
    const counts = blankCounts();
    for (const row of this.store.database
      .prepare(
        'SELECT kind,action,COUNT(*) AS count FROM plan GROUP BY kind,action',
      )
      .iterate())
      counts[row.kind as Kind][row.action as Action] = Number(row.count);
    // The artifact carries the destination schema: it includes retained
    // models, and every managed and block model matches the source structure.
    return {
      source: {
        siteId: this.source.siteId,
        environmentId: this.source.environmentId,
      },
      destination: {
        siteId: this.target.siteId,
        environmentId: this.target.environmentId,
      },
      schema: this.target,
      options: {
        ...this.options,
        modelIds: [...new Set(this.options.modelIds)].sort(),
      },
      counts,
    };
  }
}

/** Folder creates and updates, parents before children in the final tree. */
export function* orderedCollectionWrites(
  store: SnapshotStore,
): Generator<CollectionPlan> {
  for (const row of store.database
    .prepare(`SELECT p.data FROM planner_nodes n
    JOIN plan p ON p.kind='collection' AND p.id=n.id
    WHERE n.phase=? AND n.kind='collection' AND n.done=1
    AND p.action IN ('create','update') ORDER BY n.rank,p.id`)
    .iterate(COLLECTION_WRITE_PHASE))
    yield JSON.parse(String(row.data)) as CollectionPlan;
}

export function createPlan(
  store: SnapshotStore,
  sourceSchema: SchemaState,
  targetSchema: SchemaState,
  options: PlanOptions,
): PlanMetadata {
  // This private working database has no competing readers or network awaits.
  // One disk-backed transaction avoids a journal/fsync cycle for every index
  // and plan write while leaving no partially planned result after an error.
  return store.transaction(() => {
    const planning = new Planning(store, sourceSchema, targetSchema, options);
    planning.indexReferences();
    planning.recordEntries();
    planning.assetScope();
    planning.assetEntries();
    planning.payloadRefusals();
    planning.creationFields();
    // Each pass skips at least one refused mutation, and the orders are
    // recomputed without it.
    do planning.executionOrders();
    while (planning.processRefusals());
    return planning.finish();
  });
}
