import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const hasAxiom = !!(process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET);

/** Resolve the appropriate Pino transport for the current environment. */
export function getTransport():
  | pino.TransportSingleOptions
  | pino.TransportMultiOptions
  | undefined {
  const axiomTransport = {
    target: '@axiomhq/pino',
    options: {
      dataset: process.env.AXIOM_DATASET,
      token: process.env.AXIOM_TOKEN,
    },
  };

  if (isProduction) {
    return hasAxiom ? axiomTransport : undefined;
  }

  // Dev: always pretty-print to console. Also send to Axiom if configured.
  const prettyTransport = { target: 'pino-pretty', options: { colorize: true } };

  if (hasAxiom) {
    return {
      targets: [
        { ...prettyTransport, level: 'debug' },
        { ...axiomTransport, level: 'info' }, // don't flood Axiom with debug logs
      ],
    };
  }

  return prettyTransport;
}

export const log = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transport: getTransport(),
});

/** Create a child logger scoped to a specific context (e.g. 'auth', 'payments'). */
export const createLogger = (context: string) => log.child({ context });
