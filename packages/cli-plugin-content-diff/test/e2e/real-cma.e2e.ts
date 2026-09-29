import { runRealCmaE2E } from './real-cma-harness';

describe('content:diff real CMA E2E', function () {
  this.timeout(1_800_000);

  it("generates with the plugin, applies with the plugin's migrations:run, and verifies through raw CMA", async () => {
    await runRealCmaE2E();
  });
});
