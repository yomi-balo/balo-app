import { getAvatarUrl } from '@/lib/storage/avatar-url';

/**
 * The ONLY user data that crosses into the marketing header. Three display fields.
 * ⚠ Deliberately NOT `SessionUser`: that type carries id / email / platformRole /
 * companyId / expertProfileId / activeWorkspace, all of which would be serialised
 * into the RSC payload and readable in page source. Adding a field here is an
 * information-disclosure decision, not a convenience.
 */
export interface MarketingViewer {
  /** Full name, else the email local-part, else 'User'. Display only — never an identifier. */
  displayName: string;
  /** 1–2 uppercase letters for the avatar fallback. */
  initials: string;
  /** An already-resolved CDN URL, or null. Never a raw R2 key. */
  avatarUrl: string | null;
}

/**
 * Structural parameter type on purpose — this module must not import from
 * `@/lib/auth/session` (which is `server-only`) so it stays safe to reach from
 * the client graph. `SessionUser` is structurally assignable to it.
 */
export interface MarketingViewerSource {
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
}

function deriveDisplayName(user: MarketingViewerSource): string {
  const { firstName, lastName } = user;
  if (firstName && lastName) return `${firstName} ${lastName}`;
  if (firstName) return firstName;
  if (lastName) return lastName;

  const [localPart] = user.email.split('@');
  if (!localPart) return 'User';
  return localPart;
}

function deriveInitials(user: MarketingViewerSource, displayName: string): string {
  const { firstName, lastName } = user;
  if (firstName && lastName) {
    const [firstLetter] = firstName;
    const [lastLetter] = lastName;
    return `${firstLetter ?? ''}${lastLetter ?? ''}`.toUpperCase();
  }
  if (firstName) {
    const [firstLetter] = firstName;
    return (firstLetter ?? '').toUpperCase();
  }
  if (lastName) {
    const [firstLetter] = lastName;
    return (firstLetter ?? '').toUpperCase();
  }

  // Both name fields are null — derive from the already-resolved displayName so a real
  // display name never falls back to a bare literal while it exists.
  const [firstLetter] = displayName;
  return (firstLetter ?? '').toUpperCase();
}

export function toMarketingViewer(user: MarketingViewerSource | null): MarketingViewer | null {
  if (!user) return null;

  const displayName = deriveDisplayName(user);
  const initials = deriveInitials(user, displayName);

  return {
    displayName,
    initials,
    avatarUrl: getAvatarUrl(user.avatarUrl, 'thumbnail'),
  };
}
