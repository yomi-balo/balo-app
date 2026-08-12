import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import LobbyLoading from './loading';

describe('LobbyLoading', () => {
  it('announces itself with an sr-only line', () => {
    render(<LobbyLoading />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('⚠ uses <output>, NOT role="status" (SonarCloud S6819)', () => {
    // The ARIA role where a native element exists is a Sonar finding that escapes local lint
    // (memory `reference_sonarcloud_void_and_output_rules_missed_locally`).
    const { container } = render(<LobbyLoading />);

    expect(container.querySelector('output')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('⚠⚠ aria-busy is on the DECORATIVE skeleton, NEVER on the <output>', () => {
    // `aria-busy` tells assistive tech to SUPPRESS a live region's announcements — so on the
    // `<output>` it silenced the very "Loading…" line that element exists to announce.
    const { container } = render(<LobbyLoading />);

    expect(container.querySelector('output')?.getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector('div[aria-busy="true"]')).not.toBeNull();
  });

  it('⚠ promises no meeting content — this route never knows any', () => {
    // A skeleton shaped like a title and a date would promise content that is never coming:
    // the page performs zero database reads by design.
    const { container } = render(<LobbyLoading />);
    const text = container.textContent ?? '';

    for (const forbidden of [/invited/i, /meeting with/i, /\bwhen\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<LobbyLoading />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
