import { createHash } from 'node:crypto';
import { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import { isPortableDatoId } from '../../src/content-diff/canonicalize';
import { deterministicPortableDatoId } from '../../src/content-diff/legacy-ids';
import {
  MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH,
  MIGRATIONS_RUN_LOCK_NAME_PREFIX,
  MIGRATIONS_RUN_LOCK_RECORD_ID,
  MIGRATIONS_RUN_LOCK_SEED,
  type MigrationsRunLock,
  MigrationsRunLockError,
  type MigrationsRunLockMetadata,
  acquireMigrationsRunLock,
  describeMigrationsRunLock,
  detectMigrationsRunCi,
  encodeMigrationsRunLockName,
  forceUnlockMigrationsRunLock,
  migrationsRunCommand,
  migrationsRunLockClearCommand,
  migrationsRunLockUnlockToken,
  migrationsRunLockWasCopied,
  parseMigrationsRunLockName,
  readMigrationsRunLock,
  releaseMigrationsRunLock,
} from '../../src/utils/migrations-run-lock';

const MODEL = { id: 'tracking-model', api_key: 'schema_migration' };

function metadata(
  overrides: Partial<MigrationsRunLockMetadata> = {},
): MigrationsRunLockMetadata {
  return {
    v: 1,
    runId: '0123456789abcdef',
    environmentId: 'main',
    mode: 'in-place',
    host: 'build-host',
    pid: 4242,
    startedAt: '2026-09-28T10:00:00.000Z',
    pending: 2,
    first: '1700000000_first.js',
    plugin: '0.2.0-beta.1',
    ...overrides,
  };
}

function apiError(status: number): CmaClient.ApiError {
  return new CmaClient.ApiError({
    request: {
      url: `/items/${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
      method: 'GET',
      headers: {},
    },
    response: { status, statusText: String(status), headers: {} },
  });
}

function apiErrorWithCode(
  status: number,
  code: string,
  id = 'error-instance',
): CmaClient.ApiError {
  return new CmaClient.ApiError({
    request: {
      url: `/items/${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
      method: 'GET',
      headers: {},
    },
    response: {
      status,
      statusText: String(status),
      headers: {},
      body: {
        data: [{ id, type: 'api_error', attributes: { code, details: {} } }],
      },
    },
  });
}

type FakeItem = {
  id: string;
  item_type: { type: 'item_type'; id: string };
  name: unknown;
  meta: { created_at: string };
  creator?: { type: string; id: string };
};

function fakeClient(initial: FakeItem | null = null) {
  const state = {
    item: initial,
    calls: [] as string[],
    createError: null as unknown,
    createPersists: false,
    renameOnCreate: null as string | null,
    destroyError: null as unknown,
  };
  const client = {
    items: {
      find: async (id: string) => {
        state.calls.push(`find ${id}`);
        if (!state.item || state.item.id !== id) throw apiError(404);
        return state.item;
      },
      create: async (body: {
        id: string;
        item_type: { id: string };
        name: string;
      }) => {
        state.calls.push(`create ${body.id}`);
        if (state.createError) {
          if (state.createPersists) {
            state.item = itemFor(state.renameOnCreate ?? body.name);
          }
          throw state.createError;
        }
        if (state.item) throw apiError(422);
        state.item = itemFor(state.renameOnCreate ?? body.name, {
          modelId: body.item_type.id,
        });
        return state.item;
      },
      destroy: async (id: string) => {
        state.calls.push(`destroy ${id}`);
        if (state.destroyError) throw state.destroyError;
        if (!state.item) throw apiError(404);
        state.item = null;
        return {};
      },
    },
  };
  return { state, client: client as unknown as CmaClient.Client };
}

function itemFor(
  name: unknown,
  { modelId = MODEL.id }: { modelId?: string } = {},
): FakeItem {
  return {
    id: MIGRATIONS_RUN_LOCK_RECORD_ID,
    item_type: { type: 'item_type', id: modelId },
    name,
    meta: { created_at: '2026-09-28T10:00:01.000Z' },
    creator: { type: 'access_token', id: '1234' },
  };
}

function lockFor(meta: MigrationsRunLockMetadata): MigrationsRunLock {
  return {
    recordId: MIGRATIONS_RUN_LOCK_RECORD_ID,
    name: encodeMigrationsRunLockName(meta),
    meta,
    token: meta.runId,
    createdAt: '2026-09-28T10:00:01.000Z',
    creator: null,
  };
}

describe('migrations:run lock', () => {
  describe('identity and encoding', () => {
    it('uses the portable ID derived from the reserved seed', () => {
      expect(MIGRATIONS_RUN_LOCK_RECORD_ID).to.equal(
        deterministicPortableDatoId(MIGRATIONS_RUN_LOCK_SEED),
      );
      expect(isPortableDatoId(MIGRATIONS_RUN_LOCK_RECORD_ID)).to.equal(true);
    });

    it('never starts with a digit and never contains a slash', () => {
      for (const meta of [
        metadata({ ci: 'github:owner/repo#123', first: undefined }),
        metadata({
          first: 'legacyClient/1.js',
          host: 'a/b',
          plugin: undefined,
        }),
      ]) {
        const name = encodeMigrationsRunLockName(meta);

        expect(name).to.match(/^\D/u);
        expect(name).not.to.contain('/');
        expect(parseMigrationsRunLockName(name)).to.deep.equal({
          meta: JSON.parse(JSON.stringify(meta)),
        });
      }
      expect(MIGRATIONS_RUN_LOCK_NAME_PREFIX).to.match(/^\D/u);
    });

    it('writes keys in a fixed order regardless of input order', () => {
      const shuffled = Object.fromEntries(
        Object.entries(metadata()).reverse(),
      ) as MigrationsRunLockMetadata;

      expect(encodeMigrationsRunLockName(shuffled)).to.equal(
        encodeMigrationsRunLockName(metadata()),
      );
      expect(encodeMigrationsRunLockName(metadata())).to.equal(
        `${MIGRATIONS_RUN_LOCK_NAME_PREFIX}{"v":1,"runId":"0123456789abcdef","environmentId":"main","mode":"in-place","host":"build-host","pid":4242,"startedAt":"2026-09-28T10:00:00.000Z","pending":2,"first":"1700000000_first.js","plugin":"0.2.0-beta.1"}`,
      );
    });

    it('truncates host, ci, and first to their own limits', () => {
      const withoutOptional = {
        host: undefined,
        ci: undefined,
        first: undefined,
        plugin: undefined,
      };
      for (const [key, limit] of [
        ['host', 64],
        ['ci', 64],
        ['first', 64],
      ] as const) {
        const parsed = parseMigrationsRunLockName(
          encodeMigrationsRunLockName(
            metadata({ ...withoutOptional, [key]: 'x'.repeat(200) }),
          ),
        );
        expect(parsed, key).to.have.property('meta');
        if (!('meta' in parsed)) return;
        expect(parsed.meta[key], key).to.equal('x'.repeat(limit));
      }
    });

    it('stays within 255 characters by dropping first, then ci, then host, then plugin, then the source', () => {
      const order = ['first', 'ci', 'host', 'plugin', 'sourceEnvironmentId'];
      const droppedCounts = new Set<number>();
      for (
        let environmentLength = 1;
        environmentLength <= 90;
        environmentLength++
      ) {
        const maximal = metadata({
          mode: 'fork',
          environmentId: 'e'.repeat(environmentLength),
          sourceEnvironmentId: 's'.repeat(environmentLength),
          host: 'h/'.repeat(100),
          ci: 'c'.repeat(200),
          first: 'f'.repeat(200),
          pid: 4_194_304,
          pending: 9999,
        });
        const name = encodeMigrationsRunLockName(maximal);
        const parsed = parseMigrationsRunLockName(name);

        expect(name.length).to.be.at.most(MIGRATIONS_RUN_LOCK_NAME_MAX_LENGTH);
        expect(parsed).to.have.property('meta');
        if (!('meta' in parsed)) return;
        const dropped = order.filter(
          (key) => !(key in (parsed.meta as Record<string, unknown>)),
        );
        expect(dropped).to.deep.equal(order.slice(0, dropped.length));
        droppedCounts.add(dropped.length);
      }
      expect([...droppedCounts].sort()).to.include.members([3, 4, 5]);
    });

    it('refuses to encode metadata that cannot fit even without optional fields', () => {
      expect(() =>
        encodeMigrationsRunLockName(
          metadata({ environmentId: 'e'.repeat(300) }),
        ),
      ).to.throw('exceeds 255 characters');
    });

    it('stores no OS user name', () => {
      expect(encodeMigrationsRunLockName(metadata())).not.to.contain('"user"');
    });
  });

  describe('parsing', () => {
    it('round-trips valid names', () => {
      for (const meta of [
        metadata(),
        metadata({
          mode: 'fork',
          sourceEnvironmentId: 'main',
          ci: 'ci',
          host: undefined,
          first: undefined,
          plugin: undefined,
        }),
      ]) {
        const parsed = parseMigrationsRunLockName(
          encodeMigrationsRunLockName(meta),
        );
        expect(parsed).to.deep.equal({
          meta: JSON.parse(JSON.stringify(meta)),
        });
      }
    });

    const valid = JSON.stringify(metadata());
    const withField = (field: string, value: unknown) =>
      `${MIGRATIONS_RUN_LOCK_NAME_PREFIX}${JSON.stringify({
        ...JSON.parse(valid),
        [field]: value,
      })}`;
    const invalidNames: Record<string, unknown> = {
      'a missing prefix': valid,
      'malformed JSON': `${MIGRATIONS_RUN_LOCK_NAME_PREFIX}{"v":1`,
      'a JSON array': `${MIGRATIONS_RUN_LOCK_NAME_PREFIX}[]`,
      'a wrong version': withField('v', 2),
      'a short run ID': withField('runId', 'abc'),
      'an uppercase run ID': withField('runId', '0123456789ABCDEF'),
      'an unknown mode': withField('mode', 'parallel'),
      'a string pid': withField('pid', '4242'),
      'a fractional pending count': withField('pending', 1.5),
      'a negative pending count': withField('pending', -1),
      'an invalid start time': withField('startedAt', 'yesterday'),
      'a numeric host': withField('host', 7),
      'an empty environment': withField('environmentId', ''),
      'an unknown key': withField('user', 'someone'),
      'a non-string name': 42,
    };
    for (const [label, name] of Object.entries(invalidNames)) {
      it(`rejects ${label}`, () => {
        expect(parseMigrationsRunLockName(name)).to.deep.equal({
          unreadable: true,
        });
      });
    }

    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const terminalPayload = `${ESC}]52;c;Y3VybCBldmlsfHNo${BEL}${ESC}[2K\rbuild-box`;
    const unsafeValues: Record<string, string> = {
      'an OSC 52 clipboard write and a line rewrite': terminalPayload,
      'an OSC 8 hyperlink': `${ESC}]8;;https://example.invalid${ESC}\\link`,
      'a C1 control': `build${String.fromCharCode(0x9b)}2Khost`,
      'a DEL character': `build${String.fromCharCode(0x7f)}host`,
      'a bidirectional override': `build${String.fromCharCode(0x202e)}tsoh`,
      'a line separator': `build${String.fromCharCode(0x2028)}host`,
    };
    for (const field of [
      'host',
      'ci',
      'first',
      'plugin',
      'environmentId',
      'sourceEnvironmentId',
    ]) {
      for (const [label, value] of Object.entries(unsafeValues)) {
        it(`treats ${label} in ${field} as unreadable and never prints it`, async () => {
          const name = withField(field, value);
          expect(parseMigrationsRunLockName(name)).to.deep.equal({
            unreadable: true,
          });

          const { client } = fakeClient(itemFor(name));
          const lock = await readMigrationsRunLock(client, MODEL);
          expect(lock?.meta).to.equal(null);
          expect(lock?.token).to.equal(
            createHash('sha256').update(name).digest('hex').slice(0, 16),
          );
          const description = describeMigrationsRunLock(
            lock as MigrationsRunLock,
            'main',
          );
          expect(description).to.match(
            /^unreadable lock metadata, unlock token [0-9a-f]{16}, created /u,
          );
          expect(description).not.to.contain(value);
          expect(description).not.to.contain(ESC);
        });
      }
    }

    it('replaces terminal control characters in its own optional metadata so it can read its lock back', () => {
      const name = encodeMigrationsRunLockName(
        metadata({
          host: `build${ESC}[2Khost`,
          ci: `ci\r${BEL}`,
          first: `1700000000_a${String.fromCharCode(0x202e)}.js`,
          plugin: `0.2.0${String.fromCharCode(0x9b)}`,
          sourceEnvironmentId: `main${ESC}`,
          mode: 'fork',
        }),
      );
      const parsed = parseMigrationsRunLockName(name);

      if (!('meta' in parsed)) throw new Error('the lock name is unreadable');
      expect(parsed.meta).to.include({
        host: 'build\uFFFD[2Khost',
        ci: 'ci\uFFFD\uFFFD',
        plugin: '0.2.0\uFFFD',
        sourceEnvironmentId: 'main\uFFFD',
      });
      // "first" is dropped first when the name would exceed its limit.
      expect([undefined, '1700000000_a\uFFFD.js']).to.include(
        parsed.meta.first,
      );
      expect(migrationsRunLockUnlockToken(name)).to.equal('0123456789abcdef');
    });

    it('derives the unlock token of unreadable names from their SHA-256', () => {
      const name = `${MIGRATIONS_RUN_LOCK_NAME_PREFIX}not json`;

      expect(migrationsRunLockUnlockToken(name)).to.equal(
        createHash('sha256').update(name).digest('hex').slice(0, 16),
      );
      expect(
        migrationsRunLockUnlockToken(encodeMigrationsRunLockName(metadata())),
      ).to.equal('0123456789abcdef');
      expect(migrationsRunLockUnlockToken(null)).to.equal(
        createHash('sha256').update('null').digest('hex').slice(0, 16),
      );
    });
  });

  describe('description', () => {
    const now = new Date('2026-09-28T10:07:30.000Z');

    it('includes holder, host, pid, ci, age, pending count and creator', () => {
      const description = describeMigrationsRunLock(
        {
          ...lockFor(metadata({ ci: 'github:owner/repo#99' })),
          creator: { type: 'access_token', id: '1234' },
        },
        'main',
        now,
      );

      expect(description).to.equal(
        'run 0123456789abcdef, started 2026-09-28T10:00:00.000Z (7 min ago), on host "build-host", pid 4242, github:owner/repo#99, 2 pending migration(s) starting with "1700000000_first.js", created by access_token 1234',
      );
    });

    it('marks locks copied from another environment', () => {
      const lock = lockFor(metadata({ environmentId: 'main' }));

      expect(migrationsRunLockWasCopied(lock, 'main')).to.equal(false);
      expect(migrationsRunLockWasCopied(lock, 'main-copy')).to.equal(true);
      expect(describeMigrationsRunLock(lock, 'main-copy', now)).to.contain(
        'copied from environment "main"',
      );
      expect(describeMigrationsRunLock(lock, 'main', now)).not.to.contain(
        'copied',
      );
    });

    it('describes unreadable locks by token and creation time', () => {
      const description = describeMigrationsRunLock(
        {
          recordId: MIGRATIONS_RUN_LOCK_RECORD_ID,
          name: 'garbled',
          meta: null,
          token: 'feedfacefeedface',
          createdAt: '2026-09-26T10:00:00.000Z',
          creator: null,
        },
        'main',
        now,
      );

      expect(description).to.equal(
        'unreadable lock metadata, unlock token feedfacefeedface, created 2026-09-26T10:00:00.000Z (2 days ago)',
      );
    });

    it('formats hour-scale ages', () => {
      expect(
        describeMigrationsRunLock(
          lockFor(metadata()),
          'main',
          new Date('2026-09-28T13:30:00.000Z'),
        ),
      ).to.contain('(3 h ago)');
    });
  });

  describe('clear command', () => {
    it('adds --allow-primary only for an in-place primary environment', () => {
      const base = { environmentId: 'main', token: 'abc' };

      expect(
        migrationsRunLockClearCommand('datocms', {
          ...base,
          inPlace: true,
          primary: true,
        }),
      ).to.equal(
        'datocms migrations:run --source=main --in-place --allow-primary --force-unlock=abc',
      );
      expect(
        migrationsRunLockClearCommand('datocms', {
          ...base,
          inPlace: true,
          primary: false,
        }),
      ).to.equal(
        'datocms migrations:run --source=main --in-place --force-unlock=abc',
      );
      expect(
        migrationsRunLockClearCommand('datocms', {
          ...base,
          inPlace: false,
          primary: true,
          destinationEnvironmentId: 'review',
        }),
      ).to.equal(
        'datocms migrations:run --source=main --destination=review --force-unlock=abc',
      );
    });

    it('names a custom tracking model and builds the matching dry run', () => {
      const options = {
        environmentId: 'main',
        token: 'abc',
        inPlace: true,
        primary: false,
        migrationsModelApiKey: 'deploy_history',
      };

      expect(migrationsRunLockClearCommand('datocms', options)).to.equal(
        'datocms migrations:run --source=main --in-place --migrations-model=deploy_history --force-unlock=abc',
      );
      expect(
        migrationsRunLockClearCommand('datocms', { ...options, dryRun: true }),
      ).to.equal(
        'datocms migrations:run --source=main --in-place --migrations-model=deploy_history --dry-run',
      );
    });

    it('repeats an explicit config file and migrations tsconfig, and builds the bare resume command', () => {
      const options = {
        environmentId: 'review',
        token: 'abc',
        inPlace: true,
        primary: false,
        profile: 'client_a',
        configFile: '/work/my config/datocms.config.json',
        migrationsDirectory: './content-migrations',
        migrationsModelApiKey: 'schema_migration',
        migrationsTsconfig: './tsconfig.migrations.json',
      };
      const selection =
        "--profile=client_a --config-file='/work/my config/datocms.config.json' --migrations-dir=./content-migrations --migrations-model=schema_migration --migrations-tsconfig=./tsconfig.migrations.json";

      expect(migrationsRunLockClearCommand('datocms', options)).to.equal(
        `datocms migrations:run --source=review --in-place ${selection} --force-unlock=abc`,
      );
      expect(migrationsRunCommand('datocms', options)).to.equal(
        `datocms migrations:run --source=review --in-place ${selection}`,
      );
    });

    it('names an explicit profile and migrations directory, quoting unsafe values', () => {
      const options = {
        environmentId: 'main',
        token: 'abc',
        inPlace: true,
        primary: true,
        profile: 'client_a',
        migrationsDirectory: "./my migrations/it's here",
      };

      expect(migrationsRunLockClearCommand('datocms', options)).to.equal(
        "datocms migrations:run --source=main --in-place --allow-primary --profile=client_a --migrations-dir='./my migrations/it'\\''s here' --force-unlock=abc",
      );
      expect(
        migrationsRunLockClearCommand('datocms', {
          ...options,
          migrationsDirectory: './migrations',
          dryRun: true,
        }),
      ).to.equal(
        'datocms migrations:run --source=main --in-place --allow-primary --profile=client_a --migrations-dir=./migrations --dry-run',
      );
    });
  });

  describe('CI detection', () => {
    it('identifies GitHub, GitLab, and generic CI without secrets', () => {
      expect(
        detectMigrationsRunCi({
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_RUN_ID: '77',
          GITHUB_TOKEN: 'secret',
        }),
      ).to.equal('github:owner/repo#77');
      expect(
        detectMigrationsRunCi({ GITLAB_CI: 'true', CI_PIPELINE_ID: '12' }),
      ).to.equal('gitlab:12');
      expect(detectMigrationsRunCi({ CI: 'true' })).to.equal('ci');
      expect(detectMigrationsRunCi({})).to.equal(undefined);
      expect(
        detectMigrationsRunCi({
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'o'.repeat(100),
          GITHUB_RUN_ID: '1',
        }),
      ).to.have.length(64);
    });
  });

  describe('client operations', () => {
    it('reads no lock when the reserved record does not exist', async () => {
      const { client } = fakeClient();

      expect(await readMigrationsRunLock(client, MODEL)).to.equal(null);
      expect(await readMigrationsRunLock(client, null)).to.equal(null);
    });

    it('reads a held lock with its token, creation time, and creator', async () => {
      const name = encodeMigrationsRunLockName(metadata());
      const { client } = fakeClient(itemFor(name));

      expect(await readMigrationsRunLock(client, MODEL)).to.deep.equal({
        recordId: MIGRATIONS_RUN_LOCK_RECORD_ID,
        name,
        meta: metadata(),
        token: '0123456789abcdef',
        createdAt: '2026-09-28T10:00:01.000Z',
        creator: { type: 'access_token', id: '1234' },
      });
    });

    it('treats the reserved ID under another model as a conflict', async () => {
      const { client } = fakeClient(
        itemFor('anything', { modelId: 'other-model' }),
      );

      for (const model of [MODEL, null]) {
        const error = await readMigrationsRunLock(client, model).catch(
          (caught) => caught,
        );
        expect(error).to.be.instanceOf(MigrationsRunLockError);
        expect(error.code).to.equal('MIGRATIONS_RUN_LOCK_CONFLICT');
        expect(error.message).to.contain('belongs to another model');
      }
    });

    it('rethrows lookup failures other than 404', async () => {
      const { client } = fakeClient();
      (client.items as unknown as Record<string, unknown>).find = async () => {
        throw apiError(403);
      };

      const error = await readMigrationsRunLock(client, MODEL).catch(
        (caught) => caught,
      );
      expect(error).to.be.instanceOf(CmaClient.ApiError);
    });

    it('treats CMA not-found error codes as absence, like the shared predicate (D20)', async () => {
      const handle = {
        environmentId: 'main',
        runId: '0123456789abcdef',
        token: '0123456789abcdef',
      };
      const name = encodeMigrationsRunLockName(metadata());

      const lookup = fakeClient();
      (lookup.client.items as unknown as Record<string, unknown>).find =
        async () => {
          throw apiErrorWithCode(422, 'RECORD_NOT_FOUND');
        };
      expect(await readMigrationsRunLock(lookup.client, MODEL)).to.equal(null);

      const release = fakeClient(itemFor(name));
      release.state.destroyError = apiErrorWithCode(422, 'NOT_FOUND');
      expect(
        await releaseMigrationsRunLock(release.client, MODEL, handle),
      ).to.deep.equal({ status: 'already-cleared' });

      const unlock = fakeClient(itemFor(name));
      const lock = await readMigrationsRunLock(unlock.client, MODEL);
      if (!lock) throw new Error('expected a lock');
      unlock.state.destroyError = apiErrorWithCode(422, 'ITEM_NOT_FOUND');
      await forceUnlockMigrationsRunLock(
        unlock.client,
        'main',
        lock,
        '0123456789abcdef',
      );

      // Other codes, and an error instance ID that merely looks like a code,
      // are still failures.
      for (const failure of [
        apiErrorWithCode(422, 'INVALID_FIELD'),
        apiErrorWithCode(422, 'INVALID_FIELD', 'NOT_FOUND'),
      ]) {
        const failing = fakeClient();
        (failing.client.items as unknown as Record<string, unknown>).find =
          async () => {
            throw failure;
          };
        const error = await readMigrationsRunLock(failing.client, MODEL).catch(
          (caught) => caught,
        );
        expect(error).to.equal(failure);
      }
    });

    it('acquires with the fixed ID and releases only its own lock', async () => {
      const { client, state } = fakeClient();

      const handle = await acquireMigrationsRunLock(client, MODEL, metadata());
      expect(handle).to.deep.equal({
        environmentId: 'main',
        runId: '0123456789abcdef',
        token: '0123456789abcdef',
      });
      expect(state.item?.name).to.equal(
        encodeMigrationsRunLockName(metadata()),
      );

      expect(
        await releaseMigrationsRunLock(client, MODEL, handle),
      ).to.deep.equal({
        status: 'released',
      });
      expect(state.item).to.equal(null);
      expect(state.calls).to.deep.equal([
        `create ${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
        `find ${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
        `destroy ${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
      ]);
    });

    it('fails with the holder when another run holds the lock', async () => {
      const other = metadata({ runId: 'aaaaaaaaaaaaaaaa', host: 'other-host' });
      const { client, state } = fakeClient(
        itemFor(encodeMigrationsRunLockName(other)),
      );

      const error = await acquireMigrationsRunLock(
        client,
        MODEL,
        metadata(),
      ).catch((caught) => caught);

      expect(error).to.be.instanceOf(MigrationsRunLockError);
      expect(error.code).to.equal('MIGRATIONS_RUN_LOCKED');
      expect(error.lock.token).to.equal('aaaaaaaaaaaaaaaa');
      expect(error.message).to.contain('other-host');
      expect(state.calls).not.to.include(
        `destroy ${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
      );
    });

    it('holds the lock when a failed create actually stored this run', async () => {
      const { client, state } = fakeClient();
      state.createError = new Error('socket hang up');
      state.createPersists = true;

      const handle = await acquireMigrationsRunLock(client, MODEL, metadata());

      expect(handle.token).to.equal('0123456789abcdef');
    });

    it('reports the original create error when no lock exists afterwards', async () => {
      const { client, state } = fakeClient();
      state.createError = new Error('name is too long');

      const error = await acquireMigrationsRunLock(
        client,
        MODEL,
        metadata(),
      ).catch((caught) => caught);

      expect(error.code).to.equal('MIGRATIONS_RUN_LOCK_CREATE_FAILED');
      expect(error.message).to.equal(
        'Could not create the migrations:run lock record in model "schema_migration": name is too long. No migration was executed. Retry: another run may have released its lock at the same moment. If this keeps failing, the "name" field must accept arbitrary strings of up to 255 characters.',
      );
      expect(error.cause).to.equal(state.createError);
    });

    it('removes a created lock whose name was rewritten and fails', async () => {
      const { client, state } = fakeClient();
      state.renameOnCreate = 'rewritten';

      const error = await acquireMigrationsRunLock(
        client,
        MODEL,
        metadata(),
      ).catch((caught) => caught);

      expect(error.code).to.equal('MIGRATIONS_RUN_LOCK_CONFLICT');
      expect(state.item).to.equal(null);
    });

    it('reports its own unlock token when neither create nor read-back succeeds', async () => {
      const { client, state } = fakeClient();
      state.createError = new Error('request timed out');
      state.createPersists = true;
      const readError = apiError(500);
      (client.items as unknown as { find: () => Promise<never> }).find =
        async () => {
          throw readError;
        };

      const error = await acquireMigrationsRunLock(
        client,
        MODEL,
        metadata(),
      ).catch((caught) => caught);

      expect(error).to.be.instanceOf(MigrationsRunLockError);
      expect(error.code).to.equal('MIGRATIONS_RUN_LOCK_CREATE_FAILED');
      expect(error.message).to.contain(
        'Could not create the migrations:run lock record in model "schema_migration": request timed out. Reading it back also failed: ',
      );
      expect(error.message).to.contain(
        'No migration was executed. The lock record may have been stored anyway; its unlock token is 0123456789abcdef.',
      );
      expect(error.cause).to.equal(state.createError);
    });

    it('removes its own lock stored under a rewritten name by a failed create', async () => {
      const { client, state } = fakeClient();
      state.createError = new Error('socket hang up');
      state.createPersists = true;
      state.renameOnCreate = encodeMigrationsRunLockName(
        metadata({ host: 'rewritten-host' }),
      );

      const error = await acquireMigrationsRunLock(
        client,
        MODEL,
        metadata(),
      ).catch((caught) => caught);

      expect(error.code).to.equal('MIGRATIONS_RUN_LOCK_CONFLICT');
      expect(error.message).to.contain('its unlock token is 0123456789abcdef.');
      expect(state.item).to.equal(null);
      expect(state.calls).to.include(
        `destroy ${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
      );
    });

    it('reports an already-cleared or replaced lock on release without destroying', async () => {
      const handle = {
        environmentId: 'main',
        runId: '0123456789abcdef',
        token: '0123456789abcdef',
      };
      const cleared = fakeClient();
      expect(
        await releaseMigrationsRunLock(cleared.client, MODEL, handle),
      ).to.deep.equal({ status: 'already-cleared' });

      const replaced = fakeClient(
        itemFor(
          encodeMigrationsRunLockName(metadata({ runId: 'bbbbbbbbbbbbbbbb' })),
        ),
      );
      const outcome = await releaseMigrationsRunLock(
        replaced.client,
        MODEL,
        handle,
      );
      expect(outcome.status).to.equal('replaced');
      expect(replaced.state.item).not.to.equal(null);
      expect(replaced.state.calls).to.deep.equal([
        `find ${MIGRATIONS_RUN_LOCK_RECORD_ID}`,
      ]);
    });

    it('force-unlocks only with the matching token', async () => {
      const name = encodeMigrationsRunLockName(metadata());
      const { client, state } = fakeClient(itemFor(name));
      const lock = await readMigrationsRunLock(client, MODEL);
      if (!lock) throw new Error('expected a lock');

      const error = await forceUnlockMigrationsRunLock(
        client,
        'main',
        lock,
        'wrong',
      ).catch((caught) => caught);
      expect(error.code).to.equal('MIGRATIONS_RUN_UNLOCK_TOKEN_MISMATCH');
      expect(error.message).to.equal(
        '--force-unlock=wrong does not match the current run lock on "main" (unlock token 0123456789abcdef). The lock may belong to a different run than the one you inspected. No lock was cleared.',
      );
      expect(state.item).not.to.equal(null);

      await forceUnlockMigrationsRunLock(
        client,
        'main',
        lock,
        '0123456789abcdef',
      );
      expect(state.item).to.equal(null);
    });

    it('force-unlocks an unreadable lock with its derived token', async () => {
      const { client, state } = fakeClient(itemFor('garbled'));
      const lock = await readMigrationsRunLock(client, MODEL);
      if (!lock) throw new Error('expected a lock');

      expect(lock.meta).to.equal(null);
      await forceUnlockMigrationsRunLock(
        client,
        'main',
        lock,
        migrationsRunLockUnlockToken('garbled'),
      );
      expect(state.item).to.equal(null);
    });
  });
});
