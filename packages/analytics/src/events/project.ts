export const PROJECT_EVENTS = {
  PROJECT_DRAWER_OPENED: 'project_drawer_opened',
  PROJECT_ENTRY_SELECTED: 'project_entry_selected',
  PROJECT_STEP_VIEWED: 'project_step_viewed',
  // Legacy ProjectDrawer UI event (manual path), keyed off expert_id — NOT the
  // persisted request_id — and predating the origination spine. SUPERSEDED by
  // PROJECT_REQUEST_CREATED: do NOT sum the two in one metric and add no new fire
  // sites. A1 consolidates — when it wires PROJECT_REQUEST_CREATED it should drop
  // the single PROJECT_REQUEST_SUBMITTED fire (project-drawer.tsx) so one submit
  // never emits both (else the creation funnel ~2x double-counts).
  PROJECT_REQUEST_SUBMITTED: 'project_request_submitted',
  // Request origination contract (BAL-267 / BAL-266) — DEFINED here; FIRED by the
  // A1–A7 UI slices. PROJECT_REQUEST_CREATED is the CANONICAL "a project_requests
  // row was persisted" event and the single source of truth for the creation
  // funnel: fire it exactly once per created row, at the persisted-row boundary
  // (right after createProjectRequest resolves), keyed off request_id, for EVERY
  // source (manual | ai | quickstart). The rest key off persisted row ids too.
  PROJECT_REQUEST_CREATED: 'project_request_created',
  PROJECT_REQUEST_STATUS_TRANSITIONED: 'project_request_status_transitioned',
  PROJECT_EXPERT_INVITED: 'project_expert_invited',
  PROJECT_EOI_SUBMITTED: 'project_eoi_submitted',
  PROJECT_EOI_WITHDRAWN: 'project_eoi_withdrawn',
  PROJECT_PROPOSAL_REQUESTED: 'project_proposal_requested',
  // NOTE (BAL-357): PROJECT_PROPOSAL_SUBMITTED and PROJECT_PROPOSAL_ACCEPTED are
  // NOT client events — they moved to PROJECT_SERVER_EVENTS (emitted via
  // trackServer) so the Balo fee + client-charged price never transit the browser.
  // Firing either via the client `track()` is now a compile error, by design.
  // BAL-290 (A6.4) changes-requested loop + proposal versioning. CHANGES_REQUESTED
  // fires when the client requests changes on a submitted proposal (actor:'client');
  // PROPOSAL_RESUBMITTED fires when the expert resubmits as v(n+1).
  CHANGES_REQUESTED: 'project_changes_requested',
  PROPOSAL_RESUBMITTED: 'project_proposal_resubmitted',
  PROJECT_KICKOFF_APPROVED: 'project_kickoff_approved',
  // BAL-291 (A6.5): a participant confirmed their kickoff gate (client billing /
  // expert payment-terms) on the KickoffBoard "Complete" action. Fired client-side
  // so the kickoff funnel can measure per-gate dwell (accept → each gate confirmed →
  // admin approval). Admin approval is PROJECT_KICKOFF_APPROVED, not a gate event.
  PROJECT_KICKOFF_GATE_CONFIRMED: 'project_kickoff_gate_confirmed',
  // Request-detail page (A1 / BAL-268) viewer-occurrence signals, fired from the
  // client analytics island. DETAIL_VIEWED on mount; PHASE_FLIPPED the first time
  // a viewer sees this request in Phase 2 (per request+lens, sessionStorage-guarded
  // — the true server transition is PROJECT_REQUEST_STATUS_TRANSITIONED); DETAIL_DWELL
  // on tab-hide / unload.
  PROJECT_REQUEST_DETAIL_VIEWED: 'project_request_detail_viewed',
  PROJECT_REQUEST_PHASE_FLIPPED: 'project_request_phase_flipped',
  PROJECT_REQUEST_DETAIL_DWELL: 'project_request_detail_dwell',
  // BAL-293: the @balo/db coherence guard rejected a committing proposal/engagement
  // transition (defence-in-depth behind the web readiness check). Fired CLIENT-side
  // by the submit/resubmit/accept islands when the action returns a `coherence`
  // payload — the raw `rule` discriminant is analytics-only and is NEVER rendered.
  PROPOSAL_COHERENCE_REJECTED: 'proposal_coherence_rejected',
  // BAL-294: estimated effort per deliverable + asymmetric T&M/Fixed total. Both
  // carry the `project_` feature prefix to match every constant in this file (the
  // ticket's bare names `milestone_effort_estimated` / `proposal_pricing_method_switched`
  // map to these prefixed values). MILESTONE_EFFORT_ESTIMATED fires CLIENT-side once
  // per submit (not per keystroke); PROPOSAL_PRICING_METHOD_SWITCHED fires on a
  // committed pricing-method change (after the Fixed→T&M confirm dialog).
  MILESTONE_EFFORT_ESTIMATED: 'project_milestone_effort_estimated',
  PROPOSAL_PRICING_METHOD_SWITCHED: 'project_proposal_pricing_method_switched',
  // BAL-324: an admin sent a "complete your billing details" reminder from the
  // kickoff board while the client-billing gate was still outstanding. Feature
  // prefix `project_` matches every constant here (the ticket's bare
  // `billing_reminder_sent` would violate the project-domain naming regex). Fired
  // CLIENT-side by the RemindClientButton after the server action succeeds.
  BILLING_REMINDER_SENT: 'project_billing_reminder_sent',
} as const;

