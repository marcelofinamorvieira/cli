import { expect } from 'chai';
import {
  SCHEMA_GATE_FAILURE_PATTERN,
  managedSchemaMismatchScenario,
  outOfScopeSchemaDriftScenario,
  schemaGateApiKey,
} from './schema-gating-scenarios';

describe('real-CMA schema-gating scenarios', () => {
  it('requires the actionable managed-schema failure guidance', () => {
    const actionable = [
      'Incompatible schema: managed schemas differ.',
      'No content records were read and no migration artifacts were created.',
      'datocms migrations:new "sync source schema"',
      'datocms migrations:run --source="destination"',
      'datocms content:diff "sync content"',
      '--migrate-invalid-content does not bypass schema compatibility.',
    ].join('\n');

    expect(SCHEMA_GATE_FAILURE_PATTERN.test(actionable)).to.equal(true);
    expect(SCHEMA_GATE_FAILURE_PATTERN.test('Incompatible schema')).to.equal(
      false,
    );
    expect(
      managedSchemaMismatchScenario.expectedGenerationFailure,
    ).to.deep.equal({ messagePattern: SCHEMA_GATE_FAILURE_PATTERN });
  });

  it('keeps both lanes scoped to a single explicitly selected model', () => {
    expect(managedSchemaMismatchScenario.name).to.contain('managed');
    expect(outOfScopeSchemaDriftScenario.name).to.contain('unrelated');
    expect(outOfScopeSchemaDriftScenario.expectedGenerationFailure).to.equal(
      undefined,
    );
    expect(outOfScopeSchemaDriftScenario.verify).to.be.a('function');
  });

  it('generates compact API keys without underscore-before-digit segments', () => {
    for (const apiKey of [
      schemaGateApiKey('managed', 'mismatch', 'mepgph3k-012abc'),
      schemaGateApiKey('unrelated', 'out_of_scope', 'mepgph3k-012abc'),
    ]) {
      expect(apiKey).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      expect(apiKey.length).to.be.lessThan(30);
    }
  });
});
