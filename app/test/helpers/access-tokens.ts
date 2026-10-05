/** Locally generated Cloudflare-Access-style tokens for tests. */
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type GenerateKeyPairResult,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { AccessConfig } from '../../src/config.js';

export const TEST_ACCESS: AccessConfig = {
  teamDomain: 'testteam.cloudflareaccess.com',
  audience: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
};

export interface TokenFactory {
  keySet: JWTVerifyGetKey;
  sign(claims?: JWTPayload, options?: SignOptions): Promise<string>;
}

export interface SignOptions {
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  issuedAt?: number;
  kid?: string;
}

async function makeKey(
  kid: string,
): Promise<{ privateKey: GenerateKeyPairResult['privateKey']; jwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}

/** A key set containing one trusted key; `sign` signs with it unless told otherwise. */
export async function createTokenFactory(
  access: AccessConfig = TEST_ACCESS,
): Promise<TokenFactory> {
  const trusted = await makeKey('trusted');
  const keySet = createLocalJWKSet({ keys: [trusted.jwk] });

  return {
    keySet,
    async sign(claims = { email: 'user@example.com' }, options = {}) {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'trusted' })
        .setIssuer(options.issuer ?? `https://${access.teamDomain}`)
        .setAudience(options.audience ?? access.audience)
        .setIssuedAt(options.issuedAt)
        .setExpirationTime(options.expiresIn ?? '5m');
      return jwt.sign(trusted.privateKey);
    },
  };
}

/** Signs with a key that is NOT in the trusted key set, reusing the trusted kid. */
export async function signWithUntrustedKey(access: AccessConfig = TEST_ACCESS): Promise<string> {
  const rogue = await makeKey('trusted');
  return new SignJWT({ email: 'attacker@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'trusted' })
    .setIssuer(`https://${access.teamDomain}`)
    .setAudience(access.audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(rogue.privateKey);
}
