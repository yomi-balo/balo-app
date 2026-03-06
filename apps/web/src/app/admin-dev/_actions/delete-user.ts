'use server';

import 'server-only';

import {
  db,
  users,
  expertProfiles,
  expertSkills,
  expertCertifications,
  expertLanguages,
  expertIndustries,
  workHistory,
  companyMembers,
  companies,
  agencyMembers,
  meetingGuests,
  eq,
  and,
  inArray,
} from '@balo/db';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getWorkOS } from '@/lib/auth/config';
import { log } from '@/lib/logging';

interface DeleteUserResult {
  success: boolean;
  error?: string;
  warning?: string;
}

export async function deleteUserAction(userId: string): Promise<DeleteUserResult> {
  if (process.env.NODE_ENV === 'production') {
    return { success: false, error: 'Not available in production.' };
  }

  const parsed = z.string().uuid().safeParse(userId);
  if (!parsed.success) {
    return { success: false, error: 'Invalid user ID.' };
  }

  // 1. Fetch the user to get workosId
  const [user] = await db.select().from(users).where(eq(users.id, parsed.data)).limit(1);

  if (!user) {
    return { success: false, error: 'User not found.' };
  }

  try {
    await db.transaction(async (tx) => {
      // ── Phase 1: Expert profile children ──────────────────────────
      const profileRows = await tx
        .select({ id: expertProfiles.id })
        .from(expertProfiles)
        .where(eq(expertProfiles.userId, userId));

      const profileIds = profileRows.map((r) => r.id);

      if (profileIds.length > 0) {
        await tx.delete(expertSkills).where(inArray(expertSkills.expertProfileId, profileIds));
        await tx
          .delete(expertCertifications)
          .where(inArray(expertCertifications.expertProfileId, profileIds));
        await tx
          .delete(expertLanguages)
          .where(inArray(expertLanguages.expertProfileId, profileIds));
        await tx
          .delete(expertIndustries)
          .where(inArray(expertIndustries.expertProfileId, profileIds));
        await tx.delete(workHistory).where(inArray(workHistory.expertProfileId, profileIds));
      }

      // ── Phase 2: Expert profiles ──────────────────────────────────
      await tx.delete(expertProfiles).where(eq(expertProfiles.userId, userId));

      // ── Phase 3: Nullify invitedBy references ─────────────────────
      await tx
        .update(companyMembers)
        .set({ invitedById: null })
        .where(eq(companyMembers.invitedById, userId));
      await tx
        .update(agencyMembers)
        .set({ invitedById: null })
        .where(eq(agencyMembers.invitedById, userId));

      // ── Phase 4: Guest records ────────────────────────────────────
      await tx.delete(meetingGuests).where(eq(meetingGuests.invitedById, userId));
      await tx.update(meetingGuests).set({ userId: null }).where(eq(meetingGuests.userId, userId));
      await tx
        .update(meetingGuests)
        .set({ convertedToUserId: null })
        .where(eq(meetingGuests.convertedToUserId, userId));

      // ── Phase 5: Memberships + personal companies ─────────────────
      const personalCompanyRows = await tx
        .select({ id: companies.id })
        .from(companies)
        .innerJoin(companyMembers, eq(companyMembers.companyId, companies.id))
        .where(and(eq(companyMembers.userId, userId), eq(companies.isPersonal, true)));

      const personalCompanyIds = personalCompanyRows.map((r) => r.id);

      // Delete all members of the user's personal companies (including the user themselves)
      if (personalCompanyIds.length > 0) {
        await tx
          .delete(companyMembers)
          .where(inArray(companyMembers.companyId, personalCompanyIds));
      }

      // Delete remaining company memberships for this user (non-personal companies)
      await tx.delete(companyMembers).where(eq(companyMembers.userId, userId));

      // Delete personal companies
      if (personalCompanyIds.length > 0) {
        await tx.delete(companies).where(inArray(companies.id, personalCompanyIds));
      }

      // Delete agency memberships
      await tx.delete(agencyMembers).where(eq(agencyMembers.userId, userId));

      // ── Phase 6: Delete the user ──────────────────────────────────
      await tx.delete(users).where(eq(users.id, userId));
    });

    log.info('User deleted successfully from DB', {
      userId,
      email: user.email,
    });
  } catch (error) {
    log.error('Failed to delete user from DB', {
      userId,
      email: user.email,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      success: false,
      error: 'Database deletion failed. Check server logs for details.',
    };
  }

  // ── Phase 7: WorkOS deletion (best-effort, outside transaction) ──
  let workosWarning: string | undefined;
  try {
    await getWorkOS().userManagement.deleteUser(user.workosId);
    log.info('WorkOS user deleted', { userId, workosId: user.workosId });
  } catch (error) {
    workosWarning =
      'DB deleted but WorkOS identity removal failed — user may be able to re-sign-in.';
    log.warn('Failed to delete WorkOS user (best-effort)', {
      userId,
      workosId: user.workosId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Phase 8: Future integrations ─────────────────────────────────
  // TODO: Stripe customer deletion
  // TODO: Algolia record deletion
  // TODO: Cloudflare R2 file cleanup

  revalidatePath('/admin-dev');
  return { success: true, warning: workosWarning };
}
