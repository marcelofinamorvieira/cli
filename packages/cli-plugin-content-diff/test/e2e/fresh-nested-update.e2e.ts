import { freshNestedUpdateScenario } from './fresh-nested-update-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff fresh nested UPDATE real CMA E2E', function () {
  this.timeout(1_800_000);

  it('converges exact fresh nested IDs through valid published staging and current restoration', async () => {
    await runRealCmaScenario(freshNestedUpdateScenario);
  });
});
