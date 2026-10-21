/** Runtime checks shared by browser-facing adapters. */
import type { FastifyInstance } from 'fastify';
import { types } from 'node:util';

/** Refuse hosts whose automatic request logger can serialize URLs or cookies. */
export function requireHardenedRequestLogging(app: FastifyInstance): void {
  if (types.isProxy(app)) throw new Error('HTTP_LOGGING_CONFIGURATION');
  const controllerSymbols = Object.getOwnPropertySymbols(app).filter(
    (symbol) => symbol.description === 'fastify.logController',
  );
  if (controllerSymbols.length !== 1)
    throw new Error('HTTP_LOGGING_CONFIGURATION');
  const controller = Object.getOwnPropertyDescriptor(app, controllerSymbols[0]!)
    ?.value as unknown;
  if (
    controller === null ||
    typeof controller !== 'object' ||
    types.isProxy(controller) ||
    Object.getOwnPropertyDescriptor(controller, 'disableRequestLogging')
      ?.value !== true
  )
    throw new Error('HTTP_LOGGING_CONFIGURATION');
}
