import type { CmaClient } from '@datocms/cli-utils';
import { stableStringify } from './canonicalize';
import { mapWithConcurrency } from './shared/concurrency';
import { compareStrings } from './shared/ordering';
import {
  computeSchemaDigest,
  environmentSemanticsFromSite,
  isExactMigrationsTrackingModel,
  normalizeItemTypeSnapshot,
  normalizeWorkflowSnapshot,
} from './shared/schema-state';
import type {
  ItemTypeSchemaSnapshot,
  ItemTypeSelection,
  JsonObject,
  SchemaSnapshot,
} from './types';
import { ContentDiffError, DEFAULT_CONTENT_DIFF_MODEL_API_KEY } from './types';

export {
  computeSchemaDigest,
  schemaSemanticState,
} from './shared/schema-state';

/**
 * Model ID -> API key of the field the dashboard shows as a record's title.
 * Presentation settings stay out of the schema snapshot and its digest, so
 * this is collected on the side and only used to label records in output.
 */
export type PresentationTitleFields = Map<string, string>;

export async function fetchSchemaSnapshot(
  client: CmaClient.Client,
  environmentId: string,
  presentationTitleFields?: PresentationTitleFields,
): Promise<SchemaSnapshot> {
  const [site, itemTypes, workflows] = await Promise.all([
    client.site.find(),
    client.itemTypes.list(),
    client.workflows.list(),
  ]);
  const fieldLists = await mapWithConcurrency(itemTypes, 5, async (itemType) =>
    client.fields.list(itemType.id),
  );
  const fieldsByItemType = new Map(
    itemTypes.map((itemType, index) => [itemType.id, fieldLists[index]]),
  );
  if (presentationTitleFields) {
    for (const itemType of itemTypes) {
      const titleFieldId =
        itemType.presentation_title_field?.id ?? itemType.title_field?.id;
      const titleField = fieldsByItemType
        .get(itemType.id)
        ?.find((field) => field.id === titleFieldId);
      if (titleField) {
        presentationTitleFields.set(itemType.id, titleField.api_key);
      }
    }
  }
  const normalizedItemTypes = itemTypes
    .map((itemType) =>
      normalizeItemTypeSnapshot(
        itemType,
        fieldsByItemType.get(itemType.id) ?? [],
      ),
    )
    .sort((left, right) => compareStrings(left.id, right.id));
  const normalizedWorkflows = workflows
    .map(normalizeWorkflowSnapshot)
    .sort((left, right) => compareStrings(left.id, right.id));

  const snapshot: SchemaSnapshot = {
    siteId: site.id,
    environmentId,
    locales: [...site.locales],
    environmentSemantics: environmentSemanticsFromSite(site),
    itemTypes: normalizedItemTypes,
    workflows: normalizedWorkflows,
    digest: '',
  };

  snapshot.digest = computeSchemaDigest(snapshot);

  return snapshot;
}

export function schemaForScope(
  schema: SchemaSnapshot,
  selection: ItemTypeSelection,
  migrationsModelApiKey?: string,
  contentDiffModelApiKey: string = DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
): SchemaSnapshot {
  const selected = resolveItemTypeSelection(
    schema,
    selection,
    migrationsModelApiKey,
    contentDiffModelApiKey,
  );

  const allById = new Map(
    schema.itemTypes.map((itemType) => [itemType.id, itemType]),
  );
  const includedIds = new Set(selected.map(({ id }) => id));
  const internalModelId = schema.itemTypes.find(
    ({ apiKey }) => apiKey === contentDiffModelApiKey,
  )?.id;
  let changed = true;

  // Field validators contain every allowed record/block model relationship.
  // Following those IDs keeps the digest scoped while still including nested
  // block schemas and linked-model constraints needed by the generated plan.
  while (changed) {
    changed = false;

    for (const itemTypeId of [...includedIds]) {
      const itemType = allById.get(itemTypeId);

      if (!itemType) {
        continue;
      }

      for (const field of itemType.fields) {
        for (const candidate of referencedItemTypeIds(field.validators)) {
          if (candidate === internalModelId) {
            throw new ContentDiffError(
              'INVALID_SCOPE',
              `Managed field ${field.id} refers to reserved internal model ${contentDiffModelApiKey}.`,
              { itemTypeId, fieldId: field.id, contentDiffModelApiKey },
            );
          }
          if (allById.has(candidate) && !includedIds.has(candidate)) {
            includedIds.add(candidate);
            changed = true;
          }
        }
      }
    }
  }

  const itemTypes = schema.itemTypes.filter(({ id }) => includedIds.has(id));
  const workflowIds = new Set(
    itemTypes
      .map(({ workflowId }) => workflowId)
      .filter((id): id is string => Boolean(id)),
  );
  const scoped: SchemaSnapshot = {
    siteId: schema.siteId,
    environmentId: schema.environmentId,
    locales: [...schema.locales],
    environmentSemantics: { ...schema.environmentSemantics },
    itemTypes,
    workflows: schema.workflows.filter(({ id }) => workflowIds.has(id)),
    digest: '',
  };

  scoped.digest = computeSchemaDigest(scoped);

  return scoped;
}

