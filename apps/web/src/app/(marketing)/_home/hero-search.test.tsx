import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import { buildProductNameMap } from '@/lib/search/taxonomy';
import type { PopularChip } from '@/lib/marketing/popular-chips';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import { rememberPendingHomeProject } from '@/lib/marketing/pending-home-project';
import { HERO_MODE_COPY } from './copy';
import { HeroSearch } from './hero-search';
import { HeroSection } from './hero-section';

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

interface PanelStubProps {
  open?: unknown;
  onClose?: () => void;
  seed?: unknown;
  resumeDraft?: unknown;
  isLoggedIn?: unknown;
}

// BAL-582 — a data-attribute stub for the lazily mounted `./home-project-panel`, so this file
// never pulls in `useAuthModal` / the real `ProjectRequestPanel`'s much larger mock surface. The
// close button lets a test drive `onClose` without mounting the real panel.
vi.mock('./home-project-panel', () => ({
  HomeProjectPanel: (props: PanelStubProps) => (
    <div
      data-testid="home-project-panel-stub"
      data-open={String(props.open)}
      data-resume-draft={String(props.resumeDraft)}
      data-is-logged-in={String(props.isLoggedIn)}
      data-seed={JSON.stringify(props.seed ?? null)}
    >
      <button type="button" onClick={props.onClose}>
        close-panel-stub
      </button>
    </div>
  ),
}));

const mockTrack = vi.mocked(track);

/**
 * BAL-493 §5 — the hero search contract. A single taxonomy with two products, one of which
 * ("Agentforce") is ALSO a "Popular:" chip, so a single fixture can drive the shared-state
 * assertion in both directions (chip -> facet AND facet -> chip) against a real, un-mocked
 * `ProductSelector` (§5.2 — not a hand-rolled facet).
 */
const taxonomy: ProductTaxonomy = {
  groups: [
    {
      id: 'g-ai',
      name: 'AI',
      items: [
        { id: 'agentforce-id', name: 'Agentforce' },
        { id: 'data-cloud-id', name: 'Data Cloud' },
      ],
    },
  ],
};
const productNameMap = buildProductNameMap(taxonomy);
const chips: readonly PopularChip[] = [{ id: 'agentforce-id', name: 'Agentforce' }];
const PROJECT_PHRASES = ['migrate us from HubSpot to Sales Cloud'];

/** Trimmed length 37, `projectScore` 5 — well above `PROJECT_NUDGE_THRESHOLD` (3). */
const ELIGIBLE_QUERY = 'implement CPQ across our support team';

function renderHeroSearch(overrides: { isLoggedIn?: boolean } = {}) {
  return render(
    <HeroSearch
      taxonomy={taxonomy}
      productNameMap={productNameMap}
      chips={chips}
      phrases={['fix a broken Flow before lunch']}
      projectPhrases={PROJECT_PHRASES}
      verticalName="Salesforce"
      isLoggedIn={overrides.isLoggedIn ?? true}
    />
  );
}

async function switchToProjectMode() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole('button', { name: HERO_MODE_COPY.toggleLabel, pressed: false })
  );
  return user;
}

beforeEach(() => {
  mockPush.mockClear();
  mockTrack.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  globalThis.window.history.replaceState(null, '', '/');
});

describe('HeroSearch — the real ProductSelector is mounted (§5.2)', () => {
  it('renders ProductSelector by role/label when the facet popover opens, not a hand-rolled facet', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Product/ }));
    const dialog = await screen.findByRole('dialog');

    // `ProductSelector`'s own sr-only search label — proves the REAL composer part is mounted,
    // not a stand-in facet (plan §5.1's rejected `ProductFacet`).
    expect(within(dialog).getByLabelText('Search products and skills')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Agentforce' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Data Cloud' })).toBeInTheDocument();
  });
});

