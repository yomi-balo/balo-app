import 'server-only';

import { WorkOS } from '@workos-inc/node';

export { sessionConfig, COOKIE_NAME } from './session-config';

let _workos: WorkOS;
export function getWorkOS(): WorkOS {
  if (!_workos) {
    _workos = new WorkOS(process.env.WORKOS_API_KEY!);
  }
  return _workos;
}

export const clientId = process.env.WORKOS_CLIENT_ID!;
