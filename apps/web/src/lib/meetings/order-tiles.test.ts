import { describe, expect, it } from 'vitest';
import { orderTiles, type TileCandidate } from './order-tiles';

function person(sessionId: string, overrides: Partial<TileCandidate> = {}): TileCandidate {
  return {
    sessionId,
    isLocal: false,
    isScreenSharing: false,
    joinedAtMs: 1_000,
    ...overrides,
  };
}

const ids = (tiles: readonly TileCandidate[]): string[] => tiles.map((tile) => tile.sessionId);

describe('orderTiles', () => {
  it('puts the active speaker first', () => {
    const result = orderTiles(
      [person('a', { joinedAtMs: 1 }), person('b', { joinedAtMs: 2 }), person('c')],
      'c'
    );
    expect(ids(result.visible)[0]).toBe('c');
  });

  it('puts a screen-sharer second, behind the active speaker', () => {
    const result = orderTiles(
      [
        person('speaker', { joinedAtMs: 5 }),
        person('other', { joinedAtMs: 1 }),
        person('sharer', { isScreenSharing: true, joinedAtMs: 9 }),
      ],
      'speaker'
    );
    expect(ids(result.visible)).toEqual(['speaker', 'sharer', 'other']);
  });

  it('orders the remaining remotes by join time', () => {
    const result = orderTiles(
      [person('late', { joinedAtMs: 30 }), person('early', { joinedAtMs: 10 })],
      null
    );
    expect(ids(result.visible)).toEqual(['early', 'late']);
  });

  it('⚠ puts SELF last — always, even when self is the active speaker', () => {
    const result = orderTiles(
      [person('me', { isLocal: true, joinedAtMs: 1 }), person('them', { joinedAtMs: 9 })],
      'me'
    );
    expect(ids(result.visible)).toEqual(['them', 'me']);
  });

  it('⚠ is STABLE under equal join times — the order cannot depend on input order', () => {
    const roster = [person('c'), person('a'), person('b')];
    const first = ids(orderTiles(roster, null).visible);
    const second = ids(orderTiles([...roster].reverse(), null).visible);
    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'b', 'c']);
  });

  it('gives everyone a real tile at or below the ten-cell cap', () => {
    const roster = Array.from({ length: 10 }, (_unused, index) =>
      person(`p${index}`, { joinedAtMs: index })
    );
    const result = orderTiles(roster, null);
    expect(result.visible).toHaveLength(10);
    expect(result.overflow).toEqual([]);
  });

  it('⚠ above the cap renders NINE tiles and collapses the rest — nine plus one overflow cell', () => {
    const roster = Array.from({ length: 14 }, (_unused, index) =>
      person(`p${index}`, { joinedAtMs: index })
    );
    const result = orderTiles(roster, null);
    expect(result.visible).toHaveLength(9);
    expect(result.overflow).toHaveLength(5);
  });

  it('⚠⚠ ALWAYS promotes the active speaker out of overflow, however late they joined', () => {
    const roster = Array.from({ length: 14 }, (_unused, index) =>
      person(`p${index}`, { joinedAtMs: index })
    );
    const result = orderTiles(roster, 'p13');
    expect(ids(result.visible)[0]).toBe('p13');
    expect(ids(result.overflow)).not.toContain('p13');
  });

  it('does not mutate the caller’s array', () => {
    const roster = [person('c'), person('a')];
    const snapshot = ids(roster);
    orderTiles(roster, null);
    expect(ids(roster)).toEqual(snapshot);
  });

  it('answers empty for an empty room', () => {
    expect(orderTiles([], null)).toEqual({ visible: [], overflow: [] });
  });
});
