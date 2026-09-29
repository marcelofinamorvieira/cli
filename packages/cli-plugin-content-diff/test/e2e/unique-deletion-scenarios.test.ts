import { expect } from 'chai';
import {
  CROSS_BOUNDARY_REFERRER_FAILURE_PATTERN,
  crossBoundaryDeletionReferrerScenario,
  defaultInvalidUniquePeerScenario,
  localizedPublishedStageUniqueScenario,
  optionalDeletionCyclesScenario,
  skippedOwnerUnpublishedCreateSeedScenario,
  skippedRecordUploadProtectionScenario,
  uniqueAcyclicHandoffScenario,
  uniqueCyclicSwapRelaxationScenario,
  uniqueDeletionApiKey,
} from './unique-deletion-scenarios';

describe('real-CMA uniqueness and deletion scenarios', () => {
  it('builds deterministic API-safe model keys for every lane', () => {
    const runId = 'mepgph3k-012abc';
    const keys = [
      'uhand',
      'uswap',
      'udef',
      'ustag',
      'useed',
      'dcycle',
      'bound',
      'refer',
      'uprot',
    ].map((lane) => uniqueDeletionApiKey(lane, runId));

    expect(new Set(keys).size).to.equal(keys.length);
    for (const key of keys) {
      expect(key).to.match(/^[a-z](?:[a-z0-9]|_(?![_0-9]))*[a-z0-9]$/);
      expect(key.length).to.be.at.most(30);
    }
    expect(uniqueDeletionApiKey('uhand', runId)).to.equal(keys[0]);
  });

  it('requires the precise cross-boundary deletion refusal', () => {
    expect(
      CROSS_BOUNDARY_REFERRER_FAILURE_PATTERN.test(
        'Record target cannot be deleted safely because published referrer referrer is outside the selected reconciliation or deletion island, or retains the reference.',
      ),
    ).to.equal(true);
    expect(
      CROSS_BOUNDARY_REFERRER_FAILURE_PATTERN.test(
        'Record target cannot be deleted safely',
      ),
    ).to.equal(false);
    expect(
      crossBoundaryDeletionReferrerScenario.expectedGenerationFailure,
    ).to.deep.equal({
      messagePattern: CROSS_BOUNDARY_REFERRER_FAILURE_PATTERN,
    });
  });

  it('keeps each live lane explicit about its safety opt-ins', () => {
    expect(uniqueAcyclicHandoffScenario.contentDiffArgs).to.equal(undefined);
    expect(uniqueCyclicSwapRelaxationScenario.contentDiffArgs).to.deep.equal([
      '--migrate-invalid-content',
    ]);
    expect(defaultInvalidUniquePeerScenario.contentDiffArgs).to.equal(
      undefined,
    );
    expect(localizedPublishedStageUniqueScenario.contentDiffArgs).to.deep.equal(
      ['--migrate-invalid-content'],
    );
    expect(skippedOwnerUnpublishedCreateSeedScenario.contentDiffArgs).to.equal(
      undefined,
    );
    expect(optionalDeletionCyclesScenario.contentDiffArgs).to.deep.equal([
      '--include-deletions',
    ]);
    expect(crossBoundaryDeletionReferrerScenario.contentDiffArgs).to.deep.equal(
      ['--include-deletions'],
    );
    expect(skippedRecordUploadProtectionScenario.contentDiffArgs).to.deep.equal(
      ['--uploads=all', '--include-deletions'],
    );
  });

  it('provides independent raw-CMA verification for every successful lane', () => {
    for (const scenario of [
      uniqueAcyclicHandoffScenario,
      uniqueCyclicSwapRelaxationScenario,
      defaultInvalidUniquePeerScenario,
      localizedPublishedStageUniqueScenario,
      skippedOwnerUnpublishedCreateSeedScenario,
      optionalDeletionCyclesScenario,
      skippedRecordUploadProtectionScenario,
    ]) {
      expect(scenario.verify).to.be.a('function');
      expect(scenario.expectedGenerationFailure).to.equal(undefined);
    }
  });
});
