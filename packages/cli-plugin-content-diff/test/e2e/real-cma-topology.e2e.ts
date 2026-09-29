import { runRealCmaScenario } from './real-cma-harness';
import { topologyWorkflowScenario } from './real-cma-topology';

describe('content:diff real CMA topology/workflow E2E', function () {
  this.timeout(1_800_000);

  it('reproduces tree topology, sortable order, and workflow stages', async () => {
    await runRealCmaScenario(topologyWorkflowScenario);
  });
});
