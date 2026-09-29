// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { ContentDiffPlan, RecordPlan } from '../types';
import { sharedFailure } from './failure-factory';
import { isObject } from './json';
import { type ItemTypeLookup, itemTypesById } from './nested-blocks';
import { compareStrings } from './ordering';

/**
 * The position of a record reparented to the end of a sibling group whose end
 * cannot be known, because retained destination-only siblings are absent from
 * the plan. Only a later explicit position write resolves it.
 */
export const UNKNOWN_UNTIL_POSITIONED = 'unknown-until-positioned' as const;

/** A record's modeled place among its siblings. */
export interface RecordTopologyState {
  itemTypeId: string;
  parentId: string | null;
  position: number | typeof UNKNOWN_UNTIL_POSITIONED | null;
}

/** A modeled topology position, or a live row that may be missing. */
export interface RecordPositionState {
  parentId?: string | null;
  position?: number | typeof UNKNOWN_UNTIL_POSITIONED | null;
}

type TopologyRecord = Pick<RecordPlan, 'id'> & {
  desired: { topology: { parentId: string | null } } | null;
};

type PositionedRecord = Pick<RecordPlan, 'id' | 'itemTypeId'> & {
  desired: {
    topology: { parentId: string | null; position: number | null };
  } | null;
};

/** Creating at a requested position shifts every following sibling. */
export function shiftForInsert(
  states: Map<string, RecordTopologyState>,
  itemTypeId: string,
  parentId: string | null,
  position: number,
  excludedId: string,
): void {
  for (const [id, state] of states) {
    if (
      id !== excludedId &&
      state.itemTypeId === itemTypeId &&
      state.parentId === parentId &&
      typeof state.position === 'number' &&
      state.position >= position
    ) {
      state.position += 1;
    }
  }
}

/** The position a parent-only move gives a record: the end of its group. */
export function nextKnownPosition(
  states: ReadonlyMap<string, RecordTopologyState>,
  itemTypeId: string,
  parentId: string | null,
  excludedId: string,
): number {
  let maximum = 0;
  let found = false;
  for (const [id, state] of states) {
    if (
      id !== excludedId &&
      state.itemTypeId === itemTypeId &&
      state.parentId === parentId &&
      typeof state.position === 'number'
    ) {
      found = true;
      maximum = Math.max(maximum, state.position);
    }
  }
  return found ? maximum + 1 : 1;
}

/** Applies the sibling shifts of one explicit position write. */
export function moveStatePosition(
  states: Map<string, RecordTopologyState>,
  recordId: string,
  desiredPosition: number,
): void {
  const moved = states.get(recordId);
  if (!moved) return;
  const previous = moved.position;
  for (const [id, state] of states) {
    if (
      id === recordId ||
      state.itemTypeId !== moved.itemTypeId ||
      state.parentId !== moved.parentId ||
      typeof state.position !== 'number'
    ) {
      continue;
    }
    if (typeof previous !== 'number') {
      if (state.position >= desiredPosition) state.position += 1;
    } else if (
      previous < desiredPosition &&
      state.position > previous &&
      state.position <= desiredPosition
    ) {
      state.position -= 1;
    } else if (
      previous > desiredPosition &&
      state.position >= desiredPosition &&
      state.position < previous
    ) {
      state.position += 1;
    }
  }
  moved.position = desiredPosition;
}

/**
 * Orders records so every desired tree parent comes before its children,
 * then by ID. A cycle among desired parents throws.
 */
export function parentFirst<Entry extends TopologyRecord>(
  entries: readonly Entry[],
): Entry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const depthCache = new Map<string, number>();
  const depth = (entry: Entry, visiting: ReadonlySet<string>): number => {
    const cached = depthCache.get(entry.id);
    if (cached !== undefined) return cached;
    if (visiting.has(entry.id)) {
      throw sharedFailure(
        'treeCycle',
        `Tree cycle includes record ${entry.id}.`,
        { recordId: entry.id },
      );
    }
    const next = new Set(visiting);
    next.add(entry.id);
    const parentId = entry.desired?.topology.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    const result = parent ? depth(parent, next) + 1 : 0;
    depthCache.set(entry.id, result);
    return result;
  };
  return [...entries].sort(
    (left, right) =>
      depth(left, new Set()) - depth(right, new Set()) ||
      compareStrings(left.id, right.id),
  );
}

/**
 * The entries in execution order: first those the order names, once each,
 * then every other entry by ID.
 */
