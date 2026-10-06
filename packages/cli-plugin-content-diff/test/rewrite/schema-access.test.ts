import assert from 'node:assert/strict';
import { recordGuard, recordHash } from '../../src/engine/codec';
import { ContentError } from '../../src/engine/errors';
import {
  assertApplyAccess,
  assertFullReadAccess,
  fetchSchema,
  schemaHash,
} from '../../src/engine/schema';
import { SnapshotStore } from '../../src/engine/store';
import type {
  Client,
  JsonObject,
  RecordState,
  SchemaState,
} from '../../src/engine/types';
import { withBulkSchema } from './bulk-schema-fixture';

const MODEL = 'aaaaaaaaaaaaaaaaaaaaaa';
const WORKFLOW = 'bbbbbbbbbbbbbbbbbbbbbb';
const RECORD = 'cccccccccccccccccccccc';

function fixture() {
  const schema: SchemaState = {
    siteId: 'site',
    environmentId: 'target',
    locales: ['en'],
    semantics: {},
    hash: '',
    models: [
      {
        id: MODEL,
        apiKey: 'page',
        name: 'Page',
        block: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftMode: true,
        saveInvalidDrafts: false,
        allLocalesRequired: false,
        workflowId: WORKFLOW,
        fields: [
          {
            id: 'dddddddddddddddddddddd',
            apiKey: 'title',
            type: 'string',
            localized: false,
            validators: {},
            defaultValue: null,
          },
        ],
      },
    ],
    workflows: [
      {
        id: WORKFLOW,
        apiKey: 'editorial',
        stages: [
          { id: 'draft', name: 'Draft', initial: true },
          { id: 'review', name: 'Review', initial: false },
          { id: 'approved', name: 'Approved', initial: false },
        ],
      },
    ],
  };
  const baseline: RecordState = {
    id: RECORD,
    modelId: MODEL,
    current: { title: 'Old' },
    published: null,
    currentVersion: '1',
    publishedUpdatedAt: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    firstPublishedAt: null,
    parentId: null,
    position: null,
    stage: 'draft',
    schedules: { publication: null, unpublishing: null },
    validity: { current: true, published: null },
    hash: '',
  };
  baseline.hash = recordHash(baseline);
  const desired = {
    ...baseline,
    current: { title: 'New' },
    stage: 'approved',
    hash: '',
  };
  desired.hash = recordHash(desired);
  const store = new SnapshotStore();
  store.putPlan({
    kind: 'record',
    id: RECORD,
    modelId: MODEL,
    action: 'update',
    guard: recordGuard(baseline),
    baseline,
    desired,
    safety: {
      currentReferences: [],
      publishedReferences: [],
      uploadReferences: [],
      blockIds: [],
      desiredParentId: null,
      desiredPosition: null,
    },
    diagnostics: [],
  });
  const permissions: JsonObject = {
    can_manage_environments: true,
    can_manage_upload_collections: true,
    positive_item_type_permissions: [],
    negative_item_type_permissions: [],
    positive_upload_permissions: [
      {
        action: 'all',
        environment: 'target',
        on_creator: 'anyone',
        localization_scope: 'all',
      },
    ],
    negative_upload_permissions: [],
  };
  const client = {
    users: {
      findMe: async () => ({
        type: 'user',
        role: { id: 'role', meta: { final_permissions: permissions } },
      }),
    },
  } as unknown as Client;
  const rule: JsonObject = {
    action: 'all',
    environment: 'target',
    item_type: MODEL,
    on_creator: 'anyone',
    localization_scope: 'all',
  };
  return { schema, store, client, permissions, rule };
}

const unproven = (error: unknown) =>
  error instanceof ContentError && error.code === 'UNPROVEN_APPLY_ACCESS';