describe('HeroSearch — chips and the facet popover share ONE state (§5.4)', () => {
  it('a chip toggle updates the facet badge, and the facet popover reflects the same selection', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    const chip = screen.getByRole('button', { name: 'Agentforce' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    const facetButton = screen.getByRole('button', { name: /Product/ });
    expect(within(facetButton).getByText('1')).toBeInTheDocument();

    await user.click(facetButton);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Agentforce' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Facet -> chip: toggle a DIFFERENT product inside the popover, close it, and confirm the
    // outer "Popular:" row reflects it too — proving there is one shared state, not two.
    await user.click(within(dialog).getByRole('button', { name: 'Data Cloud' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    expect(
      within(screen.getByRole('button', { name: /Product/ })).getByText('2')
    ).toBeInTheDocument();
  });
});

describe('HeroSearch — submit navigates to /experts with q + repeated product UUIDs (§5.3)', () => {
  it('submits via clicking "Find experts"', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.type(
      screen.getByRole('textbox', { name: /Describe what you need help with/i }),
      'fix a broken Flow'
    );
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    await user.click(screen.getByRole('button', { name: /Find experts/i }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const [url] = mockPush.mock.calls[0] as [string];
    expect(url.startsWith('/experts?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('q')).toBe('fix a broken Flow');
    expect(params.getAll('products')).toEqual(['agentforce-id']);
  });

  it('submits identically via pressing Enter in the search field (a `type="button"` submit can never do this)', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    await user.type(
      screen.getByRole('textbox', { name: /Describe what you need help with/i }),
      'fix a broken Flow{Enter}'
    );

    expect(mockPush).toHaveBeenCalledTimes(1);
    const [url] = mockPush.mock.calls[0] as [string];
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('q')).toBe('fix a broken Flow');
    expect(params.getAll('products')).toEqual(['agentforce-id']);
  });

  it('an empty submit still navigates to bare /experts (browse everything)', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Find experts/i }));
    expect(mockPush).toHaveBeenCalledWith('/experts?');
  });
});

/**
 * BAL-493 fix round 2 (review MAJOR 6) — this island asserted NOTHING about `track` at all,
 * which is exactly why the StrictMode double-fire bug (fix round 1's B4, MAJOR 4) reached
 * review undetected. Mirrors `bench-rows.test.tsx`'s emitter-testing approach: exact bags,
 * exactly-once counts, and — for the toggle — a real `<StrictMode>` render, because the B4 bug
 * only manifests when React actually double-invokes the `setSelectedIds` updater function; a
 * plain (non-Strict) render would pass identically whether or not the fix regresses.
 */
describe('HeroSearch — analytics emitters (AC-6)', () => {
  it('opening the facet popover fires exactly one hero_facet_opened with an empty bag', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Product/ }));
    await screen.findByRole('dialog');

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_FACET_OPENED, {});

    // Closing the popover must not emit a second event.
    await user.keyboard('{Escape}');
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠⚠ REGRESSION GUARD for fix round 1's B4 (review MAJOR 4). `hero-search.tsx`'s
   * `handleToggle` docblock explains why the `track` call must sit OUTSIDE the `setSelectedIds`
   * updater: React's StrictMode double-invokes a state updater FUNCTION (the callback form) in
   * development to surface impurities. The current fix passes `setSelectedIds` an already-
   * computed VALUE and calls `tracking.heroProductToggled` directly in the (never
   * double-invoked) click handler body, so it is immune. Moving the `track` call back inside a
   * functional `setSelectedIds((prev) => { ...; tracking.heroProductToggled(...); return next })`
   * would double-fire here, under a REAL `<StrictMode>` render — a plain render would not catch
   * it, which is why this test deliberately wraps in one.
   */
  it('a chip toggle fires exactly one hero_product_toggled under StrictMode', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <HeroSearch
          taxonomy={taxonomy}
          productNameMap={productNameMap}
          chips={chips}
          phrases={['fix a broken Flow before lunch']}
          projectPhrases={PROJECT_PHRASES}
          verticalName="Salesforce"
          isLoggedIn
        />
      </StrictMode>
    );

    await user.click(screen.getByRole('button', { name: 'Agentforce' }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Agentforce',
      source: 'chip',
      selected: true,
    });
  });

  it('a facet toggle inside the popover also fires exactly one hero_product_toggled, source "facet"', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Product/ }));
    const dialog = await screen.findByRole('dialog');
    mockTrack.mockClear(); // drop the hero_facet_opened emission from opening the popover

    await user.click(within(dialog).getByRole('button', { name: 'Data Cloud' }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Data Cloud',
      source: 'facet',
      selected: true,
    });
  });

  it('toggling the same chip off fires exactly one hero_product_toggled with selected:false', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    const chip = screen.getByRole('button', { name: 'Agentforce' });
    await user.click(chip); // select
    mockTrack.mockClear();
    await user.click(chip); // deselect

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, {
      product: 'Agentforce',
      source: 'chip',
      selected: false,
    });
  });

  it('submit fires exactly one hero_search_submitted, with query_length and the selected product names', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.type(
      screen.getByRole('textbox', { name: /Describe what you need help with/i }),
      'fix a broken Flow'
    );
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    mockTrack.mockClear();

    await user.click(screen.getByRole('button', { name: /Find experts/i }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED, {
      query_length: 'fix a broken Flow'.length,
      product_count: 1,
      products: ['Agentforce'],
    });
  });

  it('an empty submit still fires hero_search_submitted, with query_length 0 and no products', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: /Find experts/i }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED, {
      query_length: 0,
      product_count: 0,
      products: [],
    });
  });
});

