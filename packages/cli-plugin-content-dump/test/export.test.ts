import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yauzl from 'yauzl';
import { type RecordLine, openDump } from '../src/dump/format';
import { exportEnvironment } from '../src/export/export-environment';
import { type FakeEnvironment, stubFetch } from './fixtures/cma';
import {
  PNG,
  type Project,
  SVG,
  buildProject,
  emptyEnvironment,
  writer,
} from './fixtures/project';

function exportTo(
  environment: FakeEnvironment,
  path: string,
  includeAssets = false,
) {
  return exportEnvironment({
    client: environment.client(),
    environment: { id: environment.id, primary: environment.primary },
    path,
    includeAssets,
    progress: () => {},
  });
}

async function entryNames(path: string): Promise<string[]> {
  const zip = await yauzl.openPromise(path, { lazyEntries: true });
  const names: string[] = [];
  for await (const entry of zip.eachEntry()) names.push(entry.fileName);
  zip.close();
  return names.sort();
}

/** A dump's manifest, schema and lines, and the contents of `files`. */
async function readDump(path: string, files: string[] = []) {
  const dump = await openDump(path);
  try {
    const lines = async (prefix: string) => {
      const values: any[] = [];
      for await (const { value } of dump.zip.lines(prefix)) values.push(value);
      return values;
    };
    const contents: Record<string, Buffer> = {};
    for (const name of files) {
      const chunks: Buffer[] = [];
      for await (const chunk of await dump.zip.stream(name)) chunks.push(chunk);
      contents[name] = Buffer.concat(chunks);
    }
    return {
      manifest: dump.manifest,
      schema: dump.schema,
      records: (await lines('records')) as RecordLine[],
      uploads: await lines('uploads'),
      folders: await lines('upload-collections'),
      files: contents,
    };
  } finally {
    dump.zip.close();
  }
}

/** The queries of the `GET /items` calls `run` makes `environment` receive. */
async function itemReads(environment: FakeEnvironment, run: () => unknown) {
  const from = environment.calls.length;
  await run();
  return environment.calls
    .slice(from)
    .filter((call) => call.method === 'request')
    .map((call) => call.args[0].queryParams);
}

