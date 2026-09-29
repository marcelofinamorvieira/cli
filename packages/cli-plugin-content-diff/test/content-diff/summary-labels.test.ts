import { expect } from 'chai';
import {
  recordPresentationTitle,
  summarizeForCommand,
  summaryDisplayText,
} from '../../src/content-diff/index';
import {
  type PresentationTitleFields,
  fetchSchemaSnapshot,
} from '../../src/content-diff/schema';
import type { ContentDiffPlan, JsonObject } from '../../src/content-diff/types';

const LOCALES = ['en', 'it', 'de'];

function cmaItemType(
  id: string,
  apiKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: 'item_type',
    name: apiKey,
    api_key: apiKey,
    modular_block: false,
    singleton: false,
    sortable: false,
    tree: false,
    draft_mode_active: false,
    draft_saving_active: false,
    all_locales_required: false,
    workflow: null,
    presentation_title_field: null,
    title_field: null,
    ...overrides,
  };
}

function cmaField(id: string, apiKey: string): Record<string, unknown> {
  return {
    id,
    type: 'field',
    api_key: apiKey,
    field_type: 'string',
    localized: false,
    position: 1,
    default_value: null,
    validators: {},
  };
}

function schemaClient(itemTypes: Record<string, unknown>[]) {
  const fields = new Map<string, Record<string, unknown>[]>([
    [
      'post-model',
      [cmaField('post-title', 'title'), cmaField('post-slug', 'slug')],
    ],
    ['tier-model', [cmaField('tier-name', 'tier_name')]],
    ['plain-model', [cmaField('plain-body', 'body')]],
  ]);
  return {
    site: {
      find: async () => ({
        id: 'site',
        locales: LOCALES,
        timezone: 'Europe/London',
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
    itemTypes: { list: async () => structuredClone(itemTypes) },
    workflows: { list: async () => [] },
    fields: {
      list: async (itemTypeId: string) =>
        structuredClone(fields.get(itemTypeId) ?? []),
    },
  };
}

function recordSnapshot(id: string, itemTypeId: string, fields: JsonObject) {
  return {
    id,
    itemTypeId,
    current: { fields, hash: `${id}-current` },
    published: null,
  };
}

function planWith(
  records: Record<string, unknown>[],
  uploads: Record<string, unknown>[] = [],
): ContentDiffPlan {
  return {
    schema: { locales: LOCALES },
    records,
    uploads,
    warnings: [],
    summary: {
      records: { create: 0, update: 0, delete: 0 },
      uploads: { create: 0, update: 0, delete: 0 },
      uploadCollections: { create: 0, update: 0 },
      legacyIdMappings: { detected: 0, skipped: 0, records: 0 },
      invalidContent: {},
    },
    invalidContent: { skippedRecords: [], validatorRelaxations: [] },
    legacyIdMappings: { entries: [], skippedEntries: [] },
  } as unknown as ContentDiffPlan;
}

describe('content:diff summary labels', () => {
  describe('recordPresentationTitle', () => {
    it('reads the main locale of a localized title field', () => {
      expect(
        recordPresentationTitle(
          {
            title: { de: 'Frühjahrsstart', en: 'Spring launch', it: 'Lancio' },
          },
          'title',
          LOCALES,
        ),
      ).to.equal('Spring launch');
    });

    it('falls back to the first locale with a value, in project locale order', () => {
      expect(
        recordPresentationTitle(
          { title: { de: 'Frühjahrsstart', en: '  ', it: 'Lancio' } },
          'title',
          LOCALES,
        ),
      ).to.equal('Lancio');
    });

    it('reads non-localized strings and numbers', () => {
      expect(
        recordPresentationTitle({ name: 'Plus' }, 'name', LOCALES),
      ).to.equal('Plus');
      expect(recordPresentationTitle({ year: 2026 }, 'year', LOCALES)).to.equal(
        '2026',
      );
    });

    it('returns nothing without a title field, value, or printable text', () => {
      expect(recordPresentationTitle({ title: 'Plus' }, undefined, LOCALES)).to
        .be.undefined;
      expect(recordPresentationTitle({}, 'title', LOCALES)).to.be.undefined;
      expect(recordPresentationTitle({ title: null }, 'title', LOCALES)).to.be
        .undefined;
      expect(
        recordPresentationTitle(
          { title: { en: '', it: null } },
          'title',
          LOCALES,
        ),
      ).to.be.undefined;
      expect(recordPresentationTitle({ title: ['a', 'b'] }, 'title', LOCALES))
        .to.be.undefined;
    });
  });

  describe('summaryDisplayText', () => {
    it('drops characters that could rewrite the terminal', () => {
      expect(
        summaryDisplayText(
          'A\u001b]52;c;ZXZpbA==\u0007 title\r\nwith‮ bidi line',
        ),
      ).to.equal('A ]52;c;ZXZpbA== title with bidi line');
    });

    it('shortens long values to 60 characters', () => {
      const shortened = summaryDisplayText('x'.repeat(80));
      expect(shortened).to.have.length(60);
      expect(shortened?.endsWith('…')).to.equal(true);
      expect(summaryDisplayText('y'.repeat(60))).to.equal('y'.repeat(60));
    });
  });

  describe('summarizeForCommand', () => {
    it('labels creates and updates from the source and deletes from the destination', () => {
      const plan = planWith(
        [
          {
            id: 'created',
            itemTypeId: 'post-model',
            action: 'create',
            baseline: null,
            desired: recordSnapshot('created', 'post-model', {
              title: { en: 'Spring launch' },
            }),
          },
          {
            id: 'updated',
            itemTypeId: 'post-model',
            action: 'update',
            baseline: recordSnapshot('updated', 'post-model', {
              title: { en: 'Old title' },
            }),
            desired: recordSnapshot('updated', 'post-model', {
              title: { en: 'New title' },
            }),
          },
          {
            id: 'deleted',
            itemTypeId: 'post-model',
            action: 'delete',
            baseline: recordSnapshot('deleted', 'post-model', {
              headline: 'Destination-only headline',
            }),
            desired: null,
          },
          {
            id: 'untitled',
            itemTypeId: 'plain-model',
            action: 'update',
            baseline: null,
            desired: recordSnapshot('untitled', 'plain-model', {
              body: 'Body',
            }),
          },
          {
            id: 'unchanged',
            itemTypeId: 'post-model',
            action: 'noop',
            baseline: null,
            desired: recordSnapshot('unchanged', 'post-model', {
              title: { en: 'Unchanged' },
            }),
          },
        ],
        [
          {
            id: 'upload-new',
            action: 'create',
            baseline: null,
            desired: { filename: 'spring-launch-hero.png' },
          },
          {
            id: 'upload-gone',
            action: 'delete',
            baseline: { filename: 'old-banner.jpg' },
            desired: null,
          },
        ],
      );
      // The destination uses a different title field for the same model.
      const source: PresentationTitleFields = new Map([
        ['post-model', 'title'],
      ]);
      const destination: PresentationTitleFields = new Map([
        ['post-model', 'headline'],
      ]);

      const summary = summarizeForCommand(plan, { source, destination });

      expect(summary.records).to.deep.equal([
        {
          id: 'created',
          itemTypeId: 'post-model',
          action: 'create',
          title: 'Spring launch',
        },
        {
          id: 'updated',
          itemTypeId: 'post-model',
          action: 'update',
          title: 'New title',
        },
        {
          id: 'deleted',
          itemTypeId: 'post-model',
          action: 'delete',
          title: 'Destination-only headline',
        },
        { id: 'untitled', itemTypeId: 'plain-model', action: 'update' },
      ]);
      expect(summary.uploads).to.deep.equal([
        {
          id: 'upload-new',
          action: 'create',
          filename: 'spring-launch-hero.png',
        },
        { id: 'upload-gone', action: 'delete', filename: 'old-banner.jpg' },
      ]);
    });

    it('leaves records unlabelled when no title fields were collected', () => {
      const summary = summarizeForCommand(
        planWith([
          {
            id: 'created',
            itemTypeId: 'post-model',
            action: 'create',
            baseline: null,
            desired: recordSnapshot('created', 'post-model', {
              title: { en: 'Spring launch' },
            }),
          },
        ]),
      );
      expect(summary.records).to.deep.equal([
        { id: 'created', itemTypeId: 'post-model', action: 'create' },
      ]);
    });
  });

  describe('fetchSchemaSnapshot title fields', () => {
    const itemTypes = [
      cmaItemType('post-model', 'post', {
        presentation_title_field: { id: 'post-title', type: 'field' },
        title_field: { id: 'post-slug', type: 'field' },
      }),
      cmaItemType('tier-model', 'pricing_tier', {
        title_field: { id: 'tier-name', type: 'field' },
      }),
      cmaItemType('plain-model', 'plain'),
    ];

    it('collects the presentation title field, then the title field, by API key', async () => {
      const titleFields: PresentationTitleFields = new Map();
      await fetchSchemaSnapshot(
        schemaClient(itemTypes) as never,
        'main',
        titleFields,
      );
      expect([...titleFields.entries()].sort()).to.deep.equal([
        ['post-model', 'title'],
        ['tier-model', 'tier_name'],
      ]);
    });

    it('keeps presentation settings out of the schema snapshot and its digest', async () => {
      const withTitles = await fetchSchemaSnapshot(
        schemaClient(itemTypes) as never,
        'main',
        new Map(),
      );
      const withoutTitleSettings = await fetchSchemaSnapshot(
        schemaClient(
          itemTypes.map((itemType) => ({
            ...itemType,
            presentation_title_field: null,
            title_field: null,
          })),
        ) as never,
        'main',
      );
      expect(withTitles).to.deep.equal(withoutTitleSettings);
    });
  });
});
