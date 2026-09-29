import { runRealCmaScenario } from './real-cma-harness';
import { scheduleScenario } from './real-cma-schedules';

describe('content:diff real CMA schedule E2E', function () {
  this.timeout(1_800_000);

  it('reconciles selective publication and unpublishing schedules', async () => {
    await runRealCmaScenario(scheduleScenario);
  });
});
