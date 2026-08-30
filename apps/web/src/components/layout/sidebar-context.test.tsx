import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CompanyWorkspace } from '@balo/shared/workspaces';
import type { NavContext } from './nav-registry';
import { SidebarProvider, useSidebar, useSidebarOptional } from './sidebar-context';

/**
 * BAL-496 (D13 / A10) — the ONLY test that renders the REAL `SidebarProvider`. Both
 * `sidebar.test.tsx` and `sidebar-analytics.test.tsx` mock `./sidebar-context` wholesale, so
 * nothing else in the suite executes the provider — without this file, D13's new `workspaces` /
 * `activeWorkspaceKey` lines (the `useMemo` value and its dependency array) would be new,
 * uncovered code.
 */

const COMPANY: CompanyWorkspace = {
  type: 'company',
  key: 'company:33333333-3333-4333-8333-333333333333',
  companyId: '33333333-3333-4333-8333-333333333333',
  name: 'Northwind Industrial',
  via: 'membership',
  isPersonal: false,
  role: 'owner',
};

const NAV_CONTEXT: NavContext = { workspaceType: 'company', capabilities: [] };

function Probe(): React.JSX.Element {
  const { workspaces, activeWorkspaceKey } = useSidebar();
  return (
    <div>
      <span data-testid="count">{workspaces.length}</span>
      <span data-testid="active-key">{activeWorkspaceKey ?? 'null'}</span>
    </div>
  );
}

/** Calls `useSidebar()` with NO wrapping provider — used to assert the throw. */
function UnwrappedRequiredProbe(): React.JSX.Element {
  useSidebar();
  return <div />;
}

/** Calls `useSidebarOptional()` with NO wrapping provider — used to assert the `null` return. */
function UnwrappedOptionalProbe(): React.JSX.Element {
  const ctx = useSidebarOptional();
  return <span data-testid="optional-result">{ctx === null ? 'null' : 'present'}</span>;
}

/** Fixed component identity across a `rerender` — lets the dependency-array test change only
 *  `workspaces` / `activeWorkspaceKey` between renders while every other prop stays byte-equal. */
function Harness(props: {
  workspaces: readonly CompanyWorkspace[];
  activeWorkspaceKey: string | null;
}): React.JSX.Element {
  return (
    <SidebarProvider
      activeMode="client"
      userName="Dana Lee"
      userInitials="DL"
      userAvatarUrl={null}
      checklistCompletedCount={0}
      checklistAllComplete={false}
      navContext={NAV_CONTEXT}
      workspaces={props.workspaces}
      activeWorkspaceKey={props.activeWorkspaceKey}
    >
      <Probe />
    </SidebarProvider>
  );
}

function renderProbe(props: {
  workspaces: readonly CompanyWorkspace[];
  activeWorkspaceKey: string | null;
}): ReturnType<typeof render> {
  return render(<Harness {...props} />);
}

describe('SidebarProvider — workspaces round-trip (BAL-496)', () => {
  it('exposes the supplied workspaces and activeWorkspaceKey via useSidebar()', () => {
    renderProbe({ workspaces: [COMPANY], activeWorkspaceKey: COMPANY.key });
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('active-key')).toHaveTextContent(COMPANY.key);
  });

  it('exposes an empty list and a null active key as a valid, stable state', () => {
    renderProbe({ workspaces: [], activeWorkspaceKey: null });
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(screen.getByTestId('active-key')).toHaveTextContent('null');
  });

  it('useSidebar() throws outside a provider', () => {
    // React only surfaces a hook's throw when the hook runs during an actual render — calling
    // useSidebar() directly (outside a component) trips React's "invalid hook call" check
    // instead of this module's own error, so the throw is asserted through a render.
    expect(() => render(<UnwrappedRequiredProbe />)).toThrow(
      'useSidebar must be used within SidebarProvider'
    );
  });

  it('useSidebarOptional() returns null outside a provider', () => {
    render(<UnwrappedOptionalProbe />);
    expect(screen.getByTestId('optional-result')).toHaveTextContent('null');
  });

  // BAL-496 fix-round S3 — pins the `useMemo` dependency array. Every prior test in this file
  // renders once and never re-renders, so omitting `workspaces` / `activeWorkspaceKey` from the
  // dep array would leave the memo stale forever and every test above would still pass. This
  // rerenders the SAME element (`Harness`, fixed identity) with only those two props changed —
  // if either is missing from the dep array, `Probe` keeps showing the pre-rerender values and
  // the assertions below fail.
  it('re-renders when workspaces / activeWorkspaceKey change', () => {
    const OTHER: CompanyWorkspace = {
      type: 'company',
      key: 'company:44444444-4444-4444-8444-444444444444',
      companyId: '44444444-4444-4444-8444-444444444444',
      name: 'Southbend Co',
      via: 'membership',
      isPersonal: false,
      role: 'admin',
    };

    const { rerender } = renderProbe({ workspaces: [COMPANY], activeWorkspaceKey: COMPANY.key });
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('active-key')).toHaveTextContent(COMPANY.key);

    rerender(<Harness workspaces={[COMPANY, OTHER]} activeWorkspaceKey={OTHER.key} />);

    expect(screen.getByTestId('count')).toHaveTextContent('2');
    expect(screen.getByTestId('active-key')).toHaveTextContent(OTHER.key);
  });
});
