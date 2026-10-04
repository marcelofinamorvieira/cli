import {
  hashJson,
  inspectRecord,
  object,
  recordGuard,
  unsupportedRecordPayloadKey,
} from './codec';
import { ContentError } from './errors';
import { PlannerGraph } from './planner-graph';
import {
  aggregateFields,
  creationEmptyValue,
  fieldFailures,
  fieldNeedsDefaultSuppression,
  provenFailures,
  suppressedDefaultValue,
} from './planner-validity';
import type { SnapshotStore } from './store';
import type {
  Action,
  BlockOwner,
  CollectionPlan,
  CollectionState,
  Diagnostic,
  FieldSchema,
  JsonObject,
  Kind,
  ModelSchema,
  PlanCounts,
  PlanEntry,
  PlanMetadata,
  PlanOptions,
  RecordPlan,
  RecordState,
  SchemaState,
  Side,
  TemporarySchemaChange,
} from './types';

const PORTABLE_ID = /^[A-Za-z0-9_-]{22}$/;
const MUTATIONS = new Set<Action>(['create', 'update', 'delete']);

function blankCounts(): PlanCounts {
  const actions = () => ({ create: 0, update: 0, delete: 0, noop: 0, skip: 0 });
  return { record: actions(), upload: actions(), collection: actions() };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function recordSafety(
  record: RecordState,
  schema: SchemaState,
): RecordPlan['safety'] {
  const inspection = inspectRecord(record, schema);
  return {
    currentReferences: sortedUnique(
      inspection.references
        .filter((ref) => ref.kind === 'current')
        .map((ref) => ref.targetId),
    ),
    publishedReferences: sortedUnique(
      inspection.references
        .filter((ref) => ref.kind === 'published')
        .map((ref) => ref.targetId),
    ),
    uploadReferences: sortedUnique(
      inspection.references
        .filter((ref) => ref.kind === 'upload')
        .map((ref) => ref.targetId),
    ),
    blockIds: sortedUnique(
      inspection.blockOwners.map((owner) => owner.blockId),
    ),
    desiredParentId: record.parentId,
    desiredPosition: record.position,
  };
}

function schemaCompatible(
  source: SchemaState,
  target: SchemaState,
  selected: Set<string>,
): void {
  const sourceModels = new Map(source.models.map((model) => [model.id, model]));
  for (const id of selected) {
    const model = sourceModels.get(id);
    if (!model || model.block)
      throw new ContentError(
        'INVALID_MODEL_SELECTION',
        `Selected model ${id} is not a source regular model.`,
      );
  }
  if (
    hashJson(source.locales) !== hashJson(target.locales) ||
    hashJson(source.semantics) !== hashJson(target.semantics) ||
    hashJson(source.workflows) !== hashJson(target.workflows)
  ) {
    throw new ContentError(
      'SCHEMA_INCOMPATIBLE',
      'Locales, site semantics, and workflows must match before content can be transferred.',
    );
  }
  const targetModels = new Map(target.models.map((model) => [model.id, model]));
  for (const model of source.models) {
    if (!selected.has(model.id) && !model.block) continue;
    const destination = targetModels.get(model.id);
    if (!destination || hashJson(model) !== hashJson(destination)) {
      throw new ContentError(
        'SCHEMA_INCOMPATIBLE',
        `Managed model ${model.apiKey} (${model.id}) must have identical source and destination schema.`,
        { modelId: model.id },
      );
    }
  }
}

class Planning {
  readonly graph: PlannerGraph;
  readonly models: Map<string, ModelSchema>;
  readonly fields: Map<string, { model: ModelSchema; field: FieldSchema }>;
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
    this.fields = new Map(
      target.models.flatMap((model) =>
        model.fields.map((field) => [field.id, { model, field }] as const),
      ),
    );
    store.database.exec(`
      DELETE FROM plan; DELETE FROM edges;
      CREATE TEMP TABLE IF NOT EXISTS planner_unsafe(kind TEXT NOT NULL,id TEXT NOT NULL,code TEXT NOT NULL,message TEXT NOT NULL,dependency_id TEXT,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id,code,message)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_unsafe_queue ON planner_unsafe(done,kind,id);
      CREATE TEMP TABLE IF NOT EXISTS planner_asset_scope(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS planner_effective_refs(owner_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,slice TEXT NOT NULL,field_id TEXT NOT NULL,PRIMARY KEY(owner_id,target_kind,target_id,slice,field_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_effective_refs_target ON planner_effective_refs(target_kind,target_id,owner_id);
      CREATE TEMP TABLE IF NOT EXISTS planner_effective_uniques(model_id TEXT NOT NULL,field_id TEXT NOT NULL,locale TEXT NOT NULL,slice TEXT NOT NULL,value TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(model_id,field_id,locale,slice,value,record_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_effective_uniques_record ON planner_effective_uniques(record_id,field_id,slice);
      CREATE TEMP TABLE IF NOT EXISTS planner_bad_block_owners(side TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(side,record_id)) WITHOUT ROWID;
      DELETE FROM planner_bad_block_owners;
      CREATE TEMP TABLE IF NOT EXISTS planner_unique_owners(side TEXT NOT NULL,model_id TEXT NOT NULL,field_id TEXT NOT NULL,locale TEXT NOT NULL,slice TEXT NOT NULL,value TEXT NOT NULL,owner_id TEXT NOT NULL,owner_count INTEGER NOT NULL,PRIMARY KEY(side,model_id,field_id,locale,slice,value)) WITHOUT ROWID;
      DELETE FROM planner_unique_owners;
      CREATE TEMP TABLE IF NOT EXISTS planner_temp_usage(field_id TEXT NOT NULL,record_id TEXT NOT NULL,validator TEXT NOT NULL,reason TEXT NOT NULL,suppress_default INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(field_id,record_id,validator,reason,suppress_default)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS planner_skipped_ordering(model_id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS planner_skipped_collection_groups(parent_id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS planner_deferred_fields(owner_id TEXT NOT NULL,api_key TEXT NOT NULL,PRIMARY KEY(owner_id,api_key)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS planner_positions(model_id TEXT NOT NULL,parent_id TEXT NOT NULL,position REAL NOT NULL,id TEXT NOT NULL,PRIMARY KEY(model_id,parent_id,position,id)) WITHOUT ROWID;
      DELETE FROM planner_skipped_ordering; DELETE FROM planner_skipped_collection_groups; DELETE FROM planner_positions; DELETE FROM planner_deferred_fields;
      DELETE FROM planner_unsafe; DELETE FROM planner_asset_scope; DELETE FROM planner_effective_refs; DELETE FROM planner_effective_uniques; DELETE FROM planner_temp_usage;
      DELETE FROM planner_graph; DELETE FROM planner_nodes;
    `);
  }

  unsafe(
    kind: Kind,
    id: string,
    code: string,
    message: string,
    dependencyId?: string,
  ): void {
    const plan = this.store.getPlan(kind, id);
    if (!plan || !MUTATIONS.has(plan.action)) return;
    this.store.database
      .prepare(
        'INSERT OR IGNORE INTO planner_unsafe(kind,id,code,message,dependency_id) VALUES(?,?,?,?,?)',
      )
      .run(kind, id, code, message, dependencyId ?? null);
  }

  relaxation(
    recordId: string,
    fieldId: string,
    validator: string,
    reason: string,
    suppressDefault = false,
  ): void {
    if (!this.options.allowTemporarySchemaChanges) {
      this.unsafe(
        'record',
        recordId,
        'TEMPORARY_SCHEMA_CHANGE_REQUIRED',
        reason,
      );
      return;
    }
    if (!this.fields.has(fieldId))
      throw new ContentError(
        'SCHEMA_INCOMPATIBLE',
        `Field ${fieldId} is missing from the destination schema.`,
      );
    this.store.database
      .prepare(
        'INSERT OR IGNORE INTO planner_temp_usage(field_id,record_id,validator,reason,suppress_default) VALUES(?,?,?,?,?)',
      )
      .run(fieldId, recordId, validator, reason, suppressDefault ? 1 : 0);
  }

  indexRecords(): void {
    // Capture indexes are disposable. Rebuild them from authoritative expanded
    // aggregate content so a caller cannot accidentally omit dependency proofs.
    for (const side of ['source', 'target'] as const) {
      for (const table of ['refs', 'block_owners', 'unique_values'])
        this.store.database
          .prepare(`DELETE FROM ${table} WHERE side=?`)
          .run(side);
      const schema = side === 'source' ? this.source : this.target;
      for (const record of this.store.records(side)) {
        const inspection = inspectRecord(record, schema);
        const blockIds = new Set<string>();
        for (const owner of inspection.blockOwners) {
          const key = `${owner.slice}/${owner.blockId}`;
          if (blockIds.has(key))
            this.store.database
              .prepare(
                'INSERT OR IGNORE INTO planner_bad_block_owners VALUES(?,?)',
              )
              .run(side, record.id);
          blockIds.add(key);
        }
        for (const reference of inspection.references)
          this.store.putReference(side, reference);
        for (const owner of inspection.blockOwners)
          this.store.putBlockOwner(side, owner);
        for (const value of inspection.uniqueValues)
          this.store.putUniqueValue(side, value);
      }
    }
  }

  initialRecords(): void {
    for (const row of this.store.database
      .prepare(
        `SELECT id FROM records WHERE side IN ('source','target') GROUP BY id ORDER BY id`,
      )
      .iterate()) {
      const id = String(row.id);
      const source = this.store.getRecord('source', id);
      const target = this.store.getRecord('target', id);
      if (source && target && source.modelId !== target.modelId)
        throw new ContentError(
          'IDENTITY_CONFLICT',
          `Record ${id} has different source and destination models.`,
        );
      const managed = this.selected.has((source ?? target)!.modelId);
      if (!managed && !target) continue;
      const desired = managed ? source : target;
      const action: Action = !managed
        ? 'noop'
        : !target
          ? 'create'
          : !source
            ? this.options.includeDeletions
              ? 'delete'
              : 'noop'
            : source.hash === target.hash && source.position === target.position
              ? 'noop'
              : 'update';
      const record = desired ?? target!;
      const diagnostics: Diagnostic[] = [];
      if (!source && target && !this.sourceModels.has(target.modelId))
        diagnostics.push({
          code: 'RETAINED_DESTINATION_MODEL',
          message: `Record ${id} belongs to a destination-only model and is retained.`,
        });
      if (!source && action === 'noop' && managed)
        diagnostics.push({
          code: 'DELETIONS_DISABLED',
          message: `Destination-only record ${id} is retained because deletions are disabled.`,
        });
      const plan: RecordPlan = {
        kind: 'record',
        id,
        modelId: record.modelId,
        action,
        guard: target ? recordGuard(target) : null,
        safety: recordSafety(
          record,
          managed && source ? this.source : this.target,
        ),
        diagnostics,
      };
      if (action !== 'noop') {
        plan.baseline = target ?? null;
        plan.desired = source ?? null;
      }
      this.store.putPlan(plan);
    }
  }

  assetScope(): void {
    const add = this.store.database.prepare(
      'INSERT OR IGNORE INTO planner_asset_scope(kind,id) VALUES(?,?)',
    );
    if (this.options.uploads === 'all') {
      this.store.database.exec(`INSERT OR IGNORE INTO planner_asset_scope SELECT 'upload',id FROM uploads WHERE side IN ('source','target');
        INSERT OR IGNORE INTO planner_asset_scope SELECT 'collection',id FROM collections WHERE side IN ('source','target');`);
      return;
    }
    // Scope comes from managed aggregates on both sides; all other captures
    // provide preservation evidence, rather than mutation authority.
    for (const row of this.store.database
      .prepare(
        `SELECT DISTINCT r.target_id FROM refs r JOIN plan p ON p.kind='record' AND p.id=r.owner_id WHERE r.kind='upload'`,
      )
      .iterate()) {
      // The indexed EXISTS below avoids incorrectly selecting an upload merely
      // because an unrelated preservation aggregate references the same ID.
      if (row.target_id) {
        const owners = this.store.database.prepare(
          `SELECT DISTINCT p.model_id FROM refs r JOIN plan p ON p.kind='record' AND p.id=r.owner_id WHERE r.side IN ('source','target') AND r.kind='upload' AND r.target_id=?`,
        );
        for (const owner of owners.iterate(row.target_id))
          if (this.selected.has(String(owner.model_id))) {
            add.run('upload', row.target_id);
            break;
          }
      }
    }
    for (const row of this.store.database
      .prepare(
        `SELECT DISTINCT u.collection_id FROM uploads u JOIN planner_asset_scope s ON s.kind='upload' AND s.id=u.id WHERE u.side IN ('source','target') AND u.collection_id IS NOT NULL`,
      )
      .iterate()) {
      let id: string | null = String(row.collection_id);
      while (id) {
        if (Number(add.run('collection', id).changes) === 0) break;
        const parent: { parentId: string | null } | undefined =
          this.store.getCollection('source', id) ??
          this.store.getCollection('target', id);
        id = parent?.parentId ?? null;
      }
    }
  }

  initialAssets(): void {
    for (const kind of ['upload', 'collection'] as const) {
      const table = kind === 'upload' ? 'uploads' : 'collections';
      for (const row of this.store.database
        .prepare(
          `SELECT id FROM ${table} WHERE side IN ('source','target') GROUP BY id ORDER BY id`,
        )
        .iterate()) {
        const id = String(row.id);
        const source =
          kind === 'upload'
            ? this.store.getUpload('source', id)
            : this.store.getCollection('source', id);
        const target =
          kind === 'upload'
            ? this.store.getUpload('target', id)
            : this.store.getCollection('target', id);
        const inScope = Boolean(
          this.store.database
            .prepare('SELECT 1 FROM planner_asset_scope WHERE kind=? AND id=?')
            .get(kind, id),
        );
        if (!inScope && !target) continue;
        const action: Action = !inScope
          ? 'noop'
          : !target
            ? 'create'
            : !source
              ? this.options.includeDeletions
                ? 'delete'
                : 'noop'
              : source.hash === target.hash
                ? 'noop'
                : 'update';
        const plan = {
          kind,
          id,
          action,
          guard: target ? { hash: target.hash } : null,
          diagnostics: [],
        } as PlanEntry;
        if (action !== 'noop')
          Object.assign(plan, {
            baseline: target ?? null,
            desired: source ?? null,
          });
        this.store.putPlan(plan);
        if (
          kind === 'collection' &&
          (action === 'create' || action === 'update') &&
          !Number.isSafeInteger((source as CollectionState).position)
        )
          this.unsafe(
            'collection',
            id,
            'UNSUPPORTED_COLLECTION_POSITION',
            `Collection ${id} has no authoritative integer position.`,
          );
        if (action === 'create' && !PORTABLE_ID.test(id))
          this.unsafe(
            kind,
            id,
            'UNSUPPORTED_LEGACY_ID',
            `${kind} ${id} cannot be created with its nonportable source identity.`,
          );
      }
    }
  }

  basicSafety(): void {
    for (const plan of this.store.planEntries('record')) {
      if (
        plan.kind !== 'record' ||
        !['create', 'update'].includes(plan.action) ||
        !plan.desired
      )
        continue;
      const desired = plan.desired;
      if (
        this.store.database
          .prepare(
            "SELECT 1 FROM planner_bad_block_owners WHERE side='source' AND record_id=?",
          )
          .get(plan.id)
      )
        this.unsafe(
          'record',
          plan.id,
          'DUPLICATE_BLOCK_OWNERSHIP',
          `Record ${plan.id} repeats a block identity within one captured slice; that ownership cannot be reproduced safely.`,
        );
      const model = this.models.get(desired.modelId)!;
      this.localeStructure(plan);
      if (plan.action === 'update' && !plan.baseline?.currentVersion)
        this.unsafe(
          'record',
          plan.id,
          'MISSING_CONCURRENCY_VERSION',
          `Record ${plan.id} has no destination current version for an optimistic update guard.`,
        );
      if (plan.action === 'create' && !PORTABLE_ID.test(plan.id))
        this.unsafe(
          'record',
          plan.id,
          'UNSUPPORTED_LEGACY_ID',
          `Record ${plan.id} cannot be created with its nonportable source identity.`,
        );
      if (
        plan.action === 'create' &&
        this.store.database
          .prepare(
            "SELECT 1 FROM block_owners WHERE side='target' AND block_id=? LIMIT 1",
          )
          .get(plan.id)
      )
        throw new ContentError(
          'IDENTITY_CONFLICT',
          `Record ${plan.id} would reuse an existing destination block identity.`,
        );
      for (const owner of this.store.blockOwners('source', plan.id)) {
        if (this.store.getRecord('target', owner.blockId))
          throw new ContentError(
            'IDENTITY_CONFLICT',
            `Block ${owner.blockId} would reuse an existing destination record identity.`,
          );
        const exists = this.store.database
          .prepare(
            `SELECT 1 FROM block_owners WHERE side='target' AND block_id=? LIMIT 1`,
          )
          .get(owner.blockId);
        if (!exists && !PORTABLE_ID.test(owner.blockId))
          this.unsafe(
            'record',
            plan.id,
            'UNSUPPORTED_LEGACY_BLOCK_ID',
            `Nested block ${owner.blockId} cannot be created with its nonportable source identity.`,
          );
      }
      for (const slice of [desired.current, desired.published]) {
        if (!slice) continue;
        const unsupportedKey = unsupportedRecordPayloadKey(
          slice,
          model.id,
          this.target,
        );
        if (unsupportedKey)
          this.unsafe(
            'record',
            plan.id,
            'UNSUPPORTED_PAYLOAD_KEY',
            `Record ${plan.id} contains native field metadata at ${unsupportedKey} that the CMA client cannot safely preserve through writes and responses.`,
          );
        for (const value of aggregateFields(slice, model, this.target)) {
          if (
            !value.blockId ||
            !fieldNeedsDefaultSuppression(value.field, value.value)
          )
            continue;
          if (
            !this.store.database
              .prepare(
                "SELECT 1 FROM block_owners WHERE side='target' AND block_id=? LIMIT 1",
              )
              .get(value.blockId)
          )
            this.relaxation(
              plan.id,
              value.field.id,
              '',
              `Record ${plan.id} needs the default of ${value.field.apiKey} suppressed to preserve null on a newly created nested block.`,
              true,
            );
        }
      }
      if (!model.draftMode && !desired.published)
        this.unsafe(
          'record',
          plan.id,
          'UNSUPPORTED_DRAFT_STATE',
          `Record ${plan.id} is unpublished in a model without draft mode.`,
        );
      if (
        !model.draftMode &&
        hashJson(desired.current) !== hashJson(desired.published)
      )
        this.unsafe(
          'record',
          plan.id,
          'UNSUPPORTED_PUBLICATION_STATE',
          `Record ${plan.id} has distinct current and published values in a model without draft mode.`,
        );
      if (desired.published && !desired.firstPublishedAt)
        this.unsafe(
          'record',
          plan.id,
          'MISSING_PUBLICATION_TIMESTAMP',
          `Published record ${plan.id} has no first publication timestamp.`,
        );
      if (
        (model.tree || model.sortable) &&
        (desired.position === null || !Number.isSafeInteger(desired.position))
      )
        this.unsafe(
          'record',
          plan.id,
          'UNSUPPORTED_POSITION',
          `Ordered record ${plan.id} has no authoritative integer position.`,
        );
      if (
        !desired.validity.current &&
        !(model.draftMode && model.saveInvalidDrafts)
      )
        this.invalidSlice(plan, desired.current, 'current');
      // Validator changes do not necessarily revalidate stored CMA versions.
      // A grandfathered record can report valid while its copied values now
      // violate required/length/range/enum. Prove those failures directly for
      // every written slice instead of trusting metadata as a validation probe.
      for (const slice of ['current', 'published'] as const) {
        const fields = desired[slice];
        if (!fields) continue;
        if (slice === 'current' && model.draftMode && model.saveInvalidDrafts)
          continue;
        for (const failure of provenFailures(fields, model, this.target))
          this.relaxation(
            plan.id,
            failure.field.id,
            failure.validator,
            `Record ${plan.id} has a proven ${failure.validator} failure on ${failure.field.apiKey} in its desired ${slice} values, regardless of stored validity metadata.`,
          );
      }
      if (desired.published && desired.validity.published === false)
        this.invalidSlice(plan, desired.published, 'published');
      if (desired.published && desired.validity.published === null)
        this.unsafe(
          'record',
          plan.id,
          'UNPROVEN_PUBLICATION_VALIDITY',
          `Record ${plan.id} has no authoritative published validity.`,
        );
      if (desired.stage && !model.workflowId)
        this.unsafe(
          'record',
          plan.id,
          'UNSUPPORTED_WORKFLOW_STAGE',
          `Record ${plan.id} has a workflow stage in a model without a workflow.`,
        );
      if (desired.stage && model.workflowId) {
        const workflow = this.target.workflows.find(
          (entry) => entry.id === model.workflowId,
        );
        if (
          !workflow ||
          !Array.isArray(workflow.stages) ||
          !workflow.stages.some(
            (stage) =>
              stage !== null &&
              typeof stage === 'object' &&
              !Array.isArray(stage) &&
              stage.id === desired.stage,
          )
        )
          this.unsafe(
            'record',
            plan.id,
            'UNSUPPORTED_WORKFLOW_STAGE',
            `Record ${plan.id} has an unrecognized workflow stage.`,
          );
      }
      if (desired.schedules.publication) {
        const scope = desired.schedules.publication.selective;
        if (
          !Number.isFinite(Date.parse(desired.schedules.publication.at)) ||
          Date.parse(desired.schedules.publication.at) <= Date.now()
        )
          this.unsafe(
            'record',
            plan.id,
            'EXPIRED_SCHEDULE',
            `Record ${plan.id} has a publication schedule that is not a future date.`,
          );
        if (
          scope &&
          (scope.locales.some(
            (locale) => !this.target.locales.includes(locale),
          ) ||
            (!scope.nonLocalized && scope.locales.length === 0))
        )
          this.unsafe(
            'record',
            plan.id,
            'UNSUPPORTED_SCHEDULE_SCOPE',
            `Record ${plan.id} has an invalid selective publication scope.`,
          );
        this.checkScheduledPublication(plan, desired);
      }
      if (
        desired.schedules.unpublishing &&
        (!Number.isFinite(Date.parse(desired.schedules.unpublishing.at)) ||
          Date.parse(desired.schedules.unpublishing.at) <= Date.now())
      )
        this.unsafe(
          'record',
          plan.id,
          'EXPIRED_SCHEDULE',
          `Record ${plan.id} has an unpublishing schedule that is not a future date.`,
        );
      if (
        desired.schedules.unpublishing?.locales?.some(
          (locale) => !this.target.locales.includes(locale),
        )
      )
        this.unsafe(
          'record',
          plan.id,
          'UNSUPPORTED_SCHEDULE_SCOPE',
          `Record ${plan.id} has an invalid unpublishing locale scope.`,
        );
    }
    for (const model of this.models.values()) {
      if (!model.singleton || !this.selected.has(model.id)) continue;
      const source = this.store.database
        .prepare(
          `SELECT id FROM records WHERE side='source' AND model_id=? LIMIT 2`,
        )
        .all(model.id);
      const target = this.store.database
        .prepare(
          `SELECT id FROM records WHERE side='target' AND model_id=? LIMIT 2`,
        )
        .all(model.id);
      if (source.length > 1 || target.length > 1)
        throw new ContentError(
          'SINGLETON_CONFLICT',
          `Singleton model ${model.apiKey} contains more than one record.`,
        );
      if (source[0] && target[0] && source[0].id !== target[0].id) {
        for (const row of [...source, ...target])
          this.unsafe(
            'record',
            String(row.id),
            'SINGLETON_IDENTITY_MISMATCH',
            `Singleton model ${model.apiKey} has different source and destination record identities.`,
          );
        this.graph.edge(
          'dependency',
          'record',
          String(source[0].id),
          'record',
          String(target[0].id),
          'singleton',
        );
        this.graph.edge(
          'dependency',
          'record',
          String(target[0].id),
          'record',
          String(source[0].id),
          'singleton',
        );
      }
    }
  }

  scheduledFailures(record: RecordState): ReturnType<typeof provenFailures> {
    if (!record.schedules.publication) return [];
    const model = this.models.get(record.modelId)!;
    const enforces =
      (model.draftMode && model.saveInvalidDrafts) ||
      this.target.semantics.improved_validation_at_publishing === true;
    if (!enforces) return [];
    // Native invalid-draft models validate selective scope values directly.
    // Other enforced schedules use overall current validity, so every current
    // field must be refreshable under restored validators before recreation.
    const scope =
      model.draftMode && model.saveInvalidDrafts
        ? record.schedules.publication.selective
        : null;
    const scopeFields: JsonObject = {};
    const scopeModel = {
      ...model,
      fields: model.fields.filter(
        (field) =>
          !scope ||
          (field.localized ? scope.locales.length > 0 : scope.nonLocalized),
      ),
    };
    for (const field of scopeModel.fields) {
      const value = record.current[field.apiKey] ?? null;
      if (scope && field.localized && object(value)) {
        const locales: JsonObject = {};
        for (const locale of scope.locales)
          locales[locale] = (value as JsonObject)[locale] ?? null;
        scopeFields[field.apiKey] = locales;
      } else scopeFields[field.apiKey] = value;
    }
    const failures = provenFailures(scopeFields, scopeModel, this.target);
    // A valid record can be scheduled and later edited into a duplicate draft.
    // That native state exists, but its schedule cannot be recreated after the
    // managed cancellation phase. Check effective peers, including retained
    // destination records and baselines restored by partial skips.
    for (const value of inspectRecord(
      { ...record, current: scopeFields, published: null },
      {
        ...this.target,
        models: this.target.models.map((entry) =>
          entry.id === model.id ? scopeModel : entry,
        ),
      },
    ).uniqueValues) {
      let duplicate = false;
      for (const side of ['source', 'target']) {
        duplicate = Boolean(
          this.store.database
            .prepare(`SELECT 1 FROM unique_values peer
          JOIN plan p ON p.kind='record' AND p.id=peer.record_id
          WHERE peer.side=? AND peer.model_id=? AND peer.field_id=? AND peer.locale=?
          AND peer.slice='current' AND peer.value=? AND peer.record_id<>?
          AND p.action IN (${
            side === 'source' ? "'create','update'" : "'noop','skip'"
          }) LIMIT 1`)
            .get(
              side,
              value.modelId,
              value.fieldId,
              value.locale,
              value.valueKey,
              record.id,
            ),
        );
        if (duplicate) break;
      }
      if (duplicate)
        failures.push({
          field: this.fields.get(value.fieldId)!.field,
          modelId: value.modelId,
          validator: 'unique',
        });
    }
    return failures;
  }

  checkScheduledPublication(plan: RecordPlan, record: RecordState): void {
    const failures = this.scheduledFailures(record);
    if (!failures.length) return;
    if (plan.action === 'noop') {
      const fields = sortedUnique(
        failures.map(
          (failure) => `${failure.field.apiKey} (${failure.validator})`,
        ),
      ).join(', ');
      throw new ContentError(
        'UNEXECUTABLE_EXISTING_SCHEDULE',
        `Managed unchanged record ${plan.id} has an existing enforced publication schedule whose selected values fail ${fields}. The CMA cannot reliably recreate this schedule under the restored validators.`,
        { id: plan.id, scope: record.schedules.publication?.selective },
      );
    }
    this.unsafe(
      'record',
      plan.id,
      'INVALID_SCHEDULED_PUBLICATION',
      `Record ${plan.id} schedules publication of values with proven validator failures in the requested scope; its schedule cannot be recreated under the restored validators.`,
    );
  }

  checkNoopSchedules(): void {
    // Run only after partial-skip closure and only when the final plan writes.
    // A verification-only run leaves these existing schedules intact.
    for (const plan of this.store.planEntries('record', 'noop')) {
      if (
        plan.kind !== 'record' ||
        !this.selected.has(plan.modelId) ||
        !plan.guard?.schedules.publication
      )
        continue;
      const record = this.store.getRecord('target', plan.id)!;
      this.checkScheduledPublication(plan, record);
      const model = this.models.get(plan.modelId)!;
      const stampRequired =
        (model.saveInvalidDrafts ||
          this.target.semantics.improved_validation_at_publishing === true) &&
        !(model.saveInvalidDrafts && record.schedules.publication?.selective);
      if (!stampRequired || record.validity.current) continue;
      const key = unsupportedRecordPayloadKey(
        record.current,
        model.id,
        this.target,
      );
      if (key)
        throw new ContentError(
          'UNEXECUTABLE_EXISTING_SCHEDULE',
          `Managed unchanged record ${plan.id} needs a current-content validity refresh before its publication schedule can be restored, but native field metadata named ${key} cannot be rewritten safely by the CMA client.`,
          { id: plan.id, reason: 'UNSUPPORTED_PAYLOAD_KEY', key },
        );
    }
  }

  localeStructure(plan: RecordPlan): void {
    for (const fields of [plan.desired!.current, plan.desired!.published]) {
      if (!fields) continue;
      const keys = new Map<string, string>();
      for (const value of aggregateFields(
        fields,
        this.models.get(plan.modelId)!,
        this.target,
      )) {
        if (!value.field.localized) continue;
        if (!object(value.value)) {
          this.unsafe(
            'record',
            plan.id,
            'UNSUPPORTED_LOCALE_MAP',
            `Record ${plan.id} has a localized field without an explicit locale map.`,
          );
          continue;
        }
        const locales = Object.keys(value.value).sort();
        if (
          locales.some((locale) => !this.target.locales.includes(locale)) ||
          (this.models.get(value.modelId)!.allLocalesRequired &&
            hashJson(locales) !== hashJson([...this.target.locales].sort()))
        )
          this.unsafe(
            'record',
            plan.id,
            'UNSUPPORTED_LOCALE_KEYS',
            `Record ${plan.id} has locale keys that cannot be saved under the destination model settings.`,
          );
        const owner = `${value.modelId}/${value.blockId ?? plan.id}`;
        const encoded = hashJson(locales);
        if (keys.has(owner) && keys.get(owner) !== encoded)
          this.unsafe(
            'record',
            plan.id,
            'INCONSISTENT_LOCALE_KEYS',
            `Record ${plan.id} has inconsistent present locale keys across localized fields.`,
          );
        keys.set(owner, encoded);
      }
    }
  }

  invalidSlice(
    plan: RecordPlan,
    fields: JsonObject,
    slice: 'current' | 'published',
  ): void {
    const known = new Set([
      'required',
      'length',
      'size',
      'number_range',
      'enum',
      'unique',
    ]);
    for (const value of aggregateFields(
      fields,
      this.models.get(plan.modelId)!,
      this.target,
    )) {
      if (Object.keys(value.field.validators).some((key) => !known.has(key)))
        this.unsafe(
          'record',
          plan.id,
          'UNPROVEN_VALIDATION_FAILURE',
          `Record ${plan.id} has a reported invalid ${slice} slice with unsupported validators; exact executable validator changes cannot be proven locally.`,
        );
    }
    // Flags are asynchronously computed CMA metadata, not transplantable
    // content. A stale false flag with no actual proven failures is not an
    // instruction to make the new version invalid. The common all-slice pass
    // diagnoses and narrowly relaxes its actual known value failures.
  }

  dependencies(): void {
    const duplicate = this.store.database
      .prepare(
        "SELECT record_id FROM planner_bad_block_owners WHERE side='target' LIMIT 1",
      )
      .get();
    if (duplicate)
      throw new ContentError(
        'BLOCK_OWNERSHIP_CONFLICT',
        `Destination record ${duplicate.record_id} repeats a block identity within one captured slice.`,
      );
    const ambiguous = this.store.database
      .prepare(
        "SELECT block_id,slice FROM block_owners WHERE side='target' GROUP BY block_id,slice HAVING COUNT(*)>1 LIMIT 1",
      )
      .get();
    if (ambiguous)
      throw new ContentError(
        'BLOCK_OWNERSHIP_CONFLICT',
        `Destination block ${ambiguous.block_id} has multiple owners in its ${ambiguous.slice} slice.`,
      );
    for (const side of ['source', 'target'] as const) {
      for (const row of this.store.database
        .prepare(
          'SELECT owner_id,target_id,kind,field_id FROM refs WHERE side=? ORDER BY owner_id,target_id',
        )
        .iterate(side)) {
        const ownerId = String(row.owner_id);
        const targetKind: Kind = row.kind === 'upload' ? 'upload' : 'record';
        const targetId = String(row.target_id);
        this.graph.edge(
          side === 'source' ? 'dependency' : 'preservation',
          'record',
          ownerId,
          targetKind,
          targetId,
          'reference',
          String(row.field_id),
        );
      }
      for (const row of this.store.database
        .prepare(
          'SELECT id,parent_id FROM records WHERE side=? AND parent_id IS NOT NULL ORDER BY id',
        )
        .iterate(side))
        this.graph.edge(
          side === 'source' ? 'dependency' : 'preservation',
          'record',
          String(row.id),
          'record',
          String(row.parent_id),
          'parent',
        );
      for (const row of this.store.database
        .prepare(
          'SELECT id,collection_id FROM uploads WHERE side=? AND collection_id IS NOT NULL ORDER BY id',
        )
        .iterate(side))
        this.graph.edge(
          side === 'source' ? 'dependency' : 'preservation',
          'upload',
          String(row.id),
          'collection',
          String(row.collection_id),
          'collection',
        );
      for (const row of this.store.database
        .prepare(
          'SELECT id,parent_id FROM collections WHERE side=? AND parent_id IS NOT NULL ORDER BY id',
        )
        .iterate(side))
        this.graph.edge(
          side === 'source' ? 'dependency' : 'preservation',
          'collection',
          String(row.id),
          'collection',
          String(row.parent_id),
          'parent',
        );
    }
    for (const row of this.store.database
      .prepare(`SELECT s.block_id,s.record_id,s.path,s.model_id,t.record_id AS previous_record,t.path AS previous_path,t.model_id AS previous_model
      FROM block_owners s JOIN block_owners t ON t.side='target' AND s.block_id=t.block_id
      WHERE s.side='source' ORDER BY s.record_id,s.block_id`)
      .iterate()) {
      const scope = (path: string) => path.replace(/\[\d+\]/g, '[]');
      if (
        row.record_id !== row.previous_record ||
        row.model_id !== row.previous_model ||
        scope(String(row.path)) !== scope(String(row.previous_path))
      ) {
        this.unsafe(
          'record',
          String(row.record_id),
          'BLOCK_OWNERSHIP_RELOCATION',
          `Block ${row.block_id} would move between records, fields, locales, or block models.`,
          String(row.previous_record),
        );
        this.graph.edge(
          'dependency',
          'record',
          String(row.previous_record),
          'record',
          String(row.record_id),
          'block-ownership',
        );
      }
    }
    for (const row of this.store.database
      .prepare(
        `SELECT block_id,slice FROM block_owners WHERE side='source' GROUP BY block_id,slice HAVING COUNT(*)>1`,
      )
      .iterate()) {
      for (const owner of this.store.database
        .prepare(
          `SELECT record_id FROM block_owners WHERE side='source' AND block_id=? AND slice=?`,
        )
        .iterate(row.block_id, row.slice))
        this.unsafe(
          'record',
          String(owner.record_id),
          'DUPLICATE_BLOCK_OWNERSHIP',
          `Block ${row.block_id} is reused within the source ${row.slice} version.`,
        );
    }
  }

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
    this.graph.order('creation-discovery');
    const defer = this.store.database.prepare(
      'INSERT OR IGNORE INTO planner_deferred_fields VALUES(?,?)',
    );
    for (const entry of this.store.planEntries('record', 'create')) {
      if (entry.kind !== 'record' || !entry.desired) continue;
      const model = this.models.get(entry.modelId)!;
      const slice = entry.desired.published ? 'published' : 'current';
      for (const row of this.store.database
        .prepare(`SELECT r.path,r.target_id,r.field_id FROM refs r
        JOIN planner_nodes n ON n.phase='creation-discovery' AND n.kind='record' AND n.id=r.target_id AND n.done=0
        WHERE r.side='source' AND r.owner_id=? AND r.kind=? AND r.field_id<>''`)
        .iterate(entry.id, slice)) {
        const root = /^[^.[\]]+/.exec(
          String(row.path).replace(/^(current|published)\./, ''),
        )?.[0];
        const field = model.fields.find(
          (candidate) => candidate.apiKey === root,
        );
        if (field) {
          const original = (entry.desired.published ?? entry.desired.current)[
            field.apiKey
          ];
          const empty =
            field.localized && object(original)
              ? (Object.fromEntries(
                  Object.keys(original).map((locale) => [
                    locale,
                    creationEmptyValue(field.type),
                  ]),
                ) as JsonObject)
              : creationEmptyValue(field.type);
          if (
            (model.draftMode && model.saveInvalidDrafts) ||
            (fieldFailures(field, empty).length === 0 &&
              !fieldNeedsDefaultSuppression(field, empty))
          )
            defer.run(entry.id, field.apiKey);
        }
      }
    }
    // Breaking locally nullable edges first lets required acyclic dependants
    // wait for cycle seeds, retaining their complete valid creation fields.
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id,r.field_id,r.path FROM refs r
      JOIN planner_deferred_fields d ON d.owner_id=r.owner_id
      WHERE r.side='source' AND (r.path=d.api_key OR substr(r.path,1,length(d.api_key)+1)=d.api_key||'.')`)
      .iterate())
      this.store.database
        .prepare(
          "DELETE FROM planner_graph WHERE phase='creation-discovery' AND owner_kind='record' AND owner_id=? AND dependency_kind='record' AND dependency_id=? AND field_id=?",
        )
        .run(row.owner_id, row.target_id, row.field_id);
    this.graph.order('creation-discovery');
    // Acyclic dependencies keep their complete valid fields. Only unresolved
    // cycle/dependant vertices need null seeds; their validators/defaults are
    // independently proven safe or narrowly relaxed with explicit authority.
    for (const entry of this.store.planEntries('record')) {
      if (
        entry.kind !== 'record' ||
        entry.action !== 'create' ||
        !entry.desired
      )
        continue;
      const model = this.models.get(entry.modelId)!;
      const fields = structuredClone(
        entry.desired.published ?? entry.desired.current,
      );
      const slice = entry.desired.published ? 'published' : 'current';
      const deferred = new Set<string>();
      for (const row of this.store.database
        .prepare('SELECT api_key FROM planner_deferred_fields WHERE owner_id=?')
        .iterate(entry.id))
        deferred.add(String(row.api_key));
      for (const row of this.store.database
        .prepare(`SELECT r.path,r.target_id,p.model_id,p.action FROM refs r JOIN plan p ON p.kind='record' AND p.id=r.target_id
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
        const dependency = this.store.database
          .prepare(
            "SELECT done FROM planner_nodes WHERE phase='creation-discovery' AND kind='record' AND id=?",
          )
          .get(row.target_id);
        if (
          dependency?.done &&
          (model.draftMode || !this.models.get(String(row.model_id))?.draftMode)
        )
          continue;
        const path = String(row.path).replace(/^(current|published)\./, '');
        const root = /^[^.[\]]+/.exec(path)?.[0];
        if (!root || !model.fields.some((field) => field.apiKey === root)) {
          this.unsafe(
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
      if (!(model.draftMode && model.saveInvalidDrafts))
        for (const key of deferred) {
          const field = model.fields.find(
            (candidate) => candidate.apiKey === key,
          )!;
          for (const validator of fieldFailures(field, fields[key]))
            this.relaxation(
              entry.id,
              field.id,
              validator,
              `Record ${entry.id} needs ${validator} temporarily relaxed on ${field.apiKey} while its unavailable creation references are deferred.`,
            );
        }
      for (const field of aggregateFields(fields, model, this.target))
        if (fieldNeedsDefaultSuppression(field.field, field.value))
          this.relaxation(
            entry.id,
            field.field.id,
            '',
            `Record ${entry.id} needs the default of ${field.field.apiKey} suppressed to preserve an explicit null during creation.`,
            true,
          );
      entry.execution = { ...entry.execution, creationFields: fields };
      this.store.putPlan(entry);
    }
  }

  rebuildEffective(): void {
    this.store.database.exec(
      'DELETE FROM planner_effective_refs; DELETE FROM planner_effective_uniques;',
    );
    const refInsert = this.store.database.prepare(
      'INSERT OR IGNORE INTO planner_effective_refs VALUES(?,?,?,?,?)',
    );
    const uniqueInsert = this.store.database.prepare(
      'INSERT OR IGNORE INTO planner_effective_uniques SELECT model_id,field_id,locale,slice,value,record_id FROM unique_values WHERE side=? AND record_id=?',
    );
    for (const entry of this.store.planEntries('record')) {
      if (entry.kind !== 'record' || entry.action === 'delete') continue;
      const side: Side = ['create', 'update'].includes(entry.action)
        ? 'source'
        : 'target';
      const record = this.store.getRecord(side, entry.id);
      if (!record) continue;
      for (const ref of this.store.references(side, entry.id))
        refInsert.run(
          entry.id,
          ref.kind === 'upload' ? 'upload' : 'record',
          ref.targetId,
          ref.kind,
          ref.fieldId,
        );
      if (record.parentId)
        refInsert.run(entry.id, 'record', record.parentId, 'parent', '');
      uniqueInsert.run(side, entry.id);
    }
  }

  blockTransitions(): void {
    const changes = this.temporaryChanges();
    for (const entry of this.store.planEntries('record')) {
      if (entry.kind !== 'record') continue;
      const issue = recordBlockTransitionIssue(entry, this.target, changes);
      if (issue)
        this.unsafe(
          'record',
          entry.id,
          issue.code,
          issue.message,
          issue.dependencyId,
        );
    }
  }

  effectiveSafety(): void {
    this.rebuildEffective();
    for (const row of this.store.database
      .prepare(`SELECT r.*,p.action AS target_action FROM planner_effective_refs r
      LEFT JOIN plan p ON p.kind=r.target_kind AND p.id=r.target_id ORDER BY r.owner_id,r.target_id`)
      .iterate()) {
      const dependency = row.target_action
        ? this.store.getPlan(row.target_kind as Kind, String(row.target_id))
        : null;
      const exists =
        dependency &&
        dependency.action !== 'delete' &&
        (dependency.action !== 'skip' || dependency.guard !== null);
      if (exists) {
        if (row.slice === 'published' && dependency?.kind === 'record') {
          const target = ['create', 'update'].includes(dependency.action)
            ? dependency.desired
            : this.store.getRecord('target', dependency.id);
          if (!target?.published) {
            const owner = this.store.getPlan('record', String(row.owner_id));
            if (owner && MUTATIONS.has(owner.action))
              this.unsafe(
                'record',
                owner.id,
                'UNPUBLISHED_DEPENDENCY',
                `Record ${owner.id} requires unpublished record ${dependency.id} for publication.`,
                dependency.id,
              );
            else if (dependency.action === 'update')
              this.unsafe(
                'record',
                dependency.id,
                'REFERENCED_UNPUBLISHING',
                `Record ${dependency.id} remains referenced by retained published record ${row.owner_id}.`,
                String(row.owner_id),
              );
            else
              throw new ContentError(
                'UNPROVEN_PUBLICATION_DEPENDENCY',
                `Retained published record ${row.owner_id} requires unpublished record ${dependency.id}.`,
              );
          }
        }
        continue;
      }
      const owner = this.store.getPlan('record', String(row.owner_id));
      if (owner && MUTATIONS.has(owner.action))
        this.unsafe(
          'record',
          owner.id,
          'MISSING_DEPENDENCY',
          `Record ${owner.id} requires unavailable ${row.target_kind} ${row.target_id}.`,
          String(row.target_id),
        );
      else if (dependency?.action === 'delete')
        this.unsafe(
          dependency.kind,
          dependency.id,
          'REFERENCED_DELETION',
          `${dependency.kind} ${dependency.id} is referenced by retained record ${row.owner_id}.`,
          String(row.owner_id),
        );
      else
        throw new ContentError(
          'UNPROVEN_PRESERVATION_DEPENDENCY',
          `Retained record ${row.owner_id} requires unavailable ${row.target_kind} ${row.target_id}.`,
        );
    }
    // Collection membership and parent ownership are equally authoritative.
    for (const kind of ['upload', 'collection'] as const)
      for (const entry of this.store.planEntries(kind)) {
        if (
          entry.action === 'delete' ||
          (entry.action === 'skip' && !entry.guard)
        )
          continue;
        const side: Side = ['create', 'update'].includes(entry.action)
          ? 'source'
          : 'target';
        const state =
          kind === 'upload'
            ? this.store.getUpload(side, entry.id)
            : this.store.getCollection(side, entry.id);
        const parent =
          state &&
          ('collectionId' in state ? state.collectionId : state.parentId);
        if (!parent) continue;
        const dependency = this.store.getPlan('collection', parent);
        if (
          dependency &&
          dependency.action !== 'delete' &&
          (dependency.action !== 'skip' || dependency.guard)
        )
          continue;
        if (MUTATIONS.has(entry.action))
          this.unsafe(
            kind,
            entry.id,
            'MISSING_COLLECTION',
            `${kind} ${entry.id} requires unavailable collection ${parent}.`,
            parent,
          );
        else if (dependency?.action === 'delete')
          this.unsafe(
            'collection',
            parent,
            'REFERENCED_COLLECTION_DELETION',
            `Collection ${parent} is required by retained ${kind} ${entry.id}.`,
            entry.id,
          );
        else
          throw new ContentError(
            'UNPROVEN_PRESERVATION_DEPENDENCY',
            `Retained ${kind} ${entry.id} requires unavailable collection ${parent}.`,
          );
      }
    for (const group of this.store.database
      .prepare(
        'SELECT model_id,field_id,locale,slice,value FROM planner_effective_uniques GROUP BY model_id,field_id,locale,slice,value HAVING COUNT(*)>1',
      )
      .iterate()) {
      const owners = this.store.database.prepare(
        'SELECT record_id FROM planner_effective_uniques WHERE model_id=? AND field_id=? AND locale=? AND slice=? AND value=?',
      );
      const grandfathered = !this.store.database
        .prepare(
          `SELECT 1 FROM planner_effective_uniques peer WHERE peer.model_id=? AND peer.field_id=? AND peer.locale=? AND peer.slice=? AND peer.value=? AND NOT EXISTS(SELECT 1 FROM unique_values original WHERE original.side='source' AND original.model_id=peer.model_id AND original.field_id=peer.field_id AND original.locale=peer.locale AND original.slice=peer.slice AND original.value=peer.value AND original.record_id=peer.record_id) LIMIT 1`,
        )
        .get(
          group.model_id,
          group.field_id,
          group.locale,
          group.slice,
          group.value,
        );
      for (const row of owners.iterate(
        group.model_id,
        group.field_id,
        group.locale,
        group.slice,
        group.value,
      )) {
        const plan = this.store.getPlan(
          'record',
          String(row.record_id),
        ) as RecordPlan;
        if (
          group.slice === 'current' &&
          this.selected.has(plan.modelId) &&
          ['create', 'update'].includes(plan.action)
        ) {
          const scheduled = plan.desired;
          if (scheduled?.schedules.publication)
            this.checkScheduledPublication(plan, scheduled);
        }
        if (!['create', 'update'].includes(plan.action) || !plan.desired)
          continue;
        const nativeInvalid =
          group.slice === 'current' &&
          this.models.get(plan.modelId)?.draftMode &&
          this.models.get(plan.modelId)?.saveInvalidDrafts;
        if (nativeInvalid) continue;
        if (grandfathered)
          this.relaxation(
            plan.id,
            String(group.field_id),
            'unique',
            `Record ${plan.id} needs unique temporarily relaxed to reproduce proven grandfathered source ownership on field ${group.field_id}.`,
          );
        else
          this.unsafe(
            'record',
            plan.id,
            'UNIQUE_VALUE_CONFLICT',
            `Record ${plan.id} requests a unique ${group.slice} value that remains owned by another record on field ${group.field_id}.`,
          );
      }
    }
  }

  processUnsafe(): boolean {
    const first = this.store.database
      .prepare(
        'SELECT * FROM planner_unsafe WHERE done=0 ORDER BY kind,id,code LIMIT 1',
      )
      .get();
    if (!first) return false;
    if (!this.options.allowPartial)
      throw new ContentError('UNSAFE_REQUESTED_CHANGE', String(first.message), {
        kind: first.kind,
        id: first.id,
        reason: first.code,
        dependencyId: first.dependency_id,
      });
    const next = this.store.database.prepare(
      'SELECT * FROM planner_unsafe WHERE done=0 ORDER BY kind,id,code LIMIT 1',
    );
    for (;;) {
      const row = next.get();
      if (!row) break;
      this.store.database
        .prepare(
          'UPDATE planner_unsafe SET done=1 WHERE kind=? AND id=? AND code=? AND message=?',
        )
        .run(row.kind, row.id, row.code, row.message);
      const entry = this.store.getPlan(row.kind as Kind, String(row.id));
      if (!entry) continue;
      const diagnostic: Diagnostic = {
        code: String(row.code),
        message: String(row.message),
        ...(row.dependency_id
          ? { dependencyId: String(row.dependency_id) }
          : {}),
      };
      if (
        !entry.diagnostics.some(
          (existing) =>
            existing.code === diagnostic.code &&
            existing.message === diagnostic.message,
        )
      )
        entry.diagnostics.push(diagnostic);
      entry.action = 'skip';
      if (entry.kind === 'record') entry.execution = undefined;
      this.store.putPlan(entry);
      if (entry.kind === 'record') {
        const model = this.models.get(entry.modelId)!;
        if (
          (model.tree || model.sortable) &&
          Number(
            this.store.database
              .prepare(
                'INSERT OR IGNORE INTO planner_skipped_ordering VALUES(?)',
              )
              .run(entry.modelId).changes,
          )
        ) {
          for (const sibling of this.store.database
            .prepare(
              "SELECT id FROM plan WHERE kind='record' AND model_id=? AND action IN ('create','update','delete') ORDER BY id",
            )
            .iterate(entry.modelId))
            this.unsafe(
              'record',
              String(sibling.id),
              'ORDERING_SKIP_CLOSURE',
              `Record ${sibling.id} shares an ordered model with skipped record ${entry.id}; the complete ordered model is preserved.`,
              entry.id,
            );
        }
      }
      if (entry.kind === 'collection') {
        for (const state of [entry.baseline, entry.desired]) {
          if (!state) continue;
          const inserted = this.store.database
            .prepare(
              'INSERT OR IGNORE INTO planner_skipped_collection_groups VALUES(?)',
            )
            .run(state.parentId ?? '').changes;
          if (!inserted) continue;
          this.collectionGroupUnsafe(
            state.parentId,
            'COLLECTION_ORDERING_SKIP_CLOSURE',
            `Collection ordering shares an affected sibling group with skipped collection ${entry.id}; that group is preserved.`,
            entry.id,
          );
        }
      }
      // Propagate to requested dependants. Separately, preserve the complete
      // baseline closure of each skipped entity, including optional references.
      for (const dependant of this.store.database
        .prepare(
          `SELECT owner_kind,owner_id FROM planner_graph WHERE phase='dependency' AND dependency_kind=? AND dependency_id=? ORDER BY owner_kind,owner_id`,
        )
        .iterate(entry.kind, entry.id))
        this.unsafe(
          dependant.owner_kind as Kind,
          String(dependant.owner_id),
          'SKIPPED_DEPENDENCY',
          `${dependant.owner_kind} ${dependant.owner_id} depends on skipped ${entry.kind} ${entry.id}.`,
          entry.id,
        );
      if (entry.guard)
        for (const dependency of this.store.database
          .prepare(
            `SELECT dependency_kind,dependency_id FROM planner_graph WHERE phase='preservation' AND owner_kind=? AND owner_id=? ORDER BY dependency_kind,dependency_id`,
          )
          .iterate(entry.kind, entry.id)) {
          const target = this.store.getPlan(
            dependency.dependency_kind as Kind,
            String(dependency.dependency_id),
          );
          if (target?.action === 'delete')
            this.unsafe(
              target.kind,
              target.id,
              'PRESERVED_SKIP_DEPENDENCY',
              `${target.kind} ${target.id} must remain for skipped ${entry.kind} ${entry.id}.`,
              entry.id,
            );
        }
    }
    return true;
  }

  collectionGroupUnsafe(
    parentId: string | null,
    code: string,
    message: string,
    dependencyId?: string,
  ): number {
    let marked = 0;
    for (const row of this.store.database
      .prepare(`SELECT DISTINCT p.id FROM collections c INDEXED BY collections_parent
      CROSS JOIN plan p ON p.kind='collection' AND p.id=c.id
      WHERE c.side IN ('source','target') AND c.parent_id IS ? AND p.action IN ('create','update','delete')
      ORDER BY p.id`)
      .iterate(parentId)) {
      this.unsafe('collection', String(row.id), code, message, dependencyId);
      marked++;
    }
    return marked;
  }

  uniqueTransitions(): void {
    // Invalid/grandfathered namespaces may contain many owners of a unique
    // value. Aggregate ownership first, avoiding an all-to-all value join.
    this.store.database.exec(
      "DELETE FROM planner_unique_owners; INSERT INTO planner_unique_owners SELECT side,model_id,field_id,locale,slice,value,MIN(record_id),COUNT(*) FROM unique_values WHERE side='target' GROUP BY side,model_id,field_id,locale,slice,value; INSERT INTO planner_unique_owners SELECT 'effective',model_id,field_id,locale,slice,value,MIN(record_id),COUNT(*) FROM planner_effective_uniques GROUP BY model_id,field_id,locale,slice,value;",
    );
    for (const row of this.store.database
      .prepare(`SELECT s.record_id,s.field_id,s.slice,t.owner_id AS owner,t.owner_count,t.slice AS owner_slice FROM unique_values s
      JOIN plan p ON p.kind='record' AND p.id=s.record_id AND p.action IN ('create','update')
      JOIN planner_unique_owners t ON t.side='target' AND t.model_id=s.model_id AND t.field_id=s.field_id AND t.locale=s.locale AND t.slice IN ('current','published') AND t.value=s.value
      WHERE s.side='source' AND (s.record_id<>t.owner_id OR t.owner_count>1) ORDER BY s.record_id,s.field_id,t.owner_id`)
      .iterate()) {
      const demander = this.store.getPlan(
        'record',
        String(row.record_id),
      ) as RecordPlan;
      const model = this.models.get(demander.modelId)!;
      if (row.slice === 'current' && model.draftMode && model.saveInvalidDrafts)
        continue;
      if (this.options.allowTemporarySchemaChanges) {
        this.relaxation(
          demander.id,
          String(row.field_id),
          'unique',
          `Record ${demander.id} needs unique temporarily relaxed on field ${row.field_id} during a proven value transition.`,
        );
        continue;
      }
      if (Number(row.owner_count) !== 1) {
        this.unsafe(
          'record',
          demander.id,
          'UNSAFE_UNIQUE_TRANSITION',
          `Record ${demander.id} requires a unique value with multiple destination owners on field ${row.field_id}.`,
        );
        continue;
      }
      const owner = this.store.getPlan('record', String(row.owner)) as
        | RecordPlan
        | undefined;
      if (!owner)
        throw new ContentError(
          'UNPROVEN_UNIQUE_OWNERSHIP',
          `Unique owner ${row.owner} is outside the authoritative destination capture.`,
        );
      this.graph.edge(
        'dependency',
        'record',
        demander.id,
        'record',
        owner.id,
        'unique-release',
        String(row.field_id),
      );
      if (
        owner.action === 'update' &&
        demander.action !== 'create' &&
        row.slice === 'current' &&
        row.owner_slice === 'current'
      )
        this.graph.edge(
          'update',
          'record',
          demander.id,
          'record',
          owner.id,
          'unique-release',
          String(row.field_id),
        );
      else
        this.unsafe(
          'record',
          demander.id,
          'UNSAFE_UNIQUE_TRANSITION',
          `Record ${demander.id} needs a unique value still owned by ${owner.id} during creation or publication staging.`,
          owner.id,
        );
    }
    for (const row of this.store.database
      .prepare(`SELECT s.record_id,s.field_id,c.owner_id AS owner FROM unique_values s
      JOIN plan p ON p.kind='record' AND p.id=s.record_id AND p.action IN ('create','update')
      JOIN planner_unique_owners c ON c.side='effective' AND c.model_id=s.model_id AND c.field_id=s.field_id AND c.locale=s.locale AND c.value=s.value AND c.slice='current'
      WHERE s.side='source' AND s.slice='published' AND (s.record_id<>c.owner_id OR c.owner_count>1) ORDER BY s.record_id,s.field_id,c.owner_id`)
      .iterate()) {
      const plan = this.store.getPlan(
        'record',
        String(row.record_id),
      ) as RecordPlan;
      this.relaxation(
        plan.id,
        String(row.field_id),
        'unique',
        `Record ${plan.id} stages a published value into CURRENT while another record owns that value.`,
      );
    }
  }

  executionOrders(): void {
    for (const phase of [
      'create',
      'publish',
      'delete',
      'tree',
      'collection-create',
      'collection-delete',
      'collection-tree',
    ])
      this.graph.clear(phase);
    this.store.database
      .prepare(`DELETE FROM planner_nodes WHERE phase='update'`)
      .run();
    for (const entry of this.store.planEntries()) {
      if (!MUTATIONS.has(entry.action)) continue;
      if (entry.kind === 'record') {
        if (entry.action === 'create')
          this.graph.node('create', 'record', entry.id);
        if (entry.action !== 'delete') {
          this.graph.node('update', 'record', entry.id);
          this.graph.node('publish', 'record', entry.id);
        } else this.graph.node('delete', 'record', entry.id);
      } else if (entry.kind === 'collection')
        this.graph.node(
          entry.action === 'delete' ? 'collection-delete' : 'collection-create',
          entry.kind,
          entry.id,
        );
    }
    // Trees must remain forests even when their parent already exists. Use all
    // effective managed/preserved vertices, not just the newly created ones.
    for (const entry of this.store.planEntries('record')) {
      if (
        entry.kind !== 'record' ||
        entry.action === 'delete' ||
        (entry.action === 'skip' && !entry.guard)
      )
        continue;
      const desired = ['create', 'update'].includes(entry.action)
        ? this.store.getRecord('source', entry.id)
        : this.store.getRecord('target', entry.id);
      if (!desired) continue;
      this.graph.node('tree', 'record', entry.id);
      if (desired.parentId) {
        const parent = this.store.getPlan('record', desired.parentId) as
          | RecordPlan
          | undefined;
        if (
          !parent ||
          parent.modelId !== entry.modelId ||
          !this.models.get(entry.modelId)?.tree
        )
          this.unsafe(
            'record',
            entry.id,
            'UNSUPPORTED_TREE_PARENT',
            `Record ${entry.id} has an unavailable or incompatible tree parent.`,
            desired.parentId,
          );
        this.graph.edge(
          'tree',
          'record',
          entry.id,
          'record',
          desired.parentId,
          'parent',
        );
        if (entry.action === 'create' && parent?.action === 'create')
          this.graph.edge(
            'create',
            'record',
            entry.id,
            'record',
            desired.parentId,
            'parent',
          );
        if (
          ['create', 'update'].includes(entry.action) &&
          parent &&
          ['create', 'update'].includes(parent.action)
        ) {
          this.graph.edge(
            'publish',
            'record',
            entry.id,
            'record',
            parent.id,
            'parent',
          );
          this.graph.edge(
            'update',
            'record',
            entry.id,
            'record',
            parent.id,
            'parent',
          );
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
      for (const ref of inspectRecord(seed, this.target).references) {
        if (ref.kind !== 'current') continue;
        if (this.store.getPlan('record', ref.targetId)?.action === 'create')
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
    }
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id FROM planner_effective_refs r
      JOIN planner_nodes a ON a.phase='publish' AND a.kind='record' AND a.id=r.owner_id
      WHERE r.slice='published' AND r.owner_id<>r.target_id ORDER BY r.owner_id,r.target_id`)
      .iterate()) {
      const dependency = this.store.getPlan('record', String(row.target_id)) as
        | RecordPlan
        | undefined;
      const target =
        dependency &&
        (['create', 'update'].includes(dependency.action)
          ? dependency.desired
          : this.store.getRecord('target', dependency.id));
      if (!target?.published)
        this.unsafe(
          'record',
          String(row.owner_id),
          'UNPUBLISHED_DEPENDENCY',
          `Record ${row.owner_id} requires unpublished record ${row.target_id} for publication.`,
          String(row.target_id),
        );
      else if (
        dependency &&
        ['create', 'update'].includes(dependency.action) &&
        !this.store.getRecord('target', dependency.id)?.published
      )
        this.graph.edge(
          'publish',
          'record',
          String(row.owner_id),
          'record',
          String(row.target_id),
          'publication',
        );
    }
    // Final-state references prove that unpublishing is safe eventually, but
    // the old published referrers must first release their live references.
    // Deletes run after publication, so they cannot provide that release.
    // Native publication/unpublication/deletion allows content self-references;
    // tree-parent self references remain checked by their separate graph.
    for (const row of this.store.database
      .prepare(`SELECT r.owner_id,r.target_id,owner.action AS owner_action FROM refs r
      JOIN plan dependency ON dependency.kind='record' AND dependency.id=r.target_id AND dependency.action='update'
      JOIN plan owner ON owner.kind='record' AND owner.id=r.owner_id
      WHERE r.side='target' AND r.kind='published' AND r.owner_id<>r.target_id AND json_extract(dependency.data,'$.desired.published') IS NULL
      ORDER BY r.target_id,r.owner_id`)
      .iterate()) {
      if (row.owner_action === 'update')
        this.graph.edge(
          'publish',
          'record',
          String(row.target_id),
          'record',
          String(row.owner_id),
          'publication-release',
        );
      else if (row.owner_action === 'delete')
        this.unsafe(
          'record',
          String(row.target_id),
          'UNSUPPORTED_PUBLICATION_RELEASE',
          `Record ${row.target_id} cannot be unpublished before its published referrer ${row.owner_id} is deleted in the later deletion phase.`,
          String(row.owner_id),
        );
    }
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
    for (const row of this.store.database
      .prepare(`SELECT r.id,r.parent_id FROM records r JOIN plan a ON a.kind='record' AND a.id=r.id AND a.action='delete'
      JOIN plan b ON b.kind='record' AND b.id=r.parent_id AND b.action='delete' WHERE r.side='target' ORDER BY r.parent_id,r.id`)
      .iterate())
      this.graph.edge(
        'delete',
        'record',
        String(row.parent_id),
        'record',
        String(row.id),
        'parent',
      );
    for (const entry of this.store.planEntries('collection')) {
      if (
        entry.kind === 'collection' &&
        entry.action !== 'delete' &&
        (entry.action !== 'skip' || entry.guard)
      ) {
        const state = ['create', 'update'].includes(entry.action)
          ? entry.desired
          : this.store.getCollection('target', entry.id);
        if (state) {
          this.graph.node('collection-tree', 'collection', entry.id);
          if (state.parentId)
            this.graph.edge(
              'collection-tree',
              'collection',
              entry.id,
              'collection',
              state.parentId,
              'parent',
            );
        }
      }
      if (
        entry.kind !== 'collection' ||
        !['create', 'update', 'delete'].includes(entry.action)
      )
        continue;
      const state = entry.action === 'delete' ? entry.baseline : entry.desired;
      if (!state?.parentId) continue;
      const phase =
        entry.action === 'delete' ? 'collection-delete' : 'collection-create';
      this.graph.node(phase, 'collection', entry.id);
      const parent = this.store.getPlan('collection', state.parentId);
      if (
        parent &&
        (entry.action === 'delete'
          ? parent.action === 'delete'
          : ['create', 'update'].includes(parent.action))
      ) {
        if (entry.action !== 'delete')
          this.graph.edge(
            phase,
            'collection',
            entry.id,
            'collection',
            state.parentId,
            'parent',
          );
        else
          this.graph.edge(
            phase,
            'collection',
            state.parentId,
            'collection',
            entry.id,
            'parent',
          );
      }
    }
    for (const phase of [
      'tree',
      'create',
      'update',
      'publish',
      'delete',
      'collection-create',
      'collection-delete',
      'collection-tree',
    ]) {
      if (this.graph.order(phase)) {
        let requested = false;
        for (const node of this.graph.cycles(phase)) {
          const entry = this.store.getPlan(node.kind, node.id);
          if (entry && MUTATIONS.has(entry.action)) {
            requested = true;
            this.unsafe(
              node.kind,
              node.id,
              `${phase.toUpperCase().replace(/-/g, '_')}_CYCLE`,
              `${node.kind} ${node.id} is in or depends on an unsupported ${phase} cycle.`,
            );
          }
        }
        if (!requested)
          throw new ContentError(
            'PRESERVATION_CYCLE',
            `An existing preserved ${phase} cycle prevents a safe execution order.`,
          );
      }
      for (const rank of this.graph.ranks(phase)) {
        if (rank.kind !== 'record' || phase === 'tree') continue;
        const entry = this.store.getPlan('record', rank.id) as RecordPlan;
        entry.execution = { ...entry.execution, [`${phase}Order`]: rank.rank };
        this.store.putPlan(entry);
      }
    }
  }

  collectionOrdering(): void {
    const entries = (phase: string): Iterable<CollectionPlan> => {
      const planning = this;
      return (function* () {
        for (const node of planning.graph.ranks(phase)) {
          const entry = planning.store.getPlan('collection', node.id);
          if (entry?.kind === 'collection') yield entry;
        }
      })();
    };
    for (const issue of collectionTransitionIssues({
      store: this.store,
      baselineSide: 'target',
      writes: orderedCollectionWrites(this.store),
      deletes: entries('collection-delete'),
    })) {
      const entry = this.store.getPlan('collection', issue.id);
      if (entry && MUTATIONS.has(entry.action))
        this.unsafe(
          'collection',
          issue.id,
          issue.code,
          issue.message,
          issue.dependencyId,
        );
      else if (
        !this.collectionGroupUnsafe(
          issue.parentId,
          issue.code,
          issue.message,
          issue.id,
        )
      )
        throw new ContentError('UNPROVEN_COLLECTION_ORDERING', issue.message);
    }
  }

  temporaryChanges(): TemporarySchemaChange[] {
    const changes: TemporarySchemaChange[] = [];
    for (const field of this.fields.values()) {
      const uses = this.store.database
        .prepare(`SELECT DISTINCT u.validator,u.suppress_default FROM planner_temp_usage u JOIN plan p ON p.kind='record' AND p.id=u.record_id
        WHERE u.field_id=? AND p.action IN ('create','update') ORDER BY u.validator,u.suppress_default`)
        .all(field.field.id);
      if (!uses.length) continue;
      const temporary = structuredClone(field.field.validators);
      for (const use of uses)
        if (use.validator)
          Reflect.deleteProperty(temporary, String(use.validator));
      changes.push({
        fieldId: field.field.id,
        modelId: field.model.id,
        original: {
          validators: field.field.validators,
          defaultValue: field.field.defaultValue,
        },
        temporary: {
          validators: temporary,
          defaultValue: uses.some((use) => use.suppress_default)
            ? suppressedDefaultValue(field.field, this.source.locales)
            : field.field.defaultValue,
        },
        reasons: sortedUnique(
          uses.map((use) =>
            use.suppress_default
              ? 'Suppress the field default during explicit-null creation.'
              : `Temporarily relax ${use.validator} for proven managed content transitions.`,
          ),
        ),
      });
    }
    return changes.sort(
      (a, b) =>
        a.modelId.localeCompare(b.modelId) ||
        a.fieldId.localeCompare(b.fieldId),
    );
  }

  finish(): PlanMetadata {
    const insert = this.store.database.prepare(
      'INSERT INTO planner_positions VALUES(?,?,?,?)',
    );
    for (const entry of this.store.planEntries('record')) {
      if (
        entry.kind !== 'record' ||
        entry.action === 'delete' ||
        (entry.action === 'skip' && !entry.guard)
      )
        continue;
      const model = this.models.get(entry.modelId)!;
      if (!model.tree && !model.sortable) continue;
      const state = ['create', 'update'].includes(entry.action)
        ? entry.desired
        : this.store.getRecord('target', entry.id);
      if (state?.position !== null && state?.position !== undefined)
        insert.run(
          entry.modelId,
          state.parentId ?? '',
          state.position,
          entry.id,
        );
    }
    const conflict = this.store.database
      .prepare(
        'SELECT model_id,parent_id,position FROM planner_positions GROUP BY model_id,parent_id,position HAVING COUNT(*)>1 LIMIT 1',
      )
      .get();
    if (conflict)
      throw new ContentError(
        'ORDERING_CONFLICT',
        `The intended result requires duplicate sibling position ${conflict.position} in model ${conflict.model_id}; exact preservation is impossible.`,
      );
    const counts = blankCounts();
    for (const row of this.store.database
      .prepare(
        'SELECT kind,action,COUNT(*) AS count FROM plan GROUP BY kind,action',
      )
      .iterate())
      counts[row.kind as Kind][row.action as Action] = Number(row.count);
    const temporarySchemaChanges = this.temporaryChanges();
    if (
      temporarySchemaChanges.length ||
      Object.values(counts).some(
        (kind) => kind.create || kind.update || kind.delete,
      )
    )
      this.checkNoopSchedules();
    // The bundle carries the destination schema: it includes retained models,
    // while all managed/source block schemas have been proven identical.
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
        modelIds: sortedUnique(this.options.modelIds),
      },
      counts,
      temporarySchemaChanges,
    };
  }
}

/** Native nested updates can reuse an existing ID only from their current slot. */
export function recordBlockTransitionIssue(
  entry: RecordPlan,
  schema: SchemaState,
  changes: TemporarySchemaChange[] = [],
): Diagnostic | undefined {
  if (!['create', 'update'].includes(entry.action) || !entry.desired) return;
  const desired = entry.desired;
  const model = schema.models.find(
    (candidate) => candidate.id === entry.modelId,
  );
  if (
    !model ||
    !model.fields.some((field) =>
      ['rich_text', 'single_block', 'structured_text'].includes(field.type),
    )
  )
    return;
  if (entry.action === 'update' && !entry.baseline) return;
  let current: JsonObject =
    entry.action === 'create'
      ? entry.execution?.creationFields ?? desired.published ?? desired.current
      : entry.baseline!.current;
  let published: JsonObject | null =
    entry.action === 'create'
      ? model.draftMode
        ? null
        : current
      : entry.baseline!.published;
  const owners = (fields: JsonObject | null): Map<string, BlockOwner> =>
    new Map(
      fields
        ? inspectRecord(
            { ...desired, current: fields, published: null },
            schema,
          ).blockOwners.map((owner) => [owner.blockId, owner])
        : [],
    );
  const write = (fields: JsonObject, phase: string): Diagnostic | undefined => {
    if (hashJson(current) === hashJson(fields)) return;
    const currentOwners = owners(current);
    const publishedOwners = owners(published);
    const created = new Set<string>();
    for (const wanted of owners(fields).values()) {
      const existing = currentOwners.get(wanted.blockId);
      if (!existing && !publishedOwners.has(wanted.blockId)) {
        if (!PORTABLE_ID.test(wanted.blockId))
          return {
            code: 'UNSUPPORTED_LEGACY_BLOCK_ID',
            message: `Record ${entry.id} must recreate block ${wanted.blockId} while writing ${phase}, but its identity cannot be used for a new block.`,
            dependencyId: wanted.blockId,
          };
        created.add(wanted.blockId);
        continue;
      }
      // Paths identify the field/locale and stable ancestor block IDs. Array
      // indices and Structured Text node positions do not define ownership.
      if (
        !existing ||
        existing.path !== wanted.path ||
        existing.modelId !== wanted.modelId
      )
        return {
          code: 'UNSUPPORTED_BLOCK_REINTRODUCTION',
          message: `Record ${entry.id} cannot write its ${phase} values because existing block ${wanted.blockId} is not owned by the required current field, locale, parent block, and model (${wanted.path}).`,
          dependencyId: wanted.blockId,
        };
    }
    if (created.size)
      for (const value of aggregateFields(fields, model, schema)) {
        if (!value.blockId || !created.has(value.blockId)) continue;
        const change = changes.find(
          (candidate) =>
            candidate.fieldId === value.field.id &&
            candidate.modelId === value.modelId,
        );
        const effective = change
          ? { ...value.field, defaultValue: change.temporary.defaultValue }
          : value.field;
        if (fieldNeedsDefaultSuppression(effective, value.value))
          return {
            code: 'UNSUPPORTED_BLOCK_RECREATION_DEFAULT',
            message: `Record ${entry.id} must create block ${value.blockId} while writing ${phase}, but the default of ${value.field.apiKey} would replace its explicit null and no matching suppression is declared.`,
            dependencyId: value.blockId,
          };
      }
    // Native cleanup deletes blocks removed from current unless publication
    // still retains them. The union of these two slices is the live namespace.
    current = fields;
    if (!model.draftMode) published = fields;
  };
  if (hashJson(published) !== hashJson(desired.published)) {
    if (desired.published) {
      const issue = write(desired.published, 'published');
      if (issue) return issue;
      published = desired.published;
    } else published = null;
  }
  return write(desired.current, 'current');
}

export interface CollectionTransitionIssue {
  id: string;
  parentId: string | null;
  code:
    | 'COLLECTION_LABEL_CONFLICT'
    | 'COLLECTION_ORDERING_CONFLICT'
    | 'COLLECTION_PARENT_CONFLICT';
  message: string;
  dependencyId?: string;
}

/** Full intended-tree depth preserves moves through unchanged ancestors. */
export function* orderedCollectionWrites(
  store: SnapshotStore,
): Generator<CollectionPlan> {
  if (
    !store.database
      .prepare(
        "SELECT 1 FROM plan WHERE kind='collection' AND action IN ('create','update') LIMIT 1",
      )
      .get()
  )
    return;
  for (const row of store.database
    .prepare(`SELECT p.data FROM planner_nodes n
    JOIN plan p ON p.kind='collection' AND p.id=n.id
    WHERE n.phase='collection-final-parent-proof' AND n.kind='collection' AND n.done=1
    AND p.action IN ('create','update') ORDER BY n.rank,p.id`)
    .iterate())
    yield JSON.parse(String(row.data)) as CollectionPlan;
}

/** Shared planner/import proof. Ordered inputs must match actual execution. */
export function* collectionTransitionIssues({
  store,
  baselineSide,
  writes,
  deletes,
}: {
  store: SnapshotStore;
  baselineSide: 'target' | 'live';
  writes: Iterable<CollectionPlan>;
  deletes: Iterable<CollectionPlan>;
}): Generator<CollectionTransitionIssue> {
  if (
    !store.database
      .prepare(
        "SELECT 1 FROM plan WHERE kind='collection' AND action IN ('create','update','delete') LIMIT 1",
      )
      .get()
  )
    return;
  // Collections allow gaps and duplicate positions. Simulate the executor's
  // exact native shifts and two reconciliation passes instead of assuming a
  // dense or unique order. A collection CREATE/DELETE does not shift peers.
  store.database.exec(`
      CREATE TEMP TABLE IF NOT EXISTS planner_collection_live(id TEXT PRIMARY KEY,parent_id TEXT,position INTEGER NOT NULL,label TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_collection_live_siblings ON planner_collection_live(parent_id,position,id);
      CREATE INDEX IF NOT EXISTS planner_collection_live_labels ON planner_collection_live(parent_id,label,id);
      CREATE TEMP TABLE IF NOT EXISTS planner_collection_intended(id TEXT PRIMARY KEY,parent_id TEXT,position INTEGER NOT NULL,label TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS planner_collection_intended_order ON planner_collection_intended(parent_id,position,id);
      DELETE FROM planner_collection_live; DELETE FROM planner_collection_intended;
    `);
  store.database
    .prepare(
      "INSERT INTO planner_collection_live SELECT id,parent_id,position,json_extract(state_json,'$.label') FROM collections WHERE side=?",
    )
    .run(baselineSide);
  const intended = store.database.prepare(
    'INSERT INTO planner_collection_intended VALUES(?,?,?,?)',
  );
  for (const entry of store.planEntries('collection')) {
    if (
      entry.kind !== 'collection' ||
      entry.action === 'delete' ||
      (entry.action === 'skip' && !entry.guard)
    )
      continue;
    const state =
      entry.action === 'create' || entry.action === 'update'
        ? entry.desired
        : store.getCollection(baselineSide, entry.id);
    if (state && Number.isSafeInteger(state.position))
      intended.run(state.id, state.parentId, state.position, state.label);
  }
  let invalidParent = false;
  for (const row of store.database
    .prepare(`SELECT child.id,child.parent_id FROM planner_collection_intended child
    LEFT JOIN planner_collection_intended parent ON parent.id=child.parent_id
    WHERE child.parent_id IS NOT NULL AND parent.id IS NULL ORDER BY child.id`)
    .iterate()) {
    invalidParent = true;
    const parent = store.getPlan('collection', String(row.parent_id));
    const removed =
      parent?.kind === 'collection' && parent.action === 'delete'
        ? parent
        : undefined;
    yield {
      id: removed?.id ?? String(row.id),
      parentId: removed?.baseline?.parentId ?? String(row.parent_id),
      code: 'COLLECTION_PARENT_CONFLICT',
      message: `Collection ${row.id} requires parent ${row.parent_id}, which is absent from the intended result.`,
      dependencyId: String(row.parent_id),
    };
  }
  // Validate the complete effective forest, including unchanged descendants.
  // Kahn ordering keeps a deep create chain linear in vertices and edges.
  const graph = new PlannerGraph(store.database);
  const phase = 'collection-final-parent-proof';
  graph.clear(phase);
  for (const row of store.database
    .prepare('SELECT id,parent_id FROM planner_collection_intended ORDER BY id')
    .iterate()) {
    graph.node(phase, 'collection', String(row.id));
    if (row.parent_id !== null)
      graph.edge(
        phase,
        'collection',
        String(row.id),
        'collection',
        String(row.parent_id),
        'parent',
      );
  }
  if (graph.order(phase)) {
    invalidParent = true;
    let changedCycle = false;
    for (const node of graph.cycles(phase)) {
      const entry = store.getPlan('collection', node.id);
      if (entry?.kind !== 'collection' || !MUTATIONS.has(entry.action))
        continue;
      changedCycle = true;
      yield {
        id: node.id,
        parentId: entry.desired?.parentId ?? null,
        code: 'COLLECTION_PARENT_CONFLICT',
        message: `Collection ${node.id} is in or depends on an intended parent cycle.`,
      };
    }
    if (!changedCycle) {
      const first = graph.cycles(phase).next().value;
      if (first)
        yield {
          id: first.id,
          parentId: null,
          code: 'COLLECTION_PARENT_CONFLICT',
          message: `Preserved collection ${first.id} is in an invalid parent cycle.`,
        };
    }
  }
  if (invalidParent) return;
  const current = store.database.prepare(
    'SELECT * FROM planner_collection_live WHERE id=?',
  );
  const write = store.database.prepare(
    'INSERT OR REPLACE INTO planner_collection_live VALUES(?,?,?,?)',
  );
  const range = store.database.prepare(
    'UPDATE planner_collection_live SET position=position+? WHERE parent_id IS ? AND id<>? AND position BETWEEN ? AND ?',
  );
  const tail = store.database.prepare(
    'UPDATE planner_collection_live SET position=position+? WHERE parent_id IS ? AND id<>? AND position>=?',
  );
  const remove = store.database.prepare(
    'DELETE FROM planner_collection_live WHERE id=?',
  );
  const duplicateLabel = store.database.prepare(
    'SELECT id FROM planner_collection_live WHERE parent_id IS ? AND label=? AND id<>? LIMIT 1',
  );
  const ancestor = store.database.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM planner_collection_live WHERE id=?
    UNION SELECT p.id,p.parent_id FROM ancestors a CROSS JOIN planner_collection_live p ON p.id=a.parent_id
  ) SELECT 1 FROM ancestors WHERE id=? LIMIT 1`);
  const move = (
    state: Pick<CollectionState, 'id' | 'parentId' | 'position' | 'label'>,
  ): CollectionTransitionIssue | undefined => {
    const previous = current.get(state.id);
    if (
      previous &&
      previous.parent_id === state.parentId &&
      Number(previous.position) === state.position &&
      previous.label === state.label
    )
      return;
    if (state.parentId !== null) {
      if (!current.get(state.parentId))
        return {
          id: state.id,
          parentId: state.parentId,
          code: 'COLLECTION_PARENT_CONFLICT',
          message: `Collection ${state.id} requires unavailable parent ${state.parentId} during the planned transition.`,
          dependencyId: state.parentId,
        };
      // Only reparenting existing vertices can introduce a transient cycle.
      // New identities cannot already be an ancestor of an existing parent.
      if (
        previous &&
        previous.parent_id !== state.parentId &&
        ancestor.get(state.parentId, state.id)
      )
        return {
          id: state.id,
          parentId: state.parentId,
          code: 'COLLECTION_PARENT_CONFLICT',
          message: `Collection ${state.id} would move beneath itself or its descendant ${state.parentId} during the planned transition.`,
          dependencyId: state.parentId,
        };
    }
    const duplicate = duplicateLabel.get(state.parentId, state.label, state.id);
    if (duplicate)
      return {
        id: state.id,
        parentId: state.parentId,
        code: 'COLLECTION_LABEL_CONFLICT',
        message: `Collection ${state.id} requests a sibling label still owned by collection ${duplicate.id} during the planned transition.`,
        dependencyId: String(duplicate.id),
      };
    if (previous) {
      const position = Number(previous.position);
      if (previous.parent_id === state.parentId)
        range.run(
          state.position < position ? 1 : -1,
          state.parentId,
          state.id,
          Math.min(position, state.position),
          Math.max(position, state.position),
        );
      else {
        tail.run(1, state.parentId, state.id, state.position);
        tail.run(-1, previous.parent_id, state.id, position);
      }
    }
    write.run(state.id, state.parentId, state.position, state.label);
  };
  for (const entry of writes) {
    if (entry.desired && Number.isSafeInteger(entry.desired.position)) {
      const issue = move(entry.desired);
      if (issue) yield issue;
    }
  }
  for (const entry of deletes) remove.run(entry.id);
  for (const ascending of [false, true]) {
    for (const row of store.database
      .prepare(
        `SELECT * FROM planner_collection_intended ORDER BY parent_id,position ${
          ascending ? 'ASC' : 'DESC'
        },id`,
      )
      .iterate()) {
      const actual = current.get(row.id);
      if (
        !actual ||
        (ascending
          ? Number(actual.position) <= Number(row.position)
          : Number(actual.position) >= Number(row.position))
      )
        continue;
      const issue = move({
        id: String(row.id),
        parentId: row.parent_id === null ? null : String(row.parent_id),
        position: Number(row.position),
        label: String(row.label),
      });
      if (issue) yield issue;
    }
  }
  for (const row of store.database
    .prepare(`SELECT MIN(wanted.id) AS id,wanted.parent_id FROM planner_collection_intended wanted
      LEFT JOIN planner_collection_live actual ON actual.id=wanted.id
      WHERE actual.id IS NULL OR actual.parent_id IS NOT wanted.parent_id OR actual.position<>wanted.position
      GROUP BY wanted.parent_id ORDER BY wanted.parent_id`)
    .iterate()) {
    yield {
      id: String(row.id),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      code: 'COLLECTION_ORDERING_CONFLICT',
      message: `Collection ${row.id} cannot retain its exact intended position after native sibling shifts.`,
      dependencyId: String(row.id),
    };
  }
}

export async function createPlan(
  store: SnapshotStore,
  sourceSchema: SchemaState,
  targetSchema: SchemaState,
  options: PlanOptions,
): Promise<PlanMetadata> {
  schemaCompatible(sourceSchema, targetSchema, new Set(options.modelIds));
  // This private working database has no competing readers or network awaits.
  // One disk-backed transaction avoids a journal/fsync cycle for every index
  // and plan write while leaving no partially planned result after an error.
  return store.transaction(() => {
    const planning = new Planning(store, sourceSchema, targetSchema, options);
    planning.indexRecords();
    planning.initialRecords();
    planning.assetScope();
    planning.initialAssets();
    planning.basicSafety();
    planning.dependencies();
    planning.creationFields();
    // Each pass permanently skips at least one requested mutation. SQLite holds
    // the closure queue and uniqueness ownership; project-sized arrays are never
    // retained. Effective checks are rerun because skipped baselines can protect
    // records/assets or acquire a unique value that the source had released.
    for (;;) {
      planning.effectiveSafety();
      planning.uniqueTransitions();
      planning.blockTransitions();
      planning.executionOrders();
      planning.collectionOrdering();
      if (!planning.processUnsafe()) break;
    }
    return planning.finish();
  });
}
