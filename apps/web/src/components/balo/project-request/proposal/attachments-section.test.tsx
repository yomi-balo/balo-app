import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { AttachmentsSection } from './attachments-section';
import type { ProposalDocumentUploadController } from './proposal-document-uploader';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

function doc(): ProposalDocumentView {
  return {
    id: 'doc-1',
    proposalId: 'prop-1',
    kind: 'ref',
    fileName: 'mockup.png',
    contentType: 'image/png',
    sizeBytes: 2048,
    uploadedByUserId: 'user-1',
    createdAtIso: '2025-02-01T00:00:00.000Z',
  };
}

function controller(
  overrides: Partial<ProposalDocumentUploadController> = {}
): ProposalDocumentUploadController {
  return {
    progress: null,
    removingId: null,
    uploadFiles: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('AttachmentsSection', () => {
  it('renders the optional Attachments heading with the page-wide drop prompt', () => {
    render(<AttachmentsSection documents={[]} upload={controller()} />);
    expect(screen.getByRole('heading', { level: 2, name: /Attachments/ })).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Drop files anywhere on this page, or browse' })
    ).toBeInTheDocument();
  });

  it('lists reference documents with a Reference tag and no kind control', () => {
    render(<AttachmentsSection documents={[doc()]} upload={controller()} />);
    expect(screen.getByText('mockup.png')).toBeInTheDocument();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('names the file input after the section heading', () => {
    const { container } = render(<AttachmentsSection documents={[]} upload={controller()} />);
    const input = container.querySelector('input[type="file"]');
    expect(input).toHaveAttribute('aria-labelledby', 'proposal-section-attachments-heading');
    expect(input).toHaveAttribute('multiple');
  });

  it('hands picked files to upload.uploadFiles', () => {
    const upload = controller();
    const { container } = render(<AttachmentsSection documents={[]} upload={upload} />);
    const input = container.querySelector('input[type="file"]');
    if (input === null) throw new Error('file input not found');
    const files = [
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ];
    fireEvent.change(input, { target: { files } });
    expect(upload.uploadFiles).toHaveBeenCalledWith(files);
  });

  it('removes a document through upload.remove', async () => {
    const user = userEvent.setup();
    const upload = controller();
    render(<AttachmentsSection documents={[doc()]} upload={upload} />);
    await user.click(screen.getByRole('button', { name: 'Remove mockup.png' }));
    expect(upload.remove).toHaveBeenCalledWith('doc-1');
  });
});
