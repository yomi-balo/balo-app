import 'server-only';

import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, CASE_BILLING_SERVER_EVENTS } from '@/lib/analytics/server';
import { renderSessionStatementPdfToBuffer } from '@/lib/credit/statement/pdf/session-statement-pdf-document';
import { statementPdfFileName } from '@/lib/credit/statement/pdf/statement-pdf-file-name';
import {
  loadSessionStatement,
  SessionStatementRateLimitedError,
  SessionStatementUnavailableError,
} from './load-session-statement';
import { isStatementDownloadable } from './session-statement-view';

/** The two lens literals, matching `loadSessionStatement` and `statementPdfFileName`. */
type StatementLens = 'client' | 'expert';

/**
 * BAL-441 (plan §10) — the statement PDF Route Handler, ONE definition, lens-parameterised.
 *
 * Mirrors `projects/[requestId]/proposal/[relationshipId]/pdf/route.ts`: it re-runs the SAME
 * lens gate server-side (`loadSessionStatement`), so a PDF can never be produced from a payload
 * the browser holds. `401`, not a redirect — a fetch or an `<a download>` must not receive an
 * HTML login page.
 *
 * ⚠ WHY A FACTORY. The receipt and payout handlers were byte-identical apart from four `'client'`
 * / `'expert'` literals — a 23-line clone that put new-code duplication over the SonarCloud gate
 * (measured 4.78% on tsx). More importantly, a clone on a MONEY path is a correctness hazard, not
 * just a maintainability one: the lens appears four separate times in the body (the gate, the log
 * field, the analytics property, the filename) and a copy-paste that updated three of them would
 * serve one lens's document under the other's name. Here the lens is bound ONCE.
 *
 * `runtime`/`dynamic` cannot live here — Next resolves those statically per route file.
 */
const uuidParam = z.string().uuid();

function errorFields(error: unknown): { error: string; stack: string | undefined } {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

type StatementPdfHandler = (
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> }
) => Promise<Response>;

/** Build the GET handler for one lens. The lens is bound once and used for every downstream use. */
export function createStatementPdfRoute(lens: StatementLens): StatementPdfHandler {
  return async function GET(_request, ctx): Promise<Response> {
    const { sessionId } = await ctx.params;

    // The id reaches a filename and (via the loader) an api path — validate before either.
    if (!uuidParam.safeParse(sessionId).success) {
      return new Response(null, { status: 404 });
    }

    const user = await getCurrentUser();
    if (!user) {
      return new Response(null, { status: 401 });
    }

    let view: Awaited<ReturnType<typeof loadSessionStatement>>;
    try {
      view = await loadSessionStatement(sessionId, user.id, lens);
    } catch (error) {
      // BAL-519 — the api's per-user limiter refused the gate read. Answer 429 and STOP: no render
      // (the whole point — a `@react-pdf/renderer` pass on Vercel is the expensive half of this
      // loop), and no `SESSION_STATEMENT_DOWNLOADED` event, which fires further down only after a
      // successful render. `null` body, matching this handler's 401/404/500 shape.
      if (error instanceof SessionStatementRateLimitedError) {
        log.warn('Session statement PDF rate-limited', {
          sessionId,
          userId: user.id,
          lens,
          retryAfterSeconds: error.retryAfterSeconds,
        });
        return new Response(null, {
          status: 429,
          // ⚠ ONLY when the api supplied a number. A `Retry-After` synthesised from a missing
          // cooldown would be a fabricated promise, and `Retry-After: null` is not a valid header.
          ...(error.retryAfterSeconds === null
            ? {}
            : { headers: { 'Retry-After': String(error.retryAfterSeconds) } }),
        });
      }
      if (error instanceof SessionStatementUnavailableError) {
        log.error('Session statement PDF gate resolution failed', {
          sessionId,
          userId: user.id,
          lens,
          ...errorFields(error),
        });
        return new Response(null, { status: 500 });
      }
      throw error;
    }

    // `null` absorbs missing / unauthorised / WRONG-LENS alike — one 404, no existence leak.
    // `isStatementDownloadable` additionally refuses the pending, cancelled and zero-money
    // shapes: there is nothing worth forwarding for a call that was never billed.
    if (view === null || !isStatementDownloadable(view)) {
      return new Response(null, { status: 404 });
    }

    let body: Buffer;
    try {
      body = await renderSessionStatementPdfToBuffer({ view });
    } catch (error) {
      log.error('Session statement PDF render failed', { sessionId, lens, ...errorFields(error) });
      return new Response(null, { status: 500 });
    }

    trackServerAndFlush(CASE_BILLING_SERVER_EVENTS.SESSION_STATEMENT_DOWNLOADED, {
      session_id: sessionId,
      lens,
      distinct_id: user.id,
    });

    const bytes = new Uint8Array(body);
    const fileName = statementPdfFileName(lens, view.occurredAtIso, sessionId);
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, no-store',
      },
    });
  };
}
