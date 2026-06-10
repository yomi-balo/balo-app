import type { ConversationThreadView } from '@/lib/project-request/conversation-view-types';

/**
 * Shared `ConversationThreadView` fixture for the BAL-271 conversation suites.
 * Defaults mirror the most common shape (quiet, open, no profile slug); pass
 * overrides for anything a test cares about.
 */
export function thread(overrides: Partial<ConversationThreadView> = {}): ConversationThreadView {
  return {
    relationshipId: 'rel-1',
    expertProfileId: 'exp-1',
    expertName: 'Priya Nair',
    expertFirstName: 'Priya',
    expertInitials: 'PN',
    expertUsername: null,
    relationshipStatus: 'eoi_submitted',
    stage: 'active',
    invitedAtIso: '2026-06-01T00:00:00.000Z',
    unread: false,
    latestMessagePreview: null,
    latestMessageAtIso: null,
    latestMessageFromViewer: false,
    latestInboundActivityAtIso: null,
    lastReadAtIso: null,
    fileCount: 0,
    eoiHtml: null,
    eoiSubmittedAtIso: null,
    ...overrides,
  };
}
