import { NextResponse, type NextRequest } from 'next/server';

/**
 * Returns a 415 response when the request's Content-Type is not `application/json`
 * (a `; charset=…` parameter is allowed), or null when the request may proceed.
 * Guards state-changing routes against cross-site form posts that cannot set this header.
 */
export function rejectNonJsonContentType(request: NextRequest): NextResponse | null {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType === 'application/json') {
    return null;
  }
  return NextResponse.json({ error: 'Unsupported media type' }, { status: 415 });
}
