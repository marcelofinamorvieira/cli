import { createHash } from 'node:crypto';
import type { CmaClient } from '@datocms/cli-utils';
import { isCmaNotFoundError } from '../content-diff/shared/cma-errors';

/**
 * Destination-side run lock for migrations:run.
 *
 * The lock is one record with a fixed ID in the migrations tracking model. Its
 * only field is the stock `name` field, which holds a reserved prefix followed
 * by compact JSON metadata. Item IDs are primary keys, so creating the record
 * with an explicit ID succeeds for exactly one run. Stock and older plugin
 * runners never shadow a script with it (their history names must start with
 * a digit), but they also ignore it: the lock is advisory against them.
 */

/** Seed of MIGRATIONS_RUN_LOCK_RECORD_ID through deterministicPortableDatoId. */
export const MIGRATIONS_RUN_LOCK_SEED =
  'datocms-cli-plugin-content-diff:migrations-run-lock:v1';

/** Same ID in every environment and project, so forks copy it verbatim. */
export const MIGRATIONS_RUN_LOCK_RECORD_ID = 'pV2V96fXSDyPgWYeu6p3jw';

/** Never starts with a digit, so it cannot match a migration filename. */
export const MIGRATIONS_RUN_LOCK_NAME_PREFIX = 'datocms-migrations-run-lock ';

export const MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH = 255;

const HOST_MAX_LENGTH = 64;
const CI_MAX_LENGTH = 64;
const FIRST_MAX_LENGTH = 64;

export type MigrationsRunLockMetadata = {
  v: 1;
  /** Random 16-hex-character run ID; it is also the unlock token. */
  runId: string;
  environmentId: string;
  mode: 'in-place' | 'fork';
  sourceEnvironmentId?: string;
  host?: string;
  pid: number;
  ci?: string;
  startedAt: string;
  pending: number;
  first?: string;
  plugin?: string;
};

const METADATA_KEYS = [
  'v',
  'runId',
  'environmentId',
  'mode',
  'sourceEnvironmentId',
  'host',
  'pid',
  'ci',
  'startedAt',
  'pending',
  'first',
  'plugin',
] as const satisfies readonly (keyof MigrationsRunLockMetadata)[];

/** Optional fields dropped, in this order, until the name fits. */
const DROPPABLE_KEYS = [
  'first',
  'ci',
  'host',
  'plugin',
  'sourceEnvironmentId',
] as const satisfies readonly (keyof MigrationsRunLockMetadata)[];

export type MigrationsRunLockCreator = Readonly<{ type: string; id: string }>;

export type MigrationsRunLock = Readonly<{
  recordId: string;
  name: string;
  /** Null when the name is not a lock name this version can read. */
  meta: MigrationsRunLockMetadata | null;
  token: string;
  createdAt: string | null;
  creator: MigrationsRunLockCreator | null;
}>;

export type MigrationsRunLockHandle = Readonly<{
  environmentId: string;
  runId: string;
  token: string;
}>;

export type MigrationsRunLockErrorCode =
  | 'MIGRATIONS_RUN_LOCKED'
  | 'MIGRATIONS_RUN_LOCK_CONFLICT'
  | 'MIGRATIONS_RUN_LOCK_CREATE_FAILED'
  | 'MIGRATIONS_RUN_UNLOCK_TOKEN_MISMATCH';

export class MigrationsRunLockError extends Error {
  readonly code: MigrationsRunLockErrorCode;
  /** The lock that blocked the operation, when one was read. */
  readonly lock: MigrationsRunLock | null;

  constructor(
    code: MigrationsRunLockErrorCode,
    message: string,
    options: Readonly<{
      lock?: MigrationsRunLock | null;
      cause?: unknown;
    }> = {},
  ) {
    super(message);
    this.name = 'MigrationsRunLockError';
    this.code = code;
    this.lock = options.lock ?? null;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        configurable: true,
        writable: true,
      });
    }
  }
}

type LockClient = Pick<CmaClient.Client, 'items'>;
type TrackingModel = Pick<CmaClient.ApiTypes.ItemType, 'id' | 'api_key'>;

