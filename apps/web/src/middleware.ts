import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const response = NextResponse.next();

  response.headers.set('x-request-id', requestId);

  // Structured JSON log compatible with Axiom ingestion.
  // Pino is not available in Edge Runtime, so we use console.log with JSON.
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Request',
      requestId,
      method: request.method,
      path: request.nextUrl.pathname,
      timestamp: new Date().toISOString(),
    })
  );

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/((?!_next/static|favicon.ico).*)'],
};
