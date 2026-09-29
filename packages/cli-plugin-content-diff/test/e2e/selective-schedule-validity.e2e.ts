import { runRealCmaScenario } from './real-cma-harness';
import { selectiveScheduleValidityScenario } from './selective-schedule-validity-scenario';

describe('content:diff selective schedule validity real CMA E2E', function () {
  this.timeout(1_800_000);

  it('migrates an en-only valid slice and preserves an it-only invalid slice', async () => {
    await runRealCmaScenario(selectiveScheduleValidityScenario);
  });
});