describe('HeroSearch — the no-JS fallback', () => {
  it('carries a real <form action="/experts" method="get"> and one hidden input per selected product', async () => {
    const user = userEvent.setup();
    const { container } = renderHeroSearch();

    const form = screen.getByRole('search');
    expect(form.tagName).toBe('FORM');
    expect(form).toHaveAttribute('action', '/experts');
    expect(form).toHaveAttribute('method', 'get');
    expect(container.querySelectorAll('input[type="hidden"][name="products"]')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    const hiddenInputs = container.querySelectorAll<HTMLInputElement>(
      'input[type="hidden"][name="products"]'
    );
    expect(hiddenInputs).toHaveLength(1);
    const [hidden] = hiddenInputs;
    if (!hidden) throw new Error('expected one hidden products input');
    expect(hidden.value).toBe('agentforce-id');
  });

  it('SSR renders consultation mode even with ?intent=project in the URL (mode toggling is a client enhancement)', () => {
    globalThis.window.history.replaceState(null, '', '/?intent=project');
    const html = renderToString(
      <HeroSearch
        taxonomy={taxonomy}
        productNameMap={productNameMap}
        chips={chips}
        phrases={['fix a broken Flow before lunch']}
        projectPhrases={PROJECT_PHRASES}
        verticalName="Salesforce"
        isLoggedIn={false}
      />
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(HERO_MODE_COPY.submit.consultation);
    expect(html).not.toContain(HERO_MODE_COPY.submit.project);
  });
});

describe('HeroSearch — accessibility', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderHeroSearch();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations in project mode', async () => {
    const { container } = renderHeroSearch();
    await switchToProjectMode();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('HeroSection ⊃ HeroSearch — exactly one <h1> at the composition boundary (AC-3)', () => {
  it('HeroSearch itself owns no heading; HeroSection renders exactly one h1', () => {
    const { container: searchOnly } = renderHeroSearch();
    expect(searchOnly.querySelectorAll('h1')).toHaveLength(0);

    render(
      <HeroSection
        expertTotal={null}
        wasAvailabilityGated={false}
        taxonomy={taxonomy}
        productNameMap={productNameMap}
        chips={chips}
        benchTiles={[]}
        isLoggedIn={false}
      />
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('.mk-hero-inner direct children are [mk-h1, mk-lede, mk-sent, mk-search-zone, mk-chips] with no live pill', () => {
    const { container } = render(
      <HeroSection
        expertTotal={null}
        wasAvailabilityGated={false}
        taxonomy={taxonomy}
        productNameMap={productNameMap}
        chips={chips}
        benchTiles={[]}
        isLoggedIn={false}
      />
    );
    const inner = container.querySelector('.mk-hero-inner');
    if (!inner) throw new Error('expected .mk-hero-inner');
    const classes = [...inner.children].map((child) => child.className);
    expect(classes).toEqual(['mk-h1', 'mk-lede', 'mk-sent', 'mk-search-zone', 'mk-chips']);
  });
});

describe('HeroSearch — BAL-582 sentence mode toggle', () => {
  it('the phrase button carries a STABLE accessible name across toggles, while aria-pressed flips', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    const phraseBtn = screen.getByRole('button', { name: HERO_MODE_COPY.toggleLabel });
    expect(phraseBtn).toHaveAttribute('aria-pressed', 'false');
    expect(phraseBtn).not.toHaveAttribute('title');

    await user.click(phraseBtn);

    // Same accessible name resolves to exactly one button after the flip — it never changed to
    // "narrate" the new state (that is `aria-pressed`'s job, not the name's).
    const flipped = screen.getByRole('button', { name: HERO_MODE_COPY.toggleLabel });
    expect(flipped).toBe(phraseBtn);
    expect(flipped).toHaveAttribute('aria-pressed', 'true');
    expect(flipped).not.toHaveAttribute('title');
  });

  it('the phrase click fires heroModeChanged with source "phrase"; the tail click fires it with source "tail"', async () => {
    const user = userEvent.setup();
    renderHeroSearch();

    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.toggleLabel }));
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_MODE_CHANGED, {
      mode: 'project',
      source: 'phrase',
    });

    mockTrack.mockClear();
    await user.click(screen.getByRole('button', { name: 'book a consultation' }));
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_MODE_CHANGED, {
      mode: 'consultation',
      source: 'tail',
    });
  });

  it('the tail button always names and selects the OTHER mode', () => {
    renderHeroSearch();
    expect(screen.getByRole('button', { name: 'start a project' })).toBeInTheDocument();
  });

  it('project mode swaps the submit label, the input aria-label and shows the hint — query and chips survive the switch', async () => {
    renderHeroSearch();

    await userEvent
      .setup()
      .type(
        screen.getByRole('textbox', { name: /Describe what you need help with/i }),
        'fix a broken Flow'
      );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Agentforce' }));
    expect(screen.queryByText(HERO_MODE_COPY.projectHint)).not.toBeInTheDocument();

    await switchToProjectMode();

    expect(screen.getByRole('button', { name: HERO_MODE_COPY.submit.project })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: HERO_MODE_COPY.projectInputLabel('Salesforce') })
    ).toHaveValue('fix a broken Flow');
    expect(screen.getByText(HERO_MODE_COPY.projectHint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agentforce' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('renders the project hint as a sibling of <output>, never inside it (only phrasing content is allowed there)', async () => {
    const { container } = renderHeroSearch();
    await switchToProjectMode();

    const output = container.querySelector('output');
    if (!output) throw new Error('expected an <output> live region');
    expect(output.querySelector('.mk-mode-hint')).toBeNull();
    expect(container.querySelector('.mk-mode-hint')).not.toBeNull();
  });
});

