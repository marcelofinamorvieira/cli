import { runRealCmaScenario } from './real-cma-harness';
import {
  presentationOnlyDriftScenario,
  transitiveSchemaMismatchScenario,
} from './transitive-schema-presentation-scenarios';

describe('content:diff transitive schema and presentation real CMA E2E', function () {
  this.timeout(1_800_000);

  it('rejects content-affecting drift at the fourth managed schema hop', async () => {
    await runRealCmaScenario(transitiveSchemaMismatchScenario);
  });

  it('converges content without rewriting destination presentation metadata', async () => {
    await runRealCmaScenario(presentationOnlyDriftScenario);
  });
});
