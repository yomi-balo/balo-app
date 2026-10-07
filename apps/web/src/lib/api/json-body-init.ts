export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The `headers` and optional `body` of a `fetch` init, derived from the method alone. */
export interface JsonBodyInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * The body and `Content-Type` a web→api call sends, decided by method.
 *
 * - **GET / DELETE:** no body and no JSON content type. A `body` argument is ignored.
 * - **Every other method:** `Content-Type: application/json` and always a body,
 *   `JSON.stringify(body ?? {})`.
 *
 * ⚠ THE CONTENT TYPE AND THE BODY MUST AGREE. Fastify treats DELETE as a body-carrying method:
 * when a `Content-Type` is present it always runs the body parser, and the JSON parser rejects
 * a zero-length body with a 400 (`FST_ERR_CTP_EMPTY_JSON_BODY`) before the handler runs. So a
 * JSON content type over an empty body is a 400, on any method.
 *
 * ⚠ DELETE GETS NO `{}` EITHER. undici stops reusing the connection when a body goes out on a
 * method that does not expect one, so the fix for DELETE is to drop the content type, not to
 * add a body.
 */
export function jsonBodyInit(method: ApiMethod, body?: unknown): JsonBodyInit {
  if (method === 'GET' || method === 'DELETE') {
    return { headers: {} };
  }
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
}
