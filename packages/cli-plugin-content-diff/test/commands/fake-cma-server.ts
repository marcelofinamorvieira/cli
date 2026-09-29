import { type IncomingHttpHeaders, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'chai';

export type FakeCmaRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
};

export type FakeCmaResponse = {
  status: number;
  body: Record<string, unknown>;
};

export type FakeCmaServer = {
  baseUrl: string;
  requests: FakeCmaRequest[];
  close: () => Promise<void>;
};

/**
 * Minimal CMA stand-in that lets command tests drive the real CMA client, and
 * therefore its real request logging, through --base-url. Every response
 * echoes the Authorization header it received in `meta.echoed_authorization`
 * so tests can also prove that echoed response bodies are redacted.
 */
export async function startFakeCmaServer(
  route: (request: FakeCmaRequest) => FakeCmaResponse | undefined,
): Promise<FakeCmaServer> {
  const requests: FakeCmaRequest[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const request: FakeCmaRequest = {
        method: incoming.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: incoming.headers,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      };
      requests.push(request);

      const response =
        route(request) ?? apiErrorResponse(404, 'NOT_FOUND', request.path);
      const meta = response.body.meta as Record<string, unknown> | undefined;

      outgoing.writeHead(response.status, {
        'content-type': 'application/json; charset=utf-8',
      });
      outgoing.end(
        JSON.stringify({
          ...response.body,
          meta: {
            ...meta,
            echoed_authorization: incoming.headers.authorization,
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function apiErrorResponse(
  status: number,
  code: string,
  id = code,
): FakeCmaResponse {
  return {
    status,
    body: {
      data: [{ id, type: 'api_error', attributes: { code, details: {} } }],
    },
  };
}

export function environmentsResponse(
  environments: Array<{ id: string; primary: boolean }>,
): FakeCmaResponse {
  return {
    status: 200,
    body: { data: environments.map(environmentResource) },
  };
}

export function environmentResource({
  id,
  primary,
}: {
  id: string;
  primary: boolean;
}): Record<string, unknown> {
  return {
    id,
    type: 'environment',
    meta: { status: 'ready', primary, read_only_mode: false },
  };
}

export function siteResponse(siteId: string): FakeCmaResponse {
  return {
    status: 200,
    body: {
      data: {
        id: siteId,
        type: 'site',
        attributes: { name: 'Fake project' },
        relationships: {},
      },
      included: [],
    },
  };
}

/**
 * Asserts that verbose CMA output was produced (request headers and echoed
 * response bodies) and that none of the credentials appear in it.
 */
export function expectRedactedCmaOutput(
  output: string,
  credentials: readonly string[],
): void {
  expect(output).to.contain('authorization: [REDACTED]');
  expect(output).to.contain('"echoed_authorization": "Bearer [REDACTED]"');
  for (const credential of credentials) {
    expect(output).not.to.contain(credential);
  }
}

/** Proves the credentials reached the API, so their absence from logs matters. */
export function expectAuthenticatedWith(
  requests: readonly FakeCmaRequest[],
  credentials: readonly string[],
): void {
  const authorizations = new Set(
    requests.map(({ headers }) => headers.authorization),
  );

  expect([...authorizations].sort()).to.deep.equal(
    credentials.map((credential) => `Bearer ${credential}`).sort(),
  );
}

export function requestedEnvironments(
  requests: readonly FakeCmaRequest[],
): Set<string | undefined> {
  return new Set(
    requests.map(({ headers }) => {
      const environment = headers['x-environment'];
      return Array.isArray(environment) ? environment[0] : environment;
    }),
  );
}
