import { describe, it, expect } from 'vitest';
import { resolvePanelCapabilities } from './panel-capabilities';
import type {
  MeetingGuestPanelRegistration,
  MeetingMemberPanelRegistration,
} from './meeting-panels';

/**
 * BAL-445 — `resolvePanelCapabilities` is THE ONE PLACE "what may this audience reach" is
 * decided. Three inputs (`null`, guest, member) × six fields, pinned exhaustively so a future
 * fifth capability field cannot be added without a test noticing it went unhandled for one
 * audience.
 */

const MEMBER: MeetingMemberPanelRegistration = {
  audience: 'member',
  joinLinkUrl: 'https://balo.test/join/m/x',
  loadGuests: async () => ({
    success: true,
    data: { guests: [], canHost: false, participantCount: 1, participantCap: 10 },
  }),
  inviteGuests: async () => ({
    success: true,
    invitedCount: 0,
    participantCount: 1,
    participantCap: 10,
  }),
  decideAdmission: async () => ({ success: true }),
  resendLink: async () => ({ success: true }),
  files: {
    list: async () => ({ success: true, files: [] }),
    requestUpload: async () => ({ success: true, presignedUrl: 'x', key: 'y' }),
    confirmUpload: async () => ({
      success: true,
      file: {
        id: 'f',
        meetingId: 'm',
        fileName: 'a',
        contentType: 'a',
        sizeBytes: 1,
        party: 'client',
        source: 'chat',
        uploadedByUserId: 'u',
        createdAtIso: '2026-01-01T00:00:00.000Z',
      },
    }),
    download: async () => ({ success: true, url: 'x' }),
  },
  chat: null,
  realtime: null,
  balance: null,
};

const GUEST: MeetingGuestPanelRegistration = {
  audience: 'guest',
  files: {
    list: async () => ({ success: true, files: [] }),
    download: async () => ({ success: true, url: 'x' }),
  },
  chat: null,
};

describe('resolvePanelCapabilities', () => {
  it('null ⇒ everything false, isGuest false — the shipped unregistered state', () => {
    expect(resolvePanelCapabilities(null)).toEqual({
      hasPeople: false,
      hasFiles: false,
      hasChat: false,
      hasBalance: false,
      hasReactions: false,
      isGuest: false,
    });
  });

  it('member, nothing extra registered ⇒ People + Files only', () => {
    expect(resolvePanelCapabilities(MEMBER)).toEqual({
      hasPeople: true,
      hasFiles: true,
      hasChat: false,
      hasBalance: false,
      hasReactions: false,
      isGuest: false,
    });
  });

  it('member with chat + balance + realtime registered ⇒ every capability true', () => {
    const full: MeetingMemberPanelRegistration = {
      ...MEMBER,
      chat: {
        fetchThread: async () => ({
          success: true,
          messages: [],
          hasEarlier: false,
          viewerUserId: 'u',
          writable: true,
        }),
        postMessage: async () => ({
          success: true,
          message: {
            id: 'm',
            conversationId: 'c',
            bodyHtml: '<p>x</p>',
            senderUserId: 'u',
            senderName: 'A',
            createdAtIso: '2026-01-01T00:00:00.000Z',
          },
        }),
        requestUpload: async () => ({ success: true, presignedUrl: 'x', key: 'y' }),
        confirmUpload: MEMBER.files.confirmUpload,
      },
      realtime: {
        fetchToken: async () =>
          ({ success: true, token: 't', expiresAt: '2026-01-01T00:00:00.000Z' }) as never,
        sendReaction: async () => ({ success: true }),
        meetingChannel: 'meeting:m',
        conversationChannel: 'conversation:c',
      },
      balance: { loadDrawdownState: async () => ({ success: true, state: null }) },
    };
    expect(resolvePanelCapabilities(full)).toEqual({
      hasPeople: true,
      hasFiles: true,
      hasChat: true,
      hasBalance: true,
      hasReactions: true,
      isGuest: false,
    });
  });

  it('guest, files only (no chat registered — e.g. the anonymous lobby mount) ⇒ Files, isGuest true', () => {
    expect(resolvePanelCapabilities(GUEST)).toEqual({
      hasPeople: false,
      hasFiles: true,
      hasChat: false,
      hasBalance: false,
      hasReactions: false,
      isGuest: true,
    });
  });

  it('guest with chat registered ⇒ Files + Chat, still NEVER People/Balance/Reactions', () => {
    const guestWithChat: MeetingGuestPanelRegistration = {
      ...GUEST,
      chat: { fetchThread: async () => ({ success: true, messages: [], hasEarlier: false }) },
    };
    expect(resolvePanelCapabilities(guestWithChat)).toEqual({
      hasPeople: false,
      hasFiles: true,
      hasChat: true,
      hasBalance: false,
      hasReactions: false,
      isGuest: true,
    });
  });
});
