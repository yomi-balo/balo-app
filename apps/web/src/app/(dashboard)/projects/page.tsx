import type { Metadata } from 'next';
import type { EligibleAgency } from '@balo/db';
import { redirect } from 'next/navigation';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { resolvePortfolioLens } from '@/lib/projects-inbox/resolve-portfolio-lens';
import {
  loadAdminPortfolio,
  loadClientPortfolio,
  loadExpertPortfolio,
} from '@/lib/projects-inbox/portfolio-view';
import { loadOversightAgencies } from '@/lib/projects-inbox/agency-oversight';
import { loadAgencyPortfolio } from '@/lib/projects-inbox/agency-portfolio-view';
import type {
  AdminPortfolioDTO,
  AgencyPortfolioDTO,
  PortfolioDTO,
} from '@/lib/projects-inbox/portfolio-row';
import { ProjectsInboxShell } from './_components/projects-inbox-shell';
import { ProjectsInboxAnalytics } from './_components/projects-inbox-analytics';

/**
 * A7 tri-lens portfolio dashboard (BAL-274). Server Component:
 *  1. `getCurrentUser()` — null → `/login` (the (dashboard) layout already gates
 *     onboarding/drift; we guard only the unauthenticated edge).
 *  2. derive the viewer's agency oversight set (server-side, capability-based), then resolve
 *     the lens from `?lens=` (a VIEW chooser — out-of-bounds falls back; never the default
 *     for `agency`).
 *  3. load ONLY the chosen lens's data inside a try/catch that `log.error`s then
 *     re-throws to `error.tsx`.
 *  4. render the analytics island + the lens shell.
 */

export const metadata: Metadata = {
  title: 'Projects — Balo',
  robots: { index: false, follow: false },
};

interface ProjectsPageProps {
  searchParams: Promise<{ lens?: string; agency?: string }>;
}

function analyticsCounts(dto: PortfolioDTO | AdminPortfolioDTO | AgencyPortfolioDTO): {
  needs: number;
  inProgress: number;
  total: number;
} {
  if (dto.lens === 'admin') {
    return {
      needs: dto.tiles.untriaged,
      inProgress: dto.tiles.pipeline,
      total: dto.triage.length + dto.tiles.pipeline,
    };
  }
  if (dto.lens === 'agency') {
    return {
      needs: dto.tiles.changesRequested,
      inProgress: dto.tiles.inDelivery,
      total: dto.tiles.live,
    };
  }
  return { needs: dto.tiles.needs, inProgress: dto.tiles.inProgress, total: dto.tiles.total };
}

export default async function ProjectsPage({
  searchParams,
}: Readonly<ProjectsPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const { lens, agency } = await searchParams;

  let oversightAgencies: EligibleAgency[] = [];
  try {
    oversightAgencies = await loadOversightAgencies(user);
  } catch (error) {
    log.warn('Agency oversight lookup failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const { lens: resolvedLens, allowedLenses } = resolvePortfolioLens(user, lens, {
    canOverseeAgency: oversightAgencies.length > 0,
  });

  let dto: PortfolioDTO | AdminPortfolioDTO | AgencyPortfolioDTO;
  try {
    if (resolvedLens === 'agency' && oversightAgencies.length > 0) {
      dto = await loadAgencyPortfolio(user, oversightAgencies, agency, allowedLenses);
    } else if (resolvedLens === 'admin') {
      dto = await loadAdminPortfolio(allowedLenses);
    } else if (resolvedLens === 'expert' && user.expertProfileId !== undefined) {
      dto = await loadExpertPortfolio(
        { ...user, expertProfileId: user.expertProfileId },
        allowedLenses
      );
    } else {
      dto = await loadClientPortfolio(user, allowedLenses);
    }
  } catch (error) {
    log.error('Failed to load projects inbox', {
      userId: user.id,
      lens: resolvedLens,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  const counts = analyticsCounts(dto);

  return (
    <>
      <ProjectsInboxAnalytics
        lens={dto.lens}
        needsCount={counts.needs}
        inProgressCount={counts.inProgress}
        totalCount={counts.total}
      />
      <ProjectsInboxShell dto={dto} viewerUserId={user.id} />
    </>
  );
}
