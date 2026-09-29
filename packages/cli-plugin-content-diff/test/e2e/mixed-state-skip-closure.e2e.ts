import { mixedStateSkipClosureScenario } from './mixed-state-skip-closure-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff multi-hop mixed-state skip closure real CMA E2E', function () {
  this.timeout(1_800_000);

  it('preserves the exact A-B-C closure and its upload while independently converging D', async () => {
    await runRealCmaScenario(mixedStateSkipClosureScenario);
  });
});