describe('HeroSearch — BAL-582 ?intent=project', () => {
  it('preselects project mode on hydration and fires exactly one heroModeChanged("project","url"), even under StrictMode', async () => {
    globalThis.window.history.replaceState(null, '', '/?intent=project');

    render(
      <StrictMode>
        <HeroSearch
          taxonomy={taxonomy}
          productNameMap={productNameMap}
          chips={chips}
          phrases={['fix a broken Flow before lunch']}
          projectPhrases={PROJECT_PHRASES}
          verticalName="Salesforce"
          isLoggedIn
        />
      </StrictMode>
    );

    await screen.findByRole('button', { name: HERO_MODE_COPY.toggleLabel, pressed: true });

    const urlModeChanges = mockTrack.mock.calls.filter(
      ([event]) => event === MARKETING_HOME_EVENTS.HERO_MODE_CHANGED
    );
    expect(urlModeChanges).toEqual([
      [MARKETING_HOME_EVENTS.HERO_MODE_CHANGED, { mode: 'project', source: 'url' }],
    ]);
  });
});

describe('HeroSearch — BAL-582 project submit and panel seeding', () => {
  it('a project submit makes no push and fires no hero_search_submitted', async () => {
    renderHeroSearch();
    const user = await switchToProjectMode();

    await user.type(
      screen.getByRole('textbox', { name: HERO_MODE_COPY.projectInputLabel('Salesforce') }),
      'migrate us from HubSpot to Sales Cloud'
    );
    mockTrack.mockClear();
    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.submit.project }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalledWith(
      MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED,
      expect.anything()
    );
  });

  it('fires hero_project_cta_clicked with the exact payload and opens the panel with a title seed', async () => {
    renderHeroSearch({ isLoggedIn: false });
    const user = await switchToProjectMode();
    const query = 'migrate us from HubSpot to Sales Cloud';

    await user.type(
      screen.getByRole('textbox', { name: HERO_MODE_COPY.projectInputLabel('Salesforce') }),
      query
    );
    mockTrack.mockClear();
    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.submit.project }));

    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_PROJECT_CTA_CLICKED, {
      query_length: query.length,
      product_count: 0,
      signed_in: false,
      seeded_into: 'title',
      source: 'submit',
    });

    const stub = await screen.findByTestId('home-project-panel-stub');
    expect(stub).toHaveAttribute('data-open', 'true');
    expect(stub).toHaveAttribute('data-is-logged-in', 'false');
    expect(JSON.parse(stub.getAttribute('data-seed') ?? 'null')).toEqual({ title: query });
  });

  it('a query over 120 characters seeds descriptionText instead of title', async () => {
    renderHeroSearch();
    const user = await switchToProjectMode();
    const query = 'a'.repeat(121);

    await user.type(
      screen.getByRole('textbox', { name: HERO_MODE_COPY.projectInputLabel('Salesforce') }),
      query
    );
    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.submit.project }));

    const stub = await screen.findByTestId('home-project-panel-stub');
    expect(JSON.parse(stub.getAttribute('data-seed') ?? 'null')).toEqual({
      descriptionText: query,
    });
    expect(mockTrack).toHaveBeenCalledWith(
      MARKETING_HOME_EVENTS.HERO_PROJECT_CTA_CLICKED,
      expect.objectContaining({ seeded_into: 'description' })
    );
  });

  it('an empty query with no products seeds nothing ("none")', async () => {
    renderHeroSearch();
    const user = await switchToProjectMode();

    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.submit.project }));

    const stub = await screen.findByTestId('home-project-panel-stub');
    expect(stub).toHaveAttribute('data-seed', 'null');
    expect(mockTrack).toHaveBeenCalledWith(
      MARKETING_HOME_EVENTS.HERO_PROJECT_CTA_CLICKED,
      expect.objectContaining({ seeded_into: 'none' })
    );
  });

  it('closing the panel sets open to false while the host stays mounted', async () => {
    renderHeroSearch();
    const user = await switchToProjectMode();

    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.submit.project }));
    const stub = await screen.findByTestId('home-project-panel-stub');
    expect(stub).toHaveAttribute('data-open', 'true');

    await user.click(screen.getByRole('button', { name: 'close-panel-stub' }));

    expect(screen.getByTestId('home-project-panel-stub')).toHaveAttribute('data-open', 'false');
  });

  it('an empty query with a selected product still seeds { productIds }', async () => {
    renderHeroSearch();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Agentforce' }));
    const user = await switchToProjectMode();

    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.submit.project }));

    const stub = await screen.findByTestId('home-project-panel-stub');
    expect(JSON.parse(stub.getAttribute('data-seed') ?? 'null')).toEqual({
      productIds: ['agentforce-id'],
    });
  });
});

