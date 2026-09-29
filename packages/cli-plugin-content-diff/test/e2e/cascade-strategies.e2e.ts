import {
  externalFailUnpublishBoundaryScenario,
  managedCascadeStrategiesScenario,
} from './cascade-strategy-scenarios';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff cascade strategies real CMA E2E', function () {
  this.timeout(1_800_000);

  it('reconciles all managed cascades through explicit safe plan phases', async () => {
    await runRealCmaScenario(managedCascadeStrategiesScenario);
  });

  it('rejects an unpublish retained by an external fail-strategy referrer', async () => {
    await runRealCmaScenario(externalFailUnpublishBoundaryScenario);
  });
});
