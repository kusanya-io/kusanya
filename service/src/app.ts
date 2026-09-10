import Fastify, { LogController } from 'fastify';
import type { Config } from './config.js';
import type { Database } from './database.js';

const statusSchema = (status: string) => ({
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', const: status } },
});

/** Construct the HTTP service without opening a socket, enabling isolated tests. */
export function createApp(config: Config, database: Database, logging = true) {
  const app = Fastify({
    logger: logging
      ? {
          level: config.logLevel,
          serializers: {
            req: (request: { method: string }) => ({ method: request.method }),
            err: () => ({
              type: 'Error',
              message: 'Request failed',
              stack: '',
            }),
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: 1024,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    return503OnClosing: true,
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onClose', async () => {
    await database.close();
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'Not found' }),
  );
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(500).send({ error: 'Internal server error' }),
  );
  app.get(
    '/healthz',
    { schema: { response: { 200: statusSchema('ok') } } },
    () => ({ status: 'ok' }),
  );
  app.get(
    '/readyz',
    {
      schema: {
        response: {
          200: statusSchema('ready'),
          503: statusSchema('unavailable'),
        },
      },
    },
    async (_request, reply) => {
      try {
        await database.ping();
        return { status: 'ready' };
      } catch {
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );
  return app;
}
