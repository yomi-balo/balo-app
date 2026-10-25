'use client';

import { useEffect, useState } from 'react';
import { Download, ExternalLink, ImageOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * In-app viewer for an exchanged file: an image (`kind="image"`, the default) or a PDF
 * (`kind="pdf"`).
 *
 * ⚠ An `<img>` fetches a SUBRESOURCE, which ignores `Content-Disposition` — so an image renders
 * from the existing presigned URL with its `attachment` header untouched, and no storage change
 * is needed.
 *
 * ⚠⚠ A PDF IS A DOCUMENT, so an `<iframe>` honours the header and `attachment` would download it
 * instead. A `kind="pdf"` caller must therefore pass a URL minted by the PREVIEW presign, which
 * signs BOTH `inline` and a forced `application/pdf` content type (the PUT does not sign
 * `content-type`, so the stored type is never trusted). Only request files have that presign; the
 * conversation-file callers stay on images.
 *
 * ⚠ Mobile full-screen takeover follows `RecordingPlayerDialog`: a bottom Sheet would crop the
 * one piece of content this surface exists to show.
 *
 * ⚠⚠ `url` IS NON-NULLABLE, AND THAT IS THE CONTRACT: callers mint the presigned URL first and
 * mount this second, with the row's own busy spinner covering the mint. It makes two states
 * unrepresentable — a refused mint that leaves a modal spinner up for ever, and a dismissal
 * during the mint that a late success re-opens.
 */
export function FileViewerDialog({
  open,
  onOpenChange,
  kind = 'image',
  fileName,
  url,
  onDownload,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind?: 'image' | 'pdf';
  fileName: string;
  url: string;
  onDownload: () => void;
}>): React.JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  /**
   * ⚠ Keyed on the URL, not `open`: clicking straight from one image to another keeps `open`
   * true throughout, so an `[open]` reset would never fire and the new image would inherit the
   * previous one's settled state.
   */
  useEffect(() => {
    setStatus('loading');
  }, [url]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-dvh w-screen max-w-none gap-3 rounded-none p-4 sm:h-auto sm:max-w-3xl sm:rounded-xl sm:p-6">
        <DialogHeader>
          {/* `break-all`: file names are user-supplied and arrive without spaces often enough
              that a long one would otherwise push the close button off a 375px viewport. */}
          <DialogTitle className="pr-6 text-base break-all">{fileName}</DialogTitle>
          <DialogDescription className="sr-only">
            Preview of {fileName}. Use Download to save a copy.
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted/40 relative flex min-h-[220px] items-center justify-center overflow-hidden rounded-lg sm:min-h-[320px]">
          {status === 'failed' ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <ImageOff className="text-muted-foreground h-6 w-6" aria-hidden="true" />
              <p className="text-muted-foreground max-w-[280px] text-sm leading-relaxed">
                This preview couldn&apos;t be loaded. You can still download the file.
              </p>
            </div>
          ) : (
            <>
              {status === 'loading' && (
                /* A skeleton in the image's own footprint, not a spinner — the house rule, and
                   the honest shape here: the bytes are on their way and will land in this box. */
                <output
                  className="bg-muted absolute inset-0 animate-pulse motion-reduce:animate-none"
                  aria-live="polite"
                >
                  <span className="sr-only">Loading preview…</span>
                </output>
              )}
              {kind === 'pdf' ? (
                <iframe
                  key={url}
                  src={url}
                  title={fileName}
                  onLoad={() => setStatus('ready')}
                  className={`h-[60vh] w-full transition-opacity duration-200 ${
                    status === 'ready' ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              ) : (
                <>
                  {/*
                   * ⚠ Plain `<img>`, never `next/image`: the source is a short-lived presigned URL
                   * on a third-party host, and the optimizer would cache private bytes under a
                   * key whose signature expires.
                   */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={url}
                    src={url}
                    alt={fileName}
                    onLoad={() => setStatus('ready')}
                    onError={() => setStatus('failed')}
                    className={`max-h-[60vh] w-auto max-w-full object-contain transition-opacity duration-200 ${
                      status === 'ready' ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                </>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {kind === 'pdf' && (
            <Button asChild variant="outline" className="min-h-11">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open in new tab
              </a>
            </Button>
          )}
          <Button variant="outline" className="min-h-11" onClick={onDownload}>
            <Download className="h-4 w-4" aria-hidden="true" /> Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
