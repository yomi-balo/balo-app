import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { resolvePortfolioLens } from '@/lib/projects-inbox/resolve-portfolio-lens';
import {
  loadAdminPortfolio,
  loadClientPortfolio,
  loadExpertPortfolio,
} from '@/lib/projects-inbox/portfolio-view';
import type { AdminPortfolioDTO, PortfolioDTO } from '@/lib/projects-inbox/portfolio-row';
import { ProjectsInboxShell } from './_components/projects-inbox-shell';
import { ProjectsInboxAnalytics } from './_components/projects-inbox-analytics';

/**
 * A7 tri-lens portfolio dashboard (BAL-274). Server Component:
 *  1. `getCurrentUser()` — null → `/login` (the (dashboard) layout already gates
 *     onboarding/drift; we guard only the unauthenticated edge).
 *  2. resolve the lens from `?lens=` (a VIEW chooser — out-of-bounds falls back).
 *  3. load ONLY the chosen lens's data inside a try/catch that `log.error`s then
 *     re-throws to `error.tsx`.
 *  4. render the analytics island + the lens shell.
 */

export const metadata: Metadata = {
  title: 'Projects — Balo',
  robots: { index: false, follow: false },
};

interface ProjectsPageProps {
  searchParams: Promise<{ lens?: string }>;
}

export default async function ProjectsPage({
  searchParams,
}: Readonly<ProjectsPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const { lens } = await searchParams;
  const { lens: resolvedLens, allowedLenses } = resolvePortfolioLens(user, lens);

  let dto: PortfolioDTO | AdminPortfolioDTO;
  try {
    if (resolvedLens === 'admin') {
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

  return (
    <>
      <ProjectsInboxAnalytics
        lens={dto.lens}
        needsCount={dto.lens === 'admin' ? dto.tiles.untriaged : dto.tiles.needs}
        inProgressCount={dto.lens === 'admin' ? dto.tiles.pipeline : dto.tiles.inProgress}
        totalCount={dto.lens === 'admin' ? dto.triage.length + dto.tiles.pipeline : dto.tiles.total}
      />
      <ProjectsInboxShell dto={dto} />
    </>
  );
}
