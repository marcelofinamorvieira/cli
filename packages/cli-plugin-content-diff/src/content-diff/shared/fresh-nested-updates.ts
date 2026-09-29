// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type {
  ContentDiffPlan,
  ItemTypeSchemaSnapshot,
  RecordPlan,
  RecordVersionSnapshot,
} from '../types';
import { projectPlanCreateSeedFields } from './create-seeds';
import { isObject, semanticHash } from './json';
import {
  type ItemTypeLookup,
  collectNestedBlockIds,
  itemTypesById,
  requireItemType,
} from './nested-blocks';
import { compareStrings } from './ordering';

export type FreshNestedBlockUpdateStage = 'published-stage' | 'current-restore';

export interface UnsupportedFreshNestedBlockUpdate {
  recordId: string;
  stage: FreshNestedBlockUpdateStage;
  slice: 'current' | 'published';
  blockId: string;
}

type RecordWriteContract = Pick<
  RecordPlan,
  'id' | 'action' | 'baseline' | 'desired'
>;

type ItemTypeMap = ReadonlyMap<string, ItemTypeSchemaSnapshot>;

/**
 * Models the field-bearing writes performed by runtime phases 5, 7, and 8.
 *
 * Ordinary valid UPDATEs can create unused custom block IDs. Full-validation
 * UPDATEs instead rehydrate supplied IDs from CURRENT, while an ID retained
 * only in PUBLISHED is occupied in either path. Track those two lifetimes and
 * conservatively retain the restriction for invalid/intermediate predecessors
 * and models affected by temporary validator changes. Records resolve their
 * model through desired.itemTypeId; an unknown model throws.
 */
export function findUnsupportedFreshNestedBlockUpdates(
  records: readonly RecordWriteContract[],
  lookup: ItemTypeLookup,
  baselineLookup: ItemTypeLookup = lookup,
  blockedItemTypeIds: ReadonlySet<string> = new Set(),
  unsafeCreateRecordIds: ReadonlySet<string> = new Set(),
): UnsupportedFreshNestedBlockUpdate[] {
  const itemTypes = itemTypesById(lookup);
  const baselineItemTypes = itemTypesById(baselineLookup);
  const issues: UnsupportedFreshNestedBlockUpdate[] = [];

  for (const record of [...records].sort((left, right) =>
    compareStrings(left.id, right.id),
  )) {
    if (
      !record.desired ||
      record.action === 'delete' ||
      record.action === 'noop'
    ) {
      continue;
    }

    const itemTypeId = record.desired.itemTypeId;
    const modelBlocked = blockedItemTypeIds.has(itemTypeId);
    const desiredValidity = record.desired.validity;
    if (!record.baseline) {
      // Phase 5 creates the top-level aggregate from its published slice when
      // present, otherwise from CURRENT. Reference-shell projection can change
      // values in this seed, but it preserves every descendant block identity.
      const seed = record.desired.published ?? record.desired.current;
      collectFreshNestedUpdateIssue(
        issues,
        record.id,
        'current-restore',
        'current',
        seed,
        record.desired.current,
        itemTypeId,
        itemTypes,
        itemTypes,
        nestedBlockIdsForVersion(
          record.desired.published,
          itemTypeId,
          itemTypes,
        ),
        !modelBlocked &&
          !unsafeCreateRecordIds.has(record.id) &&
          freshNestedValidityFlag(
            desiredValidity,
            record.desired.published ? 'published' : 'current',
          ) &&
          freshNestedValidityFlag(desiredValidity, 'current'),
      );
      continue;
    }

    let precedingCurrent = record.baseline.current;
    let precedingItemTypes = baselineItemTypes;
    let publishedIds = nestedBlockIdsForVersion(
      record.baseline.published,
      itemTypeId,
      baselineItemTypes,
    );
    let validPredecessor =
      freshNestedValidityFlag(record.baseline.validity, 'current') &&
      !modelBlocked;

    // Phase 7 writes the desired published version into CURRENT only when the
    // published slice itself differs. If publication already matches, runtime
    // returns before staging and CURRENT remains the baseline draft exactly.
    if (
      record.desired.published &&
      record.desired.published.hash !== record.baseline.published?.hash
    ) {
      collectFreshNestedUpdateIssue(
        issues,
        record.id,
        'published-stage',
        'published',
        precedingCurrent,
        record.desired.published,
        itemTypeId,
        itemTypes,
        precedingItemTypes,
        publishedIds,
        validPredecessor &&
          freshNestedValidityFlag(desiredValidity, 'published'),
      );
      precedingCurrent = record.desired.published;
      precedingItemTypes = itemTypes;
      publishedIds = nestedBlockIdsForVersion(
        record.desired.published,
        itemTypeId,
        itemTypes,
      );
      validPredecessor &&= freshNestedValidityFlag(
        desiredValidity,
        'published',
      );
    } else if (!record.desired.published) {
      // Phase 7 unpublishes first. Blocks absent from both remaining versions
      // are removed, so their former public IDs can subsequently be unused.
      publishedIds = new Set();
    }

    // Phase 8 restores the desired CURRENT version after publication handling.
    collectFreshNestedUpdateIssue(
      issues,
      record.id,
      'current-restore',
      'current',
      precedingCurrent,
      record.desired.current,
      itemTypeId,
      itemTypes,
      precedingItemTypes,
      publishedIds,
      validPredecessor && freshNestedValidityFlag(desiredValidity, 'current'),
    );
  }

  return issues;
}

