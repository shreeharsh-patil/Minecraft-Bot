/** The keep-alive endpoint is what keeps a PaaS deployment alive - test it. */
import { afterAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { silentLogger } from '../../src/utils/logger.js';
import { startHealthServer } from '../../src/healthServer.js';

function get(port: number): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('health server', () => {
  let handle: Awaited<ReturnType<typeof startHealthServer>> | undefined;

  afterAll(async () => {
    await handle?.close();
  });

  it('answers any request with 200 ok on an ephemeral port', async () => {
    handle = await startHealthServer(0, silentLogger);
    expect(handle.port).toBeGreaterThan(0);

    const response = await get(handle.port);
    expect(response.status).toBe(200);
    expect(response.body.trim()).toBe('ok');
  });

  it('close() releases the port so a new listener can bind it', async () => {
    const first = await startHealthServer(0, silentLogger);
    const port = first.port;
    await first.close();

    // Binding the same port succeeds only when the handle released it.
    const second = await startHealthServer(port, silentLogger);
    await second.close();
  });
});
