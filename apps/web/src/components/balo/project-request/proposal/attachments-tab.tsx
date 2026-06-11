'use client';

import { Label } from '@/components/ui/label';
import { ProposalDocumentUploader } from './proposal-document-uploader';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

interface AttachmentsTabProps {
  requestId: string;
  relationshipId: string;
  /** General `ref` documents only (terms supplement lives on the Payment tab). */
  documents: ProposalDocumentView[];
  ensureProposalId: () => Promise<string | null>;
  onAdded: (document: ProposalDocumentView) => void;
  onRemoved: (documentId: string) => void;
}

/**
 * Proposal-scoped general attachments (`kind:'ref'`) — case studies, mockups,
 * supporting docs. The terms supplement is separate (Payment & terms tab).
 */
export function AttachmentsTab({
  requestId,
  relationshipId,
  documents,
  ensureProposalId,
  onAdded,
  onRemoved,
}: Readonly<AttachmentsTabProps>): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label id="attachments-label" className="text-foreground text-sm font-medium">
          Supporting files (optional)
        </Label>
        <p className="text-muted-foreground text-[13px]">
          Add case studies, mockups, or anything that strengthens your proposal. Up to 10 MB each.
        </p>
      </div>
      <ProposalDocumentUploader
        requestId={requestId}
        relationshipId={relationshipId}
        documents={documents}
        kind="ref"
        ensureProposalId={ensureProposalId}
        onAdded={onAdded}
        onRemoved={onRemoved}
        labelId="attachments-label"
      />
    </div>
  );
}
