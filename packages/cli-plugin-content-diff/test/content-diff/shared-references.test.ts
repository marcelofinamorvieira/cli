import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { canonicalizeJson } from '../../src/content-diff/canonicalize';
import {
  collectRecordReferences,
  collectUploadReferences,
  projectCreateSeedFields,
} from '../../src/content-diff/dependencies';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import {
  type UnavailableReferencePolicy,
  stripUnavailableReferences,
} from '../../src/content-diff/shared/create-seeds';
import { fieldIsRequired } from '../../src/content-diff/shared/references';
import {
  ContentDiffError,
  type FieldSchemaSnapshot,
  type ItemTypeSchemaSnapshot,
  type JsonObject,
  type JsonValue,
  type RecordSnapshot,
  type SchemaSnapshot,
} from '../../src/content-diff/types';

type FailureLike = Error & { code?: string; details?: unknown };

interface RuntimeReferences {
  __stripUnavailableReferences(
    fields: unknown,
    itemType: unknown,
    lookup: unknown,
    unavailable: ReadonlySet<string>,
    path: string,
    requiredReferences: unknown,
  ): JsonObject;
  __fieldIsRequired(field: unknown): boolean;
  __collectRecordReferencesFromFields(
    fields: unknown,
    itemType: unknown,
    context: unknown,
  ): Set<string>;
  __collectUploadReferencesFromFields(
    fields: unknown,
    itemType: unknown,
    context: unknown,
    output: Set<string>,
  ): void;
  __expectedCreateSeedFields(context: unknown, recordPlan: unknown): JsonObject;
}

const RECORD_A = 'YhEa5SbeSl6KwIFizzkzig';
const RECORD_B = 'XSPMXvayT-yMUrVxP-YoSw';
const RECORD_C = 'N_x2F8mBRZivlvO0fD1q6A';
const OWNER_MODEL = '4QI3BfBvQs-hcv_YEkk1wg';
const BLOCK_MODEL = 'LkT6QfLoRXmEO7nLt6x0uA';
const BLOCK_ID = 'X4h0kJ7xQy2oO3UscO9V6Q';
const INNER_BLOCK_ID = 'LQQiCYCfSU6DTmCQ63-JRw';
const UPLOAD_ID = 'dc2q6SS5SFWIR5SfPTDGGw';

function field(
  apiKey: string,
  fieldType: FieldSchemaSnapshot['fieldType'],
  validators: JsonObject = {},
  localized = false,
): FieldSchemaSnapshot {
  return {
    id: `field-${apiKey}`,
    apiKey,
    fieldType,
    localized,
    position: 1,
    validators,
  };
}

function itemType(
  id: string,
  modularBlock: boolean,
  fields: FieldSchemaSnapshot[],
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey: `model_${id}`,
    name: id,
    modularBlock,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: false,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}

/**
 * An owner with optional and required reference fields of every kind, and a
 * block model whose own `target` link is required.
 */
function makeSchema(
  extraOwnerFields: FieldSchemaSnapshot[] = [],
): SchemaSnapshot {
  return {
    siteId: 'site',
    environmentId: 'main',
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
    itemTypes: [
      itemType(OWNER_MODEL, false, [
        field('author', 'link'),
        field('editor', 'link', { required: {} }),
        field('related', 'links'),
        field('reviewers', 'links', { size: { min: 1 } }),
        field('body', 'structured_text', { length: { min: 1 } }),
        field('notes', 'structured_text'),
        field('content', 'rich_text'),
        field('translated', 'link', {}, true),
        field('hero', 'file'),
        field('photos', 'gallery'),
        field('seo', 'seo'),
        ...extraOwnerFields,
      ]),
      itemType(BLOCK_MODEL, true, [
        field('caption', 'string'),
        field('target', 'link', { required: {} }),
        field('image', 'file'),
        field('children', 'rich_text'),
      ]),
    ],
    workflows: [],
    digest: 'schema-digest',
  };
}

function block(
  id: string,
  attributes: JsonObject,
  itemTypeId = BLOCK_MODEL,
): JsonObject {
  return {
    attributes,
    id,
    relationships: {
      item_type: { data: { id: itemTypeId, type: 'item_type' } },
    },
    type: 'item',
  };
}

