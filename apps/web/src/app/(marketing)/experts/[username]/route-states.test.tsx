import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ExpertProfileView } from '@/components/expert/profile';

import ExpertProfileLoading from './loading';
import ExpertProfileError from './error';
import ExpertProfileNotFound from './not-found';

describe('experts/[username]/loading', () => {
  it('renders the hero + nav + body skeleton shell (no spinner)', () => {
    const { container } = render(<ExpertProfileLoading />);
    // The shell mirrors the real layout: a dark .expert-hero block + pulse skeletons.
    expect(container.querySelector('.expert-hero')).toBeTruthy();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('experts/[username]/error', () => {
  it('renders the fallback and calls reset on Try again', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<ExpertProfileError error={new Error('boom')} reset={reset} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('experts/[username]/not-found', () => {
  it('renders the 404 copy and a "Browse experts" link', () => {
    render(<ExpertProfileNotFound />);
    expect(screen.getByText("This expert profile isn't available")).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Browse experts' });
    expect(link).toHaveAttribute('href', '/experts');
  });
});

// ── page.tsx (RSC) — mock the seams the page composes, like BAL-247's page.test ──
const { mockFindProfile, mockMapView, mockGetAvatarUrl, mockGetCurrentUser, mockNotFound } =
  vi.hoisted(() => ({
    mockFindProfile: vi.fn(),
    mockMapView: vi.fn(),
    mockGetAvatarUrl: vi.fn(),
    mockGetCurrentUser: vi.fn(),
    mockNotFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
  }));

vi.mock('@balo/db', () => ({
  expertsRepository: { findPublicProfileByUsername: mockFindProfile },
}));
vi.mock('@/lib/expert-profile/profile-view', () => ({ mapProfileToView: mockMapView }));
vi.mock('@/lib/storage/avatar-url', () => ({ getAvatarUrl: mockGetAvatarUrl }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

// Stub the client tree — page.tsx coverage is about the server gate/fetch/mapper
// wiring, not re-rendering the (separately tested) presentational tree.
vi.mock('./_components/expert-profile-client', () => ({
  ExpertProfileClient: ({ view, isLoggedIn }: { view: { name: string }; isLoggedIn: boolean }) => (
    <div data-testid="profile-client" data-logged-in={String(isLoggedIn)}>
      {view.name}
    </div>
  ),
}));

import ExpertProfilePage, { generateMetadata } from './page';

const VIEW: Pick<ExpertProfileView, 'name'> = { name: 'Anil Pilania' };

async function renderPage(username = 'anil') {
  const ui = await ExpertProfilePage({ params: Promise.resolve({ username }) });
  return render(ui);
}

describe('ExpertProfilePage (RSC)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the profile and renders the client tree on a successful fetch', async () => {
    mockFindProfile.mockResolvedValue({ id: 'p1' });
    mockMapView.mockReturnValue(VIEW);
    mockGetAvatarUrl.mockReturnValue('https://cdn.test/anil.png');
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });

    await renderPage('anil');

    expect(mockFindProfile).toHaveBeenCalledWith('anil');
    expect(mockMapView).toHaveBeenCalledWith({ id: 'p1' });
    const client = screen.getByTestId('profile-client');
    expect(client).toHaveTextContent('Anil Pilania');
    expect(client).toHaveAttribute('data-logged-in', 'true');
  });

  it('passes isLoggedIn=false when there is no current user', async () => {
    mockFindProfile.mockResolvedValue({ id: 'p1' });
    mockMapView.mockReturnValue(VIEW);
    mockGetAvatarUrl.mockReturnValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    await renderPage();
    expect(screen.getByTestId('profile-client')).toHaveAttribute('data-logged-in', 'false');
  });

  it('calls notFound() when the profile is missing or gated', async () => {
    mockFindProfile.mockResolvedValue(null);
    await expect(renderPage('ghost')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockMapView).not.toHaveBeenCalled();
  });

  it('re-throws so error.tsx can render when the fetch rejects', async () => {
    mockFindProfile.mockRejectedValue(new Error('db down'));
    await expect(renderPage('anil')).rejects.toThrow('db down');
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});

describe('ExpertProfilePage — generateMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds title/description/canonical from the profile when found', async () => {
    mockFindProfile.mockResolvedValue({
      user: { firstName: 'Anil', lastName: 'Pilania' },
      headline: 'Salesforce Architect',
    });

    const meta = await generateMetadata({ params: Promise.resolve({ username: 'anil' }) });

    expect(meta.title).toBe('Anil Pilania — Balo Expert');
    expect(meta.description).toBe('Salesforce Architect');
    expect(meta.alternates?.canonical).toBe('https://balo.expert/experts/anil');
  });

  it('falls back to a generic description when the headline is missing', async () => {
    mockFindProfile.mockResolvedValue({
      user: { firstName: 'Anil', lastName: null },
      headline: null,
    });

    const meta = await generateMetadata({ params: Promise.resolve({ username: 'anil' }) });
    expect(meta.title).toBe('Anil — Balo Expert');
    expect(meta.description).toBe('Anil is a technology consultant on Balo.');
  });

  it('returns the not-found title when the profile is missing', async () => {
    mockFindProfile.mockResolvedValue(null);
    const meta = await generateMetadata({ params: Promise.resolve({ username: 'ghost' }) });
    expect(meta.title).toBe('Expert Not Found — Balo');
  });
});