describe('HeroSearch — BAL-582 D1 resume path', () => {
  it('a valid marker (signed in) sets project mode, reopens the panel with resumeDraft, and consumes the marker', async () => {
    rememberPendingHomeProject();
    renderHeroSearch({ isLoggedIn: true });

    await screen.findByRole('button', { name: HERO_MODE_COPY.toggleLabel, pressed: true });
    const stub = await screen.findByTestId('home-project-panel-stub');
    expect(stub).toHaveAttribute('data-open', 'true');
    expect(stub).toHaveAttribute('data-resume-draft', 'true');
    expect(stub).toHaveAttribute('data-seed', 'null');
    expect(sessionStorage.getItem('balo:pending-intent:home')).toBeNull();
  });

  it('an expired marker does nothing', async () => {
    rememberPendingHomeProject(Date.now() - 31 * 60 * 1000);
    renderHeroSearch({ isLoggedIn: true });

    expect(
      screen.getByRole('button', { name: HERO_MODE_COPY.toggleLabel, pressed: false })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('home-project-panel-stub')).not.toBeInTheDocument();
  });

  it('a valid marker while signed out does nothing (resume requires isLoggedIn)', () => {
    rememberPendingHomeProject();
    renderHeroSearch({ isLoggedIn: false });

    expect(
      screen.getByRole('button', { name: HERO_MODE_COPY.toggleLabel, pressed: false })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('home-project-panel-stub')).not.toBeInTheDocument();
  });
});

