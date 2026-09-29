import type { CmaClient } from '@datocms/cli-utils';
import { LEGACY_ID_MAPPING_MODEL_API_KEY } from '../../content-diff/shared/contract';
import {
  type LegacyIdMappingSchemaMismatch,
  inspectLegacyMappingFields,
  legacyMappingModelMismatches,
} from '../../content-diff/shared/legacy-id-ledger';
import type { Schema } from './types';

/**
 * Internal bookkeeping owned by the content-diff plugin. It is deliberately
 * outside the user-managed schema so a mapping ledger created in one
 * environment never becomes a schema migration create/delete operation.
 */
export const CONTENT_DIFF_MAPPING_MODEL_API_KEY =
  LEGACY_ID_MAPPING_MODEL_API_KEY;

const ITEM_TYPE_REFERENCE_VALIDATORS = new Set([
  'item_item_type',
  'items_item_type',
  'rich_text_blocks',
  'single_block_blocks',
  'structured_text_blocks',
  'structured_text_inline_blocks',
  'structured_text_links',
]);

export async function fetchSchema(client: CmaClient.Client): Promise<Schema> {
  const [
    siteResponse,
    menuItemsResponse,
    schemaMenuItemsResponse,
    pluginsResponse,
    workflowsResponse,
    itemTypeFiltersResponse,
    uploadFiltersResponse,
  ] = await Promise.all([
    client.site.rawFind({
      include: 'item_types,item_types.fields,item_types.fieldsets',
    }),
    client.menuItems.rawList(),
    client.schemaMenuItems.rawList(),
    client.plugins.rawList(),
    client.workflows.rawList(),
    client.itemTypeFilters.rawList(),
    client.uploadFilters.rawList(),
  ]);

  const includedResources = siteResponse.included || [];

  const internalItemTypes = includedResources.filter(
    (resource): resource is CmaClient.RawApiTypes.ItemType =>
      resource.type === 'item_type' &&
      resource.attributes.api_key === CONTENT_DIFF_MAPPING_MODEL_API_KEY,
  );
  const internalItemTypeIds = new Set(internalItemTypes.map(({ id }) => id));

  const allFields = includedResources.filter(
    (x): x is CmaClient.RawApiTypes.Field => x.type === 'field',
  );

  const allFieldsets: CmaClient.RawApiTypes.Fieldset[] =
    includedResources.filter(
      (x): x is CmaClient.RawApiTypes.Fieldset => x.type === 'fieldset',
    );

  assertContentDiffMappingModelContract({
    itemTypes: internalItemTypes,
    fields: allFields,
    fieldsets: allFieldsets,
    menuItems: menuItemsResponse.data,
    schemaMenuItems: schemaMenuItemsResponse.data,
    itemTypeFilters: itemTypeFiltersResponse.data,
  });

  const schemaMenuItems = withoutInternalSchemaMenuItems(
    schemaMenuItemsResponse.data,
    internalItemTypeIds,
  );
  const menuItems = withoutInternalMenuItems(
    menuItemsResponse.data,
    internalItemTypeIds,
  );
  const internalItemTypeFilters = itemTypeFiltersResponse.data.filter((itf) =>
    internalItemTypeIds.has(itf.relationships.item_type.data.id),
  );

  if (internalItemTypeFilters.length > 0) {
    throw internalNavigationConflict(
      'item-type filters',
      internalItemTypeFilters.map(({ id }) => id),
    );
  }

  return {
    siteEntity: siteResponse.data,
    internalItemTypeIds: [...internalItemTypeIds].sort(),
    itemTypesById: Object.fromEntries(
      includedResources
        .filter(
          (x): x is CmaClient.RawApiTypes.ItemType =>
            x.type === 'item_type' && !internalItemTypeIds.has(x.id),
        )
        .map((itemType) => [
          itemType.id,
          {
            entity: itemType,
            fieldsById: Object.fromEntries(
              allFields
                .filter(
                  (f) => f.relationships.item_type.data.id === itemType.id,
                )
                .map((field) => [field.id, field]),
            ),
            fieldsetsById: Object.fromEntries(
              allFieldsets
                .filter(
                  (f) => f.relationships.item_type.data.id === itemType.id,
                )
                .map((fieldset) => [fieldset.id, fieldset]),
            ),
          },
        ]),
    ),
    menuItemsById: Object.fromEntries(
      menuItems.map((menuItem) => [menuItem.id, menuItem]),
    ),
    schemaMenuItemsById: Object.fromEntries(
      schemaMenuItems.map((schemaMenuItem) => [
        schemaMenuItem.id,
        schemaMenuItem,
      ]),
    ),
    pluginsById: Object.fromEntries(
      pluginsResponse.data.map((plugin) => [plugin.id, plugin]),
    ),
    workflowsById: Object.fromEntries(
      workflowsResponse.data.map((workflow) => [workflow.id, workflow]),
    ),
    itemTypeFiltersById: Object.fromEntries(
      itemTypeFiltersResponse.data
        .filter((itf) => itf.attributes.shared)
        .map((itemTypeFilter) => [itemTypeFilter.id, itemTypeFilter]),
    ),
    uploadFiltersById: Object.fromEntries(
      uploadFiltersResponse.data
        .filter((itf) => itf.attributes.shared)
        .map((uploadFilter) => [uploadFilter.id, uploadFilter]),
    ),
  };
}

