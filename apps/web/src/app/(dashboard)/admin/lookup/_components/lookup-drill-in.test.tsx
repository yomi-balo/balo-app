import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { LookupSelection } from '../_lib/lookup-view';
import { LookupDrillIn } from './lookup-drill-in';

const { mockAction, mockTimelineAction } = vi.hoisted(() => ({
  mockAction: vi.fn(),
  mockTimelineAction: vi.fn(),
}));
vi.mock('../_actions/fetch-lookup-money-block', () => ({
  fetchLookupMoneyBlockAction: mockAction,
}));
vi.mock('../_actions/fetch-lookup-timeline', () => ({
  fetchLookupTimelineAction: mockTimelineAction,
}));

beforeEach(() => {
  mockAction.mockClear();
  mockTimelineAction.mockClear();
  // Never resolves by default — most tests here assert on the header/Open-link matrix, not the
  // Timeline section's own fetch lifecycle (covered by lookup-timeline-section.test.tsx), so a
  // pending promise avoids an unrelated post-test state update warning.
  mockTimelineAction.mockReturnValue(new Promise(() => {}));
});

function selection(
  overrides: Partial<LookupSelection> & Pick<LookupSelection, 'type' | 'id'>
): LookupSelection {
  return {
    key: `${overrides.type}:${overrides.id}`,
    title: 'Title',
    sub: 'Sub line',
    publicExpertUsername: null,
    engagementType: null,
    via: 'search',
    ...overrides,
  };
}

describe('LookupDrillIn — the Open-link matrix', () => {
  it('project_request always renders Open, linking to /projects/{id}', () => {
    render(
      <LookupDrillIn
        selection={selection({ type: 'project_request', id: 'r1' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/projects/r1');
  });

  it('a published expert renders Open, linking to /experts/{username}', () => {
    render(
      <LookupDrillIn
        selection={selection({ type: 'expert', id: 'x1', publicExpertUsername: 'priya' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/experts/priya');
  });

  it('an unpublished expert renders no Open link and the not-public copy', () => {
    render(
      <LookupDrillIn selection={selection({ type: 'expert', id: 'x2' })} onTabSelect={vi.fn()} />
    );
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByText(/isn't public yet/i)).toBeInTheDocument();
  });

  it('F12 — an expert opened FROM RECENT renders no Open link, even with a live profile, and says why', () => {
    render(
      <LookupDrillIn
        selection={selection({
          type: 'expert',
          id: 'x1',
          publicExpertUsername: null,
          via: 'recent',
        })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByText(/recent links can go stale/i)).toBeInTheDocument();
  });

  it.each(['user', 'company', 'agency'] as const)(
    '%s renders no Open link and the no-page copy',
    (type) => {
      render(<LookupDrillIn selection={selection({ type, id: 'z1' })} onTabSelect={vi.fn()} />);
      expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
      expect(screen.getByText(/there's no .* page yet/i)).toBeInTheDocument();
    }
  );

  it('credit_session renders no Open link and the receipt-is-client-view copy', () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    render(
      <LookupDrillIn
        selection={selection({ type: 'credit_session', id: 's1' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByText(/the receipt is the client's own view/i)).toBeInTheDocument();
  });

  it('a PROJECT engagement renders Open, linking to /engagements/{id} (BAL-555 C1)', () => {
    render(
      <LookupDrillIn
        selection={selection({ type: 'engagement', id: 'e1', engagementType: 'project' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/engagements/e1');
  });

  it('a CASE engagement renders no Open link and the no-staff-page copy (BAL-555 C1 — no admin lens)', () => {
    render(
      <LookupDrillIn
        selection={selection({ type: 'engagement', id: 'e2', engagementType: 'case' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no staff page for a case/i)).toBeInTheDocument();
  });

  it('mounts the Money section only for credit_session', () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    render(
      <LookupDrillIn
        selection={selection({ type: 'credit_session', id: 's1' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('tab', { name: 'Money' })).toBeInTheDocument();
  });

  it('does not render a Money tab for any other type', () => {
    render(
      <LookupDrillIn selection={selection({ type: 'company', id: 'co1' })} onTabSelect={vi.fn()} />
    );
    expect(screen.queryByRole('tab', { name: 'Money' })).not.toBeInTheDocument();
    expect(mockAction).not.toHaveBeenCalled();
  });

  it('renders no tab or tablist element for a single-tab type (labelled section, not a tab bar)', () => {
    render(
      <LookupDrillIn selection={selection({ type: 'company', id: 'co1' })} onTabSelect={vi.fn()} />
    );
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('renders the type eyebrow and title', () => {
    render(
      <LookupDrillIn
        selection={selection({ type: 'user', id: 'u1', title: 'Dana Whitfield' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
  });
});

describe('LookupDrillIn — the tab shell (C2)', () => {
  it('a credit session renders role="tablist" with exactly two tabs', () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    render(
      <LookupDrillIn
        selection={selection({ type: 'credit_session', id: 's1' })}
        onTabSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('BAL-555 fix round F3 — the visible tabpanel is labelled by its matching tab id', () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    render(
      <LookupDrillIn
        selection={selection({ type: 'credit_session', id: 's1' })}
        onTabSelect={vi.fn()}
      />
    );
    const panel = screen.getByRole('tabpanel');
    const timelineTab = screen.getByRole('tab', { name: 'Timeline' });
    expect(panel).toHaveAttribute('id', 'lookup-drill-in-panel-timeline');
    expect(panel).toHaveAttribute('aria-labelledby', 'lookup-drill-in-tab-timeline');
    expect(timelineTab).toHaveAttribute('id', 'lookup-drill-in-tab-timeline');
  });

  it('switching to the Money tab shows the money panel and calls onTabSelect', async () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    const onTabSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <LookupDrillIn
        selection={selection({ type: 'credit_session', id: 's1' })}
        onTabSelect={onTabSelect}
      />
    );

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(onTabSelect).toHaveBeenCalledWith('money');
    await waitFor(() => expect(mockAction).toHaveBeenCalledWith('s1'));
  });

  it('every non-credit_session type renders no tablist and the Timeline section directly', async () => {
    for (const type of [
      'user',
      'expert',
      'company',
      'agency',
      'project_request',
      'engagement',
    ] as const) {
      const { unmount } = render(
        <LookupDrillIn selection={selection({ type, id: 'z1' })} onTabSelect={vi.fn()} />
      );
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      await waitFor(() => expect(mockTimelineAction).toHaveBeenCalled());
      unmount();
      mockTimelineAction.mockClear();
    }
  });
});
