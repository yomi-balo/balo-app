import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  SendToSelector,
  ExpertUnavailableNotice,
  type ProjectRequestExpert,
} from './send-to-selector';

const EXPERT: ProjectRequestExpert = {
  name: 'Priya Sharma',
  firstName: 'Priya',
  initials: 'PS',
  avatarKey: null,
  headline: 'Salesforce Solution Architect',
  availableForWork: true,
};
const HELPER = 'Priya will review your brief and reply with a proposal.';

describe('SendToSelector — context-free (no expert)', () => {
  it('renders a static "Find me an expert" block with nothing to choose', () => {
    render(<SendToSelector value="match" onChange={vi.fn()} helperText="Matching copy." />);
    expect(screen.getByText('Find me an expert')).toBeInTheDocument();
    expect(screen.getByText("We'll match you with the right fit.")).toBeInTheDocument();
    expect(screen.getByText('Matching copy.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('stays a static match block even if handed a stale Direct value', () => {
    render(<SendToSelector value="direct" onChange={vi.fn()} helperText="Matching copy." />);
    expect(screen.getByText('Find me an expert')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SendToSelector value="match" onChange={vi.fn()} helperText="Matching copy." />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SendToSelector — expert-bound', () => {
  it('pins the expert card on Direct: name, headline and initials', () => {
    render(
      <SendToSelector value="direct" onChange={vi.fn()} expert={EXPERT} helperText={HELPER} />
    );
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Salesforce Solution Architect')).toBeInTheDocument();
    expect(screen.getByText('PS')).toBeInTheDocument();
    expect(screen.getByText(HELPER)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('renders no headline line when the headline is null', () => {
    render(
      <SendToSelector
        value="direct"
        onChange={vi.fn()}
        expert={{ ...EXPERT, headline: null }}
        helperText={HELPER}
      />
    );
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.queryByText('Salesforce Solution Architect')).not.toBeInTheDocument();
  });

  it('offers to switch to matching on Direct, and calls onChange("match")', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SendToSelector value="direct" onChange={onChange} expert={EXPERT} helperText={HELPER} />
    );
    await user.click(screen.getByRole('button', { name: 'Get matched with someone else instead' }));
    expect(onChange).toHaveBeenCalledWith('match');
  });

  it('shows the match block on Match with a way back, and calls onChange("direct")', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SendToSelector value="match" onChange={onChange} expert={EXPERT} helperText="Match." />
    );
    expect(screen.getByText('Find me an expert')).toBeInTheDocument();
    expect(screen.queryByText('Priya Sharma')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send to Priya instead' }));
    expect(onChange).toHaveBeenCalledWith('direct');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SendToSelector value="direct" onChange={vi.fn()} expert={EXPERT} helperText={HELPER} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SendToSelector — expert not taking on new work', () => {
  const UNAVAILABLE = { ...EXPERT, availableForWork: false };

  it('shows the notice on Direct and hides the toggle', () => {
    render(
      <SendToSelector value="direct" onChange={vi.fn()} expert={UNAVAILABLE} helperText={HELPER} />
    );
    expect(screen.getByText("Priya isn't taking on new work right now.")).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Get matched with someone else instead' })
    ).not.toBeInTheDocument();
  });

  it('renders no helper line while Direct is blocked, but shows it on Match', () => {
    const { rerender } = render(
      <SendToSelector value="direct" onChange={vi.fn()} expert={UNAVAILABLE} helperText={HELPER} />
    );
    expect(screen.queryByText(HELPER)).not.toBeInTheDocument();
    rerender(
      <SendToSelector value="match" onChange={vi.fn()} expert={UNAVAILABLE} helperText="Match." />
    );
    expect(screen.getByText('Match.')).toBeInTheDocument();
  });

  it('wraps the recipient block in a polite live region', () => {
    render(
      <SendToSelector value="direct" onChange={vi.fn()} expert={UNAVAILABLE} helperText={HELPER} />
    );
    const region = screen.getByText('Priya Sharma').closest('[aria-live]');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toContainElement(screen.getByRole('button', { name: 'Get matched instead' }));
  });

  it('"Get matched instead" calls onChange("match")', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SendToSelector value="direct" onChange={onChange} expert={UNAVAILABLE} helperText={HELPER} />
    );
    await user.click(screen.getByRole('button', { name: 'Get matched instead' }));
    expect(onChange).toHaveBeenCalledWith('match');
  });

  it('shows no notice on Match but keeps "Send to Priya instead"', () => {
    render(
      <SendToSelector value="match" onChange={vi.fn()} expert={UNAVAILABLE} helperText="Match." />
    );
    expect(screen.queryByText(/isn't taking on new work/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Priya instead' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SendToSelector value="direct" onChange={vi.fn()} expert={UNAVAILABLE} helperText={HELPER} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ExpertUnavailableNotice', () => {
  it('renders the copy and fires onMatchInstead', async () => {
    const user = userEvent.setup();
    const onMatchInstead = vi.fn();
    render(<ExpertUnavailableNotice firstName="Priya" onMatchInstead={onMatchInstead} />);
    expect(screen.getByText("Priya isn't taking on new work right now.")).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your brief is saved. We can match you with someone with similar experience instead.'
      )
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Get matched instead' }));
    expect(onMatchInstead).toHaveBeenCalledTimes(1);
  });
});
