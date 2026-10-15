import { isDeepStrictEqual } from 'node:util';
import type { CmaClient } from '@datocms/cli-utils';

type Client = CmaClient.Client;

/** An environment's schema as the CMA returns it: a dump's `schema.json`. */
export interface RawSchema {
  /** `GET /site?include=item_types,item_types.fields`, as JSON:API. */
  site: Awaited<ReturnType<Client['site']['rawFind']>>;
  workflows: CmaClient.ApiTypes.Workflow[];
}

export async function readRawSchema(client: Client): Promise<RawSchema> {
  const [site, workflows] = await Promise.all([
    client.site.rawFind({ include: 'item_types,item_types.fields' }),
    client.workflows.list(),
  ]);
  return { site, workflows };
}

/** The models and block models of a raw schema, with their fields. */
export function rawModels(schema: RawSchema): Array<{
  model: CmaClient.RawApiTypes.ItemType;
  fields: CmaClient.RawApiTypes.Field[];
}> {
  const included = schema.site.included ?? [];
  return included
    .filter(
      (entry): entry is CmaClient.RawApiTypes.ItemType =>
        entry.type === 'item_type',
    )
    .map((model) => ({
      model,
      fields: included.filter(
        (entry): entry is CmaClient.RawApiTypes.Field =>
          entry.type === 'field' &&
          entry.relationships.item_type.data.id === model.id,
      ),
    }));
}

export interface FieldView {
  type: string;
  localized: boolean;
  validators: unknown;
}

/** How a content model treats its records. */
export interface ModelSettings {
  singleton: boolean;
  sortable: boolean;
  tree: boolean;
  draftMode: boolean;
  draftSaving: boolean;
  allLocalesRequired: boolean;
  workflow: string | null;
}

export interface ModelView {
  apiKey: string;
  block: boolean;
  /**
   * Null for block models: the CMA ignores these settings on them, and so
   * does the native schema autogenerate when it creates them.
   */
  settings: ModelSettings | null;
  /** Keyed by API key: content is written by field API key. */
  fields: Record<string, FieldView>;
}

export interface WorkflowView {
  apiKey: string;
  stages: string[];
  initialStage: string | null;
}

/**
 * What decides whether an environment accepts a dump's content, and how
 * the import writes it: the locales, every model and block model by ID
 * (records and blocks name their model by ID, and so do validators), their
 * fields by API key with type, localization and validators, the settings of
 * content models, and the workflows with their stages.
 *
 * Names, hints, appearance, fieldsets, default values, field IDs, the
 * timezone and the environment's flags are left out: they do not change
 * what the CMA accepts, and some of them a migration generated with
 * `migrations:new --autogenerate` does not reproduce. So is the model the
 * native migration runner tracks migrations in, which `migrations:run`
 * creates in the environment it runs in.
 */
export interface SchemaView {
  locales: string[];
  /** Keyed by model ID. */
  models: Record<string, ModelView>;
  /** Keyed by workflow ID. */
  workflows: Record<string, WorkflowView>;
}

export function schemaView(
  schema: RawSchema,
  trackingModelApiKey: string,
): SchemaView {
  const models: Record<string, ModelView> = {};
  for (const { model, fields } of rawModels(schema)) {
    const attributes = model.attributes;
    if (attributes.api_key === trackingModelApiKey) continue;
    models[model.id] = {
      apiKey: attributes.api_key,
      block: attributes.modular_block,
      settings: attributes.modular_block
        ? null
        : {
            singleton: attributes.singleton,
            sortable: attributes.sortable,
            tree: attributes.tree,
            draftMode: attributes.draft_mode_active,
            draftSaving: attributes.draft_saving_active,
            allLocalesRequired: attributes.all_locales_required,
            workflow: model.relationships.workflow.data?.id ?? null,
          },
      fields: Object.fromEntries(
        fields.map((field) => [
          field.attributes.api_key,
          {
            type: field.attributes.field_type,
            localized: field.attributes.localized,
            validators: field.attributes.validators,
          },
        ]),
      ),
    };
  }
  const workflows: Record<string, WorkflowView> = {};
  for (const workflow of schema.workflows)
    workflows[workflow.id] = {
      apiKey: workflow.api_key,
      stages: workflow.stages.map((stage) => stage.id),
      initialStage: workflow.stages.find((stage) => stage.initial)?.id ?? null,
    };
  return {
    locales: [...schema.site.data.attributes.locales],
    models,
    workflows,
  };
}

