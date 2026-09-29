import { noDraftSingletonScenario } from './no-draft-singleton-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff no-draft singleton real CMA E2E', function () {
  this.timeout(1_800_000);

  it('creates a source-only published dependency before its no-draft singleton', async () => {
    await runRealCmaScenario(noDraftSingletonScenario);
  });
});
