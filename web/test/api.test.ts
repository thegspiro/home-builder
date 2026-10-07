import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, query } from '../src/lib/api';

function respond(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api()', () => {
  it('sends JSON and parses the response', async () => {
    respond(201, { id: 7 });
    await expect(api('POST', '/api/tags', { name: 'x' })).resolves.toEqual({ id: 7 });
    const [path, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(path).toBe('/api/tags');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: '{"name":"x"}',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('returns undefined for 204', async () => {
    respond(204);
    await expect(api('DELETE', '/api/tags/1')).resolves.toBeUndefined();
  });

  it('shows the server message for validation and conflict errors', async () => {
    respond(409, { error: 'conflict', message: 'A tag with that name already exists' });
    await expect(api('POST', '/api/tags', {})).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'A tag with that name already exists',
    });
  });

  it('hides server details for other errors', async () => {
    respond(500, { error: 'internal_error', message: 'stack trace here' });
    const error = await api('GET', '/api/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Something went wrong. Please try again.');
  });

  it('explains expired sign-ins and network failures', async () => {
    respond(401, { error: 'unauthorized' });
    await expect(api('GET', '/api/me')).rejects.toThrow(/sign-in has expired/);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(api('GET', '/api/me')).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});

describe('query()', () => {
  it('skips empty values and encodes the rest', () => {
    expect(query({ houseId: 3, q: 'garage door', tagIds: undefined, area: '', x: null })).toBe(
      '?houseId=3&q=garage+door',
    );
    expect(query({})).toBe('');
  });
});
