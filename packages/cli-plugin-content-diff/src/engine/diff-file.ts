import { object } from './codec';
import { ContentError } from './errors';
import type { MigrationTrackingBinding } from './migration-schema';
import { type Operation, assertOperation } from './operations';
import type { PlanCounts, PlanOptions } from './types';
import { ZipReader, ZipWriter } from './zip';

const FORMAT = 'datocms-content-diff';
const VERSION = 1;

export const PLUGIN_VERSION: string = require('../../package.json').version;

/** The first entry apply reads: what the diff was generated from and for. */
export interface DiffManifest {
  format: typeof FORMAT;
  version: typeof VERSION;
  createdAt: string;
  pluginVersion: string;
  /** Whether new and replaced assets are uploaded from files in the diff. */
  includesAssets: boolean;
  source: {
    kind: 'environment' | 'dump';
    siteId: string;
    environmentId: string;
    /** The dump file name, for a diff generated from a dump. */
    dump?: string;
  };
  destination: { siteId: string; environmentId: string };
  /** The destination schema hash, without the migration tracking model. */
  schemaHash: string;
  sourceTracking: MigrationTrackingBinding;
  destinationTracking: MigrationTrackingBinding;
  options: PlanOptions;
  counts: PlanCounts;
  operations: number;
}

/**
 * Writes a diff: its operations in run order, the asset files they upload
 * (copied from the source dump), and the manifest.
 */
export async function writeDiff(args: {
  path: string;
  manifest: Omit<
    DiffManifest,
    'format' | 'version' | 'createdAt' | 'pluginVersion' | 'operations'
  >;
  operations: AsyncIterable<Operation>;
  /** The source dump, when asset files are copied from it. */
  files?: ZipReader;
}): Promise<number> {
  const zip = new ZipWriter(args.path);
  try {
    const lines = zip.jsonLines('operations');
    const files: string[] = [];
    for await (const operation of args.operations) {
      if (operation.file) files.push(operation.file);
      await lines.write(operation);
    }
    lines.end();
    for (const name of files) {
      if (!args.files?.has(name))
        throw new ContentError(
          'INVALID_DUMP',
          `The source dump has no file ${name}.`,
        );
      zip.addStream(name, () => args.files!.stream(name));
    }
    const manifest: DiffManifest = {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      ...args.manifest,
      operations: lines.count,
    };
    zip.addBuffer('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    await zip.close();
    return lines.count;
  } catch (error) {
    await zip.discard();
    throw error;
  }
}

/** An opened diff: its manifest and its operations, read as a stream. */
export class DiffFile {
  private constructor(
    readonly zip: ZipReader,
    readonly manifest: DiffManifest,
  ) {}

  static async open(path: string): Promise<DiffFile> {
    const { zip, manifest } = await ZipReader.openWithManifest(path, {
      code: 'INVALID_DIFF',
      format: FORMAT,
      version: VERSION,
      name: 'content diff',
    });
    const fields = manifest as Partial<DiffManifest>;
    if (
      !object(fields.destination) ||
      typeof fields.destination.siteId !== 'string' ||
      typeof fields.destination.environmentId !== 'string' ||
      typeof fields.schemaHash !== 'string' ||
      !object(fields.destinationTracking) ||
      !object(fields.counts)
    ) {
      zip.close();
      throw new ContentError(
        'INVALID_DIFF',
        'The diff manifest is missing its destination, schema or counts.',
      );
    }
    return new DiffFile(zip, fields as DiffManifest);
  }

  /** Every operation, checked, with where it sits in the diff. */
  async *operations(): AsyncGenerator<{ operation: Operation; where: string }> {
    for await (const { entry, line, value } of this.zip.lines('operations')) {
      const where = `${entry} line ${line}`;
      assertOperation(value, where, (name) => this.zip.has(name));
      yield { operation: value, where };
    }
  }

  close(): void {
    this.zip.close();
  }
}
