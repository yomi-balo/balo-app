import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
  path?: string;
  method?: string;
  startTime?: number;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function withContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}
