import { runRealCmaScenario } from './real-cma-harness';
import {
  requiredDeletionPreserveScenario,
  requiredDeletionRelaxationScenario,
} from './required-deletion-scenarios';

describe('content:diff required deletion SCC real CMA E2E', function () {
  this.timeout(1_800_000);

  it('preserves a destination-only required SCC as complete aggregates by default', async () => {
    await runRealCmaScenario(requiredDeletionPreserveScenario);
  });

  it('preserves an opt-in published nested-block SCC that the CMA cannot safely unlink', async () => {
    await runRealCmaScenario(requiredDeletionRelaxationScenario);
  });
});
