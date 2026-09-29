import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CmaClient } from '@datocms/cli-utils';
import { createScenarioCancellation } from '../e2e/scenario-cancellation';
import {
  CROSS_PROJECT_PNG,
  type CrossProjectCapturedState,
  type FixtureLane,
  assertAppliedState,
  assertFixturePngBytes,
  assertUploadedFixturePng,
  buildCrossProjectFields,
  captureFixtureState,
  crossProjectFixture,
  fixtureBlockIds,
  inspectCrossProjectFields,
  introduceCrossProjectDrift,
  readBundledFixturePng,
  seedAlignedFixture,
} from './recursive-fixture';

const fixture = crossProjectFixture('offline-recursive-cross-project');
const uploadId = 'fixture-upload';

describe('cross-project recursive fixture and independent raw oracle', () => {
  it('seeds identical five-model schemas and exact baseline block IDs independently in both projects', async () => {
    const calls = [[], []] as Record<string, unknown>[][];
    const client = (index: number) =>
      ({
        itemTypes: {
          async create(value: Record<string, unknown>) {
            calls[index].push({ kind: 'model', ...value });
            return { id: value.id };
          },
        },
        fields: {
          async create(model: string, value: Record<string, unknown>) {
            calls[index].push({ kind: 'field', model, ...value });
            return value;
          },
        },
        items: {
          async create(value: Record<string, unknown>) {
            calls[index].push({ kind: 'record', ...value });
            return { id: value.id };
          },
          async publish(id: string) {
            calls[index].push({ kind: 'publish', id });
          },
        },
      }) as unknown as CmaClient.Client;
    const seeded = await seedAlignedFixture(
      client(0),
      client(1),
      fixture.runId,
    );
    assert.deepEqual(seeded, fixture);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(
      calls[0].filter(
        ({ kind, modular_block }) => kind === 'model' && modular_block,
      ).length,
      4,
    );
    assert.equal(calls[0].filter(({ kind }) => kind === 'model').length, 5);
    const record = calls[0].find(({ kind }) => kind === 'record')!;
    assert.equal(record.id, fixture.ids.baselineRecord);
    assert.deepEqual(
      inspectCrossProjectFields(record, fixture).ids,
      fixtureBlockIds(fixture, 'baseline'),
    );
    assert.deepEqual(calls[0].at(-1), {
      kind: 'publish',
      id: fixture.ids.baselineRecord,
    });
  });

  it('keeps all four container identities across versions while preserving independent records and opaque JSON', () => {
    const allIds: string[] = [];
    for (const lane of ['baseline', 'source', 'destination'] as const) {
      const published = buildCrossProjectFields(
        fixture,
        lane,
        'published',
        uploadId,
      );
      const current = buildCrossProjectFields(
        fixture,
        lane,
        'current',
        uploadId,
      );
      const publishedResult = inspectCrossProjectFields(published, fixture);
      const currentResult = inspectCrossProjectFields(current, fixture);
      assert.deepEqual(publishedResult.ids, fixtureBlockIds(fixture, lane));
      assert.deepEqual(currentResult.ids, publishedResult.ids);
      assert.notDeepEqual(currentResult.fields, publishedResult.fields);
      assert.equal(
        leaf(current).peer,
        lane === 'baseline' ? null : fixture.ids.baselineRecord,
      );
      assert.equal(object(leaf(current).image).upload_id, uploadId);
      const opaque = JSON.parse(String(leaf(current).opaque));
      assert.equal(opaque.id, '123456');
      assert.equal(opaque.attributes.image.upload_id, 'opaque-upload');
      assert.equal(opaque.document.children[0].item, 'opaque-reference');
      allIds.push(...currentResult.ids);
    }
    assert.equal(allIds.length, 12);
    assert.equal(new Set(allIds).size, 12);
  });

  it('publishes the baseline before the referring create and restores both current slices using the owned PNG', async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'cross-project-fixture-seed-'),
    );
    const cancellation = createScenarioCancellation();
    const writes: {
      project: string;
      kind: string;
      id: string;
      fields?: unknown;
    }[] = [];
    const client = (project: string) =>
      ({
        uploads: {
          async createFromLocalFile(input: {
            localPath: string;
            skipCreationIfAlreadyExists: boolean;
          }) {
            assert.equal(project, 'source');
            assert.equal(
              input.localPath,
              join(workspace, 'cross-project-fixture.png'),
            );
            assert.equal(input.skipCreationIfAlreadyExists, false);
            assertFixturePngBytes(await readFile(input.localPath), 'seed file');
            return { id: uploadId };
          },
          async rawFind(id: string) {
            assert.equal(id, uploadId);
            return { data: { meta: { antivirus: { status: 'clean' } } } };
          },
        },
        items: {
          async update(id: string, fields: unknown) {
            writes.push({ project, kind: 'update', id, fields });
          },
          async create(fields: { id: string }) {
            writes.push({ project, kind: 'create', id: fields.id, fields });
            return { id: fields.id };
          },
          async publish(id: string) {
            writes.push({ project, kind: 'publish', id });
          },
        },
      }) as unknown as CmaClient.Client;
    try {
      assert.equal(
        await introduceCrossProjectDrift({
          source: client('source'),
          destination: client('destination'),
          fixture,
          workspace,
          cancellation,
        }),
        uploadId,
      );
      assert.deepEqual(
        writes.map(({ project, kind, id }) => [project, kind, id]),
        [
          ['source', 'update', fixture.ids.baselineRecord],
          ['source', 'publish', fixture.ids.baselineRecord],
          ['source', 'update', fixture.ids.baselineRecord],
          ['source', 'create', fixture.ids.sourceOnlyRecord],
          ['source', 'publish', fixture.ids.sourceOnlyRecord],
          ['source', 'update', fixture.ids.sourceOnlyRecord],
          ['destination', 'update', fixture.ids.baselineRecord],
          ['destination', 'publish', fixture.ids.baselineRecord],
          ['destination', 'create', fixture.ids.destinationOnlyRecord],
          ['destination', 'publish', fixture.ids.destinationOnlyRecord],
          ['destination', 'update', fixture.ids.destinationOnlyRecord],
        ],
      );
      for (const write of writes.filter(({ fields }) => fields)) {
        const lane =
          write.id === fixture.ids.baselineRecord
            ? 'baseline'
            : write.id === fixture.ids.sourceOnlyRecord
              ? 'source'
              : 'destination';
        assert.deepEqual(
          inspectCrossProjectFields(write.fields, fixture).ids,
          fixtureBlockIds(fixture, lane),
        );
        const image = leaf(write.fields).image;
        assert.equal(
          image === null ? null : object(image).upload_id,
          write.project === 'source' ? uploadId : null,
        );
        assert.equal(
          leaf(write.fields).peer,
          lane === 'baseline' ? null : fixture.ids.baselineRecord,
        );
      }
    } finally {
      await cancellation.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('compares every nested attribute and ID, ignores block metadata only, and retains destination-only slices', () => {
    const source = state('source');
    const destination = state('destination');
    const applied = {
      current: {
        ...source.current,
        [fixture.ids.destinationOnlyRecord]:
          destination.current[fixture.ids.destinationOnlyRecord],
      },
      published: {
        ...source.published,
        [fixture.ids.destinationOnlyRecord]:
          destination.published[fixture.ids.destinationOnlyRecord],
      },
    };
    assertAppliedState({ source, destination, applied, fixture });
    const fields = buildCrossProjectFields(
      fixture,
      'source',
      'current',
      uploadId,
    );
    const metadataChanged = clone(fields);
    object((object(metadataChanged).modules as unknown[])[0]).meta = {
      current_version: 'irrelevant',
      updated_at: 'different project',
    };
    assert.deepEqual(
      inspectCrossProjectFields(fields, fixture),
      inspectCrossProjectFields(metadataChanged, fixture),
    );

    for (const [label, mutate] of [
      [
        'nested ID',
        (fields: unknown) => {
          leafResource(fields).id = 'changed-id';
        },
      ],
      [
        'opaque JSON',
        (fields: unknown) => {
          leaf(fields).opaque = '{"id":"rewritten"}';
        },
      ],
      [
        'upload reference',
        (fields: unknown) => {
          object(leaf(fields).image).upload_id = 'wrong-upload';
        },
      ],
      [
        'record reference',
        (fields: unknown) => {
          leaf(fields).peer = fixture.ids.destinationOnlyRecord;
        },
      ],
      [
        'nested label',
        (fields: unknown) => {
          leaf(fields).caption = 'rewritten';
        },
      ],
    ] as const) {
      for (const version of ['current', 'published'] as const) {
        const changed = clone(applied);
        mutate(changed[version][fixture.ids.sourceOnlyRecord].fields);
        assert.throws(
          () =>
            assertAppliedState({
              source,
              destination,
              applied: changed,
              fixture,
            }),
          Error,
          `${label}/${version}`,
        );
      }
    }
    const changedRetained = clone(applied);
    leaf(
      changedRetained.published[fixture.ids.destinationOnlyRecord].fields,
    ).opaque = '{}';
    assert.throws(
      () =>
        assertAppliedState({
          source,
          destination,
          applied: changedRetained,
          fixture,
        }),
      /destination-only published content changed/,
    );
  });

  it('reads complete nested current and published slices and rejects changed IDs or truncated responses', async () => {
    const requests: unknown[] = [];
    const response = (version: string) => ({
      data: (['baseline', 'source'] as const).map((lane) => ({
        id:
          lane === 'baseline'
            ? fixture.ids.baselineRecord
            : fixture.ids.sourceOnlyRecord,
        type: 'item',
        relationships: {
          item_type: { data: { id: fixture.ids.model, type: 'item_type' } },
        },
        attributes: buildCrossProjectFields(fixture, lane, version, uploadId),
        meta: {
          status: 'updated',
          is_current_version_valid: true,
          is_published_version_valid: true,
        },
      })),
      meta: { total_count: 2 },
    });
    const client = {
      items: {
        async rawList(request: { version: string }) {
          requests.push(request);
          return response(request.version);
        },
      },
    } as unknown as CmaClient.Client;
    const captured = await captureFixtureState(client, fixture);
    assert.deepEqual(captured, state('source'));
    assert.deepEqual(
      requests,
      ['current', 'published'].map((version) => ({
        filter: { type: fixture.ids.model },
        nested: true,
        version,
        page: { offset: 0, limit: 30 },
      })),
    );
    for (const mutate of [
      (result: ReturnType<typeof response>) => {
        result.meta.total_count += 1;
      },
      (result: ReturnType<typeof response>) => {
        result.data[1].id = result.data[0].id;
      },
      (result: ReturnType<typeof response>) => {
        leafResource(result.data[0].attributes).id = 'changed-leaf-id';
      },
    ]) {
      const invalid = {
        items: {
          async rawList() {
            const result = response('current');
            mutate(result);
            return result;
          },
        },
      } as unknown as CmaClient.Client;
      await assert.rejects(captureFixtureState(invalid, fixture));
    }
  });

  it('checks bundled bytes against the known PNG, not just a declared digest', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'cross-project-bundled-png-'),
    );
    try {
      await mkdir(join(directory, 'assets'));
      const path = join(directory, 'assets', 'fixture.bin');
      await writeFile(path, CROSS_PROJECT_PNG);
      const transport = {
        bundledPath: 'assets/fixture.bin',
        sha256: sha256(CROSS_PROJECT_PNG),
      };
      const plan = {
        uploads: [{ id: uploadId, action: 'create', desired: { transport } }],
      };
      assert.deepEqual(
        await readBundledFixturePng(
          plan,
          join(directory, 'fixture.plan.json'),
          uploadId,
        ),
        CROSS_PROJECT_PNG,
      );
      const changed = Buffer.from(CROSS_PROJECT_PNG);
      changed[changed.length - 1] ^= 1;
      await writeFile(path, changed);
      transport.sha256 = sha256(changed);
      await assert.rejects(
        readBundledFixturePng(
          plan,
          join(directory, 'fixture.plan.json'),
          uploadId,
        ),
        /known PNG bytes/,
      );
      assert.throws(
        () => assertFixturePngBytes(CROSS_PROJECT_PNG.subarray(1), 'truncated'),
        /known PNG bytes/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses cancellation-aware fetch for destination bytes and rejects wrong bytes or a cancelled phase', async () => {
    const bytes = Buffer.from(CROSS_PROJECT_PNG);
    let requests = 0;
    let reads = 0;
    const client = {
      uploads: {
        async find(id: string) {
          reads += 1;
          return { id, url: 'https://assets.invalid/fixture.png' };
        },
      },
    } as unknown as CmaClient.Client;
    const cancellation = createScenarioCancellation({
      fetchFn: async (url, init) => {
        assert.equal(url, 'https://assets.invalid/fixture.png');
        assert.ok(init?.signal);
        requests += 1;
        return new Response(bytes);
      },
    });
    try {
      await assertUploadedFixturePng(
        client,
        uploadId,
        cancellation,
        CROSS_PROJECT_PNG,
      );
      bytes[bytes.length - 1] ^= 1;
      await assert.rejects(
        assertUploadedFixturePng(
          client,
          uploadId,
          cancellation,
          CROSS_PROJECT_PNG,
        ),
        /known PNG bytes/,
      );
      assert.equal(requests, 2);
      cancellation.abort(new Error('stop fixture work'));
      await assert.rejects(
        assertUploadedFixturePng(client, uploadId, cancellation),
        /stop fixture work/,
      );
      assert.equal(reads, 2);
      assert.equal(requests, 2);
    } finally {
      await cancellation.shutdown();
    }
  });
});

