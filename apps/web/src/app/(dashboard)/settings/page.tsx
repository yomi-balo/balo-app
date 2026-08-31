import { redirect } from 'next/navigation';

/**
 * BAL-503 (D-A) — `/settings` unconditionally redirects to `/settings/billing`. No session read:
 * Credits & billing is the only Settings section that is both real content (balance, Top up,
 * Redeem a code) and unconditionally reachable — `company` / `notifications` are placeholders,
 * and `team` `notFound()`s for a member without `MANAGE_MEMBERS`, so neither can be the default.
 * A capability-dependent default would also cost a DB read on every `/settings` hit and leak the
 * actor's capability through the resulting URL. The tab bar (`SETTINGS_SECTION_ORDER`) keeps the
 * design reference's order regardless — only the *landing target* differs.
 */
export default function SettingsPage(): never {
  redirect('/settings/billing');
}
