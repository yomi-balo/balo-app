import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { CaseFileRowView } from '@/lib/cases/case-view-types';
import type { ProjectDocumentRef } from '@/lib/project-request/actions/schemas';

vi.mock('server-only', () => ({}));

const mockCopy = vi.fn();
const mockRemove = vi.fn();
const mockToastError = vi.fn();

vi.mock('@/app/(dashboard)/cases/[engagementId]/_actions/copy-case-file-to-project', () => ({
  copyCaseFileToProjectAction: (...args: unknown[]) => mockCopy(...args),
}));
vi.mock('@/lib/project-request/actions/remove-project-document', () => ({
  removeProjectDocumentAction: (...args: unknown[]) => mockRemove(...args),
}));
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args), success: vi.fn() },
}));

import { CaseFilePicker } from './case-file-picker';

const CASE_ID = '33333333-3333-3333-3333-333333333333';

const CONVERSATION_FILE: CaseFileRowView = {
  origin: 'conversation',
  id: 'f1',
  meetingId: null,
  fileName: 'requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1024,
  createdAtIso: '2026-01-01T00:00:00.000Z',
  uploaderLabel: 'You',
  sourceLabel: 'Conversation',
};

const MEETING_FILE: CaseFileRowView = {
  origin: 'meeting',
  id: 'f2',
  meetingId: 'm1',
  fileName: 'notes.png',
  contentType: 'image/png',
  sizeBytes: 2048,
  createdAtIso: '2026-01-01T00:00:00.000Z',
  uploaderLabel: 'Dana',
  sourceLabel: 'Consultation 1',
};

const OVERSIZE_FILE: CaseFileRowView = {
  ...CONVERSATION_FILE,
  id: 'f3',
  fileName: 'huge.pdf',
  sizeBytes: 6 * 1024 * 1024,
};

const DOCX_FILE: CaseFileRowView = {
  ...CONVERSATION_FILE,
  id: 'f4',
  fileName: 'legacy.docx',
  contentType: 'application/msword',
};

const COPIED_CONVERSATION_DOC: ProjectDocumentRef = {
  r2Key: 'project-documents/c/u/copied-1',
  fileName: 'requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1024,
};

const COPIED_MEETING_DOC: ProjectDocumentRef = {
  r2Key: 'project-documents/c/u/copied-2',
  fileName: 'notes.png',
  contentType: 'image/png',
  sizeBytes: 2048,
};

/**
 * A REAL, state-backed harness. `onCaseFileSelectionsChange` is React's own `setState` updater
 * SIGNATURE (fix round F2), so passing the setter itself exercises the component's functional
 * updates exactly as `ProjectRequestPanel` does (`setField('caseFileSelections', updater)`).
 */
function renderPicker(
  overrides: Partial<{
    files: readonly CaseFileRowView[];
    uploadedDocumentCount: number;
    initialSelections: Record<string, ProjectDocumentRef>;
  }> = {}
) {
  let latestSelections: Record<string, ProjectDocumentRef> = overrides.initialSelections ?? {};

  function Harness() {
    const [selections, setSelections] = useState(overrides.initialSelections ?? {});
    latestSelections = selections;
    return (
      <CaseFilePicker
        caseId={CASE_ID}
        files={overrides.files ?? [CONVERSATION_FILE, MEETING_FILE]}
        uploadedDocumentCount={overrides.uploadedDocumentCount ?? 0}
        caseFileSelections={selections}
        onCaseFileSelectionsChange={setSelections}
      />
    );
  }

  const view = render(<Harness />);
  return { view, getSelections: () => latestSelections };
}

/** Narrow by destructure + guard (fix round F10) — never `[n]!`. */
function nthCheckbox(index: number): HTMLElement {
  const checkboxes = screen.getAllByRole('checkbox');
  const checkbox = checkboxes[index];
  if (checkbox === undefined) throw new Error(`expected a checkbox at index ${index}`);
  return checkbox;
}

