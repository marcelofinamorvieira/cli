import { constants } from 'node:fs';
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { canonicalizeJson, stableStringify } from './canonicalize';
import {
  RUNTIME_VERSION,
  renderEntrypoint,
  renderRuntime,
} from './runtime-template';
import { mapWithConcurrency } from './shared/concurrency';
import { CONTENT_DIFF_MANIFEST_VERSION } from './shared/contract';
import {
  type AssetDownloadTimeouts,
  downloadAsset,
} from './shared/download-asset';
import { isObject, sha256 } from './shared/json';
import {
  assertContentDiffEnvelope,
  validateContentDiffPlan,
} from './shared/plan-validation';
import { contentDiffTuningDefinition } from './shared/tuning';
import { uploadStagingFilename } from './shared/upload-contract';
import {
  ContentDiffError,
  type ContentDiffPlan,
  type JsonValue,
  type UploadSnapshot,
} from './types';

export interface ContentPlanEnvelope {
  formatVersion: typeof CONTENT_DIFF_MANIFEST_VERSION;
  runtimeVersion: typeof RUNTIME_VERSION;
  integrity: {
    algorithm: 'sha256';
    planSha256: string;
  };
  plan: ContentDiffPlan;
}

/**
 * Primitives that expose fully staged artifacts under their final names.
 * Injectable so tests can simulate filesystems without hard-link support.
 */
