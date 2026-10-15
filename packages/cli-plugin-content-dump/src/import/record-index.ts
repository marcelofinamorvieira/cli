import type { ItemResource, RecordLine } from '../dump/format';
import type { ZipReader } from '../dump/zip';
import {
  type FieldView,
  type SchemaView,
  contentModelSettings,
} from '../schema';
import { bulletList, userError } from '../utils/errors';
import { recordReferences } from './fields';
import type { RecordStore, StoredLine } from './record-store';

export type RecordStatus = 'draft' | 'published' | 'updated';

/** A link from a record to another, by index. */
export interface Reference {
  /** The top-level field holding the link. */
  field: string;
  target: number;
  /** Whether the field cannot be left empty when the record is created. */
  required: boolean;
}

/**
 * What the import keeps in memory of each record: who it is, where its line
 * is stored, and what it depends on. Records are numbered by index; -1
 * stands for none.
 */
export interface RecordNode {
  id: string;
  modelId: string;
  /** Null for a record that something links to but the dump does not hold. */
  stored: StoredLine | null;
  status: RecordStatus;
  createdAt: number;
  /** The links of the version the record is created with. */
  references: Reference[];
  /** The tree parent. */
  parent: number;
  /** The sibling just before it, in a sortable model or under a tree parent. */
  previous: number;
  /**
   * Whether the record needs more writes once every record exists: a newer
   * draft, a workflow stage or a schedule.
   */
  finish: boolean;
}

export interface RecordIndex {
  nodes: RecordNode[];
  /** The indexes of the records the dump holds, in dump order. */
  records: number[];
  /** Records of the migration tracking model, which the import leaves out. */
  skipped: number;
}

/** A field that the CMA refuses to save empty. */
function isRequired(field: FieldView): boolean {
  const validators = field.validators as {
    required?: unknown;
    size?: { min?: number };
  };
  return Boolean(validators.required) || (validators.size?.min ?? 0) > 0;
}

/**
 * Reads every record of the dump once: stores its line, and keeps its node.
 * Refuses the dump, before anything is written, when DatoCMS reports some of
 * its records as invalid, since it would refuse to import them.
 */
export async function indexRecords(
  zip: ZipReader,
  schema: SchemaView,
  store: RecordStore,
): Promise<RecordIndex> {
  const nodes: RecordNode[] = [];
  const indexes = new Map<string, number>();
  const indexOf = (id: string) => {
    let index = indexes.get(id);
    if (index === undefined) {
      index = nodes.push(absentRecord(id)) - 1;
      indexes.set(id, index);
    }
    return index;
  };
  const siblings = new Map<
    string,
    Array<{ index: number; position: number }>
  >();
  const records: number[] = [];
  const invalid: string[] = [];
  let skipped = 0;

  for await (const { text, value } of zip.lines('records')) {
    const { current, published } = value as RecordLine;
    const modelId = current.relationships.item_type.data.id;
    const model = schema.models[modelId];
    // Only the migration tracking model is missing from the schema view.
    if (!model) {
      skipped++;
      continue;
    }
    const settings = contentModelSettings(schema, modelId);
    const index = indexOf(current.id);
    records.push(index);
    const status = current.meta.status as RecordStatus;
    const created = published ?? current;
    const parentId = settings.tree
      ? (current.attributes.parent_id as string | null)
      : null;
    nodes[index] = {
      id: current.id,
      modelId,
      stored: store.append(text),
      status,
      createdAt: Date.parse(current.meta.created_at),
      references: recordReferences(schema, modelId, created.attributes).map(
        (reference) => ({
          field: reference.field,
          target: indexOf(reference.id),
          required: isRequired(model.fields[reference.field]!),
        }),
      ),
      parent: parentId ? indexOf(parentId) : -1,
      previous: -1,
      finish:
        status === 'updated' ||
        stageToSet(schema, modelId, current) !== null ||
        Boolean(current.meta.publication_scheduled_at) ||
        Boolean(current.meta.unpublishing_scheduled_at),
    };
    if (settings.sortable || settings.tree) {
      const group = `${modelId}/${parentId ?? ''}`;
      const members = siblings.get(group) ?? [];
      members.push({ index, position: current.attributes.position as number });
      siblings.set(group, members);
    }
    const failing = invalidVersion(current, status, settings);
    if (failing)
      invalid.push(`${model.apiKey} ${current.id}: ${failing} invalid`);
  }

  if (invalid.length) throw invalidRecords(invalid);
  for (const members of siblings.values()) {
    members.sort((a, b) => a.position - b.position || a.index - b.index);
    members.forEach((member, at) => {
      nodes[member.index]!.previous = at ? members[at - 1]!.index : -1;
    });
  }
  return { nodes, records, skipped };
}

function absentRecord(id: string): RecordNode {
  return {
    id,
    modelId: '',
    stored: null,
    status: 'draft',
    createdAt: 0,
    references: [],
    parent: -1,
    previous: -1,
    finish: false,
  };
}

/**
 * The workflow stage to move a record to once created, where it would
 * otherwise stay in its workflow's initial stage; null when there is none.
 */
export function stageToSet(
  schema: SchemaView,
  modelId: string,
  current: ItemResource,
): string | null {
  const { workflow } = contentModelSettings(schema, modelId);
  const initial = workflow ? schema.workflows[workflow]?.initialStage : null;
  const stage = current.meta.stage;
  return stage && stage !== initial ? stage : null;
}

/**
 * The version of a record that DatoCMS itself reports as invalid and would
 * refuse to import: a published version always, a draft unless its model
 * saves invalid drafts.
 */
function invalidVersion(
  current: ItemResource,
  status: RecordStatus,
  settings: { draftMode: boolean; draftSaving: boolean },
): string | undefined {
  if (status !== 'draft' && current.meta.is_published_version_valid === false)
    return 'published version';
  if (
    current.meta.is_current_version_valid === false &&
    !(settings.draftMode && settings.draftSaving)
  )
    return 'current version';
  return undefined;
}

function invalidRecords(lines: string[]) {
  return userError(
    'INVALID_RECORDS',
    `${
      lines.length
    } records of the dump do not pass the validations of their model, so DatoCMS would refuse to import them:\n${bulletList(
      lines,
    )}`,
    [
      'Fix these records in the environment the dump was exported from (the dashboard marks them as invalid), then export a new dump.',
    ],
  );
}
