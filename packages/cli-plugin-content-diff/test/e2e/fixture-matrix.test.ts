import { expect } from 'chai';
import {
  FIRST_LIVE_LANE_ID,
  FIXTURE_MATRIX,
  REQUIRED_FIXTURE_FEATURES,
  assertFixtureMatrixComplete,
  fixtureCoverage,
  fixtureLane,
} from './fixture-matrix';

describe('real-CMA fixture matrix', () => {
  it('is internally complete as a declarative design catalog', () => {
    expect(() => assertFixtureMatrixComplete()).not.to.throw();
    expect([...fixtureCoverage().keys()].sort()).to.deep.equal(
      [...REQUIRED_FIXTURE_FEATURES].sort(),
    );
  });

  it('keeps the first live lane small, portable, and ledger-free', () => {
    const lane = fixtureLane(FIRST_LIVE_LANE_ID);

    expect(lane.priority).to.equal('smoke');
    expect(lane.features).to.include.members([
      'portable_ids',
      'draft',
      'published',
      'updated',
      'destination_only_content',
      'idempotent_rerun',
    ]);
    expect(
      lane.features.some((feature) => feature.startsWith('legacy_')),
    ).to.equal(false);
    expect(lane.oracle.join('\n')).to.contain(
      'reserved legacy ledger is absent',
    );
  });

  it('makes every destructive or rejection lane explicit', () => {
    const deletionLanes = FIXTURE_MATRIX.filter(
      ({ run }) => run.includeDeletions,
    );
    const rejectionLanes = FIXTURE_MATRIX.filter(({ run }) =>
      run.expectedOutcome.endsWith('rejects'),
    );

    expect(deletionLanes.map(({ id }) => id)).to.have.members([
      'recursive_block_cross_product',
      'deletions_and_retention_boundaries',
    ]);
    expect(rejectionLanes.length).to.be.greaterThan(0);
    for (const lane of rejectionLanes) {
      expect(lane.oracle.join('\n')).to.match(/reject|fail closed/i);
    }
  });
});
