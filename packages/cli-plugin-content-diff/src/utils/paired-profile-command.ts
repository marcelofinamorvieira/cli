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
import { jsonFailure } from './command-helpers';
import { resolveLinkedSiteToken, resolveProfileApiToken } from './profile-auth';

/** One project: the root client manages environments. */
interface ProjectEndpoint {
  rootClient: CmaClient.Client;
  buildEnvironmentClient: (environmentId: string) => CmaClient.Client;
}

type ClientFlags = {
  'api-token'?: string;
  'base-url'?: string;
  'log-level'?: LogLevelFlagEnum;
  'log-mode'?: LogLevelModeEnum;
  json?: boolean;
};

/**
 * `content:diff` can read its source and destination through two configured
 * profiles, while `CmaClientCommand` resolves exactly one profile, and builds
 * its client, during `init`. This base accepts the native single-profile
 * flags and resolves each endpoint's token in the native order: explicit
 * token, then the linked project's OAuth token, then the profile's
 * environment variable. Clients are built in `run`, after the command checks
 * its own options.
 */
export abstract class PairedProfileCommand extends DatoConfigCommand {
  static baseFlags = CmaClientCommand.baseFlags;

  protected datoProfileConfig?: ProfileConfig;
  protected profileId = 'default';

  protected async init(): Promise<void> {
    await super.init();
    const { flags, raw } = await this.parse(this.ctor);
    if (
      flags['source-profile'] !== undefined ||
      flags['destination-profile'] !== undefined
    ) {
      if (!flags['source-profile'] || !flags['destination-profile'])
        this.error('Both source and destination profiles must be nonempty.');
      if (
        raw.some(
          (token) =>
            token.type === 'flag' &&
            ['profile', 'api-token'].includes(token.flag),
        )
      )
        this.error(
          'Use paired source/destination profiles and token flags together; --profile and --api-token select a single project.',
        );
      return;
    }
    // The same checks as DatoProfileConfigCommand, which cannot be the base:
    // with paired profiles a config file always holds several of them.
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

  /**
   * Clients for one project: the named paired profile with its own token
   * flag, or, without a profile ID, the single profile with `--api-token`.
   */
  protected async endpoint(
    profileId?: string,
    explicitApiToken?: string,
  ): Promise<ProjectEndpoint> {
    const { flags: parsed } = await this.parse(this.ctor);
    const flags = parsed as ClientFlags;
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
        resolveLinkedSiteToken({ siteId, organizationId }),
    });
    if (!apiToken && !profileId)
      // The same message and suggestion as CmaClientCommand.
      this.error('Cannot find an API token to use to call DatoCMS!', {
        suggestions: [
          `The API token to use is determined by looking at:
* The --api-token flag
* The ${environmentName} environment variable (we look inside .env.local and .env too)
* A linked project via "datocms link" (requires "datocms login" first)`,
        ],
      });
    if (!apiToken)
      this.error(
        `No API token is available for profile "${selectedProfileId}". Link the profile after login, set ${environmentName}, or provide its endpoint API token flag.`,
        {
          suggestions: [
            'Provide the matching --source-api-token or --destination-api-token.',
            `Set ${environmentName} (including .env.local or .env).`,
            'Run "datocms login" and "datocms link" to use a linked project.',
          ],
        },
      );
    const logLevel = flags['log-level'] ?? profile?.logLevel;
    const logMode = flags['log-mode'] ?? profile?.logMode;
    const options: CmaClient.ClientConfigOptions = {
      apiToken,
      baseUrl: flags['base-url'] ?? profile?.baseUrl,
      // Unlike CmaClientCommand, `--output` does not silence request logs:
      // here it names the generated script, not an output format.
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
    };
    return {
      rootClient: CmaClient.buildClient(options),
      buildEnvironmentClient: (environment) =>
        CmaClient.buildClient({ ...options, environment }),
    };
  }

  protected async catch(
    error: Error & { exitCode?: number | undefined },
  ): Promise<void> {
    if (this.jsonEnabled()) return this.logJson(jsonFailure(error));
    // CmaClientCommand's handler gives authorization and permission failures
    // their native messages and suggestions. It is not this class's base (see
    // above), so it is called directly.
    return Reflect.apply(
      Reflect.get(CmaClientCommand.prototype, 'catch'),
      this,
      [error],
    );
  }

  protected progress(message: string): void {
    if (!this.jsonEnabled()) this.logToStderr(message);
  }
}
