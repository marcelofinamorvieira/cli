import type { ContentMigrationClient } from './content-migration-client';
import { compareIds } from './engine/compare-ids';
import { ContentError } from './engine/errors';

/** One sibling group of a sortable or tree model and its complete final order. */
export interface RecordOrder {
  /** Model ID. */
  model: string;
  /** Parent record ID for tree models; null for top-level or sortable records. */
  parent: string | null;
  /** Every record of the group, in the desired order. */
  order: string[];
}

interface Sibling {
  id: string;
  position: number;
}

const PASSES = 3;

async function siblings(
  client: ContentMigrationClient,
  { model, parent }: RecordOrder,
): Promise<Sibling[]> {
  const group: Sibling[] = [];
  for await (const item of client.items.listPagedIterator(
    { filter: { type: model }, version: 'current' },
    { perPage: 500 },
  )) {
    const { position, parent_id } = item as {
      position?: unknown;
      parent_id?: unknown;
    };
    if ((typeof parent_id === 'string' ? parent_id : null) !== parent) continue;
    group.push({
      id: item.id,
      position: typeof position === 'number' ? position : 0,
    });
  }
  return group.sort(
    (a, b) => a.position - b.position || compareIds(a.id, b.id),
  );
}

function listed(ids: string[]): string {
  return ids.length > 10
    ? `${ids.slice(0, 10).join(', ')} and ${ids.length - 10} more`
    : ids.join(', ');
}

function assertMembers(group: Sibling[], target: RecordOrder): void {
  const members = new Set(group.map((sibling) => sibling.id));
  const wanted = new Set(target.order);
  const unexpected = [...members].filter((id) => !wanted.has(id));
  const missing = [...wanted].filter((id) => !members.has(id));
  const repeated = target.order.filter(
    (id, index) => target.order.indexOf(id) !== index,
  );
  if (!unexpected.length && !missing.length && !repeated.length) return;
  const problems = [
    unexpected.length ? `not listed: ${listed(unexpected)}` : '',
    missing.length ? `listed but not present: ${listed(missing)}` : '',
    repeated.length ? `listed more than once: ${listed(repeated)}` : '',
  ].filter(Boolean);
  throw new ContentError(
    'ORDERING_MEMBERS_DIFFER',
    `The ${
      target.parent
        ? `children of record ${target.parent}`
        : 'top-level records'
    } of model ${target.model} differ from the order list (${problems.join(
      '; ',
    )}). Update the order list so it names every record of the group exactly once.`,
    { ...target, unexpected, missing, repeated },
  );
}

/** Indexes of one longest strictly increasing subsequence of `values`. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let index = 0; index < values.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]] < values[index]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const kept = new Set<number>();
  for (
    let index = tails.length ? tails[tails.length - 1] : -1;
    index !== -1;
    index = previous[index]
  )
    kept.add(index);
  return kept;
}

/**
 * The fewest moves that turn `group` into `order` when each move inserts a
 * record at a position and shifts the siblings in between, as the CMA does.
 * Records forming the longest run already in relative order stay put; every
 * other record is moved, in desired order, right after its desired
 * predecessor, using the group's existing positions as slots.
 */
function moves(group: Sibling[], order: string[]): Sibling[] {
  const slots = group.map((sibling) => sibling.position);
  const live = group.map((sibling) => sibling.id);
  const rank = new Map(order.map((id, index) => [id, index]));
  const stable = new Set(
    [...longestIncreasing(live.map((id) => rank.get(id)!))].map(
      (index) => live[index],
    ),
  );
  const result: Sibling[] = [];
  order.forEach((id, index) => {
    if (stable.has(id)) return;
    const from = live.indexOf(id);
    live.splice(from, 1);
    const to = index === 0 ? 0 : live.indexOf(order[index - 1]) + 1;
    live.splice(to, 0, id);
    if (to !== from) result.push({ id, position: slots[to] });
  });
  return result;
}

/**
 * Put one sibling group of a sortable or tree model in the given order.
 *
 * The group's current members must be exactly the records in `order`. Only
 * out-of-place records are moved, to the positions the group already uses;
 * the result is read back and moves are repeated if the CMA placed records
 * differently than expected (for example around gaps in the positions). A
 * group already in order costs one listing and no writes.
 */
export async function reorderRecords(
  client: ContentMigrationClient,
  target: RecordOrder,
): Promise<void> {
  for (let pass = 0; ; pass++) {
    const group = await siblings(client, target);
    assertMembers(group, target);
    if (group.every((sibling, index) => sibling.id === target.order[index]))
      return;
    if (pass === PASSES)
      throw new ContentError(
        'ORDERING_NOT_APPLIED',
        `The ${
          target.parent
            ? `children of record ${target.parent}`
            : 'top-level records'
        } of model ${
          target.model
        } are still out of order after ${PASSES} attempts.`,
        {
          ...target,
          actual: group.map((sibling) => sibling.id),
        },
      );
    for (const { id, position } of moves(group, target.order))
      await client.items.update(id, { position });
  }
}
