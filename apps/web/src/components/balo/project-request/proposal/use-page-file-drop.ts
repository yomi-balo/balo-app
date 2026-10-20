'use client';

import { useEffect, useRef, useState } from 'react';

interface UsePageFileDropArgs {
  /** Listeners are attached only while true. */
  enabled: boolean;
  onFiles: (files: File[]) => void;
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Page-wide file drop. Reacts only to drags that carry files; a depth counter keeps
 * `dragActive` steady while the pointer crosses child elements. A drop is consumed
 * (the browser never navigates to the file) and its files go to `onFiles`.
 */
export function usePageFileDrop({ enabled, onFiles }: Readonly<UsePageFileDropArgs>): {
  dragActive: boolean;
} {
  const [dragActive, setDragActive] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    let depth = 0;

    const handleEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragActive(true);
    };
    const handleOver = (event: DragEvent): void => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const handleLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const handleDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };

    globalThis.addEventListener('dragenter', handleEnter);
    globalThis.addEventListener('dragover', handleOver);
    globalThis.addEventListener('dragleave', handleLeave);
    globalThis.addEventListener('drop', handleDrop);
    return () => {
      globalThis.removeEventListener('dragenter', handleEnter);
      globalThis.removeEventListener('dragover', handleOver);
      globalThis.removeEventListener('dragleave', handleLeave);
      globalThis.removeEventListener('drop', handleDrop);
      setDragActive(false);
    };
  }, [enabled]);

  return { dragActive };
}
