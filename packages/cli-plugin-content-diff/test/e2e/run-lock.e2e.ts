import {
  concurrentInPlaceRuns,
  contentDiffRefusesLockedEnvironments,
  forkModeLocks,
  probeDuplicateLockId,
  runRunLockScenario,
  signalInterruption,
} from './run-lock-scenarios';

describe('migrations:run run lock and interruption real CMA E2E', function () {
  this.timeout(1_800_000);

  it('rejects a duplicate lock ID without overwriting and stores a 255-character lock name', async () => {
    await runRunLockScenario('duplicate lock ID probe', probeDuplicateLockId);
  });

  it('lets only one of two concurrent in-place runs execute', async () => {
    await runRunLockScenario('concurrent in-place runs', concurrentInPlaceRuns);
  });

  it('refuses content:diff while either environment is locked', async () => {
    await runRunLockScenario(
      'content:diff against locked environments',
      contentDiffRefusesLockedEnvironments,
    );
  });

  it('refuses to fork a locked source, clears it with --force-unlock, and reports a lock copied by a fork', async () => {
    await runRunLockScenario('fork-mode run locks', forkModeLocks);
  });

  it('stops after the running migration on SIGINT and exits at once with the lock held on a second SIGINT', async () => {
    await runRunLockScenario('signal interruption', signalInterruption);
  });
});
