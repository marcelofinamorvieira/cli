import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { assertNotAborted } from './cancellation';
import { type CaptureSink, captureEnvironment } from './capture';
import { object } from './codec';
import { PLUGIN_VERSION } from './diff-file';
import { assetEntryName, originalFileUrl } from './emit';
import { ContentError } from './errors';
import { type RawSchema, readRawSchema, schemaFromRaw } from './schema';
import type { CaptureOptions, Client, SchemaState } from './types';
import { type JsonLinesWriter, ZipReader, ZipWriter } from './zip';

const FORMAT = 'datocms-project-dump';
const VERSION = 1;

export interface DumpManifest {
  format: typeof FORMAT;
  version: typeof VERSION;
  createdAt: string;
  pluginVersion: string;
  site: { id: string; environment: string; primary: boolean };
  locales: string[];
  includesAssets: boolean;
  counts: { records: number; uploads: number; uploadCollections: number };
}

interface Asset {
  id: string;
  url: string;
  filename: string;
  md5: string;
}

/** Streams a downloaded file and fails it when its MD5 is not `md5`. */
function verified(body: Readable, asset: Asset): Readable {
  const hash = createHash('md5');
  const check = new Transform({
    transform(chunk, _, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        hash.digest('hex') === asset.md5.toLowerCase()
          ? null
          : new ContentError(
              'CAPTURE_DRIFT',
              `Asset ${asset.id} changed while it was being exported.`,
            ),
      );
    },
  });
  body.on('error', (error) => check.destroy(error));
  return body.pipe(check);
}

async function download(asset: Asset): Promise<Readable> {
  const response = await fetch(originalFileUrl(asset.url));
  if (!response.ok || !response.body)
    throw new ContentError(
      'ASSET_DOWNLOAD_FAILED',
      `Asset ${asset.id} could not be downloaded (HTTP ${response.status}).`,
    );
  return verified(
    Readable.fromWeb(response.body as unknown as ReadableStream),
    asset,
  );
}

/**
 * Exports an environment to a dump: its schema, every record (current and
 * published versions, with their schedules), upload and folder as JSON
 * lines, and optionally every asset's file.
 */
export async function writeDump(args: {
  client: Client;
  environmentId: string;
  primary: boolean;
  path: string;
  includeAssets: boolean;
  options: CaptureOptions;
}): Promise<DumpManifest> {
  const { client, options } = args;
  const raw = await readRawSchema(client);
  const schema = schemaFromRaw(raw, args.environmentId);
  const zip = new ZipWriter(args.path);
  try {
    zip.addBuffer('schema.json', JSON.stringify(raw));
    // Capture reads records, then uploads, then folders, so each kind's
    // entries are finished before the next kind's start.
    let open: JsonLinesWriter | undefined;
    const writers = new Map<string, JsonLinesWriter>();
    const writer = (prefix: string) => {
      let next = writers.get(prefix);
      if (!next) {
        next = zip.jsonLines(prefix);
        writers.set(prefix, next);
      }
      if (open !== next) open?.end();
      open = next;
      return next;
    };
    const assets: Asset[] = [];
    let records = 0;
    const sink: CaptureSink = {
      async record(line) {
        await writer('records').write(line);
        if (++records % 1000 === 0)
          options.progress?.(`Exported ${records} records`);
      },
      async upload(upload) {
        await writer('uploads').write(upload);
        if (args.includeAssets) {
          const { id, url, filename, md5 } = upload as Asset;
          assets.push({ id, url, filename, md5 });
        }
      },
      async collection(collection) {
        await writer('upload-collections').write(collection);
      },
    };
    await captureEnvironment({ client, schema, sink, options });
    open?.end();
    for (const asset of assets)
      zip.addStream(assetEntryName(asset.id, asset.filename), () => {
        assertNotAborted(options.signal);
        return download(asset);
      });
    const manifest: DumpManifest = {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      site: {
        id: schema.siteId,
        environment: args.environmentId,
        primary: args.primary,
      },
      locales: schema.locales,
      includesAssets: args.includeAssets,
      counts: {
        records: writers.get('records')?.count ?? 0,
        uploads: writers.get('uploads')?.count ?? 0,
        uploadCollections: writers.get('upload-collections')?.count ?? 0,
      },
    };
    zip.addBuffer('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    if (assets.length)
      options.progress?.(`Downloading ${assets.length} asset files`);
    await zip.close();
    return manifest;
  } catch (error) {
    await zip.discard();
    throw error;
  }
}

/** An opened dump: its manifest, its schema, and its content as a capture. */
export class DumpFile {
  private constructor(
    readonly zip: ZipReader,
    readonly manifest: DumpManifest,
    readonly schema: SchemaState,
  ) {}

  static async open(path: string): Promise<DumpFile> {
    const { zip, manifest } = await ZipReader.openWithManifest(path, {
      code: 'INVALID_DUMP',
      format: FORMAT,
      version: VERSION,
      name: 'project dump',
    });
    try {
      if (
        !object(manifest.site) ||
        typeof manifest.site.environment !== 'string' ||
        !object(manifest.counts)
      )
        throw new ContentError(
          'INVALID_DUMP',
          `${path} is not a version ${VERSION} project dump.`,
        );
      const dump = manifest as unknown as DumpManifest;
      const schema = schemaFromRaw(
        (await zip.json('schema.json')) as RawSchema,
        dump.site.environment,
      );
      return new DumpFile(zip, dump, schema);
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  /** Reads the dump's records, uploads and folders, as a capture does. */
  async read(sink: CaptureSink, signal?: AbortSignal): Promise<void> {
    const counts = { records: 0, uploads: 0, uploadCollections: 0 };
    for (const [prefix, key, put] of [
      ['records', 'records', sink.record],
      ['uploads', 'uploads', sink.upload],
      ['upload-collections', 'uploadCollections', sink.collection],
    ] as const) {
      for await (const { value } of this.zip.lines(prefix)) {
        assertNotAborted(signal);
        counts[key]++;
        await put.call(sink, value as never);
      }
      if (counts[key] !== this.manifest.counts[key])
        throw new ContentError(
          'INVALID_DUMP',
          `The dump lists ${this.manifest.counts[key]} ${prefix} but holds ${counts[key]}; it is incomplete.`,
        );
    }
  }

  close(): void {
    this.zip.close();
  }
}
