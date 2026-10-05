import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CmaClient,
  DatoConfigCommand,
  DatoProfileConfigCommand,
  type LogLevelFlagEnum,
  type LogLevelModeEnum,
  logLevelMap,
} from '@datocms/cli-utils';
import { ContentError } from '../engine/errors';
import type { SchemaState } from '../engine/types';
import { resolveProfileApiToken } from './profile-auth';
import { RedactedCmaClientCommand } from './redacted-cma-client-command';

export interface ContentEndpoint {
  rootClient: CmaClient.Client;
  buildEnvironmentClient: (environmentId: string) => CmaClient.Client;
}

type AuthenticationFlags = {
  'base-url'?: string;
  'log-level'?: LogLevelFlagEnum;
  'log-mode'?: LogLevelModeEnum;
  json?: boolean;
};

/** Keep profile/OAuth resolution in cli-utils and share its client settings. */
export abstract class ContentCommand extends RedactedCmaClientCommand {
  protected async init(): Promise<void> {
    const { flags, raw } = await this.parse(this.ctor);
    const dual =
      flags['source-profile'] !== undefined ||
      flags['destination-profile'] !== undefined;
    if (dual) {
      if (!flags['source-profile'] || !flags['destination-profile'])
        this.error('Both source and destination profiles must be nonempty.');
      if (
        raw.some(
          (token) =>
            token.type === 'flag' &&
            ['profile', 'api-token'].includes(token.flag),
        )
      ) {
        this.error(
          'Use paired source/destination profiles and token flags together; --profile and --api-token select a single project.',
        );
      }
      await Reflect.apply(
        Reflect.get(DatoConfigCommand.prototype, 'init'),
        this,
        [],
      );
    } else {
      // Initialize the selected profile without building a duplicate root client.
      await Reflect.apply(
        Reflect.get(DatoProfileConfigCommand.prototype, 'init'),
        this,
        [],
      );
    }
  }

  protected async endpoint(
    profileId?: string,
    explicitApiToken?: string,
  ): Promise<ContentEndpoint> {
    let options: CmaClient.ClientConfigOptions;
    if (!profileId) {
      options = await this.buildBaseClientInitializationOptions();
    } else {
      this.requireDatoConfig();
      const profile = this.datoConfig!.profiles[profileId];
      if (!profile)
        this.error(
          `Profile "${profileId}" is not defined in "${this.datoConfigRelativePath}".`,
        );
      const { apiToken, environmentName } = await resolveProfileApiToken({
        explicitApiToken,
        profileConfig: profile,
        profileId,
        resolveLinkedSiteToken: async (siteId, organizationId) => {
          const resolver = Reflect.get(this, 'resolveTokenFromSiteId');
          return Reflect.apply(resolver, this, [siteId, organizationId]);
        },
      });
      if (!apiToken)
        this.error(
          `No API token is available for profile "${profileId}". Link the profile after login, set ${environmentName}, or provide its endpoint API token flag.`,
        );
      const { flags: parsed } = await this.parse(this.ctor);
      const flags = parsed as AuthenticationFlags;
      const logLevel = flags['log-level'] ?? profile.logLevel;
      const logMode = flags['log-mode'] ?? profile.logMode;
      options = this.credentialRedactor.protectClientOptions({
        apiToken,
        baseUrl: flags['base-url'] ?? profile.baseUrl,
        logLevel:
          flags.json || !logLevel
            ? CmaClient.LogLevel.NONE
            : logLevelMap[logLevel],
        logFn: (message) => {
          if (logMode === 'file')
            appendFileSync('./api-calls.log', `${message}\n`, 'utf8');
          else if (logMode === 'directory') {
            const requestId = /^\[([\d]+)\]/.exec(message)?.[1];
            if (!requestId) return;
            mkdirSync('./api-calls', { recursive: true });
            appendFileSync(
              join('./api-calls', `${requestId}.log`),
              `${message}\n`,
              'utf8',
            );
          } else this.log(message);
        },
      });
    }
    return {
      rootClient: CmaClient.buildClient(options),
      buildEnvironmentClient: (environmentId) =>
        CmaClient.buildClient({ ...options, environment: environmentId }),
    };
  }

  // cli-utils silences request logs for any command with an `output` flag,
  // which content:diff uses for its bundle directory.
  protected async buildBaseClientInitializationOptions(): Promise<
    Partial<CmaClient.ClientConfigOptions> & { apiToken: string }
  > {
    const options = await super.buildBaseClientInitializationOptions();
    const { flags: parsed } = await this.parse(this.ctor);
    const flags = parsed as AuthenticationFlags;
    const logLevel = flags['log-level'] ?? this.datoProfileConfig?.logLevel;
    return {
      ...options,
      logLevel:
        flags.json || !logLevel
          ? CmaClient.LogLevel.NONE
          : logLevelMap[logLevel],
    };
  }

  // The host reports failures as an object dump on stdout. Under --json, emit
  // a JSON error object instead, with the same exit status. Fields are picked
  // explicitly: oclif's parse errors also carry the parsed flags, tokens
  // included.
  protected async catch(
    error: Error & { exitCode?: number | undefined },
  ): Promise<void> {
    if (!this.jsonEnabled()) return super.catch(error);
    this.credentialRedactor.redactError(error);
    const { code, details, suggestions, keptForkEnvironmentId, oclif } =
      error as Error & {
        code?: string;
        details?: Record<string, unknown>;
        suggestions?: string[];
        keptForkEnvironmentId?: string;
        oclif?: { exit?: number };
      };
    process.exitCode ??= error.exitCode ?? oclif?.exit ?? 1;
    this.logJson(
      this.toErrorJson({
        name: error.name,
        message: error.message,
        code: code ?? apiErrorCode(error),
        details,
        suggestions,
        keptForkEnvironmentId,
      }),
    );
  }

  protected progress(message: string): void {
    if (!this.jsonEnabled()) this.logToStderr(message);
  }
}

// CMA client errors carry their codes in the JSON:API errors array.
function apiErrorCode(error: Error): string | undefined {
  const { errors } = error as {
    errors?: Array<{ attributes?: { code?: unknown } }>;
  };
  const code = Array.isArray(errors) ? errors[0]?.attributes?.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function concurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 16)
    throw new ContentError(
      'INVALID_CONCURRENCY',
      'Concurrency must be an integer from 1 to 16.',
    );
  return value;
}

export function selectedModels(
  schema: SchemaState,
  selection: string,
): string[] {
  const regular = schema.models.filter((model) => !model.block);
  if (selection === 'all') return regular.map((model) => model.id).sort();
  const keys = [...new Set(selection.split(',').map((key) => key.trim()))];
  if (keys.some((key) => !key || key === 'all'))
    throw new ContentError(
      'INVALID_MODEL_SELECTION',
      '--item-types must be "all" or comma-separated model API keys.',
    );
  return keys
    .map((key) => {
      const model = regular.find((model) => model.apiKey === key);
      if (!model)
        throw new ContentError(
          'INVALID_MODEL_SELECTION',
          `Source model "${key}" does not exist or is a block.`,
        );
      return model.id;
    })
    .sort();
}

export function environmentId(
  requested: string,
  environments: Array<{ id: string; meta: { primary: boolean } }>,
): string {
  const environment =
    requested === 'primary'
      ? environments.find((value) => value.meta.primary)
      : environments.find((value) => value.id === requested);
  if (!environment)
    throw new ContentError(
      'ENVIRONMENT_NOT_FOUND',
      `Environment "${requested}" is not available.`,
    );
  return environment.id;
}
