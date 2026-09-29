import { publishedTreeScenario } from './published-tree-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff published tree real CMA E2E', function () {
  this.timeout(1_800_000);

  it('publishes parent-first and reparents before child-first subtree deletion', async () => {
    await runRealCmaScenario(publishedTreeScenario);
  });
});
