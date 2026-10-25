import { Clock, Info, MessageSquare, Sparkles } from 'lucide-react';

import { Reveal } from '../reveal';
import type { EngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import type { ChangeOrderPanelView } from '@/lib/engagement/change-order-view';
import { ChangeReviewCard } from './change-order-client-cards';
import {
  ChangeRequestCard,
  DraftChangeBanner,
  SentChangeBanner,
} from './change-order-expert-cards';
import { ToneBanner } from './change-order-tone';

interface ChangeOrderPanelProps {
  engagementId: string;
  lens: EngagementLens;
  view: ChangeOrderPanelView;
  /** The client company ("Northwind"): who the expert's change waits on. */
  clientParty: string;
  /** The expert's prospective party ("CloudPeak"): who the client's request waits on. */
  expertParty: string;
  /** The expert's retrospective first mention ("Charles @ CloudPeak"). */
  expertActor: string;
  /** Entrance stagger, in seconds. */
  delay?: number;
}

/**
 * The open change order for the viewer, or the outcome of the last decided one. Exactly one
 * card shows at a time, chosen by the order's status and who is looking:
 *  - expert: the client's request (reply), an unsent draft, or the sent change (withdraw);
 *  - client: the sent change to review (approve / decline), or an acknowledgement that the
 *    request is with the expert;
 *  - admin: one line saying where the open order stands.
 * Controls follow the view's `affordances`, which the server derives; every action re-checks
 * its own capability.
 */
export function ChangeOrderPanel({
  delay,
  ...props
}: Readonly<ChangeOrderPanelProps>): React.JSX.Element | null {
  const body = panelBody(props);
  if (body === null) return null;
  return <Reveal delay={delay}>{body}</Reveal>;
}

type PanelBodyProps = Omit<ChangeOrderPanelProps, 'delay'>;

function adminBody(view: PanelBodyProps['view']): React.JSX.Element | null {
  if (view.adminStateLine === null) return null;
  return (
    <ToneBanner
      tone="muted"
      icon={view.open?.status === 'sent' ? Clock : MessageSquare}
      label="Change order status"
    >
      {view.adminStateLine}
    </ToneBanner>
  );
}

function expertBody({ engagementId, view, clientParty }: PanelBodyProps): React.JSX.Element | null {
  const { open, affordances, composerHref } = view;
  if (open?.status === 'requested') {
    return (
      <ChangeRequestCard
        engagementId={engagementId}
        order={open}
        affordances={affordances}
        composerHref={composerHref}
      />
    );
  }
  if (affordances.continueDraft || open?.status === 'draft') {
    return (
      <DraftChangeBanner
        engagementId={engagementId}
        order={open}
        affordances={affordances}
        composerHref={composerHref}
        clientParty={clientParty}
      />
    );
  }
  if (open?.status === 'sent') {
    return (
      <SentChangeBanner
        engagementId={engagementId}
        order={open}
        affordances={affordances}
        clientParty={clientParty}
      />
    );
  }
  return null;
}

function clientBody({
  engagementId,
  view,
  expertParty,
  expertActor,
}: PanelBodyProps): React.JSX.Element | null {
  const { open, affordances } = view;
  if (open === null) return null;
  if (open.status === 'sent') {
    return (
      <ChangeReviewCard
        engagementId={engagementId}
        order={open}
        canDecide={affordances.decide}
        proposedBy={expertActor}
        expertParty={expertParty}
      />
    );
  }
  return (
    <ToneBanner tone="muted" icon={MessageSquare} label="Change request">
      {open.requestedHeading ?? 'You asked for a change'}. {expertParty} will reply with a proposed
      change or an answer.
    </ToneBanner>
  );
}

function outcomeBody(view: PanelBodyProps['view']): React.JSX.Element | null {
  if (view.open !== null || view.outcome === null) return null;
  const approved = view.outcome.tone === 'emerald';
  return (
    <ToneBanner
      tone={approved ? 'success' : 'muted'}
      icon={approved ? Sparkles : Info}
      label="Change outcome"
    >
      {view.outcome.text}
    </ToneBanner>
  );
}

function panelBody(props: PanelBodyProps): React.JSX.Element | null {
  const { lens, view } = props;
  if (lens === 'admin') return adminBody(view);
  if (lens === 'expert') {
    const body = expertBody(props);
    if (body !== null) return body;
  }
  if (lens === 'client') {
    const body = clientBody(props);
    if (body !== null) return body;
  }
  return outcomeBody(view);
}
