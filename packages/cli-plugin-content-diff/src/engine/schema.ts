import type { CmaClient } from '@datocms/cli-utils';
import {
  assertIntegerFieldPrecision,
  assertMetadataIntegerPrecision,
  hashJson,
  json,
  jsonObject,
  object,
  referenceId,
  string,
} from './codec';
import { ContentError } from './errors';
import type { SnapshotStore } from './store';
import type { Client, JsonObject, ModelSchema, SchemaState } from './types';

// Code unit order, like SQLite, so bundles do not depend on the machine locale.
export const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function schemaHash(
  schema: Pick<SchemaState, 'locales' | 'semantics' | 'models' | 'workflows'>,
): string {
  // Field settings may be restored during apply, including an imported bundle.
  // A rounded integer must not become an apparently exact schema guard.
  for (const model of schema.models)
    for (const field of model.fields) {
      assertIntegerFieldPrecision(field, field.defaultValue, model.id);
      assertMetadataIntegerPrecision(
        field.validators,
        `Validators for ${model.id}.${field.apiKey}`,
      );
    }
  return hashJson({
    locales: schema.locales,
    semantics: schema.semantics,
    models: schema.models,
    workflows: schema.workflows,
  });
}

export async function fetchSchema(
  client: Client,
  environmentId: string,
  project?: (schema: SchemaState) => SchemaState,
): Promise<SchemaState> {
  // Every consistency check makes a fresh bulk read. A retained SDK schema
  // cache would hide concurrent changes or our temporary field settings.
  const results = await Promise.allSettled([
    client.site.rawFind({ include: 'item_types,item_types.fields' }),
    client.workflows.list(),
  ]);
  if (results[0].status === 'rejected') throw results[0].reason;
  if (results[1].status === 'rejected') throw results[1].reason;
  const response = results[0].value;
  const workflows = results[1].value;
  const site = {
    ...response.data.attributes,
    id: response.data.id,
    meta: response.data.meta,
  };
  const included = response.included ?? [];
  const models = included.filter(
    (entry): entry is CmaClient.RawApiTypes.ItemType =>
      entry.type === 'item_type',
  );
  const fields = included.filter(
    (entry): entry is CmaClient.RawApiTypes.Field => entry.type === 'field',
  );
  const modelIds = new Set(models.map((model) => model.id));
  const fieldIds = new Set(fields.map((field) => field.id));
  const expectedModels = response.data.relationships.item_types.data;
  const invalid = (message: string): never => {
    throw new ContentError('INVALID_SCHEMA', message);
  };
  if (modelIds.size !== models.length || fieldIds.size !== fields.length)
    invalid('Bulk schema contains duplicate model or field identities.');
  if (
    expectedModels.length !== models.length ||
    expectedModels.some((model) => !modelIds.has(model.id)) ||
    new Set(expectedModels.map((model) => model.id)).size !==
      expectedModels.length
  )
    invalid('Bulk schema does not include every declared model.');
  const fieldsByModel = new Map<string, CmaClient.RawApiTypes.Field[]>();
  for (const field of fields) {
    const owner = field.relationships.item_type.data.id;
    if (!modelIds.has(owner))
      invalid(`Bulk schema field ${field.id} has an unknown model.`);
    const group = fieldsByModel.get(owner) ?? [];
    group.push(field);
    fieldsByModel.set(owner, group);
  }
  const normalized: ModelSchema[] = models.map((resource) => {
    const model = resource.attributes;
    const fields = fieldsByModel.get(resource.id) ?? [];
    const expected = resource.relationships.fields.data;
    const actual = new Set(fields.map((field) => field.id));
    if (
      expected.length !== fields.length ||
      expected.some((field) => !actual.has(field.id)) ||
      new Set(expected.map((field) => field.id)).size !== expected.length
    )
      invalid(
        `Bulk schema does not include every declared field of model ${resource.id}.`,
      );
    return {
      id: resource.id,
      apiKey: model.api_key,
      name: model.name,
      block: model.modular_block,
      singleton: model.singleton,
      sortable: model.sortable,
      tree: model.tree,
      draftMode: model.draft_mode_active,
      saveInvalidDrafts: model.draft_saving_active,
      allLocalesRequired: model.all_locales_required,
      workflowId: referenceId(resource.relationships.workflow.data),
      fields: fields
        .map((resource) => {
          const field = resource.attributes;
          const shape = {
            apiKey: field.api_key,
            type: field.field_type,
            localized: field.localized,
          };
          assertIntegerFieldPrecision(
            shape,
            field.default_value,
            resource.relationships.item_type.data.id,
          );
          assertMetadataIntegerPrecision(
            field.validators,
            `Validators for ${resource.relationships.item_type.data.id}.${field.api_key}`,
          );
          return {
            id: resource.id,
            ...shape,
            validators: jsonObject(field.validators),
            defaultValue:
              field.default_value === undefined
                ? null
                : json(field.default_value),
          };
        })
        .sort((a, b) => compareIds(a.id, b.id)),
    };
  });
  const semantics: JsonObject = {
    timezone: string(site.timezone, 'site timezone'),
  };
  for (const key of [
    'improved_timezone_management',
    'improved_boolean_fields',
    'improved_validation_at_publishing',
    'milliseconds_in_datetime',
    'non_localized_focal_points',
    'improved_hex_management',
  ]) {
    const meta: unknown = site.meta;
    const value = object(meta) ? meta[key] : undefined;
    if (typeof value !== 'boolean')
      throw new ContentError(
        'INVALID_SCHEMA',
        `Missing environment semantics setting ${key}.`,
      );
    semantics[key] = value;
  }
  const schema: SchemaState = {
    siteId: site.id,
    environmentId,
    locales: [...site.locales],
    semantics,
    models: normalized.sort((a, b) => compareIds(a.id, b.id)),
    workflows: workflows
      .map((workflow) =>
        jsonObject({
          id: workflow.id,
          apiKey: workflow.api_key,
          stages: workflow.stages.map((stage) => ({
            id: stage.id,
            name: stage.name,
            initial: stage.initial === true,
          })),
        }),
      )
      .sort((a, b) => compareIds(String(a.id), String(b.id))),
    hash: '',
  };
  schema.hash = schemaHash(schema);
  return project ? project(schema) : schema;
}

