'use server';

import 'server-only';

import { db, users, expertProfiles, companyMembers, sql, desc } from '@balo/db';
import { log } from '@/lib/logging';

export interface AdminUserRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  platformRole: 'user' | 'admin' | 'super_admin';
  activeMode: 'client' | 'expert';
  onboardingCompleted: boolean;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: Date;
  expertProfileCount: number;
  applicationStatus: string | null;
  companyMembershipCount: number;
}

export async function listUsersAction(): Promise<AdminUserRow[]> {
  if (process.env.NODE_ENV === 'production') return [];
  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        platformRole: users.platformRole,
        activeMode: users.activeMode,
        onboardingCompleted: users.onboardingCompleted,
        status: users.status,
        createdAt: users.createdAt,
        expertProfileCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${expertProfiles}
          WHERE ${expertProfiles.userId} = ${users.id}
        )`,
        applicationStatus: sql<string | null>`(
          SELECT ${expertProfiles.applicationStatus} FROM ${expertProfiles}
          WHERE ${expertProfiles.userId} = ${users.id}
          LIMIT 1
        )`,
        companyMembershipCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${companyMembers}
          WHERE ${companyMembers.userId} = ${users.id}
        )`,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    return rows;
  } catch (error) {
    log.error('Failed to list users for admin-dev', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return [];
  }
}
