import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { RecapPartyView } from '@/lib/meetings/recap-view-types';

const mockGetAvatarUrl = vi.fn();
vi.mock('@/lib/storage/avatar-url', () => ({
  getAvatarUrl: (...args: unknown[]) => mockGetAvatarUrl(...args),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { PartyCard } from './party-card';

const PARTY: RecapPartyView = {
  name: 'Amara Okafor',
  headline: 'Salesforce CPQ specialist',
  orgLabel: 'CloudPeak',
  avatarUrl: null,
  initials: 'AO',
  ordinalLine: '3rd consultation on this case',
  bookAgainHref: '/experts/amara',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAvatarUrl.mockReturnValue(null);
});

describe('PartyCard', () => {
  /**
   * ⚠⚠ `users.avatar_url` IS NOT ALWAYS A URL. A Balo upload stores an R2 KEY
   * (`avatars/<uuid>/<uuid>.webp`); handing that straight to `src` renders a relative path that
   * 404s and silently falls back to initials, so ONLY WorkOS OAuth avatars would ever paint.
   * Every other display site in the app converts, and this assertion is what keeps this one
   * converting too — it fails outright if the call is dropped.
   */
  it('runs the avatar through getAvatarUrl, so an R2 KEY is not used as a bare src', () => {
    render(<PartyCard party={{ ...PARTY, avatarUrl: 'avatars/u1/a1.webp' }} lens="client" />);
    expect(mockGetAvatarUrl).toHaveBeenCalledWith('avatars/u1/a1.webp', 'thumbnail');
  });

  it('converts a null avatar too, rather than branching around the helper', () => {
    render(<PartyCard party={PARTY} lens="client" />);
    expect(mockGetAvatarUrl).toHaveBeenCalledWith(null, 'thumbnail');
    expect(screen.getByText('AO')).toBeInTheDocument();
  });

  it('renders the identity stack and the ordinal footer', () => {
    render(<PartyCard party={PARTY} lens="client" />);
    expect(screen.getByText('Amara Okafor')).toBeInTheDocument();
    expect(screen.getByText('Salesforce CPQ specialist')).toBeInTheDocument();
    expect(screen.getByText('CloudPeak')).toBeInTheDocument();
    expect(screen.getByText('3rd consultation on this case')).toBeInTheDocument();
  });

  it('renders NO action at all when there is no live destination', () => {
    // `expert_profiles.username` is NULLABLE: a null username means NO button, never a disabled
    // one and never a link to `/experts/null`.
    const { container } = render(
      <PartyCard party={{ ...PARTY, bookAgainHref: null }} lens="expert" />
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.queryByText('Book again')).not.toBeInTheDocument();
  });

  it('never renders an email address or a mailto', () => {
    const { container } = render(<PartyCard party={PARTY} lens="client" />);
    expect(container.innerHTML).not.toContain('mailto:');
    expect(container.innerHTML).not.toContain('@example');
  });
});
