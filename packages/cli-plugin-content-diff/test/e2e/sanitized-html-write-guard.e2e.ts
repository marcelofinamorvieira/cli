import { runRealCmaScenario } from './real-cma-harness';
import { sanitizedHtmlWriteGuardScenario } from './sanitized-html-write-guard-scenario';

describe('content:diff sanitized_html write guard real CMA E2E', function () {
  this.timeout(1_800_000);

  it('rejects source-only CREATE and full-rehydrate UPDATE sanitizer rewrites without artifacts or mutations', async () => {
    await runRealCmaScenario(sanitizedHtmlWriteGuardScenario);
  });
});
