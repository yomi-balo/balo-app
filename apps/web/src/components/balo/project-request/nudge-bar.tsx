import {
  ArrowRight,
  Calendar,
  Check,
  Clock,
  DollarSign,
  FileText,
  Lock,
  type LucideIcon,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RequestLens, ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
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
  accepted: {
    variant: 'action',
    icon: FileText,
    headline: 'Add your billing details to start kickoff',
    sub: 'Almost there. We need company billing details to raise the first invoice.',
    primary: { label: 'Add billing details', icon: ArrowRight },
  },
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
    sub: 'Deliverables, exclusions, terms, payment schedule.',
    primary: { label: 'Build proposal', icon: FileText },
  },
  proposal_submitted: {
    variant: 'waiting',
    icon: Clock,
    headline: 'Your proposal is with the client',
    sub: "They're reviewing it alongside others. Keep the conversation warm.",
    secondary: { label: 'Send a message', icon: MessageSquare },
  },
  accepted: {
    variant: 'action',
    icon: DollarSign,
    headline: 'Confirm payment terms for kickoff',
    sub: 'The client accepted your proposal. Confirm terms so Balo can invoice and kick off.',
    primary: { label: 'Confirm payment terms', icon: Check },
  },
  kickoff_approved: {
    variant: 'done',
    icon: Zap,
    headline: 'Kicked off — time to deliver',
    sub: 'Milestones are in the workspace. Mark them done as you go.',
    primary: { label: 'Open workspace', icon: Zap },
  },
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
  accepted: {
    variant: 'action',
    icon: DollarSign,
    headline: 'Chase upfront invoice, then approve kickoff',
    sub: 'Confirm payment settled, then approve.',
    primary: { label: 'Approve for kickoff', icon: Check },
    secondary: { label: 'View invoice status', icon: DollarSign },
  },
  kickoff_approved: {
    variant: 'done',
    icon: Zap,
    headline: 'Project kicked off',
    sub: "It's now a live project and has left the request pipeline.",
  },
};

const NUDGES_BY_LENS: Record<RequestLens, NudgeMap> = {
  client: CLIENT_NUDGES,
  expert: EXPERT_NUDGES,
  admin: ADMIN_NUDGES,
};

/**
 * The single privileged next step for a (lens, status) cell, or `null` when
 * there's nothing to nudge. Data-driven (no copy-pasted branches).
 */
export function nudgeFor(lens: RequestLens, status: ProjectRequestStatus): NudgeContent | null {
  return NUDGES_BY_LENS[lens][status] ?? null;
}
