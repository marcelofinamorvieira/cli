import type { CmaClient } from '@datocms/cli-utils';

/**
 * Public CMA operations available in generated content scripts. These are SDK
 * signatures and real server responses. Calls execute immediately; nothing is
 * simulated, recorded as desired content, or replanned during application.
 * Parts transport awaited operations across IPC, so arguments/results must be
 * transferable data (progress callbacks and async iterators stay outside parts).
 */
export interface ContentMigrationClient {
  readonly items: Readonly<
    Pick<
      CmaClient.Client['items'],
      'create' | 'update' | 'find' | 'destroy' | 'publish' | 'unpublish'
    >
  >;
  readonly fields: Readonly<
    Pick<CmaClient.Client['fields'], 'find' | 'update'>
  >;
  readonly scheduledPublication: Readonly<
    Pick<CmaClient.Client['scheduledPublication'], 'create' | 'destroy'>
  >;
  readonly scheduledUnpublishing: Readonly<
    Pick<CmaClient.Client['scheduledUnpublishing'], 'create' | 'destroy'>
  >;
  readonly uploads: Readonly<
    Pick<
      CmaClient.Client['uploads'],
      | 'create'
      | 'find'
      | 'update'
      | 'destroy'
      | 'createFromLocalFile'
      | 'updateFromLocalFile'
    >
  >;
  readonly uploadCollections: Readonly<
    Pick<
      CmaClient.Client['uploadCollections'],
      'create' | 'find' | 'update' | 'destroy'
    >
  >;
}
