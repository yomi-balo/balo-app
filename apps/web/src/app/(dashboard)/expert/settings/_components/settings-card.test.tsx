import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { occurrences, resolveRouteDir, stripBlockComments } from '@/invariants/_source-scan';
import { SettingsCard, SettingsEyebrow, SettingsStatusPill } from './settings-card';

const APP_DIR = resolveRouteDir(['src/app', 'apps/web/src/app']);

describe('SettingsCard', () => {
  it('renders a section with its children and forwards attributes', () => {
    render(
      <SettingsCard aria-labelledby="x" className="gap-4" data-testid="card">
        <span>body</span>
      </SettingsCard>
    );
    const card = screen.getByTestId('card');
    expect(card.tagName).toBe('SECTION');
    expect(card).toHaveAttribute('aria-labelledby', 'x');
    expect(card.className).toContain('rounded-xl');
    expect(card.className).toContain('gap-4');
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});

describe('SettingsEyebrow', () => {
  it('is an h3 heading by default', () => {
    render(<SettingsEyebrow id="identity">Identity</SettingsEyebrow>);
    const heading = screen.getByRole('heading', { level: 3, name: 'Identity' });
    expect(heading).toHaveAttribute('id', 'identity');
  });

  it('renders the requested element', () => {
    render(<SettingsEyebrow as="p">Weekly hours</SettingsEyebrow>);
    expect(screen.getByText('Weekly hours').tagName).toBe('P');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('as a label, names the control it points at', () => {
    render(
      <>
        <SettingsEyebrow as="label" htmlFor="target">
          Where bookings go
        </SettingsEyebrow>
        <input id="target" />
      </>
    );
    const label = screen.getByText('Where bookings go');
    expect(label.tagName).toBe('LABEL');
    expect(label.className).toContain('uppercase');
    expect(screen.getByRole('textbox', { name: 'Where bookings go' })).toBeInTheDocument();
  });

  it('drops htmlFor on an element that is not a label', () => {
    render(
      <SettingsEyebrow as="p" htmlFor="target">
        Busy calendars
      </SettingsEyebrow>
    );
    expect(screen.getByText('Busy calendars')).not.toHaveAttribute('for');
  });
});

describe('SettingsStatusPill', () => {
  it.each([
    ['success', 'text-success-strong'],
    ['warning', 'text-warning-strong'],
    ['destructive', 'text-destructive-strong'],
    ['neutral', 'text-foreground/75'],
  ] as const)('applies the %s tone', (tone, expectedClass) => {
    render(<SettingsStatusPill tone={tone}>Label</SettingsStatusPill>);
    const pill = screen.getByText('Label');
    expect(pill).toHaveAttribute('data-tone', tone);
    expect(pill.className.split(' ')).toContain(expectedClass);
  });

  // The fill-tuned tokens fall under AA as 11px text on these backgrounds: `text-destructive`
  // on its own tint (1.87:1 in dark mode) and `text-muted-foreground` on `bg-muted` (4.31:1).
  it.each([
    ['destructive', 'text-destructive'],
    ['neutral', 'text-muted-foreground'],
  ] as const)('never spends the fill-tuned %s text token', (tone, fillToken) => {
    render(<SettingsStatusPill tone={tone}>Label</SettingsStatusPill>);
    expect(screen.getByText('Label').className.split(' ')).not.toContain(fillToken);
  });
});

describe('the destructive-strong token the pill spends', () => {
  const css = stripBlockComments(readFileSync(`${APP_DIR}/globals.css`, 'utf8'));

  it('is declared as its own value in both themes and exposed to Tailwind', () => {
    // :root and .dark each declare a literal — dark is NOT an alias of the dark fill token.
    expect(occurrences(css, '--destructive-strong: oklch(')).toBe(2);
    expect(css).not.toContain('--destructive-strong: var(--destructive);');
    expect(css).toContain('--color-destructive-strong: var(--destructive-strong);');
  });
});
