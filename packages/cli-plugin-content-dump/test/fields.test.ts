import assert from 'node:assert/strict';
import type { ItemResource } from '../src/dump/format';
import { recordReferences, writableAttributes } from '../src/import/fields';
import { importedId } from '../src/import/ids';
import type { FieldView, ModelSettings, SchemaView } from '../src/schema';
import { fixtureId } from './fixture-id';

const POST = fixtureId('post');
const PAGE = fixtureId('page');
const TEXT = fixtureId('text_block');
const INNER = fixtureId('inner_block');

const field = (type: string, localized = false): FieldView => ({
  type,
  localized,
  validators: {},
});
const settings: ModelSettings = {
  singleton: false,
  sortable: false,
  tree: false,
  draftMode: true,
  draftSaving: false,
  allLocalesRequired: false,
  workflow: null,
};

const schema: SchemaView = {
  locales: ['en', 'it'],
  models: {
    [POST]: {
      apiKey: 'post',
      block: false,
      settings,
      fields: {
        title: field('string', true),
        author: field('link'),
        related: field('links'),
        tags: field('links', true),
        cover: field('file'),
        gallery: field('gallery'),
        seo: field('seo'),
        data: field('json'),
      },
    },
    [PAGE]: {
      apiKey: 'page',
      block: false,
      settings,
      fields: {
        blocks: field('rich_text'),
        hero: field('single_block'),
        sections: field('rich_text', true),
        body: field('structured_text', true),
      },
    },
    [TEXT]: {
      apiKey: 'text_block',
      block: true,
      settings: null,
      fields: {
        text: field('string'),
        image: field('file'),
        inner: field('single_block'),
        body: field('structured_text'),
      },
    },
    [INNER]: {
      apiKey: 'inner_block',
      block: true,
      settings: null,
      fields: { label: field('string'), target: field('link') },
    },
  },
  workflows: {},
};

const itemType = (id: string) => ({
  data: { type: 'item_type' as const, id },
});

/** A block as `GET /items?nested=true` returns it. */
function readBlock(
  modelId: string,
  name: string,
  attributes: Record<string, unknown>,
): ItemResource {
  return {
    type: 'item',
    id: fixtureId(name),
    attributes,
    relationships: { item_type: itemType(modelId) },
    meta: {
      created_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-01T10:00:00.000Z',
      current_version: fixtureId(`${name} version`),
    } as ItemResource['meta'],
  };
}

/** A block as a write sends it. */
function writtenBlock(
  modelId: string,
  name: string,
  attributes: Record<string, unknown>,
) {
  return {
    type: 'item',
    id: fixtureId(name),
    attributes,
    relationships: { item_type: itemType(modelId) },
  };
}

const span = (value: string) => ({ type: 'span', value });
const dast = (...children: unknown[]) => ({
  schema: 'dast',
  document: { type: 'root', children },
});

const ADA = fixtureId('ada');
const FIRST = fixtureId('first');
const SECOND = fixtureId('second');

