import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { PLATFORM_CAPABILITIES, PLATFORM_CAPABILITY_LABELS } from '@balo/shared/authz';
import { AccessChangeSummary } from './access-change-summary';

const EMPTY = new Set<never>();

describe('AccessChangeSummary', () => {
  it('shows the role-move banner when the role changes', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="super_admin"
        before={EMPTY}
        after={EMPTY}
        customListBefore={false}
        customListAfter={false}
      />
    );
    expect(screen.getByText(/role moves from/i)).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Super admin')).toBeInTheDocument();
  });

  it('appends the leaving-the-list note when the new role is "No staff access"', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="user"
        before={EMPTY}
        after={EMPTY}
        customListBefore={false}
        customListAfter={false}
      />
    );
    expect(screen.getByText(/adeeb will leave this list/i)).toBeInTheDocument();
  });

  it('no role banner when the role is unchanged', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="admin"
        before={EMPTY}
        after={EMPTY}
        customListBefore={false}
        customListAfter={true}
      />
    );
    expect(screen.queryByText(/role moves from/i)).not.toBeInTheDocument();
  });

  it('renders a diff with + additions and − removals, using plain names', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="admin"
        before={new Set([PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES])}
        after={new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS])}
        customListBefore={true}
        customListAfter={true}
      />
    );
    const addedName = screen.getByText(
      PLATFORM_CAPABILITY_LABELS[PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS].name
    );
    const removedName = screen.getByText(
      PLATFORM_CAPABILITY_LABELS[PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES].name
    );
    // F7 (R6) — each name must sit inside the LINE carrying its sign's colour class, not just
    // appear somewhere on the page: swapping which list a name renders in must fail this test.
    expect(addedName.closest('li')).toHaveClass('text-success');
    expect(removedName.closest('li')).toHaveClass('text-destructive');
  });

  it('when only the role changed with no capability diff, says only the role label moves', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="super_admin"
        before={EMPTY}
        after={EMPTY}
        customListBefore={false}
        customListAfter={false}
      />
    );
    expect(screen.getByText(/only the role label moves/i)).toBeInTheDocument();
  });

  it('when only the mode changed to custom with an identical set, says it will no longer follow the role', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="admin"
        before={new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS])}
        after={new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS])}
        customListBefore={false}
        customListAfter={true}
      />
    );
    expect(screen.getByText(/will no longer follow the role/i)).toBeInTheDocument();
  });

  it('when switching back to follow with an identical set, says it will follow the role again', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="admin"
        before={new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS])}
        after={new Set([PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS])}
        customListBefore={true}
        customListAfter={false}
      />
    );
    expect(screen.getByText(/will follow the role again/i)).toBeInTheDocument();
  });

  it('always renders the recorded-against-your-name footer note', () => {
    render(
      <AccessChangeSummary
        firstName="Adeeb"
        roleBefore="admin"
        roleAfter="admin"
        before={EMPTY}
        after={EMPTY}
        customListBefore={false}
        customListAfter={false}
      />
    );
    expect(screen.getByText(/recorded against your name/i)).toBeInTheDocument();
  });
});
