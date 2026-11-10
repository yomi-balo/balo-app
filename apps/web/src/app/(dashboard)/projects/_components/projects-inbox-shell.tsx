'use client';

import { motion } from 'motion/react';
import { Building2, Shield, User, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  AdminPortfolioDTO,
  AgencyPortfolioDTO,
  PortfolioDTO,
} from '@/lib/projects-inbox/portfolio-row';
import type { RequestLens } from '@/lib/project-request/resolve-request-lens';
import type { PortfolioLens } from '@/lib/projects-inbox/resolve-portfolio-lens';
import { LensSwitch } from './lens-switch';
import { ParticipantDash } from './participant-dash';
import { AdminDash } from './admin-dash';
import { AgencyDash } from './agency-dash';
import { InboxEmptyState } from './inbox-empty-state';

/**
 * ProjectsInboxShell — the page root for the A7 portfolio dashboard. Renders the
 * lens-switch (when the viewer qualifies for >1 lens), the per-lens header, and
 * dispatches to the participant or admin dashboard — or the per-lens empty state.
 * Client component because the lens-switch + tile-filters are interactive; the DTO
 * arrives fully serialised from the server loader.
 */

type ShellDTO = PortfolioDTO | AdminPortfolioDTO | AgencyPortfolioDTO;

interface ProjectsInboxShellProps {
  dto: ShellDTO;
  /**
   * BAL-541 (D8) — the viewer's own user id, forwarded to `AdminDash` ONLY for the "Mine"
   * kanban pill's client-side filter. No loader-signature change, no searchParam — the pill is
   * pure client state over an admin-only field already on the DTO (`AdminKanbanCard.baloOwner`).
   */
  viewerUserId: string;
}

const LENS_META: Record<PortfolioLens, { icon: LucideIcon; tone: string; ring: string }> = {
  client: {
    icon: User,
    tone: 'text-primary',
    ring: 'border-primary/25 bg-primary/5',
  },
  expert: {
    icon: Shield,
    tone: 'text-violet-600 dark:text-violet-400',
    ring: 'border-violet-500/25 bg-violet-500/5',
  },
  agency: {
    icon: Building2,
    tone: 'text-success',
    ring: 'border-success/25 bg-success/5',
  },
  admin: {
    icon: Users,
    tone: 'text-info',
    ring: 'border-info/25 bg-info/5',
  },
};

const SUBTITLE: Record<RequestLens, string> = {
  client: 'Your project requests, from idea to kickoff.',
  expert: 'Your invitations and active engagements.',
  admin: 'Triage new requests and keep the pipeline moving.',
};

const LENS_LABEL: Record<PortfolioLens, string> = {
  client: 'Client',
  expert: 'Expert',
  agency: 'Agency',
  admin: 'Admin',
};

/** The lens subtitle; the agency lens names the agency being viewed. */
function subtitleFor(dto: ShellDTO): string {
  if (dto.lens === 'agency') {
    return `Projects ${dto.agency.name} experts are delivering for clients.`;
  }
  return SUBTITLE[dto.lens];
}

/**
 * Pick the lens body — empty state, admin board, agency oversight, or participant dashboard.
 * The agency dashboard owns its empty state so the agency picker stays reachable.
 */
function renderBody(dto: ShellDTO, viewerUserId: string): React.JSX.Element {
  if (dto.lens === 'agency') return <AgencyDash key={dto.agency.id} dto={dto} />;
  if (dto.isEmpty) return <InboxEmptyState lens={dto.lens} />;
  if (dto.lens === 'admin') return <AdminDash dto={dto} viewerUserId={viewerUserId} />;
  return <ParticipantDash dto={dto} />;
}

export function ProjectsInboxShell({
  dto,
  viewerUserId,
}: Readonly<ProjectsInboxShellProps>): React.JSX.Element {
  const meta = LENS_META[dto.lens];
  const LensIcon = meta.icon;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs',
            meta.ring
          )}
        >
          <LensIcon className={cn('h-3 w-3', meta.tone)} aria-hidden="true" />
          <span className="text-muted-foreground">Viewing as</span>
          <strong className={cn('font-semibold', meta.tone)}>{LENS_LABEL[dto.lens]}</strong>
        </span>
        <div className="ml-auto">
          <LensSwitch lens={dto.lens} allowedLenses={dto.allowedLenses} />
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-6"
      >
        <h2 className="text-foreground text-2xl font-semibold">Projects</h2>
        <p className="text-muted-foreground mt-1 text-sm">{subtitleFor(dto)}</p>
      </motion.div>

      {renderBody(dto, viewerUserId)}
    </div>
  );
}
