/**
 * Minimal keep-alive HTTP endpoint for platform hosts (Render, Fly, ...).
 *
 * PaaS web services are considered dead unless they hold an open port, and
 * free tiers additionally suspend services that stop receiving requests. The
 * bot is a plain TCP client - not a web app - so it carries this tiny server
 * purely to satisfy the platform: any request gets a 200 "ok".
 *
 * It must never take the bot down: a busy or blocked port is a platform
 * problem, not a bot problem, so failures are logged and swallowed.
 */
import { createServer, type Server } from 'node:http';
import type { Logger } from './utils/logger.js';

export interface HealthServerHandle {
  /** The bound port (useful when started on an ephemeral port). */
  port: number;
  /** Closes the listener; resolves once the socket is released. */
  close(): Promise<void>;
}

export async function startHealthServer(port: number, logger: Logger): Promise<HealthServerHandle> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });

  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;

  // Swap the startup error listener for a permanent one: post-bind errors
  // (rare) are logged, never fatal.
  server.removeAllListeners('error');
  server.on('error', (error: unknown) => {
    logger.warn('health server error', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info('health server listening', { port: bound });
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
