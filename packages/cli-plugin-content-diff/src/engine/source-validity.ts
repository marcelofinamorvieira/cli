import { compareIds } from './compare-ids';
import { recordLabel } from './emit';
import { ContentError } from './errors';
import type { Plan } from './planner';
import type { SchemaState } from './types';

const LISTED = 20;

export interface InvalidSourceRecord {
  id: string;
  modelId: string;
  versions: Array<'current' | 'published'>;
}

/**
 * The diff can only write source records the CMA accepts, so generation
 * stops when a record it would write is one the source CMA itself reports
 * invalid. This reads the CMA's verdict; it never evaluates validators.
 *
 * An invalid published version always stops generation. An invalid current
 * version stops it too, unless the destination model has draft mode with
 * invalid draft saving: the destination's setting is the one the CMA applies
 * when the diff writes that draft.
 */
export function invalidSourceRecords(
  plan: Plan,
  destination: SchemaState,
): InvalidSourceRecord[] {
  const models = new Map(destination.models.map((model) => [model.id, model]));
  const result: InvalidSourceRecord[] = [];
  for (const entry of plan.records.values()) {
    if (entry.action !== 'create' && entry.action !== 'update') continue;
    const facts = entry.desired;
    if (!facts?.invalid) continue;
    const model = models.get(facts.modelId);
    const versions: InvalidSourceRecord['versions'] = [];
    if (facts.invalid.current && !(model?.draftMode && model.saveInvalidDrafts))
      versions.push('current');
    if (facts.invalid.published && facts.published) versions.push('published');
    if (versions.length)
      result.push({ id: facts.id, modelId: facts.modelId, versions });
  }
  return result.sort((a, b) => compareIds(a.id, b.id));
}

/** Records are named with the source schema, where they must be fixed. */
export function assertSourceRecordsValid(
  plan: Plan,
  source: SchemaState,
  destination: SchemaState,
): void {
  const invalid = invalidSourceRecords(plan, destination);
  if (!invalid.length) return;
  const lines = invalid.slice(0, LISTED).map((record) => {
    const which = record.versions
      .map((version) =>
        version === 'current' ? 'current version' : 'published version',
      )
      .join(' and ');
    return `- ${recordLabel(
      source,
      record.modelId,
      record.id,
      plan.records.get(record.id)?.desired?.title,
    )}: ${which} invalid`;
  });
  if (invalid.length > LISTED)
    lines.push(`- and ${invalid.length - LISTED} more`);
  throw new ContentError(
    'INVALID_SOURCE_RECORDS',
    [
      `The diff cannot be generated: ${invalid.length} source record${
        invalid.length === 1 ? ' is' : 's are'
      } invalid, and invalid records cannot be diffed. Fix them in the source environment and run content:diff again. Only destination models with draft mode and "Save invalid drafts" enabled may keep an invalid draft.`,
      ...lines,
    ].join('\n'),
    { records: invalid },
  );
}
