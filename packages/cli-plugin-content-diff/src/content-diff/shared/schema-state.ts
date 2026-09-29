// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.
// Keep it dependency-free; any change changes the runtime bytes.

import type { CmaClient } from '@datocms/cli-utils';
import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  SchemaSnapshot,
  ValidatorRelaxationPlan,
  WorkflowSchemaSnapshot,
} from '../types';
import { compareFieldSnapshots } from './canonicalize';
import { sharedFailure } from './failure-factory';
import {
  canonicalizeJson,
  isObject,
  semanticHash,
  stableStringify,
} from './json';
import { compareStrings } from './ordering';

/** Site settings that change how content is serialized or validated. */
export type EnvironmentSemantics = SchemaSnapshot['environmentSemantics'];

/** The schema parts a schema digest covers; provenance is excluded. */
export type SchemaSemanticInput = Pick<
  SchemaSnapshot,
  'locales' | 'environmentSemantics' | 'itemTypes' | 'workflows'
>;

/** Boolean environment settings, each paired with its CMA `site.meta` key. */
const SCHEMA_STATE_ENVIRONMENT_FLAGS = [
  ['improvedTimezoneManagement', 'improved_timezone_management'],
  ['improvedBooleanFields', 'improved_boolean_fields'],
  ['improvedValidationAtPublishing', 'improved_validation_at_publishing'],
  ['millisecondsInDatetime', 'milliseconds_in_datetime'],
  ['nonLocalizedFocalPoints', 'non_localized_focal_points'],
  ['improvedHexManagement', 'improved_hex_management'],
] as const;

export function normalizeFieldSnapshot(
  input: CmaClient.ApiTypes.Field,
): FieldSchemaSnapshot {
  return {
    id: input.id,
    apiKey: input.api_key,
    fieldType: input.field_type,
    localized: input.localized,
    position: input.position,
    defaultValue:
      input.default_value === undefined
        ? null
        : canonicalizeJson(input.default_value),
    validators: canonicalizeJson(input.validators) as JsonObject,
  };
}

/**
 * Normalizes a CMA model and its fields. Fields are ordered by position, then
 * by ID. A model without a workflow has `workflowId` null; a workflow
 * relationship that is present must carry a non-empty string ID.
 */
export function normalizeItemTypeSnapshot(
  input: CmaClient.ApiTypes.ItemType,
  fields: readonly CmaClient.ApiTypes.Field[],
): ItemTypeSchemaSnapshot {
  return {
    id: input.id,
    apiKey: input.api_key,
    name: input.name,
    modularBlock: input.modular_block,
    singleton: input.singleton,
    sortable: input.sortable,
    tree: input.tree,
    draftModeActive: input.draft_mode_active,
    draftSavingActive: input.draft_saving_active,
    allLocalesRequired: input.all_locales_required,
    workflowId: itemTypeWorkflowId(input),
    fields: fields.map(normalizeFieldSnapshot).sort(compareFieldSnapshots),
  };
}

/**
 * Reads the workflow ID of a CMA model: null when the model has no workflow,
 * otherwise the relationship's non-empty string ID. Anything else fails.
 */
export function itemTypeWorkflowId(
  input: CmaClient.ApiTypes.ItemType,
): string | null {
  const workflow: unknown = input.workflow;
  if (workflow === null || workflow === undefined) return null;
  if (isObject(workflow) && typeof workflow.id === 'string' && workflow.id) {
    return workflow.id;
  }
  throw sharedFailure(
    'malformedContent',
    `Item type ${String(input.id)} has a malformed workflow relationship.`,
    { itemTypeId: String(input.id) },
  );
}

export function normalizeWorkflowSnapshot(
  input: CmaClient.ApiTypes.Workflow,
): WorkflowSchemaSnapshot {
  return {
    id: input.id,
    apiKey: input.api_key,
    stages: input.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      initial: stage.initial === true,
    })),
  };
}

/**
 * Reads the environment content semantics from a CMA site resource. A site
 * without its `meta` object, or with a missing or mistyped setting, fails
 * instead of producing semantics that no plan could carry.
 */
export function environmentSemanticsFromSite(
  site: unknown,
): EnvironmentSemantics {
  const meta: Record<string, unknown> =
    isObject(site) && isObject(site.meta) ? site.meta : {};
  const semantics: Record<string, unknown> = {
    timezone: isObject(site) ? site.timezone : undefined,
  };
  for (const [key, metaKey] of SCHEMA_STATE_ENVIRONMENT_FLAGS) {
    semantics[key] = meta[metaKey];
  }
  if (!isEnvironmentSemantics(semantics)) {
    const invalidSettings = Object.keys(semantics).filter((key) =>
      key === 'timezone'
        ? typeof semantics[key] !== 'string' || !semantics[key]
        : typeof semantics[key] !== 'boolean',
    );
    const listed = invalidSettings.join(', ');
    throw sharedFailure(
      'malformedContent',
      `The CMA site response is missing environment content-semantics settings: ${listed}.`,
      { invalidSettings },
    );
  }
  return semantics;
}