export type ProjectEntryMethod = 'manual' | 'ai';
export type ProjectStep = 'start' | 'manual' | 'review' | 'done';
export type ProjectActor = 'client' | 'expert' | 'admin';
/** Viewer lens on the request-detail page (admin is the observer archetype). */
export type ProjectRequestLens = 'client' | 'expert' | 'admin';
export type ProjectRequestArchetype = 'participant' | 'observer';
export type ProjectRequestPhase = 'phase1' | 'phase2';

export interface ProjectEventMap {
  [PROJECT_EVENTS.PROJECT_DRAWER_OPENED]: { expert_id: string };
  [PROJECT_EVENTS.PROJECT_ENTRY_SELECTED]: { expert_id: string; method: ProjectEntryMethod };
  [PROJECT_EVENTS.PROJECT_STEP_VIEWED]: { expert_id: string; step: ProjectStep };
  [PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED]: {
    expert_id: string;
    send_to: 'direct' | 'match';
    tag_count: number;
    product_count: number;
    document_count: number;
    method: ProjectEntryMethod;
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_CREATED]: {
    request_id: string;
    send_to: 'direct' | 'match';
    source: 'manual' | 'ai' | 'quickstart';
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED]: {
    request_id: string;
    from: string;
    to: string;
    actor: ProjectActor;
    /**
     * ms from request creation → the FIRST admin action (status was `requested`).
     * Computed server-side in the action and attached client-side. Absent on
     * later transitions. Powers the "raised → first admin action" metric.
     */
    time_to_first_admin_action_ms?: number;
  };
  [PROJECT_EVENTS.PROJECT_EXPERT_INVITED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    actor: 'admin';
  };
  [PROJECT_EVENTS.PROJECT_EOI_SUBMITTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    /**
     * ms from the relationship invite (`invitedAt`) → the EOI submit/resubmit.
     * Computed server-side in the action and attached client-side. Powers the
     * "invite → EOI" timing metric. Optional (absent if `invitedAt` is unavailable).
     */
    time_to_eoi_ms?: number;
  };
  [PROJECT_EVENTS.PROJECT_EOI_WITHDRAWN]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
  };
  [PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    actor: 'client' | 'admin';
    /**
     * Which surface committed the request. The client commits from the desktop
     * thread header or the mobile rail (A5); BAL-315 adds `'admin'` for the
     * admin Pipeline-health control acting on the client's behalf.
     */
    surface: 'header' | 'rail' | 'admin';
    /**
     * Relationships at/after `proposal_requested` on this request, INCLUDING this
     * one. Its distribution per request_id feeds the proposal-cap decision.
     * Known approximation: computed from a pre-transition snapshot, so two
     * concurrent requests on different threads can each report the same count.
     */
    proposal_request_count: number;
    /**
     * ms from the request's earliest LIVE EOI → this proposal request. Computed
     * server-side in the action and attached client-side (the `time_to_eoi_ms`
     * pattern). Known approximation: a withdrawn-and-resubmitted EOI reports the
     * resubmit time. Absent when no live EOI timestamp resolves.
     */
    time_from_first_eoi_ms?: number;
    /**
     * Interaction depth of THIS thread at commit time (live rows only). Meetings
     * are deferred — add `meeting_count` when the Booking project replaces the
     * mock call seam (`conversation_call_cta_clicked` captures intent meanwhile).
     */
    message_count: number;
    file_count: number;
    /**
     * Open threads visible to the client's island at commit time. Optional
     * (BAL-315): the admin surface has no client thread island, so it omits this.
     */
    thread_count?: number;
  };
  [PROJECT_EVENTS.CHANGES_REQUESTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    section: string;
    actor: string;
  };
  [PROJECT_EVENTS.PROPOSAL_RESUBMITTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    version: number;
    price_cents: number;
    currency: string;
  };
  [PROJECT_EVENTS.PROJECT_KICKOFF_APPROVED]: {
    request_id: string;
    actor: 'admin';
  };
  [PROJECT_EVENTS.PROJECT_KICKOFF_GATE_CONFIRMED]: {
    request_id: string;
    relationship_id: string;
    gate: 'client_billing' | 'expert_terms';
    actor: 'client' | 'expert';
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_VIEWED]: {
    request_id: string;
    lens: ProjectRequestLens;
    archetype: ProjectRequestArchetype;
    status: string;
    phase: ProjectRequestPhase;
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_PHASE_FLIPPED]: {
    request_id: string;
    lens: ProjectRequestLens;
    from_phase: 'phase1';
    to_phase: 'phase2';
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_DWELL]: {
    request_id: string;
    lens: ProjectRequestLens;
    status: string;
    dwell_ms: number;
  };
  [PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED]: {
    /** The `@balo/db` coherence-rule discriminant (e.g. `installments_not_100`). */
    rule: string;
    pricing_method: 'fixed' | 'tm';
    /** Hardcoded `'web'` today; the union lets future non-web callers reuse the event. */
    entry_point: 'web' | 'api' | 'slack' | 'worker';
    proposal_id: string;
    relationship_id: string;
  };
  // BAL-294: estimated effort per deliverable + asymmetric total derivation.
  [PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED]: {
    proposal_id: string;
    milestone_count: number;
    total_estimated_minutes: number;
    pricing_method: 'fixed' | 'tm';
  };
  [PROJECT_EVENTS.PROPOSAL_PRICING_METHOD_SWITCHED]: {
    proposal_id: string;
    from_method: 'fixed' | 'tm';
    to_method: 'fixed' | 'tm';
    /** Whether a typed Fixed price existed at switch time (informs the confirm beat). */
    had_typed_price: boolean;
  };
  // BAL-324: admin-initiated client-billing reminder from the kickoff board.
  [PROJECT_EVENTS.BILLING_REMINDER_SENT]: {
    request_id: string;
    company_id: string;
    admin_user_id: string;
    /** 1 = owner only; 2 = owner + request creator (creator ≠ owner AND a company member). */
    recipient_count: number;
    /** Whole days since proposal acceptance; `null` when no acceptance timestamp resolves. */
    days_since_acceptance: number | null;
  };
}

