import assert from 'node:assert/strict';
import { ContentError } from '../src/engine/errors';
import {
  assertFullReadAccess,
  fetchSchema,
  schemaHash,
} from '../src/engine/schema';
import type { Client, JsonObject, SchemaState } from '../src/engine/types';
import { withBulkSchema } from './bulk-schema-fixture';

const MODEL = 'aaaaaaaaaaaaaaaaaaaaaa';
const WORKFLOW = 'bbbbbbbbbbbbbbbbbbbbbb';

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
  return { schema, client, permissions, rule };
}

const unproven = (error: unknown) =>
  error instanceof ContentError && error.code === 'UNPROVEN_FULL_ACCESS';

describe('full read access proof', () => {
  it('accepts unrestricted read grants regardless of destination-stage restrictions', async () => {
    const value = fixture();
    for (const grant of [
      value.rule,
      { ...value.rule, action: 'read' },
      { ...value.rule, to_stage: 'review' },
      { ...value.rule, to_stage: null, on_stage: null },
      { ...value.rule, item_type: null, workflow: WORKFLOW },
    ]) {
      value.permissions.positive_item_type_permissions = [grant];
      await assertFullReadAccess(value.client, value.schema);
    }
  });

  it('rejects restricted read grants and matching negative permissions', async () => {
    const value = fixture();
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
        assertFullReadAccess(value.client, value.schema),
        unproven,
      );
    }
    value.permissions.positive_item_type_permissions = [value.rule];
    value.permissions.negative_item_type_permissions = [
      { action: 'read', environment: 'target', workflow: WORKFLOW },
    ];
    await assert.rejects(
      assertFullReadAccess(value.client, value.schema),
      unproven,
    );
    value.permissions.negative_item_type_permissions = [
      { action: 'all', environment: 'other', workflow: WORKFLOW },
    ];
    await assertFullReadAccess(value.client, value.schema);
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

describe('schema field settings', () => {
  it('reads defaults and validator metadata as opaque settings, unsafe integers included', async () => {
    const unsafe = JSON.parse('9007199254740993') as number;
    for (const [defaultValue, localized, validators] of [
      [unsafe, false, { number_range: { max: unsafe } }],
      [{ en: 1, it: unsafe }, true, { nested: { limits: [1, null, unsafe] } }],
      [Number.MAX_SAFE_INTEGER, false, {}],
      [null, false, { number_range: { min: null, max: 10.5 } }],
    ] as const) {
      const schema = await fetchSchema(
        defaultSchemaClient(
          defaultValue,
          localized,
          'integer',
          validators as JsonObject,
        ),
        'target',
      );
      assert.deepEqual(schema.models[0].fields[0].defaultValue, defaultValue);
      assert.deepEqual(schema.models[0].fields[0].validators, validators);
      assert.equal(schema.hash, schemaHash(schema));
    }
  });
});
