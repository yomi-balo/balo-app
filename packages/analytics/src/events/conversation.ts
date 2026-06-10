export const CONVERSATION_EVENTS = {
  CONVERSATION_MESSAGE_SENT: 'conversation_message_sent',
  CONVERSATION_FILE_SHARED: 'conversation_file_shared',
  CONVERSATION_THREAD_SELECTED: 'conversation_thread_selected',
  CONVERSATION_FILES_OPENED: 'conversation_files_opened',
  CONVERSATION_CALL_CTA_CLICKED: 'conversation_call_cta_clicked',
} as const;

/** Viewer lens inside the conversation stage (admin observes, never chats). */
export type ConversationLens = 'client' | 'expert';
/** How a thread became active: resolved default on mount vs a user tab click. */
export type ConversationThreadSelectMethod = 'auto' | 'manual';
/** Where the files drawer/sheet was opened from. */
export type ConversationFilesSurface = 'header' | 'tabstrip';
/** Where the call CTA was clicked. */
export type ConversationCallSurface = 'header' | 'rail' | 'nudge';

/**
 * Multi-expert conversation events (BAL-271 / A4). All client-side, keyed off
 * persisted ids. PM questions: messages per request = count(MESSAGE_SENT) by
 * request_id; parallel engagement = distinct relationship_id per request_id
 * (+ thread_count); meeting-CTA click rate = CALL_CTA_CLICKED ÷
 * project_request_detail_viewed{phase:'phase2'}; depth ↔ proposal = join
 * MESSAGE_SENT counts with PROJECT_PROPOSAL_REQUESTED on request_id.
 */
export interface ConversationEventMap {
  [CONVERSATION_EVENTS.CONVERSATION_MESSAGE_SENT]: {
    request_id: string;
    relationship_id: string;
    lens: ConversationLens;
    /** Plain-text characters in the sent message. */
    body_length: number;
    /** Open threads visible to this viewer at send time. */
    thread_count: number;
    is_first_message_in_thread: boolean;
  };
  [CONVERSATION_EVENTS.CONVERSATION_FILE_SHARED]: {
    request_id: string;
    relationship_id: string;
    lens: ConversationLens;
    content_type: string;
    size_bytes: number;
  };
  [CONVERSATION_EVENTS.CONVERSATION_THREAD_SELECTED]: {
    request_id: string;
    relationship_id: string;
    method: ConversationThreadSelectMethod;
    was_unread: boolean;
    thread_count: number;
  };
  [CONVERSATION_EVENTS.CONVERSATION_FILES_OPENED]: {
    request_id: string;
    relationship_id: string;
    surface: ConversationFilesSurface;
    file_count: number;
  };
  [CONVERSATION_EVENTS.CONVERSATION_CALL_CTA_CLICKED]: {
    request_id: string;
    relationship_id: string;
    lens: ConversationLens;
    surface: ConversationCallSurface;
  };
}
