import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import type { CaseHeaderView } from '@/lib/cases/case-view-types';
import { CaseHeader } from './case-header';

/**
 * BAL-421 — the case header.
 *
 * ⚠⚠ THE DISCLOSURE TOGGLE MUST NOT EXIST WHEN THERE IS NOTHING TO DISCLOSE. `line-clamp-3` is
 * CSS: whether it truncates depends on the rendered text and the container width, neither
 * knowable server-side. A toggle rendered unconditionally gave a one-line description a button
 * that expanded nothing, and `aria-expanded="false"` then announced a collapsed disclosure with
 * NO hidden content — a lie to a screen reader, not a stray pixel.
 *
 * ⚠ JSDOM REPORTS `scrollHeight === clientHeight === 0` FOR EVERYTHING, so overflow must be
 * SIMULATED by stubbing the two properties. That is the only honest way to test a CSS-derived
 * measurement in this environment — and it is why both the overflow and the no-overflow arms
 * are tested explicitly rather than one being assumed.
 */

const BASE: CaseHeaderView = {
  title: 'Flow interview loop',
  descriptionHtml: '<p>We need to rebuild the intake flow before the September release.</p>',
  openedAtIso: '2026-06-12T09:00:00Z',
  heldConsultationCount: 2,
  consultationCount: 3,
  isOpen: true,
  closeReason: null,
  closedAtIso: null,
  counterpartyOrgLabel: 'CloudPeak',
  closedNote: null,
};

/**
 * Make every element report `scrollHeight`/`clientHeight` as though the clamp bit (or did not).
 * Restored in `afterEach` so no other suite inherits the stub.
 */
function stubOverflow(overflows: boolean): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => (overflows ? 120 : 40),
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 40,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const property of ['scrollHeight', 'clientHeight']) {
    Reflect.deleteProperty(HTMLElement.prototype, property);
  }
});

describe('CaseHeader — the Show more toggle is gated on REAL overflow', () => {
  it('renders NO toggle when the description FITS its clamp', async () => {
    stubOverflow(false);
    render(<CaseHeader header={BASE} />);
    // The measurement runs in an effect, so give it a tick before asserting the absence.
    await waitFor(() => {
      expect(screen.getByText(/rebuild the intake flow/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show less/i })).not.toBeInTheDocument();
  });

  it('announces NO disclosure at all when nothing is hidden', async () => {
    stubOverflow(false);
    const { container } = render(<CaseHeader header={BASE} />);
    await waitFor(() => {
      expect(screen.getByText(/rebuild the intake flow/i)).toBeInTheDocument();
    });
    // The aria-expanded lie is the actual accessibility defect — assert it is gone.
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('renders the toggle when the description DOES overflow', async () => {
    stubOverflow(true);
    render(<CaseHeader header={BASE} />);
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('expands and collapses, keeping aria-expanded and aria-controls honest', async () => {
    stubOverflow(true);
    const user = userEvent.setup();
    render(<CaseHeader header={BASE} />);

    const toggle = await screen.findByRole('button', { name: 'Show more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // `aria-controls` must name a node that actually exists.
    const controlled = toggle.getAttribute('aria-controls') ?? '';
    expect(document.getElementById(controlled)).not.toBeNull();

    await user.click(toggle);
    const expanded = screen.getByRole('button', { name: 'Show less' });
    expect(expanded).toHaveAttribute('aria-expanded', 'true');

    await user.click(expanded);
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  /**
   * ⚠ THE MEASUREMENT MUST NOT RUN WHILE EXPANDED. Once expanded the clamp is gone and
   * `scrollHeight === clientHeight`, so re-measuring then would report "no overflow" and REMOVE
   * THE VERY BUTTON THE READER JUST PRESSED — stranding them expanded with no way back.
   */
  it('keeps the toggle after expanding, even though the expanded node no longer overflows', async () => {
    stubOverflow(true);
    const user = userEvent.setup();
    render(<CaseHeader header={BASE} />);

    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    // Simulate the expanded node fitting, exactly as it does once `line-clamp-3` is dropped.
    stubOverflow(false);

    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });
});

describe('CaseHeader — the record it states', () => {
  it('renders the title, the held count and the counterparty org', () => {
    stubOverflow(false);
    render(<CaseHeader header={BASE} />);
    expect(screen.getByRole('heading', { name: 'Flow interview loop' })).toBeInTheDocument();
    expect(screen.getByText(/2 consultations held/)).toBeInTheDocument();
    expect(screen.getByText('CloudPeak')).toBeInTheDocument();
  });

  it('singularises a single held consultation', () => {
    stubOverflow(false);
    render(<CaseHeader header={{ ...BASE, heldConsultationCount: 1 }} />);
    expect(screen.getByText(/1 consultation held/)).toBeInTheDocument();
  });

  it('renders the sanitised description markup', () => {
    stubOverflow(false);
    render(<CaseHeader header={BASE} />);
    expect(screen.getByText(/rebuild the intake flow/i)).toBeInTheDocument();
  });

  /**
   * ⚠ THE TWO CLOSED REASONS STAY DISTINCT. "Resolved" is something the client DID; "Closed —
   * inactive" is something that HAPPENED because nobody acted. One chip for both would tell a
   * client their case was resolved when in fact it timed out.
   */
  it.each([
    [true, null, 'Open'],
    [false, 'resolved', 'Resolved'],
    [false, 'auto_inactive', 'Closed — inactive'],
  ] as const)('chips isOpen=%s closeReason=%s as "%s"', (isOpen, closeReason, chip) => {
    stubOverflow(false);
    render(<CaseHeader header={{ ...BASE, isOpen, closeReason }} />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('never renders "Resolved" for an auto-closed case', () => {
    stubOverflow(false);
    render(<CaseHeader header={{ ...BASE, isOpen: false, closeReason: 'auto_inactive' }} />);
    expect(screen.queryByText('Resolved')).not.toBeInTheDocument();
  });

  it('renders the closed note when there is one, and nothing while open', () => {
    stubOverflow(false);
    const { unmount } = render(
      <CaseHeader
        header={{
          ...BASE,
          isOpen: false,
          closeReason: 'resolved',
          closedNote: 'Marked resolved on 12 August 2026. Everything here stays available.',
        }}
      />
    );
    expect(screen.getByText(/Everything here stays available/)).toBeInTheDocument();
    unmount();

    render(<CaseHeader header={BASE} />);
    expect(screen.queryByText(/Everything here stays available/)).not.toBeInTheDocument();
  });
});
