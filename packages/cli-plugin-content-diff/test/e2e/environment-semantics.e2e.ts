import { environmentTimezoneMismatchScenario } from './environment-semantics-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff real CMA environment semantics E2E', function () {
  this.timeout(1_800_000);

  it('rejects timezone drift before content reads or artifacts', async () => {
    await runRealCmaScenario(environmentTimezoneMismatchScenario);
  });
});
