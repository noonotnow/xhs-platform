import { createRemoteJWKSet, jwtVerify } from 'jose';

let cachedIssuer: string | null = null;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function validateCloudflareAccessRequest(
  request: Pick<Request, 'headers'>,
) {
  const issuer = process.env.CLOUDFLARE_ACCESS_ISSUER?.trim();
  const audience = process.env.CLOUDFLARE_ACCESS_AUDIENCE?.trim();
  if (!issuer || !audience) throw new Error('Cloudflare Access is not configured');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new Error('Cloudflare Access assertion is missing');
  const origin = new URL(issuer).origin;
  const normalizedIssuer = issuer.endsWith('/') ? issuer : `${issuer}/`;
  if (!cachedJwks || cachedIssuer !== normalizedIssuer) {
    cachedJwks = createRemoteJWKSet(new URL(`${origin}/cdn-cgi/access/certs`));
    cachedIssuer = normalizedIssuer;
  }
  const { payload } = await jwtVerify(token, cachedJwks, {
    issuer: [issuer, normalizedIssuer],
    audience,
  });
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (!email) throw new Error('Cloudflare Access identity email is missing');
  return { email };
}