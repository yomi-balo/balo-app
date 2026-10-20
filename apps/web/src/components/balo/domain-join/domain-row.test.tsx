import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '@/test/axe';
import type { PartyDomainForSettings } from '@balo/db';
import { DomainRow, attributionText } from './domain-row';

function makeRow(over: Partial<PartyDomainForSettings> = {}): PartyDomainForSettings {
  return {
    id: 'd1',
    domain: 'northwind.com',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    attribution: { kind: 'signup', name: 'Ada Lovelace' },
    ...over,
  };
}

describe('attributionText', () => {
  it('names the signup person with "@ party" on first mention only', () => {
    const attribution = { kind: 'signup', name: 'Ada Lovelace' } as const;
    expect(attributionText(attribution, true, 'Northwind')).toBe(
      'Added automatically when Ada Lovelace @ Northwind signed up'
    );
    expect(attributionText(attribution, false, 'Northwind')).toBe(
      'Added automatically when Ada Lovelace signed up'
    );
  });

  it('falls back to a neutral name and drops the suffix when the signup person is unknown', () => {
    expect(attributionText({ kind: 'signup', name: null }, true, 'Northwind')).toBe(
      'Added automatically when a teammate signed up'
    );
  });

  it('attributes a Balo-added row to Balo, never a person', () => {
    expect(attributionText({ kind: 'balo' }, true, 'Northwind')).toBe('Added by Balo');
  });
});

describe('DomainRow', () => {
  it('renders the domain and attribution with no remove control', () => {
    render(<DomainRow row={makeRow()} firstMention partyName="Northwind" />);
    expect(screen.getByText('northwind.com')).toBeInTheDocument();
    expect(
      screen.getByText('Added automatically when Ada Lovelace @ Northwind signed up')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <DomainRow
        row={makeRow({ attribution: { kind: 'balo' } })}
        firstMention
        partyName="Northwind"
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
