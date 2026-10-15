import type { CmaClient } from '@datocms/cli-utils';
import type { RawSchema } from '../schema';
import { userError } from '../utils/errors';
import { ZipReader } from './zip';

/*
 * A dump is a zip holding:
 *
 *   manifest.json             what was exported, from where and when (DumpManifest)
 *   schema.json               the environment's schema, as the CMA returns it (RawSchema)
 *   records/000001.jsonl …    one RecordLine per record
 *   uploads/000001.jsonl …    one upload per line, as the SDK's uploads.list returns it
 *   upload-collections/…      one upload folder per line, as uploadCollections.list returns it
 *   assets/<id>/<filename>    the file of every asset, only with --include-assets (see assets.ts)
 */

export const DUMP_FORMAT = 'datocms-project-dump';
export const DUMP_VERSION = 1;

export const PLUGIN_VERSION: string = require('../../package.json').version;

export interface DumpManifest {
  format: typeof DUMP_FORMAT;
  version: typeof DUMP_VERSION;
  createdAt: string;
  pluginVersion: string;
  site: { id: string; environment: string; primary: boolean };
  locales: string[];
  includesAssets: boolean;
  counts: { records: number; uploads: number; uploadCollections: number };
}

/** A record or block exactly as `GET /items` returns it. */
export interface ItemResource {
  id: string;
  type: 'item';
  attributes: Record<string, unknown>;
  relationships: { item_type: { data: { id: string; type: 'item_type' } } };
  meta: CmaClient.RawApiTypes.ItemMeta;
}

/**
 * One record of a dump: its current version, read with its blocks nested,
 * and its published version when it differs from the current one (the
 * record has unpublished changes). A record whose published version is its
 * current one has `published: null`.
 */
export interface RecordLine {
  id: string;
  current: ItemResource;
  published: ItemResource | null;
}

export type Upload = CmaClient.ApiTypes.Upload;
export type UploadCollection = CmaClient.ApiTypes.UploadCollection;

/** An opened dump. Close its zip once done. */
export interface Dump {
  path: string;
  manifest: DumpManifest;
  schema: RawSchema;
  zip: ZipReader;
}

/** Opens a dump and reads its manifest and schema. */
export async function openDump(path: string): Promise<Dump> {
  const notADump = (reason: string) =>
    userError(
      'INVALID_DUMP',
      `${path} is not a dump written by content:export: ${reason}.`,
    );
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(path);
  } catch (error) {
    throw notADump(
      `it is not a readable zip (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  try {
    if (!zip.has('manifest.json') || !zip.has('schema.json'))
      throw notADump('it has no manifest.json or schema.json');
    const manifest = (await zip.json('manifest.json')) as DumpManifest;
    if (manifest?.format !== DUMP_FORMAT || manifest.version !== DUMP_VERSION)
      throw notADump(
        `its manifest is not one of a version ${DUMP_VERSION} ${DUMP_FORMAT}`,
      );
    const schema = (await zip.json('schema.json')) as RawSchema;
    return { path, manifest, schema, zip };
  } catch (error) {
    zip.close();
    throw error instanceof SyntaxError
      ? notADump('its manifest or schema is not valid JSON')
      : error;
  }
}
