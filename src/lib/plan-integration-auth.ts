import { createHash, timingSafeEqual } from 'crypto';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';

const MIN_TOKEN_LENGTH = 32;

function integrationToken() {
  const token = process.env.PLAN_INTEGRATION_TOKEN?.trim();
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new LocalPublishJobError(
      'PLAN integration authentication is not configured',
      'PLAN_INTEGRATION_AUTH_NOT_CONFIGURED',
      503,
    );
  }
  return token;
}

export function requirePlanIntegration(authorization: string | null) {
  const expected = integrationToken();
  const provided = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  if (!provided || !timingSafeEqual(providedDigest, expectedDigest)) {
    throw new LocalPublishJobError(
      'Missing or invalid PLAN integration authorization',
      'UNAUTHORIZED',
      401,
    );
  }
}
