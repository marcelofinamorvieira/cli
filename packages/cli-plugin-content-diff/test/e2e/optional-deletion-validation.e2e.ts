import { optionalDeletionValidationScenario } from './optional-deletion-validation-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff strict optional deletion SCC real CMA E2E', function () {
  this.timeout(1_800_000);

  it('relaxes only size, deletes the whole SCC, and restores validators', async () => {
    await runRealCmaScenario(optionalDeletionValidationScenario);
  });
});