export function encodeMigrationsRunLockName(
  metadata: MigrationsRunLockMetadata,
): string {
  // Parsing rejects terminal control characters, so this run's own lock must
  // never carry one: a lock it could not read back would never be released.
  const bounded: MigrationsRunLockMetadata = {
    ...metadata,
    sourceEnvironmentId: printable(metadata.sourceEnvironmentId),
    host: truncate(printable(metadata.host), HOST_MAX_LENGTH),
    ci: truncate(printable(metadata.ci), CI_MAX_LENGTH),
    first: truncate(printable(metadata.first), FIRST_MAX_LENGTH),
    plugin: printable(metadata.plugin),
  };
  let name = renderLockName(bounded);
  for (const key of DROPPABLE_KEYS) {
    if (name.length <= MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH) break;
    delete bounded[key];
    name = renderLockName(bounded);
  }
  if (name.length > MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH) {
    throw new Error(
      `The migrations:run lock name for environment "${metadata.environmentId}" exceeds ${MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
}

function renderLockName(metadata: MigrationsRunLockMetadata): string {
  const ordered: Record<string, unknown> = {};
  for (const key of METADATA_KEYS) {
    if (metadata[key] !== undefined) ordered[key] = metadata[key];
  }
  // History names may contain "/" (legacyClient/ paths); the lock name never
  // does. A "/" can only occur inside a JSON string, where / is valid.
  return `${MIGRATIONS_RUN_LOCK_NAME_PREFIX}${JSON.stringify(ordered).replace(
    /\//gu,
    '\\u002f',
  )}`;
}

/**
 * True for characters that can change what a terminal shows when printed:
 * C0 and C1 controls (ESC starts CSI/OSC sequences, CR rewrites the line),
 * DEL, line and paragraph separators, and bidirectional formatting marks.
 */
export function isUnsafeTerminalCharacter(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function hasUnsafeTerminalCharacter(value: string): boolean {
  for (const character of value) {
    if (isUnsafeTerminalCharacter(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

function printable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let result = '';
  for (const character of value) {
    result += isUnsafeTerminalCharacter(character.codePointAt(0) ?? 0)
      ? '\uFFFD'
      : character;
  }
  return result;
}

function truncate(value: string | undefined, maxLength: number) {
  if (value === undefined || value.length === 0) return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Lock records are ordinary records that any editor of the tracking model can
 * write, and their metadata is printed to terminals. Names carrying terminal
 * control or bidirectional formatting characters are treated as unreadable:
 * they still block runs and get a stable unlock token, but none of their text
 * is ever printed.
 */
export function parseMigrationsRunLockName(
  name: unknown,
): { meta: MigrationsRunLockMetadata } | { unreadable: true } {
  const unreadable = { unreadable: true } as const;
  if (
    typeof name !== 'string' ||
    !name.startsWith(MIGRATIONS_RUN_LOCK_NAME_PREFIX)
  )
    return unreadable;

  let value: unknown;
  try {
    value = JSON.parse(name.slice(MIGRATIONS_RUN_LOCK_NAME_PREFIX.length));
  } catch {
    return unreadable;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return unreadable;

  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(METADATA_KEYS);
  const optionalStrings = [
    'sourceEnvironmentId',
    'host',
    'ci',
    'first',
    'plugin',
  ] as const;
  const valid =
    Object.keys(record).every((key) => allowed.has(key)) &&
    record.v === 1 &&
    typeof record.runId === 'string' &&
    /^[0-9a-f]{16}$/u.test(record.runId) &&
    typeof record.environmentId === 'string' &&
    record.environmentId.length > 0 &&
    (record.mode === 'in-place' || record.mode === 'fork') &&
    isNonNegativeInteger(record.pid) &&
    typeof record.startedAt === 'string' &&
    !Number.isNaN(Date.parse(record.startedAt)) &&
    isNonNegativeInteger(record.pending) &&
    optionalStrings.every(
      (key) => record[key] === undefined || typeof record[key] === 'string',
    ) &&
    Object.values(record).every(
      (field) =>
        typeof field !== 'string' || !hasUnsafeTerminalCharacter(field),
    );

  return valid ? { meta: record as MigrationsRunLockMetadata } : unreadable;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The token that --force-unlock must repeat. Unreadable lock names still get a
 * stable token, so clearing always compares a value that was shown to a user.
 */
export function migrationsRunLockUnlockToken(name: unknown): string {
  const parsed = parseMigrationsRunLockName(name);
  if ('meta' in parsed) return parsed.meta.runId;
  return createHash('sha256')
    .update(typeof name === 'string' ? name : JSON.stringify(name ?? null))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Reads the lock of one environment. Returns null when no lock record exists.
 * Throws MIGRATIONS_RUN_LOCK_CONFLICT when the reserved ID belongs to a record
 * outside the tracking model (including when there is no tracking model).
 */
export async function readMigrationsRunLock(
  client: LockClient,
  trackingModel: Pick<TrackingModel, 'id'> | null,
): Promise<MigrationsRunLock | null> {
  let item: CmaClient.ApiTypes.Item;
  try {
    item = await client.items.find(MIGRATIONS_RUN_LOCK_RECORD_ID);
  } catch (error) {
    if (isCmaNotFoundError(error)) return null;
    throw error;
  }

  if (!trackingModel || item.item_type?.id !== trackingModel.id) {
    throw new MigrationsRunLockError(
      'MIGRATIONS_RUN_LOCK_CONFLICT',
      `Record ID ${MIGRATIONS_RUN_LOCK_RECORD_ID}, reserved for the migrations:run lock, belongs to another model. No migration was executed.`,
    );
  }

  return lockFromItem(item);
}

function lockFromItem(item: CmaClient.ApiTypes.Item): MigrationsRunLock {
  const name = item.name;
  const parsed = parseMigrationsRunLockName(name);
  const creator = (item as { creator?: { type?: unknown; id?: unknown } })
    .creator;
  return {
    recordId: item.id,
    name: typeof name === 'string' ? name : JSON.stringify(name ?? null),
    meta: 'meta' in parsed ? parsed.meta : null,
    token: migrationsRunLockUnlockToken(name),
    createdAt:
      typeof item.meta?.created_at === 'string' ? item.meta.created_at : null,
    creator:
      creator &&
      typeof creator.type === 'string' &&
      typeof creator.id === 'string'
        ? { type: creator.type, id: creator.id }
        : null,
  };
}

/**
 * Creates the lock record. Any create failure is resolved by reading the
 * record back, so the outcome never depends on the CMA's duplicate-ID error
 * code: our own run ID means a retried create already succeeded.
 */
export async function acquireMigrationsRunLock(
  client: LockClient,
  trackingModel: TrackingModel,
  metadata: MigrationsRunLockMetadata,
): Promise<MigrationsRunLockHandle> {
  const name = encodeMigrationsRunLockName(metadata);
  const handle: MigrationsRunLockHandle = {
    environmentId: metadata.environmentId,
    runId: metadata.runId,
    token: metadata.runId,
  };

  let created: CmaClient.ApiTypes.Item;
  try {
    created = await client.items.create({
      id: MIGRATIONS_RUN_LOCK_RECORD_ID,
      item_type: { type: 'item_type', id: trackingModel.id },
      name,
    });
  } catch (createError) {
    let existing: MigrationsRunLock | null;
    try {
      existing = await readMigrationsRunLock(client, trackingModel);
    } catch (readError) {
      if (readError instanceof MigrationsRunLockError) throw readError;
      // The create may still have stored this run's lock (a timeout, for
      // example), so its token must be reported.
      throw new MigrationsRunLockError(
        'MIGRATIONS_RUN_LOCK_CREATE_FAILED',
        `Could not create the migrations:run lock record in model "${
          trackingModel.api_key
        }": ${errorMessage(
          createError,
        )}. Reading it back also failed: ${errorMessage(
          readError,
        )}. No migration was executed. The lock record may have been stored anyway; its unlock token is ${
          metadata.runId
        }.`,
        { cause: createError },
      );
    }
    if (!existing) {
      throw new MigrationsRunLockError(
        'MIGRATIONS_RUN_LOCK_CREATE_FAILED',
        `Could not create the migrations:run lock record in model "${
          trackingModel.api_key
        }": ${errorMessage(
          createError,
        )}. No migration was executed. Retry: another run may have released its lock at the same moment. If this keeps failing, the "name" field must accept arbitrary strings of up to ${MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH} characters.`,
        { cause: createError },
      );
    }
    if (existing.meta?.runId === metadata.runId) {
      if (existing.name === name) return handle;
      // This run's create was stored after all, but with a rewritten name.
      return removeRewrittenLock(client, trackingModel, existing.name);
    }
    throw new MigrationsRunLockError(
      'MIGRATIONS_RUN_LOCKED',
      `Environment "${
        metadata.environmentId
      }" is locked by another migrations:run (${describeMigrationsRunLock(
        existing,
        metadata.environmentId,
      )}).`,
      { lock: existing },
    );
  }

  if (created.name !== name) {
    return removeRewrittenLock(client, trackingModel, created.name);
  }

  return handle;
}

/**
 * A model hook or plugin rewrote the name: the record would not be
 * recognizable as this run's lock. Remove it before failing.
 */
async function removeRewrittenLock(
  client: LockClient,
  trackingModel: TrackingModel,
  storedName: unknown,
): Promise<never> {
  try {
    await client.items.destroy(MIGRATIONS_RUN_LOCK_RECORD_ID);
  } catch {
    // Reported through the unlock token below.
  }
  throw new MigrationsRunLockError(
    'MIGRATIONS_RUN_LOCK_CONFLICT',
    `The migrations:run lock record created in model "${
      trackingModel.api_key
    }" was stored with a different name than requested, so it cannot identify this run. No migration was executed. If a lock record remains, its unlock token is ${migrationsRunLockUnlockToken(
      storedName,
    )}.`,
  );
}

export type MigrationsRunLockReleaseOutcome =
  | Readonly<{ status: 'released' }>
  | Readonly<{ status: 'already-cleared' }>
  | Readonly<{ status: 'replaced'; current: MigrationsRunLock }>;

/**
 * Removes the lock only while it still carries this run's token. There is a
 * residual race after an explicit --force-unlock: another run could clear and
 * re-acquire the lock between this read and the destroy.
 */
export async function releaseMigrationsRunLock(
  client: LockClient,
  trackingModel: Pick<TrackingModel, 'id'>,
  handle: MigrationsRunLockHandle,
): Promise<MigrationsRunLockReleaseOutcome> {
  const current = await readMigrationsRunLock(client, trackingModel);
  if (!current) return { status: 'already-cleared' };
  if (current.token !== handle.token) return { status: 'replaced', current };

  try {
    await client.items.destroy(MIGRATIONS_RUN_LOCK_RECORD_ID);
  } catch (error) {
    if (isCmaNotFoundError(error)) return { status: 'already-cleared' };
    throw error;
  }
  return { status: 'released' };
}

/**
 * Clears a lock left by another run when the given token matches the lock
 * that was just read. The caller reads `lock` with readMigrationsRunLock, so a
 * reserved ID owned by another model has already been refused.
 */
export async function forceUnlockMigrationsRunLock(
  client: LockClient,
  environmentId: string,
  lock: MigrationsRunLock,
  token: string,
): Promise<void> {
  if (lock.token !== token) {
    throw new MigrationsRunLockError(
      'MIGRATIONS_RUN_UNLOCK_TOKEN_MISMATCH',
      `--force-unlock=${token} does not match the current run lock on "${environmentId}" (unlock token ${lock.token}). The lock may belong to a different run than the one you inspected. No lock was cleared.`,
      { lock },
    );
  }

  try {
    await client.items.destroy(MIGRATIONS_RUN_LOCK_RECORD_ID);
  } catch (error) {
    if (!isCmaNotFoundError(error)) throw error;
  }
}

/**
 * One human-readable line describing who holds a lock, for errors, warnings,
 * and the content:diff generation check.
 */
export function describeMigrationsRunLock(
  lock: MigrationsRunLock,
  currentEnvironmentId: string,
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  const meta = lock.meta;
  if (meta) {
    parts.push(
      `run ${lock.token}, started ${meta.startedAt}${formatAge(
        meta.startedAt,
        now,
      )}`,
    );
    if (meta.host) parts.push(`on host "${meta.host}"`);
    parts.push(`pid ${meta.pid}`);
    if (meta.ci) parts.push(meta.ci);
    parts.push(
      `${meta.pending} pending migration(s)${
        meta.first ? ` starting with "${meta.first}"` : ''
      }`,
    );
  } else {
    parts.push(
      `unreadable lock metadata, unlock token ${lock.token}${
        lock.createdAt
          ? `, created ${lock.createdAt}${formatAge(lock.createdAt, now)}`
          : ''
      }`,
    );
  }
  if (lock.creator) {
    parts.push(`created by ${lock.creator.type} ${lock.creator.id}`);
  }
  if (meta && meta.environmentId !== currentEnvironmentId) {
    parts.push(`copied from environment "${meta.environmentId}"`);
  }
  return parts.join(', ');
}

/** True when the lock was taken in another environment and then copied. */
export function migrationsRunLockWasCopied(
  lock: MigrationsRunLock,
  currentEnvironmentId: string,
): boolean {
  return lock.meta !== null && lock.meta.environmentId !== currentEnvironmentId;
}

function formatAge(iso: string, now: Date): string {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return '';
  const minutes = Math.floor((now.getTime() - started) / 60_000);
  if (minutes < 1) return ' (less than a minute ago)';
  if (minutes < 120) return ` (${minutes} min ago)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return ` (${hours} h ago)`;
  return ` (${Math.floor(hours / 24)} days ago)`;
}

