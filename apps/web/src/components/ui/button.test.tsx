import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { Button } from './button';

describe('Button — gradient variant (BAL-502)', () => {
  it('carries the blue→violet gradient class fragments and the data-variant attribute', () => {
    render(<Button variant="gradient">Get started</Button>);
    const button = screen.getByRole('button', { name: 'Get started' });
    expect(button.className).toContain('bg-gradient-to-r');
    expect(button.className).toContain('from-primary');
    expect(button.className).toContain('to-violet-600');
    expect(button.className).toContain('dark:to-violet-500');
    expect(button.className).toContain('text-white');
    expect(button).toHaveAttribute('data-variant', 'gradient');
  });

  it('leaves an existing variant unchanged (additive-only claim)', () => {
    render(<Button variant="outline">Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('border');
    expect(button.className).toContain('bg-background');
    expect(button).toHaveAttribute('data-variant', 'outline');
  });
});
