import { type CmaClient, CmaClientCommand } from '@datocms/cli-utils';
import { CredentialRedactor } from './credential-redaction';

/**
 * CMA client command whose clients never print the API token they
 * authenticate with, at any --log-level or --log-mode, and whose uncaught API
 * errors are reported without their Authorization header.
 *
 * Every client built through `buildClient()` (the root client, environment
 * clients, and the clients handed to migrations) derives its options from
 * `buildBaseClientInitializationOptions()`, so protecting that single entry
 * point covers them all. Commands that build clients through another path
 * must pass the options through `credentialRedactor.protectClientOptions()`.
 */
export abstract class RedactedCmaClientCommand extends CmaClientCommand {
  private redactor?: CredentialRedactor;

  // Created on first use rather than as a class field, so instances built
  // without the constructor (for example via Object.create) still redact.
  protected get credentialRedactor(): CredentialRedactor {
    if (!this.redactor) {
      this.redactor = new CredentialRedactor();
    }

    return this.redactor;
  }

  protected async buildBaseClientInitializationOptions(): Promise<
    Partial<CmaClient.ClientConfigOptions> & { apiToken: string }
  > {
    return this.credentialRedactor.protectClientOptions(
      await super.buildBaseClientInitializationOptions(),
    );
  }

  protected async catch(
    error: Error & { exitCode?: number | undefined },
  ): Promise<void> {
    this.credentialRedactor.redactError(error);
    return super.catch(error);
  }
}