export interface ArtifactFileOperations {
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface WriteContentDiffArtifactsInput {
  plan: ContentDiffPlan;
  migrationFilePath: string;
  format: 'js' | 'ts';
  bundleAssets: boolean;
  fetchFn?: typeof fetch;
  assetDownloadTimeouts?: AssetDownloadTimeouts;
  fileOperations?: Partial<ArtifactFileOperations>;
}

export interface WrittenContentDiffArtifacts {
  migrationPath: string;
  planPath: string;
  runtimePath: string;
  assetsPath?: string;
  manifestSha256: string;
}

const CONTENT_DIRECTORY = '.datocms-content';
const STAGE_DIRECTORY_PREFIX = '.datocms-content-stage-';
const STAGE_OWNER_MARKER = '.owner.json';
const ABANDONED_STAGE_DIRECTORY_AGE_MS = 24 * 60 * 60 * 1000;
const RUNTIME_INSTALL_ATTEMPTS = 3;
const RUNTIME_RESERVATION_POLL_ATTEMPTS = 20;
const RUNTIME_RESERVATION_POLL_INTERVAL_MS = 100;

// link() failures that mean "no hard link can be created here" rather than
// "this path is taken": cross-device content directories (EXDEV), exFAT/FAT,
// SMB and FUSE mounts (EPERM, ENOTSUP, EOPNOTSUPP, ENOSYS), and link-count
// limits (EMLINK). libuv reports Windows ERROR_INVALID_FUNCTION, which FAT
// volumes return for CreateHardLinkW, as EISDIR; POSIX link() never returns
// EISDIR for the regular files staged here.
const LINK_UNSUPPORTED_ERROR_CODES: ReadonlySet<string> = new Set([
  'EISDIR',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

export async function writeContentDiffArtifacts({
  plan,
  migrationFilePath,
  format,
  bundleAssets,
  fetchFn = fetch,
  assetDownloadTimeouts,
  fileOperations,
}: WriteContentDiffArtifactsInput): Promise<WrittenContentDiffArtifacts> {
  const migrationsDirectory = dirname(migrationFilePath);
  const contentDirectory = join(migrationsDirectory, CONTENT_DIRECTORY);
  const migrationBasename = basename(migrationFilePath, `.${format}`);
  const planBasename = `${migrationBasename}.plan.json`;
  const assetsBasename = `${migrationBasename}.assets`;
  const planPath = join(contentDirectory, planBasename);
  const runtimePath = join(
    contentDirectory,
    `runtime-v${RUNTIME_VERSION}.${format}`,
  );
  const assetsPath = join(contentDirectory, assetsBasename);
  const manifestPlan = clonePlan(plan);

  // Reject malformed or unauthorized plans before creating even a staging
  // directory, downloading an asset, or exposing a final artifact path.
  assertEnvelope(buildEnvelope(manifestPlan));

  await mkdir(migrationsDirectory, { recursive: true });
  await refuseExisting(migrationFilePath, 'migration');
  await refuseExisting(planPath, 'content plan');

  if (bundleAssets) {
    await refuseExisting(assetsPath, 'bundled asset directory');
  }

  // A killed generation never reaches its finally block. Reclaim only stage
  // directories whose owner is provably gone before staging this one.
  await removeAbandonedStageDirectories(migrationsDirectory);
  await removeAbandonedStageDirectories(contentDirectory);

  const stagingDirectory = await createStageDirectory(migrationsDirectory);
  const installer: ArtifactInstaller = {
    operations: {
      link: fileOperations?.link ?? link,
      rename: fileOperations?.rename ?? rename,
    },
    migrationsDirectory,
    stagingDirectory,
    stageDirectories: new Map(),
    candidates: new Map(),
  };
  const stagedMigrationPath = join(
    stagingDirectory,
    `${migrationBasename}.${format}`,
  );
  const stagedPlanPath = join(stagingDirectory, planBasename);
  const stagedRuntimePath = join(
    stagingDirectory,
    `runtime-v${RUNTIME_VERSION}.${format}`,
  );
  const stagedAssetsPath = join(stagingDirectory, assetsBasename);

  let installedPlan = false;
  let installedAssets = false;
  let installedMigration = false;

  try {
    if (bundleAssets) {
      await bundleChangedAssets({
        plan: manifestPlan,
        assetsDirectory: stagedAssetsPath,
        assetsBasename,
        fetchFn,
        assetDownloadTimeouts,
      });
    }

    const envelope = buildEnvelope(manifestPlan);
    const manifestContents = `${JSON.stringify(
      canonicalizeJson(envelope as unknown as JsonValue),
      null,
      2,
    )}\n`;
    const manifestSha256 = sha256(manifestContents);
    const runtimeContents = `${renderRuntime(format).trimEnd()}\n`;
    const entrypointContents = `${renderEntrypoint(
      format,
      planBasename,
      manifestSha256,
      manifestPlan.target.siteId,
    ).trimEnd()}\n`;

    // Validate everything before any final path becomes visible.
    assertEnvelope(JSON.parse(manifestContents));
    await writeFile(stagedPlanPath, manifestContents, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await writeFile(stagedRuntimePath, runtimeContents, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await writeFile(stagedMigrationPath, entrypointContents, {
      encoding: 'utf8',
      flag: 'wx',
    });

    await mkdir(contentDirectory, { recursive: true });

    await installImmutableRuntime(
      installer,
      stagedRuntimePath,
      runtimePath,
      runtimeContents,
    );

    if (bundleAssets) {
      await installOwnedDirectory(installer, stagedAssetsPath, assetsPath);
      installedAssets = true;
    }

    // Without hard links the plan's exclusive reservation also serializes
    // every content-diff writer targeting this migration name.
    await installStagedFile(installer, stagedPlanPath, planPath, 'reserve');
    installedPlan = true;

    // The top-level migration is deliberately installed last: migrations:run
    // cannot discover an entrypoint whose dependencies are only half-written.
    await installStagedFile(
      installer,
      stagedMigrationPath,
      migrationFilePath,
      'entrypoint',
    );
    installedMigration = true;

    return {
      migrationPath: migrationFilePath,
      planPath,
      runtimePath,
      ...(bundleAssets ? { assetsPath } : {}),
      manifestSha256,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];

    if (installedMigration) {
      await unlink(migrationFilePath).catch((cleanupError) => {
        cleanupErrors.push(cleanupError);
      });
    }

    if (installedPlan) {
      await unlink(planPath).catch((cleanupError) => {
        cleanupErrors.push(cleanupError);
      });
    }

    if (installedAssets) {
      await rm(assetsPath, { recursive: true, force: true }).catch(
        (cleanupError) => {
          cleanupErrors.push(cleanupError);
        },
      );
    }

    // A versioned runtime is shared by every migration of the same format.
    // Once exposed, never remove it during rollback: a concurrent generator
    // may already have reused the byte-identical file.
    if (cleanupErrors.length > 0) {
      throw Object.assign(
        new Error(
          'Content migration generation failed and local artifact cleanup was incomplete.',
        ),
        { cause: error, cleanupErrors },
      );
    }

    throw error;
  } finally {
    // Staging directories are never referenced by installed artifacts. A
    // transient cleanup failure (for example, a Windows antivirus file lock)
    // must not turn an otherwise successful atomic install into a reported
    // generation failure or mask the original error. Their owner markers let
    // a later generation reclaim anything left behind.
    const stagingDirectories = [
      stagingDirectory,
      ...(await Promise.all(
        [...installer.stageDirectories.values()].map((directory) =>
          directory.catch(() => null),
        ),
      )),
    ].filter((directory): directory is string => directory !== null);
    await Promise.all(
      stagingDirectories.map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  }
}

export function buildEnvelope(plan: ContentDiffPlan): ContentPlanEnvelope {
  return {
    formatVersion: CONTENT_DIFF_MANIFEST_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    integrity: {
      algorithm: 'sha256',
      planSha256: sha256(stableStringify(plan as unknown as JsonValue)),
    },
    plan,
  };
}

// Generation rejects exactly what execution rejects: the runtime runs these
// same shared checks before touching the destination project.
function assertEnvelope(envelope: unknown): void {
  validateContentDiffPlan(assertContentDiffEnvelope(envelope));
}

async function bundleChangedAssets({
  plan,
  assetsDirectory,
  assetsBasename,
  fetchFn,
  assetDownloadTimeouts,
}: {
  plan: ContentDiffPlan;
  assetsDirectory: string;
  assetsBasename: string;
  fetchFn: typeof fetch;
  assetDownloadTimeouts?: AssetDownloadTimeouts;
}): Promise<void> {
  const uploads = plan.uploads.filter(
    (upload) =>
      upload.desired &&
      upload.action !== 'delete' &&
      (upload.action === 'create' || upload.changes.binary),
  );

  await mkdir(assetsDirectory, { recursive: false });

  await mapWithConcurrency(uploads, 2, async (upload) => {
    const desired = upload.desired as UploadSnapshot;
    const assetBasename = `${uploadStagingFilename(upload.id)}.bin`;
    const stagedPath = join(assetsDirectory, assetBasename);
    let hashes: Awaited<ReturnType<typeof downloadAsset>>;
    try {
      hashes = await downloadAsset(
        desired.transport.sourceUrl,
        stagedPath,
        fetchFn,
        assetDownloadTimeouts,
      );
    } catch (error) {
      throw withAssetDownloadTuningHint(error);
    }

    if (hashes.md5.toLowerCase() !== desired.md5.toLowerCase()) {
      throw new Error(
        `Upload "${upload.id}" changed while bundling: expected MD5 ${desired.md5}, received ${hashes.md5}`,
      );
    }

    // Manifest paths are portable across operating systems; the runtime
    // resolves the slash-separated path beneath the manifest directory.
    desired.transport.bundledPath = `${assetsBasename}/${assetBasename}`;
    desired.transport.sha256 = hashes.sha256;
  });
}

/**
 * Names the variable that raises a download deadline that expired, in the
 * same words the generated runtime uses for its own download timeouts.
 */
function withAssetDownloadTuningHint(error: unknown): unknown {
  if (
    !(error instanceof Error) ||
    (error as { code?: unknown }).code !== 'UPLOAD_DOWNLOAD_TIMEOUT'
  ) {
    return error;
  }

  const details = (error as { details?: unknown }).details;
  const phase = isObject(details) ? details.phase : undefined;
  const timeoutMilliseconds = isObject(details)
    ? details.timeoutMilliseconds
    : undefined;
  const { variable } = contentDiffTuningDefinition(
    phase === 'headers' ? 'assetHeadersTimeoutMs' : 'assetIdleTimeoutMs',
  );

  return new ContentDiffError(
    'UPLOAD_DOWNLOAD_TIMEOUT',
    `${error.message} Set ${variable} to wait longer.`,
    {
      ...(typeof phase === 'string' ? { phase } : {}),
      ...(typeof timeoutMilliseconds === 'number'
        ? { timeoutMilliseconds }
        : {}),
      variable,
    },
  );
}

interface ArtifactInstaller {
  readonly operations: ArtifactFileOperations;
  readonly migrationsDirectory: string;
  readonly stagingDirectory: string;
  /** Lazily created stage directories beside non-migration destinations. */
  readonly stageDirectories: Map<string, Promise<string>>;
  /** Durable same-directory copies, prepared once per destination path. */
  readonly candidates: Map<string, Promise<string>>;
}

/**
 * Exposes one fully written staged file under its final name without ever
 * replacing an existing file. A hard link does both atomically. Filesystems
 * without hard links get a durable same-directory copy that is renamed into
 * place, so the final name only ever shows complete bytes:
 *
 * - `reserve` (plan, runtime) first claims the name with an exclusive create
 *   and then renames the complete copy over that empty reservation, so the
 *   only file the rename can replace is this writer's own reservation. No
 *   discoverable migration references these names while they are reserved.
 * - `entrypoint` never exposes an empty reservation under a name that
 *   migrations:run discovers and could execute or record as run. The plan
 *   reservation already excludes every other content-diff writer for this
 *   migration name, and the absence check runs immediately before the
 *   rename. Node offers no no-replace rename, so an unrelated process that
 *   creates this exact timestamped name inside that window is the one race
 *   this fallback cannot exclude.
 */
async function installStagedFile(
  installer: ArtifactInstaller,
  stagedPath: string,
  destinationPath: string,
  mode: 'reserve' | 'entrypoint',
): Promise<void> {
  try {
    await installer.operations.link(stagedPath, destinationPath);
    return;
  } catch (error) {
    if (!isLinkUnsupportedError(error)) throw error;
  }

  const candidatePath = await prepareSameDirectoryCandidate(
    installer,
    stagedPath,
    destinationPath,
  );

  if (mode === 'entrypoint') {
    await refuseExistingEntry(destinationPath, 'migration');
    await installer.operations.rename(candidatePath, destinationPath);
    return;
  }

  const reservation = await open(destinationPath, 'wx');

  try {
    await reservation.close();
    await installer.operations.rename(candidatePath, destinationPath);
  } catch (error) {
    await removeEmptyReservation(destinationPath);
    throw error;
  }
}

async function installImmutableRuntime(
  installer: ArtifactInstaller,
  stagedPath: string,
  destinationPath: string,
  expectedContents: string,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await installStagedFile(
        installer,
        stagedPath,
        destinationPath,
        'reserve',
      );
      return;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    const existingContents = await readSettledRuntime(destinationPath);

    if (existingContents === null) {
      // A concurrent writer without hard links withdrew its empty
      // reservation after a failed rename. Claim the name again.
      if (attempt < RUNTIME_INSTALL_ATTEMPTS) continue;

      throw new Error(
        `Immutable runtime "${relative(
          process.cwd(),
          destinationPath,
        )}" repeatedly disappeared while another generation was installing it`,
      );
    }

    if (existingContents === '') {
      throw new Error(
        `Refusing to reuse incomplete immutable runtime "${relative(
          process.cwd(),
          destinationPath,
        )}": it is still empty. Another content-diff generation may be installing it, or an interrupted generation left an empty reservation behind. Once no generation is running, remove the empty file and retry.`,
      );
    }

    if (existingContents !== expectedContents) {
      throw new Error(
        `Refusing to overwrite mismatched immutable runtime "${relative(
          process.cwd(),
          destinationPath,
        )}"`,
      );
    }

    return;
  }
}

/**
 * Reads an existing runtime, waiting briefly while it is an empty reservation
 * of a concurrent writer without hard links. Returns null when it vanished.
 */
async function readSettledRuntime(path: string): Promise<string | null> {
  for (let poll = 1; ; poll += 1) {
    let contents: string;

    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }

    if (contents !== '' || poll >= RUNTIME_RESERVATION_POLL_ATTEMPTS) {
      return contents;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, RUNTIME_RESERVATION_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Installs a staged directory into a destination directory that this
 * generation creates exclusively. Nothing references the destination until
 * the plan is exposed, so files copied without hard links may appear
 * incrementally.
 */
async function installOwnedDirectory(
  installer: ArtifactInstaller,
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<void> {
  // List the stage first: a stage directory that vanished (for example, one
  // reclaimed by another generation) must not leave an empty destination.
  const sourceFiles = await readdir(sourceDirectory);
  await mkdir(destinationDirectory, { recursive: false });

  try {
    for (const sourceFile of sourceFiles) {
      const sourcePath = join(sourceDirectory, sourceFile);
      const destinationPath = join(destinationDirectory, sourceFile);

      try {
        await installer.operations.link(sourcePath, destinationPath);
        continue;
      } catch (error) {
        if (!isLinkUnsupportedError(error)) throw error;
      }

      await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      await syncFile(destinationPath);
    }
  } catch (error) {
    await rm(destinationDirectory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Returns a durable, complete copy of a staged file in a stage directory
 * beside its destination, so the final rename never crosses a filesystem.
 */
function prepareSameDirectoryCandidate(
  installer: ArtifactInstaller,
  stagedPath: string,
  destinationPath: string,
): Promise<string> {
  let candidate = installer.candidates.get(destinationPath);

  if (!candidate) {
    candidate = (async () => {
      const stageDirectory = await sameDirectoryStage(
        installer,
        dirname(destinationPath),
      );
      let candidatePath = stagedPath;

      if (dirname(stagedPath) !== stageDirectory) {
        candidatePath = join(stageDirectory, basename(destinationPath));
        await copyFile(stagedPath, candidatePath, constants.COPYFILE_EXCL);
      }

      await syncFile(candidatePath);
      return candidatePath;
    })();
    installer.candidates.set(destinationPath, candidate);
  }

  return candidate;
}

function sameDirectoryStage(
  installer: ArtifactInstaller,
  directory: string,
): Promise<string> {
  if (directory === installer.migrationsDirectory) {
    return Promise.resolve(installer.stagingDirectory);
  }

  let stageDirectory = installer.stageDirectories.get(directory);

  if (!stageDirectory) {
    stageDirectory = createStageDirectory(directory);
    installer.stageDirectories.set(directory, stageDirectory);
  }

  return stageDirectory;
}

async function syncFile(path: string): Promise<void> {
  // Windows can only flush handles opened for writing.
  const handle = await open(path, 'r+');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeEmptyReservation(path: string): Promise<void> {
  try {
    const entry = await lstat(path);

    // Staged artifacts are never empty, so an empty file is still this
    // writer's reservation rather than an installed plan or runtime.
    if (entry.isFile() && entry.size === 0) {
      await unlink(path);
    }
  } catch {
    // Preserve the original failure; a leftover empty reservation fails
    // closed for later writers.
  }
}

async function refuseExistingEntry(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  throw Object.assign(
    new Error(
      `Refusing to overwrite existing ${label} "${relative(
        process.cwd(),
        path,
      )}"`,
    ),
    { code: 'EEXIST', path },
  );
}

interface StageDirectoryOwner {
  pid: number;
  hostname: string;
  createdAtMs: number;
}

async function createStageDirectory(parentDirectory: string): Promise<string> {
  const directory = await mkdtemp(
    join(parentDirectory, STAGE_DIRECTORY_PREFIX),
  );

  try {
    await writeFile(
      join(directory, STAGE_OWNER_MARKER),
      `${JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }

  return directory;
}

/**
 * Best-effort removal of stage directories left by killed generations. A
 * directory is abandoned only when its owner is provably gone: on this host,
 * its process no longer exists (a live PID is never reclaimed, whatever its
 * age); from another host, or without a readable owner marker, it is older
 * than 24 hours.
 */
async function removeAbandonedStageDirectories(
  directory: string,
): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(STAGE_DIRECTORY_PREFIX),
      )
      .map(async (entry) => {
        const path = join(directory, entry.name);

        try {
          if (await isAbandonedStageDirectory(path, now)) {
            await rm(path, { recursive: true, force: true });
          }
        } catch {
          // Another generation may be reclaiming or using it concurrently.
        }
      }),
  );
}

async function isAbandonedStageDirectory(
  path: string,
  now: number,
): Promise<boolean> {
  const owner = await readStageDirectoryOwner(path);

  if (owner && owner.hostname === hostname()) {
    return !isProcessAlive(owner.pid);
  }

  const createdAtMs = owner ? owner.createdAtMs : (await stat(path)).mtimeMs;
  return now - createdAtMs > ABANDONED_STAGE_DIRECTORY_AGE_MS;
}

async function readStageDirectoryOwner(
  directory: string,
): Promise<StageDirectoryOwner | null> {
  let marker: unknown;

  try {
    marker = JSON.parse(
      await readFile(join(directory, STAGE_OWNER_MARKER), 'utf8'),
    );
  } catch {
    return null;
  }

  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return null;
  }

  const {
    pid,
    hostname: ownerHostname,
    createdAt,
  } = marker as Record<string, unknown>;
  const createdAtMs =
    typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;

  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof ownerHostname !== 'string' ||
    ownerHostname === '' ||
    !Number.isFinite(createdAtMs)
  ) {
    return null;
  }

  return { pid, hostname: ownerHostname, createdAtMs };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user. Anything other
    // than a definite ESRCH cannot prove the owner is gone.
    return errorCode(error) !== 'ESRCH';
  }
}

async function refuseExisting(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return;
  }

  throw new Error(
    `Refusing to overwrite existing ${label} "${relative(
      process.cwd(),
      path,
    )}"`,
  );
}

function clonePlan(plan: ContentDiffPlan): ContentDiffPlan {
  return JSON.parse(JSON.stringify(plan)) as ContentDiffPlan;
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isLinkUnsupportedError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && LINK_UNSUPPORTED_ERROR_CODES.has(code);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