describe('writableAttributes', () => {
  it('writes Modular Content and single block values as full blocks without meta, at every depth', () => {
    const attributes = {
      blocks: [
        readBlock(TEXT, 'kept', {
          text: 'Kept',
          image: null,
          inner: readBlock(INNER, 'nested', { label: 'Nested', target: ADA }),
          body: dast({
            type: 'block',
            item: readBlock(INNER, 'deep', { label: 'Deep', target: null }),
          }),
        }),
        readBlock(INNER, 'second', { label: 'Second', target: null }),
      ],
      hero: readBlock(INNER, 'hero', { label: 'Hero', target: FIRST }),
      sections: {
        en: [readBlock(INNER, 'english', { label: 'English', target: null })],
        it: [],
      },
      body: { en: null, it: null },
    };
    assert.deepStrictEqual(writableAttributes(schema, PAGE, attributes), {
      blocks: [
        writtenBlock(TEXT, 'kept', {
          text: 'Kept',
          image: null,
          inner: writtenBlock(INNER, 'nested', {
            label: 'Nested',
            target: ADA,
          }),
          body: dast({
            type: 'block',
            item: writtenBlock(INNER, 'deep', { label: 'Deep', target: null }),
          }),
        }),
        writtenBlock(INNER, 'second', { label: 'Second', target: null }),
      ],
      hero: writtenBlock(INNER, 'hero', { label: 'Hero', target: FIRST }),
      sections: {
        en: [
          writtenBlock(INNER, 'english', { label: 'English', target: null }),
        ],
        it: [],
      },
      body: { en: null, it: null },
    });
  });

  it('writes the blocks of Structured Text block and inlineBlock nodes in full, keeping every other node as it is', () => {
    const paragraph = (inline: unknown) => ({
      type: 'paragraph',
      children: [
        { type: 'span', value: 'See ', marks: ['strong'] },
        { type: 'itemLink', item: FIRST, meta: [], children: [span('first')] },
        { type: 'inlineItem', item: SECOND },
        inline,
        { type: 'link', url: 'https://example.com', children: [span('out')] },
      ],
    });
    const attributes = {
      body: {
        en: dast(
          paragraph({
            type: 'inlineBlock',
            item: readBlock(INNER, 'inline', { label: 'Inline', target: null }),
          }),
          {
            type: 'block',
            item: readBlock(TEXT, 'text', {
              text: 'In the text',
              image: null,
              inner: null,
              body: dast({
                type: 'block',
                item: readBlock(INNER, 'innermost', {
                  label: 'Innermost',
                  target: null,
                }),
              }),
            }),
          },
        ),
        it: dast({ type: 'paragraph', children: [span('Ciao')] }),
      },
    };
    assert.deepStrictEqual(writableAttributes(schema, PAGE, attributes), {
      blocks: null,
      hero: null,
      sections: null,
      body: {
        en: dast(
          paragraph({
            type: 'inlineBlock',
            item: writtenBlock(INNER, 'inline', {
              label: 'Inline',
              target: null,
            }),
          }),
          {
            type: 'block',
            item: writtenBlock(TEXT, 'text', {
              text: 'In the text',
              image: null,
              inner: null,
              body: dast({
                type: 'block',
                item: writtenBlock(INNER, 'innermost', {
                  label: 'Innermost',
                  target: null,
                }),
              }),
            }),
          },
        ),
        it: dast({ type: 'paragraph', children: [span('Ciao')] }),
      },
    });
  });

  it('passes links, files, galleries, SEO and JSON values through unchanged, mapping every locale', () => {
    const file = {
      upload_id: fixtureId('upload'),
      alt: 'Alt',
      title: null,
      custom_data: { source: 'test' },
      focal_point: { x: 0.5, y: 0.5 },
    };
    const attributes = {
      title: { en: 'First', it: 'Primo' },
      author: ADA,
      related: [FIRST, SECOND],
      tags: { en: [FIRST], it: [] },
      cover: file,
      gallery: [file, { ...file, alt: null }],
      seo: { title: 'Seo', description: 'Desc', image: file.upload_id },
      data: '{"answer":42}',
    };
    assert.deepStrictEqual(
      writableAttributes(schema, POST, attributes),
      structuredClone(attributes),
    );
  });

  it('writes legacy numeric IDs of records, uploads and blocks as the UUIDs derived from them, everywhere', () => {
    const file = { upload_id: '7001', alt: null, title: null, custom_data: {} };
    const legacyBlock = (id: string, attributes: Record<string, unknown>) => ({
      ...readBlock(INNER, id, attributes),
      id,
    });
    const post = writableAttributes(schema, POST, {
      title: { en: 'Old', it: null },
      author: '1001',
      related: ['1002', FIRST],
      tags: { en: ['1003'], it: [] },
      cover: file,
      gallery: [file, { ...file, upload_id: fixtureId('new upload') }],
      seo: { title: 'Seo', image: '7002' },
      data: '"1004"',
    });
    assert.deepStrictEqual(post, {
      title: { en: 'Old', it: null },
      author: importedId('1001'),
      related: [importedId('1002'), FIRST],
      tags: { en: [importedId('1003')], it: [] },
      cover: { ...file, upload_id: importedId('7001') },
      gallery: [
        { ...file, upload_id: importedId('7001') },
        { ...file, upload_id: fixtureId('new upload') },
      ],
      seo: { title: 'Seo', image: importedId('7002') },
      data: '"1004"',
    });
    const page = writableAttributes(schema, PAGE, {
      blocks: [legacyBlock('2001', { label: 'Legacy', target: '1001' })],
      hero: null,
      sections: null,
      body: {
        en: dast(
          {
            type: 'paragraph',
            children: [
              { type: 'itemLink', item: '1002', children: [span('old')] },
              { type: 'inlineItem', item: '1003' },
            ],
          },
          {
            type: 'block',
            item: legacyBlock('2002', { label: null, target: null }),
          },
        ),
        it: null,
      },
    });
    const written = (id: string, attributes: Record<string, unknown>) => ({
      ...writtenBlock(INNER, id, attributes),
      id: importedId(id),
    });
    assert.deepStrictEqual(page, {
      blocks: [
        written('2001', { label: 'Legacy', target: importedId('1001') }),
      ],
      hero: null,
      sections: null,
      body: {
        en: dast(
          {
            type: 'paragraph',
            children: [
              {
                type: 'itemLink',
                item: importedId('1002'),
                children: [span('old')],
              },
              { type: 'inlineItem', item: importedId('1003') },
            ],
          },
          {
            type: 'block',
            item: written('2002', { label: null, target: null }),
          },
        ),
        it: null,
      },
    });
  });

  it('keeps an own "__proto__" key of custom data parsed from JSON, in records and blocks', () => {
    const file = () =>
      JSON.parse(
        `{"upload_id":"${fixtureId(
          'upload',
        )}","alt":null,"title":null,"focal_point":null,"custom_data":{"__proto__":{"admin":true},"source":"test"}}`,
      );
    const post = writableAttributes(schema, POST, { cover: file() });
    const page = writableAttributes(schema, PAGE, {
      blocks: [readBlock(TEXT, 'with file', { image: file() })],
    });
    const customData = [
      (post.cover as { custom_data: object }).custom_data,
      (
        page.blocks as Array<{ attributes: { image: { custom_data: object } } }>
      )[0]!.attributes.image.custom_data,
    ];
    for (const value of customData) {
      assert.ok(Object.hasOwn(value, '__proto__'));
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
      assert.match(JSON.stringify(value), /"__proto__":\{"admin":true\}/);
    }
    assert.equal(({} as { admin?: boolean }).admin, undefined);
  });

  it('writes every field of the model, missing ones as null, and copies no other attribute', () => {
    assert.deepStrictEqual(
      writableAttributes(schema, POST, {
        title: { en: 'First', it: null },
        position: 3,
        parent_id: FIRST,
        internal_locales: ['en'],
      }),
      {
        title: { en: 'First', it: null },
        author: null,
        related: null,
        tags: null,
        cover: null,
        gallery: null,
        seo: null,
        data: null,
      },
    );
  });

  it('writes emptied fields as [] for Modular Content and links and null otherwise, in every locale present', () => {
    const cover = { upload_id: fixtureId('upload'), alt: null, title: null };
    assert.deepStrictEqual(
      writableAttributes(
        schema,
        POST,
        {
          title: { en: 'First', it: 'Primo' },
          author: ADA,
          related: [FIRST],
          tags: { en: [FIRST], it: [SECOND] },
          cover,
        },
        { emptied: new Set(['title', 'author', 'related', 'tags']) },
      ),
      {
        title: { en: null, it: null },
        author: null,
        related: [],
        tags: { en: [], it: [] },
        cover,
        gallery: null,
        seo: null,
        data: null,
      },
    );
    assert.deepStrictEqual(
      writableAttributes(
        schema,
        PAGE,
        {
          blocks: [readBlock(INNER, 'gone', { label: 'Gone', target: ADA })],
          hero: readBlock(INNER, 'gone hero', { label: 'Gone', target: ADA }),
          sections: { en: [], it: null },
          body: { en: dast({ type: 'inlineItem', item: FIRST }), it: null },
        },
        { emptied: new Set(['blocks', 'hero', 'sections', 'body']) },
      ),
      {
        blocks: [],
        hero: null,
        sections: { en: [], it: [] },
        body: { en: null, it: null },
      },
    );
  });

  it('with only, writes just those fields, their blocks still in full', () => {
    const attributes = {
      blocks: [readBlock(INNER, 'only', { label: 'Only', target: ADA })],
      hero: readBlock(INNER, 'left out', { label: 'Left out', target: null }),
    };
    assert.deepStrictEqual(
      writableAttributes(schema, PAGE, attributes, {
        only: new Set(['blocks']),
      }),
      { blocks: [writtenBlock(INNER, 'only', { label: 'Only', target: ADA })] },
    );
    assert.deepStrictEqual(
      writableAttributes(
        schema,
        POST,
        { author: ADA, related: [FIRST], tags: { en: [SECOND], it: [] } },
        { only: new Set(['related', 'tags']), emptied: new Set(['tags']) },
      ),
      { related: [FIRST], tags: { en: [], it: [] } },
    );
  });
});

