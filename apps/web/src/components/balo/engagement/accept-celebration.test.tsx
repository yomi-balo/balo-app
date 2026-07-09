import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/utils';

const { mockReduced } = vi.hoisted(() => ({ mockReduced: vi.fn() }));
vi.mock('motion/react', () => ({ useReducedMotion: () => mockReduced() }));

import { AcceptCelebration, celebrationStorageKey } from './accept-celebration';

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mockReduced.mockReturnValue(false);
});

describe('AcceptCelebration', () => {
  it('renders nothing when the celebration flag is absent (calm revisit)', () => {
    const { container } = render(<AcceptCelebration engagementId="eng-1" />);
    expect(container.querySelector('span')).toBeNull();
  });

  it('fires the one-shot confetti when armed, then consumes the flag', () => {
    window.sessionStorage.setItem(celebrationStorageKey('eng-1'), '1');
    const { container } = render(<AcceptCelebration engagementId="eng-1" />);
    // Particles rendered on the transition...
    expect(container.querySelectorAll('span').length).toBeGreaterThan(0);
    // ...and the flag consumed so a reload won't replay it.
    expect(window.sessionStorage.getItem(celebrationStorageKey('eng-1'))).toBeNull();
  });

  it('renders nothing under reduced motion, even when armed', () => {
    mockReduced.mockReturnValue(true);
    window.sessionStorage.setItem(celebrationStorageKey('eng-1'), '1');
    const { container } = render(<AcceptCelebration engagementId="eng-1" />);
    expect(container.querySelector('span')).toBeNull();
  });

  it('keys the flag by engagement id (one banner never steals another’s confetti)', () => {
    window.sessionStorage.setItem(celebrationStorageKey('eng-OTHER'), '1');
    const { container } = render(<AcceptCelebration engagementId="eng-1" />);
    expect(container.querySelector('span')).toBeNull();
    // The other engagement's flag is untouched.
    expect(window.sessionStorage.getItem(celebrationStorageKey('eng-OTHER'))).toBe('1');
  });
});
