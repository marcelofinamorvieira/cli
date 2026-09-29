import { runRealCmaScenario } from './real-cma-harness';
import {
  crossBoundaryDeletionReferrerScenario,
  defaultInvalidUniquePeerScenario,
  localizedPublishedStageUniqueScenario,
  optionalDeletionCyclesScenario,
  skippedOwnerUnpublishedCreateSeedScenario,
  skippedRecordUploadProtectionScenario,
  uniqueAcyclicHandoffScenario,
  uniqueCyclicSwapRelaxationScenario,
} from './unique-deletion-scenarios';

describe('content:diff uniqueness and deletion real CMA E2E', function () {
  this.timeout(1_800_000);

  it('orders current and published unique releases before source-only creates', async () => {
    await runRealCmaScenario(uniqueAcyclicHandoffScenario);
  });

  it('temporarily relaxes only unique for current and published cyclic swaps', async () => {
    await runRealCmaScenario(uniqueCyclicSwapRelaxationScenario);
  });

  it('keeps a native invalid draft with an independently skipped uniqueness peer', async () => {
    await runRealCmaScenario(defaultInvalidUniquePeerScenario);
  });

  it('relaxes only unique for localized phase-7 published staging', async () => {
    await runRealCmaScenario(localizedPublishedStageUniqueScenario);
  });

  it('skips an unpublished create seed whose unique owner must be preserved', async () => {
    await runRealCmaScenario(skippedOwnerUnpublishedCreateSeedScenario);
  });

  it('releases current and published optional-reference SCCs before deletion', async () => {
    await runRealCmaScenario(optionalDeletionCyclesScenario);
  });

  it('rejects a deletion retained by an out-of-scope published referrer', async () => {
    await runRealCmaScenario(crossBoundaryDeletionReferrerScenario);
  });

  it('skips a claimant blocked by a target-only owner and protects its upload', async () => {
    await runRealCmaScenario(skippedRecordUploadProtectionScenario);
  });
});
