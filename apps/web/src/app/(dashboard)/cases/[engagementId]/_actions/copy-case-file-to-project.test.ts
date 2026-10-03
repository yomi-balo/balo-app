import { describe, it, expect, vi, beforeEach } from 'vitest';

const CASE_ID = 'e1000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'a0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000005';
const OTHER_COMPANY_ID = 'a0000000-0000-4000-8000-000000000009';
const FILE_ID = 'f1000000-0000-4000-8000-000000000003';
const CONVERSATION_ID = 'k1000000-0000-4000-8000-000000000005';
const MEETING_ID = 'a1000000-0000-4000-8000-000000000004';
const FOREIGN_MEETING_ID = 'a1000000-0000-4000-8000-0000000000ff';

vi.mock('server-only', () => ({}));

const mockFindByContext = vi.fn();
const mockListFiles = vi.fn();
const mockListMeetingsForContext = vi.fn();
const mockFindInMeeting = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    findByContext: (...a: unknown[]) => mockFindByContext(...a),
    listFiles: (...a: unknown[]) => mockListFiles(...a),
  },
  meetingContextsRepository: {
    listMeetingsForContext: (...a: unknown[]) => mockListMeetingsForContext(...a),
  },
  meetingFilesRepository: { findInMeeting: (...a: unknown[]) => mockFindInMeeting(...a) },
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockAuthorizeCaseMutation = vi.fn();
vi.mock('../_lib/authorize-case-mutation', () => ({
  authorizeCaseMutation: (...a: unknown[]) => mockAuthorizeCaseMutation(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const mockGenerateProjectDocumentKey = vi.fn();
const mockCopyCaseFileIntoProjectDocuments = vi.fn();
vi.mock('@/lib/storage/project-document', () => ({
  generateProjectDocumentKey: (...a: unknown[]) => mockGenerateProjectDocumentKey(...a),
  copyCaseFileIntoProjectDocuments: (...a: unknown[]) => mockCopyCaseFileIntoProjectDocuments(...a),
}));

import { log } from '@/lib/logging';
import { copyCaseFileToProjectAction } from './copy-case-file-to-project';

function gateOk(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    user: { id: USER_ID },
    engagementId: CASE_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    lens: 'client',
    caseRow: { title: 'Salesforce integration' },
    ...overrides,
  };
}

function conversationFile(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: FILE_ID,
    r2Key: `conversation-files/${CONVERSATION_ID}/${USER_ID}/stored-object`,
    fileName: 'rfp.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

function meetingFile(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: FILE_ID,
    r2Key: `meeting-files/${MEETING_ID}/${USER_ID}/stored-object`,
    fileName: 'notes.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    party: 'client',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID, companyId: COMPANY_ID });
  mockAuthorizeCaseMutation.mockResolvedValue(gateOk());
  mockHasCapability.mockResolvedValue(true);
  mockFindByContext.mockResolvedValue({ id: CONVERSATION_ID });
  mockListFiles.mockResolvedValue([conversationFile()]);
  mockListMeetingsForContext.mockResolvedValue([{ id: MEETING_ID }]);
  mockFindInMeeting.mockResolvedValue(meetingFile());
  mockGenerateProjectDocumentKey.mockReturnValue(
    `project-documents/${COMPANY_ID}/${USER_ID}/new-object`
  );
  mockCopyCaseFileIntoProjectDocuments.mockResolvedValue(undefined);
});

describe('copyCaseFileToProjectAction', () => {
  it('rejects an un-onboarded session before touching the gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('not onboarded'));

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  it('denies an expert-lens actor — no copy, no file read', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue(gateOk({ lens: 'expert' }));

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({
      success: false,
      error: "You don't have permission to attach files from this case.",
    });
    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockCopyCaseFileIntoProjectDocuments).not.toHaveBeenCalled();
  });

  it('denies an actor missing PARTICIPATE', async () => {
    mockHasCapability.mockResolvedValue(false);

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({
      success: false,
      error: "You don't have permission to attach files from this case.",
    });
    expect(mockCopyCaseFileIntoProjectDocuments).not.toHaveBeenCalled();
  });

  it('denies a company mismatch between the active session and the gate', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID, companyId: OTHER_COMPANY_ID });

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({
      success: false,
      error: 'Switch to the workspace this case belongs to.',
    });
    expect(mockCopyCaseFileIntoProjectDocuments).not.toHaveBeenCalled();
  });

  it("reports another case's conversation file as no longer available", async () => {
    mockListFiles.mockResolvedValue([conversationFile({ id: 'some-other-file-id' })]);

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockCopyCaseFileIntoProjectDocuments).not.toHaveBeenCalled();
  });

  it("reports a meeting outside this case's own meetings as no longer available — file never read", async () => {
    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'meeting',
      fileId: FILE_ID,
      meetingId: FOREIGN_MEETING_ID,
    });

    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockFindInMeeting).not.toHaveBeenCalled();
  });

  it('rejects a file over 5 MB', async () => {
    mockListFiles.mockResolvedValue([conversationFile({ sizeBytes: 6 * 1024 * 1024 })]);

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({ success: false, error: 'This file is over 5 MB.' });
    expect(mockCopyCaseFileIntoProjectDocuments).not.toHaveBeenCalled();
  });

  it('rejects an unsupported content type (DOCX)', async () => {
    mockListFiles.mockResolvedValue([
      conversationFile({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ]);

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
    expect(mockCopyCaseFileIntoProjectDocuments).not.toHaveBeenCalled();
  });

  it('drops a meeting file whose party is not two-sided', async () => {
    mockFindInMeeting.mockResolvedValue(meetingFile({ party: 'observer' }));

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'meeting',
      fileId: FILE_ID,
      meetingId: MEETING_ID,
    });

    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
  });

  it('happy path copies a conversation file into the session prefix', async () => {
    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({
      success: true,
      document: {
        r2Key: `project-documents/${COMPANY_ID}/${USER_ID}/new-object`,
        fileName: 'rfp.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      },
    });
    expect(mockCopyCaseFileIntoProjectDocuments).toHaveBeenCalledWith(
      `conversation-files/${CONVERSATION_ID}/${USER_ID}/stored-object`,
      `project-documents/${COMPANY_ID}/${USER_ID}/new-object`
    );
    expect(log.info).toHaveBeenCalled();
  });

  it('happy path copies a meeting file into the session prefix', async () => {
    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'meeting',
      fileId: FILE_ID,
      meetingId: MEETING_ID,
    });

    expect(result.success).toBe(true);
    expect(mockCopyCaseFileIntoProjectDocuments).toHaveBeenCalledWith(
      `meeting-files/${MEETING_ID}/${USER_ID}/stored-object`,
      `project-documents/${COMPANY_ID}/${USER_ID}/new-object`
    );
  });

  it('logs and returns a generic error when the R2 copy throws', async () => {
    mockCopyCaseFileIntoProjectDocuments.mockRejectedValue(new Error('R2 down'));

    const result = await copyCaseFileToProjectAction({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: FILE_ID,
    });

    expect(result).toEqual({
      success: false,
      error: 'Could not attach this file. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
  });
});