/** Records always belong to content models, never to block models. */
export function contentModelSettings(
  schema: SchemaView,
  modelId: string,
): ModelSettings {
  return schema.models[modelId]!.settings!;
}

type ComparedModel = Pick<ModelView, 'apiKey' | 'block'> &
  Partial<ModelSettings>;

const MODEL_LABELS: Record<keyof ComparedModel, string> = {
  apiKey: 'API key',
  block: 'block',
  singleton: 'singleton',
  sortable: 'sortable',
  tree: 'tree',
  draftMode: 'draft mode',
  draftSaving: 'saving invalid drafts',
  allLocalesRequired: 'all locales required',
  workflow: 'workflow',
};
const FIELD_LABELS: Record<keyof FieldView, string> = {
  type: 'type',
  localized: 'localization',
  validators: 'validators',
};
const WORKFLOW_LABELS: Record<keyof WorkflowView, string> = {
  apiKey: 'API key',
  stages: 'stages',
  initialStage: 'initial stage',
};

/** The labels of the properties whose values differ. */
function differing<T extends object>(
  a: T,
  b: T,
  labels: Record<keyof T, string>,
): string[] {
  return (Object.keys(labels) as Array<keyof T>)
    .filter((key) => !isDeepStrictEqual(a[key], b[key]))
    .map((key) => labels[key]);
}

function union(a: object, b: object): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/** Code unit order, which does not depend on the machine's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every difference between the dump's schema and another environment's,
 * one line each, in a stable order.
 */
export function schemaDifferences(
  dump: SchemaView,
  other: SchemaView,
  otherName: string,
): string[] {
  const there = `in "${otherName}"`;
  const lines: string[] = [];
  if (!isDeepStrictEqual(dump.locales, other.locales))
    lines.push(
      `locales: ${dump.locales.join(', ')} in the dump, ${other.locales.join(
        ', ',
      )} ${there}`,
    );
  const apiKeyOf = (id: string) =>
    (dump.models[id] ?? other.models[id])!.apiKey;
  const models = union(dump.models, other.models).sort((a, b) =>
    compare(apiKeyOf(a), apiKeyOf(b)),
  );
  for (const id of models) {
    const ours = dump.models[id];
    const theirs = other.models[id];
    const named = (model: ModelView) =>
      `${model.block ? 'block' : 'model'} ${model.apiKey}`;
    // Models are matched by ID: a model recreated under another ID shows up
    // once on each side.
    if (!theirs) {
      lines.push(`${named(ours!)} (ID ${id}): only in the dump`);
      continue;
    }
    if (!ours) {
      lines.push(`${named(theirs)} (ID ${id}): only ${there}`);
      continue;
    }
    const compared = (model: ModelView): ComparedModel => ({
      apiKey: model.apiKey,
      block: model.block,
      ...model.settings,
    });
    const changed = differing(compared(ours), compared(theirs), MODEL_LABELS);
    if (changed.length)
      lines.push(`${named(ours)}: different ${changed.join(', ')}`);
    for (const apiKey of union(ours.fields, theirs.fields).sort(compare)) {
      const field = `field ${ours.apiKey}.${apiKey}`;
      if (!theirs.fields[apiKey]) lines.push(`${field}: only in the dump`);
      else if (!ours.fields[apiKey]) lines.push(`${field}: only ${there}`);
      else {
        const fieldChanges = differing(
          ours.fields[apiKey]!,
          theirs.fields[apiKey]!,
          FIELD_LABELS,
        );
        if (fieldChanges.length)
          lines.push(`${field}: different ${fieldChanges.join(', ')}`);
      }
    }
  }
  for (const id of union(dump.workflows, other.workflows)) {
    const ours = dump.workflows[id];
    const theirs = other.workflows[id];
    const named = `workflow ${(ours ?? theirs)!.apiKey}`;
    if (!theirs) lines.push(`${named}: only in the dump`);
    else if (!ours) lines.push(`${named}: only ${there}`);
    else {
      const changed = differing(ours, theirs, WORKFLOW_LABELS);
      if (changed.length)
        lines.push(`${named}: different ${changed.join(', ')}`);
    }
  }
  return lines;
}
