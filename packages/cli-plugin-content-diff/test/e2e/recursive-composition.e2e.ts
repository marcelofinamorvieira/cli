import { runRealCmaScenario } from './real-cma-harness';
import {
  freshRecursiveCompositionScenario,
  recursiveCompositionScenario,
} from './recursive-composition-scenario';

describe('content:diff recursive composition real CMA E2E', function () {
  this.timeout(1_800_000);

  it('converges every container pair and alternating depth-five blocks in both locales and publication slices', async () => {
    await runRealCmaScenario(recursiveCompositionScenario);
  });

  it('creates distinct nested IDs through every container pair during published staging and current restoration', async () => {
    await runRealCmaScenario(freshRecursiveCompositionScenario);
  });
});
