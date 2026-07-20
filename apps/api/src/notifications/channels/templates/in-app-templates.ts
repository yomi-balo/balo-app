import { formatAudMinor, formatExpiryDateShort } from './credit-format.js';

interface InAppOutput {
  title: string;
  body: string;
  actionUrl?: string;
}

/** Coerce a merged-payload numeric field to a number; 0 when absent/non-numeric. */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Format a minor-unit price (cents) + currency code for an in-app body, e.g.
 * `formatPriceCents(120000, 'aud') === 'AUD 1,200'`. Guards both fields: a
 * non-number price or absent currency degrades gracefully rather than rendering
 * `NaN`/`undefined`. No external money library — inline by design.
 */
function formatPriceCents(priceCents: unknown, currency: unknown): string {
  const code = typeof currency === 'string' && currency.length > 0 ? currency.toUpperCase() : '';
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) {
    return code || 'an amount';
  }
  const amount = (priceCents / 100).toLocaleString();
  return code ? `${code} ${amount}` : amount;
}

/**
 * BAL-345 — the joiner/requester display name from the resolver-hydrated
 * `data.user` (payload.userId). Degrades to "A teammate" when the name is unset.
 */
function partyMemberName(data: Record<string, unknown>): string {
  const user = data.user as { firstName?: string | null; lastName?: string | null } | undefined;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'A teammate';
}

/** BAL-345 — human noun for the party type carried in `data.partyType`. */
function partyTypeNoun(data: Record<string, unknown>): string {
  if (data.partyType === 'company') return 'company';
  if (data.partyType === 'agency') return 'agency';
  return 'organization';
}

/**
 * BAL-348 — the approved/declined in-app deep-link. Lands the requester on the
 * `/onboarding/join-result` terminal screen, which RE-VALIDATES the party
 * relationship server-side (the `status`/`party` query params are never trusted).
 *
 * The landing surface is COMPANY-ONLY (it reads `companiesRepository.findById` and
 * gates on `PARTY_TYPE = 'company'`), but `party.join_request_approved/declined` are
 * defined for BOTH company and agency parties. So the landing link is emitted only for
 * a company party; an agency party (or a payload with no `partyId`) falls back to
 * `/dashboard` for approved and omits the link for declined (its terminal screen offers
 * "create your own" — no dead-end).
 */
function joinResultActionUrl(
  status: 'approved' | 'declined',
  data: Record<string, unknown>
): string | undefined {
  const partyId = data.partyId;
  if (data.partyType !== 'company' || typeof partyId !== 'string' || partyId.length === 0) {
    return status === 'approved' ? '/dashboard' : undefined;
  }
  return `/onboarding/join-result?status=${status}&party=${partyId}`;
}

/** The common in-app shape: title + body linking to the project request. */
function projectRequestNotice(
  title: string,
  body: string,
  data: Record<string, unknown>
): InAppOutput {
  const projectRequestId = data.projectRequestId as string | undefined;
  return { title, body, actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined };
}

/** BAL-332 — the common in-app shape for a milestone notice, deep-linked to the workspace. */
function engagementNotice(title: string, body: string, data: Record<string, unknown>): InAppOutput {
  const engagementId = data.engagementId as string | undefined;
  return { title, body, actionUrl: engagementId ? `/engagements/${engagementId}` : undefined };
}

/** BAL-332 — "n/m" milestone progress from the payload counts; "" when either is absent. */
function milestoneProgress(data: Record<string, unknown>): string {
  const done = data.completedCount;
  const total = data.totalCount;
  return typeof done === 'number' && typeof total === 'number' ? `${done}/${total}` : '';
}

