import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolveUpNextFooterLinks } from './up-next-footer-links';
import { resolveBreadcrumbTrail, type NavContext } from '@/components/layout/nav-registry';
import { resolveRouteDir } from '@/invariants/_source-scan';

const COMPANY_CONTEXT: NavContext = { workspaceType: 'company', capabilities: [] };
const EXPERT_CONTEXT: NavContext = { workspaceType: 'expert', capabilities: [] };

describe('resolveUpNextFooterLinks (BAL-566 D12)', () => {
  it('company: the cases link matches the /cases/:id crumb parent href, plus Projects', () => {
    const [crumb] = resolveBreadcrumbTrail('/cases/case-1');
    const links = resolveUpNextFooterLinks(COMPANY_CONTEXT, 'company');
    const casesLink = links.find((link) => link.target === 'cases');
    const projectsLink = links.find((link) => link.target === 'projects');
    expect(casesLink?.href).toBe(crumb?.href);
    expect(projectsLink?.label).toBe('Projects');
    expect(projectsLink?.href).toBe('/projects');
  });

  it('expert: "Open calendar" -> /expert/calendar', () => {
    const links = resolveUpNextFooterLinks(EXPERT_CONTEXT, 'expert');
    expect(links).toEqual([
      { target: 'calendar', label: 'Open calendar', href: '/expert/calendar' },
    ]);
  });

  it('F6: the EXPLICIT workspaceType argument wins over context.workspaceType — an expert-mode session rendering the company branch still gets Cases/Projects', () => {
    // The exact bug shape: navContext says 'expert' (BAL-566 D11's activeMode-derived workspace
    // type), but the caller decided to render the COMPANY dashboard branch (no expertProfileId).
    const links = resolveUpNextFooterLinks(EXPERT_CONTEXT, 'company');
    expect(links.map((link) => link.target)).toEqual(['cases', 'projects']);
  });

  it('never spells out the "consultations" literal in its own source (D12)', () => {
    const path = resolveRouteDir([
      'src/app/(dashboard)/dashboard/_lib/up-next-footer-links.ts',
      'apps/web/src/app/(dashboard)/dashboard/_lib/up-next-footer-links.ts',
    ]);
    expect(path).not.toBe('');
    const source = readFileSync(path, 'utf8');
    expect(source).not.toContain('consultations');
  });
});
