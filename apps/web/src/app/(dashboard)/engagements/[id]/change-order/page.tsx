import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { engagementChangeOrdersRepository, projectEngagementsRepository } from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { getCurrentUser } from '@/lib/auth/session';
import { hasExpertDeliveryCapability } from '@/lib/authz/engagement';
import { log } from '@/lib/logging';
import { resolveEngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import {
  deriveEngagementParties,
  projectEngagementTitle,
} from '@/lib/engagement/engagement-parties';
import {
  effectiveExpertPriceCents,
  findOpenOrder,
  mapChangeOrdersToView,
} from '@/lib/engagement/change-order-view';
import {
  parseChangeOrderPrefill,
  type ChangeOrderPrefill,
} from '@/lib/engagement/scope-change-redirect';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { ChangeOrderComposer } from '@/components/balo/engagement/change-orders/change-order-composer';
import type {
  ComposerMilestone,
  ComposerSavedLine,
} from '@/components/balo/engagement/change-orders/change-order-composer-state';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';

interface ChangeOrderComposerPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Generic and leak-free: the composer is a private, expert-only surface.
export const metadata: Metadata = {
  title: 'Propose a change — Balo',
  robots: { index: false, follow: false },
};

function plainOrNull(html: string | null): string | null {
  if (html === null || html.trim() === '') return null;
  return htmlToPlainText(html) || null;
}

/**
 * The line an attempted change opens the composer with. A remove names a live milestone of
 * this engagement and takes its live title; an unknown id is ignored.
 */
function prefillLineFor(
  prefill: ChangeOrderPrefill | null,
  milestones: readonly ComposerMilestone[]
): ComposerSavedLine | null {
  if (prefill === null) return null;
  if (prefill.op === 'add') {
    return {
      op: 'add',
      milestoneId: null,
      title: '',
      descriptionText: null,
      estimatedMinutes: null,
    };
  }
  const target = milestones.find((m) => m.id === prefill.milestoneId);
  if (target === undefined) return null;
  return {
    op: 'remove',
    milestoneId: target.id,
    title: target.title,
    descriptionText: null,
    estimatedMinutes: null,
  };
}

/**
 * The expert's change-order composer (`/engagements/[id]/change-order`). Reached only by the
 * delivering expert or an agency owner / admin (the `manage_engagement` capability): everyone
 * else, including the client and Balo staff, gets the same 404 a missing engagement gets, so
 * the route never confirms an engagement exists. Hands the composer expert-side figures only.
 * A project that is not `active`, or one whose change is already with the client, goes back to
 * the workspace: nothing is editable there.
 */
export default async function ChangeOrderComposerPage({
  params,
  searchParams,
}: Readonly<ChangeOrderComposerPageProps>): Promise<React.JSX.Element> {
  const { id } = await params;
  const prefill = parseChangeOrderPrefill(await searchParams);

  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const engagement = await projectEngagementsRepository.findWithMilestones(id);
  if (!engagement) {
    notFound();
  }

  const ctx = resolveEngagementLens(user, engagement);
  if (!ctx) {
    notFound();
  }

  const mayPropose = await hasExpertDeliveryCapability(
    user,
    ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
    engagement.expertProfileId,
    { contextType: 'project', contextId: id }
  );
  if (!mayPropose) {
    log.warn('Change-order composer access denied', { engagementId: id, userId: user.id });
    notFound();
  }

  const workspaceHref = `/engagements/${id}`;
  if (engagement.status !== 'active') {
    redirect(workspaceHref);
  }

  const orders = await engagementChangeOrdersRepository.listForEngagement(id);
  const open = findOpenOrder(orders);
  if (open?.status === 'sent') {
    redirect(workspaceHref);
  }

  const parties = deriveEngagementParties(engagement);
  const requestedHeading =
    mapChangeOrdersToView(orders, engagement, ctx, parties, false).open?.requestedHeading ?? null;
  const projectTitle = projectEngagementTitle(
    engagement.projectRequest?.title ?? null,
    parties.expertPartyShort
  );

  const milestones: ComposerMilestone[] = engagement.milestones.map((m) => ({
    id: m.id,
    title: m.title,
    descriptionText: plainOrNull(m.descriptionHtml),
    status: m.status,
    estimatedMinutes: m.estimatedMinutes,
  }));

  const order =
    open?.status === 'requested' || open?.status === 'draft'
      ? {
          id: open.id,
          status: open.status,
          requestNote: open.requestNote,
          requestedHeading,
          note: open.note,
          priceDeltaCents: open.priceDeltaCents,
          lines: open.lines.map(
            (line): ComposerSavedLine => ({
              op: line.op,
              milestoneId: line.engagementMilestoneId,
              title: line.title,
              descriptionText: plainOrNull(line.descriptionHtml),
              estimatedMinutes: line.estimatedMinutes,
            })
          ),
        }
      : null;

  return (
    <>
      <EntityCrumb label="Propose a change" />
      <ChangeOrderComposer
        engagementId={id}
        pricingMethod={engagement.pricingMethod}
        clientCompanyName={parties.clientCompanyName}
        projectTitle={projectTitle}
        currency={engagement.currency}
        currentPriceCents={effectiveExpertPriceCents(engagement.priceCents, orders)}
        hourlyRateCents={engagement.rateCents}
        milestones={milestones}
        order={order}
        prefillLine={prefillLineFor(prefill, milestones)}
      />
    </>
  );
}