function rules(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !object(entry)))
    throw new ContentError(
      'UNPROVEN_FULL_ACCESS',
      'Effective permission rules are unavailable.',
    );
  return value as Record<string, unknown>[];
}

async function effectivePermissions(
  client: Client,
): Promise<JsonObject | null> {
  const actor: unknown = await client.users.findMe({ include: 'role' });
  if (!object(actor))
    throw new ContentError(
      'UNPROVEN_FULL_ACCESS',
      'The CMA did not return the current actor.',
    );
  if (
    actor.type === 'account' ||
    actor.type === 'organization' ||
    (actor.type === 'access_token' && actor.hardcoded_type === 'admin')
  )
    return null;
  if (!object(actor.role) || typeof actor.role.id !== 'string')
    throw new ContentError(
      'UNPROVEN_FULL_ACCESS',
      'The actor has no inspectable effective role.',
    );
  const role: unknown =
    object(actor.role.meta) && object(actor.role.meta.final_permissions)
      ? actor.role
      : await client.roles.find(actor.role.id);
  if (
    !object(role) ||
    !object(role.meta) ||
    !object(role.meta.final_permissions)
  )
    throw new ContentError(
      'UNPROVEN_FULL_ACCESS',
      'The role does not expose effective permissions.',
    );
  if (
    actor.type === 'access_token' &&
    role.meta.final_permissions.can_manage_upload_collections !== true
  )
    throw new ContentError(
      'UNPROVEN_FULL_ACCESS',
      'The token cannot authoritatively read upload collections.',
    );
  return jsonObject(role.meta.final_permissions);
}

export async function assertSchemaEditAccess(client: Client): Promise<void> {
  const permissions = await effectivePermissions(client);
  if (permissions && permissions.can_edit_schema !== true)
    throw new ContentError(
      'UNPROVEN_SCHEMA_EDIT_ACCESS',
      'Temporary field changes require proven schema editing permission.',
    );
}

export async function assertFullReadAccess(
  client: Client,
  schema: SchemaState,
): Promise<void> {
  const permissions = await effectivePermissions(client);
  if (!permissions) return;
  const applicable = (rule: Record<string, unknown>) =>
    (rule.action === 'read' || rule.action === 'all') &&
    rule.environment === schema.environmentId;
  const unrestricted = (rule: Record<string, unknown>) =>
    rule.on_creator === 'anyone' &&
    !rule.on_stage &&
    (rule.localization_scope === undefined ||
      rule.localization_scope === null ||
      rule.localization_scope === 'all');
  const positives = rules(permissions.positive_item_type_permissions);
  const negatives = rules(permissions.negative_item_type_permissions);
  for (const model of schema.models) {
    if (model.block) continue;
    const matches = (rule: Record<string, unknown>) =>
      rule.item_type
        ? rule.item_type === model.id
        : rule.workflow
          ? rule.workflow === model.workflowId
          : true;
    if (
      !positives.some(
        (rule) => applicable(rule) && unrestricted(rule) && matches(rule),
      ) ||
      negatives.some((rule) => applicable(rule) && matches(rule))
    )
      throw new ContentError(
        'UNPROVEN_FULL_ACCESS',
        `Cannot prove unrestricted reads for model ${model.apiKey} in ${schema.environmentId}.`,
      );
  }
  if (
    !rules(permissions.positive_upload_permissions).some(
      (rule) =>
        applicable(rule) && unrestricted(rule) && !rule.upload_collection,
    ) ||
    rules(permissions.negative_upload_permissions).some(applicable)
  )
    throw new ContentError(
      'UNPROVEN_FULL_ACCESS',
      `Cannot prove unrestricted upload reads in ${schema.environmentId}.`,
    );
}

