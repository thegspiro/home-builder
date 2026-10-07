/**
 * JSON API client. Requests go to the same origin, so the browser sends the
 * Cloudflare Access cookie and the Origin header the API checks on writes.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const FRIENDLY: Record<number, string> = {
  401: 'Your sign-in has expired. Reload the page to sign in again.',
  403: 'You don’t have permission to do that.',
  404: 'Not found.',
  409: 'That conflicts with something that already exists.',
  413: 'That is too large to upload.',
};

export async function api<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!response.ok) {
    const payload = (data ?? {}) as { error?: string; message?: string };
    const message =
      response.status === 400 || response.status === 409
        ? (payload.message ?? FRIENDLY[response.status] ?? 'Request failed.')
        : (FRIENDLY[response.status] ?? 'Something went wrong. Please try again.');
    throw new ApiError(response.status, payload.error ?? 'error', message);
  }
  return data as T;
}

/** Builds "?a=1&b=x" from defined, non-empty values. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
