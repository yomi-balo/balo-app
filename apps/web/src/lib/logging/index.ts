import pino from 'pino';
import { getTransport } from '@balo/shared/logging';
import { getContext } from './context';

const baseLogger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  transport: getTransport(),
  mixin() {
    const ctx = getContext();
    return ctx ? { requestId: ctx.requestId, userId: ctx.userId } : {};
  },
});

export const logger = baseLogger;

export const log = {
  info: (msg: string, data?: object) => logger.info(data, msg),
  error: (msg: string, data?: object) => logger.error(data, msg),
  warn: (msg: string, data?: object) => logger.warn(data, msg),
  debug: (msg: string, data?: object) => logger.debug(data, msg),
};

export { getContext, withContext, requestContext } from './context';
export type { RequestContext } from './context';
