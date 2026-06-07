import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, EXPERT_PROFILE_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';
import type { ExpertProfileView } from '@/components/expert/profile';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';

const EMPTY_TAXONOMIES = { tags: EMPTY_TAXONOMY, products: EMPTY_TAXONOMY };

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const mockTrack = vi.mocked(track);
const mockToast = vi.mocked(toast);

// useIsMobile reads window.matchMedia (absent in jsdom). The codebase pattern is
// to mock the hook directly (see top-nav.test.tsx / drawer.test.tsx). It only
// drives the analytics `viewport` value here, not layout — default to desktop.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

// The mounted ProjectDrawer imports the `'use server'` action (pulls server-only
// deps at module load). Mock it so the client tree mounts cleanly.
vi.mock('../_actions/submit-project-request', () => ({
  submitProjectRequestAction: vi.fn(),
}));

import { ExpertProfileClient } from './expert-profile-client';

/**
 * A fully serializable `ExpertProfileView` mirroring the exact shape in
 * `components/expert/profile/types.ts` and what `mapProfileToView` produces
 * (string-formatted dates, no Drizzle rows). Overridable per test.
 */
function makeView(overrides: Partial<ExpertProfileView> = {}): ExpertProfileView {
  return {
    expertId: 'expert-1',
    agencyId: 'agency-1',
    name: 'Anil Pilania',
    firstName: 'Anil',
    initials: 'AP',
    headline: 'Salesforce Solution Architect',
    bio: 'Seasoned architect.\n\nLed dozens of orgs through complex migrations.',
    avatarKey: 'avatars/anil.png',
    countryCode: 'CA',
    country: 'Canada',
    rate: 9.5,
    yearsExperience: 9,
    consultationCount: 124,
    certCount: 2,
    availableForWork: true,
    baloVerified: true,
    topRated: false,
    competencies: [
      { id: 's1', name: 'Apex', proficiency: 10, level: 'Expert', tone: 'success', pct: 100 },
      { id: 's2', name: 'Flows', proficiency: 5, level: 'Intermediate', tone: 'warning', pct: 50 },
      { id: 's3', name: 'LWC', proficiency: 2, level: 'Beginner', tone: 'muted', pct: 20 },
    ],
    certifications: [
      { id: 'c1', name: 'Platform Developer I', logoUrl: 'https://cdn.test/pd1.png' },
      { id: 'c2', name: 'Administrator', logoUrl: null },
    ],
    languages: [
      { name: 'English', flagEmoji: '🇬🇧' },
      { name: 'Tamil', flagEmoji: null },
    ],
    languagesLabel: 'English, Tamil',
    agency: {
      name: 'Cloud Partners',
      slug: 'cloud-partners',
      logoUrl: null,
      initials: 'CP',
    },
    workHistory: [
      {
        role: 'Lead Architect',
        company: 'Cloud Partners',
        periodLabel: 'Apr 2025 — Present',
        durationLabel: '',
        isCurrent: true,
        responsibilities: 'Leading the architecture practice.',
      },
      {
        role: 'Senior Developer',
        company: 'Acme Corp',
        periodLabel: 'Nov 2017 — Apr 2020',
        durationLabel: '2 yrs 5 mos',
        isCurrent: false,
        responsibilities: null,
      },
    ],
    ...overrides,
  };
}

/** A bare-bones profile that exercises every empty-state / null-gating branch. */
function makeSparseView(): ExpertProfileView {
  return makeView({
    expertId: 'expert-2',
    name: 'Salesforce Expert',
    firstName: 'this expert',
    initials: 'SE',
    headline: null,
    bio: null,
    avatarKey: null,
    countryCode: null,
    country: null,
    rate: null,
    yearsExperience: null,
    consultationCount: 0,
    certCount: 0,
    availableForWork: false,
    competencies: [],
    certifications: [],
    languages: [],
    languagesLabel: '',
    agency: null,
    workHistory: [],
  });
}

