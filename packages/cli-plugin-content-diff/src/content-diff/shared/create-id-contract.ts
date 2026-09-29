// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { ContentDiffPlan } from '../types';
import { collectFreshNestedBlockCreateIds } from './fresh-nested-updates';
import { isPortableDatoId } from './ids';
import { schemaWithInspectionItemTypes } from './schema-state';

/** Re-derives every ID that an executable plan can ask CMA to create. */
export function findNonPortableCreateIds(
  plan: Pick<
    ContentDiffPlan,
    'records' | 'schema' | 'targetInspection' | 'uploadCollections' | 'uploads'
  >,
): string[] {
  const candidates = new Set<string>();
  for (const record of plan.records) {
    if (record.action !== 'create' || !record.desired) continue;
    candidates.add(record.id);
  }
  const captureSchema = schemaWithInspectionItemTypes(
    plan.schema,
    plan.targetInspection.itemTypes,
  );
  for (const blockId of collectFreshNestedBlockCreateIds(
    plan.records,
    captureSchema,
    captureSchema,
  )) {
    candidates.add(blockId);
  }
  for (const upload of plan.uploads) {
    if (upload.action === 'create') candidates.add(upload.id);
  }
  for (const collection of plan.uploadCollections) {
    if (collection.action === 'create') candidates.add(collection.id);
  }

  return [...candidates].filter((id) => !isPortableDatoId(id)).sort();
}

export function findRecordSnapshotIdentityMismatches(
  plan: Pick<ContentDiffPlan, 'records'>,
): string[] {
  const mismatches: string[] = [];
  for (const record of plan.records) {
    if (record.baseline && record.baseline.id !== record.id) {
      mismatches.push(`${record.id}:baseline=${record.baseline.id}`);
    }
    if (record.baseline && record.baseline.itemTypeId !== record.itemTypeId) {
      mismatches.push(
        `${record.id}:baselineItemType=${record.baseline.itemTypeId}`,
      );
    }
    if (record.desired && record.desired.id !== record.id) {
      mismatches.push(`${record.id}:desired=${record.desired.id}`);
    }
    if (record.desired && record.desired.itemTypeId !== record.itemTypeId) {
      mismatches.push(
        `${record.id}:desiredItemType=${record.desired.itemTypeId}`,
      );
    }
  }
  return mismatches.sort();
}
