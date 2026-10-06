import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { assertNotAborted } from './cancellation';
import { captureSnapshot, readRecordBatch } from './capture';
import { hashJson, recordHash } from './codec';
import { ContentError, type ContentFailureContext } from './errors';
import {
  type BaselineManifest,
  compareBaseline,
  loadBaseline,
} from './migration-artifact';
import { projectMigrationSchema } from './migration-schema';
import {
  assertDirectApplyAccess,
  assertSchemaEditAccess,
  fetchSchema,
  schemaHash,
} from './schema';
import { SnapshotStore } from './store';
import type {
  Client,
  DirectApplyOptions,
  DirectApplyOutcome,
  RecordGuard,
  RepairOptions,
  RepairResult,
  SchemaState,
  TemporarySchemaChange,
} from './types';

type Definition = ((client: Client, signal?: AbortSignal) => Promise<void>) & {
  options: { baseline: string };
};
interface Arguments {
  rootClient: Client;
  buildEnvironmentClient: (environmentId: string) => Client;
  scriptPath: string;
  definition: Definition;
}
const equal = (left: unknown, right: unknown) =>
  hashJson(left) === hashJson(right);
const changes = (baseline: BaselineManifest): TemporarySchemaChange[] =>
  baseline.temporarySchemaChanges;

