import { expect } from 'chai';
import {
  profileApiTokenEnvironmentName,
  resolveProfileApiToken,
} from '../../../src/utils/profile-auth';

describe('cross-project profile authentication', () => {
  it('uses the same default environment-variable names as the DatoCMS CLI', () => {
    expect(profileApiTokenEnvironmentName('default', {})).to.equal(
      'DATOCMS_API_TOKEN',
    );
    expect(profileApiTokenEnvironmentName('client_a', {})).to.equal(
      'DATOCMS_CLIENT_A_PROFILE_API_TOKEN',
    );
    expect(
      profileApiTokenEnvironmentName('client_a', {
        apiTokenEnvName: 'CUSTOM_CLIENT_CREDENTIAL',
      }),
    ).to.equal('CUSTOM_CLIENT_CREDENTIAL');
  });

  it('resolves explicit credentials before linked projects and environment variables', async () => {
    const previousCredential = process.env.TEST_PROFILE_CREDENTIAL;
    process.env.TEST_PROFILE_CREDENTIAL = 'environment-credential';
    let linkedProjectRequested = false;

    try {
      const result = await resolveProfileApiToken({
        explicitApiToken: 'explicit-credential',
        profileConfig: {
          siteId: 'linked-site',
          apiTokenEnvName: 'TEST_PROFILE_CREDENTIAL',
        },
        profileId: 'source',
        resolveLinkedSiteToken: async () => {
          linkedProjectRequested = true;
          return 'oauth-credential';
        },
      });

      expect(result.apiToken).to.equal('explicit-credential');
      expect(linkedProjectRequested).to.equal(false);
    } finally {
      restoreEnvironmentVariable('TEST_PROFILE_CREDENTIAL', previousCredential);
    }
  });

  it('resolves linked projects before profile environment variables', async () => {
    const previousCredential = process.env.TEST_PROFILE_CREDENTIAL;
    process.env.TEST_PROFILE_CREDENTIAL = 'environment-credential';

    try {
      const result = await resolveProfileApiToken({
        profileConfig: {
          siteId: 'linked-site',
          organizationId: 'linked-organization',
          apiTokenEnvName: 'TEST_PROFILE_CREDENTIAL',
        },
        profileId: 'source',
        resolveLinkedSiteToken: async (siteId, organizationId) => {
          expect(siteId).to.equal('linked-site');
          expect(organizationId).to.equal('linked-organization');
          return 'oauth-credential';
        },
      });

      expect(result.apiToken).to.equal('oauth-credential');
    } finally {
      restoreEnvironmentVariable('TEST_PROFILE_CREDENTIAL', previousCredential);
    }
  });

  it('falls back to the profile environment variable when a linked project has no token', async () => {
    const previousCredential = process.env.TEST_PROFILE_CREDENTIAL;
    process.env.TEST_PROFILE_CREDENTIAL = 'environment-credential';

    try {
      const result = await resolveProfileApiToken({
        profileConfig: {
          siteId: 'linked-site',
          apiTokenEnvName: 'TEST_PROFILE_CREDENTIAL',
        },
        profileId: 'source',
        resolveLinkedSiteToken: async () => undefined,
      });

      expect(result.apiToken).to.equal('environment-credential');
    } finally {
      restoreEnvironmentVariable('TEST_PROFILE_CREDENTIAL', previousCredential);
    }
  });
});

function restoreEnvironmentVariable(
  name: string,
  previousValue: string | undefined,
): void {
  if (previousValue === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = previousValue;
  }
}
