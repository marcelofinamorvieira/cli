import type { Client } from '@datocms/cma-client-node';

/** Optional runner services for migrations that need managed execution. */
export interface MigrationExecutionContext {
  readonly version: 1;
  readonly migrationPath: string;
  readonly environmentId: string;
  readonly sourceEnvironmentId: string;
  readonly inPlace: boolean;
  readonly allowPrimary: boolean;
  readonly primaryEnvironmentId: string | null;
  readonly signal: AbortSignal;
  readonly trackingModel: {
    readonly id: string;
    readonly apiKey: string;
    readonly createdByThisRun: boolean;
  } | null;
  readonly rootClient: Client;
  readonly buildEnvironmentClient: (environmentId: string) => Client;
  readonly log: (message: string) => void;

  /**
   * Enable cooperative signal handling before starting work. Cleanup applies
   * only to an environment fork owned by this runner, never an in-place run.
   * It also covers failure to save the completed migration's receipt.
   */
  activate(options?: { discardOwnedForkOnFailure?: boolean }): void;
}