export type MigrationsRunCommandOptions = Readonly<{
  environmentId: string;
  inPlace: boolean;
  primary: boolean;
  destinationEnvironmentId?: string;
  profile?: string;
  configFile?: string;
  migrationsDirectory?: string;
  migrationsModelApiKey?: string;
  migrationsTsconfig?: string;
}>;

/**
 * The migrations:run command that targets the same environment, project and
 * migration set as the run being described. A primary environment can only be
 * targeted in place with --allow-primary, which migrations:run requires before
 * it reads locks. A tracking model other than the default is named
 * explicitly, because the lock lives in that model. `profile`, `configFile`,
 * `migrationsDirectory` and `migrationsTsconfig` are added when the caller
 * selected them explicitly, so the command reaches the same project and runs
 * the same pending migrations with the same compilation settings. API tokens
 * are never included; callers tell the reader to add the one they passed.
 */
export function migrationsRunCommand(
  bin: string,
  options: MigrationsRunCommandOptions,
): string {
  const args = [
    `${bin} migrations:run`,
    `--source=${shellWord(options.environmentId)}`,
  ];
  if (options.inPlace) {
    args.push('--in-place');
    if (options.primary) args.push('--allow-primary');
  } else if (options.destinationEnvironmentId) {
    args.push(`--destination=${shellWord(options.destinationEnvironmentId)}`);
  }
  if (options.profile) {
    args.push(`--profile=${shellWord(options.profile)}`);
  }
  if (options.configFile) {
    args.push(`--config-file=${shellWord(options.configFile)}`);
  }
  if (options.migrationsDirectory) {
    args.push(`--migrations-dir=${shellWord(options.migrationsDirectory)}`);
  }
  if (options.migrationsModelApiKey) {
    args.push(`--migrations-model=${shellWord(options.migrationsModelApiKey)}`);
  }
  if (options.migrationsTsconfig) {
    args.push(`--migrations-tsconfig=${shellWord(options.migrationsTsconfig)}`);
  }
  return args.join(' ');
}