describe('recordReferences', () => {
  const sorted = (references: Array<{ field: string; id: string }>) =>
    [...references].sort((a, b) =>
      `${a.field} ${a.id}` < `${b.field} ${b.id}` ? -1 : 1,
    );
  const ids = Array.from({ length: 10 }, (_, index) =>
    fixtureId(`target ${index}`),
  );

  it('finds link and links IDs in every locale, each with its field', () => {
    const references = recordReferences(schema, POST, {
      title: { en: ids[9], it: null },
      author: ids[0],
      related: [ids[1], ids[2]],
      tags: { en: [ids[3]], it: [ids[4], ids[5]] },
      cover: { upload_id: ids[6], alt: null },
      seo: { title: null, description: null, image: ids[7] },
    });
    assert.deepStrictEqual(
      sorted(references),
      sorted([
        { field: 'author', id: ids[0]! },
        { field: 'related', id: ids[1]! },
        { field: 'related', id: ids[2]! },
        { field: 'tags', id: ids[3]! },
        { field: 'tags', id: ids[4]! },
        { field: 'tags', id: ids[5]! },
      ]),
    );
  });

  it('finds links, itemLink and inlineItem IDs inside blocks at every depth and in every locale, each attributed to the top-level field', () => {
    const references = recordReferences(schema, PAGE, {
      blocks: [
        readBlock(TEXT, 'outer', {
          text: null,
          inner: readBlock(INNER, 'nested', { label: null, target: ids[0] }),
          body: dast(
            {
              type: 'paragraph',
              children: [{ type: 'itemLink', item: ids[1], children: [] }],
            },
            {
              type: 'block',
              item: readBlock(INNER, 'deep', { label: null, target: ids[2] }),
            },
          ),
        }),
      ],
      hero: readBlock(INNER, 'hero', { label: null, target: ids[3] }),
      sections: {
        en: [readBlock(INNER, 'en', { label: null, target: ids[4] })],
        it: [readBlock(INNER, 'it', { label: null, target: ids[5] })],
      },
      body: {
        en: dast(
          {
            type: 'paragraph',
            children: [
              { type: 'itemLink', item: ids[6], children: [span('six')] },
              {
                type: 'inlineBlock',
                item: readBlock(INNER, 'inline', {
                  label: null,
                  target: ids[7],
                }),
              },
            ],
          },
          {
            type: 'list',
            style: 'bulleted',
            children: [
              {
                type: 'listItem',
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'inlineItem', item: ids[8] }],
                  },
                ],
              },
            ],
          },
        ),
        it: dast({ type: 'inlineItem', item: ids[9] }),
      },
    });
    assert.deepStrictEqual(
      sorted(references),
      sorted([
        { field: 'blocks', id: ids[0]! },
        { field: 'blocks', id: ids[1]! },
        { field: 'blocks', id: ids[2]! },
        { field: 'hero', id: ids[3]! },
        { field: 'sections', id: ids[4]! },
        { field: 'sections', id: ids[5]! },
        { field: 'body', id: ids[6]! },
        { field: 'body', id: ids[7]! },
        { field: 'body', id: ids[8]! },
        { field: 'body', id: ids[9]! },
      ]),
    );
  });

  it('finds nothing in empty values', () => {
    assert.deepStrictEqual(
      recordReferences(schema, PAGE, {
        blocks: [],
        hero: null,
        sections: { en: null, it: [] },
        body: { en: null, it: dast() },
      }),
      [],
    );
    assert.deepStrictEqual(recordReferences(schema, POST, {}), []);
  });
});