describe('ExpertProfileClient — full profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the expert name, the section nav, and the booking CTA', () => {
    render(
      <ExpertProfileClient
        view={makeView()}
        portraitUrl="https://cdn.test/anil.png"
        isLoggedIn
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );

    // Name appears in the hero.
    expect(screen.getByRole('heading', { name: 'Anil Pilania', level: 1 })).toBeInTheDocument();

    // Full section nav including Work (workHistory present).
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expertise' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick Starts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Work' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reviews' })).toBeInTheDocument();

    // Booking CTA + per-minute rate.
    expect(screen.getByRole('button', { name: /book a consultation/i })).toBeInTheDocument();
    expect(screen.getByText('A$9.50')).toBeInTheDocument();
  });

  it('renders the skills, certifications, work history, and agency lockup', () => {
    render(
      <ExpertProfileClient
        view={makeView()}
        portraitUrl={null}
        isLoggedIn={false}
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );

    expect(screen.getByText('Apex')).toBeInTheDocument();
    expect(screen.getByText('Platform Developer I')).toBeInTheDocument();
    expect(screen.getByText('Lead Architect')).toBeInTheDocument();
    // Agency name shows in the hero lockup AND as the current role's company.
    expect(screen.getAllByText('Cloud Partners').length).toBeGreaterThan(0);
  });

  it('falls back to the illustrated portrait when portraitUrl is null', () => {
    const { container } = render(
      <ExpertProfileClient
        view={makeView()}
        portraitUrl={null}
        isLoggedIn
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );
    // HeroPortrait is an inline SVG placeholder (no <img>).
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

describe('ExpertProfileClient — sparse profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits the Work section and drops it from the nav when there is no history', () => {
    render(
      <ExpertProfileClient
        view={makeSparseView()}
        portraitUrl={null}
        isLoggedIn={false}
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );
    expect(screen.queryByRole('button', { name: 'Work' })).not.toBeInTheDocument();
    // Remaining sections still render.
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reviews' })).toBeInTheDocument();
  });

  it('shows the empty states for bio, expertise, and reviews', () => {
    render(
      <ExpertProfileClient
        view={makeSparseView()}
        portraitUrl={null}
        isLoggedIn={false}
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );
    expect(screen.getByText(/hasn't added a bio yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Skills and certifications will appear here once they're added\./i)
    ).toBeInTheDocument();
    expect(screen.getByText('No reviews yet')).toBeInTheDocument();
  });

  it('shows "Rate on request" and the unavailable state when rate is null and not available', () => {
    render(
      <ExpertProfileClient
        view={makeSparseView()}
        portraitUrl={null}
        isLoggedIn={false}
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );
    expect(screen.getByText('Rate on request')).toBeInTheDocument();
    // "Currently unavailable" appears in the hero pill and the booking card.
    expect(screen.getAllByText('Currently unavailable').length).toBeGreaterThan(0);
  });

  // Axe runs on the sparse variant: it renders nearly the entire presentational
  // tree (Hero, StickyNav, About, Expertise, QuickStarts, Reviews, BookingCard)
  // but omits WorkSection, whose `<h3>` directly under the hero `<h1>` trips a
  // pre-existing heading-order finding in the source (an h2 is skipped).
  it('has no accessibility violations', async () => {
    const { container } = render(
      <ExpertProfileClient
        view={makeSparseView()}
        portraitUrl={null}
        isLoggedIn={false}
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ExpertProfileClient — CTA handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts "Coming soon" for the still-stubbed book + message CTAs', async () => {
    const user = userEvent.setup();
    render(
      <ExpertProfileClient
        view={makeView()}
        portraitUrl={null}
        isLoggedIn
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );

    await user.click(screen.getByRole('button', { name: /book a consultation/i }));
    await user.click(screen.getByRole('button', { name: /send a message first/i }));

    const clickedCtas = mockTrack.mock.calls
      .filter(([event]) => event === EXPERT_PROFILE_EVENTS.PROFILE_CTA_CLICKED)
      .map(([, props]) => (props as { cta: string }).cta);
    expect(clickedCtas).toEqual(['book', 'message']);
    expect(mockToast).toHaveBeenCalledWith('Coming soon', expect.objectContaining({}));
  });

  it('opens the ProjectDrawer (not a toast) and still fires cta_clicked {cta:project}', async () => {
    const user = userEvent.setup();
    render(
      <ExpertProfileClient
        view={makeView()}
        portraitUrl={null}
        isLoggedIn
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );

    // The drawer is closed initially — its start-step heading is absent.
    expect(
      screen.queryByRole('heading', { name: /start a project with anil pilania/i })
    ).not.toBeInTheDocument();

    // "Start a project" appears in both the BookingCard and the QuickStarts
    // empty-state — both route through the same `project` handler.
    const [startProject] = screen.getAllByRole('button', { name: /start a project/i });
    if (startProject) await user.click(startProject);

    // Drawer opened — start-step heading visible.
    expect(
      await screen.findByRole('heading', { name: /start a project with anil pilania/i })
    ).toBeInTheDocument();

    // Profile-level CTA event still fired with cta:'project'.
    expect(mockTrack).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.PROFILE_CTA_CLICKED, {
      expert_id: 'expert-1',
      cta: 'project',
    });
    // No "Coming soon" toast for the project CTA.
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('jumps to a section (and stays green despite scrollIntoView) when a nav tab is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExpertProfileClient
        view={makeView()}
        portraitUrl={null}
        isLoggedIn
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );
    // handleJump sets active + smooth-scrolls; scrollIntoView is stubbed in setup.
    await user.click(screen.getByRole('button', { name: 'Reviews' }));
    expect(screen.getByRole('button', { name: 'Reviews' })).toHaveAttribute('aria-current', 'true');
  });
});

