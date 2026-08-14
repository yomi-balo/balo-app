'use client';

import { useCallback, useEffect, useState } from 'react';
import { LayoutGrid, Maximize2, Minimize2 } from 'lucide-react';
import { MeetingToolbarButton } from './meeting-toolbar-button';

/**
 * BAL-435 — the stage's top-right ViewControls. **Desktop only.**
 *
 * ⚠⚠ `fullscreenchange` IS THE SINGLE SOURCE OF TRUTH, AND THAT IS A FIX TO THE PROTOTYPE.
 * The prototype keeps a `keydown Escape` listener flipping its OWN boolean independently of the
 * browser, plus a `position: fixed` fallback that can desync from real fullscreen — so pressing
 * Esc, or exiting fullscreen from the browser's own chrome, left the UI claiming the opposite of
 * what the window was doing.
 *
 * Here the icon renders from `document.fullscreenElement === frameElement`, held in state and
 * updated ONLY by the event. **The Esc keydown listener is DELETED** — Esc is handled natively
 * for free, and `view-controls.test.tsx` asserts no `keydown` listener is registered.
 *
 * ⚠ `globalThis.document`, never a bare `window` (SonarCloud S7764).
 *
 * ⚠ HIDDEN BELOW `lg` IN CSS, and additionally NOT RENDERED AT ALL where `fullscreenEnabled` is
 * false — iOS Safari exposes no Fullscreen API on non-video elements, so the button would be a
 * lie rather than merely useless.
 */

/** ⚠ Narrowed with `in` checks, never `any`: Safari's names are prefixed. */
interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}
interface WebkitFullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}

function currentFullscreenElement(): Element | null {
  const doc: WebkitFullscreenDocument = globalThis.document;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function fullscreenSupported(): boolean {
  if (globalThis.window === undefined) return false;
  const doc: WebkitFullscreenDocument = globalThis.document;
  return doc.fullscreenEnabled === true || 'webkitExitFullscreen' in doc;
}

export interface ViewControlsProps {
  /** The element that goes fullscreen. `null` before the frame mounts. */
  readonly frameElement: HTMLElement | null;
  /** ⚠ Hidden while a screen share or PreJoin is up — there is no layout to toggle. */
  readonly showLayoutToggle: boolean;
  readonly isGallery: boolean;
  readonly onToggleLayout: () => void;
}

export function ViewControls({
  frameElement,
  showLayoutToggle,
  isGallery,
  onToggleLayout,
}: Readonly<ViewControlsProps>): React.JSX.Element | null {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);

  useEffect(() => {
    setCanFullscreen(fullscreenSupported());
  }, []);

  useEffect(() => {
    const sync = (): void => {
      setIsFullscreen(frameElement !== null && currentFullscreenElement() === frameElement);
    };
    sync();
    const doc = globalThis.document;
    doc.addEventListener('fullscreenchange', sync);
    // ⚠ SAFARI'S PREFIXED EVENT TOO — without it the icon sticks on macOS Safari.
    doc.addEventListener('webkitfullscreenchange', sync);
    return () => {
      doc.removeEventListener('fullscreenchange', sync);
      doc.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [frameElement]);

  const toggleFullscreen = useCallback((): void => {
    const doc: WebkitFullscreenDocument = globalThis.document;
    if (currentFullscreenElement() !== null) {
      if (typeof doc.exitFullscreen === 'function') {
        // ⚠ NOT `void`-PREFIXED (SonarCloud S3735) and not awaited — a rejected exit means the
        // browser is already out of fullscreen, which `fullscreenchange` will tell us anyway.
        doc.exitFullscreen().catch(() => {});
        return;
      }
      doc.webkitExitFullscreen?.();
      return;
    }
    const element: WebkitFullscreenElement | null = frameElement;
    if (element === null) return;
    if (typeof element.requestFullscreen === 'function') {
      element.requestFullscreen().catch(() => {});
      return;
    }
    element.webkitRequestFullscreen?.();
  }, [frameElement]);

  if (!showLayoutToggle && !canFullscreen) return null;

  return (
    // ⚠ CSS-ONLY VISIBILITY (`hidden lg:flex`) — a JS breakpoint would flash on first paint.
    <div className="absolute top-3 right-3 z-[15] hidden items-center gap-2 lg:flex">
      {showLayoutToggle ? (
        <MeetingToolbarButton
          icon={LayoutGrid}
          label={isGallery ? 'Speaker view' : 'Gallery view'}
          size="stage"
          state={isGallery ? 'active' : 'default'}
          pressed={isGallery}
          onClick={onToggleLayout}
          className="border-transparent bg-black/50 text-white"
        />
      ) : null}
      {canFullscreen ? (
        <MeetingToolbarButton
          icon={isFullscreen ? Minimize2 : Maximize2}
          label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          size="stage"
          pressed={isFullscreen}
          onClick={toggleFullscreen}
          className="border-transparent bg-black/50 text-white"
        />
      ) : null}
    </div>
  );
}
