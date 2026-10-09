import { ContentError } from './errors';
import { recordSubject } from './migration-emit';
import type { SnapshotStore } from './store';
import type { SchemaState } from './types';

const LISTED = 20;

export interface InvalidSourceRecord {
  id: string;
  modelId: string;
  versions: Array<'current' | 'published'>;
}

/**
 * The migration can only write source records the CMA accepts, so generation
 * stops when a record it would write is one the source CMA itself reports
 * invalid. This reads the CMA's verdict; it never evaluates validators.
 *
 * An invalid published version always stops generation. An invalid current
 * version stops it too, unless the model has draft mode with invalid draft
 * saving, where the CMA accepts that draft.
 */
export function invalidSourceRecords(
  store: SnapshotStore,
  schema: SchemaState,
): InvalidSourceRecord[] {
  const models = new Map(schema.models.map((model) => [model.id, model]));
  const result: InvalidSourceRecord[] = [];
  for (const action of ['create', 'update'] as const)
    for (const entry of store.planEntries('record', action)) {
      const state = store.getRecord('source', entry.id);
      if (!state?.invalid) continue;
      const model = models.get(state.modelId);
      const versions: InvalidSourceRecord['versions'] = [];
      if (
        state.invalid.current &&
        !(model?.draftMode && model.saveInvalidDrafts)
      )
        versions.push('current');
      if (state.invalid.published && state.published)
        versions.push('published');
      if (versions.length)
        result.push({ id: state.id, modelId: state.modelId, versions });
    }
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function assertSourceRecordsValid(
  store: SnapshotStore,
  schema: SchemaState,
): void {
  const invalid = invalidSourceRecords(store, schema);
  if (!invalid.length) return;
  const lines = invalid.slice(0, LISTED).map((record) => {
    const state = store.getRecord('source', record.id);
    const which = record.versions
      .map((version) =>
        version === 'current' ? 'current version' : 'published version',
      )
      .join(' and ');
    return `- ${recordSubject(
      record,
      schema,
      state?.current,
    )}: ${which} invalid`;
  });
  if (invalid.length > LISTED)
    lines.push(`- and ${invalid.length - LISTED} more`);
  throw new ContentError(
    'INVALID_SOURCE_RECORDS',
    [
      `The diff cannot be generated: ${invalid.length} source record${
        invalid.length === 1 ? ' is' : 's are'
      } invalid, and invalid records cannot be diffed. Fix them in the source environment and run content:diff again. Only models with draft mode and "Save invalid drafts" enabled may keep an invalid draft.`,
      ...lines,
    ].join('\n'),
    { records: invalid },
  );
}
