'use client';

import { useCallback, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { track, REQUEST_FILE_EVENTS } from '@/lib/analytics';
import { FileViewerDialog } from '@/components/balo/conversation/file-viewer-dialog';
import { isConversationViewableImage } from '@/lib/storage/conversation-file-constraints';
import { getRequestFileDownloadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-request-file-download';

export type RequestFilePreviewSurface = 'thread_card' | 'files_card' | 'files_sheet';
type PreviewViewerSide = 'client' | 'expert' | 'admin';

export interface PreviewTarget {
  id: string;
  fileName: string;
  contentType: string;
}

interface ViewerState {
  kind: 'image' | 'pdf';
  fileId: string;
  fileName: string;
  url: string;
}

const PDF_CONTENT_TYPE = 'application/pdf';
const PREVIEW_FAILED_COPY = 'Could not open this file. Please try again.';

function previewKindOf(contentType: string): 'image' | 'pdf' | null {
  if (isConversationViewableImage(contentType)) return 'image';
  return contentType === PDF_CONTENT_TYPE ? 'pdf' : null;
}

/**
 * Mobile browsers that can't show an embedded PDF: iOS (iPhone, iPad, and iPadOS, which reports
 * as a Mac with a touch screen) renders only the first page, and Android Chrome renders nothing.
 */
function opensPdfInNewTab(): boolean {
  const nav = globalThis.navigator;
  if (nav === undefined) return false;
  return (
    /iPad|iPhone|iPod|Android/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  );
}

interface UseRequestFilePreviewInput {
  requestId: string;
  viewerSide: PreviewViewerSide;
  /** The plain download, for types the viewer cannot show and for the viewer's own Download. */
  onDownload: (fileId: string) => void;
}

export interface UseRequestFilePreviewResult {
  preview: (file: PreviewTarget, surface: RequestFilePreviewSurface) => void;
  /** The file whose URL is being minted — the row's busy state covers the wait. */
  previewingId: string | null;
  /** Mount once, anywhere. Renders nothing until a preview opens. */
  viewer: React.JSX.Element | null;
}

/**
 * In-app preview for request files. Images and PDFs open in `FileViewerDialog`; anything else
 * falls through to a download. The URL is minted FIRST and the dialog mounted second, so the
 * viewer never holds a null URL. A preview authorizes exactly like a download (the action runs
 * the same gate), so a revoked or deleted file cannot be previewed.
 *
 * On iOS and Android a PDF opens in a new tab instead of the viewer. Mobile browsers block a
 * window opened after an await, so the tab is created synchronously inside the click, detached
 * from this page (`opener = null`), and pointed at the URL once it is minted.
 */
export function useRequestFilePreview(
  input: UseRequestFilePreviewInput
): UseRequestFilePreviewResult {
  const { requestId, viewerSide, onDownload } = input;
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState | null>(null);

  const runPreview = useCallback(
    async (
      file: PreviewTarget,
      kind: 'image' | 'pdf',
      surface: RequestFilePreviewSurface,
      tab: Window | null
    ): Promise<void> => {
      setPreviewingId(file.id);
      try {
        const result = await getRequestFileDownloadAction({
          requestId,
          fileId: file.id,
          purpose: 'preview',
        });
        if (!result.success) {
          tab?.close();
          toast.error(result.error);
          return;
        }
        track(REQUEST_FILE_EVENTS.PREVIEWED, { kind, surface, lens: viewerSide });
        if (tab === null) {
          setViewerState({ kind, fileId: file.id, fileName: file.fileName, url: result.url });
        } else {
          tab.location.href = result.url;
        }
      } catch (error) {
        tab?.close();
        Sentry.captureException(error);
        toast.error(PREVIEW_FAILED_COPY);
      } finally {
        setPreviewingId(null);
      }
    },
    [requestId, viewerSide]
  );

  const preview = useCallback(
    (file: PreviewTarget, surface: RequestFilePreviewSurface): void => {
      const kind = previewKindOf(file.contentType);
      if (kind === null) {
        onDownload(file.id);
        return;
      }
      const tab = kind === 'pdf' && opensPdfInNewTab() ? globalThis.open('', '_blank') : null;
      if (tab !== null) tab.opener = null;
      runPreview(file, kind, surface, tab).catch((error: unknown) => {
        Sentry.captureException(error);
      });
    },
    [onDownload, runPreview]
  );

  const handleOpenChange = useCallback((open: boolean): void => {
    if (!open) setViewerState(null);
  }, []);

  const handleViewerDownload = useCallback((): void => {
    if (viewerState !== null) onDownload(viewerState.fileId);
  }, [viewerState, onDownload]);

  const viewer =
    viewerState === null ? null : (
      <FileViewerDialog
        open
        onOpenChange={handleOpenChange}
        kind={viewerState.kind}
        fileName={viewerState.fileName}
        url={viewerState.url}
        onDownload={handleViewerDownload}
      />
    );

  return { preview, previewingId, viewer };
}
