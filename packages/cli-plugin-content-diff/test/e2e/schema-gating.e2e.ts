import { runRealCmaScenario } from './real-cma-harness';
import {
  managedSchemaMismatchScenario,
  outOfScopeSchemaDriftScenario,
} from './schema-gating-scenarios';

describe('content:diff real CMA schema gating E2E', function () {
  this.timeout(1_800_000);

  it('rejects managed validator/default drift before artifacts or mutations', async () => {
    await runRealCmaScenario(managedSchemaMismatchScenario);
  });

  it('allows unrelated schema drift and converges managed records', async () => {
    await runRealCmaScenario(outOfScopeSchemaDriftScenario);
  });
});
