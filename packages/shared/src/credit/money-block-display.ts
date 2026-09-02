/**
 * BAL-441 (plan §6) — `durationLine` and `finalizedAmountMinor`, MOVED VERBATIM out of
 * `apps/web/src/components/balo/recap/money-block.tsx` (comments included), not rewritten.
 *
 * The invariant `apps/web/src/invariants/no-money-block-in-call.test.ts` scans the live-call
 * render tree for the substring `recap/money-block` — a MODULE-SPECIFIER match, not a "this
 * logic must live in React" rule. `@balo/shared/credit` is a subpath the in-call panel already
 * imports today (`components/balo/credit/in-call-balance-panel.tsx` imports `DrawdownState`
 * from here), so moving these two pure functions here cannot trip that scan — the specifier
 * the scan matches never appears again.
 *
 * A second, independent reason to move them: `money-block.tsx` is `'use client'` and imports
 * `useEffect` + `track`. The new BAL-441 consumers are an RSC (`apps/web/.../_lib/`) and a
 * `@react-pdf/renderer` document rendered in a Node Route Handler — importing a `'use client'`
 * React module from either to reach a pure string function would drag the client component
 * graph and the analytics client into a server-only render path.
 *
 * Dependency-free (no `@balo/db`, no React, no I/O) — safe for the client bundle, an RSC and a
 * Node Route Handler alike.
 */
import type { SessionMoneyBlock } from './money-block';

/** The own-side finalized amount for the lens (client all-in vs expert earnings). */
export function finalizedAmountMinor(block: SessionMoneyBlock): number {
  return block.lens === 'client' ? block.amountAudMinor : block.earningsAudMinor;
}

/**
 * BAL-412 (D13, plan §7.3) — the finalized duration line. Keyed on `settlementShape` FIRST (the
 * two zero shapes have no number to attach — there is nothing to floor when nobody was charged)
 * and on `billingFloorApplied` second. `no_show_client` is checked ahead of `billingFloorApplied`
 * — that shape now ALWAYS sets the flag (the floor is flatly the whole charge, owner ruling
 * 2026-08-21), but it wants its own "min held" phrasing rather than the generic short-call one,
 * so it must be matched first.
 *
 * Quiet fact, never punitive, never scolding, gender-neutral, no absence framing — the same
 * register as the booking-flow billing line.
 *
 * ⚠ MJ COPY CHECKPOINT — all six strings below are pending MJ sign-off (flagged in the PR body).
 * ⚠ BAL-441 — THIS MOVED FROM `money-block.tsx` (see this module's docblock for why the move is
 * safe against `no-money-block-in-call.test.ts`; that test's scan is a module-specifier match,
 * not a "must stay in React" rule).
 */
export function durationLine(block: SessionMoneyBlock): string {
  if (block.settlementShape === 'missed_call') {
    return block.lens === 'client'
      ? "Not charged — your consultant didn't join this time" // pending-MJ
      : "No earnings recorded — the call didn't take place"; // pending-MJ
  }
  if (block.settlementShape === 'abandoned_wait') {
    // F12(b), UX review round 1 — `actualMinutes` (the real connected time before the
    // session was abandoned) is deliberately NOT surfaced here: "Not charged"/"No earnings
    // recorded" plus a partial-minute figure reads as more detail than an abandoned session
    // warrants. Revisit if MJ copy sign-off disagrees.
    return block.lens === 'client' ? 'Not charged' : 'No earnings recorded'; // pending-MJ
  }
  if (block.settlementShape === 'no_show_client') {
    // F9, UX review round 1 — `actualMinutes`, not `durationMinutes`: `durationMinutes` is the
    // BILLED figure, which on this shape is FLATLY the floor (owner ruling 2026-08-21), so it
    // would state the floor twice while discarding the real time the expert held the room.
    // "40 min held · billed at the 15-minute minimum" is now a TRUE statement — before R1 the
    // client was actually charged 40 while this line claimed 15.
    return block.lens === 'client'
      ? `${block.actualMinutes} min held · billed at the ${block.billingFloorMinutes}-minute minimum` // pending-MJ
      : `${block.actualMinutes} min held · paid the ${block.billingFloorMinutes}-minute minimum`; // pending-MJ
  }
  if (block.billingFloorApplied) {
    return block.lens === 'client'
      ? `${block.actualMinutes} min · billed at the ${block.billingFloorMinutes}-minute minimum` // pending-MJ
      : `${block.actualMinutes} min · paid the ${block.billingFloorMinutes}-minute minimum`; // pending-MJ
  }
  return `${block.durationMinutes} min`; // pending-MJ
}
