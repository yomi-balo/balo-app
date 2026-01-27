import { log } from './index';

interface FetchOptions extends RequestInit {
  /** Name of the external service being called (e.g. 'stripe', 'workos'). */
  service?: string;
}

/**
 * Fetch wrapper that automatically logs external API calls with timing.
 * Request context (requestId, userId) is attached automatically.
 */
export async function loggedFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { service = 'external', ...fetchOptions } = options;
  const start = Date.now();

  try {
    const response = await fetch(url, fetchOptions);
    const duration = Date.now() - start;

    log.info('External API call', {
      service,
      url: new URL(url).pathname,
      method: options.method || 'GET',
      status: response.status,
      duration,
    });

    return response;
  } catch (error) {
    const duration = Date.now() - start;

    log.error('External API call failed', {
      service,
      url: new URL(url).pathname,
      method: options.method || 'GET',
      error: error instanceof Error ? error.message : 'Unknown error',
      duration,
    });

    throw error;
  }
}