function dast(children: JsonValue[]): JsonObject {
  return { schema: 'dast', document: { type: 'root', children } };
}

function record(id: string, fields: JsonObject): RecordSnapshot {
  return {
    id,
    itemTypeId: OWNER_MODEL,
    current: { fields, hash: 'current-hash' },
    published: null,
    topology: { parentId: null, position: null },
    lifecycle: { createdAt: '2025-01-01T00:00:00Z', firstPublishedAt: null },
    validity: { current: true, published: null },
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: 'record-hash',
    consistency: {
      currentVersion: '1',
      updatedAt: '2025-01-01T00:00:00Z',
      publishedAt: null,
      currentValid: true,
      publishedValid: null,
    },
  } as RecordSnapshot;
}

function schemaById(
  schema: SchemaSnapshot,
): Map<string, ItemTypeSchemaSnapshot> {
  return new Map(schema.itemTypes.map((entry) => [entry.id, entry]));
}

function owner(schema: SchemaSnapshot): ItemTypeSchemaSnapshot {
  return schema.itemTypes.find(({ id }) => id === OWNER_MODEL)!;
}

function failure(run: () => unknown): FailureLike {
  try {
    run();
  } catch (error) {
    return error as FailureLike;
  }
  throw new Error('Expected the call to fail.');
}

/** A runtime create plan entry and the context expectedCreateSeedFields reads. */
function runtimeSeed(
  schema: SchemaSnapshot,
  records: RecordSnapshot[],
  execution: {
    createOrder: string[];
    shellRecordIds: string[];
    shellComponents: string[][];
  },
) {
  const plans = records.map((entry) => ({
    id: entry.id,
    itemTypeId: entry.itemTypeId,
    action: 'create',
    desired: { current: entry.current, published: entry.published },
  }));
  return {
    plans,
    context: {
      plan: { records: plans, execution },
      schemaById: schemaById(schema),
    },
  };
}

