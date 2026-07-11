import 'server-only';

import { usersRepository, type User } from '@balo/db';
import { AccountExistsError } from '@/lib/auth/errors';

/** Minimal WorkOS identity shape the resolver needs. */
export interface WorkosIdentity {
  id: string; // WorkOS user id (the new workosId)
  email: string;
  emailVerified: boolean; // WorkOS-asserted verification of the INCOMING identity
}

export interface ResolvedIdentity {
  user: User;
  didRelink: boolean; // true only when a workosId miss re-linked onto a live email
}

/**
 * BAL-362: non-leaky copy for the `account_exists` conflict, shared by every auth
 * entry point (mirrors the login page). Never reveals which side is unverified.
 */
export const ACCOUNT_EXISTS_MESSAGE =
  'An account with this email already exists. Please sign in with your original method.';

/**
 * BAL-362: resolve a WorkOS identity to a LIVE Balo user, re-linking a `workosId`
 * miss onto a live verified-email row when safe. The SINGLE shared resolver behind
 * the OAuth callback and the password / OTP Server Actions.
 *
 * - `findByWorkosId` hit → returns immediately, `didRelink: false` (never consults
 *   the email fallback).
 * - no `workosId` and no live email → returns `null` (the caller creates).
 * - a live email is owned under a DIFFERENT `workosId` → re-link ONLY when BOTH the
 *   incoming profile AND the existing row are verified; otherwise throw
 *   `AccountExistsError` (account-takeover guard). The seam (`relinkWorkosId`)
 *   re-enforces both guards fail-closed, so no caller can bypass them.
 */
export async function resolveLinkedUser(
  identity: WorkosIdentity
): Promise<ResolvedIdentity | null> {
  const byWorkosId = await usersRepository.findByWorkosId(identity.id);
  if (byWorkosId) return { user: byWorkosId, didRelink: false };

  const emailMatch = await usersRepository.findByEmail(identity.email);
  if (!emailMatch) return null;

  // Account-takeover guard: only re-link when BOTH sides are verified. Clean surface
  // for the caller; the seam guard below is the fail-closed backstop.
  if (identity.emailVerified !== true || emailMatch.emailVerified !== true) {
    throw new AccountExistsError(emailMatch.id);
  }

  const relinked = await usersRepository.relinkWorkosId(emailMatch.id, identity.id, {
    actorUserId: emailMatch.id,
    oldWorkosId: emailMatch.workosId,
    email: identity.email,
    emailVerified: identity.emailVerified,
  });
  return { user: relinked, didRelink: true };
}
