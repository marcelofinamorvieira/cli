import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CmaClient,
  CmaClientCommand,
  DatoConfigCommand,
  type LogLevelFlagEnum,
  type LogLevelModeEnum,
  type ProfileConfig,
  logLevelMap,
} from '@datocms/cli-utils';
import { ContentError, contentErrorReport } from '../engine/errors';
import type { SchemaState } from '../engine/types';
import { CredentialRedactor } from './credential-redaction';
import { resolveLinkedSiteToken, resolveProfileApiToken } from './profile-auth';

export interface ContentEndpoint {
  rootClient: CmaClient.Client;
  buildEnvironmentClient: (environmentId: string) => CmaClient.Client;
}

type AuthenticationFlags = {
  'api-token'?: string;
  'base-url'?: string;
  'log-level'?: LogLevelFlagEnum;
  'log-mode'?: LogLevelModeEnum;
  json?: boolean;
};

/**
 * Multi-profile authentication adapter built on the public config command,
 * credential reader and Dashboard SDK. Client creation stays lazy so argument
 * validation completes before any authentication or network access.
 */
export abstract class ContentCommand extends DatoConfigCommand {
  static baseFlags = CmaClientCommand.baseFlags;

  protected datoProfileConfig?: ProfileConfig;
  protected profileId = 'default';
  private redactor?: CredentialRedactor;

  protected get credentialRedactor(): CredentialRedactor {
    if (!this.redactor) this.redactor = new CredentialRedactor();
    return this.redactor;
  }

  protected async init(): Promise<void> {
    await super.init();
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
      return;
    }
    const profileId = flags.profile as string | undefined;
    if (profileId) {
      if (!this.datoConfig)
        this.error(
          `Requested profile "${profileId}" but cannot find config file`,
          {
            suggestions: [
              `Create profile with "${this.config.bin} profile:set ${profileId}"`,
            ],
          },
        );
      if (!Object.hasOwn(this.datoConfig.profiles, profileId))
        this.error(
          `Requested profile "${profileId}" is not defined in config file "${this.datoConfigRelativePath}"`,
          {
            suggestions: [
              `Configure it with "${this.config.bin} profile:set ${profileId}"`,
            ],
          },
        );
    } else if (
      this.datoConfig &&
      Object.keys(this.datoConfig.profiles).length > 1
    ) {
      this.error(
        `Multiple profiles detected in config file "${this.datoConfigRelativePath}"`,
        {
          suggestions: [
            'Specify --profile or DATOCMS_PROFILE (including .env.local and .env).',
          ],
        },
      );
    }
    this.profileId = profileId || 'default';
    this.datoProfileConfig = this.datoConfig?.profiles[this.profileId];
  }

  protected async linkedSiteToken(
    siteId: string,
    organizationId?: string,
  ): Promise<string> {
    return resolveLinkedSiteToken({
      siteId,
      organizationId,
      redactor: this.credentialRedactor,
    });
  }

  protected async endpoint(
    profileId?: string,
    explicitApiToken?: string,
  ): Promise<ContentEndpoint> {
    const { flags: parsed } = await this.parse(this.ctor);
    const flags = parsed as AuthenticationFlags;
    let profile = this.datoProfileConfig;
    if (profileId) {
      this.requireDatoConfig();
      if (!Object.hasOwn(this.datoConfig!.profiles, profileId))
        this.error(
          `Profile "${profileId}" is not defined in "${this.datoConfigRelativePath}".`,
        );
      profile = this.datoConfig!.profiles[profileId];
    }
    const selectedProfileId = profileId ?? this.profileId ?? 'default';
    const { apiToken, environmentName } = await resolveProfileApiToken({
      explicitApiToken: profileId ? explicitApiToken : flags['api-token'],
      profileConfig: profile ?? {},
      profileId: selectedProfileId,
      resolveLinkedSiteToken: (siteId, organizationId) =>
        this.linkedSiteToken(siteId, organizationId),
    });
    if (!apiToken)
      this.error(
        `No API token is available for profile "${selectedProfileId}". Link the profile after login, set ${environmentName}, or provide its endpoint API token flag.`,
        {
          suggestions: [
            profileId
              ? 'Provide the matching --source-api-token or --destination-api-token.'
              : 'Provide --api-token.',
            `Set ${environmentName} (including .env.local or .env).`,
            'Run "datocms login" and "datocms link" to use a linked project.',
          ],
        },
      );
    const logLevel = flags['log-level'] ?? profile?.logLevel;
    const logMode = flags['log-mode'] ?? profile?.logMode;
    const options = this.credentialRedactor.protectClientOptions({
      apiToken,
      baseUrl: flags['base-url'] ?? profile?.baseUrl,
      logLevel:
        flags.json || !logLevel
          ? CmaClient.LogLevel.NONE
          : logLevelMap[logLevel],
      logFn: (message: string) => {
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
    return {
      rootClient: CmaClient.buildClient(options),
      buildEnvironmentClient: (environmentId) =>
        CmaClient.buildClient({ ...options, environment: environmentId }),
    };
  }

  // The host reports failures as an object dump on stdout. Under --json, emit
  // a JSON error object instead, with the same exit status. Fields are picked
  // explicitly: oclif's parse errors also carry the parsed flags, tokens
  // included.
  protected async catch(
    error: Error & { exitCode?: number | undefined },
  ): Promise<void> {
    if (error instanceof CmaClient.ApiError && !('suggestions' in error)) {
      const suggestions = error.findError('INVALID_AUTHORIZATION_HEADER')
        ? [
            'Run "datocms login" to re-authenticate',
            'Use --api-token to provide a valid token',
          ]
        : error.findError('INSUFFICIENT_PERMISSIONS')
          ? [
              'Check your project permissions in the DatoCMS dashboard',
              'Use --api-token to provide a token with the required permissions',
            ]
          : undefined;
      if (suggestions) Object.assign(error, { suggestions });
    }
    this.credentialRedactor.redactError(error);
    if (!this.jsonEnabled()) return super.catch(error);
    const { oclif } = error as Error & { oclif?: { exit?: number } };
    process.exitCode ??= error.exitCode ?? oclif?.exit ?? 1;
    this.logJson(
      this.toErrorJson(
        this.credentialRedactor.redactJsonValue(contentErrorReport(error)),
      ),
    );
  }

  protected progress(message: string): void {
    if (!this.jsonEnabled()) this.logToStderr(message);
  }
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
