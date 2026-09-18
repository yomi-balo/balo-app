import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { StaffAccessPerson } from '@balo/shared/authz';

vi.mock('./staff-roster', () => ({
  StaffRoster: (props: {
    people: readonly StaffAccessPerson[];
    activePersonId: string | null;
    onSelect: (id: string) => void;
    onGiveAccess: () => void;
  }) => (
    <div data-testid="roster">
      <span data-testid="active">{props.activePersonId ?? 'none'}</span>
      {props.people.map((person) => (
        <button key={person.id} onClick={() => props.onSelect(person.id)}>
          select-{person.id}
        </button>
      ))}
      <button onClick={props.onGiveAccess}>roster-give-access</button>
    </div>
  ),
}));

vi.mock('./staff-access-detail', () => ({
  StaffAccessDetail: (props: { person: StaffAccessPerson }) => (
    <div data-testid="detail">detail-{props.person.id}</div>
  ),
}));

vi.mock('./add-staff-dialog', () => ({
  AddStaffDialog: (props: { open: boolean }) =>
    props.open ? <div data-testid="add-dialog" /> : null,
}));

vi.mock('./staff-access-states', () => ({
  StaffAccessEmptyState: (props: { onGiveAccess: () => void }) => (
    <button onClick={props.onGiveAccess}>empty-give-access</button>
  ),
}));

import { StaffAccessWorkspace } from './staff-access-workspace';

function person(overrides: Partial<StaffAccessPerson>): StaffAccessPerson {
  return {
    id: 'u1',
    firstName: 'Dana',
    lastName: 'Whitfield',
    email: 'dana@example.com',
    role: 'admin',
    customList: null,
    isLive: true,
    emailVerified: true,
    ...overrides,
  };
}

const VIEWER = person({ id: 'viewer' });
const OTHER_A = person({ id: 'other-a' });
const OTHER_B = person({ id: 'other-b' });

beforeEach(() => {
  vi.spyOn(globalThis.history, 'replaceState').mockImplementation(() => {});
});

describe('StaffAccessWorkspace — empty roster', () => {
  it('renders the empty state and opens the add dialog from it', async () => {
    const user = userEvent.setup();
    render(<StaffAccessWorkspace people={[]} viewerId="viewer" initialPersonId={null} />);
    expect(screen.getByText('empty-give-access')).toBeInTheDocument();
    expect(screen.queryByTestId('add-dialog')).not.toBeInTheDocument();
    await user.click(screen.getByText('empty-give-access'));
    expect(screen.getByTestId('add-dialog')).toBeInTheDocument();
  });
});

describe('StaffAccessWorkspace — initial selection', () => {
  it('uses initialPersonId when it is on the roster', () => {
    render(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A, OTHER_B]}
        viewerId="viewer"
        initialPersonId="other-b"
      />
    );
    expect(screen.getByTestId('active')).toHaveTextContent('other-b');
    expect(screen.getByTestId('detail')).toHaveTextContent('detail-other-b');
  });

  it('falls back to the first non-self person when initialPersonId is absent', () => {
    render(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A, OTHER_B]}
        viewerId="viewer"
        initialPersonId={null}
      />
    );
    expect(screen.getByTestId('active')).toHaveTextContent('other-a');
  });

  it('falls back to the first non-self person when initialPersonId is not on the roster', () => {
    render(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A, OTHER_B]}
        viewerId="viewer"
        initialPersonId="ghost"
      />
    );
    expect(screen.getByTestId('active')).toHaveTextContent('other-a');
  });

  it('falls back to the first person when everyone on the roster is the viewer', () => {
    render(<StaffAccessWorkspace people={[VIEWER]} viewerId="viewer" initialPersonId={null} />);
    expect(screen.getByTestId('active')).toHaveTextContent('viewer');
  });
});

describe('StaffAccessWorkspace — selection updates the URL without a server round trip', () => {
  it('calls window.history.replaceState with ?person=<id>, not router.replace', async () => {
    const user = userEvent.setup();
    render(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A, OTHER_B]}
        viewerId="viewer"
        initialPersonId="other-a"
      />
    );
    await user.click(screen.getByText('select-other-b'));
    expect(globalThis.history.replaceState).toHaveBeenCalledWith(null, '', '?person=other-b');
    expect(screen.getByTestId('active')).toHaveTextContent('other-b');
  });
});

describe('StaffAccessWorkspace — post-refresh fallback', () => {
  it('re-derives the selection when the selected person falls off a refreshed roster', () => {
    const { rerender } = render(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A, OTHER_B]}
        viewerId="viewer"
        initialPersonId="other-b"
      />
    );
    expect(screen.getByTestId('active')).toHaveTextContent('other-b');

    // `other-b` demoted off the roster entirely — the fallback rule re-derives from `people`.
    rerender(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A]}
        viewerId="viewer"
        initialPersonId="other-b"
      />
    );
    expect(screen.getByTestId('active')).toHaveTextContent('other-a');
  });

  it('does not fight a fresh manual pick when people is unchanged', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A, OTHER_B]}
        viewerId="viewer"
        initialPersonId="other-a"
      />
    );
    await user.click(screen.getByText('select-other-b'));
    expect(screen.getByTestId('active')).toHaveTextContent('other-b');

    // Same `people` reference-equal array re-passed (e.g. a parent re-render) must not reset the
    // manual pick back to the initial fallback.
    rerender(
      <StaffAccessWorkspace
        people={[VIEWER, OTHER_A, OTHER_B]}
        viewerId="viewer"
        initialPersonId="other-a"
      />
    );
    expect(screen.getByTestId('active')).toHaveTextContent('other-b');
  });
});
