export const REDACTED_CREDENTIAL = '[REDACTED]';

type LogFunction = (message: string) => void;

// rest-client-utils logs each request header as `[<request id>] <name>: <value>`.
const AUTHORIZATION_LOG_LINE = /^(\[[^\]]*\]\s+authorization:\s*)(.*)$/gimu;
const AUTHORIZATION_HEADER_NAME = /^authorization$/iu;
const CLIENT_REDACTED_VALUE = /^\s*\[REDACTED\b/u;

/**
 * Collects every API token a command authenticates with and scrubs those
 * tokens from CMA request logs and surfaced errors.
 *
 * At --log-level=BODY_AND_HEADERS the CMA client prints the Authorization
 * header verbatim, response bodies can echo credentials back, and uncaught API
 * errors are dumped together with their request headers. Tokens are matched
 * when output is produced, so a token registered for one client is also
 * removed from output produced by every other client of the same command.
 */
export class CredentialRedactor {
  private readonly credentials = new Set<string>();
  private orderedCredentials: string[] = [];

  register(...credentials: Array<string | null | undefined>): void {
    let changed = false;

    for (const credential of credentials) {
      if (typeof credential !== 'string' || credential.length === 0) continue;

      for (const variant of credentialVariants(credential)) {
        if (!this.credentials.has(variant)) {
          this.credentials.add(variant);
          changed = true;
        }
      }
    }

    if (changed) {
      // Longer variants first, so a token containing another registered token
      // is never left partially visible.
      this.orderedCredentials = [...this.credentials].sort(
        (left, right) =>
          right.length - left.length ||
          (left < right ? -1 : left > right ? 1 : 0),
      );
    }
  }

  redact(text: string): string {
    const redacted = this.orderedCredentials.reduce(
      (current, credential) =>
        current.includes(credential)
          ? current.split(credential).join(REDACTED_CREDENTIAL)
          : current,
      text,
    );

    // Fallback for a header logged by a client whose token was never
    // registered: the Authorization value is never useful in a log.
    return redacted.replace(
      AUTHORIZATION_LOG_LINE,
      (_line, prefix: string, value: string) =>
        `${prefix}${redactAuthorizationValue(value)}`,
    );
  }

  wrapLogFunction(logFn: LogFunction): LogFunction {
    return (message) => logFn(this.redact(String(message)));
  }

  /**
   * Registers the client's token and wraps its log function. Every CMA client a
   * command builds must go through this before it can emit output.
   */
  protectClientOptions<
    Options extends { apiToken?: string | null; logFn?: LogFunction },
  >(options: Options): Options & { logFn: LogFunction } {
    this.register(options.apiToken);

    return {
      ...options,
      // The CMA client falls back to console.log without a log function.
      logFn: this.wrapLogFunction(
        options.logFn ?? ((message) => console.log(message)),
      ),
    };
  }

  /**
   * Redacts credentials in place from an error that is about to be reported.
   * The CLI error handler serializes API errors, including their request
   * headers, so this must run before the error reaches it.
   */
  redactError(error: unknown): void {
    this.redactObject(error, new WeakSet<object>());
  }

  private redactObject(value: unknown, visited: WeakSet<object>): void {
    if (value === null || typeof value !== 'object' || visited.has(value)) {
      return;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    visited.add(value);

    if (value instanceof Error) {
      // `stack` is an accessor on V8 errors, so the data-property walk below
      // does not reach it.
      this.redactStringProperty(value, 'stack');
    }

    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (!descriptor || !('value' in descriptor)) continue;

      if (typeof descriptor.value !== 'string') {
        this.redactObject(descriptor.value, visited);
      } else if (AUTHORIZATION_HEADER_NAME.test(key)) {
        replaceProperty(value, key, redactAuthorizationValue(descriptor.value));
      } else {
        this.redactStringProperty(value, key);
      }
    }
  }

  private redactStringProperty(target: object, key: string): void {
    let current: unknown;

    try {
      current = Reflect.get(target, key);
    } catch {
      return;
    }

    if (typeof current !== 'string') return;

    const redacted = this.redact(current);

    if (redacted !== current) {
      replaceProperty(target, key, redacted);
    }
  }
}

function credentialVariants(credential: string): string[] {
  return Array.from(
    new Set([
      credential,
      JSON.stringify(credential).slice(1, -1),
      encodeURIComponent(credential),
    ]),
  ).filter((variant) => variant.length > 0);
}

/** Keeps the authentication scheme (for example `Bearer`) and hides the rest. */
function redactAuthorizationValue(value: string): string {
  // The CMA client already masks the header as `[REDACTED, ending in abcd]`;
  // the last characters are dropped too, like every other credential.
  if (CLIENT_REDACTED_VALUE.test(value)) return REDACTED_CREDENTIAL;

  const scheme = /^(\s*\S+\s+)\S/u.exec(value)?.[1] ?? '';

  return `${scheme}${REDACTED_CREDENTIAL}`;
}

function replaceProperty(target: object, key: string, value: string): void {
  try {
    Reflect.set(target, key, value);
  } catch {
    // Frozen values cannot be updated in place.
  }
}
