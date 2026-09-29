import { advertisedBlockLimitScenario } from './complex-recursive-boundary-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff advertised block-count limit real CMA E2E', function () {
  this.timeout(1_800_000);

  it('migrates exactly 2000 blocks only when the project advertises capacity for them', async () => {
    await runRealCmaScenario(advertisedBlockLimitScenario);
  });
});
