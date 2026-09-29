import { optionalCreateValidationScenario } from './optional-create-validation-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff strict optional create SCC real CMA E2E', function () {
  this.timeout(1_800_000);

  it('relaxes only size, creates the whole SCC, and restores validators', async () => {
    await runRealCmaScenario(optionalCreateValidationScenario);
  });
});