export function validateForkName(
  options: Pick<DirectApplyOptions, 'forkName' | 'inPlace'>,
): void {
  if (options.forkName === undefined) return;
  if (options.inPlace)
    throw new ContentError(
      'INVALID_FORK_NAME',
      '--fork-name cannot be used with --in-place.',
    );
  if (!options.forkName || /[^a-z0-9-]/.test(options.forkName))
    throw new ContentError(
      'INVALID_FORK_NAME',
      'Fork names must contain only lowercase letters, numbers, and dashes, and cannot be empty.',
    );
}
async function findMaybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CmaClient.ApiError && error.response.status === 404)
      return null;
    throw error;
  }
}
function available(
  environment: Awaited<ReturnType<Client['environments']['find']>>,
): void {
  if (environment.meta.read_only_mode || environment.meta.status !== 'ready')
    throw new ContentError(
      'DESTINATION_UNAVAILABLE',
      'Destination environment is not writable and ready.',
    );
}
interface WorkingEnvironment {
  id: string;
  createdAt: string | undefined;
  forkedFrom: string | null | undefined;
  allowPrimary: boolean;
}
async function assertWorkingEnvironment(
  root: Client,
  expected: WorkingEnvironment,
): Promise<void> {
  const current = await root.environments.find(expected.id);
  available(current);
  if (
    current.id !== expected.id ||
    current.meta.created_at !== expected.createdAt ||
    current.meta.forked_from !== expected.forkedFrom
  )
    throw new ContentError(
      'ENVIRONMENT_CHANGED',
      `Environment "${expected.id}" was replaced or its ownership metadata changed; no writes are permitted.`,
    );
  if (current.meta.primary && !expected.allowPrimary)
    throw new ContentError(
      'PRIMARY_REQUIRES_APPROVAL',
      `Environment "${expected.id}" is now primary; no writes are permitted without explicit primary authorization.`,
    );
}
function assertScheduleWindow(store: SnapshotStore, minutes: number): void {
  if (minutes === 0) return;
  const deadline = Date.now() + minutes * 60_000;
  for (const row of store.database
    .prepare(`SELECT id,at FROM (
    SELECT id,json_extract(state_json,'$.schedules.publication.at') AS at FROM records WHERE side='target'
    UNION ALL SELECT id,json_extract(state_json,'$.schedules.unpublishing.at') FROM records WHERE side='target'
  ) WHERE at IS NOT NULL ORDER BY id`)
    .iterate()) {
    if (
      Number.isFinite(Date.parse(String(row.at))) &&
      Date.parse(String(row.at)) > deadline
    )
      continue;
    throw new ContentError(
      'SCHEDULE_DUE_DURING_APPLY',
      `Record ${row.id} has a schedule at ${row.at}, within the ${minutes}-minute schedule window. Apply after it has run, or lower --schedule-window.`,
      { recordId: String(row.id), at: String(row.at), windowMinutes: minutes },
    );
  }
}
async function waitForFork(
  client: Client,
  id: string,
  signal?: AbortSignal,
  log?: (message: string) => void,
) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  for (let wait = 1000; ; wait = Math.min(wait * 2, 10_000)) {
    assertNotAborted(signal);
    const environment = await findMaybe(() => client.environments.find(id));
    if (!environment)
      throw new ContentError(
        'FORK_FAILED',
        `DatoCMS removed failed fork "${id}".`,
      );
    if (environment.meta.status === 'ready') return environment;
    if (environment.meta.status !== 'creating')
      throw new ContentError(
        'FORK_VERIFY_FAILED',
        `Fork "${id}" ended in status ${environment.meta.status}.`,
      );
    if (Date.now() >= deadline)
      throw new ContentError(
        'FORK_TIMEOUT',
        `Fork "${id}" was still being created after 120 minutes.`,
      );
    log?.(
      `Waiting for fork "${id}" (${
        environment.meta.fork_completion_percentage ?? 0
      }%).`,
    );
    try {
      await delay(wait, undefined, signal ? { signal } : undefined);
    } finally {
      assertNotAborted(signal);
    }
  }
}
function projection(baseline: BaselineManifest) {
  return (schema: SchemaState) =>
    projectMigrationSchema(schema, baseline.destinationTracking);
}
async function assertBaseline(
  client: Client,
  environmentId: string,
  baseline: BaselineManifest,
  store: SnapshotStore,
  options: DirectApplyOptions,
): Promise<SchemaState> {
  const schema = await fetchSchema(client, environmentId, projection(baseline));
  if (
    schema.siteId !== baseline.destination.siteId ||
    schema.hash !== baseline.schema.hash
  )
    throw new ContentError(
      'DESTINATION_MISMATCH',
      'Destination project or schema differs from the migration baseline.',
    );
  store.clearSide('target');
  options.log?.(`Checking original migration baseline in "${environmentId}".`);
  // DatoCMS has no persistent sandbox freeze; maintenance mode only protects
  // primary. These checks reject observed drift before the script starts.
  await captureSnapshot({
    client,
    environmentId,
    schema,
    store,
    side: 'target',
    options: {
      modelIds: schema.models
        .filter((model) => !model.block)
        .map((model) => model.id),
      uploads: 'all',
      concurrency: options.concurrency ?? 8,
      signal: options.signal,
      progress: options.log,
      schemaProjection: projection(baseline),
    },
    verify: options.verification === 'full' ? true : 'versions',
  });
  compareBaseline(store, 'target');
  assertScheduleWindow(store, options.scheduleWindowMinutes ?? 120);
  return schema;
}
async function assertDeclaredAccess(
  client: Client,
  schema: SchemaState,
  baseline: BaselineManifest,
  inPlace: boolean,
): Promise<void> {
  const mutates = (kind: 'upload' | 'collection') =>
    (['create', 'update', 'delete'] as const).some(
      (action) => baseline.counts[kind][action] > 0,
    );
  await assertDirectApplyAccess(client, schema, {
    modelIds: baseline.options.modelIds,
    uploads: mutates('upload'),
    collections: mutates('collection'),
    inPlace,
  });
  if (changes(baseline).length) await assertSchemaEditAccess(client);
}

/** Restore only generated temporary values, never somebody else's field edits. */
async function restoreFields(
  client: Client,
  baseline: BaselineManifest,
  problem: (message: string) => void,
  log?: (message: string) => void,
  signal?: AbortSignal,
  beforeWrite?: () => Promise<void>,
): Promise<number> {
  let restored = 0;
  for (const change of changes(baseline)) {
    assertNotAborted(signal);
    try {
      const live = await client.fields.find(change.fieldId);
      const settings = {
        validators: live.validators,
        defaultValue: live.default_value,
      };
      if (equal(settings, change.original)) continue;
      if (!equal(settings, change.temporary)) {
        problem(
          `Field ${change.fieldId}: settings differ from the original and generated temporary values; left unchanged.`,
        );
        continue;
      }
      await beforeWrite?.();
      log?.(`Restoring field ${change.fieldId} settings.`);
      await client.fields.update(change.fieldId, {
        validators: change.original.validators,
        default_value: change.original.defaultValue,
      } as Parameters<Client['fields']['update']>[1]);
      const after = await client.fields.find(change.fieldId);
      if (
        !equal(
          { validators: after.validators, defaultValue: after.default_value },
          change.original,
        )
      ) {
        problem(
          `Field ${change.fieldId}: original settings could not be verified after restoration.`,
        );
        continue;
      }
      restored++;
    } catch (error) {
      assertNotAborted(signal);
      problem(`Field ${change.fieldId}: ${String(error)}`);
    }
  }
  return restored;
}

