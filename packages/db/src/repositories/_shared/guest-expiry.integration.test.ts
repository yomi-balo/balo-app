import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../client';
import { meetingGuests } from '../../schema';
import { meetingFactory, meetingGuestFactory } from '../../test/factories';
import { extendGuestExpiryForMeetingTx } from './guest-expiry';

const DAY_MS = 86_400_000;

describe('extendGuestExpiryForMeetingTx (BAL-409)', () => {
  it('pushes every LIVE guest link out, and reports how many moved', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + DAY_MS);
    const live = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon },
    });
    const revoked = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon, revokedAt: new Date() },
    });

    const later = new Date(Date.now() + 30 * DAY_MS);
    await expect(extendGuestExpiryForMeetingTx(db, meeting.id, later)).resolves.toBe(1);

    const [movedLive] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, live.guest.id));
    const [untouchedRevoked] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, revoked.guest.id));
    expect(movedLive?.expiresAt.getTime()).toBe(later.getTime());
    expect(untouchedRevoked?.expiresAt.getTime()).toBe(soon.getTime());
  });

  it('NEVER SHORTENS a window — moving a meeting earlier is not a silent revocation', async () => {
    const { meeting } = await meetingFactory();
    const far = new Date(Date.now() + 30 * DAY_MS);
    const seeded = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: far },
    });

    await expect(
      extendGuestExpiryForMeetingTx(db, meeting.id, new Date(Date.now() + DAY_MS))
    ).resolves.toBe(0);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, seeded.guest.id));
    expect(row?.expiresAt.getTime()).toBe(far.getTime());
  });

  // B7 — a never-admitted lobby knock (a public, self-declared `POST /meetings/:meetingId/
  // lobby` write, no host approval ever in the loop) must not have its expiry re-armed by a
  // reschedule it was never entitled to be extended by.
  it('B7 — ignores a pending (un-admitted) guest — does not re-arm its expiry', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + DAY_MS);
    const pending = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon, admission: 'pending', admissionDecidedAt: null },
    });

    const later = new Date(Date.now() + 30 * DAY_MS);
    await expect(extendGuestExpiryForMeetingTx(db, meeting.id, later)).resolves.toBe(0);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, pending.guest.id));
    expect(row?.expiresAt.getTime()).toBe(soon.getTime());
  });

  // B7 — a `denied` guest is terminal and must never be resurrected into a live handle by a
  // later reschedule extending its expiry.
  it('B7 — ignores a denied guest', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + DAY_MS);
    const denied = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon, admission: 'denied', admissionDecidedAt: new Date() },
    });

    const later = new Date(Date.now() + 30 * DAY_MS);
    await expect(extendGuestExpiryForMeetingTx(db, meeting.id, later)).resolves.toBe(0);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, denied.guest.id));
    expect(row?.expiresAt.getTime()).toBe(soon.getTime());
  });

  it('extends an ADMITTED (not just pre_admitted) guest too', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + DAY_MS);
    const admitted = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon, admission: 'admitted', admissionDecidedAt: new Date() },
    });

    const later = new Date(Date.now() + 30 * DAY_MS);
    await expect(extendGuestExpiryForMeetingTx(db, meeting.id, later)).resolves.toBe(1);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, admitted.guest.id));
    expect(row?.expiresAt.getTime()).toBe(later.getTime());
  });

  it('ignores soft-deleted rows', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + DAY_MS);
    const softDeleted = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon, deletedAt: new Date() },
    });

    const later = new Date(Date.now() + 30 * DAY_MS);
    await expect(extendGuestExpiryForMeetingTx(db, meeting.id, later)).resolves.toBe(0);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, softDeleted.guest.id));
    expect(row?.expiresAt.getTime()).toBe(soon.getTime());
  });

  it('composes under a caller-supplied tx — rolls back with the transaction', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + DAY_MS);
    const seeded = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon },
    });
    const later = new Date(Date.now() + 30 * DAY_MS);

    class RollbackSignal extends Error {}
    await expect(
      db.transaction(async (tx) => {
        const moved = await extendGuestExpiryForMeetingTx(tx, meeting.id, later);
        expect(moved).toBe(1);
        throw new RollbackSignal();
      })
    ).rejects.toThrow(RollbackSignal);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, seeded.guest.id));
    // The outer test transaction is itself rolled back by the harness, but within THIS test
    // the inner tx's rollback must already have restored the pre-call value.
    expect(row?.expiresAt.getTime()).toBe(soon.getTime());
  });
});
