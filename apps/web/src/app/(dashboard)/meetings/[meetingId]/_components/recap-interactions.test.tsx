import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { RecapFileRowView, RecapResolveView } from '@/lib/meetings/recap-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}));

const mockResolveCase = vi.fn();
vi.mock('../_actions/resolve-case', () => ({
  resolveCaseAction: (...a: unknown[]) => mockResolveCase(...a),
}));

const mockDismiss = vi.fn();
vi.mock('../_actions/dismiss-resolution-request', () => ({
  dismissResolutionRequestAction: (...a: unknown[]) => mockDismiss(...a),
}));

const mockDownload = vi.fn();
vi.mock('../_actions/get-meeting-file-download', () => ({
  getMeetingFileDownloadAction: (...a: unknown[]) => mockDownload(...a),
}));

import { SummarySection } from './summary-section';
import { TranscriptSection } from './transcript-section';
import { FilesCard } from './files-card';
import { WrapUpCard } from './wrap-up-card';
import { ResolvePromptBanner } from './resolve-prompt-banner';
import { ResolveDismissalProvider, UnlessDismissed } from './resolve-dismissal';
import { NotHeldPanel } from './not-held-panel';
import { RecapStatusChip } from './recap-status-chip';
import { LocalDateTime } from './local-date-time';

const OFFERED: RecapResolveView = {
  engagementId: 'e1',
  variant: 'offered',
  requesterLabel: null,
  expertShortName: 'Amara',
  resolved: null,
  reviewWillBeAsked: true,
};

const REQUESTED: RecapResolveView = {
  engagementId: 'e1',
  variant: 'requested',
  requesterLabel: 'Amara @ CloudPeak',
  expertShortName: 'Amara',
  resolved: null,
  reviewWillBeAsked: true,
};

/** The case is CLOSED: the rail card stays and states the outcome in place. */
const RESOLVED: RecapResolveView = {
  engagementId: 'e1',
  variant: 'none',
  requesterLabel: null,
  expertShortName: 'Amara',
  resolved: { reviewLinkSent: true },
  reviewWillBeAsked: true,
};

/**
 * The R4 banner AS COMPOSED: provider above, `UnlessDismissed` around the slot. The banner
 * keeps NO dismissal state of its own — the answer lives above BOTH prompts so that clearing
 * the request columns server-side cannot resurface the R9 card in the same session.
 */
function renderBanner(resolve: RecapResolveView): void {
  render(
    <ResolveDismissalProvider>
      <UnlessDismissed>
        <ResolvePromptBanner meetingId={MEETING_ID} resolve={resolve} />
      </UnlessDismissed>
    </ResolveDismissalProvider>
  );
}

