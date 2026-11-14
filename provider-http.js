/**
 * Shared HTTP layer for the platform adapters.
 *
 * One request helper per adapter: it injects the platform's authentication
 * (header or query parameter), applies a timeout, follows the caller's abort
 * signal, and redacts credentials from every error message. `access_token`
 * query parameters are how the Gitee family authenticates, so error text must
 * never carry them into logs or the model.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/** Replace credential query values with `***` for messages and logs. */
export function redactUrl(input) {
  return String(input ?? '').replace(/([?&](?:access_token|accessToken)=)[^&\s"']*/gi, '$1***');
}

/** Combine the caller's signal with the timeout signal (Node 20+: AbortSignal.any). */
function combineSignals(signal, timeoutSignal) {
  if (signal === undefined || signal === null) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/**
 * Create a request helper bound to one platform.
 * options:
 * - platform: label used in error messages
 * - baseUrl: absolute origin + API prefix
 * - headers: extra headers (authentication)
 * - query: query parameters appended to every request (Gitee `access_token`)
 * - timeoutMs
 */
export function createHttp({ platform, baseUrl, headers = {}, query = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');

  function withQuery(pathname) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const text = params.toString();
    if (text === '') return pathname;
    return `${pathname}${pathname.includes('?') ? '&' : '?'}${text}`;
  }

  async function request(method, pathname, { signal, body, accept } = {}) {
    const url = `${base}${withQuery(pathname)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'user-agent': 'dsh-pr-review-plugin',
          accept: accept ?? 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combineSignals(signal, controller.signal),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `${platform} ${redactUrl(pathname)} 失败：HTTP ${response.status} ${redactUrl(text).slice(0, 300)}`,
        );
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(pathname, signal) {
    return (await request('GET', pathname, { signal })).json();
  }

  async function getText(pathname, accept, signal) {
    return (await request('GET', pathname, { accept, signal })).text();
  }

  async function postJson(pathname, payload, signal) {
    return (await request('POST', pathname, { body: payload, signal })).json();
  }

  return { getJson, getText, postJson, request };
}
