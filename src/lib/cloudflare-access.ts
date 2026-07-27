import { createRemoteJWKSet } from 'jose/jwks/remote';
import { jwtVerify } from 'jose/jwt/verify';

const ACCESS_COOKIE = 'CF_Authorization';
const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

export interface CloudflareAccessOperator {
  email: string;
}

let cachedIssuer = '';
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getAccessConfig() {
  const teamDomain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim();
  const audience = process.env.CLOUDFLARE_ACCESS_AUDIENCE?.trim();
  const operatorEmails = process.env.CLOUDFLARE_ACCESS_OPERATOR_EMAILS
    ?.split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);

  if (!teamDomain || !audience || !operatorEmails?.length) {
    throw new Error(
      'Cloudflare Access is not configured. Set CLOUDFLARE_ACCESS_TEAM_DOMAIN, ' +
      'CLOUDFLARE_ACCESS_AUDIENCE, and CLOUDFLARE_ACCESS_OPERATOR_EMAILS.',
    );
  }

  const issuer = `https://${teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return { issuer, audience, operatorEmails };
}

function getAssertion(headers: Headers): string | null {
  const headerAssertion = headers.get(ACCESS_HEADER);
  if (headerAssertion) return headerAssertion;

  const cookie = headers.get('cookie');
  const match = cookie?.match(new RegExp(`(?:^|;\\s*)${ACCESS_COOKIE}=([^;]+)`));
  return match?.[1] ?? null;
}

function getJwks(issuer: string) {
  if (!cachedJwks || cachedIssuer !== issuer) {
    cachedIssuer = issuer;
    cachedJwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  }
  return cachedJwks;
}

export async function validateCloudflareAccessRequest(
  request: Pick<Request, 'headers'>,
): Promise<CloudflareAccessOperator> {
  const assertion = getAssertion(request.headers);
  if (!assertion) throw new Error('Missing Cloudflare Access assertion');

  const { issuer, audience, operatorEmails } = getAccessConfig();
  const { payload } = await jwtVerify(assertion, getJwks(issuer), {
    issuer,
    audience,
    algorithms: ['RS256'],
    requiredClaims: ['exp', 'email'],
  });

  if (typeof payload.email !== 'string') {
    throw new Error('Cloudflare Access assertion is missing an email');
  }

  const email = payload.email.trim().toLowerCase();
  if (!operatorEmails.includes(email)) {
    throw new Error('Cloudflare Access identity is not an allowed operator');
  }

  return { email };
}
