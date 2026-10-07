import 'server-only';

import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { authorizeMeetingParticipation } from './meeting-participation';

/**
 * BAL-579 — where a SIGNED-IN participant who opened the anonymous lobby link belongs: the member
 * call route, `/meetings/{meetingId}/call`, or `null` when the visitor should see the lobby.
 *
 * ⚠ ANONYMOUS VISITORS RETURN `null` BEFORE ANY REPOSITORY READ, so the lobby's zero-read
 * guarantee for a visitor holding a guessed uuid is untouched.
 *
 * ⚠ A NON-PARTICIPANT ALSO GETS `null`, indistinguishable from an anonymous visitor, so the page
 * is no existence oracle: only somebody already entitled to see the meeting is redirected.
 *
 * ⚠ NEVER THROWS. A failed read degrades to the lobby (`null`) with a `warn`; the caller
 * redirects OUTSIDE any try/catch because `redirect()` works by throwing.
 *
 * Lives in `lib/authz/`, not `lib/meetings/`, because `meeting-call-no-lens-gate.test.ts` scans
 * the latter and the participation seam it calls is deliberately kept out of that tree.
 */
export async function resolveLobbyMemberRedirect(meetingId: string): Promise<string | null> {
  try {
    const user = await getCurrentUser();
    if (user === null) return null;

    const result = await authorizeMeetingParticipation({ meetingId, userId: user.id });
    return result.ok ? memberCallPath(meetingId) : null;
  } catch (error) {
    log.warn('Lobby member redirect check failed — showing the lobby', {
      meetingId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
