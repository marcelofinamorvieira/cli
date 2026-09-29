import {
  invalidScheduleOnlyScenario,
  invalidUnchangedScheduleCurrentWriteScenario,
} from './invalid-schedule-only-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff invalid schedule-only real CMA E2E', function () {
  this.timeout(1_800_000);

  it('preserves an invalid target aggregate when only a future selective publication schedule differs', async () => {
    await runRealCmaScenario(invalidScheduleOnlyScenario);
  });

  it('preserves an invalid target aggregate when a changed invalid current value retains the exact future schedule', async () => {
    await runRealCmaScenario(invalidUnchangedScheduleCurrentWriteScenario);
  });
});