export function directApply(
  args: Arguments & { options: DirectApplyOptions },
): Promise<DirectApplyOutcome> {
  return execute(args);
}

/** Read-only preflight takes no executable module or callback. */
export function directPreflight(
  args: Omit<Arguments, 'definition'> & { options: DirectApplyOptions },
): Promise<DirectApplyOutcome> {
  return execute({
    ...args,
    options: { ...args.options, preflightOnly: true },
  });
}

async function execute(
  args: Omit<Arguments, 'definition'> & {
    definition?: Definition;
    options: DirectApplyOptions;
  },
): Promise<DirectApplyOutcome> {
  const { options } = args;
  validateForkName(options);
  if (
    !Number.isSafeInteger(options.concurrency ?? 8) ||
    (options.concurrency ?? 8) < 1 ||
    (options.concurrency ?? 8) > 16
  )
    throw new ContentError(
      'INVALID_CONCURRENCY',
      'Concurrency must be an integer from 1 to 16.',
    );
  if (
    !Number.isSafeInteger(options.scheduleWindowMinutes ?? 120) ||
    (options.scheduleWindowMinutes ?? 120) < 0
  )
    throw new ContentError(
      'INVALID_SCHEDULE_WINDOW',
      'Schedule window must be a nonnegative whole number of minutes.',
    );
  const store = new SnapshotStore();
  let baseline: BaselineManifest | undefined;
  let executionClient: Client | undefined;
  let executionStarted = false;
  let forkId: string | undefined;
  let forkRequested = false;
  let forkCreatedAt: string | undefined;
  let destinationId: string | undefined;
  let working: WorkingEnvironment | undefined;
  const beforeWrite = async () => {
    if (!working)
      throw new ContentError(
        'ENVIRONMENT_CHANGED',
        'No bound environment is available for cleanup.',
      );
    await assertWorkingEnvironment(args.rootClient, working);
  };
  try {
    assertNotAborted(options.signal);
    options.log?.('Validating migration baseline and asset checksums.');
    baseline = await loadBaseline(
      resolve(
        dirname(resolve(args.scriptPath)),
        args.definition?.options.baseline ??
          `${basename(args.scriptPath, '.ts')}.content`,
      ),
      store,
      options.signal,
    );
    destinationId =
      options.destinationEnvironmentId ?? baseline.destination.environmentId;
    const client = args.buildEnvironmentClient(destinationId);
    const [rootSite, environment] = await Promise.all([
      args.rootClient.site.find(),
      args.rootClient.environments.find(destinationId),
    ]);
    if (rootSite.id !== baseline.destination.siteId)
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Destination project does not match the migration.',
      );
    available(environment);
    working = {
      id: destinationId,
      createdAt: environment.meta.created_at,
      forkedFrom: environment.meta.forked_from,
      allowPrimary: !options.inPlace || options.allowPrimary,
    };
    if (options.inPlace && environment.meta.primary && !options.allowPrimary)
      throw new ContentError(
        'PRIMARY_REQUIRES_APPROVAL',
        'Applying in place to primary requires --allow-primary.',
      );
    if (changes(baseline).length && !options.allowTemporarySchemaChanges)
      throw new ContentError(
        'TEMPORARY_SCHEMA_CHANGES_REQUIRED',
        'This migration requires --allow-temporary-schema-changes.',
      );
    if (!options.inPlace) {
      forkId = options.forkName ?? `content-apply-${randomUUID()}`;
      if (await findMaybe(() => args.rootClient.environments.find(forkId!)))
        throw new ContentError(
          'FORK_ID_COLLISION',
          `Environment "${forkId}" already exists. Choose another --fork-name.`,
        );
    }
    const schema = await assertBaseline(
      client,
      destinationId,
      baseline,
      store,
      options,
    );
    await assertDeclaredAccess(client, schema, baseline, options.inPlace);
    await beforeWrite();
    const partial = Object.values(baseline.counts).some(
      (counts) => counts.skip > 0,
    );
    assertNotAborted(options.signal);
    if (options.preflightOnly)
      return {
        environmentId: destinationId,
        preflightOnly: true,
        scriptExecuted: false,
        partial,
        generatedCounts: baseline.counts,
      };
    let environmentId = destinationId;
    executionClient = client;
    if (forkId) {
      options.log?.(`Creating destination fork "${forkId}".`);
      forkRequested = true;
      const requested = await args.rootClient.environments.fork(
        destinationId,
        { id: forkId },
        { immediate_return: true, ...(options.fastFork ? { fast: true } : {}) },
      );
      if (
        requested.id !== forkId ||
        typeof requested.meta.created_at !== 'string' ||
        !Number.isFinite(Date.parse(requested.meta.created_at))
      )
        throw new ContentError(
          'FORK_VERIFY_FAILED',
          'DatoCMS did not confirm the requested fork identity and creation time.',
        );
      forkCreatedAt = requested.meta.created_at;
      const fork = await waitForFork(
        args.rootClient,
        forkId,
        options.signal,
        options.log,
      );
      available(fork);
      if (
        fork.meta.primary ||
        fork.meta.forked_from !== destinationId ||
        fork.meta.created_at !== forkCreatedAt
      )
        throw new ContentError(
          'FORK_VERIFY_FAILED',
          'The owned fork is not a regular writable fork.',
        );
      environmentId = forkId;
      working = {
        id: forkId,
        createdAt: forkCreatedAt,
        forkedFrom: destinationId,
        allowPrimary: false,
      };
      executionClient = args.buildEnvironmentClient(environmentId);
      const forkSchema = await assertBaseline(
        executionClient,
        environmentId,
        baseline,
        store,
        options,
      );
      await assertDeclaredAccess(executionClient, forkSchema, baseline, true);
    }
    await beforeWrite();
    assertNotAborted(options.signal);
    options.log?.(
      `Executing TypeScript against the CMA in "${environmentId}".`,
    );
    if (!args.definition)
      throw new ContentError(
        'INVALID_CONTENT_MIGRATION',
        'Execution requires a loaded migration callback.',
      );
    executionStarted = true;
    await args.definition(executionClient, options.signal);
    assertNotAborted(options.signal);
    const problems: string[] = [];
    await restoreFields(
      executionClient,
      baseline,
      (message) => problems.push(message),
      options.log,
      undefined,
      beforeWrite,
    );
    if (problems.length)
      throw new ContentError('RESTORATION_INCOMPLETE', problems.join('; '), {
        problems,
      });
    return { environmentId, scriptExecuted: true, partial };
  } catch (error) {
    const problems: string[] = [];
    let problemCount = 0;
    const problem = (message: string) => {
      problemCount++;
      if (problems.length < 20) problems.push(message);
    };
    if (executionStarted && executionClient && baseline) {
      try {
        await beforeWrite();
        await restoreFields(
          executionClient,
          baseline,
          problem,
          options.log,
          undefined,
          beforeWrite,
        );
      } catch (cleanup) {
        problem(`Restoration was not authorized: ${String(cleanup)}`);
      }
      if (options.inPlace || options.keepFailedFork) {
        try {
          await beforeWrite();
          const environmentId = forkCreatedAt ? forkId! : destinationId!;
          const schema = await fetchSchema(
            executionClient,
            environmentId,
            projection(baseline),
          );
          if (schema.hash === baseline.schema.hash)
            await restoreOriginalSchedules(
              executionClient,
              schema,
              store,
              problem,
              options.log,
              undefined,
              beforeWrite,
            );
        } catch (cleanup) {
          problem(`Original schedule restoration: ${String(cleanup)}`);
        }
      }
    }
    if (forkRequested && forkId && forkCreatedAt && !options.keepFailedFork) {
      try {
        const fork = await findMaybe(() =>
          args.rootClient.environments.find(forkId!),
        );
        if (fork) {
          if (
            fork.meta.primary ||
            fork.meta.created_at !== forkCreatedAt ||
            fork.meta.forked_from !== destinationId
          )
            throw new Error(
              'Fork ownership could not be proven; environment retained.',
            );
          options.log?.(`Removing failed fork "${forkId}".`);
          await args.rootClient.environments.destroy(forkId);
          if (await findMaybe(() => args.rootClient.environments.find(forkId!)))
            throw new Error('Failed fork still exists after deletion.');
        }
      } catch (cleanup) {
        problem(`Failed fork ${forkId}: ${String(cleanup)}`);
      }
    }
    let failure = error;
    if (problemCount) {
      failure = new ContentError(
        'APPLY_FAILED_REPAIR_INCOMPLETE',
        `${
          error instanceof Error ? error.message : String(error)
        } Cleanup problems: ${problems.join('; ')}`,
        { problemCount, problems },
      );
      if (error instanceof Error) {
        const exit = error as Error & {
          exitCode?: number;
          oclif?: { exit?: number };
        };
        Object.assign(failure as ContentError, {
          exitCode: exit.exitCode,
          oclif: exit.oclif,
        });
      }
    }
    if (failure instanceof Error) {
      const context: ContentFailureContext = {};
      if (forkRequested && !forkCreatedAt)
        context.unconfirmedForkEnvironmentId = forkId;
      if (forkCreatedAt && options.keepFailedFork)
        context.keptForkEnvironmentId = forkId;
      Object.assign(failure, context);
    }
    throw failure;
  } finally {
    store.dispose();
  }
}