export function resolveItemTypeSelection(
  schema: SchemaSnapshot,
  selection: ItemTypeSelection,
  migrationsModelApiKey?: string,
  contentDiffModelApiKey: string = DEFAULT_CONTENT_DIFF_MODEL_API_KEY,
): ItemTypeSchemaSnapshot[] {
  const migrationsModelId = migrationsTrackingModelId(
    schema,
    migrationsModelApiKey,
  );
  const regularItemTypes = schema.itemTypes.filter(
    (itemType) =>
      !itemType.modularBlock &&
      itemType.id !== migrationsModelId &&
      itemType.apiKey !== contentDiffModelApiKey,
  );
  let selected: ItemTypeSchemaSnapshot[];

  if (selection === 'all') {
    selected = regularItemTypes;
  } else {
    const bySelector = new Map<string, ItemTypeSchemaSnapshot>();

    for (const itemType of regularItemTypes) {
      bySelector.set(itemType.id, itemType);
      bySelector.set(itemType.apiKey, itemType);
    }

    selected = selection.map((selector) => {
      const itemType = bySelector.get(selector);

      if (!itemType) {
        throw new ContentDiffError(
          'INVALID_SCOPE',
          `Cannot find a regular model with ID or API key "${selector}".`,
          { selector },
        );
      }

      return itemType;
    });
  }

  if (selected.length === 0) {
    throw new ContentDiffError(
      'INVALID_SCOPE',
      'The selected content scope does not contain any regular models.',
    );
  }

  return [
    ...new Map(selected.map((itemType) => [itemType.id, itemType])).values(),
  ].sort((left, right) => compareStrings(left.id, right.id));
}

/**
 * Returns the configured core CLI tracking model only when it is safe to
 * exclude from authoritative content/referrer reads. The runner itself treats
 * this API key as internal, so a conflicting user model must fail closed.
 */
export function migrationsTrackingModelId(
  schema: SchemaSnapshot,
  migrationsModelApiKey?: string,
): string | undefined {
  if (!migrationsModelApiKey) return undefined;
  const model = schema.itemTypes.find(
    ({ apiKey }) => apiKey === migrationsModelApiKey,
  );
  if (!model) return undefined;

  if (!isExactMigrationsTrackingModel(model, migrationsModelApiKey)) {
    throw new ContentDiffError(
      'INVALID_MIGRATIONS_MODEL',
      `Configured migrations model ${migrationsModelApiKey} does not match the exact internal tracking-model contract created by migrations:run.`,
      { migrationsModelApiKey, itemTypeId: model.id },
    );
  }

  return model.id;
}

export function assertSchemasCompatible(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
): void {
  if (
    stableStringify(source.environmentSemantics) !==
    stableStringify(target.environmentSemantics)
  ) {
    const keys = Object.keys(source.environmentSemantics).filter(
      (key) =>
        source.environmentSemantics[
          key as keyof SchemaSnapshot['environmentSemantics']
        ] !==
        target.environmentSemantics[
          key as keyof SchemaSnapshot['environmentSemantics']
        ],
    );
    throw new ContentDiffError(
      'ENVIRONMENT_SEMANTICS_MISMATCH',
      `Source environment "${
        source.environmentId
      }" and destination environment "${
        target.environmentId
      }" have incompatible content serialization or validation settings (${keys.join(
        ', ',
      )}). Align the environment activations/settings before generating a content diff; schema autogeneration alone may not repair this mismatch. No content records were read.`,
      {
        sourceEnvironmentId: source.environmentId,
        destinationEnvironmentId: target.environmentId,
        mismatchedSettings: keys,
      },
    );
  }

  if (source.digest !== target.digest) {
    throw schemaMismatch(source, target);
  }
}

export function assertDistinctEndpoints(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
): void {
  if (
    source.siteId === target.siteId &&
    source.environmentId === target.environmentId
  ) {
    throw new ContentDiffError(
      'INVALID_SCOPE',
      'Source and destination must identify different project/environment endpoints.',
      {
        sourceSiteId: source.siteId,
        targetSiteId: target.siteId,
        sourceEnvironmentId: source.environmentId,
        destinationEnvironmentId: target.environmentId,
      },
    );
  }
}

export function schemaMismatch(
  source: Pick<SchemaSnapshot, 'siteId' | 'environmentId'>,
  target: Pick<SchemaSnapshot, 'siteId' | 'environmentId'>,
): ContentDiffError {
  const remediation =
    source.siteId === target.siteId
      ? 'Apply a schema migration first, then regenerate the content diff.'
      : 'Apply the same checked-in schema migration history to both aligned projects first, then regenerate the content diff. Cross-project schema autogeneration is not supported.';
  return new ContentDiffError(
    'SCHEMA_MISMATCH',
    `Source environment "${source.environmentId}" and destination environment "${target.environmentId}" do not have identical managed schemas. ${remediation} No content records were read.`,
    {
      sourceEnvironmentId: source.environmentId,
      destinationEnvironmentId: target.environmentId,
    },
  );
}

const ITEM_TYPE_REFERENCE_VALIDATORS = new Set([
  'item_item_type',
  'items_item_type',
  'rich_text_blocks',
  'single_block_blocks',
  'structured_text_blocks',
  'structured_text_inline_blocks',
  'structured_text_links',
]);

function referencedItemTypeIds(validators: JsonObject): string[] {
  const result = new Set<string>();

  for (const [validatorKey, configuration] of Object.entries(validators)) {
    if (
      !ITEM_TYPE_REFERENCE_VALIDATORS.has(validatorKey) ||
      !configuration ||
      typeof configuration !== 'object' ||
      Array.isArray(configuration)
    ) {
      continue;
    }

    const itemTypes = configuration.item_types;

    if (!Array.isArray(itemTypes)) continue;

    for (const itemTypeId of itemTypes) {
      if (typeof itemTypeId === 'string') result.add(itemTypeId);
    }
  }

  return [...result].sort();
}