describe('shared reference collection and create-seed projection', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimeReferences;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-shared-refs-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        'module.exports.__stripUnavailableReferences = stripUnavailableReferences;',
        'module.exports.__fieldIsRequired = fieldIsRequired;',
        'module.exports.__collectRecordReferencesFromFields = collectRecordReferencesFromFields;',
        'module.exports.__collectUploadReferencesFromFields = collectUploadReferencesFromFields;',
        'module.exports.__expectedCreateSeedFields = expectedCreateSeedFields;',
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimeReferences;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('is the reference and create-seed code the generated runtime runs', () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include.members([
      'src/content-diff/shared/references.ts',
      'src/content-diff/shared/create-seeds.ts',
    ]);
    expect(typeof runtime.__stripUnavailableReferences).to.equal('function');
    expect(typeof runtime.__expectedCreateSeedFields).to.equal('function');
  });

  it('keeps reference paths and required flags stable', () => {
    const schema = makeSchema();
    const fields: JsonObject = {
      author: RECORD_B,
      editor: RECORD_C,
      related: [RECORD_B, 42, RECORD_C],
      notes: dast([
        {
          type: 'paragraph',
          children: [
            { type: 'inlineItem', item: RECORD_B },
            {
              type: 'itemLink',
              item: RECORD_C,
              children: [{ type: 'span', value: 'x' }],
            },
          ],
        },
        { type: 'block', item: block(BLOCK_ID, { target: RECORD_B }) },
      ]),
      content: [
        block(BLOCK_ID, {
          target: RECORD_C,
          children: [block(INNER_BLOCK_ID, { target: RECORD_A })],
        }),
      ],
      translated: { en: RECORD_B, it: null },
    };

    expect(
      collectRecordReferences(record(RECORD_A, fields), schema).map(
        ({ toRecordId, path, required }) => [toRecordId, path, required],
      ),
    ).to.deep.equal([
      [RECORD_C, `current.content[0].block:${BLOCK_ID}.target`, true],
      [RECORD_C, 'current.editor', true],
      [RECORD_C, 'current.notes.document.children[0].children[1].item', false],
      [RECORD_C, 'current.related[2]', false],
      [RECORD_B, 'current.author', false],
      [RECORD_B, 'current.notes.document.children[0].children[0].item', false],
      [
        RECORD_B,
        `current.notes.document.children[1].item.block:${BLOCK_ID}.target`,
        true,
      ],
      [RECORD_B, 'current.related[0]', false],
      [RECORD_B, 'current.translated.en', false],
      [
        RECORD_A,
        `current.content[0].block:${BLOCK_ID}.children[0].block:${INNER_BLOCK_ID}.target`,
        true,
      ],
    ]);
    const context = {
      schemaById: schemaById(schema),
      captureSchemaById: schemaById(schema),
    };
    expect([
      ...runtime.__collectRecordReferencesFromFields(
        fields,
        owner(schema),
        context,
      ),
    ]).to.deep.equal([RECORD_B, RECORD_C, RECORD_A]);
  });

  it('reads {id} link objects as references and strips them (D8)', () => {
    const schema = makeSchema();
    const fields: JsonObject = {
      author: { id: RECORD_B },
      related: [{ id: RECORD_B }, RECORD_C, { id: RECORD_A }],
    };

    expect(
      collectRecordReferences(record(RECORD_A, fields), schema).map(
        ({ toRecordId, path }) => [toRecordId, path],
      ),
    ).to.deep.equal([
      [RECORD_C, 'current.related[1]'],
      [RECORD_B, 'current.author'],
      [RECORD_B, 'current.related[0]'],
      [RECORD_A, 'current.related[2]'],
    ]);
    const context = {
      schemaById: schemaById(schema),
      captureSchemaById: schemaById(schema),
    };
    expect([
      ...runtime.__collectRecordReferencesFromFields(
        fields,
        owner(schema),
        context,
      ),
    ]).to.deep.equal([RECORD_B, RECORD_C, RECORD_A]);

    const unavailable = new Set([RECORD_A, RECORD_B]);
    const expected = { author: null, related: [RECORD_C] };
    for (const policy of ['keep', 'reject', 'strip'] as const) {
      expect(
        stripUnavailableReferences(
          fields,
          owner(schema),
          schema,
          unavailable,
          `record ${RECORD_A}`,
          policy,
        ),
      ).to.deep.equal(expected);
      expect(
        runtime.__stripUnavailableReferences(
          fields,
          owner(schema),
          schemaById(schema),
          unavailable,
          `record ${RECORD_A}`,
          policy,
        ),
      ).to.deep.equal(expected);
    }
  });

  it('keeps, rejects or strips required unavailable references by policy (D9)', () => {
    const schema = makeSchema();
    const fields: JsonObject = {
      author: RECORD_B,
      editor: RECORD_B,
      reviewers: [RECORD_B, RECORD_C],
      body: dast([
        {
          type: 'paragraph',
          children: [{ type: 'inlineItem', item: RECORD_B }],
        },
      ]),
      content: [block(BLOCK_ID, { target: RECORD_B, caption: 'kept' })],
    };
    const unavailable = new Set([RECORD_B]);
    const strip = (policy: unknown) => ({
      planner: () =>
        stripUnavailableReferences(
          fields,
          owner(schema),
          schema,
          unavailable,
          `record ${RECORD_A}`,
          policy as UnavailableReferencePolicy,
        ),
      runtime: () =>
        runtime.__stripUnavailableReferences(
          fields,
          owner(schema),
          schemaById(schema),
          unavailable,
          `record ${RECORD_A}`,
          policy,
        ),
    });
    const emptyDast = dast([
      { type: 'paragraph', children: [{ type: 'span', value: '' }] },
    ]);

    // Deletion and cycle analyses keep what a required field holds; the
    // nested block's required link is kept for the same reason.
    const kept = {
      ...fields,
      author: null,
      content: [block(BLOCK_ID, { target: RECORD_B, caption: 'kept' })],
    };
    expect(strip('keep').planner()).to.deep.equal(kept);
    expect(strip('keep').runtime()).to.deep.equal(kept);

    // Declared shells strip everything unavailable.
    const stripped = {
      author: null,
      editor: null,
      reviewers: [RECORD_C],
      body: emptyDast,
      content: [block(BLOCK_ID, { target: null, caption: 'kept' })],
    };
    expect(strip('strip').planner()).to.deep.equal(stripped);
    expect(strip('strip').runtime()).to.deep.equal(stripped);

    // Any other create seed must not hold one.
    const message = `record ${RECORD_A}.editor requires record ${RECORD_B} before it can be created.`;
    const plannerError = failure(strip('reject').planner);
    expect(plannerError).to.be.instanceOf(ContentDiffError);
    expect(plannerError.code).to.equal('REQUIRED_REFERENCE_CYCLE');
    expect(plannerError.message).to.equal(message);
    const runtimeError = failure(strip('reject').runtime);
    expect(runtimeError.name).to.equal('ContentDiffRuntimeError');
    expect(runtimeError.code).to.equal('REQUIRED_REFERENCE_CYCLE');
    expect(runtimeError.message).to.equal(message);

    for (const [name, value, reason] of [
      [
        'reviewers',
        [RECORD_B],
        'contains references that cannot be seeded safely.',
      ],
      ['body', fields.body, 'contains a required cyclic record reference.'],
    ] as const) {
      const only = { [name]: value } as JsonObject;
      const expected = `record ${RECORD_A}.${name} ${reason}`;
      expect(
        failure(() =>
          stripUnavailableReferences(
            only,
            owner(schema),
            schema,
            unavailable,
            `record ${RECORD_A}`,
            'reject',
          ),
        ),
      ).to.include({ code: 'REQUIRED_REFERENCE_CYCLE', message: expected });
      expect(
        failure(() =>
          runtime.__stripUnavailableReferences(
            only,
            owner(schema),
            schemaById(schema),
            unavailable,
            `record ${RECORD_A}`,
            'reject',
          ),
        ),
      ).to.include({ code: 'REQUIRED_REFERENCE_CYCLE', message: expected });
    }

    // A caller still passing the old boolean fails instead of guessing.
    expect(failure(strip(true).planner)).to.include({
      code: 'UNSUPPORTED_CONTENT_STATE',
      message: 'Unknown required-reference policy true.',
    });
    expect(failure(strip(true).runtime)).to.include({
      code: 'INVALID_PLAN',
      message: 'Unknown required-reference policy true.',
    });
  });

  it('rejects a required unavailable reference in a non-shell create seed on both sides (D9)', () => {
    const schema = makeSchema();
    const first = record(RECORD_A, { editor: RECORD_B, author: RECORD_B });
    const second = record(RECORD_B, { editor: RECORD_A });
    const order = [RECORD_A, RECORD_B];
    const message = `record ${RECORD_A}.editor requires record ${RECORD_B} before it can be created.`;

    const plannerError = failure(() =>
      projectCreateSeedFields(
        first,
        schema,
        order,
        new Set(order),
        new Set(),
        [],
      ),
    );
    expect(plannerError).to.be.instanceOf(ContentDiffError);
    expect(plannerError).to.include({
      code: 'REQUIRED_REFERENCE_CYCLE',
      message,
    });
    const plain = runtimeSeed(schema, [first, second], {
      createOrder: order,
      shellRecordIds: [],
      shellComponents: [],
    });
    expect(
      failure(() =>
        runtime.__expectedCreateSeedFields(plain.context, plain.plans[0]),
      ),
    ).to.include({ code: 'REQUIRED_REFERENCE_CYCLE', message });

    // Declared as a shell, the same record strips its required link.
    const shellFields = { editor: null, author: null };
    expect(
      projectCreateSeedFields(
        first,
        schema,
        order,
        new Set(order),
        new Set(order),
        [order],
      ),
    ).to.deep.equal(shellFields);
    const shell = runtimeSeed(schema, [first, second], {
      createOrder: order,
      shellRecordIds: order,
      shellComponents: [order],
    });
    expect(
      runtime.__expectedCreateSeedFields(shell.context, shell.plans[0]),
    ).to.deep.equal(shellFields);
    // A required link to a record created earlier survives.
    expect(
      projectCreateSeedFields(
        second,
        schema,
        order,
        new Set(order),
        new Set(),
        [],
      ),
    ).to.deep.equal({ editor: RECORD_A });
  });

  it('reports seed contract failures with each side keeping its code', () => {
    const schema = makeSchema();
    const entry = record(RECORD_A, { author: RECORD_B });

    const missing = `Execution createOrder is missing record ${RECORD_A}.`;
    expect(
      failure(() =>
        projectCreateSeedFields(entry, schema, [], new Set(), new Set(), []),
      ),
    ).to.deep.include({
      code: 'UNSUPPORTED_CONTENT_STATE',
      message: missing,
      details: { recordId: RECORD_A },
    });
    const noOrder = runtimeSeed(schema, [entry], {
      createOrder: [],
      shellRecordIds: [],
      shellComponents: [],
    });
    expect(
      failure(() =>
        runtime.__expectedCreateSeedFields(noOrder.context, noOrder.plans[0]),
      ),
    ).to.deep.include({
      code: 'INVALID_CREATE_ORDER',
      message: missing,
      details: { recordId: RECORD_A },
    });

    const noComponent = `Execution shellComponents is missing shell record ${RECORD_A}.`;
    expect(
      failure(() =>
        projectCreateSeedFields(
          entry,
          schema,
          [RECORD_A],
          new Set([RECORD_A]),
          new Set([RECORD_A]),
          [],
        ),
      ),
    ).to.deep.include({
      code: 'UNSUPPORTED_CONTENT_STATE',
      message: noComponent,
      details: { recordId: RECORD_A },
    });
    const noShell = runtimeSeed(schema, [entry], {
      createOrder: [RECORD_A],
      shellRecordIds: [RECORD_A],
      shellComponents: [],
    });
    expect(
      failure(() =>
        runtime.__expectedCreateSeedFields(noShell.context, noShell.plans[0]),
      ),
    ).to.deep.include({
      code: 'INVALID_PLAN',
      message: noComponent,
      details: { recordId: RECORD_A },
    });
  });

  it('rejects an unknown top-level model in the reference, upload and seed walkers (D41)', () => {
    const schema = makeSchema();
    const context = {
      schemaById: schemaById(schema),
      captureSchemaById: schemaById(schema),
    };
    const fields: JsonObject = { author: RECORD_B };

    for (const itemType of [undefined, null]) {
      expect(
        failure(() =>
          runtime.__collectRecordReferencesFromFields(
            fields,
            itemType,
            context,
          ),
        ),
      ).to.include({
        code: 'SCHEMA_MISMATCH',
        message: 'Cannot collect record references for an unknown item type.',
      });
      expect(
        failure(() =>
          runtime.__collectUploadReferencesFromFields(
            fields,
            itemType,
            context,
            new Set(),
          ),
        ),
      ).to.include({
        code: 'SCHEMA_MISMATCH',
        message: 'Cannot collect upload references for an unknown item type.',
      });
      const noSchema = `No schema exists while preparing record ${RECORD_A}.`;
      expect(
        failure(() =>
          stripUnavailableReferences(
            fields,
            itemType,
            schema,
            new Set(),
            `record ${RECORD_A}`,
            'strip',
          ),
        ),
      ).to.deep.include({
        code: 'INCOMPATIBLE_SCHEMA',
        message: noSchema,
        details: { path: `record ${RECORD_A}` },
      });
      expect(
        failure(() =>
          runtime.__stripUnavailableReferences(
            fields,
            itemType,
            schemaById(schema),
            new Set(),
            `record ${RECORD_A}`,
            'strip',
          ),
        ),
      ).to.deep.include({
        code: 'SCHEMA_MISMATCH',
        message: noSchema,
        details: { path: `record ${RECORD_A}` },
      });
    }

    // A create seed of a model absent from the schema names the model.
    const orphan = { ...record(RECORD_A, fields), itemTypeId: 'missing' };
    const seed = runtimeSeed(schema, [orphan], {
      createOrder: [RECORD_A],
      shellRecordIds: [],
      shellComponents: [],
    });
    expect(
      failure(() =>
        runtime.__expectedCreateSeedFields(seed.context, seed.plans[0]),
      ),
    ).to.include({
      code: 'SCHEMA_MISMATCH',
      message:
        'Content refers to item type missing, which is absent from the scoped schema.',
    });
  });

  it('rebuilds nested blocks in their canonical shape (D10)', () => {
    const schema = makeSchema();
    const canonical = canonicalizeJson({
      content: [
        block(BLOCK_ID, {
          caption: 'kept',
          target: RECORD_C,
          children: [block(INNER_BLOCK_ID, { target: RECORD_C })],
        }),
      ],
      notes: dast([{ type: 'block', item: block(INNER_BLOCK_ID, {}) }]),
    }) as JsonObject;
    const project = (fields: JsonObject) => {
      const seed = runtimeSeed(schema, [record(RECORD_A, fields)], {
        createOrder: [RECORD_A],
        shellRecordIds: [],
        shellComponents: [],
      });
      return [
        projectCreateSeedFields(
          record(RECORD_A, fields),
          schema,
          [RECORD_A],
          new Set([RECORD_A]),
          new Set(),
          [],
        ),
        runtime.__expectedCreateSeedFields(seed.context, seed.plans[0]),
      ];
    };

    // Canonical input comes back unchanged, down to its key order.
    for (const projected of project(canonical)) {
      expect(JSON.stringify(projected)).to.equal(JSON.stringify(canonical));
    }

    // Flat CMA blocks are rebuilt, identity keys dropped from the fields.
    const flat: JsonObject = {
      content: [
        {
          id: BLOCK_ID,
          type: 'item',
          item_type: { id: BLOCK_MODEL, type: 'item_type' },
          caption: 'flat',
          target: RECORD_C,
        },
      ],
    };
    const rebuilt = {
      content: [block(BLOCK_ID, { caption: 'flat', target: RECORD_C })],
    };
    for (const projected of project(flat)) {
      expect(projected).to.deep.equal(rebuilt);
    }
  });

  it('requires block models and own attributes in the reference, upload and seed walkers (D3, D5)', () => {
    const schema = makeSchema();
    const context = {
      schemaById: schemaById(schema),
      captureSchemaById: schemaById(schema),
    };
    const walkers = (fields: JsonObject) => ({
      plannerReferences: () =>
        collectRecordReferences(record(RECORD_A, fields), schema),
      plannerUploads: () =>
        collectUploadReferences(record(RECORD_A, fields), schema),
      plannerSeed: () =>
        stripUnavailableReferences(
          fields,
          owner(schema),
          schema,
          new Set(),
          `record ${RECORD_A}`,
          'keep',
        ),
      runtimeReferences: () =>
        runtime.__collectRecordReferencesFromFields(
          fields,
          owner(schema),
          context,
        ),
      runtimeUploads: () =>
        runtime.__collectUploadReferencesFromFields(
          fields,
          owner(schema),
          context,
          new Set(),
        ),
      runtimeSeed: () =>
        runtime.__stripUnavailableReferences(
          fields,
          owner(schema),
          context.schemaById,
          new Set(),
          `record ${RECORD_A}`,
          'reject',
        ),
    });
    const paths = {
      plannerReferences: 'current.content[0]',
      plannerUploads: 'current.content[0]',
      plannerSeed: `record ${RECORD_A}.content[0]`,
      runtimeReferences: 'content[0]',
      runtimeUploads: 'content[0]',
      runtimeSeed: `record ${RECORD_A}.content[0]`,
    };

    const regular = walkers({
      content: [block(BLOCK_ID, { target: RECORD_B }, OWNER_MODEL)],
    });
    for (const [name, run] of Object.entries(regular)) {
      expect(failure(run), name).to.deep.include({
        code: name.startsWith('planner')
          ? 'INCOMPATIBLE_SCHEMA'
          : 'SCHEMA_MISMATCH',
        message: `Nested block ${BLOCK_ID} refers to unknown block model ${OWNER_MODEL}.`,
        details: {
          blockId: BLOCK_ID,
          itemTypeId: OWNER_MODEL,
          fieldPath: paths[name as keyof typeof paths],
        },
      });
    }

    for (const attributes of [null, [], 'x']) {
      const malformed = walkers({
        content: [
          {
            ...block(BLOCK_ID, {}),
            attributes: attributes as JsonValue,
          },
        ],
      });
      for (const [name, run] of Object.entries(malformed)) {
        const path = paths[name as keyof typeof paths];
        expect(failure(run), name).to.deep.include({
          code: name.startsWith('planner')
            ? 'UNSUPPORTED_CONTENT_STATE'
            : 'INVALID_CMA_RESPONSE',
          message: `Nested content at ${path} has malformed block attributes.`,
          details: { path },
        });
      }
    }
  });

  it('reads only own fields, so a constructor field absent from the record stays absent (D6)', () => {
    const schema = makeSchema([
      field('constructor', 'link'),
      field('toString', 'file'),
    ]);
    const fields: JsonObject = { author: RECORD_B, hero: UPLOAD_ID };
    const entry = record(RECORD_A, fields);

    expect(
      collectRecordReferences(entry, schema).map(({ path }) => path),
    ).to.deep.equal(['current.author']);
    expect(collectUploadReferences(entry, schema)).to.deep.equal([UPLOAD_ID]);
    const projected = projectCreateSeedFields(
      entry,
      schema,
      [RECORD_A],
      new Set([RECORD_A]),
      new Set(),
      [],
    );
    expect(projected).to.deep.equal(fields);
    expect(Object.keys(projected)).to.deep.equal(['author', 'hero']);
  });

  it('collects the same uploads on both sides', () => {
    const schema = makeSchema();
    const fields: JsonObject = {
      hero: { upload_id: UPLOAD_ID },
      photos: ['gallery-a', { upload_id: 'gallery-b' }, 7],
      seo: { image: 'seo-image', title: 'x' },
      notes: dast([
        { type: 'block', item: block(BLOCK_ID, { image: 'st-image' }) },
      ]),
      content: [
        block(BLOCK_ID, {
          image: { upload_id: 'rich-image' },
          children: [block(INNER_BLOCK_ID, { image: 'inner-image' })],
        }),
      ],
    };
    // The runtime keeps model field order; the planner sorts.
    const expected = [
      'st-image',
      'rich-image',
      'inner-image',
      UPLOAD_ID,
      'gallery-a',
      'gallery-b',
      'seo-image',
    ];
    expect(
      collectUploadReferences(record(RECORD_A, fields), schema),
    ).to.deep.equal([...expected].sort());
    const output = new Set<string>();
    runtime.__collectUploadReferencesFromFields(
      fields,
      owner(schema),
      { schemaById: schemaById(schema), captureSchemaById: schemaById(schema) },
      output,
    );
    expect([...output]).to.deep.equal(expected);
  });

  it('treats validators that are not an object as none on both sides', () => {
    const cases: Array<[FieldSchemaSnapshot['fieldType'], unknown, boolean]> = [
      ['link', null, false],
      ['link', 'required', false],
      ['link', [], false],
      ['link', { required: null }, true],
      ['links', { size: { min: 1 } }, true],
      ['links', { size: { eq: 2 } }, true],
      ['links', { size: { min: 0, max: 3 } }, false],
      ['links', { size: 'min' }, false],
      ['structured_text', { length: { min: 1 } }, true],
      ['structured_text', { size: { min: 1 } }, false],
    ];
    for (const [fieldType, validators, required] of cases) {
      const candidate = { fieldType, validators };
      expect(
        fieldIsRequired(candidate),
        `${fieldType} ${JSON.stringify(validators)}`,
      ).to.equal(required);
      expect(runtime.__fieldIsRequired(candidate)).to.equal(required);
    }

    const schema = makeSchema();
    const author = owner(schema).fields.find(
      ({ apiKey }) => apiKey === 'author',
    )!;
    (author as { validators: unknown }).validators = null;
    expect(
      collectRecordReferences(record(RECORD_A, { author: RECORD_B }), schema),
    ).to.deep.equal([
      {
        fromRecordId: RECORD_A,
        toRecordId: RECORD_B,
        path: 'current.author',
        required: false,
      },
    ]);
  });
});
