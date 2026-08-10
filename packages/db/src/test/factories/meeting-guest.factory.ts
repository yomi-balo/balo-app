import { randomBytes, createHash } from 'node:crypto';
import { db } from '../../client';
import { meetingGuests } from '../../schema';
import type { MeetingGuest, NewMeetingGuest } from '../../schema';
import { meetingFactory } from './meeting.factory';
import { userFactory } from './user.factory';

const DAY_MS = 86_400_000;

let seq = 0;

interface MeetingGuestFactoryOverrides {
  /** Reuse an existing meeting instead of seeding a fresh one (with its default case context). */
  meetingId?: string;
  /** The inviter. Defaults to a fresh user. */
  invitedById?: string;
  /**
   * Row-level overrides (email, party, participationRole, accessScope, admission,
   * expiresAt, revokedAt, deletedAt, …).
   *
   * ⚠ Passing `values.tokenHash` DECOUPLES the returned `rawToken` from the stored hash —
   * deliberately available (a "wrong token" fixture needs it), but never do it by accident:
   * the returned `rawToken` would then resolve nothing.
   */
  values?: Partial<NewMeetingGuest>;
}

export interface MeetingGuestFactoryResult {
  guest: MeetingGuest;
  /**
   * The RAW token — returned so landing tests exercise a REAL hash lookup rather than
   * reading `guest.tokenHash` back out and thereby testing nothing. Production never gets a
   * second chance at this value; the fixture does, because it minted it.
   */
  rawToken: string;
  meetingId: string;
  invitedById: string;
}

/**
 * Seeds one LIVE `meeting_guests` row (client-side `guest`, `meeting` scope, `email`
 * channel, `pre_admitted`, expiring in 7 days), hashing the raw token exactly as the
 * production caller does — `sha256(raw).hex`, with the hashing in the CALLER and never in
 * `@balo/db` (`meeting-guests.ts` imports no `node:crypto`; only this factory does).
 *
 * Inserts DIRECTLY via `db` rather than through `meetingGuestsRepository.createMany` (the
 * `proposal-share-link.factory` / `review.factory` precedent) so a test can force states the
 * write path refuses to produce — a revoked, expired or soft-deleted guest, a `pending`
 * admission (which has no producer at all in BAL-408), or an expert-side row.
 *
 * The default `email` is per-call unique so two guests on ONE meeting do not trip
 * `meeting_guest_meeting_email_live_idx` by accident; a test that MEANS to trip it passes
 * the same `values.email` twice, explicitly.
 */
export async function meetingGuestFactory(
  overrides: MeetingGuestFactoryOverrides = {}
): Promise<MeetingGuestFactoryResult> {
  seq++;

  const meetingId = overrides.meetingId ?? (await meetingFactory()).meeting.id;
  const invitedById = overrides.invitedById ?? (await userFactory()).id;

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const [guest] = await db
    .insert(meetingGuests)
    .values({
      meetingId,
      invitedById,
      email: `guest${seq}-${Date.now()}@northwind.test`,
      name: 'Guest Person',
      emailDomain: 'northwind.test',
      party: 'client',
      participationRole: 'guest',
      accessScope: 'meeting',
      inviteChannel: 'email',
      admission: 'pre_admitted',
      tokenHash,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      ...overrides.values,
    })
    .returning();
  if (guest === undefined) {
    throw new Error('meeting guest insert failed');
  }

  return { guest, rawToken, meetingId, invitedById };
}
