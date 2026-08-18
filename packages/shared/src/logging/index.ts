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

/**
 * B3 (BAL-467 security review SUGGESTION) — plan §4c asked for this and it shipped without
 * it, leaving no `redact` config anywhere in the API app. This is the SAFETY NET behind
 * B1 (sanitized Apiroc route templates) and B2 (`ApirocError.wireErrorRaw` made
 * non-enumerable) — not a substitute for either: both of those stop the leak at the
 * source, this stops it from EVERY OTHER caller that logs a raw header object, a raw
 * request/response config, or an error carrying `wireErrorRaw` by some path this list
 * didn't anticipate.
 *
 * Paths cover common casings/nestings pino's `err`/req-log shapes actually use; unmatched
 * nesting depths are a known limitation of `fast-redact`'s non-recursive wildcard, not an
 * oversight — extend this list if a new nesting shape is found.
 */
export const REDACT_PATHS: readonly string[] = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  '*.headers.authorization',
  'apiKey',
  '*.apiKey',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'headers["x-api-key"]',
  'req.headers["x-api-key"]',
  '*.headers["x-api-key"]',
  // The B2 belt-and-suspenders: `ApirocError.wireErrorRaw` is non-enumerable at the source,
  // but any caller that spreads/clones the error (or a future error class that doesn't
  // repeat that discipline) is still covered here.
  'wireErrorRaw',
  'err.wireErrorRaw',
  '*.wireErrorRaw',
  // Fix brief round 2, item 10 — `ApirocError.zodIssues[].message` is OWN and ENUMERABLE
  // (unlike `wireErrorRaw`, B2 did not touch it), and Zod's `invalid_enum_value` message
  // echoes the received value verbatim (`"… received 'xyz'"`). The interceptor's own log
  // line only ever sends `zodIssuePaths` (paths only, never `.message`) — this entry exists
  // for any OTHER caller that logs the `ApirocError`/capture object directly (e.g. a bare
  // `log.error({ err })`) and would otherwise let Pino's default `err` serializer copy the
  // whole array, `.message` included, straight to Axiom.
  'zodIssues',
  'err.zodIssues',
  '*.zodIssues',
];

/**
 * BAL-467 fix brief round 2, item 6 — hoisted so `index.test.ts` can pin the REAL logger's
 * config instead of building a separate `pino({ redact: … })` that only proves `fast-redact`
 * itself works. Deleting the `redact:` block from `log` below used to leave all 838
 * `packages/shared` tests green (measured); asserting against this exported object closes
 * that gap.
 */
export const LOGGER_OPTIONS = {
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transport: getTransport(),
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
  },
} satisfies pino.LoggerOptions;

export const log = pino(LOGGER_OPTIONS);

/** Create a child logger scoped to a specific context (e.g. 'auth', 'payments'). */
export const createLogger = (context: string) => log.child({ context });