describe('CaseFilePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the case has no files', () => {
    const { view } = renderPicker({ files: [] });
    expect(view.container).toBeEmptyDOMElement();
  });

  it('lists every file with its name and size', () => {
    renderPicker();
    expect(screen.getByText('requirements.pdf')).toBeInTheDocument();
    expect(screen.getByText('notes.png')).toBeInTheDocument();
    expect(screen.getByText('1 KB')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
  });

  it('disables and labels an oversize row', () => {
    renderPicker({ files: [OVERSIZE_FILE] });
    expect(nthCheckbox(0)).toBeDisabled();
    expect(screen.getByText('over 5 MB')).toBeInTheDocument();
  });

  it('disables and labels an unsupported-type row', () => {
    renderPicker({ files: [DOCX_FILE] });
    expect(nthCheckbox(0)).toBeDisabled();
    expect(screen.getByText('file type not supported')).toBeInTheDocument();
  });

  it('disables unselected rows once the document cap is reached (uploads + case copies combined)', () => {
    renderPicker({
      uploadedDocumentCount: 2,
      initialSelections: {
        'x:1': { ...COPIED_CONVERSATION_DOC, r2Key: 'k1' },
        'x:2': { ...COPIED_CONVERSATION_DOC, r2Key: 'k2' },
      },
    });
    const checkboxes = screen.getAllByRole('checkbox');
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeDisabled();
    }
    expect(screen.getAllByText('4-file limit reached')).toHaveLength(2);
  });

  // ── F7 — the whole row is the hit target, not the bare 16px checkbox ──────────────────────
  it('clicking the FILE NAME (not just the checkbox) toggles selection', async () => {
    mockCopy.mockResolvedValue({ success: true, document: COPIED_CONVERSATION_DOC });
    const user = userEvent.setup();
    const { getSelections } = renderPicker();

    await user.click(screen.getByText('requirements.pdf'));

    expect(mockCopy).toHaveBeenCalledWith({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: 'f1',
    });
    await waitFor(() =>
      expect(getSelections()).toEqual({ 'conversation:f1': COPIED_CONVERSATION_DOC })
    );
  });

  it('a disabled row shows a not-allowed cursor and never toggles', async () => {
    const user = userEvent.setup();
    renderPicker({ files: [OVERSIZE_FILE] });
    const label = nthCheckbox(0).closest('label');
    expect(label).not.toBeNull();
    expect(label).toHaveClass('cursor-not-allowed');

    await user.click(screen.getByText('huge.pdf'));
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('selecting a conversation file copies it and adds it to caseFileSelections', async () => {
    mockCopy.mockResolvedValue({ success: true, document: COPIED_CONVERSATION_DOC });
    const user = userEvent.setup();
    const { getSelections } = renderPicker();

    await user.click(nthCheckbox(0));

    expect(mockCopy).toHaveBeenCalledWith({
      caseId: CASE_ID,
      origin: 'conversation',
      fileId: 'f1',
    });
    await waitFor(() =>
      expect(getSelections()).toEqual({ 'conversation:f1': COPIED_CONVERSATION_DOC })
    );
  });

  it('selecting a meeting file passes its meetingId', async () => {
    mockCopy.mockResolvedValue({ success: true, document: COPIED_MEETING_DOC });
    const user = userEvent.setup();
    renderPicker();

    await user.click(nthCheckbox(1));

    expect(mockCopy).toHaveBeenCalledWith({
      caseId: CASE_ID,
      origin: 'meeting',
      fileId: 'f2',
      meetingId: 'm1',
    });
  });

  it('shows a toast and does not update selections when the copy fails', async () => {
    mockCopy.mockResolvedValue({ success: false, error: 'This file is no longer available.' });
    const user = userEvent.setup();
    const { getSelections } = renderPicker();

    await user.click(nthCheckbox(0));

    expect(mockToastError).toHaveBeenCalledWith('This file is no longer available.');
    expect(getSelections()).toEqual({});
  });

  it('deselecting drops the selection and best-effort deletes the copy', async () => {
    mockRemove.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    const { getSelections } = renderPicker({
      initialSelections: { 'conversation:f1': COPIED_CONVERSATION_DOC },
    });

    await user.click(nthCheckbox(0));

    expect(getSelections()).toEqual({});
    expect(mockRemove).toHaveBeenCalledWith({ key: COPIED_CONVERSATION_DOC.r2Key });
  });

  it('shows no success toast on a successful copy, matching DocumentUploader', async () => {
    mockCopy.mockResolvedValue({ success: true, document: COPIED_CONVERSATION_DOC });
    const user = userEvent.setup();
    renderPicker();
    await user.click(nthCheckbox(0));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // ── F2 — a functional update, so two quick selections resolving OUT OF ORDER both persist ──
  it('two selections resolving out of order both persist in caseFileSelections', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    let resolveSecond: (value: unknown) => void = () => {};
    mockCopy
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    const user = userEvent.setup();
    const { getSelections } = renderPicker();

    await user.click(nthCheckbox(0));
    await user.click(nthCheckbox(1));

    // Resolve OUT OF ORDER — the second click's copy lands before the first's.
    await act(async () => {
      resolveSecond({ success: true, document: COPIED_MEETING_DOC });
      await Promise.resolve();
    });
    expect(getSelections()).toEqual({ 'meeting:f2': COPIED_MEETING_DOC });

    await act(async () => {
      resolveFirst({ success: true, document: COPIED_CONVERSATION_DOC });
      await Promise.resolve();
    });
    expect(getSelections()).toEqual({
      'meeting:f2': COPIED_MEETING_DOC,
      'conversation:f1': COPIED_CONVERSATION_DOC,
    });
  });

  // ── F18 — an in-flight copy reserves its slot BEFORE it resolves ──────────────────────────
  it('at 3 documents, ticking two rows quickly disables the second row once the first is in flight', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockCopy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const user = userEvent.setup();
    const { getSelections } = renderPicker({ uploadedDocumentCount: 3 });

    await user.click(nthCheckbox(0));

    // The first copy hasn't resolved yet — no new selection exists — but its busy slot already
    // counts toward the shared cap, so the still-unselected second row is disabled.
    expect(getSelections()).toEqual({});
    expect(nthCheckbox(1)).toBeDisabled();
    expect(screen.getByText('4-file limit reached')).toBeInTheDocument();

    await user.click(nthCheckbox(1));
    expect(mockCopy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ success: true, document: COPIED_CONVERSATION_DOC });
      await Promise.resolve();
    });
    expect(getSelections()).toEqual({ 'conversation:f1': COPIED_CONVERSATION_DOC });
  });
});
