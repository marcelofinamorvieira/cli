import { customStructuredTextScenario } from './custom-structured-text-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff custom Structured Text real CMA E2E', function () {
  this.timeout(1_800_000);

  it('ignores out-of-children decoys and migrates real child references and nested blocks', async () => {
    await runRealCmaScenario(customStructuredTextScenario);
  });
});
