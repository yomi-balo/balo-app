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
