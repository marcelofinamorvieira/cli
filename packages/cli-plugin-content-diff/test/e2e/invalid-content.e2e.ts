import {
  invalidContentDefaultScenario,
  invalidContentRelaxationScenario,
} from './invalid-content-scenarios';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff invalid-content real CMA E2E', function () {
  this.timeout(1_800_000);

  it('migrates actual invalid current and published content with exact temporary relaxations', async () => {
    await runRealCmaScenario(invalidContentRelaxationScenario);
  });

  it('skips strict invalid aggregates while preserving native invalid drafts and no-ops', async () => {
    await runRealCmaScenario(invalidContentDefaultScenario);
  });
});
