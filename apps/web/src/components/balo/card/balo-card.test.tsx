import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BaloCard, baloCardClassName } from './balo-card';

describe('BaloCard', () => {
  it('renders a flat bordered div by default', () => {
    render(<BaloCard data-testid="card">body</BaloCard>);
    const card = screen.getByTestId('card');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveClass('bg-card', 'rounded-2xl', 'border', 'border-border');
    expect(card.className).not.toMatch(/shadow/);
  });

  it('uses the primary-tinted border for the highlight emphasis', () => {
    render(
      <BaloCard emphasis="highlight" data-testid="card">
        body
      </BaloCard>
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass('border-primary/40');
    expect(card).not.toHaveClass('border-border');
  });

  it('lets className override the radius', () => {
    render(
      <BaloCard className="rounded-[14px] p-6" data-testid="card">
        body
      </BaloCard>
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass('rounded-[14px]', 'p-6');
    expect(card).not.toHaveClass('rounded-2xl');
  });

  it.each(['section', 'article'] as const)('renders as %s and forwards attributes', (tag) => {
    render(
      <BaloCard as={tag} aria-labelledby="h" data-x="1" data-testid="card">
        body
      </BaloCard>
    );
    const card = screen.getByTestId('card');
    expect(card.tagName).toBe(tag.toUpperCase());
    expect(card).toHaveAttribute('aria-labelledby', 'h');
    expect(card).toHaveAttribute('data-x', '1');
  });
});

describe('baloCardClassName', () => {
  it('returns the highlight class set without any shadow', () => {
    const cls = baloCardClassName('highlight');
    expect(cls.split(' ').sort()).toEqual(
      ['bg-card', 'rounded-2xl', 'border', 'border-primary/40'].sort()
    );
    expect(cls).not.toContain('shadow');
  });

  it('defaults to the border-border set', () => {
    expect(baloCardClassName()).toContain('border-border');
  });
});
