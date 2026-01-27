import { APP_VERSION } from '@/lib/version';

export function GET() {
  return Response.json({
    status: 'ok',
    ...APP_VERSION,
  });
}
