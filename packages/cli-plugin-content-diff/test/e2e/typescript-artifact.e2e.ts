import { goldenPathScenario, runRealCmaScenario } from './real-cma-harness';

describe('content:diff TypeScript artifact real CMA E2E', function () {
  this.timeout(1_800_000);

  it('generates, applies, replays, and regenerates a TypeScript migration', async () => {
    await runRealCmaScenario({
      ...goldenPathScenario,
      name: 'TypeScript published update, create, and retained extra',
      migrationFormat: 'ts',
    });
  });
});
