import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { CaseSurfaceView } from '@/lib/cases/case-view-types';

/**
 * BAL-589 — `ConvertToProject` is a thin integration point: a button that mounts
 * `ProjectRequestPanel` with the case-bound props. The panel itself (routing, the case-brief
 * flow, submission) is `project-request-panel.test.tsx`'s job (WP-H); this suite proves only
 * that THIS component hands it the right props, built from the right fields of `view`.
 *
 * `ProjectRequestPanel` is mocked rather than rendered for real: mounting it for real would
 * re-exercise WP-H's own suite and drag in every `'use server'` action its sub-components
 * import at module load.
 */
const mockPanel = vi.fn();
vi.mock('@/components/balo/project-request/panel', () => ({
  ProjectRequestPanel: (props: Record<string, unknown>) => {
    mockPanel(props);
    return null;
  },
}));

import { ConvertToProject } from './convert-to-project';

function clientView(
  over: Partial<Extract<CaseSurfaceView, { lens: 'client' }>> = {}
): Extract<CaseSurfaceView, { lens: 'client' }> {
  return {
    engagementId: 'e-1',
    expertProfileId: 'expert-1',
    viewerUserId: 'u-1',
    header: {
      title: 'Flow interview loop',
      descriptionHtml: '<p>hi</p>',
      openedAtIso: '2026-06-12T09:00:00Z',
      heldConsultationCount: 1,
      consultationCount: 1,
      isOpen: true,
      closeReason: null,
      closedAtIso: null,
      counterpartyOrgLabel: 'CloudPeak',
      closedNote: null,
    },
    nudge: null,
    consultations: [],
    rescheduleProposals: [],
    conversation: {
      conversationId: 'v-1',
      writable: true,
      counterpartyFirstName: 'Amara',
      counterpartyName: 'Amara Okafor',
      initialMessages: [],
      initialHasEarlier: false,
      initialFiles: [],
      realtimeEnabled: false,
    },
    actionItems: {
      yours: [],
      theirs: [],
      unassigned: [],
      counterpartyLabel: 'Amara',
      totalCount: 0,
      canToggle: false,
    },
    files: [],
    filesTruncated: false,
    party: {
      name: 'Amara Okafor',
      headline: 'Salesforce CPQ specialist',
      orgLabel: 'CloudPeak',
      avatarUrl: 'https://cdn.example.com/amara.png',
      initials: 'AO',
      bookAgainHref: '/experts/amara',
      ratingAverage: 4.3,
      ratingCount: 2,
      availableForWork: true,
    },
    people: [{ name: 'Dana Reyes', isViewer: true }],
    counterpartyPartyLabel: 'CloudPeak Consulting',
    clientCompanyName: 'Northwind Industrial',
    lens: 'client',
    canClose: true,
    caseScopeDomains: [],
    rating: null,
    projectConversion: { productIds: ['prod-1'], expertAvailableForWork: true },
    ...over,
  };
}

describe('ConvertToProject', () => {
  it('renders the button and mounts the panel closed', () => {
    render(<ConvertToProject view={clientView()} />);
    expect(screen.getByRole('button', { name: 'Convert to project' })).toBeInTheDocument();
    expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ open: false }));
  });

  it('opens the panel with entryPoint "case" and the case-bound expert + sourceCase props', async () => {
    const user = userEvent.setup();
    const view = clientView({
      engagementId: 'case-42',
      expertProfileId: 'expert-9',
      header: {
        title: 'Flow interview loop',
        descriptionHtml: '<p>hi</p>',
        openedAtIso: '2026-06-12T09:00:00Z',
        heldConsultationCount: 1,
        consultationCount: 1,
        isOpen: true,
        closeReason: null,
        closedAtIso: null,
        counterpartyOrgLabel: 'CloudPeak',
        closedNote: null,
      },
      files: [
        {
          origin: 'conversation',
          id: 'file-1',
          meetingId: null,
          fileName: 'rfp.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          createdAtIso: '2026-06-12T09:00:00Z',
          uploaderLabel: 'You',
          sourceLabel: 'Conversation',
        },
      ],
      projectConversion: { productIds: ['prod-1', 'prod-2'], expertAvailableForWork: true },
    });

    render(<ConvertToProject view={view} />);
    await user.click(screen.getByRole('button', { name: 'Convert to project' }));

    expect(mockPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        entryPoint: 'case',
        expertProfileId: 'expert-9',
        expert: expect.objectContaining({
          name: 'Amara Okafor',
          firstName: 'Amara',
          initials: 'AO',
          avatarKey: 'https://cdn.example.com/amara.png',
          headline: null,
          availableForWork: true,
        }),
        sourceCase: {
          id: 'case-42',
          title: 'Flow interview loop',
          productIds: ['prod-1', 'prod-2'],
          files: view.files,
        },
      })
    );
  });

  it('closes the panel via onClose, then can reopen it', async () => {
    const user = userEvent.setup();
    render(<ConvertToProject view={clientView()} />);

    await user.click(screen.getByRole('button', { name: 'Convert to project' }));
    expect(mockPanel).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));

    const { onClose } = mockPanel.mock.calls.at(-1)?.[0] as { onClose: () => void };
    act(() => {
      onClose();
    });
    expect(mockPanel).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));

    await user.click(screen.getByRole('button', { name: 'Convert to project' }));
    expect(mockPanel).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
  });

  it('passes availableForWork: false for an ineligible expert, never a hardcoded true', () => {
    render(
      <ConvertToProject
        view={clientView({
          projectConversion: { productIds: [], expertAvailableForWork: false },
        })}
      />
    );
    expect(mockPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        expert: expect.objectContaining({ availableForWork: false }),
      })
    );
  });
});
