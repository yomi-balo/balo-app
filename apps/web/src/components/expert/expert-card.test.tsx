import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────

// Filter motion-only props so jsdom doesn't warn about unknown DOM attributes.
// Includes `button` (CTAs + heart) on top of div/span used by the card.
vi.mock('motion/react', () => {
  const MOTION_PROPS = new Set([
    'variants',
    'initial',
    'animate',
    'exit',
    'whileHover',
    'whileTap',
    'transition',
  ]);
  const filterMotion = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).filter(([k]) => !MOTION_PROPS.has(k)));

  return {
    motion: {
      div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div {...filterMotion(props)}>{children}</div>
      ),
      span: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <span {...filterMotion(props)}>{children}</span>
      ),
      button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <button {...filterMotion(props)}>{children}</button>
      ),
    },
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  };
});

// Control photo ↔ initials deterministically. The card calls
// getAvatarUrl(expert.avatarUrl, 'profile'); a non-null return → photo state.
const mockGetAvatarUrl = vi.fn<(key: string | null, size: string) => string | null>();
vi.mock('@/lib/storage/avatar-url', () => ({
  getAvatarUrl: (key: string | null, size: string) => mockGetAvatarUrl(key, size),
}));

import { ExpertCard } from './expert-card';
import type { ExpertCardData } from './expert-card.types';

// ── Factory ─────────────────────────────────────────────────────

function makeExpert(overrides: Partial<ExpertCardData> = {}): ExpertCardData {
  return {
    id: 'expert-1',
    username: 'jane-doe',
    name: 'Jane Doe',
    initials: 'JD',
    avatarUrl: 'avatars/jane.jpg',
    headline: 'Senior Salesforce Architect',
    bio: 'Ten years building scalable orgs across finance and healthcare verticals.',
    countryCode: 'AU',
    rate: 3.44,
    nextAvailableAt: null,
    languages: [{ name: 'English', flagEmoji: '🇬🇧' }],
    agency: null,
    distinctions: {
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
    },
    rating: null,
    reviewCount: 0,
    yearsExperience: 8,
    consultationCount: 132,
    expertise: [
      { product: 'Sales Cloud', skills: ['technical', 'architecture'] },
      { product: 'Service Cloud', skills: ['admin'] },
    ],
    ...overrides,
  };
}

