import type { ProfileConfig } from '@datocms/cli-utils';

export type ResolveLinkedSiteToken = (
  siteId: string,
  organizationId?: string,
) => Promise<string | undefined>;

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
    const linkedSiteToken = await resolveLinkedSiteToken(
      profileConfig.siteId,
      profileConfig.organizationId,
    );

    if (linkedSiteToken) {
      return { apiToken: linkedSiteToken, environmentName };
    }
  }

  return {
    apiToken: process.env[environmentName],
    environmentName,
  };
}
