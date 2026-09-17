import {
  resolveEntityListNavEntry,
  resolveNavItems,
  type NavContext,
} from '@/components/layout/nav-registry';
import { UP_NEXT_OPEN_CALENDAR } from './up-next-copy';
import type { UpNextFooterLink, UpNextWorkspaceType } from './up-next-view-types';

/**
 * BAL-566 (D12) — the Up next card's footer links, resolved through the nav registry so the
 * label always matches what the sidebar shows (surviving a future Cases nav-entry rename with no
 * hand-typed label literal here). Missing entries are skipped, never rendered disabled.
 */
function companyFooterLinks(context: NavContext): readonly UpNextFooterLink[] {
  const links: UpNextFooterLink[] = [];
  const cases = resolveEntityListNavEntry(context, 'cases');
  if (cases !== undefined) {
    links.push({ target: 'cases', label: cases.label, href: cases.href });
  }
  const projects = resolveEntityListNavEntry(context, 'projects');
  if (projects !== undefined) {
    links.push({ target: 'projects', label: projects.label, href: projects.href });
  }
  return links;
}

function expertFooterLinks(context: NavContext): readonly UpNextFooterLink[] {
  const calendar = resolveNavItems(context, 'primary').find((entry) => entry.key === 'calendar');
  return calendar === undefined
    ? []
    : [{ target: 'calendar', label: UP_NEXT_OPEN_CALENDAR, href: calendar.href }];
}

const FOOTER_LINKS_BY_WORKSPACE: Record<
  UpNextWorkspaceType,
  (context: NavContext) => readonly UpNextFooterLink[]
> = {
  company: companyFooterLinks,
  expert: expertFooterLinks,
};

/**
 * BAL-566 fix round 1 (F6) — `workspaceType` is now an EXPLICIT second argument, never read off
 * `context.workspaceType`. `page.tsx` can render the COMPANY branch for a session whose
 * `navContext.workspaceType` is `'expert'` (an expert-mode user with no `expertProfileId`, R1 /
 * D11) — reading `context.workspaceType` here silently handed that company render the expert's
 * "Open calendar" footer link instead of Cases/Projects. The caller now passes the workspace it
 * actually decided to render.
 */
export function resolveUpNextFooterLinks(
  context: NavContext,
  workspaceType: UpNextWorkspaceType
): readonly UpNextFooterLink[] {
  return FOOTER_LINKS_BY_WORKSPACE[workspaceType](context);
}
