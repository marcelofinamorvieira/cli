import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { type RecordLine, openDump } from '../src/dump/format';
import { ZipWriter } from '../src/dump/zip';
import { exportEnvironment } from '../src/export/export-environment';
import { importedId } from '../src/import/ids';
import { importDump } from '../src/import/import-dump';
import { assertSameSchema } from '../src/import/schema-check';
import { readRawSchema, schemaView } from '../src/schema';
import { CONCURRENCY } from '../src/utils/concurrency';
import { assertSameContents, comparableContents } from './dump-contents';
import { type FakeEnvironment, apiError, stubFetch } from './fixtures/cma';
import {
  type Project,
  buildProject,
  emptyEnvironment,
  inDays,
  writer,
} from './fixtures/project';

const TRACKING_MODEL = 'schema_migration';

describe('importDump', () => {
  let directory: string;
  let project: Project;
  let restoreFetch: () => void;
  let withAssets: string;
  let withoutAssets: string;
  let expected: Awaited<ReturnType<typeof comparableContents>>;

  const exportTo = async (
    environment: FakeEnvironment,
    includeAssets = false,
  ) => {
    const path = join(directory, `${environment.id}-${includeAssets}.dump.zip`);
    await exportEnvironment({
      client: environment.client(),
      environment: { id: environment.id, primary: environment.primary },
      path,
      includeAssets,
      progress: () => {},
    });
    return path;
  };

  /** The content of an environment, as two dumps are compared. */
  const contentsOf = async (environment: FakeEnvironment) =>
    comparableContents(await exportTo(environment), [TRACKING_MODEL]);

  /**
   * What an import reproduces, read from the emulated CMA itself, so that a
   * mistake the export makes in both dumps does not go unnoticed.
   */
  const stateOf = (environment: FakeEnvironment) => ({
    records: Object.fromEntries(
      [...environment.records.values()]
        .filter((record) => record.model.apiKey !== TRACKING_MODEL)
        .map(({ id, current, published, status, parentId, position, meta }) => [
          id,
          {
            current,
            published,
            status,
            parentId,
            position,
            createdAt: meta.created_at,
            firstPublishedAt: meta.first_published_at,
            schedules: [
              meta.publication_scheduled_at,
              meta.unpublishing_scheduled_at,
            ],
          },
        ]),
    ),
    uploads: Object.fromEntries(
      [...environment.uploads.values()].map(
        ({
          url: _url,
          path: _path,
          created_at: _created,
          updated_at: _updated,
          ...upload
        }) => [upload.id, upload],
      ),
    ),
    folders: Object.fromEntries(environment.folders),
  });

  /**
   * Imports a dump into a new empty environment with the project's schema,
   * as content:import does once it has checked the schema.
   */
  const importInto = async (
    path: string,
    id: string,
    prepare: (environment: FakeEnvironment) => void = () => {},
  ) => {
    const environment = emptyEnvironment(project.cma, id);
    prepare(environment);
    const client = environment.client();
    const dump = await openDump(path);
    const temporary = await mkdtemp(join(directory, 'import-'));
    try {
      const schema = schemaView(dump.schema, TRACKING_MODEL);
      await assertSameSchema({
        dump,
        expected: schema,
        target: id,
        trackingModelApiKey: TRACKING_MODEL,
        readSchema: (other) =>
          readRawSchema(project.cma.environment(other).client()),
      });
      const result = await importDump({
        dump,
        client,
        environment: id,
        schema,
        directory: temporary,
        progress: () => {},
      });
      return { result, environment };
    } finally {
      dump.zip.close();
      await rm(temporary, { recursive: true, force: true });
    }
  };

  /** Writes a copy of a dump without asset files, with `edit` applied to its records. */
  const rewrite = async (
    source: string,
    name: string,
    edit: (line: RecordLine) => void,
  ) => {
    const path = join(directory, name);
    const dump = await openDump(source);
    const zip = new ZipWriter(path);
    try {
      assert.equal(dump.manifest.includesAssets, false);
      const values = async function* (prefix: string) {
        for await (const { value } of dump.zip.lines(prefix)) {
          if (prefix === 'records') edit(value as RecordLine);
          yield value;
        }
      };
      zip.addJson('schema.json', dump.schema);
      for (const prefix of ['records', 'uploads', 'upload-collections'])
        await zip.addLines(prefix, values(prefix));
      zip.addJson('manifest.json', dump.manifest, { pretty: true });
      await zip.close();
    } finally {
      dump.zip.close();
    }
    return path;
  };

  const createsOf = (environment: FakeEnvironment) =>
    environment.writes.filter((call) => call.method === 'items.rawCreate');

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-dump-import-'));
    project = await buildProject(directory);
    restoreFetch = stubFetch(project.cma);
    withAssets = await exportTo(project.main, true);
    withoutAssets = await exportTo(project.main);
    expected = await comparableContents(withAssets, [TRACKING_MODEL]);
  });

  after(async () => {
    restoreFetch();
    await rm(directory, { recursive: true, force: true });
  });

  it('imports a dump with asset files into an empty environment, which then holds the same content', async () => {
    const { result, environment } = await importInto(withAssets, 'restored');

    assert.deepEqual(result, {
      environment: 'restored',
      counts: { uploadCollections: 5, uploads: 2, records: 16, published: 12 },
      skippedRecords: 1,
      skippedSchedules: 0,
    });
    assertSameContents(await contentsOf(environment), expected);
    assert.deepEqual(stateOf(environment), stateOf(project.main));
    const methods = environment.writes.map((call) => call.method);
    assert.equal(
      methods.filter((method) => method === 'uploads.createFromLocalFile')
        .length,
      2,
    );
    assert.equal(methods.includes('uploads.createFromUrl'), false);
    // Siblings are created in order instead, each appended to the others.
    for (const call of createsOf(environment))
      assert.equal('position' in call.args[0].data.attributes, false);
  });

  it('imports a dump without asset files from the original file of every upload', async () => {
    const fetchedBefore = project.cma.fetched.length;
    const { environment } = await importInto(withoutAssets, 'from-urls');

    assertSameContents(await contentsOf(environment), expected);
    assert.deepEqual(stateOf(environment), stateOf(project.main));
    const urls = project.cma.fetched
      .slice(fetchedBefore)
      .map((url) => new URL(url));
    assert.deepEqual(
      urls.map((url) => url.origin + url.pathname).sort(),
      [...project.main.uploads.values()].map((upload) => upload.url).sort(),
    );
    for (const { searchParams } of urls) {
      assert.equal(searchParams.get('skip-default-optimizations'), 'true');
      assert.equal(searchParams.get('svg-sanitize'), 'false');
    }
    // The SDK takes the content type from the local file's extension.
    const uploads = environment.writes.filter(
      (call) => call.method === 'uploads.createFromLocalFile',
    );
    assert.equal(uploads.length, 2);
    for (const call of uploads)
      assert.equal(
        extname(call.args[0].localPath),
        extname(call.args[0].filename),
      );
  });

  it('explains a video the asset CDN refuses to serve when importing from URLs', async () => {
    const source = emptyEnvironment(project.cma, 'videos');
    const localPath = join(directory, 'clip.mp4');
    await writeFile(localPath, 'not really a video');
    const { api } = writer(source);
    const video = await api.uploads.createFromLocalFile({ localPath });

    await assert.rejects(
      importInto(await exportTo(source), 'videos-from-urls'),
      (error: any) => {
        assert.equal(error.code, 'IMPORT_FAILED');
        assert.match(
          error.message,
          new RegExp(
            `^The import stopped while creating upload ${video.id} "clip.mp4": Asset ${video.id} is a video, .*To import it from its URL, turn off`,
          ),
        );
        return true;
      },
    );
  });

  it('gives every record, block, upload and folder with a legacy numeric ID a UUID derived from it, wherever it is referenced', async () => {
    // A dump of an older project, where every such ID is a number.
    const dump = await openDump(withoutAssets);
    const numbers = new Map<string, string>();
    const number = (id: string) => {
      if (!numbers.has(id)) numbers.set(id, String(48_291_000 + numbers.size));
    };
    const blocks = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(blocks);
      else if (value && typeof value === 'object') {
        const entry = value as {
          type?: string;
          id?: string;
          relationships?: unknown;
        };
        if (entry.type === 'item' && entry.relationships && entry.id)
          number(entry.id);
        Object.values(value).forEach(blocks);
      }
    };
    try {
      for await (const { value } of dump.zip.lines('records')) {
        const line = value as RecordLine;
        number(line.id);
        blocks(line);
      }
      for (const prefix of ['uploads', 'upload-collections'])
        for await (const { value } of dump.zip.lines(prefix))
          number((value as { id: string }).id);
    } finally {
      dump.zip.close();
    }
    const replaced = (text: string, to: (number: string) => string) => {
      let result = text;
      for (const [id, legacy] of numbers)
        result = result.replaceAll(id, to(legacy));
      return result;
    };
    const path = join(directory, 'legacy.dump.zip');
    const source = await openDump(withoutAssets);
    const zip = new ZipWriter(path);
    try {
      zip.addJson('schema.json', source.schema);
      for (const prefix of ['records', 'uploads', 'upload-collections']) {
        const lines = async function* () {
          for await (const { text } of source.zip.lines(prefix))
            yield JSON.parse(replaced(text, (legacy) => legacy));
        };
        await zip.addLines(prefix, lines());
      }
      zip.addJson('manifest.json', source.manifest, { pretty: true });
      await zip.close();
    } finally {
      source.zip.close();
    }

    const { environment } = await importInto(path, 'legacy-ids');

    // 17 records, 7 blocks, 2 uploads and 5 folders.
    assert.equal(numbers.size, 31);
    assertSameContents(
      await contentsOf(environment),
      JSON.parse(replaced(JSON.stringify(expected), importedId)),
    );
    for (const id of [
      ...environment.records.keys(),
      ...environment.uploads.keys(),
    ])
      assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  });

  it('imports a dump of the older format, with the published version of every published record, identically', async () => {
    let filled = 0;
    const path = await rewrite(withoutAssets, 'older.dump.zip', (line) => {
      if (line.current.meta.status === 'published' && !line.published) {
        line.published = structuredClone(line.current);
        filled++;
      }
    });
    assert.equal(filled, 12);

    const { environment } = await importInto(path, 'older-format');

    assertSameContents(await contentsOf(environment), expected);
  });

  it('refuses records DatoCMS reports as invalid before writing anything', async () => {
    const { second, draft } = project.ids.records;
    const path = await rewrite(withoutAssets, 'invalid.dump.zip', (line) => {
      if (line.id === second)
        line.current.meta.is_published_version_valid = false;
      // Article saves no invalid drafts.
      if (line.id === draft) line.current.meta.is_current_version_valid = false;
    });

    await assert.rejects(importInto(path, 'invalid'), (error: any) => {
      assert.equal(error.code, 'INVALID_RECORDS');
      assert.match(error.message, /^2 records of the dump/);
      assert.ok(
        error.message.includes(`article ${second}: published version invalid`),
      );
      assert.ok(
        error.message.includes(`article ${draft}: current version invalid`),
      );
      return true;
    });
    assert.deepEqual(project.cma.environment('invalid').writes, []);
  });

  it('accepts an invalid draft of a model that saves invalid drafts', async () => {
    const two = project.ids.records.children[1]!;
    const path = await rewrite(withoutAssets, 'draft.dump.zip', (line) => {
      if (line.id === two) line.current.meta.is_current_version_valid = false;
    });

    const { result } = await importInto(path, 'invalid-draft');

    assert.equal(result.counts.records, 16);
  });

  it('stops at the first CMA rejection, naming the step and the CMA code, and starts no task afterwards', async () => {
    const source = emptyEnvironment(project.cma, 'categories');
    const { create } = writer(source);
    const categories: string[] = [];
    for (let index = 0; index < 3 * CONCURRENCY; index++)
      categories.push(await create('category', { name: `C${index}` }));
    const path = await exportTo(source);
    const failing = categories[0]!;

    const importing = importInto(path, 'rejecting', (environment) =>
      environment.failWhen(
        (call) =>
          call.method === 'items.rawCreate' && call.args[0].data.id === failing,
        apiError('POST', '/items', 422, 'INVALID_FIELD', {
          field: 'name',
          code: 'VALIDATION_REQUIRED',
        }),
      ),
    );

    await assert.rejects(importing, (error: any) => {
      assert.equal(error.code, 'IMPORT_FAILED');
      assert.equal(
        error.message,
        `The import stopped while creating record ${failing} (category): the CMA answered POST /items with 422 INVALID_FIELD (name: VALIDATION_REQUIRED).`,
      );
      return true;
    });
    const target = project.cma.environment('rejecting');
    // Only the tasks already running when the failure came back.
    assert.ok(createsOf(target).length <= CONCURRENCY);
    const calls = target.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(target.calls.length, calls);
  });

  it('does not recreate a schedule whose time has passed, and counts it', async () => {
    const source = emptyEnvironment(project.cma, 'scheduled');
    const { api, create } = writer(source);
    const passed = await create('author', { name: 'Passed' });
    const coming = await create('author', { name: 'Coming' });
    // Scheduled two days ago, for yesterday.
    project.cma.timeShift = -2 * 86_400_000;
    try {
      await api.scheduledPublication.create(passed, {
        publication_scheduled_at: inDays(-1),
      });
    } finally {
      project.cma.timeShift = 0;
    }
    await api.scheduledPublication.create(coming, {
      publication_scheduled_at: inDays(10),
    });

    const { result, environment } = await importInto(
      await exportTo(source),
      'rescheduled',
    );

    assert.equal(result.skippedSchedules, 1);
    assert.deepEqual(
      environment.writes
        .filter((call) => call.method === 'scheduledPublication.create')
        .map((call) => call.args[0]),
      [coming],
    );
    assert.equal(
      environment.records.get(passed)!.meta.publication_scheduled_at,
      null,
    );
  });
});
