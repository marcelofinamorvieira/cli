import type { ItemResource } from '../dump/format';
import type { FieldView, SchemaView } from '../schema';
import { importedId } from './ids';

/*
 * Field values as the CMA returns them with blocks nested, and as it accepts
 * them in writes. A block is a resource,
 * `{ type: 'item', id, attributes, relationships: { item_type } }`, found in
 * Modular Content arrays, single block values, and the `item` of `block` and
 * `inlineBlock` nodes of a Structured Text document. Record references are
 * IDs: `link` values, `links` arrays, and the `item` of `itemLink` and
 * `inlineItem` nodes, also inside blocks. Uploads are referenced by the
 * `upload_id` of file and gallery values and the `image` of SEO values.
 */

type Attributes = Record<string, unknown>;
type DocumentNode = {
  type: string;
  item?: unknown;
  children?: DocumentNode[];
};
type FileValue = { upload_id: string };

function isLocalizedValue(
  field: FieldView,
  value: unknown,
): value is Record<string, unknown> {
  return field.localized && value !== null && typeof value === 'object';
}

/** `convert` applied to the value of every locale of a field. */
function mapLocales(
  field: FieldView,
  value: unknown,
  convert: (value: unknown) => unknown,
): unknown {
  return isLocalizedValue(field, value)
    ? Object.fromEntries(
        Object.entries(value).map(([locale, entry]) => [
          locale,
          convert(entry),
        ]),
      )
    : convert(value);
}

/** Calls `visit` with the value of every locale of a field. */
function forEachLocale(
  field: FieldView,
  value: unknown,
  visit: (value: unknown) => void,
): void {
  if (isLocalizedValue(field, value))
    for (const entry of Object.values(value)) visit(entry);
  else visit(value);
}

/**
 * The attributes a write sends for a record or block of `modelId`: one per
 * field of the model, with every block sent in full, every ID as the
 * destination knows it (see ids.ts), and the fields in `emptied` sent empty.
 * With `only`, just those fields.
 */
export function writableAttributes(
  schema: SchemaView,
  modelId: string,
  attributes: Attributes,
  options: { emptied?: ReadonlySet<string>; only?: ReadonlySet<string> } = {},
): Attributes {
  const result: Attributes = {};
  for (const [apiKey, field] of Object.entries(
    schema.models[modelId]!.fields,
  )) {
    if (options.only && !options.only.has(apiKey)) continue;
    const empty =
      field.type === 'rich_text' || field.type === 'links' ? [] : null;
    result[apiKey] = mapLocales(field, attributes[apiKey] ?? null, (value) =>
      options.emptied?.has(apiKey)
        ? empty
        : writableValue(schema, field.type, value),
    );
  }
  return result;
}

function writableValue(schema: SchemaView, type: string, value: unknown) {
  if (value === null) return null;
  switch (type) {
    case 'link':
      return importedId(value as string);
    case 'links':
      return (value as string[]).map((id) => importedId(id));
    case 'file':
      return writableFile(value as FileValue);
    case 'gallery':
      return (value as FileValue[]).map(writableFile);
    case 'seo': {
      const seo = value as { image?: string | null };
      return seo.image ? { ...seo, image: importedId(seo.image) } : seo;
    }
    case 'rich_text':
      return (value as ItemResource[]).map((block) =>
        writableBlock(schema, block),
      );
    case 'single_block':
      return writableBlock(schema, value as ItemResource);
    case 'structured_text': {
      const document = value as { document: DocumentNode };
      return {
        ...document,
        document: writableNode(schema, document.document),
      };
    }
    default:
      return value;
  }
}

function writableFile(file: FileValue): FileValue {
  return { ...file, upload_id: importedId(file.upload_id) };
}

function writableNode(schema: SchemaView, node: DocumentNode): DocumentNode {
  const { type, item, children } = node;
  return {
    ...node,
    ...((type === 'block' || type === 'inlineBlock') && {
      item: writableBlock(schema, item as ItemResource),
    }),
    ...((type === 'itemLink' || type === 'inlineItem') && {
      item: importedId(item as string),
    }),
    ...(children && {
      children: children.map((child) => writableNode(schema, child)),
    }),
  };
}

function writableBlock(schema: SchemaView, block: ItemResource) {
  const modelId = block.relationships.item_type.data.id;
  return {
    type: 'item',
    id: importedId(block.id),
    attributes: writableAttributes(schema, modelId, block.attributes),
    relationships: { item_type: { data: { type: 'item_type', id: modelId } } },
  };
}

/** A record a record links to, and the top-level field holding the link. */
export interface FieldReference {
  field: string;
  id: string;
}

/**
 * Every record the attributes of a record of `modelId` link to, including
 * links inside its blocks, each with the top-level field that holds it.
 */
export function recordReferences(
  schema: SchemaView,
  modelId: string,
  attributes: Attributes,
): FieldReference[] {
  const references: FieldReference[] = [];
  for (const [apiKey, field] of Object.entries(schema.models[modelId]!.fields))
    forEachLocale(field, attributes[apiKey] ?? null, (value) =>
      collectReferences(schema, field.type, value, (id) =>
        references.push({ field: apiKey, id }),
      ),
    );
  return references;
}

function collectReferences(
  schema: SchemaView,
  type: string,
  value: unknown,
  add: (id: string) => void,
): void {
  if (value === null) return;
  switch (type) {
    case 'link':
      add(value as string);
      return;
    case 'links':
      for (const id of value as string[]) add(id);
      return;
    case 'rich_text':
      for (const block of value as ItemResource[])
        collectBlockReferences(schema, block, add);
      return;
    case 'single_block':
      collectBlockReferences(schema, value as ItemResource, add);
      return;
    case 'structured_text': {
      const pending = [(value as { document: DocumentNode }).document];
      for (let node = pending.pop(); node; node = pending.pop()) {
        if (node.type === 'block' || node.type === 'inlineBlock')
          collectBlockReferences(schema, node.item as ItemResource, add);
        if (node.type === 'itemLink' || node.type === 'inlineItem')
          add(node.item as string);
        if (node.children) pending.push(...node.children);
      }
    }
  }
}

function collectBlockReferences(
  schema: SchemaView,
  block: ItemResource,
  add: (id: string) => void,
): void {
  const fields = schema.models[block.relationships.item_type.data.id]!.fields;
  for (const [apiKey, field] of Object.entries(fields))
    forEachLocale(field, block.attributes[apiKey] ?? null, (value) =>
      collectReferences(schema, field.type, value, add),
    );
}
