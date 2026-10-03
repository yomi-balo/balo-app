'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ProjectRequestPanel } from '@/components/balo/project-request/panel';
import type { CaseSurfaceView } from '@/lib/cases/case-view-types';

/**
 * BAL-589 — the case header's "Convert to project" action (design reference
 * `project-request-entry-modes.jsx:972-986`).
 *
 * ⚠ CLIENT LENS ONLY, AND OFFERED ON BOTH OPEN AND CLOSED CASES (D2/D3). `case-surface.tsx`
 * mounts this component only when `view.lens === 'client'` — a RENDER HINT, never
 * authorization: every server action the mounted panel reaches re-authorizes independently
 * through `authorizeClientCaseMutation` (ruling 3). The case itself is never mutated by
 * opening this panel or by submitting from it (D1).
 *
 * Mounts `ProjectRequestPanel` bound to the case's own expert: `entryPoint: 'case'` gives it
 * its own draft key and opens it straight at `manual` (D4), prefilled from the case's title
 * and live products and offering the case's files (`sourceCase`).
 *
 * ⚠⚠ `expert.availableForWork` IS `projectConversion.expertAvailableForWork` — THE REAL
 * `findNewWorkEligibility` GATE the loader resolved (D10). NEVER the
 * `availableForWork: true` hardcode `CasePartyCard` builds for its own `BookingFlowExpert`
 * quick-pick fixture; that one has no equivalent read and answers a different question.
 */
export function ConvertToProject({
  view,
}: Readonly<{
  view: Extract<CaseSurfaceView, { lens: 'client' }>;
}>): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const onOpen = useCallback(() => {
    setOpen(true);
  }, []);

  const onClose = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <>
      <Button type="button" onClick={onOpen}>
        Convert to project
      </Button>
      <ProjectRequestPanel
        open={open}
        onClose={onClose}
        entryPoint="case"
        expertProfileId={view.expertProfileId}
        expert={{
          name: view.party.name,
          firstName: view.conversation.counterpartyFirstName,
          initials: view.party.initials,
          avatarKey: view.party.avatarUrl,
          headline: null,
          availableForWork: view.projectConversion.expertAvailableForWork,
        }}
        sourceCase={{
          id: view.engagementId,
          title: view.header.title,
          productIds: view.projectConversion.productIds,
          files: view.files,
        }}
      />
    </>
  );
}