function assertRepairSchema(
  current: SchemaState,
  baseline: BaselineManifest,
): void {
  const original = new Map(
    baseline.schema.models.flatMap((model) =>
      model.fields.map((field) => [field.id, field] as const),
    ),
  );
  const permitted = new Set(changes(baseline).map((change) => change.fieldId));
  const normalized = {
    ...current,
    models: current.models.map((model) => ({
      ...model,
      fields: model.fields.map((field) => {
        const before = original.get(field.id);
        return before && permitted.has(field.id)
          ? {
              ...field,
              validators: before.validators,
              defaultValue: before.defaultValue,
            }
          : field;
      }),
    })),
  };
  if (
    current.siteId !== baseline.destination.siteId ||
    schemaHash(normalized) !== baseline.schema.hash
  )
    throw new ContentError(
      'REPAIR_SCHEMA_CONFLICT',
      'Repair requires the original schema except for declared temporary field settings.',
    );
}
async function restoreOriginalSchedules(
  client: Client,
  schema: SchemaState,
  store: SnapshotStore,
  problem: (message: string) => void,
  log?: (message: string) => void,
  signal?: AbortSignal,
  beforeWrite?: () => Promise<void>,
): Promise<number> {
  let restored = 0;
  const rows = store.database.prepare(
    "SELECT id,guard_json FROM migration_baseline WHERE kind='record' AND (json_extract(guard_json,'$.schedules.publication') IS NOT NULL OR json_extract(guard_json,'$.schedules.unpublishing') IS NOT NULL) ORDER BY id",
  );
  for (const row of rows.iterate()) {
    assertNotAborted(signal);
    const id = String(row.id);
    const guard = JSON.parse(String(row.guard_json)) as RecordGuard;
    try {
      const [live] = await readRecordBatch(client, [id], schema);
      if (!live) {
        problem(
          `Record ${id}: no longer exists; original schedules were not restored.`,
        );
        continue;
      }
      if (equal(live.schedules, guard.schedules)) continue;
      if (
        recordHash({ ...live, schedules: guard.schedules }) !== guard.hash ||
        live.position !== guard.position
      ) {
        problem(
          `Record ${id}: content differs from the original baseline; schedules were left unchanged.`,
        );
        continue;
      }
      const keys = ['publication', 'unpublishing'] as const;
      if (
        keys.some(
          (key) =>
            live.schedules[key] &&
            !equal(live.schedules[key], guard.schedules[key]),
        )
      ) {
        problem(
          `Record ${id}: schedules were changed by another operation; left unchanged.`,
        );
        continue;
      }
      if (
        keys.some(
          (key) =>
            guard.schedules[key] &&
            Date.parse(guard.schedules[key]!.at) <= Date.now(),
        )
      ) {
        problem(
          `Record ${id}: an original schedule is no longer in the future; restore it manually.`,
        );
        continue;
      }
      let changed = false;
      for (const key of keys) {
        const wanted = guard.schedules[key];
        if (!wanted || live.schedules[key]) continue;
        assertNotAborted(signal);
        // Maintenance mode cannot freeze this sandbox. Recheck immediately
        // before restoring a missing schedule to avoid overwriting observed edits.
        const [fresh] = await readRecordBatch(client, [id], schema);
        if (
          !fresh ||
          recordHash({ ...fresh, schedules: guard.schedules }) !== guard.hash ||
          fresh.position !== guard.position ||
          fresh.schedules[key]
        ) {
          problem(
            `Record ${id}: changed while schedules were being restored; left unchanged.`,
          );
          break;
        }
        await beforeWrite?.();
        log?.(`Restoring original ${key} schedule of record ${id}.`);
        if (key === 'publication') {
          const publication = guard.schedules.publication!;
          await client.scheduledPublication.create(id, {
            publication_scheduled_at: publication.at,
            selective_publication: publication.selective
              ? {
                  content_in_locales: publication.selective.locales,
                  non_localized_content: publication.selective.nonLocalized,
                }
              : null,
          });
        } else {
          const unpublishing = guard.schedules.unpublishing!;
          await client.scheduledUnpublishing.create(id, {
            unpublishing_scheduled_at: unpublishing.at,
            content_in_locales: unpublishing.locales,
          });
        }
        changed = true;
      }
      if (changed) restored++;
    } catch (error) {
      assertNotAborted(signal);
      problem(`Record ${id}: ${String(error)}`);
    }
  }
  return restored;
}

