import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { StickyNav, type NavSection } from './sticky-nav';

const SECTIONS: NavSection[] = [
  { key: 'about', label: 'About' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'reviews', label: 'Reviews' },
];

describe('StickyNav', () => {
  it('renders one button per provided section', () => {
    render(<StickyNav sections={SECTIONS} active="about" onJump={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expertise' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reviews' })).toBeInTheDocument();
  });

  it('does not render sections it was not given (data-driven)', () => {
    render(
      <StickyNav sections={[{ key: 'about', label: 'About' }]} active="about" onJump={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: 'Work' })).not.toBeInTheDocument();
  });

  it('marks the active section with aria-current', () => {
    render(<StickyNav sections={SECTIONS} active="expertise" onJump={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Expertise' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(screen.getByRole('button', { name: 'About' })).not.toHaveAttribute('aria-current');
  });

  it('calls onJump with the section key when a tab is clicked', async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<StickyNav sections={SECTIONS} active="about" onJump={onJump} />);

    await user.click(screen.getByRole('button', { name: 'Reviews' }));
    expect(onJump).toHaveBeenCalledWith('reviews');
  });

  // BAL-502 — the marketing header is `sticky top-0 z-40`; `top-0` here would slide this
  // in-page nav underneath it instead of stacking below.
  it('sits below the marketing header rather than at the viewport top', () => {
    const { container } = render(<StickyNav sections={SECTIONS} active="about" onJump={vi.fn()} />);
    const nav = container.querySelector('nav');
    expect(nav?.className).toContain('top-14');
    expect(nav?.className).toContain('md:top-16');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<StickyNav sections={SECTIONS} active="about" onJump={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
