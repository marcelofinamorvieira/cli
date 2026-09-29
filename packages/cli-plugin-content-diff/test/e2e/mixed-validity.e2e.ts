import { mixedValidityScenario } from './mixed-validity-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff mixed current/published validity real CMA E2E', function () {
  this.timeout(1_800_000);

  it('recreates opposite validity states and restores the exact validator contract', async () => {
    await runRealCmaScenario(mixedValidityScenario);
  });
});