function state(project: 'source' | 'destination'): CrossProjectCapturedState {
  const capture = (version: 'current' | 'published') =>
    Object.fromEntries(
      (project === 'source'
        ? ['baseline', 'source']
        : ['baseline', 'destination']
      ).map((lane) => {
        const id =
          lane === 'baseline'
            ? fixture.ids.baselineRecord
            : lane === 'source'
              ? fixture.ids.sourceOnlyRecord
              : fixture.ids.destinationOnlyRecord;
        return [
          id,
          {
            id,
            itemTypeId: fixture.ids.model,
            status: 'updated',
            currentValid: true,
            publishedValid: true,
            fields: inspectCrossProjectFields(
              buildCrossProjectFields(
                fixture,
                lane as FixtureLane,
                version,
                uploadId,
              ),
              fixture,
            ).fields,
          },
        ];
      }),
    );
  return { current: capture('current'), published: capture('published') };
}

function leafResource(fields: unknown): Record<string, unknown> {
  const modules = object(fields).modules as unknown[];
  const hero = object(object(modules[0]).attributes).hero;
  const body = object(object(hero).attributes).body;
  const bodyNode = (object(object(body).document).children as unknown[])[0];
  const inlineBody = object(
    object(object(bodyNode).item).attributes,
  ).inline_body;
  const paragraph = (
    object(object(inlineBody).document).children as unknown[]
  )[0];
  return object(object((object(paragraph).children as unknown[])[1]).item);
}

function leaf(fields: unknown): Record<string, unknown> {
  return object(leafResource(fields).attributes);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