/** The IDs of every nested block of a record version, or none without one. */
export function nestedBlockIdsForVersion(
  version: Pick<RecordVersionSnapshot, 'fields'> | null | undefined,
  itemTypeId: string,
  lookup: ItemTypeLookup,
): Set<string> {
  const ids = new Set<string>();
  if (version) {
    const itemTypes = itemTypesById(lookup);
    collectNestedBlockIds(
      version.fields,
      ids,
      requireItemType(itemTypes, itemTypeId),
      itemTypes,
    );
  }
  return ids;
}

function collectFreshNestedUpdateIssue(
  output: UnsupportedFreshNestedBlockUpdate[],
  recordId: string,
  stage: FreshNestedBlockUpdateStage,
  slice: UnsupportedFreshNestedBlockUpdate['slice'],
  precedingCurrent: RecordVersionSnapshot,
  desired: RecordVersionSnapshot,
  itemTypeId: string,
  itemTypes: ItemTypeMap,
  precedingItemTypes: ItemTypeMap,
  publishedIds: ReadonlySet<string>,
  allowUnusedIds: boolean,
): void {
  if (precedingCurrent.hash === desired.hash) return;

  const precedingIds = nestedBlockIdsForVersion(
    precedingCurrent,
    itemTypeId,
    precedingItemTypes,
  );
  const freshIds = [...nestedBlockIdsForVersion(desired, itemTypeId, itemTypes)]
    .filter(
      (id) =>
        !precedingIds.has(id) && (!allowUnusedIds || publishedIds.has(id)),
    )
    .sort();

  if (freshIds.length === 0) return;

  output.push({ recordId, stage, slice, blockId: freshIds[0] });
}

/**
 * Includes IDs recreated after their last CURRENT/PUBLISHED copy is removed.
 * Records resolve their model through desired.itemTypeId; an unknown model
 * throws instead of hiding its nested IDs.
 */
export function collectFreshNestedBlockCreateIds(
  records: readonly RecordWriteContract[],
  lookup: ItemTypeLookup,
  baselineLookup: ItemTypeLookup = lookup,
): string[] {
  const itemTypes = itemTypesById(lookup);
  const baselineItemTypes = itemTypesById(baselineLookup);
  const candidates = new Set<string>();
  for (const record of records) {
    if (
      !record.desired ||
      record.action === 'delete' ||
      record.action === 'noop'
    )
      continue;
    const itemTypeId = record.desired.itemTypeId;
    const desiredCurrent = nestedBlockIdsForVersion(
      record.desired.current,
      itemTypeId,
      itemTypes,
    );
    const desiredPublished = nestedBlockIdsForVersion(
      record.desired.published,
      itemTypeId,
      itemTypes,
    );
    if (record.action === 'create' || !record.baseline) {
      for (const id of [...desiredCurrent, ...desiredPublished])
        candidates.add(id);
      continue;
    }
    let current = nestedBlockIdsForVersion(
      record.baseline.current,
      itemTypeId,
      baselineItemTypes,
    );
    let published = nestedBlockIdsForVersion(
      record.baseline.published,
      itemTypeId,
      baselineItemTypes,
    );
    if (
      record.desired.published &&
      record.desired.published.hash !== record.baseline.published?.hash
    ) {
      for (const id of desiredPublished) {
        if (!current.has(id) && !published.has(id)) candidates.add(id);
      }
      current = desiredPublished;
      published = desiredPublished;
    } else if (!record.desired.published) {
      published = new Set();
    }
    for (const id of desiredCurrent) {
      if (!current.has(id) && !published.has(id)) candidates.add(id);
    }
  }
  return [...candidates].sort();
}

/** Validator changes on a block can revalidate every model that contains it. */
export function itemTypeIdsAffectedByValidatorChanges(
  lookup: ItemTypeLookup,
  changedItemTypeIds: ReadonlySet<string>,
): Set<string> {
  const affected = new Set(changedItemTypeIds);
  if (affected.size === 0) return affected;
  const itemTypes = [...itemTypesById(lookup).values()];
  let changed = true;
  while (changed) {
    changed = false;
    for (const itemType of itemTypes) {
      if (affected.has(itemType.id)) continue;
      const embedsAffectedBlock = itemType.fields.some((field) => {
        const keys =
          field.fieldType === 'rich_text'
            ? ['rich_text_blocks']
            : field.fieldType === 'single_block'
              ? ['single_block_blocks']
              : field.fieldType === 'structured_text'
                ? ['structured_text_blocks', 'structured_text_inline_blocks']
                : [];
        return keys.some((key) => {
          const validator: unknown = field.validators[key];
          return (
            isObject(validator) &&
            Array.isArray(validator.item_types) &&
            validator.item_types.some(
              (id: unknown) => typeof id === 'string' && affected.has(id),
            )
          );
        });
      });
      if (embedsAffectedBlock) {
        affected.add(itemType.id);
        changed = true;
      }
    }
  }
  return affected;
}

/**
 * Creates whose phase-5 seed differs from their planned first version, and
 * every declared reference shell. Their descendants' IDs are not proven to be
 * creatable by an ordinary valid UPDATE, so fresh nested IDs stay blocked.
 */
export function unsafeFreshNestedCreateRecordIds(
  plan: Pick<ContentDiffPlan, 'execution' | 'records' | 'schema'>,
): Set<string> {
  const result = new Set(plan.execution.shellRecordIds);
  const seeds = projectPlanCreateSeedFields(plan);
  for (const record of plan.records) {
    if (record.action !== 'create' || !record.desired) continue;
    const seed = record.desired.published ?? record.desired.current;
    if (semanticHash(seeds.get(record.id)) !== seed.hash) result.add(record.id);
  }
  return result;
}

/** Reads one validity flag; anything but true counts as not valid. */
function freshNestedValidityFlag(
  validity: unknown,
  key: 'current' | 'published',
): boolean {
  return isObject(validity) && validity[key] === true;
}
