'use client';

import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { track, HELP_EVENTS } from '@/lib/analytics';
import { HELP_CAPTURE_DPR, type HelpImage } from '@/lib/help/types';

interface ScreenshotZoomProps {
  slug: string;
  image: HelpImage;
  /** The server-rendered thumbnail twins, wrapped unchanged by the trigger. */
  children: ReactNode;
}

/** The capture's CSS width: the thumbnail's widest size, and the enlarged view's narrowest. */
function captureWidth(image: HelpImage): string {
  return `${image.width / HELP_CAPTURE_DPR}px`;
}

/**
 * Widths of the enlarged image, as CSS lengths the class list reads through custom properties.
 * Neither exceeds `image.width`, the file's pixel width, so the enlarged view is never upscaled
 * past the PNG's natural pixels; the DPR-2 capture is what keeps it sharp at twice the thumbnail.
 * Phones fit the image to the screen width and readers pinch-zoom for detail. From `sm` up the
 * image fits the viewport but is never narrower than the capture, so a tall capture opens at least
 * at thumbnail size and scrolls when it is taller than the viewport. The fit repeats the `sm:`
 * classes on `DialogContent`, so change them together:
 * - 4rem of side room: the panel's 1.5rem of side padding (`sm:p-3`) and 2px of border, plus a
 *   gutter of about 1.2rem each side, and any notch inset.
 * - 6.5rem of height: the 2rem viewport margin (`sm:max-h-[calc(100dvh-2rem)]`), the 3rem close
 *   strip (`sm:pt-12`), the 0.75rem bottom padding (`sm:p-3`) and the dialog and image borders
 *   (4px), about 6rem, plus 0.5rem of slack so a rounding remainder never makes a fitted image
 *   scroll.
 */
function zoomWidths(image: HelpImage): CSSProperties {
  const natural = `${image.width}px`;
  const capture = captureWidth(image);
  const ratio = image.width / image.height;
  const sideRoom = 'calc(100vw - 4rem - env(safe-area-inset-left) - env(safe-area-inset-right))';
  return {
    '--zoom-w': `min(${natural}, 100%)`,
    '--zoom-w-sm': `min(${natural}, ${sideRoom}, max(${capture}, calc((100dvh - 6.5rem) * ${ratio})))`,
  } as CSSProperties;
}

/**
 * Makes a guide screenshot open an enlarged view. The thumbnail stays server-rendered and arrives
 * as `children`; only the trigger and the dialog are client code. The dialog repeats the
 * light/dark twin classes rather than reading the theme in JS, so it can never flash the wrong
 * capture. On phones the dialog takes the whole screen, inside the safe-area insets, and the image
 * scrolls; Radix's scroll lock allows pinch-zoom, so native zoom still works. Opening focuses the
 * panel rather than the first control, so a mouse or tap open draws no focus ring. The image's
 * region becomes a labelled tab stop only while it overflows, so keyboard users can scroll a tall
 * capture and never land on a stop with nothing to scroll; it is measured on open and on resize.
 */
export function ScreenshotZoom({
  slug,
  image,
  children,
}: Readonly<ScreenshotZoomProps>): React.JSX.Element {
  const zoomStyle = zoomWidths(image);
  const [scrollable, setScrollable] = useState(false);
  const measureRegion = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = (): void => {
      setScrollable(node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) track(HELP_EVENTS.SCREENSHOT_ENLARGED, { slug, image: image.lightSrc });
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Enlarge screenshot: ${image.alt}`}
          style={{ maxWidth: captureWidth(image) }}
          className="focus-visible:ring-ring focus-visible:ring-offset-mist flex w-full cursor-zoom-in flex-col rounded-[10px] transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none"
        >
          {children}
        </button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 pt-[calc(3rem+env(safe-area-inset-top))] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none sm:top-[50%] sm:left-[50%] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-auto sm:max-w-none sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-[14px] sm:border sm:p-3 sm:pt-12"
      >
        <DialogTitle className="sr-only">{image.alt}</DialogTitle>
        <DialogClose asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-[calc(0.125rem+env(safe-area-inset-top))] right-[calc(0.125rem+env(safe-area-inset-right))] inline-flex size-11 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none sm:top-0.5 sm:right-0.5"
          >
            <XIcon className="size-5" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </button>
        </DialogClose>
        <div
          ref={measureRegion}
          {...(scrollable && {
            tabIndex: 0,
            role: 'region',
            'aria-label': 'Scrollable screenshot',
          })}
          className="focus-visible:outline-ring flex min-h-0 flex-1 overflow-auto p-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid sm:p-0"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed, pre-optimised PNG; see HelpScreenshot */}
          <img
            src={image.lightSrc}
            alt={image.alt}
            width={image.width}
            height={image.height}
            style={zoomStyle}
            loading="lazy"
            decoding="async"
            className="border-line m-auto h-auto w-(--zoom-w) max-w-none shrink-0 rounded-[10px] border sm:w-(--zoom-w-sm) dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- fixed, pre-optimised PNG; see HelpScreenshot */}
          <img
            src={image.darkSrc}
            alt={image.alt}
            width={image.width}
            height={image.height}
            style={zoomStyle}
            loading="lazy"
            decoding="async"
            className="border-line m-auto hidden h-auto w-(--zoom-w) max-w-none shrink-0 rounded-[10px] border sm:w-(--zoom-w-sm) dark:block"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
