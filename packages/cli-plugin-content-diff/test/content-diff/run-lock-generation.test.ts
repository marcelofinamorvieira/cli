import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import {
  ContentDiffError,
  type GenerateContentDiffMigrationInput,
  generateContentDiffMigration,
} from '../../src/content-diff';
import {
  MIGRATIONS_RUN_LOCK_RECORD_ID,
  type MigrationsRunLockMetadata,
  encodeMigrationsRunLockName,
} from '../../src/utils/migrations-run-lock';

const ARTICLE_MODEL_ID = 'article-model';
const TRACKING_MODEL_ID = 'tracking-model';

type SideOptions = {
  /** The environment has an exact schema_migration model (default true). */
  trackingModel?: boolean;
  /** Names of history records stored in the tracking model. */
  historyNames?: string[];
  /** Model of the record under the reserved lock ID, when one exists. */
  lockModelId?: string;
  /** Lock lookups that still report no lock before one appears. */
  lockAppearsAfterLookups?: number;
  /** Rejects every lock lookup. */
  lockLookupError?: unknown;
  /** Effective role of the credential; an account when omitted. */
  role?: Record<string, unknown>;
  /** API key of the tracking model (default schema_migration). */
  trackingModelApiKey?: string;
  /** Adds a field to Article, so the managed schemas differ. */
  extraArticleField?: boolean;
};

type FakeSide = {
  client: any;
  events: string[];
};

function lockMetadata(environmentId: string): MigrationsRunLockMetadata {
  return {
    v: 1,
    runId: 'feedfacefeedface',
    environmentId,
    mode: 'in-place',
    host: 'deploy-host',
    pid: 31337,
    startedAt: '2026-09-28T10:00:00.000Z',
    pending: 2,
    first: '1700000000_schema.js',
  };
}

function notFound(): CmaClient.ApiError {
  return new CmaClient.ApiError({
    request: { url: '/items/x', method: 'GET', headers: {} },
    response: { status: 404, statusText: 'Not Found', headers: {} },
  });
}

function fakeSide(
  siteId: string,
  environmentId: string,
  options: SideOptions = {},
): FakeSide {
  const events: string[] = [];
  const hasTrackingModel = options.trackingModel ?? true;
  let lockLookups = 0;
  const itemTypes = [
    {
      id: ARTICLE_MODEL_ID,
      name: 'Article',
      api_key: 'article',
      modular_block: false,
      singleton: false,
      sortable: false,
      tree: false,
      draft_mode_active: true,
      draft_saving_active: false,
      all_locales_required: false,
      workflow: null,
    },
    ...(hasTrackingModel
      ? [
          {
            id: TRACKING_MODEL_ID,
            name: 'Schema migration',
            api_key: options.trackingModelApiKey ?? 'schema_migration',
            modular_block: false,
            singleton: false,
            sortable: false,
            tree: false,
            draft_mode_active: false,
            draft_saving_active: false,
            all_locales_required: false,
            workflow: null,
          },
        ]
      : []),
  ];
  const fieldsByModel: Record<string, unknown[]> = {
    [ARTICLE_MODEL_ID]: [
      {
        id: 'title-field',
        api_key: 'title',
        field_type: 'string',
        localized: false,
        position: 1,
        default_value: null,
        validators: {},
      },
      ...(options.extraArticleField
        ? [
            {
              id: 'subtitle-field',
              api_key: 'subtitle',
              field_type: 'string',
              localized: false,
              position: 2,
              default_value: null,
              validators: {},
            },
          ]
        : []),
    ],
    [TRACKING_MODEL_ID]: [
      {
        id: 'migration-name-field',
        api_key: 'name',
        field_type: 'string',
        localized: false,
        position: 1,
        default_value: null,
        validators: { required: {} },
      },
    ],
  };
  const lockItem = () => ({
    id: MIGRATIONS_RUN_LOCK_RECORD_ID,
    item_type: {
      type: 'item_type',
      id: options.lockModelId ?? TRACKING_MODEL_ID,
    },
    name: encodeMigrationsRunLockName(lockMetadata(environmentId)),
    meta: { created_at: '2026-09-28T10:00:01.000Z' },
  });
  const client = {
    users: {
      findMe: async () => {
        events.push('permission-proof');
        return options.role
          ? { type: 'user', role: options.role }
          : { type: 'account' };
      },
    },
    site: {
      find: async () => ({
        id: siteId,
        locales: ['en'],
        timezone: 'UTC',
        meta: {
          improved_timezone_management: true,
          improved_boolean_fields: true,
          improved_validation_at_publishing: true,
          milliseconds_in_datetime: true,
          non_localized_focal_points: true,
          improved_hex_management: true,
        },
      }),
    },
    itemTypes: { list: async () => itemTypes },
    fields: { list: async (modelId: string) => fieldsByModel[modelId] ?? [] },
    workflows: { list: async () => [] },
    items: {
      async *listPagedIterator(params: { filter?: { type?: string } }) {
        const type = params?.filter?.type;
        events.push(`content-read ${type}`);
        if (type === TRACKING_MODEL_ID) {
          yield* (options.historyNames ?? []).map((name, index) => ({
            id: `history-record-${index}`,
            item_type: { type: 'item_type', id: TRACKING_MODEL_ID },
            name,
          }));
        }
      },
      find: async (id: string) => {
        if (id !== MIGRATIONS_RUN_LOCK_RECORD_ID) {
          events.push('collision-probe');
          throw notFound();
        }
        lockLookups += 1;
        events.push('lock-lookup');
        if (options.lockLookupError) throw options.lockLookupError;
        const present =
          options.lockModelId !== undefined ||
          (options.lockAppearsAfterLookups !== undefined &&
            lockLookups > options.lockAppearsAfterLookups);
        if (!present) throw notFound();
        return lockItem();
      },
    },
    uploads: {
      listPagedIterator: () => {
        events.push('content-read uploads');
        return (async function* () {})();
      },
    },
    uploadCollections: {
      list: async () => {
        events.push('content-read upload-collections');
        return [];
      },
    },
  };

  return { client, events };
}

