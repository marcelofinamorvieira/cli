import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { rawVideoBlocked, userError } from '../utils/errors';
import type { Upload } from './format';

/** What downloading an asset's file needs. */
export type AssetFile = Pick<Upload, 'id' | 'filename' | 'url'>;

/** Where an asset's file sits in a dump. */
export function assetEntryName(id: string, filename: string): string {
  return `assets/${id}/${filename.replace(/[/\\]/g, '_')}`;
}

/**
 * The stored file of an asset. Without these parameters the CDN serves
 * images with default optimizations applied and SVG files sanitized.
 */
function originalFileUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('skip-default-optimizations', 'true');
  parsed.searchParams.set('svg-sanitize', 'false');
  return parsed.toString();
}

/**
 * Downloads the original file of an asset. `purpose` completes the message
 * for a video file the CDN refuses to serve.
 */
export async function downloadAsset(
  asset: AssetFile,
  purpose: string,
): Promise<Readable> {
  const response = await fetch(originalFileUrl(asset.url));
  if (response.status === 422) throw rawVideoBlocked(asset.id, purpose);
  if (!response.ok || !response.body)
    throw userError(
      'ASSET_DOWNLOAD_FAILED',
      `Asset ${asset.id} could not be downloaded (HTTP ${response.status}).`,
    );
  return Readable.fromWeb(response.body as ReadableStream);
}
