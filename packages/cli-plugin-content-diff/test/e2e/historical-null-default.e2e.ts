import { historicalNullDefaultScenario } from './historical-null-default-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff historical-null default real CMA E2E', function () {
  this.timeout(1_800_000);

  it('recreates explicit float null values even after non-null defaults are added', async () => {
    await runRealCmaScenario(historicalNullDefaultScenario);
  });
});
