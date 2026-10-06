import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type { ContentMigrationClient } from '../../src/migration';
import { defineContentMigration, runMigrationPart } from '../../src/migration';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function client(
  update: (...args: unknown[]) => unknown,
): ContentMigrationClient {
  return { items: { update } } as unknown as ContentMigrationClient;
}

describe('content migration part lifecycle', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'migration-parts-lifecycle-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const filename = () => join(directory, 'part.ts');

  it('rejects a delayed unawaited part before its intent can escape recording', async () => {
    await writeFile(
      filename(),
      `export default async function(client) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await client.items.update('late', { title: 'Must not escape' });
    }`,
    );
    const calls: unknown[] = [];
    const migration = defineContentMigration(
      { baseline: directory },
      async (recording) => {
        void runMigrationPart(recording, filename());
      },
    );
    await assert.rejects(
      migration.run(
        client((...args) => {
          calls.push(args);
        }),
      ),
      (error: unknown) =>
        (error as { code: string }).code === 'UNAWAITED_MIGRATION_PART',
    );
    await delay(100);
    assert.deepEqual(calls, []);
  });

  it('drains an active handler before preserving the callback failure', async () => {
    await writeFile(
      filename(),
      "export default async function(client) { await client.items.update('active', {}); }",
    );
    const started = deferred();
    const release = deferred();
    const original = new Error('Callback failed');
    const events: string[] = [];
    const recording = client(async () => {
      started.resolve();
      await release.promise;
      events.push('drained');
    });
    const migration = defineContentMigration(
      { baseline: directory },
      async (recording) => {
        void runMigrationPart(recording, filename());
        await started.promise;
        throw original;
      },
    );
    const result = migration.run(recording);
    const failed = assert.rejects(
      result,
      (error: unknown) => error === original,
    );
    await started.promise;
    release.resolve();
    await failed;
    assert.deepEqual(events, ['drained']);
    await delay(50);
    assert.deepEqual(events, ['drained']);
  });

  it('keeps a caught part failure sticky so partial intent cannot be applied', async () => {
    await writeFile(
      filename(),
      `export default async function(client) {
      await client.items.update('prefix', {});
      throw new Error('Part failed after prefix');
    }`,
    );
    const events: string[] = [];
    const migration = defineContentMigration(
      { baseline: directory },
      async (recording) => {
        try {
          await runMigrationPart(recording, filename());
        } catch {
          events.push('caught');
        }
      },
    );
    await assert.rejects(
      migration.run(
        client(() => {
          events.push('prefix');
        }),
      ),
      /Part failed after prefix/,
    );
    assert.deepEqual(events, ['prefix', 'caught']);
  });

  it('allows properly awaited sequential parts and closes their session afterward', async () => {
    await writeFile(
      filename(),
      "export default async function(client) { await client.items.update('one', {}); }",
    );
    const next = join(directory, 'next.ts');
    await writeFile(
      next,
      "export default async function(client) { await client.items.update('two', {}); }",
    );
    const calls: unknown[] = [];
    const recording = client((id) => {
      calls.push(id);
    });
    const migration = defineContentMigration(
      { baseline: directory },
      async (recording) => {
        await runMigrationPart(recording, filename());
        await runMigrationPart(recording, next);
      },
    );
    await migration.run(recording);
    assert.deepEqual(calls, ['one', 'two']);
    await assert.rejects(
      runMigrationPart(recording, filename()),
      /inside defineContentMigration/,
    );
  });

  it('preserves plugin interruption metadata and drains before cancellation finishes', async () => {
    await writeFile(
      filename(),
      "export default async function(client) { await client.items.update('active', {}); await client.items.update('forbidden-late', {}); }",
    );
    const started = deferred();
    const release = deferred();
    const calls: unknown[] = [];
    const recording = client(async (id) => {
      calls.push(id);
      started.resolve();
      await release.promise;
    });
    const controller = new AbortController();
    const interruption = Object.assign(new Error('Content apply SIGINT'), {
      code: 'INTERRUPTED',
      exitCode: 130,
      oclif: { exit: 130 },
    });
    const migration = defineContentMigration(
      { baseline: directory },
      async (recording) => {
        await runMigrationPart(recording, filename());
      },
    );
    const result = migration.run(recording, controller.signal);
    const failed = assert.rejects(
      result,
      (error: unknown) => error === interruption,
    );
    await started.promise;
    controller.abort(interruption);
    release.resolve();
    await failed;
    assert.deepEqual(calls, ['active']);
    await delay(50);
    assert.deepEqual(calls, ['active']);
  });
});
