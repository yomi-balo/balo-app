import { describe, it, expect, vi } from 'vitest';
import type { ConversationFile, ConversationMessage } from '@balo/db';

/**
 * BAL-421 — unit tests for the ANCHOR-AGNOSTIC conversation row → view mappers.
 *
 * ⚠⚠ THE RETURNED MESSAGE SHAPE IS AN ABLY WIRE PAYLOAD. `ConversationMessageView` is what the
 * client hook's STRUCTURAL guard `isConversationMessagePayload` checks field by field, so
 * renaming a field here silently rejects every inbound realtime message with a green
 * typecheck. The field-set assertions below are what make that renaming fail loudly.
 *
 * ⚠ `r2Key` HAS NO FIELD IN `ConversationFileView`, and the mapper projects field by field
 * rather than spreading — so it cannot acquire one by accident. The fixture carries a
 * real-looking key and the assertions serialize the whole output to hunt for it, because a
 * type cannot police a spread.
 *
 * `@balo/db` is imported for TYPES ONLY here (as it is in the module under test), so it is
 * erased and needs no mock.
 */

vi.mock('server-only', () => ({}));

import { mapConversationFileRowToView, mapMessageRowToView } from './conversation-view';

const CONVERSATION_ID = 'cv000000-0000-4000-8000-000000000001';
const SENDER_ID = 'u0000000-0000-4000-8000-000000000002';
const UPLOADER_ID = 'u0000000-0000-4000-8000-000000000003';
const R2_KEY = 'conversations/cv-1/9a8b7c6d-SUPERSECRETOBJECTKEY/deck.pdf';

type MessageRow = ConversationMessage & {
  senderFirstName: string | null;
  senderLastName: string | null;
};

function messageRow(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg-1',
    conversationId: CONVERSATION_ID,
    senderUserId: SENDER_ID,
    body: '<p>Morning — the sandbox is refreshed.</p>',
    senderFirstName: 'Dana',
    senderLastName: 'Okafor',
    sentDuringMeetingId: null,
    createdAt: new Date('2026-08-12T09:00:00Z'),
    updatedAt: new Date('2026-08-12T09:00:00Z'),
    deletedAt: null,
    ...over,
  } as unknown as MessageRow;
}

/** A FULL `conversation_files` row — `r2Key` included, exactly as the repository returns it. */
function fileRow(over: Partial<ConversationFile> = {}): ConversationFile {
  return {
    id: 'cf-1',
    conversationId: CONVERSATION_ID,
    uploadedByUserId: UPLOADER_ID,
    r2Key: R2_KEY,
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    createdAt: new Date('2026-08-12T09:30:00Z'),
    updatedAt: new Date('2026-08-12T09:30:00Z'),
    deletedAt: null,
    ...over,
  } as unknown as ConversationFile;
}

describe('mapMessageRowToView — the Ably wire payload', () => {
  it('projects exactly the six wire fields, renaming `body` to `bodyHtml`', () => {
    const view = mapMessageRowToView(messageRow());

    expect(view).toEqual({
      id: 'msg-1',
      conversationId: CONVERSATION_ID,
      bodyHtml: '<p>Morning — the sandbox is refreshed.</p>',
      senderUserId: SENDER_ID,
      senderName: 'Dana Okafor',
      createdAtIso: '2026-08-12T09:00:00.000Z',
    });
  });

  it('joins only the name parts that exist, on either side', () => {
    expect(mapMessageRowToView(messageRow({ senderLastName: null })).senderName).toBe('Dana');
    expect(mapMessageRowToView(messageRow({ senderFirstName: null })).senderName).toBe('Okafor');
  });

  it('falls back to "Participant" when NEITHER name part resolves — never an email', () => {
    const view = mapMessageRowToView(messageRow({ senderFirstName: null, senderLastName: null }));

    expect(view.senderName).toBe('Participant');
    expect(JSON.stringify(view)).not.toContain('@');
  });

  it('carries no `sentDuringMeetingId` and no soft-delete bookkeeping onto the wire', () => {
    const view = mapMessageRowToView(messageRow());

    expect('sentDuringMeetingId' in view).toBe(false);
    expect('deletedAt' in view).toBe(false);
  });
});

describe('mapConversationFileRowToView — the case-side file mapper', () => {
  it('attributes the uploader from the PRE-RESOLVED name map, and omits r2Key entirely', () => {
    const view = mapConversationFileRowToView(fileRow(), new Map([[UPLOADER_ID, 'Dana Okafor']]));

    expect(view).toEqual({
      id: 'cf-1',
      conversationId: CONVERSATION_ID,
      fileName: 'deck.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      uploadedByUserId: UPLOADER_ID,
      uploadedByName: 'Dana Okafor',
      createdAtIso: '2026-08-12T09:30:00.000Z',
    });
    // A type cannot police a spread; a serialized search can.
    expect('r2Key' in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain(R2_KEY);
    expect(JSON.stringify(view)).not.toContain('SUPERSECRETOBJECTKEY');
  });

  it('falls back to "Participant" for an uploader the batch did not resolve', () => {
    const view = mapConversationFileRowToView(fileRow(), new Map());

    expect(view.uploadedByName).toBe('Participant');
  });

  it('ignores names in the map that belong to other uploaders', () => {
    const view = mapConversationFileRowToView(
      fileRow(),
      new Map([[SENDER_ID, 'Someone Else Entirely']])
    );

    expect(view.uploadedByName).toBe('Participant');
    expect(JSON.stringify(view)).not.toContain('Someone Else Entirely');
  });
});
