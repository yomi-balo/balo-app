'use client';

import { ComposerSection } from './composer-section';
import { ProposalDocumentUploaderView } from './proposal-document-uploader';
import type { ProposalDocumentUploadController } from './proposal-document-uploader';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

interface AttachmentsSectionProps {
  /** General `ref` documents only (the terms supplement lives in the property bar). */
  documents: ProposalDocumentView[];
  /** The composer-owned `ref` upload controller (shared with the page-wide drop). */
  upload: ProposalDocumentUploadController;
}

const HEADING_ID = 'proposal-section-attachments-heading';

/**
 * Proposal-scoped general attachments (`kind:'ref'`) — case studies, mockups,
 * supporting docs — as a dashed drop zone under the document list.
 */
export function AttachmentsSection({
  documents,
  upload,
}: Readonly<AttachmentsSectionProps>): React.JSX.Element {
  return (
    <ComposerSection
      id="proposal-section-attachments"
      title="Attachments"
      optional
      help="Supporting documents, or your own terms to sit alongside Balo's."
    >
      <ProposalDocumentUploaderView
        controller={upload}
        documents={documents}
        labelId={HEADING_ID}
        pickLabel="Drop files anywhere on this page, or browse"
      />
    </ComposerSection>
  );
}
