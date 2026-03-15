const CDN_URL = process.env.NEXT_PUBLIC_CDN_URL ?? '';

const SIZE_PARAMS: Record<'thumbnail' | 'profile', string> = {
  thumbnail: 'width=200,height=200,fit=cover,quality=80',
  profile: 'width=600,height=600,fit=cover,quality=85',
};

export function getAvatarUrl(
  avatarKeyOrUrl: string | null,
  size: 'thumbnail' | 'profile'
): string | null {
  if (!avatarKeyOrUrl) return null;
  // Legacy full URLs (existing uploads, OAuth provider URLs)
  if (avatarKeyOrUrl.startsWith('http')) return avatarKeyOrUrl;
  // R2 key -> Cloudflare Image Resizing transform URL
  return `${CDN_URL}/cdn-cgi/image/${SIZE_PARAMS[size]}/${avatarKeyOrUrl}`;
}
