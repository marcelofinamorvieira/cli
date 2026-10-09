import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { CmaClient } from '@datocms/cli-utils';
import { recordHash } from '../src/engine/codec';
import { DiffFile } from '../src/engine/diff-file';
import { runOperations } from '../src/engine/execution';
import { schemaHash } from '../src/engine/schema';
import type { JsonObject, RecordState, SchemaState } from '../src/engine/types';
import { fixtureId as id } from './fixture-id';
import { content, diff, run, writeTestDiff } from './pipeline';

const MODEL = id('transport-model');
const PUBLISHED_AT = '2025-02-01T00:00:00.000Z';

function schema(): SchemaState {
  const result: SchemaState = {
    siteId: 'site',
    environmentId: 'source',
    locales: ['en'],
    semantics: {},
    workflows: [],
    models: [
      {
        id: MODEL,
        apiKey: 'article',
        name: 'Article',
        block: false,
        singleton: false,
        sortable: false,
        tree: false,
        draftMode: true,
        saveInvalidDrafts: false,
        allLocalesRequired: false,
        workflowId: null,
        fields: [
          {
            id: id('transport-title'),
            apiKey: 'title',
            type: 'string',
            localized: false,
            validators: {},
            defaultValue: null,
          },
        ],
      },
    ],
    hash: '',
  };
  result.hash = schemaHash(result);
  return result;
}

function record(name: string, title: string, published: boolean): RecordState {
  const result: RecordState = {
    id: id(name),
    modelId: MODEL,
    current: { title },
    published: published ? { title } : null,
    currentVersion: `v-${name}`,
    publishedUpdatedAt: published ? PUBLISHED_AT : null,
    createdAt: '2025-01-01T00:00:00.000Z',
    firstPublishedAt: published ? PUBLISHED_AT : null,
    parentId: null,
    position: null,
    stage: null,
    schedules: { publication: null, unpublishing: null },
    hash: '',
  };
  result.hash = recordHash(result);
  return result;
}

/** What the server received, one entry per request. */
interface Received {
  method: string;
  path: string;
  query: Record<string, string>;
  environment: string | string[] | undefined;
  body: JsonObject | null;
}

/**
 * A CMA over HTTP for the records of `target`: it answers the version
 * listings of apply's checks and echoes every write, slowly, so writes that
 * overlap would be seen. `reject` answers a write with an error instead.
 */
