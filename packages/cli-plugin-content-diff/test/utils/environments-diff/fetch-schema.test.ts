import { expect } from 'chai';
import {
  CONTENT_DIFF_MAPPING_MODEL_API_KEY,
  fetchSchema,
} from '../../../src/utils/environments-diff/fetch-schema';

describe('environment schema snapshot', () => {
  it('excludes the internal content-diff mapping model and its fields', async () => {
    const regularItemType = {
      id: 'article-model',
      type: 'item_type',
      attributes: { api_key: 'article' },
    };
    const internalItemType = {
      id: 'content-diff-model',
      type: 'item_type',
      attributes: {
        name: 'Content diff',
        api_key: CONTENT_DIFF_MAPPING_MODEL_API_KEY,
        singleton: false,
        modular_block: false,
        draft_mode_active: true,
        draft_saving_active: false,
        sortable: false,
        tree: false,
        all_locales_required: false,
        inverse_relationships_enabled: false,
        collection_appearance: 'compact',
        ordering_direction: null,
        ordering_meta: null,
        has_singleton_item: false,
        hint: null,
      },
      relationships: {
        workflow: { data: null },
        singleton_item: { data: null },
        ordering_field: { data: null },
        presentation_title_field: {
          data: { id: 'name-field', type: 'field' },
        },
        title_field: { data: { id: 'name-field', type: 'field' } },
        presentation_image_field: { data: null },
        image_preview_field: { data: null },
        excerpt_field: { data: null },
      },
    };
    const regularField = {
      id: 'title-field',
      type: 'field',
      attributes: { validators: {} },
      relationships: {
        item_type: { data: { id: regularItemType.id, type: 'item_type' } },
      },
    };
    const internalField = {
      id: 'mapping-field',
      type: 'field',
      attributes: {
        label: 'Mapping',
        api_key: 'mapping',
        field_type: 'json',
        localized: false,
        position: 2,
        validators: { required: {} },
        appearance: { addons: [], editor: 'json', parameters: {} },
        default_value: null,
        hint: null,
        deep_filtering_enabled: false,
        content_link_enabled: true,
      },
      relationships: {
        item_type: { data: { id: internalItemType.id, type: 'item_type' } },
        fieldset: { data: null },
      },
    };
    const internalNameField = {
      id: 'name-field',
      type: 'field',
      attributes: {
        label: 'Name',
        api_key: 'name',
        field_type: 'string',
        localized: false,
        position: 1,
        validators: { required: {}, unique: {} },
        appearance: {
          addons: [],
          editor: 'single_line',
          parameters: { heading: false, placeholder: null },
        },
        default_value: null,
        hint: null,
        deep_filtering_enabled: false,
        content_link_enabled: true,
      },
      relationships: {
        item_type: { data: { id: internalItemType.id, type: 'item_type' } },
        fieldset: { data: null },
      },
    };
    const internalSchemaMenuItem = {
      id: 'content-diff-schema-menu-item',
      type: 'schema_menu_item',
      attributes: { position: 1 },
      relationships: {
        item_type: {
          data: { id: internalItemType.id, type: 'item_type' },
        },
        parent: { data: null },
        children: { data: [] },
      },
    };
    const regularSchemaMenuItem = {
      id: 'article-schema-menu-item',
      type: 'schema_menu_item',
      attributes: { position: 2 },
      relationships: {
        item_type: {
          data: { id: regularItemType.id, type: 'item_type' },
        },
        parent: { data: null },
        children: { data: [] },
      },
    };
    const regularMenuItem = {
      id: 'article-menu-item',
      type: 'menu_item',
      attributes: { position: 1 },
      relationships: {
        item_type: {
          data: { id: regularItemType.id, type: 'item_type' },
        },
        item_type_filter: { data: null },
        parent: { data: null },
        children: { data: [] },
      },
    };
    const emptyList = async () => ({ data: [] });
    const client = {
      site: {
        rawFind: async () => ({
          data: { id: 'site', type: 'site', attributes: {} },
          included: [
            regularItemType,
            internalItemType,
            regularField,
            internalNameField,
            internalField,
          ],
        }),
      },
      menuItems: {
        rawList: async () => ({ data: [regularMenuItem] }),
      },
      schemaMenuItems: {
        rawList: async () => ({
          data: [internalSchemaMenuItem, regularSchemaMenuItem],
        }),
      },
      plugins: { rawList: emptyList },
      workflows: { rawList: emptyList },
      itemTypeFilters: { rawList: emptyList },
      uploadFilters: { rawList: emptyList },
    };

    const schema = await fetchSchema(client as never);

    expect(schema.internalItemTypeIds).to.deep.equal([internalItemType.id]);
    expect(Object.keys(schema.itemTypesById)).to.deep.equal([
      regularItemType.id,
    ]);
    expect(
      Object.keys(schema.itemTypesById[regularItemType.id].fieldsById),
    ).to.deep.equal([regularField.id]);
    expect(Object.keys(schema.schemaMenuItemsById)).to.deep.equal([
      regularSchemaMenuItem.id,
    ]);
    expect(
      schema.schemaMenuItemsById[regularSchemaMenuItem.id].attributes.position,
    ).to.equal(1);
    expect(Object.keys(schema.menuItemsById)).to.deep.equal([
      regularMenuItem.id,
    ]);
    expect(
      schema.menuItemsById[regularMenuItem.id].attributes.position,
    ).to.equal(1);

    internalNameField.attributes.appearance.parameters.heading = true;

    let fieldDriftError: unknown;

    try {
      await fetchSchema(client as never);
    } catch (caught) {
      fieldDriftError = caught;
    }

    expect(fieldDriftError).to.be.instanceOf(Error);
    expect((fieldDriftError as Error).message).to.contain(
      'reserved model API key "datocms_content_diff"',
    );

    internalNameField.attributes.appearance.parameters.heading = false;
    internalNameField.attributes.content_link_enabled = false;

    let contentLinkDriftError: unknown;

    try {
      await fetchSchema(client as never);
    } catch (caught) {
      contentLinkDriftError = caught;
    }

    expect(contentLinkDriftError).to.be.instanceOf(Error);
    expect((contentLinkDriftError as Error).message).to.contain(
      'reserved model API key "datocms_content_diff"',
    );

    internalNameField.attributes.content_link_enabled = true;

    internalItemType.attributes.name = 'User-owned content diff';

    let collisionError: unknown;

    try {
      await fetchSchema(client as never);
    } catch (caught) {
      collisionError = caught;
    }

    expect(collisionError).to.be.instanceOf(Error);
    expect((collisionError as Error).message).to.contain(
      'reserved model API key "datocms_content_diff"',
    );
  });

  it('fails instead of hiding schema-menu descendants under the reserved model', async () => {
    const itemType = {
      id: 'content-diff-model',
      type: 'item_type',
      attributes: {
        name: 'Content diff',
        api_key: CONTENT_DIFF_MAPPING_MODEL_API_KEY,
        singleton: false,
        modular_block: false,
        draft_mode_active: true,
        draft_saving_active: false,
        sortable: false,
        tree: false,
        all_locales_required: false,
        inverse_relationships_enabled: false,
        collection_appearance: 'compact',
        ordering_direction: null,
        ordering_meta: null,
        has_singleton_item: false,
        hint: null,
      },
      relationships: {
        workflow: { data: null },
        singleton_item: { data: null },
        ordering_field: { data: null },
        presentation_title_field: {
          data: { id: 'name-field', type: 'field' },
        },
        title_field: { data: { id: 'name-field', type: 'field' } },
        presentation_image_field: { data: null },
        image_preview_field: { data: null },
        excerpt_field: { data: null },
      },
    };
    const fields = [
      {
        id: 'name-field',
        type: 'field',
        attributes: {
          label: 'Name',
          api_key: 'name',
          field_type: 'string',
          localized: false,
          position: 1,
          validators: { required: {}, unique: {} },
          appearance: {
            addons: [],
            editor: 'single_line',
            parameters: { heading: false, placeholder: null },
          },
          default_value: null,
          hint: null,
          deep_filtering_enabled: false,
          content_link_enabled: true,
        },
        relationships: {
          item_type: { data: { id: itemType.id, type: 'item_type' } },
          fieldset: { data: null },
        },
      },
      {
        id: 'mapping-field',
        type: 'field',
        attributes: {
          label: 'Mapping',
          api_key: 'mapping',
          field_type: 'json',
          localized: false,
          position: 2,
          validators: { required: {} },
          appearance: { addons: [], editor: 'json', parameters: {} },
          default_value: null,
          hint: null,
          deep_filtering_enabled: false,
          content_link_enabled: true,
        },
        relationships: {
          item_type: { data: { id: itemType.id, type: 'item_type' } },
          fieldset: { data: null },
        },
      },
    ];
    const internalNode = {
      id: 'content-diff-schema-menu-item',
      type: 'schema_menu_item',
      attributes: { position: 1 },
      relationships: {
        item_type: { data: { id: itemType.id, type: 'item_type' } },
        parent: { data: null },
        children: { data: [{ id: 'user-child', type: 'schema_menu_item' }] },
      },
    };
    const child = {
      id: 'user-child',
      type: 'schema_menu_item',
      attributes: { position: 1 },
      relationships: {
        item_type: { data: null },
        parent: {
          data: { id: internalNode.id, type: 'schema_menu_item' },
        },
        children: { data: [] },
      },
    };
    const emptyList = async () => ({ data: [] });
    const client = {
      site: {
        rawFind: async () => ({
          data: { id: 'site', type: 'site', attributes: {} },
          included: [itemType, ...fields],
        }),
      },
      menuItems: { rawList: emptyList },
      schemaMenuItems: {
        rawList: async () => ({ data: [internalNode, child] }),
      },
      plugins: { rawList: emptyList },
      workflows: { rawList: emptyList },
      itemTypeFilters: { rawList: emptyList },
      uploadFilters: { rawList: emptyList },
    };

    let error: unknown;

    try {
      await fetchSchema(client as never);
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(
      'not the exact internal content-diff mapping contract',
    );
  });
});

describe('environment schema snapshot ledger contract', () => {
  function ledgerSchema() {
    const itemType = {
      id: 'content-diff-model',
      type: 'item_type',
      attributes: {
        name: 'Content diff',
        api_key: CONTENT_DIFF_MAPPING_MODEL_API_KEY,
        singleton: false,
        modular_block: false,
        draft_mode_active: true,
        draft_saving_active: false,
        sortable: false,
        tree: false,
        all_locales_required: false,
        inverse_relationships_enabled: false,
        collection_appearance: 'compact',
        ordering_direction: null,
        ordering_meta: null,
        has_singleton_item: false,
        hint: null,
      } as Record<string, unknown>,
      relationships: {
        workflow: { data: null },
        singleton_item: { data: null },
        ordering_field: { data: null },
        presentation_title_field: {
          data: { id: 'name-field', type: 'field' },
        },
        title_field: { data: { id: 'name-field', type: 'field' } },
        presentation_image_field: { data: null },
        image_preview_field: { data: null },
        excerpt_field: { data: null },
      } as Record<string, unknown>,
    };
    const ledgerField = (
      id: string,
      attributes: Record<string, unknown>,
    ): { id: string; type: string; attributes: any; relationships: any } => ({
      id,
      type: 'field',
      attributes: {
        localized: false,
        default_value: null,
        hint: null,
        deep_filtering_enabled: false,
        content_link_enabled: true,
        ...attributes,
      },
      relationships: {
        item_type: { data: { id: itemType.id, type: 'item_type' } },
        fieldset: { data: null },
      },
    });
    const fields = [
      ledgerField('name-field', {
        label: 'Name',
        api_key: 'name',
        field_type: 'string',
        position: 1,
        validators: { required: {}, unique: {} },
        appearance: {
          addons: [],
          editor: 'single_line',
          parameters: { heading: false, placeholder: null },
        },
      }),
      ledgerField('mapping-field', {
        label: 'Mapping',
        api_key: 'mapping',
        field_type: 'json',
        position: 2,
        validators: { required: {} },
        appearance: { addons: [], editor: 'json', parameters: {} },
      }),
    ];
    const schemaMenuItem = {
      id: 'content-diff-schema-menu-item',
      type: 'schema_menu_item',
      attributes: { position: 1 },
      relationships: {
        item_type: { data: { id: itemType.id, type: 'item_type' } },
        parent: { data: null },
        children: { data: [] },
      },
    };
    const emptyList = async () => ({ data: [] });
    const client = {
      site: {
        rawFind: async () => ({
          data: { id: 'site', type: 'site', attributes: {} },
          included: [itemType, ...fields],
        }),
      },
      menuItems: { rawList: emptyList },
      schemaMenuItems: { rawList: async () => ({ data: [schemaMenuItem] }) },
      plugins: { rawList: emptyList },
      workflows: { rawList: emptyList },
      itemTypeFilters: { rawList: emptyList },
      uploadFilters: { rawList: emptyList },
    };

    return { itemType, fields, ledgerField, client };
  }

  async function schemaError(client: unknown): Promise<Error> {
    try {
      await fetchSchema(client as never);
    } catch (caught) {
      return caught as Error;
    }
    throw new Error('Expected the ledger contract check to fail');
  }

  it('hides an exact ledger through the shared contract', async () => {
    const { itemType, client } = ledgerSchema();

    const schema = await fetchSchema(client as never);

    expect(schema.internalItemTypeIds).to.deep.equal([itemType.id]);
    expect(schema.itemTypesById).to.deep.equal({});
    expect(schema.schemaMenuItemsById).to.deep.equal({});
  });

  it('names each differing field by API key and ID', async () => {
    const { fields, client } = ledgerSchema();
    fields[0].attributes.validators = { required: { x: 1 }, unique: {} };

    const error = await schemaError(client);

    expect(error.message).to.equal(
      'The reserved model API key "datocms_content_diff" is not the exact internal content-diff mapping contract (validators of field "name" (name-field)). Rerun the content migration that created it if setup was interrupted, or rename the conflicting model before generating a schema migration.',
    );
  });

  it('rejects an appearance with keys beyond the contract', async () => {
    const { fields, client } = ledgerSchema();
    fields[1].attributes.appearance = {
      addons: [],
      editor: 'json',
      parameters: {},
      field_extension: 'custom-json-editor',
    };

    const error = await schemaError(client);

    expect(error.message).to.contain(
      '(appearance of field "mapping" (mapping-field))',
    );
  });

  it('reads a relationship missing from the resource as empty', async () => {
    const { itemType, fields, client } = ledgerSchema();
    const without = (relationships: Record<string, unknown>, key: string) =>
      Object.fromEntries(
        Object.entries(relationships).filter(([name]) => name !== key),
      );
    itemType.relationships = without(itemType.relationships, 'workflow');
    fields[1].relationships = without(fields[1].relationships, 'fieldset');

    const schema = await fetchSchema(client as never);

    expect(schema.internalItemTypeIds).to.deep.equal([itemType.id]);
  });

  it('rejects a relationship without data instead of failing on its shape', async () => {
    const { itemType, client } = ledgerSchema();
    itemType.relationships.workflow = {};

    const error = await schemaError(client);

    expect(error.message).to.contain(
      'not the exact internal content-diff mapping contract (workflow)',
    );
  });

  it('never hides a model that takes the reserved API key without the contract', async () => {
    const { itemType, fields, ledgerField, client } = ledgerSchema();
    itemType.attributes.name = 'Imported notes';
    itemType.attributes.draft_mode_active = false;
    fields.push(
      ledgerField('notes-field', {
        label: 'Notes',
        api_key: 'notes',
        field_type: 'text',
        position: 3,
        validators: {},
        appearance: { addons: [], editor: 'textarea', parameters: {} },
      }),
    );
    fields[1].attributes.position = 4;

    const error = await schemaError(client);

    expect(error.message).to.contain(
      '(name; draft_mode_active; extraFields; position of field "mapping" (mapping-field))',
    );
    expect(error.message).to.contain('rename the conflicting model');
  });

  it('requires both ledger fields, since schema diffing never resumes a partial setup', async () => {
    const { fields, client } = ledgerSchema();
    fields.splice(1, 1);

    const error = await schemaError(client);

    expect(error.message).to.contain('(fieldCount)');
  });
});
