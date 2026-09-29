import { runRealCmaScenario } from './real-cma-harness';
import { independentRequiredShellComponentsScenario } from './shell-components-scenarios';

describe('content:diff independent shell components real CMA E2E', function () {
  this.timeout(1_800_000);

  it('preserves a required one-way dependency between independent shell SCCs', async () => {
    await runRealCmaScenario(independentRequiredShellComponentsScenario);
  });
});
