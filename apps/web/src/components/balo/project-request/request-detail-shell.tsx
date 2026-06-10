import { Lock, Shield, User, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RequestDetailView } from '@/lib/project-request/request-detail-view';
import {
  BEFORE_INVITE_STATUSES,
  requestPhase,
  type RequestViewerContext,
} from '@/lib/project-request/resolve-request-lens';
import { RequestCard } from './request-card';
import { RequestContext } from './request-context';
import { NudgeBar, nudgeFor, EXPERT_GATED_NUDGE } from './nudge-bar';
import { ConversationPlaceholder } from './conversation-placeholder';
import { AdminHealthPanel } from './admin-health-panel';
import { RequestDetailAnalytics } from './request-detail-analytics';
import { StatusStepper } from './status-stepper';
import { EoiEntry } from './eoi-entry';
import { ProposalSlot } from './proposal-slot';

interface RequestDetailShellProps {
  view: RequestDetailView;
  ctx: RequestViewerContext;
}

const LENS_META = {
  client: {
    label: 'Client',
    icon: User,
    tone: 'text-primary',
    ring: 'border-primary/25 bg-primary/5',
  },
  expert: {
    label: 'Expert',
    icon: Shield,
    // Distinct brand-violet (reuses the gradient palette) so the three lenses
    // read apart: client=primary blue, expert=violet, admin=info cyan.
    tone: 'text-violet-600 dark:text-violet-400',
    ring: 'border-violet-500/25 bg-violet-500/5',
  },
  admin: { label: 'Admin', icon: Users, tone: 'text-info', ring: 'border-info/25 bg-info/5' },
} as const;

const STATUS_LABEL_BEFORE_INVITE = new Set<string>(BEFORE_INVITE_STATUSES);

/** "Viewing as {lens}" line + phase pill (participants only). */
function LensLine({
  ctx,
  isPhase2,
}: Readonly<{ ctx: RequestViewerContext; isPhase2: boolean }>): React.JSX.Element {
  const meta = LENS_META[ctx.lens];
  const Icon = meta.icon;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs',
          meta.ring
        )}
      >
        <Icon className={cn('h-3 w-3', meta.tone)} aria-hidden="true" />
        <span className="text-muted-foreground">Viewing as</span>
        <strong className={cn('font-semibold', meta.tone)}>{meta.label}</strong>
      </span>
      {ctx.archetype === 'participant' && (
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-1.5 text-xs">
          <span
            className={cn('h-1.5 w-1.5 rounded-full', isPhase2 ? 'bg-violet-500' : 'bg-primary')}
            aria-hidden="true"
          />
          {isPhase2 ? 'Phase 2 — conversation' : 'Phase 1 — request'}
        </span>
      )}
    </div>
  );
}

/** Expert lock card — request not yet open to the (uninvited) expert. */
function ExpertGatedCard(): React.JSX.Element {
  return (
    <RequestCard className="px-10 py-12 text-center">
      <span className="bg-muted mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl">
        <Lock className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">
        This request isn&apos;t open to experts yet
      </h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
        Balo is still scoping it with the client. If invited, you&apos;ll get an email with a direct
        link to express interest.
      </p>
    </RequestCard>
  );
}

/**
 * The layout switch. Branches on archetype / expert-gating / phase into the four
 * layouts from the Lens × Status matrix:
 *  - observer (admin): full RequestContext + AdminHealthPanel (once invited)
 *  - expert-gated: lock card + waiting nudge
 *  - participant Phase 1: full-width RequestContext hero
 *  - participant Phase 2: ConversationPlaceholder (main) + compact 3-card panel
 *
 * Everything is server-rendered; the only client island is RequestDetailAnalytics.
 */
export function RequestDetailShell({
  view,
  ctx,
}: Readonly<RequestDetailShellProps>): React.JSX.Element {
  const phase = requestPhase(view.status);
  const isPhase2 = phase === 'phase2';
  const isExpertGated = ctx.lens === 'expert' && STATUS_LABEL_BEFORE_INVITE.has(view.status);
  const nudge = isExpertGated ? EXPERT_GATED_NUDGE : nudgeFor(ctx.lens, view.status);
  // Health panel only once there are relationships (none before experts_invited).
  const showHealthPanel = ctx.archetype === 'observer' && view.relationships.length > 0;

  return (
    <div>
      <RequestDetailAnalytics
        requestId={view.id}
        lens={ctx.lens}
        archetype={ctx.archetype}
        status={view.status}
        phase={phase}
      />

      <LensLine ctx={ctx} isPhase2={isPhase2} />

      {/* At-a-glance pipeline position — shown for every lens. A slim full-width
          strip; the stepper itself scrolls horizontally on narrow viewports. */}
      <div
        className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both mb-5 duration-500 motion-reduce:animate-none"
        style={{ animationDelay: '60ms' }}
      >
        <StatusStepper current={view.status} />
      </div>

      {nudge && (
        <div
          className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both mb-5 duration-500 motion-reduce:animate-none"
          style={{ animationDelay: '120ms' }}
        >
          <NudgeBar nudge={nudge} lens={ctx.lens} status={view.status} requestId={view.id} />
        </div>
      )}

      <div
        className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none"
        style={{ animationDelay: '180ms' }}
      >
        {ctx.archetype === 'observer' && (
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <RequestContext view={view} variant="full" />
            {showHealthPanel && (
              <AdminHealthPanel
                requestId={view.id}
                status={view.status}
                relationships={view.relationships}
              />
            )}
          </div>
        )}

        {ctx.archetype === 'participant' && isExpertGated && <ExpertGatedCard />}

        {ctx.archetype === 'participant' && !isExpertGated && !isPhase2 && (
          <div className="space-y-5">
            <RequestContext view={view} variant="full" />
            {/* Expert Phase-1: the EOI-entry card sits under the brief. The client
                lens never sees it (no `viewerEoi`). */}
            {ctx.lens === 'expert' && view.viewerEoi && (
              <EoiEntry
                requestId={view.id}
                initialHasEoi={view.viewerEoi.hasLiveEoi}
                initialMessageHtml={view.viewerEoi.messageHtml}
              />
            )}
          </div>
        )}

        {ctx.archetype === 'participant' && !isExpertGated && isPhase2 && (
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <ConversationPlaceholder />
            <div className="space-y-5">
              {/* Expert Phase-2: the gated "Build proposal" header slot + a compact
                  EOI card so withdraw/resubmit stays reachable once the request has
                  flipped to the conversation. The client lens gets neither. */}
              {ctx.lens === 'expert' && (
                <>
                  <div className="flex justify-end">
                    <ProposalSlot requestStatus={view.status} />
                  </div>
                  {view.viewerEoi && (
                    <EoiEntry
                      requestId={view.id}
                      initialHasEoi={view.viewerEoi.hasLiveEoi}
                      initialMessageHtml={view.viewerEoi.messageHtml}
                      compact
                    />
                  )}
                </>
              )}
              <RequestContext view={view} variant="compact" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
