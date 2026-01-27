import pino from 'pino';
import type { TransportTargetOptions } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

function getTransport(): pino.TransportSingleOptions | undefined {
  if (!isProduction) {
    return { target: 'pino-pretty', options: { colorize: true } };
  }

  if (process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET) {
    return {
      target: '@axiomhq/pino',
      options: {
        dataset: process.env.AXIOM_DATASET,
        token: process.env.AXIOM_TOKEN,
      },
    };
  }

  return undefined;
}

export const log = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transport: getTransport(),
});

/** Create a child logger scoped to a specific context (e.g. 'auth', 'payments'). */
export const createLogger = (context: string) => log.child({ context });
