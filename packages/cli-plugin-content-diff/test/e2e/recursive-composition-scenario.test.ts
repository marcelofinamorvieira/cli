import assert from 'node:assert/strict';
import {
  buildRecursiveCompositionFields,
  inspectRecursiveComposition,
} from './recursive-composition-scenario';

describe('recursive composition live fixture oracle', () => {
  it('covers all sixteen pairs at depth five with disjoint locale and owner identities', () => {
    const input = {
      namespace: 'update',
      blockModelId: 'model',
      anchorId: 'anchor',
      variant: 'published',
    };
    const published = inspectRecursiveComposition(
      buildRecursiveCompositionFields(input),
    );
    const current = inspectRecursiveComposition(
      buildRecursiveCompositionFields({ ...input, variant: 'current' }),
    );
    const created = inspectRecursiveComposition(
      buildRecursiveCompositionFields({ ...input, namespace: 'create' }),
    );
    assert.equal(published.depth, 5);
    assert.equal(published.ids.length, 46);
    assert.equal(new Set(published.ids).size, 46);
    assert.equal(published.pairs.length, 16);
    assert.deepEqual(published.ids, current.ids);
    assert.notDeepEqual(published.fields, current.fields);
    assert.equal(
      created.ids.filter((id) => published.ids.includes(id)).length,
      0,
    );
    assert.ok(JSON.stringify(published.fields).includes('json-is-not-a-block'));
  });

  it('keeps every baseline, published, and current identity distinct in the fresh-ID fixture', () => {
    const versions = [
      'update',
      'update:published',
      'update:current',
      'create:published',
      'create:current',
    ].map((namespace) =>
      inspectRecursiveComposition(
        buildRecursiveCompositionFields({
          namespace,
          blockModelId: 'model',
          anchorId: 'anchor',
          variant: namespace,
        }),
      ),
    );
    for (const version of versions) {
      assert.equal(version.depth, 5);
      assert.equal(version.ids.length, 46);
      assert.equal(version.pairs.length, 16);
    }
    assert.equal(new Set(versions.flatMap((version) => version.ids)).size, 230);
  });
});
