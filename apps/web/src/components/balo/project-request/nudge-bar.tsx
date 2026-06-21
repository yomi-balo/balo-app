import {
  Calendar,
  Check,
  Clock,
  FileText,
  Lock,
  type LucideIcon,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RequestLens, ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';
import { RequestCard } from './request-card';
import { NudgeActions } from './nudge-actions';

type NudgeVariant = 'action' | 'waiting' | 'done' | 'commit';

interface NudgeButton {
  label: string;
  icon: LucideIcon;
}

export interface NudgeContent {
  variant: NudgeVariant;
  icon: LucideIcon;
  headline: string;
  sub?: string;
  primary?: NudgeButton;
  secondary?: NudgeButton;
}

interface NudgeBarProps {
  nudge: NudgeContent;
  /** Viewer lens + request context — required to wire the interactive CTAs. */
  lens: RequestLens;
  status: ProjectRequestStatus;
  requestId: string;
  /**
   * The viewer-expert's own relationship id (`ctx.relationshipId`) — threaded to
   * `NudgeActions` so the `build-proposal` CTA can deep-link to the composer.
   * `null` for client/admin lenses.
   */
  viewerRelationshipId?: string | null;
}

const EYEBROW: Record<NudgeVariant, string> = {
  action: 'Your next step',
  commit: 'Your next step',
  waiting: 'Waiting',
  done: 'Done',
};

/** Accent token set per variant — semantic colors only (no hardcoded hex). */
function accentClasses(variant: NudgeVariant): {
  rail: string;
  iconWrap: string;
  icon: string;
  eyebrow: string;
} {
  if (variant === 'waiting') {
    return {
      rail: 'bg-warning',
      iconWrap: 'bg-warning/10 border-warning/30',
      icon: 'text-warning',
      eyebrow: 'text-warning',
    };
  }
  if (variant === 'done') {
    return {
      rail: 'bg-success',
      iconWrap: 'bg-success/10 border-success/30',
      icon: 'text-success',
      eyebrow: 'text-success',
    };
  }
  return {
    rail: 'bg-primary',
    iconWrap: 'bg-primary/10 border-primary/30',
    icon: 'text-primary',
    eyebrow: 'text-primary',
  };
}

/**
 * Presentational "always nudge" bar — one privileged next step per cell. Copy
 * comes from {@link nudgeFor}; the interactive CTA row is delegated to the
 * {@link NudgeActions} client island, which wires the A2 (BAL-269) triage/invite/
 * book CTAs to Server Actions and leaves the CTAs owned by later slices disabled.
 * `NudgeBar` itself stays a server component.
 */
export function NudgeBar({
  nudge,
  lens,
  status,
  requestId,
  viewerRelationshipId = null,
}: Readonly<NudgeBarProps>): React.JSX.Element {
  const { variant, icon: Icon, headline, sub, primary, secondary } = nudge;
  const a = accentClasses(variant);
  const glow = variant === 'action' || variant === 'commit';

  return (
    <RequestCard glow={glow} className="overflow-hidden p-0">
      <div className="flex items-stretch">
        <span className={cn('w-1 shrink-0', a.rail)} aria-hidden="true" />
        <div className="flex-1 p-5">
          <div className="mb-1 flex items-center gap-2">
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
                a.iconWrap
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', a.icon)} aria-hidden="true" />
            </span>
            <span className={cn('text-[10.5px] font-bold tracking-wider uppercase', a.eyebrow)}>
              {EYEBROW[variant]}
            </span>
          </div>
          <p className="text-foreground ml-8 text-[15px] font-semibold">{headline}</p>
          {sub && (
            <p className="text-muted-foreground mt-0.5 ml-8 text-sm leading-relaxed">{sub}</p>
          )}
          {(primary || secondary) && (
            <NudgeActions
              lens={lens}
              status={status}
              requestId={requestId}
              viewerRelationshipId={viewerRelationshipId}
              primary={primary}
              secondary={secondary}
            />
          )}
        </div>
      </div>
    </RequestCard>
  );
}

// ── nudgeFor — data-driven copy per (lens, status) ───────────────────
// Returns the single privileged next step for a cell, or null (no nudge).
// CTAs here are copy only — the NudgeBar renders them disabled (siblings wire).

type NudgeMap = Partial<Record<ProjectRequestStatus, NudgeContent>>;

const CLIENT_NUDGES: NudgeMap = {
  requested: {
    variant: 'waiting',
    icon: Clock,
    headline: "We're reviewing your request",
    sub: 'Balo is checking your brief and lining up the right experts — usually within one business day.',
    secondary: { label: 'Add more detail', icon: Plus },
  },
  exploratory_meeting_requested: {
    variant: 'action',
    icon: Calendar,
    headline: 'Book your exploratory call with Balo',
    sub: 'A 20-minute call helps us match you precisely. Pick a time that suits you.',
    primary: { label: 'Book exploratory call', icon: Calendar },
  },
  experts_invited: {
    variant: 'waiting',
    icon: Clock,
    headline: 'Experts are reviewing your request',
    sub: "We've invited specialists. You'll be notified the moment one expresses interest.",
    secondary: { label: 'Message Balo', icon: MessageSquare },
  },
  // accepted / kickoff_approved: the KickoffBoard (BAL-291) owns ALL kickoff
  // messaging + actions for the client, so no global nudge here would conflict.
};

const EXPERT_NUDGES: NudgeMap = {
  experts_invited: {
    variant: 'action',
    icon: Send,
    headline: "You're invited — submit your expression of interest",
    sub: "Balo thinks you're a strong fit. A short, specific EOI starts the conversation.",
    primary: { label: 'Write your EOI', icon: Send },
    secondary: { label: 'Re-read the brief', icon: FileText },
  },
  eoi_submitted: {
    variant: 'action',
    icon: Calendar,
    headline: 'Offer the client a time to talk',
    sub: "Clients don't share calendars — propose a couple of times to get ahead.",
    primary: { label: 'Propose meeting times', icon: Calendar },
    secondary: { label: 'Send a message', icon: MessageSquare },
  },
  proposal_requested: {
    variant: 'action',
    icon: FileText,
    headline: 'Your proposal was requested — build it',
    sub: 'Lay out scope, milestones and pricing. You can save a draft and submit when ready.',
    primary: { label: 'Build proposal', icon: FileText },
  },
  proposal_submitted: {
    variant: 'waiting',
    icon: Clock,
    headline: 'Your proposal is with the client',
    sub: "They're reviewing it alongside others. Keep the conversation warm.",
    secondary: { label: 'Send a message', icon: MessageSquare },
  },
  // accepted / kickoff_approved: the KickoffBoard (BAL-291) owns ALL kickoff
  // messaging + actions for the winning expert, so no global nudge here.
};

/** Gated-expert nudge (before invite) — shown alongside the lock card. */
export const EXPERT_GATED_NUDGE: NudgeContent = {
  variant: 'waiting',
  icon: Lock,
  headline: 'Not yet visible to you',
  sub: "This request is still with the client and Balo admin. You'll be notified by email if you're invited.",
};

const ADMIN_NUDGES: NudgeMap = {
  requested: {
    variant: 'action',
    icon: Sparkles,
    headline: 'Triage this new request',
    sub: 'Invite experts now, or request an exploratory call to sharpen scope first.',
    primary: { label: 'Invite experts', icon: Users },
    secondary: { label: 'Request exploratory call', icon: Calendar },
  },
  exploratory_meeting_requested: {
    variant: 'action',
    icon: Calendar,
    headline: 'Exploratory call requested — awaiting client booking',
    sub: 'Once scope is clear, invite experts.',
    primary: { label: 'Invite experts', icon: Users },
    secondary: { label: 'Mark call complete', icon: Check },
  },
  experts_invited: {
    variant: 'waiting',
    icon: Clock,
    headline: 'Experts invited — awaiting EOIs',
    sub: 'Nudge a quiet expert or invite an alternate.',
    secondary: { label: 'Invite another', icon: Plus },
  },
  eoi_submitted: {
    variant: 'waiting',
    icon: Clock,
    headline: 'Client & experts are connecting',
    sub: 'Step back in at proposals.',
    secondary: { label: 'View activity', icon: MessageSquare },
  },
  proposal_requested: {
    variant: 'waiting',
    icon: Clock,
    headline: 'Proposals requested',
    sub: 'Awaiting submissions.',
  },
  proposal_submitted: {
    variant: 'waiting',
    icon: Clock,
    headline: 'Client is reviewing proposals',
    sub: 'The acceptance + kickoff chase lands with you next.',
  },
  // accepted / kickoff_approved: the KickoffBoard (BAL-291) is the admin's first
  // CTA (settle + approve) and owns the kicked-off banner, so no global nudge here.
};

const NUDGES_BY_LENS: Record<RequestLens, NudgeMap> = {
  client: CLIENT_NUDGES,
  expert: EXPERT_NUDGES,
  admin: ADMIN_NUDGES,
};

/**
 * Proposal-phase request statuses whose EXPERT cell must be keyed by the
 * viewer's RELATIONSHIP status, not the request aggregate (BAL-272): the
 * request status is max-progress, so once one expert's proposal is requested
 * every other expert's page would otherwise show a false "Build proposal"
 * commit prompt. `accepted`/`kickoff_approved` cells stay request-keyed.
 */
const RELATIONSHIP_KEYED_EXPERT_STATUSES = new Set<ProjectRequestStatus>([
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
]);

/**
 * The expert cell for the viewer's RELATIONSHIP status inside the proposal
 * phase — never the request-keyed aggregate (it reflects ANOTHER expert's
 * progress and would show this viewer a false prompt). `declined` and the
 * decided outcomes (`accepted`) are filtered upstream in {@link expertNudgeFor},
 * so in practice this maps:
 *  - `invited` → the experts_invited cell (their true next step is the EOI);
 *  - the three proposal-phase statuses → their own cells;
 *  - anything else → null (defensive; never fall back to the aggregate).
 */
function expertCellFor(viewerRelationshipStatus: RelationshipStatus): NudgeContent | null {
  if (viewerRelationshipStatus === 'invited') {
    return EXPERT_NUDGES['experts_invited'] ?? null;
  }
  if (
    viewerRelationshipStatus === 'eoi_submitted' ||
    viewerRelationshipStatus === 'proposal_requested' ||
    viewerRelationshipStatus === 'proposal_submitted'
  ) {
    return EXPERT_NUDGES[viewerRelationshipStatus] ?? null;
  }
  // declined / accepted — nothing to nudge inside the proposal phase
  // (accepted flips the REQUEST status out of this band anyway).
  return null;
}

/**
 * The whole expert-lens page nudge, keyed on the viewer's OWN relationship —
 * never the request aggregate (max-progress; another expert's progress must not
 * change this viewer's cell). Routes the three BAL-286 / BAL-272 false-prompt
 * classes through one place so no request status can leak a stale cell:
 *
 *  1. `declined` → null at EVERY request status (BAL-286 item 2). DEFENSIVE
 *     CONTRACT, not the primary barrier: the live page already gates a declined
 *     expert out earlier — `resolveRequestLens` only matches a NON-declined
 *     relationship, so a dropped expert resolves to a `null` lens and the page
 *     `notFound()`s before this runs (`view.viewerRelationshipStatus` is never
 *     `declined` from the shell today). The guard keeps `nudgeFor` honest for any
 *     other caller and if that gating ever loosens: without it a `declined` viewer
 *     at `experts_invited` — outside the proposal-phase band below — would fall
 *     through to the request-keyed map and get a false "You're invited — submit
 *     your EOI" prompt for a thread they walked away from.
 *  2. DECIDED request (`accepted` / `kickoff_approved`) → suppressed by the
 *     viewer's OUTCOME, not the aggregate (BAL-286 item 1). The request status is
 *     max-progress, so a request-keyed accepted cell would prompt EVERY
 *     non-selected expert. The two outcomes own dedicated surfaces instead —
 *     winner → the KickoffBoard (right column); loser → the thread-level
 *     "went with another expert" cell — so the top nudge stays null for BOTH
 *     (`deriveThreadStage(viewerRelationshipStatus, status)` ∈ {'won','not_selected'}).
 *     Any future winner/loser page prompt MUST branch on that derived outcome
 *     here, never on `status`, or it lies to losing experts again.
 *  3. Proposal phase (`eoi_submitted` / `proposal_requested` / `proposal_submitted`)
 *     → keyed per-thread via {@link expertCellFor} (BAL-272 divergence fix).
 *
 * Anything else (pre-proposal request statuses — `experts_invited`, exploratory…)
 * can only carry an `invited` viewer here, so the request-keyed expert cell is
 * served as before.
 */
function expertNudgeFor(
  status: ProjectRequestStatus,
  viewerRelationshipStatus: RelationshipStatus
): NudgeContent | null {
  if (viewerRelationshipStatus === 'declined') return null;
  if (status === 'accepted' || status === 'kickoff_approved') return null;
  if (RELATIONSHIP_KEYED_EXPERT_STATUSES.has(status)) {
    return expertCellFor(viewerRelationshipStatus);
  }
  return EXPERT_NUDGES[status] ?? null;
}

/**
 * The single privileged next step for a (lens, status) cell, or `null` when
 * there's nothing to nudge. Data-driven (no copy-pasted branches).
 *
 * For the EXPERT lens, pass the viewer's own `viewerRelationshipStatus` to key
 * the cell per-thread on the viewer's relationship rather than the request-keyed
 * aggregate (it carries another expert's progress and would show this viewer a
 * false prompt) — see {@link expertNudgeFor} for the full mapping (BAL-272 +
 * BAL-286). Without it (client/admin lenses, or an expert with no relationship)
 * the request status keys the map as before.
 */
export function nudgeFor(
  lens: RequestLens,
  status: ProjectRequestStatus,
  viewerRelationshipStatus: RelationshipStatus | null = null
): NudgeContent | null {
  if (lens === 'expert' && viewerRelationshipStatus !== null) {
    return expertNudgeFor(status, viewerRelationshipStatus);
  }
  return NUDGES_BY_LENS[lens][status] ?? null;
}
