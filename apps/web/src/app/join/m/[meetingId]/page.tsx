import type { Metadata } from 'next';
import { z } from 'zod';
import { JoinUnavailableNotice } from '@/components/balo/meetings/join-notice-card';
import { LobbyClient } from './lobby-client';

// No `node:crypto` and no Drizzle here (see below), but the segment stays on Node for
// consistency with its sibling and because the Server Actions it mounts are Node-only.
export const runtime = 'nodejs';
// Never statically cached: the card is constant, but caching a public join surface invites a
// CDN to serve it under conditions nobody reasoned about.
export const dynamic = 'force-dynamic';

/**
 * ⚠ A NEUTRAL TITLE AND `noindex`. The tab, any share preview and any search crawler must not
 * name the company, the agency, the expert or the meeting — and the URL carries a meeting id,
 * so an indexed page would publish the existence of a meeting to anyone who searched.
 */
export const metadata: Metadata = {
  title: 'Join a meeting — Balo',
  robots: { index: false, follow: false },
};

interface LobbyPageProps {
  /** ⚠ Next 16: this is a Promise and MUST be awaited. A sync interface silently no-ops. */
  params: Promise<{ meetingId: string }>;
}

/**
 * BAL-132 (Decision 8 + Decision 9) — the ANONYMOUS lobby landing at `/join/m/<meetingId>`.
 *
 * ⚠⚠ THIS PAGE PERFORMS **ZERO DATABASE READS**, AND THAT IS THE ACCEPTANCE CRITERION OF THE
 * FILE — not an optimisation. It renders a BYTE-IDENTICAL card for a real meeting, a
 * cancelled one, an ended one, a soft-deleted one, and a meeting id that never existed.
 *
 * Rendering "Design review with CloudPeak" to an anonymous holder of a GUESSED uuid is a
 * disclosure; rendering "no such meeting" is an existence oracle. Both are avoided by the
 * same move: know nothing at render time. Every question about this meeting is asked LATER,
 * by a POST, after the visitor has identified themselves — and `apps/api` collapses every
 * answer into one literal anyway.
 *
 * This is the same one-card property `/join/[token]` enforces (`page.test.tsx` asserts the
 * rendered-markup set has size 1), applied PRE-EMPTIVELY rather than after a lookup.
 *
 * ⚠ IT ALSO MAKES THE FILE TRIVIALLY SATISFY `join-link-never-writes.test.ts`, which scans
 * everything under `app/join` except `_actions/`: a page with no repository reference cannot
 * reference a participation mutator.
 *
 * ⚠⚠ THE ROUTE IS PUBLIC FOR FREE, BUT IT WAS **NOT** REDACTION-COVERED FOR FREE — and an
 * earlier version of this note claimed it was, "verified, not assumed". It was neither.
 * `route-config.ts`'s `'/join/'` entry does make this path public by `startsWith`, but
 * `redactSensitivePath` replaces only THE SINGLE SEGMENT FOLLOWING a prefix, and the segment
 * after `/join/` here is the literal `m` — so the output was `/join/[redacted]/{meetingId}`
 * and the id flowed on to Axiom, Sentry and PostHog's `$current_url` / `$pathname` from an
 * anonymous browser. `SENSITIVE_PATH_PREFIXES` now carries an explicit `'/join/m/'` entry,
 * ORDERED BEFORE `'/join/'` (first match wins), with the matching `PUBLIC_PREFIXES` line the
 * paired-registry invariant requires. Coverage is now asserted, not inherited.
 *
 * ⚠ IT CANNOT COLLIDE WITH `/join/[token]`: one segment versus two, and a base64url token
 * contains no `/`.
 *
 * ⚠ AND IT MUST NOT BECOME AN RSC THAT READS. If a later ticket wants to show the meeting
 * title here, it needs a NEW decision about disclosure to an unauthenticated visitor — not a
 * quiet `meetingsRepository.findById`.
 */
/**
 * ⚠⚠ THE **SAME** VALIDATOR THE ACTION USES, NOT A SECOND ONE. `claimLobbyPlaceAction`'s Zod
 * schema is `z.string().uuid()`; expressing the page's check with a hand-rolled regex would be
 * a second definition of "a meeting id" that can disagree with the one that actually refuses,
 * and the failure would look exactly like the bug below. Zod also keeps this linear and
 * anchored, so there is no S5852 surface on a caller-controlled path segment.
 */
const meetingIdSchema = z.string().uuid();

export default async function LobbyPage({
  params,
}: Readonly<LobbyPageProps>): Promise<React.JSX.Element> {
  // ⚠ AWAITED. In Next 16 `params` is a Promise; treating it as a plain object yields
  // `undefined` for every key with no error at all.
  const { meetingId } = await params;

  /**
   * ── ⚠⚠ A MALFORMED ID IS REFUSED **HERE**, NOT AFTER THE VISITOR TYPES THEIR DETAILS ─────
   *
   * `/join/m/not-a-uuid` used to render the full form. Every submit then failed the action's
   * `z.string().uuid()` and came back as `kind: 'invalid_input'`, whose copy is **"Please enter
   * your name and a valid email address."** — so the page blamed the visitor, in perpetuity,
   * for a malformed URL they were sent, with no way out and nothing they could change. A
   * permanently misleading dead-end loop.
   *
   * ⚠ IT DISCLOSES NOTHING, WHICH IS WHY IT IS SAFE TO DO AT RENDER TIME AND WHY IT DOES NOT
   * BREAK THIS FILE'S ZERO-READS ACCEPTANCE CRITERION. No lookup happens: the only fact
   * asserted is that a string the visitor can already see is not shaped like a uuid. A real
   * meeting id, a cancelled meeting's id and an id that never existed all still render the
   * form and are still indistinguishable — the property that matters is untouched.
   *
   * ⚠ AND IT RENDERS THE **SAME PROPLESS CARD** every other collapsed failure renders, so the
   * markup a scanner sees for a malformed id is byte-identical to the markup it sees after a
   * refused claim.
   */
  if (!meetingIdSchema.safeParse(meetingId).success) {
    return <JoinUnavailableNotice />;
  }

  return <LobbyClient meetingId={meetingId} />;
}