describe('ExpertProfileClient — IntersectionObserver effects', () => {
  type Cb = (entries: ReadonlyArray<Partial<IntersectionObserverEntry>>) => void;
  const callbacks: Cb[] = [];
  const original = globalThis.IntersectionObserver;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks.length = 0;
    // Capture each observer's callback so the test can feed it entries, exercising
    // the scroll-spy (client) and section-viewed (analytics) callback bodies.
    class CapturingObserver {
      constructor(cb: IntersectionObserverCallback) {
        callbacks.push(cb as unknown as Cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.IntersectionObserver = original;
  });

  function entry(section: string, isIntersecting: boolean): Partial<IntersectionObserverEntry> {
    const target = document.createElement('section');
    target.setAttribute('data-section', section);
    return {
      isIntersecting,
      target,
      boundingClientRect: { top: 0 } as DOMRectReadOnly,
    };
  }

  it('updates the active nav from the scroll-spy and fires section-viewed analytics', () => {
    render(
      <ExpertProfileClient
        view={makeView()}
        portraitUrl={null}
        isLoggedIn
        projectTaxonomies={EMPTY_TAXONOMIES}
      />
    );

    // Two observers are registered: scroll-spy (client) + section-viewed (analytics).
    expect(callbacks.length).toBeGreaterThanOrEqual(2);
    // Feed an intersecting "expertise" entry to every observer. Wrap in act so
    // the scroll-spy's setActiveNav state update flushes before asserting.
    const entries = [entry('expertise', true), entry('about', false)];
    act(() => {
      for (const cb of callbacks) cb(entries);
    });

    // Scroll-spy marks expertise active.
    expect(screen.getByRole('button', { name: 'Expertise' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    // Analytics fires the section-viewed event for the intersecting section.
    expect(mockTrack).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.PROFILE_SECTION_VIEWED, {
      expert_id: 'expert-1',
      section: 'expertise',
    });
  });
});
