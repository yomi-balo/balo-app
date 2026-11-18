import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signAddToCalendarToken } from '@balo/shared/calendar-link-token';
import { render, screen } from '@/test/utils';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('@/lib/logging', () => ({ log: { warn: mockWarn, error: vi.fn(), info: vi.fn() } }));

import AddToCalendarPage from './page';

const SECRET = 'page-test-secret';
const FUTURE = {
  title: 'Consultation with Northwind Industrial',
  startIso: '2099-03-02T22:00:00.000Z',
  endIso: '2099-03-02T23:00:00.000Z',
};

async function renderPage(token: string): Promise<void> {
  render(await AddToCalendarPage({ params: Promise.resolve({ token }) }));
}

beforeEach(() => {
  vi.stubEnv('INTERNAL_API_SECRET', SECRET);
  mockWarn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AddToCalendarPage', () => {
  it('renders the signed event with its calendar options', async () => {
    await renderPage(signAddToCalendarToken(FUTURE, SECRET));
    expect(screen.getByRole('heading', { name: FUTURE.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Google Calendar/ })).toBeInTheDocument();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('a token signed with another secret gets the neutral card, and the token is not logged', async () => {
    const token = signAddToCalendarToken(FUTURE, 'someone-else');
    await renderPage(token);
    expect(screen.getByRole('heading', { name: /isn.t working/ })).toBeInTheDocument();
    expect(screen.queryByText(FUTURE.title)).not.toBeInTheDocument();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(token);
  });

  it('fails closed when INTERNAL_API_SECRET is unset', async () => {
    const token = signAddToCalendarToken(FUTURE, SECRET);
    vi.stubEnv('INTERNAL_API_SECRET', '');
    await renderPage(token);
    expect(screen.getByRole('heading', { name: /isn.t working/ })).toBeInTheDocument();
  });

  it('a call that has ended offers nothing to add', async () => {
    const past = {
      ...FUTURE,
      startIso: '2020-01-01T00:00:00.000Z',
      endIso: '2020-01-01T01:00:00.000Z',
    };
    await renderPage(signAddToCalendarToken(past, SECRET));
    expect(screen.getByText(/already taken place/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
