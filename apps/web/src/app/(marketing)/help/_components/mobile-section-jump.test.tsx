import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import * as jump from './jump-to-section';
import { MobileSectionJump } from './mobile-section-jump';

const { listOpenAtJump } = vi.hoisted(() => ({ listOpenAtJump: vi.fn() }));

vi.mock('./jump-to-section', async () => {
  const actual = await vi.importActual<typeof import('./jump-to-section')>('./jump-to-section');
  return {
    jumpToSection: vi.fn((slug: string, n: number) => {
      listOpenAtJump(document.getElementById('help-jump') !== null);
      actual.jumpToSection(slug, n);
    }),
  };
});

const steps = [
  { n: 1, title: 'Open the profile' },
  { n: 2, title: 'Pick a time' },
];

beforeEach(() => {
  vi.clearAllMocks();
  const el = document.createElement('section');
  el.id = 'step-2';
  el.scrollIntoView = vi.fn();
  document.body.appendChild(el);
});

describe('MobileSectionJump', () => {
  it('is collapsed by default and toggles with aria-expanded', async () => {
    render(<MobileSectionJump slug="booking" steps={steps} />);
    const toggle = screen.getByRole('button', { name: /In this guide/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(toggle).toHaveTextContent('2 sections');
    expect(screen.queryByText('Pick a time')).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'help-jump');
    expect(screen.getByText('Pick a time')).toBeInTheDocument();
  });

  it('closes and tracks the jump when a section is picked', async () => {
    render(<MobileSectionJump slug="booking" steps={steps} />);
    await userEvent.click(screen.getByRole('button', { name: /In this guide/ }));

    await userEvent.click(screen.getByRole('button', { name: /Pick a time/ }));

    expect(screen.queryByText('Pick a time')).not.toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.SECTION_JUMPED, { slug: 'booking', section: 2 });
  });

  it('collapses the list before the jump measures the page', async () => {
    render(<MobileSectionJump slug="booking" steps={steps} />);
    await userEvent.click(screen.getByRole('button', { name: /In this guide/ }));

    await userEvent.click(screen.getByRole('button', { name: /Pick a time/ }));

    expect(jump.jumpToSection).toHaveBeenCalledWith('booking', 2);
    expect(listOpenAtJump).toHaveBeenCalledWith(false);
  });

  it('uses the singular for one section', () => {
    render(<MobileSectionJump slug="booking" steps={[{ n: 1, title: 'Only' }]} />);
    expect(screen.getByRole('button', { name: /In this guide/ })).toHaveTextContent('1 section');
  });
});
