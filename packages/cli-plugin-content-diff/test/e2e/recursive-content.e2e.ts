import { runRealCmaScenario } from './real-cma-harness';
import {
  recursiveRequiredCycleRelaxationScenario,
  recursiveRequiredCycleSkipScenario,
} from './recursive-content-scenarios';

describe('content:diff recursive real CMA E2E', function () {
  this.timeout(1_800_000);

  it('recreates a recursive localized published Structured Text-only cycle with exact validator relaxation', async () => {
    await runRealCmaScenario(recursiveRequiredCycleRelaxationScenario);
  });

  it('skips an unsafe Structured Text-only required cycle without the invalid-content opt-in', async () => {
    await runRealCmaScenario(recursiveRequiredCycleSkipScenario);
  });
});
