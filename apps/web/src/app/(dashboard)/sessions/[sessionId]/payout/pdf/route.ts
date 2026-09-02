import { createStatementPdfRoute } from '../../_lib/create-statement-pdf-route';

// react-pdf needs Node, not Edge. Next resolves these statically per route file, so they cannot
// move into the shared factory.
export const runtime = 'nodejs';
// Authorized, per-viewer content — never statically cached.
export const dynamic = 'force-dynamic';

/**
 * BAL-441 — the EXPERT-lens payout PDF. The handler body is defined ONCE in
 * `_lib/create-statement-pdf-route.ts`; only the lens differs between the two routes, and
 * binding it in a single place means the gate, the log field, the analytics property and the
 * filename can never disagree about which document this is.
 */
export const GET = createStatementPdfRoute('expert');