/**
 * The exact command that clears a stale lock and then continues with any
 * pending migrations (see migrationsRunCommand for the flags it repeats).
 * Pass `dryRun` for the command that previews those pending migrations
 * instead; it reports the lock without clearing it.
 */
export function migrationsRunLockClearCommand(
  bin: string,
  options: MigrationsRunCommandOptions &
    Readonly<{
      token: string;
      dryRun?: boolean;
    }>,
): string {
  return `${migrationsRunCommand(bin, options)} ${
    options.dryRun ? '--dry-run' : `--force-unlock=${shellWord(options.token)}`
  }`;
}

/** Quotes a value for a POSIX shell unless it only has safe characters. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Identifies the CI job holding a lock, without secrets. */
export function detectMigrationsRunCi(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let ci: string | undefined;
  if (
    environment.GITHUB_ACTIONS === 'true' &&
    environment.GITHUB_REPOSITORY &&
    environment.GITHUB_RUN_ID
  ) {
    ci = `github:${environment.GITHUB_REPOSITORY}#${environment.GITHUB_RUN_ID}`;
  } else if (environment.GITLAB_CI === 'true' && environment.CI_PIPELINE_ID) {
    ci = `gitlab:${environment.CI_PIPELINE_ID}`;
  } else if (environment.CI === 'true' || environment.CI === '1') {
    ci = 'ci';
  }
  return truncate(ci, CI_MAX_LENGTH);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
