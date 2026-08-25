export const CONVERSATION_EVENTS = {
  CONVERSATION_MESSAGE_SENT: 'conversation_message_sent',
  CONVERSATION_FILE_SHARED: 'conversation_file_shared',
  CONVERSATION_THREAD_SELECTED: 'conversation_thread_selected',
  CONVERSATION_FILES_OPENED: 'conversation_files_opened',
  CONVERSATION_CALL_CTA_CLICKED: 'conversation_call_cta_clicked',
  CONVERSATION_PROPOSAL_CTA_CLICKED: 'conversation_proposal_cta_clicked',
  // BAL-283 — the two conversation call-CTA "completion" events, wiring
  // CONVERSATION_CALL_CTA_CLICKED (the funnel head) to a real outcome per lens: the expert's
  // completion is the share, the client's is the booking.
  CONVERSATION_AVAILABILITY_SHARED: 'conversation_availability_shared',
  CONVERSATION_INTRO_CALL_BOOKED: 'conversation_intro_call_booked',
} as const;

/** Viewer lens inside the conversation stage (admin observes, never chats). */
export type ConversationLens = 'client' | 'expert';
/** How a thread became active: resolved default on mount vs a user tab click. */
export type ConversationThreadSelectMethod = 'auto' | 'manual';
/** Where the files drawer/sheet was opened from. */
export type ConversationFilesSurface = 'header' | 'tabstrip';
/**
 * Where the call CTA was clicked — THE canonical surface list.
 *
 * ⚠ THE TUPLE IS EXPORTED, NOT ONLY THE TYPE (round-1 W10). Four modules had re-declared the
 * literal union inline and two more had hand-written a matching `z.enum([...])`, so the wire
 * contract lived in six places and could drift silently in five of them. Server Actions derive
 * their Zod enum from THIS tuple; components import the type from here.
 */
export const CONVERSATION_CALL_SURFACES = ['header', 'rail', 'nudge'] as const;
export type ConversationCallSurface = (typeof CONVERSATION_CALL_SURFACES)[number];
/** Where the client's Request-proposal CTA was clicked (A5: no nudge surface). */
export type ConversationProposalSurface = 'header' | 'rail';

/**
 * What a conversation is ANCHORED to (BAL-424 / ADR-1045 §2) — the seam, restated for the
 * analytics wire. `relationship` is the pre-sales project thread; `engagement` is the
 * delivery thread (case, project, package or retainer — one label for the supertype).
 */
export type ConversationContextType = 'relationship' | 'engagement';

/**
 * Multi-expert conversation events (BAL-271 / A4). All client-side, keyed off
 * persisted ids. PM questions: messages per request = count(MESSAGE_SENT) by
 * request_id; parallel engagement = distinct relationship_id per request_id
 * (+ thread_count); meeting-CTA click rate = CALL_CTA_CLICKED ÷
 * project_request_detail_viewed{phase:'phase2'}; depth ↔ proposal = join
 * MESSAGE_SENT counts with PROJECT_PROPOSAL_REQUESTED on request_id;
 * confirm-beat abandonment (BAL-272) = PROPOSAL_CTA_CLICKED −
 * project_proposal_requested per request_id (the measurable friction cost of
 * the "committing action gets a confirm" rule).
 *
 * BAL-424 generalises the anchor: `conversation_id` + `context_type` are added and
 * `request_id` / `relationship_id` become OPTIONAL, because a Case-anchored thread has
 * NEITHER. The EVENT KEY SET IS DELIBERATELY UNCHANGED — the two questions the ticket adds
 * are answered as DERIVATIONS rather than as new events:
 *
 *  · THREAD LENGTH ("messages per conversation") = count(MESSAGE_SENT) group by
 *    `conversation_id`. That is the ticket's `thread_length`, obtained without a COUNT query
 *    on every send.
 *  · CASE MESSAGES vs CONSULTATIONS = MESSAGE_SENT{context_type:'engagement'} counted per
 *    `context_id` (= the engagement id), joined against booking events on the same
 *    engagement. Cases with heavy messaging and NO follow-up booking are the substitution
 *    signal — the evidence that would falsify "messaging is free and unlimited".
 */
export interface ConversationEventMap {
  [CONVERSATION_EVENTS.CONVERSATION_MESSAGE_SENT]: {
    /** Absent on an engagement-anchored (e.g. Case) thread — it has no request. */
    request_id?: string;
    /** Absent on an engagement-anchored (e.g. Case) thread — it has no relationship row. */
    relationship_id?: string;
    /** BAL-424 — the thread identity, present on EVERY anchor. */
    conversation_id: string;
    context_type: ConversationContextType;
    lens: ConversationLens;
    /** Plain-text characters in the sent message. */
    body_length: number;
    /** Open threads visible to this viewer at send time. */
    thread_count: number;
    is_first_message_in_thread: boolean;
    /** True when the message was sent from the in-call panel (BAL-132 / BAL-418). */
    during_meeting: boolean;
  };
  [CONVERSATION_EVENTS.CONVERSATION_FILE_SHARED]: {
    request_id?: string;
    relationship_id?: string;
    conversation_id: string;
    context_type: ConversationContextType;
    lens: ConversationLens;
    content_type: string;
    size_bytes: number;
  };
  [CONVERSATION_EVENTS.CONVERSATION_THREAD_SELECTED]: {
    request_id?: string;
    relationship_id?: string;
    conversation_id: string;
    method: ConversationThreadSelectMethod;
    was_unread: boolean;
    thread_count: number;
  };
  [CONVERSATION_EVENTS.CONVERSATION_FILES_OPENED]: {
    request_id?: string;
    relationship_id?: string;
    conversation_id: string;
    surface: ConversationFilesSurface;
    file_count: number;
  };
  [CONVERSATION_EVENTS.CONVERSATION_CALL_CTA_CLICKED]: {
    request_id: string;
    relationship_id: string;
    lens: ConversationLens;
    surface: ConversationCallSurface;
  };
  [CONVERSATION_EVENTS.CONVERSATION_PROPOSAL_CTA_CLICKED]: {
    request_id: string;
    relationship_id: string;
    surface: ConversationProposalSurface;
  };
  /**
   * BAL-283 (Ruling 3) — `shareAvailabilityAction` returned `ok`. `lens` is deliberately
   * ABSENT (§14.2 of the plan): this event is structurally expert-only (the share is the
   * expert's completion), so a `lens` property could only ever hold one value and would
   * invite a false cross-tab against `CONVERSATION_INTRO_CALL_BOOKED`.
   */
  [CONVERSATION_EVENTS.CONVERSATION_AVAILABILITY_SHARED]: {
    request_id: string;
    relationship_id: string;
    surface: ConversationCallSurface;
    is_reshare: boolean;
  };
  /**
   * BAL-283 — `bookIntroCallAction` returned `ok`. Structurally client-only (the booking is
   * the client's completion) — same `lens`-absence reasoning as the share event above.
   */
  [CONVERSATION_EVENTS.CONVERSATION_INTRO_CALL_BOOKED]: {
    request_id: string;
    relationship_id: string;
    expert_profile_id: string;
    surface: ConversationCallSurface;
    duration_minutes: number;
    guest_count: number;
    provisioned: boolean;
  };
}
