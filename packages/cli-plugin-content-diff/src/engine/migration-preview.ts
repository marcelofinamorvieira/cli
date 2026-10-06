import type { SnapshotStore } from './store';
import type {
  Action,
  ApplyPreviewResult,
  Kind,
  PlanMetadata,
  PlanPreviewGroup,
} from './types';

/** Aggregate on disk: preview size follows the schema, not the record count. */
export function buildPlanPreview(
  store: SnapshotStore,
  metadata: PlanMetadata,
  environmentId: string,
): ApplyPreviewResult {
  const groups = new Map<string, PlanPreviewGroup>();
  const models = new Map(
    metadata.schema.models.map((model) => [model.id, model]),
  );
  for (const row of store.database
    .prepare(
      'SELECT kind,model_id,action,COUNT(*) AS total FROM plan GROUP BY kind,model_id,action ORDER BY kind,model_id,action',
    )
    .iterate()) {
    const kind = String(row.kind) as Kind;
    const key = `${kind}:${row.model_id ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      const model = models.get(String(row.model_id));
      group = {
        kind,
        ...(model
          ? { model: { id: model.id, apiKey: model.apiKey, name: model.name } }
          : {}),
        counts: { create: 0, update: 0, delete: 0, noop: 0, skip: 0 },
      };
      groups.set(key, group);
    }
    group.counts[String(row.action) as Action] = Number(row.total);
  }
  return {
    dryRun: true,
    environmentId,
    mutations: 0,
    partial: Object.values(metadata.counts).some((counts) => counts.skip > 0),
    counts: metadata.counts,
    groups: [...groups.values()].filter(
      ({ counts }) =>
        counts.create + counts.update + counts.delete + counts.skip > 0,
    ),
    temporarySchemaChanges: metadata.temporarySchemaChanges.length,
  };
}