/** Exactly a non-empty timezone plus the six boolean settings. */
export function isEnvironmentSemantics(
  value: unknown,
): value is EnvironmentSemantics {
  if (
    !isObject(value) ||
    typeof value.timezone !== 'string' ||
    value.timezone.length === 0
  ) {
    return false;
  }
  const expectedKeys: string[] = ['timezone'];
  for (const [key] of SCHEMA_STATE_ENVIRONMENT_FLAGS) {
    if (typeof value[key] !== 'boolean') return false;
    expectedKeys.push(key);
  }
  expectedKeys.sort(compareStrings);
  const keys = Object.keys(value).sort(compareStrings);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

/**
 * The canonical semantic state a schema digest hashes. Provenance (site and
 * environment IDs) and model names are intentionally excluded so a fork of
 * the baseline remains compatible.
 */
export function schemaSemanticState(schema: SchemaSemanticInput): JsonObject {
  return canonicalizeJson({
    locales: schema.locales,
    environmentSemantics: schema.environmentSemantics,
    itemTypes: schema.itemTypes.map((itemType) => ({
      id: itemType.id,
      apiKey: itemType.apiKey,
      modularBlock: itemType.modularBlock,
      singleton: itemType.singleton,
      sortable: itemType.sortable,
      tree: itemType.tree,
      draftModeActive: itemType.draftModeActive,
      draftSavingActive: itemType.draftSavingActive,
      allLocalesRequired: itemType.allLocalesRequired,
      workflowId: itemType.workflowId,
      fields: itemType.fields.map((field) => ({
        id: field.id,
        apiKey: field.apiKey,
        fieldType: field.fieldType,
        localized: field.localized,
        position: field.position,
        defaultValue:
          field.defaultValue === undefined ? null : field.defaultValue,
        validators: field.validators,
      })),
    })),
    workflows: schema.workflows.map((workflow) => ({
      id: workflow.id,
      apiKey: workflow.apiKey,
      stages: workflow.stages,
    })),
  }) as JsonObject;
}

/** The digest generation records and execution recomputes from the target. */
export function computeSchemaDigest(schema: SchemaSemanticInput): string {
  return semanticHash(schemaSemanticState(schema));
}

/** Digest of the out-of-scope block models needed to inspect content. */
export function inspectionItemTypesDigest(
  itemTypes: readonly ItemTypeSchemaSnapshot[],
): string {
  return semanticHash({
    itemTypes: [...itemTypes]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((itemType) => ({
        id: itemType.id,
        apiKey: itemType.apiKey,
        modularBlock: itemType.modularBlock,
        singleton: itemType.singleton,
        sortable: itemType.sortable,
        tree: itemType.tree,
        draftModeActive: itemType.draftModeActive,
        draftSavingActive: itemType.draftSavingActive,
        allLocalesRequired: itemType.allLocalesRequired,
        workflowId: itemType.workflowId,
        fields: itemType.fields.map((field) => ({
          id: field.id,
          apiKey: field.apiKey,
          fieldType: field.fieldType,
          localized: field.localized,
          position: field.position,
          defaultValue:
            field.defaultValue === undefined ? null : field.defaultValue,
          validators: field.validators,
        })),
      })),
  });
}

/**
 * Adds the inspection block models to a managed schema for traversal. The
 * merged object keeps the managed digest: it is a traversal aid, never a
 * compatibility state. Overlapping model IDs fail.
 */
export function schemaWithInspectionItemTypes(
  managedSchema: SchemaSnapshot,
  inspectionItemTypes: readonly ItemTypeSchemaSnapshot[],
): SchemaSnapshot {
  const managedIds = new Set(managedSchema.itemTypes.map(({ id }) => id));
  const duplicates = [
    ...new Set(
      inspectionItemTypes
        .map(({ id }) => id)
        .filter((id) => managedIds.has(id)),
    ),
  ].sort(compareStrings);
  if (duplicates.length > 0) {
    const listed = duplicates.join(', ');
    throw sharedFailure(
      'invalidPlan',
      `Inspection schema overlaps managed item types: ${listed}.`,
      { itemTypeIds: duplicates },
    );
  }

  return {
    ...managedSchema,
    itemTypes: [...managedSchema.itemTypes, ...inspectionItemTypes].sort(
      (left, right) => compareStrings(left.id, right.id),
    ),
    digest: managedSchema.digest,
  };
}

/**
 * The full schema with each relaxed field's validators replaced by its
 * relaxed validators, and the digest of that state.
 */
export function schemaWithValidatorRelaxations(
  schema: SchemaSnapshot,
  relaxations: readonly Pick<
    ValidatorRelaxationPlan,
    'fieldId' | 'relaxedValidators'
  >[],
): SchemaSnapshot {
  const byFieldId = new Map(
    relaxations.map((relaxation) => [relaxation.fieldId, relaxation]),
  );
  const relaxed: SchemaSnapshot = {
    ...schema,
    itemTypes: schema.itemTypes.map((itemType) => ({
      ...itemType,
      fields: itemType.fields.map((field) => {
        const relaxation = byFieldId.get(field.id);
        return relaxation
          ? { ...field, validators: relaxation.relaxedValidators }
          : field;
      }),
    })),
    digest: '',
  };
  relaxed.digest = computeSchemaDigest(relaxed);
  return relaxed;
}

/**
 * Whether a normalized model is exactly the tracking model migrations:run
 * creates: a plain regular model named "Schema migration" with one required,
 * non-localized `name` string field and no default value.
 */
export function isExactMigrationsTrackingModel(
  model: ItemTypeSchemaSnapshot,
  apiKey: string,
): boolean {
  const nameField = model.fields[0];
  return (
    model.name === 'Schema migration' &&
    model.apiKey === apiKey &&
    model.modularBlock === false &&
    model.singleton === false &&
    model.sortable === false &&
    model.tree === false &&
    model.draftModeActive === false &&
    model.draftSavingActive === false &&
    model.allLocalesRequired === false &&
    model.workflowId === null &&
    model.fields.length === 1 &&
    nameField !== undefined &&
    nameField.apiKey === 'name' &&
    nameField.fieldType === 'string' &&
    nameField.localized === false &&
    nameField.defaultValue === null &&
    stableStringify(nameField.validators) === stableStringify({ required: {} })
  );
}
