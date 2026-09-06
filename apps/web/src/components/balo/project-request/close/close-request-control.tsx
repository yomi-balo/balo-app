'use client';

import { useState } from 'react';
import { XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CloseRequestSheet, type CloseSheetTrack } from './close-request-sheet';

/**
 * CloseRequestControl — BAL-540 Phase 6.2 (design ref `RequestHeader`, `:1420-1424`): a ghost
 * `Button` with `XCircle`, rendered in the shell's header when the viewer holds the capability.
 * Thin client wrapper: `RequestDetailShell` is a Server Component, so the sheet's open/close
 * state lives here.
 */

interface CloseRequestControlProps {
  requestId: string;
  requestTitle: string;
  companyName: string;
  variant: 'client' | 'admin';
  liveTracks: readonly CloseSheetTrack[];
}

export function CloseRequestControl({
  requestId,
  requestTitle,
  companyName,
  variant,
  liveTracks,
}: Readonly<CloseRequestControlProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <XCircle className="h-4 w-4" aria-hidden="true" />
        {/* pending-MJ */}
        Close request
      </Button>
      <CloseRequestSheet
        open={open}
        onOpenChange={setOpen}
        requestId={requestId}
        requestTitle={requestTitle}
        companyName={companyName}
        variant={variant}
        liveTracks={liveTracks}
      />
    </>
  );
}
