import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, within } from '@testing-library/react';
import type { CasePeopleGroupView } from '@/lib/cases/case-view-types';
import {
  CasePeopleCard,
  PEOPLE_CARD_CLIENT_DISCLOSURE,
  PEOPLE_CARD_NARROW_DISCLOSURE,
  formatUnnamedGuestCount,
} from './case-people-card';

/** BAL-633 — the People card renders the groups the loader hands it, and nothing more. */

function group(over: Partial<CasePeopleGroupView> = {}): CasePeopleGroupView {
  return {
    side: 'client',
    label: 'Northwind Industrial',
    people: [],
    unnamedGuestCount: 0,
    ...over,
  };
}

function renderCard(
  groups: CasePeopleGroupView[],
  lens: 'client' | 'expert' = 'client'
): ReturnType<typeof render> {
  return render(
    <CasePeopleCard
      groups={groups}
      lens={lens}
      clientCompanyName="Northwind Industrial"
      hasCaseScopeDomains={false}
    />
  );
}

/** Each group as `[heading, ...rows]`. */
function outline(container: HTMLElement): Array<Array<string | null>> {
  return within(container)
    .queryAllByRole('group')
    .map((groupEl) => [
      groupEl.querySelector('p')?.textContent ?? null,
      ...[...groupEl.querySelectorAll('li')].map((li) => li.textContent),
    ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatUnnamedGuestCount', () => {
  it('uses the singular for one and the plural otherwise', () => {
    expect(formatUnnamedGuestCount(1)).toBe('+1 guest');
    expect(formatUnnamedGuestCount(2)).toBe('+2 guests');
  });
});

describe('CasePeopleCard', () => {
  const clientLensGroups: CasePeopleGroupView[] = [
    group({
      people: [
        { key: 'p0', name: 'You', isViewer: true },
        { key: 'p1', name: 'Priya Shah', isViewer: false },
      ],
    }),
    group({
      side: 'expert',
      label: 'CloudPeak Consulting',
      people: [{ key: 'p2', name: 'Amara Okafor', isViewer: false }],
    }),
  ];

  it('renders a heading then one row per person, per group, on the client lens', () => {
    const { container } = renderCard(clientLensGroups);
    expect(outline(container)).toEqual([
      ['Northwind Industrial', 'You', 'Priya Shah'],
      ['CloudPeak Consulting', 'Amara Okafor'],
    ]);
    expect(container.querySelector('section > p')?.textContent).toBe(PEOPLE_CARD_NARROW_DISCLOSURE);
  });

  it('renders the viewer’s own group first on the expert lens', () => {
    const { container } = renderCard(
      [
        group({
          side: 'expert',
          label: 'CloudPeak Consulting',
          people: [{ key: 'p0', name: 'You', isViewer: true }],
        }),
        group({ people: [{ key: 'p1', name: 'Priya Shah', isViewer: false }] }),
      ],
      'expert'
    );
    expect(outline(container)).toEqual([
      ['CloudPeak Consulting', 'You'],
      ['Northwind Industrial', 'Priya Shah'],
    ]);
  });

  it('renders an independent expert’s own name as the heading with You beneath', () => {
    const { container } = renderCard(
      [
        group({
          side: 'expert',
          label: 'Amara Okafor',
          people: [{ key: 'p0', name: 'You', isViewer: true }],
        }),
        group(),
      ],
      'expert'
    );
    expect(outline(container)[0]).toEqual(['Amara Okafor', 'You']);
  });

  it('renders the heading alone, with no rows, when the group has nobody', () => {
    const { container } = renderCard([group()], 'expert');
    expect(outline(container)).toEqual([['Northwind Industrial']]);
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it.each([
    [1, '+1 guest'],
    [2, '+2 guests'],
  ])('renders an unnamed-guest count row of %i', (count, expected) => {
    const { container } = renderCard([group({ unnamedGuestCount: count })]);
    expect(outline(container)).toEqual([['Northwind Industrial', expected]]);
  });

  it('puts the count row after named people', () => {
    const { container } = renderCard([
      group({ people: [{ key: 'p0', name: 'You', isViewer: true }], unnamedGuestCount: 2 }),
    ]);
    expect(outline(container)).toEqual([['Northwind Industrial', 'You', '+2 guests']]);
  });

  it('marks no one as a guest', () => {
    const { container } = renderCard([
      group({
        side: 'link',
        label: 'Joined by link',
        people: [{ key: 'p0', name: 'Lena Link', isViewer: false }],
      }),
    ]);
    expect(outline(container)).toEqual([['Joined by link', 'Lena Link']]);
    expect((outline(container)[0] ?? []).join(' ')).not.toMatch(/guest/i);
  });

  it('renders two people with the same name without a duplicate-key warning', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = renderCard([
      group({
        people: [
          { key: 'p0', name: 'Sam Lee', isViewer: false },
          { key: 'p1', name: 'Sam Lee', isViewer: false },
        ],
      }),
    ]);
    expect(outline(container)).toEqual([['Northwind Industrial', 'Sam Lee', 'Sam Lee']]);
    expect(error).not.toHaveBeenCalled();
  });

  it('states the client-domain disclosure only on the client lens with a registered domain', () => {
    const { container } = render(
      <CasePeopleCard
        groups={[group()]}
        lens="client"
        clientCompanyName="Northwind Industrial"
        hasCaseScopeDomains
      />
    );
    expect(container.textContent).toContain(PEOPLE_CARD_CLIENT_DISCLOSURE('Northwind Industrial'));
  });
});