describe('apply access proof', () => {
  it('rejects all-action grants restricted to one destination workflow stage', async () => {
    const value = fixture();
    try {
      const scopes: JsonObject[] = [
        { item_type: MODEL },
        { item_type: null, workflow: WORKFLOW },
      ];
      for (const scope of scopes) {
        value.permissions.positive_item_type_permissions = [
          { ...value.rule, ...scope, to_stage: 'review' },
        ];
        // Native action=all includes move_to_stage, and MapToStage applies
        // to_stage even when read/update themselves are unrestricted.
        await assert.rejects(
          assertApplyAccess(value.client, value.schema, value.store, true, [
            MODEL,
          ]),
          unproven,
        );
      }
    } finally {
      value.store.dispose();
    }
  });

  it('accepts an additional matching unrestricted grant and explicit null stage restrictions', async () => {
    const value = fixture();
    try {
      for (const unrestricted of [
        value.rule,
        { ...value.rule, to_stage: null, on_stage: null },
        { ...value.rule, item_type: null, workflow: WORKFLOW },
      ]) {
        value.permissions.positive_item_type_permissions = [
          { ...value.rule, to_stage: 'review' },
          unrestricted,
        ];
        await assertApplyAccess(
          value.client,
          value.schema,
          value.store,
          false,
          [MODEL],
        );
      }
    } finally {
      value.store.dispose();
    }
  });

  it('keeps destination-stage restrictions irrelevant to the full-read proof', async () => {
    const value = fixture();
    try {
      value.permissions.positive_item_type_permissions = [
        { ...value.rule, to_stage: 'review' },
      ];
      await assertFullReadAccess(value.client, value.schema);
    } finally {
      value.store.dispose();
    }
  });

  it('rejects other restricted grants and matching negative workflow permissions', async () => {
    const value = fixture();
    try {
      const restrictions: JsonObject[] = [
        { action: 'update' },
        { environment: 'other' },
        { on_creator: 'self' },
        { localization_scope: 'localized', locale: 'en' },
        { on_stage: 'draft' },
        { item_type: 'other' },
        { item_type: null, workflow: 'other' },
      ];
      for (const restriction of restrictions) {
        value.permissions.positive_item_type_permissions = [
          { ...value.rule, ...restriction },
        ];
        await assert.rejects(
          assertApplyAccess(value.client, value.schema, value.store, true, [
            MODEL,
          ]),
          unproven,
        );
      }
      value.permissions.positive_item_type_permissions = [value.rule];
      value.permissions.negative_item_type_permissions = [
        {
          action: 'move_to_stage',
          environment: 'target',
          workflow: WORKFLOW,
          to_stage: 'approved',
        },
      ];
      await assert.rejects(
        assertApplyAccess(value.client, value.schema, value.store, true, [
          MODEL,
        ]),
        unproven,
      );
      value.permissions.negative_item_type_permissions = [
        { action: 'all', environment: 'other', workflow: WORKFLOW },
      ];
      await assertApplyAccess(value.client, value.schema, value.store, true, [
        MODEL,
      ]);
      value.permissions.can_manage_environments = false;
      await assert.rejects(
        assertApplyAccess(value.client, value.schema, value.store, false, [
          MODEL,
        ]),
        unproven,
      );
      await assertApplyAccess(value.client, value.schema, value.store, true, [
        MODEL,
      ]);
    } finally {
      value.store.dispose();
    }
  });
});

function defaultSchemaClient(
  defaultValue: unknown,
  localized = false,
  type = 'integer',
  validators: JsonObject = {},
): Client {
  return withBulkSchema({
    site: {
      find: async () => ({
        id: 'site',
        timezone: 'UTC',
        locales: ['en', 'it'],
        meta: {
          improved_timezone_management: true,
          improved_boolean_fields: true,
          improved_validation_at_publishing: true,
          milliseconds_in_datetime: true,
          non_localized_focal_points: true,
          improved_hex_management: true,
        },
      }),
    },
    itemTypes: {
      list: async () => [
        {
          id: MODEL,
          api_key: 'page',
          name: 'Page',
          modular_block: false,
          singleton: false,
          sortable: false,
          tree: false,
          draft_mode_active: true,
          draft_saving_active: false,
          all_locales_required: false,
          workflow: null,
        },
      ],
    },
    fields: {
      list: async () => [
        {
          id: 'dddddddddddddddddddddd',
          api_key: 'counter',
          field_type: type,
          localized,
          validators,
          default_value: defaultValue,
        },
      ],
    },
    workflows: { list: async () => [] },
  } as unknown as Client);
}

const unsupportedInteger = (error: unknown) =>
  error instanceof ContentError &&
  error.code === 'UNSUPPORTED_INTEGER_PRECISION';

