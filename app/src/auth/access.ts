/**
 * Cloudflare Access JWT verification.
 *
 * Every request reaching the app has passed Cloudflare Access, which adds a signed JWT
 * in the `Cf-Access-Jwt-Assertion` header. We verify its signature against the team's
 * public keys, plus issuer, audience and expiry, and take the user's email from it.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AccessConfig } from '../config.js';
import { normalizeEmail } from '../config.js';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export interface AccessIdentity {
  email: string;
}

export class AccessDeniedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AccessDeniedError';
  }
}

export type AccessVerifier = (token: string | undefined) => Promise<AccessIdentity>;

export function accessIssuer(config: AccessConfig): string {
  return `https://${config.teamDomain}`;
}

export function accessCertsUrl(config: AccessConfig): URL {
  return new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`);
}

/**
 * Builds a verifier. `keySet` defaults to the team's remote JWKS (fetched and cached by
 * jose, refreshed on unknown key IDs); tests pass a local key set instead.
 */
export function createAccessVerifier(
  config: AccessConfig,
  keySet?: JWTVerifyGetKey,
): AccessVerifier {
  const keys = keySet ?? createRemoteJWKSet(accessCertsUrl(config));
  const issuer = accessIssuer(config);

  return async (token) => {
    if (!token) {
      throw new AccessDeniedError('Missing Cloudflare Access token');
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        clockTolerance: 30,
        requiredClaims: ['exp', 'iat'],
      }));
    } catch (error) {
      if (error instanceof errors.JOSEError) {
        throw new AccessDeniedError(`Invalid Cloudflare Access token (${error.code})`, {
          cause: error,
        });
      }
      throw error;
    }
    // Service tokens carry no email; this app only serves people.
    const email = payload['email'];
    if (typeof email !== 'string' || !email.includes('@')) {
      throw new AccessDeniedError('Cloudflare Access token has no user email');
    }
    return { email: normalizeEmail(email) };
  };
}
