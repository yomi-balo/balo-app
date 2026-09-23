import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChipPicker } from './chip-picker';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const OPTIONS = [
  { id: 'retail', label: 'Retail' },
  { id: 'tech', label: 'Technology' },
];

function classesOf(name: string): string[] {
  return screen.getByRole('checkbox', { name }).className.split(' ');
}

describe('ChipPicker', () => {
  it('renders each option as a checkbox reflecting the selection', () => {
    render(<ChipPicker options={OPTIONS} selected={['retail']} onChange={vi.fn()} />);

    expect(screen.getByRole('checkbox', { name: 'Retail' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('checkbox', { name: 'Technology' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('adds an unselected option and removes a selected one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipPicker options={OPTIONS} selected={['retail']} onChange={onChange} />);

    await user.click(screen.getByRole('checkbox', { name: 'Technology' }));
    expect(onChange).toHaveBeenLastCalledWith(['retail', 'tech']);

    await user.click(screen.getByRole('checkbox', { name: 'Retail' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('keeps the default chip: 32px, 1.5px border, bold when selected', () => {
    render(<ChipPicker options={OPTIONS} selected={['retail']} onChange={vi.fn()} />);

    expect(screen.getByRole('checkbox', { name: 'Retail' })).toHaveAttribute(
      'data-size',
      'default'
    );
    expect(classesOf('Retail')).toEqual(
      expect.arrayContaining(['h-8', 'border-[1.5px]', 'text-[13px]', 'font-semibold'])
    );
    expect(classesOf('Technology')).toEqual(
      expect.arrayContaining(['bg-background', 'text-muted-foreground'])
    );
  });

  it('renders the compact chip: 12.5px, 1px border, a soft tint, never bold', () => {
    render(
      <ChipPicker options={OPTIONS} selected={['retail']} onChange={vi.fn()} size="compact" />
    );

    const selected = classesOf('Retail');
    expect(screen.getByRole('checkbox', { name: 'Retail' })).toHaveAttribute(
      'data-size',
      'compact'
    );
    expect(selected).toEqual(
      expect.arrayContaining([
        'border',
        'rounded-full',
        'px-3',
        'py-1.5',
        'text-[12.5px]',
        'font-medium',
        'border-primary/40',
        'bg-primary/10',
        'text-primary',
      ])
    );
    expect(selected).not.toContain('font-semibold');
    expect(selected).not.toContain('border-[1.5px]');
    expect(selected).not.toContain('h-8');

    expect(classesOf('Technology')).toEqual(
      expect.arrayContaining(['border-border', 'bg-card', 'text-muted-foreground'])
    );
  });
});
