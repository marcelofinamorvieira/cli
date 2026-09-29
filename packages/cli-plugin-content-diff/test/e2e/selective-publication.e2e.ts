import { runRealCmaScenario } from './real-cma-harness';
import { selectivePublicationScenario } from './selective-publication-scenario';

describe('content:diff selective publication real CMA E2E', function () {
  this.timeout(1_800_000);

  it('reproduces published locale membership and divergent current values', async () => {
    await runRealCmaScenario(selectivePublicationScenario);
  });
});
