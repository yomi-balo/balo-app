import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { OverviewSection } from './overview-section';
import { COMPOSER_TARGET } from './proposal-composer-state';

// The full overview TipTap editor breaks in JSDOM — swap it for a textarea that
// also exposes the props the section passes through.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: (props: {
    value: string;
    onChange: (html: string) => void;
    ariaLabel?: string;
    placeholder?: string;
    variant?: string;
    collapseOnBlur?: boolean;
  }) => (
    <textarea
      aria-label={props.ariaLabel}
      placeholder={props.placeholder}
      data-variant={props.variant}
      data-collapse={String(props.collapseOnBlur === true)}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

function renderOverview(overview = ''): { onOverviewChange: ReturnType<typeof vi.fn> } {
  const onOverviewChange = vi.fn();
  render(
    <OverviewSection
      overview={overview}
      onOverviewChange={onOverviewChange}
      companyName="Northwind"
    />
  );
  return { onOverviewChange };
}

describe('OverviewSection', () => {
  it('renders the Overview heading with company-specific help', () => {
    renderOverview();
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
    expect(
      screen.getByText("What you'll do, how you'll approach it, and what Northwind can expect.")
    ).toBeInTheDocument();
  });

  it('uses the full editor variant without collapse-on-blur and a company placeholder', () => {
    renderOverview();
    const editor = screen.getByLabelText('Proposal overview');
    expect(editor).toHaveAttribute('data-variant', 'full');
    expect(editor).toHaveAttribute('data-collapse', 'false');
    expect(editor).toHaveAttribute(
      'placeholder',
      'Describe the work, your approach, and what Northwind can expect.'
    );
  });

  it('wraps the editor in the focusable, flashable jump target', () => {
    renderOverview();
    const wrapper = screen.getByLabelText('Proposal overview').parentElement;
    expect(wrapper).toHaveAttribute('id', COMPOSER_TARGET.overview);
    expect(wrapper).toHaveAttribute('data-flash');
    expect(wrapper).toHaveAttribute('tabindex', '-1');
  });

  it('forwards editor changes', async () => {
    const user = userEvent.setup();
    const { onOverviewChange } = renderOverview();
    await user.type(screen.getByLabelText('Proposal overview'), 'A');
    expect(onOverviewChange).toHaveBeenLastCalledWith('A');
  });
});

function renderDrafting(props: Partial<React.ComponentProps<typeof OverviewSection>> = {}): {
  onOverviewChange: ReturnType<typeof vi.fn>;
  onClear: ReturnType<typeof vi.fn>;
} {
  const onOverviewChange = vi.fn();
  const onClear = vi.fn();
  render(
    <OverviewSection
      overview=""
      onOverviewChange={onOverviewChange}
      companyName="Northwind"
      clientFirstName="Dana"
      onClear={onClear}
      {...props}
    />
  );
  return { onOverviewChange, onClear };
}

describe('OverviewSection — AI draft', () => {
  it('draws the skeleton and drafting line over the mounted, typeable editor', () => {
    renderDrafting({ drafting: true });
    expect(screen.getByTestId('draft-skeleton-overview')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent("Drafting from Dana's request…");
    expect(screen.getByLabelText('Proposal overview')).toBeInTheDocument();
    expect(screen.getByTestId('draft-skeleton-overview').parentElement).toHaveClass(
      'pointer-events-none'
    );
  });

  it('hides the skeleton once the editor takes focus, and forwards the typing', async () => {
    const user = userEvent.setup();
    const { onOverviewChange } = renderDrafting({ drafting: true });
    await user.type(screen.getByLabelText('Proposal overview'), 'H');
    expect(screen.queryByTestId('draft-skeleton-overview')).not.toBeInTheDocument();
    expect(onOverviewChange).toHaveBeenLastCalledWith('H');
  });

  it('draws no skeleton when not drafting', () => {
    renderDrafting();
    expect(screen.queryByTestId('draft-skeleton-overview')).not.toBeInTheDocument();
    expect(screen.queryByText(/Drafted from/)).not.toBeInTheDocument();
  });

  it('shows the badge with Clear for a drafted overview', async () => {
    const user = userEvent.setup();
    const { onClear } = renderDrafting({ overview: '<p>Hi</p>', drafted: true });
    expect(screen.getByText("Drafted from Dana's request")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear drafted overview' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('keeps the drafting line above the editor once it is focused while still drafting', async () => {
    const user = userEvent.setup();
    renderDrafting({ drafting: true });
    await user.click(screen.getByLabelText('Proposal overview'));
    expect(screen.queryByTestId('draft-skeleton-overview')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent("Drafting from Dana's request…");
  });

  it('shows no drafting line on focus when not drafting', async () => {
    const user = userEvent.setup();
    renderDrafting();
    await user.click(screen.getByLabelText('Proposal overview'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the quiet failure line verbatim', () => {
    renderDrafting({ failed: true });
    expect(screen.getByText("Couldn't draft this one. Start from scratch.")).toBeInTheDocument();
  });
});
