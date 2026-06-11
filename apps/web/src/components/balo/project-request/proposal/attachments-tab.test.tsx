import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { AttachmentsTab } from './attachments-tab';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

// Stub the uploader — its presign/XHR/confirm internals are tested separately. We
// only assert the AttachmentsTab wires its kind:'ref' slot + the document list.
vi.mock('./proposal-document-uploader', () => ({
  ProposalDocumentUploader: (props: { kind: string; documents: ProposalDocumentView[] }) => (
    <div data-testid="ref-uploader" data-kind={props.kind}>
      {props.documents.map((d) => (
        <span key={d.id}>{d.fileName}</span>
      ))}
    </div>
  ),
}));

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-1';

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

describe('AttachmentsTab', () => {
  it('renders the supporting-files label + the ref uploader with its documents', () => {
    render(
      <AttachmentsTab
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        documents={[doc()]}
        ensureProposalId={() => Promise.resolve('prop-1')}
        onAdded={vi.fn()}
        onRemoved={vi.fn()}
      />
    );

    expect(screen.getByText(/Supporting files \(optional\)/i)).toBeInTheDocument();
    const uploader = screen.getByTestId('ref-uploader');
    expect(uploader).toHaveAttribute('data-kind', 'ref');
    expect(screen.getByText('mockup.png')).toBeInTheDocument();
  });
});
