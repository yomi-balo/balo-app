'use client';

import { useEffect, useState } from 'react';
import { Download, ImageOff, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * In-app image viewer for an exchanged conversation file.
 *
 * ⚠ An `<img>` fetches a SUBRESOURCE, which ignores `Content-Disposition` — so this renders
 * from the existing presigned URL with its `attachment` header untouched, and no storage change
 * is needed. Images only: a PDF would need the header flipped to `inline`, which is a
 * security-bearing change because the presigned PUT does not sign `content-type`.
 *
 * ⚠ Mobile full-screen takeover follows `RecordingPlayerDialog`: a bottom Sheet would crop the
 * one piece of content this surface exists to show.
 */
export function FileViewerDialog({
  open,
  onOpenChange,
  fileName,
  url,
  onDownload,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  /** `null` while the presigned URL is still being minted — the viewer shows its loading state. */
  url: string | null;
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
      <DialogContent className="h-dvh w-screen max-w-none gap-3 rounded-none p-4 sm:h-auto sm:max-w-3xl sm:rounded-2xl sm:p-6">
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
                <output className="text-muted-foreground absolute inset-0 flex items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
                  <span className="sr-only">Loading preview…</span>
                </output>
              )}
              {url !== null && (
                /*
                 * ⚠ Plain `<img>`, never `next/image`: the source is a short-lived presigned URL
                 * on a third-party host, and the optimizer would cache private bytes under a
                 * key whose signature expires.
                 */
                // eslint-disable-next-line @next/next/no-img-element
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
              )}
            </>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onDownload} disabled={url === null}>
            <Download className="h-4 w-4" aria-hidden="true" /> Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
