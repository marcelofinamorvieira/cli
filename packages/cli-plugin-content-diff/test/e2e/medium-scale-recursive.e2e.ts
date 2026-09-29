import { mediumScaleRecursiveScenario } from './medium-scale-recursive-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff medium-scale recursive real CMA E2E', function () {
  this.timeout(1_800_000);

  it('converges 65 paginated records with scalar, localized, lifecycle, ordering, link, and recursive block drift', async () => {
    await runRealCmaScenario(mediumScaleRecursiveScenario);
  });
});
