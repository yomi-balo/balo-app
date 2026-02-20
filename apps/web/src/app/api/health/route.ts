import { APP_VERSION } from '@/lib/version';

export function GET() {
  return Response.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ...APP_VERSION,
  });
}
