import { runRealCmaScenario } from './real-cma-harness';
import {
  assetSeoValidatorGauntletScenario,
  scalarValidatorGauntletScenario,
} from './validator-gauntlet-scenarios';

describe('content:diff validator gauntlet real CMA E2E', function () {
  this.timeout(1_800_000);

  it('migrates scalar, date, slug, and HTML invalid slices with exact validator restoration', async () => {
    await runRealCmaScenario(scalarValidatorGauntletScenario);
  });

  it('migrates asset and SEO invalid slices with exact validators and bundled bytes', async () => {
    await runRealCmaScenario(assetSeoValidatorGauntletScenario);
  });
});