/**
 * Hides the ledger model only when it is exactly the model content:diff
 * migrations create. The model and field checks are the shared ledger
 * contract that content:diff and the generated runtime apply, read through
 * `flattenRawResource`; navigation, filters and inbound references are
 * checked here because only schema diffing reads them.
 *
 * A model that takes the reserved API key without matching the contract is
 * never hidden and never diffed: schema generation fails and names the
 * differences, because hiding it could drop user schema from the migration
 * and diffing it would recreate an unusable ledger in another environment.
 */
function assertContentDiffMappingModelContract({
  itemTypes,
  fields,
  fieldsets,
  menuItems,
  schemaMenuItems,
  itemTypeFilters,
}: {
  itemTypes: CmaClient.RawApiTypes.ItemType[];
  fields: CmaClient.RawApiTypes.Field[];
  fieldsets: CmaClient.RawApiTypes.Fieldset[];
  menuItems: CmaClient.RawApiTypes.MenuItem[];
  schemaMenuItems: CmaClient.RawApiTypes.SchemaMenuItem[];
  itemTypeFilters: CmaClient.RawApiTypes.ItemTypeFilter[];
}): void {
  if (itemTypes.length === 0) return;

  const itemType = itemTypes[0];
  const modelFields = fields.filter(
    (field) => field.relationships.item_type.data.id === itemType.id,
  );
  const modelFieldsets = fieldsets.filter(
    (fieldset) => fieldset.relationships.item_type.data.id === itemType.id,
  );
  const modelMenuItems = menuItems.filter(
    (item) => item.relationships.item_type.data?.id === itemType.id,
  );
  const modelSchemaMenuItems = schemaMenuItems.filter(
    (item) => item.relationships.item_type.data?.id === itemType.id,
  );
  const modelFilters = itemTypeFilters.filter(
    (filter) => filter.relationships.item_type.data.id === itemType.id,
  );
  const inboundReferenceFields = fields.filter(
    (field) =>
      field.relationships.item_type.data.id !== itemType.id &&
      Object.entries(field.attributes.validators).some(
        ([validator, configuration]) =>
          ITEM_TYPE_REFERENCE_VALIDATORS.has(validator) &&
          configuration &&
          typeof configuration === 'object' &&
          'item_types' in configuration &&
          Array.isArray(configuration.item_types) &&
          configuration.item_types.includes(itemType.id),
      ),
  );
  const model = flattenRawResource(itemType);
  const mismatches: LegacyIdMappingSchemaMismatch[] = [
    ...legacyMappingModelMismatches(model),
    // Schema diffing never resumes an interrupted ledger setup: both fields
    // must exist, match exactly and be the model's only fields.
    ...inspectLegacyMappingFields(
      model,
      modelFields.map(flattenRawResource),
      null,
      false,
    ).mismatches,
  ];
  const fieldApiKeys = new Map<string, unknown>(
    modelFields.map((field) => [field.id, field.attributes?.api_key]),
  );
  const schemaMenuIsExact =
    modelSchemaMenuItems.length === 1 &&
    modelSchemaMenuItems[0].relationships.parent.data === null &&
    modelSchemaMenuItems[0].relationships.children.data.length === 0;
  const differences = [
    ...(itemTypes.length > 1 ? ['duplicate models'] : []),
    ...mismatches.map((mismatch) => describeMismatch(mismatch, fieldApiKeys)),
    ...(modelFieldsets.length > 0 ? ['fieldsets'] : []),
    ...(modelMenuItems.length > 0 ? ['content menu items'] : []),
    ...(schemaMenuIsExact ? [] : ['schema menu item']),
    ...(modelFilters.length > 0 ? ['item-type filters'] : []),
    ...(inboundReferenceFields.length > 0
      ? [
          `referenced by fields ${inboundReferenceFields
            .map(({ id }) => id)
            .sort()
            .join(', ')}`,
        ]
      : []),
  ];

  if (differences.length > 0) {
    throw new Error(
      `The reserved model API key "${CONTENT_DIFF_MAPPING_MODEL_API_KEY}" is not the exact internal content-diff mapping contract (${[
        ...new Set(differences),
      ].join(
        '; ',
      )}). Rerun the content migration that created it if setup was interrupted, or rename the conflicting model before generating a schema migration.`,
    );
  }
}

