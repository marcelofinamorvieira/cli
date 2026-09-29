import { createHash } from 'node:crypto';
import { expect } from 'chai';
import {
  RawCmaOracleError,
  type RawCmaReadPort,
  type RawItemListQuery,
  type RawLedgerPayload,
  assertLedgerAppendOnly,
  assertRawCmaState,
  captureRawCmaStateFromPort,
  inspectRawLedgerPayload,
  mergeRawCmaStates,
  remapRawCmaState,
} from './raw-cma-oracle';

const MODEL_ID = '4QI3BfBvQs-hcv_YEkk1wg';
const RECORD_A = 'YhEa5SbeSl6KwIFizzkzig';
const RECORD_B = 'XSPMXvayT-yMUrVxP-YoSw';
const RECORD_C = '-40RNzgBSJaJsXiLSYhtVA';
const LEDGER_RECORD_ID = 'ZI2O3FaURp6J5OpD7AtI_A';
const BATCH_ID = 'MhFdacOuSjWkDS9TYlAsbw';

describe('independent raw-CMA oracle', () => {
  it('paginates raw current and published slices and normalizes only selected fields', async () => {
    const current = Array.from({ length: 31 }, (_, index) =>
      rawItem(
        index === 0 ? RECORD_A : index === 30 ? RECORD_B : `item-${index}`,
        MODEL_ID,
        `title-${index}`,
        index === 0 ? RECORD_B : null,
      ),
    );
    const published = [rawItem(RECORD_A, MODEL_ID, 'title-0', null)];
    const calls: RawItemListQuery[] = [];
    const port: RawCmaReadPort = {
      rawListItems: async (query) => {
        calls.push(query);
        const records = query.version === 'current' ? current : published;
        return {
          data: records.slice(
            query.page.offset,
            query.page.offset + query.page.limit,
          ),
          meta: { total_count: records.length },
          ignored: 'the oracle never relies on client-normalized entities',
        };
      },
    };

    const state = await captureRawCmaStateFromPort(port, {
      modelId: MODEL_ID,
      recordIds: [RECORD_B, RECORD_A],
    });

    expect(state.sliceIds).to.deep.equal({
      current: [RECORD_B, RECORD_A].sort(),
      published: [RECORD_A],
    });
    expect(state.current.find(({ id }) => id === RECORD_A)).to.deep.equal({
      id: RECORD_A,
      itemTypeId: MODEL_ID,
      title: 'title-0',
      body: 'body-title-0',
      related: RECORD_B,
    });
    expect(calls).to.have.length(3);
    for (const call of calls) {
      expect(call).to.include({ nested: true, order_by: 'id_ASC' });
      expect(call.filter).to.deep.equal({ type: MODEL_ID });
      expect(call.page.limit).to.equal(30);
    }
  });

  it('fails closed on duplicate pages and unstable totals', async () => {
    let call = 0;
    const duplicatePort: RawCmaReadPort = {
      rawListItems: async ({ version }) => {
        if (version === 'published')
          return { data: [], meta: { total_count: 0 } };
        call += 1;
        return call === 1
          ? {
              data: Array.from({ length: 30 }, (_, index) =>
                rawItem(`record-${index}`, MODEL_ID, `title-${index}`, null),
              ),
              meta: { total_count: 31 },
            }
          : {
              data: [rawItem('record-0', MODEL_ID, 'duplicate', null)],
              meta: { total_count: 31 },
            };
      },
    };

    await expectRejected(
      captureRawCmaStateFromPort(duplicatePort, {
        modelId: MODEL_ID,
        recordIds: [],
      }),
      /duplicate ID record-0/,
    );
  });

  it('merges preserved state, remaps record references, and compares exactly', () => {
    const source = {
      current: [record(RECORD_A, RECORD_B)],
      published: [record(RECORD_A, null)],
      sliceIds: { current: [RECORD_A], published: [RECORD_A] },
    };
    const preserved = {
      current: [record(RECORD_C, null)],
      published: [],
      sliceIds: { current: [RECORD_C], published: [] },
    };
    const aliases = { [RECORD_A]: RECORD_B, [RECORD_B]: RECORD_A };
    const expected = mergeRawCmaStates(
      remapRawCmaState(source, aliases),
      preserved,
    );

    expect(() => assertRawCmaState(expected, expected)).not.to.throw();
    expect(expected.current.map(({ id }) => id)).to.deep.equal(
      [RECORD_B, RECORD_C].sort(),
    );
    expect(
      expected.current.find(({ id }) => id === RECORD_B)?.related,
    ).to.equal(RECORD_A);
    expect(() =>
      mergeRawCmaStates(source, {
        ...source,
        current: [{ ...source.current[0], title: 'conflict' }],
      }),
    ).to.throw(RawCmaOracleError, /conflicting current records/);
  });

  it('treats an absent reserved model as an empty ledger without creating it', () => {
    const state = inspectRawLedgerPayload(emptyLedgerPayload());

    expect(state).to.deep.equal({
      present: false,
      projectId: 'project-id',
      modelId: null,
      recordHashes: {},
      batches: [],
      entries: [],
    });
  });

  it('validates the exact ledger schema, canonical batch, lifecycle, and append-only hashes', () => {
    const payload = validLedgerPayload();
    const before = inspectRawLedgerPayload(payload);
    const after = inspectRawLedgerPayload(payload);

    expect(before.present).to.equal(true);
    expect(before.batches).to.have.length(1);
    expect(before.entries).to.deep.equal([
      { entityType: 'record', sourceId: '1', targetId: RECORD_A },
    ]);
    expect(() => assertLedgerAppendOnly(before, after)).not.to.throw();

    const tampered = structuredClone(payload);
    (tampered.currentRecords[0] as any).meta.status = 'published';
    expect(() => inspectRawLedgerPayload(tampered)).to.throw(
      RawCmaOracleError,
      /invalid lifecycle metadata status/,
    );

    const drifted = structuredClone(payload);
    const mappingField = drifted.includedSchemaResources.find(
      (resource: any) =>
        resource.type === 'field' && resource.attributes.api_key === 'mapping',
    ) as any;
    mappingField.attributes.appearance.parameters = { unexpected: true };
    expect(() => inspectRawLedgerPayload(drifted)).to.throw(
      RawCmaOracleError,
      /unexpected appearance/,
    );
  });
});

