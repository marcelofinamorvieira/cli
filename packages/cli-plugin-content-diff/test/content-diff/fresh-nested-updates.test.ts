import { expect } from 'chai';
import { semanticHash } from '../../src/content-diff/canonicalize';
import {
  collectFreshNestedBlockCreateIds,
  findUnsupportedFreshNestedBlockUpdates,
  itemTypeIdsAffectedByValidatorChanges,
} from '../../src/content-diff/shared/fresh-nested-updates';
import type {
  FieldSchemaSnapshot,
  ItemTypeSchemaSnapshot,
  JsonObject,
  RecordSnapshot,
  RecordVersionSnapshot,
  SchemaSnapshot,
} from '../../src/content-diff/types';

describe('fresh nested block UPDATE lifetimes', () => {
  const schema = makeSchema();

  const check = (
    baseline: RecordSnapshot | null,
    desired: RecordSnapshot,
    blockedModels: ReadonlySet<string> = new Set(),
    unsafeCreates: ReadonlySet<string> = new Set(),
  ) =>
    findUnsupportedFreshNestedBlockUpdates(
      [
        {
          id: 'record',
          action: baseline ? 'update' : 'create',
          baseline,
          desired,
        },
      ],
      schema,
      schema,
      blockedModels,
      unsafeCreates,
    );

  it('distinguishes unused, current, and published-only IDs at each stage', () => {
    const cases = [
      {
        baseline: record(['a'], null),
        desired: record(['b'], null),
        stages: [],
      },
      {
        baseline: record(['a'], ['b']),
        desired: record(['b'], ['b']),
        stages: ['current-restore'],
      },
      {
        baseline: record(['a'], ['b']),
        desired: record(['c'], ['c']),
        stages: [],
      },
      {
        baseline: record(['a'], ['b']),
        desired: record(['b'], ['a']),
        stages: [],
      },
      {
        baseline: record(['a'], ['b']),
        desired: record(['b'], ['c']),
        stages: [],
      },
      {
        baseline: record(['a'], ['b']),
        desired: record(['b'], null),
        stages: [],
      },
      {
        baseline: record(['a'], ['b']),
        desired: record(['c'], ['b', 'c']),
        stages: ['published-stage'],
      },
      { baseline: null, desired: record(['b'], ['a']), stages: [] },
    ];
    for (const [index, fixture] of cases.entries()) {
      expect(
        check(fixture.baseline, fixture.desired).map(({ stage }) => stage),
        `case ${index}`,
      ).to.deep.equal(fixture.stages);
    }
  });

  it('requires both target predecessor and desired slice validity, independently of source validity', () => {
    for (const baselineValid of [false, true]) {
      for (const desiredValid of [false, true]) {
        const baseline = record(['a'], null, baselineValid);
        const desired = record(['b'], null, desiredValid);
        expect(
          check(baseline, desired).length,
          `${baselineValid}/${desiredValid}`,
        ).to.equal(baselineValid && desiredValid ? 0 : 1);
      }
    }
    // A successful same-ID publication stage does not erase an unsafe initial
    // predecessor from the static contract; runtime validation remains required.
    const baseline = record(['a'], ['a'], false);
    const desired = record(['b'], ['a', 'c']);
    expect(check(baseline, desired).map(({ stage }) => stage)).to.deep.equal([
      'published-stage',
      'current-restore',
    ]);
  });

  it('finds recreated IDs even when they belonged to a baseline version', () => {
    for (const [baseline, desired, expected] of [
      [record(['legacy'], null), record(['legacy'], null), []],
      [
        record(['legacy'], null),
        record(['legacy'], ['new']),
        ['legacy', 'new'],
      ],
      [record([], ['legacy']), record(['legacy'], null), ['legacy']],
      [record([], ['legacy']), record(['legacy'], ['legacy']), []],
      [null, record(['current'], ['published']), ['current', 'published']],
    ] as const) {
      expect(
        collectFreshNestedBlockCreateIds(
          [
            {
              id: 'record',
              action: baseline ? 'update' : 'create',
              baseline,
              desired,
            },
          ],
          schema,
        ),
      ).to.deep.equal(expected);
    }
  });

  it('preserves invalid create seeds and projected intermediates with later fresh IDs', () => {
    const desired = record(['b'], ['a']);
    expect(check(null, desired, new Set(), new Set(['record']))).to.have.length(
      1,
    );
    expect(check(null, desired, new Set(['root']))).to.have.length(1);
    expect(
      check(null, {
        ...desired,
        validity: { current: true, published: false },
      }),
    ).to.have.length(1);
    expect(
      check(null, {
        ...desired,
        validity: { current: false, published: true },
      }),
    ).to.have.length(1);
    expect(
      check(null, record(['a'], ['a']), new Set(['root']), new Set(['record'])),
    ).to.deep.equal([]);
  });

  it('derives transitive containing models across every embedding field kind, excluding links and unrelated models', () => {
    for (const field of [
      embeddingField('rich_text', 'rich_text_blocks', 'leaf'),
      embeddingField('single_block', 'single_block_blocks', 'leaf'),
      embeddingField('structured_text', 'structured_text_blocks', 'leaf'),
      embeddingField(
        'structured_text',
        'structured_text_inline_blocks',
        'leaf',
      ),
    ]) {
      const related = {
        ...schema,
        // Intentionally reverse the topological order to require closure.
        itemTypes: [
          itemType('root', false, [
            embeddingField('rich_text', 'rich_text_blocks', 'middle'),
          ]),
          itemType('middle', true, [field]),
          itemType('leaf', true, [
            embeddingField('rich_text', 'rich_text_blocks', 'middle'),
          ]),
          itemType('unrelated', false, []),
          itemType('referrer', false, [
            embeddingField('link', 'item_item_type', 'leaf'),
          ]),
        ],
      };
      expect(
        [
          ...itemTypeIdsAffectedByValidatorChanges(related, new Set(['leaf'])),
        ].sort(),
      ).to.deep.equal(['leaf', 'middle', 'root']);
    }
    expect(
      check(record(['a'], null), record(['b'], null), new Set(['unrelated'])),
    ).to.deep.equal([]);
  });
});

