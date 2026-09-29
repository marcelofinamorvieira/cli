import { compareStrings } from './shared/ordering';
import {
  inspectionItemTypesDigest,
  schemaWithInspectionItemTypes,
} from './shared/schema-state';
import type {
  ContentInspectionSnapshot,
  ContentSnapshot,
  SchemaSnapshot,
  StructuralContentIssue,
} from './types';
import { ContentDiffError } from './types';

export {
  inspectionItemTypesDigest,
  schemaWithInspectionItemTypes,
} from './shared/schema-state';

export function buildContentInspectionSnapshot(
  fullSchema: SchemaSnapshot,
  managedSchema: SchemaSnapshot,
  encounteredItemTypeIds: ReadonlySet<string>,
  structuralIssues: readonly StructuralContentIssue[],
): ContentInspectionSnapshot {
  const managedIds = new Set(managedSchema.itemTypes.map(({ id }) => id));
  const fullById = new Map(
    fullSchema.itemTypes.map((itemType) => [itemType.id, itemType]),
  );
  const itemTypes = [...encounteredItemTypeIds]
    .filter((id) => !managedIds.has(id))
    .sort()
    .map((id) => {
      const itemType = fullById.get(id);
      if (!itemType?.modularBlock) {
        throw new ContentDiffError(
          'UNSUPPORTED_CONTENT_STATE',
          `Content inspection cannot resolve modular block model ${id}.`,
          { itemTypeId: id },
        );
      }
      return itemType;
    });

  return {
    itemTypes,
    digest: inspectionItemTypesDigest(itemTypes),
    structuralIssues: [...structuralIssues].sort(compareStructuralIssues),
  };
}

export function contentTraversalSchema(
  snapshot: Pick<ContentSnapshot, 'schema' | 'inspection'>,
): SchemaSnapshot {
  return schemaWithInspectionItemTypes(
    snapshot.schema,
    snapshot.inspection.itemTypes,
  );
}

export function inspectionSubsetMatches(
  inspection: ContentInspectionSnapshot,
  refreshedFullSchema: SchemaSnapshot,
): boolean {
  const wantedIds = new Set(inspection.itemTypes.map(({ id }) => id));
  const refreshed = refreshedFullSchema.itemTypes
    .filter(({ id }) => wantedIds.has(id))
    .sort((left, right) => compareStrings(left.id, right.id));
  return (
    refreshed.length === wantedIds.size &&
    inspectionItemTypesDigest(refreshed) === inspection.digest
  );
}

function compareStructuralIssues(
  left: StructuralContentIssue,
  right: StructuralContentIssue,
): number {
  return (
    compareStrings(left.recordId, right.recordId) ||
    compareStrings(left.slice, right.slice) ||
    compareStrings(left.fieldPath, right.fieldPath) ||
    compareStrings(left.locale ?? '', right.locale ?? '') ||
    compareStrings(left.validatorKey, right.validatorKey) ||
    compareStrings(left.blockId, right.blockId) ||
    compareStrings(left.blockItemTypeId, right.blockItemTypeId)
  );
}
