import { describe, it, expect, vi } from 'vitest';
import type { ActionItem } from '@balo/db';

vi.mock('server-only', () => ({}));

import { countOpenActionItems, mapRecapActionItems } from './map-recap-action-items';

const NOW = new Date('2026-08-12T00:00:00Z');

function item(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'ai-1',
    engagementId: 'e1',
    meetingId: 'm1',
    body: 'Rebuild the flow',
    status: 'open',
    assigneeParty: 'client',
    dueAt: null,
    ...over,
  } as ActionItem;
}

const BASE = {
  engagementId: 'e1',
  lens: 'client' as const,
  clientCompanyName: 'Northwind Industrial',
  expertPartyShort: 'CloudPeak',
  canWrite: true,
  now: NOW,
};

describe('mapRecapActionItems', () => {
  it('passes canWrite straight through — the CALLER decides, and the recap passes false', () => {
    // The mapper stays generic; `load-recap.ts` is what passes `false`, because every
    // action-item mutation gates through a PROJECT-only engagement read and a case id can
    // never resolve there. `load-recap.test.ts` pins that decision.
    expect(mapRecapActionItems({ ...BASE, actionItems: [] }).canWrite).toBe(true);
    expect(mapRecapActionItems({ ...BASE, actionItems: [], canWrite: false }).canWrite).toBe(false);
  });

  it('maps party labels prospectively, naming the party and never a person', () => {
    const view = mapRecapActionItems({
      ...BASE,
      actionItems: [
        item({ id: 'a', assigneeParty: 'client' }),
        item({ id: 'b', assigneeParty: 'expert' }),
        item({ id: 'c', assigneeParty: null }),
      ],
    });
    expect(view.items.map((node) => node.assigneeLabel)).toEqual([
      'Northwind Industrial',
      'CloudPeak',
      null,
    ]);
  });

  it('flags an overdue OPEN item, and never a done one', () => {
    const past = new Date('2026-08-01T00:00:00Z');
    const view = mapRecapActionItems({
      ...BASE,
      actionItems: [item({ id: 'a', dueAt: past }), item({ id: 'b', dueAt: past, status: 'done' })],
    });
    expect(view.items[0]?.isOverdue).toBe(true);
    expect(view.items[1]?.isOverdue).toBe(false);
  });

  it('anchors the panel on the ENGAGEMENT, not the meeting', () => {
    const view = mapRecapActionItems({ ...BASE, actionItems: [item()] });
    expect(view.engagementId).toBe('e1');
  });

  it('carries the viewer lens through as viewerParty', () => {
    expect(mapRecapActionItems({ ...BASE, actionItems: [], lens: 'expert' }).viewerParty).toBe(
      'expert'
    );
  });
});

describe('countOpenActionItems', () => {
  it('counts only OPEN items', () => {
    expect(
      countOpenActionItems([
        item({ id: 'a' }),
        item({ id: 'b', status: 'done' }),
        item({ id: 'c' }),
      ])
    ).toBe(2);
  });

  it('is zero for an empty list', () => {
    expect(countOpenActionItems([])).toBe(0);
  });
});