/**
 * Server-side project events (emitted via trackServer from RSC/Server Actions,
 * never the browser). project_request_access_denied fires at a request-detail
 * denial boundary when the would-be viewer is a DECLINED expert (BAL-276) — so we
 * can measure whether dropped/declined experts keep hitting the wall. NO PII:
 * only the request id, the denial reason, the attempted lens, and the distinct_id
 * (user UUID) — never the client's contact name/email.
 *
 * project_proposal_submitted / project_proposal_accepted are emitted SERVER-SIDE
 * (BAL-357) so the Balo service fee (`balo_fee_bps`) and the client-charged price
 * (`client_price_cents`) — from which the expert's exact payout could be backed out
 * — never transit the browser. This is an audience-boundary invariant: a client
 * must never be able to read the expert's fee/price in devtools, and vice versa.
 */
export const PROJECT_SERVER_EVENTS = {
  REQUEST_ACCESS_DENIED: 'project_request_access_denied',
  PROJECT_PROPOSAL_SUBMITTED: 'project_proposal_submitted',
  PROJECT_PROPOSAL_ACCEPTED: 'project_proposal_accepted',
  // BAL-358: an admin overrode a single request's Balo fee (basis points). Emitted
  // SERVER-SIDE only — the fee is an admin-audience figure that must never transit
  // the browser (same audience-boundary rationale as the proposal events above).
  ADMIN_PROJECT_FEE_OVERRIDDEN: 'admin_project_fee_overridden',
  // BAL-385: a client or admin downloaded the Balo-branded, client-facing proposal
  // PDF. Emitted SERVER-SIDE from the download Route Handler — proposal telemetry
  // stays off the browser (same audience-boundary rationale as the events above).
  // `audience` records WHO downloaded (client|admin); the PDF's serializer audience
  // is ALWAYS `client`, so the marked-up client figures are the only money it ever
  // carries — the fee/margin never reach this surface.
  PROJECT_PROPOSAL_PDF_DOWNLOADED: 'project_proposal_pdf_downloaded',
  // BAL-386: proposal sharing with an external colleague. All three are emitted
  // SERVER-SIDE (created/revoked in Server Actions, opened on the public server
  // page) — proposal telemetry stays off the browser (same audience-boundary
  // rationale as the events above). NEVER carry the full recipient email — the
  // create event records only the email DOMAIN.
  PROPOSAL_SHARE_CREATED: 'project_proposal_share_created',
  PROPOSAL_SHARE_OPENED: 'project_proposal_share_opened',
  PROPOSAL_SHARE_REVOKED: 'project_proposal_share_revoked',
} as const;

