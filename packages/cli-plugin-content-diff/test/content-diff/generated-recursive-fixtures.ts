import { createHash } from 'node:crypto';
import { computeSchemaDigest } from '../../src/content-diff/schema';
import type {
  FieldSchemaSnapshot,
  JsonObject,
  SchemaSnapshot,
} from '../../src/content-diff/types';

export const RECURSIVE_SEED = 0x5eedc0de;
export const EMBEDDING_KINDS = [
  'rich_text',
  'single_block',
  'block',
  'inlineBlock',
] as const;
export type EmbeddingKind = (typeof EMBEDDING_KINDS)[number];
const MODEL_ID = '4QI3BfBvQs-hcv_YEkk1wg';
const RECORD_ID = 'YhEa5SbeSl6KwIFizzkzig';
const PEER_ID = 'N_x2F8mBRZivlvO0fD1q6A';

export function embeddingPaths(depth: number): EmbeddingKind[][] {
  if (depth === 0) return [[]];
  return embeddingPaths(depth - 1).flatMap((prefix) =>
    EMBEDDING_KINDS.map((kind) => [...prefix, kind]),
  );
}

export interface GeneratedBlockSlot {
  id: string;
  itemTypeId: string;
  path: (string | number)[];
  fieldPath: string;
  locale: string | null;
}

