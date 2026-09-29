// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { UploadCollectionPlan, UploadCollectionSnapshot } from '../types';
import { isPortableDatoId } from './ids';
import { semanticHash, stableStringify } from './json';
import { isPlainJsonObject } from './upload-contract';

const UPLOAD_COLLECTION_SNAPSHOT_KEYS = [
  'hash',
  'id',
  'label',
  'parentId',
  'position',
] as const;

export function deriveRequiredManageUploadCollections(
  plans: readonly UploadCollectionPlan[],
): boolean {
  return plans.length > 0;
}

export function uploadCollectionPlanContractError(
  plan: UploadCollectionPlan,
): string | null {
  if (!plan || !['create', 'update', 'noop'].includes(plan.action)) {
    return 'action is invalid';
  }
  if (plan.action === 'create' && !isPortableDatoId(plan.id)) {
    return 'create ID is not a portable DatoCMS ID';
  }

  const { baseline, desired } = plan;
  if (
    (baseline && uploadCollectionSnapshotContractError(baseline)) ||
    !desired ||
    uploadCollectionSnapshotContractError(desired)
  ) {
    return 'baseline or desired snapshot is malformed';
  }
  if (baseline && baseline.id !== plan.id) {
    return 'baseline ID does not match the plan ID';
  }
  if (desired.id !== plan.id) {
    return 'desired ID does not match the plan ID';
  }

  if (
    plan.action === 'create' &&
    (baseline !== null || plan.expectedTargetHash !== null)
  ) {
    return 'create action is inconsistent with baseline or expectedTargetHash';
  }
  if (
    plan.action === 'update' &&
    (!baseline || plan.expectedTargetHash !== baseline.hash)
  ) {
    return 'update action is inconsistent with baseline or expectedTargetHash';
  }
  if (
    plan.action === 'update' &&
    baseline &&
    stableStringify(uploadCollectionSemanticState(baseline)) ===
      stableStringify(uploadCollectionSemanticState(desired))
  ) {
    return 'update action has no baseline/desired delta';
  }
  if (
    plan.action === 'noop' &&
    (!baseline ||
      plan.expectedTargetHash !== baseline.hash ||
      stableStringify(uploadCollectionSemanticState(baseline)) !==
        stableStringify(uploadCollectionSemanticState(desired)))
  ) {
    return 'noop action does not contain identical baseline and desired state';
  }

  return null;
}

export function uploadCollectionOrderContractError(
  plans: readonly UploadCollectionPlan[],
  collectionOrder: readonly string[],
  initialOccupancy?: readonly UploadCollectionSnapshot[],
): string | null {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const changedIds = plans
    .filter(({ action }) => action !== 'noop')
    .map(({ id }) => id)
    .sort();
  if (
    stableStringify([...new Set(collectionOrder)].sort()) !==
      stableStringify(changedIds) ||
    collectionOrder.length !== changedIds.length
  ) {
    return 'collectionOrder must contain every non-noop collection exactly once';
  }

  const live = new Map<string, UploadCollectionSnapshot>();
  if (initialOccupancy) {
    for (const snapshot of initialOccupancy) live.set(snapshot.id, snapshot);
  } else {
    for (const plan of plans) {
      if (plan.baseline) live.set(plan.id, plan.baseline);
    }
  }
  for (const id of collectionOrder) {
    const plan = byId.get(id);
    if (!plan || plan.action === 'noop') {
      return `collectionOrder contains invalid entry ${id}`;
    }
    const desiredKey = uploadCollectionLabelKey(plan.desired);
    const occupant = [...live.entries()].find(
      ([candidateId, snapshot]) =>
        candidateId !== id && uploadCollectionLabelKey(snapshot) === desiredKey,
    );
    if (occupant) {
      return `collection ${id} would claim label ${JSON.stringify(
        plan.desired.label,
      )} under parent ${String(
        plan.desired.parentId,
      )} while it is occupied by ${occupant[0]}`;
    }
    live.set(id, plan.desired);
  }
  return null;
}

function uploadCollectionSnapshotContractError(
  snapshot: UploadCollectionSnapshot,
): string | null {
  if (
    !isPlainJsonObject(snapshot) ||
    stableStringify(Object.keys(snapshot).sort()) !==
      stableStringify(UPLOAD_COLLECTION_SNAPSHOT_KEYS) ||
    typeof snapshot.id !== 'string' ||
    snapshot.id.length === 0 ||
    typeof snapshot.label !== 'string' ||
    snapshot.label.trim().length === 0 ||
    (snapshot.parentId !== null &&
      (typeof snapshot.parentId !== 'string' ||
        snapshot.parentId.length === 0)) ||
    !Number.isSafeInteger(snapshot.position) ||
    typeof snapshot.hash !== 'string'
  ) {
    return 'snapshot shape or scalar values are invalid';
  }
  return snapshot.hash === semanticHash(uploadCollectionSemanticState(snapshot))
    ? null
    : 'snapshot semantic hash does not match its state';
}

function uploadCollectionSemanticState(snapshot: UploadCollectionSnapshot) {
  return {
    id: snapshot.id,
    label: snapshot.label,
    parentId: snapshot.parentId,
    position: snapshot.position,
  };
}

/**
 * The sibling-label key DatoCMS keeps unique: parent ID (or '' at the root)
 * and label. The runtime also keys live collections with it.
 */
export function uploadCollectionLabelKey(
  snapshot: UploadCollectionSnapshot,
): string {
  return `${snapshot.parentId ?? ''}\u0000${snapshot.label}`;
}