function record(
  currentIds: string[],
  publishedIds: string[] | null,
  valid = true,
): RecordSnapshot {
  const current = version(currentIds);
  const published = publishedIds ? version(publishedIds) : null;
  return {
    id: 'record',
    itemTypeId: 'root',
    current,
    published,
    topology: { parentId: null, position: null },
    lifecycle: {
      createdAt: '2020-01-01T00:00:00.000Z',
      firstPublishedAt: published ? '2020-01-01T00:00:00.000Z' : null,
    },
    validity: { current: valid, published: published ? valid : null },
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: semanticHash({
      current: current.hash,
      published: published?.hash ?? null,
    }),
    consistency: {
      currentVersion: '1',
      updatedAt: '2020-01-01T00:00:00.000Z',
      publishedAt: published ? '2020-01-01T00:00:00.000Z' : null,
      currentValid: valid,
      publishedValid: published ? valid : null,
    },
  };
}

function version(ids: string[]): RecordVersionSnapshot {
  const fields: JsonObject = {
    blocks: ids.map((id) => ({
      id,
      type: 'item',
      attributes: { title: id },
      relationships: { item_type: { data: { id: 'leaf', type: 'item_type' } } },
    })),
  };
  return { fields, hash: semanticHash(fields) };
}

function embeddingField(
  fieldType: FieldSchemaSnapshot['fieldType'],
  validator: string,
  child: string,
): FieldSchemaSnapshot {
  return {
    id: 'field-blocks',
    apiKey: 'blocks',
    fieldType,
    localized: false,
    position: 1,
    validators: { [validator]: { item_types: [child] } },
  };
}

function itemType(
  id: string,
  modularBlock: boolean,
  fields: FieldSchemaSnapshot[],
): ItemTypeSchemaSnapshot {
  return {
    id,
    apiKey: id,
    name: id,
    modularBlock,
    singleton: false,
    sortable: false,
    tree: false,
    draftModeActive: !modularBlock,
    draftSavingActive: false,
    allLocalesRequired: false,
    workflowId: null,
    fields,
  };
}

function makeSchema(): SchemaSnapshot {
  return {
    siteId: 'site',
    environmentId: 'environment',
    locales: ['en'],
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
      itemType('root', false, [
        embeddingField('rich_text', 'rich_text_blocks', 'leaf'),
      ]),
      itemType('leaf', true, []),
    ],
    workflows: [],
    digest: '',
  };
}
