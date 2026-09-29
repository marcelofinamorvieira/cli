import { optionalSelfCycleScenario } from './optional-self-cycle-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff optional self-reference cycle real CMA E2E', function () {
  this.timeout(1_800_000);

  it('creates exact IDs before restoring optional self and peer references without relaxation', async () => {
    await runRealCmaScenario(optionalSelfCycleScenario);
  });
});
