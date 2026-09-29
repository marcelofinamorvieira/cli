import { expect } from 'chai';
import {
  PROVEN_FEATURES,
  SANITIZED_HTML_WRITE_GUARD_FAILURE_PATTERN,
  projectSanitizedHtmlRawRecord,
  sanitizedHtmlWriteGuardScenario,
} from './sanitized-html-write-guard-scenario';

describe('sanitized_html write-guard real-CMA oracle', () => {
  it('declares only the exact expected-failure features proved by the lane', () => {
    expect(PROVEN_FEATURES).to.deep.equal([
      'active-sanitized-html-source-only-create-fails-before-artifacts',
      'active-sanitized-html-full-rehydrate-current-restore-fails-before-artifacts',
      'non-sanitizer-validator-relaxation-does-not-disable-sanitized-html',
      'noncanonical-current-and-published-html-bytes-remain-exact',
      'expected-generation-failure-preserves-source-and-target-fingerprints',
      'expected-generation-failure-leaves-zero-migration-artifacts',
    ]);
    expect(sanitizedHtmlWriteGuardScenario.contentDiffArgs).to.deep.equal([
      '--migrate-invalid-content',
    ]);
    expect(
      sanitizedHtmlWriteGuardScenario.expectedGenerationFailure?.messagePattern,
    ).to.equal(SANITIZED_HTML_WRITE_GUARD_FAILURE_PATTERN);
  });

  it('projects exact raw current/published bytes and validity metadata', () => {
    const recordId = 'SanitizeOracle1234567';
    expect(
      projectSanitizedHtmlRawRecord(
        {
          data: {
            id: recordId,
            type: 'item',
            attributes: {
              body: '<p>Historical <br /> &copy; bytes</p>',
              marker: '',
            },
            meta: {
              is_current_version_valid: false,
              is_published_version_valid: false,
            },
          },
        },
        recordId,
        'published',
      ),
    ).to.deep.equal({
      id: recordId,
      body: '<p>Historical <br /> &copy; bytes</p>',
      marker: '',
      currentValid: false,
      publishedValid: false,
    });
  });

  it('matches only the fail-closed, pre-artifact generator diagnostic', () => {
    expect(
      SANITIZED_HTML_WRITE_GUARD_FAILURE_PATTERN.test(
        'Cannot generate an exact migration because CMA may rewrite 2 projected text value(s) during attribute-bearing CREATE/UPDATE stages under active sanitized_html rules. No migration artifacts were created.',
      ),
    ).to.equal(true);
    expect(
      SANITIZED_HTML_WRITE_GUARD_FAILURE_PATTERN.test(
        'CMA validation failed after artifacts were written',
      ),
    ).to.equal(false);
    expect(
      SANITIZED_HTML_WRITE_GUARD_FAILURE_PATTERN.test(
        'Cannot generate an exact migration because CMA may rewrite 1 projected text value(s) during attribute-bearing CREATE/UPDATE stages. No migration artifacts were created.',
      ),
    ).to.equal(false);
  });
});
