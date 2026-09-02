import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardBrandMark, formatCardBrand } from './CardBrandMark';

describe('formatCardBrand', () => {
  it('maps Stripe brand strings to display names', () => {
    expect(formatCardBrand('visa')).toBe('Visa');
    expect(formatCardBrand('mastercard')).toBe('Mastercard');
    expect(formatCardBrand('amex')).toBe('Amex');
  });

  it('title-cases an unrecognised brand rather than dropping it', () => {
    expect(formatCardBrand('cartes_bancaires')).toBe('Cartes_bancaires');
  });

  it('falls back to "Card" for an empty brand', () => {
    expect(formatCardBrand('')).toBe('Card');
  });
});

describe('CardBrandMark', () => {
  it('renders a short brand label for a known network', () => {
    render(<CardBrandMark brand="visa" />);
    expect(screen.getByText('Visa')).toBeInTheDocument();
  });

  it('abbreviates Mastercard in the chip while prose says the full name', () => {
    render(<CardBrandMark brand="mastercard" />);
    expect(screen.getByText('MC')).toBeInTheDocument();
    expect(formatCardBrand('mastercard')).toBe('Mastercard');
  });

  it('renders a glyph (no text) for an unknown brand', () => {
    const { container } = render(<CardBrandMark brand="unknown" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
  });

  it('uses ONLY design tokens — no hardcoded network colours (balo-ui + brand risk)', () => {
    const { container } = render(<CardBrandMark brand="visa" />);
    const chip = container.firstElementChild;
    expect(chip?.className).toContain('bg-muted');
    expect(chip?.className).toContain('text-muted-foreground');
    // A raw hex anywhere here would be both a dark-mode bug and a brand-guideline risk.
    expect(container.innerHTML).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it('is decorative — hidden from assistive tech (the row text carries the meaning)', () => {
    const { container } = render(<CardBrandMark brand="visa" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