describe('ExpertCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a real CDN URL → photo state.
    mockGetAvatarUrl.mockReturnValue('https://cdn.balo.dev/avatars/jane.jpg');
  });

  // ── Avatar: photo vs initials ─────────────────────────────────

  it('renders the avatar photo when getAvatarUrl returns a URL', () => {
    render(<ExpertCard expert={makeExpert()} />);
    const img = screen.getByRole('img', { name: 'Jane Doe' });
    expect(img).toHaveAttribute('src', expect.stringContaining('jane.jpg'));
    // Initials are not painted while the photo is showing.
    expect(screen.queryByText('JD')).not.toBeInTheDocument();
  });

  it('falls back to initials when getAvatarUrl returns null', () => {
    mockGetAvatarUrl.mockReturnValue(null);
    render(<ExpertCard expert={makeExpert()} />);
    expect(screen.queryByRole('img', { name: 'Jane Doe' })).not.toBeInTheDocument();
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('swaps to the initials fallback when the photo errors', () => {
    render(<ExpertCard expert={makeExpert()} />);
    const img = screen.getByRole('img', { name: 'Jane Doe' });
    fireEvent.error(img);
    expect(screen.queryByRole('img', { name: 'Jane Doe' })).not.toBeInTheDocument();
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  // ── Agency badge: logo vs name vs none ────────────────────────

  it('renders the agency logo image when a logoUrl is present', () => {
    render(
      <ExpertCard
        expert={makeExpert({ agency: { name: 'MIDCAI', logoUrl: 'https://logos/midcai.png' } })}
      />
    );
    const logo = screen.getByRole('img', { name: /MIDCAI/i });
    expect(logo).toHaveAttribute('src', expect.stringContaining('midcai.png'));
  });

  it('renders the agency name as text when no logoUrl', () => {
    render(<ExpertCard expert={makeExpert({ agency: { name: 'MIDCAI', logoUrl: null } })} />);
    expect(screen.getByText('MIDCAI')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /MIDCAI/i })).not.toBeInTheDocument();
  });

  it('renders no agency badge when agency is null', () => {
    render(<ExpertCard expert={makeExpert({ agency: null })} />);
    expect(screen.queryByText('MIDCAI')).not.toBeInTheDocument();
  });

  // ── Rating gate (always null in v1) ───────────────────────────

  it('renders no rating UI when rating is null', () => {
    render(<ExpertCard expert={makeExpert({ rating: null, reviewCount: 0 })} />);
    expect(screen.queryByText('(0)')).not.toBeInTheDocument();
    // No rating value text either.
    expect(screen.queryByText(/^\d\.\d$/)).not.toBeInTheDocument();
  });

  it('renders the rating badge with value and review count when rating is set', () => {
    render(<ExpertCard expert={makeExpert({ rating: 4.8, reviewCount: 27 })} />);
    expect(screen.getByText('4.8')).toBeInTheDocument();
    expect(screen.getByText('(27)')).toBeInTheDocument();
  });

  // ── Sessions / New ────────────────────────────────────────────

  it('shows "New" and no session count when consultationCount is 0 (grid)', () => {
    render(<ExpertCard expert={makeExpert({ consultationCount: 0 })} />);
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.queryByText(/sessions/)).not.toBeInTheDocument();
  });

  it('shows "N sessions" and no "New" when consultationCount is positive (grid)', () => {
    render(<ExpertCard expert={makeExpert({ consultationCount: 132 })} />);
    expect(screen.getByText('132 sessions')).toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  // ── Distinctions ──────────────────────────────────────────────

  it('renders the Salesforce MVP label when isSalesforceMvp is true', () => {
    render(
      <ExpertCard
        expert={makeExpert({
          distinctions: {
            isSalesforceMvp: true,
            isSalesforceCta: false,
            isCertifiedTrainer: false,
          },
        })}
      />
    );
    expect(screen.getByText('Salesforce MVP')).toBeInTheDocument();
    expect(screen.queryByText('CTA')).not.toBeInTheDocument();
    expect(screen.queryByText('Certified Trainer')).not.toBeInTheDocument();
  });

  it('renders the CTA label when isSalesforceCta is true', () => {
    render(
      <ExpertCard
        expert={makeExpert({
          distinctions: {
            isSalesforceMvp: false,
            isSalesforceCta: true,
            isCertifiedTrainer: false,
          },
        })}
      />
    );
    expect(screen.getByText('CTA')).toBeInTheDocument();
    expect(screen.queryByText('Salesforce MVP')).not.toBeInTheDocument();
  });

  it('renders the Certified Trainer label when isCertifiedTrainer is true', () => {
    render(
      <ExpertCard
        expert={makeExpert({
          distinctions: {
            isSalesforceMvp: false,
            isSalesforceCta: false,
            isCertifiedTrainer: true,
          },
        })}
      />
    );
    expect(screen.getByText('Certified Trainer')).toBeInTheDocument();
    expect(screen.queryByText('CTA')).not.toBeInTheDocument();
  });

  it('renders no distinction labels when all flags are false', () => {
    render(<ExpertCard expert={makeExpert()} />);
    expect(screen.queryByText('Salesforce MVP')).not.toBeInTheDocument();
    expect(screen.queryByText('CTA')).not.toBeInTheDocument();
    expect(screen.queryByText('Certified Trainer')).not.toBeInTheDocument();
  });

  // ── Availability ──────────────────────────────────────────────

  it('shows "No availability" when nextAvailableAt is null', () => {
    render(<ExpertCard expert={makeExpert({ nextAvailableAt: null })} />);
    expect(screen.getByText('No availability')).toBeInTheDocument();
  });

  // ── Location ──────────────────────────────────────────────────

  it('renders the country name for a known countryCode', () => {
    render(<ExpertCard expert={makeExpert({ countryCode: 'AU' })} />);
    expect(screen.getByText('Australia')).toBeInTheDocument();
  });

  it('renders "Remote" when countryCode is null', () => {
    render(<ExpertCard expert={makeExpert({ countryCode: null })} />);
    expect(screen.getByText('Remote')).toBeInTheDocument();
  });

  // ── Rate ──────────────────────────────────────────────────────

  it('renders the formatted rate with a per-minute label (grid)', () => {
    render(<ExpertCard expert={makeExpert({ rate: 3.44 })} />);
    expect(screen.getByText('A$3.44')).toBeInTheDocument();
    expect(screen.getByText('per minute')).toBeInTheDocument();
  });

  it('renders a placeholder (no NaN / no A$null) when rate is null', () => {
    render(<ExpertCard expert={makeExpert({ rate: null })} />);
    expect(screen.getByText('rate not set')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A\$null/)).not.toBeInTheDocument();
  });

  it('renders a rate placeholder (no NaN / no A$null) in the list variant when rate is null', () => {
    render(<ExpertCard expert={makeExpert({ rate: null })} variant="list" />);
    expect(screen.getByText('rate not set')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A\$null/)).not.toBeInTheDocument();
  });

  // ── Headline fallback ─────────────────────────────────────────

  it('falls back to the first expertise product when headline is null', () => {
    // "Sales Cloud" also appears as an expertise pill, so the fallback headline
    // makes it appear twice (headline + pill) rather than once.
    render(<ExpertCard expert={makeExpert({ headline: null })} />);
    expect(screen.getAllByText('Sales Cloud').length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to "Salesforce Expert" when headline is null and there is no expertise', () => {
    render(<ExpertCard expert={makeExpert({ headline: null, expertise: [] })} />);
    expect(screen.getByText('Salesforce Expert')).toBeInTheDocument();
  });

  // ── List variant ──────────────────────────────────────────────

  it('renders the list variant with name, meta, bio and CTAs', () => {
    render(<ExpertCard expert={makeExpert()} variant="list" />);
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    // Meta line shows flag + country name together.
    expect(screen.getByText(/Australia/)).toBeInTheDocument();
    expect(screen.getByText('132 sessions')).toBeInTheDocument();
    expect(screen.getByText(/Ten years building scalable orgs/)).toBeInTheDocument();
    expect(screen.getByText('View profile')).toBeInTheDocument();
    expect(screen.getByText('Book a call')).toBeInTheDocument();
  });

  it('uses the "New expert" meta label in the list variant when there are no sessions', () => {
    render(<ExpertCard expert={makeExpert({ consultationCount: 0 })} variant="list" />);
    expect(screen.getByText('New expert')).toBeInTheDocument();
  });

  // ── CTA callbacks ─────────────────────────────────────────────

  it('fires onViewProfile and onBook when their CTAs are clicked', async () => {
    const onBook = vi.fn();
    const onViewProfile = vi.fn();
    const user = userEvent.setup();
    render(<ExpertCard expert={makeExpert()} onBook={onBook} onViewProfile={onViewProfile} />);

    await user.click(screen.getByRole('button', { name: /view profile/i }));
    expect(onViewProfile).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: /book a call/i }));
    expect(onBook).toHaveBeenCalledOnce();
  });

  it('toggles the favorite heart aria-label on click', async () => {
    const user = userEvent.setup();
    render(<ExpertCard expert={makeExpert()} />);

    const heart = screen.getByRole('button', { name: /add to favorites/i });
    await user.click(heart);
    expect(screen.getByRole('button', { name: /remove from favorites/i })).toBeInTheDocument();
  });

  it('renders the favorite heart in the list variant too', () => {
    render(<ExpertCard expert={makeExpert()} variant="list" />);
    expect(screen.getByRole('button', { name: /add to favorites/i })).toBeInTheDocument();
  });
});
