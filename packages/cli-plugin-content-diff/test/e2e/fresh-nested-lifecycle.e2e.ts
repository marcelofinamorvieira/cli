import {
  freshNestedSourceCreateScenario,
  publishedOnlyNestedIdScenario,
} from './fresh-nested-update-scenario';
import { runRealCmaScenario } from './real-cma-harness';

describe('content:diff fresh nested ID lifetimes real CMA E2E', function () {
  this.timeout(1_800_000);

  it('creates and publishes a source-only aggregate before restoring a different current block ID', async () => {
    await runRealCmaScenario(freshNestedSourceCreateScenario);
  });

  it('preserves a destination whose desired current block ID is retained only in its published version', async () => {
    await runRealCmaScenario(publishedOnlyNestedIdScenario);
  });
});
