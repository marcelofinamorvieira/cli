import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmaClient } from '@datocms/cli-utils';
import { defineContentMigration, runMigrationPart } from '../src/migration';

describe('content migrations over the real CMA SDK transport', () => {
  it('sends inline and part writes immediately and returns actual server values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-sdk-transport-'));
    const writes: string[] = [];
    const environments: Array<string | string[] | undefined> = [];
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'PUT');
        assert.equal(request.url, '/items/record-id');
        environments.push(request.headers['x-environment']);
        let bytes = '';
        for await (const chunk of request) bytes += chunk;
        const body = JSON.parse(bytes);
        writes.push(body.data.attributes.title);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: {
              id: 'record-id',
              type: 'item',
              attributes: { title: `${body.data.attributes.title}:server` },
              relationships: {
                item_type: { data: { id: 'model-id', type: 'item_type' } },
              },
              meta: { current_version: `server-version-${writes.length}` },
            },
          }),
        );
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const client = CmaClient.buildClient({
        apiToken: 'local-test-credential',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        environment: 'isolated',
      });
      const part = join(directory, 'part.ts');
      await writeFile(
        part,
        `export default async function(client) {
          const result = await client.items.update('record-id', { title: 'part' });
          if (result.title !== 'part:server' || result.meta.current_version !== 'server-version-2') {
            throw new Error('The part did not receive the actual CMA response');
          }
          await client.items.update('record-id', { title: result.title });
        }`,
      );
      const migration = defineContentMigration(
        { baseline: join(directory, 'unused.content') },
        async (actual) => {
          assert.equal(actual, client);
          const result = await actual.items.update('record-id', {
            title: 'inline',
          });
          assert.equal(result.title, 'inline:server');
          assert.equal(result.meta.current_version, 'server-version-1');
          assert.deepEqual(writes, ['inline']);
          await runMigrationPart(actual, part);
          assert.deepEqual(writes, ['inline', 'part', 'part:server']);
        },
      );
      await migration(client);
      assert.deepEqual(environments, ['isolated', 'isolated', 'isolated']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
