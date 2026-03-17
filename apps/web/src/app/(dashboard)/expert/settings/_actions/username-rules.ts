// Canonical source: packages/db/src/repositories/username-utils.ts
// Keep these values in sync with that file.
export const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const RESERVED_USERNAMES = new Set([
  'admin',
  'support',
  'balo',
  'help',
  'api',
  'www',
  'app',
  'expert',
  'experts',
]);
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
