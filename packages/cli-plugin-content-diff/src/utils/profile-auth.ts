import { type ProfileConfig, oclif, readCredentials } from '@datocms/cli-utils';
import * as DashboardClient from '@datocms/dashboard-client';
import type { ContentErrorCode } from '../engine/errors';

type ResolveLinkedSiteToken = (
  siteId: string,
  organizationId?: string,
) => Promise<string>;

export function profileApiTokenEnvironmentName(
  profileId: string,
  profileConfig: ProfileConfig,
): string {
  if (profileConfig.apiTokenEnvName) {
    return profileConfig.apiTokenEnvName;
  }

  return profileId === 'default'
    ? 'DATOCMS_API_TOKEN'
    : `DATOCMS_${profileId.toUpperCase()}_PROFILE_API_TOKEN`;
}

export async function resolveProfileApiToken({
  explicitApiToken,
  profileConfig,
  profileId,
  resolveLinkedSiteToken,
}: {
  explicitApiToken?: string;
  profileConfig: ProfileConfig;
  profileId: string;
  resolveLinkedSiteToken: ResolveLinkedSiteToken;
}): Promise<{ apiToken?: string; environmentName: string }> {
  const environmentName = profileApiTokenEnvironmentName(
    profileId,
    profileConfig,
  );

  if (explicitApiToken) {
    return { apiToken: explicitApiToken, environmentName };
  }

  if (profileConfig.siteId) {
    // A linked profile must either resolve or fail. Falling back to an
    // environment token after an OAuth failure could target another project.
    return {
      apiToken: await resolveLinkedSiteToken(
        profileConfig.siteId,
        profileConfig.organizationId,
      ),
      environmentName,
    };
  }

  return {
    apiToken: process.env[environmentName],
    environmentName,
  };
}

/**
 * The CMA token of a project linked with `datocms link`, read through the
 * saved OAuth credentials. This mirrors the private resolver of
 * `CmaClientCommand` in `@datocms/cli-utils` 4.2, messages included, for the
 * source project of a cross-project diff; the destination uses the native one.
 */
export async function resolveLinkedSiteToken(
  {
    siteId,
    organizationId,
  }: {
    siteId: string;
    organizationId?: string;
  },
  dependencies: {
    readCredentials: typeof readCredentials;
    buildClient: typeof DashboardClient.buildClient;
  } = { readCredentials, buildClient: DashboardClient.buildClient },
): Promise<string> {
  const credentials = await dependencies.readCredentials();
  if (!credentials)
    throw authenticationError(
      'OAUTH_CREDENTIALS_MISSING',
      'Project is linked but no OAuth credentials found.',
      [
        'Run "datocms login" to authenticate',
        'Use --api-token (or --source-api-token for the source project) to provide a token directly',
      ],
    );
  const client = dependencies.buildClient({
    apiToken: credentials.apiToken,
    ...(credentials.dashboardBaseUrl
      ? { baseUrl: credentials.dashboardBaseUrl }
      : {}),
    ...(organizationId ? { organization: organizationId } : {}),
  });
  let site: Awaited<ReturnType<typeof client.sites.find>>;
  try {
    site = await client.sites.find(siteId);
  } catch (error) {
    if (
      error instanceof DashboardClient.ApiError &&
      error.findError('INVALID_AUTHORIZATION_HEADER')
    )
      throw authenticationError(
        'OAUTH_CREDENTIALS_INVALID',
        'Your OAuth token is invalid or has been revoked.',
        [
          'Run "datocms login" to re-authenticate',
          'Use --api-token (or --source-api-token for the source project) to provide a token directly',
        ],
      );
    throw authenticationError(
      'LINKED_PROJECT_UNAVAILABLE',
      `Could not access linked project (ID: ${siteId}). It may have been deleted or moved, or your OAuth permissions may not allow access to it.`,
      [
        'Run "datocms login" to re-authenticate with updated permissions',
        'Run "datocms link" to re-link to a project',
        'Use --api-token (or --source-api-token for the source project) to provide a token directly',
      ],
    );
  }
  if (!site.access_token)
    throw authenticationError(
      'LINKED_PROJECT_TOKEN_MISSING',
      `Could not retrieve an API token for project "${site.name}" (ID: ${siteId}). You may not have access to this project.`,
      [
        'Run "datocms link" to re-link to a project',
        'Use --api-token (or --source-api-token for the source project) to provide a token directly',
      ],
    );
  return site.access_token;
}

/** A native CLI error (exit 2, pretty-printed), with a code for --json. */
function authenticationError(
  code: ContentErrorCode,
  message: string,
  suggestions: string[],
): oclif.Errors.CLIError {
  return new oclif.Errors.CLIError(message, { code, suggestions });
}
