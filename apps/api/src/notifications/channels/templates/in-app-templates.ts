interface InAppOutput {
  title: string;
  body: string;
  actionUrl?: string;
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

  'party-join-request-approved': (data) => ({
    title: "You're in",
    body: `Your request to join the ${partyTypeNoun(data)} was approved`,
    actionUrl: '/dashboard',
  }),

  'party-join-request-declined': (data) => ({
    title: 'Request declined',
    body: `Your request to join the ${partyTypeNoun(data)} was not approved`,
  }),

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
};

export function getInAppTemplate(templateName: string, data: Record<string, unknown>): InAppOutput {
  const factory = templates[templateName];
  if (!factory) {
    return { title: 'Notification', body: 'You have a new notification' };
  }
  return factory(data);
}