export function orderedPlans<Entry extends { id: string }>(
  order: readonly string[],
  entries: readonly Entry[],
): Entry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const output: Entry[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const entry = byId.get(id);
    if (entry && !seen.has(id)) {
      output.push(entry);
      seen.add(id);
    }
  }
  for (const entry of [...entries].sort((left, right) =>
    compareStrings(left.id, right.id),
  )) {
    if (!seen.has(entry.id)) output.push(entry);
  }
  return output;
}

export function recordSiblingGroupKey(
  itemTypeId: string,
  parentId: string | null,
): string {
  return `${itemTypeId}\u0000${String(parentId)}`;
}

/**
 * The sibling groups of ordered models whose membership or order the plan
 * changes: both the baseline and the desired group of every created,
 * deleted, or moved record.
 */
export function affectedSiblingGroups(
  records: readonly Pick<
    RecordPlan,
    'action' | 'baseline' | 'changes' | 'desired' | 'itemTypeId'
  >[],
  lookup: ItemTypeLookup,
): Set<string> {
  const itemTypes = itemTypesById(lookup);
  const groups = new Set<string>();
  for (const record of records) {
    const itemType = itemTypes.get(record.itemTypeId);
    if (
      !itemType ||
      (!itemType.tree && !itemType.sortable) ||
      record.action === 'noop'
    ) {
      continue;
    }
    if (
      record.action === 'create' ||
      record.action === 'delete' ||
      record.changes.topology
    ) {
      if (record.baseline) {
        groups.add(
          recordSiblingGroupKey(
            record.itemTypeId,
            record.baseline.topology.parentId,
          ),
        );
      }
      if (record.desired) {
        groups.add(
          recordSiblingGroupKey(
            record.itemTypeId,
            record.desired.topology.parentId,
          ),
        );
      }
    }
  }
  return groups;
}

/**
 * Whether the positioned records sit where the plan wants them: at their
 * exact positions when absolute positions are reproducible, otherwise in the
 * desired relative order within each sibling group.
 */
export function positionGoalReached(
  records: readonly PositionedRecord[],
  states: ReadonlyMap<string, RecordPositionState>,
  absolutePositionsReproducible: boolean,
): boolean {
  if (absolutePositionsReproducible) {
    return records.every((record) => {
      const state = states.get(record.id);
      return Boolean(
        state &&
          state.parentId === record.desired!.topology.parentId &&
          state.position === record.desired!.topology.position,
      );
    });
  }

  const groups = new Map<
    string,
    {
      actual: Array<{ id: string; position: number }>;
      desired: Array<{ id: string; position: number }>;
    }
  >();
  for (const record of records) {
    const state = states.get(record.id);
    if (
      !state ||
      state.parentId !== record.desired!.topology.parentId ||
      typeof state.position !== 'number'
    ) {
      return false;
    }
    const key = recordSiblingGroupKey(
      record.itemTypeId,
      record.desired!.topology.parentId,
    );
    const group = groups.get(key) ?? { actual: [], desired: [] };
    group.actual.push({ id: record.id, position: state.position });
    group.desired.push({
      id: record.id,
      position: record.desired!.topology.position!,
    });
    groups.set(key, group);
  }
  const compare = (
    left: { id: string; position: number },
    right: { id: string; position: number },
  ) => left.position - right.position || compareStrings(left.id, right.id);
  for (const group of groups.values()) {
    const actualIds = [...group.actual].sort(compare).map(({ id }) => id);
    const desiredIds = [...group.desired].sort(compare).map(({ id }) => id);
    if (
      actualIds.length !== desiredIds.length ||
      actualIds.some((id, index) => id !== desiredIds[index])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the plan can reproduce absolute record positions. Disabling
 * deletions does not by itself make positions ambiguous: only a retained
 * destination-only sibling, which the planner records as an
 * ABSOLUTE_POSITION_NOT_REPRODUCIBLE warning, reduces the attainable contract
 * to managed relative order.
 */
export function absoluteRecordPositionsReproducible(
  plan: Partial<Pick<ContentDiffPlan, 'options' | 'warnings'>> | null,
): boolean {
  if (plan?.options?.includeDeletions === true) return true;
  const warnings: unknown = plan?.warnings;
  return !(
    Array.isArray(warnings) &&
    warnings.some(
      (warning) =>
        isObject(warning) &&
        warning.code === 'ABSOLUTE_POSITION_NOT_REPRODUCIBLE',
    )
  );
}
