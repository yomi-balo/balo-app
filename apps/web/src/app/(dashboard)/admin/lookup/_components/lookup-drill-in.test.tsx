import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { LookupSelection } from '../_lib/lookup-view';
import { LookupDrillIn } from './lookup-drill-in';

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));
vi.mock('../_actions/fetch-lookup-money-block', () => ({
  fetchLookupMoneyBlockAction: mockAction,
}));

beforeEach(() => {
  mockAction.mockClear();
});

function selection(
  overrides: Partial<LookupSelection> & Pick<LookupSelection, 'type' | 'id'>
): LookupSelection {
  return {
    key: `${overrides.type}:${overrides.id}`,
    title: 'Title',
    sub: 'Sub line',
    publicExpertUsername: null,
    via: 'search',
    ...overrides,
  };
}

describe('LookupDrillIn — the Open-link matrix', () => {
  it('project_request always renders Open, linking to /projects/{id}', () => {
    render(<LookupDrillIn selection={selection({ type: 'project_request', id: 'r1' })} />);
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/projects/r1');
  });

  it('a published expert renders Open, linking to /experts/{username}', () => {
    render(
      <LookupDrillIn
        selection={selection({ type: 'expert', id: 'x1', publicExpertUsername: 'priya' })}
      />
    );
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', '/experts/priya');
  });

  it('an unpublished expert renders no Open link and the not-public copy', () => {
    render(<LookupDrillIn selection={selection({ type: 'expert', id: 'x2' })} />);
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
      />
    );
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByText(/recent links can go stale/i)).toBeInTheDocument();
  });

  it.each(['user', 'company', 'agency'] as const)(
    '%s renders no Open link and the no-page copy',
    (type) => {
      render(<LookupDrillIn selection={selection({ type, id: 'z1' })} />);
      expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
      expect(screen.getByText(/there's no .* page yet/i)).toBeInTheDocument();
    }
  );

  it('credit_session renders no Open link and the receipt-is-client-view copy', () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    render(<LookupDrillIn selection={selection({ type: 'credit_session', id: 's1' })} />);
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByText(/the receipt is the client's own view/i)).toBeInTheDocument();
  });

  it('mounts the Money section only for credit_session', () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    render(<LookupDrillIn selection={selection({ type: 'credit_session', id: 's1' })} />);
    expect(mockAction).toHaveBeenCalledWith('s1');
  });

  it('does not mount the Money section for any other type', () => {
    render(<LookupDrillIn selection={selection({ type: 'company', id: 'co1' })} />);
    expect(mockAction).not.toHaveBeenCalled();
  });

  it('renders no tab or tablist element (single labelled section, not a tab bar)', () => {
    render(<LookupDrillIn selection={selection({ type: 'company', id: 'co1' })} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('renders the type eyebrow and title', () => {
    render(
      <LookupDrillIn selection={selection({ type: 'user', id: 'u1', title: 'Dana Whitfield' })} />
    );
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
  });
});