describe('exportEnvironment', () => {
  let directory: string;
  let project: Project;
  let restoreFetch: () => void;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-dump-export-'));
    project = await buildProject(directory);
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    restoreFetch = stubFetch(project.cma);
    project.cma.fetched.length = 0;
  });

  afterEach(() => restoreFetch());

  it('writes the schema, records, uploads and folders, and a manifest that counts them', async () => {
    const path = join(directory, 'main.dump.zip');
    const manifest = await exportTo(project.main, path);

    assert.deepEqual(await entryNames(path), [
      'manifest.json',
      'records/000001.jsonl',
      'schema.json',
      'upload-collections/000001.jsonl',
      'uploads/000001.jsonl',
    ]);
    const dump = await readDump(path);
    assert.deepEqual(dump.manifest, manifest);
    assert.equal(manifest.format, 'datocms-project-dump');
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.site, {
      id: project.cma.siteId,
      environment: 'main',
      primary: true,
    });
    assert.deepEqual(manifest.locales, ['en', 'it']);
    assert.equal(manifest.includesAssets, false);
    assert.deepEqual(manifest.counts, {
      records: 17,
      uploads: 2,
      uploadCollections: 5,
    });
    const client = project.main.client();
    assert.deepEqual(dump.schema, {
      site: await client.site.rawFind({
        include: 'item_types,item_types.fields',
      }),
      workflows: await client.workflows.list(),
    });
    assert.deepEqual(
      dump.records.map((line) => line.id).sort(),
      [...project.main.records.keys()].sort(),
    );
    assert.deepEqual(
      dump.uploads.map((upload) => upload.id).sort(),
      Object.values(project.ids.uploads).sort(),
    );
    assert.deepEqual(
      dump.folders.map((folder) => folder.id).sort(),
      Object.values(project.ids.folders).sort(),
    );
    assert.deepEqual(project.cma.fetched, []);
  });

  it('reads records of models with block fields 30 per page with their blocks nested, and the others 500 per page', async () => {
    const environment = emptyEnvironment(project.cma, 'paged');
    const { create } = writer(environment);
    const author = await create('author', { name: 'Ada' });
    const articles: string[] = [];
    for (let index = 0; index < 65; index++)
      articles.push(
        await create('article', { title: { en: `${index}` }, author }),
      );
    const path = join(directory, 'paged.dump.zip');
    const [authorModel, articleModel] = ['author', 'article'].map(
      (apiKey) =>
        environment.schema.site.included.find(
          (entry) => entry.attributes.api_key === apiKey,
        ).id,
    );

    const reads = await itemReads(environment, () =>
      exportTo(environment, path),
    );

    const ofModel = (model: string) =>
      reads.filter((query) => query.filter.type === model);
    assert.deepEqual(
      ofModel(articleModel).map((query) => [
        query.nested,
        query.version,
        query.order_by,
        query.page,
      ]),
      [0, 30, 60].map((offset) => [
        true,
        'current',
        '_created_at_ASC',
        { offset, limit: 30 },
      ]),
    );
    assert.deepEqual(
      ofModel(authorModel).map((query) => [query.nested, query.page]),
      [[false, { offset: 0, limit: 500 }]],
    );
    const { records } = await readDump(path);
    assert.deepEqual(
      records.filter((line) => line.id !== author).map((line) => line.id),
      articles,
    );
    const [line] = records.filter((line) => line.id === articles[0]);
    assert.deepEqual(line!.current.attributes.blocks, []);
  });

  it('reads the published version only of records with unpublished changes', async () => {
    const { first } = project.ids.records;
    const path = join(directory, 'published.dump.zip');

    const reads = await itemReads(project.main, () =>
      exportTo(project.main, path),
    );

    assert.deepEqual(
      reads.filter((query) => query.version === 'published'),
      [
        {
          filter: { ids: first },
          nested: true,
          version: 'published',
          page: { limit: 1 },
        },
      ],
    );
    const { records } = await readDump(path);
    for (const line of records)
      if (line.id !== first) assert.equal(line.published, null, line.id);
    const edited = records.find((line) => line.id === first)!;
    assert.equal(edited.current.meta.status, 'updated');
    assert.deepEqual(edited.current.attributes.title, {
      en: 'First, edited',
      it: 'Primo',
    });
    assert.deepEqual(edited.published!.attributes.title, {
      en: 'First',
      it: 'Primo',
    });
    const labels = (blocks: any[]) =>
      blocks.map((block) => block.attributes.label ?? block.attributes.text);
    assert.deepEqual(labels(edited.published!.attributes.blocks as any[]), [
      'Kept',
      'Removed in the draft',
    ]);
    assert.deepEqual(labels(edited.current.attributes.blocks as any[]), [
      'Kept, edited',
      'Added in the draft',
    ]);
  });

  it('stores the original file of every asset under its ID, only with includeAssets', async () => {
    const { png, svg } = project.ids.uploads;
    const path = join(directory, 'assets.dump.zip');

    const manifest = await exportTo(project.main, path, true);

    assert.equal(manifest.includesAssets, true);
    const assets = [`assets/${png}/pixel.png`, `assets/${svg}/shape.svg`];
    assert.deepEqual(
      (await entryNames(path)).filter((name) => name.startsWith('assets/')),
      [...assets].sort(),
    );
    const { files } = await readDump(path, assets);
    assert.deepEqual(files[assets[0]!], PNG);
    assert.deepEqual(files[assets[1]!], SVG);
    assert.equal(project.cma.fetched.length, 2);
    for (const url of project.cma.fetched) {
      const { searchParams } = new URL(url);
      assert.equal(searchParams.get('skip-default-optimizations'), 'true');
      assert.equal(searchParams.get('svg-sanitize'), 'false');
    }
  });

  it('explains a video the asset CDN refuses to serve, and leaves neither the dump nor its partial file', async () => {
    const environment = emptyEnvironment(project.cma, 'videos');
    const localPath = join(directory, 'clip.mp4');
    await writeFile(localPath, Buffer.from('not really a video'));
    const video = await (
      environment.client() as any
    ).uploads.createFromLocalFile({ localPath });
    const path = join(directory, 'videos.dump.zip');

    await assert.rejects(exportTo(environment, path, true), (error: any) => {
      assert.equal(error.code, 'ASSET_DOWNLOAD_FAILED');
      assert.match(
        error.message,
        new RegExp(
          `^Asset ${video.id} is a video, .*Block serving URLs for raw video assets`,
        ),
      );
      return true;
    });
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.partial`), false);
  });
});
