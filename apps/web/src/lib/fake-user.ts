// Hardcoded user for development. Replaced with real session data in BAL-169.
export const FAKE_USER = {
  name: 'Yomi Joseph',
  email: 'yomi@getbalo.com',
  avatarUrl: null,
  initials: 'YJ',
} as const;

export type FakeUser = typeof FAKE_USER;
