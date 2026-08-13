import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import CallLoading from './loading';

/**
 * BAL-435 — the call route's skeleton, mirroring BAL-132's `/join/m/[meetingId]/loading.test.tsx`.
 *
 * ⚠ THE SKELETON IS THE FRAME'S **BONES**, so it is drawn in the frame's palette — permanently
 * dark — rather than in the viewer's. In a light-mode viewer's theme it was a white top bar,
 * white toolbar circles and a white stage well that flipped to a dark call a beat later, which
 * made the real frame's arrival read as a flash rather than a resolve.
 */
describe('CallLoading', () => {
  it('announces itself with an sr-only line', () => {
    render(<CallLoading />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('⚠ uses <output>, NOT role="status" (SonarCloud S6819)', () => {
    const { container } = render(<CallLoading />);

    expect(container.querySelector('output')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('⚠⚠ carries NO aria-busy — it would suppress the announcement it looks like it helps', () => {
    const { container } = render(<CallLoading />);

    expect(container.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('⚠⚠ draws the FRAME palette, not the viewer theme', () => {
    const { container } = render(<CallLoading />);

    expect(container.querySelector('output')?.className).toContain('dark');
  });

  it('⚠ is <span> children only — an <output> is phrasing content', () => {
    // A `<div>` inside an `<output>` is invalid markup, which is why the skeleton is built from
    // spans rather than the usual divs.
    const { container } = render(<CallLoading />);

    expect(container.querySelector('output div')).toBeNull();
  });

  it('⚠ keys its toolbar circles from a fixed literal array, never an index (S6479)', () => {
    const { container } = render(<CallLoading />);

    expect(container.querySelectorAll('.rounded-full')).toHaveLength(5);
  });

  it('promises no meeting content — the route knows none at this point', () => {
    const { container } = render(<CallLoading />);
    const text = container.textContent ?? '';

    for (const forbidden of [/waiting for/i, /meeting with/i, /\bhost\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CallLoading />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
