import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  userFactory,
  companyFactory,
  companyMemberFactory,
  meetingFactory,
  meetingAuditEventFactory,
} from '../test/factories';
import { clientPartyRecipientsRepository } from './client-party-recipients';

/**
 * Integration tests for the client-party recipient resolver. Per-test transaction,
 * auto-rolled-back.
 */

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');

async function seedCompany(): Promise<{ companyId: string; ownerId: string; adminId: string }> {
  const company = await companyFactory();
  const owner = await userFactory();
  const admin = await userFactory();
  await companyMemberFactory({ companyId: company.id, userId: owner.id, role: 'owner' });
  await companyMemberFactory({ companyId: company.id, userId: admin.id, role: 'admin' });
  return { companyId: company.id, ownerId: owner.id, adminId: admin.id };
}

async function seedBookedMeeting(bookerUserId: string | null): Promise<string> {
  const { meeting } = await meetingFactory();
  await meetingAuditEventFactory({
    meetingId: meeting.id,
    action: 'meeting.booked',
    createdAt: T0,
    actorUserId: bookerUserId,
  });
  return meeting.id;
}

describe('clientPartyRecipientsRepository.resolveClientPartyRecipients', () => {
  it('appends a member booker after the admins', async () => {
    const { companyId, ownerId, adminId } = await seedCompany();
    const booker = await userFactory();
    await companyMemberFactory({ companyId, userId: booker.id, role: 'member' });
    const meetingId = await seedBookedMeeting(booker.id);

    const result = await clientPartyRecipientsRepository.resolveClientPartyRecipients({
      meetingId,
      companyId,
    });

    expect(result.includedBookingMember).toBe(true);
    expect(result.recipientUserIds).toHaveLength(3);
    expect(result.recipientUserIds.slice(0, 2).sort()).toEqual([ownerId, adminId].sort());
    expect(result.recipientUserIds[2]).toBe(booker.id);
  });

  it('lists an admin booker once', async () => {
    const { companyId, ownerId, adminId } = await seedCompany();
    const meetingId = await seedBookedMeeting(adminId);

    const result = await clientPartyRecipientsRepository.resolveClientPartyRecipients({
      meetingId,
      companyId,
    });

    expect(result.includedBookingMember).toBe(true);
    expect([...result.recipientUserIds].sort()).toEqual([ownerId, adminId].sort());
  });

  it('excludes a booker whose membership was soft-removed', async () => {
    const { companyId, ownerId, adminId } = await seedCompany();
    const booker = await userFactory();
    await companyMemberFactory({
      companyId,
      userId: booker.id,
      role: 'member',
      deletedAt: new Date(),
    });
    const meetingId = await seedBookedMeeting(booker.id);

    const result = await clientPartyRecipientsRepository.resolveClientPartyRecipients({
      meetingId,
      companyId,
    });

    expect(result.includedBookingMember).toBe(false);
    expect([...result.recipientUserIds].sort()).toEqual([ownerId, adminId].sort());
  });

  it('returns the admins only when the meeting has no meeting.booked row', async () => {
    const { companyId, ownerId, adminId } = await seedCompany();
    const { meeting } = await meetingFactory();

    const result = await clientPartyRecipientsRepository.resolveClientPartyRecipients({
      meetingId: meeting.id,
      companyId,
    });

    expect(result.includedBookingMember).toBe(false);
    expect([...result.recipientUserIds].sort()).toEqual([ownerId, adminId].sort());
  });

  it('returns the admins only when the meeting.booked row has a NULL actor', async () => {
    const { companyId, ownerId, adminId } = await seedCompany();
    const meetingId = await seedBookedMeeting(null);

    const result = await clientPartyRecipientsRepository.resolveClientPartyRecipients({
      meetingId,
      companyId,
    });

    expect(result.includedBookingMember).toBe(false);
    expect([...result.recipientUserIds].sort()).toEqual([ownerId, adminId].sort());
  });

  it('returns the booker alone when the company has no admins', async () => {
    const company = await companyFactory();
    const booker = await userFactory();
    await companyMemberFactory({ companyId: company.id, userId: booker.id, role: 'member' });
    const meetingId = await seedBookedMeeting(booker.id);

    const result = await clientPartyRecipientsRepository.resolveClientPartyRecipients({
      meetingId,
      companyId: company.id,
    });

    expect(result).toEqual({ recipientUserIds: [booker.id], includedBookingMember: true });
  });
});

describe('clientPartyRecipientsRepository.findMeetingBookerUserId', () => {
  it('returns the meeting.booked actor and ignores a later meeting.rescheduled actor', async () => {
    const booker = await userFactory();
    const rescheduler = await userFactory();
    const { meeting } = await meetingFactory();
    await meetingAuditEventFactory({
      meetingId: meeting.id,
      action: 'meeting.booked',
      createdAt: T0,
      actorUserId: booker.id,
    });
    await meetingAuditEventFactory({
      meetingId: meeting.id,
      action: 'meeting.rescheduled',
      createdAt: T1,
      actorUserId: rescheduler.id,
    });

    expect(await clientPartyRecipientsRepository.findMeetingBookerUserId(meeting.id)).toBe(
      booker.id
    );
  });

  it('returns null for a meeting with no audit rows', async () => {
    expect(await clientPartyRecipientsRepository.findMeetingBookerUserId(randomUUID())).toBeNull();
  });
});

describe('clientPartyRecipientsRepository.bookerStillParticipatesInCompany', () => {
  it('is true for a live member', async () => {
    const company = await companyFactory();
    const user = await userFactory();
    await companyMemberFactory({ companyId: company.id, userId: user.id, role: 'member' });

    expect(
      await clientPartyRecipientsRepository.bookerStillParticipatesInCompany(company.id, user.id)
    ).toBe(true);
  });

  it('is false for a member of a different company', async () => {
    const company = await companyFactory();
    const other = await companyFactory();
    const user = await userFactory();
    await companyMemberFactory({ companyId: other.id, userId: user.id, role: 'member' });

    expect(
      await clientPartyRecipientsRepository.bookerStillParticipatesInCompany(company.id, user.id)
    ).toBe(false);
  });

  it('is false for a soft-removed member', async () => {
    const company = await companyFactory();
    const user = await userFactory();
    await companyMemberFactory({
      companyId: company.id,
      userId: user.id,
      role: 'member',
      deletedAt: new Date(),
    });

    expect(
      await clientPartyRecipientsRepository.bookerStillParticipatesInCompany(company.id, user.id)
    ).toBe(false);
  });
});
