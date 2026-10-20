/** The keep-alive endpoint is what keeps a PaaS deployment alive - test it. */
import { afterAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { silentLogger } from '../../src/utils/logger.js';
import { startHealthServer } from '../../src/healthServer.js';

function request(
  port: number,
  path = '/',
  method = 'GET',
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
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

    const response = await request(handle.port);
    expect(response.status).toBe(200);
    expect(response.body.trim()).toBe('ok');
  });

  it('answers any path and any method with 200 ok', async () => {
    // The platform probes the port with whatever it likes; the contract is
    // "every request gets 200 ok", not "GET / gets 200 ok".
    const local = await startHealthServer(0, silentLogger);
    try {
      const probes: ReadonlyArray<readonly [string, string]> = [
        ['/healthz', 'GET'],
        ['/anything/else', 'GET'],
        ['/', 'POST'],
      ];
      for (const [path, method] of probes) {
        const response = await request(local.port, path, method);
        expect(response.status, `${method} ${path}`).toBe(200);
      }
      const root = await request(local.port);
      expect(root.body.trim()).toBe('ok');
    } finally {
      await local.close();
    }
  });

  it('close() releases the port so a new listener can bind it', async () => {
    const first = await startHealthServer(0, silentLogger);
    const port = first.port;
    await first.close();

    // Binding the same port succeeds only when the handle released it.
    const second = await startHealthServer(port, silentLogger);
    expect(second.port).toBe(port);
    await second.close();
  });
});
