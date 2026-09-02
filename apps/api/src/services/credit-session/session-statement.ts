/**
 * BAL-441 (plan §4) — `GET /sessions/:id/statement`'s resolver. Serves money (the existing,
 * UNMODIFIED `ClientMoneyBlock` / `ExpertMoneyBlock` builders) AND the receipt-only context
 * (date, subject, counterparty, back-link, payout reference) in ONE lens-discriminated payload,
 * off the SAME `resolveSessionLens` decision the money-block route uses — so the two can never
 * disagree about which session/lens they describe.
 *
 * ⚠ `packages/shared/src/credit/money-block.ts` is NOT touched here. Not one line.
 */
import {
  creditSessionsRepository,
  expertPayoutRecordsRepository,
  toClientMoneyBlock,
  toExpertMoneyBlock,
  type SessionStatementContextRow,
} from '@balo/db';
import type {
  SessionStatement,
  ClientSessionStatementContext,
  ExpertSessionStatementContext,
  SessionStatementCounterparty,
} from '@balo/shared/credit';
import { personDisplayName } from '@balo/shared/parties';
import { resolveSessionLens } from './resolve-session-lens.js';

export type ResolveSessionStatementResult =
  | { ok: true; statement: SessionStatement }
  | { ok: false; code: 'not_found' };

/** `connectedAt ?? endedAt`, ISO-8601 UTC — `null` when the session never connected. */
function occurredAtIso(row: SessionStatementContextRow): string | null {
  const at = row.connectedAt ?? row.endedAt;
  return at === null ? null : at.toISOString();
}

/**
 * CLIENT lens counterparty — the delivering EXPERT PERSON, with the expert's AGENCY on first
 * mention (`null` for an independent expert). Mirrors
 * `apps/web/.../resolve-counterparty.ts`'s semantics (the two-line form is enough here — this
 * module does not need the React-free party-card shape that file also builds).
 */
function clientCounterparty(row: SessionStatementContextRow): SessionStatementCounterparty {
  const name = personDisplayName(row.expertFirstName, row.expertLastName, 'An expert');
  const orgLabel = row.expertProfileType === 'agency' ? (row.agencyName ?? null) : null;
  return { name, orgLabel };
}

/**
 * EXPERT lens counterparty — the client COMPANY, never a client person (plan §C3, following the
 * shipped `resolve-counterparty.ts` precedent: client-side rights sit on COMPANY membership,
 * CLAUDE.md's attribution rule, and there is no single client PERSON to name here).
 */
function expertCounterparty(row: SessionStatementContextRow): SessionStatementCounterparty {
  return { name: row.companyName, orgLabel: null };
}

/** Both lenses' shared context fields, built once. */
function baseContext(row: SessionStatementContextRow) {
  return {
    occurredAtIso: occurredAtIso(row),
    title: row.caseTitle,
    meetingId: row.meetingId,
    cancelled: row.status === 'cancelled',
  };
}

/**
 * Resolve the whole statement (money block + context) for `sessionId` + the authenticated
 * `userId`. `not_found` short-circuits BEFORE either projected read — existence stays hidden at
 * the service, matching `resolveSessionMoneyBlock`.
 */
export async function resolveSessionStatement(
  sessionId: string,
  userId: string
): Promise<ResolveSessionStatementResult> {
  const grant = await resolveSessionLens(sessionId, userId);
  if (!grant.ok) {
    return { ok: false, code: 'not_found' };
  }

  if (grant.lens === 'client') {
    const [view, contextRow] = await Promise.all([
      creditSessionsRepository.findForClientMoneyView(sessionId),
      creditSessionsRepository.findStatementContext(sessionId),
    ]);
    if (view === undefined || contextRow === undefined) {
      return { ok: false, code: 'not_found' };
    }
    const context: ClientSessionStatementContext = {
      ...baseContext(contextRow),
      counterparty: clientCounterparty(contextRow),
    };
    // ⚠ Constructed ARM-BY-ARM (`load-recap.ts:461-477`'s house rule) — never a spread over a
    // shared base plus a conditional payout field. The discriminant makes the expert-only
    // `payout` field UNREPRESENTABLE on this arm.
    return { ok: true, statement: { lens: 'client', block: toClientMoneyBlock(view), context } };
  }

  const [view, contextRow, payout] = await Promise.all([
    creditSessionsRepository.findForExpertView(sessionId),
    creditSessionsRepository.findStatementContext(sessionId),
    expertPayoutRecordsRepository.findBySession(sessionId),
  ]);
  if (view === undefined || contextRow === undefined) {
    return { ok: false, code: 'not_found' };
  }
  const context: ExpertSessionStatementContext = {
    ...baseContext(contextRow),
    counterparty: expertCounterparty(contextRow),
    // ⚠ `expert_payout_records.amountMinor` is deliberately NOT carried — the expert's own
    // earnings already cross as `block.earningsAudMinor`; a second copy could disagree.
    payout:
      payout === undefined
        ? null
        : { reference: payout.id, recordedAtIso: payout.recordedAt.toISOString() },
  };
  return {
    ok: true,
    statement: { lens: 'expert', block: toExpertMoneyBlock(view, payout?.status), context },
  };
}