/** Why a would-be participant was denied. Extend as more terminal-negative
 *  relationship statuses (removed/withdrawn) gain analytics. */
export type ProjectRequestAccessDenialReason = 'declined_relationship';

export interface ProjectServerEventMap {
  [PROJECT_SERVER_EVENTS.REQUEST_ACCESS_DENIED]: {
    request_id: string;
    reason: ProjectRequestAccessDenialReason;
    lens_attempted: 'expert';
    distinct_id: string;
  };
  // BAL-357: emitted server-side from the expert's submit action — the fee +
  // client price never reach the browser. `distinct_id` is the acting expert.
  [PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_SUBMITTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    price_cents: number;
    currency: string;
    /** Sum of milestone estimated_minutes (BAL-294). 0 for Fixed (effort is T&M-only). */
    total_estimated_minutes: number;
    /** The proposal's pricing method at submit (BAL-294). */
    pricing_method: 'fixed' | 'tm';
    /** Snapshotted Balo service margin, in basis points (BAL-357). 2500 = 25%. */
    balo_fee_bps: number;
    /** Client-charged price = applyBaloFee(price_cents, balo_fee_bps), derived
     *  SERVER-SIDE (BAL-357). `price_cents` above stays the expert's payout quote. */
    client_price_cents: number;
    distinct_id: string;
  };
  // BAL-357: emitted server-side from the client's accept action — the fee +
  // client price never reach the browser. `distinct_id` is the acting client.
  [PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_ACCEPTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    proposal_id: string;
    /** Snapshotted Balo service margin, in basis points (BAL-357). 2500 = 25%. */
    balo_fee_bps: number;
    /** Client-charged price = applyBaloFee(proposal.price_cents, balo_fee_bps),
     *  derived SERVER-SIDE (BAL-357), never on the client. */
    client_price_cents: number;
    distinct_id: string;
  };
  // BAL-358: emitted server-side from the admin fee-override action, ONLY on a real
  // change (a no-op override emits nothing). `distinct_id` is the acting admin.
  [PROJECT_SERVER_EVENTS.ADMIN_PROJECT_FEE_OVERRIDDEN]: {
    project_request_id: string;
    previous_bps: number;
    new_bps: number;
    distinct_id: string;
  };
  // BAL-385: emitted server-side from the client-facing proposal PDF Route Handler
  // on a successful download (cache hit or miss). `audience` is the DOWNLOADER's
  // lens (client|admin); the serializer that builds the PDF always runs with the
  // `client` audience, so no fee/margin/expert-quote figure is ever in the document.
  // `version` is the proposal version stamped on the PDF; `distinct_id` is the
  // downloader's user id.
  [PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_PDF_DOWNLOADED]: {
    proposal_id: string;
    version: number;
    audience: 'client' | 'admin';
    distinct_id: string;
  };
  // BAL-386: a client member minted a share link for an external colleague. Emitted
  // server-side from the share Server Action. `recipient_email_domain` is the DOMAIN
  // only (never the full address); `distinct_id` is the sharing user.
  [PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_CREATED]: {
    relationship_id: string;
    recipient_email_domain: string;
    distinct_id: string;
  };
  // BAL-386: an external colleague opened a valid share link. Emitted server-side
  // from the public shared-proposal page. `first_open` is true only on the first
  // valid hit; `distinct_id` is a synthetic per-link id (`share_{id}`) — no user.
  [PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_OPENED]: {
    share_link_id: string;
    first_open: boolean;
    distinct_id: string;
  };
  // BAL-386: the sharer revoked a share link. Emitted server-side from the revoke
  // Server Action. `distinct_id` is the revoking user.
  [PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_REVOKED]: {
    share_link_id: string;
    distinct_id: string;
  };
}
