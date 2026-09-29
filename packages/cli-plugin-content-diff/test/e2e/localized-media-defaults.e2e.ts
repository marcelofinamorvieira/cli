import { localizedMediaDefaultsScenario } from './localized-media-defaults-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff localized media and cross-type defaults real CMA E2E', function () {
  this.timeout(1_800_000);

  it('converges localized media, nested uploads, video, and every supported non-string historical default type', async () => {
    await runRealCmaScenario(localizedMediaDefaultsScenario);
  });
});