/**
 * Adapts a raw JSON:API resource to the flat shape the simple CMA client
 * returns, which the shared ledger contract checks read: attributes and
 * relationship data side by side with the ID. A relationship without a
 * `data` member is kept as is, so the contract reports it as malformed.
 */
function flattenRawResource(resource: {
  id: string;
  attributes?: object;
  relationships?: object;
}): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...resource.attributes };
  for (const [key, relationship] of Object.entries(
    resource.relationships ?? {},
  )) {
    flat[key] =
      relationship !== null &&
      typeof relationship === 'object' &&
      'data' in relationship
        ? relationship.data
        : relationship;
  }
  flat.id = resource.id;
  return flat;
}

/** Names a field by its API key, which is what someone renaming it sees. */
function describeMismatch(
  { fieldId, property }: LegacyIdMappingSchemaMismatch,
  fieldApiKeys: ReadonlyMap<string, unknown>,
): string {
  if (typeof fieldId !== 'string') return property;
  const apiKey = fieldApiKeys.get(fieldId);
  return typeof apiKey === 'string'
    ? `${property} of field "${apiKey}" (${fieldId})`
    : `${property} of field ${fieldId}`;
}

function withoutInternalMenuItems(
  input: CmaClient.RawApiTypes.MenuItem[],
  internalItemTypeIds: ReadonlySet<string>,
): CmaClient.RawApiTypes.MenuItem[] {
  const conflicts = input.filter(
    ({ relationships }) =>
      relationships.item_type.data &&
      internalItemTypeIds.has(relationships.item_type.data.id),
  );

  if (conflicts.length > 0) {
    throw internalNavigationConflict(
      'content menu items',
      conflicts.map(({ id }) => id),
    );
  }

  return input;
}

/**
 * Removing an internal root changes the absolute positions returned for every
 * later root. Compact each remaining sibling group so the ignored node cannot
 * produce a spurious schema-menu reorder. Descendants are rejected rather than
 * silently hidden because removing their parent would leave an invalid graph.
 */
function withoutInternalSchemaMenuItems(
  input: CmaClient.RawApiTypes.SchemaMenuItem[],
  internalItemTypeIds: ReadonlySet<string>,
): CmaClient.RawApiTypes.SchemaMenuItem[] {
  const internalItems = input.filter(
    ({ relationships }) =>
      relationships.item_type.data &&
      internalItemTypeIds.has(relationships.item_type.data.id),
  );
  const excludedIds = new Set(internalItems.map(({ id }) => id));
  const invalidInternalItems = internalItems.filter(
    ({ relationships }) =>
      relationships.parent.data || relationships.children.data.length > 0,
  );
  const orphanedChildren = input.filter(({ relationships }) => {
    const parentId = relationships.parent.data?.id;

    return parentId ? excludedIds.has(parentId) : false;
  });

  if (invalidInternalItems.length > 0 || orphanedChildren.length > 0) {
    throw internalNavigationConflict('schema-menu descendants', [
      ...invalidInternalItems.map(({ id }) => id),
      ...orphanedChildren.map(({ id }) => id),
    ]);
  }

  const keptIds = new Set(
    input.filter(({ id }) => !excludedIds.has(id)).map(({ id }) => id),
  );
  const output = input
    .filter(({ id }) => keptIds.has(id))
    .map((item) => ({
      ...item,
      attributes: { ...item.attributes },
      relationships: {
        ...item.relationships,
        children: {
          ...item.relationships.children,
          data: item.relationships.children.data.filter(({ id }) =>
            keptIds.has(id),
          ),
        },
      },
    }));
  compactNavigationPositions(output);

  return output;
}

function internalNavigationConflict(kind: string, ids: string[]): Error {
  return new Error(
    `The reserved ${CONTENT_DIFF_MAPPING_MODEL_API_KEY} model has unsupported ${kind}: ${[
      ...new Set(ids),
    ]
      .sort()
      .join(
        ', ',
      )}. Remove this custom navigation before generating a schema migration.`,
  );
}

function compactNavigationPositions<
  Item extends
    | CmaClient.RawApiTypes.MenuItem
    | CmaClient.RawApiTypes.SchemaMenuItem,
>(output: Item[]): void {
  const siblings = new Map<string, Item[]>();

  for (const item of output) {
    const parentId = item.relationships.parent.data?.id ?? '';
    siblings.set(parentId, [...(siblings.get(parentId) ?? []), item]);
  }

  for (const group of siblings.values()) {
    group
      .sort(
        (left, right) =>
          left.attributes.position - right.attributes.position ||
          left.id.localeCompare(right.id),
      )
      .forEach((item, index) => {
        item.attributes.position = index + 1;
      });
  }
}