function input(
  source: FakeSide,
  destination: FakeSide,
  migrationFilePath: string,
  migrationsModelApiKey?: string,
): GenerateContentDiffMigrationInput {
  return {
    source: {
      rootClient: source.client,
      environmentClient: source.client,
      environmentId: 'main',
      migrationsModelApiKey,
    },
    destination: {
      rootClient: destination.client,
      environmentClient: destination.client,
      environmentId: 'staging',
      migrationsModelApiKey,
    },
    migrationFilePath,
    format: 'js',
    options: {
      itemTypes: 'all',
      uploads: 'referenced',
      includeDeletions: true,
      bundleAssets: false,
      migrateInvalidContent: false,
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<ContentDiffError> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(ContentDiffError);
    return error as ContentDiffError;
  }
  throw new Error('Expected generation to fail');
}

describe('content diff generation run-lock check', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'datocms-content-run-lock-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses a destination being migrated before any content capture', async () => {
    const source = fakeSide('source-site', 'main');
    const destination = fakeSide('destination-site', 'staging', {
      lockModelId: TRACKING_MODEL_ID,
    });

    const error = await failure(
      generateContentDiffMigration(
        input(source, destination, join(directory, '1700000000_sync.js')),
      ),
    );

    expect(error.code).to.equal('MIGRATION_RUN_IN_PROGRESS');
    // The lock description includes the lock's age, which depends on the clock.
    expect(error.message).to.match(
      /^Destination environment "staging" is being migrated by migrations:run \(run feedfacefeedface, started 2026-09-28T10:00:00\.000Z( \([^)]*\))?, on host "deploy-host", pid 31337, 2 pending migration\(s\) starting with "1700000000_schema\.js"\)\. /,
    );
    expect(error.message).to.contain(
      '. A content diff generated now would compare a partially migrated state. No migration was generated. Wait for that run to finish, then retry. If that run is no longer active, "datocms migrations:run --source=staging --in-place --force-unlock=feedfacefeedface" clears the stale lock and then runs every pending migration in "staging"; review them first with "datocms migrations:run --source=staging --in-place --dry-run". Run both against the project that holds "staging" (add its --profile when needed), and add --allow-primary if it is the primary environment.',
    );
    const { lockDescription, ...details } = error.details ?? {};
    expect(details).to.deep.equal({
      side: 'destination',
      environmentId: 'staging',
      trackingModelApiKey: 'schema_migration',
      lockRecordId: MIGRATIONS_RUN_LOCK_RECORD_ID,
      unlockToken: 'feedfacefeedface',
    });
    expect(error.message).to.contain(`(${lockDescription}).`);
    expect(lockDescription).to.match(
      /^run feedfacefeedface, started 2026-09-28T10:00:00\.000Z/,
    );
    for (const side of [source, destination]) {
      expect(
        side.events.filter((event) => event.startsWith('content-read')),
      ).to.deep.equal([]);
      expect(side.events.indexOf('permission-proof')).to.be.lessThan(
        side.events.indexOf('lock-lookup'),
      );
    }
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('refuses a source being migrated before any content capture', async () => {
    const source = fakeSide('source-site', 'main', {
      lockModelId: TRACKING_MODEL_ID,
    });
    const destination = fakeSide('destination-site', 'staging');

    const error = await failure(
      generateContentDiffMigration(
        input(source, destination, join(directory, '1700000000_sync.js')),
      ),
    );

    expect(error.code).to.equal('MIGRATION_RUN_IN_PROGRESS');
    expect(error.message).to.match(
      /^Source environment "main" is being migrated by migrations:run \(run feedfacefeedface, /,
    );
    expect(error.message).to.contain(
      '--source=main --in-place --force-unlock=feedfacefeedface',
    );
    for (const side of [source, destination]) {
      expect(
        side.events.filter((event) => event.startsWith('content-read')),
      ).to.deep.equal([]);
    }
  });

  it('names a tracking model other than the default in both commands', async () => {
    const source = fakeSide('source-site', 'main', {
      trackingModelApiKey: 'deploy_history',
      lockModelId: TRACKING_MODEL_ID,
    });
    const destination = fakeSide('destination-site', 'staging', {
      trackingModelApiKey: 'deploy_history',
    });

    const error = await failure(
      generateContentDiffMigration(
        input(
          source,
          destination,
          join(directory, '1700000000_sync.js'),
          'deploy_history',
        ),
      ),
    );

    expect(error.code).to.equal('MIGRATION_RUN_IN_PROGRESS');
    expect(error.message).to.contain(
      '"datocms migrations:run --source=main --in-place --migrations-model=deploy_history --force-unlock=feedfacefeedface" clears the stale lock',
    );
    expect(error.message).to.contain(
      '"datocms migrations:run --source=main --in-place --migrations-model=deploy_history --dry-run"',
    );
    expect(error.details?.trackingModelApiKey).to.equal('deploy_history');
  });

  it('reports a held lock instead of the schema difference it explains', async () => {
    const source = fakeSide('source-site', 'main');
    const destination = fakeSide('destination-site', 'staging', {
      extraArticleField: true,
      lockModelId: TRACKING_MODEL_ID,
    });

    const error = await failure(
      generateContentDiffMigration(
        input(source, destination, join(directory, '1700000000_sync.js')),
      ),
    );

    expect(error.code).to.equal('MIGRATION_RUN_IN_PROGRESS');
    expect(error.details?.side).to.equal('destination');
    for (const side of [source, destination]) {
      expect(
        side.events.filter((event) => event.startsWith('content-read')),
      ).to.deep.equal([]);
    }
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('keeps the schema difference when no lock is held or the lookup fails', async () => {
    for (const options of [
      {},
      {
        lockLookupError: new CmaClient.ApiError({
          request: { url: '/items/x', method: 'GET', headers: {} },
          response: { status: 403, statusText: 'Forbidden', headers: {} },
        }),
      },
      { trackingModel: false },
    ]) {
      const destination = fakeSide('destination-site', 'staging', {
        ...options,
        extraArticleField: true,
      });

      const error = await failure(
        generateContentDiffMigration(
          input(
            fakeSide('source-site', 'main'),
            destination,
            join(directory, '1700000000_sync.js'),
          ),
        ),
      );

      expect(error.code).to.equal('SCHEMA_MISMATCH');
      expect(
        destination.events.filter((event) => event === 'lock-lookup'),
      ).to.have.length(options.trackingModel === false ? 0 : 1);
    }
  });

  it('refuses a lock that appears between capture and writing, and writes nothing', async () => {
    const source = fakeSide('source-site', 'main');
    const destination = fakeSide('destination-site', 'staging', {
      lockAppearsAfterLookups: 1,
    });

    const error = await failure(
      generateContentDiffMigration(
        input(source, destination, join(directory, '1700000000_sync.js')),
      ),
    );

    expect(error.code).to.equal('MIGRATION_RUN_IN_PROGRESS');
    expect(error.details?.side).to.equal('destination');
    const lookups = destination.events
      .map((event, index) => (event === 'lock-lookup' ? index : -1))
      .filter((index) => index >= 0);
    const contentReads = destination.events
      .map((event, index) => (event.startsWith('content-read') ? index : -1))
      .filter((index) => index >= 0);
    expect(lookups).to.have.length(2);
    expect(contentReads).not.to.have.length(0);
    expect(lookups[0]).to.be.lessThan(Math.min(...contentReads));
    expect(lookups[1]).to.be.greaterThan(Math.max(...contentReads));
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('keeps the plan independent of the tracking model and its history', async () => {
    const plans: string[] = [];

    for (const [index, options] of [
      {},
      { historyNames: ['1690000000_create_articles.js'] },
      { trackingModel: false },
    ].entries()) {
      const migrationFilePath = join(directory, `170000000${index}_sync.js`);
      const source = fakeSide('source-site', 'main', options);
      const destination = fakeSide('destination-site', 'staging', options);
      const result = await generateContentDiffMigration(
        input(source, destination, migrationFilePath),
      );
      for (const side of [source, destination]) {
        expect(side.events).not.to.include(`content-read ${TRACKING_MODEL_ID}`);
      }
      const manifest = JSON.parse(await readFile(result.planPath, 'utf8'));
      expect(JSON.stringify(manifest)).not.to.contain(
        MIGRATIONS_RUN_LOCK_RECORD_ID,
      );
      // Only the capture timestamps may differ between generations.
      plans.push(
        JSON.stringify(manifest.plan, (key, value) =>
          key === 'capturedAt' ? undefined : value,
        ),
      );
    }

    expect(plans[1]).to.equal(plans[0]);
    expect(plans[2]).to.equal(plans[0]);
  });

  it('makes no lock lookup when there is no tracking model', async () => {
    const source = fakeSide('source-site', 'main', { trackingModel: false });
    const destination = fakeSide('destination-site', 'staging', {
      trackingModel: false,
    });

    await generateContentDiffMigration(
      input(source, destination, join(directory, '1700000000_sync.js')),
    );

    for (const side of [source, destination]) {
      expect(side.events).not.to.include('lock-lookup');
    }
  });

  it('does not treat the reserved ID under another model as a lock', async () => {
    const source = fakeSide('source-site', 'main');
    const destination = fakeSide('destination-site', 'staging', {
      lockModelId: ARTICLE_MODEL_ID,
    });

    await generateContentDiffMigration(
      input(source, destination, join(directory, '1700000000_sync.js')),
    );

    expect(
      destination.events.filter((event) => event === 'lock-lookup'),
    ).to.have.length(2);
  });

  it('fails closed when the role cannot prove read access to the tracking model', async () => {
    const readArticles = {
      action: 'read',
      environment: 'staging',
      on_creator: 'anyone',
      item_type: ARTICLE_MODEL_ID,
    };
    const readUploads = {
      action: 'read',
      environment: 'staging',
      on_creator: 'anyone',
    };
    const role = (itemTypePermissions: unknown[]) => ({
      id: 'role',
      meta: {
        final_permissions: {
          positive_item_type_permissions: itemTypePermissions,
          negative_item_type_permissions: [],
          positive_upload_permissions: [readUploads],
          negative_upload_permissions: [],
        },
      },
    });
    const source = fakeSide('source-site', 'main');
    const destination = fakeSide('destination-site', 'staging', {
      role: role([readArticles]),
    });

    const error = await failure(
      generateContentDiffMigration(
        input(source, destination, join(directory, '1700000000_sync.js')),
      ),
    );

    expect(error.code).to.equal('UNPROVEN_FULL_ACCESS');
    expect(error.message).to.equal(
      'The current credential cannot prove read access to the migrations tracking model "schema_migration" in environment "staging". content:diff reads that model to prove that no migrations:run is in progress there. Grant the role unrestricted read access to that model, or use a full-access API token.',
    );
    expect(error.details).to.deep.equal({
      environmentId: 'staging',
      itemTypeId: TRACKING_MODEL_ID,
    });
    expect(destination.events).not.to.include('lock-lookup');

    // Read access to every model, the tracking model included, is enough.
    const permitted = fakeSide('destination-site', 'staging', {
      role: role([{ ...readArticles, item_type: undefined }]),
    });
    await generateContentDiffMigration(
      input(
        fakeSide('source-site', 'main'),
        permitted,
        join(directory, '1700000001_sync.js'),
      ),
    );
    expect(permitted.events).to.include('lock-lookup');
  });

  it('fails closed when the lock lookup is refused for permissions', async () => {
    const source = fakeSide('source-site', 'main');
    const destination = fakeSide('destination-site', 'staging', {
      lockLookupError: new CmaClient.ApiError({
        request: { url: '/items/x', method: 'GET', headers: {} },
        response: { status: 403, statusText: 'Forbidden', headers: {} },
      }),
    });

    const error = await failure(
      generateContentDiffMigration(
        input(source, destination, join(directory, '1700000000_sync.js')),
      ),
    );

    expect(error.code).to.equal('UNPROVEN_FULL_ACCESS');
    expect(error.message).to.contain(
      'content:diff reads that model to prove that no migrations:run is in progress there.',
    );
    expect(
      destination.events.filter((event) => event.startsWith('content-read')),
    ).to.deep.equal([]);
  });

  it('propagates other lock lookup failures', async () => {
    const lookupError = new Error('connection reset');
    const error = await generateContentDiffMigration(
      input(
        fakeSide('source-site', 'main'),
        fakeSide('destination-site', 'staging', {
          lockLookupError: lookupError,
        }),
        join(directory, '1700000000_sync.js'),
      ),
    ).catch((caught) => caught);

    expect(error).to.equal(lookupError);
  });
});
