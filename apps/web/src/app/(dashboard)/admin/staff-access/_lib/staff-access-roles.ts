import type { PlatformRole } from '@balo/shared/parties';
import { PLATFORM_ROLE_LABELS } from '@balo/shared/authz';

/**
 * BAL-561 — the platform-role order and copy the Staff access role picker renders. `PlatformRole`
 * is exported from `@balo/shared/authz` (re-exported from `@balo/shared/parties`), so
 * `satisfies readonly PlatformRole[]` is checked against the real union rather than a hand-rolled
 * tuple — a fourth role added to the enum fails `tsc` here until this order is updated.
 */
export const STAFF_ACCESS_ROLE_ORDER = [
  'user',
  'admin',
  'super_admin',
] as const satisfies readonly PlatformRole[];

export interface StaffAccessRoleCopy {
  readonly title: string;
  readonly description: string;
  readonly tone: 'neutral' | 'primary';
}

/**
 * `title` is `PLATFORM_ROLE_LABELS[role]` — the SAME wording the Lookup Timeline's role-change
 * sentence uses, so a role never reads two different names on two surfaces. `description` is the
 * prototype's `ROLES[].desc` verbatim (`.claude/design-references/staff-access.jsx`).
 */
export const STAFF_ACCESS_ROLE_COPY: Readonly<Record<PlatformRole, StaffAccessRoleCopy>> = {
  user: {
    title: PLATFORM_ROLE_LABELS.user,
    description: 'An ordinary Balo account. Cannot open the admin area.',
    tone: 'neutral',
  },
  admin: {
    title: PLATFORM_ROLE_LABELS.admin,
    description: 'Support and operations. Works the queues, runs requests, manages money settings.',
    tone: 'neutral',
  },
  super_admin: {
    title: PLATFORM_ROLE_LABELS.super_admin,
    description: 'Everything an admin can do, plus impersonation, job re-drives, and this page.',
    tone: 'primary',
  },
};
