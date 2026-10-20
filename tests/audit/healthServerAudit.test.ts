/**
 * Audit of src/healthServer.ts: the shutdown contract of the keep-alive port.
 *
 * The bot runs headless on Render, where the platform needs an open HTTP
 * port. `close()` is the only way that port is released again (BotApp
 * shutdown awaits it before the event loop is allowed to drain), so it has to
 * finish even when a client is still connected.
 */
import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { silentLogger } from '../../src/utils/logger.js';
import { startHealthServer } from '../../src/healthServer.js';

/**
 * Awaits `close()` but gives up after `ms`, so a hanging shutdown fails the
 * test quickly instead of eating the whole vitest timeout.
 */
async function closeOutcome(close: () => Promise<void>, ms = 3000): Promise<'closed' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref();
  });
  try {
    return await Promise.race([close().then(() => 'closed' as const), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Opens a raw socket to the health port and keeps it open. */
async function openSocket(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  // The server destroys the socket on close(); without a handler the reset
  // would surface as an unhandled 'error' event in the test process.
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  return socket;
}

function get(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('health server shutdown', () => {
  it('close() resolves and frees the port while a client socket is still open', async () => {
    const handle = await startHealthServer(0, silentLogger);
    const port = handle.port;

    // A client that connects and then goes silent never finishes a request,
    // so the server still counts it as an open connection.
    const client = await openSocket(port);
    try {
      expect(await closeOutcome(() => handle.close())).toBe('closed');

      // The port is really released: a new listener can bind it again.
      const second = await startHealthServer(port, silentLogger);
      await second.close();
    } finally {
      client.destroy();
    }
  });

  it('close() resolves and frees the port while a client stalls mid-request', async () => {
    const handle = await startHealthServer(0, silentLogger);
    const port = handle.port;

    // Headers that are never terminated: the request never completes, so the
    // connection stays "in flight" and keeps the server from draining.
    const client = await openSocket(port);
    client.write('GET / HTTP/1.1\r\nHost: x\r\n');
    try {
      expect(await closeOutcome(() => handle.close())).toBe('closed');

      const second = await startHealthServer(port, silentLogger);
      await second.close();
    } finally {
      client.destroy();
    }
  });

  it('keeps answering 200 ok while another client is stalled', async () => {
    const handle = await startHealthServer(0, silentLogger);
    const port = handle.port;

    const stalled = await openSocket(port);
    stalled.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nshort');
    try {
      expect(await get(port)).toBe(200);
      expect(await closeOutcome(() => handle.close())).toBe('closed');
    } finally {
      stalled.destroy();
    }
  });
});