const FILE: RecapFileRowView = {
  file: {
    id: 'f1',
    meetingId: MEETING_ID,
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    party: 'expert',
    source: 'files_tab',
    uploadedByUserId: 'u-expert',
    createdAtIso: '2026-07-29T05:00:00.000Z',
  },
  uploaderLabel: 'Amara',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SummarySection', () => {
  const ready = {
    summary: { state: 'ready' as const, content: 'We agreed to rebuild the flow.' },
    transcript: { state: 'ready' as const, content: 'Amara: hello.' },
    collapsed: false,
  };

  it('renders the summary and toggles between clamped and full', async () => {
    const user = userEvent.setup();
    render(<SummarySection artifacts={ready} />);
    expect(screen.getByText(/We agreed to rebuild the flow./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Read full summary/ }));
    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Show less/ }));
    expect(screen.getByRole('button', { name: /Read full summary/ })).toBeInTheDocument();
  });

  it('renders the PROCESSING skeleton with a live-region label', () => {
    render(
      <SummarySection
        artifacts={{
          summary: { state: 'processing', content: null },
          transcript: { state: 'processing', content: null },
          collapsed: false,
        }}
      />
    );
    expect(screen.getByRole('status', { name: /Writing up the consultation/ })).toBeInTheDocument();
    expect(screen.getByText(/Everything else on this page is ready now/)).toBeInTheDocument();
  });

  it('renders ONE collapsed card when both artefacts are absent', () => {
    render(
      <SummarySection
        artifacts={{
          summary: { state: 'absent', content: null },
          transcript: { state: 'absent', content: null },
          collapsed: true,
        }}
      />
    );
    expect(screen.getByText(/wasn.t written up/)).toBeInTheDocument();
    expect(screen.getByText(/action items and files are still here/)).toBeInTheDocument();
  });

  it('renders the FAILED copy without blaming anyone or offering a dead retry', () => {
    render(
      <SummarySection
        artifacts={{
          summary: { state: 'failed', content: null },
          transcript: { state: 'failed', content: null },
          collapsed: true,
        }}
      />
    );
    expect(screen.getByText(/couldn.t write this one up/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('renders the summary-only absent branch when the transcript IS ready', () => {
    render(
      <SummarySection
        artifacts={{
          summary: { state: 'absent', content: null },
          transcript: { state: 'ready', content: 'Amara: hello.' },
          collapsed: false,
        }}
      />
    );
    expect(screen.getByText(/the transcript below has the detail/)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<SummarySection artifacts={ready} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('TranscriptSection', () => {
  const ready = { state: 'ready' as const, content: 'Amara: hello there.' };

  it('fires recap_transcript_opened exactly once when expanded', async () => {
    const user = userEvent.setup();
    render(<TranscriptSection meetingId={MEETING_ID} transcript={ready} />);
    await user.click(screen.getByRole('button', { name: /View full transcript/ }));
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.TRANSCRIPT_OPENED, { meeting_id: MEETING_ID });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('does not fire the event again when collapsed', async () => {
    const user = userEvent.setup();
    render(<TranscriptSection meetingId={MEETING_ID} transcript={ready} />);
    await user.click(screen.getByRole('button', { name: /View full transcript/ }));
    await user.click(screen.getByRole('button', { name: /Collapse/ }));
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('keeps the privacy note visible', () => {
    render(<TranscriptSection meetingId={MEETING_ID} transcript={ready} />);
    expect(screen.getByText(/verbatim record is retained but not shown/)).toBeInTheDocument();
  });

  it('renders a bare factual line when there is no transcript', () => {
    render(
      <TranscriptSection meetingId={MEETING_ID} transcript={{ state: 'absent', content: null }} />
    );
    expect(screen.getByText(/No transcript for this one./)).toBeInTheDocument();
  });

  it('renders the processing affordance', () => {
    render(
      <TranscriptSection
        meetingId={MEETING_ID}
        transcript={{ state: 'processing', content: null }}
      />
    );
    expect(screen.getByText(/Transcript is being prepared/)).toBeInTheDocument();
  });
});

describe('FilesCard', () => {
  it('keeps the section at zero and states what it is, without inviting an upload', () => {
    render(<FilesCard meetingId={MEETING_ID} files={[]} />);
    expect(screen.getByText(/No files yet/)).toBeInTheDocument();
    // There is NO upload affordance anywhere in apps/web today (BAL-423 shipped the actions
    // with no consumer), so the copy must not ask for one.
    expect(screen.getByText(/shares on this consultation shows up here/)).toBeInTheDocument();
  });

  it('renders NO recording row and no coming-soon placeholder (D-B)', () => {
    const { container } = render(<FilesCard meetingId={MEETING_ID} files={[FILE]} />);
    expect(container.textContent).not.toMatch(/recording/i);
    expect(container.textContent).not.toMatch(/coming soon/i);
  });

  it('labels the uploader by first name and shows a human size', () => {
    render(<FilesCard meetingId={MEETING_ID} files={[FILE]} />);
    expect(screen.getByText(/Amara · 2 KB/)).toBeInTheDocument();
  });

  it('mints a presigned URL and tracks the download', async () => {
    const assign = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      assign,
    } as unknown as Location);
    mockDownload.mockResolvedValue({ success: true, url: 'https://r2.example/signed' });

    const user = userEvent.setup();
    render(<FilesCard meetingId={MEETING_ID} files={[FILE]} />);
    await user.click(screen.getByRole('button', { name: /Download deck.pdf/ }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://r2.example/signed'));
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.FILE_DOWNLOADED, {
      meeting_id: MEETING_ID,
      content_type: 'application/pdf',
    });
  });

  it('toasts the returned copy when the download is refused', async () => {
    mockDownload.mockResolvedValue({ success: false, error: 'That file is no longer available.' });
    const user = userEvent.setup();
    render(<FilesCard meetingId={MEETING_ID} files={[FILE]} />);
    await user.click(screen.getByRole('button', { name: /Download deck.pdf/ }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('That file is no longer available.')
    );
  });

  it('toasts a friendly failure when the action throws', async () => {
    mockDownload.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    render(<FilesCard meetingId={MEETING_ID} files={[FILE]} />);
    await user.click(screen.getByRole('button', { name: /Download deck.pdf/ }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<FilesCard meetingId={MEETING_ID} files={[FILE]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('WrapUpCard + ResolveDialog', () => {
  it('renders nothing at all for a variant that is not its own', () => {
    const { container } = render(
      <WrapUpCard meetingId={MEETING_ID} resolve={{ ...OFFERED, variant: 'requested' }} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers, rather than chases — an outline CTA plus a no-pressure line', () => {
    render(<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />);
    expect(screen.getByRole('button', { name: /Mark resolved/ })).toBeInTheDocument();
    expect(screen.getByText(/the case stays open/)).toBeInTheDocument();
  });

  it('states EXACTLY the four facts in the dialog, and names the expert', async () => {
    const user = userEvent.setup();
    render(<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />);
    await user.click(screen.getByRole('button', { name: /Mark resolved/ }));

    expect(screen.getByRole('heading', { name: /Mark this case resolved/ })).toBeInTheDocument();
    expect(screen.getByText(/closes the case for both of you/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be reopened/)).toBeInTheDocument();
    expect(screen.getByText(/start a new case with Amara/)).toBeInTheDocument();
    expect(screen.getByText(/completely optional/)).toBeInTheDocument();
  });

  it('DROPS the review-link fact for a client who has already rated this expert', async () => {
    const user = userEvent.setup();
    render(
      <WrapUpCard meetingId={MEETING_ID} resolve={{ ...OFFERED, reviewWillBeAsked: false }} />
    );
    await user.click(screen.getByRole('button', { name: /Mark resolved/ }));

    // `resolveReviewAsk` mints no token in this case, so promising the email would be untrue.
    expect(screen.getByText(/closes the case for both of you/)).toBeInTheDocument();
    expect(screen.queryByText(/completely optional/)).not.toBeInTheDocument();
  });

  it('CANNOT be dismissed with Escape while the irreversible mutation is in flight', async () => {
    let settle: (value: { success: boolean }) => void = () => {};
    mockResolveCase.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        settle = resolve;
      })
    );
    const user = userEvent.setup();
    render(<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />);
    await user.click(screen.getByRole('button', { name: /Mark resolved/ }));
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));

    await user.keyboard('{Escape}');

    // A dialog that vanishes on Escape tells the user they cancelled a close that still happens.
    expect(screen.getByRole('heading', { name: /Mark this case resolved/ })).toBeInTheDocument();
    settle({ success: true });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it('toasts and refreshes on a successful resolve', async () => {
    mockResolveCase.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />);
    await user.click(screen.getByRole('button', { name: /Mark resolved/ }));
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Case resolved — nice work.')
    );
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CTA_CLICKED, {
      cta: 'case_resolved',
      lens: 'client',
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('toasts the returned copy verbatim on a refused resolve', async () => {
    mockResolveCase.mockResolvedValue({ success: false, error: 'This case is already resolved.' });
    const user = userEvent.setup();
    render(<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />);
    await user.click(screen.getByRole('button', { name: /Mark resolved/ }));
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('This case is already resolved.')
    );
  });

  it('closes the dialog on Not yet, without mutating anything', async () => {
    const user = userEvent.setup();
    render(<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />);
    await user.click(screen.getByRole('button', { name: /Mark resolved/ }));
    await user.click(screen.getByRole('button', { name: /Not yet/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: /Mark this case resolved/ })
      ).not.toBeInTheDocument()
    );
    expect(mockResolveCase).not.toHaveBeenCalled();
  });
});

describe('WrapUpCard - the post-resolve success state', () => {
  it('STAYS IN PLACE once the case is closed and confirms the review email', () => {
    render(<WrapUpCard meetingId={MEETING_ID} resolve={RESOLVED} />);
    expect(screen.getByText(/Resolved/)).toBeInTheDocument();
    expect(screen.getByText(/Everything from this case stays here/)).toBeInTheDocument();
    expect(screen.getByText(/short review link for/)).toBeInTheDocument();
    // The offer is GONE - the page never asks a question it has already had answered.
    expect(screen.queryByRole('button', { name: /Mark resolved/ })).not.toBeInTheDocument();
  });

  it('omits the review line when no link was sent (already rated, or an auto-close)', () => {
    render(
      <WrapUpCard
        meetingId={MEETING_ID}
        resolve={{ ...RESOLVED, resolved: { reviewLinkSent: false } }}
      />
    );
    expect(screen.getByText(/Everything from this case stays here/)).toBeInTheDocument();
    expect(screen.queryByText(/short review link/)).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<WrapUpCard meetingId={MEETING_ID} resolve={RESOLVED} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ResolvePromptBanner', () => {
  it('renders nothing for a variant that is not its own', () => {
    const { container } = render(<ResolvePromptBanner meetingId={MEETING_ID} resolve={OFFERED} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('attributes the ask to the person @ agency on first mention', () => {
    render(<ResolvePromptBanner meetingId={MEETING_ID} resolve={REQUESTED} />);
    expect(screen.getByText(/Amara @ CloudPeak thinks this one is sorted/)).toBeInTheDocument();
  });

  it('renders a neutral headline when nobody could be attributed', () => {
    render(
      <ResolvePromptBanner
        meetingId={MEETING_ID}
        resolve={{ ...REQUESTED, requesterLabel: null }}
      />
    );
    expect(screen.getByText(/This one looks sorted/)).toBeInTheDocument();
  });

  it('dismisses via a SERVER mutation and stops asking', async () => {
    mockDismiss.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderBanner(REQUESTED);
    await user.click(screen.getByRole('button', { name: /Not yet/ }));

    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ meetingId: MEETING_ID }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/thinks this one is sorted/)).not.toBeInTheDocument()
    );
  });

  it('dismisses from the X control too', async () => {
    mockDismiss.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderBanner(REQUESTED);
    await user.click(screen.getByRole('button', { name: /Dismiss this request/ }));
    await waitFor(() =>
      expect(screen.queryByText(/thinks this one is sorted/)).not.toBeInTheDocument()
    );
    await waitFor(() => expect(mockDismiss).toHaveBeenCalled());
  });

  it('toasts the returned copy and KEEPS the banner when the dismissal is refused', async () => {
    mockDismiss.mockResolvedValue({ success: false, error: 'This case is no longer open.' });
    const user = userEvent.setup();
    renderBanner(REQUESTED);
    await user.click(screen.getByRole('button', { name: /Not yet/ }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('This case is no longer open.')
    );
    expect(screen.getByText(/thinks this one is sorted/)).toBeInTheDocument();
  });

  it('toasts a friendly failure when the action throws, and KEEPS the banner', async () => {
    mockDismiss.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    renderBanner(REQUESTED);
    await user.click(screen.getByRole('button', { name: /Not yet/ }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    // A throw is NOT an answer: the question stays on the page rather than vanishing silently.
    expect(screen.getByText(/thinks this one is sorted/)).toBeInTheDocument();
  });

  it('dismisses safely with NO provider above it — the default context is a no-op', async () => {
    mockDismiss.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<ResolvePromptBanner meetingId={MEETING_ID} resolve={REQUESTED} />);
    await user.click(screen.getByRole('button', { name: /Not yet/ }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    // Nothing above it recorded the answer, so the banner stays: session-level suppression is
    // the COMPOSITION's job (`ResolveDismissalProvider` + `UnlessDismissed`), never this
    // component's own state. Rendering it bare must still be safe.
    expect(screen.getByText(/thinks this one is sorted/)).toBeInTheDocument();
  });

  it('opens the SAME dialog as the rail card', async () => {
    const user = userEvent.setup();
    render(<ResolvePromptBanner meetingId={MEETING_ID} resolve={REQUESTED} />);
    await user.click(screen.getByRole('button', { name: /Yes, mark it resolved/ }));
    expect(screen.getByRole('heading', { name: /Mark this case resolved/ })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ResolvePromptBanner meetingId={MEETING_ID} resolve={REQUESTED} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('NotHeldPanel', () => {
  it('renders the headline and body, and no CTA at all', () => {
    const { container } = render(
      <NotHeldPanel
        notHeld={{
          reason: 'missed_call',
          headline: 'This one did not go ahead',
          body: 'The call did not start.',
        }}
      />
    );
    expect(screen.getByText(/This one did not go ahead/)).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <NotHeldPanel notHeld={{ reason: 'cancelled', headline: 'h', body: 'b' }} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('RecapStatusChip', () => {
  // The previous version asserted only that the label rendered, so it passed for ANY
  // ICONS / TONE_CLASSES mapping - including both records being deleted. These bind.
  it.each([
    ['check', 'success', 'text-success'],
    ['clock', 'warning', 'text-warning'],
    ['ban', 'neutral', 'text-muted-foreground'],
    ['circle-check', 'success', 'text-success'],
  ] as const)('renders the %s icon with the %s tone', (icon, tone, toneClass) => {
    const { container } = render(<RecapStatusChip status={{ label: 'Chip', tone, icon }} />);
    const badge = screen.getByText('Chip');
    expect(badge.className).toContain(toneClass);
    // lucide renders an <svg>; an absent ICONS entry would render nothing at all.
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('maps each of the four icon names to a DISTINCT glyph', () => {
    const paths = (['check', 'clock', 'ban', 'circle-check'] as const).map((icon) => {
      const { container, unmount } = render(
        <RecapStatusChip status={{ label: 'Chip', tone: 'neutral', icon }} />
      );
      const markup = container.querySelector('svg')?.innerHTML ?? '';
      unmount();
      return markup;
    });
    expect(new Set(paths).size).toBe(4);
  });
});

describe('LocalDateTime', () => {
  it('renders an ABSOLUTE machine-readable time, never a relative one', async () => {
    render(<LocalDateTime iso="2026-07-29T04:14:00.000Z" />);
    const el = await screen.findByText(/2026/);
    expect(el.tagName.toLowerCase()).toBe('time');
    expect(el).toHaveAttribute('dateTime', '2026-07-29T04:14:00.000Z');
    expect(el.textContent).not.toMatch(/ago/);
  });
});
