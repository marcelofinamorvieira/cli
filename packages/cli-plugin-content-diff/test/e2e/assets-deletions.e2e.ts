import { assetsAndDeletionsScenario } from './assets-deletions-scenario';
import { runRealCmaScenario } from './real-cma-harness';
import { exifClearedBinaryReplacementScenario } from './upload-exif-replacement-scenario';
import { sameByteUploadRenameScenario } from './upload-rename-permission-scenario';

describe('content:diff real CMA assets and deletions E2E', function () {
  this.timeout(1_800_000);

  it('bundles source-only bytes, converges metadata and collections, and deletes an unreferenced upload', async () => {
    await runRealCmaScenario(assetsAndDeletionsScenario);
  });

  it('renames an existing upload without changing bytes or manual metadata using replace-asset permission only', async () => {
    await runRealCmaScenario(sameByteUploadRenameScenario);
  });

  it('replaces EXIF-bearing bytes while preserving cleared manual metadata', async () => {
    await runRealCmaScenario(exifClearedBinaryReplacementScenario);
  });
});