/** Repair immutable original settings only; never evaluate the migration callback. */
export async function directRepair(
  args: Omit<Arguments, 'definition'> & { options: RepairOptions },
): Promise<RepairResult> {
  const store = new SnapshotStore();
  try {
    const { options } = args;
    assertNotAborted(options.signal);
    if (!args.scriptPath.endsWith('.ts'))
      throw new ContentError(
        'INVALID_MIGRATION_PATH',
        'Pass the generated .ts entrypoint path; repair reads its sibling .content directory without loading the script.',
      );
    const path = resolve(args.scriptPath);
    const directory = resolve(
      dirname(path),
      `${basename(path, '.ts')}.content`,
    );
    const baseline = await loadBaseline(directory, store, options.signal);
    const environmentId =
      options.destinationEnvironmentId ?? baseline.destination.environmentId;
    const client = args.buildEnvironmentClient(environmentId);
    const [rootSite, environment, schema] = await Promise.all([
      args.rootClient.site.find(),
      args.rootClient.environments.find(environmentId),
      fetchSchema(client, environmentId, projection(baseline)),
    ]);
    if (
      rootSite.id !== baseline.destination.siteId ||
      schema.siteId !== baseline.destination.siteId
    )
      throw new ContentError(
        'DESTINATION_MISMATCH',
        'Repair project differs from the migration baseline.',
      );
    available(environment);
    if (environment.meta.primary && !options.allowPrimary)
      throw new ContentError(
        'PRIMARY_REQUIRES_APPROVAL',
        'Repairing primary requires --allow-primary.',
      );
    const expected = {
      id: environmentId,
      createdAt: environment.meta.created_at,
      forkedFrom: environment.meta.forked_from,
      allowPrimary: options.allowPrimary,
    };
    const beforeWrite = () =>
      assertWorkingEnvironment(args.rootClient, expected);
    assertRepairSchema(schema, baseline);
    await assertDeclaredAccess(client, schema, baseline, true);
    const problems: string[] = [];
    let problemCount = 0;
    const problem = (message: string) => {
      problemCount++;
      if (problems.length < 20) problems.push(message);
    };
    const restoredFields = await restoreFields(
      client,
      baseline,
      problem,
      options.log,
      options.signal,
      beforeWrite,
    );
    const after = await fetchSchema(
      client,
      environmentId,
      projection(baseline),
    );
    let restoredSchedules = 0;
    if (after.hash === baseline.schema.hash)
      restoredSchedules = await restoreOriginalSchedules(
        client,
        after,
        store,
        problem,
        options.log,
        options.signal,
        beforeWrite,
      );
    else
      problem(
        'Schema still differs from the original; schedules were not restored.',
      );
    if (problemCount)
      throw new ContentError(
        'REPAIR_INCOMPLETE',
        `Restored ${restoredFields} field settings and ${restoredSchedules} schedules. ${problemCount} items need attention: ${problems.join(
          '; ',
        )}`,
        { problemCount, problems, restoredFields, restoredSchedules },
      );
    return { environmentId, restoredFields, restoredSchedules };
  } finally {
    store.dispose();
  }
}