async function cma(
  target: RecordState[],
  reject?: (request: Received) => unknown[] | undefined,
) {
  const requests: Received[] = [];
  let writing = 0;
  let overlapping = false;
  const item = (recordId: string, meta: JsonObject = {}) => ({
    id: recordId,
    type: 'item',
    attributes: {},
    relationships: { item_type: { data: { id: MODEL, type: 'item_type' } } },
    meta,
  });
  const server = createServer(async (request, response) => {
    const write = request.method !== 'GET';
    if (write && writing++) overlapping = true;
    try {
      const url = new URL(request.url!, 'http://localhost');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const received: Received = {
        method: request.method!,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        environment: request.headers['x-environment'],
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(received);
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (received.method === 'GET' && received.path === '/items') {
        const published = received.query.version === 'published';
        const ids = received.query['filter[ids]']!.split(',');
        const data = target
          .filter((state) => ids.includes(state.id))
          .filter((state) => !published || state.published)
          .map((state) =>
            item(state.id, {
              current_version: state.currentVersion,
              updated_at: published ? state.publishedUpdatedAt : null,
            }),
          );
        return reply(200, { data, meta: { total_count: data.length } });
      }
      await setTimeout(10);
      const errors = reject?.(received);
      if (errors) return reply(422, { data: errors });
      const recordId =
        received.path.split('/')[2] ??
        ((received.body?.data as JsonObject).id as string);
      reply(received.method === 'POST' ? 201 : 200, {
        data: item(recordId, { current_version: 'server-version' }),
      });
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    } finally {
      if (write) writing--;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = CmaClient.buildClient({
    apiToken: 'local-test-credential',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    environment: 'sandbox',
  });
  return {
    client,
    requests,
    overlapping: () => overlapping,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('content diffs over the real CMA SDK transport', () => {
  let directory: string;
  const before = [record('kept', 'Old', true), record('gone', 'Gone', false)];
  const after = [record('kept', 'New', true), record('fresh', 'Fresh', true)];
  const args = {
    source: content({ records: after }),
    target: content({ records: before }),
    sourceSchema: schema(),
    options: {
      modelIds: [MODEL],
      uploads: 'all' as const,
      includeDeletions: true,
      allowPartial: false,
    },
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'content-sdk-transport-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('checks the destination, then sends each operation once the previous one is answered', async () => {
    const { plan, operations } = await diff(args);
    const server = await cma(before);
    try {
      await run(
        server.client,
        await writeTestDiff(directory, plan, operations),
      );
      // The two version listings are read at once, in either order.
      const checks = server.requests
        .slice(0, 2)
        .sort((a, b) => a.query.version!.localeCompare(b.query.version!));
      const writes = server.requests.slice(2);
      const ids = [id('fresh'), id('kept'), id('gone')].join(',');
      assert.deepEqual(
        checks.map((request) => [request.method, request.path, request.query]),
        ['current', 'published'].map((version) => [
          'GET',
          '/items',
          { 'filter[ids]': ids, version, 'page[limit]': '3' },
        ]),
      );
      assert.deepEqual(
        writes.map((request) => [request.method, request.path, request.query]),
        [
          ['POST', '/items', {}],
          ['PUT', `/items/${id('fresh')}/publish`, { recursive: 'false' }],
          ['PUT', `/items/${id('kept')}`, {}],
          ['PUT', `/items/${id('kept')}/publish`, { recursive: 'false' }],
          ['DELETE', `/items/${id('gone')}`, {}],
        ],
      );
      assert.ok(
        server.requests.every((request) => request.environment === 'sandbox'),
      );
      assert.equal(server.overlapping(), false);
      assert.deepEqual(writes[0]!.body, {
        data: {
          id: id('fresh'),
          type: 'item',
          attributes: { title: 'Fresh' },
          relationships: {
            item_type: { data: { id: MODEL, type: 'item_type' } },
          },
          meta: {
            created_at: '2025-01-01T00:00:00.000Z',
            first_published_at: PUBLISHED_AT,
          },
        },
      });
      assert.deepEqual(writes[2]!.body, {
        data: {
          id: id('kept'),
          type: 'item',
          attributes: { title: 'New' },
          meta: { current_version: 'v-kept' },
        },
      });
    } finally {
      await server.close();
    }
  });

  it('reports a CMA rejection with the line and label of its operation, and sends nothing after it', async () => {
    const { plan, operations } = await diff(args);
    const path = await writeTestDiff(directory, plan, operations);
    const index = operations.findIndex(
      (operation) => operation.op === 'record.update',
    );
    const where = `operations/000001.jsonl line ${index + 1}`;
    const { label } = operations[index]!;
    const keptPath = `/items/${id('kept')}`;
    for (const [apiCode, details, code, message] of [
      [
        'INVALID_FIELD',
        { field: 'title', code: 'VALIDATION_LENGTH' },
        'CMA_VALIDATION_FAILED',
        `The CMA rejected PUT ${keptPath}: INVALID_FIELD (title: VALIDATION_LENGTH).`,
      ],
      [
        'STALE_ITEM_VERSION',
        {},
        'RECORD_CHANGED_DURING_APPLY',
        `Record ${id(
          'kept',
        )} was modified by someone else while the diff was running.`,
      ],
    ] as const) {
      const server = await cma(before, (request) =>
        request.method === 'PUT' && request.path === keptPath
          ? [
              {
                id: 'error',
                type: 'api_error',
                attributes: { code: apiCode, details },
              },
            ]
          : undefined,
      );
      const file = await DiffFile.open(path);
      try {
        await assert.rejects(runOperations(server.client, file, {}), {
          code,
          message: `${where}, ${label}: ${message}`,
          details: {
            method: 'PUT',
            url: `${server.client.config.baseUrl}${keptPath}`,
            status: 422,
            errors: [{ code: apiCode, details }],
            operation: { where, label },
          },
        });
        assert.equal(server.requests.at(-1)!.path, keptPath);
        assert.equal(server.requests.length, index + 1);
      } finally {
        file.close();
        await server.close();
      }
    }
  });
});
