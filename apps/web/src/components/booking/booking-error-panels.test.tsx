import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import {
  BookingBalancePanel,
  ExpertUnavailablePanel,
  FundingSetupPanel,
  bookingSwitchFailedCopy,
  caseSavedCopy,
  type BookingBalancePanelProps,
} from './booking-error-panels';

const COMPANY = 'Northwind Industrial';
const CASE_SAVED = { caseTitle: 'Migration planning', expertLabel: 'CloudPeak' } as const;

type HoldOverrides = Partial<Extract<BookingBalancePanelProps, { variant: 'hold' }>>;
type ReservedOverrides = Partial<Extract<BookingBalancePanelProps, { variant: 'reserved' }>>;

function holdProps(overrides: HoldOverrides = {}): BookingBalancePanelProps {
  return {
    variant: 'hold',
    topUpNeededMinor: 27_500,
    amountExceedsSingleTopUp: false,
    canManageBilling: true,
    companyName: COMPANY,
    companyIsActive: true,
    caseSaved: null,
    isSwitching: false,
    onTopUp: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function reservedProps(overrides: ReservedOverrides = {}): BookingBalancePanelProps {
  return {
    variant: 'reserved',
    topUpNeededMinor: 7_500,
    amountExceedsSingleTopUp: false,
    reservedBookingCount: 2,
    canManageBilling: true,
    companyName: COMPANY,
    companyIsActive: true,
    caseSaved: null,
    isSwitching: false,
    onTopUp: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function renderedBody(container: HTMLElement): string {
  return container.querySelector('p')?.textContent ?? '';
}

describe('BookingBalancePanel — hold variant (D6.1), copy v2.1 §1a verbatim', () => {
  it('manager, figure', () => {
    const { container } = render(<BookingBalancePanel {...holdProps()} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'One thing to settle first'
    );
    expect(renderedBody(container)).toBe(
      "Northwind Industrial's balance needs a top-up of A$275.00 or more before new consultations can be booked. Consultations already booked aren't affected."
    );
  });

  it('manager, large (a figure above the single top-up maximum)', () => {
    const { container } = render(
      <BookingBalancePanel
        {...holdProps({ topUpNeededMinor: 1_250_000, amountExceedsSingleTopUp: true })}
      />
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'One thing to settle first'
    );
    expect(renderedBody(container)).toBe(
      "Northwind Industrial's balance needs top-ups totalling A$12,500.00 or more before new consultations can be booked — each top-up can be up to A$10,000. Consultations already booked aren't affected."
    );
  });

  it('manager, failed-heal fallback — no figure at all', () => {
    const { container } = render(
      <BookingBalancePanel {...holdProps({ topUpNeededMinor: null })} />
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'An earlier hold is still clearing'
    );
    expect(renderedBody(container)).toBe(
      "An earlier hold is still on Northwind Industrial's account, although the balance already covers it. It lifts automatically within a day, or at once with any top-up. Consultations already booked aren't affected."
    );
    expect(container.textContent).not.toContain('A$');
  });

  it('member, figure — plain members SEE the figure (owner checkpoint 1)', () => {
    const { container } = render(
      <BookingBalancePanel {...holdProps({ canManageBilling: false })} />
    );
    expect(renderedBody(container)).toBe(
      "Northwind Industrial's balance needs a top-up of A$275.00 or more before new consultations can be booked. Your billing admins have been notified. Consultations already booked aren't affected."
    );
  });

  it('member, large', () => {
    const { container } = render(
      <BookingBalancePanel
        {...holdProps({
          canManageBilling: false,
          topUpNeededMinor: 1_000_001,
          amountExceedsSingleTopUp: true,
        })}
      />
    );
    expect(renderedBody(container)).toBe(
      "Northwind Industrial's balance needs top-ups totalling A$10,000.01 or more before new consultations can be booked. Your billing admins have been notified. Consultations already booked aren't affected."
    );
  });

  it('member, failed-heal fallback', () => {
    const { container } = render(
      <BookingBalancePanel {...holdProps({ canManageBilling: false, topUpNeededMinor: null })} />
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'An earlier hold is still clearing'
    );
    expect(renderedBody(container)).toBe(
      "An earlier hold is still on Northwind Industrial's account, although the balance already covers it. It lifts automatically within a day, or at once with any top-up. Your billing admins have been notified."
    );
    expect(container.textContent).not.toContain('A$');
  });

  it('the "top-ups totalling" wording follows the parent\'s amountExceedsSingleTopUp flag, not a figure the panel recomputes', () => {
    const { container, rerender } = render(
      <BookingBalancePanel {...holdProps({ amountExceedsSingleTopUp: true })} />
    );
    expect(renderedBody(container)).toContain('needs top-ups totalling A$275.00 or more');

    rerender(
      <BookingBalancePanel
        {...holdProps({ topUpNeededMinor: 1_250_000, amountExceedsSingleTopUp: false })}
      />
    );
    expect(renderedBody(container)).toContain('needs a top-up of A$12,500.00 or more');
    expect(renderedBody(container)).not.toContain('top-ups totalling');
  });

  it('a null company name reads "Your team" at the start of a sentence and "your team" elsewhere', () => {
    const { container, rerender } = render(
      <BookingBalancePanel {...holdProps({ companyName: null })} />
    );
    expect(renderedBody(container)).toMatch(/^Your team's balance needs a top-up of A\$275\.00/);

    rerender(<BookingBalancePanel {...holdProps({ companyName: null, topUpNeededMinor: null })} />);
    expect(renderedBody(container)).toMatch(/^An earlier hold is still on your team's account/);
  });
});

describe('BookingBalancePanel — reserved variant (D6.5), copy v2.1 §1b verbatim', () => {
  it('manager: names the COUNT only, and the balance still shows in full', () => {
    const { container } = render(<BookingBalancePanel {...reservedProps()} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      "Part of Northwind Industrial's balance is set aside for planned consultations"
    );
    expect(renderedBody(container)).toBe(
      "Part of Northwind Industrial's balance is set aside for 2 upcoming consultations, so there isn't enough left to book this one. A top-up of A$75.00 or more would make room for it. Northwind Industrial's balance still shows in full — nothing has been taken for the planned consultations yet."
    );
  });

  it('manager, large', () => {
    const { container } = render(
      <BookingBalancePanel
        {...reservedProps({ topUpNeededMinor: 1_250_000, amountExceedsSingleTopUp: true })}
      />
    );
    expect(renderedBody(container)).toBe(
      "Part of Northwind Industrial's balance is set aside for 2 upcoming consultations, so there isn't enough left to book this one. Top-ups totalling A$12,500.00 or more would make room for it — each top-up can be up to A$10,000. Northwind Industrial's balance still shows in full — nothing has been taken for the planned consultations yet."
    );
  });

  it('member: no figure in the sentence, billing admins told', () => {
    const { container } = render(
      <BookingBalancePanel {...reservedProps({ canManageBilling: false })} />
    );
    expect(renderedBody(container)).toBe(
      "Part of Northwind Industrial's balance is set aside for 2 upcoming consultations, so there isn't enough left to book this one. Your billing admins have been notified. Northwind Industrial's balance still shows in full — nothing has been taken for the planned consultations yet."
    );
  });

  it('member, a figure above the maximum: the member body names no figure, so it does not change', () => {
    const { container } = render(
      <BookingBalancePanel
        {...reservedProps({
          canManageBilling: false,
          topUpNeededMinor: 2_000_000,
          amountExceedsSingleTopUp: true,
        })}
      />
    );
    expect(renderedBody(container)).toContain('Your billing admins have been notified.');
    expect(container.textContent).not.toContain('A$');
  });

  it('the count is singular for one planned consultation', () => {
    const { container } = render(
      <BookingBalancePanel {...reservedProps({ reservedBookingCount: 1 })} />
    );
    expect(renderedBody(container)).toContain('set aside for 1 upcoming consultation, so');
    expect(renderedBody(container)).not.toContain('consultations, so');
  });

  it('a null company name: "Part of your team\'s balance" … "Your team\'s balance still shows in full"', () => {
    const { container } = render(<BookingBalancePanel {...reservedProps({ companyName: null })} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      "Part of your team's balance is set aside for planned consultations"
    );
    expect(renderedBody(container)).toContain("Your team's balance still shows in full");
  });

  it('names no other booking: no expert, no time, no booker', () => {
    const { container } = render(<BookingBalancePanel {...reservedProps()} />);
    expect(container.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(container.textContent).not.toContain('CloudPeak');
  });
});

describe('BookingBalancePanel — buttons (copy v2.1 §1c)', () => {
  it('manager on the held company: "Top up" and "I\'ll do this later"', async () => {
    const user = userEvent.setup();
    const props = holdProps({ onTopUp: vi.fn(), onClose: vi.fn() });
    render(<BookingBalancePanel {...props} />);

    await user.click(screen.getByRole('button', { name: 'Top up' }));
    expect(props.onTopUp).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: "I'll do this later" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('manager, held company NOT active: "Switch to {Company} and top up"', () => {
    render(<BookingBalancePanel {...holdProps({ companyIsActive: false })} />);
    expect(
      screen.getByRole('button', { name: 'Switch to Northwind Industrial and top up' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Top up' })).not.toBeInTheDocument();
  });

  it('manager, not active, name unavailable: "Switch company and top up"', () => {
    render(<BookingBalancePanel {...holdProps({ companyIsActive: false, companyName: null })} />);
    expect(screen.getByRole('button', { name: 'Switch company and top up' })).toBeInTheDocument();
  });

  it('manager, mid-switch: the primary is disabled and busy, and "I\'ll do this later" is disabled too', async () => {
    const user = userEvent.setup();
    const props = holdProps({ companyIsActive: false, isSwitching: true, onClose: vi.fn() });
    render(<BookingBalancePanel {...props} />);
    const primary = screen.getByRole('button', {
      name: 'Switch to Northwind Industrial and top up',
    });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAttribute('aria-busy', 'true');
    // Closing mid-switch would strand the user on /billing/top-up once the switch commits.
    const later = screen.getByRole('button', { name: "I'll do this later" });
    expect(later).toBeDisabled();
    await user.click(later);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('positive control: the same manager, not switching, has ENABLED buttons and is not busy', async () => {
    const user = userEvent.setup();
    const props = holdProps({ companyIsActive: false, onClose: vi.fn() });
    render(<BookingBalancePanel {...props} />);
    const primary = screen.getByRole('button', {
      name: 'Switch to Northwind Industrial and top up',
    });
    expect(primary).toBeEnabled();
    expect(primary).toHaveAttribute('aria-busy', 'false');
    const later = screen.getByRole('button', { name: "I'll do this later" });
    expect(later).toBeEnabled();
    await user.click(later);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('member: only "Got it" — NO dead-end top-up button', async () => {
    const user = userEvent.setup();
    const props = holdProps({ canManageBilling: false, onClose: vi.fn() });
    render(<BookingBalancePanel {...props} />);

    expect(screen.queryByRole('button', { name: /top up/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onTopUp).not.toHaveBeenCalled();
  });

  it('bookingSwitchFailedCopy names the company, or says "companies" when the name is unavailable', () => {
    expect(bookingSwitchFailedCopy(COMPANY)).toBe(
      "We couldn't switch to Northwind Industrial. Please try again."
    );
    expect(bookingSwitchFailedCopy(null)).toBe("We couldn't switch companies. Please try again.");
  });
});

describe('the case-saved line (copy v2.1 §8)', () => {
  const EXPECTED =
    '"Migration planning" is saved in your Cases — choose it when you book with CloudPeak again.';

  it('caseSavedCopy is the drafted sentence', () => {
    expect(caseSavedCopy(CASE_SAVED)).toBe(EXPECTED);
  });

  it.each([
    ['hold', holdProps({ caseSaved: CASE_SAVED })],
    ['reserved', reservedProps({ caseSaved: CASE_SAVED })],
  ])('renders on the %s balance panel when the case was written', (_variant, props) => {
    render(<BookingBalancePanel {...props} />);
    expect(screen.getByText(EXPECTED)).toBeInTheDocument();
  });

  it('is absent when the refusal came before any write (caseSaved null)', () => {
    const { container } = render(<BookingBalancePanel {...holdProps()} />);
    expect(container.textContent).not.toContain('is saved in your Cases');
  });

  it('renders on FundingSetupPanel too, and only when set', () => {
    const { container, rerender } = render(
      <FundingSetupPanel
        canManageBilling
        onManageBilling={vi.fn()}
        onClose={vi.fn()}
        caseSaved={CASE_SAVED}
      />
    );
    expect(screen.getByText(EXPECTED)).toBeInTheDocument();

    rerender(<FundingSetupPanel canManageBilling onManageBilling={vi.fn()} onClose={vi.fn()} />);
    expect(container.textContent).not.toContain('is saved in your Cases');
  });

  it('never promises the next booking resumes by itself', () => {
    const { container } = render(<BookingBalancePanel {...holdProps({ caseSaved: CASE_SAVED })} />);
    expect(container.textContent).not.toMatch(/right where you left off|pick up|resume/i);
  });
});

describe('BookingBalancePanel — words that must never appear', () => {
  const PANELS: ReadonlyArray<readonly [string, BookingBalancePanelProps]> = [
    ['hold manager', holdProps()],
    ['hold member', holdProps({ canManageBilling: false })],
    ['hold fallback', holdProps({ topUpNeededMinor: null })],
    ['hold large', holdProps({ topUpNeededMinor: 5_000_000, amountExceedsSingleTopUp: true })],
    ['reserved manager', reservedProps()],
    ['reserved member', reservedProps({ canManageBilling: false })],
  ];

  it.each(PANELS)(
    '%s carries no banned phrase, no /billing link and no A$0.00',
    (_label, props) => {
      const { container } = render(<BookingBalancePanel {...props} />);
      const text = container.textContent ?? '';
      for (const banned of [
        'overdraft',
        'extra time',
        'straight away',
        'nothing else to do',
        'a booking is waiting',
        'clears the way',
        'A$0.00',
      ]) {
        expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
      }
      expect(container.querySelector('a')).toBeNull();
    }
  );
});

describe('ExpertUnavailablePanel', () => {
  it('names the expert by first name, offers an introduction, and closes', async () => {
    const onClose = vi.fn();
    render(<ExpertUnavailablePanel expertFirstName="Priya" onClose={onClose} />);
    expect(screen.getByText("Priya isn't taking on new work right now.")).toBeInTheDocument();
    expect(
      screen.getByText('We can introduce you to someone with similar experience.')
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to "This expert" and never offers a retry', () => {
    render(<ExpertUnavailablePanel expertFirstName={null} onClose={vi.fn()} />);
    expect(screen.getByText("This expert isn't taking on new work right now.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('leads with "Find a similar expert" when a search link is supplied, keeping Close', () => {
    render(
      <ExpertUnavailablePanel
        expertFirstName="Priya"
        similarExpertsHref="/experts?vertical=salesforce"
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: 'Find a similar expert' })).toHaveAttribute(
      'href',
      '/experts?vertical=salesforce'
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows no similar-expert link when none is supplied', () => {
    render(<ExpertUnavailablePanel expertFirstName="Priya" onClose={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Find a similar expert' })).not.toBeInTheDocument();
  });
});
