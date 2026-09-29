import { complexRecursiveBoundaryScenario } from './complex-recursive-boundary-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff complex recursive boundary real CMA E2E', function () {
  this.timeout(1_800_000);

  it('migrates 500 blocks at maximum depth with the complete DAST grammar', async () => {
    await runRealCmaScenario(complexRecursiveBoundaryScenario);
  });
});