function rawItem(
  id: string,
  itemTypeId: string,
  title: string,
  related: string | null,
): unknown {
  return {
    type: 'item',
    id,
    attributes: { title, body: `body-${title}`, related },
    relationships: { item_type: relationship(itemTypeId) },
    meta: { status: 'draft' },
  };
}

function record(id: string, related: string | null) {
  return {
    id,
    itemTypeId: MODEL_ID,
    title: `title-${id}`,
    body: `body-${id}`,
    related,
  };
}

function relationship(id: string | null) {
  return { data: id === null ? null : { type: 'resource', id } };
}

function emptyLedgerPayload(): RawLedgerPayload {
  return {
    projectId: 'project-id',
    includedSchemaResources: [],
    menuItems: [],
    schemaMenuItems: [],
    itemTypeFilters: [],
    currentRecords: [],
    publishedRecords: [],
  };
}

function validLedgerPayload(): RawLedgerPayload {
  const nameFieldId = 'name-field-id';
  const mappingFieldId = 'mapping-field-id';
  const ledgerModelId = 'ledger-model-id';
  const entries = [{ entityType: 'record', sourceId: '1', targetId: RECORD_A }];
  const wholeHash = sha256(stableJson(entries));
  const document = {
    batchId: BATCH_ID,
    chunkCount: 1,
    chunkIndex: 0,
    entries,
    formatVersion: 1,
    projectId: 'project-id',
    wholeHash,
  };
  const mapping = JSON.stringify(canonicalJson(document), null, 2);

  return {
    projectId: 'project-id',
    includedSchemaResources: [
      {
        type: 'item_type',
        id: ledgerModelId,
        attributes: {
          name: 'Content diff',
          api_key: 'datocms_content_diff',
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
          workflow: relationship(null),
          singleton_item: relationship(null),
          ordering_field: relationship(null),
          presentation_image_field: relationship(null),
          image_preview_field: relationship(null),
          excerpt_field: relationship(null),
          title_field: relationship(nameFieldId),
          presentation_title_field: relationship(nameFieldId),
        },
      },
      ledgerField(
        nameFieldId,
        ledgerModelId,
        'Name',
        'name',
        'string',
        1,
        { required: {}, unique: {} },
        {
          addons: [],
          editor: 'single_line',
          parameters: { heading: false, placeholder: null },
        },
      ),
      ledgerField(
        mappingFieldId,
        ledgerModelId,
        'Mapping',
        'mapping',
        'json',
        2,
        { required: {} },
        { addons: [], editor: 'json', parameters: {} },
      ),
    ],
    menuItems: [],
    schemaMenuItems: [
      {
        type: 'schema_menu_item',
        id: 'ledger-schema-menu-id',
        attributes: { label: 'Content diff', position: 99 },
        relationships: {
          item_type: relationship(ledgerModelId),
          parent: relationship(null),
          children: { data: [] },
        },
      },
    ],
    itemTypeFilters: [],
    currentRecords: [
      {
        type: 'item',
        id: LEDGER_RECORD_ID,
        attributes: {
          name: `legacy-id-map:${BATCH_ID}:1/1`,
          mapping,
        },
        relationships: { item_type: relationship(ledgerModelId) },
        meta: {
          status: 'draft',
          is_valid: true,
          is_current_version_valid: true,
          is_published_version_valid: null,
          stage: null,
          publication_scheduled_at: null,
          unpublishing_scheduled_at: null,
          published_at: null,
          first_published_at: null,
        },
      },
    ],
    publishedRecords: [],
  };
}

function ledgerField(
  id: string,
  itemTypeId: string,
  label: string,
  apiKey: string,
  fieldType: string,
  position: number,
  validators: Record<string, unknown>,
  appearance: Record<string, unknown>,
) {
  return {
    type: 'field',
    id,
    attributes: {
      label,
      api_key: apiKey,
      field_type: fieldType,
      localized: false,
      position,
      validators,
      appearance,
      default_value: null,
      hint: null,
      deep_filtering_enabled: false,
      content_link_enabled: true,
    },
    relationships: {
      item_type: relationship(itemTypeId),
      fieldset: relationship(null),
    },
  };
}

async function expectRejected(
  promise: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  try {
    await promise;
    expect.fail('Expected promise to reject.');
  } catch (error) {
    expect(error).to.be.instanceOf(RawCmaOracleError);
    expect((error as Error).message).to.match(message);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}
