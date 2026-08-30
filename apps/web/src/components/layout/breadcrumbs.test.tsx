import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

// A mutable module-level pathname the mocked `usePathname` reads live, so a test can flip the
// route mid-test (`pathname = '/next-route'`) and re-render to exercise a navigation.
let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { Breadcrumbs } from './breadcrumbs';
import { BreadcrumbProvider, EntityCrumb } from './breadcrumb-context';

beforeEach(() => {
  pathname = '/dashboard';
});

describe('Breadcrumbs', () => {
  it('a list route resolves to exactly one crumb, rendered as the current-page h1, with no link', () => {
    pathname = '/consultations';
    render(
      <BreadcrumbProvider>
        <Breadcrumbs />
      </BreadcrumbProvider>
    );

    const nav = screen.getByLabelText('Breadcrumb');
    const heading = within(nav).getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Consultations');
    expect(heading).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });

  it('an entity route with a published label renders two crumbs; the parent crumb navigates', () => {
    pathname = '/cases/e-1';
    render(
      <BreadcrumbProvider>
        <EntityCrumb label="Case #1042" />
        <Breadcrumbs />
      </BreadcrumbProvider>
    );

    const nav = screen.getByLabelText('Breadcrumb');
    const parentLink = within(nav).getByRole('link', { name: 'Consultations' });
    expect(parentLink).toHaveAttribute('href', '/consultations');
    expect(within(nav).getByRole('heading', { level: 1 })).toHaveTextContent('Case #1042');
  });

  it('anti-staleness A (unmount path): a label is cleared when its publisher unmounts', () => {
    pathname = '/cases/e-1';
    function Harness({ showPublisher }: Readonly<{ showPublisher: boolean }>): React.JSX.Element {
      return (
        <BreadcrumbProvider>
          {showPublisher && <EntityCrumb label="Case #1042" />}
          <Breadcrumbs />
        </BreadcrumbProvider>
      );
    }

    const { rerender } = render(<Harness showPublisher />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Case #1042');

    pathname = '/consultations';
    rerender(<Harness showPublisher={false} />);

    expect(screen.queryByText('Case #1042')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Consultations');
  });

  it('anti-staleness B — THE GUARANTEE (D12): a stale label never leaks onto a new pathname, even with its publisher left mounted', () => {
    pathname = '/cases/e-1';
    function Harness(): React.JSX.Element {
      return (
        <BreadcrumbProvider>
          <EntityCrumb label="Case #1042" />
          <Breadcrumbs />
        </BreadcrumbProvider>
      );
    }

    const { rerender } = render(<Harness />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Case #1042');

    // The publisher is deliberately NOT removed from the tree on this rerender — the SAME
    // `EntityCrumb` instance is reconciled, never unmounted. This is the assertion that proves
    // the guarantee is the render-time pathname check, not cleanup ordering: it fails on any
    // effect-cleanup-only design, because cleanup never runs here.
    pathname = '/cases/e-2';
    rerender(<Harness />);

    expect(screen.queryByText('Case #1042')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Consultations');
  });

  it('BAL-499 F2: an unmounting stale publisher does NOT clear a DIFFERENT entity that has since published (the `clear` guard is ordering-proof)', () => {
    // Proof this guard matters: replacing `clear`'s guard with an unconditional `setRecord(null)`
    // makes every OTHER test in this file still pass, because they only ever clear a record that
    // still matches. This test constructs the one interleaving the guard exists for: publisher B
    // publishes for a NEW pathname BEFORE stale publisher A's cleanup runs, so when A's cleanup
    // finally fires, the stored record is no longer A's — it must be left alone.
    pathname = '/cases/e-1';
    function Harness({
      showA,
      showB,
    }: Readonly<{ showA: boolean; showB: boolean }>): React.JSX.Element {
      return (
        <BreadcrumbProvider>
          {showA && <EntityCrumb label="Case A" />}
          {showB && <EntityCrumb label="Case B" />}
          <Breadcrumbs />
        </BreadcrumbProvider>
      );
    }

    // 1. Publisher A mounts at /cases/e-1 and publishes.
    const { rerender } = render(<Harness showA showB={false} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Case A');

    // 2. Navigate to /cases/e-2: publisher B mounts and publishes BEFORE A unmounts — A is
    // deliberately kept in the tree on this rerender so its cleanup has not run yet.
    pathname = '/cases/e-2';
    rerender(<Harness showA showB />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Case B');

    // 3. NOW A unmounts. Its cleanup calls `clear('/cases/e-1')` — the pathname it was frozen
    // to. The stored record is B's (`/cases/e-2`), so the guard must refuse to clear it.
    rerender(<Harness showA={false} showB />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Case B');
    expect(screen.queryByText('Case A')).not.toBeInTheDocument();
  });

  it('BAL-499 F2: publish() bails out (no-op) when the record already matches — covers the true arm at :70', () => {
    // Two publishers agreeing on the identical pathname + label exercise the SECOND publish()
    // call's bail-out branch (`prev` already equals `next`, so the reducer returns `prev`
    // unchanged rather than constructing a new record) — the one branch the other tests in this
    // file never reach, since they only ever publish a pathname/label pair once.
    pathname = '/cases/e-1';
    render(
      <BreadcrumbProvider>
        <EntityCrumb label="Case #1042" />
        <EntityCrumb label="Case #1042" />
        <Breadcrumbs />
      </BreadcrumbProvider>
    );

    const nav = screen.getByLabelText('Breadcrumb');
    expect(within(nav).getByRole('heading', { level: 1 })).toHaveTextContent('Case #1042');
  });

  it.each(['', '   ', '\t\n'])(
    'BAL-499 F6: an empty or whitespace-only label (%j) does NOT publish — falls back to the parent crumb',
    (blankLabel) => {
      pathname = '/cases/e-1';
      render(
        <BreadcrumbProvider>
          <EntityCrumb label={blankLabel} />
          <Breadcrumbs />
        </BreadcrumbProvider>
      );

      const nav = screen.getByLabelText('Breadcrumb');
      // No empty <h1> + dangling chevron — exactly one crumb, the parent, as a link.
      const heading = within(nav).getByRole('heading', { level: 1 });
      expect(heading).toHaveTextContent('Consultations');
      expect(within(heading).getByRole('link', { name: 'Consultations' })).toHaveAttribute(
        'href',
        '/consultations'
      );
      expect(within(nav).queryAllByRole('link')).toHaveLength(1);
    }
  );

  it('BAL-499 F6: a label with leading/trailing whitespace publishes TRIMMED', () => {
    pathname = '/cases/e-1';
    render(
      <BreadcrumbProvider>
        <EntityCrumb label="  Case #1042  " />
        <Breadcrumbs />
      </BreadcrumbProvider>
    );

    const nav = screen.getByLabelText('Breadcrumb');
    const heading = within(nav).getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Case #1042');
  });

  it('an entity route with no publisher at all still shows the parent crumb as a link (the way back is never lost)', () => {
    pathname = '/cases/e-1';
    render(
      <BreadcrumbProvider>
        <Breadcrumbs />
      </BreadcrumbProvider>
    );

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Consultations');
    expect(within(heading).getByRole('link', { name: 'Consultations' })).toHaveAttribute(
      'href',
      '/consultations'
    );
  });

  it('an unrecognised route renders nothing', () => {
    pathname = '/nope';
    render(
      <BreadcrumbProvider>
        <Breadcrumbs />
      </BreadcrumbProvider>
    );

    expect(screen.queryByLabelText('Breadcrumb')).not.toBeInTheDocument();
  });

  it('renders the route trail even outside a BreadcrumbProvider (keeps sidebar.test.tsx green)', () => {
    pathname = '/dashboard';
    render(<Breadcrumbs />);
    expect(screen.getByLabelText('Breadcrumb')).toHaveTextContent('Dashboard');
  });

  it('has no accessibility violations', async () => {
    pathname = '/cases/e-1';
    const { container } = render(
      <BreadcrumbProvider>
        <EntityCrumb label="Case #1042" />
        <Breadcrumbs />
      </BreadcrumbProvider>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
