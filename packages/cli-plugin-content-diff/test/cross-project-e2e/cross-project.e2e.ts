import { runAlignedCrossProjectE2E } from './cross-project-harness';

describe('content:diff aligned cross-project real CMA E2E', function () {
  this.timeout(1_800_000);

  it('generates read-only across aligned projects and executes with destination credentials only', async () => {
    await runAlignedCrossProjectE2E();
  });
});