describe('HeroSearch — BAL-582 intent nudge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the nudge 500ms after an eligible query, fires projectNudgeShown once, and the live region has no role attribute', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderHeroSearch();

    const output = document.querySelector('output');
    if (!output) throw new Error('expected an <output> live region');
    expect(output).not.toHaveAttribute('role');

    await user.type(
      screen.getByRole('textbox', { name: /Describe what you need help with/i }),
      ELIGIBLE_QUERY
    );
    expect(screen.queryByText(HERO_MODE_COPY.nudge.label)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByText(HERO_MODE_COPY.nudge.label)).toBeInTheDocument();
    const shownCalls = mockTrack.mock.calls.filter(
      ([event]) => event === MARKETING_HOME_EVENTS.PROJECT_NUDGE_SHOWN
    );
    expect(shownCalls).toEqual([[MARKETING_HOME_EVENTS.PROJECT_NUDGE_SHOWN, { score: 5 }]]);
  });

  it('the CTA fires projectNudgeClicked + heroModeChanged(nudge) + heroProjectCtaClicked, switches mode, opens the panel, and returns focus to the input', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderHeroSearch();
    const input = screen.getByRole('textbox', { name: /Describe what you need help with/i });

    await user.type(input, ELIGIBLE_QUERY);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    mockTrack.mockClear();

    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.nudge.cta }));

    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.PROJECT_NUDGE_CLICKED, {
      score: 5,
    });
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.HERO_MODE_CHANGED, {
      mode: 'project',
      source: 'nudge',
    });
    expect(mockTrack).toHaveBeenCalledWith(
      MARKETING_HOME_EVENTS.HERO_PROJECT_CTA_CLICKED,
      expect.objectContaining({ signed_in: true, source: 'nudge' })
    );
    expect(await screen.findByTestId('home-project-panel-stub')).toHaveAttribute(
      'data-open',
      'true'
    );
    expect(
      screen.getByRole('textbox', { name: HERO_MODE_COPY.projectInputLabel('Salesforce') })
    ).toHaveFocus();
  });

  it('the CTA opens the panel with isLoggedIn:false and the seeded query when the visitor is signed out', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderHeroSearch({ isLoggedIn: false });
    const input = screen.getByRole('textbox', { name: /Describe what you need help with/i });

    await user.type(input, ELIGIBLE_QUERY);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.nudge.cta }));

    const stub = await screen.findByTestId('home-project-panel-stub');
    expect(stub).toHaveAttribute('data-open', 'true');
    expect(stub).toHaveAttribute('data-is-logged-in', 'false');
    expect(JSON.parse(stub.getAttribute('data-seed') ?? 'null')).toEqual({
      title: ELIGIBLE_QUERY,
    });
  });

  it('dismissing fires projectNudgeDismissed, hides the pill, and returns focus to the input', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderHeroSearch();
    const input = screen.getByRole('textbox', { name: /Describe what you need help with/i });

    await user.type(input, ELIGIBLE_QUERY);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    mockTrack.mockClear();

    await user.click(screen.getByRole('button', { name: HERO_MODE_COPY.nudge.dismiss }));

    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.PROJECT_NUDGE_DISMISSED, {
      score: 5,
    });
    expect(screen.queryByText(HERO_MODE_COPY.nudge.label)).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('never shows in project mode, even with an eligible query', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderHeroSearch();
    await switchToProjectMode();

    await user.type(
      screen.getByRole('textbox', { name: HERO_MODE_COPY.projectInputLabel('Salesforce') }),
      ELIGIBLE_QUERY
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.queryByText(HERO_MODE_COPY.nudge.label)).not.toBeInTheDocument();
  });
});