const templates: Record<string, (data: Record<string, unknown>) => InAppOutput> = {
  'booking-confirmed': (data) => {
    const clientName = (data.clientName as string) ?? 'A client';
    const caseId = data.caseId as string | undefined;
    return {
      title: 'New booking',
      body: `${clientName} booked a consultation`,
      actionUrl: caseId ? `/cases/${caseId}` : undefined,
    };
  },

  'new-message': (data) => {
    const caseId = data.caseId as string | undefined;
    return {
      title: 'New message',
      body: 'You have a new message in your consultation',
      actionUrl: caseId ? `/cases/${caseId}` : undefined,
    };
  },

  'project-exploratory-requested': (data) => {
    const title = (data.title as string) ?? 'your project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Book your exploratory call',
      body: `Balo wants a quick call about "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-expert-invited': (data) => {
    const title = (data.title as string) ?? 'a new project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: "You're invited to a project",
      body: `Balo invited you to express interest in "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-eoi-submitted': (data) => {
    const title = (data.title as string) ?? 'your project';
    const expertName = (data.expertName as string) ?? 'An expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'An expert is interested',
      body: `${expertName} expressed interest in "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-requested': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal requested',
      body: `The client requested your proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  // BAL-315: client heads-up when an admin requested a proposal on their behalf.
  'project-proposal-requested-client': (data) => {
    const title = (data.title as string) ?? 'your project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal requested for you',
      body: `Balo asked an expert to send a proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-submitted': (data) => {
    const title = (data.title as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal received',
      body: `${expertName} sent a proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-accepted': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal accepted',
      body: `Your proposal for "${title}" was accepted`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-kickoff-approved-expert': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Kickoff approved',
      body: `Kickoff approved for "${title}" — time to deliver`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-kickoff-approved-client': (data) => {
    const title = (data.title as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Kickoff approved',
      body: `${expertName} is ready — kickoff approved for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-not-selected': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal not selected',
      body: `The client chose another proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-changes-requested': (data) => {
    const title = (data.projectTitle as string) ?? 'a project';
    const clientName = (data.clientName as string) ?? 'The client';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Changes requested',
      body: `${clientName} requested changes to your proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-resubmitted': (data) => {
    const title = (data.projectTitle as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const version = typeof data.version === 'number' ? data.version : undefined;
    const projectRequestId = data.projectRequestId as string | undefined;
    const versionLabel = version ? ` (v${version})` : '';
    return {
      title: 'Updated proposal',
      body: `${expertName} sent an updated proposal${versionLabel} for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-accepted-admin': (data) => {
    const clientName = (data.clientName as string) ?? 'A client';
    const company = (data.clientCompanyName as string) ?? '';
    // First-mention "Name @ Company" rule; degrade to the bare name when absent.
    const who = company ? `${clientName} @ ${company}` : clientName;
    const title = (data.title as string) ?? 'a project';
    const amount = formatPriceCents(data.priceCents, data.currency);
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal accepted — raise invoice',
      body: `${who} accepted a proposal for "${title}" (${amount})`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  // BAL-345 domain auto-join. `data.user` (the joiner/requester) is hydrated by
  // the resolver from payload.userId; `data.partyType` names the party. member/
  // request notices go to party admins; approved/declined go to the requester.
  'party-member-joined-via-domain': (data) => {
    const actorName = partyMemberName(data);
    return {
      title: 'New teammate joined',
      body: `${actorName} joined your ${partyTypeNoun(data)} via a matched email domain`,
      actionUrl: '/settings/team',
    };
  },

  'party-join-request-created': (data) => {
    const actorName = partyMemberName(data);
    return {
      title: 'Join request',
      body: `${actorName} requested to join your ${partyTypeNoun(data)}`,
      actionUrl: '/settings/team',
    };
  },

  // BAL-348: the deep-link now lands the requester on the join-result terminal screen
  // (was /dashboard) so a request-mode requester who never finished onboarding reaches
  // the correct "you're in" screen. The route re-validates membership server-side.
  'party-join-request-approved': (data) => ({
    title: "You're in",
    body: `Your request to join the ${partyTypeNoun(data)} was approved`,
    actionUrl: joinResultActionUrl('approved', data),
  }),

  // BAL-348: adds a deep-link (was none) to the declined terminal screen, which offers
  // the "create your own company" action.
  'party-join-request-declined': (data) => ({
    title: 'Request declined',
    body: `Your request to join the ${partyTypeNoun(data)} was not approved`,
    actionUrl: joinResultActionUrl('declined', data),
  }),

  // BAL-348 agency provisioned — owner in-app milestone. `data.agency` is the
  // resolver-hydrated summary (name only). Deep-links to team/members settings.
  'agency-provisioned': (data) => {
    const agency = data.agency as { name?: string } | undefined;
    const teamName = agency?.name ?? 'Your team';
    return {
      title: 'Your team is set up',
      body: `${teamName} is on Balo — colleagues who sign up with your email domain will join automatically.`,
      actionUrl: '/settings/team',
    };
  },

  // BAL-332 (D2) milestone completed — CLIENT owner ("your expert delivered").
  'engagement-milestone-completed-client': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const milestone = (data.milestoneTitle as string) ?? 'a milestone';
    const progress = milestoneProgress(data);
    const suffix = progress ? ` (${progress})` : '';
    return engagementNotice(
      'Milestone completed',
      `${actor} completed '${milestone}'${suffix}.`,
      data
    );
  },

  // BAL-332 (D2) milestone completed — ADMIN ops signal (project-scoped).
  'engagement-milestone-completed-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const milestone = (data.milestoneTitle as string) ?? 'a milestone';
    const progress = milestoneProgress(data);
    const suffix = progress ? ` (${progress})` : '';
    return engagementNotice(
      'Milestone completed',
      `${title}: '${milestone}' completed${suffix}.`,
      data
    );
  },

  // BAL-332 (D2) milestone reverted — shared by the client-owner + admin rules.
  'engagement-milestone-reverted': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const milestone = (data.milestoneTitle as string) ?? 'a milestone';
    return engagementNotice(
      'Milestone reopened',
      `${actor} moved '${milestone}' back to in progress.`,
      data
    );
  },

  // BAL-333 (D3) delivery-plan scope changed — CLIENT owner (exact ticket copy).
  'engagement-scope-changed-client': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const summary = (data.changeSummary as string) ?? 'updated the delivery plan';
    return engagementNotice(
      'Delivery plan updated',
      `${actor} updated the delivery plan: ${summary}.`,
      data
    );
  },

  // BAL-333 (D3) delivery-plan scope changed — ADMIN ops signal (project-scoped, same summary).
  'engagement-scope-changed-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const actor = (data.actorExpertLabel as string) ?? 'The expert';
    const summary = (data.changeSummary as string) ?? 'updated the delivery plan';
    return engagementNotice('Delivery plan updated', `${title}: ${actor} ${summary}.`, data);
  },

  // BAL-334 (D4) completion requested — CLIENT owner ("review it and make it official").
  'engagement-completion-requested-client': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const title = (data.projectTitle as string) ?? 'your project';
    const autoDate = (data.autoDate as string) ?? 'the review deadline';
    return engagementNotice(
      'Project complete — review it',
      `${actor} marked '${title}' complete 🎉 — take a look and make it official. Closes out as delivered on ${autoDate} if no one responds.`,
      data
    );
  },

  // BAL-334 (D4) completion requested — ADMIN ops signal (project-scoped, auto-accept date).
  'engagement-completion-requested-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const company = (data.clientCompanyName as string) ?? 'the client';
    const autoDate = (data.autoDate as string) ?? 'the review deadline';
    return engagementNotice(
      'Sent for review',
      `${title} sent for ${company} review — auto-accepts ${autoDate}.`,
      data
    );
  },

  // BAL-334 (D4) completion withdrawn — shared by the client-owner + admin rules.
  'engagement-completion-withdrawn': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'The expert';
    const title = (data.projectTitle as string) ?? 'the project';
    return engagementNotice(
      'Back to active',
      `${actor} withdrew the completion request on ${title} — the project is active again.`,
      data
    );
  },

  // BAL-334 (D4) engagement cancelled — shared by the client-owner + expert rules.
  'engagement-cancelled': (data) => {
    const title = (data.projectTitle as string) ?? 'The project';
    const cancelledOn = (data.cancelledOn as string) ?? 'an earlier date';
    return engagementNotice(
      'Engagement cancelled',
      `${title} has been cancelled. Balo cancelled the engagement on ${cancelledOn}.`,
      data
    );
  },

  // BAL-338 (D7) client accepted — EXPERT (congrats). Retrospective person naming.
  'engagement-accepted-expert': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'the project';
    return engagementNotice(
      'Project accepted 🎉',
      `${actor} accepted '${title}' — congratulations on the delivery. Balo takes care of the final invoice.`,
      data
    );
  },

  // BAL-338 (D7) client accepted — ADMIN (money signal).
  'engagement-accepted-admin': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'A project';
    return engagementNotice(
      'Ready to invoice: final installment',
      `${actor} accepted '${title}' — final installment is ready to invoice.`,
      data
    );
  },

  // BAL-338 (D7) client requested changes — EXPERT (act).
  'engagement-changes-requested-expert': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'the project';
    return engagementNotice(
      'Changes requested',
      `${actor} requested changes on '${title}' — the project is active again. Mark it complete when it's fixed.`,
      data
    );
  },

  // BAL-338 (D7) client requested changes — ADMIN ops signal (review cycle {n}).
  'engagement-changes-requested-admin': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'A project';
    const cycle = typeof data.reviewCycle === 'number' ? data.reviewCycle : undefined;
    const cycleLabel = cycle ? ` (review cycle ${cycle})` : '';
    return engagementNotice(
      'Changes requested',
      `${actor} requested changes on '${title}'${cycleLabel}.`,
      data
    );
  },

  // BAL-338 (D7) auto-accepted — CLIENT (wrapped up as delivered).
  'engagement-auto-accepted-client': (data) => {
    const title = (data.projectTitle as string) ?? 'Your project';
    return engagementNotice(
      'Project complete 🎉',
      `'${title}' is complete — wrapped up as delivered after the review window. Balo will be in touch about the final invoice.`,
      data
    );
  },

  // BAL-338 (D7) auto-accepted — EXPERT (congrats).
  'engagement-auto-accepted-expert': (data) => {
    const title = (data.projectTitle as string) ?? 'The project';
    const autoDate = (data.autoDate as string) ?? 'the review deadline';
    return engagementNotice(
      'Project complete 🎉',
      `'${title}' closed out as delivered on ${autoDate} after the review window. Balo takes care of the final invoice.`,
      data
    );
  },

  // BAL-338 (D7) auto-accepted — ADMIN (money signal; auto path noted).
  'engagement-auto-accepted-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const reviewDays = typeof data.reviewDays === 'number' ? data.reviewDays : 7;
    return engagementNotice(
      'Ready to invoice: final installment',
      `'${title}' accepted automatically (${reviewDays}-day window) — final installment is ready to invoice.`,
      data
    );
  },

  // BAL-338 (D7) T-2 review reminder — CLIENT (one friendly nudge).
  'engagement-review-reminder-client': (data) => {
    const title = (data.projectTitle as string) ?? 'Your project';
    const autoDate = (data.autoDate as string) ?? 'soon';
    return engagementNotice(
      'Your completed project is waiting 👋',
      `'${title}' wraps up as delivered on ${autoDate} — take a look and make it official.`,
      data
    );
  },

  // BAL-323: MJ's "ready to invoice" nudge once a company's billing details land.
  'billing-details-confirmed-admin': (data) => {
    const companyName = (data.companyName as string) ?? 'a company';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Billing details confirmed',
      body: `Billing details confirmed for ${companyName} — ready to invoice.`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-message-posted': (data) => {
    const senderName = (data.senderName as string) ?? 'Someone';
    const preview = (data.preview as string) ?? 'sent you a message';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'New message',
      body: `${senderName}: ${preview}`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-file-shared': (data) => {
    const senderName = (data.senderName as string) ?? 'Someone';
    const fileName = (data.fileName as string) ?? 'a file';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'New file shared',
      body: `${senderName} shared ${fileName}`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  // BAL-324 admin billing reminder — OWNER (must add billing details).
  'project-billing-reminder-owner': (data) => {
    const title = (data.title as string) ?? 'your project';
    return projectRequestNotice(
      'Complete your billing details',
      `Add your billing details to kick off "${title}"`,
      data
    );
  },

  // BAL-324 admin billing reminder — CREATOR (FYI, no action of their own).
  'project-billing-reminder-creator': (data) => {
    const title = (data.title as string) ?? 'your project';
    return projectRequestNotice(
      'Billing details still needed',
      `"${title}" is on hold until your company's billing details are added`,
      data
    );
  },

  // BAL-380 (ADR-1040 Lane 3) dormancy reminder — company billing admins. Switches on
  // the merged-payload `window` (60|30). Warm, non-countdown: "still here", the date as
  // a plain fact, and a note that any activity keeps it going. Deep-links to expert search.
  'credit-dormancy-reminder': (data) => {
    const balance = formatAudMinor(numberOrZero(data.balanceMinor));
    const shortDate = formatExpiryDateShort((data.expiresAt as string) ?? '');
    if (data.window === 30) {
      return {
        title: `Your balance stays available until ${shortDate}`,
        body: `${balance} is still here. A good time to put it to use.`,
        actionUrl: '/experts',
      };
    }
    return {
      title: 'Your balance is still here',
      body: `${balance}, available until ${shortDate}. Any activity keeps it going.`,
      actionUrl: '/experts',
    };
  },

  // BAL-380 (ADR-1040 Lane 3) balance expired — company billing admins. Soft-toned,
  // provisional, no balance figure (0 post-expiry). Deep-links to the wallet/billing
  // panel (delivered by a later credit-system lane).
  'credit-balance-expired': () => ({
    title: 'About your balance',
    body: 'Your balance reached its expiry date. Add credit to pick back up anytime.',
    actionUrl: '/settings/billing',
  }),

  // BAL-378 (ADR-1040 Lane 2) in-session drawdown / settlement in-app notices. Warm,
  // non-countdown; "extra time" is the client name for what was drawn past the balance — the
  // word "overdraft" NEVER appears. Money via `formatAudMinor` (no inline formatting).

  // Low balance — the in-session member (self).
  'session-low-balance': (data) => ({
    title: 'Balance running low',
    body: `About ${numberOrZero(data.minutesRemaining)} minutes of balance left — top up so nothing interrupts you.`,
    actionUrl: '/settings/billing',
  }),

  // Entered grace — the in-session member (self). Lens-neutral (self may be client or member).
  'session-grace-entered': () => ({
    title: "We're keeping you going",
    body: "You've used your balance — no interruption. Extra time from here settles afterward.",
    actionUrl: '/settings/billing',
  }),

  // Entered grace — the billing admins' async ping.
  'session-grace-entered-admin': () => ({
    title: 'A session is running on grace',
    body: "A teammate's session continued past the balance — the extra time will settle to your card.",
    actionUrl: '/settings/billing',
  }),

  // Nearing the wrap — the in-session member (self).
  'session-near-wrap': (data) => ({
    title: 'Coming up on a good place to wrap',
    body: `About ${numberOrZero(data.graceRemainingMinutes)} more minutes before we pause to settle up.`,
    actionUrl: '/settings/billing',
  }),

  // Settled receipt — billing admins.
  'session-settled': (data) => {
    const overdraft = numberOrZero(data.overdraftSettledMinor);
    const expertName = (data.expertName as string) ?? 'your expert';
    if (overdraft > 0) {
      return {
        title: 'Extra time settled',
        body: `We settled ${formatAudMinor(overdraft)} of extra time from your session with ${expertName} to your card.`,
        actionUrl: '/settings/billing',
      };
    }
    return {
      title: 'Session wrapped up',
      body: `Your session with ${expertName} stayed within your balance — nothing extra to settle.`,
      actionUrl: '/settings/billing',
    };
  },

  // Settlement failed — billing admins (dunning).
  'session-settlement-failed': (data) => {
    const amount = formatAudMinor(numberOrZero(data.amountMinor));
    if (data.reason === 'requires_action') {
      return {
        title: 'Confirm your card to finish up',
        body: `Settling ${amount} of extra time from a recent session needs a quick confirmation on your card.`,
        actionUrl: '/settings/billing',
      };
    }
    return {
      title: "Let's sort the extra time",
      body: `We couldn't settle ${amount} of extra time from a recent session — a quick card update sorts it.`,
      actionUrl: '/settings/billing',
    };
  },

  // Member top-up nudge — billing admins.
  'session-topup-nudge': (data) => {
    const requestedByName = (data.requestedByName as string) ?? 'A teammate';
    return {
      title: `${requestedByName} asked for a top-up`,
      body: `${requestedByName} is in a session and asked you to top up the team balance.`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-377 (ADR-1040 Lane 1) top-up receipt — the purchaser. Warm + factual: the credit
  // landed and the balance is ready. Mentions a promo bonus when one was granted. NO fee
  // figure (BAL-357). Deep-links to expert search (put the balance to use).
  'credit-topup-completed': (data) => {
    const balanceAfter = formatAudMinor(numberOrZero(data.balanceAfterMinor));
    const promoGrantedMinor = numberOrZero(data.promoGrantedMinor);
    const promoSuffix =
      promoGrantedMinor > 0 ? ` (including ${formatAudMinor(promoGrantedMinor)} bonus)` : '';
    return {
      title: "You're topped up",
      body: `Your balance is now ${balanceAfter}${promoSuffix}, ready when you are.`,
      actionUrl: '/experts',
    };
  },

  // BAL-377 / BAL-381 top-up nudge — company billing admins. Names the nudging member
  // (data.requesterName, hydrated by the resolver). Deep-links to the top-up composer.
  'credit-topup-requested': (data) => {
    const memberName = (data.requesterName as string) ?? 'A teammate';
    return {
      title: 'Top-up requested',
      body: `${memberName} asked you to top up your team's balance.`,
      actionUrl: '/billing/top-up',
    };
  },

  // BAL-383 (ADR-1040) promo redeemed — the ACTOR who redeemed (recipient 'self'). Warm,
  // congratulatory, no countdown. `grantedLabel` / `companyName` come from the payload;
  // deep-links to expert search (the natural next step once credit lands).
  'promo-redeemed': (data) => {
    const grantedLabel = (data.grantedLabel as string) ?? 'Your credit';
    const companyName = (data.companyName as string) ?? 'your team';
    return {
      title: 'Credit added 🎉',
      body: `${grantedLabel} is ready for ${companyName} — find an expert whenever you are.`,
      actionUrl: '/experts',
    };
  },

  // BAL-391 (ADR-1043) action item assigned — the assigned side (client owner OR expert).
  // One template serves both. Gender-neutral; `actorLabel` is the retrospective person;
  // the due date reads as a helpful fact (never a countdown). Deep-links to the workspace.
  'action-item-assigned': (data) => {
    const actor = (data.actorLabel as string) ?? 'A teammate';
    const body = (data.actionItemBody as string) ?? 'an action item';
    const dueOn = data.dueOn as string | undefined;
    const dueSuffix = dueOn ? ` · noted for ${dueOn}` : '';
    return engagementNotice(
      'New action item',
      `${actor} assigned you '${body}'${dueSuffix}.`,
      data
    );
  },
};

export function getInAppTemplate(templateName: string, data: Record<string, unknown>): InAppOutput {
  const factory = templates[templateName];
  if (!factory) {
    return { title: 'Notification', body: 'You have a new notification' };
  }
  return factory(data);
}
