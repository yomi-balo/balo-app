import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockUseIsMobile = vi.fn();
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockUseIsMobile() }));

import { ThreadFilesPanel, formatRelativeTime } from './thread-files-panel';
import type { ConversationFileView } from '@/lib/project-request/conversation-view-types';

function file(overrides: Partial<ConversationFileView> = {}): ConversationFileView {
  return {
    id: 'f-1',
    relationshipId: 'rel-1',
    fileName: 'price-book-export.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 2 * 1024 * 1024,
    uploadedByUserId: 'user-expert',
    uploadedByName: 'Priya Nair',
    createdAtIso: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof ThreadFilesPanel>> = {}): {
  onDownload: ReturnType<typeof vi.fn>;
  onRetry: ReturnType<typeof vi.fn>;
} {
  const onDownload = vi.fn();
  const onRetry = vi.fn();
  render(
    <ThreadFilesPanel
      open
      onOpenChange={vi.fn()}
      state="ready"
      files={[]}
      downloadingFileId={null}
      onDownload={onDownload}
      onRetry={onRetry}
      {...overrides}
    />
  );
  return { onDownload, onRetry };
}

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  it('formats minutes/hours/days/weeks', () => {
    expect(formatRelativeTime('2026-06-10T11:59:40.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-06-10T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-06-10T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-06-08T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatRelativeTime('2026-05-20T12:00:00.000Z', now)).toBe('3w ago');
  });
});

describe('ThreadFilesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
  });

  it('shows the empty state as an invitation', () => {
    renderPanel();
    expect(screen.getByText('Shared in this conversation')).toBeInTheDocument();
    expect(screen.getByText('No files shared yet')).toBeInTheDocument();
    expect(screen.getByText(/Drop a file in the conversation/)).toBeInTheDocument();
  });

  it('shows skeleton rows (never the empty copy) while the thread fetch is in flight', () => {
    renderPanel({ state: 'loading' });
    expect(screen.getByText('Loading shared files…')).toBeInTheDocument();
    expect(screen.queryByText('No files shared yet')).not.toBeInTheDocument();
  });

  it('shows the inline error with a working Retry when the thread fetch failed', async () => {
    const user = userEvent.setup();
    const { onRetry } = renderPanel({ state: 'error' });
    expect(screen.getByText(/Couldn't load files/)).toBeInTheDocument();
    expect(screen.queryByText('No files shared yet')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('lists files with uploader · relative time · size and fires downloads', async () => {
    const user = userEvent.setup();
    const { onDownload } = renderPanel({ files: [file()] });
    expect(screen.getByText('price-book-export.xlsx')).toBeInTheDocument();
    expect(screen.getByText(/Priya Nair · 2h ago · 2\.0 MB/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /price-book-export/ }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'f-1' }));
  });

  it('disables the row while its download is presigning', () => {
    renderPanel({ files: [file()], downloadingFileId: 'f-1' });
    expect(screen.getByRole('button', { name: /price-book-export/ })).toBeDisabled();
  });

  it('renders as a bottom sheet on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    renderPanel({ files: [file()] });
    expect(screen.getByText('Shared in this conversation')).toBeInTheDocument();
    expect(screen.getByText('price-book-export.xlsx')).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    renderPanel({ open: false, files: [file()] });
    expect(screen.queryByText('Shared in this conversation')).not.toBeInTheDocument();
  });
});
