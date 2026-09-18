import type { Metadata } from 'next';
import { z } from 'zod';
import { JoinUnavailableNotice } from '@/components/balo/meetings/join-notice-card';
import { lobbyPath } from '@/lib/meetings/join-link';
import { LobbyResumeClient } from './lobby-resume-client';

// Consistent with the lobby's own segment; the Server Action this route eventually leans on
// (indirectly, via the lobby's own affordance) is Node-only.
export const runtime = 'nodejs';
// Never statically cached — a public join surface must not be served under conditions a CDN
// reasoned about on its own.
export const dynamic = 'force-dynamic';

/**
 * ⚠ A NEUTRAL TITLE AND `noindex`, matching the lobby's own metadata — this segment sits one
 * hop before it. `referrer: 'no-referrer'` is NOT re-declared: it is inherited from
 * `app/join/layout.tsx`, which children override only title/robots, and this segment carries a
 * RAW GUEST TOKEN in its own URL — the one landing on this whole route tree that needs it most.
 */
export const metadata: Metadata = {
  title: 'Join a meeting — Balo',
  robots: { index: false, follow: false },
};

interface LobbyResumePageProps {
  /** ⚠ Next 16: a Promise. A sync interface silently yields `undefined` for every key. */
  params: Promise<{ meetingId: string; token: string }>;
}

const meetingIdSchema = z.string().uuid();
/**
 * ⚠ THE SAME BOUNDS THE api's `guestJoinBodySchema` USES (`apps/api/routes/meetings/join.schema.ts`),
 * not a hand-rolled regex — the shipped mint is 43 base64url characters, but pinning the exact
 * length here would turn a future token-format change into an "unavailable" card on every
 * existing link. The real validation is the hash lookup, one navigation later.
 */
const tokenSchema = z.string().min(20).max(200);

/**
 * BAL-442 (RULING 3) — the RESUME landing an emailed re-entry link points at:
 * `/join/m/{meetingId}/resume/{token}`. It writes the raw token into the lobby's own
 * `sessionStorage` keys, then REPLACES into the clean `/join/m/{meetingId}` URL, so the
 * token-bearing URL leaves this TAB'S BACK STACK.
 *
 * ⚠ fix round (R-7) — THAT IS ALL `replace` BUYS, AND THE EARLIER WORDING OVERCLAIMED IT. This
 * page is reached by a real navigation from an email client, so the visit is already recorded
 * in the browser's own history — and, for a signed-in profile, synced — exactly as a
 * `/join/{token}` landing is. The exposure of this form EQUALS that one; `replace` only keeps
 * a Back press from re-landing on the credential. What the path form actually buys over a
 * `?rt=` query string is the SERVER-SIDE surfaces: `redactSensitivePathPrefixes` covers it
 * (BLOCKER B), where a query string lands in logs and referrer headers unredacted.
 *
 * ⚠⚠ ZERO DATABASE READS — the acceptance criterion of this file, exactly as the lobby page's
 * (`m/[meetingId]/page.tsx`) own. The token is NOT resolved here: resolution happens on the
 * lobby's `guest-join` poll, one navigation later. That keeps this page free of any oracle,
 * free of any `meetingGuestsRepository` reference (so `join-link-never-writes.test.ts`'s
 * participation-mutator and allow-list assertions are trivially satisfied here), and free of a
 * GET that stamps `recordAccess`.
 *
 * ⚠⚠ BLOCKER C — THE `/join/` STRING LITERAL IS BANNED INSIDE `app/join`
 * (`join-link-never-writes.test.ts`). `router.replace('/join/m/…')` cannot be written in the
 * CLIENT component below, and `lib/meetings/join-link.ts` begins `import 'server-only'`, so a
 * client component cannot import the builder either. This SERVER page calls {@link lobbyPath}
 * and passes the result down as a plain `destination` string prop.
 *
 * ⚠ REJECTED: reusing `/join/[token]` — that route's `page.tsx` asserts a self-claimed lobby
 * row never reaches it, and it drags in the roster/inviter path. REJECTED: a `?rt=` query
 * string — likeliest to land in logs and referrer headers.
 */
export default async function LobbyResumePage({
  params,
}: Readonly<LobbyResumePageProps>): Promise<React.JSX.Element> {
  const { meetingId, token } = await params;

  if (!meetingIdSchema.safeParse(meetingId).success || !tokenSchema.safeParse(token).success) {
    // ⚠ THE SAME PROPLESS CARD every other collapsed failure on this route tree renders.
    return <JoinUnavailableNotice />;
  }

  return (
    <LobbyResumeClient
      meetingId={meetingId}
      token={token}
      // ⚠ BLOCKER C — built on the SERVER, passed down as a plain string.
      destination={lobbyPath(meetingId)}
    />
  );
}
