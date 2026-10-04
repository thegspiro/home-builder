import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  accessCertsUrl,
  AccessDeniedError,
  createAccessVerifier,
  type AccessVerifier,
} from '../../src/auth/access.js';
import {
  createTokenFactory,
  signWithUntrustedKey,
  TEST_ACCESS,
  type TokenFactory,
} from '../helpers/access-tokens.js';

describe('Cloudflare Access verifier', () => {
  let tokens: TokenFactory;
  let verify: AccessVerifier;

  beforeAll(async () => {
    tokens = await createTokenFactory();
    verify = createAccessVerifier(TEST_ACCESS, tokens.keySet);
  });

  it('accepts a valid token and normalizes the email', async () => {
    const token = await tokens.sign({ email: 'Person@Example.COM' });
    await expect(verify(token)).resolves.toEqual({ email: 'person@example.com' });
  });

  it('rejects a missing token', async () => {
    await expect(verify(undefined)).rejects.toThrow(AccessDeniedError);
    await expect(verify('')).rejects.toThrow(AccessDeniedError);
  });

  it('rejects garbage', async () => {
    await expect(verify('not.a.jwt')).rejects.toThrow(AccessDeniedError);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await tokens.sign(
      { email: 'a@b.co' },
      { issuedAt: now - 3600, expiresIn: now - 600 },
    );
    await expect(verify(token)).rejects.toThrow(/ERR_JWT_EXPIRED/);
  });

  it('rejects the wrong audience', async () => {
    const token = await tokens.sign({ email: 'a@b.co' }, { audience: 'someotherapplicationaud' });
    await expect(verify(token)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects the wrong issuer', async () => {
    const token = await tokens.sign(
      { email: 'a@b.co' },
      { issuer: 'https://evil.cloudflareaccess.com' },
    );
    await expect(verify(token)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects a token signed by a key outside the team key set', async () => {
    await expect(verify(await signWithUntrustedKey())).rejects.toThrow(AccessDeniedError);
  });

  it('rejects an HMAC token (algorithm confusion)', async () => {
    const token = await new SignJWT({ email: 'a@b.co' })
      .setProtectedHeader({ alg: 'HS256', kid: 'trusted' })
      .setIssuer(`https://${TEST_ACCESS.teamDomain}`)
      .setAudience(TEST_ACCESS.audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough!!'));
    await expect(verify(token)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects a service token with no email', async () => {
    const token = await tokens.sign({ common_name: 'service-token-id' });
    await expect(verify(token)).rejects.toThrow('Cloudflare Access token has no user email');
  });

  it('points at the team certs endpoint', () => {
    expect(accessCertsUrl(TEST_ACCESS).href).toBe(
      'https://testteam.cloudflareaccess.com/cdn-cgi/access/certs',
    );
  });
});
