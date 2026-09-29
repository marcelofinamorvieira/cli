import { runRealCmaScenario } from './real-cma-harness';
import { lifecycleStateScenario } from './real-cma-lifecycle';

describe('content:diff real CMA lifecycle E2E', function () {
  this.timeout(1_800_000);

  it('reproduces draft, published, updated, unpublished, and no-draft states', async () => {
    await runRealCmaScenario(lifecycleStateScenario);
  });
});