describe('integer schema default precision', () => {
  it('rejects rounded integer defaults before normalization and schema hashing', async () => {
    const rounded = JSON.parse('9007199254740993') as number;
    assert.equal(rounded, JSON.parse('9007199254740992'));
    for (const raw of [
      '9007199254740993',
      '-9007199254740993',
      '9223372036854775807',
    ]) {
      await assert.rejects(
        fetchSchema(defaultSchemaClient(JSON.parse(raw)), 'target'),
        unsupportedInteger,
      );
      await assert.rejects(
        fetchSchema(
          defaultSchemaClient({ en: 1, it: JSON.parse(raw) }, true),
          'target',
        ),
        unsupportedInteger,
      );
    }
  });

  it('rejects unsafe integer defaults when hashing an imported schema', async () => {
    const schema = await fetchSchema(defaultSchemaClient(null), 'target');
    const field = schema.models[0].fields[0];
    field.defaultValue = JSON.parse('9007199254740993') as number;
    assert.throws(() => schemaHash(schema), unsupportedInteger);
    field.localized = true;
    field.defaultValue = {
      en: null,
      it: JSON.parse('-9007199254740993') as number,
    };
    assert.throws(() => schemaHash(schema), unsupportedInteger);
  });

  it('accepts safe integer limits and keeps floats and opaque JSON values outside this guard', async () => {
    for (const value of [
      Number.MIN_SAFE_INTEGER,
      0,
      Number.MAX_SAFE_INTEGER,
      null,
    ]) {
      const schema = await fetchSchema(defaultSchemaClient(value), 'target');
      assert.equal(schema.models[0].fields[0].defaultValue, value);
      assert.equal(schema.hash, schemaHash(schema));
    }
    const localized = { en: Number.MAX_SAFE_INTEGER, it: null };
    assert.deepEqual(
      (await fetchSchema(defaultSchemaClient(localized, true), 'target'))
        .models[0].fields[0].defaultValue,
      localized,
    );
    const numeric = JSON.parse('9007199254740993') as number;
    assert.equal(
      (
        await fetchSchema(
          defaultSchemaClient(numeric, false, 'float'),
          'target',
        )
      ).models[0].fields[0].defaultValue,
      numeric,
    );
    const opaque = '{"counter":9007199254740993}';
    assert.equal(
      (await fetchSchema(defaultSchemaClient(opaque, false, 'json'), 'target'))
        .models[0].fields[0].defaultValue,
      opaque,
    );
  });
});

describe('schema validator metadata precision', () => {
  it('rejects unsafe integer-shaped numbers in nested validator metadata before capture', async () => {
    const unsafe = JSON.parse('9007199254740993') as number;
    const validators: JsonObject[] = [
      { number_range: { max: unsafe } },
      { nested: { rules: [{ limits: [1, null, unsafe] }] } },
    ];
    for (const rules of validators)
      await assert.rejects(
        fetchSchema(defaultSchemaClient(0, false, 'integer', rules), 'target'),
        unsupportedInteger,
      );
  });

  it('rejects unsafe validator metadata when hashing an imported schema', async () => {
    const schema = await fetchSchema(defaultSchemaClient(null), 'target');
    schema.models[0].fields[0].validators = {
      number_range: { min: JSON.parse('-9223372036854775807') as number },
    };
    assert.throws(() => schemaHash(schema), unsupportedInteger);
  });

  it('preserves safe numeric metadata, strings, nulls, fractions, and typed FLOAT defaults', async () => {
    const validators: JsonObject = {
      number_range: { min: null, max: 10.5 },
      nested: {
        values: [
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          null,
          0.25,
          '9007199254740993',
        ],
      },
    };
    const schema = await fetchSchema(
      defaultSchemaClient(null, false, 'float', validators),
      'target',
    );
    assert.deepEqual(schema.models[0].fields[0].validators, validators);
    assert.equal(schema.hash, schemaHash(schema));
    const largeFloat = await fetchSchema(
      defaultSchemaClient(1e30, false, 'float', {
        number_range: { min: -0.5 },
      }),
      'target',
    );
    assert.equal(largeFloat.models[0].fields[0].defaultValue, 1e30);
  });
});