/** Reject unproven mutation authority before an in-place run can partially write. */
export async function assertApplyAccess(
  client: Client,
  schema: SchemaState,
  store: SnapshotStore,
  inPlace: boolean,
  managedModelIds?: readonly string[],
): Promise<void> {
  const models = new Set<string>();
  for (const row of store.database
    .prepare(
      "SELECT DISTINCT model_id FROM plan WHERE kind='record' AND action IN ('create','update','delete') OR kind='record' AND json_extract(data,'$.guard.schedules.publication') IS NOT NULL OR kind='record' AND json_extract(data,'$.guard.schedules.unpublishing') IS NOT NULL",
    )
    .iterate()) {
    const id = String(row.model_id);
    if (!managedModelIds || managedModelIds.includes(id)) models.add(id);
  }
  const changed = (kind: string) =>
    !!store.database
      .prepare(
        "SELECT 1 FROM plan WHERE kind=? AND action IN ('create','update','delete') LIMIT 1",
      )
      .get(kind);
  return assertDirectApplyAccess(client, schema, {
    modelIds: [...models],
    uploads: changed('upload'),
    collections: changed('collection'),
    inPlace,
  });
}

/** Prove permission for the declared generation scope; edited calls remain subject to CMA permissions. */
export async function assertDirectApplyAccess(
  client: Client,
  schema: SchemaState,
  scope: {
    modelIds: readonly string[];
    uploads: boolean;
    collections: boolean;
    inPlace: boolean;
  },
): Promise<void> {
  const permissions = await effectivePermissions(client);
  if (!permissions) return;
  if (!scope.inPlace && permissions.can_manage_environments !== true)
    throw new ContentError(
      'UNPROVEN_APPLY_ACCESS',
      'Fresh-fork execution requires proven environment management permission.',
    );
  const unrestricted = (rule: Record<string, unknown>) =>
    rule.action === 'all' &&
    rule.environment === schema.environmentId &&
    rule.on_creator === 'anyone' &&
    !rule.on_stage &&
    !rule.to_stage &&
    (rule.localization_scope === undefined ||
      rule.localization_scope === null ||
      rule.localization_scope === 'all');
  const positives = rules(permissions.positive_item_type_permissions);
  const negatives = rules(permissions.negative_item_type_permissions);
  for (const id of scope.modelIds) {
    const model = schema.models.find((entry) => entry.id === id);
    if (!model)
      throw new ContentError(
        'INVALID_BUNDLE',
        'A mutation model is absent from the destination schema.',
      );
    const matches = (rule: Record<string, unknown>) =>
      rule.item_type
        ? rule.item_type === model.id
        : rule.workflow
          ? rule.workflow === model.workflowId
          : true;
    if (
      !positives.some((rule) => unrestricted(rule) && matches(rule)) ||
      negatives.some(
        (rule) => rule.environment === schema.environmentId && matches(rule),
      )
    )
      throw new ContentError(
        'UNPROVEN_APPLY_ACCESS',
        `Cannot prove unrestricted mutations for model ${model.apiKey}.`,
      );
  }
  if (
    scope.uploads &&
    (!rules(permissions.positive_upload_permissions).some(
      (rule) => unrestricted(rule) && !rule.upload_collection,
    ) ||
      rules(permissions.negative_upload_permissions).some(
        (rule) => rule.environment === schema.environmentId,
      ))
  )
    throw new ContentError(
      'UNPROVEN_APPLY_ACCESS',
      'Cannot prove unrestricted upload mutations.',
    );
  if (scope.collections && permissions.can_manage_upload_collections !== true)
    throw new ContentError(
      'UNPROVEN_APPLY_ACCESS',
      'Cannot prove upload collection mutation permission.',
    );
}