/** Expected slots are recorded while constructing content, never discovered by a production walker. */
export function generatedRecursiveFixture(
  path: EmbeddingKind[],
  revision = 0,
  options: {
    withUploads?: boolean;
    wireJson?: boolean;
    sharedPeer?: boolean;
  } = {},
) {
  const label = path.join('/');
  let randomState =
    (RECURSIVE_SEED ^
      createHash('sha256').update(label).digest().readUInt32LE()) >>>
    0;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
  const localized = random() % 2 === 0;
  const locales = localized ? ['en', 'it'] : [null];
  const blockTypes = path.map((_, index) => generatedId(`model:${index}`));
  const slots: GeneratedBlockSlot[] = [];
  const uploadIds = new Set<string>();
  const referenceIds = new Set<string>();
  const reference = (role: string, level: number, locale: string | null) => {
    const id = options.sharedPeer
      ? PEER_ID
      : generatedId(`reference:${role}:${level}:${locale}`);
    referenceIds.add(id);
    return id;
  };
  const sidecar = {
    type: 'block',
    item: {
      id: generatedId('opaque-block'),
      type: 'item',
      attributes: {
        peer: generatedId('opaque-peer'),
        image: { upload_id: generatedId('opaque-upload') },
      },
      relationships: {
        item_type: {
          data: { id: generatedId('opaque-model'), type: 'item_type' },
        },
      },
    },
    children: [{ type: 'inlineItem', item: generatedId('opaque-reference') }],
  };
  const fieldsFor = (level: number): FieldSchemaSnapshot[] => {
    const kind = path[level];
    const childModel = blockTypes[level];
    return [
      ['caption', 'string', {}],
      ['peer', 'link', { item_item_type: { item_types: [MODEL_ID] } }],
      ['image', 'file', {}],
      ['metadata', 'json', {}],
      ...(kind
        ? [
            [
              'content',
              kind === 'block' || kind === 'inlineBlock'
                ? 'structured_text'
                : kind,
              {
                [kind === 'block'
                  ? 'structured_text_blocks'
                  : kind === 'inlineBlock'
                    ? 'structured_text_inline_blocks'
                    : `${kind}_blocks`]: { item_types: [childModel] },
                ...(kind === 'block' || kind === 'inlineBlock'
                  ? { structured_text_links: { item_types: [MODEL_ID] } }
                  : {}),
              },
            ],
          ]
        : []),
    ].map(([apiKey, fieldType, validators], index) => ({
      id: generatedId(`field:${level}:${apiKey}`),
      apiKey: String(apiKey),
      fieldType: String(fieldType) as FieldSchemaSnapshot['fieldType'],
      validators: validators as JsonObject,
      localized: level === 0 && apiKey === 'content' && localized,
      position: index + 1,
    }));
  };
  const schema: SchemaSnapshot = {
    siteId: 'site-id',
    environmentId: 'source',
    locales: ['en', 'it'],
    environmentSemantics: {
      timezone: 'UTC',
      improvedTimezoneManagement: true,
      improvedBooleanFields: true,
      improvedValidationAtPublishing: true,
      millisecondsInDatetime: true,
      nonLocalizedFocalPoints: true,
      improvedHexManagement: true,
    },
    itemTypes: [MODEL_ID, ...blockTypes].map((id, level) => ({
      id,
      apiKey: level ? `block_${String.fromCharCode(96 + level)}` : 'article',
      name: level ? `Block ${level}` : 'Article',
      modularBlock: level > 0,
      singleton: false,
      sortable: false,
      tree: false,
      draftModeActive: level === 0,
      draftSavingActive: level === 0,
      allLocalesRequired: false,
      workflowId: null,
      fields: fieldsFor(level),
    })),
    workflows: [],
    digest: '',
  };
  schema.digest = computeSchemaDigest(schema);
  const buildFields = (
    level: number,
    locale: string | null,
    pointer: (string | number)[],
    ownerPath: string,
  ): { input: JsonObject; canonical: JsonObject } => {
    const uploadId = generatedId(`upload:${level}:${locale}`);
    if (options.withUploads !== false) uploadIds.add(uploadId);
    const fields: JsonObject = {
      caption:
        level === path.length && locale !== 'it'
          ? `leaf:${revision}`
          : `level:${level}`,
      peer: reference('field', level, locale),
      image:
        options.withUploads !== false
          ? { upload_id: uploadId, alt: null, title: null, custom_data: {} }
          : null,
      metadata: {
        sidecar: structuredClone(sidecar),
        sequence: [3, 1, 2],
        label: 'opaque',
      },
    };
    // Full migration mocks use CMA JSON strings; normalization tests also
    // cover decoded opaque JSON objects without claiming server acceptance.
    if (options.wireJson) fields.metadata = JSON.stringify(fields.metadata);
    if (level === path.length)
      return { input: structuredClone(fields), canonical: fields };
    const embed = (
      selectedLocale: string | null,
      contentPointer: (string | number)[],
    ) => {
      const kind = path[level];
      const suffix =
        kind === 'rich_text'
          ? [0]
          : kind === 'single_block'
            ? []
            : kind === 'block'
              ? ['document', 'children', 1, 'item']
              : ['document', 'children', 0, 'children', 1, 'item'];
      const blockPath = [...contentPointer, ...suffix];
      const id = generatedId(`${label}:${selectedLocale}:${level}`);
      const fieldPath = ownerPath ? `${ownerPath}.content` : 'content';
      slots.push({
        id,
        itemTypeId: blockTypes[level],
        path: blockPath,
        fieldPath,
        locale: level === 0 ? selectedLocale : null,
      });
      const child = buildFields(
        level + 1,
        selectedLocale,
        [...blockPath, 'attributes'],
        `${fieldPath}.block:${id}`,
      );
      const relationship = {
        item_type: { data: { id: blockTypes[level], type: 'item_type' } },
      };
      const canonical = {
        id,
        type: 'item',
        attributes: child.canonical,
        relationships: relationship,
      };
      const input: JsonObject =
        random() % 2 === 0
          ? {
              id,
              type: 'item',
              attributes: child.input,
              relationships: relationship,
              __itemTypeId: blockTypes[level],
            }
          : {
              id,
              type: 'item',
              item_type: { id: blockTypes[level], type: 'item_type' },
              ...child.input,
            };
      const wrap = (item: JsonObject): JsonObject | JsonObject[] => {
        if (kind === 'rich_text') return [item];
        if (kind === 'single_block') return item;
        const span = { type: 'span', value: 'linked text', marks: ['strong'] };
        const paragraph: JsonObject = {
          type: 'paragraph',
          sidecar: structuredClone(sidecar),
          children: [
            {
              type: 'inlineItem',
              item: reference('inlineItem', level, selectedLocale),
            },
            ...(kind === 'inlineBlock'
              ? [
                  {
                    type: 'inlineBlock',
                    item,
                    sidecar: structuredClone(sidecar),
                  },
                ]
              : []),
            {
              type: 'itemLink',
              item: reference('itemLink', level, selectedLocale),
              children: [span],
            },
          ],
        };
        return {
          schema: 'dast',
          sidecar: structuredClone(sidecar),
          document: {
            type: 'root',
            sidecar: structuredClone(sidecar),
            children: [
              paragraph,
              ...(kind === 'block'
                ? [{ type: 'block', item, sidecar: structuredClone(sidecar) }]
                : []),
            ],
          },
        };
      };
      return { input: wrap(input), canonical: wrap(canonical) };
    };
    const input = structuredClone(fields);
    const canonical = structuredClone(fields);
    if (level === 0 && localized) {
      input.content = {};
      canonical.content = {};
      for (const selected of locales) {
        const value = embed(selected, [...pointer, 'content', selected!]);
        input.content[selected!] = value.input;
        canonical.content[selected!] = value.canonical;
      }
    } else {
      const value = embed(locale, [...pointer, 'content']);
      input.content = value.input;
      canonical.content = value.canonical;
    }
    return { input, canonical };
  };
  const fields = buildFields(0, null, [], '');
  const resource = (value: JsonObject) => ({
    id: RECORD_ID,
    type: 'item',
    item_type: { id: MODEL_ID, type: 'item_type' },
    ...value,
    meta: {
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      current_version: `version-${revision}`,
      first_published_at: null,
      published_at: null,
      stage: null,
      is_valid: true,
      is_current_version_valid: true,
      is_published_version_valid: null,
      publication_scheduled_at: null,
      unpublishing_scheduled_at: null,
    },
  });
  return {
    label,
    path,
    localized,
    schema,
    input: resource(fields.input),
    canonicalFields: fields.canonical,
    slots,
    referenceIds: [...referenceIds].sort(),
    uploadIds: [...uploadIds].sort(),
    resource,
  };
}

export function generatedId(label: string): string {
  const bytes = createHash('sha256').update(label).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return bytes.toString('base64url');
}

export function valueAt(value: any, path: (string | number)[]): any {
  return path.reduce((parent, key) => parent[key], value);
}

export function setValueAt(
  value: any,
  path: (string | number)[],
  child: unknown,
): void {
  valueAt(value, path.slice(0, -1))[path[path.length - 1]] = child;
}

export function reverseObjectKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

export function expandGeneratedPatch(
  fields: JsonObject,
  baseline: JsonObject,
  slots: GeneratedBlockSlot[],
  allowFreshIds = false,
): JsonObject {
  const result = structuredClone(fields);
  for (const slot of slots) {
    const value = valueAt(result, slot.path);
    if (typeof value === 'string') {
      if (value !== valueAt(baseline, slot.path).id)
        throw new Error(`Unexpected block shorthand ${value}`);
      setValueAt(
        result,
        slot.path,
        structuredClone(valueAt(baseline, slot.path)),
      );
    } else if (
      !value ||
      typeof value.id !== 'string' ||
      (!allowFreshIds && value.id !== slot.id)
    ) {
      throw new Error(`Unexpected block identity at ${slot.path.join('.')}`);
    }
  }
  return result;
}
