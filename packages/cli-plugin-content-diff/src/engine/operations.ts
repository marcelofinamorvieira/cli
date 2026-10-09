import { object } from './codec';
import { ContentError } from './errors';
import type { JsonValue } from './types';

/**
 * What the destination held when the diff was generated, checked before the
 * first operation that touches a record, upload or folder.
 */
export type Expectation =
  | { currentVersion: string | null; publishedUpdatedAt: string | null }
  | { hash: string };

/** One line of a diff: a single CMA call, or the plugin's reorder routine. */
export interface Operation {
  op: OperationName;
  id?: string;
  label: string;
  expect?: Expectation;
  /** A new file: an entry of the diff zip, or a URL. */
  file?: string;
  url?: string;
  md5?: string;
  /** The body passed to the SDK method. */
  data?: JsonValue;
}

/** Every operation a diff may contain, and what its line carries. */
export const OPERATIONS = {
  'folder.create': { id: true, data: 'object' },
  'folder.update': { id: true, data: 'object' },
  'folder.delete': { id: true },
  'folders.reorder': { data: 'array' },
  'upload.create': { id: true, data: 'object', upload: true },
  'upload.replace': { id: true, data: 'object', upload: true },
  'upload.update': { id: true, data: 'object' },
  'upload.delete': { id: true },
  'record.create': { id: true, data: 'object' },
  'record.update': { id: true, data: 'object' },
  'record.publish': { id: true },
  'record.unpublish': { id: true },
  'record.delete': { id: true },
  'records.reorder': { data: 'object' },
  'schedule.publication.create': { id: true, data: 'object' },
  'schedule.publication.delete': { id: true },
  'schedule.unpublishing.create': { id: true, data: 'object' },
  'schedule.unpublishing.delete': { id: true },
} as const satisfies Record<
  string,
  { id?: true; data?: 'object' | 'array'; upload?: true }
>;
export type OperationName = keyof typeof OPERATIONS;

/** Operations that create a record, upload or folder under a new ID. */
export const CREATES = new Set<OperationName>([
  'record.create',
  'upload.create',
  'folder.create',
]);

/** What an operation creates or first touches, for the destination checks. */
export function operationKind(
  name: OperationName,
): 'record' | 'upload' | 'collection' | null {
  if (name.startsWith('record.') || name.startsWith('schedule.'))
    return 'record';
  if (name.startsWith('upload.')) return 'upload';
  if (name.startsWith('folder.')) return 'collection';
  return null;
}

const nullableString = (value: unknown) =>
  value === null || typeof value === 'string';

/**
 * Refuses a line that is not a known operation with the fields it needs,
 * before the first write of a run.
 */
export function assertOperation(
  value: unknown,
  where: string,
  hasEntry: (name: string) => boolean,
): asserts value is Operation {
  const invalid = (problem: string): never => {
    throw new ContentError('INVALID_DIFF', `${where}: ${problem}`, { where });
  };
  if (!object(value)) invalid('expected an operation object.');
  const line = value as Record<string, unknown>;
  const name = line.op;
  if (typeof name !== 'string' || !Object.hasOwn(OPERATIONS, name))
    invalid(`unknown operation ${JSON.stringify(name)}.`);
  const spec: { id?: true; data?: string; upload?: true } =
    OPERATIONS[name as OperationName];
  if (typeof line.label !== 'string') invalid('"label" must be a string.');
  // IDs go into request paths, so only DatoCMS ID characters are accepted.
  if (spec.id && (typeof line.id !== 'string' || !/^[\w-]+$/.test(line.id)))
    invalid('"id" must be a DatoCMS ID.');
  if (spec.data === 'object' && !object(line.data))
    invalid('"data" must be an object.');
  if (spec.data === 'array' && !Array.isArray(line.data))
    invalid('"data" must be an array.');
  if (spec.upload) {
    if (typeof line.md5 !== 'string') invalid('"md5" must be a string.');
    if (typeof line.file === 'string') {
      if (!hasEntry(line.file)) invalid(`the diff has no file ${line.file}.`);
    } else if (typeof line.url !== 'string')
      invalid('"file" or "url" must be a string.');
  }
  if (line.expect !== undefined) {
    const expect = line.expect;
    const kind = operationKind(name as OperationName);
    const valid =
      object(expect) &&
      (kind === 'record'
        ? nullableString(expect.currentVersion) &&
          nullableString(expect.publishedUpdatedAt)
        : typeof expect.hash === 'string');
    if (!valid || CREATES.has(name as OperationName))
      invalid('"expect" does not fit the operation.');
  }
}
