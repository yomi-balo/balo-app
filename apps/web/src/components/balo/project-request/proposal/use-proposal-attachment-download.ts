'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { getProposalDocumentDownloadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-proposal-document-download';
import type { ProposalReviewAttachment } from './proposal-review-types';

interface UseProposalAttachmentDownloadArgs {
  requestId: string;
  relationshipId: string;
  proposalId: string;
}

interface UseProposalAttachmentDownload {
  download: (attachment: ProposalReviewAttachment) => void;
  /** The attachment whose presigned link is being minted, or null. */
  downloadingId: string | null;
}

/**
 * Opens one proposal attachment through `getProposalDocumentDownloadAction`, which mints a
 * short-lived presigned link after its own authorization check.
 */
export function useProposalAttachmentDownload({
  requestId,
  relationshipId,
  proposalId,
}: Readonly<UseProposalAttachmentDownloadArgs>): UseProposalAttachmentDownload {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const download = useCallback(
    (attachment: ProposalReviewAttachment): void => {
      const run = async (): Promise<void> => {
        setDownloadingId(attachment.id);
        try {
          const result = await getProposalDocumentDownloadAction({
            requestId,
            relationshipId,
            proposalId,
            documentId: attachment.id,
          });
          if (!result.success) {
            toast.error(result.error);
            return;
          }
          // Same-tab: the URL forces an attachment disposition, so this downloads in place. A
          // `window.open` after the await runs outside the click's user gesture, which iOS
          // Safari blocks as a popup.
          globalThis.location.assign(result.url);
        } catch {
          // The action call itself rejected (offline, deploy skew) — it never got to answer.
          toast.error('Could not open this document. Please try again.');
        } finally {
          setDownloadingId(null);
        }
      };
      run();
    },
    [requestId, relationshipId, proposalId]
  );

  return { download, downloadingId };
}
